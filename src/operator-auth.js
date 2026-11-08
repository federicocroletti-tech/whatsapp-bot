const { createHash, randomBytes, timingSafeEqual } = require("node:crypto");

const SESSION_COOKIE = "motosmart_operator";
const SESSION_DURATION_SECONDS = 8 * 60 * 60;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;
const loginAttempts = new Map();

function safeEqual(left, right) {
  const leftDigest = createHash("sha256").update(String(left)).digest();
  const rightDigest = createHash("sha256").update(String(right)).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function hashSessionToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function getCookie(header, cookieName) {
  if (typeof header !== "string") return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== cookieName) continue;
    return part.slice(separator + 1).trim();
  }
  return undefined;
}

function getCookieValue(token, isProduction, maxAge = SESSION_DURATION_SECONDS) {
  return [
    `${SESSION_COOKIE}=${token}`,
    "HttpOnly",
    "Path=/operator",
    "SameSite=Strict",
    `Max-Age=${maxAge}`,
    ...(maxAge === 0 ? ["Expires=Thu, 01 Jan 1970 00:00:00 GMT"] : []),
    ...(isProduction ? ["Secure"] : []),
  ].join("; ");
}

function isAllowedOrigin(origin, allowedOrigins) {
  return typeof origin === "string" && allowedOrigins.includes(origin);
}

function createOperatorAuth({ config, pool, isProduction = false, now = Date.now }) {
  async function hasValidSession(req) {
    const token = getCookie(req.get("cookie"), SESSION_COOKIE);
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) return false;

    const result = await pool.query(
      `SELECT username
       FROM operator_sessions
       WHERE token_hash = $1 AND username = $2 AND expires_at > NOW()`,
      [hashSessionToken(token), config.operator.username],
    );
    if (result.rowCount === 0) return false;
    req.operatorUsername = result.rows[0].username;
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
    const { username, password } = req.body ?? {};
    if (
      typeof username !== "string" ||
      typeof password !== "string" ||
      username.length > 128 ||
      password.length > 256
    ) {
      return res.status(400).json({ error: "Credenziali non valide" });
    }

    const currentTime = now();
    for (const [key, attempt] of loginAttempts) {
      if (currentTime - attempt.startedAt >= LOGIN_WINDOW_MS) loginAttempts.delete(key);
    }
    const attemptKey = createHash("sha256").update(username).digest("hex");
    const existing = loginAttempts.get(attemptKey);
    const recent =
      existing && currentTime - existing.startedAt < LOGIN_WINDOW_MS
        ? existing
        : { startedAt: currentTime, count: 0 };

    if (recent.count >= LOGIN_MAX_ATTEMPTS) {
      res.set(
        "Retry-After",
        String(Math.ceil((recent.startedAt + LOGIN_WINDOW_MS - currentTime) / 1000)),
      );
      return res.status(429).json({ error: "Troppi tentativi. Riprova più tardi." });
    }

    const usernameMatches = safeEqual(username, config.operator.username);
    const passwordMatches = safeEqual(password, config.operator.password);
    if (!usernameMatches || !passwordMatches) {
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
      `INSERT INTO operator_sessions (token_hash, username, expires_at)
       VALUES ($1, $2, $3)`,
      [hashSessionToken(token), config.operator.username, expiresAt],
    );
    res.set("Set-Cookie", getCookieValue(token, isProduction));
    return res.status(200).json({ username: config.operator.username });
  }

  async function logout(req, res) {
    res.set("Cache-Control", "no-store");
    const token = getCookie(req.get("cookie"), SESSION_COOKIE);
    if (typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token)) {
      await pool.query("DELETE FROM operator_sessions WHERE token_hash = $1", [
        hashSessionToken(token),
      ]);
    }
    res.set("Set-Cookie", getCookieValue("", isProduction, 0));
    return res.sendStatus(204);
  }

  function session(req, res) {
    res.set("Cache-Control", "no-store");
    return res.status(200).json({ username: req.operatorUsername });
  }

  return { login, logout, requireOrigin, requireSession, session };
}

module.exports = {
  SESSION_COOKIE,
  createOperatorAuth,
  getCookie,
  isAllowedOrigin,
};
