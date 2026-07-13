"use strict";

const assert = require("assert");
const core = require("../server/core.js");

// Tiny inline test helper, sync + async aware (cmapper-style).
let passed = 0, failed = 0;
function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === "function") {
      return r.then(
        () => { console.log(`  ok  - ${name}`); passed++; },
        (err) => { console.log(`  FAIL - ${name}\n         ${err.stack || err.message}`); failed++; process.exitCode = 1; }
      );
    }
    console.log(`  ok  - ${name}`); passed++;
  } catch (err) {
    console.log(`  FAIL - ${name}\n         ${err.stack || err.message}`);
    failed++;
    process.exitCode = 1;
  }
}

const HUMAN = { type: "human", id: "u1", name: "Test User" };
const AI = { type: "ai", id: "claude", name: "Claude", sessionId: "test-1" };

// ---------------------------------------------------------------------------
// uid + measure helpers
// ---------------------------------------------------------------------------

test("uid generates prefix-based id with reasonable entropy", () => {
  const a = core.uid("t-");
  const b = core.uid("t-");
  assert.notStrictEqual(a, b);
  assert.ok(a.startsWith("t-"));
  assert.ok(a.length >= 8);
});

test("now returns a number (ms epoch)", () => {
  const n = core.now();
  assert.strictEqual(typeof n, "number");
  assert.ok(n > 1700000000000);
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

test("constants are exported", () => {
  assert.strictEqual(core.SCHEMA_VERSION, 1);
  assert.ok(Array.isArray(core.DEFAULT_TICKET_TYPES));
  assert.ok(core.DEFAULT_TICKET_TYPES.includes("user-story"));
  assert.ok(Array.isArray(core.DEFAULT_STATUSES));
  assert.deepStrictEqual(core.DEFAULT_STATUSES, ["backlog", "ready", "in-progress", "review", "done"]);
  assert.ok(core.LIMITS);
  assert.ok(typeof core.LIMITS.maxTicketsPerProject === "number");
});

// ---------------------------------------------------------------------------
// normalize* — defaults, idempotency
// ---------------------------------------------------------------------------

test("normalizeProject fills defaults and is idempotent", () => {
  const a = core.normalizeProject({ id: "p1", name: "Acme" });
  assert.strictEqual(a.id, "p1");
  assert.strictEqual(a.name, "Acme");
  assert.strictEqual(a.description, "");
  assert.strictEqual(a.ticketPrefix, "P");
  assert.strictEqual(a.ticketCounter, 0);
  // E13.C: storymapper seedet jetzt sinnvolle DoR/DoD-Defaults wenn das
  // Projekt ohne eigene Definitions angelegt wird. Beide Listen sind
  // damit non-empty out of the box.
  assert.ok(a.definitions);
  assert.ok(a.definitions.ready);
  assert.ok(a.definitions.done);
  assert.ok(a.definitions.ready.global.length > 0, "DoR defaults should be seeded");
  assert.ok(a.definitions.done.global.length > 0,  "DoD defaults should be seeded");
  // E13.C: storymapper seedet ebenso einen Default-Workflow.
  assert.ok(a.workflow);
  assert.ok(Array.isArray(a.workflow.statuses) && a.workflow.statuses.length > 0);
  assert.ok(a.workflow.transitions, "workflow.transitions present");
  assert.ok(Array.isArray(a.ticketTypes));
  assert.ok(Array.isArray(a.labels));
  assert.strictEqual(a.isDeleted, false);
  // Idempotency: normalize again is byte-equal.
  const b = core.normalizeProject(a);
  assert.deepStrictEqual(b, a);
});

test("normalizeProject preserves provided definitions", () => {
  const a = core.normalizeProject({
    id: "p1",
    name: "Acme",
    definitions: {
      ready: { global: [{ id: "ac", label: "AC defined", required: true }] },
      done: { global: [{ id: "cr", label: "Code review", required: true }] }
    }
  });
  assert.strictEqual(a.definitions.ready.global.length, 1);
  assert.strictEqual(a.definitions.ready.global[0].label, "AC defined");
});

test("E13.C: empty definitions get seeded with STORYMAPPER_DEFAULT_DEFINITIONS", () => {
  const p = core.normalizeProject({ id: "p1", name: "P" });
  const expectDor = core.STORYMAPPER_DEFAULT_DEFINITIONS.ready.global.map(it => it.id);
  const expectDod = core.STORYMAPPER_DEFAULT_DEFINITIONS.done.global.map(it => it.id);
  assert.deepStrictEqual(p.definitions.ready.global.map(it => it.id), expectDor);
  assert.deepStrictEqual(p.definitions.done.global.map(it => it.id),  expectDod);
});

function findTransitionTo(transitions, toStatus) {
  return (transitions || []).find(t => t.toStatus === toStatus) || null;
}

test("E13.C: missing workflow gets seeded with STORYMAPPER_DEFAULT_WORKFLOW", () => {
  const p = core.normalizeProject({ id: "p1", name: "P" });
  assert.deepStrictEqual(p.workflow.statuses, core.STORYMAPPER_DEFAULT_WORKFLOW.statuses);
  // After E21.B transitions are an array; default workflow has gates on
  // 'ready' (DoR) and 'done' (DoD). Status entries without gates also
  // exist as allowFromAny transitions so legacy forward moves remain
  // possible.
  const ready = findTransitionTo(p.workflow.transitions, "ready");
  const done  = findTransitionTo(p.workflow.transitions, "done");
  assert.ok(ready, "transition to 'ready' exists");
  assert.ok(done,  "transition to 'done' exists");
  assert.strictEqual(ready.requireGate, "DoR");
  assert.strictEqual(done.requireGate,  "DoD");
  assert.strictEqual(ready.allowFromAny, true, "default transitions are allowFromAny");
});

test("E21.A: STORYMAPPER_DEFAULT_WORKFLOW.statuses are full status objects (not strings)", () => {
  const statuses = core.STORYMAPPER_DEFAULT_WORKFLOW.statuses;
  assert.ok(Array.isArray(statuses) && statuses.length > 0, "default statuses must be a non-empty array");
  for (const s of statuses) {
    assert.strictEqual(typeof s, "object", "status entry must be object");
    assert.strictEqual(typeof s.id, "string");
    assert.strictEqual(typeof s.name, "string");
    assert.ok(["todo", "doing", "blocked", "done", "cancelled"].includes(s.category),
      "category must be one of todo|doing|blocked|done|cancelled, got " + s.category);
  }
});

test("E21.A: default workflow categorizes well-known statuses correctly", () => {
  const byId = {};
  for (const s of core.STORYMAPPER_DEFAULT_WORKFLOW.statuses) byId[s.id] = s.category;
  assert.strictEqual(byId.backlog,       "todo");
  assert.strictEqual(byId.ready,         "todo");
  assert.strictEqual(byId["in-progress"], "doing");
  assert.strictEqual(byId.review,        "doing");
  assert.strictEqual(byId.done,          "done");
});

test("E21.A: normalizeWorkflow migrates legacy string statuses to objects", () => {
  const wf = core.normalizeWorkflow({
    statuses: ["backlog", "doing-thing", "blocked", "done"],
    transitions: { "done": { requireGate: "DoD" } },
    byType: {}
  });
  assert.ok(Array.isArray(wf.statuses));
  const ids = wf.statuses.map(s => s.id);
  // SM-242: additive migration appends a cancelled status (workflow had none).
  assert.deepStrictEqual(ids, ["backlog", "doing-thing", "blocked", "done", "cancelled"]);
  // Names default to a humanized variant of the id (here we just check shape).
  for (const s of wf.statuses) {
    assert.strictEqual(typeof s.name, "string");
    assert.ok(s.name.length > 0);
  }
  // Default categorization heuristic: blocked → blocked, backlog → todo, done → done,
  // unknown stays "doing" by default.
  const byId = {};
  for (const s of wf.statuses) byId[s.id] = s.category;
  assert.strictEqual(byId.backlog,       "todo");
  assert.strictEqual(byId.blocked,       "blocked");
  assert.strictEqual(byId.done,          "done");
  assert.strictEqual(byId["doing-thing"], "doing");
});

test("E21.A: normalizeWorkflow respects explicit status objects (idempotent)", () => {
  const input = {
    statuses: [
      { id: "todo", name: "To Do", category: "todo" },
      { id: "wip",  name: "Work in Progress", category: "doing" },
      { id: "hold", name: "On Hold", category: "blocked" },
      { id: "shipped", name: "Shipped", category: "done" }
    ],
    transitions: {},
    byType: {}
  };
  const a = core.normalizeWorkflow(input);
  const b = core.normalizeWorkflow(a);
  assert.deepStrictEqual(a, b);   // idempotent (incl. the SM-242 cancelled migration)
  // SM-242: a cancelled status is appended (input had none); the original four
  // are byte-identical and precede it.
  assert.deepStrictEqual(a.statuses.slice(0, 4), input.statuses);
  assert.strictEqual(a.statuses.length, 5);
  assert.strictEqual(a.statuses[4].category, "cancelled");
});

test("E21.A: normalizeWorkflow rejects invalid categories (falls back to doing)", () => {
  const wf = core.normalizeWorkflow({
    statuses: [{ id: "weird", name: "Weird", category: "bogus" }],
    transitions: {}, byType: {}
  });
  assert.strictEqual(wf.statuses[0].category, "doing");
});

test("E21.A: validateStatusTransition still works on object-form statuses", () => {
  const project = core.normalizeProject({
    id: "p1", name: "P",
    workflow: {
      statuses: [
        { id: "backlog", name: "Backlog", category: "todo" },
        { id: "ready",   name: "Ready",   category: "todo" },
        { id: "done",    name: "Done",    category: "done" }
      ],
      transitions: { "ready": { requireGate: "DoR" }, "done": { requireGate: "DoD" } },
      byType: {}
    }
  });
  const t = core.normalizeTicket({
    id: "t1", projectId: "p1", type: "user-story", title: "T",
    status: "backlog",
    definitionOfReady: { items: [{ id: "g1", label: "G1", required: true, checked: false }] },
    definitionOfDone:  { items: [] }
  });
  assert.throws(() => core.validateStatusTransition(t, "ready", project),
    /definition of ready not met/, "DoR gate fires on unchecked required item");
  t.definitionOfReady.items[0].checked = true;
  // should not throw now
  core.validateStatusTransition(t, "ready", project);
});

test("E13.C: getWorkflowForType returns base workflow when no per-type override", () => {
  const p = core.normalizeProject({ id: "p1", name: "P" });
  const wf = core.getWorkflowForType(p, "user-story");
  assert.deepStrictEqual(wf.statuses, core.STORYMAPPER_DEFAULT_WORKFLOW.statuses);
  assert.strictEqual(findTransitionTo(wf.transitions, "ready").requireGate, "DoR");
});

test("E13.C: getWorkflowForType applies per-type override", () => {
  const p = core.normalizeProject({
    id: "p1", name: "P",
    workflow: {
      statuses: ["backlog", "ready", "done"],
      transitions: { "ready": { requireGate: "DoR" }, "done": { requireGate: "DoD" } },
      byType: {
        "bug": { transitions: { "ready": { requireGate: null } } }
      }
    }
  });
  const bug = core.getWorkflowForType(p, "bug");
  assert.strictEqual(findTransitionTo(bug.transitions, "ready").requireGate, null, "bug.ready gate disabled");
  assert.strictEqual(findTransitionTo(bug.transitions, "done").requireGate,  "DoD", "bug.done gate inherits");
  const story = core.getWorkflowForType(p, "user-story");
  assert.strictEqual(findTransitionTo(story.transitions, "ready").requireGate, "DoR", "story.ready unchanged");
});

test("E21.B: normalizeWorkflow migrates legacy {target:{gate}} object form to array", () => {
  const wf = core.normalizeWorkflow({
    statuses: ["backlog", "ready", "done"],
    transitions: { "ready": { requireGate: "DoR" }, "done": { requireGate: "DoD" } },
    byType: {}
  });
  assert.ok(Array.isArray(wf.transitions), "transitions normalized to array");
  // Every status should have a transition entry (allowFromAny=true) so the
  // legacy forward-move behavior is preserved by default.
  const ids = wf.transitions.map(t => t.toStatus);
  assert.ok(ids.includes("backlog"));
  assert.ok(ids.includes("ready"));
  assert.ok(ids.includes("done"));
  for (const t of wf.transitions) {
    assert.strictEqual(typeof t.id, "string");
    assert.strictEqual(typeof t.name, "string");
    assert.ok(Array.isArray(t.fromStatuses));
    assert.strictEqual(typeof t.allowFromAny, "boolean");
    assert.strictEqual(t.allowFromAny, true, "legacy migration emits allowFromAny transitions");
  }
  const ready = findTransitionTo(wf.transitions, "ready");
  assert.strictEqual(ready.requireGate, "DoR");
  const done  = findTransitionTo(wf.transitions, "done");
  assert.strictEqual(done.requireGate,  "DoD");
  const backlog = findTransitionTo(wf.transitions, "backlog");
  assert.strictEqual(backlog.requireGate, null, "status without legacy gate gets requireGate=null");
});

test("E21.B: normalizeWorkflow respects explicit named transitions (idempotent)", () => {
  const input = {
    statuses: [
      { id: "todo", name: "To Do", category: "todo" },
      { id: "wip",  name: "WIP",   category: "doing" },
      { id: "done", name: "Done",  category: "done" }
    ],
    transitions: [
      { id: "t-start", name: "Start", fromStatuses: ["todo"], toStatus: "wip", requireGate: null, allowFromAny: false },
      { id: "t-resolve", name: "Resolve", fromStatuses: ["wip"], toStatus: "done", requireGate: "DoD", allowFromAny: false },
      { id: "t-cancel", name: "Cancel", fromStatuses: [], toStatus: "done", requireGate: null, allowFromAny: true }
    ],
    byType: {}
  };
  const a = core.normalizeWorkflow(input);
  const b = core.normalizeWorkflow(a);
  assert.deepStrictEqual(a, b);
  // SM-242: the 3 explicit transitions are preserved + a cancel transition is
  // appended (no cancelled-category status existed). The original toStatus=done
  // "Cancel" entry stays; the migration's cancel points at the new cancelled id.
  assert.strictEqual(a.transitions.length, 4);
  assert.strictEqual(a.transitions[1].requireGate, "DoD");
  assert.strictEqual(a.transitions[3].toStatus, "cancelled");
});

test("E21.B: normalizeWorkflow drops transitions with unknown toStatus", () => {
  const wf = core.normalizeWorkflow({
    statuses: ["todo", "done"],
    transitions: [
      { id: "ok",  name: "OK",  fromStatuses: ["todo"], toStatus: "done",  requireGate: null, allowFromAny: false },
      { id: "bad", name: "Bad", fromStatuses: ["todo"], toStatus: "ghost", requireGate: null, allowFromAny: false }
    ],
    byType: {}
  });
  const ids = wf.transitions.map(t => t.id);
  assert.ok(ids.includes("ok"));
  assert.ok(!ids.includes("bad"), "transition to non-existent status is dropped");
});

test("E21.B: byType per-type transitions also migrated", () => {
  const wf = core.normalizeWorkflow({
    statuses: ["backlog", "ready", "done"],
    transitions: { "ready": { requireGate: "DoR" }, "done": { requireGate: "DoD" } },
    byType: {
      "bug": { transitions: { "ready": { requireGate: null } } }
    }
  });
  assert.ok(Array.isArray(wf.byType.bug.transitions));
  // Per-type override should produce a single transition (the one explicitly
  // overridden) — the base-level transitions still apply on top via merge in
  // getWorkflowForType.
  const ready = findTransitionTo(wf.byType.bug.transitions, "ready");
  assert.ok(ready, "per-type ready transition present");
  assert.strictEqual(ready.requireGate, null);
});

// ---------------------------------------------------------------------------
// E21.C — project.boards.kanban.columns
// ---------------------------------------------------------------------------

test("E21.C: normalizeProject seeds boards.kanban with one column per status", () => {
  const p = core.normalizeProject({ id: "p1", name: "P" });
  assert.ok(p.boards && p.boards.kanban, "boards.kanban present");
  const cols = p.boards.kanban.columns;
  assert.ok(Array.isArray(cols));
  // SM-242: default workflow now has 6 statuses (incl. cancelled) → 6 columns.
  assert.strictEqual(cols.length, 6);
  const statusIds = core.STORYMAPPER_DEFAULT_WORKFLOW.statuses.map(s => s.id);
  cols.forEach((c, i) => {
    assert.strictEqual(typeof c.id, "string");
    assert.strictEqual(typeof c.name, "string");
    assert.ok(Array.isArray(c.statusIds));
    // Default mapping: 1:1 — one status per column, same order.
    assert.deepStrictEqual(c.statusIds, [statusIds[i]]);
  });
});

test("E21.C: normalizeProject is idempotent w.r.t. existing kanban columns", () => {
  const cols = [
    { id: "col-todo",    name: "To Do",       statusIds: ["backlog", "ready"] },
    { id: "col-doing",   name: "In Progress", statusIds: ["in-progress", "review"] },
    { id: "col-done",    name: "Done",        statusIds: ["done"] }
  ];
  const a = core.normalizeProject({ id: "p1", name: "P", boards: { kanban: { columns: cols } } });
  const b = core.normalizeProject(a);
  assert.deepStrictEqual(a.boards.kanban.columns, b.boards.kanban.columns);
  assert.strictEqual(a.boards.kanban.columns.length, 3);
  assert.deepStrictEqual(a.boards.kanban.columns[0].statusIds, ["backlog", "ready"]);
});

test("E21.C: normalizeProject drops column statusIds that don't exist in workflow", () => {
  const p = core.normalizeProject({
    id: "p1", name: "P",
    workflow: { statuses: ["todo", "done"], transitions: {} },
    boards: { kanban: { columns: [
      { id: "c1", name: "Mix", statusIds: ["todo", "ghost", "done"] }
    ] } }
  });
  assert.deepStrictEqual(p.boards.kanban.columns[0].statusIds, ["todo", "done"]);
});

test("E21.C: normalizeProject keeps user-created empty columns (E21.G makes them addable)", () => {
  // After E21.G the user can add empty columns and drag statuses in later.
  // Columns with all-stale statusIds are NOT dropped — they survive as
  // empty containers. Stale statusIds themselves are filtered out. Orphan
  // statuses that end up in no column are surfaced as orphan-lanes by the
  // kanban renderer (computeKanbanLayout), so nothing is invisible.
  const p = core.normalizeProject({
    id: "p1", name: "P",
    workflow: { statuses: ["todo", "done"], transitions: {} },
    boards: { kanban: { columns: [
      { id: "stale", name: "Stale", statusIds: ["nonexistent"] }
    ] } }
  });
  const cols = p.boards.kanban.columns;
  assert.strictEqual(cols.length, 1, "user-defined column must survive");
  assert.strictEqual(cols[0].id, "stale");
  assert.deepStrictEqual(cols[0].statusIds, [], "stale ids dropped, column kept empty");
});

test("normalizeTicket fills defaults and is idempotent", () => {
  const a = core.normalizeTicket({ id: "t1", projectId: "p1", type: "user-story", title: "T" });
  assert.strictEqual(a.id, "t1");
  assert.strictEqual(a.projectId, "p1");
  assert.strictEqual(a.type, "user-story");
  assert.strictEqual(a.title, "T");
  assert.strictEqual(a.description, "");
  assert.strictEqual(a.status, "backlog");
  assert.deepStrictEqual(a.position, { releaseId: null, epicId: null, processStepId: null, sortOrder: 0 });
  assert.ok(a.definitionOfReady);
  assert.deepStrictEqual(a.definitionOfReady.items, []);
  assert.ok(a.definitionOfDone);
  assert.deepStrictEqual(a.acceptanceCriteria, []);
  assert.deepStrictEqual(a.comments, []);
  assert.deepStrictEqual(a.labels, []);
  assert.deepStrictEqual(a.links, []);
  assert.strictEqual(a.isDeleted, false);
  assert.strictEqual(a.version, 1);
  const b = core.normalizeTicket(a);
  assert.deepStrictEqual(b, a);
});

test("SM-197 R-1: requirement is a default ticket type", () => {
  assert.ok(core.DEFAULT_TICKET_TYPES.includes("requirement"));
});

test("SM-197 R-1: isSpecType / isBoardWorkItem predicates", () => {
  assert.strictEqual(core.isSpecType("requirement"), true);
  assert.strictEqual(core.isSpecType("user-story"), false);
  assert.strictEqual(core.isSpecType("epic"), false);
  // board work-items = movable cards on the kanban
  assert.strictEqual(core.isBoardWorkItem("user-story"), true);
  assert.strictEqual(core.isBoardWorkItem("bug"), true);
  assert.strictEqual(core.isBoardWorkItem("test-definition"), true);
  assert.strictEqual(core.isBoardWorkItem("epic"), false);        // container
  assert.strictEqual(core.isBoardWorkItem("requirement"), false); // spec object
});

test("SM-197 R-1: normalizeTicket carries sectionPath + sourceAnchor on requirement", () => {
  const r = core.normalizeTicket({
    id: "r1", type: "requirement", title: "The system shall …",
    sectionPath: "2.1",
    sourceAnchor: { attachmentId: "att-9", sectionId: "2.1", charStart: 120, charEnd: 240 }
  });
  assert.strictEqual(r.type, "requirement");
  assert.strictEqual(r.sectionPath, "2.1");
  assert.deepStrictEqual(r.sourceAnchor, { attachmentId: "att-9", sectionId: "2.1", charStart: 120, charEnd: 240 });
  assert.deepStrictEqual(core.normalizeTicket(r), r);   // idempotent
});

test("SM-197 R-1: non-requirement tickets get uniform empty spec fields", () => {
  const s = core.normalizeTicket({
    id: "s1", type: "user-story", title: "Story",
    sectionPath: "9.9", sourceAnchor: { attachmentId: "att-x" }
  });
  assert.strictEqual(s.sectionPath, "");   // gated to requirement type
  assert.strictEqual(s.sourceAnchor, null);
});

test("SM-197 R-1: sourceAnchor tolerates partial / missing input", () => {
  const r = core.normalizeTicket({ id: "r2", type: "requirement", title: "X" });
  assert.strictEqual(r.sectionPath, "");
  assert.strictEqual(r.sourceAnchor, null);
  const r2 = core.normalizeTicket({
    id: "r3", type: "requirement", title: "Y", sourceAnchor: { attachmentId: "att-1" }
  });
  assert.deepStrictEqual(r2.sourceAnchor, { attachmentId: "att-1", sectionId: "", charStart: null, charEnd: null });
});

test("SM-197 R-1: getEntityTypeConfig for requirement hides work-item sections", () => {
  const cfg = core.getEntityTypeConfig({}, "requirement");
  assert.strictEqual(cfg.showAcceptanceCriteria, false);
  assert.strictEqual(cfg.showDefinitionOfReady, false);
  assert.strictEqual(cfg.showDefinitionOfDone, false);
  assert.strictEqual(cfg.allowParentEpic, false);
  assert.strictEqual(cfg.showRelease, false);
  assert.strictEqual(cfg.showProcessStep, false);
  assert.strictEqual(cfg.showLinks, true);
});

test("SM-198 R-2: spec-module is a default spec type, board-excluded", () => {
  assert.ok(core.DEFAULT_TICKET_TYPES.includes("spec-module"));
  assert.strictEqual(core.isSpecType("spec-module"), true);
  assert.strictEqual(core.isBoardWorkItem("spec-module"), false);
  const cfg = core.getEntityTypeConfig({}, "spec-module");
  assert.strictEqual(cfg.showRelease, false);
  assert.strictEqual(cfg.showProcessStep, false);
  assert.strictEqual(cfg.allowParentEpic, false);
  assert.strictEqual(cfg.showDefinitionOfReady, false);
});

test("SM-198 R-2: normalizeTicket carries sourceAttachmentId on spec-module only", () => {
  const m = core.normalizeTicket({ id: "m1", type: "spec-module", title: "PRD", sourceAttachmentId: "att-1" });
  assert.strictEqual(m.sourceAttachmentId, "att-1");
  const s = core.normalizeTicket({ id: "s1", type: "user-story", title: "S", sourceAttachmentId: "att-x" });
  assert.strictEqual(s.sourceAttachmentId, "");
  assert.deepStrictEqual(core.normalizeTicket(m), m);   // idempotent
});

test("SM-198 R-2: compareSectionPath sorts numerically per dotted segment", () => {
  assert.ok(core.compareSectionPath("2.1", "2.10") < 0);
  assert.ok(core.compareSectionPath("2.10", "10.1") < 0);
  assert.ok(core.compareSectionPath("10.1", "2.9") > 0);   // not lexical
  assert.strictEqual(core.compareSectionPath("3.2", "3.2"), 0);
  assert.ok(core.compareSectionPath("", "1") < 0);          // empty first
});

test("SM-198 R-2: requirementsInModule returns slices in document (sectionPath) order", () => {
  const snap = core.normalizeSnapshot({
    project: { id: "p", name: "P", ticketPrefix: "P" },
    tickets: [
      { id: "m1", type: "spec-module", title: "PRD", sourceAttachmentId: "att-1", links: [
        { linkTypeId: "contains", targetTicketId: "r-b" },
        { linkTypeId: "contains", targetTicketId: "r-a" },
        { linkTypeId: "contains", targetTicketId: "r-c" }
      ] },
      { id: "r-a", type: "requirement", title: "A", sectionPath: "2.1" },
      { id: "r-b", type: "requirement", title: "B", sectionPath: "2.10" },
      { id: "r-c", type: "requirement", title: "C", sectionPath: "10.1" },
      { id: "s1", type: "user-story", title: "Story" }
    ]
  });
  assert.deepStrictEqual(core.tickets.specModules(snap).map(t => t.id), ["m1"]);
  assert.deepStrictEqual(
    core.tickets.requirementsInModule(snap, "m1").map(t => t.sectionPath),
    ["2.1", "2.10", "10.1"]
  );
  assert.deepStrictEqual(core.tickets.requirementsInModule(snap, "nope"), []);
});

test("SM-198 R-2: requirements + spec-modules never leak into story-map backlog", () => {
  const snap = core.normalizeSnapshot({
    project: { id: "p", name: "P", ticketPrefix: "P" },
    tickets: [
      { id: "m1", type: "spec-module", title: "PRD" },
      { id: "r-a", type: "requirement", title: "A", sectionPath: "1" },
      { id: "s1", type: "user-story", title: "Orphan story" }
    ]
  });
  // Only the real story is an orphan; the SpecObjects stay out of the board.
  assert.deepStrictEqual(core.tickets.orphanStories(snap).map(t => t.id), ["s1"]);
  assert.deepStrictEqual(core.tickets.backlogEpics(snap).map(t => t.id), []);
});

test("normalizeRelease fills defaults", () => {
  const a = core.normalizeRelease({ id: "r1", projectId: "p1", name: "v1.0" });
  assert.strictEqual(a.status, "planning");
  assert.strictEqual(a.sortOrder, 0);
  assert.strictEqual(a.description, "");
  assert.strictEqual(a.startDate, null);
  assert.strictEqual(a.endDate, null);
  assert.strictEqual(a.isDeleted, false);
});

test("normalizeProcessStep fills defaults", () => {
  const a = core.normalizeProcessStep({ id: "ps1", projectId: "p1", name: "Onboarding" });
  assert.strictEqual(a.description, "");
  assert.strictEqual(a.epicId, null);
  assert.strictEqual(a.sortOrder, 0);
  assert.strictEqual(a.isDeleted, false);
});

test("normalizeSnapshot normalizes all sub-entities", () => {
  const snap = core.normalizeSnapshot({
    project: { id: "p1", name: "Acme" },
    tickets: [{ id: "t1", projectId: "p1", type: "user-story", title: "X" }],
    releases: [{ id: "r1", projectId: "p1", name: "v1" }],
    processSteps: [{ id: "ps1", projectId: "p1", name: "S1" }]
  });
  assert.strictEqual(snap.version, 1);
  assert.strictEqual(snap.project.description, "");
  assert.strictEqual(snap.tickets[0].status, "backlog");
  assert.strictEqual(snap.releases[0].status, "planning");
  assert.strictEqual(snap.processSteps[0].epicId, null);
});

// ---------------------------------------------------------------------------
// resolveDefinitions
// ---------------------------------------------------------------------------

test("resolveDefinitions on empty definitions yields empty lists", () => {
  const r = core.resolveDefinitions({ ready: { global: [], byType: {} }, done: { global: [], byType: {} } }, "user-story");
  assert.deepStrictEqual(r, { ready: [], done: [] });
});

test("resolveDefinitions returns globals when no byType match", () => {
  const defs = {
    ready: { global: [{ id: "g1", label: "G1", required: true }], byType: {} },
    done:  { global: [{ id: "d1", label: "D1", required: true }], byType: {} }
  };
  const r = core.resolveDefinitions(defs, "user-story");
  assert.strictEqual(r.ready.length, 1);
  assert.strictEqual(r.ready[0].id, "g1");
  assert.strictEqual(r.done[0].id, "d1");
});

test("resolveDefinitions appends byType.appended to globals", () => {
  const defs = {
    ready: {
      global: [{ id: "g1", label: "G1", required: true }],
      byType: { "user-story": { appended: [{ id: "us1", label: "US1", required: true }] } }
    },
    done: { global: [], byType: {} }
  };
  const r = core.resolveDefinitions(defs, "user-story");
  assert.strictEqual(r.ready.length, 2);
  assert.deepStrictEqual(r.ready.map(i => i.id), ["g1", "us1"]);
});

test("resolveDefinitions: byType.overridden replaces globals", () => {
  const defs = {
    ready: {
      global: [{ id: "g1", label: "G1", required: true }],
      byType: { "bug": { overridden: [{ id: "b1", label: "Repro", required: true }] } }
    },
    done: { global: [], byType: {} }
  };
  const r = core.resolveDefinitions(defs, "bug");
  assert.strictEqual(r.ready.length, 1);
  assert.strictEqual(r.ready[0].id, "b1");
});

test("resolveDefinitions: unknown ticketType returns only globals", () => {
  const defs = {
    ready: {
      global: [{ id: "g1", label: "G1", required: true }],
      byType: { "user-story": { appended: [{ id: "us1", label: "US1", required: true }] } }
    },
    done: { global: [], byType: {} }
  };
  const r = core.resolveDefinitions(defs, "made-up-type");
  assert.strictEqual(r.ready.length, 1);
  assert.strictEqual(r.ready[0].id, "g1");
});

// ---------------------------------------------------------------------------
// buildTicketChecklists — freezing
// ---------------------------------------------------------------------------

test("buildTicketChecklists freezes resolved items onto a new ticket", () => {
  const project = core.normalizeProject({
    id: "p1", name: "Acme",
    definitions: {
      ready: {
        global: [{ id: "g1", label: "G1", required: true }],
        byType: { "user-story": { appended: [{ id: "us1", label: "US1", required: true }] } }
      },
      done: {
        global: [{ id: "cr", label: "Code review", required: true }],
        byType: {}
      }
    }
  });
  const { definitionOfReady, definitionOfDone } = core.buildTicketChecklists(project, { type: "user-story" });
  assert.strictEqual(definitionOfReady.items.length, 2);
  assert.strictEqual(definitionOfReady.items[0].id, "g1");
  assert.strictEqual(definitionOfReady.items[0].checked, false);
  assert.strictEqual(definitionOfReady.items[0].checkedAt, null);
  assert.strictEqual(definitionOfReady.items[0].checkedBy, null);
  assert.strictEqual(definitionOfDone.items.length, 1);
  assert.strictEqual(definitionOfDone.items[0].id, "cr");
});

// ---------------------------------------------------------------------------
// ops — createTicket and friends
// ---------------------------------------------------------------------------

function freshSnapshot(overrides) {
  return core.normalizeSnapshot(Object.assign({
    project: {
      id: "p1", name: "Acme", ticketPrefix: "P",
      definitions: {
        ready: { global: [{ id: "g1", label: "G1", required: true }], byType: {} },
        done:  { global: [{ id: "d1", label: "D1", required: true }], byType: {} }
      }
    },
    tickets: [],
    releases: [],
    processSteps: []
  }, overrides));
}

test("SM-254: seedDefaultScaffold seeds one default release + process step when empty", () => {
  const s0 = freshSnapshot();   // no releases, no process steps
  const s1 = core.seedDefaultScaffold(s0, HUMAN);
  const rels = s1.releases.filter(r => !r.isDeleted);
  const steps = s1.processSteps.filter(p => !p.isDeleted);
  assert.strictEqual(rels.length, 1, "exactly one default release");
  assert.strictEqual(rels[0].name, core.DEFAULT_RELEASE_NAME);
  assert.strictEqual(steps.length, 1, "exactly one default process step");
  assert.strictEqual(steps[0].name, core.DEFAULT_PROCESS_STEP_NAME);
});

test("SM-254: seedDefaultScaffold is idempotent — never double-seeds", () => {
  const s0 = freshSnapshot();
  const once = core.seedDefaultScaffold(s0, HUMAN);
  const twice = core.seedDefaultScaffold(once, HUMAN);
  assert.strictEqual(twice.releases.filter(r => !r.isDeleted).length, 1, "still one release");
  assert.strictEqual(twice.processSteps.filter(p => !p.isDeleted).length, 1, "still one process step");
  // A project that already has its own structure is left untouched.
  let custom = core.ops.createRelease(freshSnapshot(), { name: "MVP" }, HUMAN);
  custom = core.seedDefaultScaffold(custom, HUMAN);
  assert.deepStrictEqual(custom.releases.filter(r => !r.isDeleted).map(r => r.name), ["MVP"],
    "existing release kept, no default added");
  assert.strictEqual(custom.processSteps.filter(p => !p.isDeleted).length, 1,
    "missing process step still gets seeded");
});

test("ops.createTicket adds ticket with frozen checklists and increments ticket_counter", () => {
  const s0 = freshSnapshot();
  const s1 = core.ops.createTicket(s0, { type: "user-story", title: "First story" }, HUMAN);
  assert.strictEqual(s1.tickets.length, 1);
  const t = s1.tickets[0];
  assert.strictEqual(t.title, "First story");
  assert.strictEqual(t.status, "backlog");
  assert.strictEqual(t.ticketKey, "P-1");
  assert.strictEqual(s1.project.ticketCounter, 1);
  assert.strictEqual(t.definitionOfReady.items.length, 1);
  assert.strictEqual(t.definitionOfReady.items[0].id, "g1");
  assert.strictEqual(t.definitionOfReady.items[0].checked, false);
  assert.deepStrictEqual(t.createdBy, HUMAN);
});

test("ops.createTicket: second ticket gets next key", () => {
  const s0 = freshSnapshot();
  const s1 = core.ops.createTicket(s0, { type: "user-story", title: "A" }, HUMAN);
  const s2 = core.ops.createTicket(s1, { type: "bug", title: "B" }, HUMAN);
  assert.strictEqual(s2.tickets[0].ticketKey, "P-1");
  assert.strictEqual(s2.tickets[1].ticketKey, "P-2");
  assert.strictEqual(s2.project.ticketCounter, 2);
});

test("SM-196: a requirement created in a single-epic cell gets NO epic container (review fix)", () => {
  let s = freshSnapshot({
    releases:     [{ id: "r1", name: "R" }],
    processSteps: [{ id: "ps1", name: "PS" }]
  });
  s = core.ops.createTicket(s, { type: "epic", title: "E", position: { releaseId: "r1", processStepId: "ps1" } }, HUMAN);
  const epicId = s.tickets.find(t => t.type === "epic").id;
  s = core.ops.createTicket(s, { type: "requirement", title: "REQ", position: { releaseId: "r1", processStepId: "ps1" } }, HUMAN);
  const req = s.tickets.find(t => t.type === "requirement");
  const epic = s.tickets.find(t => t.id === epicId);
  const contained = (epic.links || []).some(l => (l.linkTypeId || l.type) === "contains" && l.targetTicketId === req.id);
  assert.ok(!contained, "requirement must not be auto-contained by the cell's epic");
  assert.strictEqual(req.position.epicId, null);
});

test("ops.updateTicket patches fields and bumps version + updatedBy/At", () => {
  const s0 = freshSnapshot();
  const s1 = core.ops.createTicket(s0, { type: "user-story", title: "A" }, HUMAN);
  const t1 = s1.tickets[0];
  const before = t1.version;
  const s2 = core.ops.updateTicket(s1, t1.id, { title: "A renamed", description: "more" }, AI);
  const t2 = s2.tickets[0];
  assert.strictEqual(t2.title, "A renamed");
  assert.strictEqual(t2.description, "more");
  assert.strictEqual(t2.version, before + 1);
  assert.deepStrictEqual(t2.updatedBy, AI);
});

test("SM-260: a partial position patch MERGES with the current position (releaseId-only move)", () => {
  let s = freshSnapshot();
  s = core.ops.createRelease(s, { id: "RA", name: "vA" }, HUMAN);
  s = core.ops.createRelease(s, { id: "RB", name: "vB" }, HUMAN);
  s = core.ops.createProcessStep(s, { id: "PA", name: "Build" }, HUMAN);
  s = core.ops.createTicket(s, { type: "user-story", title: "A",
    position: { releaseId: "RA", processStepId: "PA", sortOrder: 3 } }, HUMAN);
  const id = s.tickets[0].id;
  // Move to another release ONLY — processStep + sortOrder must survive.
  s = core.ops.updateTicket(s, id, { position: { releaseId: "RB" } }, HUMAN);
  const p = s.tickets.find(t => t.id === id).position;
  assert.strictEqual(p.releaseId, "RB", "releaseId moved");
  assert.strictEqual(p.processStepId, "PA", "processStep preserved (not nulled)");
  assert.strictEqual(p.sortOrder, 3, "sortOrder preserved");
  // An explicit null still clears a field.
  s = core.ops.updateTicket(s, id, { position: { releaseId: null } }, HUMAN);
  assert.strictEqual(s.tickets.find(t => t.id === id).position.releaseId, null, "explicit null clears");
  assert.strictEqual(s.tickets.find(t => t.id === id).position.processStepId, "PA", "other fields still kept");
});

// --- SM-170: Card-Aging — statusEnteredAt -----------------------------------

test("SM-170: a new ticket's statusEnteredAt defaults to createdAt", () => {
  const s0 = freshSnapshot();
  const s1 = core.ops.createTicket(s0, { type: "user-story", title: "A" }, HUMAN);
  const t = s1.tickets[0];
  assert.strictEqual(typeof t.statusEnteredAt, "number");
  assert.strictEqual(t.statusEnteredAt, t.createdAt);
});

test("SM-170: changeStatus resets statusEnteredAt; a no-op transition keeps it", () => {
  const s0 = freshSnapshot();
  let s = core.ops.createTicket(s0, { type: "user-story", title: "A", status: "backlog" }, HUMAN);
  const id = s.tickets[0].id;
  // Plant an old entry time to make the reset observable regardless of clock res.
  s.tickets[0].statusEnteredAt = 1000;
  // No-op: same status → unchanged.
  s = core.ops.changeStatus(s, id, "backlog", HUMAN);
  assert.strictEqual(s.tickets[0].statusEnteredAt, 1000, "same-status change must not reset the clock");
  // Real transition → reset to ~now.
  s = core.ops.changeStatus(s, id, "ready", HUMAN);
  assert.ok(s.tickets[0].statusEnteredAt > 1000, "real transition resets statusEnteredAt");
});

test("SM-170: updateTicket resets statusEnteredAt only when the patch changes status", () => {
  const s0 = freshSnapshot();
  let s = core.ops.createTicket(s0, { type: "user-story", title: "A", status: "backlog" }, HUMAN);
  const id = s.tickets[0].id;
  s.tickets[0].statusEnteredAt = 1000;
  // Non-status patch → clock untouched.
  s = core.ops.updateTicket(s, id, { title: "renamed" }, HUMAN);
  assert.strictEqual(s.tickets[0].statusEnteredAt, 1000, "non-status update must not reset the clock");
  // Status patch → reset.
  s = core.ops.updateTicket(s, id, { status: "in-progress" }, HUMAN);
  assert.ok(s.tickets[0].statusEnteredAt > 1000, "status patch resets statusEnteredAt");
});

test("SM-170: a test-execution re-opened via outcome flip (done→in-progress) also resets statusEnteredAt", () => {
  // Review nit: _syncExecStatusToOutcome set exec.status directly, bypassing
  // the aging clock. A re-opened exec card would show a stale age otherwise.
  const snap = core.normalizeSnapshot({
    project: { id: "p1", name: "P", ticketPrefix: "P" },
    tickets: [{ id: "e1", type: "test-execution", title: "Run", status: "done",
                outcomeOverride: "passed", statusEnteredAt: 1000 }]
  });
  assert.strictEqual(snap.tickets[0].status, "done");
  assert.strictEqual(snap.tickets[0].statusEnteredAt, 1000, "stable while done+passed");
  // Flip the outcome to pending → sync re-opens it to in-progress.
  const s2 = core.ops.updateTicket(snap, "e1", { outcomeOverride: "pending" }, HUMAN);
  assert.strictEqual(s2.tickets[0].status, "in-progress", "outcome flip re-opens the run");
  assert.ok(s2.tickets[0].statusEnteredAt > 1000, "the re-open must reset the aging clock");
});

test("SM-170: normalizeTicket on a legacy ticket (no statusEnteredAt) falls back to createdAt", () => {
  const snap = core.normalizeSnapshot({
    project: { id: "p1", name: "P", ticketPrefix: "P" },
    tickets: [{ id: "t1", type: "user-story", title: "Legacy", status: "in-progress", createdAt: 4242 }]
  });
  assert.strictEqual(snap.tickets[0].statusEnteredAt, 4242);
});

test("ops.softDeleteTicket sets isDeleted=true and deletedAt/By", () => {
  const s0 = freshSnapshot();
  const s1 = core.ops.createTicket(s0, { type: "bug", title: "X" }, HUMAN);
  const id = s1.tickets[0].id;
  const s2 = core.ops.softDeleteTicket(s1, id, HUMAN);
  const t = s2.tickets[0];
  assert.strictEqual(t.isDeleted, true);
  assert.deepStrictEqual(t.deletedBy, HUMAN);
  assert.ok(typeof t.deletedAt === "number");
});

test("ops.changeStatus updates status (no DoR/DoD checks here — that's validation.js)", () => {
  const s0 = freshSnapshot();
  const s1 = core.ops.createTicket(s0, { type: "user-story", title: "A" }, HUMAN);
  const id = s1.tickets[0].id;
  const s2 = core.ops.changeStatus(s1, id, "in-progress", HUMAN);
  assert.strictEqual(s2.tickets[0].status, "in-progress");
});

test("ops.moveTicket updates position", () => {
  const s0 = freshSnapshot();
  const s1 = core.ops.createTicket(s0, { type: "user-story", title: "A" }, HUMAN);
  const id = s1.tickets[0].id;
  const s2 = core.ops.moveTicket(s1, id, { releaseId: "r1", processStepId: "ps1", sortOrder: 5 }, HUMAN);
  assert.strictEqual(s2.tickets[0].position.releaseId, "r1");
  assert.strictEqual(s2.tickets[0].position.processStepId, "ps1");
  assert.strictEqual(s2.tickets[0].position.sortOrder, 5);
});

test("ops.addComment appends a comment with actor + timestamp", () => {
  const s0 = freshSnapshot();
  const s1 = core.ops.createTicket(s0, { type: "user-story", title: "A" }, HUMAN);
  const id = s1.tickets[0].id;
  const s2 = core.ops.addComment(s1, id, { body: "hello" }, AI);
  assert.strictEqual(s2.tickets[0].comments.length, 1);
  assert.strictEqual(s2.tickets[0].comments[0].body, "hello");
  assert.deepStrictEqual(s2.tickets[0].comments[0].actor, AI);
});

// ---------------------------------------------------------------------------
// ops — DoR/DoD item check/uncheck
// ---------------------------------------------------------------------------

test("ops.checkDorItem sets checked=true with actor + timestamp", () => {
  const s0 = freshSnapshot();
  const s1 = core.ops.createTicket(s0, { type: "user-story", title: "A" }, HUMAN);
  const id = s1.tickets[0].id;
  const s2 = core.ops.checkDorItem(s1, id, "g1", AI);
  const item = s2.tickets[0].definitionOfReady.items.find(i => i.id === "g1");
  assert.strictEqual(item.checked, true);
  assert.deepStrictEqual(item.checkedBy, AI);
  assert.ok(typeof item.checkedAt === "number");
});

test("ops.uncheckDorItem clears checked + timestamp", () => {
  const s0 = freshSnapshot();
  const s1 = core.ops.createTicket(s0, { type: "user-story", title: "A" }, HUMAN);
  const id = s1.tickets[0].id;
  const s2 = core.ops.checkDorItem(s1, id, "g1", HUMAN);
  const s3 = core.ops.uncheckDorItem(s2, id, "g1", HUMAN);
  const item = s3.tickets[0].definitionOfReady.items.find(i => i.id === "g1");
  assert.strictEqual(item.checked, false);
  assert.strictEqual(item.checkedAt, null);
  assert.strictEqual(item.checkedBy, null);
});

test("ops.checkDodItem / uncheckDodItem analogously", () => {
  const s0 = freshSnapshot();
  const s1 = core.ops.createTicket(s0, { type: "user-story", title: "A" }, HUMAN);
  const id = s1.tickets[0].id;
  const s2 = core.ops.checkDodItem(s1, id, "d1", AI);
  assert.strictEqual(s2.tickets[0].definitionOfDone.items.find(i => i.id === "d1").checked, true);
  const s3 = core.ops.uncheckDodItem(s2, id, "d1", AI);
  assert.strictEqual(s3.tickets[0].definitionOfDone.items.find(i => i.id === "d1").checked, false);
});

// ---------------------------------------------------------------------------
// ops — Releases / ProcessSteps
// ---------------------------------------------------------------------------

test("ops.createRelease appends a release with defaults", () => {
  const s0 = freshSnapshot();
  const s1 = core.ops.createRelease(s0, { name: "v1.0" }, HUMAN);
  assert.strictEqual(s1.releases.length, 1);
  assert.strictEqual(s1.releases[0].name, "v1.0");
  assert.strictEqual(s1.releases[0].status, "planning");
});

test("ops.updateRelease patches and bumps version", () => {
  const s0 = freshSnapshot();
  const s1 = core.ops.createRelease(s0, { name: "v1.0" }, HUMAN);
  const id = s1.releases[0].id;
  const s2 = core.ops.updateRelease(s1, id, { status: "active" }, HUMAN);
  assert.strictEqual(s2.releases[0].status, "active");
  assert.strictEqual(s2.releases[0].version, 2);
});

test("ops.reorderReleases respects given order", () => {
  let s = freshSnapshot();
  s = core.ops.createRelease(s, { name: "a" }, HUMAN);
  s = core.ops.createRelease(s, { name: "b" }, HUMAN);
  s = core.ops.createRelease(s, { name: "c" }, HUMAN);
  const ids = s.releases.map(r => r.id);
  const reordered = [ids[2], ids[0], ids[1]];
  const s2 = core.ops.reorderReleases(s, reordered, HUMAN);
  assert.deepStrictEqual(s2.releases.map(r => r.id), reordered);
  assert.deepStrictEqual(s2.releases.map(r => r.sortOrder), [0, 1, 2]);
});

test("ops.createProcessStep appends with epicId support", () => {
  const s0 = freshSnapshot();
  const s1 = core.ops.createProcessStep(s0, { name: "Onboarding", epicId: "t-foo" }, HUMAN);
  assert.strictEqual(s1.processSteps.length, 1);
  assert.strictEqual(s1.processSteps[0].epicId, "t-foo");
});

// ---------------------------------------------------------------------------
// diffSnapshots
// ---------------------------------------------------------------------------

test("diffSnapshots: identical → empty diff", () => {
  const s = freshSnapshot();
  const d = core.diffSnapshots(s, s);
  assert.deepStrictEqual(d.tickets, { added: [], updated: [], removed: [] });
  assert.deepStrictEqual(d.releases, { added: [], updated: [], removed: [] });
  assert.deepStrictEqual(d.processSteps, { added: [], updated: [], removed: [] });
});

test("diffSnapshots: one added ticket", () => {
  const s0 = freshSnapshot();
  const s1 = core.ops.createTicket(s0, { type: "user-story", title: "A" }, HUMAN);
  const d = core.diffSnapshots(s0, s1);
  assert.strictEqual(d.tickets.added.length, 1);
  assert.strictEqual(d.tickets.updated.length, 0);
  assert.strictEqual(d.tickets.removed.length, 0);
});

test("diffSnapshots: one updated ticket", () => {
  const s0 = freshSnapshot();
  const s1 = core.ops.createTicket(s0, { type: "user-story", title: "A" }, HUMAN);
  const s2 = core.ops.updateTicket(s1, s1.tickets[0].id, { title: "A renamed" }, HUMAN);
  const d = core.diffSnapshots(s1, s2);
  assert.strictEqual(d.tickets.added.length, 0);
  assert.strictEqual(d.tickets.updated.length, 1);
  assert.strictEqual(d.tickets.removed.length, 0);
});

test("diffSnapshots: one removed ticket", () => {
  const s0 = freshSnapshot();
  const s1 = core.ops.createTicket(s0, { type: "user-story", title: "A" }, HUMAN);
  const s2 = Object.assign({}, s1, { tickets: [] });
  const d = core.diffSnapshots(s1, s2);
  assert.strictEqual(d.tickets.removed.length, 1);
});

// ---------------------------------------------------------------------------
// E9b — Backlog-IDs, Auto-Epic-Assignment, Tickets-Helpers
// ---------------------------------------------------------------------------

test("EPIC_BACKLOG_ID and STORY_BACKLOG_ID constants exported", () => {
  assert.strictEqual(typeof core.EPIC_BACKLOG_ID, "string");
  assert.strictEqual(typeof core.STORY_BACKLOG_ID, "string");
  assert.notStrictEqual(core.EPIC_BACKLOG_ID, core.STORY_BACKLOG_ID);
});

test("tickets.partiallyAssignedByRelease: groups release-bound but unplaced tickets per release", () => {
  let s = freshSnapshot();
  s = core.ops.createRelease(s, { name: "v1.0" }, HUMAN);
  s = core.ops.createRelease(s, { name: "v1.1" }, HUMAN);
  const r1 = s.releases[0].id, r2 = s.releases[1].id;
  s = core.ops.createProcessStep(s, { name: "Onboarding" }, HUMAN);
  const psid = s.processSteps[0].id;
  // Epic fully placed → NOT in result
  s = core.ops.createTicket(s, { type: "epic", title: "Placed", position: { releaseId: r1, processStepId: psid } }, HUMAN);
  // Epic only with release → partial under r1
  s = core.ops.createTicket(s, { type: "epic", title: "EpicPartial", position: { releaseId: r1 } }, HUMAN);
  // Story under r1, no epic → partial
  s = core.ops.createTicket(s, { type: "user-story", title: "StoryPartial r1", position: { releaseId: r1 } }, HUMAN);
  // Story under r2, no epic → partial
  s = core.ops.createTicket(s, { type: "user-story", title: "StoryPartial r2", position: { releaseId: r2 } }, HUMAN);
  // Backlog story (no release) → NOT in result
  s = core.ops.createTicket(s, { type: "user-story", title: "Orphan" }, HUMAN);

  const out = core.tickets.partiallyAssignedByRelease(s);
  assert.ok(out instanceof Map);
  assert.strictEqual(out.size, 2);
  const g1 = out.get(r1);
  assert.strictEqual(g1.epics.length, 1);
  assert.strictEqual(g1.epics[0].title, "EpicPartial");
  assert.strictEqual(g1.stories.length, 1);
  assert.strictEqual(g1.stories[0].title, "StoryPartial r1");
  const g2 = out.get(r2);
  assert.strictEqual(g2.epics.length, 0);
  assert.strictEqual(g2.stories.length, 1);
  assert.strictEqual(g2.stories[0].title, "StoryPartial r2");
});

test("tickets.backlogEpics: epics without releaseId", () => {
  let s = freshSnapshot();
  s = core.ops.createRelease(s, { name: "v1.0" }, HUMAN);
  const rid = s.releases[0].id;
  s = core.ops.createTicket(s, { type: "epic", title: "InRel", position: { releaseId: rid } }, HUMAN);
  s = core.ops.createTicket(s, { type: "epic", title: "Backlog1" }, HUMAN);
  s = core.ops.createTicket(s, { type: "epic", title: "Backlog2" }, HUMAN);
  // soft-deleted backlog epic must not appear
  s = core.ops.createTicket(s, { type: "epic", title: "Trashed" }, HUMAN);
  s = core.ops.softDeleteTicket(s, s.tickets[s.tickets.length - 1].id, HUMAN);
  const list = core.tickets.backlogEpics(s);
  assert.strictEqual(list.length, 2);
  assert.deepStrictEqual(list.map(t => t.title).sort(), ["Backlog1", "Backlog2"]);
});

test("tickets.epicsInCell: returns epics in (releaseId, processStepId) cell", () => {
  let s = freshSnapshot();
  s = core.ops.createRelease(s, { name: "v1.0" }, HUMAN);
  const rid = s.releases[0].id;
  s = core.ops.createProcessStep(s, { name: "PS1" }, HUMAN);
  const ps1 = s.processSteps[0].id;
  s = core.ops.createProcessStep(s, { name: "PS2" }, HUMAN);
  const ps2 = s.processSteps[1].id;
  s = core.ops.createTicket(s, { type: "epic", title: "E1", position: { releaseId: rid, processStepId: ps1 } }, HUMAN);
  s = core.ops.createTicket(s, { type: "epic", title: "E2", position: { releaseId: rid, processStepId: ps1 } }, HUMAN);
  s = core.ops.createTicket(s, { type: "epic", title: "E3", position: { releaseId: rid, processStepId: ps2 } }, HUMAN);
  // story in same cell — must NOT be in epicsInCell
  s = core.ops.createTicket(s, { type: "user-story", title: "Story", position: { releaseId: rid, processStepId: ps1 } }, HUMAN);

  const cell1 = core.tickets.epicsInCell(s, rid, ps1);
  assert.strictEqual(cell1.length, 2);
  assert.deepStrictEqual(cell1.map(e => e.title).sort(), ["E1", "E2"]);
  const cell2 = core.tickets.epicsInCell(s, rid, ps2);
  assert.strictEqual(cell2.length, 1);
});

test("tickets.storiesInEpic: returns non-epic tickets with position.epicId", () => {
  let s = freshSnapshot();
  s = core.ops.createTicket(s, { type: "epic", title: "E" }, HUMAN);
  const epicId = s.tickets[0].id;
  s = core.ops.createTicket(s, { type: "user-story", title: "S1", position: { epicId } }, HUMAN);
  s = core.ops.createTicket(s, { type: "bug", title: "B1", position: { epicId } }, HUMAN);
  s = core.ops.createTicket(s, { type: "user-story", title: "Orphan" }, HUMAN);
  const list = core.tickets.storiesInEpic(s, epicId);
  assert.strictEqual(list.length, 2);
  assert.deepStrictEqual(list.map(t => t.title).sort(), ["B1", "S1"]);
});

// ---- Auto-Epic-Assignment in ops.createTicket --------------------------

test("ops.createTicket — Story in a cell with exactly ONE epic auto-assigns to that epic (SM-52: via contains-link)", () => {
  let s = freshSnapshot();
  s = core.ops.createRelease(s, { name: "v1.0" }, HUMAN);
  const rid = s.releases[0].id;
  s = core.ops.createProcessStep(s, { name: "PS1" }, HUMAN);
  const psid = s.processSteps[0].id;
  s = core.ops.createTicket(s, { type: "epic", title: "Only-Epic", position: { releaseId: rid, processStepId: psid } }, HUMAN);
  const epicId = s.tickets[0].id;
  // Now create a Story in same cell — should auto-assign via contains-link.
  s = core.ops.createTicket(s, { type: "user-story", title: "Auto-Story", position: { releaseId: rid, processStepId: psid } }, HUMAN);
  const story = s.tickets.find(t => t.title === "Auto-Story");
  // SM-52: containment is a contains-link from epic, NOT position.epicId.
  assert.strictEqual(story.position.epicId, null, "position.epicId is never persisted after SM-52");
  const stories = core.tickets.storiesInEpic(s, epicId).map(t => t.id);
  assert.ok(stories.indexOf(story.id) >= 0, "story is contained by the epic via link");
});

test("SM-77-followup: containerEpicIdOf returns the epic-id via contains-link, null otherwise", () => {
  let s = freshSnapshot();
  s = core.ops.createRelease(s, { name: "v1.0" }, HUMAN);
  const rid = s.releases[0].id;
  s = core.ops.createProcessStep(s, { name: "PS1" }, HUMAN);
  const psid = s.processSteps[0].id;
  s = core.ops.createTicket(s, { type: "epic", title: "E", position: { releaseId: rid, processStepId: psid } }, HUMAN);
  const epicId = s.tickets.find(t => t.title === "E").id;
  s = core.ops.createTicket(s, { type: "user-story", title: "Contained",
    position: { releaseId: rid, processStepId: psid } }, HUMAN);
  const storyId = s.tickets.find(t => t.title === "Contained").id;
  // Auto-assignment via single-epic-in-cell → story is contained.
  assert.strictEqual(core.containerEpicIdOf(s, storyId), epicId);
  // A standalone orphan ticket has no container.
  s = core.ops.createTicket(s, { type: "user-story", title: "Orphan" }, HUMAN);
  const orphanId = s.tickets.find(t => t.title === "Orphan").id;
  assert.strictEqual(core.containerEpicIdOf(s, orphanId), null);
});

test("SM-77-followup: containerEpicIdOf returns null for an unknown ticket id or empty snapshot", () => {
  const s = freshSnapshot();
  assert.strictEqual(core.containerEpicIdOf(s, "t-nope"), null);
  assert.strictEqual(core.containerEpicIdOf(null, "t-nope"), null);
  assert.strictEqual(core.containerEpicIdOf(s, null), null);
});

test("ops.createTicket — Story in cell with 0 epics: no contains-link assigned", () => {
  let s = freshSnapshot();
  s = core.ops.createRelease(s, { name: "v1.0" }, HUMAN);
  const rid = s.releases[0].id;
  s = core.ops.createProcessStep(s, { name: "PS1" }, HUMAN);
  const psid = s.processSteps[0].id;
  // No epic in this cell.
  s = core.ops.createTicket(s, { type: "user-story", title: "No-Auto", position: { releaseId: rid, processStepId: psid } }, HUMAN);
  const story = s.tickets[0];
  assert.strictEqual(story.position.epicId, null);
  assert.strictEqual(core.tickets.epicForStory(s, story.id), null, "no container epic");
});

test("ops.createTicket — Story in cell with 2+ epics: no auto-assignment (ambiguous)", () => {
  let s = freshSnapshot();
  s = core.ops.createRelease(s, { name: "v1.0" }, HUMAN);
  const rid = s.releases[0].id;
  s = core.ops.createProcessStep(s, { name: "PS1" }, HUMAN);
  const psid = s.processSteps[0].id;
  s = core.ops.createTicket(s, { type: "epic", title: "E1", position: { releaseId: rid, processStepId: psid } }, HUMAN);
  s = core.ops.createTicket(s, { type: "epic", title: "E2", position: { releaseId: rid, processStepId: psid } }, HUMAN);
  s = core.ops.createTicket(s, { type: "user-story", title: "Story", position: { releaseId: rid, processStepId: psid } }, HUMAN);
  const story = s.tickets.find(t => t.title === "Story");
  assert.strictEqual(story.position.epicId, null);
  assert.strictEqual(core.tickets.epicForStory(s, story.id), null, "ambiguous → no container assignment");
});

test("ops.createTicket — Epic itself never gets auto-assignment of epicId", () => {
  let s = freshSnapshot();
  s = core.ops.createRelease(s, { name: "v1.0" }, HUMAN);
  const rid = s.releases[0].id;
  s = core.ops.createProcessStep(s, { name: "PS1" }, HUMAN);
  const psid = s.processSteps[0].id;
  s = core.ops.createTicket(s, { type: "epic", title: "First Epic", position: { releaseId: rid, processStepId: psid } }, HUMAN);
  s = core.ops.createTicket(s, { type: "epic", title: "Second Epic", position: { releaseId: rid, processStepId: psid } }, HUMAN);
  for (const t of s.tickets) {
    assert.strictEqual(t.position.epicId, null, t.title + " should not have an epicId");
  }
});

test("ops.createTicket — explicit epicId in patch overrides auto-assignment", () => {
  let s = freshSnapshot();
  s = core.ops.createRelease(s, { name: "v1.0" }, HUMAN);
  const rid = s.releases[0].id;
  s = core.ops.createProcessStep(s, { name: "PS1" }, HUMAN);
  const psid = s.processSteps[0].id;
  s = core.ops.createTicket(s, { type: "epic", title: "Auto-target", position: { releaseId: rid, processStepId: psid } }, HUMAN);
  const autoEpicId = s.tickets[0].id;
  // Create a second epic in a different cell so it's eligible as explicit choice.
  s = core.ops.createProcessStep(s, { name: "PS2" }, HUMAN);
  const ps2 = s.processSteps[1].id;
  s = core.ops.createTicket(s, { type: "epic", title: "Other epic", position: { releaseId: rid, processStepId: ps2 } }, HUMAN);
  const otherEpicId = s.tickets[1].id;
  // Story explicitly bound to otherEpicId — auto-assignment must not override.
  s = core.ops.createTicket(s, { type: "user-story", title: "Pinned", position: { releaseId: rid, processStepId: psid, epicId: otherEpicId } }, HUMAN);
  const story = s.tickets.find(t => t.title === "Pinned");
  // SM-52: position.epicId is never persisted; the link is the source of truth.
  assert.strictEqual(story.position.epicId, null);
  const container = core.tickets.epicForStory(s, story.id);
  assert.ok(container, "story has a container epic");
  assert.strictEqual(container.id, otherEpicId, "explicit choice wins over auto-assignment");
  assert.notStrictEqual(container.id, autoEpicId);
});

// ---------------------------------------------------------------------------
// E9l — Loose tickets in cell + partiallyAssigned excludes cell-resident loose
// ---------------------------------------------------------------------------

test("ops.createTicket — Orphan tickets get auto-sortOrder = max(orphans) + 1 (lands at end of backlog)", () => {
  let s = freshSnapshot();
  // Three orphan tickets created in sequence. Each should get sortOrder one
  // higher than the previous so the new one always lands at the end.
  s = core.ops.createTicket(s, { type: "user-story", title: "first" },  HUMAN);
  s = core.ops.createTicket(s, { type: "user-story", title: "second" }, HUMAN);
  s = core.ops.createTicket(s, { type: "user-story", title: "third" },  HUMAN);
  const orphans = core.tickets.orphanStories(s);
  assert.deepStrictEqual(orphans.map(t => t.title), ["first", "second", "third"]);
  assert.strictEqual(orphans[0].position.sortOrder, 0);
  assert.strictEqual(orphans[1].position.sortOrder, 1);
  assert.strictEqual(orphans[2].position.sortOrder, 2);
});

test("ops.createTicket — Orphan added AFTER higher-sortOrder orphans (e.g. after Kanban reorder) lands at end", () => {
  let s = freshSnapshot();
  // Simulate state after a Kanban-reorder that gave orphans high sortOrders.
  s = core.ops.createTicket(s, { type: "user-story", title: "old A", position: { sortOrder: 5 } }, HUMAN);
  s = core.ops.createTicket(s, { type: "user-story", title: "old B", position: { sortOrder: 8 } }, HUMAN);
  // New orphan from the toolbar → no position → should land at sortOrder=9.
  s = core.ops.createTicket(s, { type: "user-story", title: "new" }, HUMAN);
  const newTicket = s.tickets.find(t => t.title === "new");
  assert.strictEqual(newTicket.position.sortOrder, 9, "new orphan must land at end of backlog (max+1)");
});

test("tickets.looseTicketsInCell: non-epic tickets in (rel, ps) without epicId", () => {
  let s = freshSnapshot();
  s = core.ops.createRelease(s, { name: "v1.0" }, HUMAN);
  const rid = s.releases[0].id;
  s = core.ops.createProcessStep(s, { name: "PS1" }, HUMAN);
  const psid = s.processSteps[0].id;
  // Two epics → ambiguous auto-epic, the next non-epic stays loose.
  s = core.ops.createTicket(s, { type: "epic", title: "E1", position: { releaseId: rid, processStepId: psid } }, HUMAN);
  s = core.ops.createTicket(s, { type: "epic", title: "E2", position: { releaseId: rid, processStepId: psid } }, HUMAN);
  s = core.ops.createTicket(s, { type: "bug",  title: "B1", position: { releaseId: rid, processStepId: psid } }, HUMAN);
  // Story explicitly under an epic → NOT loose
  const e1 = s.tickets.find(t => t.title === "E1").id;
  s = core.ops.createTicket(s, { type: "user-story", title: "S1", position: { releaseId: rid, processStepId: psid, epicId: e1 } }, HUMAN);
  const loose = core.tickets.looseTicketsInCell(s, rid, psid);
  assert.strictEqual(loose.length, 1);
  assert.strictEqual(loose[0].title, "B1");
});

test("tickets.partiallyAssignedByRelease excludes loose tickets that have a processStepId", () => {
  let s = freshSnapshot();
  s = core.ops.createRelease(s, { name: "v1.0" }, HUMAN);
  const rid = s.releases[0].id;
  s = core.ops.createProcessStep(s, { name: "PS1" }, HUMAN);
  const psid = s.processSteps[0].id;
  // Two epics → auto-epic ambiguous, "Cellbound" loose ticket stays in cell.
  s = core.ops.createTicket(s, { type: "epic", title: "E1", position: { releaseId: rid, processStepId: psid } }, HUMAN);
  s = core.ops.createTicket(s, { type: "epic", title: "E2", position: { releaseId: rid, processStepId: psid } }, HUMAN);
  s = core.ops.createTicket(s, { type: "bug", title: "Cellbound", position: { releaseId: rid, processStepId: psid } }, HUMAN);
  // Pure release-only loose ticket → still in partially-assigned.
  s = core.ops.createTicket(s, { type: "bug", title: "ReleaseOnly", position: { releaseId: rid } }, HUMAN);
  const out = core.tickets.partiallyAssignedByRelease(s);
  const grp = out.get(rid);
  const titles = grp.stories.map(t => t.title);
  assert.ok(titles.includes("ReleaseOnly"));
  assert.ok(!titles.includes("Cellbound"), "Cellbound has processStepId → belongs to cell, not backlog");
});

// ---------------------------------------------------------------------------
// E18.B — updateProject op (header-only mutation for store-zentrierte
//          Persistenz; locked fields: id, ticketPrefix, ticketCounter)
// ---------------------------------------------------------------------------

test("ops.updateProject patches allowed fields and bumps audit", () => {
  const HUMAN = { type: "human", id: "u1", name: "U" };
  let snap = core.normalizeSnapshot({ project: { id: "p1", name: "Old", ticketPrefix: "P" } });
  const beforeVersion = snap.project.version;
  snap = core.ops.updateProject(snap, { name: "New", description: "Hello" }, HUMAN);
  assert.strictEqual(snap.project.name, "New");
  assert.strictEqual(snap.project.description, "Hello");
  assert.strictEqual(snap.project.version, beforeVersion + 1);
});

test("ops.updateProject IGNORES locked fields (id/ticketPrefix/ticketCounter)", () => {
  const HUMAN = { type: "human", id: "u1", name: "U" };
  let snap = core.normalizeSnapshot({ project: { id: "p1", name: "P", ticketPrefix: "P", ticketCounter: 5 } });
  snap = core.ops.updateProject(snap,
    { id: "evil", ticketPrefix: "X", ticketCounter: 0, name: "Renamed" }, HUMAN);
  assert.strictEqual(snap.project.id, "p1", "id is locked");
  assert.strictEqual(snap.project.ticketPrefix, "P", "ticketPrefix is locked");
  assert.strictEqual(snap.project.ticketCounter, 5, "ticketCounter is locked");
  assert.strictEqual(snap.project.name, "Renamed", "allowed field went through");
});

test("ops.updateProject can set definitions and workflow", () => {
  const HUMAN = { type: "human", id: "u1", name: "U" };
  let snap = core.normalizeSnapshot({ project: { id: "p1", name: "P" } });
  const newDefs = { ready: { global: [{ id: "x", label: "X", required: true }], byType: {} }, done: { global: [], byType: {} } };
  snap = core.ops.updateProject(snap, { definitions: newDefs }, HUMAN);
  assert.strictEqual(snap.project.definitions.ready.global.length, 1);
  assert.strictEqual(snap.project.definitions.ready.global[0].id, "x");
});

// ---------------------------------------------------------------------------
// SM-44 — typed ticket links: normalizeLink, addLink, removeLink, setLinks,
// validation (self/dup/cycle), stale-target cleanup in normalizeSnapshot.
// ---------------------------------------------------------------------------

function setupTwoTickets() {
  const HUMAN = { type: "human", id: "u1", name: "U" };
  let snap = core.normalizeSnapshot({ project: { id: "p1", name: "P" } });
  snap = core.ops.createTicket(snap, { type: "user-story", title: "A" }, HUMAN);
  snap = core.ops.createTicket(snap, { type: "user-story", title: "B" }, HUMAN);
  const A = snap.tickets.find(t => t.title === "A").id;
  const B = snap.tickets.find(t => t.title === "B").id;
  return { snap, A, B, HUMAN };
}

test("SM-44: normalizeLink keeps linkTypeId and label, migrates legacy `type`", () => {
  const fresh = core.normalizeLink({ linkTypeId: "blocks", targetTicketId: "t2", label: "Blocked by deploy" });
  assert.strictEqual(fresh.linkTypeId, "blocks");
  assert.strictEqual(fresh.targetTicketId, "t2");
  assert.strictEqual(fresh.label, "Blocked by deploy");
  // Legacy data with `type` migrates to linkTypeId.
  const legacy = core.normalizeLink({ type: "follows-on", targetTicketId: "t9" });
  assert.strictEqual(legacy.linkTypeId, "follows-on");
});

test("SM-44: addLink appends a link with default linkTypeId 'relates-to' when unset", () => {
  const { snap, A, B, HUMAN } = setupTwoTickets();
  const next = core.ops.addLink(snap, A, { targetTicketId: B }, HUMAN);
  const a = next.tickets.find(t => t.id === A);
  assert.strictEqual(a.links.length, 1);
  assert.strictEqual(a.links[0].linkTypeId, "relates-to");
  assert.strictEqual(a.links[0].targetTicketId, B);
});

test("SM-44: addLink rejects self-link with kind=LINK_SELF", () => {
  const { snap, A, HUMAN } = setupTwoTickets();
  let caught = null;
  try { core.ops.addLink(snap, A, { linkTypeId: "blocks", targetTicketId: A }, HUMAN); }
  catch (e) { caught = e; }
  assert.ok(caught, "expected throw");
  assert.strictEqual(caught.kind, "LINK_SELF");
  assert.strictEqual(caught.statusCode, 400);
});

test("SM-44: addLink rejects missing target with kind=LINK_TARGET_MISSING", () => {
  const { snap, A, HUMAN } = setupTwoTickets();
  let caught = null;
  try { core.ops.addLink(snap, A, { linkTypeId: "relates-to", targetTicketId: "t-nonexistent" }, HUMAN); }
  catch (e) { caught = e; }
  assert.ok(caught);
  assert.strictEqual(caught.kind, "LINK_TARGET_MISSING");
});

test("SM-44: addLink rejects duplicate (same linkTypeId + target) with kind=LINK_DUPLICATE", () => {
  const { snap, A, B, HUMAN } = setupTwoTickets();
  const one = core.ops.addLink(snap, A, { linkTypeId: "blocks", targetTicketId: B }, HUMAN);
  let caught = null;
  try { core.ops.addLink(one, A, { linkTypeId: "blocks", targetTicketId: B }, HUMAN); }
  catch (e) { caught = e; }
  assert.ok(caught);
  assert.strictEqual(caught.kind, "LINK_DUPLICATE");
});

test("SM-44: cycle-check — A blocks B, then B blocks A throws LINK_CYCLE", () => {
  const { snap, A, B, HUMAN } = setupTwoTickets();
  const one = core.ops.addLink(snap, A, { linkTypeId: "blocks", targetTicketId: B }, HUMAN);
  let caught = null;
  try { core.ops.addLink(one, B, { linkTypeId: "blocks", targetTicketId: A }, HUMAN); }
  catch (e) { caught = e; }
  assert.ok(caught, "expected cycle throw");
  assert.strictEqual(caught.kind, "LINK_CYCLE");
});

test("SM-44: cycle-check is per-linkTypeId — A blocks B does not block A predecessor-of B", () => {
  const { snap, A, B, HUMAN } = setupTwoTickets();
  let next = core.ops.addLink(snap, A, { linkTypeId: "blocks", targetTicketId: B }, HUMAN);
  // 'predecessor-of' is independent of 'blocks' — should NOT cycle-check across.
  next = core.ops.addLink(next, B, { linkTypeId: "predecessor-of", targetTicketId: A }, HUMAN);
  assert.ok(next, "different linkTypeId means no cycle in the same-type subgraph");
});

test("SM-44: cycle-check skipped for non-directional types (relates-to)", () => {
  const { snap, A, B, HUMAN } = setupTwoTickets();
  const one = core.ops.addLink(snap, A, { linkTypeId: "relates-to", targetTicketId: B }, HUMAN);
  // Reverse "relates-to" is fine — symmetric semantic.
  const two = core.ops.addLink(one, B, { linkTypeId: "relates-to", targetTicketId: A }, HUMAN);
  assert.strictEqual(two.tickets.find(t => t.id === B).links.length, 1);
});

test("SM-180: default link-types seed supersedes/replaces/refines/realises with the right semantics", () => {
  const p = core.normalizeProject({ id: "p1", name: "P" });
  const byId = Object.fromEntries(p.linkTypes.map(lt => [lt.id, lt]));
  assert.strictEqual(byId["supersedes"].semantic, "supersession");
  assert.strictEqual(byId["replaces"].semantic, "supersession");
  assert.ok(byId["refines"], "refines present");
  assert.ok(byId["realises"], "realises present");
  assert.strictEqual(byId["refines"].cycleCheck, true);   // hierarchy, no loops
});

test("SM-180: supersession is cycle-checked — A supersedes B, then B supersedes A throws LINK_CYCLE", () => {
  const { snap, A, B, HUMAN } = setupTwoTickets();
  const one = core.ops.addLink(snap, A, { linkTypeId: "supersedes", targetTicketId: B }, HUMAN);
  let caught = null;
  try { core.ops.addLink(one, B, { linkTypeId: "supersedes", targetTicketId: A }, HUMAN); }
  catch (e) { caught = e; }
  assert.ok(caught, "expected cycle throw");
  assert.strictEqual(caught.kind, "LINK_CYCLE");
});

test("SM-44: removeLink drops the named link, bumps audit", () => {
  const { snap, A, B, HUMAN } = setupTwoTickets();
  const one = core.ops.addLink(snap, A, { linkTypeId: "relates-to", targetTicketId: B }, HUMAN);
  const linkId = one.tickets.find(t => t.id === A).links[0].id;
  const versionBefore = one.tickets.find(t => t.id === A).version;
  const two = core.ops.removeLink(one, A, linkId, HUMAN);
  assert.strictEqual(two.tickets.find(t => t.id === A).links.length, 0);
  assert.ok(two.tickets.find(t => t.id === A).version > versionBefore, "audit bumped");
});

test("SM-44: setLinks bulk-replaces and validates the WHOLE list (incl. internal duplicates)", () => {
  const { snap, A, B, HUMAN } = setupTwoTickets();
  // Valid bulk-set.
  const valid = core.ops.setLinks(snap, A, [
    { linkTypeId: "blocks", targetTicketId: B },
    { linkTypeId: "relates-to", targetTicketId: B }
  ], HUMAN);
  assert.strictEqual(valid.tickets.find(t => t.id === A).links.length, 2);
  // Internal duplicate must throw.
  let caught = null;
  try {
    core.ops.setLinks(snap, A, [
      { linkTypeId: "blocks", targetTicketId: B },
      { linkTypeId: "blocks", targetTicketId: B }   // duplicate
    ], HUMAN);
  } catch (e) { caught = e; }
  assert.ok(caught);
  assert.strictEqual(caught.kind, "LINK_DUPLICATE");
});

// ---------------------------------------------------------------------------
// SM-45 — project.linkTypes config + semantic-driven cycle-check
// ---------------------------------------------------------------------------

test("SM-45 (+SM-56, +SM-54-followup, +SM-94): normalizeProject seeds the default link-types incl. 'executes', 'tests', 'modifies'", () => {
  const snap = core.normalizeSnapshot({ project: { id: "p1", name: "P" } });
  const ids = snap.project.linkTypes.map(lt => lt.id);
  assert.deepStrictEqual(ids, ["predecessor-of", "blocks", "follows-on", "contains", "relates-to", "executes", "tests", "modifies", "supersedes", "replaces", "refines", "realises"]);
  // SM-94: 'modifies' carries cycleCheck:true explicitly.
  const modifies = snap.project.linkTypes.find(lt => lt.id === "modifies");
  assert.strictEqual(modifies.cycleCheck, true);
  // Each entry has all required fields.
  for (const lt of snap.project.linkTypes) {
    assert.ok(typeof lt.label === "string" && lt.label.length > 0);
    assert.ok(typeof lt.inverseLabel === "string" && lt.inverseLabel.length > 0);
    assert.ok(core.LINK_SEMANTICS.indexOf(lt.semantic) >= 0);
  }
});

test("SM-45 + SM-52: custom linkTypes REPLACES defaults but `contains` is re-injected (system-required)", () => {
  const snap = core.normalizeSnapshot({
    project: {
      id: "p1", name: "P",
      linkTypes: [
        { id: "duplicates", label: "Duplicates", inverseLabel: "Duplicated by", semantic: "freeform" }
      ]
    }
  });
  // SM-52: `contains` must always exist so epic→story containment works.
  const ids = snap.project.linkTypes.map(lt => lt.id).sort();
  assert.deepStrictEqual(ids, ["contains", "duplicates"]);
});

test("SM-45: normalizeLinkType drops unknown semantic to 'freeform'", () => {
  const lt = core.normalizeLinkType({ id: "weird", label: "Weird", semantic: "not-a-real-semantic" });
  assert.strictEqual(lt.semantic, "freeform");
});

test("SM-45: normalizeLinkType requires id + label (synthesises if missing)", () => {
  const lt = core.normalizeLinkType({});
  assert.ok(lt.id, "id present");
  assert.ok(lt.label, "label present");
  assert.ok(lt.inverseLabel, "inverseLabel present (synthesised from label/id when missing)");
});

test("SM-45: validateLink cycle-check uses project linkType.semantic over hardcoded ID list", () => {
  const HUMAN = { type: "human", id: "u", name: "U" };
  // Custom project with 'predecessor-of' semantic switched to freeform —
  // cycle check must NOT fire for that ID anymore, because the project
  // explicitly opted-out by reassigning the semantic.
  let snap = core.normalizeSnapshot({
    project: {
      id: "p1", name: "P",
      linkTypes: [
        { id: "predecessor-of", label: "Pred-of-freeform", inverseLabel: "Inv", semantic: "freeform" }
      ]
    }
  });
  snap = core.ops.createTicket(snap, { type: "user-story", title: "A" }, HUMAN);
  snap = core.ops.createTicket(snap, { type: "user-story", title: "B" }, HUMAN);
  const A = snap.tickets.find(t => t.title === "A").id;
  const B = snap.tickets.find(t => t.title === "B").id;
  snap = core.ops.addLink(snap, A, { linkTypeId: "predecessor-of", targetTicketId: B }, HUMAN);
  // Reverse — would be a cycle under hardcoded list, but the project
  // mapped this ID to 'freeform' so cycle-check is skipped.
  snap = core.ops.addLink(snap, B, { linkTypeId: "predecessor-of", targetTicketId: A }, HUMAN);
  assert.strictEqual(snap.tickets.find(t => t.id === B).links.length, 1);
});

test("SM-45 + SM-52: ops.updateProject allows patching linkTypes (contains stays system-required)", () => {
  const HUMAN = { type: "human", id: "u", name: "U" };
  let snap = core.normalizeSnapshot({ project: { id: "p1", name: "P" } });
  snap = core.ops.updateProject(snap, {
    linkTypes: [
      { id: "tests", label: "Tests", inverseLabel: "Tested by", semantic: "validation" }
    ]
  }, HUMAN);
  const ids = snap.project.linkTypes.map(lt => lt.id).sort();
  assert.deepStrictEqual(ids, ["contains", "tests"]);
});

test("SM-44: normalizeSnapshot drops links whose targetTicketId no longer exists", () => {
  const HUMAN = { type: "human", id: "u1", name: "U" };
  // Hand-craft a snapshot with a stale link reference.
  const raw = {
    project: { id: "p1", name: "P" },
    tickets: [
      { id: "t-A", type: "user-story", title: "A",
        links: [
          { id: "ln-1", linkTypeId: "relates-to", targetTicketId: "t-B" },
          { id: "ln-2", linkTypeId: "blocks",     targetTicketId: "t-gone" }   // stale
        ]
      },
      { id: "t-B", type: "user-story", title: "B" }
    ]
  };
  const snap = core.normalizeSnapshot(raw);
  const A = snap.tickets.find(t => t.id === "t-A");
  assert.strictEqual(A.links.length, 1, "stale link to t-gone dropped");
  assert.strictEqual(A.links[0].targetTicketId, "t-B");
});

// ---------------------------------------------------------------------------
// SM-78 — normalizeSnapshot prunes stale position.processStepId / releaseId
// ---------------------------------------------------------------------------

test("SM-78: stale processStepId is nulled (PS missing from snapshot)", () => {
  const raw = {
    project: { id: "p1", name: "P" },
    tickets: [
      { id: "t-A", type: "user-story", title: "A",
        position: { releaseId: null, processStepId: "ps-gone", epicId: null, sortOrder: 0 } }
    ],
    releases: [],
    processSteps: []   // ps-gone never existed
  };
  const snap = core.normalizeSnapshot(raw);
  assert.strictEqual(snap.tickets[0].position.processStepId, null,
    "stale processStepId cleared → ticket lands in Backlog");
});

test("SM-78: stale releaseId is nulled (Release missing from snapshot)", () => {
  const raw = {
    project: { id: "p1", name: "P" },
    tickets: [
      { id: "t-A", type: "user-story", title: "A",
        position: { releaseId: "r-gone", processStepId: null, epicId: null, sortOrder: 0 } }
    ],
    releases: [],   // r-gone never existed
    processSteps: []
  };
  const snap = core.normalizeSnapshot(raw);
  assert.strictEqual(snap.tickets[0].position.releaseId, null);
});

test("SM-78: both stale → both cleared, ticket effectively in Backlog", () => {
  const raw = {
    project: { id: "p1", name: "P" },
    tickets: [
      { id: "t-A", type: "user-story", title: "A",
        position: { releaseId: "r-gone", processStepId: "ps-gone", epicId: null, sortOrder: 5 } }
    ],
    releases: [], processSteps: []
  };
  const snap = core.normalizeSnapshot(raw);
  assert.strictEqual(snap.tickets[0].position.releaseId, null);
  assert.strictEqual(snap.tickets[0].position.processStepId, null);
  // sortOrder is preserved — only the container refs are cleared.
  assert.strictEqual(snap.tickets[0].position.sortOrder, 5);
});

test("SM-78: soft-deleted Release / ProcessStep also count as stale", () => {
  const raw = {
    project: { id: "p1", name: "P" },
    tickets: [
      { id: "t-A", type: "user-story", title: "A",
        position: { releaseId: "r-1", processStepId: "ps-1", epicId: null, sortOrder: 0 } }
    ],
    releases: [{ id: "r-1", name: "v1", isDeleted: true }],
    processSteps: [{ id: "ps-1", name: "Build", isDeleted: true }]
  };
  const snap = core.normalizeSnapshot(raw);
  assert.strictEqual(snap.tickets[0].position.releaseId, null,
    "soft-deleted release treated as stale (UX: stuck-ticket > silent disappearance)");
  assert.strictEqual(snap.tickets[0].position.processStepId, null);
});

test("SM-78: valid (live) references are preserved", () => {
  const raw = {
    project: { id: "p1", name: "P" },
    tickets: [
      { id: "t-A", type: "user-story", title: "A",
        position: { releaseId: "r-1", processStepId: "ps-1", epicId: null, sortOrder: 0 } }
    ],
    releases: [{ id: "r-1", name: "v1" }],
    processSteps: [{ id: "ps-1", name: "Build" }]
  };
  const snap = core.normalizeSnapshot(raw);
  assert.strictEqual(snap.tickets[0].position.releaseId, "r-1", "live release kept");
  assert.strictEqual(snap.tickets[0].position.processStepId, "ps-1", "live PS kept");
});

test("SM-78: pruning is idempotent (twice-normalize == once-normalize)", () => {
  const raw = {
    project: { id: "p1", name: "P" },
    tickets: [
      { id: "t-A", type: "user-story", title: "A",
        position: { releaseId: "r-gone", processStepId: "ps-1", epicId: null, sortOrder: 7 } }
    ],
    releases: [],
    processSteps: [{ id: "ps-1", name: "Build" }]
  };
  const once  = core.normalizeSnapshot(raw);
  const twice = core.normalizeSnapshot(once);
  assert.deepStrictEqual(once.tickets[0].position, twice.tickets[0].position,
    "second normalize is a no-op on already-pruned positions");
});

// ---------------------------------------------------------------------------
// SM-52 — Epic-Story containment migrated to contains-link
// ---------------------------------------------------------------------------

test("SM-52: normalizeSnapshot migrates legacy position.epicId to a contains-link from the epic", () => {
  // Hand-craft a legacy snapshot — story carries position.epicId, epic has no
  // links. After normalize, the epic must own a contains-link to the story
  // and the story's position.epicId must be null.
  const raw = {
    project: { id: "p1", name: "P", ticketPrefix: "P" },
    tickets: [
      { id: "t-epic", projectId: "p1", type: "epic", title: "Epic-X",
        position: { releaseId: null, processStepId: null, epicId: null, sortOrder: 0 },
        links: [] },
      { id: "t-story", projectId: "p1", type: "user-story", title: "Story-A",
        position: { releaseId: null, processStepId: null, epicId: "t-epic", sortOrder: 0 },
        links: [] }
    ]
  };
  const snap = core.normalizeSnapshot(raw);
  const epic = snap.tickets.find(t => t.id === "t-epic");
  const story = snap.tickets.find(t => t.id === "t-story");
  assert.strictEqual(story.position.epicId, null, "legacy field cleared");
  assert.ok(epic.links.length === 1, "epic gained one contains-link");
  assert.strictEqual(epic.links[0].linkTypeId, "contains");
  assert.strictEqual(epic.links[0].targetTicketId, "t-story");
});

test("SM-52: migration is idempotent — running normalize twice does not duplicate the link", () => {
  const raw = {
    project: { id: "p1", name: "P", ticketPrefix: "P" },
    tickets: [
      { id: "t-epic", projectId: "p1", type: "epic", title: "Epic" },
      { id: "t-story", projectId: "p1", type: "user-story", title: "Story",
        position: { releaseId: null, processStepId: null, epicId: "t-epic", sortOrder: 0 } }
    ]
  };
  const snap1 = core.normalizeSnapshot(raw);
  const snap2 = core.normalizeSnapshot(snap1);
  const epic2 = snap2.tickets.find(t => t.id === "t-epic");
  assert.strictEqual(epic2.links.length, 1, "no duplicate contains-link");
});

test("SM-52: migration is silent when the referenced epic does not exist (just clears the legacy field)", () => {
  const raw = {
    project: { id: "p1", name: "P", ticketPrefix: "P" },
    tickets: [
      { id: "t-story", projectId: "p1", type: "user-story", title: "Lonely",
        position: { releaseId: null, processStepId: null, epicId: "t-ghost", sortOrder: 0 } }
    ]
  };
  const snap = core.normalizeSnapshot(raw);
  assert.strictEqual(snap.tickets[0].position.epicId, null, "legacy field cleared even when epic missing");
});

test("SM-52: createTicket with explicit position.epicId stores the containment as a link, not on position", () => {
  let s = freshSnapshot();
  s = core.ops.createTicket(s, { type: "epic", title: "Container" }, HUMAN);
  const epicId = s.tickets[0].id;
  s = core.ops.createTicket(s, { type: "user-story", title: "Child",
    position: { epicId: epicId } }, HUMAN);
  const story = s.tickets.find(t => t.title === "Child");
  assert.strictEqual(story.position.epicId, null);
  const stories = core.tickets.storiesInEpic(s, epicId).map(t => t.id);
  assert.deepStrictEqual(stories, [story.id]);
});

test("SM-52: moveTicket with position.epicId re-parents via contains-link (old link removed, new added)", () => {
  let s = freshSnapshot();
  s = core.ops.createTicket(s, { type: "epic", title: "E1" }, HUMAN);
  s = core.ops.createTicket(s, { type: "epic", title: "E2" }, HUMAN);
  s = core.ops.createTicket(s, { type: "user-story", title: "S", position: { epicId: s.tickets[0].id } }, HUMAN);
  const e1 = s.tickets.find(t => t.title === "E1").id;
  const e2 = s.tickets.find(t => t.title === "E2").id;
  const sId = s.tickets.find(t => t.title === "S").id;
  // Re-parent to E2.
  s = core.ops.moveTicket(s, sId, { releaseId: null, processStepId: null, epicId: e2 }, HUMAN);
  assert.deepStrictEqual(core.tickets.storiesInEpic(s, e1).map(t => t.id), [], "E1 no longer contains");
  assert.deepStrictEqual(core.tickets.storiesInEpic(s, e2).map(t => t.id), [sId], "E2 now contains");
});

test("SM-52: reorderTickets with scope.epicId re-parents the listed tickets via links", () => {
  let s = freshSnapshot();
  s = core.ops.createTicket(s, { type: "epic", title: "E1" }, HUMAN);
  s = core.ops.createTicket(s, { type: "epic", title: "E2" }, HUMAN);
  const e1 = s.tickets[0].id, e2 = s.tickets[1].id;
  s = core.ops.createTicket(s, { type: "user-story", title: "A", position: { epicId: e1 } }, HUMAN);
  s = core.ops.createTicket(s, { type: "user-story", title: "B", position: { epicId: e1 } }, HUMAN);
  const a = s.tickets.find(t => t.title === "A").id;
  const b = s.tickets.find(t => t.title === "B").id;
  // Move both into E2 via reorder.
  s = core.ops.reorderTickets(s, [b, a], { releaseId: null, processStepId: null, epicId: e2 }, HUMAN);
  assert.deepStrictEqual(core.tickets.storiesInEpic(s, e1).map(t => t.id), [], "E1 empty after move");
  // Both now in E2, in the order we passed (b first, a second).
  assert.deepStrictEqual(core.tickets.storiesInEpic(s, e2).map(t => t.id), [b, a]);
});

test("SM-52: looseTicketsInCell now reads from contains-link, not position.epicId", () => {
  let s = freshSnapshot();
  s = core.ops.createRelease(s, { name: "v1" }, HUMAN);
  const rid = s.releases[0].id;
  s = core.ops.createProcessStep(s, { name: "PS" }, HUMAN);
  const psid = s.processSteps[0].id;
  s = core.ops.createTicket(s, { type: "epic", title: "E", position: { releaseId: rid, processStepId: psid } }, HUMAN);
  const epicId = s.tickets[0].id;
  // Two stories in the cell. One auto-assigned to the epic (via single-epic
  // inference), one explicitly outside it.
  s = core.ops.createTicket(s, { type: "user-story", title: "Auto-in",
    position: { releaseId: rid, processStepId: psid } }, HUMAN);
  // To create a story IN the cell but OUT of the epic, we need to skip the
  // auto-assignment. Simplest: create with no position, then move.
  s = core.ops.createTicket(s, { type: "user-story", title: "Loose-out" }, HUMAN);
  const loose = s.tickets.find(t => t.title === "Loose-out").id;
  // Move it into the cell WITHOUT specifying epicId.
  s = core.ops.moveTicket(s, loose, { releaseId: rid, processStepId: psid }, HUMAN);
  // Now only "Loose-out" should be loose; "Auto-in" is contained by E.
  const looseIds = core.tickets.looseTicketsInCell(s, rid, psid).map(t => t.id);
  assert.deepStrictEqual(looseIds, [loose]);
});

test("SM-52: orphanStories ignores stories that have a contains-link (even without release)", () => {
  let s = freshSnapshot();
  s = core.ops.createTicket(s, { type: "epic", title: "E" }, HUMAN);
  const epicId = s.tickets[0].id;
  // Story contained by E, no release.
  s = core.ops.createTicket(s, { type: "user-story", title: "Inside", position: { epicId: epicId } }, HUMAN);
  // Standalone orphan.
  s = core.ops.createTicket(s, { type: "user-story", title: "True-orphan" }, HUMAN);
  const orphans = core.tickets.orphanStories(s).map(t => t.title);
  assert.deepStrictEqual(orphans, ["True-orphan"]);
});

// ---------------------------------------------------------------------------
// SM-53 — Ticket-Type 'test-definition' data model
// ---------------------------------------------------------------------------

test("SM-53: DEFAULT_TICKET_TYPES includes 'test-definition' and 'test-execution'", () => {
  assert.ok(core.DEFAULT_TICKET_TYPES.indexOf("test-definition") >= 0);
  assert.ok(core.DEFAULT_TICKET_TYPES.indexOf("test-execution")  >= 0);
});

test("SM-53: normalizeTicket type='test-definition' adds prerequisites + steps arrays (defaults empty)", () => {
  const t = core.normalizeTicket({ type: "test-definition", title: "Login OK" });
  assert.ok(Array.isArray(t.prerequisites));
  assert.strictEqual(t.prerequisites.length, 0);
  assert.ok(Array.isArray(t.steps));
  assert.strictEqual(t.steps.length, 0);
  // Non-test fields default to empty for this type.
  assert.strictEqual(t.executionSteps.length, 0);
  assert.strictEqual(t.referencedTestDefinitionId, "");
});

test("SM-53: normalizeTicket preserves prerequisites + steps when provided", () => {
  const t = core.normalizeTicket({
    type: "test-definition", title: "T",
    prerequisites: [{ label: "User exists", required: true }],
    steps: [
      { step: "Open login page", expectedResult: "Page renders" },
      { step: "Enter credentials", data: "user/pass", expectedResult: "No error" }
    ]
  });
  assert.strictEqual(t.prerequisites.length, 1);
  assert.strictEqual(t.prerequisites[0].label, "User exists");
  assert.strictEqual(t.prerequisites[0].required, true);
  assert.strictEqual(t.prerequisites[0].checked, false);
  assert.strictEqual(t.steps.length, 2);
  assert.strictEqual(t.steps[0].step, "Open login page");
  assert.strictEqual(t.steps[1].data, "user/pass");
  assert.ok(t.steps[0].id, "step gets a generated id");
});

test("SM-53: non-test ticket-types get empty test fields (uniform JSON shape)", () => {
  const t = core.normalizeTicket({ type: "user-story", title: "S" });
  assert.deepStrictEqual(t.prerequisites, []);
  assert.deepStrictEqual(t.steps, []);
  assert.deepStrictEqual(t.executionSteps, []);
});

test("SM-53 + SM-54-followup: getEntityTypeConfig defaults for 'test-definition' hide AC + DoR + DoD; show prereqs/steps", () => {
  const cfg = core.getEntityTypeConfig({}, "test-definition");
  assert.strictEqual(cfg.showAcceptanceCriteria, false, "AC live on the user-story");
  assert.strictEqual(cfg.showPrerequisites, true);
  assert.strictEqual(cfg.showSteps, true);
  assert.strictEqual(cfg.showExecutionSteps, false);
  // SM-54-followup: tests have their OWN completeness criteria (prereqs +
  // steps); the generic DoR/DoD checklist doesn't apply.
  assert.strictEqual(cfg.showDefinitionOfReady, false);
  assert.strictEqual(cfg.showDefinitionOfDone,  false);
});

// ---------------------------------------------------------------------------
// SM-56 — Ticket-Type 'test-execution' data model
// ---------------------------------------------------------------------------

test("SM-56: normalizeTicket type='test-execution' adds executionSteps + outcome fields", () => {
  const t = core.normalizeTicket({ type: "test-execution", title: "Run 1" });
  assert.ok(Array.isArray(t.executionSteps));
  assert.strictEqual(t.executionSteps.length, 0);
  assert.strictEqual(t.referencedTestDefinitionId, "");
  assert.strictEqual(t.runAt, null);
  assert.strictEqual(t.runBy, null);
  assert.strictEqual(t.env, "");
  assert.strictEqual(t.outcomeOverride, null);
});

test("SM-56: normalizeTestExecStep coerces unknown status to 'pending' + keeps actual+note", () => {
  const s = core.normalizeTestExecStep({
    stepId: "tstep-1", step: "Click submit", data: "", expectedResult: "Saved",
    actualResult: "Got 500", status: "weird", note: "see jira"
  });
  assert.strictEqual(s.status, "pending", "unknown status falls back to pending");
  assert.strictEqual(s.actualResult, "Got 500");
  assert.strictEqual(s.note, "see jira");
});

test("SM-56: deriveOutcome — empty steps → pending", () => {
  assert.strictEqual(core.deriveOutcome([]), "pending");
  assert.strictEqual(core.deriveOutcome(null), "pending");
});

test("SM-56: deriveOutcome — all passed → passed", () => {
  assert.strictEqual(
    core.deriveOutcome([{ status: "passed" }, { status: "passed" }, { status: "passed" }]),
    "passed");
});

test("SM-56: deriveOutcome — any failed → failed (even with other states)", () => {
  assert.strictEqual(
    core.deriveOutcome([{ status: "passed" }, { status: "failed" }, { status: "blocked" }]),
    "failed");
});

test("SM-56: deriveOutcome — blocked (no failed) → blocked", () => {
  assert.strictEqual(
    core.deriveOutcome([{ status: "passed" }, { status: "blocked" }, { status: "passed" }]),
    "blocked");
});

test("SM-56: deriveOutcome — any pending (no failed/blocked) → pending", () => {
  assert.strictEqual(
    core.deriveOutcome([{ status: "passed" }, { status: "pending" }]),
    "pending");
});

test("SM-56: getEffectiveOutcome — outcomeOverride wins over derived", () => {
  const t = {
    executionSteps: [{ status: "passed" }, { status: "passed" }],
    outcomeOverride: "blocked"
  };
  assert.strictEqual(core.getEffectiveOutcome(t), "blocked");
});

test("SM-56: getEffectiveOutcome — unknown override falls back to derived", () => {
  const t = {
    executionSteps: [{ status: "passed" }],
    outcomeOverride: "not-a-status"
  };
  assert.strictEqual(core.getEffectiveOutcome(t), "passed");
});

test("SM-56: validateStatusTransition blocks test-execution → done while outcome is pending (kind=TEST_OUTCOME)", () => {
  const project = { id: "p1", name: "P", ticketPrefix: "P" };
  const snap = core.normalizeSnapshot({ project: project });
  const ticket = core.normalizeTicket({
    type: "test-execution", title: "R", status: "review",
    executionSteps: [{ step: "x", status: "pending" }]
  });
  let thrown = null;
  try { core.validateStatusTransition(ticket, "done", snap.project); }
  catch (e) { thrown = e; }
  assert.ok(thrown, "transition refused");
  assert.strictEqual(thrown.statusCode, 422);
  assert.strictEqual(thrown.kind, "TEST_OUTCOME");
});

test("SM-56: validateStatusTransition allows test-execution → done with non-pending outcome", () => {
  const snap = core.normalizeSnapshot({ project: { id: "p1", name: "P", ticketPrefix: "P" } });
  const ticket = core.normalizeTicket({
    type: "test-execution", title: "R", status: "review",
    executionSteps: [{ step: "x", status: "passed" }]
  });
  // No throw — passing outcome lets it through.
  core.validateStatusTransition(ticket, "done", snap.project);
});

test("SM-56: getEntityTypeConfig defaults for 'test-execution' hide AC/DoR/DoD + show exec-steps/outcome", () => {
  const cfg = core.getEntityTypeConfig({}, "test-execution");
  assert.strictEqual(cfg.showAcceptanceCriteria, false);
  assert.strictEqual(cfg.showDefinitionOfReady, false);
  assert.strictEqual(cfg.showDefinitionOfDone, false);
  assert.strictEqual(cfg.showExecutionSteps, true);
  assert.strictEqual(cfg.showTestOutcome, true);
});

// ---------------------------------------------------------------------------
// SM-100 — test-flags are type-bound. A stale `true` in an epic's override
// must not leak Prereqs / Steps / Execution / Outcome into the modal.
// ---------------------------------------------------------------------------

test("SM-100: getEntityTypeConfig hard-locks test-flags to false for non-test types even with a stale override", () => {
  // Reproduce the SQLite state we found in storymap-roadmap: an epic with
  // all four test-flags set to `true` by the SM-9 editor's `!== false`
  // materialisation.
  const project = {
    ticketTypes: ["epic", "user-story", "test-definition", "test-execution"],
    entityTypeConfig: {
      epic: {
        showPrerequisites: true, showSteps: true,
        showExecutionSteps: true, showTestOutcome: true,
        showDefinitionOfReady: false
      }
    }
  };
  const cfg = core.getEntityTypeConfig(project, "epic");
  assert.strictEqual(cfg.showPrerequisites, false, "Prereqs locked off for epic");
  assert.strictEqual(cfg.showSteps,          false, "Steps locked off for epic");
  assert.strictEqual(cfg.showExecutionSteps, false, "Execution-steps locked off for epic");
  assert.strictEqual(cfg.showTestOutcome,    false, "Outcome locked off for epic");
  // Other override fields still honoured.
  assert.strictEqual(cfg.showDefinitionOfReady, false, "non-test flags still merge");
});

test("SM-100: getEntityTypeConfig still honours test-flags as TRUE for the matching test type", () => {
  const project = {
    ticketTypes: ["test-definition", "test-execution"],
    entityTypeConfig: {
      "test-definition": { showPrerequisites: true, showSteps: true },
      "test-execution":  { showExecutionSteps: true, showTestOutcome: true }
    }
  };
  const def = core.getEntityTypeConfig(project, "test-definition");
  assert.strictEqual(def.showPrerequisites, true);
  assert.strictEqual(def.showSteps,         true);
  assert.strictEqual(def.showExecutionSteps, false, "exec flags belong to execution");
  assert.strictEqual(def.showTestOutcome,    false);
  const exec = core.getEntityTypeConfig(project, "test-execution");
  assert.strictEqual(exec.showExecutionSteps, true);
  assert.strictEqual(exec.showTestOutcome,    true);
  assert.strictEqual(exec.showPrerequisites, false, "def flags belong to definition");
  assert.strictEqual(exec.showSteps,         false);
});

test("SM-100: getEntityTypeConfig blocks an override that tries to enable showSteps on user-story", () => {
  const project = {
    ticketTypes: ["user-story"],
    entityTypeConfig: { "user-story": { showSteps: true, showPrerequisites: true } }
  };
  const cfg = core.getEntityTypeConfig(project, "user-story");
  assert.strictEqual(cfg.showSteps,          false);
  assert.strictEqual(cfg.showPrerequisites,  false);
});

test("SM-100: normalizeProject drops stale test-flags from non-test entity-type configs (migration)", () => {
  const snap = core.normalizeSnapshot({
    project: {
      id: "p1", name: "P", ticketPrefix: "P",
      entityTypeConfig: {
        epic: {
          showPrerequisites: true, showSteps: true,
          showExecutionSteps: true, showTestOutcome: true,
          showDefinitionOfReady: false
        },
        "user-story": { showSteps: true, showLinks: true },
        "test-definition": { showPrerequisites: false, showSteps: true },
        "test-execution":  { showExecutionSteps: true, showTestOutcome: false }
      }
    }
  });
  const etc = snap.project.entityTypeConfig;
  // epic: all four test-flags stripped.
  assert.strictEqual("showPrerequisites" in etc.epic, false);
  assert.strictEqual("showSteps"         in etc.epic, false);
  assert.strictEqual("showExecutionSteps" in etc.epic, false);
  assert.strictEqual("showTestOutcome"   in etc.epic, false);
  // epic: non-test flag preserved.
  assert.strictEqual(etc.epic.showDefinitionOfReady, false);
  // user-story: showSteps stripped, showLinks kept.
  assert.strictEqual("showSteps" in etc["user-story"], false);
  assert.strictEqual(etc["user-story"].showLinks, true);
  // test-definition: only its own two test-flags retained, exec-flags dropped.
  assert.strictEqual(etc["test-definition"].showPrerequisites, false);
  assert.strictEqual(etc["test-definition"].showSteps, true);
  assert.strictEqual("showExecutionSteps" in etc["test-definition"], false);
  assert.strictEqual("showTestOutcome"    in etc["test-definition"], false);
  // test-execution: only its own two.
  assert.strictEqual(etc["test-execution"].showExecutionSteps, true);
  assert.strictEqual(etc["test-execution"].showTestOutcome,    false);
  assert.strictEqual("showPrerequisites" in etc["test-execution"], false);
  assert.strictEqual("showSteps"         in etc["test-execution"], false);
});

// ---------------------------------------------------------------------------
// SM-54-followup — Test-Definition must link to ≥1 tested ticket
// ---------------------------------------------------------------------------

test("SM-54-followup: STORYMAPPER_DEFAULT_LINK_TYPES seeds 'tests' linkType + renames executes-inverse", () => {
  const tests   = core.STORYMAPPER_DEFAULT_LINK_TYPES.find(lt => lt.id === "tests");
  const exec    = core.STORYMAPPER_DEFAULT_LINK_TYPES.find(lt => lt.id === "executes");
  assert.ok(tests, "tests linkType present");
  assert.strictEqual(tests.semantic, "validation");
  assert.strictEqual(tests.inverseLabel, "Tested by");
  assert.strictEqual(exec.inverseLabel, "Executed by", "executes-inverse renamed to avoid clash");
});

test("SM-54-followup: validateStatusTransition blocks test-definition leaving backlog without a 'tests' link (kind=TEST_TARGETS)", () => {
  const snap = core.normalizeSnapshot({ project: { id: "p1", name: "P", ticketPrefix: "P" } });
  const ticket = core.normalizeTicket({
    type: "test-definition", title: "Login flow test", status: "backlog",
    links: []   // no targets
  });
  let thrown = null;
  try { core.validateStatusTransition(ticket, "ready", snap.project); }
  catch (e) { thrown = e; }
  assert.ok(thrown, "transition refused");
  assert.strictEqual(thrown.statusCode, 422);
  assert.strictEqual(thrown.kind, "TEST_TARGETS");
});

test("SM-54-followup: validateStatusTransition allows test-definition leaving backlog with ≥1 'tests' link", () => {
  const snap = core.normalizeSnapshot({ project: { id: "p1", name: "P", ticketPrefix: "P" } });
  const ticket = core.normalizeTicket({
    type: "test-definition", title: "Login flow test", status: "backlog",
    links: [{ id: "ln-1", linkTypeId: "tests", targetTicketId: "t-target" }]
  });
  // No throw — link present satisfies the gate.
  core.validateStatusTransition(ticket, "ready", snap.project);
});

test("SM-54-followup: validateStatusTransition gate only fires when leaving backlog (currIdx=0)", () => {
  // Already past backlog: forward moves don't re-check the targets link.
  const snap = core.normalizeSnapshot({ project: { id: "p1", name: "P", ticketPrefix: "P" } });
  const ticket = core.normalizeTicket({
    type: "test-definition", title: "T", status: "ready",
    links: []   // legacy ticket already in the pipeline without a target
  });
  // ready → in-progress passes without a targets link.
  core.validateStatusTransition(ticket, "in-progress", snap.project);
});

test("SM-54-followup: gate is type-scoped — non-test types are not affected", () => {
  const snap = core.normalizeSnapshot({ project: { id: "p1", name: "P", ticketPrefix: "P" } });
  // A regular user-story without any links transitions out of backlog freely
  // (subject to its own DoR gate, which we satisfy by setting required=false
  // — this test isolates the targets gate from DoR).
  const ticket = core.normalizeTicket({
    type: "user-story", title: "U", status: "backlog",
    definitionOfReady: { items: [{ id: "i", label: "x", required: false }] },
    links: []
  });
  core.validateStatusTransition(ticket, "ready", snap.project);
});

test("SM-54-followup: reverse move (e.g. done → backlog reopen) is unaffected by the gate", () => {
  const snap = core.normalizeSnapshot({ project: { id: "p1", name: "P", ticketPrefix: "P" } });
  const ticket = core.normalizeTicket({
    type: "test-definition", title: "T", status: "done",
    links: []
  });
  // Reverse: passes the early-return path in validateStatusTransition.
  core.validateStatusTransition(ticket, "backlog", snap.project);
});

// ---------------------------------------------------------------------------
// SM-57-followup — test-execution status couples to outcome
// ---------------------------------------------------------------------------

function sm57Snap() {
  // A minimal snapshot with a test-definition (2 steps) + a test-execution
  // spawned from it via startTestExecution (status='in-progress', all steps
  // 'pending', outcome='pending').
  let snap = core.normalizeSnapshot({
    project: { id: "p", name: "P", ticketPrefix: "P",
      ticketTypes: ["user-story", "test-definition", "test-execution"] }
  });
  // Need a story to satisfy the test-definition's required 'tests' link.
  snap = core.ops.createTicket(snap, { type: "user-story", title: "F" }, HUMAN);
  const feature = snap.tickets.find(t => t.title === "F");
  snap = core.ops.createTicket(snap, {
    type: "test-definition", title: "D",
    steps: [
      { id: "s1", step: "step 1", data: "", expectedResult: "r1" },
      { id: "s2", step: "step 2", data: "", expectedResult: "r2" }
    ],
    links: [{ linkTypeId: "tests", targetTicketId: feature.id }]
  }, HUMAN);
  const def = snap.tickets.find(t => t.title === "D");
  snap = core.ops.startTestExecution(snap, def.id, {}, HUMAN);
  const exec = snap.tickets.find(t => t.type === "test-execution");
  return { snap, def, exec };
}

test("SM-57-followup: recordTestExecStep auto-transitions in-progress → done when outcome becomes non-pending", () => {
  let { snap, exec } = sm57Snap();
  assert.strictEqual(exec.status, "in-progress");
  assert.strictEqual(core.getEffectiveOutcome(exec), "pending");
  // Mark step 1 as passed — outcome still pending (step 2 is pending).
  snap = core.ops.recordTestExecStep(snap, exec.id, "s1", { status: "passed" }, HUMAN);
  let cur = snap.tickets.find(t => t.id === exec.id);
  assert.strictEqual(cur.status, "in-progress", "still running while a step is pending");
  // Mark step 2 as passed — now outcome=passed → status should auto-flip to done.
  snap = core.ops.recordTestExecStep(snap, exec.id, "s2", { status: "passed" }, HUMAN);
  cur = snap.tickets.find(t => t.id === exec.id);
  assert.strictEqual(core.getEffectiveOutcome(cur), "passed");
  assert.strictEqual(cur.status, "done", "auto-transition to done after last step settled");
});

test("SM-57-followup: any failed step flips status to done immediately (failed outcome is conclusive)", () => {
  let { snap, exec } = sm57Snap();
  snap = core.ops.recordTestExecStep(snap, exec.id, "s1", { status: "failed" }, HUMAN);
  const cur = snap.tickets.find(t => t.id === exec.id);
  assert.strictEqual(core.getEffectiveOutcome(cur), "failed");
  assert.strictEqual(cur.status, "done");
});

test("SM-57-followup: reverting a step from passed → pending flips status back to in-progress", () => {
  let { snap, exec } = sm57Snap();
  // Drive to done.
  snap = core.ops.recordTestExecStep(snap, exec.id, "s1", { status: "passed" }, HUMAN);
  snap = core.ops.recordTestExecStep(snap, exec.id, "s2", { status: "passed" }, HUMAN);
  let cur = snap.tickets.find(t => t.id === exec.id);
  assert.strictEqual(cur.status, "done");
  // User reverts step 1 to pending — outcome derives back to pending → revert.
  snap = core.ops.recordTestExecStep(snap, exec.id, "s1", { status: "pending" }, HUMAN);
  cur = snap.tickets.find(t => t.id === exec.id);
  assert.strictEqual(core.getEffectiveOutcome(cur), "pending");
  assert.strictEqual(cur.status, "in-progress", "reverts back to in-progress");
});

test("SM-57-followup: setTestExecOutcome non-pending flips status to done; 'auto' rolls back if derived is still pending", () => {
  let { snap, exec } = sm57Snap();
  // Explicit manual override "passed" while steps are still pending.
  snap = core.ops.setTestExecOutcome(snap, exec.id, "passed", HUMAN);
  let cur = snap.tickets.find(t => t.id === exec.id);
  assert.strictEqual(cur.outcomeOverride, "passed");
  assert.strictEqual(cur.status, "done", "manual override produces a result");
  // Clear override → derived outcome becomes pending again → revert.
  snap = core.ops.setTestExecOutcome(snap, exec.id, "auto", HUMAN);
  cur = snap.tickets.find(t => t.id === exec.id);
  assert.strictEqual(cur.outcomeOverride, null);
  assert.strictEqual(core.getEffectiveOutcome(cur), "pending");
  assert.strictEqual(cur.status, "in-progress", "clearing override while steps pending reverts to in-progress");
});

test("SM-57-followup: updateTicket patch with executionSteps drives the same coupling", () => {
  let { snap, exec } = sm57Snap();
  // Patch both steps to passed via the generic updateTicket path.
  snap = core.ops.updateTicket(snap, exec.id, {
    executionSteps: [
      { id: exec.executionSteps[0].id, stepId: "s1", step: "step 1", data: "", expectedResult: "r1", actualResult: "ok", status: "passed" },
      { id: exec.executionSteps[1].id, stepId: "s2", step: "step 2", data: "", expectedResult: "r2", actualResult: "ok", status: "passed" }
    ]
  }, HUMAN);
  const cur = snap.tickets.find(t => t.id === exec.id);
  assert.strictEqual(core.getEffectiveOutcome(cur), "passed");
  assert.strictEqual(cur.status, "done", "updateTicket triggers the same sync as recordTestExecStep");
});

test("SM-57-followup: manual status (e.g. backlog/review) is NOT clobbered by the auto-coupling", () => {
  let { snap, exec } = sm57Snap();
  // User parks the execution in review for human-eyes-on before recording.
  snap = core.ops.updateTicket(snap, exec.id, { status: "review" }, HUMAN);
  let cur = snap.tickets.find(t => t.id === exec.id);
  assert.strictEqual(cur.status, "review");
  // Now mark all steps as passed — outcome flips to passed BUT the coupling
  // only forwards from in-progress, so review stays put. User decides.
  snap = core.ops.recordTestExecStep(snap, exec.id, "s1", { status: "passed" }, HUMAN);
  snap = core.ops.recordTestExecStep(snap, exec.id, "s2", { status: "passed" }, HUMAN);
  cur = snap.tickets.find(t => t.id === exec.id);
  assert.strictEqual(core.getEffectiveOutcome(cur), "passed");
  assert.strictEqual(cur.status, "review", "manual review state stays — coupling only owns in-progress↔done");
});

test("SM-57-followup: coupling is type-scoped — non test-execution tickets are unaffected", () => {
  let snap = core.normalizeSnapshot({
    project: { id: "p", name: "P", ticketPrefix: "P" }
  });
  snap = core.ops.createTicket(snap, { type: "user-story", title: "S" }, HUMAN);
  const s = snap.tickets.find(t => t.title === "S");
  // updateTicket with stray executionSteps on a user-story shouldn't touch its status.
  snap = core.ops.updateTicket(snap, s.id, { status: "in-progress" }, HUMAN);
  snap = core.ops.updateTicket(snap, s.id, {
    executionSteps: [{ id: "x", step: "x", data: "", expectedResult: "x", status: "passed" }]
  }, HUMAN);
  const cur = snap.tickets.find(t => t.id === s.id);
  // user-story has executionSteps stripped to [] by normalizeTicket, so the
  // patch is essentially a no-op on the field. But more importantly the
  // status MUST stay at in-progress — _syncExecStatusToOutcome guards on type.
  assert.strictEqual(cur.status, "in-progress");
});

// ---------------------------------------------------------------------------
// SM-67 — Position-inheritance Epic → contained stories
// ---------------------------------------------------------------------------

function sm67Snap() {
  let snap = core.normalizeSnapshot({
    project: { id: "p", name: "P", ticketPrefix: "P", ticketTypes: ["epic", "user-story", "bug"] },
    releases: [{ id: "v1", name: "v1" }, { id: "v2", name: "v2" }],
    processSteps: [{ id: "ps1", name: "Plan" }, { id: "ps2", name: "Build" }]
  });
  snap = core.ops.createTicket(snap, {
    type: "epic", title: "E", position: { releaseId: "v1", processStepId: "ps1" }
  }, HUMAN);
  return snap;
}

test("SM-67: createTicket on a contained story inherits release+processStep from the epic", () => {
  let snap = sm67Snap();
  const e = snap.tickets.find(t => t.title === "E");
  // Story created with epicId set but ONLY release given (no processStep)
  snap = core.ops.createTicket(snap, {
    type: "user-story", title: "S",
    position: { releaseId: "v2", epicId: e.id }  // wrong release on purpose; should be overridden
  }, HUMAN);
  const s = snap.tickets.find(t => t.title === "S");
  assert.strictEqual(s.position.releaseId, "v1", "release should be inherited from epic");
  assert.strictEqual(s.position.processStepId, "ps1", "processStep should be inherited from epic");
  // Container link is in place.
  assert.strictEqual(core.containerEpicIdOf(snap, s.id), e.id);
});

test("SM-67: moveTicket on a contained story silently overrides input release/processStep with the epic's", () => {
  let snap = sm67Snap();
  const e = snap.tickets.find(t => t.title === "E");
  snap = core.ops.createTicket(snap, {
    type: "user-story", title: "S",
    position: { releaseId: "v1", processStepId: "ps1", epicId: e.id }
  }, HUMAN);
  const s = snap.tickets.find(t => t.title === "S");
  // Attempt to move the story to v2/ps2 while keeping the container.
  snap = core.ops.moveTicket(snap, s.id, {
    releaseId: "v2", processStepId: "ps2", epicId: e.id, sortOrder: 0
  }, HUMAN);
  const s2 = snap.tickets.find(t => t.id === s.id);
  assert.strictEqual(s2.position.releaseId, "v1", "release stays at epic's value");
  assert.strictEqual(s2.position.processStepId, "ps1", "processStep stays at epic's value");
});

test("SM-67: moveTicket on a story dropped to null-container honors the input release/processStep (detach)", () => {
  let snap = sm67Snap();
  const e = snap.tickets.find(t => t.title === "E");
  snap = core.ops.createTicket(snap, {
    type: "user-story", title: "S", position: { releaseId: "v1", processStepId: "ps1", epicId: e.id }
  }, HUMAN);
  const s = snap.tickets.find(t => t.title === "S");
  // Detach (epicId omitted) and move to a different cell.
  snap = core.ops.moveTicket(snap, s.id, {
    releaseId: "v2", processStepId: "ps2", sortOrder: 0
  }, HUMAN);
  const s2 = snap.tickets.find(t => t.id === s.id);
  assert.strictEqual(s2.position.releaseId, "v2");
  assert.strictEqual(s2.position.processStepId, "ps2");
  assert.strictEqual(core.containerEpicIdOf(snap, s.id), null);
});

test("SM-67: moveTicket on an epic cascades release+processStep to all contained stories", () => {
  let snap = sm67Snap();
  const e = snap.tickets.find(t => t.title === "E");
  // Two contained stories in v1/ps1.
  snap = core.ops.createTicket(snap, {
    type: "user-story", title: "S1", position: { releaseId: "v1", processStepId: "ps1", epicId: e.id }
  }, HUMAN);
  snap = core.ops.createTicket(snap, {
    type: "user-story", title: "S2", position: { releaseId: "v1", processStepId: "ps1", epicId: e.id }
  }, HUMAN);
  // Move the epic to v2/ps2.
  snap = core.ops.moveTicket(snap, e.id, {
    releaseId: "v2", processStepId: "ps2", sortOrder: 0
  }, HUMAN);
  const s1 = snap.tickets.find(t => t.title === "S1");
  const s2 = snap.tickets.find(t => t.title === "S2");
  assert.strictEqual(s1.position.releaseId, "v2");
  assert.strictEqual(s1.position.processStepId, "ps2");
  assert.strictEqual(s2.position.releaseId, "v2");
  assert.strictEqual(s2.position.processStepId, "ps2");
});

test("SM-67: updateTicket position-patch on an epic cascades to contained stories", () => {
  let snap = sm67Snap();
  const e = snap.tickets.find(t => t.title === "E");
  snap = core.ops.createTicket(snap, {
    type: "user-story", title: "S", position: { releaseId: "v1", processStepId: "ps1", epicId: e.id }
  }, HUMAN);
  snap = core.ops.updateTicket(snap, e.id, {
    position: { releaseId: "v2", processStepId: "ps2", sortOrder: 0 }
  }, HUMAN);
  const s = snap.tickets.find(t => t.title === "S");
  assert.strictEqual(s.position.releaseId, "v2");
  assert.strictEqual(s.position.processStepId, "ps2");
});

test("SM-67: reorderTickets with scope.epicId pulls stories to epic's actual release+processStep", () => {
  let snap = sm67Snap();
  const e = snap.tickets.find(t => t.title === "E");
  // Two orphan stories.
  snap = core.ops.createTicket(snap, { type: "user-story", title: "A" }, HUMAN);
  snap = core.ops.createTicket(snap, { type: "user-story", title: "B" }, HUMAN);
  const a = snap.tickets.find(t => t.title === "A");
  const b = snap.tickets.find(t => t.title === "B");
  // Scope into epic with a deliberately wrong release/processStep on scope —
  // inheritance should override with the epic's (v1/ps1).
  snap = core.ops.reorderTickets(snap, [a.id, b.id], {
    releaseId: "v2", processStepId: "ps2", epicId: e.id
  }, HUMAN);
  const A = snap.tickets.find(t => t.id === a.id);
  const B = snap.tickets.find(t => t.id === b.id);
  assert.strictEqual(A.position.releaseId, "v1");
  assert.strictEqual(A.position.processStepId, "ps1");
  assert.strictEqual(B.position.releaseId, "v1");
  assert.strictEqual(B.position.processStepId, "ps1");
  assert.strictEqual(core.containerEpicIdOf(snap, A.id), e.id);
  assert.strictEqual(core.containerEpicIdOf(snap, B.id), e.id);
});

test("SM-67: normalizeSnapshot sync-pass repairs misaligned contained stories on load", () => {
  // Construct a snapshot where the contains-link exists but story position
  // diverges from the epic's — this simulates a legacy snapshot from before
  // SM-67 was in place (or one corrupted via direct DB edit).
  const raw = {
    project: { id: "p", name: "P", ticketPrefix: "P", ticketTypes: ["epic", "user-story"] },
    releases: [{ id: "v1", name: "v1" }, { id: "v2", name: "v2" }],
    processSteps: [{ id: "ps1", name: "Plan" }, { id: "ps2", name: "Build" }],
    tickets: [
      {
        id: "t-e", type: "epic", title: "E",
        position: { releaseId: "v2", processStepId: "ps2", sortOrder: 0 },
        links: [{ id: "l-1", linkTypeId: "contains", targetTicketId: "t-s" }]
      },
      {
        id: "t-s", type: "user-story", title: "S",
        position: { releaseId: "v1", processStepId: "ps1", sortOrder: 0 }
      }
    ]
  };
  const snap = core.normalizeSnapshot(raw);
  const s = snap.tickets.find(t => t.id === "t-s");
  assert.strictEqual(s.position.releaseId, "v2", "release sync'd to epic");
  assert.strictEqual(s.position.processStepId, "ps2", "processStep sync'd to epic");
});

test("SM-67: normalizeSnapshot sync-pass is idempotent on already-aligned snapshots", () => {
  let snap = sm67Snap();
  const e = snap.tickets.find(t => t.title === "E");
  snap = core.ops.createTicket(snap, {
    type: "user-story", title: "S", position: { releaseId: "v1", processStepId: "ps1", epicId: e.id }
  }, HUMAN);
  const before = JSON.stringify(snap);
  const normalized = core.normalizeSnapshot(JSON.parse(before));
  // Sync-pass shouldn't change anything; positions already aligned.
  const s = normalized.tickets.find(t => t.title === "S");
  assert.strictEqual(s.position.releaseId, "v1");
  assert.strictEqual(s.position.processStepId, "ps1");
});

test("SM-67: a story created via auto-epic-inference inherits the epic's processStep (not the input's)", () => {
  // Both epic and inferred-from cell at v1/ps1. Story created with same
  // releaseId/processStepId — auto-inference picks the epic as container,
  // and inheritance confirms the same values.
  let snap = sm67Snap();
  // Story created at (v1, ps1) with NO epicId — auto-inference fires.
  snap = core.ops.createTicket(snap, {
    type: "user-story", title: "S",
    position: { releaseId: "v1", processStepId: "ps1" }
  }, HUMAN);
  const s = snap.tickets.find(t => t.title === "S");
  const e = snap.tickets.find(t => t.title === "E");
  assert.strictEqual(core.containerEpicIdOf(snap, s.id), e.id, "auto-inferred container");
  assert.strictEqual(s.position.releaseId, "v1");
  assert.strictEqual(s.position.processStepId, "ps1");
});

test("SM-67: peer auto-sortOrder for contained stories uses inherited release+processStep", () => {
  // Verifies the bug surfaced by the failing sort-fix tests: when stories
  // are created with epicId but no processStepId, the peer-set computation
  // must use the INHERITED processStepId, not the input null. Otherwise,
  // sortOrder collides at 0 for every story created this way.
  let snap = sm67Snap();
  const e = snap.tickets.find(t => t.title === "E");
  for (let i = 0; i < 3; i++) {
    snap = core.ops.createTicket(snap, {
      type: "user-story", title: "S" + i,
      position: { releaseId: "v1", epicId: e.id }  // NB: no processStepId
    }, HUMAN);
  }
  const sorts = snap.tickets
    .filter(t => t.title && t.title.startsWith("S"))
    .map(t => t.position.sortOrder)
    .sort((a, b) => a - b);
  assert.deepStrictEqual(sorts, [0, 1, 2], "distinct, ascending sort orders");
});

// ---------------------------------------------------------------------------
// SM-103 — TRANSITION_RULES catalog + evaluateTransitionRules walker (pure)
// ---------------------------------------------------------------------------

test("SM-103: TRANSITION_RULES + evaluateTransitionRules are exported", () => {
  assert.ok(core.TRANSITION_RULES && typeof core.TRANSITION_RULES === "object",
    "TRANSITION_RULES is an object (the catalog seam)");
  assert.strictEqual(typeof core.evaluateTransitionRules, "function");
});

test("SM-103: walker returns [] for empty ruleIds", () => {
  const out = core.evaluateTransitionRules([], { ticket: { type: "bug" }, project: {} });
  assert.deepStrictEqual(out, []);
});

test("SM-103: walker returns [] for a non-array ruleIds (defensive)", () => {
  const out = core.evaluateTransitionRules(undefined, { ticket: { type: "bug" }, project: {} });
  assert.deepStrictEqual(out, []);
});

test("SM-103: walker skips rules whose enabledFor returns false (check never runs)", () => {
  let checked = false;
  const cat = {
    "r.off": {
      id: "r.off", label: "off",
      enabledFor: () => false,
      check: () => { checked = true; return { kind: "X" }; }
    }
  };
  const out = core.evaluateTransitionRules(["r.off"], { ticket: { type: "bug" }, project: {} }, cat);
  assert.deepStrictEqual(out, []);
  assert.strictEqual(checked, false, "check must not run when enabledFor is false");
});

test("SM-103: walker aggregates non-null check results in ruleIds order", () => {
  const cat = {
    "r.a":  { id: "r.a",  label: "a",  enabledFor: () => true, check: () => ({ kind: "A" }) },
    "r.ok": { id: "r.ok", label: "ok", enabledFor: () => true, check: () => null },
    "r.b":  { id: "r.b",  label: "b",  enabledFor: () => true, check: () => ({ kind: "B" }) }
  };
  const out = core.evaluateTransitionRules(["r.a", "r.ok", "r.b"],
    { ticket: { type: "bug" }, project: {} }, cat);
  assert.deepStrictEqual(out, [{ kind: "A" }, { kind: "B" }]);
});

test("SM-103: walker passes (type, project) to enabledFor and (ticket, project, ctx) to check", () => {
  const seen = {};
  const ticket = { type: "test-definition", id: "t1" };
  const project = { id: "p1" };
  const ctx = { currIdx: 0, nextIdx: 1, toStatus: "ready", toCategory: "todo" };
  const cat = {
    r: {
      id: "r", label: "r",
      enabledFor: (type, proj) => { seen.enType = type; seen.enProj = proj; return true; },
      check: (tk, proj, c) => { seen.tk = tk; seen.proj = proj; seen.ctx = c; return null; }
    }
  };
  core.evaluateTransitionRules(["r"], { ticket, project, ctx }, cat);
  assert.strictEqual(seen.enType, "test-definition");
  assert.strictEqual(seen.enProj, project);
  assert.strictEqual(seen.tk, ticket);
  assert.strictEqual(seen.proj, project);
  assert.strictEqual(seen.ctx, ctx, "ctx is passed through unchanged (same reference)");
});

test("SM-103: walker skips unknown rule ids (forward-compat, no throw)", () => {
  const out = core.evaluateTransitionRules(["nope"], { ticket: { type: "bug" }, project: {} }, {});
  assert.deepStrictEqual(out, []);
});

test("SM-103: walker uses the module TRANSITION_RULES catalog by default (unknown id skipped)", () => {
  const out = core.evaluateTransitionRules(["unknown.rule"],
    { ticket: { type: "bug" }, project: {} });
  assert.deepStrictEqual(out, []);
});

// ---------------------------------------------------------------------------
// SM-104 — DoR/DoD catalog rules + transitionRuleIds adapter + walker wiring
// ---------------------------------------------------------------------------

test("SM-104: default catalog contains dor.allRequiredMet + dod.allRequiredMet", () => {
  assert.ok(core.TRANSITION_RULES["dor.allRequiredMet"]);
  assert.ok(core.TRANSITION_RULES["dod.allRequiredMet"]);
});

test("SM-104: dor.allRequiredMet fires on an unchecked required item", () => {
  const ticket = { type: "bug", definitionOfReady: { items: [
    { id: "x", label: "X", required: true, checked: false } ] } };
  const out = core.evaluateTransitionRules(["dor.allRequiredMet"], { ticket, project: {} });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].kind, "DoR");
  assert.strictEqual(out[0].message, "definition of ready not met");
  assert.deepStrictEqual(out[0].missing, [{ id: "x", label: "X" }]);
});

