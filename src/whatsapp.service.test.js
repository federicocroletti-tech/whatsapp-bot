const test = require("node:test");
const assert = require("node:assert/strict");
const axios = require("axios");
const { sendMessage } = require("./whatsapp.service");

test("sends a reply with the selected tenant phone number and access token", async (t) => {
  const originalPost = axios.post;
  let request;
  axios.post = async (...args) => {
    request = args;
    return { status: 200 };
  };
  t.after(() => {
    axios.post = originalPost;
  });

  await sendMessage(
    "123456789012345",
    "tenant-token",
    "customer-id",
    "Risposta",
  );

  assert.equal(
    request[0],
    "https://graph.facebook.com/v25.0/123456789012345/messages",
  );
  assert.deepEqual(request[1], {
    messaging_product: "whatsapp",
    to: "customer-id",
    text: { body: "Risposta" },
  });
  assert.equal(request[2].headers.Authorization, "Bearer tenant-token");
});
