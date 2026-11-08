const test = require("node:test");
const assert = require("node:assert/strict");
const { createHmac } = require("node:crypto");
const { verifyWebhookSignature } = require("./webhook-signature");

test("accepts a valid Meta SHA-256 signature", () => {
  const body = Buffer.from('{"object":"whatsapp_business_account"}');
  const secret = "test-app-secret";
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

  assert.equal(verifyWebhookSignature(body, signature, secret), true);
});

test("rejects malformed, missing, or invalid webhook signatures", () => {
  const body = Buffer.from("{}");
  assert.equal(verifyWebhookSignature(body, null, "secret"), false);
  assert.equal(verifyWebhookSignature(body, "sha256=invalid", "secret"), false);
  assert.equal(verifyWebhookSignature(body, `sha256=${"0".repeat(64)}`, "secret"), false);
  assert.equal(verifyWebhookSignature("{}", `sha256=${"0".repeat(64)}`, "secret"), false);
});