test("SM-104: dor.allRequiredMet is satisfied when all required items checked", () => {
  const ticket = { type: "bug", definitionOfReady: { items: [
    { id: "x", label: "X", required: true, checked: true } ] } };
  assert.deepStrictEqual(
    core.evaluateTransitionRules(["dor.allRequiredMet"], { ticket, project: {} }), []);
});

test("SM-104: enabledFor skips the DoR rule when entityTypeConfig hides the section", () => {
  // SM-101 lockstep, now living inside the rule: hidden field ⇒ gate N/A.
  const project = { entityTypeConfig: { bug: { showDefinitionOfReady: false } } };
  const ticket = { type: "bug", definitionOfReady: { items: [
    { id: "x", label: "X", required: true, checked: false } ] } };
  assert.deepStrictEqual(
    core.evaluateTransitionRules(["dor.allRequiredMet"], { ticket, project }), []);
});

test("SM-104: dod.allRequiredMet fires + is skipped symmetrically", () => {
  const ticket = { type: "bug", definitionOfDone: { items: [
    { id: "d", label: "D", required: true, checked: false } ] } };
  const fired = core.evaluateTransitionRules(["dod.allRequiredMet"], { ticket, project: {} });
  assert.strictEqual(fired[0].kind, "DoD");
  const hidden = { entityTypeConfig: { bug: { showDefinitionOfDone: false } } };
  assert.deepStrictEqual(
    core.evaluateTransitionRules(["dod.allRequiredMet"], { ticket, project: hidden }), []);
});

