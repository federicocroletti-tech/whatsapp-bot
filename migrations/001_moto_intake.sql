CREATE TABLE IF NOT EXISTS processed_webhook_messages (
  message_id TEXT PRIMARY KEY,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS moto_conversations (
  wa_id TEXT PRIMARY KEY,
  step TEXT NOT NULL CHECK (step IN ('idle', 'consent', 'name', 'motorcycle', 'issue', 'availability')),
  customer_name TEXT,
  motorcycle TEXT,
  issue TEXT,
  availability TEXT,
  consent_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours')
);

CREATE INDEX IF NOT EXISTS moto_conversations_expires_at_idx
  ON moto_conversations (expires_at);

CREATE TABLE IF NOT EXISTS moto_service_requests (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  wa_id TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  motorcycle TEXT NOT NULL,
  issue TEXT NOT NULL,
  availability TEXT NOT NULL,
  consent_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'in_review', 'closed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS moto_service_requests_created_at_idx
  ON moto_service_requests (created_at DESC);

CREATE TABLE IF NOT EXISTS message_outbox (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_message_id TEXT NOT NULL UNIQUE,
  recipient_id TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'expired')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_until TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS message_outbox_pending_idx
  ON message_outbox (next_attempt_at, created_at)
  WHERE status IN ('pending', 'sending');

CREATE TABLE IF NOT EXISTS operator_sessions (
  token_hash CHAR(64) PRIMARY KEY,
  username TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS operator_sessions_expires_at_idx
  ON operator_sessions (expires_at);
