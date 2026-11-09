CREATE TABLE IF NOT EXISTS tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE,
  legal_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  privacy_url TEXT NOT NULL,
  request_retention_days INTEGER NOT NULL DEFAULT 30
    CHECK (request_retention_days BETWEEN 1 AND 3650),
  branding JSONB NOT NULL DEFAULT '{}'::jsonb,
  knowledge JSONB NOT NULL DEFAULT '{}'::jsonb,
  wa_business_account_id TEXT NOT NULL,
  wa_phone_number_id TEXT NOT NULL UNIQUE,
  wa_access_token_encrypted TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tenant_operator_users (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  username TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner', 'operator')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, username),
  UNIQUE (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS tenant_operator_sessions (
  token_hash CHAR(64) PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  operator_id BIGINT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (tenant_id, operator_id)
    REFERENCES tenant_operator_users(tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS tenant_operator_sessions_expires_at_idx
  ON tenant_operator_sessions (expires_at);

CREATE TABLE IF NOT EXISTS tenant_processed_webhook_messages (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, message_id)
);

CREATE INDEX IF NOT EXISTS tenant_processed_webhook_messages_processed_at_idx
  ON tenant_processed_webhook_messages (processed_at);

CREATE TABLE IF NOT EXISTS tenant_moto_conversations (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  wa_id TEXT NOT NULL,
  step TEXT NOT NULL CHECK (step IN ('idle', 'consent', 'name', 'motorcycle', 'issue', 'availability')),
  customer_name TEXT,
  motorcycle TEXT,
  issue TEXT,
  availability TEXT,
  consent_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
  PRIMARY KEY (tenant_id, wa_id)
);

CREATE INDEX IF NOT EXISTS tenant_moto_conversations_expires_at_idx
  ON tenant_moto_conversations (expires_at);

CREATE TABLE IF NOT EXISTS tenant_moto_service_requests (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  wa_id TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  motorcycle TEXT NOT NULL,
  issue TEXT NOT NULL,
  availability TEXT NOT NULL,
  consent_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'in_review', 'closed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS tenant_moto_service_requests_tenant_created_at_idx
  ON tenant_moto_service_requests (tenant_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS tenant_message_outbox (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source_message_id TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'expired')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_until TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ,
  UNIQUE (tenant_id, source_message_id)
);

CREATE INDEX IF NOT EXISTS tenant_message_outbox_pending_idx
  ON tenant_message_outbox (next_attempt_at, created_at)
  WHERE status IN ('pending', 'sending');

CREATE INDEX IF NOT EXISTS tenant_message_outbox_created_at_idx
  ON tenant_message_outbox (created_at);
