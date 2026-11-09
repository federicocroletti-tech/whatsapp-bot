const { promisify } = require("node:util");
const { randomBytes, scrypt, timingSafeEqual } = require("node:crypto");

const scryptAsync = promisify(scrypt);
const KEY_LENGTH = 64;
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

async function hashOperatorPassword(password) {
  const salt = randomBytes(16);
  const derivedKey = await scryptAsync(
    password,
    salt,
    KEY_LENGTH,
    SCRYPT_OPTIONS,
  );
  return `scrypt$16384$8$1$${salt.toString("base64url")}$${Buffer.from(derivedKey).toString("base64url")}`;
}

async function verifyOperatorPassword(password, encodedHash) {
  const match =
    /^scrypt\$16384\$8\$1\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{86})$/.exec(
      encodedHash,
    );
  if (!match) return false;

  const salt = Buffer.from(match[1], "base64url");
  const expected = Buffer.from(match[2], "base64url");
  if (salt.length !== 16 || expected.length !== KEY_LENGTH) return false;

  const actual = Buffer.from(
    await scryptAsync(password, salt, KEY_LENGTH, SCRYPT_OPTIONS),
  );
  return timingSafeEqual(actual, expected);
}

module.exports = { hashOperatorPassword, verifyOperatorPassword };
