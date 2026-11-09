const test = require("node:test");
const assert = require("node:assert/strict");
const {
  decryptTenantCredential,
  encryptTenantCredential,
} = require("./tenant-secrets");

const key = Buffer.alloc(32, 7);

test("encrypts tenant credentials with authenticated encryption and unique nonces", () => {
  const first = encryptTenantCredential("tenant-secret-token", key);
  const second = encryptTenantCredential("tenant-secret-token", key);

  assert.notEqual(first, second);
  assert.equal(decryptTenantCredential(first, key), "tenant-secret-token");
  assert.equal(decryptTenantCredential(second, key), "tenant-secret-token");
  assert.ok(!first.includes("tenant-secret-token"));
});

test("rejects tampered envelopes and incorrect encryption keys", () => {
  const encrypted = encryptTenantCredential("tenant-secret-token", key);
  const [version, iv, tag, ciphertext] = encrypted.split(".");
  const replacement = ciphertext[0] === "A" ? "B" : "A";
  const tampered = `${version}.${iv}.${tag}.${replacement}${ciphertext.slice(1)}`;

  assert.throws(() => decryptTenantCredential(tampered, key));
  assert.throws(() => decryptTenantCredential(encrypted, Buffer.alloc(32, 8)));
  assert.throws(() => decryptTenantCredential(undefined, key), /non valida/);
});
