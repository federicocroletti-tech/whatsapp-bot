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

function getRetentionDays(value) {
  const days = Number(value || 30);
  if (!Number.isInteger(days) || days < 1 || days > 3650) {
    throw new Error("REQUEST_RETENTION_DAYS deve essere un intero tra 1 e 3650");
  }
  return days;
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
          (parsed.protocol === "http:" && !["localhost", "127.0.0.1"].includes(parsed.hostname))
        );
      } catch {
        return true;
      }
    })
  ) {
    throw new Error("WEB_ORIGINS deve contenere origini HTTP/HTTPS valide separate da virgola");
  }
  return origins;
}

function getOperatorCredentials() {
  const username = getRequiredEnv("OPERATOR_USERNAME");
  const password = getRequiredEnv("OPERATOR_PASSWORD");

  if (password.length < 16) {
    throw new Error("OPERATOR_PASSWORD deve contenere almeno 16 caratteri");
  }

  return { username, password };
}

const operator = getOperatorCredentials();

module.exports = {
  port: getPort(process.env.PORT),

  token: getRequiredEnv("TOKEN"),

  appSecret: getRequiredEnv("APP_SECRET"),

  phoneNumberId: getRequiredEnv("PHONE_NUMBER_ID"),

  verifyToken: getRequiredEnv("VERIFY_TOKEN"),

  databaseUrl: getRequiredEnv("DATABASE_URL"),

  allowedNumbers: parseAllowedNumbers(process.env.ALLOWED_NUMBERS || ""),

  workshopName: getRequiredEnv("WORKSHOP_NAME"),

  privacyUrl: getRequiredEnv("PRIVACY_URL"),

  requestRetentionDays: getRetentionDays(process.env.REQUEST_RETENTION_DAYS),

  webOrigins: getAllowedOrigins(getRequiredEnv("WEB_ORIGINS")),

  operator,
};
