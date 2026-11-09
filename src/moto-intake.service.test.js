const test = require("node:test");
const assert = require("node:assert/strict");
const { createMotoIntakeService } = require("./moto-intake.service");

function createMemoryPool() {
  const processed = new Set();
  const conversations = new Map();
  const requests = [];
  const outbox = [];
  const statements = [];

  return {
    processed,
    conversations,
    requests,
    outbox,
    statements,
    async connect() {
      return {
        async query(sql, params = []) {
          statements.push(sql);
          if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
            return { rowCount: 0, rows: [] };
          }
          if (sql.includes("INSERT INTO tenant_processed_webhook_messages")) {
            const key = `${params[0]}:${params[1]}`;
            if (processed.has(key)) return { rowCount: 0, rows: [] };
            processed.add(key);
            return { rowCount: 1, rows: [{ message_id: params[1] }] };
          }
          if (sql.includes("INSERT INTO tenant_moto_conversations")) {
            const key = `${params[0]}:${params[1]}`;
            if (!conversations.has(key)) {
              conversations.set(key, {
                tenant_id: params[0],
                wa_id: params[1],
                step: "idle",
                customer_name: null,
                motorcycle: null,
                issue: null,
                availability: null,
                consent_at: null,
                updated_at: new Date(),
              });
            }
            return { rowCount: 1, rows: [] };
          }
          if (sql.includes("SELECT tenant_id, wa_id, step")) {
            return {
              rowCount: 1,
              rows: [conversations.get(`${params[0]}:${params[1]}`)],
            };
          }
          if (sql.includes("UPDATE tenant_moto_conversations")) {
            const conversation = conversations.get(`${params[0]}:${params[1]}`);
            Object.assign(conversation, {
              step: params[2],
              customer_name: params[3],
              motorcycle: params[4],
              issue: params[5],
              availability: params[6],
              consent_at: params[7],
              updated_at: new Date(),
            });
            return { rowCount: 1, rows: [] };
          }
          if (sql.includes("INSERT INTO tenant_moto_service_requests")) {
            requests.push(params);
            return { rowCount: 1, rows: [] };
          }
          if (sql.includes("INSERT INTO tenant_message_outbox")) {
            outbox.push(params);
            return { rowCount: 1, rows: [] };
          }
          throw new Error(`SQL non gestita nel test: ${sql}`);
        },
        release() {},
      };
    },
  };
}

function createService(pool, options = {}) {
  const calls = { ai: [], local: [] };
  const tenant = options.tenant ?? {
    id: "tenant-a",
    display_name: "Officina Test",
    privacy_url: "https://example.test/privacy",
    knowledge: {},
  };
  const service = createMotoIntakeService({
    pool,
    askLocalKnowledge: (text, knowledge) => {
      calls.local.push({ text, knowledge });
      return "risposta locale";
    },
  });
  return {
    ...service,
    processIncomingMessage: (message) =>
      service.processIncomingMessage({ ...message, tenant }),
    calls,
  };
}

test("persists an explicitly consented intake and queues replies transactionally", async () => {
  const pool = createMemoryPool();
  const { processIncomingMessage } = createService(pool);
  const senderId = "whatsapp-user";
  const messages = [
    ["m1", "Vorrei un tagliando"],
    ["m2", "Sì"],
    ["m3", "Mario Rossi"],
    ["m4", "Honda SH 300 del 2020"],
    ["m5", "Il freno anteriore fa rumore"],
    ["m6", "Dopo le 17 nei giorni feriali"],
  ];

  for (const [messageId, text] of messages) {
    await processIncomingMessage({
      messageId,
      senderId,
      text,
      sourceTimestamp: 1762560000,
    });
  }

  assert.equal(pool.requests.length, 1);
  assert.equal(pool.requests[0][0], "tenant-a");
  assert.equal(pool.requests[0][1], senderId);
  assert.deepEqual(pool.requests[0].slice(2, 6), [
    "Mario Rossi",
    "Honda SH 300 del 2020",
    "Il freno anteriore fa rumore",
    "Dopo le 17 nei giorni feriali",
  ]);
  assert.ok(pool.requests[0][6]);
  assert.equal(pool.outbox.length, messages.length);
  assert.equal(pool.outbox.at(-1)[0], "tenant-a");
  assert.match(pool.outbox.at(-1)[3], /non conferma un appuntamento/);
  assert.equal(pool.outbox.at(-1)[4], 1762560000);
  assert.equal(
    pool.statements.filter((sql) => sql === "COMMIT").length,
    messages.length,
  );
});

test("does not reprocess a duplicate Meta webhook message", async () => {
  const pool = createMemoryPool();
  const { processIncomingMessage } = createService(pool);
  const message = {
    messageId: "wamid.duplicate",
    senderId: "user",
    text: "tagliando",
    sourceTimestamp: 1762560000,
  };

  assert.deepEqual(await processIncomingMessage(message), { duplicate: false });
  assert.deepEqual(await processIncomingMessage(message), { duplicate: true });
  assert.equal(pool.outbox.length, 1);
  assert.equal(pool.statements.filter((sql) => sql === "COMMIT").length, 2);
});

test("keeps generic WhatsApp messages local", async () => {
  const pool = createMemoryPool();
  const { processIncomingMessage, calls } = createService(pool, {
    tenant: {
      id: "tenant-a",
      display_name: "Officina Test",
      privacy_url: "https://example.test/privacy",
      knowledge: { orari: "Lunedì-venerdì 9:00-18:00" },
    },
  });
  await processIncomingMessage({
    messageId: "wamid.greeting",
    senderId: "user",
    text: "Buongiorno",
    sourceTimestamp: 1762560000,
  });

  assert.deepEqual(calls.local, [
    { text: "Buongiorno", knowledge: { orari: "Lunedì-venerdì 9:00-18:00" } },
  ]);
});

test("keeps sender conversations and deduplication scoped to each tenant", async () => {
  const pool = createMemoryPool();
  const tenantA = createService(pool, {
    tenant: {
      id: "tenant-a",
      display_name: "Officina A",
      privacy_url: "https://example.test/a",
      knowledge: {},
    },
  });
  const tenantB = createService(pool, {
    tenant: {
      id: "tenant-b",
      display_name: "Officina B",
      privacy_url: "https://example.test/b",
      knowledge: {},
    },
  });
  const message = {
    messageId: "wamid.shared",
    senderId: "same-customer",
    text: "tagliando",
    sourceTimestamp: 1762560000,
  };

  assert.deepEqual(await tenantA.processIncomingMessage(message), {
    duplicate: false,
  });
  assert.deepEqual(await tenantB.processIncomingMessage(message), {
    duplicate: false,
  });
  assert.equal(pool.processed.size, 2);
  assert.equal(pool.conversations.size, 2);
  assert.equal(pool.outbox.length, 2);
});
