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
          if (sql.includes("INSERT INTO processed_webhook_messages")) {
            if (processed.has(params[0])) return { rowCount: 0, rows: [] };
            processed.add(params[0]);
            return { rowCount: 1, rows: [{ message_id: params[0] }] };
          }
          if (sql.includes("INSERT INTO moto_conversations")) {
            if (!conversations.has(params[0])) {
              conversations.set(params[0], {
                wa_id: params[0],
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
          if (sql.includes("SELECT wa_id, step")) {
            return { rowCount: 1, rows: [conversations.get(params[0])] };
          }
          if (sql.includes("UPDATE moto_conversations")) {
            const conversation = conversations.get(params[0]);
            Object.assign(conversation, {
              step: params[1],
              customer_name: params[2],
              motorcycle: params[3],
              issue: params[4],
              availability: params[5],
              consent_at: params[6],
              updated_at: new Date(),
            });
            return { rowCount: 1, rows: [] };
          }
          if (sql.includes("INSERT INTO moto_service_requests")) {
            requests.push(params);
            return { rowCount: 1, rows: [] };
          }
          if (sql.includes("INSERT INTO message_outbox")) {
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
  const service = createMotoIntakeService({
    pool,
    config: {
      workshopName: "Officina Test",
      privacyUrl: "https://example.test/privacy",
      ...options.config,
    },
    askLocalKnowledge: (text) => {
      calls.local.push(text);
      return "risposta locale";
    },
  });
  return { ...service, calls };
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
    await processIncomingMessage({ messageId, senderId, text, sourceTimestamp: 1762560000 });
  }

  assert.equal(pool.requests.length, 1);
  assert.equal(pool.requests[0][0], senderId);
  assert.deepEqual(pool.requests[0].slice(1, 5), [
    "Mario Rossi",
    "Honda SH 300 del 2020",
    "Il freno anteriore fa rumore",
    "Dopo le 17 nei giorni feriali",
  ]);
  assert.ok(pool.requests[0][5]);
  assert.equal(pool.outbox.length, messages.length);
  assert.match(pool.outbox.at(-1)[2], /non conferma un appuntamento/);
  assert.equal(pool.outbox.at(-1)[3], 1762560000);
  assert.equal(pool.statements.filter((sql) => sql === "COMMIT").length, messages.length);
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
  const { processIncomingMessage, calls } = createService(pool);
  await processIncomingMessage({
    messageId: "wamid.greeting",
    senderId: "user",
    text: "Buongiorno",
    sourceTimestamp: 1762560000,
  });

  assert.deepEqual(calls.local, ["Buongiorno"]);
});
