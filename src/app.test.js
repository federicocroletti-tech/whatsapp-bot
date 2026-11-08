const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { createHash } = require("node:crypto");

Object.assign(process.env, {
  TOKEN: "test-token",
  APP_SECRET: "test-app-secret",
  PHONE_NUMBER_ID: "test-phone-number-id",
  VERIFY_TOKEN: "test-verify-token",
  DATABASE_URL: "postgresql://test:test@127.0.0.1:1/test",
  WORKSHOP_NAME: "Officina Test",
  PRIVACY_URL: "https://example.test/privacy",
  WEB_ORIGINS: "http://localhost:4200",
  OPERATOR_USERNAME: "operator",
  OPERATOR_PASSWORD: "a-strong-password-for-tests",
});
delete process.env.OPENAI_API_KEY;

const app = require("./app");
const { pool } = require("./database");

test("chat endpoint validates input and uses the configured local fallback", async (t) => {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const invalid = await fetch(`${baseUrl}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "" }),
  });
  assert.equal(invalid.status, 400);

  const valid = await fetch(`${baseUrl}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "Buongiorno" }),
  });
  assert.equal(valid.status, 200);
  assert.match((await valid.json()).reply, /richiesta di assistenza/);
});

test("operator routes enforce origin checks and HttpOnly login sessions", async (t) => {
  const sessions = new Map();
  const originalQuery = pool.query;
  pool.query = async (sql, values) => {
    if (sql.includes("INSERT INTO operator_sessions")) {
      sessions.set(values[0], { username: values[1], expiresAt: values[2] });
      return { rowCount: 1, rows: [] };
    }
    if (sql.includes("SELECT username") && sql.includes("operator_sessions")) {
      const session = sessions.get(values[0]);
      return session && session.username === values[1] && session.expiresAt > new Date()
        ? { rowCount: 1, rows: [{ username: session.username }] }
        : { rowCount: 0, rows: [] };
    }
    if (sql.includes("DELETE FROM operator_sessions")) {
      sessions.delete(values[0]);
      return { rowCount: 1, rows: [] };
    }
    throw new Error(`Unexpected SQL in operator route test: ${sql}`);
  };
  t.after(() => {
    pool.query = originalQuery;
  });

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  const baseUrl = `http://127.0.0.1:${server.address().port}/operator`;
  const origin = "http://localhost:4200";
  const rejected = await fetch(`${baseUrl}/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://not-allowed.example" },
    body: JSON.stringify({ username: "operator", password: "a-strong-password-for-tests" }),
  });
  assert.equal(rejected.status, 403);

  const unauthorized = await fetch(`${baseUrl}/requests`, {
    headers: { origin },
  });
  assert.equal(unauthorized.status, 401);

  const login = await fetch(`${baseUrl}/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ username: "operator", password: "a-strong-password-for-tests" }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  assert.equal(sessions.size, 1);
  assert.equal([...sessions.keys()][0], createHash("sha256").update(cookie.split("=")[1]).digest("hex"));
  assert.match(login.headers.get("set-cookie"), /HttpOnly/);

  const session = await fetch(`${baseUrl}/session`, {
    headers: { origin, cookie },
  });
  assert.equal(session.status, 200);
  assert.deepEqual(await session.json(), { username: "operator" });

  const logout = await fetch(`${baseUrl}/logout`, {
    method: "POST",
    headers: { origin, cookie },
  });
  assert.equal(logout.status, 204);
  assert.match(logout.headers.get("set-cookie"), /Max-Age=0/);

  const afterLogout = await fetch(`${baseUrl}/session`, {
    headers: { origin, cookie },
  });
  assert.equal(afterLogout.status, 401);
  assert.equal(sessions.size, 0);
});
