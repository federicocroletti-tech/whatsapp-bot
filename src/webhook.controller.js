const { timingSafeEqual } = require("node:crypto");
const { verifyWebhookSignature } = require("./webhook-signature");

function createWebhookHandlers({ config, processIncomingMessage }) {
  function verify(req, res) {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    const expectedToken = Buffer.from(config.verifyToken);
    const receivedToken = typeof token === "string" ? Buffer.from(token) : Buffer.alloc(0);

    if (
      mode === "subscribe" &&
      typeof challenge === "string" &&
      receivedToken.length === expectedToken.length &&
      timingSafeEqual(receivedToken, expectedToken)
    ) {
      return res.status(200).send(challenge);
    }

    return res.sendStatus(403);
  }

  async function handleMessage(req, res) {
    if (
      !verifyWebhookSignature(req.rawBody, req.get("x-hub-signature-256"), config.appSecret)
    ) {
      return res.sendStatus(401);
    }

    try {
      const messages = (Array.isArray(req.body.entry) ? req.body.entry : []).flatMap((entry) =>
        (Array.isArray(entry.changes) ? entry.changes : []).flatMap((change) =>
          Array.isArray(change.value?.messages) ? change.value.messages : [],
        ),
      );

      for (const message of messages) {
        const senderId = message.from ?? message.from_user_id;
        if (typeof senderId !== "string" || typeof message.id !== "string") continue;
        if (config.allowedNumbers.length > 0 && !config.allowedNumbers.includes(senderId)) continue;
        const sourceTimestamp = Number(message.timestamp);
        if (!Number.isSafeInteger(sourceTimestamp) || sourceTimestamp <= 0) continue;

        const text = message.type === "text" ? message.text?.body : null;
        await processIncomingMessage({
          messageId: message.id,
          senderId,
          text: typeof text === "string" ? text : null,
          sourceTimestamp,
        });
      }

      return res.sendStatus(200);
    } catch (error) {
      console.error("Errore webhook WhatsApp:", error.code || "unknown");
      return res.sendStatus(500);
    }
  }

  return { verify, handleMessage };
}

module.exports = { createWebhookHandlers };