test("SM-104: transitionRuleIds maps requireGate → rule ids, else uses rules[]", () => {
  assert.deepStrictEqual(core.transitionRuleIds({ requireGate: "DoR" }), ["dor.allRequiredMet"]);
  assert.deepStrictEqual(core.transitionRuleIds({ requireGate: "DoD" }), ["dod.allRequiredMet"]);
  assert.deepStrictEqual(core.transitionRuleIds({ rules: ["custom.x"] }), ["custom.x"]);
  assert.deepStrictEqual(core.transitionRuleIds({}), []);
  assert.deepStrictEqual(core.transitionRuleIds(null), []);
});

test("SM-104: requireGate wins over rules[] in the adapter (back-compat)", () => {
  assert.deepStrictEqual(
    core.transitionRuleIds({ requireGate: "DoD", rules: ["ignored"] }), ["dod.allRequiredMet"]);
});

// ---------------------------------------------------------------------------
// SM-105 — test-definition TEST_TARGETS gate as a global catalog rule
// ---------------------------------------------------------------------------

test("SM-105: links.hasTestTarget is in the catalog and in GLOBAL_TRANSITION_RULES", () => {
  assert.ok(core.TRANSITION_RULES["links.hasTestTarget"]);
  assert.ok(core.GLOBAL_TRANSITION_RULES.includes("links.hasTestTarget"));
});

