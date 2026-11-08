const { createHmac, timingSafeEqual } = require("node:crypto");

function verifyWebhookSignature(rawBody, signature, appSecret) {
  if (!Buffer.isBuffer(rawBody) || typeof signature !== "string" || !appSecret) {
    return false;
  }

  const match = /^sha256=([a-f0-9]{64})$/i.exec(signature);
  if (!match) return false;

  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  const received = Buffer.from(match[1], "hex");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

module.exports = { verifyWebhookSignature };
