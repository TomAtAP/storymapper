"use strict";

/**
 * SM-240 — Copy-on-Write guardrails over ALL core.ops.
 *
 * Today every op deep-clones the whole snapshot (clone(snap) =
 * JSON round-trip) — the real `commit` hotspot (~11ms at N=1000) and the
 * reason no structural sharing exists. The COW rewrite makes ops share
 * unchanged entity objects by reference. These guardrails make that safe:
 *
 *   (a) INPUT IMMUTABLE   — the input snapshot is deep-frozen; any in-place
 *       mutation of a shared object throws (strict mode). Belt+suspenders:
 *       a deep-equal compare against a pre-op copy.
 *   (b) STRUCTURAL SHARING — entities the op does not touch come out
 *       REFERENCE-EQUAL (===). This is the red→green pin for COW.
 *   (c) NORMALIZE-INVARIANT — normalize(op(snap)) deep-equals op(snap),
 *       so the store can skip the full normalize on the op path
 *       (normalize-only-at-edges).
 *
 * Every op is exercised via the OPS_TABLE; adding an op without a table
 * entry fails the completeness check.
 */

const assert = require("assert");
const core = require("../shared/core.js");
const ops = core.ops;

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  - ${name}`); passed++; }
  catch (err) { console.log(`  FAIL - ${name}\n         ${err.stack || err.message}`); failed++; process.exitCode = 1; }
}

const A = { type: "human", id: "u1", name: "U" };

function deepFreeze(x) {
  if (x && typeof x === "object" && !Object.isFrozen(x)) {
    Object.freeze(x);
    for (const k of Object.keys(x)) deepFreeze(x[k]);
  }
  return x;
}

// Order-insensitive deep equality (JSON key order must not matter).
function deepEq(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEq(v, b[i]));
  }
  if (typeof a === "object") {
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every(k => deepEq(a[k], b[k]));
  }
  return false;
}

/**
 * Rich fixture: release, 2 process steps, epic with 2 contained stories,
 * a loose bystander story (touched by NO op — the sharing sentinel),
 * a draft test-definition with step+prereq, a started execution, and a
 * relates-to link S1→S2.
 */
function buildFixture() {
  let s = core.normalizeSnapshot({ project: { id: "p1", name: "P", ticketPrefix: "T" } });
  s = ops.createRelease(s, { name: "v1" }, A);
  s = ops.createProcessStep(s, { name: "Build" }, A);
  s = ops.createProcessStep(s, { name: "Ship" }, A);
  const rid = s.releases[0].id, ps1 = s.processSteps[0].id, ps2 = s.processSteps[1].id;
  s = ops.createTicket(s, { type: "epic", title: "E1", position: { releaseId: rid, processStepId: ps1 } }, A);
  const epic = s.tickets.find(t => t.title === "E1").id;
  s = ops.createTicket(s, { type: "user-story", title: "S1", acceptanceCriteria: [{ text: "AC1" }], position: { releaseId: rid, epicId: epic } }, A);  // AC for deriveTestDefinition (SM-301)
  s = ops.createTicket(s, { type: "user-story", title: "S2", position: { releaseId: rid, epicId: epic } }, A);
  s = ops.createTicket(s, { type: "user-story", title: "Bystander" }, A);
  s = ops.createTicket(s, { type: "test-definition", title: "TD" }, A);
  const td = s.tickets.find(t => t.title === "TD").id;
  s = ops.addTestStep(s, td, { text: "step1" }, A);
  s = ops.addTestPrereq(s, td, { text: "pre1" }, A);
  s = ops.startTestExecution(s, td, {}, A);
  const s1 = s.tickets.find(t => t.title === "S1").id;
  const s2 = s.tickets.find(t => t.title === "S2").id;
  s = ops.addLink(s, s1, { linkTypeId: "relates-to", targetTicketId: s2 }, A);
  // Make the whole fixture the canonical normalized shape.
  s = core.normalizeSnapshot(s);
  const ids = {
    rid, ps1, ps2, epic, s1, s2, td,
    bystander: s.tickets.find(t => t.title === "Bystander").id,
    exec: s.tickets.find(t => t.type === "test-execution").id,
    linkId: s.tickets.find(t => t.id === s1).links[0].id,
    dorItem: (s.tickets.find(t => t.id === s1).definitionOfReady.items[0] || {}).id,
    stepId: s.tickets.find(t => t.id === td).steps[0].id,
    prereqId: s.tickets.find(t => t.id === td).prerequisites[0].id,
    execStepId: (s.tickets.find(t => t.type === "test-execution").executionSteps[0] || {}).id
  };
  return { snap: s, ids };
}

// op-name → (ids) => [args after snap]. Touched = ticket ids the op may
// legitimately replace; everything else must come out reference-equal.
// "*" = structural op (creates/renumbers many) — only the bystander pin runs.
const OPS_TABLE = {
  createTicket:        (i) => ({ args: [{ type: "user-story", title: "Neu", position: { releaseId: i.rid, processStepId: i.ps1 } }, A], touched: [i.epic, "*new*"] }),
  updateTicket:        (i) => ({ args: [i.s1, { title: "S1x" }, A], touched: [i.s1] }),
  softDeleteTicket:    (i) => ({ args: [i.s2, A], touched: [i.s2, i.epic, i.td] }),
  changeStatus:        (i) => ({ args: [i.s1, "in-progress", A], touched: [i.s1, i.epic] }),
  cancelTicket:        (i) => ({ args: [i.s1, A], touched: [i.s1, i.epic] }),
  moveTicket:          (i) => ({ args: [i.s1, { releaseId: i.rid, processStepId: i.ps2, sortOrder: 5 }, A], touched: [i.s1, i.epic] }),
  addComment:          (i) => ({ args: [i.s1, { body: "hi" }, A], touched: [i.s1] }),
  checkDorItem:        (i) => ({ args: [i.s1, i.dorItem, A], touched: [i.s1] }),
  uncheckDorItem:      (i) => ({ args: [i.s1, i.dorItem, A], touched: [i.s1] }),
  checkDodItem:        (i) => ({ args: [i.s1, i.dorItem, A], touched: [i.s1] }),
  uncheckDodItem:      (i) => ({ args: [i.s1, i.dorItem, A], touched: [i.s1] }),
  addTestStep:         (i) => ({ args: [i.td, { text: "s2" }, A], touched: [i.td] }),
  deriveTestDefinition: (i) => ({ args: [i.s1, {}, A], touched: [i.epic, "*new*"] }),  // SM-301: creates a def (loose) + links it to s1; internal createTicket may touch the epic
  updateTestStep:      (i) => ({ args: [i.td, i.stepId, { text: "s1x" }, A], touched: [i.td] }),
  removeTestStep:      (i) => ({ args: [i.td, i.stepId, A], touched: [i.td] }),
  reorderTestSteps:    (i) => ({ args: [i.td, [i.stepId], A], touched: [i.td] }),
  addTestPrereq:       (i) => ({ args: [i.td, { text: "p2" }, A], touched: [i.td] }),
  updateTestPrereq:    (i) => ({ args: [i.td, i.prereqId, { text: "p1x" }, A], touched: [i.td] }),
  removeTestPrereq:    (i) => ({ args: [i.td, i.prereqId, A], touched: [i.td] }),
  checkTestPrereq:     (i) => ({ args: [i.td, i.prereqId, A], touched: [i.td] }),
  uncheckTestPrereq:   (i) => ({ args: [i.td, i.prereqId, A], touched: [i.td] }),
  startTestExecution:  (i) => ({ args: [i.td, {}, A], touched: [i.td, "*new*"] }),
  recordTestExecStep:  (i) => ({ args: [i.exec, i.execStepId, { state: "passed" }, A], touched: [i.exec, i.td] }),
  setTestExecOutcome:  (i) => ({ args: [i.exec, "passed", A], touched: [i.exec, i.td] }),
  updateProject:       (i) => ({ args: [{ name: "P2" }, A], touched: [] }),
  createRelease:       (i) => ({ args: [{ name: "v2" }, A], touched: [] }),
  updateRelease:       (i) => ({ args: [i.rid, { name: "v1x" }, A], touched: [] }),
  softDeleteRelease:   (i) => ({ args: [i.rid, A], touched: "*" }),
  reorderReleases:     (i) => ({ args: [[i.rid], A], touched: [] }),
  createProcessStep:   (i) => ({ args: [{ name: "QA" }, A], touched: [] }),
  updateProcessStep:   (i) => ({ args: [i.ps1, { name: "Buildx" }, A], touched: [] }),
  softDeleteProcessStep: (i) => ({ args: [i.ps1, A], touched: "*" }),
  reorderProcessSteps: (i) => ({ args: [[i.ps2, i.ps1], A], touched: [] }),
  splitProcessStep:    (i) => ({ args: [i.ps1, { name: "Split", epicIds: [i.epic] }, A], touched: "*" }),
  reorderTickets:      (i) => ({ args: [[i.s2, i.s1], { releaseId: i.rid, processStepId: i.ps1, epicId: i.epic }, A], touched: "*" }),
  addLink:             (i) => ({ args: [i.s2, { linkTypeId: "relates-to", targetTicketId: i.s1 }, A], touched: [i.s2] }),
  removeLink:          (i) => ({ args: [i.s1, i.linkId, A], touched: [i.s1] }),
  setLinks:            (i) => ({ args: [i.s1, [{ linkTypeId: "relates-to", targetTicketId: i.s2 }], A], touched: [i.s1] })
};

test("SM-240: OPS_TABLE covers every core.ops entry (completeness)", () => {
  const missing = Object.keys(ops).filter(k => !OPS_TABLE[k]);
  assert.deepStrictEqual(missing, [], "ops without a guardrail entry: " + missing.join(", "));
});

for (const [name, spec] of Object.entries(OPS_TABLE)) {
  test(`SM-240 (a): ${name} never mutates the input snapshot (frozen + deep-equal)`, () => {
    const { snap, ids } = buildFixture();
    const before = JSON.parse(JSON.stringify(snap));
    deepFreeze(snap);
    ops[name](snap, ...spec(ids).args);   // must not throw (no shared-object mutation)
    assert.ok(deepEq(snap, before), "input snapshot must be unchanged after " + name);
  });

  test(`SM-240 (b): ${name} shares untouched tickets by reference (COW)`, () => {
    const { snap, ids } = buildFixture();
    const { args, touched } = spec(ids);
    const out = ops[name](snap, ...args);
    const byId = new Map(snap.tickets.map(t => [t.id, t]));
    // The bystander is touched by NO op — it must always be shared.
    const byOut = out.tickets.find(t => t.id === ids.bystander);
    assert.ok(byOut === byId.get(ids.bystander),
      "bystander ticket must be reference-shared after " + name);
    if (touched !== "*") {
      const touchedSet = new Set(touched);
      for (const t of out.tickets) {
        if (touchedSet.has(t.id) || t.id === "*new*") continue;
        if (!byId.has(t.id)) continue;   // newly created
        assert.ok(t === byId.get(t.id),
          name + ": untouched ticket " + t.id + " must be reference-equal");
      }
    }
  });

  test(`SM-240 (c): ${name} output is normalize-invariant (ordered)`, () => {
    const { snap, ids } = buildFixture();
    const out = ops[name](snap, ...spec(ids).args);
    const normed = core.normalizeSnapshot(out);
    // Review hardening: ORDER-SENSITIVE equality — the store's applyRemote
    // echo check compares via JSON.stringify, so an op that appends a field
    // out of normalize's canonical key order would break the no-op echo
    // guarantee even though the values match.
    assert.strictEqual(JSON.stringify(out), JSON.stringify(normed),
      name + ": JSON.stringify(op(snap)) must equal the normalized form");
  });
}

// ---------------------------------------------------------------------------
// Review regressions — the three invariance holes the adversarial review
// reproduced (fixture blind spots in the generic table above).
// ---------------------------------------------------------------------------

test("SM-240 review: deleting a release/PS prunes SOFT-DELETED tickets too (normalize parity)", () => {
  const { snap, ids } = buildFixture();
  // Soft-delete S2 first; its position still points into the release + step.
  const s1 = ops.softDeleteTicket(snap, ids.s2, A);
  const afterRel = ops.softDeleteRelease(s1, ids.rid, A);
  assert.strictEqual(JSON.stringify(afterRel), JSON.stringify(core.normalizeSnapshot(afterRel)),
    "softDeleteRelease must prune soft-deleted tickets' releaseId");
  const afterPs = ops.softDeleteProcessStep(s1, ids.ps1, A);
  assert.strictEqual(JSON.stringify(afterPs), JSON.stringify(core.normalizeSnapshot(afterPs)),
    "softDeleteProcessStep must prune soft-deleted tickets' processStepId");
});

test("SM-240 review: updateTicket type-change re-gates type-conditional fields", () => {
  const { snap, ids } = buildFixture();
  // test-definition → user-story: steps/prereqs/lifecycle must be re-gated.
  const out1 = ops.updateTicket(snap, ids.td, { type: "user-story" }, A);
  assert.strictEqual(JSON.stringify(out1), JSON.stringify(core.normalizeSnapshot(out1)),
    "td → user-story must drop steps/prerequisites/lifecycle like normalize");
  // user-story → test-definition: lifecycle must become "draft".
  const out2 = ops.updateTicket(snap, ids.s1, { type: "test-definition" }, A);
  const t2 = out2.tickets.find(t => t.id === ids.s1);
  assert.strictEqual(t2.lifecycle, "draft");
  assert.strictEqual(JSON.stringify(out2), JSON.stringify(core.normalizeSnapshot(out2)));
});

test("SM-240 review: position patch WITHOUT epicId keeps the container's cell (SM-166 + SM-67)", () => {
  const { snap, ids } = buildFixture();
  // S1 is contained by the epic; a sortOrder-only patch must keep the epic's
  // release+processStep (syncContainedStoryPositions parity).
  const out = ops.updateTicket(snap, ids.s1, { position: { sortOrder: 9 } }, A);
  const t = out.tickets.find(x => x.id === ids.s1);
  assert.strictEqual(t.position.releaseId, ids.rid, "release inherited from container epic");
  assert.strictEqual(t.position.processStepId, ids.ps1, "processStep inherited from container epic");
  assert.strictEqual(t.position.sortOrder, 9);
  assert.strictEqual(JSON.stringify(out), JSON.stringify(core.normalizeSnapshot(out)));
});

// ---------------------------------------------------------------------------
// Store-level: normalize-only-at-edges + structural sharing end-to-end.
// ---------------------------------------------------------------------------

test("SM-240: store.updateTicket shares every untouched ticket by reference (===)", () => {
  const { ProjectStore } = require("../frontend/js/store.js");
  const { snap, ids } = buildFixture();
  const store = new ProjectStore(snap);
  const before = store.get();
  store.updateTicket(ids.s1, { title: "S1-renamed" }, A);
  const after = store.get();
  assert.notStrictEqual(after, before);
  const byId = new Map(before.tickets.map(t => [t.id, t]));
  let shared = 0, replaced = 0;
  for (const t of after.tickets) {
    if (t.id === ids.s1) { replaced++; assert.notStrictEqual(t, byId.get(t.id)); continue; }
    assert.strictEqual(t, byId.get(t.id), "untouched ticket must be reference-shared in the store");
    shared++;
  }
  assert.strictEqual(replaced, 1);
  assert.ok(shared >= 5, "the fixture's other tickets are all shared");
  // The undo stack holds the PREVIOUS snapshot by reference — no deep copy.
  assert.strictEqual(store._past[store._past.length - 1], before);
});

test("SM-240: applyRemote still normalizes (outer entry) — raw snapshots are safe", () => {
  const { ProjectStore } = require("../frontend/js/store.js");
  const { snap } = buildFixture();
  const store = new ProjectStore(snap);
  // A raw (denormalized) remote snapshot: position.epicId set, missing fields.
  const raw = JSON.parse(JSON.stringify(snap));
  raw.tickets[0].title = "remote-edit";
  raw.tickets[0].version = (raw.tickets[0].version || 1) + 1;
  delete raw.tickets[0].labels;   // normalize must restore the canonical shape
  store.applyRemote(raw);
  const t0 = store.get().tickets[0];
  assert.strictEqual(t0.title, "remote-edit");
  assert.ok(Array.isArray(t0.labels), "applyRemote normalized the incoming snapshot");
});

console.log(`\n  ${passed} passed, ${failed} failed`);
module.exports.done = Promise.resolve();