test("SM-105: rule fires for test-definition leaving backlog (currIdx 0) without a tests link", () => {
  const ticket = { type: "test-definition", links: [] };
  const out = core.evaluateTransitionRules(["links.hasTestTarget"],
    { ticket, project: {}, ctx: { currIdx: 0, nextIdx: 1 } });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].kind, "TEST_TARGETS");
});

test("SM-105: rule passes when a tests link is present", () => {
  const ticket = { type: "test-definition", links: [{ id: "l", linkTypeId: "tests", targetTicketId: "t-x" }] };
  assert.deepStrictEqual(core.evaluateTransitionRules(["links.hasTestTarget"],
    { ticket, project: {}, ctx: { currIdx: 0, nextIdx: 1 } }), []);
});

test("SM-105: rule only fires on backlog-exit (ctx.currIdx !== 0 → satisfied)", () => {
  const ticket = { type: "test-definition", links: [] };
  assert.deepStrictEqual(core.evaluateTransitionRules(["links.hasTestTarget"],
    { ticket, project: {}, ctx: { currIdx: 1, nextIdx: 2 } }), []);
});

test("SM-105: enabledFor scopes the rule to test-definition only", () => {
  const ticket = { type: "user-story", links: [] };
  assert.deepStrictEqual(core.evaluateTransitionRules(["links.hasTestTarget"],
    { ticket, project: {}, ctx: { currIdx: 0, nextIdx: 1 } }), []);
});

