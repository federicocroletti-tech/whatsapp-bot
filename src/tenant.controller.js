const { createHash, timingSafeEqual } = require("node:crypto");
const { hashOperatorPassword } = require("./operator-password");
const { encryptTenantCredential } = require("./tenant-secrets");

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const WHATSAPP_ID_PATTERN = /^\d{5,32}$/;
const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedString(value, min, max) {
  return (
    typeof value === "string" &&
    value.trim().length >= min &&
    value.trim().length <= max
  );
}

function isHttpsUrl(value, required = false) {
  if (value === undefined && !required) return true;
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

function validateTenantInput(body) {
  if (!isObject(body) || !isObject(body.operator)) return null;

  const { branding = {}, knowledge = {} } = body;
  if (!isObject(branding) || !isObject(knowledge)) return null;

  const retentionDays = body.requestRetentionDays ?? 30;
  if (
    !Number.isInteger(retentionDays) ||
    retentionDays < 1 ||
    retentionDays > 3650
  )
    return null;

  if (
    typeof body.slug !== "string" ||
    !SLUG_PATTERN.test(body.slug) ||
    !boundedString(body.legalName, 2, 200) ||
    !boundedString(body.displayName, 2, 100) ||
    !isHttpsUrl(body.privacyUrl, true) ||
    typeof body.waBusinessAccountId !== "string" ||
    !WHATSAPP_ID_PATTERN.test(body.waBusinessAccountId) ||
    typeof body.waPhoneNumberId !== "string" ||
    !WHATSAPP_ID_PATTERN.test(body.waPhoneNumberId) ||
    !boundedString(body.waAccessToken, 20, 4096) ||
    !boundedString(body.operator.username, 1, 128) ||
    !boundedString(body.operator.password, 16, 256)
  ) {
    return null;
  }

  if (
    (branding.primaryColor !== undefined &&
      !HEX_COLOR_PATTERN.test(branding.primaryColor)) ||
    (branding.accentColor !== undefined &&
      !HEX_COLOR_PATTERN.test(branding.accentColor)) ||
    !isHttpsUrl(branding.logoUrl)
  ) {
    return null;
  }

  const normalizedKnowledge = {};
  for (const key of ["orari", "prezzi", "azienda"]) {
    const value = knowledge[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || value.length > 3000) return null;
    normalizedKnowledge[key] = value.trim();
  }

  return {
    slug: body.slug,
    legalName: body.legalName.trim(),
    displayName: body.displayName.trim(),
    privacyUrl: body.privacyUrl,
    requestRetentionDays: retentionDays,
    branding: {
      ...(branding.primaryColor ? { primaryColor: branding.primaryColor } : {}),
      ...(branding.accentColor ? { accentColor: branding.accentColor } : {}),
      ...(branding.logoUrl ? { logoUrl: branding.logoUrl } : {}),
    },
    knowledge: normalizedKnowledge,
    waBusinessAccountId: body.waBusinessAccountId,
    waPhoneNumberId: body.waPhoneNumberId,
    waAccessToken: body.waAccessToken.trim(),
    operator: {
      username: body.operator.username.trim(),
      password: body.operator.password,
    },
  };
}

function safeTokenEqual(received, expected) {
  const left = createHash("sha256").update(String(received)).digest();
  const right = createHash("sha256").update(String(expected)).digest();
  return timingSafeEqual(left, right);
}

function createTenantHandlers({ pool, config }) {
  function requirePlatformAdmin(req, res, next) {
    const authorization = req.get("authorization") || "";
    const match = /^Bearer (.+)$/.exec(authorization);
    if (!match || !safeTokenEqual(match[1], config.platformAdminToken)) {
      return res.sendStatus(401);
    }
    return next();
  }

  async function createTenant(req, res) {
    res.set("Cache-Control", "no-store");
    const tenant = validateTenantInput(req.body);
    if (!tenant) {
      return res
        .status(400)
        .json({ error: "Configurazione tenant non valida" });
    }

    const passwordHash = await hashOperatorPassword(tenant.operator.password);
    const encryptedAccessToken = encryptTenantCredential(
      tenant.waAccessToken,
      config.tenantCredentialEncryptionKey,
    );
    const client = await pool.connect();

    try {
      await client.query("BEGIN");
      const created = await client.query(
        `INSERT INTO tenants
           (slug, legal_name, display_name, privacy_url, request_retention_days,
            branding, knowledge, wa_business_account_id, wa_phone_number_id,
            wa_access_token_encrypted)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10)
         RETURNING id, slug, display_name, privacy_url`,
        [
          tenant.slug,
          tenant.legalName,
          tenant.displayName,
          tenant.privacyUrl,
          tenant.requestRetentionDays,
          JSON.stringify(tenant.branding),
          JSON.stringify(tenant.knowledge),
          tenant.waBusinessAccountId,
          tenant.waPhoneNumberId,
          encryptedAccessToken,
        ],
      );
      await client.query(
        `INSERT INTO tenant_operator_users (tenant_id, username, password_hash, role)
         VALUES ($1, $2, $3, 'owner')`,
        [created.rows[0].id, tenant.operator.username, passwordHash],
      );
      await client.query("COMMIT");
      return res.status(201).json({
        tenant: {
          slug: created.rows[0].slug,
          displayName: created.rows[0].display_name,
          privacyUrl: created.rows[0].privacy_url,
        },
        operator: { username: tenant.operator.username, role: "owner" },
      });
    } catch (error) {
      await client.query("ROLLBACK");
      if (error.code === "23505") {
        return res
          .status(409)
          .json({ error: "Slug o numero WhatsApp già configurato" });
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async function getPublicTenant(req, res) {
    res.set("Cache-Control", "no-store");
    const { tenantSlug } = req.params;
    if (!SLUG_PATTERN.test(tenantSlug)) return res.sendStatus(404);

    const result = await pool.query(
      `SELECT display_name, privacy_url, branding
       FROM tenants
       WHERE slug = $1 AND status = 'active'`,
      [tenantSlug],
    );
    if (result.rowCount === 0) return res.sendStatus(404);

    return res.status(200).json({
      displayName: result.rows[0].display_name,
      privacyUrl: result.rows[0].privacy_url,
      branding: result.rows[0].branding,
    });
  }

  return { createTenant, getPublicTenant, requirePlatformAdmin };
}

module.exports = { createTenantHandlers, validateTenantInput };
