const { pool } = require("./database");
const { sendMessage } = require("./whatsapp.service");
const config = require("./config");
const { decryptTenantCredential } = require("./tenant-secrets");

const MAX_ATTEMPTS = 5;
const POLL_INTERVAL_MS = 2000;
const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
let running = false;
let timer;
let lastCleanupAt = 0;

async function claimPendingMessages() {
  const result = await pool.query(
    `WITH pending AS (
       SELECT outbox.id
       FROM tenant_message_outbox AS outbox
       JOIN tenants AS tenant ON tenant.id = outbox.tenant_id AND tenant.status = 'active'
       WHERE outbox.expires_at > NOW()
         AND ((outbox.status = 'pending' AND outbox.next_attempt_at <= NOW())
          OR (outbox.status = 'sending' AND outbox.lease_until < NOW()))
       ORDER BY outbox.created_at
       FOR UPDATE OF outbox SKIP LOCKED
       LIMIT 10
     ),
     claimed AS (
       UPDATE tenant_message_outbox AS outbox
       SET status = 'sending',
           attempts = outbox.attempts + 1,
           lease_until = NOW() + INTERVAL '1 minute'
       FROM pending
       WHERE outbox.id = pending.id
       RETURNING outbox.id, outbox.tenant_id, outbox.recipient_id, outbox.body, outbox.attempts
     )
     SELECT claimed.id, claimed.tenant_id, claimed.recipient_id, claimed.body, claimed.attempts,
            tenant.wa_phone_number_id, tenant.wa_access_token_encrypted
     FROM claimed
     JOIN tenants AS tenant ON tenant.id = claimed.tenant_id
     WHERE tenant.status = 'active'`,
  );
  return result.rows.map((row) => ({
    id: row.id,
    tenantId: row.tenant_id,
    recipientId: row.recipient_id,
    body: row.body,
    attempts: row.attempts,
    phoneNumberId: row.wa_phone_number_id,
    encryptedAccessToken: row.wa_access_token_encrypted,
  }));
}

async function expireOutdatedMessages() {
  await pool.query(
    `UPDATE tenant_message_outbox
     SET status = 'expired', lease_until = NULL
     WHERE status IN ('pending', 'sending') AND expires_at <= NOW()`,
  );
}

async function cleanRetainedData() {
  const now = Date.now();
  if (now - lastCleanupAt < CLEANUP_INTERVAL_MS) return;

  await pool.query(
    `DELETE FROM tenant_moto_service_requests AS request
     USING tenants AS tenant
     WHERE request.tenant_id = tenant.id
       AND request.created_at <= NOW() - (tenant.request_retention_days * INTERVAL '1 day')`,
  );
  await pool.query(
    `DELETE FROM tenant_moto_conversations
     WHERE expires_at <= NOW()`,
  );
  await pool.query(
    `DELETE FROM tenant_processed_webhook_messages
     WHERE processed_at <= NOW() - INTERVAL '30 days'`,
  );
  await pool.query(
    `DELETE FROM tenant_message_outbox
     WHERE status IN ('sent', 'failed', 'expired')
       AND created_at <= NOW() - INTERVAL '30 days'`,
  );
  await pool.query(
    "DELETE FROM tenant_operator_sessions WHERE expires_at <= NOW()",
  );
  lastCleanupAt = now;
}

async function markSent(id) {
  await pool.query(
    `UPDATE tenant_message_outbox
     SET status = 'sent', sent_at = NOW(), lease_until = NULL
     WHERE id = $1`,
    [id],
  );
}

async function markFailed(message, error) {
  const terminal = message.attempts >= MAX_ATTEMPTS;
  const retrySeconds = Math.min(300, 10 * 2 ** (message.attempts - 1));
  await pool.query(
    `UPDATE tenant_message_outbox
     SET status = $2,
         next_attempt_at = NOW() + ($3 * INTERVAL '1 second'),
         lease_until = NULL,
         last_error = $4
     WHERE id = $1`,
    [
      message.id,
      terminal ? "failed" : "pending",
      retrySeconds,
      error.response?.status
        ? `http_${error.response.status}`
        : error.code || "send_failed",
    ],
  );
}

async function deliverPendingMessages() {
  if (running) return;
  running = true;

  try {
    await expireOutdatedMessages();
    await cleanRetainedData();
    const messages = await claimPendingMessages();
    for (const message of messages) {
      try {
        const accessToken = decryptTenantCredential(
          message.encryptedAccessToken,
          config.tenantCredentialEncryptionKey,
        );
        await sendMessage(
          message.phoneNumberId,
          accessToken,
          message.recipientId,
          message.body,
        );
        await markSent(message.id);
      } catch (error) {
        await markFailed(message, error);
        console.error(
          "Invio WhatsApp non riuscito:",
          error.response?.status || error.code || "unknown",
        );
      }
    }
  } finally {
    running = false;
  }
}

function startOutboxWorker() {
  if (timer) return;
  timer = setInterval(() => {
    deliverPendingMessages().catch((error) => {
      console.error("Errore del worker WhatsApp:", error.code || "unknown");
    });
  }, POLL_INTERVAL_MS);
  timer.unref();
  return deliverPendingMessages();
}

module.exports = { deliverPendingMessages, startOutboxWorker };