// ---------------------------------------------------------------------------
// SM-106 — test-execution TEST_OUTCOME gate as a global catalog rule
// ---------------------------------------------------------------------------

test("SM-106: outcome.notPending is in the catalog and in GLOBAL_TRANSITION_RULES", () => {
  assert.ok(core.TRANSITION_RULES["outcome.notPending"]);
  assert.ok(core.GLOBAL_TRANSITION_RULES.includes("outcome.notPending"));
});

test("SM-106: rule fires when entering done-category with a pending outcome", () => {
  const ticket = core.normalizeTicket({
    type: "test-execution", title: "R", status: "review",
    executionSteps: [{ step: "x", status: "pending" }]
  });
  assert.strictEqual(core.getEffectiveOutcome(ticket), "pending"); // anchor precondition
  const out = core.evaluateTransitionRules(["outcome.notPending"],
    { ticket, project: {}, ctx: { currIdx: 2, nextIdx: 3, toCategory: "done" } });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].kind, "TEST_OUTCOME");
});

test("SM-106: rule passes when the outcome is non-pending", () => {
  const ticket = core.normalizeTicket({
    type: "test-execution", title: "R", status: "review",
    executionSteps: [{ step: "x", status: "passed" }]
  });
  assert.notStrictEqual(core.getEffectiveOutcome(ticket), "pending");
  assert.deepStrictEqual(core.evaluateTransitionRules(["outcome.notPending"],
    { ticket, project: {}, ctx: { currIdx: 2, nextIdx: 3, toCategory: "done" } }), []);
});

