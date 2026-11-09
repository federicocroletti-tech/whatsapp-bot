const axios = require("axios");

async function sendMessage(phoneNumberId, accessToken, to, text) {
  await axios.post(
    `https://graph.facebook.com/v25.0/${phoneNumberId}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      text: { body: text },
    },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      timeout: 10000,
    },
  );
}

module.exports = { sendMessage };
