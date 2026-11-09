require("dotenv").config();

function getRequiredEnv(name) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Variabile ambiente mancante: ${name}`);
  }

  return value;
}

function parseAllowedNumbers(value) {
  return value
    .split(",")
    .map((number) => number.trim())
    .filter(Boolean);
}

function getPort(value) {
  const port = Number(value || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT deve essere un numero tra 1 e 65535");
  }
  return port;
}

function getAllowedOrigins(value) {
  const origins = value
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (
    origins.length === 0 ||
    origins.some((origin) => {
      try {
        const parsed = new URL(origin);
        return (
          parsed.origin !== origin ||
          !["http:", "https:"].includes(parsed.protocol) ||
          (parsed.protocol === "http:" &&
            !["localhost", "127.0.0.1"].includes(parsed.hostname))
        );
      } catch {
        return true;
      }
    })
  ) {
    throw new Error(
      "WEB_ORIGINS deve contenere origini HTTP/HTTPS valide separate da virgola",
    );
  }
  return origins;
}

function getEncryptionKey(value) {
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) {
    throw new Error(
      "TENANT_CREDENTIAL_ENCRYPTION_KEY deve essere una chiave Base64 di 32 byte",
    );
  }
  return key;
}

function getPlatformAdminToken() {
  const token = getRequiredEnv("PLATFORM_ADMIN_TOKEN");
  if (token.length < 32) {
    throw new Error("PLATFORM_ADMIN_TOKEN deve contenere almeno 32 caratteri");
  }
  return token;
}

module.exports = {
  port: getPort(process.env.PORT),
  appSecret: getRequiredEnv("APP_SECRET"),
  verifyToken: getRequiredEnv("VERIFY_TOKEN"),
  databaseUrl: getRequiredEnv("DATABASE_URL"),
  allowedNumbers: parseAllowedNumbers(process.env.ALLOWED_NUMBERS || ""),
  webOrigins: getAllowedOrigins(getRequiredEnv("WEB_ORIGINS")),
  tenantCredentialEncryptionKey: getEncryptionKey(
    getRequiredEnv("TENANT_CREDENTIAL_ENCRYPTION_KEY"),
  ),
  platformAdminToken: getPlatformAdminToken(),
};
