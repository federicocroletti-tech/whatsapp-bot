const test = require("node:test");
const assert = require("node:assert/strict");
const { createHmac } = require("node:crypto");
const { createWebhookHandlers } = require("./webhook.controller");

const config = {
  appSecret: "test-app-secret",
  verifyToken: "verify-token",
  allowedNumbers: [],
};
const tenant = {
  id: "tenant-a",
  display_name: "Officina Test",
  privacy_url: "https://example.test/privacy",
  knowledge: {},
};

function createHandlers(processIncomingMessage = async () => {}) {
  return createWebhookHandlers({
    config,
    processIncomingMessage,
    resolveTenant: async (phoneNumberId) =>
      phoneNumberId === "phone-a" ? tenant : null,
  });
}

function createResponse() {
  return {
    statusCode: undefined,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    },
    sendStatus(code) {
      this.statusCode = code;
      return this;
    },
  };
}

function signedRequest(body, signatureOverride) {
  const rawBody = Buffer.from(JSON.stringify(body));
  const signature =
    signatureOverride ??
    `sha256=${createHmac("sha256", config.appSecret).update(rawBody).digest("hex")}`;
  return {
    body,
    rawBody,
    get(name) {
      return name.toLowerCase() === "x-hub-signature-256"
        ? signature
        : undefined;
    },
  };
}

test("verifies the Meta webhook challenge and rejects incorrect tokens", () => {
  const { verify } = createHandlers();
  const valid = createResponse();
  verify(
    {
      query: {
        "hub.mode": "subscribe",
        "hub.verify_token": "verify-token",
        "hub.challenge": "challenge-value",
      },
    },
    valid,
  );
  assert.equal(valid.statusCode, 200);
  assert.equal(valid.body, "challenge-value");

  const invalid = createResponse();
  verify(
    {
      query: {
        "hub.mode": "subscribe",
        "hub.verify_token": "wrong-token",
        "hub.challenge": "challenge-value",
      },
    },
    invalid,
  );
  assert.equal(invalid.statusCode, 403);
});

test("rejects requests with an invalid Meta signature without processing messages", async () => {
  let processed = false;
  const { handleMessage } = createHandlers(async () => {
    processed = true;
  });
  const response = createResponse();
  await handleMessage(
    signedRequest({ entry: [] }, `sha256=${"0".repeat(64)}`),
    response,
  );
  assert.equal(response.statusCode, 401);
  assert.equal(processed, false);
});

test("processes text messages, business-scoped sender IDs, and ignores status-only events", async () => {
  const received = [];
  const { handleMessage } = createHandlers(async (message) =>
    received.push(message),
  );
  const body = {
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: "phone-a" },
              messages: [
                {
                  id: "wamid.1",
                  from: "123",
                  timestamp: "1762560000",
                  type: "text",
                  text: { body: "tagliando" },
                },
                {
                  id: "wamid.2",
                  from_user_id: "bsuid.2",
                  timestamp: "1762560001",
                  type: "image",
                },
              ],
              statuses: [{ id: "wamid.sent", status: "delivered" }],
            },
          },
        ],
      },
    ],
  };
  const response = createResponse();
  await handleMessage(signedRequest(body), response);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(received, [
    {
      messageId: "wamid.1",
      senderId: "123",
      text: "tagliando",
      sourceTimestamp: 1762560000,
      tenant,
    },
    {
      messageId: "wamid.2",
      senderId: "bsuid.2",
      text: null,
      sourceTimestamp: 1762560001,
      tenant,
    },
  ]);
});

test("enforces the configured sender allowlist", async () => {
  const received = [];
  const { handleMessage } = createWebhookHandlers({
    config: { ...config, allowedNumbers: ["trusted-sender"] },
    processIncomingMessage: async (message) => received.push(message),
    resolveTenant: async () => tenant,
  });
  const response = createResponse();
  await handleMessage(
    signedRequest({
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: "phone-a" },
                messages: [
                  {
                    id: "wamid.untrusted",
                    from: "other-sender",
                    timestamp: "1762560000",
                    type: "text",
                    text: { body: "hello" },
                  },
                ],
              },
            },
          ],
        },
      ],
    }),
    response,
  );
  assert.equal(response.statusCode, 200);
  assert.deepEqual(received, []);
});

test("does not route webhook messages for an unconfigured WhatsApp number", async () => {
  let processed = false;
  const { handleMessage } = createWebhookHandlers({
    config,
    processIncomingMessage: async () => {
      processed = true;
    },
    resolveTenant: async () => null,
  });
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const response = createResponse();
    await handleMessage(
      signedRequest({
        entry: [
          {
            changes: [
              {
                value: {
                  metadata: { phone_number_id: "unconfigured-phone" },
                  messages: [
                    {
                      id: "wamid.unknown-tenant",
                      from: "sender",
                      timestamp: "1762560000",
                      type: "text",
                      text: { body: "tagliando" },
                    },
                  ],
                },
              },
            ],
          },
        ],
      }),
      response,
    );
    assert.equal(response.statusCode, 200);
    assert.equal(processed, false);
  } finally {
    console.warn = originalWarn;
  }
});

test("ignores messages without a usable Meta event timestamp", async () => {
  const received = [];
  const { handleMessage } = createHandlers(async (message) =>
    received.push(message),
  );
  const response = createResponse();
  await handleMessage(
    signedRequest({
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: "phone-a" },
                messages: [
                  {
                    id: "wamid.no-timestamp",
                    from: "sender",
                    type: "text",
                    text: { body: "tagliando" },
                  },
                ],
              },
            },
          ],
        },
      ],
    }),
    response,
  );
  assert.equal(response.statusCode, 200);
  assert.deepEqual(received, []);
});
