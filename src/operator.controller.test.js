const test = require("node:test");
const assert = require("node:assert/strict");
const { createOperatorHandlers } = require("./operator.controller");

function response() {
  return {
    statusCode: undefined,
    body: undefined,
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

test("lists requests with a validated status filter and a hard page limit", async () => {
  let query;
  const { listRequests } = createOperatorHandlers({
    pool: {
      async query(...args) {
        query = args;
        return { rows: [{ id: "1", status: "received" }] };
      },
    },
  });
  const res = response();
  await listRequests({ query: { status: "received" } }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.requests, [{ id: "1", status: "received" }]);
  assert.match(query[0], /LIMIT 100/);
  assert.deepEqual(query[1], ["received"]);
});

test("rejects invalid filters and request status values", async () => {
  const { listRequests, updateRequestStatus } = createOperatorHandlers({
    pool: { async query() { throw new Error("Database must not be queried"); } },
  });

  const invalidFilter = response();
  await listRequests({ query: { status: "deleted" } }, invalidFilter);
  assert.equal(invalidFilter.statusCode, 400);

  const invalidId = response();
  await updateRequestStatus({ params: { id: "1; DROP TABLE" }, body: { status: "closed" } }, invalidId);
  assert.equal(invalidId.statusCode, 400);

  const invalidStatus = response();
  await updateRequestStatus({ params: { id: "1" }, body: { status: "admin" } }, invalidStatus);
  assert.equal(invalidStatus.statusCode, 400);
});

test("updates a valid request with parameterized SQL and returns 404 for missing IDs", async () => {
  const calls = [];
  const { updateRequestStatus } = createOperatorHandlers({
    pool: {
      async query(...args) {
        calls.push(args);
        return calls.length === 1
          ? { rowCount: 1, rows: [{ id: "42", status: "in_review" }] }
          : { rowCount: 0, rows: [] };
      },
    },
  });

  const updated = response();
  await updateRequestStatus({ params: { id: "42" }, body: { status: "in_review" } }, updated);
  assert.equal(updated.statusCode, 200);
  assert.deepEqual(calls[0][1], ["42", "in_review"]);

  const missing = response();
  await updateRequestStatus({ params: { id: "43" }, body: { status: "closed" } }, missing);
  assert.equal(missing.statusCode, 404);
});
