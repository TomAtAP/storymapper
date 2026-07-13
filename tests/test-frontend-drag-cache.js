"use strict";

/**
 * SM-221 — drag-layout cache for the story-map renderer.
 *
 * During a drag, setDragProjection → _rerender → renderInto used to recompute
 * the O(Releases×Steps×Tickets) base layout on EVERY pointermove. Now the base
 * layout is computed once per snapshot and cached (keyed on the snapshot +
 * filter + matchTicket references); only the pure projection helpers run per
 * move. These tests pin: ≤1 base-compute per drag, cache invalidation on a
 * commit mid-drag, cache cleanup at drop/unmount, and unchanged projection DOM.
 */

const assert = require("assert");
const { JSDOM } = require("jsdom");

const dom = new JSDOM(`<!doctype html><html><body><div id="host"></div></body></html>`);
global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;

const core = require("../frontend/js/core.js");
const { ProjectStore } = require("../frontend/js/store.js");
const storymap = require("../frontend/js/renderer-storymap.js");

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  - ${name}`); passed++; }
  catch (err) { console.log(`  FAIL - ${name}\n         ${err.stack || err.message}`); failed++; process.exitCode = 1; }
}

const HUMAN = { type: "human", id: "u1", name: "U" };

// A board with one cell holding an epic with four stories — enough to drive
// story-reorder projections at distinct insertion indices.
function boardWithEpicAndStories() {
  const store = new ProjectStore(core.normalizeSnapshot({
    project: { id: "p1", name: "X", ticketPrefix: "P",
      definitions: {
        ready: { global: [{ id: "g1", label: "G1", required: true }], byType: {} },
        done:  { global: [{ id: "d1", label: "D1", required: true }], byType: {} }
      }
    }
  }));
  store.createRelease({ name: "v1.0" }, HUMAN);
  store.createProcessStep({ name: "Build" }, HUMAN);
  const rA = store.get().releases[0].id;
  const p1 = store.get().processSteps[0].id;
  store.createTicket({ type: "epic", title: "EpicA", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  const eA = store.get().tickets.find(t => t.title === "EpicA").id;
  for (const t of ["S0", "S1", "S2", "S3"]) {
    store.createTicket({ type: "user-story", title: t, position: { releaseId: rA, epicId: eA } }, HUMAN);
  }
  const s0 = store.get().tickets.find(t => t.title === "S0").id;
  return { store, eA, s0 };
}

function freshHost() {
  const host = document.getElementById("host");
  host.innerHTML = "";
  return host;
}

// ---------------------------------------------------------------------------

test("SM-221 (AC1): the base layout is computed ≤1× across many pointermoves of one drag", () => {
  const { store, eA, s0 } = boardWithEpicAndStories();
  const host = freshHost();
  const ctrl = storymap.mount(host, store);   // initial render populates the cache

  storymap._resetLayoutComputeCount();
  // Simulate a pointermove storm: distinct insertion indices so each move
  // really re-renders (the setDragProjection fast-path only short-circuits
  // identical projections).
  for (let k = 0; k <= 4; k++) {
    ctrl.setDragProjection({ ticketId: s0, target: { type: "epic", epicId: eA }, insertionIndex: k });
  }
  assert.ok(storymap._getLayoutComputeCount() <= 1,
    "computeStoryMapLayout must run ≤1× during a drag, got " + storymap._getLayoutComputeCount());

  // …and the re-renders genuinely happened: the projected shadow card exists.
  const shadow = host.querySelector(".sm-story-card.sm-card-shadow");
  assert.ok(shadow && shadow.textContent.includes("S0"), "the per-move projection still renders the shadow");
  ctrl();
});

test("SM-221 (AC1): the cached base layout object is REUSED across moves (reference-stable)", () => {
  const { store, eA, s0 } = boardWithEpicAndStories();
  const host = freshHost();
  const ctrl = storymap.mount(host, store);

  ctrl.setDragProjection({ ticketId: s0, target: { type: "epic", epicId: eA }, insertionIndex: 1 });
  const layout1 = storymap._peekBaseLayoutCache().layout;
  ctrl.setDragProjection({ ticketId: s0, target: { type: "epic", epicId: eA }, insertionIndex: 3 });
  const layout2 = storymap._peekBaseLayoutCache().layout;
  assert.strictEqual(layout1, layout2, "same snapshot → the base layout object is reused, not rebuilt");
  ctrl();
});

test("SM-221 (AC3): a store commit mid-drag invalidates the cache (recomputed for the new snapshot)", () => {
  const { store, eA, s0 } = boardWithEpicAndStories();
  const host = freshHost();
  const ctrl = storymap.mount(host, store);

  ctrl.setDragProjection({ ticketId: s0, target: { type: "epic", epicId: eA }, insertionIndex: 1 });
  const snapDuringDrag = store.get();
  assert.strictEqual(storymap._peekBaseLayoutCache().snap, snapDuringDrag, "cache holds the drag-start snapshot");

  storymap._resetLayoutComputeCount();
  // A WS-push / local commit during the drag → new snapshot reference.
  store.updateTicket(s0, { title: "S0-renamed" }, HUMAN);
  assert.notStrictEqual(store.get(), snapDuringDrag, "the commit produced a new snapshot");
  assert.strictEqual(storymap._peekBaseLayoutCache().snap, store.get(),
    "cache must be rebuilt for the post-commit snapshot");
  assert.ok(storymap._getLayoutComputeCount() >= 1, "a recompute happened after the commit");
  ctrl();
});

test("SM-221 (AC4): drop (clearDragProjection) recomputes exactly once and leaves no stale shadow", () => {
  const { store, eA, s0 } = boardWithEpicAndStories();
  const host = freshHost();
  const ctrl = storymap.mount(host, store);

  ctrl.setDragProjection({ ticketId: s0, target: { type: "epic", epicId: eA }, insertionIndex: 2 });
  assert.ok(host.querySelector(".sm-card-shadow"), "shadow present during drag");

  storymap._resetLayoutComputeCount();
  ctrl.clearDragProjection();   // drop: cache cleared, then ONE recompute ("Recalc erst beim Drop")
  assert.strictEqual(storymap._getLayoutComputeCount(), 1, "exactly one recompute at drop");
  assert.strictEqual(storymap._peekBaseLayoutCache().snap, store.get(), "drop render recomputed for the current snapshot");
  assert.strictEqual(host.querySelector(".sm-card-shadow"), null, "no stale shadow card after drop");
  ctrl();
});

test("SM-221 (AC4): unmount drops the cache (no stale layout leaks into the next mount)", () => {
  const { store, eA, s0 } = boardWithEpicAndStories();
  const host = freshHost();
  const ctrl = storymap.mount(host, store);
  ctrl.setDragProjection({ ticketId: s0, target: { type: "epic", epicId: eA }, insertionIndex: 1 });
  assert.ok(storymap._peekBaseLayoutCache() !== null, "cache populated during drag");
  ctrl();   // unmount
  assert.strictEqual(storymap._peekBaseLayoutCache(), null, "unmount nulls the cache");
});

test("SM-221 (AC2): projection on the cached base layout is DOM-equivalent to a freshly projected layout", () => {
  const { store, eA, s0 } = boardWithEpicAndStories();
  const host = freshHost();
  const ctrl = storymap.mount(host, store);

  // Cached path: render with the projection active.
  ctrl.setDragProjection({ ticketId: s0, target: { type: "epic", epicId: eA }, insertionIndex: 2 });
  const cachedHtml = host.innerHTML;

  // Fresh path: same snapshot, same projection, but force a from-scratch
  // base-layout compute by invalidating the cache (a commit-free new render).
  // We drop the cache via unmount+remount so renderInto rebuilds the base.
  ctrl();
  const ctrl2 = storymap.mount(host, store);
  ctrl2.setDragProjection({ ticketId: s0, target: { type: "epic", epicId: eA }, insertionIndex: 2 });
  const freshHtml = host.innerHTML;

  assert.strictEqual(cachedHtml, freshHtml,
    "cached-base projection must render byte-identical DOM to a freshly-computed base");
  ctrl2();
});

// ---------------------------------------------------------------------------
// SM-223 (d) — drag-incremental DOM update.
//
// SM-221 removed the layout recompute per pointermove, but the dragMove
// benchmark showed the REAL per-move cost is renderInto building a fresh full
// grid + Phase-C morphing all cards (~200ms at N=500). Mid-drag, only the
// affected containers may be rebuilt + morphed; the full grid build is
// skipped. The result DOM must be IDENTICAL to the full-render path.
// ---------------------------------------------------------------------------

// Two cells (two process steps), each with an epic; epic A holds 4 stories.
// Enough to drive story-reorder, cross-epic, cell-loose and epic-cell drags.
function boardWithTwoCells() {
  const store = new ProjectStore(core.normalizeSnapshot({
    project: { id: "p2", name: "X", ticketPrefix: "P" }
  }));
  store.createRelease({ name: "v1.0" }, HUMAN);
  store.createProcessStep({ name: "Build" }, HUMAN);
  store.createProcessStep({ name: "Ship" }, HUMAN);
  const rA = store.get().releases[0].id;
  const p1 = store.get().processSteps[0].id;
  const p2 = store.get().processSteps[1].id;
  store.createTicket({ type: "epic", title: "EpicA", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  store.createTicket({ type: "epic", title: "EpicB", position: { releaseId: rA, processStepId: p2 } }, HUMAN);
  const eA = store.get().tickets.find(t => t.title === "EpicA").id;
  const eB = store.get().tickets.find(t => t.title === "EpicB").id;
  for (const t of ["S0", "S1", "S2", "S3"]) {
    store.createTicket({ type: "user-story", title: t, position: { releaseId: rA, epicId: eA } }, HUMAN);
  }
  const s0 = store.get().tickets.find(t => t.title === "S0").id;
  return { store, rA, p1, p2, eA, eB, s0 };
}

test("SM-223 (d): mid-drag projection updates skip the full grid build", () => {
  const { store, eA, s0 } = boardWithTwoCells();
  const host = freshHost();
  const ctrl = storymap.mount(host, store);
  // Drag start: first projection may take the full path once.
  ctrl.setDragProjection({ ticketId: s0, target: { type: "epic", epicId: eA }, insertionIndex: 0 });
  storymap._resetGridBuildCount();
  for (let k = 1; k <= 3; k++) {
    ctrl.setDragProjection({ ticketId: s0, target: { type: "epic", epicId: eA }, insertionIndex: k });
  }
  assert.strictEqual(storymap._getGridBuildCount(), 0,
    "no full grid build during mid-drag projection updates");
  // The live preview still works: exactly one shadow card in the epic grid.
  const shadows = host.querySelectorAll(".sm-card-shadow");
  assert.strictEqual(shadows.length, 1, "shadow card present after incremental updates");
  ctrl.clearDragProjection();
  ctrl();
});

test("SM-223 (d): incremental story-reorder DOM is identical to the full-render DOM", () => {
  const { store, eA, s0 } = boardWithTwoCells();
  const host = freshHost();
  const ctrl = storymap.mount(host, store);
  ctrl.setDragProjection({ ticketId: s0, target: { type: "epic", epicId: eA }, insertionIndex: 0 });
  ctrl.setDragProjection({ ticketId: s0, target: { type: "epic", epicId: eA }, insertionIndex: 2 });
  const incremental = host.innerHTML;
  storymap._rerenderForTests();          // full build + morph with the same projection
  assert.strictEqual(host.innerHTML, incremental,
    "incremental DOM must equal the full-render DOM (story reorder)");
  ctrl.clearDragProjection();
  ctrl();
});

test("SM-223 (d): incremental cross-epic + cell-loose DOM is identical to full render", () => {
  const { store, rA, p2, eA, eB, s0 } = boardWithTwoCells();
  const host = freshHost();
  const ctrl = storymap.mount(host, store);
  // story onto the OTHER epic (different cell)…
  ctrl.setDragProjection({ ticketId: s0, target: { type: "epic", epicId: eA }, insertionIndex: 1 });
  ctrl.setDragProjection({ ticketId: s0, target: { type: "epic", epicId: eB }, insertionIndex: 0 });
  let incremental = host.innerHTML;
  storymap._rerenderForTests();
  assert.strictEqual(host.innerHTML, incremental, "cross-epic projection DOM identical");
  // …then onto the cell's loose column.
  ctrl.setDragProjection({ ticketId: s0, target: { type: "cell", releaseId: rA, processStepId: p2 }, insertionIndex: 0 });
  incremental = host.innerHTML;
  storymap._rerenderForTests();
  assert.strictEqual(host.innerHTML, incremental, "cell-loose projection DOM identical");
  ctrl.clearDragProjection();
  ctrl();
});

test("SM-223 (d): incremental epic-on-cell drag (cell-epics, incl. home cell) DOM identical", () => {
  const { store, rA, p1, p2, eA } = boardWithTwoCells();
  const host = freshHost();
  const ctrl = storymap.mount(host, store);
  ctrl.setDragProjection({ ticketId: eA, target: { type: "cell-epics", releaseId: rA, processStepId: p1 }, insertionIndex: 0 });
  ctrl.setDragProjection({ ticketId: eA, target: { type: "cell-epics", releaseId: rA, processStepId: p2 }, insertionIndex: 1 });
  const incremental = host.innerHTML;
  storymap._rerenderForTests();
  assert.strictEqual(host.innerHTML, incremental,
    "epic-on-cell projection DOM identical (target + home cell rebuilt)");
  ctrl.clearDragProjection();
  ctrl();
});

test("SM-223 (d): backlog projection target DOM identical to full render", () => {
  const { store, eA, s0 } = boardWithTwoCells();
  const host = freshHost();
  const ctrl = storymap.mount(host, store);
  ctrl.setDragProjection({ ticketId: s0, target: { type: "epic", epicId: eA }, insertionIndex: 0 });
  ctrl.setDragProjection({ ticketId: s0, target: { type: "backlog" }, insertionIndex: 0 });
  const incremental = host.innerHTML;
  storymap._rerenderForTests();
  assert.strictEqual(host.innerHTML, incremental, "backlog projection DOM identical");
  ctrl.clearDragProjection();
  ctrl();
});

test("SM-223 (d): a Phase-A/B fast-path commit mid-drag forces the full path (no stale revert)", () => {
  // Review finding: Phase A (sort-only) and Phase B (content-only) handle
  // applyRemote commits WITHOUT renderInto — currentSnapshot and the layout
  // cache stay stale together. The incremental guard must check the STORE's
  // snapshot, or the next projection morph visually reverts the remote change.
  const { store, eA, s0 } = boardWithTwoCells();
  const host = freshHost();
  const ctrl = storymap.mount(host, store);
  ctrl.setDragProjection({ ticketId: s0, target: { type: "epic", epicId: eA }, insertionIndex: 0 });

  // Remote content-edit mid-drag (Phase-B shape: title change, no reorder).
  const remote = JSON.parse(JSON.stringify(store.get()));
  const s1 = remote.tickets.find(t => t.title === "S1");
  s1.title = "S1-remote-edit";
  s1.version = (s1.version || 1) + 1;
  store.applyRemote(remote);
  assert.ok(host.textContent.includes("S1-remote-edit"), "Phase-B patched the card in place");

  // Next projection move: must NOT take the incremental path on the stale base.
  storymap._resetGridBuildCount();
  ctrl.setDragProjection({ ticketId: s0, target: { type: "epic", epicId: eA }, insertionIndex: 2 });
  assert.ok(storymap._getGridBuildCount() >= 1,
    "post-commit projection must take the full path (cache is stale)");
  assert.ok(host.textContent.includes("S1-remote-edit"),
    "the remote edit must survive the projection render (no stale revert)");
  // …and subsequent moves are incremental again (cache rebuilt for new snap).
  storymap._resetGridBuildCount();
  ctrl.setDragProjection({ ticketId: s0, target: { type: "epic", epicId: eA }, insertionIndex: 3 });
  assert.strictEqual(storymap._getGridBuildCount(), 0, "incremental resumes on the fresh base");
  ctrl.clearDragProjection();
  ctrl();
});

test("SM-223 (d): process-step projection falls back to the full path", () => {
  const { store, p1, p2 } = boardWithTwoCells();
  const host = freshHost();
  const ctrl = storymap.mount(host, store);
  ctrl.setDragProjection({ ticketId: p1, target: { type: "process-step", beforeId: p2 }, insertionIndex: 0 });
  storymap._resetGridBuildCount();
  ctrl.setDragProjection({ ticketId: p1, target: { type: "process-step", beforeId: null }, insertionIndex: 0 });
  assert.ok(storymap._getGridBuildCount() >= 1,
    "process-step projections keep the (correct) full-render path");
  ctrl.clearDragProjection();
  ctrl();
});

console.log(`\n  ${passed} passed, ${failed} failed`);
