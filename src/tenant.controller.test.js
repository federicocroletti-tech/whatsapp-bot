const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createTenantHandlers,
  validateTenantInput,
} = require("./tenant.controller");
const { verifyOperatorPassword } = require("./operator-password");
const { decryptTenantCredential } = require("./tenant-secrets");

const encryptionKey = Buffer.alloc(32, 3);
const config = {
  platformAdminToken: "platform-admin-token-that-is-long-enough-for-tests",
  tenantCredentialEncryptionKey: encryptionKey,
};

function validTenantInput() {
  return {
    slug: "officina-a",
    legalName: "Officina A S.r.l.",
    displayName: "Officina A",
    privacyUrl: "https://officina.example/privacy",
    requestRetentionDays: 180,
    branding: {
      primaryColor: "#123456",
      accentColor: "#abcdef",
      logoUrl: "https://officina.example/logo.png",
    },
    knowledge: {
      orari: "Lun-Ven 9:00-18:00",
      azienda: "Riparazione moto",
    },
    waBusinessAccountId: "123456789012345",
    waPhoneNumberId: "234567890123456",
    waAccessToken: "test-meta-access-token-keep-private",
    operator: {
      username: "responsabile",
      password: "a-strong-password-for-tests",
    },
  };
}

function response() {
  return {
    headers: {},
    statusCode: undefined,
    body: undefined,
    set(name, value) {
      this.headers[name] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    sendStatus(code) {
      this.statusCode = code;
      return this;
    },
  };
}

test("validates tenant branding, legal/privacy settings, Meta credentials and operator password", () => {
  const valid = validateTenantInput(validTenantInput());
  assert.equal(valid.slug, "officina-a");
  assert.equal(valid.requestRetentionDays, 180);
  assert.deepEqual(valid.knowledge, {
    orari: "Lun-Ven 9:00-18:00",
    azienda: "Riparazione moto",
  });

  const invalidCases = [
    { ...validTenantInput(), slug: "Officina A" },
    { ...validTenantInput(), privacyUrl: "http://officina.example/privacy" },
    {
      ...validTenantInput(),
      privacyUrl: "https://user:password@officina.example/privacy",
    },
    { ...validTenantInput(), requestRetentionDays: 0 },
    { ...validTenantInput(), waPhoneNumberId: "phone-id" },
    { ...validTenantInput(), branding: { primaryColor: "green" } },
    {
      ...validTenantInput(),
      operator: { username: "owner", password: "short" },
    },
    { ...validTenantInput(), knowledge: { azienda: "x".repeat(3001) } },
  ];
  for (const invalid of invalidCases)
    assert.equal(validateTenantInput(invalid), null);
});

test("provisions a tenant transactionally without persisting its Meta token or plaintext password", async () => {
  const statements = [];
  let insertedTenant;
  let insertedOperator;
  const pool = {
    async connect() {
      return {
        async query(sql, values = []) {
          statements.push(sql);
          if (sql.includes("INSERT INTO tenants")) {
            insertedTenant = values;
            return {
              rowCount: 1,
              rows: [
                {
                  id: "tenant-uuid",
                  slug: values[0],
                  display_name: values[2],
                  privacy_url: values[3],
                },
              ],
            };
          }
          if (sql.includes("INSERT INTO tenant_operator_users")) {
            insertedOperator = values;
            return { rowCount: 1, rows: [] };
          }
          return { rowCount: 0, rows: [] };
        },
        release() {},
      };
    },
  };
  const handlers = createTenantHandlers({ pool, config });
  const res = response();
  await handlers.createTenant({ body: validTenantInput() }, res);

  assert.equal(res.statusCode, 201);
  assert.deepEqual(res.body, {
    tenant: {
      slug: "officina-a",
      displayName: "Officina A",
      privacyUrl: "https://officina.example/privacy",
    },
    operator: { username: "responsabile", role: "owner" },
  });
  assert.equal(statements[0], "BEGIN");
  assert.match(statements[1], /INSERT INTO tenants/);
  assert.match(statements[2], /INSERT INTO tenant_operator_users/);
  assert.equal(statements[3], "COMMIT");
  assert.notEqual(insertedTenant[9], validTenantInput().waAccessToken);
  assert.equal(
    decryptTenantCredential(insertedTenant[9], encryptionKey),
    validTenantInput().waAccessToken,
  );
  assert.equal(insertedTenant[5], JSON.stringify(validTenantInput().branding));
  assert.equal(insertedTenant[6], JSON.stringify(validTenantInput().knowledge));
  assert.equal(insertedOperator[1], "responsabile");
  assert.notEqual(insertedOperator[2], validTenantInput().operator.password);
  assert.equal(
    await verifyOperatorPassword(
      validTenantInput().operator.password,
      insertedOperator[2],
    ),
    true,
  );
});

test("protects tenant provisioning with the platform bearer token", () => {
  const handlers = createTenantHandlers({
    pool: {},
    config,
  });
  const req = {
    get: () => "Bearer wrong-token",
  };
  const res = response();
  let continued = false;
  handlers.requirePlatformAdmin(req, res, () => {
    continued = true;
  });

  assert.equal(res.statusCode, 401);
  assert.equal(continued, false);

  const authorized = response();
  let authorizedNext = false;
  handlers.requirePlatformAdmin(
    {
      get: () => `Bearer ${config.platformAdminToken}`,
    },
    authorized,
    () => {
      authorizedNext = true;
    },
  );
  assert.equal(authorizedNext, true);
});

test("returns only public tenant branding and privacy details", async () => {
  const handlers = createTenantHandlers({
    config,
    pool: {
      async query(sql, values) {
        assert.match(sql, /display_name, privacy_url, branding/);
        assert.deepEqual(values, ["officina-a"]);
        return {
          rowCount: 1,
          rows: [
            {
              display_name: "Officina A",
              privacy_url: "https://officina.example/privacy",
              branding: { primaryColor: "#123456" },
            },
          ],
        };
      },
    },
  });
  const res = response();
  await handlers.getPublicTenant({ params: { tenantSlug: "officina-a" } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    displayName: "Officina A",
    privacyUrl: "https://officina.example/privacy",
    branding: { primaryColor: "#123456" },
  });
  assert.equal(JSON.stringify(res.body).includes("wa_access_token"), false);
});
