const test = require("node:test");
const assert = require("node:assert/strict");
const { createOperatorAuth, getCookie, isAllowedOrigin } = require("./operator-auth");

const config = {
  operator: { username: "operator", password: "a-strong-password-for-tests" },
  webOrigins: ["https://inbox.example.test"],
};

function createResponse() {
  return {
    headers: {},
    statusCode: undefined,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    set(name, value) {
      this.headers[name] = value;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    sendStatus(code) {
      this.statusCode = code;
      return this;
    },
  };
}

function createPool(now = Date.now) {
  const sessions = new Map();
  return {
    sessions,
    async query(sql, values) {
      if (sql.includes("INSERT INTO operator_sessions")) {
        sessions.set(values[0], { username: values[1], expiresAt: values[2] });
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("SELECT username") && sql.includes("operator_sessions")) {
        const session = sessions.get(values[0]);
        const valid = session && session.username === values[1] && session.expiresAt > new Date(now());
        return valid
          ? { rowCount: 1, rows: [{ username: session.username }] }
          : { rowCount: 0, rows: [] };
      }
      if (sql.includes("DELETE FROM operator_sessions")) {
        return { rowCount: Number(sessions.delete(values[0])), rows: [] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
}

function request({ origin = "https://inbox.example.test", body = {}, cookie } = {}) {
  const headers = { origin };
  if (cookie) headers.cookie = cookie;
  return {
    body,
    get(name) {
      return headers[name.toLowerCase()];
    },
  };
}

test("parses only the named cookie and compares browser origins exactly", () => {
  assert.equal(getCookie("other=ok; motosmart_operator=abc", "motosmart_operator"), "abc");
  assert.equal(getCookie("motosmart_operatorx=abc", "motosmart_operator"), undefined);
  assert.equal(isAllowedOrigin("https://inbox.example.test", config.webOrigins), true);
  assert.equal(isAllowedOrigin("https://inbox.example.test.evil", config.webOrigins), false);
  assert.equal(isAllowedOrigin(undefined, config.webOrigins), false);
});

test("stores only a hash, checks the database on each request and revokes sessions on logout", async () => {
  let now = 1_800_000_000_000;
  const pool = createPool(() => now);
  const auth = createOperatorAuth({ config, pool, isProduction: true, now: () => now });
  const blockedOrigin = createResponse();
  auth.requireOrigin(request({ origin: "https://attacker.example" }), blockedOrigin, () => {
    throw new Error("Disallowed origin must be blocked");
  });
  assert.equal(blockedOrigin.statusCode, 403);

  const success = createResponse();
  await auth.login(request({ body: { username: "operator", password: config.operator.password } }), success);
  assert.equal(success.statusCode, 200);
  assert.match(success.headers["Set-Cookie"], /HttpOnly/);
  assert.match(success.headers["Set-Cookie"], /Secure/);
  assert.match(success.headers["Set-Cookie"], /SameSite=Strict/);

  const cookie = success.headers["Set-Cookie"].split(";")[0];
  const token = cookie.split("=")[1];
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(pool.sessions.size, 1);
  assert.equal([...pool.sessions.keys()][0].length, 64);
  assert.notEqual([...pool.sessions.keys()][0], token);

  const sessionRequest = request({ cookie });
  const sessionGate = createResponse();
  let continued = false;
  await auth.requireSession(sessionRequest, sessionGate, () => {
    continued = true;
  });
  assert.equal(continued, true);
  const sessionResponse = createResponse();
  auth.session(sessionRequest, sessionResponse);
  assert.equal(sessionResponse.statusCode, 200);
  assert.deepEqual(sessionResponse.body, { username: "operator" });

  const logoutResponse = createResponse();
  await auth.logout(request({ cookie }), logoutResponse);
  assert.equal(logoutResponse.statusCode, 204);
  assert.match(logoutResponse.headers["Set-Cookie"], /Max-Age=0/);

  const afterLogout = createResponse();
  await auth.requireSession(request({ cookie }), afterLogout, () => {
    throw new Error("Revoked session must be rejected");
  });
  assert.equal(afterLogout.statusCode, 401);

  const expiredResponse = createResponse();
  await auth.login(request({ body: { username: "operator", password: config.operator.password } }), expiredResponse);
  now += 9 * 60 * 60 * 1000;
  const expired = createResponse();
  await auth.requireSession(request({ cookie: expiredResponse.headers["Set-Cookie"].split(";")[0] }), expired, () => {
    throw new Error("Expired session must be rejected");
  });
  assert.equal(expired.statusCode, 401);
});

test("limits repeated failed operator logins", async () => {
  const auth = createOperatorAuth({ config, pool: createPool(), now: () => 1_800_000_000_000 });
  let last;
  for (let attempt = 0; attempt < 11; attempt += 1) {
    last = createResponse();
    await auth.login(request({ body: { username: "wrong", password: "wrong" } }), last);
  }
  assert.equal(last.statusCode, 429);
  assert.ok(last.headers["Retry-After"]);
});
