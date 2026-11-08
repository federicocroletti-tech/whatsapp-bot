const { INITIAL_CONVERSATION, transitionConversation } = require("./intake-flow");

function createMotoIntakeService({ pool, config, askLocalKnowledge }) {
  async function enqueueMessage(client, sourceMessageId, recipientId, body, sourceTimestamp) {
    await client.query(
      `INSERT INTO message_outbox (source_message_id, recipient_id, body, expires_at)
       VALUES ($1, $2, $3, TO_TIMESTAMP($4) + INTERVAL '24 hours')
       ON CONFLICT (source_message_id) DO NOTHING`,
      [sourceMessageId, recipientId, body, sourceTimestamp],
    );
  }

  async function processIncomingMessage({ messageId, senderId, text, sourceTimestamp }) {
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const inserted = await client.query(
        `INSERT INTO processed_webhook_messages (message_id)
         VALUES ($1)
         ON CONFLICT DO NOTHING
         RETURNING message_id`,
        [messageId],
      );

      if (inserted.rowCount === 0) {
        await client.query("COMMIT");
        return { duplicate: true };
      }

      await client.query(
        `INSERT INTO moto_conversations (wa_id, step)
         VALUES ($1, 'idle')
         ON CONFLICT (wa_id) DO NOTHING`,
        [senderId],
      );

      const result = await client.query(
        `SELECT wa_id, step, customer_name, motorcycle, issue, availability, consent_at,
                updated_at
         FROM moto_conversations
         WHERE wa_id = $1
         FOR UPDATE`,
        [senderId],
      );
      let conversation = result.rows[0];

      if (Date.now() - new Date(conversation.updated_at).getTime() > 24 * 60 * 60 * 1000) {
        conversation = { ...INITIAL_CONVERSATION, wa_id: senderId };
      }

      let reply;
      let transition = null;
      if (typeof text === "string" && text.length > 2000) {
        reply = "Il messaggio è troppo lungo. Invia un testo entro 2000 caratteri.";
      } else if (typeof text === "string" && text.trim()) {
        transition = transitionConversation(conversation, text, {
          workshopName: config.workshopName,
          privacyUrl: config.privacyUrl,
        });
      } else {
        reply = "Per ora posso gestire messaggi di testo. Scrivi “richiesta officina” per avviare una richiesta o contatta direttamente l'officina.";
      }

      if (transition) {
        conversation = transition.conversation;
        reply = transition.reply;
      } else if (typeof text === "string" && text.trim()) {
        reply = askLocalKnowledge(text.trim());
      }

      await client.query(
        `UPDATE moto_conversations
         SET step = $2, customer_name = $3, motorcycle = $4, issue = $5,
             availability = $6, consent_at = $7, updated_at = NOW(),
             expires_at = NOW() + INTERVAL '24 hours'
         WHERE wa_id = $1`,
        [
          senderId,
          conversation.step,
          conversation.customer_name,
          conversation.motorcycle,
          conversation.issue,
          conversation.availability,
          conversation.consent_at,
        ],
      );

      if (transition?.request) {
        const request = transition.request;
        await client.query(
          `INSERT INTO moto_service_requests
             (wa_id, customer_name, motorcycle, issue, availability, consent_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            senderId,
            request.customer_name,
            request.motorcycle,
            request.issue,
            request.availability,
            request.consent_at,
          ],
        );
      }

      await enqueueMessage(client, messageId, senderId, reply, sourceTimestamp);
      await client.query("COMMIT");
      return { duplicate: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  return { processIncomingMessage };
}

module.exports = { createMotoIntakeService };