test("SM-106: rule only fires on done-category transitions (toCategory !== 'done' → satisfied)", () => {
  const ticket = core.normalizeTicket({
    type: "test-execution", title: "R", status: "ready",
    executionSteps: [{ step: "x", status: "pending" }]
  });
  assert.deepStrictEqual(core.evaluateTransitionRules(["outcome.notPending"],
    { ticket, project: {}, ctx: { currIdx: 1, nextIdx: 2, toCategory: "doing" } }), []);
});

test("SM-106: enabledFor scopes the rule via showTestOutcome (non-test type → skipped)", () => {
  const ticket = { type: "user-story" };
  assert.deepStrictEqual(core.evaluateTransitionRules(["outcome.notPending"],
    { ticket, project: {}, ctx: { currIdx: 2, nextIdx: 3, toCategory: "done" } }), []);
});

test("SM-106 + SM-237: the only type-check in validateStatusTransition is the epic-derived structural guard", () => {
  // AC3: every GATE (DoR/DoD/test) stays fully walker-driven. SM-237 added a
  // single STRUCTURAL guard at the top — an epic has no manual transitions
  // because its status is derived. That is the only permitted type-check.
  const src = core.validateStatusTransition.toString();
  const typeChecks = src.match(/type\s*===\s*"[^"]+"/g) || [];
  assert.deepStrictEqual(typeChecks, ['type === "epic"'],
    "only the SM-237 epic-derived guard may reference a concrete type");
});

// ---------------------------------------------------------------------------
// SM-102 (epic capstone) — structural invariant across the whole catalog
// ---------------------------------------------------------------------------

