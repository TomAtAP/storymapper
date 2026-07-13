"use strict";

const assert = require("assert");
const core = require("../frontend/js/core.js");
const { ProjectStore, emptySnapshot } = require("../frontend/js/store.js");

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  - ${name}`); passed++; }
  catch (err) { console.log(`  FAIL - ${name}\n         ${err.stack || err.message}`); failed++; process.exitCode = 1; }
}

const HUMAN = { type: "human", id: "u1", name: "U" };

function defs() {
  return {
    ready: { global: [{ id: "g1", label: "G1", required: true }], byType: {} },
    done:  { global: [{ id: "d1", label: "D1", required: true }], byType: {} }
  };
}

function freshSnap() {
  return core.normalizeSnapshot({
    project: { id: "p1", name: "X", definitions: defs() }
  });
}

// ---------------------------------------------------------------------------
// Basics
// ---------------------------------------------------------------------------

test("constructor + get returns normalized snapshot", () => {
  const s = new ProjectStore(freshSnap());
  const snap = s.get();
  assert.strictEqual(snap.project.id, "p1");
  assert.strictEqual(snap.tickets.length, 0);
});

test("subscribe fires on commit", () => {
  const s = new ProjectStore(freshSnap());
  let calls = 0;
  let lastReason = null;
  s.subscribe((snap, reason) => { calls++; lastReason = reason; });
  s.createTicket({ type: "user-story", title: "A" }, HUMAN);
  assert.strictEqual(calls, 1);
  assert.strictEqual(lastReason, "createTicket");
});

test("subscribe unsubscribe stops further events", () => {
  const s = new ProjectStore(freshSnap());
  let calls = 0;
  const off = s.subscribe(() => calls++);
  s.createTicket({ type: "user-story", title: "A" }, HUMAN);
  off();
  s.createTicket({ type: "user-story", title: "B" }, HUMAN);
  assert.strictEqual(calls, 1);
});

// ---------------------------------------------------------------------------
// Op wrappers
// ---------------------------------------------------------------------------

test("createTicket via store adds to snapshot, commits undo entry", () => {
  const s = new ProjectStore(freshSnap());
  s.createTicket({ type: "user-story", title: "A" }, HUMAN);
  assert.strictEqual(s.get().tickets.length, 1);
  assert.strictEqual(s.canUndo(), true);
});

test("checkDorItem via store affects the frozen item", () => {
  const s = new ProjectStore(freshSnap());
  s.createTicket({ type: "user-story", title: "A" }, HUMAN);
  const ticketId = s.get().tickets[0].id;
  s.checkDorItem(ticketId, "g1", HUMAN);
  assert.strictEqual(s.get().tickets[0].definitionOfReady.items[0].checked, true);
});

// ---------------------------------------------------------------------------
// Undo / Redo
// ---------------------------------------------------------------------------

test("undo restores prior snapshot", () => {
  const s = new ProjectStore(freshSnap());
  s.createTicket({ type: "user-story", title: "A" }, HUMAN);
  const beforeId = s.get().tickets[0].id;
  s.createTicket({ type: "bug", title: "B" }, HUMAN);
  assert.strictEqual(s.get().tickets.length, 2);
  s.undo();
  assert.strictEqual(s.get().tickets.length, 1);
  assert.strictEqual(s.get().tickets[0].id, beforeId);
});

test("redo restores undone snapshot", () => {
  const s = new ProjectStore(freshSnap());
  s.createTicket({ type: "user-story", title: "A" }, HUMAN);
  s.createTicket({ type: "bug", title: "B" }, HUMAN);
  s.undo();
  assert.strictEqual(s.get().tickets.length, 1);
  assert.strictEqual(s.canRedo(), true);
  s.redo();
  assert.strictEqual(s.get().tickets.length, 2);
});

test("any new commit clears redo stack", () => {
  const s = new ProjectStore(freshSnap());
  s.createTicket({ type: "user-story", title: "A" }, HUMAN);
  s.createTicket({ type: "bug", title: "B" }, HUMAN);
  s.undo();
  s.createTicket({ type: "user-story", title: "C" }, HUMAN);
  assert.strictEqual(s.canRedo(), false);
});

// ---------------------------------------------------------------------------
// applySnapshot vs applyRemote vs hydrate — semantics
// ---------------------------------------------------------------------------

test("applySnapshot commits an undo entry", () => {
  const s = new ProjectStore(freshSnap());
  s.createTicket({ type: "user-story", title: "A" }, HUMAN);
  const beforeLen = s.get().tickets.length;
  // Replace whole snapshot via applySnapshot
  s.applySnapshot(freshSnap());
  assert.strictEqual(s.get().tickets.length, 0);
  // Undo brings the previous state back
  s.undo();
  assert.strictEqual(s.get().tickets.length, beforeLen);
});

test("applyRemote is a no-op when incoming equals current (undo stack untouched)", () => {
  const s = new ProjectStore(freshSnap());
  s.createTicket({ type: "user-story", title: "A" }, HUMAN);
  const beforePastLen = s._past.length;
  s.applyRemote(s.get());  // echo
  assert.strictEqual(s._past.length, beforePastLen, "applyRemote with identical snapshot should be a no-op");
});

test("applyRemote with different snapshot commits as undo entry", () => {
  const s = new ProjectStore(freshSnap());
  s.createTicket({ type: "user-story", title: "A" }, HUMAN);
  const beforePastLen = s._past.length;
  const otherSnap = core.normalizeSnapshot({
    project: { id: "p1", name: "X-changed" }, tickets: [], releases: [], processSteps: []
  });
  s.applyRemote(otherSnap);
  assert.ok(s._past.length > beforePastLen, "applyRemote should add to past stack");
  assert.strictEqual(s.canUndo(), true);
});

test("hydrate WIPES undo + redo stacks", () => {
  const s = new ProjectStore(freshSnap());
  s.createTicket({ type: "user-story", title: "A" }, HUMAN);
  s.createTicket({ type: "bug", title: "B" }, HUMAN);
  s.undo();
  assert.ok(s.canUndo());
  assert.ok(s.canRedo());
  s.hydrate(freshSnap());
  assert.strictEqual(s.canUndo(), false);
  assert.strictEqual(s.canRedo(), false);
});

// ---------------------------------------------------------------------------
// E18.B — Auto-Wrapper picks up every core.ops entry (verify updateProject)
// ---------------------------------------------------------------------------

test("store.updateProject patches header and commits an undo entry", () => {
  const s = new ProjectStore(freshSnap());
  s.updateProject({ name: "Renamed" }, HUMAN);
  assert.strictEqual(s.get().project.name, "Renamed");
  assert.strictEqual(s.canUndo(), true);
  s.undo();
  assert.strictEqual(s.get().project.name, "X");
});

test("subscribe receives the op-name as reason for store ops", () => {
  const s = new ProjectStore(freshSnap());
  const reasons = [];
  s.subscribe((_snap, reason) => reasons.push(reason));
  s.createTicket({ type: "user-story", title: "A" }, HUMAN);
  s.updateProject({ name: "Y" }, HUMAN);
  s.undo();
  assert.deepStrictEqual(reasons, ["createTicket", "updateProject", "undo"]);
});

test("changeStatusGated throws DoR error before committing (no undo entry)", () => {
  const s = new ProjectStore(freshSnap());
  s.createTicket({ type: "user-story", title: "A" }, HUMAN);
  const tid = s.get().tickets[0].id;
  const undoBefore = s._past.length;
  let caught = null;
  try { s.changeStatusGated(tid, "ready", HUMAN); }
  catch (e) { caught = e; }
  assert.ok(caught, "expected throw");
  assert.strictEqual(caught.kind, "DoR");
  assert.ok(Array.isArray(caught.missing));
  assert.strictEqual(s._past.length, undoBefore, "no commit on gate failure");
  assert.strictEqual(s.get().tickets[0].status, "backlog");
});

test("changeStatusGated commits when DoR is satisfied", () => {
  const s = new ProjectStore(freshSnap());
  s.createTicket({ type: "user-story", title: "A" }, HUMAN);
  const tid = s.get().tickets[0].id;
  s.checkDorItem(tid, "g1", HUMAN);
  s.changeStatusGated(tid, "ready", HUMAN);
  assert.strictEqual(s.get().tickets[0].status, "ready");
});

test("subscribe sees applyRemote reason (used as save-subscriber skip-key in E18.C)", () => {
  const s = new ProjectStore(freshSnap());
  const reasons = [];
  s.subscribe((_snap, reason) => reasons.push(reason));
  // applyRemote on a DIFFERENT snapshot to ensure it commits (no-op on identical).
  const other = core.normalizeSnapshot({ project: { id: "p1", name: "Y", definitions: defs() } });
  s.applyRemote(other);
  assert.deepStrictEqual(reasons, ["applyRemote"]);
});

// ---------------------------------------------------------------------------
// SM-220 — cheap signal echo-check in applyRemote
// ---------------------------------------------------------------------------
const { snapshotSignal } = require("../frontend/js/store.js");

test("SM-220: snapshotSignal differs after a real op (version bump) and matches on identical", () => {
  const s = new ProjectStore(freshSnap());
  s.createTicket({ type: "user-story", title: "A" }, HUMAN);
  const sig1 = snapshotSignal(s.get());
  // identical snapshot → identical signal
  assert.strictEqual(snapshotSignal(core.normalizeSnapshot(s.get())), sig1);
  // a real edit bumps the ticket version → signal changes
  s.updateTicket(s.get().tickets[0].id, { title: "B" }, HUMAN);
  assert.notStrictEqual(snapshotSignal(s.get()), sig1, "an edit must change the signal");
  // ticket count is part of the signal
  s.createTicket({ type: "bug", title: "C" }, HUMAN);
  assert.ok(snapshotSignal(s.get()).startsWith("2|"), "ticket count leads the signal");
});

test("SM-220: applyRemote on an identical (echo) snapshot is a no-op — no undo entry", () => {
  const s = new ProjectStore(freshSnap());
  s.createTicket({ type: "user-story", title: "A" }, HUMAN);
  const pastLen = s._past.length;
  const reasons = [];
  s.subscribe((_snap, reason) => reasons.push(reason));
  // a structurally identical snapshot (same versions, same content) → echo
  s.applyRemote(core.normalizeSnapshot(JSON.parse(JSON.stringify(s.get()))));
  assert.strictEqual(s._past.length, pastLen, "echo must NOT push an undo entry");
  assert.deepStrictEqual(reasons, [], "echo must NOT emit");
});

test("SM-220: applyRemote on a real change commits (signal-fast path)", () => {
  const s = new ProjectStore(freshSnap());
  s.createTicket({ type: "user-story", title: "A" }, HUMAN);
  const pastLen = s._past.length;
  const incoming = JSON.parse(JSON.stringify(s.get()));
  incoming.tickets[0].title = "Changed";
  incoming.tickets[0].version += 1;   // a real edit bumps version → signal differs
  s.applyRemote(incoming);
  assert.strictEqual(s._past.length, pastLen + 1, "a real change commits");
  assert.strictEqual(s.get().tickets[0].title, "Changed");
});

test("SM-220 (AC3): same metadata, different content → still detected as a change", () => {
  // The pathological collision: identical lengths AND identical versions, but
  // different content. The signal MATCHES, so only the deepEqual fallback can
  // catch it — it must commit, not silently no-op.
  const s = new ProjectStore(freshSnap());
  s.createTicket({ type: "user-story", title: "Original" }, HUMAN);
  const cur = s.get();
  const incoming = JSON.parse(JSON.stringify(cur));
  incoming.tickets[0].title = "Tampered";   // content differs…
  // …but version is left UNTOUCHED → snapshotSignal(incoming) === current signal
  assert.strictEqual(snapshotSignal(core.normalizeSnapshot(incoming)), s._signal,
    "test premise: the signal must collide for this to exercise the fallback");
  const pastLen = s._past.length;
  s.applyRemote(incoming);
  assert.strictEqual(s._past.length, pastLen + 1, "AC3: a real difference must commit even when the signal collides");
  assert.strictEqual(s.get().tickets[0].title, "Tampered");
});

test("SM-220: _signal stays in lockstep across commit / undo / redo / hydrate", () => {
  const s = new ProjectStore(freshSnap());
  s.createTicket({ type: "user-story", title: "A" }, HUMAN);
  assert.strictEqual(s._signal, snapshotSignal(s.get()), "after commit");
  s.undo();
  assert.strictEqual(s._signal, snapshotSignal(s.get()), "after undo");
  s.redo();
  assert.strictEqual(s._signal, snapshotSignal(s.get()), "after redo");
  s.hydrate(freshSnap());
  assert.strictEqual(s._signal, snapshotSignal(s.get()), "after hydrate");
});

test("SM-220: an echo arriving AFTER an undo is still a no-op (signal lockstep)", () => {
  const s = new ProjectStore(freshSnap());
  s.createTicket({ type: "user-story", title: "A" }, HUMAN);
  s.undo();   // back to the empty board; _signal must follow
  const reasons = [];
  s.subscribe((_snap, reason) => reasons.push(reason));
  s.applyRemote(core.normalizeSnapshot(JSON.parse(JSON.stringify(s.get()))));
  assert.deepStrictEqual(reasons, [], "echo of the post-undo state must NOT commit");
});

console.log(`\n  ${passed} passed, ${failed} failed`);
