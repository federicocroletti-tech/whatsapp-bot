const axios = require("axios");
const config = require("./config");

async function sendMessage(to, text) {
  await axios.post(
    `https://graph.facebook.com/v25.0/${config.phoneNumberId}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      text: { body: text },
    },
    {
      headers: {
        Authorization: `Bearer ${config.token}`,
        "Content-Type": "application/json",
      },
      timeout: 10000,
    },
  );
}

module.exports = { sendMessage };
