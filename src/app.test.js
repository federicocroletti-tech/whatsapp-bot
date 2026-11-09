const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { createHash } = require("node:crypto");

Object.assign(process.env, {
  APP_SECRET: "test-app-secret",
  VERIFY_TOKEN: "test-verify-token",
  DATABASE_URL: "postgres://test:test@127.0.0.1:1/test",
  WEB_ORIGINS: "http://localhost:4200",
  PLATFORM_ADMIN_TOKEN: "test-platform-admin-token-that-is-long-enough",
  TENANT_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
});
delete process.env.OPENAI_API_KEY;

const app = require("./app");
const { pool } = require("./database");
const { hashOperatorPassword } = require("./operator-password");
const operatorPassword = "a-strong-password-for-tests";

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

test("operator routes enforce origin checks and tenant-scoped HttpOnly sessions", async (t) => {
  const sessions = new Map();
  const passwordHash = await hashOperatorPassword(operatorPassword);
  const originalQuery = pool.query;
  pool.query = async (sql, values) => {
    if (sql.includes("SELECT operator.id")) {
      return values[1] === "operator"
        ? {
            rowCount: 1,
            rows: [
              {
                id: "11",
                tenant_id: "tenant-a",
                username: "operator",
                password_hash: passwordHash,
                role: "owner",
              },
            ],
          }
        : { rowCount: 0, rows: [] };
    }
    if (sql.includes("INSERT INTO tenant_operator_sessions")) {
      sessions.set(values[0], { tenantId: values[1], expiresAt: values[3] });
      return { rowCount: 1, rows: [] };
    }
    if (sql.includes("DELETE FROM tenant_operator_sessions")) {
      sessions.delete(values[0]);
      return { rowCount: 1, rows: [] };
    }
    if (sql.includes("FROM tenant_operator_sessions")) {
      const session = sessions.get(values[0]);
      return session &&
        session.tenantId === "tenant-a" &&
        values[1] === "workshop-a" &&
        session.expiresAt > new Date()
        ? {
            rowCount: 1,
            rows: [
              { username: "operator", role: "owner", tenant_id: "tenant-a" },
            ],
          }
        : { rowCount: 0, rows: [] };
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

  const baseUrl = `http://127.0.0.1:${server.address().port}/operator/workshop-a`;
  const origin = "http://localhost:4200";
  const rejected = await fetch(`${baseUrl}/login`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://not-allowed.example",
    },
    body: JSON.stringify({ username: "operator", password: operatorPassword }),
  });
  assert.equal(rejected.status, 403);

  const unauthorized = await fetch(`${baseUrl}/requests`, {
    headers: { origin },
  });
  assert.equal(unauthorized.status, 401);

  const login = await fetch(`${baseUrl}/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ username: "operator", password: operatorPassword }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  assert.equal(sessions.size, 1);
  assert.equal(
    [...sessions.keys()][0],
    createHash("sha256").update(cookie.split("=")[1]).digest("hex"),
  );
  assert.match(login.headers.get("set-cookie"), /HttpOnly/);
  assert.match(login.headers.get("set-cookie"), /Path=\/operator\/workshop-a/);

  const session = await fetch(`${baseUrl}/session`, {
    headers: { origin, cookie },
  });
  assert.equal(session.status, 200);
  assert.deepEqual(await session.json(), {
    username: "operator",
    role: "owner",
  });

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
