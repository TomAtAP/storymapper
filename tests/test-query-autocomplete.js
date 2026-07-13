"use strict";

// SM-216 — JQL autocomplete suggestion engine (shared/query-autocomplete.js).
// Pure, no DOM.

const assert = require("assert");
const AC = require("../shared/query-autocomplete.js");

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  - ${name}`); passed++; }
  catch (err) { console.log(`  FAIL - ${name}\n         ${err.stack || err.message}`); failed++; process.exitCode = 1; }
}

const snap = {
  project: {
    ticketTypes: ["epic", "user-story", "bug"],
    workflow: { statuses: [{ id: "backlog" }, { id: "ready" }, { id: "in-progress" }, { id: "done" }] },
    labels: ["frontend", "backend"]
  },
  releases: [{ id: "r1", name: "v1.0" }, { id: "r2", name: "Big Release" }],
  processSteps: [{ id: "p1", name: "Specify" }],
  tickets: []
};
// labels of the suggestions at a cursor (defaults to end of input)
const at = (input, cur) => AC.suggest(input, cur == null ? input.length : cur, snap).map((s) => s.label);
const sugg = (input, cur) => AC.suggest(input, cur == null ? input.length : cur, snap);

test("SM-216: at the start, suggest fields + NOT + (", () => {
  const labels = at("");
  assert.ok(labels.indexOf("status") >= 0 && labels.indexOf("type") >= 0 && labels.indexOf("release") >= 0);
  assert.ok(labels.indexOf("NOT") >= 0 && labels.indexOf("(") >= 0);
});

test("SM-216: a field prefix narrows the field list", () => {
  assert.deepStrictEqual(at("stat").filter((l) => l === "status"), ["status"]);
  assert.ok(at("st").indexOf("type") < 0, "'st' should not match type");
});

test("SM-216: after a field → operators the field allows (status = enum, no ~)", () => {
  const labels = at("status ");
  assert.deepStrictEqual(labels.slice().sort(), ["!=", "=", "IN", "NOT IN"]);
  assert.ok(labels.indexOf("~") < 0, "enum field does not allow ~");
});

test("SM-216: a numeric field offers comparison operators", () => {
  const labels = at("acCount ");
  assert.ok(labels.indexOf("<") >= 0 && labels.indexOf(">=") >= 0 && labels.indexOf("=") >= 0);
  assert.ok(labels.indexOf("IN") < 0, "acCount has no IN");
});

test("SM-216: an operator prefix filters operators", () => {
  assert.deepStrictEqual(at("status I").slice().sort(), ["IN", "NOT IN"]);
});

test("SM-216: after '=' → the field's values", () => {
  assert.deepStrictEqual(at("status = ").slice().sort(), ["backlog", "done", "in-progress", "ready"]);
  assert.deepStrictEqual(at("type = ").slice().sort(), ["bug", "epic", "user-story"]);
});

test("SM-216: a value prefix narrows the value list", () => {
  assert.deepStrictEqual(at("status = re"), ["ready", "in-progress"]);   // both contain 're'
});

test("SM-216: a value with spaces is inserted quoted", () => {
  const s = AC.suggest("release = Big", 13, snap);
  const big = s.find((x) => x.label === "Big Release");
  assert.ok(big && big.insertText === '"Big Release" ');
  assert.strictEqual(big.kind, "value");
});

test("SM-216: text / date / number fields offer no value suggestions (free input)", () => {
  assert.deepStrictEqual(at("text ~ "), []);
  assert.deepStrictEqual(at("created > "), []);
  assert.deepStrictEqual(at("acCount = "), []);
});

test("SM-216: inside an IN list → values + closing paren", () => {
  const labels = at("type IN (");
  assert.ok(labels.indexOf("epic") >= 0 && labels.indexOf(")") >= 0);
});

test("SM-216: after a complete clause → AND / OR / ) / ORDER BY", () => {
  assert.deepStrictEqual(at("status = ready ").slice().sort(), [")", "AND", "OR", "ORDER BY"]);
});

test("SM-216: after AND → fields again", () => {
  assert.ok(at("status = ready AND ").indexOf("type") >= 0);
});

test("SM-216: ORDER BY → field, then ASC/DESC", () => {
  assert.ok(at("type = bug ORDER BY ").indexOf("created") >= 0);
  assert.deepStrictEqual(at("type = bug ORDER BY created ").slice().sort(), ["ASC", "DESC"]);
});

test("SM-216: replaceStart/replaceEnd cover the in-progress token", () => {
  const s = AC.suggest("stat", 4, snap).find((x) => x.label === "status");
  assert.strictEqual(s.replaceStart, 0);
  assert.strictEqual(s.replaceEnd, 4);
});

test("SM-216: lenient — an unterminated string value still yields value suggestions", () => {
  // `release = "Big` mid-typing: query.tokenize would throw; the engine recovers
  // and suggests release names matching 'Big'.
  const labels = AC.suggest('release = "Big', 14, snap).map((s) => s.label);
  assert.deepStrictEqual(labels, ["Big Release"]);
});

test("SM-216: suggest never throws on garbage / partial input", () => {
  assert.doesNotThrow(() => AC.suggest("((( ~~~ ", 8, snap));
  assert.doesNotThrow(() => AC.suggest("", 0, snap));
  assert.doesNotThrow(() => AC.suggest("status = ready AND (type", 24, snap));
});

console.log(`\n  ${passed} passed, ${failed} failed`);
