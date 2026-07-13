"use strict";

// SM-189 — Query engine + field schema (shared/query-engine.js). Pure, no DOM.

const assert = require("assert");
const E = require("../shared/query-engine.js");

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  - ${name}`); passed++; }
  catch (err) { console.log(`  FAIL - ${name}\n         ${err.stack || err.message}`); failed++; process.exitCode = 1; }
}

// --- fixture: 1 epic + 3 stories + 1 bug + 1 test-def, with links/labels/dates
const DAY = 86400000;
const snap = {
  project: {
    id: "p", ticketPrefix: "SM",
    ticketTypes: ["epic", "user-story", "bug", "test-definition"],
    workflow: { statuses: [{ id: "backlog" }, { id: "ready" }, { id: "in-progress" }, { id: "review" }, { id: "done" }] },
    labels: ["frontend", "backend", "urgent"]
  },
  releases: [{ id: "r1", name: "v1.0" }, { id: "r2", name: "Durchgängige Traceability" }],
  processSteps: [{ id: "ps1", name: "Specify" }, { id: "ps2", name: "Build" }],
  tickets: [
    { id: "e1", ticketKey: "SM-1", type: "epic", status: "backlog", title: "Login epic", description: "",
      acceptanceCriteria: [], labels: [], createdAt: 1000, updatedAt: 1000,
      links: [{ linkTypeId: "contains", targetTicketId: "s1" }, { linkTypeId: "contains", targetTicketId: "s2" }],
      position: { releaseId: "r1", processStepId: "ps1" } },
    { id: "s1", ticketKey: "SM-2", type: "user-story", status: "ready", title: "Build login form", description: "email + password",
      acceptanceCriteria: [{ text: "a" }, { text: "b" }], labels: ["frontend"], createdAt: 2000, updatedAt: 5 * DAY,
      links: [{ linkTypeId: "blocks", targetTicketId: "s3" }], position: { releaseId: "r1", processStepId: "ps2", sortOrder: 1 } },
    { id: "s2", ticketKey: "SM-3", type: "user-story", status: "done", title: "Password reset", description: "",
      acceptanceCriteria: [{ text: "a" }], labels: ["backend"], createdAt: 3000, updatedAt: 3000,
      links: [], position: { releaseId: "r1", processStepId: "ps2", sortOrder: 0 } },
    { id: "s3", ticketKey: "SM-4", type: "user-story", status: "in-progress", title: "Stay signed in", description: "",
      acceptanceCriteria: [{ text: "a" }, { text: "b" }, { text: "c" }], labels: ["frontend", "urgent"], createdAt: 4000, updatedAt: 4000,
      links: [], position: { releaseId: "r2", processStepId: "ps1" } },
    { id: "b1", ticketKey: "SM-5", type: "bug", status: "backlog", title: "Crash on submit", description: "",
      acceptanceCriteria: [], labels: ["urgent"], createdAt: 5000, updatedAt: 5000,
      links: [], position: { releaseId: "r2" } },
    { id: "d1", ticketKey: "SM-6", type: "test-definition", status: "backlog", title: "Login test", description: "",
      acceptanceCriteria: [], labels: [], createdAt: 6000, updatedAt: 6000, isDeleted: true,
      links: [], position: {} }
  ]
};

const keys = (q) => { const r = E.queryTickets(snap, q); assert.strictEqual(r.error, null, "unexpected error: " + JSON.stringify(r.error)); return r.tickets.map((t) => t.ticketKey); };
const setOf = (q) => keys(q).slice().sort();

// --- fields + operators -----------------------------------------------------

test("SM-189: type eq / neq / in / not-in", () => {
  assert.deepStrictEqual(setOf("type = user-story"), ["SM-2", "SM-3", "SM-4"]);
  assert.deepStrictEqual(setOf("type != user-story"), ["SM-1", "SM-5"]);   // SM-6 soft-deleted
  assert.deepStrictEqual(setOf("type IN (epic, bug)"), ["SM-1", "SM-5"]);
  assert.deepStrictEqual(setOf("type NOT IN (user-story)"), ["SM-1", "SM-5"]);
});

test("SM-189: status filters; values are case-insensitive", () => {
  assert.deepStrictEqual(setOf("status = ready"), ["SM-2"]);
  assert.deepStrictEqual(setOf("status = READY"), ["SM-2"]);
  assert.deepStrictEqual(setOf("status IN (ready, in-progress)"), ["SM-2", "SM-4"]);
});

test("SM-189: text ~ searches key/title/description/labels", () => {
  assert.deepStrictEqual(setOf("text ~ login"), ["SM-1", "SM-2"]);   // 'Login epic' + 'Build login form'
  assert.deepStrictEqual(setOf("text ~ password"), ["SM-2", "SM-3"]); // desc 'email + password' + title 'Password reset'
  assert.deepStrictEqual(setOf("text ~ frontend"), ["SM-2", "SM-4"]); // label in haystack
});

test("SM-189: key contains + eq", () => {
  assert.deepStrictEqual(setOf("key = SM-2"), ["SM-2"]);
  assert.deepStrictEqual(setOf("key ~ SM-"), ["SM-1", "SM-2", "SM-3", "SM-4", "SM-5"]);
});

test("SM-227: title + description are queryable fields (~ contains, case-insensitive)", () => {
  // 'Login epic' (SM-1) + 'Build login form' (SM-2) contain 'login'
  assert.deepStrictEqual(setOf("title ~ login"), ["SM-1", "SM-2"]);
  assert.deepStrictEqual(setOf("title ~ LOGIN"), ["SM-1", "SM-2"]);   // case-insensitive
  assert.deepStrictEqual(setOf("title ~ Password"), ["SM-3"]);
  // description search (SM-2 desc = 'email + password')
  assert.deepStrictEqual(setOf("description ~ password"), ["SM-2"]);
  // title is a known field, so the smart-bar treats `title ~ x` as a query
  assert.strictEqual(require("../shared/query.js").looksLikeQuery("title ~ login",
    E.QUERY_FIELDS.map((f) => f.key)), true);
});

test("SM-189: release + processStep resolve by name (quoted for spaces)", () => {
  assert.deepStrictEqual(setOf("release = v1.0"), ["SM-1", "SM-2", "SM-3"]);
  assert.deepStrictEqual(setOf('release = "Durchgängige Traceability"'), ["SM-4", "SM-5"]);
  assert.deepStrictEqual(setOf("processStep = Build"), ["SM-2", "SM-3"]);
});

test("SM-189: epic resolves the containing epic via the contains-link", () => {
  assert.deepStrictEqual(setOf("epic = SM-1"), ["SM-2", "SM-3"]);
  assert.deepStrictEqual(keys("epic = SM-99"), []);
});

test("SM-260: ref fields match by ID as well as by name (release/processStep/epic)", () => {
  // release by ID (previously a silent 0)
  assert.deepStrictEqual(E.queryTickets(snap, "release = r1").tickets.map((t) => t.ticketKey).sort(),
    ["SM-1", "SM-2", "SM-3"]);
  // name still works
  assert.deepStrictEqual(setOf("release = v1.0"), ["SM-1", "SM-2", "SM-3"]);
  // processStep by ID
  assert.deepStrictEqual(E.queryTickets(snap, "processStep = ps2").tickets.map((t) => t.ticketKey).sort(),
    ["SM-2", "SM-3"]);
  // epic by internal id AND by ticketKey resolve the same contained stories
  assert.deepStrictEqual(E.queryTickets(snap, "epic = e1").tickets.map((t) => t.ticketKey).sort(),
    ["SM-2", "SM-3"]);
  assert.deepStrictEqual(setOf("epic = SM-1"), ["SM-2", "SM-3"]);
  // IN works across id + name mixed
  assert.deepStrictEqual(E.queryTickets(snap, "release IN (r1, \"Durchgängige Traceability\")")
    .tickets.map((t) => t.ticketKey).sort(), ["SM-1", "SM-2", "SM-3", "SM-4", "SM-5"]);
});

test("SM-260: strictRefs flags an unknown ref value as a query error (not silent 0)", () => {
  const bad = E.queryTickets(snap, "release = nope", { strictRefs: true });
  assert.ok(bad.error && /release/i.test(bad.error.message), "unknown release value errors under strictRefs");
  assert.strictEqual(bad.tickets.length, 0);
  // smart-bar path (no strictRefs) stays silent — 0 results, no error
  const soft = E.queryTickets(snap, "release = nope");
  assert.strictEqual(soft.error, null);
  assert.strictEqual(soft.tickets.length, 0);
  // a known value (by id) passes strictRefs
  assert.strictEqual(E.queryTickets(snap, "release = r1", { strictRefs: true }).error, null);
  // epic unknown key also flagged
  assert.ok(E.queryTickets(snap, "epic = SM-99", { strictRefs: true }).error);
});

test("SM-189: label membership (eq=has, in, not-in)", () => {
  assert.deepStrictEqual(setOf("label = frontend"), ["SM-2", "SM-4"]);
  assert.deepStrictEqual(setOf("label IN (backend, urgent)"), ["SM-3", "SM-4", "SM-5"]);
  assert.deepStrictEqual(setOf("type = user-story AND label NOT IN (urgent)"), ["SM-2", "SM-3"]);
});

test("SM-189: linkedTo / linkedFrom over the link graph (by key)", () => {
  assert.deepStrictEqual(setOf("linkedTo = SM-4"), ["SM-2"]);   // SM-2 blocks SM-4
  assert.deepStrictEqual(setOf("linkedFrom = SM-2"), ["SM-4"]); // SM-4 is linked from SM-2
  assert.deepStrictEqual(setOf("linkedTo = SM-2"), ["SM-1"]);   // epic contains SM-2
});

test("SM-189: acCount numeric comparisons", () => {
  assert.deepStrictEqual(setOf("acCount >= 2"), ["SM-2", "SM-4"]);
  assert.deepStrictEqual(setOf("acCount = 0"), ["SM-1", "SM-5"]);
  assert.deepStrictEqual(setOf("acCount < 2 AND type = user-story"), ["SM-3"]);
});

test("SM-189: date comparisons on updated (date value parsed via Date.parse)", () => {
  // SM-2 updatedAt = 5 days in ms; everything else has tiny timestamps. A
  // date-only literal needs no quotes (no colons); 1970-01-02 = DAY ms.
  assert.deepStrictEqual(setOf("updated > 1970-01-02"), ["SM-2"]);
  // A full ISO timestamp (with colons) must be quoted.
  assert.deepStrictEqual(setOf('updated > "1970-01-02T00:00:00.000Z"'), ["SM-2"]);
});

// --- boolean structure ------------------------------------------------------

test("SM-189: AND / OR / NOT compose", () => {
  assert.deepStrictEqual(setOf("type = user-story AND status = ready"), ["SM-2"]);
  assert.deepStrictEqual(setOf("status = ready OR status = done"), ["SM-2", "SM-3"]);
  assert.deepStrictEqual(setOf("type = user-story AND NOT label = frontend"), ["SM-3"]);
  // precedence: epic OR (story AND done)
  assert.deepStrictEqual(setOf("type = epic OR type = user-story AND status = done"), ["SM-1", "SM-3"]);
});

// --- ordering ---------------------------------------------------------------

test("SM-189: default order = sortOrder then key; ORDER BY overrides", () => {
  // SM-3 sortOrder 0 before SM-2 sortOrder 1 in release v1.0 stories.
  assert.deepStrictEqual(keys("release = v1.0 AND type = user-story"), ["SM-3", "SM-2"]);
  assert.deepStrictEqual(keys("type = user-story ORDER BY acCount DESC"), ["SM-4", "SM-2", "SM-3"]);
  assert.deepStrictEqual(keys("type = user-story ORDER BY key ASC"), ["SM-2", "SM-3", "SM-4"]);
  assert.deepStrictEqual(keys("type = user-story ORDER BY created DESC"), ["SM-4", "SM-3", "SM-2"]);
});

// --- match-all + deletions --------------------------------------------------

test("SM-189: empty query returns all non-deleted tickets", () => {
  assert.deepStrictEqual(setOf(""), ["SM-1", "SM-2", "SM-3", "SM-4", "SM-5"]);   // SM-6 deleted, excluded
});

test("SM-189: a pre-built AST (not a string) is accepted too", () => {
  const ast = { op: "CLAUSE", field: "type", clauseOp: "eq", value: "bug" };
  assert.deepStrictEqual(E.queryTickets(snap, ast).tickets.map((t) => t.ticketKey), ["SM-5"]);
});

// --- errors -----------------------------------------------------------------

test("SM-189: unknown field → structured error, empty list", () => {
  const r = E.queryTickets(snap, "assignee = me");
  assert.deepStrictEqual(r.tickets, []);
  assert.ok(/unknown field/i.test(r.error.message));
  assert.strictEqual(r.error.field, "assignee");
});

test("SM-189: operator not allowed on a field → structured error", () => {
  const r = E.queryTickets(snap, "status ~ ready");
  assert.ok(/not allowed/i.test(r.error.message));
  assert.ok(/eq, neq, in, not-in/.test(r.error.message));
});

test("SM-189: unknown ORDER BY field → error", () => {
  assert.ok(/unknown ORDER BY field/i.test(E.queryTickets(snap, "type = bug ORDER BY nope").error.message));
});

test("SM-189: a parser (syntax) error is passed through", () => {
  const r = E.queryTickets(snap, "type =");
  assert.ok(r.error && /value/i.test(r.error.message));
  assert.strictEqual(typeof r.error.position, "number");
});

// --- schema is the single source -------------------------------------------

test("SM-189: QUERY_FIELDS.values() feed the autocomplete (single source)", () => {
  const byKey = {};
  E.QUERY_FIELDS.forEach((f) => { byKey[f.key] = f; });
  assert.deepStrictEqual(byKey.status.values(snap).slice().sort(), ["backlog", "done", "in-progress", "ready", "review"]);
  assert.deepStrictEqual(byKey.release.values(snap), ["v1.0", "Durchgängige Traceability"]);
  assert.deepStrictEqual(byKey.label.values(snap).slice().sort(), ["backend", "frontend", "urgent"]);
  assert.deepStrictEqual(byKey.epic.values(snap), ["SM-1"]);
});

test("SM-189 review: text field only accepts ~ (eq/neq rejected)", () => {
  assert.ok(/not allowed/i.test(E.queryTickets(snap, "text = login").error.message));
  assert.strictEqual(E.queryTickets(snap, "text ~ login").error, null);
});

test("SM-189 review: a pathologically deep pre-built AST returns an error, never throws", () => {
  let node = { op: "CLAUSE", field: "type", clauseOp: "eq", value: "bug" };
  for (let i = 0; i < 60000; i++) node = { op: "NOT", child: node };
  let r;
  assert.doesNotThrow(() => { r = E.queryTickets(snap, node); });
  assert.ok(r.error, "deep AST collapses to a structured error");
});

console.log(`\n  ${passed} passed, ${failed} failed`);
