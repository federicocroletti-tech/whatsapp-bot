const { pool } = require("./database");
const { sendMessage } = require("./whatsapp.service");
const config = require("./config");

const MAX_ATTEMPTS = 5;
const POLL_INTERVAL_MS = 2000;
const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
let running = false;
let timer;
let lastCleanupAt = 0;

async function claimPendingMessages() {
  const result = await pool.query(
    `WITH pending AS (
       SELECT id
       FROM message_outbox
       WHERE expires_at > NOW()
         AND ((status = 'pending' AND next_attempt_at <= NOW())
          OR (status = 'sending' AND lease_until < NOW()))
       ORDER BY created_at
       FOR UPDATE SKIP LOCKED
       LIMIT 10
     )
     UPDATE message_outbox AS outbox
     SET status = 'sending',
         attempts = outbox.attempts + 1,
         lease_until = NOW() + INTERVAL '1 minute'
     FROM pending
     WHERE outbox.id = pending.id
     RETURNING outbox.id, outbox.recipient_id, outbox.body, outbox.attempts`,
  );
  return result.rows;
}

async function expireOutdatedMessages() {
  await pool.query(
    `UPDATE message_outbox
     SET status = 'expired', lease_until = NULL
     WHERE status IN ('pending', 'sending') AND expires_at <= NOW()`,
  );
}

async function cleanRetainedData() {
  const now = Date.now();
  if (now - lastCleanupAt < CLEANUP_INTERVAL_MS) return;

  await pool.query(
    `DELETE FROM moto_service_requests
     WHERE created_at <= NOW() - ($1 * INTERVAL '1 day')`,
    [config.requestRetentionDays],
  );
  await pool.query(
    `DELETE FROM moto_conversations
     WHERE expires_at <= NOW()`,
  );
  await pool.query(
    `DELETE FROM processed_webhook_messages
     WHERE processed_at <= NOW() - INTERVAL '30 days'`,
  );
  await pool.query(
    `DELETE FROM message_outbox
     WHERE status IN ('sent', 'failed', 'expired')
       AND created_at <= NOW() - INTERVAL '30 days'`,
  );
  lastCleanupAt = now;
}

async function markSent(id) {
  await pool.query(
    `UPDATE message_outbox
     SET status = 'sent', sent_at = NOW(), lease_until = NULL
     WHERE id = $1`,
    [id],
  );
}

async function markFailed(message, error) {
  const terminal = message.attempts >= MAX_ATTEMPTS;
  const retrySeconds = Math.min(300, 10 * 2 ** (message.attempts - 1));
  await pool.query(
    `UPDATE message_outbox
     SET status = $2,
         next_attempt_at = NOW() + ($3 * INTERVAL '1 second'),
         lease_until = NULL,
         last_error = $4
     WHERE id = $1`,
    [
      message.id,
      terminal ? "failed" : "pending",
      retrySeconds,
      error.response?.status ? `http_${error.response.status}` : error.code || "send_failed",
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
        await sendMessage(message.recipient_id, message.body);
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