test("SM-102 invariant: a disabled rule (enabledFor false) NEVER fires, for any type — table-driven", () => {
  // The primary design invariant of the rule engine: a rule cannot surface a
  // failure for a type whose backing field is configured off. Generalizes the
  // SM-100/SM-101 bug class to ALL rules × ALL default types. We build a
  // worst-case ticket that would trip EVERY rule's check if it ran (unchecked
  // required DoR/DoD, no tests-link, pending outcome) and a ctx that satisfies
  // every rule's gating condition (backlog-exit AND done-category), then assert
  // that disabled rules contribute nothing.
  const project = core.normalizeProject({ id: "p1", name: "P" });
  const ruleIds = Object.keys(core.TRANSITION_RULES);
  const ctx = { currIdx: 0, nextIdx: 1, toStatus: "done", toCategory: "done" };
  let assertedDisabledCases = 0;
  for (const type of core.DEFAULT_TICKET_TYPES) {
    const ticket = core.normalizeTicket({
      type, title: "T", status: "backlog",
      definitionOfReady: { items: [{ id: "r", label: "R", required: true, checked: false }] },
      definitionOfDone:  { items: [{ id: "d", label: "D", required: true, checked: false }] },
      links: [],
      executionSteps: [{ step: "x", status: "pending" }]
    });
    for (const id of ruleIds) {
      const rule = core.TRANSITION_RULES[id];
      const enabled = typeof rule.enabledFor === "function" ? rule.enabledFor(type, project) : true;
      if (enabled) continue;
      assertedDisabledCases += 1;
      const out = core.evaluateTransitionRules([id], { ticket, project, ctx });
      assert.deepStrictEqual(out, [],
        `rule '${id}' must NOT fire for type '${type}' when enabledFor is false`);
    }
  }
  assert.ok(assertedDisabledCases > 0, "the invariant should exercise at least one disabled case");
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// SM-111 (A2) — DEFINITION_FROZEN gate on a published test-definition spec
// ---------------------------------------------------------------------------

function testDefSnapshot(lifecycle) {
  return core.normalizeSnapshot({
    project: { id: "p", name: "P", ticketPrefix: "P" },
    tickets: [{
      id: "t1", type: "test-definition", title: "Login flow", lifecycle: lifecycle,
      steps: [{ id: "s1", step: "open", data: "", expectedResult: "form" }],
      prerequisites: [{ id: "pr1", label: "logged out", required: true }]
    }],
    releases: [], processSteps: []
  });
}

test("SM-111: published test-def — every structural spec op throws DEFINITION_FROZEN (409)", () => {
  const structuralOps = [
    (s) => core.ops.addTestStep(s, "t1", { step: "x", expectedResult: "ok" }, HUMAN),
    (s) => core.ops.updateTestStep(s, "t1", "s1", { step: "y" }, HUMAN),
    (s) => core.ops.removeTestStep(s, "t1", "s1", HUMAN),
    (s) => core.ops.reorderTestSteps(s, "t1", ["s1"], HUMAN),
    (s) => core.ops.addTestPrereq(s, "t1", { label: "z" }, HUMAN),
    (s) => core.ops.updateTestPrereq(s, "t1", "pr1", { label: "z" }, HUMAN),
    (s) => core.ops.removeTestPrereq(s, "t1", "pr1", HUMAN)
  ];
  for (const op of structuralOps) {
    let err = null;
    try { op(testDefSnapshot("published")); } catch (e) { err = e; }
    assert.ok(err, "expected a throw");
    assert.strictEqual(err.kind, "DEFINITION_FROZEN");
    assert.strictEqual(err.statusCode, 409);
  }
});

test("SM-111: published test-def — prereq check/uncheck are NOT frozen (runtime toggles)", () => {
  let snap = testDefSnapshot("published");
  // Neither should throw — they toggle runtime state, not the spec.
  snap = core.ops.checkTestPrereq(snap, "t1", "pr1", HUMAN);
  snap = core.ops.uncheckTestPrereq(snap, "t1", "pr1", HUMAN);
  assert.ok(snap.tickets.find(x => x.id === "t1"));
});

test("SM-111: DRAFT test-def — structural spec edits succeed (gate only fires when published)", () => {
  const next = core.ops.addTestStep(testDefSnapshot("draft"), "t1", { step: "x", expectedResult: "ok" }, HUMAN);
  assert.strictEqual(next.tickets.find(x => x.id === "t1").steps.length, 2);
});

// ---------------------------------------------------------------------------
// SM-166 — updateTicket position-patch must not silently detach from the epic
// ---------------------------------------------------------------------------

function snapWithEpicAndStory() {
  let snap = core.normalizeSnapshot({ project: { id: "p", name: "P", ticketPrefix: "P" } });
  snap = core.ops.createTicket(snap, { type: "epic", title: "Epic" }, HUMAN);
  const epic = snap.tickets[snap.tickets.length - 1];
  snap = core.ops.createTicket(snap, { type: "user-story", title: "Story", position: { epicId: epic.id } }, HUMAN);
  const story = snap.tickets[snap.tickets.length - 1];
  return { snap, epicId: epic.id, storyId: story.id };
}

test("SM-166: position-patch WITHOUT epicId keeps the contains-link (no silent detach)", () => {
  let { snap, epicId, storyId } = snapWithEpicAndStory();
  assert.strictEqual(core.containerEpicIdOf(snap, storyId), epicId, "story starts contained");
  // A sortOrder-only position patch must NOT touch the container.
  snap = core.ops.updateTicket(snap, storyId, { position: { sortOrder: 5 } }, HUMAN);
  assert.strictEqual(core.containerEpicIdOf(snap, storyId), epicId,
    "story stays contained after a sortOrder-only position patch");
  assert.strictEqual(snap.tickets.find(t => t.id === storyId).position.sortOrder, 5,
    "the sortOrder change still landed");
});

test("SM-166: position-patch with explicit epicId re-parents + bumps both epics' audit", () => {
  let snap = core.normalizeSnapshot({ project: { id: "p", name: "P", ticketPrefix: "P" } });
  snap = core.ops.createTicket(snap, { type: "epic", title: "EpicA" }, HUMAN);
  const epicA = snap.tickets[snap.tickets.length - 1].id;
  snap = core.ops.createTicket(snap, { type: "epic", title: "EpicB" }, HUMAN);
  const epicB = snap.tickets[snap.tickets.length - 1].id;
  snap = core.ops.createTicket(snap, { type: "user-story", title: "Story", position: { epicId: epicA } }, HUMAN);
  const storyId = snap.tickets[snap.tickets.length - 1].id;
  assert.strictEqual(core.containerEpicIdOf(snap, storyId), epicA);
  const vA0 = snap.tickets.find(t => t.id === epicA).version;
  const vB0 = snap.tickets.find(t => t.id === epicB).version;
  snap = core.ops.updateTicket(snap, storyId, { position: { epicId: epicB } }, HUMAN);
  assert.strictEqual(core.containerEpicIdOf(snap, storyId), epicB, "re-parented A → B");
  assert.ok(snap.tickets.find(t => t.id === epicA).version > vA0, "old epic A audit bumped (lost the link)");
  assert.ok(snap.tickets.find(t => t.id === epicB).version > vB0, "new epic B audit bumped (gained the link)");
});

test("SM-166: position-patch with explicit epicId:null detaches", () => {
  let { snap, epicId, storyId } = snapWithEpicAndStory();
  assert.strictEqual(core.containerEpicIdOf(snap, storyId), epicId);
  snap = core.ops.updateTicket(snap, storyId, { position: { epicId: null } }, HUMAN);
  assert.strictEqual(core.containerEpicIdOf(snap, storyId), null, "explicit epicId:null detaches");
});

// ---------------------------------------------------------------------------
// SM-167 — deleting a process step must not orphan its tickets
// ---------------------------------------------------------------------------

test("SM-167: softDeleteProcessStep clears processStepId on its tickets (keeps releaseId)", () => {
  let snap = core.normalizeSnapshot({
    project: { id: "p", name: "P", ticketPrefix: "P" },
    releases: [{ id: "V3", name: "v3" }],
    processSteps: [{ id: "PS", name: "Build" }, { id: "PS2", name: "Test" }]
  });
  snap = core.ops.createTicket(snap, { type: "user-story", title: "InPS", position: { releaseId: "V3", processStepId: "PS" } }, HUMAN);
  const inPs = snap.tickets[snap.tickets.length - 1].id;
  snap = core.ops.createTicket(snap, { type: "user-story", title: "InPS2", position: { releaseId: "V3", processStepId: "PS2" } }, HUMAN);
  const inPs2 = snap.tickets[snap.tickets.length - 1].id;

  snap = core.ops.softDeleteProcessStep(snap, "PS", HUMAN);

  const t1 = snap.tickets.find(t => t.id === inPs);
  const t2 = snap.tickets.find(t => t.id === inPs2);
  assert.strictEqual(t1.position.processStepId, null, "ticket in the deleted step loses its processStepId");
  assert.strictEqual(t1.position.releaseId, "V3", "but keeps releaseId — still planned for V3, now visible in the backlog");
  assert.strictEqual(t2.position.processStepId, "PS2", "ticket in another step is untouched");
  // It now surfaces in the backlog's per-release group (was invisible before).
  const partial = core.tickets.partiallyAssignedByRelease(snap);
  assert.ok(partial.get("V3") && partial.get("V3").stories.some(s => s.id === inPs),
    "orphaned ticket resurfaces in the backlog 'Scheduled for V3' group");
});

// ---------------------------------------------------------------------------
// SM-247 — ops.splitProcessStep: split a backbone column, moving chosen
// epics (+ their contained stories) into the new step inserted right after
// the original. Loose stories stay with the original; the split is ONE
// snapshot transition (one revision when persisted).
// ---------------------------------------------------------------------------

function splitFixture() {
  let s = core.normalizeSnapshot({
    project: { id: "p", name: "P", ticketPrefix: "P" },
    releases: [{ id: "R1", name: "v1" }, { id: "R2", name: "v2" }],
    processSteps: [{ id: "PSA", name: "A", sortOrder: 0 }, { id: "PSB", name: "B", sortOrder: 1 }]
  });
  // Two epics in PSA (different releases) + one epic in PSB.
  s = core.ops.createTicket(s, { type: "epic", title: "E1", position: { releaseId: "R1", processStepId: "PSA" } }, HUMAN);
  const e1 = s.tickets[s.tickets.length - 1].id;
  s = core.ops.createTicket(s, { type: "epic", title: "E2", position: { releaseId: "R2", processStepId: "PSA" } }, HUMAN);
  const e2 = s.tickets[s.tickets.length - 1].id;
  s = core.ops.createTicket(s, { type: "epic", title: "E3", position: { releaseId: "R1", processStepId: "PSB" } }, HUMAN);
  const e3 = s.tickets[s.tickets.length - 1].id;
  // E1 contains a story; PSA also holds a loose story.
  s = core.ops.createTicket(s, { type: "user-story", title: "S1", position: { releaseId: "R1", epicId: e1 } }, HUMAN);
  const s1 = s.tickets[s.tickets.length - 1].id;
  s = core.ops.createTicket(s, { type: "user-story", title: "Loose", position: { releaseId: "R1", processStepId: "PSA" } }, HUMAN);
  // Auto-epic-assignment would have grabbed E1 — detach to make it loose.
  const loose = s.tickets[s.tickets.length - 1].id;
  s = core.ops.updateTicket(s, loose, { position: { releaseId: "R1", processStepId: "PSA", epicId: null } }, HUMAN);
  return { s, e1, e2, e3, s1, loose };
}

test("SM-247: split inserts the new step DIRECTLY AFTER the original (renumbered)", () => {
  const { s } = splitFixture();
  const out = core.ops.splitProcessStep(s, "PSA", { name: "A2" }, HUMAN);
  const live = out.processSteps.filter(p => !p.isDeleted)
    .slice().sort((a, b) => a.sortOrder - b.sortOrder);
  assert.deepStrictEqual(live.map(p => p.name), ["A", "A2", "B"]);
  assert.deepStrictEqual(live.map(p => p.sortOrder), [0, 1, 2], "contiguous renumber");
});

test("SM-247: chosen epics + their contained stories move; loose stories stay", () => {
  const { s, e1, e2, e3, s1, loose } = splitFixture();
  const out = core.ops.splitProcessStep(s, "PSA", { name: "A2", epicIds: [e1] }, HUMAN);
  const newPs = out.processSteps.find(p => p.name === "A2");
  const get = (id) => out.tickets.find(t => t.id === id);
  assert.strictEqual(get(e1).position.processStepId, newPs.id, "chosen epic moved");
  assert.strictEqual(get(s1).position.processStepId, newPs.id, "contained story follows its epic");
  assert.strictEqual(get(e2).position.processStepId, "PSA", "unchosen epic stays");
  assert.strictEqual(get(e3).position.processStepId, "PSB", "other step untouched");
  assert.strictEqual(get(loose).position.processStepId, "PSA", "loose story stays with the original");
});

test("SM-247: edge cases — empty epicIds, empty name 400, unknown step 404, epic not in step 422", () => {
  const { s, e3 } = splitFixture();
  // Empty epicIds = pure insert-after.
  const out = core.ops.splitProcessStep(s, "PSA", { name: "A2", epicIds: [] }, HUMAN);
  assert.ok(out.processSteps.find(p => p.name === "A2"));
  assert.throws(() => core.ops.splitProcessStep(s, "PSA", { name: "  " }, HUMAN),
    (e) => e.statusCode === 400);
  assert.throws(() => core.ops.splitProcessStep(s, "ps-nope", { name: "X" }, HUMAN),
    (e) => e.statusCode === 404);
  assert.throws(() => core.ops.splitProcessStep(s, "PSA", { name: "X", epicIds: [e3] }, HUMAN),
    (e) => e.statusCode === 422 && Array.isArray(e.missing) && e.missing[0] === e3);
});

test("SM-247: split output is normalize-invariant + COW-shares untouched tickets", () => {
  const { s, e1, e2 } = splitFixture();
  const out = core.ops.splitProcessStep(s, "PSA", { name: "A2", epicIds: [e1] }, HUMAN);
  assert.strictEqual(JSON.stringify(out), JSON.stringify(core.normalizeSnapshot(out)),
    "normalize-invariant (SM-240 contract)");
  const before = new Map(s.tickets.map(t => [t.id, t]));
  const e2After = out.tickets.find(t => t.id === e2);
  assert.strictEqual(e2After, before.get(e2), "unchosen epic is reference-shared");
});

// ---------------------------------------------------------------------------
// SM-248 — tickets.epicsInProcessStep: epics in a step across all releases,
// each with release tag + contained-story count, sorted release-then-epic.
// ---------------------------------------------------------------------------

test("SM-248: epicsInProcessStep returns epics across releases with release tag + story count", () => {
  let s = core.normalizeSnapshot({
    project: { id: "p", name: "P", ticketPrefix: "P" },
    releases: [{ id: "R1", name: "v1", sortOrder: 0 }, { id: "R2", name: "v2", sortOrder: 1 }],
    processSteps: [{ id: "PSA", name: "A" }, { id: "PSB", name: "B" }]
  });
  // E2 in R2, E1 in R1 (created out of release order to prove the sort).
  s = core.ops.createTicket(s, { type: "epic", title: "E2", position: { releaseId: "R2", processStepId: "PSA" } }, HUMAN);
  s = core.ops.createTicket(s, { type: "epic", title: "E1", position: { releaseId: "R1", processStepId: "PSA" } }, HUMAN);
  const e1 = s.tickets.find(t => t.title === "E1").id;
  s = core.ops.createTicket(s, { type: "epic", title: "E3", position: { releaseId: "R1", processStepId: "PSB" } }, HUMAN);
  // E1 gets two stories.
  s = core.ops.createTicket(s, { type: "user-story", title: "S1", position: { releaseId: "R1", epicId: e1 } }, HUMAN);
  s = core.ops.createTicket(s, { type: "user-story", title: "S2", position: { releaseId: "R1", epicId: e1 } }, HUMAN);

  const hull = core.tickets.epicsInProcessStep(s, "PSA");
  assert.strictEqual(hull.length, 2, "two epics in step A");
  assert.deepStrictEqual(hull.map(h => h.epic.title), ["E1", "E2"], "sorted by release order");
  assert.strictEqual(hull[0].releaseName, "v1");
  assert.strictEqual(hull[0].storyCount, 2, "E1 has two contained stories");
  assert.strictEqual(hull[1].releaseName, "v2");
  assert.strictEqual(hull[1].storyCount, 0);
  // PSB holds only E3.
  assert.deepStrictEqual(core.tickets.epicsInProcessStep(s, "PSB").map(h => h.epic.title), ["E3"]);
  // Unknown step → empty.
  assert.deepStrictEqual(core.tickets.epicsInProcessStep(s, "nope"), []);
});

// ---------------------------------------------------------------------------
// SM-236 — Roll-up: deriveEpicStatus (pure) + recompute in the ops.
// ---------------------------------------------------------------------------

// Build a base snapshot with one release, one process step and one empty epic.
function rollupBase() {
  let s = core.normalizeSnapshot({ project: { id: "rp", name: "Rollup", ticketPrefix: "R" } });
  s = core.ops.createRelease(s, { name: "v1" }, HUMAN);
  s = core.ops.createProcessStep(s, { name: "Build" }, HUMAN);
  const rid = s.releases[0].id, ps = s.processSteps[0].id;
  s = core.ops.createTicket(s, { type: "epic", title: "E", position: { releaseId: rid, processStepId: ps } }, HUMAN);
  const epic = s.tickets.find(t => t.title === "E").id;
  return { s, rid, ps, epic };
}
function epicStatusOf(s, epicId) {
  const e = s.tickets.find(t => t.id === epicId);
  return e ? e.status : null;
}
// Append a contained story (optionally pre-set its status) and return {s, id}.
function withStory(s, rid, epic, title, status) {
  s = core.ops.createTicket(s, { type: "user-story", title, position: { releaseId: rid, epicId: epic } }, HUMAN);
  const id = s.tickets.find(t => t.title === title).id;
  if (status) s = core.ops.changeStatus(s, id, status, HUMAN);
  return { s, id };
}

test("SM-236: deriveEpicStatus + epicChildStats + recomputeEpicStatuses are exported", () => {
  assert.strictEqual(typeof core.deriveEpicStatus, "function");
  assert.strictEqual(typeof core.epicChildStats, "function");
  assert.strictEqual(typeof core.recomputeEpicStatuses, "function");
});

test("SM-236: empty epic derives the first todo-category status (backlog)", () => {
  const { s, epic } = rollupBase();
  assert.strictEqual(core.deriveEpicStatus(s, epic), "backlog");
  assert.strictEqual(epicStatusOf(s, epic), "backlog", "recompute kept it backlog");
});

test("SM-236: all children done → epic derives the done-category status", () => {
  let { s, rid, epic } = rollupBase();
  ({ s } = withStory(s, rid, epic, "A", "done"));
  ({ s } = withStory(s, rid, epic, "B", "done"));
  assert.strictEqual(core.deriveEpicStatus(s, epic), "done");
  assert.strictEqual(epicStatusOf(s, epic), "done", "recompute flipped the epic to done");
});

test("SM-236: mix of done + todo children → epic derives a doing-category status", () => {
  let { s, rid, epic } = rollupBase();
  ({ s } = withStory(s, rid, epic, "A", "done"));
  ({ s } = withStory(s, rid, epic, "B"));  // backlog (todo)
  assert.strictEqual(core.deriveEpicStatus(s, epic), "in-progress");
  assert.strictEqual(epicStatusOf(s, epic), "in-progress");
});

test("SM-236: any child in a doing-category status → epic is doing", () => {
  let { s, rid, epic } = rollupBase();
  ({ s } = withStory(s, rid, epic, "A"));               // backlog
  ({ s } = withStory(s, rid, epic, "B", "in-progress"));
  assert.strictEqual(epicStatusOf(s, epic), "in-progress");
});

test("SM-236: all children todo → epic stays todo (backlog)", () => {
  let { s, rid, epic } = rollupBase();
  ({ s } = withStory(s, rid, epic, "A"));   // backlog
  ({ s } = withStory(s, rid, epic, "B", "ready"));   // ready is also todo-category
  assert.strictEqual(epicStatusOf(s, epic), "backlog");
});

test("SM-236: epicChildStats counts done/doing/todo over board-work-item children", () => {
  let { s, rid, epic } = rollupBase();
  ({ s } = withStory(s, rid, epic, "A", "done"));
  ({ s } = withStory(s, rid, epic, "B", "in-progress"));
  ({ s } = withStory(s, rid, epic, "C"));   // backlog
  const stats = core.epicChildStats(s, epic);
  assert.deepStrictEqual(stats, { total: 3, done: 1, doing: 1, todo: 1, cancelled: 0 });
});

test("SM-236: children resolve via contains-links; spec types + nested epics are ignored", () => {
  let { s, rid, epic } = rollupBase();
  ({ s } = withStory(s, rid, epic, "A", "done"));
  // A nested epic contained by the parent epic must NOT count as a child.
  s = core.ops.createTicket(s, { type: "epic", title: "NestedE", position: { releaseId: rid, epicId: epic } }, HUMAN);
  // A spec type (requirement) contained by the epic must NOT count either.
  s = core.ops.createTicket(s, { type: "requirement", title: "Req", position: { releaseId: rid, epicId: epic } }, HUMAN);
  // Only the single done story counts → all-children-done → epic done.
  assert.strictEqual(core.deriveEpicStatus(s, epic), "done");
});

test("SM-236: a container-only epic (only sub-epics) stays backlog — nested roll-up unsupported by design", () => {
  let { s, rid, epic } = rollupBase();
  // The parent epic contains ONLY a done sub-epic — no board-work-item stories.
  s = core.ops.createTicket(s, { type: "epic", title: "SubE", position: { releaseId: rid, epicId: epic } }, HUMAN);
  // The sub-epic itself has a done story (so the sub-epic derives to done)…
  const subId = s.tickets.find(t => t.title === "SubE").id;
  ({ s } = withStory(s, rid, subId, "SubStory", "done"));
  assert.strictEqual(epicStatusOf(s, subId), "done", "sub-epic rolled up to done");
  // …but the PARENT counts no board-work-item children → stays backlog.
  assert.strictEqual(core.epicChildStats(s, epic).total, 0);
  assert.strictEqual(epicStatusOf(s, epic), "backlog");
});

test("SM-237: ops.changeStatus rejects an epic structurally (not just via validateStatusTransition)", () => {
  let { s, epic } = rollupBase();
  let threw = null;
  try { core.ops.changeStatus(s, epic, "in-progress", HUMAN); } catch (e) { threw = e; }
  assert.ok(threw, "expected a throw");
  assert.strictEqual(threw.statusCode, 422);
  assert.strictEqual(threw.kind, "EPIC_STATUS_DERIVED");
});

test("SM-236: changeStatus on the LAST open story flips the epic to done in the SAME snapshot", () => {
  let { s, rid, epic } = rollupBase();
  let bId;
  ({ s } = withStory(s, rid, epic, "A", "done"));
  ({ s, id: bId } = withStory(s, rid, epic, "B"));   // backlog → epic in-progress
  assert.strictEqual(epicStatusOf(s, epic), "in-progress");
  s = core.ops.changeStatus(s, bId, "done", HUMAN);
  assert.strictEqual(epicStatusOf(s, epic), "done");
});

test("SM-236: createTicket of a new todo story drops a done epic back to doing", () => {
  let { s, rid, epic } = rollupBase();
  ({ s } = withStory(s, rid, epic, "A", "done"));
  assert.strictEqual(epicStatusOf(s, epic), "done");
  ({ s } = withStory(s, rid, epic, "B"));   // new backlog child
  assert.strictEqual(epicStatusOf(s, epic), "in-progress");
});

test("SM-236: softDeleteTicket of the last open story flips the epic to done", () => {
  let { s, rid, epic } = rollupBase();
  let bId;
  ({ s } = withStory(s, rid, epic, "A", "done"));
  ({ s, id: bId } = withStory(s, rid, epic, "B"));   // open → epic in-progress
  assert.strictEqual(epicStatusOf(s, epic), "in-progress");
  s = core.ops.softDeleteTicket(s, bId, HUMAN);
  assert.strictEqual(epicStatusOf(s, epic), "done", "only the done story remains");
});

test("SM-236: updateTicket status patch on a child rolls up the epic", () => {
  let { s, rid, epic } = rollupBase();
  let aId;
  ({ s, id: aId } = withStory(s, rid, epic, "A"));   // backlog
  s = core.ops.updateTicket(s, aId, { status: "done" }, HUMAN);
  assert.strictEqual(epicStatusOf(s, epic), "done");
});

test("SM-236: removing a contains-link drops the story out of the roll-up", () => {
  let { s, rid, epic } = rollupBase();
  let bId;
  ({ s } = withStory(s, rid, epic, "A", "done"));
  ({ s, id: bId } = withStory(s, rid, epic, "B"));   // open → epic in-progress
  assert.strictEqual(epicStatusOf(s, epic), "in-progress");
  const epicTicket = s.tickets.find(t => t.id === epic);
  const link = epicTicket.links.find(l => (l.linkTypeId || l.type) === "contains" && l.targetTicketId === bId);
  s = core.ops.removeLink(s, epic, link.id, HUMAN);
  assert.strictEqual(epicStatusOf(s, epic), "done", "only the done story is still contained");
});

test("SM-236: reorderTickets with scope.epicId re-parents and rolls up", () => {
  let { s, rid, ps, epic } = rollupBase();
  // A loose done story in a DIFFERENT cell (no epic there → no auto-assign).
  s = core.ops.createProcessStep(s, { name: "Ship" }, HUMAN);
  const ps2 = s.processSteps.find(p => p.name === "Ship").id;
  s = core.ops.createTicket(s, { type: "user-story", title: "Loose", position: { releaseId: rid, processStepId: ps2 } }, HUMAN);
  const looseId = s.tickets.find(t => t.title === "Loose").id;
  s = core.ops.changeStatus(s, looseId, "done", HUMAN);
  assert.strictEqual(epicStatusOf(s, epic), "backlog", "epic still empty");
  s = core.ops.reorderTickets(s, [looseId], { releaseId: rid, processStepId: ps, epicId: epic }, HUMAN);
  assert.strictEqual(epicStatusOf(s, epic), "done", "the done story is now contained");
});

test("SM-236: recompute is idempotent (second normalize is a no-op, structurally)", () => {
  let { s, rid, epic } = rollupBase();
  ({ s } = withStory(s, rid, epic, "A", "done"));
  ({ s } = withStory(s, rid, epic, "B", "done"));
  const once = core.normalizeSnapshot(s);
  const twice = core.normalizeSnapshot(once);
  assert.strictEqual(JSON.stringify(once), JSON.stringify(twice));
  assert.strictEqual(once.tickets.find(t => t.id === epic).status, "done");
});

test("SM-236: migration — a stored epic status diverging from derived is corrected on normalizeSnapshot", () => {
  let { s, rid, epic } = rollupBase();
  ({ s } = withStory(s, rid, epic, "A", "done"));
  ({ s } = withStory(s, rid, epic, "B", "done"));
  // Forge a stale stored status (simulating legacy data manually walked to backlog).
  const raw = JSON.parse(JSON.stringify(s));
  raw.tickets.find(t => t.id === epic).status = "backlog";
  const migrated = core.normalizeSnapshot(raw);
  assert.strictEqual(migrated.tickets.find(t => t.id === epic).status, "done");
});

test("SM-236: recompute does NOT bump the epic's audit (version/updatedBy untouched)", () => {
  // Build an epic with one open child, THEN capture audit. A subsequent
  // child-status change must roll the epic up WITHOUT touching its audit
  // (the contains-link bump on create is legitimate and happens before capture).
  let { s, rid, epic } = rollupBase();
  let aId;
  ({ s, id: aId } = withStory(s, rid, epic, "A"));   // backlog → epic in-progress
  const before = s.tickets.find(t => t.id === epic);
  const beforeVersion = before.version, beforeUpdatedBy = JSON.stringify(before.updatedBy);
  s = core.ops.changeStatus(s, aId, "done", HUMAN);  // child flips → epic derives done
  const after = s.tickets.find(t => t.id === epic);
  assert.strictEqual(after.status, "done");
  assert.strictEqual(after.version, beforeVersion, "derived recompute must not bump version");
  assert.strictEqual(JSON.stringify(after.updatedBy), beforeUpdatedBy, "derived recompute must not rewrite updatedBy");
});

test("SM-236: custom workflow with bespoke status ids + a blocked category", () => {
  const workflow = {
    statuses: [
      { id: "icebox", name: "Icebox", category: "todo" },
      { id: "wip", name: "WIP", category: "doing" },
      { id: "stuck", name: "Stuck", category: "blocked" },
      { id: "shipped", name: "Shipped", category: "done" }
    ],
    transitions: []
  };
  let s = core.normalizeSnapshot({ project: { id: "cw", name: "CW", ticketPrefix: "C", workflow } });
  s = core.ops.createRelease(s, { name: "v1" }, HUMAN);
  const rid = s.releases[0].id;
  s = core.ops.createProcessStep(s, { name: "P" }, HUMAN);
  const ps = s.processSteps[0].id;
  s = core.ops.createTicket(s, { type: "epic", title: "E", position: { releaseId: rid, processStepId: ps } }, HUMAN);
  const epic = s.tickets.find(t => t.title === "E").id;
  // empty → first todo
  assert.strictEqual(epicStatusOf(s, epic), "icebox");
  ({ s } = withStory(s, rid, epic, "A", "stuck"));   // blocked counts as "in progress"
  assert.strictEqual(epicStatusOf(s, epic), "wip", "blocked child → first doing status");
  ({ s } = withStory(s, rid, epic, "B", "shipped"));
  s = core.ops.changeStatus(s, s.tickets.find(t => t.title === "A").id, "shipped", HUMAN);
  assert.strictEqual(epicStatusOf(s, epic), "shipped", "all done → done-category status");
});

// ---------------------------------------------------------------------------
// SM-243 — Cancel C2: epic cascade + roll-up integration (cancelled vs done).
// ---------------------------------------------------------------------------

test("SM-243: cancelTicket on an epic cascades to non-terminal children only (one snapshot)", () => {
  let { s, rid, epic } = rollupBase();
  let aId, bId, cId;
  ({ s, id: aId } = withStory(s, rid, epic, "A", "done"));        // terminal — untouched
  ({ s, id: bId } = withStory(s, rid, epic, "B", "in-progress")); // non-terminal → cancelled
  ({ s, id: cId } = withStory(s, rid, epic, "C"));                // backlog → cancelled
  s = core.ops.cancelTicket(s, epic, HUMAN);
  assert.strictEqual(s.tickets.find(t => t.id === aId).status, "done", "done child untouched");
  assert.strictEqual(s.tickets.find(t => t.id === bId).status, "cancelled");
  assert.strictEqual(s.tickets.find(t => t.id === cId).status, "cancelled");
});

test("SM-243: all children cancelled → epic derives cancelled", () => {
  let { s, rid, epic } = rollupBase();
  ({ s } = withStory(s, rid, epic, "A", "cancelled"));
  ({ s } = withStory(s, rid, epic, "B", "cancelled"));
  assert.strictEqual(epicStatusOf(s, epic), "cancelled");
});

test("SM-243: all children terminal with ≥1 done → epic derives done (done dominates cancelled)", () => {
  let { s, rid, epic } = rollupBase();
  ({ s } = withStory(s, rid, epic, "A", "done"));
  ({ s } = withStory(s, rid, epic, "B", "cancelled"));
  assert.strictEqual(epicStatusOf(s, epic), "done", "the work that shipped dominates");
});

test("SM-243: cancelled children do NOT count as open work in the roll-up", () => {
  let { s, rid, epic } = rollupBase();
  ({ s } = withStory(s, rid, epic, "A", "done"));
  ({ s } = withStory(s, rid, epic, "B", "cancelled"));
  ({ s } = withStory(s, rid, epic, "C", "in-progress"));   // still open
  // active = {done, in-progress}; not all done → doing
  assert.strictEqual(epicStatusOf(s, epic), "in-progress");
  // epicChildStats exposes the cancelled bucket
  assert.deepStrictEqual(core.epicChildStats(s, epic), { total: 3, done: 1, doing: 1, todo: 0, cancelled: 1 });
});

test("SM-243: epic cancel of a fully-open epic → all children cancelled → epic cancelled", () => {
  let { s, rid, epic } = rollupBase();
  ({ s } = withStory(s, rid, epic, "A"));   // backlog
  ({ s } = withStory(s, rid, epic, "B", "in-progress"));
  s = core.ops.cancelTicket(s, epic, HUMAN);
  assert.strictEqual(epicStatusOf(s, epic), "cancelled");
});

test("SM-243: an EMPTY epic is directly cancellable via cancelTicket (the only manual epic set)", () => {
  let { s, epic } = rollupBase();   // epic has no children
  assert.strictEqual(core.epicChildStats(s, epic).total, 0);
  s = core.ops.cancelTicket(s, epic, HUMAN);
  assert.strictEqual(epicStatusOf(s, epic), "cancelled", "empty epic cancelled directly");
});

test("SM-243: SM-237 lock still blocks epic transitions through validateStatusTransition", () => {
  const proj = core.normalizeProject({ id: "p", name: "P", ticketPrefix: "P" });
  const epic = core.normalizeTicket({ id: "e1", projectId: "p", type: "epic", title: "E", status: "backlog" });
  let threw = null;
  try { core.validateStatusTransition(epic, "cancelled", proj); } catch (e) { threw = e; }
  assert.ok(threw && threw.kind === "EPIC_STATUS_DERIVED", "manual epic→cancelled via the gate is still blocked");
});

test("SM-243: reopening a cancelled child re-derives the epic (no special case)", () => {
  let { s, rid, epic } = rollupBase();
  let aId, bId;
  ({ s, id: aId } = withStory(s, rid, epic, "A", "done"));
  ({ s, id: bId } = withStory(s, rid, epic, "B", "cancelled"));
  assert.strictEqual(epicStatusOf(s, epic), "done");   // all terminal, ≥1 done
  s = core.ops.changeStatus(s, bId, "in-progress", HUMAN);   // reopen B from cancelled
  assert.strictEqual(epicStatusOf(s, epic), "in-progress", "epic follows the reopened child");
});

test("SM-243: cancelTicket(epic) is normalize-invariant (SM-220)", () => {
  let { s, rid, epic } = rollupBase();
  ({ s } = withStory(s, rid, epic, "A", "in-progress"));
  ({ s } = withStory(s, rid, epic, "B"));
  const out = core.ops.cancelTicket(s, epic, HUMAN);
  assert.strictEqual(JSON.stringify(out), JSON.stringify(core.normalizeSnapshot(out)));
});

// ---------------------------------------------------------------------------
// SM-239 — releaseProgress (pure): X/Y over non-epic, non-spec work items.
// ---------------------------------------------------------------------------

test("SM-239: releaseProgress is exported", () => {
  assert.strictEqual(typeof core.releaseProgress, "function");
});

test("SM-239: empty release → {done:0,total:0,complete:false}", () => {
  const { s, rid } = rollupBase();
  assert.deepStrictEqual(core.releaseProgress(s, rid), { done: 0, total: 0, complete: false });
});

test("SM-239: partial progress (1 of 2 done) → not complete", () => {
  let { s, rid, ps } = rollupBase();
  s = core.ops.createTicket(s, { type: "user-story", title: "A", position: { releaseId: rid, processStepId: ps } }, HUMAN);
  s = core.ops.createTicket(s, { type: "user-story", title: "B", position: { releaseId: rid, processStepId: ps } }, HUMAN);
  s = core.ops.changeStatus(s, s.tickets.find(t => t.title === "A").id, "done", HUMAN);
  assert.deepStrictEqual(core.releaseProgress(s, rid), { done: 1, total: 2, complete: false });
});

test("SM-239: all done → complete true", () => {
  let { s, rid, ps } = rollupBase();
  s = core.ops.createTicket(s, { type: "user-story", title: "A", position: { releaseId: rid, processStepId: ps } }, HUMAN);
  s = core.ops.changeStatus(s, s.tickets.find(t => t.title === "A").id, "done", HUMAN);
  assert.deepStrictEqual(core.releaseProgress(s, rid), { done: 1, total: 1, complete: true });
});

test("SM-239: epics + spec types are NOT counted (only what the board renders)", () => {
  let { s, rid, ps, epic } = rollupBase();   // rollupBase already placed an epic in the release
  // one done story contained by the epic
  ({ s } = withStory(s, rid, epic, "A", "done"));
  // a requirement (spec type) positioned in the release — must NOT count
  s = core.ops.createTicket(s, { type: "requirement", title: "Req", position: { releaseId: rid, processStepId: ps } }, HUMAN);
  const p = core.releaseProgress(s, rid);
  assert.strictEqual(p.total, 1, "only the story counts (epic + requirement excluded)");
  assert.strictEqual(p.done, 1);
  assert.strictEqual(p.complete, true);
});

test("SM-239: custom done-category status counts as done", () => {
  const workflow = {
    statuses: [
      { id: "icebox", name: "Icebox", category: "todo" },
      { id: "shipped", name: "Shipped", category: "done" }
    ],
    transitions: []
  };
  let s = core.normalizeSnapshot({ project: { id: "cw", name: "CW", ticketPrefix: "C", workflow } });
  s = core.ops.createRelease(s, { name: "v1" }, HUMAN);
  const rid = s.releases[0].id;
  s = core.ops.createTicket(s, { type: "user-story", title: "A", position: { releaseId: rid } }, HUMAN);
  s = core.ops.changeStatus(s, s.tickets.find(t => t.title === "A").id, "shipped", HUMAN);
  assert.deepStrictEqual(core.releaseProgress(s, rid), { done: 1, total: 1, complete: true });
});

test("SM-244: releaseProgress drops cancelled tickets from BOTH X and Y (scope reduction)", () => {
  let { s, rid, ps } = rollupBase();
  s = core.ops.createTicket(s, { type: "user-story", title: "A", position: { releaseId: rid, processStepId: ps } }, HUMAN);
  s = core.ops.createTicket(s, { type: "user-story", title: "B", position: { releaseId: rid, processStepId: ps } }, HUMAN);
  s = core.ops.createTicket(s, { type: "user-story", title: "C", position: { releaseId: rid, processStepId: ps } }, HUMAN);
  s = core.ops.changeStatus(s, s.tickets.find(t => t.title === "A").id, "done", HUMAN);
  s = core.ops.cancelTicket(s, s.tickets.find(t => t.title === "C").id, HUMAN);
  // A done, B open, C cancelled → C out of both → 1/2, not complete
  assert.deepStrictEqual(core.releaseProgress(s, rid), { done: 1, total: 2, complete: false });
  s = core.ops.changeStatus(s, s.tickets.find(t => t.title === "B").id, "done", HUMAN);
  assert.deepStrictEqual(core.releaseProgress(s, rid), { done: 2, total: 2, complete: true });
});

// ---------------------------------------------------------------------------
// SM-242 — Cancel C1: cancelled status category + default workflow + cancelTicket.
// ---------------------------------------------------------------------------

test("SM-242: 'cancelled' is a valid status category", () => {
  assert.ok(core.STATUS_CATEGORIES.includes("cancelled"));
  const s = core.normalizeStatusItem({ id: "x", name: "X", category: "cancelled" });
  assert.strictEqual(s.category, "cancelled");
});

test("SM-242: cancelled-ish status ids default to the cancelled category (not done)", () => {
  for (const id of ["cancelled", "canceled", "wontdo", "won't-do", "rejected"]) {
    assert.strictEqual(core.defaultCategoryForStatusId(id), "cancelled", id);
  }
  for (const id of ["done", "closed", "complete", "shipped"]) {
    assert.strictEqual(core.defaultCategoryForStatusId(id), "done", id);
  }
});

test("SM-242: default workflow has a cancelled status + a gate-free cancel transition", () => {
  const wf = core.STORYMAPPER_DEFAULT_WORKFLOW;
  const cancelledStatus = wf.statuses.find(s => s.category === "cancelled");
  assert.ok(cancelledStatus, "cancelled status present");
  assert.strictEqual(cancelledStatus.id, "cancelled");
  const cancelTr = wf.transitions.find(t => t.toStatus === cancelledStatus.id);
  assert.ok(cancelTr, "cancel transition present");
  assert.strictEqual(cancelTr.allowFromAny, true);
  assert.strictEqual(cancelTr.requireGate, null);
});

test("SM-242: additive migration adds cancelled to a workflow that lacks it; idempotent", () => {
  const custom = { statuses: [
    { id: "todo", name: "Todo", category: "todo" },
    { id: "doing", name: "Doing", category: "doing" },
    { id: "shipped", name: "Shipped", category: "done" }
  ], transitions: [] };
  const once = core.normalizeWorkflow(custom);
  const c = once.statuses.find(s => s.category === "cancelled");
  assert.ok(c, "cancelled status added");
  assert.ok(once.transitions.some(t => t.toStatus === c.id && t.allowFromAny && t.requireGate === null),
    "cancel transition added");
  const twice = core.normalizeWorkflow(once);
  assert.strictEqual(JSON.stringify(once), JSON.stringify(twice));
});

test("SM-242: migration stays idempotent even when an unrelated transition id 'cancel' exists", () => {
  // A workflow with no cancelled-category status but an existing id="cancel"
  // transition pointing elsewhere — the migration must not inject a duplicate id.
  const custom = { statuses: [
    { id: "open", name: "Open", category: "todo" },
    { id: "shipped", name: "Shipped", category: "done" }
  ], transitions: [
    { id: "cancel", name: "Abort to shipped", fromStatuses: [], toStatus: "shipped", requireGate: null, allowFromAny: true }
  ] };
  const once = core.normalizeWorkflow(custom);
  const twice = core.normalizeWorkflow(once);
  assert.strictEqual(JSON.stringify(once), JSON.stringify(twice), "normalize² must be byte-identical");
  assert.strictEqual(once.transitions.filter(t => t.id === "cancel").length, 1, "no duplicate cancel id");
});

test("SM-244 self-heal: a 'cancelled' status mis-categorized as done (old-server corruption) is repaired", () => {
  // Simulate an OLD server having normalized the cancelled category down to done.
  const corrupted = { statuses: [
    { id: "backlog", name: "Backlog", category: "todo" },
    { id: "done", name: "Done", category: "done" },
    { id: "cancelled", name: "Cancelled", category: "done" }   // ← corrupted category
  ], transitions: [
    { id: "cancel", name: "Cancel", fromStatuses: [], toStatus: "cancelled", requireGate: null, allowFromAny: true }
  ] };
  const wf = core.normalizeWorkflow(corrupted);
  const c = wf.statuses.find(s => s.id === "cancelled");
  assert.strictEqual(c.category, "cancelled", "cancelled status category repaired");
  // and the project can now resolve a cancelled status for cancelTicket
  const proj = core.normalizeProject({ id: "p", name: "P", ticketPrefix: "P", workflow: corrupted });
  assert.strictEqual(core.firstStatusOfCategory(proj, "cancelled"), "cancelled");
  // idempotent
  assert.strictEqual(JSON.stringify(wf), JSON.stringify(core.normalizeWorkflow(wf)));
});

test("SM-242: a custom workflow that ALREADY has a cancelled-category status is left untouched", () => {
  const custom = { statuses: [
    { id: "open", name: "Open", category: "todo" },
    { id: "killed", name: "Killed", category: "cancelled" },
    { id: "shipped", name: "Shipped", category: "done" }
  ], transitions: [
    { id: "kill", name: "Kill", fromStatuses: [], toStatus: "killed", requireGate: null, allowFromAny: true }
  ] };
  const out = core.normalizeWorkflow(custom);
  const cancelledStatuses = out.statuses.filter(s => s.category === "cancelled");
  assert.strictEqual(cancelledStatuses.length, 1, "no second cancelled status injected");
  assert.strictEqual(cancelledStatuses[0].id, "killed");
});

test("SM-242: ops.cancelTicket cancels from ANY status without a gate (unchecked DoD)", () => {
  let s = core.normalizeSnapshot({ project: { id: "p", name: "P", ticketPrefix: "P",
    definitions: { ready: { global: [], byType: {} }, done: { global: [{ id: "d1", label: "D1", required: true }], byType: {} } } } });
  s = core.ops.createTicket(s, { type: "user-story", title: "A" }, HUMAN);
  const id = s.tickets.find(t => t.title === "A").id;
  s = core.ops.changeStatus(s, id, "review", HUMAN);
  s = core.ops.cancelTicket(s, id, HUMAN);
  assert.strictEqual(s.tickets.find(x => x.id === id).status, "cancelled", "cancelled despite unmet DoD");
});

test("SM-242: reopen (cancelled → backlog/ready) is ungated (reverse move)", () => {
  const proj = core.normalizeProject({ id: "p", name: "P", ticketPrefix: "P" });
  const ticket = core.normalizeTicket({ id: "t1", projectId: "p", type: "user-story", title: "x", status: "cancelled" });
  core.validateStatusTransition(ticket, "backlog", proj);
  core.validateStatusTransition(ticket, "ready", proj);
});

test("SM-242: cancelTicket rejects spec types (own lifecycle)", () => {
  // (Epics were rejected in C1; SM-243 adds the cascade — see the SM-243 tests.)
  let s = core.normalizeSnapshot({ project: { id: "p", name: "P", ticketPrefix: "P" } });
  s = core.ops.createTicket(s, { type: "requirement", title: "R" }, HUMAN);
  const req = s.tickets.find(t => t.title === "R").id;
  let e2 = null; try { core.ops.cancelTicket(s, req, HUMAN); } catch (e) { e2 = e; }
  assert.ok(e2 && e2.kind === "SPEC_CANCEL", "spec type rejected");
});

test("SM-242: a cancelled ticket is never actionable (terminal)", () => {
  const graph = require("../server/core/graph.js");
  let s = core.normalizeSnapshot({ project: { id: "p", name: "P", ticketPrefix: "P" } });
  s = core.ops.createTicket(s, { type: "user-story", title: "A" }, HUMAN);
  const id = s.tickets.find(t => t.title === "A").id;
  s = core.ops.cancelTicket(s, id, HUMAN);
  const actionable = graph.actionableTickets(s, {});
  assert.ok(!actionable.includes(id), "cancelled ticket excluded from actionable set");
});

test("SM-242: cancelTicket output is normalize-invariant (SM-220)", () => {
  let s = core.normalizeSnapshot({ project: { id: "p", name: "P", ticketPrefix: "P" } });
  s = core.ops.createTicket(s, { type: "user-story", title: "A" }, HUMAN);
  const out = core.ops.cancelTicket(s, s.tickets.find(t => t.title === "A").id, HUMAN);
  assert.strictEqual(JSON.stringify(out), JSON.stringify(core.normalizeSnapshot(out)));
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

setImmediate(() => {
test("SM-301: deriveTestDefinition builds one step per AC, tests-links back, ONE compound result", () => {
  let s = freshSnapshot();
  s = core.ops.createTicket(s, { type: "user-story", title: "Resize story",
    acceptanceCriteria: [{ text: "Trenner folgt der Maus 1:1" }, { text: "Clipping am Minimum" }] }, HUMAN);
  const story = s.tickets[s.tickets.length - 1];
  const before = s.tickets.length;
  s = core.ops.deriveTestDefinition(s, story.id, {}, HUMAN);
  const def = s.tickets[s.tickets.length - 1];
  assert.strictEqual(s.tickets.length, before + 1, "exactly one new ticket (the definition)");
  assert.strictEqual(def.type, "test-definition");
  assert.strictEqual(def.title, "Testplan: Resize story", "title defaults to 'Testplan: <story title>'");
  assert.strictEqual(def.lifecycle, "draft", "north star: draft by default");
  assert.strictEqual(def.steps.length, 2, "one step per AC");
  assert.strictEqual(def.steps[0].step, "Trenner folgt der Maus 1:1");
  assert.ok(def.steps.every(st => st.expectedResult && st.expectedResult.length), "every step has a non-empty expectedResult");
  assert.ok((def.links || []).some(l => l.linkTypeId === "tests" && l.targetTicketId === story.id),
    "tests-link from the definition back to the story");
});

test("SM-301: deriveTestDefinition honours an explicit title and skips blank AC", () => {
  let s = freshSnapshot();
  s = core.ops.createTicket(s, { type: "bug", title: "Bug",
    acceptanceCriteria: [{ text: "  " }, { text: "Real one" }] }, HUMAN);
  const bug = s.tickets[s.tickets.length - 1];
  s = core.ops.deriveTestDefinition(s, bug.id, { title: "Custom Plan" }, HUMAN);
  const def = s.tickets[s.tickets.length - 1];
  assert.strictEqual(def.title, "Custom Plan");
  assert.strictEqual(def.steps.length, 1, "blank AC dropped");
  assert.strictEqual(def.steps[0].step, "Real one");
});

test("SM-301: deriveTestDefinition on a story WITHOUT acceptance criteria → 422 NO_ACCEPTANCE_CRITERIA", () => {
  let s = freshSnapshot();
  s = core.ops.createTicket(s, { type: "user-story", title: "No AC" }, HUMAN);
  const story = s.tickets[s.tickets.length - 1];
  let err = null;
  try { core.ops.deriveTestDefinition(s, story.id, {}, HUMAN); } catch (e) { err = e; }
  assert.ok(err, "throws");
  assert.strictEqual(err.statusCode, 422);
  assert.strictEqual(err.kind, "NO_ACCEPTANCE_CRITERIA");
});

test("SM-301 (review): deriveTestDefinition rejects a deleted target and a test-definition target", () => {
  let s = freshSnapshot();
  s = core.ops.createTicket(s, { type: "user-story", title: "S", acceptanceCriteria: [{ text: "AC" }] }, HUMAN);
  const story = s.tickets[s.tickets.length - 1];
  s = core.ops.softDeleteTicket(s, story.id, HUMAN);
  let err = null;
  try { core.ops.deriveTestDefinition(s, story.id, {}, HUMAN); } catch (e) { err = e; }
  assert.ok(err && err.statusCode === 404, "deleted target rejected");
  // a test-definition target is nonsensical
  let s2 = freshSnapshot();
  s2 = core.ops.createTicket(s2, { type: "test-definition", title: "TD" }, HUMAN);
  const td = s2.tickets[s2.tickets.length - 1];
  err = null;
  try { core.ops.deriveTestDefinition(s2, td.id, {}, HUMAN); } catch (e) { err = e; }
  assert.ok(err && err.statusCode === 400, "test-definition target rejected");
});

test("SM-301: deriveTestDefinition is pure — original snapshot untouched", () => {
  let s = freshSnapshot();
  s = core.ops.createTicket(s, { type: "user-story", title: "S", acceptanceCriteria: [{ text: "AC" }] }, HUMAN);
  const before = JSON.stringify(s);
  core.ops.deriveTestDefinition(s, s.tickets[s.tickets.length - 1].id, {}, HUMAN);
  assert.strictEqual(JSON.stringify(s), before, "input snapshot not mutated (COW)");
});

  console.log(`\n  ${passed} passed, ${failed} failed`);
});
