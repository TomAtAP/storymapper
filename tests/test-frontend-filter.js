"use strict";

/**
 * SM-82 — Tests for frontend/js/filter.js.
 *
 * Pure-module tests — no JSDOM, no store. Tests cover:
 *   • normalizeFilter (empty / arrays / preserve)
 *   • toAST (empty / three dimensions)
 *   • matchesFilter (simple spec + AST forms, AND/OR/NOT, in/not-in/eq/neq)
 *   • releaseVisible
 *   • countActiveRules
 *   • Virtual field `release.status` via ctx.releaseById
 */

const assert = require("assert");
const filter = require("../frontend/js/filter.js");

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  - ${name}`); passed++; }
  catch (err) { console.log(`  FAIL - ${name}\n         ${err.stack || err.message}`); failed++; process.exitCode = 1; }
}

// ---------------------------------------------------------------------------
// normalizeFilter
// ---------------------------------------------------------------------------

test("normalizeFilter: undefined input → all null/false", () => {
  const f = filter.normalizeFilter();
  assert.strictEqual(f.statuses, null);
  assert.strictEqual(f.types, null);
  assert.strictEqual(f.hideCompletedReleases, false);
});

test("normalizeFilter: empty arrays → null (= no constraint)", () => {
  const f = filter.normalizeFilter({ statuses: [], types: [] });
  assert.strictEqual(f.statuses, null);
  assert.strictEqual(f.types, null);
});

test("normalizeFilter: arrays + boolean → preserved + cloned", () => {
  const raw = { statuses: ["backlog"], types: ["bug"], hideCompletedReleases: true };
  const f = filter.normalizeFilter(raw);
  assert.deepStrictEqual(f.statuses, ["backlog"]);
  assert.deepStrictEqual(f.types, ["bug"]);
  assert.strictEqual(f.hideCompletedReleases, true);
  // Arrays are CLONED (mutations on output must not affect caller's input).
  f.statuses.push("ready");
  assert.deepStrictEqual(raw.statuses, ["backlog"]);
});

// ---------------------------------------------------------------------------
// toAST — Boolean-Tree
// ---------------------------------------------------------------------------

test("toAST: empty filter → AND-tree with no children", () => {
  const ast = filter.toAST({});
  assert.strictEqual(ast.op, "AND");
  assert.deepStrictEqual(ast.children, []);
});

test("toAST: all three filter dimensions → AND with three CLAUSE children", () => {
  const ast = filter.toAST({ statuses: ["a"], types: ["b"], hideCompletedReleases: true });
  assert.strictEqual(ast.op, "AND");
  assert.strictEqual(ast.children.length, 3);
  assert.deepStrictEqual(ast.children[0], { op: "CLAUSE", field: "status",         clauseOp: "in",  values: ["a"] });
  assert.deepStrictEqual(ast.children[1], { op: "CLAUSE", field: "type",           clauseOp: "in",  values: ["b"] });
  assert.deepStrictEqual(ast.children[2], { op: "CLAUSE", field: "release.status", clauseOp: "neq", value: "completed" });
});

test("toAST: only some dimensions → only those clauses appear", () => {
  const ast = filter.toAST({ types: ["bug"] });
  assert.strictEqual(ast.children.length, 1);
  assert.strictEqual(ast.children[0].field, "type");
});

// ---------------------------------------------------------------------------
// matchesFilter — simple spec form
// ---------------------------------------------------------------------------

test("matchesFilter: null/undefined filter → always true", () => {
  assert.strictEqual(filter.matchesFilter({ status: "any" }, null), true);
  assert.strictEqual(filter.matchesFilter({ status: "any" }, undefined), true);
});

test("matchesFilter: empty filter spec → always true (no constraints)", () => {
  assert.strictEqual(filter.matchesFilter({ status: "done", type: "bug" }, {}), true);
});

test("matchesFilter: status filter — ticket matches", () => {
  const t = { status: "backlog", type: "bug" };
  assert.strictEqual(filter.matchesFilter(t, { statuses: ["backlog", "ready"] }), true);
});

test("matchesFilter: status filter — ticket doesn't match → false", () => {
  const t = { status: "done", type: "bug" };
  assert.strictEqual(filter.matchesFilter(t, { statuses: ["backlog", "ready"] }), false);
});

test("matchesFilter: type + status combined are AND'd", () => {
  const t = { status: "backlog", type: "bug" };
  assert.strictEqual(filter.matchesFilter(t, { statuses: ["backlog"], types: ["bug"] }),         true);
  assert.strictEqual(filter.matchesFilter(t, { statuses: ["backlog"], types: ["user-story"] }), false);
  assert.strictEqual(filter.matchesFilter(t, { statuses: ["done"],    types: ["bug"] }),         false);
});

// ---------------------------------------------------------------------------
// matchesFilter — release.status (virtual field via ctx)
// ---------------------------------------------------------------------------

test("matchesFilter: hideCompletedReleases hides tickets in completed releases", () => {
  const t = { status: "any", type: "any", position: { releaseId: "r1" } };
  const snap = { releases: [{ id: "r1", status: "completed" }] };
  const ctx  = filter.buildReleaseCtx(snap);
  assert.strictEqual(filter.matchesFilter(t, { hideCompletedReleases: true }, ctx), false);
});

test("matchesFilter: hideCompletedReleases keeps tickets in non-completed releases", () => {
  const t = { status: "any", type: "any", position: { releaseId: "r1" } };
  const snap = { releases: [{ id: "r1", status: "active" }] };
  const ctx  = filter.buildReleaseCtx(snap);
  assert.strictEqual(filter.matchesFilter(t, { hideCompletedReleases: true }, ctx), true);
});

test("matchesFilter: hideCompletedReleases is no-op for tickets without a release (backlog)", () => {
  const t = { status: "any", type: "any", position: { releaseId: null } };
  const ctx = filter.buildReleaseCtx({ releases: [] });
  // No release → release.status resolves to null → neq "completed" is true → ticket visible.
  assert.strictEqual(filter.matchesFilter(t, { hideCompletedReleases: true }, ctx), true);
});

// ---------------------------------------------------------------------------
// matchesFilter — AST form directly (forward-compatibility for JQL)
// ---------------------------------------------------------------------------

test("matchesFilter: AST with OR — true if any child matches", () => {
  const t = { status: "done", type: "any" };
  const ast = { op: "OR", children: [
    { op: "CLAUSE", field: "status", clauseOp: "eq", value: "done" },
    { op: "CLAUSE", field: "status", clauseOp: "eq", value: "backlog" }
  ]};
  assert.strictEqual(filter.matchesFilter(t, ast), true);
  const ast2 = { op: "OR", children: [
    { op: "CLAUSE", field: "status", clauseOp: "eq", value: "in-progress" },
    { op: "CLAUSE", field: "status", clauseOp: "eq", value: "backlog" }
  ]};
  assert.strictEqual(filter.matchesFilter(t, ast2), false);
});

test("matchesFilter: AST with NOT — inverts child", () => {
  const t = { status: "done", type: "any" };
  const inner = { op: "CLAUSE", field: "status", clauseOp: "eq", value: "done" };
  assert.strictEqual(filter.matchesFilter(t, { op: "NOT", child: inner }), false);
  const inner2 = { op: "CLAUSE", field: "status", clauseOp: "eq", value: "backlog" };
  assert.strictEqual(filter.matchesFilter(t, { op: "NOT", child: inner2 }), true);
});

test("matchesFilter: AST with combined AND/OR/NOT", () => {
  // (status = backlog OR status = ready) AND NOT (type = epic)
  const ast = { op: "AND", children: [
    { op: "OR", children: [
      { op: "CLAUSE", field: "status", clauseOp: "eq", value: "backlog" },
      { op: "CLAUSE", field: "status", clauseOp: "eq", value: "ready" }
    ]},
    { op: "NOT", child: { op: "CLAUSE", field: "type", clauseOp: "eq", value: "epic" } }
  ]};
  assert.strictEqual(filter.matchesFilter({ status: "backlog", type: "user-story" }, ast), true);
  assert.strictEqual(filter.matchesFilter({ status: "backlog", type: "epic" }, ast), false);
  assert.strictEqual(filter.matchesFilter({ status: "done",    type: "user-story" }, ast), false);
});

test("matchesFilter: clauseOp 'eq'", () => {
  assert.strictEqual(filter.matchesFilter({ status: "ready" },
    { op: "CLAUSE", field: "status", clauseOp: "eq", value: "ready" }), true);
  assert.strictEqual(filter.matchesFilter({ status: "ready" },
    { op: "CLAUSE", field: "status", clauseOp: "eq", value: "done" }), false);
});

test("matchesFilter: clauseOp 'neq'", () => {
  assert.strictEqual(filter.matchesFilter({ status: "ready" },
    { op: "CLAUSE", field: "status", clauseOp: "neq", value: "done" }), true);
  assert.strictEqual(filter.matchesFilter({ status: "done" },
    { op: "CLAUSE", field: "status", clauseOp: "neq", value: "done" }), false);
});

test("matchesFilter: clauseOp 'not-in'", () => {
  const t = { status: "ready" };
  assert.strictEqual(filter.matchesFilter(t,
    { op: "CLAUSE", field: "status", clauseOp: "not-in", values: ["done", "review"] }), true);
  assert.strictEqual(filter.matchesFilter(t,
    { op: "CLAUSE", field: "status", clauseOp: "not-in", values: ["ready", "review"] }), false);
});

// ---------------------------------------------------------------------------
// releaseVisible
// ---------------------------------------------------------------------------

test("releaseVisible: hideCompletedReleases off → all releases visible", () => {
  assert.strictEqual(filter.releaseVisible({ status: "completed" }, { hideCompletedReleases: false }), true);
  assert.strictEqual(filter.releaseVisible({ status: "active" },    { hideCompletedReleases: false }), true);
});

test("releaseVisible: hideCompletedReleases on → only completed releases hidden", () => {
  assert.strictEqual(filter.releaseVisible({ status: "completed" }, { hideCompletedReleases: true }), false);
  assert.strictEqual(filter.releaseVisible({ status: "active" },    { hideCompletedReleases: true }), true);
  assert.strictEqual(filter.releaseVisible({ status: "planning" },  { hideCompletedReleases: true }), true);
  assert.strictEqual(filter.releaseVisible({ status: "cancelled" }, { hideCompletedReleases: true }), true);
});

test("releaseVisible: null filter → always visible", () => {
  assert.strictEqual(filter.releaseVisible({ status: "completed" }, null), true);
});

// ---------------------------------------------------------------------------
// countActiveRules
// ---------------------------------------------------------------------------

test("countActiveRules: empty filter → 0", () => {
  assert.strictEqual(filter.countActiveRules({}), 0);
  assert.strictEqual(filter.countActiveRules(undefined), 0);
});

test("countActiveRules: one dimension → 1; three dimensions → 3", () => {
  assert.strictEqual(filter.countActiveRules({ statuses: ["a"] }), 1);
  assert.strictEqual(filter.countActiveRules({ statuses: ["a"], types: ["b"] }), 2);
  assert.strictEqual(filter.countActiveRules({ statuses: ["a"], types: ["b"], hideCompletedReleases: true }), 3);
});

test("countActiveRules: empty arrays don't count", () => {
  assert.strictEqual(filter.countActiveRules({ statuses: [], types: [] }), 0);
});

// SM-16 — free-text search match
const SEARCH_TICKET = {
  ticketKey: "SM-42", title: "Wire the WebSocket bus", type: "user-story",
  description: "Push change events to subscribed browsers", labels: ["infra", "realtime"]
};

test("matchesSearch: empty/blank query matches everything", () => {
  assert.strictEqual(filter.matchesSearch(SEARCH_TICKET, ""), true);
  assert.strictEqual(filter.matchesSearch(SEARCH_TICKET, "   "), true);
  assert.strictEqual(filter.matchesSearch(SEARCH_TICKET, null), true);
});

test("matchesSearch: matches on ticketKey, title, description, labels (case-insensitive)", () => {
  assert.strictEqual(filter.matchesSearch(SEARCH_TICKET, "sm-42"), true);
  assert.strictEqual(filter.matchesSearch(SEARCH_TICKET, "websocket"), true);
  assert.strictEqual(filter.matchesSearch(SEARCH_TICKET, "SUBSCRIBED"), true);
  assert.strictEqual(filter.matchesSearch(SEARCH_TICKET, "realtime"), true);
});

test("matchesSearch: non-match returns false", () => {
  assert.strictEqual(filter.matchesSearch(SEARCH_TICKET, "kanban"), false);
});

test("matchesSearch: multiple terms are AND-combined across fields", () => {
  assert.strictEqual(filter.matchesSearch(SEARCH_TICKET, "websocket infra"), true);
  assert.strictEqual(filter.matchesSearch(SEARCH_TICKET, "websocket kanban"), false);
});

test("matchesSearch: tolerant of missing fields", () => {
  assert.strictEqual(filter.matchesSearch({ title: "x" }, "x"), true);
  assert.strictEqual(filter.matchesSearch({}, "x"), false);
  assert.strictEqual(filter.matchesSearch(null, ""), true);
});

test("SM-244: status=cancelled is filterable like any other status", () => {
  // matchesFilter(ticket, filterSpec)
  assert.strictEqual(filter.matchesFilter({ status: "cancelled" }, { statuses: ["cancelled"] }), true);
  assert.strictEqual(filter.matchesFilter({ status: "backlog" }, { statuses: ["cancelled"] }), false);
  assert.strictEqual(filter.matchesFilter({ status: "cancelled" }, { statuses: ["backlog", "cancelled"] }), true);
});

console.log(`\n  ${passed} passed, ${failed} failed`);
