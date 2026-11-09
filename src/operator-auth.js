const { createHash, randomBytes } = require("node:crypto");
const {
  hashOperatorPassword,
  verifyOperatorPassword,
} = require("./operator-password");

const SESSION_COOKIE_PREFIX = "motosmart_operator_";
const SESSION_DURATION_SECONDS = 8 * 60 * 60;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const loginAttempts = new Map();
const dummyPasswordHash = hashOperatorPassword(
  randomBytes(32).toString("base64url"),
);

function hashSessionToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function getCookie(header, cookieName) {
  if (typeof header !== "string") return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== cookieName)
      continue;
    return part.slice(separator + 1).trim();
  }
  return undefined;
}

function getCookieValue(
  token,
  tenantSlug,
  isProduction,
  maxAge = SESSION_DURATION_SECONDS,
) {
  const cookieName = `${SESSION_COOKIE_PREFIX}${tenantSlug}`;
  return [
    `${cookieName}=${token}`,
    "HttpOnly",
    `Path=/operator/${tenantSlug}`,
    "SameSite=Strict",
    `Max-Age=${maxAge}`,
    ...(maxAge === 0 ? ["Expires=Thu, 01 Jan 1970 00:00:00 GMT"] : []),
    ...(isProduction ? ["Secure"] : []),
  ].join("; ");
}

function isAllowedOrigin(origin, allowedOrigins) {
  return typeof origin === "string" && allowedOrigins.includes(origin);
}

function createOperatorAuth({
  config,
  pool,
  isProduction = false,
  now = Date.now,
}) {
  function getTenantSlug(req) {
    return typeof req.params?.tenantSlug === "string" &&
      SLUG_PATTERN.test(req.params.tenantSlug)
      ? req.params.tenantSlug
      : null;
  }

  async function hasValidSession(req) {
    const tenantSlug = getTenantSlug(req);
    if (!tenantSlug) return false;
    const token = getCookie(
      req.get("cookie"),
      `${SESSION_COOKIE_PREFIX}${tenantSlug}`,
    );
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token))
      return false;

    const result = await pool.query(
      `SELECT operator.username, operator.role, operator.tenant_id
       FROM tenant_operator_sessions AS session
       JOIN tenant_operator_users AS operator
         ON operator.id = session.operator_id AND operator.tenant_id = session.tenant_id
       JOIN tenants AS tenant ON tenant.id = session.tenant_id
       WHERE session.token_hash = $1
         AND tenant.slug = $2
         AND tenant.status = 'active'
         AND operator.active = TRUE
         AND session.expires_at > NOW()`,
      [hashSessionToken(token), tenantSlug],
    );
    if (result.rowCount === 0) return false;
    req.operatorUsername = result.rows[0].username;
    req.operatorRole = result.rows[0].role;
    req.operatorTenantId = result.rows[0].tenant_id;
    req.operatorTenantSlug = tenantSlug;
    return true;
  }

  function requireOrigin(req, res, next) {
    if (!isAllowedOrigin(req.get("origin"), config.webOrigins)) {
      return res.sendStatus(403);
    }
    return next();
  }

  async function requireSession(req, res, next) {
    res.set("Cache-Control", "no-store");
    if (!(await hasValidSession(req))) return res.sendStatus(401);
    return next();
  }

  async function login(req, res) {
    res.set("Cache-Control", "no-store");
    const tenantSlug = getTenantSlug(req);
    const { username, password } = req.body ?? {};
    if (
      !tenantSlug ||
      typeof username !== "string" ||
      typeof password !== "string" ||
      !username.trim() ||
      username.length > 128 ||
      password.length > 256
    ) {
      return res.status(400).json({ error: "Credenziali non valide" });
    }

    const currentTime = now();
    for (const [key, attempt] of loginAttempts) {
      if (currentTime - attempt.startedAt >= LOGIN_WINDOW_MS)
        loginAttempts.delete(key);
    }
    const attemptKey = createHash("sha256")
      .update(`${tenantSlug}\0${username}`)
      .digest("hex");
    const existing = loginAttempts.get(attemptKey);
    const recent =
      existing && currentTime - existing.startedAt < LOGIN_WINDOW_MS
        ? existing
        : { startedAt: currentTime, count: 0 };

    if (recent.count >= LOGIN_MAX_ATTEMPTS) {
      res.set(
        "Retry-After",
        String(
          Math.ceil((recent.startedAt + LOGIN_WINDOW_MS - currentTime) / 1000),
        ),
      );
      return res
        .status(429)
        .json({ error: "Troppi tentativi. Riprova più tardi." });
    }

    const result = await pool.query(
      `SELECT operator.id, operator.tenant_id, operator.username, operator.password_hash,
              operator.role
       FROM tenant_operator_users AS operator
       JOIN tenants AS tenant ON tenant.id = operator.tenant_id
       WHERE tenant.slug = $1
         AND tenant.status = 'active'
         AND operator.username = $2
         AND operator.active = TRUE`,
      [tenantSlug, username.trim()],
    );
    const operator = result.rows[0];
    const passwordMatches = await verifyOperatorPassword(
      password,
      operator?.password_hash ?? (await dummyPasswordHash),
    );

    if (!operator || !passwordMatches) {
      recent.count += 1;
      loginAttempts.set(attemptKey, recent);
      if (loginAttempts.size > 4096) {
        const oldestKey = loginAttempts.keys().next().value;
        if (oldestKey) loginAttempts.delete(oldestKey);
      }
      return res.status(401).json({ error: "Credenziali non valide" });
    }

    loginAttempts.delete(attemptKey);
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(currentTime + SESSION_DURATION_SECONDS * 1000);
    await pool.query(
      `INSERT INTO tenant_operator_sessions
         (token_hash, tenant_id, operator_id, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [hashSessionToken(token), operator.tenant_id, operator.id, expiresAt],
    );
    res.set("Set-Cookie", getCookieValue(token, tenantSlug, isProduction));
    return res
      .status(200)
      .json({ username: operator.username, role: operator.role });
  }

  async function logout(req, res) {
    res.set("Cache-Control", "no-store");
    const tenantSlug = getTenantSlug(req);
    if (tenantSlug) {
      const token = getCookie(
        req.get("cookie"),
        `${SESSION_COOKIE_PREFIX}${tenantSlug}`,
      );
      if (typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token)) {
        await pool.query(
          `DELETE FROM tenant_operator_sessions
           WHERE token_hash = $1
             AND tenant_id = (SELECT id FROM tenants WHERE slug = $2)`,
          [hashSessionToken(token), tenantSlug],
        );
      }
      res.set("Set-Cookie", getCookieValue("", tenantSlug, isProduction, 0));
    }
    return res.sendStatus(204);
  }

  function session(req, res) {
    res.set("Cache-Control", "no-store");
    return res.status(200).json({
      username: req.operatorUsername,
      role: req.operatorRole,
    });
  }

  return { login, logout, requireOrigin, requireSession, session };
}

module.exports = {
  SESSION_COOKIE_PREFIX,
  createOperatorAuth,
  getCookie,
  isAllowedOrigin,
};
