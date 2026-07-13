"use strict";

/**
 * SM-93 — Spec-Evolution Governance (Predicate-Library + Evaluator +
 * Template-Renderer + DEFAULT_GOVERNANCE).
 *
 * Pure-function tests against server/core.js. Each predicate has a
 * positive and negative case; evaluateGates is exercised with combined
 * gates; renderMessage covers plain interpolation, plural-conditional,
 * list-join, format helpers; derivedHealth covers all five states.
 */

const assert = require("assert");
const core = require("../server/core.js");

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  - ${name}`); passed++; }
  catch (err) { console.log(`  FAIL - ${name}\n         ${err.stack || err.message}`); failed++; process.exitCode = 1; }
}

const HUMAN = { type: "human", id: "u1", name: "U" };

function baseSnap(extra) {
  const raw = Object.assign({
    project: { id: "p1", name: "P" },
    tickets: [],
    releases: [],
    processSteps: []
  }, extra || {});
  return core.normalizeSnapshot(raw);
}

// ---------------------------------------------------------------------------
// Predicate library — 8 functions, pos + neg each
// ---------------------------------------------------------------------------

test("ticket_field non_empty: title set → ok; empty → fail", () => {
  const snap = baseSnap();
  const ok = core.GOVERNANCE_PREDICATES.ticket_field(snap,
    { title: "Hello" }, { field: "title", check: "non_empty" });
  assert.strictEqual(ok.ok, true);
  const fail = core.GOVERNANCE_PREDICATES.ticket_field(snap,
    { title: "" }, { field: "title", check: "non_empty" });
  assert.strictEqual(fail.ok, false);
  assert.strictEqual(fail.context.field, "title");
});

test("outgoing_link minCount=1: matching link present → ok; absent → fail", () => {
  const snap = baseSnap();
  const ok = core.GOVERNANCE_PREDICATES.outgoing_link(snap,
    { links: [{ linkTypeId: "tests", targetTicketId: "t-x" }] },
    { linkTypeId: "tests", minCount: 1 });
  assert.strictEqual(ok.ok, true);
  const fail = core.GOVERNANCE_PREDICATES.outgoing_link(snap,
    { links: [] }, { linkTypeId: "tests", minCount: 1 });
  assert.strictEqual(fail.ok, false);
  assert.strictEqual(fail.context.count, 0);
});

test("incoming_link: count incoming targeting the ticket", () => {
  const snap = baseSnap({
    tickets: [
      { id: "t-A", links: [{ linkTypeId: "modifies", targetTicketId: "t-B" }] },
      { id: "t-B" }
    ]
  });
  const okB = core.GOVERNANCE_PREDICATES.incoming_link(snap,
    snap.tickets.find(t => t.id === "t-B"),
    { linkTypeId: "modifies", minCount: 1 });
  assert.strictEqual(okB.ok, true);
  const failA = core.GOVERNANCE_PREDICATES.incoming_link(snap,
    snap.tickets.find(t => t.id === "t-A"),
    { linkTypeId: "modifies", minCount: 1 });
  assert.strictEqual(failA.ok, false);
});

test("SM-299: incoming_link with sourceType + sourceLifecycle filters (published test-definition only)", () => {
  const snap = baseSnap({
    tickets: [
      { id: "t-story", type: "user-story" },
      { id: "t-draft", type: "test-definition", lifecycle: "draft",
        links: [{ linkTypeId: "tests", targetTicketId: "t-story" }] },
      { id: "t-pub", type: "test-definition", lifecycle: "published",
        links: [{ linkTypeId: "tests", targetTicketId: "t-story" }] }
    ]
  });
  const story = snap.tickets.find(t => t.id === "t-story");
  const args = { linkTypeId: "tests", sourceType: "test-definition", sourceLifecycle: "published", minCount: 1 };
  assert.strictEqual(core.GOVERNANCE_PREDICATES.incoming_link(snap, story, args).ok, true,
    "one PUBLISHED test-definition satisfies the gate");
  // remove the published one → only the draft remains → gate fails
  const snap2 = baseSnap({
    tickets: [
      { id: "t-story", type: "user-story" },
      { id: "t-draft", type: "test-definition", lifecycle: "draft",
        links: [{ linkTypeId: "tests", targetTicketId: "t-story" }] }
    ]
  });
  const r = core.GOVERNANCE_PREDICATES.incoming_link(snap2, snap2.tickets.find(t => t.id === "t-story"), args);
  assert.strictEqual(r.ok, false, "a DRAFT test-definition does NOT satisfy the gate");
  assert.strictEqual(r.context.count, 0);
});

test("SM-299: incoming_link ignores a soft-deleted source", () => {
  const snap = baseSnap({
    tickets: [
      { id: "t-story", type: "bug" },
      { id: "t-pub", type: "test-definition", lifecycle: "published", isDeleted: true,
        links: [{ linkTypeId: "tests", targetTicketId: "t-story" }] }
    ]
  });
  const args = { linkTypeId: "tests", sourceType: "test-definition", sourceLifecycle: "published", minCount: 1 };
  assert.strictEqual(
    core.GOVERNANCE_PREDICATES.incoming_link(snap, snap.tickets.find(t => t.id === "t-story"), args).ok,
    false, "a deleted test-definition doesn't count");
});

test("linked_target_status: target reaches minStatus → ok; below → fail", () => {
  // Build with proper workflow so status-index comparison works.
  const snap = baseSnap({
    project: { id: "p1", name: "P" },
    tickets: [
      { id: "t-target", ticketKey: "P-1", status: "ready" },
      { id: "t-target-lo", ticketKey: "P-2", status: "backlog" }
    ]
  });
  const def_ok = { links: [{ linkTypeId: "tests", targetTicketId: "t-target" }] };
  const def_lo = { links: [{ linkTypeId: "tests", targetTicketId: "t-target-lo" }] };
  const ok = core.GOVERNANCE_PREDICATES.linked_target_status(snap, def_ok,
    { linkTypeId: "tests", minStatus: "ready" });
  assert.strictEqual(ok.ok, true);
  const fail = core.GOVERNANCE_PREDICATES.linked_target_status(snap, def_lo,
    { linkTypeId: "tests", minStatus: "ready" });
  assert.strictEqual(fail.ok, false);
  assert.strictEqual(fail.context.targetKey, "P-2");
  assert.strictEqual(fail.context.targetStatus, "backlog");
});

test("linked_definitions_health: all linked defs in allowed states → ok; any other → fail", () => {
  // Build a target story; two test-definitions linked to it with manually-
  // set derivedHealth (overridable). Use the post-normalize derivedHealth
  // pass — for the test, fabricate executions to drive states.
  const snap = baseSnap({
    project: { id: "p1", name: "P" },
    tickets: [
      { id: "t-feat", ticketKey: "F-1", type: "user-story", status: "review" },
      { id: "t-def1", ticketKey: "TD-1", type: "test-definition",
        links: [{ linkTypeId: "tests", targetTicketId: "t-feat" }] }
    ]
  });
  // No executions → t-def1.derivedHealth = "unused", which is in allowed set.
  const okResult = core.GOVERNANCE_PREDICATES.linked_definitions_health(snap,
    snap.tickets.find(t => t.id === "t-feat"), { allowed: ["passing", "unused"] });
  assert.strictEqual(okResult.ok, true);
  // Restrict to "passing" only → unused is now offending.
  const failResult = core.GOVERNANCE_PREDICATES.linked_definitions_health(snap,
    snap.tickets.find(t => t.id === "t-feat"), { allowed: ["passing"] });
  assert.strictEqual(failResult.ok, false);
  assert.ok(failResult.context.staleReasons.indexOf("TD-1") >= 0);
});

test("incoming_modifies_open: open modifies-ticket → fail; closed/none → ok", () => {
  const snapOpen = baseSnap({
    tickets: [
      { id: "t-feat" },
      { id: "t-mod", status: "in-progress",
        links: [{ linkTypeId: "modifies", targetTicketId: "t-feat" }] }
    ]
  });
  const failOpen = core.GOVERNANCE_PREDICATES.incoming_modifies_open(snapOpen,
    snapOpen.tickets.find(t => t.id === "t-feat"), {});
  assert.strictEqual(failOpen.ok, false);
  // Same wiring but mod is done → ok.
  const snapDone = baseSnap({
    tickets: [
      { id: "t-feat" },
      { id: "t-mod", status: "done",
        links: [{ linkTypeId: "modifies", targetTicketId: "t-feat" }] }
    ]
  });
  const okDone = core.GOVERNANCE_PREDICATES.incoming_modifies_open(snapDone,
    snapDone.tickets.find(t => t.id === "t-feat"), {});
  assert.strictEqual(okDone.ok, true);
});

test("for_each_step: every step has non_empty expectedResult → ok; any empty → fail", () => {
  const snap = baseSnap();
  const okDef = { steps: [
    { id: "s1", step: "do", expectedResult: "works" },
    { id: "s2", step: "do2", expectedResult: "also works" }
  ]};
  const failDef = { steps: [
    { id: "s1", step: "do", expectedResult: "works" },
    { id: "s2", step: "do2", expectedResult: "" }
  ]};
  assert.strictEqual(core.GOVERNANCE_PREDICATES.for_each_step(snap, okDef,
    { field: "expectedResult", check: "non_empty" }).ok, true);
  const fail = core.GOVERNANCE_PREDICATES.for_each_step(snap, failDef,
    { field: "expectedResult", check: "non_empty" });
  assert.strictEqual(fail.ok, false);
  assert.strictEqual(fail.context.stepId, "s2");
});

test("for_each_prereq: every prereq label non_empty → ok; one empty → fail", () => {
  const snap = baseSnap();
  const okDef = { prerequisites: [{ id: "pr1", label: "Login" }] };
  const failDef = { prerequisites: [{ id: "pr1", label: "" }] };
  assert.strictEqual(core.GOVERNANCE_PREDICATES.for_each_prereq(snap, okDef,
    { field: "label", check: "non_empty" }).ok, true);
  assert.strictEqual(core.GOVERNANCE_PREDICATES.for_each_prereq(snap, failDef,
    { field: "label", check: "non_empty" }).ok, false);
});

// ---------------------------------------------------------------------------
// evaluateGates + evaluateWarnings
// ---------------------------------------------------------------------------

test("evaluateGates: publish_test_definition with steps+link+ready-target → ok", () => {
  const snap = baseSnap({
    tickets: [
      { id: "t-feat", ticketKey: "F-1", status: "ready" }
    ]
  });
  const def = {
    id: "t-def", ticketKey: "TD-1", type: "test-definition",
    links: [{ linkTypeId: "tests", targetTicketId: "t-feat" }],
    steps: [{ id: "s1", step: "x", expectedResult: "ok" }]
  };
  const r = core.evaluateGates("publish_test_definition", snap, def, snap.project.governance);
  assert.strictEqual(r.ok, true);
});

test("evaluateGates: publish_test_definition without steps → fails with MISSING_STEPS", () => {
  const snap = baseSnap();
  const def = {
    id: "t-def", ticketKey: "TD-1", type: "test-definition",
    links: [{ linkTypeId: "tests", targetTicketId: "t-feat" }],
    steps: []
  };
  const r = core.evaluateGates("publish_test_definition", snap, def, snap.project.governance);
  assert.strictEqual(r.ok, false);
  const kinds = r.errors.map(e => e.kind);
  assert.ok(kinds.indexOf("MISSING_STEPS") >= 0);
});

test("evaluateGates: complete_ticket blocks when OPEN_MODIFIES dangling", () => {
  const snap = baseSnap({
    tickets: [
      { id: "t-feat" },
      { id: "t-mod", ticketKey: "M-1", status: "in-progress",
        links: [{ linkTypeId: "modifies", targetTicketId: "t-feat" }] }
    ]
  });
  const r = core.evaluateGates("complete_ticket", snap,
    snap.tickets.find(t => t.id === "t-feat"), snap.project.governance);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.errors[0].kind, "OPEN_MODIFIES");
  assert.ok(r.errors[0].context.modBlockerKeys.indexOf("M-1") >= 0);
});

test("SM-299: evaluateGates appliesToTypes — gate scoped to user-story/bug, skipped for others", () => {
  const gov = {
    gates: { NEEDS_TEST: { predicate: "incoming_link",
      args: { linkTypeId: "tests", sourceType: "test-definition", sourceLifecycle: "published" },
      appliesToTypes: ["user-story", "bug"] } },
    messages: { NEEDS_TEST: { title: "x", reason: "x", suggestion: "x" } },
    tool_actions: { complete_ticket: { gates: ["NEEDS_TEST"] } }
  };
  const snap = baseSnap();
  // user-story without a published test-def → gate FIRES
  const story = core.evaluateGates("complete_ticket", snap, { type: "user-story", id: "t-s" }, gov);
  assert.strictEqual(story.ok, false);
  assert.strictEqual(story.errors[0].kind, "NEEDS_TEST");
  // technical-task → gate SKIPPED (not in appliesToTypes)
  const task = core.evaluateGates("complete_ticket", snap, { type: "technical-task-backend", id: "t-t" }, gov);
  assert.strictEqual(task.ok, true, "gate does not apply to technical tasks");
  // epic → skipped too
  assert.strictEqual(core.evaluateGates("complete_ticket", snap, { type: "epic", id: "t-e" }, gov).ok, true);
});

test("SM-299: default governance wires MISSING_TEST_DEFINITION into complete_ticket, scoped user-story/bug", () => {
  const gov = core.STORYMAPPER_DEFAULT_GOVERNANCE;
  assert.ok(gov.gates.MISSING_TEST_DEFINITION, "gate defined");
  assert.deepStrictEqual(gov.gates.MISSING_TEST_DEFINITION.appliesToTypes, ["user-story", "bug"]);
  assert.strictEqual(gov.gates.MISSING_TEST_DEFINITION.args.sourceLifecycle, "published");
  assert.ok(gov.messages.MISSING_TEST_DEFINITION, "message defined");
  assert.ok(gov.tool_actions.complete_ticket.gates.indexOf("MISSING_TEST_DEFINITION") >= 0, "wired into complete_ticket");
  // ordered LAST so OPEN_MODIFIES/STALE still win as errors[0] when both fail
  const g = gov.tool_actions.complete_ticket.gates;
  assert.strictEqual(g[g.length - 1], "MISSING_TEST_DEFINITION");
});

test("SM-299: default governance blocks a user-story completion without a published test-def", () => {
  const snap = baseSnap({ tickets: [{ id: "t-s", type: "user-story", status: "review" }] });
  const r = core.evaluateGates("complete_ticket", snap, snap.tickets[0], snap.project.governance);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some(e => e.kind === "MISSING_TEST_DEFINITION"));
  // a technical-task in the SAME project is not blocked by it
  const snap2 = baseSnap({ tickets: [{ id: "t-t", type: "technical-task-backend", status: "review" }] });
  const r2 = core.evaluateGates("complete_ticket", snap2, snap2.tickets[0], snap2.project.governance);
  assert.strictEqual(r2.ok, true);
});

test("evaluateGates: unknown tool action → ok (no gates configured)", () => {
  const snap = baseSnap();
  const r = core.evaluateGates("totally_unknown_tool", snap, {}, snap.project.governance);
  assert.strictEqual(r.ok, true);
});

test("evaluateWarnings: no warnings configured → empty array (default)", () => {
  const snap = baseSnap();
  const r = core.evaluateWarnings("ticket_update_spec", snap, {}, snap.project.governance);
  assert.deepStrictEqual(r.warnings, []);
});

test("evaluateWarnings: warnings fire when configured (parallel mechanism)", () => {
  // A SPEC_FROZEN warning fires when status is NOT in the allowed "still-editable"
  // set — i.e. predicate "passes" for backlog tickets, "fails" (warns) for ready+.
  // Same predicate library as gates; the failure-list just routes to .warnings.
  const snap = baseSnap();
  const governance = {
    gates: { SPEC_FROZEN: { predicate: "ticket_field",
      args: { field: "status", check: { in: ["backlog"] } } } },
    messages: {},
    tool_actions: {},
    tool_warnings: { ticket_update: { gates: ["SPEC_FROZEN"] } }
  };
  const ticket = { status: "ready" };
  const r = core.evaluateWarnings("ticket_update", snap, ticket, governance);
  assert.strictEqual(r.warnings.length, 1);
  assert.strictEqual(r.warnings[0].kind, "SPEC_FROZEN");
});

// ---------------------------------------------------------------------------
// renderMessage templater
// ---------------------------------------------------------------------------

test("renderMessage: plain variable interpolation", () => {
  const m = core.renderMessage(
    { title: "Hello {name}", reason: "value={count}" },
    { name: "World", count: 3 });
  assert.strictEqual(m.title, "Hello World");
  assert.strictEqual(m.reason, "value=3");
});

test("renderMessage: missing variable → empty replacement", () => {
  const m = core.renderMessage({ title: "{absent}!" }, {});
  assert.strictEqual(m.title, "!");
});

test("renderMessage: pluralization conditional {#count > N}...{/count}", () => {
  const single = core.renderMessage(
    { title: "{count} item{#count > 1}s{/count}" }, { count: 1 });
  assert.strictEqual(single.title, "1 item");
  const plural = core.renderMessage(
    { title: "{count} item{#count > 1}s{/count}" }, { count: 5 });
  assert.strictEqual(plural.title, "5 items");
});

test("renderMessage: array join format", () => {
  const m = core.renderMessage(
    { title: "Affected: {keys | join}" }, { keys: ["SM-1", "SM-2", "SM-3"] });
  assert.strictEqual(m.title, "Affected: SM-1, SM-2, SM-3");
});

test("renderMessage: shortdate format", () => {
  const m = core.renderMessage(
    { reason: "Opened {opened | shortdate}" },
    { opened: Date.UTC(2026, 4, 28) });
  assert.strictEqual(m.reason, "Opened 2026-05-28");
});

test("renderMessage: every key returned (empty when template field missing)", () => {
  const m = core.renderMessage({ title: "T" }, {});
  assert.strictEqual(m.title, "T");
  assert.strictEqual(m.reason, "");
  assert.strictEqual(m.suggestion, "");
  assert.strictEqual(m.skillRef, "");
});

// ---------------------------------------------------------------------------
// normalizeProject + STORYMAPPER_DEFAULT_GOVERNANCE
// ---------------------------------------------------------------------------

test("STORYMAPPER_DEFAULT_GOVERNANCE seeded into normalizeProject when empty", () => {
  const snap = baseSnap();
  assert.ok(snap.project.governance);
  assert.ok(snap.project.governance.gates.MISSING_STEPS);
  assert.ok(snap.project.governance.tool_actions.publish_test_definition);
});

test("updateProject accepts a governance patch (allowed field)", () => {
  const snap = baseSnap();
  const customGov = {
    gates: { NEW: { predicate: "ticket_field", args: { field: "title", check: "non_empty" } } },
    messages: { NEW: { title: "x" } },
    tool_actions: {},
    tool_warnings: {}
  };
  const next = core.ops.updateProject(snap, { governance: customGov }, HUMAN);
  assert.ok(next.project.governance.gates.NEW);
});

// ---------------------------------------------------------------------------
// Test-Definition lifecycle + derivedHealth (5 states)
// ---------------------------------------------------------------------------

test("normalizeTicket: test-definition gets lifecycle='draft' by default", () => {
  const snap = baseSnap({
    tickets: [{ id: "t-d", type: "test-definition", title: "T" }]
  });
  assert.strictEqual(snap.tickets[0].lifecycle, "draft");
});

test("normalizeTicket: lifecycle on non-test-definition is '' (uniform shape)", () => {
  const snap = baseSnap({ tickets: [{ id: "t-s", type: "user-story", title: "S" }] });
  assert.strictEqual(snap.tickets[0].lifecycle, "");
});

test("derivedHealth: 'unused' when no executions exist", () => {
  const snap = baseSnap({
    tickets: [{ id: "t-d", type: "test-definition" }]
  });
  assert.strictEqual(snap.tickets[0].derivedHealth, "unused");
});

test("derivedHealth: 'passing' when latest execution passed (no stale signals)", () => {
  const runAt = 2_000_000;
  const snap = baseSnap({
    tickets: [
      { id: "t-d", type: "test-definition", updatedAt: 1_000_000 },
      { id: "t-x", type: "test-execution", referencedTestDefinitionId: "t-d",
        runAt: runAt, updatedAt: runAt,
        executionSteps: [{ id: "es1", status: "passed" }] }
    ]
  });
  const def = snap.tickets.find(t => t.id === "t-d");
  assert.strictEqual(def.derivedHealth, "passing");
});

test("derivedHealth: 'failing' when latest execution has a failed step", () => {
  const snap = baseSnap({
    tickets: [
      { id: "t-d", type: "test-definition" },
      { id: "t-x", type: "test-execution", referencedTestDefinitionId: "t-d",
        runAt: 1, executionSteps: [{ id: "es1", status: "failed" }] }
    ]
  });
  assert.strictEqual(snap.tickets.find(t => t.id === "t-d").derivedHealth, "failing");
});

test("derivedHealth: 'stale' when definition updated AFTER latest passing run", () => {
  const snap = baseSnap({
    tickets: [
      { id: "t-d", type: "test-definition", updatedAt: 3_000_000 },
      { id: "t-x", type: "test-execution", referencedTestDefinitionId: "t-d",
        runAt: 2_000_000, executionSteps: [{ id: "es1", status: "passed" }] }
    ]
  });
  assert.strictEqual(snap.tickets.find(t => t.id === "t-d").derivedHealth, "stale");
});

test("derivedHealth: 'orphaned' when every tests-link target is missing/deleted", () => {
  const snap = baseSnap({
    tickets: [
      // Target tickets do NOT exist in the snapshot — the tests-link is dangling.
      // SM-44 will prune the dangling link, so we instead use a soft-deleted target.
      { id: "t-target", type: "user-story", isDeleted: true },
      { id: "t-d", type: "test-definition",
        links: [{ linkTypeId: "tests", targetTicketId: "t-target" }] }
    ]
  });
  assert.strictEqual(snap.tickets.find(t => t.id === "t-d").derivedHealth, "orphaned");
});

// ---------------------------------------------------------------------------

console.log(`\n  ${passed} passed, ${failed} failed`);
