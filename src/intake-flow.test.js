const test = require("node:test");
const assert = require("node:assert/strict");
const { INITIAL_CONVERSATION, isIntakeIntent, transitionConversation } = require("./intake-flow");

const config = {
  workshopName: "Officina Test",
  privacyUrl: "https://example.test/privacy",
};

function step(conversation, text) {
  return transitionConversation(conversation, text, config);
}

test("recognizes workshop requests without matching unrelated greetings", () => {
  assert.equal(isIntakeIntent("Vorrei un tagliando"), true);
  assert.equal(isIntakeIntent("Buongiorno, come va?"), false);
});

test("asks for consent before collecting request details", () => {
  const result = step(INITIAL_CONVERSATION, "Vorrei un preventivo");
  assert.equal(result.conversation.step, "consent");
  assert.match(result.reply, /Officina Test/);
  assert.match(result.reply, /https:\/\/example\.test\/privacy/);
});

test("collects the required details and returns a request without confirming an appointment", () => {
  let conversation = step(INITIAL_CONVERSATION, "richiesta officina").conversation;
  conversation = step(conversation, "SI").conversation;
  conversation = step(conversation, "Mario Rossi").conversation;
  conversation = step(conversation, "Honda SH 300 del 2020").conversation;
  conversation = step(conversation, "Il freno anteriore fa rumore").conversation;
  const result = step(conversation, "Dopo le 17 nei giorni feriali");

  assert.equal(result.request.customer_name, "Mario Rossi");
  assert.equal(result.request.motorcycle, "Honda SH 300 del 2020");
  assert.equal(result.request.issue, "Il freno anteriore fa rumore");
  assert.equal(result.request.availability, "Dopo le 17 nei giorni feriali");
  assert.ok(result.request.consent_at);
  assert.equal(result.conversation.step, "idle");
  assert.match(result.reply, /non conferma un appuntamento/);
});

test("does not start an intake without consent", () => {
  let conversation = step(INITIAL_CONVERSATION, "riparazione").conversation;
  const result = step(conversation, "NO");
  assert.equal(result.conversation.step, "idle");
  assert.match(result.reply, /Non ho registrato/);
});

test("cancellation resets collected details", () => {
  const conversation = {
    ...INITIAL_CONVERSATION,
    step: "issue",
    customer_name: "Mario Rossi",
  };
  const result = step(conversation, "ANNULLA");
  assert.equal(result.conversation.step, "idle");
  assert.equal(result.conversation.customer_name, null);
});

test("validates field length before advancing the intake", () => {
  const conversation = { ...INITIAL_CONVERSATION, step: "issue" };
  const result = step(conversation, "rumore");
  assert.equal(result.conversation.step, "issue");
  assert.match(result.reply, /massimo 500 caratteri/);
});

test("does not infer an appointment or start an intake for unrelated text", () => {
  assert.equal(step(INITIAL_CONVERSATION, "Ciao"), null);
});
