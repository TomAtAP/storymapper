"use strict";

const assert = require("assert");
const core = require("../server/core.js");
const v = require("../server/validation.js");

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  - ${name}`); passed++; }
  catch (err) { console.log(`  FAIL - ${name}\n         ${err.stack || err.message}`); failed++; process.exitCode = 1; }
}

const HUMAN = { type: "human", id: "u1", name: "Test" };

function expectThrow(fn, statusCode, msgIncludes) {
  let thrown = null;
  try { fn(); } catch (err) { thrown = err; }
  assert.ok(thrown, "expected throw");
  assert.strictEqual(thrown.statusCode, statusCode, "statusCode mismatch: got " + thrown.statusCode);
  if (msgIncludes) assert.ok(String(thrown.message).includes(msgIncludes), "message: " + thrown.message);
  return thrown;
}

function freshProject(extra) {
  return core.normalizeProject(Object.assign({
    id: "p1", name: "Acme", ticketPrefix: "P",
    definitions: {
      ready: { global: [{ id: "g1", label: "G1", required: true }], byType: {} },
      done:  { global: [{ id: "d1", label: "D1", required: true }], byType: {} }
    }
  }, extra || {}));
}

// ---------------------------------------------------------------------------
// projectInput
// ---------------------------------------------------------------------------

test("projectInput: name required", () => {
  expectThrow(() => v.projectInput({}), 400, "name");
});

test("projectInput: name max length", () => {
  expectThrow(() => v.projectInput({ name: "x".repeat(500) }), 400, "name");
});

test("projectInput: ticketPrefix must be alnum-uppercase 1-10 chars", () => {
  expectThrow(() => v.projectInput({ name: "x", ticketPrefix: "" }), 400, "ticketPrefix");
  expectThrow(() => v.projectInput({ name: "x", ticketPrefix: "with space" }), 400, "ticketPrefix");
  v.projectInput({ name: "x", ticketPrefix: "PROJ" });  // ok
});

test("projectInput: valid", () => {
  v.projectInput({ name: "Acme", description: "A project" });
});

// ---------------------------------------------------------------------------
// ticketInput
// ---------------------------------------------------------------------------

test("ticketInput: title required", () => {
  const proj = freshProject();
  expectThrow(() => v.ticketInput({ type: "user-story" }, proj), 400, "title");
});

test("ticketInput: title max length", () => {
  const proj = freshProject();
  expectThrow(() => v.ticketInput({ type: "user-story", title: "x".repeat(400) }, proj), 400, "title");
});

test("ticketInput: type must be in project.ticketTypes", () => {
  const proj = freshProject({ ticketTypes: ["user-story", "bug"] });
  expectThrow(() => v.ticketInput({ type: "epic", title: "x" }, proj), 400, "type");
  v.ticketInput({ type: "user-story", title: "x" }, proj);  // ok
});

test("ticketInput: description max length", () => {
  const proj = freshProject();
  expectThrow(() => v.ticketInput({
    type: "user-story", title: "x", description: "y".repeat(60000)
  }, proj), 400, "description");
});

// ---------------------------------------------------------------------------
// changeStatusTransition — DoR / DoD enforcement
// ---------------------------------------------------------------------------

test("changeStatus: invalid newStatus → 400", () => {
  const proj = freshProject();
  const ticket = core.normalizeTicket({
    id: "t1", projectId: "p1", type: "user-story", title: "x", status: "backlog"
  });
  expectThrow(() => v.changeStatusTransition(ticket, "foo", proj), 400, "status");
});

test("changeStatus: backlog → ready, all required DoR checked → ok", () => {
  const proj = freshProject();
  const ticket = core.normalizeTicket({
    id: "t1", projectId: "p1", type: "user-story", title: "x", status: "backlog",
    definitionOfReady: { items: [{ id: "g1", label: "G1", required: true, checked: true, checkedAt: 1, checkedBy: HUMAN }] }
  });
  v.changeStatusTransition(ticket, "ready", proj);
});

test("changeStatus: backlog → ready, required DoR unchecked → 422 with missing", () => {
  const proj = freshProject();
  const ticket = core.normalizeTicket({
    id: "t1", projectId: "p1", type: "user-story", title: "x", status: "backlog",
    definitionOfReady: { items: [{ id: "g1", label: "G1", required: true, checked: false }] }
  });
  const err = expectThrow(() => v.changeStatusTransition(ticket, "ready", proj), 422);
  assert.ok(Array.isArray(err.missing));
  assert.strictEqual(err.missing.length, 1);
  assert.strictEqual(err.missing[0].id, "g1");
  assert.strictEqual(err.kind, "DoR");
});

test("changeStatus: backlog → ready, non-required DoR uncheckt → ok", () => {
  const proj = freshProject();
  const ticket = core.normalizeTicket({
    id: "t1", projectId: "p1", type: "user-story", title: "x", status: "backlog",
    definitionOfReady: { items: [{ id: "g1", label: "G1", required: false, checked: false }] }
  });
  v.changeStatusTransition(ticket, "ready", proj);
});

test("changeStatus: review → done, all required DoD checked → ok", () => {
  const proj = freshProject();
  const ticket = core.normalizeTicket({
    id: "t1", projectId: "p1", type: "user-story", title: "x", status: "review",
    definitionOfDone: { items: [{ id: "d1", label: "D1", required: true, checked: true, checkedAt: 1, checkedBy: HUMAN }] }
  });
  v.changeStatusTransition(ticket, "done", proj);
});

test("changeStatus: review → done, required DoD unchecked → 422 with kind=DoD", () => {
  const proj = freshProject();
  const ticket = core.normalizeTicket({
    id: "t1", projectId: "p1", type: "user-story", title: "x", status: "review",
    definitionOfDone: { items: [{ id: "d1", label: "D1", required: true, checked: false }] }
  });
  const err = expectThrow(() => v.changeStatusTransition(ticket, "done", proj), 422);
  assert.strictEqual(err.kind, "DoD");
  assert.strictEqual(err.missing.length, 1);
});

test("changeStatus: in-progress → review (no DoR/DoD check)", () => {
  const proj = freshProject();
  const ticket = core.normalizeTicket({
    id: "t1", projectId: "p1", type: "user-story", title: "x", status: "in-progress",
    definitionOfDone: { items: [{ id: "d1", label: "D1", required: true, checked: false }] }
  });
  v.changeStatusTransition(ticket, "review", proj);  // ok — DoD only checked on → done
});

// ---------------------------------------------------------------------------
// SM-237 — epic status is derived; manual transitions on an epic are blocked.
// ---------------------------------------------------------------------------

test("SM-237: any manual transition on an epic → 422 kind=EPIC_STATUS_DERIVED", () => {
  const proj = freshProject();
  const epic = core.normalizeTicket({
    id: "e1", projectId: "p1", type: "epic", title: "E", status: "backlog"
  });
  const err = expectThrow(() => v.changeStatusTransition(epic, "in-progress", proj), 422, "derived");
  assert.strictEqual(err.kind, "EPIC_STATUS_DERIVED");
});

test("SM-237: epic transition blocked even for a forward → done move (gate is N/A)", () => {
  const proj = freshProject();
  const epic = core.normalizeTicket({
    id: "e1", projectId: "p1", type: "epic", title: "E", status: "review"
  });
  const err = expectThrow(() => v.changeStatusTransition(epic, "done", proj), 422);
  assert.strictEqual(err.kind, "EPIC_STATUS_DERIVED");
});

test("SM-237: non-epic transitions are unaffected by the epic guard", () => {
  const proj = freshProject();
  const story = core.normalizeTicket({
    id: "t1", projectId: "p1", type: "user-story", title: "x", status: "in-progress"
  });
  v.changeStatusTransition(story, "review", proj);  // ok
});

test("SM-237: getEntityTypeConfig hides DoR/DoD for epics (lockstep)", () => {
  const proj = freshProject();
  const cfg = core.getEntityTypeConfig(proj, "epic");
  assert.strictEqual(cfg.showDefinitionOfReady, false);
  assert.strictEqual(cfg.showDefinitionOfDone, false);
  // A stale per-type override that tries to re-enable them is hard-locked off.
  const proj2 = core.normalizeProject(Object.assign({}, proj, {
    entityTypeConfig: { epic: { showDefinitionOfReady: true, showDefinitionOfDone: true } }
  }));
  const cfg2 = core.getEntityTypeConfig(proj2, "epic");
  assert.strictEqual(cfg2.showDefinitionOfReady, false, "epic DoR stays hidden despite override");
  assert.strictEqual(cfg2.showDefinitionOfDone, false, "epic DoD stays hidden despite override");
  // Non-epics still expose them.
  const cfgStory = core.getEntityTypeConfig(proj, "user-story");
  assert.strictEqual(cfgStory.showDefinitionOfReady, true);
  assert.strictEqual(cfgStory.showDefinitionOfDone, true);
});

test("SM-237: ops.updateTicket rejects a status patch on an epic (no silent ignore)", () => {
  let s = core.normalizeSnapshot({ project: { id: "p1", name: "P", ticketPrefix: "P" } });
  s = core.ops.createTicket(s, { type: "epic", title: "E" }, HUMAN);
  const epic = s.tickets.find(t => t.title === "E").id;
  const err = expectThrow(() => core.ops.updateTicket(s, epic, { status: "done" }, HUMAN), 422);
  assert.strictEqual(err.kind, "EPIC_STATUS_DERIVED");
  // Converting an epic AWAY to a story while setting status is allowed.
  const out = core.ops.updateTicket(s, epic, { type: "user-story", status: "in-progress" }, HUMAN);
  assert.strictEqual(out.tickets.find(t => t.id === epic).status, "in-progress");
});

test("E21.B: backlog → done direct only checks the matched transition's gate (DoD, not DoR)", () => {
  // E21.B introduced named Jira-style transitions: skip moves check the
  // gate of the matched transition only, not every crossed gate. With the
  // default workflow the transition to 'done' carries gate=DoD, so we
  // expect a DoD failure when DoD is unmet — even with DoR still open.
  const proj = freshProject();
  const ticket = core.normalizeTicket({
    id: "t1", projectId: "p1", type: "user-story", title: "x", status: "backlog",
    definitionOfReady: { items: [{ id: "g1", label: "G1", required: true, checked: false }] },
    definitionOfDone:  { items: [{ id: "d1", label: "D1", required: true, checked: false }] }
  });
  const err = expectThrow(() => v.changeStatusTransition(ticket, "done", proj), 422);
  assert.strictEqual(err.kind, "DoD");
});

test("E21.B: backlog → done with DoD met but DoR open passes (jump-bypass-DoR is intentional)", () => {
  const proj = freshProject();
  const ticket = core.normalizeTicket({
    id: "t1", projectId: "p1", type: "user-story", title: "x", status: "backlog",
    definitionOfReady: { items: [{ id: "g1", label: "G1", required: true, checked: false }] },
    definitionOfDone:  { items: [{ id: "d1", label: "D1", required: true, checked: true }] }
  });
  // No throw expected — only DoD is enforced for this jump.
  v.changeStatusTransition(ticket, "done", proj);
});

test("changeStatus: done → backlog (reopen) is allowed without DoR check", () => {
  const proj = freshProject();
  const ticket = core.normalizeTicket({
    id: "t1", projectId: "p1", type: "user-story", title: "x", status: "done",
    definitionOfReady: { items: [{ id: "g1", label: "G1", required: true, checked: false }] }
  });
  v.changeStatusTransition(ticket, "backlog", proj);
});

// ---------------------------------------------------------------------------
// SM-101 — Lockstep: entityTypeConfig.showDefinitionOf{Ready,Done}=false
// bypasses the corresponding gate for that type. UI and engine must agree.
// ---------------------------------------------------------------------------

// SM-237 SUPERSESSION: the original SM-101 epic-bypass cases (hidden gate ⇒
// gate skipped) no longer apply to epics — an epic has NO manual transitions
// at all now (its status is derived). The lockstep-bypass behaviour is still
// proven below for a NON-epic type. Epic attempts now hit EPIC_STATUS_DERIVED.
test("SM-237 (ex-SM-101): epic transition is blocked outright, gate config irrelevant", () => {
  const proj = freshProject({
    entityTypeConfig: { epic: { showDefinitionOfDone: false } }
  });
  const ticket = core.normalizeTicket({
    id: "t1", projectId: "p1", type: "epic", title: "E1", status: "review",
    definitionOfDone: { items: [{ id: "d1", label: "All AC are met", required: true, checked: false }] }
  });
  const err = expectThrow(() => v.changeStatusTransition(ticket, "done", proj), 422);
  assert.strictEqual(err.kind, "EPIC_STATUS_DERIVED");
});

test("SM-101 (lockstep preserved for non-epics): hidden DoD bypasses the DoD gate", () => {
  // The lockstep rule (entityTypeConfig hides the section ⇒ gate N/A) still
  // holds for ordinary work-item types — proven here on a user-story.
  const proj = freshProject({
    entityTypeConfig: { "user-story": { showDefinitionOfDone: false } }
  });
  const ticket = core.normalizeTicket({
    id: "t1", projectId: "p1", type: "user-story", title: "S1", status: "review",
    definitionOfDone: { items: [{ id: "d1", label: "All AC are met", required: true, checked: false }] }
  });
  v.changeStatusTransition(ticket, "done", proj);  // no throw — gate hidden
});

test("SM-101: story with visible DoD still respects the gate (no regression)", () => {
  // When showDefinitionOfDone is left at its default (true), the gate
  // fires as before. This is the baseline most projects rely on.
  const proj = freshProject();
  const ticket = core.normalizeTicket({
    id: "t1", projectId: "p1", type: "user-story", title: "x", status: "review",
    definitionOfDone: { items: [{ id: "d1", label: "D1", required: true, checked: false }] }
  });
  const err = expectThrow(() => v.changeStatusTransition(ticket, "done", proj), 422);
  assert.strictEqual(err.kind, "DoD");
});

test("SM-101: story with explicit showDefinitionOfDone=true respects the gate", () => {
  const proj = freshProject({
    entityTypeConfig: { "user-story": { showDefinitionOfDone: true } }
  });
  const ticket = core.normalizeTicket({
    id: "t1", projectId: "p1", type: "user-story", title: "x", status: "review",
    definitionOfDone: { items: [{ id: "d1", label: "D1", required: true, checked: false }] }
  });
  const err = expectThrow(() => v.changeStatusTransition(ticket, "done", proj), 422);
  assert.strictEqual(err.kind, "DoD");
});

test("SM-101 (lockstep preserved for non-epics): hidden DoD+DoR allows backlog → done jump", () => {
  // The SM-22 reproduction, now on a user-story: both gates configured-but-
  // hidden ⇒ straight from backlog to done. hidden ⇒ N/A.
  const proj = freshProject({
    entityTypeConfig: {
      "user-story": { showDefinitionOfReady: false, showDefinitionOfDone: false }
    }
  });
  const ticket = core.normalizeTicket({
    id: "t1", projectId: "p1", type: "user-story", title: "S1", status: "backlog",
    definitionOfReady: { items: [{ id: "g1", label: "G1", required: true, checked: false }] },
    definitionOfDone:  { items: [{ id: "d1", label: "D1", required: true, checked: false }] }
  });
  v.changeStatusTransition(ticket, "done", proj);
});

// ---------------------------------------------------------------------------
// releaseInput / processStepInput
// ---------------------------------------------------------------------------

test("releaseInput: name required, status enum", () => {
  expectThrow(() => v.releaseInput({}), 400, "name");
  expectThrow(() => v.releaseInput({ name: "v1", status: "weird" }), 400, "status");
  v.releaseInput({ name: "v1", status: "active" });
});

test("processStepInput: name required", () => {
  expectThrow(() => v.processStepInput({}), 400, "name");
  v.processStepInput({ name: "Onboarding" });
});

test("SM-255: releaseDelete refuses the last release (422 LAST_RELEASE), allows when ≥2", () => {
  const oneLeft = { releases: [{ id: "r1", name: "v1" }] };
  let caught = null;
  try { v.releaseDelete(oneLeft, "r1"); } catch (e) { caught = e; }
  assert.ok(caught, "deleting the last release should throw");
  assert.strictEqual(caught.statusCode, 422);
  assert.strictEqual(caught.kind, "LAST_RELEASE");
  // With two live releases, deleting either is fine.
  const two = { releases: [{ id: "r1", name: "v1" }, { id: "r2", name: "v2" }] };
  v.releaseDelete(two, "r1");   // no throw
  // A soft-deleted release doesn't count toward the ≥1 floor.
  const oneLivePlusDeleted = { releases: [{ id: "r1", name: "v1" }, { id: "r2", name: "v2", isDeleted: true }] };
  let caught2 = null;
  try { v.releaseDelete(oneLivePlusDeleted, "r1"); } catch (e) { caught2 = e; }
  assert.ok(caught2 && caught2.kind === "LAST_RELEASE", "r1 is the last LIVE release");
});

// ---------------------------------------------------------------------------
// definitionsInput
// ---------------------------------------------------------------------------

test("definitionsInput: must have ready and done blocks", () => {
  expectThrow(() => v.definitionsInput({}), 400, "ready");
});

test("definitionsInput: items must have id + label", () => {
  expectThrow(() => v.definitionsInput({
    ready: { global: [{ id: "g1" }], byType: {} },
    done:  { global: [], byType: {} }
  }), 400, "label");
});

test("definitionsInput: too many items → 400", () => {
  const items = [];
  for (let i = 0; i < core.LIMITS.maxChecklistItems + 5; i++) {
    items.push({ id: "g" + i, label: "L", required: true });
  }
  expectThrow(() => v.definitionsInput({
    ready: { global: items, byType: {} },
    done:  { global: [], byType: {} }
  }), 400, "limit");
});

test("definitionsInput: valid", () => {
  v.definitionsInput({
    ready: { global: [{ id: "g1", label: "G1", required: true }], byType: {} },
    done:  { global: [{ id: "d1", label: "D1", required: true }], byType: {
      "bug": { appended: [{ id: "r1", label: "Repro", required: true }] }
    }}
  });
});

test("SM-151: definitionsInput rejects a null byType entry with a structured 400 (not a raw 500)", () => {
  expectThrow(() => v.definitionsInput({
    ready: { global: [], byType: { epic: null } },
    done:  { global: [], byType: {} }
  }), 400, "byType");
});

// ---------------------------------------------------------------------------
// snapshotLimits
// ---------------------------------------------------------------------------

test("snapshotLimits: too many tickets → 400", () => {
  const tickets = [];
  for (let i = 0; i < core.LIMITS.maxTicketsPerProject + 1; i++) {
    tickets.push({ id: "t" + i, projectId: "p1", type: "user-story", title: "x" });
  }
  const snap = core.normalizeSnapshot({ project: { id: "p1", name: "x" }, tickets });
  expectThrow(() => v.snapshotLimits(snap), 400, "tickets");
});

test("snapshotLimits: ok at limit", () => {
  // Just check that an empty / small snapshot passes.
  v.snapshotLimits(core.normalizeSnapshot({ project: { id: "p1", name: "x" } }));
});

// ---------------------------------------------------------------------------
// E13.C — Workflow-driven changeStatusTransition
// ---------------------------------------------------------------------------

test("E13.C: per-type workflow override disables a gate for that type only", () => {
  const project = core.normalizeProject({
    id: "p1", name: "P",
    workflow: {
      statuses: ["backlog", "ready", "in-progress", "review", "done"],
      transitions: { "ready": { requireGate: "DoR" }, "done": { requireGate: "DoD" } },
      byType: {
        "bug": { transitions: { "ready": { requireGate: null } } }
      }
    }
  });
  // Story still needs DoR met → ready.
  const story = { type: "user-story", status: "backlog", definitionOfReady: { items: [{ id: "r1", label: "X", required: true, checked: false }] }, definitionOfDone: { items: [] } };
  expectThrow(() => v.changeStatusTransition(story, "ready", project), 422, "ready");
  // Bug with same unchecked DoR → ready PASSES (gate disabled per-type).
  const bug = Object.assign({}, story, { type: "bug" });
  v.changeStatusTransition(bug, "ready", project);   // must not throw
});

test("E13.C: custom workflow (todo/doing/done) is honored — unknown status throws", () => {
  const project = core.normalizeProject({
    id: "p1", name: "P",
    workflow: {
      statuses: ["todo", "doing", "done"],
      transitions: { "done": { requireGate: "DoD" } }
    }
  });
  const ticket = { type: "user-story", status: "todo", definitionOfReady: { items: [] }, definitionOfDone: { items: [] } };
  // "ready" is not in the custom workflow → status invalid.
  expectThrow(() => v.changeStatusTransition(ticket, "ready", project), 400, "invalid");
  // "doing" IS in the workflow and has no gate.
  v.changeStatusTransition(ticket, "doing", project);   // must not throw
});

test("E21.B: fromStatuses restricts which source statuses can use a transition", () => {
  const project = core.normalizeProject({
    id: "p1", name: "P",
    workflow: {
      statuses: ["todo", "doing", "done"],
      transitions: [
        { id: "start",   name: "Start",   fromStatuses: ["todo"],  toStatus: "doing", requireGate: null, allowFromAny: false },
        { id: "finish",  name: "Finish",  fromStatuses: ["doing"], toStatus: "done",  requireGate: null, allowFromAny: false }
      ]
    }
  });
  // todo → doing is allowed
  v.changeStatusTransition({ type: "user-story", status: "todo", definitionOfReady: { items: [] }, definitionOfDone: { items: [] } }, "doing", project);
  // todo → done is NOT allowed (only finish exists, and its source is "doing")
  const err = expectThrow(() => v.changeStatusTransition(
    { type: "user-story", status: "todo", definitionOfReady: { items: [] }, definitionOfDone: { items: [] } },
    "done", project), 422);
  assert.strictEqual(err.kind, "TRANSITION");
});

test("E21.B: allowFromAny transition matches any source status", () => {
  const project = core.normalizeProject({
    id: "p1", name: "P",
    workflow: {
      statuses: ["todo", "doing", "blocked", "done"],
      transitions: [
        { id: "block", name: "Block", fromStatuses: [], toStatus: "blocked", requireGate: null, allowFromAny: true }
      ]
    }
  });
  const t1 = { type: "user-story", status: "todo",   definitionOfReady: { items: [] }, definitionOfDone: { items: [] } };
  const t2 = { type: "user-story", status: "doing",  definitionOfReady: { items: [] }, definitionOfDone: { items: [] } };
  // Both transitions to "blocked" succeed because allowFromAny.
  v.changeStatusTransition(t1, "blocked", project);
  v.changeStatusTransition(t2, "blocked", project);
});

test("E21.B: no matching transition → 422 with kind=TRANSITION", () => {
  const project = core.normalizeProject({
    id: "p1", name: "P",
    workflow: {
      statuses: ["todo", "done"],
      transitions: []   // no transitions defined
    }
  });
  const ticket = { type: "user-story", status: "todo", definitionOfReady: { items: [] }, definitionOfDone: { items: [] } };
  const err = expectThrow(() => v.changeStatusTransition(ticket, "done", project), 422);
  assert.strictEqual(err.kind, "TRANSITION");
  assert.ok(/transition/i.test(err.message));
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

setImmediate(() => {
  console.log(`\n  ${passed} passed, ${failed} failed`);
});
