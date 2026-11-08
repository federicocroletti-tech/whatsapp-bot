const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");

Object.assign(process.env, {
  TOKEN: "test-token",
  APP_SECRET: "test-app-secret",
  PHONE_NUMBER_ID: "test-phone-number-id",
  VERIFY_TOKEN: "test-verify-token",
  DATABASE_URL: "postgresql://test:test@127.0.0.1:1/test",
  WORKSHOP_NAME: "Officina Test",
  PRIVACY_URL: "https://example.test/privacy",
  WHATSAPP_AI_ENABLED: "false",
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
    await pool.end();
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
