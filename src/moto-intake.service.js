const {
  INITIAL_CONVERSATION,
  transitionConversation,
} = require("./intake-flow");

function createMotoIntakeService({ pool, askLocalKnowledge }) {
  async function enqueueMessage(
    client,
    tenantId,
    sourceMessageId,
    recipientId,
    body,
    sourceTimestamp,
  ) {
    await client.query(
      `INSERT INTO tenant_message_outbox
         (tenant_id, source_message_id, recipient_id, body, expires_at)
       VALUES ($1, $2, $3, $4, TO_TIMESTAMP($5) + INTERVAL '24 hours')
       ON CONFLICT (tenant_id, source_message_id) DO NOTHING`,
      [tenantId, sourceMessageId, recipientId, body, sourceTimestamp],
    );
  }

  async function processIncomingMessage({
    messageId,
    senderId,
    text,
    sourceTimestamp,
    tenant,
  }) {
    if (!tenant?.id || !tenant.display_name || !tenant.privacy_url) {
      throw new Error("Configurazione tenant webhook non valida");
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const inserted = await client.query(
        `INSERT INTO tenant_processed_webhook_messages (tenant_id, message_id)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING
         RETURNING message_id`,
        [tenant.id, messageId],
      );

      if (inserted.rowCount === 0) {
        await client.query("COMMIT");
        return { duplicate: true };
      }

      await client.query(
        `INSERT INTO tenant_moto_conversations (tenant_id, wa_id, step)
         VALUES ($1, $2, 'idle')
         ON CONFLICT (tenant_id, wa_id) DO NOTHING`,
        [tenant.id, senderId],
      );

      const result = await client.query(
        `SELECT tenant_id, wa_id, step, customer_name, motorcycle, issue, availability, consent_at,
                updated_at
         FROM tenant_moto_conversations
         WHERE tenant_id = $1 AND wa_id = $2
         FOR UPDATE`,
        [tenant.id, senderId],
      );
      let conversation = result.rows[0];

      if (
        Date.now() - new Date(conversation.updated_at).getTime() >
        24 * 60 * 60 * 1000
      ) {
        conversation = { ...INITIAL_CONVERSATION, wa_id: senderId };
      }

      let reply;
      let transition = null;
      if (typeof text === "string" && text.length > 2000) {
        reply =
          "Il messaggio è troppo lungo. Invia un testo entro 2000 caratteri.";
      } else if (typeof text === "string" && text.trim()) {
        transition = transitionConversation(conversation, text, {
          workshopName: tenant.display_name,
          privacyUrl: tenant.privacy_url,
        });
      } else {
        reply =
          "Per ora posso gestire messaggi di testo. Scrivi “richiesta officina” per avviare una richiesta o contatta direttamente l'officina.";
      }

      if (transition) {
        conversation = transition.conversation;
        reply = transition.reply;
      } else if (typeof text === "string" && text.trim()) {
        reply = askLocalKnowledge(text.trim(), tenant.knowledge);
      }

      await client.query(
        `UPDATE tenant_moto_conversations
         SET step = $3, customer_name = $4, motorcycle = $5, issue = $6,
             availability = $7, consent_at = $8, updated_at = NOW(),
             expires_at = NOW() + INTERVAL '24 hours'
         WHERE tenant_id = $1 AND wa_id = $2`,
        [
          tenant.id,
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
          `INSERT INTO tenant_moto_service_requests
             (tenant_id, wa_id, customer_name, motorcycle, issue, availability, consent_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            tenant.id,
            senderId,
            request.customer_name,
            request.motorcycle,
            request.issue,
            request.availability,
            request.consent_at,
          ],
        );
      }

      await enqueueMessage(
        client,
        tenant.id,
        messageId,
        senderId,
        reply,
        sourceTimestamp,
      );
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
