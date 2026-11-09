const {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} = require("node:crypto");

function encryptTenantCredential(value, key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error("La chiave di cifratura tenant deve essere di 32 byte");
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

function decryptTenantCredential(envelope, key) {
  if (typeof envelope !== "string") {
    throw new Error("Credenziale tenant cifrata non valida");
  }
  const [version, encodedIv, encodedTag, encodedCiphertext, ...extra] =
    envelope.split(".");
  if (
    version !== "v1" ||
    !encodedIv ||
    !encodedTag ||
    !encodedCiphertext ||
    extra.length > 0
  ) {
    throw new Error("Credenziale tenant cifrata non valida");
  }
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error("La chiave di cifratura tenant deve essere di 32 byte");
  }

  const iv = Buffer.from(encodedIv, "base64url");
  const tag = Buffer.from(encodedTag, "base64url");
  const ciphertext = Buffer.from(encodedCiphertext, "base64url");
  if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) {
    throw new Error("Credenziale tenant cifrata non valida");
  }

  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");
}

module.exports = { decryptTenantCredential, encryptTenantCredential };
