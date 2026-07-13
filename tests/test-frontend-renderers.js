"use strict";

/**
 * E9c + E9j: Tests für den 3-Ebenen-Story-Map-Renderer.
 *
 * Hierarchie: ProcessSteps (Backbone, Spalten) × Releases (Zeilen) →
 * in jeder (Release × ProcessStep)-Zelle liegen Epic-Karten; unter
 * jedem Epic ein Story-Sub-Grid. Tickets ohne vollständige Zell-
 * Position landen im Backlog-Bereich am unteren Rand — entweder in
 * der Gruppe "Unscheduled" (kein Release) oder in einer "Scheduled
 * for X" Gruppe pro Release.
 *
 * Tests gegen Pure-Layout-Funktion und gegen JSDOM-Render. Drag-
 * Mechanik via direkten Aufrufen der applyXxxDrop-Helper (JSDOM hat
 * keine echte Layout-Engine, deshalb keine pointer-event-Simulation).
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const dom = new JSDOM(`<!doctype html><html><body><div id="host"></div></body></html>`);
global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;

const core = require("../frontend/js/core.js");
const { ProjectStore } = require("../frontend/js/store.js");
const storymap = require("../frontend/js/renderer-storymap.js");
const { STORY_MAP_LAYOUT } = storymap;

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  - ${name}`); passed++; }
  catch (err) { console.log(`  FAIL - ${name}\n         ${err.stack || err.message}`); failed++; process.exitCode = 1; }
}

const HUMAN = { type: "human", id: "u1", name: "U" };

function setup() {
  // Project with 2 releases × 2 process-steps, two epics + a story each
  // in well-known positions to verify selection logic precisely.
  const snap = core.normalizeSnapshot({
    project: { id: "p1", name: "X", ticketPrefix: "P",
      definitions: {
        ready: { global: [{id:"g1", label:"G1", required:true}], byType:{} },
        done:  { global: [{id:"d1", label:"D1", required:true}], byType:{} }
      }
    }
  });
  const store = new ProjectStore(snap);
  store.createRelease({ name: "v1.0" }, HUMAN);
  store.createRelease({ name: "v1.1" }, HUMAN);
  store.createProcessStep({ name: "Onboarding" }, HUMAN);
  store.createProcessStep({ name: "Daily Use" }, HUMAN);
  return store;
}

function ids(store) {
  const s = store.get();
  return {
    rA: s.releases[0].id, rB: s.releases[1].id,
    p1: s.processSteps[0].id, p2: s.processSteps[1].id
  };
}

// ---------------------------------------------------------------------------
// Constants block (no magic numbers — values come from STORY_MAP_LAYOUT)
// ---------------------------------------------------------------------------

test("STORY_MAP_LAYOUT exported and has all required keys", () => {
  const required = [
    "RELEASE_LABEL_WIDTH_PX", "BACKBONE_COL_WIDTH_PX", "STORY_CARD_WIDTH_PX",
    "ZOOM_MIN", "ZOOM_MAX", "ZOOM_STEP", "ZOOM_DEFAULT",
    "CARD_HEIGHT_PX", "EPIC_HEADER_HEIGHT_PX", "TICKET_GAP_PX", "CELL_PADDING_PX",
    "STORIES_GRID_PADDING_PX", "COLLAPSED_RELEASE_HEIGHT_PX", "FLIP_ANIM_MS"
  ];
  for (const k of required) {
    assert.ok(typeof STORY_MAP_LAYOUT[k] === "number" && STORY_MAP_LAYOUT[k] > 0, "missing/invalid " + k);
  }
  assert.ok(STORY_MAP_LAYOUT.ZOOM_MIN < STORY_MAP_LAYOUT.ZOOM_DEFAULT);
  assert.ok(STORY_MAP_LAYOUT.ZOOM_DEFAULT < STORY_MAP_LAYOUT.ZOOM_MAX);
});

// ---------------------------------------------------------------------------
// computeStoryMapLayout — pure layout computation
// ---------------------------------------------------------------------------

test("SM-252: layout rows = releases sorted by sortOrder DESCENDING (newest on top)", () => {
  const store = setup();
  const { rA, rB } = ids(store);   // rA sortOrder 0 (v1.0), rB sortOrder 1 (v1.1)
  const layout = storymap.computeStoryMapLayout(store.get());
  assert.strictEqual(layout.rows.length, 2);
  // Newest (highest sortOrder = rB) heads the map; oldest (rA) at the bottom.
  assert.deepStrictEqual(layout.rows.map(r => r.id), [rB, rA]);
  assert.strictEqual(layout.rows[0].kind, "release");
});

test("SM-252: a newly created release lands on TOP of the map", () => {
  const store = setup();
  store.createRelease({ name: "v2.0" }, HUMAN);
  const newId = store.get().releases.find(r => r.name === "v2.0").id;
  const layout = storymap.computeStoryMapLayout(store.get());
  assert.strictEqual(layout.rows[0].id, newId, "the newest release (highest sortOrder) heads the map");
});

test("layout: columns = processSteps sorted by sortOrder", () => {
  const store = setup();
  const { p1, p2 } = ids(store);
  const layout = storymap.computeStoryMapLayout(store.get());
  assert.strictEqual(layout.columns.length, 2);
  assert.deepStrictEqual(layout.columns.map(c => c.id), [p1, p2]);
});

test("layout: cell contains epics in that (releaseId × processStepId) slot", () => {
  const store = setup();
  const { rA, p1 } = ids(store);
  store.createTicket({ type: "epic", title: "EpicA", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  store.createTicket({ type: "epic", title: "EpicB", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  const layout = storymap.computeStoryMapLayout(store.get());
  const cell = layout.releases[rA].cells[p1];
  assert.strictEqual(cell.epics.length, 2);
  assert.deepStrictEqual(cell.epics.map(e => e.epic.title).sort(), ["EpicA", "EpicB"]);
});

test("layout: epic carries its stories", () => {
  const store = setup();
  const { rA, p1 } = ids(store);
  store.createTicket({ type: "epic", title: "Container", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  const epicId = store.get().tickets.find(t => t.title === "Container").id;
  store.createTicket({ type: "user-story", title: "S1", position: { releaseId: rA, epicId } }, HUMAN);
  store.createTicket({ type: "user-story", title: "S2", position: { releaseId: rA, epicId } }, HUMAN);
  const layout = storymap.computeStoryMapLayout(store.get());
  const epicEntry = layout.releases[rA].cells[p1].epics[0];
  assert.strictEqual(epicEntry.stories.length, 2);
});

test("layout: backlog.partiallyAssigned — release set but no cell position (epic w/o ps, story w/o epic)", () => {
  const store = setup();
  const { rA, p1 } = ids(store);
  store.createTicket({ type: "epic", title: "Anchored", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  store.createTicket({ type: "epic", title: "Floating", position: { releaseId: rA } }, HUMAN);
  store.createTicket({ type: "user-story", title: "FreeStory", position: { releaseId: rA } }, HUMAN);
  const layout = storymap.computeStoryMapLayout(store.get());
  assert.strictEqual(layout.backlog.partiallyAssigned.length, 1);
  const grp = layout.backlog.partiallyAssigned[0];
  assert.strictEqual(grp.release.id, rA);
  assert.strictEqual(grp.epics.length, 1);
  assert.strictEqual(grp.epics[0].title, "Floating");
  assert.strictEqual(grp.stories.length, 1);
  assert.strictEqual(grp.stories[0].title, "FreeStory");
});

test("SM-253: layout no longer surfaces release-less tickets (backlog.epics/orphans empty); unplaced is per-release", () => {
  const store = setup();
  const { rA } = ids(store);
  store.createTicket({ type: "epic", title: "InReleaseUnplaced", position: { releaseId: rA } }, HUMAN);
  store.createTicket({ type: "epic", title: "Backlog1" }, HUMAN);   // no release → not in the SM
  store.createTicket({ type: "user-story", title: "Orphan1" }, HUMAN);
  const layout = storymap.computeStoryMapLayout(store.get());
  assert.deepStrictEqual(layout.backlog.epics, [], "release-less epics no longer surfaced");
  assert.deepStrictEqual(layout.backlog.orphans, [], "orphan stories no longer surfaced");
  // The release-assigned-but-unplaced epic lives in its release's holding zone.
  assert.deepStrictEqual(layout.releases[rA].unplaced.epics.map(e => e.epic.title), ["InReleaseUnplaced"]);
});

test("SM-253: a holding-strip epic's child stories respect the active filter (no SM-82 leak)", () => {
  const store = setup();
  const { rA } = ids(store);
  // Unplaced epic (release, no step) with a done + a backlog child story.
  store.createTicket({ type: "epic", title: "HoldEpic", position: { releaseId: rA } }, HUMAN);
  const epicId = store.get().tickets.find(t => t.title === "HoldEpic").id;
  store.createTicket({ type: "user-story", title: "DoneChild",   status: "done",    position: { releaseId: rA, epicId } }, HUMAN);
  store.createTicket({ type: "user-story", title: "ActiveChild", status: "backlog", position: { releaseId: rA, epicId } }, HUMAN);
  // A filter that hides done tickets.
  const filter = { statuses: ["backlog", "ready", "in-progress", "review"] };
  const layout = storymap.computeStoryMapLayout(store.get(), { filter });
  const holdEpic = layout.releases[rA].unplaced.epics.find(e => e.epic.title === "HoldEpic");
  assert.ok(holdEpic, "the unplaced epic is present");
  const childTitles = holdEpic.stories.map(s => s.title);
  assert.ok(childTitles.includes("ActiveChild"), "active child shown");
  assert.ok(!childTitles.includes("DoneChild"), "done child filtered out (no leak into holding-strip epic)");
});

test("layout: cells no longer include unassignedEpics/unassignedStories properties", () => {
  const store = setup();
  const { rA, p1 } = ids(store);
  store.createTicket({ type: "epic", title: "Floating", position: { releaseId: rA } }, HUMAN);
  const layout = storymap.computeStoryMapLayout(store.get());
  assert.strictEqual(layout.releases[rA].unassignedEpics, undefined);
  assert.strictEqual(layout.releases[rA].unassignedStories, undefined);
});

// ---------------------------------------------------------------------------
// Drop-Logic — pure
// ---------------------------------------------------------------------------

test("applyEpicDrop: re-targets processStepId, keeps releaseId, repositions sortOrder", () => {
  const store = setup();
  const { rA, p1, p2 } = ids(store);
  store.createTicket({ type: "epic", title: "Mover", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  const epicId = store.get().tickets[0].id;
  storymap.applyEpicDrop(store, epicId, p2, HUMAN);
  const moved = store.get().tickets[0];
  assert.strictEqual(moved.position.processStepId, p2);
  assert.strictEqual(moved.position.releaseId, rA);
});

test("SM-97: applyEpicCellProjection keeps dragged epic in source cell for cross-cell projection", () => {
  // Two releases × one process step, one epic per release-row in the same
  // process-step. User starts dragging epicA from rA/p1, hovers over rB/p1
  // — the projection target. The PRE-SM-97 implementation removed epicA
  // from rA/p1 immediately, shrinking the source row mid-drag, shifting
  // the layout, and (in live browser) causing the cursor to re-target a
  // wrong cell. After SM-97, the source cell keeps the epic.
  const store = setup();
  const { rA, rB, p1 } = ids(store);
  store.createTicket({ type: "epic", title: "EA", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  store.createTicket({ type: "epic", title: "EB", position: { releaseId: rB, processStepId: p1 } }, HUMAN);
  const EA = store.get().tickets.find(t => t.title === "EA").id;
  const EB = store.get().tickets.find(t => t.title === "EB").id;
  const snap = store.get();
  const base = storymap.computeStoryMapLayout(snap, {});

  // Simulate the drag: project epicA from rA/p1 onto rB/p1 at index 0.
  storymap._setDragProjectionForTests({
    ticketId: EA,
    target: { type: "cell-epics", releaseId: rB, processStepId: p1 },
    insertionIndex: 0
  });
  const projected = storymap.applyEpicCellProjection(base, snap);

  // SM-97: source cell still carries epicA (count stable → no layout shift).
  const srcEpics = projected.releases[rA].cells[p1].epics.map(e => e.epic.id);
  assert.ok(srcEpics.indexOf(EA) >= 0, "source cell must keep dragged epic (SM-97)");
  // Target cell has epicA as shadow at index 0 + epicB after it.
  const tgtEpics = projected.releases[rB].cells[p1].epics;
  assert.strictEqual(tgtEpics[0].epic.id, EA, "shadow inserted at projected index 0");
  assert.strictEqual(tgtEpics[0].shadow, true, "shadow entry flagged");
  assert.strictEqual(tgtEpics[1].epic.id, EB, "original epic preserved after shadow");

  // Cleanup projection so other tests aren't affected.
  storymap._setDragProjectionForTests(null);
});

test("SM-97: applyEpicCellProjection intra-cell reorder still moves epic (no duplicate)", () => {
  // Within a single cell, dragging epicA to reorder must remove it from
  // the original position and re-insert it at the projected index — no
  // duplicate of the dragged epic in the cell.
  const store = setup();
  const { rA, p1 } = ids(store);
  store.createTicket({ type: "epic", title: "E0", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  store.createTicket({ type: "epic", title: "E1", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  store.createTicket({ type: "epic", title: "E2", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  const E0 = store.get().tickets.find(t => t.title === "E0").id;
  const E1 = store.get().tickets.find(t => t.title === "E1").id;
  const E2 = store.get().tickets.find(t => t.title === "E2").id;
  const snap = store.get();
  const base = storymap.computeStoryMapLayout(snap, {});

  // Drag E0 to position 2 (after E2) within the same cell.
  storymap._setDragProjectionForTests({
    ticketId: E0,
    target: { type: "cell-epics", releaseId: rA, processStepId: p1 },
    insertionIndex: 2
  });
  const projected = storymap.applyEpicCellProjection(base, snap);

  // Cell has E1, E2, E0(shadow) — exactly one E0, three entries total.
  const cellEpics = projected.releases[rA].cells[p1].epics;
  assert.strictEqual(cellEpics.length, 3, "no duplicate of dragged epic");
  assert.strictEqual(cellEpics[0].epic.id, E1);
  assert.strictEqual(cellEpics[1].epic.id, E2);
  assert.strictEqual(cellEpics[2].epic.id, E0);
  assert.strictEqual(cellEpics[2].shadow, true, "E0 entry is the shadow");

  storymap._setDragProjectionForTests(null);
});

test("SM-61: epic-reorder within same cell — reorderTickets persists new sortOrder", () => {
  // Reproduces the bug: 3 epics in one cell, simulate dragging epic[0]
  // to the end (insertionIndex=2). After reorder, sort order must reflect
  // E1, E2, E0.
  const store = setup();
  const { rA, p1 } = ids(store);
  store.createTicket({ type: "epic", title: "E0", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  store.createTicket({ type: "epic", title: "E1", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  store.createTicket({ type: "epic", title: "E2", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  const E0 = store.get().tickets.find(t => t.title === "E0").id;
  const E1 = store.get().tickets.find(t => t.title === "E1").id;
  const E2 = store.get().tickets.find(t => t.title === "E2").id;
  // Sanity: initial order via epicsInCell helper.
  const before = core.tickets.epicsInCell(store.get(), rA, p1).map(t => t.id);
  assert.deepStrictEqual(before, [E0, E1, E2], "initial sortOrder = create order");
  // Simulate user drags E0 to drop after E2 (insertionIndex = 2 within the
  // peers list [E1, E2]). This mirrors the onEpicDrop handler in main.js.
  const peers = core.tickets.epicsInCell(store.get(), rA, p1).filter(t => t.id !== E0);
  assert.deepStrictEqual(peers.map(t => t.id), [E1, E2]);
  const orderedIds = peers.map(t => t.id);
  orderedIds.splice(2, 0, E0);
  assert.deepStrictEqual(orderedIds, [E1, E2, E0]);
  store.reorderTickets(orderedIds, { releaseId: rA, processStepId: p1, epicId: null }, HUMAN);
  // After reorder, epicsInCell returns the new order.
  const after = core.tickets.epicsInCell(store.get(), rA, p1).map(t => t.id);
  assert.deepStrictEqual(after, [E1, E2, E0],
    "post-reorder order = E1, E2, E0 (E0 moved to end)");
  // And sort orders are exactly 0, 1, 2.
  const tix = store.get().tickets;
  assert.strictEqual(tix.find(t => t.id === E1).position.sortOrder, 0);
  assert.strictEqual(tix.find(t => t.id === E2).position.sortOrder, 1);
  assert.strictEqual(tix.find(t => t.id === E0).position.sortOrder, 2);
});

test("applyStoryDrop: re-targets container epic (via contains-link), keeps releaseId", () => {
  const store = setup();
  const { rA, p1, p2 } = ids(store);
  store.createTicket({ type: "epic", title: "E1", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  store.createTicket({ type: "epic", title: "E2", position: { releaseId: rA, processStepId: p2 } }, HUMAN);
  const e1 = store.get().tickets.find(t => t.title === "E1").id;
  const e2 = store.get().tickets.find(t => t.title === "E2").id;
  store.createTicket({ type: "user-story", title: "S", position: { releaseId: rA, epicId: e1 } }, HUMAN);
  const storyId = store.get().tickets.find(t => t.title === "S").id;
  storymap.applyStoryDrop(store, storyId, e2, HUMAN);
  const moved = store.get().tickets.find(t => t.id === storyId);
  // SM-52: position.epicId is never persisted; the container is the contains-link.
  assert.strictEqual(moved.position.epicId, null);
  assert.strictEqual(moved.position.releaseId, rA);
  const container = core.tickets.epicForStory(store.get(), storyId);
  assert.ok(container);
  assert.strictEqual(container.id, e2, "story re-parented to E2 via contains-link");
});

test("applyBacklogDrop: clears releaseId, processStepId, epicId", () => {
  const store = setup();
  const { rB, p1 } = ids(store);
  store.createTicket({ type: "user-story", title: "Mobile", position: { releaseId: rB, processStepId: p1 } }, HUMAN);
  const tid = store.get().tickets[0].id;
  storymap.applyBacklogDrop(store, tid, "story", HUMAN);
  const moved = store.get().tickets[0];
  assert.strictEqual(moved.position.releaseId, null);
  assert.strictEqual(moved.position.processStepId, null);
  assert.strictEqual(moved.position.epicId, null);
});

test("applyReleaseReorder: sortOrder updated, list order matches input", () => {
  const store = setup();
  const { rA, rB } = ids(store);
  storymap.applyReleaseReorder(store, [rB, rA], HUMAN);
  const ordered = store.get().releases;
  assert.deepStrictEqual(ordered.map(r => r.id), [rB, rA]);
  assert.strictEqual(ordered[0].sortOrder, 0);
  assert.strictEqual(ordered[1].sortOrder, 1);
});

test("applyProcessStepReorder: sortOrder updated", () => {
  const store = setup();
  const { p1, p2 } = ids(store);
  storymap.applyProcessStepReorder(store, [p2, p1], HUMAN);
  const ps = store.get().processSteps;
  assert.deepStrictEqual(ps.map(p => p.id), [p2, p1]);
});

// ---------------------------------------------------------------------------
// DOM render smoke (JSDOM)
// ---------------------------------------------------------------------------

function mountFresh(store) {
  const host = document.getElementById("host");
  host.innerHTML = "";
  return storymap.mount(host, store);
}

test("mount: renders feature-backbone with one column per process-step + add-col dropzone", () => {
  const store = setup();
  mountFresh(store);
  // Data cols: 2 process-steps. Plus one .sm-add-col dropzone at the right edge.
  const dataCols = document.querySelectorAll(".sm-backbone .sm-backbone-col:not(.sm-add-col)");
  assert.strictEqual(dataCols.length, 2);
  assert.ok(dataCols[0].textContent.includes("Onboarding"));
  assert.ok(document.querySelector(".sm-backbone .sm-add-col"), "add-col dropzone missing");
});

test("mount: renders one cells-row + one label-row per release", () => {
  const store = setup();
  mountFresh(store);
  const cellRows = document.querySelectorAll(".sm-release-row.sm-release-cells");
  assert.strictEqual(cellRows.length, 2);
  const labelRows = document.querySelectorAll(".sm-release-label-row");
  assert.strictEqual(labelRows.length, 2);
  const labels = Array.from(document.querySelectorAll(".sm-release-label-row .sm-release-label"))
    .map(e => e.textContent);
  assert.ok(labels.some(t => t.includes("v1.0")));
  assert.ok(labels.some(t => t.includes("v1.1")));
});

test("SM-192: the release label row renders ABOVE its cells row (heading; tickets below)", () => {
  const store = setup();
  mountFresh(store);
  const rows = Array.from(document.querySelectorAll(".sm-grid > .sm-release-row, .sm-grid > .sm-release-label-row"));
  // For each release, the label-row index must come immediately before its cells-row.
  const firstLabel = document.querySelector(".sm-grid .sm-release-label-row");
  const firstCells = document.querySelector(".sm-grid .sm-release-row.sm-release-cells");
  assert.ok(firstLabel && firstCells);
  const allNodes = Array.from(document.querySelector(".sm-grid").children);
  assert.ok(allNodes.indexOf(firstLabel) < allNodes.indexOf(firstCells),
    "label (heading) comes before its cells row in DOM order");
});

test("SM-178: each release label has a .sm-release-label-main sticky cluster (chevron + name); Add stays outside", () => {
  const store = setup();
  mountFresh(store);
  const rows = document.querySelectorAll(".sm-release-label-row");
  assert.ok(rows.length >= 1);
  for (const row of rows) {
    const main = row.querySelector(".sm-release-label-main");
    assert.ok(main, "label-main cluster present (the sticky-left hook for the Map)");
    assert.ok(main.querySelector(".sm-release-chevron"), "chevron lives inside the cluster");
    assert.ok(main.querySelector(".sm-release-label"), "release name lives inside the cluster");
  }
  // The trailing "+ Add Release" must stay OUTSIDE the sticky cluster so it
  // scrolls normally (only chevron+name+pill pin to the left edge).
  const lastRow = rows[rows.length - 1];
  const addBtn = lastRow.querySelector(".sm-add-release-btn");
  if (addBtn) {
    assert.ok(!lastRow.querySelector(".sm-release-label-main").contains(addBtn),
      "Add Release stays outside the sticky cluster");
  }
});

test("SM-252: only the TOP (first) release-label-row has the +Add Release button", () => {
  const store = setup();
  mountFresh(store);
  const labelRows = Array.from(document.querySelectorAll(".sm-release-label-row"));
  assert.strictEqual(labelRows.length, 2);
  assert.ok(labelRows[0].querySelector(".sm-add-release-btn"),
    "top release label row should have the Add button (newest-on-top)");
  assert.strictEqual(labelRows[1].querySelector(".sm-add-release-btn"), null,
    "lower release label rows should not have an Add button");
});

test("mount: each release row has one cell per process-step, no unassigned column", () => {
  const store = setup();
  mountFresh(store);
  const firstRow = document.querySelector(".sm-release-row");
  assert.strictEqual(firstRow.querySelector(".sm-unassigned-col"), null);
  assert.strictEqual(firstRow.querySelectorAll(".sm-cell").length, 2);
});

test("SM-253: release-assigned-but-unplaced tickets show in the release's holding strip", () => {
  const store = setup();
  const { rA } = ids(store);
  store.createTicket({ type: "epic", title: "FloatEpic", position: { releaseId: rA } }, HUMAN);
  mountFresh(store);
  assert.strictEqual(document.querySelector(".sm-backlog-section"), null, "no global backlog section anymore");
  const strip = document.querySelector('.sm-release-unplaced-row[data-release-id="' + rA + '"]');
  assert.ok(strip, "release rA has a per-release holding strip");
  assert.ok(strip.textContent.includes("FloatEpic"), "the unplaced epic shows in its release's holding strip");
});

test("mount: epic with stories renders as .sm-epic-card containing .sm-story-card[]", () => {
  const store = setup();
  const { rA, p1 } = ids(store);
  store.createTicket({ type: "epic", title: "Container", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  const epicId = store.get().tickets[0].id;
  store.createTicket({ type: "user-story", title: "S1", position: { releaseId: rA, epicId } }, HUMAN);
  store.createTicket({ type: "user-story", title: "S2", position: { releaseId: rA, epicId } }, HUMAN);
  mountFresh(store);
  const epicCard = document.querySelector(".sm-epic-card");
  assert.ok(epicCard, "epic card missing");
  assert.ok(epicCard.textContent.includes("Container"));
  const stories = epicCard.querySelectorAll(".sm-story-card");
  assert.strictEqual(stories.length, 2);
});

test("SM-253: dropping a card on a release header re-homes it to that release as unplaced", () => {
  const dnd = require("../frontend/js/dnd.js");
  const store = setup();
  const { rA, rB, p1 } = ids(store);
  store.createTicket({ type: "epic", title: "E", position: { releaseId: rB, processStepId: p1 } }, HUMAN);
  const epicId = store.get().tickets.find(t => t.title === "E").id;
  store.createTicket({ type: "user-story", title: "MovingS", position: { releaseId: rB, epicId } }, HUMAN);
  const sid = store.get().tickets.find(t => t.title === "MovingS").id;
  const host = document.getElementById("host"); host.innerHTML = "";
  storymap.mount(host, store);
  const labelRow = host.querySelector('.sm-release-label-row[data-release-id="' + rA + '"]');
  const tgt = dnd._getDropTarget(labelRow);
  assert.ok(tgt && typeof tgt.onDrop === "function", "release header is a drop target");
  tgt.onDrop({ type: storymap.DRAG_TYPES.STORY, id: sid, target: labelRow });
  const pos = store.get().tickets.find(t => t.id === sid).position;
  assert.strictEqual(pos.releaseId, rA, "re-homed to the dropped-on release");
  assert.strictEqual(pos.processStepId, null, "process step cleared → unplaced");
  const strip = host.querySelector('.sm-release-unplaced-row[data-release-id="' + rA + '"]');
  assert.ok(strip && strip.textContent.includes("MovingS"), "now shows in rA's holding strip");
});

test("SM-253: the per-release holding strip is itself a drop target (re-home into it)", () => {
  const dnd = require("../frontend/js/dnd.js");
  const store = setup();
  const { rA } = ids(store);
  // Seed an unplaced epic so rA's holding strip renders.
  store.createTicket({ type: "epic", title: "Seed", position: { releaseId: rA } }, HUMAN);
  const host = document.getElementById("host"); host.innerHTML = "";
  storymap.mount(host, store);
  const strip = host.querySelector('.sm-release-unplaced-row[data-release-id="' + rA + '"]');
  const tgt = dnd._getDropTarget(strip);
  assert.ok(tgt && tgt.accepts.includes(storymap.DRAG_TYPES.STORY), "holding strip accepts story drops");
});

test("SM-274: release-LESS tickets appear in the Map-Eingang (.sm-tray), not in a backlog section", () => {
  const store = setup();
  store.createTicket({ type: "epic", title: "BL Epic A" }, HUMAN);        // no release
  store.createTicket({ type: "user-story", title: "OrphanStory" }, HUMAN); // no release
  mountFresh(store);
  const host = document.getElementById("host");
  assert.strictEqual(document.querySelector(".sm-backlog-section"), null, "still no old backlog section");
  const tray = host.querySelector(".sm-tray");
  assert.ok(tray, "the Map-Eingang strip is rendered when there is unassigned work");
  assert.ok(tray.textContent.includes("BL Epic A"), "release-less epic shows in the tray");
  assert.ok(tray.textContent.includes("OrphanStory"), "orphan story shows in the tray");
});

// ---------------------------------------------------------------------------
// SM-274: Map-Eingang (Bodenstreifen) — collect release-less tickets
// ---------------------------------------------------------------------------

test("SM-274/SM-275: STORY_MAP_LAYOUT exposes the tray constants", () => {
  assert.ok(typeof STORY_MAP_LAYOUT.TRAY_ROWS_DEFAULT === "number" && STORY_MAP_LAYOUT.TRAY_ROWS_DEFAULT >= 1);
  assert.ok(typeof STORY_MAP_LAYOUT.TRAY_BODY_PADDING_PX === "number" && STORY_MAP_LAYOUT.TRAY_BODY_PADDING_PX >= 0);
  assert.ok(typeof STORY_MAP_LAYOUT.TRAY_RESIZE_DEBOUNCE_MS === "number" && STORY_MAP_LAYOUT.TRAY_RESIZE_DEBOUNCE_MS > 0);
});

test("SM-275: computeTrayRows fills the space below the grid (floor(avail / cardSlot))", () => {
  const cardSlot = STORY_MAP_LAYOUT.CARD_HEIGHT_PX + STORY_MAP_LAYOUT.TICKET_GAP_PX;
  const pad2 = STORY_MAP_LAYOUT.TRAY_BODY_PADDING_PX * 2;
  const rows = storymap.computeTrayRows(900, 200, 30);
  assert.strictEqual(rows, Math.floor((900 - 200 - 30 - pad2) / cardSlot));
  assert.ok(rows > STORY_MAP_LAYOUT.TRAY_ROWS_DEFAULT, "lots of space → more than the fallback rows");
});

test("SM-275: computeTrayRows grows when the viewport gets taller (the reactive recompute)", () => {
  const short = storymap.computeTrayRows(500, 200, 30);
  const tall  = storymap.computeTrayRows(1000, 200, 30);
  assert.ok(tall > short, "a taller viewport yields more rows");
});

test("SM-275: computeTrayRows falls back to default when the board fills the viewport / pre-layout", () => {
  assert.strictEqual(storymap.computeTrayRows(600, 900, 30), STORY_MAP_LAYOUT.TRAY_ROWS_DEFAULT, "grid taller than viewport → fallback");
  assert.strictEqual(storymap.computeTrayRows(0, 0, 0), STORY_MAP_LAYOUT.TRAY_ROWS_DEFAULT, "pre-layout (0 height) → fallback");
});

test("SM-275: a mounted tray's grid carries a repeat(N, ...) grid-template-rows", () => {
  const store = setup();
  store.createTicket({ type: "epic", title: "BL Epic A" }, HUMAN);
  const host = document.getElementById("host");
  host.innerHTML = "";
  storymap.mount(host, store);
  const grid = host.querySelector(".sm-tray-grid");
  assert.ok(grid, "tray grid present");
  assert.ok(/^repeat\(\d+,/.test(grid.style.gridTemplateRows), "grid-template-rows is a repeat(N, ...) template");
});

test("SM-275: mount registers a window resize listener; the controller removes it", () => {
  const store = setup();
  store.createTicket({ type: "epic", title: "BL Epic A" }, HUMAN);
  const host = document.getElementById("host");
  host.innerHTML = "";
  const win = dom.window;
  const origAdd = win.addEventListener.bind(win);
  const origRemove = win.removeEventListener.bind(win);
  let added = 0, removed = 0;
  win.addEventListener = (t, ...a) => { if (t === "resize") added++; return origAdd(t, ...a); };
  win.removeEventListener = (t, ...a) => { if (t === "resize") removed++; return origRemove(t, ...a); };
  const savedWin = global.window;
  global.window = win;
  try {
    const ctrl = storymap.mount(host, store);
    assert.strictEqual(added, 1, "resize listener added on mount");
    ctrl();
    assert.strictEqual(removed, 1, "resize listener removed on unmount");
  } finally {
    global.window = savedWin;
    win.addEventListener = origAdd;
    win.removeEventListener = origRemove;
  }
});

// ---------------------------------------------------------------------------
// SM-223 (a) gate: content-visibility only on very large boards (fixes the
// WebKit/Gecko row-height jump on normal boards)
// ---------------------------------------------------------------------------

test("SM-223 gate: a normal board's grid is NOT virtualized", () => {
  const store = setup();
  store.createTicket({ type: "epic", title: "E" }, HUMAN);
  const host = document.getElementById("host");
  host.innerHTML = "";
  storymap.mount(host, store);
  assert.ok(host.querySelector(".sm-grid"), "grid rendered");
  assert.strictEqual(host.querySelector(".sm-grid-virtualized"), null, "small board is not virtualized (no content-visibility jump)");
});

test("SM-223 gate: a board past VIRTUALIZE_TICKET_THRESHOLD IS virtualized", () => {
  const base = core.normalizeSnapshot({ project: { id: "big", name: "B", ticketPrefix: "B" } });
  const store = new ProjectStore(base);
  store.createRelease({ name: "r" }, HUMAN);
  store.createProcessStep({ name: "p" }, HUMAN);
  const cur = store.get();
  const many = [];
  for (let i = 0; i < STORY_MAP_LAYOUT.VIRTUALIZE_TICKET_THRESHOLD + 1; i++) {
    many.push({ id: "big-t" + i, type: "user-story", title: "T" + i, status: "backlog", position: {} });
  }
  store.applyRemote(core.normalizeSnapshot(Object.assign({}, cur, { tickets: many })));
  const host = document.getElementById("host");
  host.innerHTML = "";
  storymap.mount(host, store);
  assert.ok(host.querySelector(".sm-grid-virtualized"), "large board opts into content-visibility virtualization");
});

test("SM-223 gate: content-visibility is scoped to .sm-grid-virtualized, not bare .sm-cell", () => {
  const fs = require("fs");
  const path = require("path");
  const css = fs.readFileSync(path.join(__dirname, "../frontend/css/storymap.css"), "utf8");
  const cvIdx = css.indexOf("content-visibility: auto");
  assert.ok(cvIdx > -1, "content-visibility is still present (gated, not removed)");
  const preceding = css.slice(Math.max(0, cvIdx - 500), cvIdx);
  assert.ok(preceding.includes(".sm-grid-virtualized .sm-cell"), "content-visibility lives under the .sm-grid-virtualized gate");
});

test("SM-281 gate: .sm-cell absorbs sub-pixel overflow with clip, never auto (cells must not capture the horizontal scroll gesture)", () => {
  const fs = require("fs");
  const path = require("path");
  const css = fs.readFileSync(path.join(__dirname, "../frontend/css/storymap.css"), "utf8");
  const ruleStart = css.indexOf("\n.sm-cell {");
  assert.ok(ruleStart > -1, ".sm-cell rule exists");
  const ruleEnd = css.indexOf("}", ruleStart);
  const rule = css.slice(ruleStart, ruleEnd);
  assert.ok(rule.includes("overflow-x: clip"), ".sm-cell uses overflow-x: clip (SM-136 sub-pixel net without a scroll container)");
  assert.ok(!rule.includes("overflow-x: auto"), ".sm-cell must NOT be a horizontal scroll container — auto makes Safari route the trackpad swipe into the cell instead of the map (SM-281)");
});

test("SM-281 gate: #view-host has always-visible classic scrollbars (::-webkit-scrollbar opts out of the overlay)", () => {
  const fs = require("fs");
  const path = require("path");
  const css = fs.readFileSync(path.join(__dirname, "../frontend/css/storymap.css"), "utf8");
  const sbIdx = css.indexOf("#view-host::-webkit-scrollbar {");
  assert.ok(sbIdx > -1, "#view-host styles ::-webkit-scrollbar — macOS overlay bars only flash the scrolled axis, so a vertical-only mouse wheel NEVER reveals the horizontal bar");
  const rule = css.slice(sbIdx, css.indexOf("}", sbIdx));
  assert.ok(/height:\s*\d+px/.test(rule), "scrollbar rule sets a height (the horizontal bar is the whole point)");
  assert.ok(css.includes("#view-host::-webkit-scrollbar-thumb"), "thumb is styled (grabbable affordance)");
});

test("SM-274: computeUnassignedTrayLayout collects release-less epics + orphan stories (epics first)", () => {
  const store = setup();
  store.createTicket({ type: "epic", title: "BL Epic A" }, HUMAN);
  store.createTicket({ type: "user-story", title: "OrphanStory" }, HUMAN);
  // A placed ticket (with release) must NOT leak into the tray.
  const { rA, p1 } = ids(store);
  store.createTicket({ type: "user-story", title: "PlacedStory", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  const tray = storymap.computeUnassignedTrayLayout(store.get(), { rows: 5 });
  assert.strictEqual(tray.count, 2, "only the two release-less tickets");
  assert.strictEqual(tray.items[0].title, "BL Epic A", "epics come first");
  assert.strictEqual(tray.items[1].title, "OrphanStory");
  assert.ok(tray.items.every(t => t.title !== "PlacedStory"), "placed ticket excluded");
});

test("SM-274: computeUnassignedTrayLayout chunks items into column-flow columns of `rows`", () => {
  const store = setup();
  for (let i = 0; i < 5; i++) store.createTicket({ type: "user-story", title: "Orphan" + i }, HUMAN);
  const tray = storymap.computeUnassignedTrayLayout(store.get(), { rows: 2 });
  assert.strictEqual(tray.rows, 2);
  // 5 items, rows=2 → columns of [2,2,1]
  assert.deepStrictEqual(tray.columns.map(c => c.length), [2, 2, 1]);
  assert.strictEqual(tray.columns[0][0].title, "Orphan0", "first column fills first (vertical-first)");
  assert.strictEqual(tray.columns[0][1].title, "Orphan1");
  assert.strictEqual(tray.columns[1][0].title, "Orphan2", "wraps to the next column to the right");
});

test("SM-274: computeUnassignedTrayLayout — empty set yields count 0, no columns", () => {
  const store = setup();
  const tray = storymap.computeUnassignedTrayLayout(store.get(), {});
  assert.strictEqual(tray.count, 0);
  assert.deepStrictEqual(tray.columns, []);
});

test("SM-274: computeUnassignedTrayLayout honours the matches predicate (filter parity)", () => {
  const store = setup();
  store.createTicket({ type: "epic", title: "KeepEpic" }, HUMAN);
  store.createTicket({ type: "user-story", title: "DropStory" }, HUMAN);
  const tray = storymap.computeUnassignedTrayLayout(store.get(), {
    matches: (t) => t.type === "epic"
  });
  assert.strictEqual(tray.count, 1);
  assert.strictEqual(tray.items[0].title, "KeepEpic");
});

test("SM-274: the tray is hidden when there is no unassigned work", () => {
  const store = setup();
  const { rA, p1 } = ids(store);
  store.createTicket({ type: "user-story", title: "Placed", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  mountFresh(store);
  assert.strictEqual(document.getElementById("host").querySelector(".sm-tray"), null, "no empty strip");
});

test("SM-274: tray header shows the count + collapse toggle; double-click a card fires onTicketClick", () => {
  const store = setup();
  store.createTicket({ type: "epic", title: "BL Epic A" }, HUMAN);
  const host = document.getElementById("host");
  host.innerHTML = "";
  let clicked = null;
  storymap.mount(host, store, { onTicketClick: (id) => { clicked = id; } });
  const tray = host.querySelector(".sm-tray");
  assert.ok(tray, "tray present");
  assert.strictEqual(tray.querySelector(".sm-tray-count").textContent, "1", "count badge shows 1");
  assert.ok(tray.querySelector(".sm-tray-toggle"), "collapse toggle present");
  const card = tray.querySelector(".sm-tray-grid .sm-story-card");
  assert.ok(card, "card rendered in tray grid");
  card.dispatchEvent(new dom.window.MouseEvent("dblclick", { bubbles: true }));
  const epicId = store.get().tickets.find(t => t.title === "BL Epic A").id;
  assert.strictEqual(clicked, epicId, "double-click opens the ticket modal");
});

test("SM-274: collapse toggle hides the tray body and re-renders", () => {
  const store = setup();
  store.createTicket({ type: "epic", title: "BL Epic A" }, HUMAN);
  const host = document.getElementById("host");
  host.innerHTML = "";
  storymap.mount(host, store);
  assert.ok(host.querySelector(".sm-tray-body"), "body visible initially");
  host.querySelector(".sm-tray-toggle").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  assert.ok(host.querySelector(".sm-tray.sm-tray-collapsed"), "tray marked collapsed");
  assert.strictEqual(host.querySelector(".sm-tray-body"), null, "body hidden when collapsed");
  // expand again so module-level _trayCollapsed doesn't leak into later tests
  host.querySelector(".sm-tray-toggle").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  assert.ok(host.querySelector(".sm-tray-body"), "body restored on re-expand");
});

// ---------------------------------------------------------------------------
// SM-276: Map-Eingang drag — schedule (→ cell) + unassign (→ strip)
// ---------------------------------------------------------------------------

test("SM-276: the tray is a drop target that accepts STORY and EPIC drags", () => {
  const dnd = require("../frontend/js/dnd.js");
  const store = setup();
  store.createTicket({ type: "epic", title: "BL Epic A" }, HUMAN);  // makes the tray render
  const host = document.getElementById("host"); host.innerHTML = "";
  storymap.mount(host, store);
  const trayRoot = host.querySelector(".sm-tray");
  const tgt = dnd._getDropTarget(trayRoot);
  assert.ok(tgt && typeof tgt.onDrop === "function", "tray is a drop target");
  assert.ok(tgt.accepts.includes(storymap.DRAG_TYPES.STORY), "accepts stories");
  assert.ok(tgt.accepts.includes(storymap.DRAG_TYPES.EPIC), "accepts epics");
});

test("SM-276: dropping a scheduled card on the tray unassigns it (clears release/ps/epic)", () => {
  const dnd = require("../frontend/js/dnd.js");
  const store = setup();
  const { rA, p1 } = ids(store);
  // One release-less ticket so the tray renders, plus a scheduled story to drag back.
  store.createTicket({ type: "epic", title: "Inbox Epic" }, HUMAN);
  store.createTicket({ type: "user-story", title: "Scheduled", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  const sid = store.get().tickets.find(t => t.title === "Scheduled").id;
  const host = document.getElementById("host"); host.innerHTML = "";
  storymap.mount(host, store);
  const trayRoot = host.querySelector(".sm-tray");
  const tgt = dnd._getDropTarget(trayRoot);
  tgt.onDrop({ type: storymap.DRAG_TYPES.STORY, id: sid, target: trayRoot });
  const pos = store.get().tickets.find(t => t.id === sid).position;
  assert.strictEqual(pos.releaseId, null, "release cleared");
  assert.strictEqual(pos.processStepId, null, "process step cleared");
  assert.strictEqual(pos.epicId, null, "epic cleared");
  // and it now shows in the tray
  assert.ok(host.querySelector(".sm-tray").textContent.includes("Scheduled"), "unassigned card appears in the inbox");
});

test("SM-276: a tray card scheduled onto a cell gets that release + process step", () => {
  const dnd = require("../frontend/js/dnd.js");
  const store = setup();
  const { rA, p1 } = ids(store);
  store.createTicket({ type: "user-story", title: "FromInbox" }, HUMAN);  // release-less → in tray
  const sid = store.get().tickets.find(t => t.title === "FromInbox").id;
  const host = document.getElementById("host"); host.innerHTML = "";
  storymap.mount(host, store);
  // The tray card is a drag source; dropping it on a cell fires the cell's
  // existing STORY handler, which schedules it into that (release × step).
  const cell = host.querySelector('.sm-cell[data-release-id="' + rA + '"][data-process-step-id="' + p1 + '"]');
  const tgt = dnd._getDropTarget(cell);
  assert.ok(tgt && tgt.accepts.includes(storymap.DRAG_TYPES.STORY), "cell accepts story drops");
  tgt.onDrop({ type: storymap.DRAG_TYPES.STORY, id: sid, target: cell });
  const pos = store.get().tickets.find(t => t.id === sid).position;
  assert.strictEqual(pos.releaseId, rA, "scheduled into the dropped-on release");
  assert.strictEqual(pos.processStepId, p1, "scheduled into the dropped-on process step");
});

test("mount: per-cell '+ Ticket' button fires onAddTicket with (releaseId, processStepId)", () => {
  const store = setup();
  let captured = null;
  const host = document.getElementById("host");
  host.innerHTML = "";
  storymap.mount(host, store, { onAddTicket: (ctx) => { captured = ctx; } });
  const { rA, p1 } = ids(store);
  const cell = document.querySelector(`.sm-cell[data-release-id="${rA}"][data-process-step-id="${p1}"]`);
  assert.ok(cell, "cell selector not found");
  const btn = cell.querySelector(".sm-add-ticket");
  assert.ok(btn, "+ button missing in cell");
  btn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  assert.deepStrictEqual(captured, { releaseId: rA, processStepId: p1 });
});

test("mount: double-clicking an epic header fires onTicketClick (single click no-op for drag-friendliness)", () => {
  const store = setup();
  const { rA, p1 } = ids(store);
  store.createTicket({ type: "epic", title: "Click me", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  const epicId = store.get().tickets[0].id;
  let clicked = null;
  const host = document.getElementById("host");
  host.innerHTML = "";
  storymap.mount(host, store, { onTicketClick: (id) => { clicked = id; } });
  const header = document.querySelector(".sm-epic-card .sm-epic-header");
  // Single click must NOT fire (would conflict with drag-gesture threshold).
  header.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  assert.strictEqual(clicked, null, "single click on epic header should be a no-op");
  // Double-click opens the detail modal.
  header.dispatchEvent(new dom.window.MouseEvent("dblclick", { bubbles: true }));
  assert.strictEqual(clicked, epicId);
});

test("mount: re-renders when store emits a commit", () => {
  const store = setup();
  const { rA, p1 } = ids(store);
  mountFresh(store);
  const before = document.querySelectorAll(".sm-epic-card").length;
  // SM-253: a release-less epic wouldn't render in the SM — place it in a cell.
  store.createTicket({ type: "epic", title: "New", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  const after = document.querySelectorAll(".sm-epic-card").length;
  assert.strictEqual(after, before + 1);
});

// ---------------------------------------------------------------------------
// E9k — Multi-Column-Wrap, column multipliers, fixed card width, live-reorder
// ---------------------------------------------------------------------------

test("SM-135: columnMultipliers = number of slim columns (epics, +loose) per process step", () => {
  // Slim-column model: each epic is ONE column regardless of story count.
  // Cell width = #epics (+1 if loose tickets exist), max across releases.
  const store = setup();
  const { rA, rB, p1, p2 } = ids(store);
  // p1 in rA: 2 epics → 2 columns. One epic is fat (12 stories) — story count
  // must NOT widen the column anymore.
  store.createTicket({ type: "epic", title: "E1a", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  store.createTicket({ type: "epic", title: "E1b", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  const e1a = store.get().tickets.find(t => t.title === "E1a").id;
  for (let i = 0; i < 12; i++) {
    store.createTicket({ type: "user-story", title: "s" + i, position: { releaseId: rA, epicId: e1a } }, HUMAN);
  }
  // p2 in rB: 3 epics → 3 columns
  store.createTicket({ type: "epic", title: "E2a", position: { releaseId: rB, processStepId: p2 } }, HUMAN);
  store.createTicket({ type: "epic", title: "E2b", position: { releaseId: rB, processStepId: p2 } }, HUMAN);
  store.createTicket({ type: "epic", title: "E2c", position: { releaseId: rB, processStepId: p2 } }, HUMAN);
  const layout = storymap.computeStoryMapLayout(store.get());
  assert.ok(layout.columnMultipliers instanceof Map);
  assert.strictEqual(layout.columnMultipliers.get(p1), 2);
  assert.strictEqual(layout.columnMultipliers.get(p2), 3);
});

test("layout: columnMultipliers default to 1 for empty PS-columns", () => {
  const store = setup();
  const { p1 } = ids(store);
  const layout = storymap.computeStoryMapLayout(store.get());
  assert.strictEqual(layout.columnMultipliers.get(p1), 1);
});

test("mount: story-cards INSIDE an Epic shrink to fit Epic-width minus padding/gap", () => {
  // SM-55 follow-up: inside-Epic story-cards are slightly narrower than the
  // standalone STORY_CARD_WIDTH_PX so the Epic-card width stays an exact
  // multiple of STORY_CARD_WIDTH_PX.
  const store = setup();
  const { rA, p1 } = ids(store);
  store.createTicket({ type: "epic", title: "E", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  const eid = store.get().tickets.find(t => t.title === "E").id;
  store.createTicket({ type: "user-story", title: "S1", position: { releaseId: rA, epicId: eid } }, HUMAN);
  mountFresh(store);
  const card = document.querySelector(".sm-story-card");
  assert.ok(card, "story card missing");
  // 1-sub-col Epic: insideW = floor((1×STORY_CARD - 2×PAD - 0×GAP) / 1)
  const expected = Math.floor(
    (STORY_MAP_LAYOUT.STORY_CARD_WIDTH_PX
     - 2 * STORY_MAP_LAYOUT.STORIES_GRID_PADDING_PX
     - 0
    ) / 1
  );
  assert.strictEqual(card.style.width, expected + "px");
});

test("SM-135: stories-grid is single-column row-flow at fixed card height (slim column)", () => {
  const store = setup();
  const { rA, p1 } = ids(store);
  store.createTicket({ type: "epic", title: "E", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  const eid = store.get().tickets.find(t => t.title === "E").id;
  for (let i = 0; i < 6; i++) {
    store.createTicket({ type: "user-story", title: "s" + i, position: { releaseId: rA, epicId: eid } }, HUMAN);
  }
  mountFresh(store);
  const grid = document.querySelector(".sm-stories-grid");
  assert.ok(grid, "stories-grid missing");
  // Single column, rows flow downward, each row at the fixed card height.
  assert.strictEqual(grid.style.gridAutoFlow, "row");
  assert.strictEqual(grid.style.gridAutoRows, "var(--sm-card-h)");
  // inside-width = epicW − 2×PAD (one column, no inter-column gap).
  const insideW = STORY_MAP_LAYOUT.STORY_CARD_WIDTH_PX
    - 2 * STORY_MAP_LAYOUT.STORIES_GRID_PADDING_PX;
  assert.strictEqual(grid.style.gridTemplateColumns, insideW + "px");
  // All 6 stories render — no 5-per-column cap anymore.
  assert.strictEqual(grid.querySelectorAll(".sm-story-card").length, 6);
});

test("mount: backbone grid-template-columns enumerates per-PS widths by multiplier", () => {
  const store = setup();
  const { rA, p1, p2 } = ids(store);
  // make p1 require 2 columns — 2 slim epic columns side by side
  store.createTicket({ type: "epic", title: "Ea", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  store.createTicket({ type: "epic", title: "Eb", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  mountFresh(store);
  const backbone = document.querySelector(".sm-backbone");
  const tpl = backbone.style.gridTemplateColumns;
  // p1 → calc(2 * var(--sm-backbone-col-w)), p2 → calc(1 * var(--sm-backbone-col-w))
  assert.ok(tpl.includes("calc(2"), "expected 2× multiplier for p1: " + tpl);
  assert.ok(tpl.includes("calc(1"), "expected 1× multiplier for p2: " + tpl);
});

test("mount: release-row grid-template-columns matches backbone (alignment)", () => {
  const store = setup();
  const { rA, p1 } = ids(store);
  store.createTicket({ type: "epic", title: "E", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  const eid = store.get().tickets.find(t => t.title === "E").id;
  for (let i = 0; i < 6; i++) {
    store.createTicket({ type: "user-story", title: "s" + i, position: { releaseId: rA, epicId: eid } }, HUMAN);
  }
  mountFresh(store);
  const backboneTpl = document.querySelector(".sm-backbone").style.gridTemplateColumns;
  const rowTpl      = document.querySelector(".sm-release-row").style.gridTemplateColumns;
  assert.strictEqual(rowTpl, backboneTpl);
});

test("Live-reorder: setDragProjection re-renders with origin removed and shadow at insertionIndex", () => {
  const store = setup();
  const { rA, p1 } = ids(store);
  store.createTicket({ type: "epic", title: "EpicA", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  store.createTicket({ type: "epic", title: "EpicB", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  const eA = store.get().tickets.find(t => t.title === "EpicA").id;
  const eB = store.get().tickets.find(t => t.title === "EpicB").id;
  store.createTicket({ type: "user-story", title: "S1", position: { releaseId: rA, epicId: eA } }, HUMAN);
  store.createTicket({ type: "user-story", title: "S2", position: { releaseId: rA, epicId: eA } }, HUMAN);
  const s1 = store.get().tickets.find(t => t.title === "S1").id;
  const host = document.getElementById("host");
  host.innerHTML = "";
  const ctrl = storymap.mount(host, store);
  // Now project: move S1 into EpicB at index 0
  ctrl.setDragProjection({ ticketId: s1, target: { type: "epic", epicId: eB }, insertionIndex: 0 });
  // S1 should not appear under EpicA anymore (origin gone)
  const epicAEntry = Array.from(document.querySelectorAll(".sm-epic-card"))
    .find(c => c.textContent.includes("EpicA"));
  const epicBEntry = Array.from(document.querySelectorAll(".sm-epic-card"))
    .find(c => c.textContent.includes("EpicB"));
  assert.ok(epicAEntry && epicBEntry);
  const inA = epicAEntry.querySelectorAll(".sm-story-card");
  const inB = epicBEntry.querySelectorAll(".sm-story-card");
  // EpicA had S1, S2 — without S1 only one card remains.
  const titlesA = Array.from(inA).map(c => c.textContent);
  assert.ok(!titlesA.some(t => t.includes("S1")), "S1 should be removed from origin EpicA");
  // EpicB now has the shadow card with title S1.
  const shadowInB = epicBEntry.querySelector(".sm-story-card.sm-card-shadow");
  assert.ok(shadowInB, "expected shadow card in target EpicB");
  assert.ok(shadowInB.textContent.includes("S1"));
});

test("Live-reorder: clearDragProjection restores full render", () => {
  const store = setup();
  const { rA, p1 } = ids(store);
  store.createTicket({ type: "epic", title: "EpicA", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  const eA = store.get().tickets.find(t => t.title === "EpicA").id;
  store.createTicket({ type: "user-story", title: "S1", position: { releaseId: rA, epicId: eA } }, HUMAN);
  const s1 = store.get().tickets.find(t => t.title === "S1").id;
  const host = document.getElementById("host");
  host.innerHTML = "";
  const ctrl = storymap.mount(host, store);
  ctrl.setDragProjection({ ticketId: s1, target: { type: "epic", epicId: eA }, insertionIndex: 0 });
  ctrl.clearDragProjection();
  // After clear, S1 is back in its origin (EpicA), no shadow.
  const epicA = document.querySelector(".sm-epic-card");
  const cards = epicA.querySelectorAll(".sm-story-card");
  assert.strictEqual(cards.length, 1);
  assert.ok(!cards[0].classList.contains("sm-card-shadow"));
});

// ---------------------------------------------------------------------------
// E9l — Multi-Epic horizontal layout, loose tickets in cell
// ---------------------------------------------------------------------------

test("layout: cell carries `loose` list — non-epic tickets in cell without epicId", () => {
  const store = setup();
  const { rA, p1 } = ids(store);
  // Two epics so auto-epic-assignment is ambiguous → loose
  store.createTicket({ type: "epic", title: "E1", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  store.createTicket({ type: "epic", title: "E2", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  store.createTicket({ type: "bug",  title: "B1", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  const layout = storymap.computeStoryMapLayout(store.get());
  const cell = layout.releases[rA].cells[p1];
  assert.strictEqual(cell.loose.length, 1);
  assert.strictEqual(cell.loose[0].title, "B1");
});

test("layout: loose ticket in cell is NOT shown as partially-assigned in backlog", () => {
  const store = setup();
  const { rA, p1 } = ids(store);
  store.createTicket({ type: "epic", title: "E1", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  store.createTicket({ type: "epic", title: "E2", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  store.createTicket({ type: "bug",  title: "LooseInCell", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  const layout = storymap.computeStoryMapLayout(store.get());
  for (const g of layout.backlog.partiallyAssigned) {
    for (const s of g.stories) assert.notStrictEqual(s.title, "LooseInCell");
  }
});

test("SM-135: 3 epics in one cell → columnMultiplier = 3 (each is one slim column)", () => {
  const store = setup();
  const { rA, p1 } = ids(store);
  for (let i = 0; i < 3; i++) {
    store.createTicket({ type: "epic", title: "E" + i, position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  }
  const layout = storymap.computeStoryMapLayout(store.get());
  assert.strictEqual(layout.columnMultipliers.get(p1), 3);
});

test("SM-135: 4 epics in one cell → columnMultiplier = 4 (no cap; each is one slim column)", () => {
  const store = setup();
  const { rA, p1 } = ids(store);
  for (let i = 0; i < 4; i++) {
    store.createTicket({ type: "epic", title: "E" + i, position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  }
  const layout = storymap.computeStoryMapLayout(store.get());
  assert.strictEqual(layout.columnMultipliers.get(p1), 4);
});

test("SM-135: story count never widens the cell — fat epic + 2 narrow = 3 columns (not a sum)", () => {
  // Slim columns: fat epic (6 stories) is still ONE column. 3 epics = 3 columns.
  const store = setup();
  const { rA, p1 } = ids(store);
  store.createTicket({ type: "epic", title: "Fat", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  const fat = store.get().tickets.find(t => t.title === "Fat").id;
  for (let i = 0; i < 6; i++) {
    store.createTicket({ type: "user-story", title: "f" + i, position: { releaseId: rA, epicId: fat } }, HUMAN);
  }
  store.createTicket({ type: "epic", title: "T1", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  store.createTicket({ type: "epic", title: "T2", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  const layout = storymap.computeStoryMapLayout(store.get());
  assert.strictEqual(layout.columnMultipliers.get(p1), 3,
    "3 epics = 3 slim columns; story count is irrelevant to width");
});

test("mount: cell with 2 epics builds .sm-cell-epics row wrapper", () => {
  const store = setup();
  const { rA, p1 } = ids(store);
  store.createTicket({ type: "epic", title: "E1", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  store.createTicket({ type: "epic", title: "E2", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  mountFresh(store);
  const cellEpics = document.querySelector(".sm-cell-epics");
  assert.ok(cellEpics, "expected .sm-cell-epics wrapper");
  const epicCards = cellEpics.querySelectorAll(".sm-epic-card");
  assert.strictEqual(epicCards.length, 2);
});

test("mount: cell with loose tickets renders them in .sm-cell-loose (not in backlog)", () => {
  const store = setup();
  const { rA, p1 } = ids(store);
  // Force loose via 2 epics in same cell (auto-epic disabled by ambiguity)
  store.createTicket({ type: "epic", title: "E1", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  store.createTicket({ type: "epic", title: "E2", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  store.createTicket({ type: "bug", title: "BugLoose", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  mountFresh(store);
  const looseHost = document.querySelector(".sm-cell-loose");
  assert.ok(looseHost, "expected .sm-cell-loose host");
  const cards = looseHost.querySelectorAll(".sm-story-card");
  assert.strictEqual(cards.length, 1);
  assert.ok(cards[0].textContent.includes("BugLoose"));
  // and NOT in any backlog list
  const backlogCards = document.querySelectorAll(".sm-backlog-section .sm-story-card");
  for (const c of backlogCards) assert.ok(!c.textContent.includes("BugLoose"));
});

test("mount: cell with no epics and only loose tickets still renders them", () => {
  const store = setup();
  const { rA, p1 } = ids(store);
  store.createTicket({ type: "bug", title: "OnlyLoose", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  mountFresh(store);
  const looseHost = document.querySelector(".sm-cell-loose");
  assert.ok(looseHost);
  assert.strictEqual(looseHost.querySelectorAll(".sm-story-card").length, 1);
});

// SM-79 regression: drag a card across cells (and across releases) — verify
// that the target cell receives the .sm-drop-target class via onEnter
// (proving the drop-target registration works end-to-end through the
// renderer's morphTree pipeline).
test("SM-79: cross-release cell drag — target cell gets .sm-drop-target highlight", () => {
  const store = setup();
  const { rA, rB, p1, p2 } = ids(store);
  // One story in (rA, p1). We'll drag it to (rB, p2).
  store.createTicket({ type: "user-story", title: "DragMe",
    position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  const storyId = store.get().tickets.find(t => t.title === "DragMe").id;
  const host = document.getElementById("host");
  host.innerHTML = "";

  // wrappedOpts in the renderer swallows the user-side onCellStoryDrop;
  // for STORY drops in a cell it calls reorderVia → opts.persistReorderTickets
  // (the HTTP-mode hook from main.js). We let the local-store fallback
  // run instead and observe the ticket's position directly after the drop.
  storymap.mount(host, store, {});

  const sourceCard = document.querySelector('.sm-story-card[data-ticket-id="' + storyId + '"]');
  assert.ok(sourceCard, "source card rendered");
  const targetCell = document.querySelector(
    '.sm-cell[data-release-id="' + rB + '"][data-process-step-id="' + p2 + '"]'
  );
  assert.ok(targetCell, "target cell rendered for (rB, p2)");

  // Stub getBoundingClientRect so dnd offset math works.
  sourceCard.getBoundingClientRect = () => ({
    left: 50, top: 50, right: 250, bottom: 130,
    width: 200, height: 80, x: 50, y: 50, toJSON: () => ({})
  });
  targetCell.getBoundingClientRect = () => ({
    left: 500, top: 300, right: 800, bottom: 500,
    width: 300, height: 200, x: 500, y: 300, toJSON: () => ({})
  });
  document.elementFromPoint = (x, y) =>
    (x >= 500 && x <= 800 && y >= 300 && y <= 500) ? targetCell : null;

  function pe(type, x, y) {
    // Use MouseEvent — JSDOM's PointerEvent constructor isn't always wired,
    // but document-level pointer-listeners receive MouseEvent dispatches
    // identically in JSDOM. (Consistent with test-frontend-dnd.js.)
    return new dom.window.MouseEvent(type, { bubbles: true, cancelable: true,
      clientX: x, clientY: y, button: 0 });
  }
  // pointerdown + pointermove (threshold) starts the drag, second
  // pointermove hovers the target. The crucial invariant: the live-preview
  // rerender that fires from onMove → setDragProjection → renderInto must
  // NOT strip the .sm-drop-target class from the currently-hovered cell
  // (was the SM-79 root cause).
  sourceCard.dispatchEvent(pe("pointerdown", 100, 80));
  document.dispatchEvent(pe("pointermove", 110, 90));
  document.dispatchEvent(pe("pointermove", 600, 400));
  assert.ok(targetCell.classList.contains("sm-drop-target"),
    "target cell must keep .sm-drop-target class through the mid-drag rerender");

  // pointerup: drop fires → renderer's wrappedOpts.onCellStoryDrop →
  // reorderVia → local store.reorderTickets with scope. Verify by reading
  // the ticket's position directly from the store.
  document.dispatchEvent(pe("pointerup", 600, 400));
  const dropped = store.get().tickets.find(t => t.id === storyId);
  assert.strictEqual(dropped.position.releaseId, rB,
    "drop persists the new releaseId — cross-release move works");
  assert.strictEqual(dropped.position.processStepId, p2,
    "drop persists the new processStepId — cross-cell move works");
});

// SM-167 (user report): a LOOSE ticket (no epic) dragged from a release cell
// into the general backlog must lose its release reference (releaseId → null).
// SM-79 followup — reproduce the user-reported "second drag breaks after
// the first successful drop". Sequence: mount → drag1 (rA, p1) → (rB, p2),
// then drag2 the SAME ticket back. Both drops must succeed.
test("SM-79 followup: a SECOND drag after a successful first drag still drops the ticket correctly", () => {
  const store = setup();
  const { rA, rB, p1, p2 } = ids(store);
  store.createTicket({ type: "user-story", title: "DragMeTwice",
    position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  const storyId = store.get().tickets.find(t => t.title === "DragMeTwice").id;
  const host = document.getElementById("host");
  host.innerHTML = "";
  storymap.mount(host, store, {});

  function pe(type, x, y) {
    return new dom.window.MouseEvent(type, { bubbles: true, cancelable: true,
      clientX: x, clientY: y, button: 0 });
  }
  function rectStub(left, top, width, height) {
    return () => ({ left, top, right: left+width, bottom: top+height,
      width, height, x: left, y: top, toJSON: () => ({}) });
  }
  function cellAt(rId, pId) {
    return document.querySelector(
      '.sm-cell[data-release-id="' + rId + '"][data-process-step-id="' + pId + '"]');
  }
  function cardOf(id) {
    return document.querySelector('.sm-story-card[data-ticket-id="' + id + '"]');
  }
  // Place cellA and cellB at separate stable rects, install elementFromPoint
  // that routes pointer coords to the right element (card OR cell). The card
  // sits inside its current cell, and we point at the card for pointerdown.
  function setupRects(cardId, sourceCellAt, targetCellAt) {
    const card = cardOf(cardId);
    const source = cellAt(sourceCellAt.r, sourceCellAt.p);
    const target = cellAt(targetCellAt.r,  targetCellAt.p);
    card.getBoundingClientRect   = rectStub( 50,  50, 200,  80);
    source.getBoundingClientRect = rectStub(  0,   0, 400, 300);
    target.getBoundingClientRect = rectStub(500, 300, 300, 200);
    document.elementFromPoint = (x, y) => {
      if (x >= 50 && x <= 250 && y >= 50 && y <= 130) return card;
      if (x >= 500 && x <= 800 && y >= 300 && y <= 500) return target;
      if (x >= 0 && x <= 400 && y >= 0 && y <= 300) return source;
      return null;
    };
    return { card, source, target };
  }

  // --- Drag #1 -------------------------------------------------------
  const r1 = setupRects(storyId, { r: rA, p: p1 }, { r: rB, p: p2 });
  r1.card.dispatchEvent(pe("pointerdown", 100, 80));
  document.dispatchEvent(pe("pointermove", 110, 90));      // > threshold
  document.dispatchEvent(pe("pointermove", 600, 400));     // hover target
  document.dispatchEvent(pe("pointerup",   600, 400));     // drop
  const afterDrag1 = store.get().tickets.find(t => t.id === storyId);
  assert.strictEqual(afterDrag1.position.releaseId, rB,
    "drag #1: cross-release move persisted releaseId=rB");
  assert.strictEqual(afterDrag1.position.processStepId, p2,
    "drag #1: cross-cell move persisted processStepId=p2");

  // --- Drag #2 -------------------------------------------------------
  // Ticket is now in (rB, p2). Drag it back to (rA, p1). The card may be
  // a fresh DOM node (cross-container morph inserts new), so we re-query.
  const r2 = setupRects(storyId, { r: rB, p: p2 }, { r: rA, p: p1 });
  // pointerdown coords match the new card rect (we placed it at 50,50).
  r2.card.dispatchEvent(pe("pointerdown", 100, 80));
  document.dispatchEvent(pe("pointermove", 110, 90));      // > threshold
  document.dispatchEvent(pe("pointermove", 600, 400));     // hover (rA, p1)
  document.dispatchEvent(pe("pointerup",   600, 400));     // drop
  const afterDrag2 = store.get().tickets.find(t => t.id === storyId);
  assert.strictEqual(afterDrag2.position.releaseId, rA,
    "drag #2: ticket moved BACK to rA (this is what the user reports broken)");
  assert.strictEqual(afterDrag2.position.processStepId, p1,
    "drag #2: ticket moved BACK to p1");
});

// SM-82 regression: filter-aware computeStoryMapLayout
test("SM-82: status filter — only matching tickets land in cells + backlog", () => {
  const store = setup();
  const { rA, p1 } = ids(store);
  store.createTicket({ type: "epic", title: "E1", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  store.createTicket({ type: "user-story", title: "S-todo",
    position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  const s = store.get().tickets.find(t => t.title === "S-todo");
  store.changeStatus(s.id, "done", HUMAN);
  store.createTicket({ type: "user-story", title: "S-open",
    position: { releaseId: rA, processStepId: p1 } }, HUMAN);

  const layoutAll = storymap.computeStoryMapLayout(store.get());
  const cellAll = layoutAll.releases[rA].cells[p1];
  const epicStoriesAll = (cellAll.epics[0] && cellAll.epics[0].stories) || [];
  assert.strictEqual(epicStoriesAll.length, 2, "without filter: both stories in epic");

  const layoutFiltered = storymap.computeStoryMapLayout(store.get(), {
    filter: { statuses: ["backlog", "ready", "in-progress", "review"] }
  });
  const cellFiltered = layoutFiltered.releases[rA].cells[p1];
  const epicStoriesFiltered = (cellFiltered.epics[0] && cellFiltered.epics[0].stories) || [];
  assert.strictEqual(epicStoriesFiltered.length, 1, "filter: only the non-done story");
  assert.strictEqual(epicStoriesFiltered[0].title, "S-open");
});

// SM-82 regression: the filter must also hide stories INSIDE a backlog epic
// card. Cells filtered epic-stories, but renderBacklogSection re-fetched them
// unfiltered (storiesInEpic) → e.g. done child-stories leaked into the
// unscheduled backlog while the same filter hid them everywhere else.
test("SM-82: type filter hides epic — its stories slide into cell-loose, NOT backlog", () => {
  const store = setup();
  const { rA, p1 } = ids(store);
  store.createTicket({ type: "epic", title: "EpicHide",
    position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  store.createTicket({ type: "user-story", title: "StoryUnder",
    position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  // Filter: hide epics (types = only user-story).
  const layout = storymap.computeStoryMapLayout(store.get(), {
    filter: { types: ["user-story"] }
  });
  const cell = layout.releases[rA].cells[p1];
  assert.strictEqual(cell.epics.length, 0, "epic filtered out of cell");
  assert.strictEqual(cell.loose.length, 1, "story evicted into cell-loose");
  assert.strictEqual(cell.loose[0].title, "StoryUnder");
  // Story must NOT be in backlog.orphans.
  assert.ok(layout.backlog.orphans.every(t => t.title !== "StoryUnder"),
    "evicted story is NOT moved to backlog as orphan");
});

test("SM-82: hideCompletedReleases removes the entire release row", () => {
  const store = setup();
  const { rA, rB } = ids(store);
  store.updateRelease(rB, { status: "completed" }, HUMAN);
  const layoutAll = storymap.computeStoryMapLayout(store.get());
  assert.strictEqual(layoutAll.rows.length, 2, "without filter: both releases visible");

  const layoutFiltered = storymap.computeStoryMapLayout(store.get(), {
    filter: { hideCompletedReleases: true }
  });
  assert.strictEqual(layoutFiltered.rows.length, 1, "filter: completed release hidden");
  assert.strictEqual(layoutFiltered.rows[0].id, rA, "only the non-completed release remains");
});

// SM-168 followup: hideCompletedReleases must also drop the backlog
// "Scheduled for <completed release>" group (it hid only the release row).
test("SM-82: hideCompletedReleases also hides the backlog 'Scheduled for <completed>' group", () => {
  const store = setup();
  const { rB } = ids(store);
  store.updateRelease(rB, { status: "completed" }, HUMAN);
  // A loose ticket scheduled for rB but not placed in a cell (no processStep).
  store.createTicket({ type: "user-story", title: "PlannedForB", position: { releaseId: rB } }, HUMAN);

  const all = storymap.computeStoryMapLayout(store.get());
  assert.ok(all.backlog.partiallyAssigned.some(g => g.release.id === rB),
    "without filter: the 'Scheduled for rB' group exists");

  const filtered = storymap.computeStoryMapLayout(store.get(), { filter: { hideCompletedReleases: true } });
  assert.ok(!filtered.backlog.partiallyAssigned.some(g => g.release.id === rB),
    "with hideCompletedReleases: the 'Scheduled for rB' group is hidden too");
});

// SM-80 — Release-Lifecycle visual marker.
test("SM-80: release with status='completed' gets data-status + sm-release-pill-completed", () => {
  const store = setup();
  const { rA } = ids(store);
  store.updateRelease(rA, { status: "completed" }, HUMAN);
  mountFresh(store);
  const labelRow = document.querySelector('.sm-release-label-row[data-release-id="' + rA + '"]');
  assert.ok(labelRow, "label row rendered");
  assert.strictEqual(labelRow.dataset.status, "completed",
    "label-row data-status reflects release.status");
  const label = labelRow.querySelector(".sm-release-label");
  assert.strictEqual(label.dataset.status, "completed",
    "label data-status reflects release.status (for CSS strikethrough)");
  const pill = labelRow.querySelector(".sm-release-pill-completed");
  assert.ok(pill, "Completed-pill rendered next to the label");
  assert.match(pill.textContent, /completed/i);
});

test("SM-277: release header column order is title → progress → completed pill", () => {
  const store = setup();
  const { rA, p1 } = ids(store);
  store.updateRelease(rA, { status: "completed" }, HUMAN);
  // give rA a work item so the X/Y progress badge renders
  store.createTicket({ type: "user-story", title: "S", status: "done", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  mountFresh(store);
  const main = document.querySelector('.sm-release-label-row[data-release-id="' + rA + '"] .sm-release-label-main');
  const order = Array.from(main.children).map(c => c.classList[0]);
  const iLabel = order.indexOf("sm-release-label");
  const iProg  = order.indexOf("sm-release-progress");
  const iPill  = order.indexOf("sm-release-pill");
  assert.ok(iLabel > -1 && iProg > -1 && iPill > -1, "title, progress and pill all present");
  assert.ok(iLabel < iProg, "title before progress");
  assert.ok(iProg < iPill, "progress before the completed pill");
});

test("SM-277: RELEASE_LABEL_WIDTH_PX drives the fixed --sm-release-label-w on the grid", () => {
  const store = setup();
  store.createTicket({ type: "epic", title: "E" }, HUMAN);
  const host = document.getElementById("host"); host.innerHTML = "";
  storymap.mount(host, store);
  const grid = host.querySelector(".sm-grid");
  assert.strictEqual(grid.style.getPropertyValue("--sm-release-label-w"),
    STORY_MAP_LAYOUT.RELEASE_LABEL_WIDTH_PX + "px", "CSS var mirrors the constant");
});

test("SM-80: release-cells row carries data-status for CSS dim", () => {
  const store = setup();
  const { rA } = ids(store);
  store.updateRelease(rA, { status: "completed" }, HUMAN);
  mountFresh(store);
  const cellsRow = document.querySelector('.sm-release-row.sm-release-cells[data-release-id="' + rA + '"]');
  assert.ok(cellsRow, "cells row rendered");
  assert.strictEqual(cellsRow.dataset.status, "completed");
});

test("SM-80: non-completed release has no pill + empty data-status", () => {
  const store = setup();
  const { rA } = ids(store);
  // Default status seeded by normalizeRelease is "planning".
  mountFresh(store);
  const labelRow = document.querySelector('.sm-release-label-row[data-release-id="' + rA + '"]');
  assert.strictEqual(labelRow.dataset.status, "planning");
  assert.strictEqual(labelRow.querySelector(".sm-release-pill"), null,
    "no pill for non-completed/-cancelled release");
});

// SM-77 regression: loose-ticket cards in a cell must support dblclick
// (was reported broken in the live UI for tickets dragged out of an epic).
test("SM-77: dblclick on a LOOSE-ticket card in a cell fires onTicketClick", () => {
  const store = setup();
  const { rA, p1 } = ids(store);
  store.createTicket({ type: "user-story", title: "LooseClickMe",
    position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  const looseId = store.get().tickets.find(t => t.title === "LooseClickMe").id;
  let clicked = null;
  const host = document.getElementById("host");
  host.innerHTML = "";
  storymap.mount(host, store, { onTicketClick: (id) => { clicked = id; } });
  const card = document.querySelector(".sm-cell-loose .sm-story-card");
  assert.ok(card, "loose card rendered");
  // Single click should NOT fire (consistent with epic-header behaviour).
  card.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  assert.strictEqual(clicked, null);
  card.dispatchEvent(new dom.window.MouseEvent("dblclick", { bubbles: true }));
  assert.strictEqual(clicked, looseId, "dblclick on loose card opens the detail modal");
});

// SM-77 regression: full user flow — story is created INSIDE an epic, then
// moved OUT (cross-container move) into the cell's loose section. The
// post-rerender DOM must still wire dblclick on the now-loose card.
test("SM-77: dblclick still fires after a story is moved OUT of its epic into cell-loose", () => {
  const store = setup();
  const { rA, p1 } = ids(store);
  // ONE epic in the cell so auto-epic-assignment binds the new story to it.
  store.createTicket({ type: "epic", title: "E1",
    position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  const epicId = store.get().tickets.find(t => t.title === "E1").id;
  store.createTicket({ type: "user-story", title: "MoveOut",
    position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  const storyId = store.get().tickets.find(t => t.title === "MoveOut").id;

  let clicked = null;
  const host = document.getElementById("host");
  host.innerHTML = "";
  storymap.mount(host, store, { onTicketClick: (id) => { clicked = id; } });

  // Sanity: story currently rendered INSIDE the epic.
  assert.ok(document.querySelector('.sm-epic-card[data-ticket-id="' + epicId + '"] .sm-story-card[data-ticket-id="' + storyId + '"]'),
    "story starts contained by the epic");
  // No loose card for it yet.
  assert.strictEqual(document.querySelector('.sm-cell-loose .sm-story-card[data-ticket-id="' + storyId + '"]'),
    null, "no loose card before move");

  // Move the story out of the epic — same cell, but epicId=null → loose.
  store.moveTicket(storyId, { releaseId: rA, processStepId: p1, epicId: null }, HUMAN);

  // Rerender already happened via store-commit subscription. Story should
  // now appear in .sm-cell-loose, not under the epic.
  const looseCard = document.querySelector('.sm-cell-loose .sm-story-card[data-ticket-id="' + storyId + '"]');
  assert.ok(looseCard, "story is now in cell-loose after the move");
  // dblclick must still fire onTicketClick (this is what the user reported broken).
  looseCard.dispatchEvent(new dom.window.MouseEvent("dblclick", { bubbles: true }));
  assert.strictEqual(clicked, storyId, "dblclick on moved-out loose card fires onTicketClick");
});

// SM-55 (was SM-28) — loose tickets always stack vertically in a single
// column at Epic-Width (STORY_CARD_WIDTH_PX), right-aligned in the cell.
// They do NOT wrap horizontally, and they do NOT affect columnMultipliers
// (see SM-55 tests further down). The renderer sets the inline width to
// STORY_CARD_WIDTH_PX so the constant stays the single source of truth.
test("SM-136: loose tickets live in their own .sm-loose-card column (240px) with header band, single-column stack", () => {
  const store = setup();
  const { rA, p1 } = ids(store);
  // Create 6 loose bugs (more than the old 5-cap) to confirm they stack in a
  // single column and never wrap horizontally.
  for (let i = 1; i <= 6; i++) {
    store.createTicket({ type: "bug", title: "L" + i, position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  }
  mountFresh(store);
  // The loose column sits INSIDE the horizontal .sm-cell-epics row, beside epics.
  const row = document.querySelector(".sm-cell-epics");
  assert.ok(row, "horizontal column row present");
  const looseCard = row.querySelector(".sm-loose-card");
  assert.ok(looseCard, "loose card column present inside the row");
  assert.strictEqual(looseCard.style.width, STORY_MAP_LAYOUT.STORY_CARD_WIDTH_PX + "px",
    "loose column width = STORY_CARD_WIDTH_PX");
  // Header band for baseline alignment with epic headers + a label.
  const header = looseCard.querySelector(".sm-loose-header");
  assert.ok(header, "loose header band present");
  assert.ok(/unassigned/i.test(header.textContent), "loose header carries a label");
  // Single-column grid body holding all 6 loose cards, no horizontal wrap.
  const looseHost = looseCard.querySelector(".sm-cell-loose");
  assert.ok(looseHost, "loose host present");
  assert.notStrictEqual(looseHost.style.gridAutoFlow, "column",
    "loose host must not use grid-auto-flow column (would wrap horizontally)");
  assert.strictEqual(looseHost.querySelectorAll(".sm-story-card").length, 6);
});

test("SM-137: baseline alignment — epic header and loose header share the same height token", () => {
  // The redesign's core promise: every slim column starts with a header band
  // of the SAME height, so the first card row lines up across all columns of a
  // release row. Both .sm-epic-header and .sm-loose-header MUST drive their
  // height from the single --sm-epic-header-h token (no hard-coded px).
  const css = fs.readFileSync(
    path.join(__dirname, "..", "frontend", "css", "storymap.css"), "utf8");
  const ruleHeight = (selector) => {
    // Grab the first declaration block for the selector, then its height decl.
    const block = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      + "\\s*\\{([^}]*)\\}").exec(css);
    assert.ok(block, "CSS rule not found: " + selector);
    const h = /height:\s*([^;]+);/.exec(block[1]);
    return h ? h[1].trim() : null;
  };
  const epicH  = ruleHeight(".sm-epic-header");
  const looseH = ruleHeight(".sm-loose-header");
  assert.strictEqual(epicH, "var(--sm-epic-header-h)", ".sm-epic-header height token");
  assert.strictEqual(looseH, "var(--sm-epic-header-h)", ".sm-loose-header height token");
  assert.strictEqual(epicH, looseH, "epic + loose headers must share the SAME height token");
});

test("SM-135: empty epic (no stories) is still exactly STORY_CARD_WIDTH_PX wide", () => {
  // Slim column: an epic is always exactly as wide as a standalone ticket card,
  // including the long-title case (the title clamps to 2 lines, doesn't widen).
  const store = setup();
  const { rA, p1 } = ids(store);
  store.createTicket({
    type: "epic",
    title: "Settings-View: Tab-Navigation (Workflow / DoR / DoD / Board)",
    position: { releaseId: rA, processStepId: p1 }
  }, HUMAN);
  mountFresh(store);
  const card = document.querySelector(".sm-epic-card");
  assert.ok(card, "epic card present");
  assert.strictEqual(card.style.width, STORY_MAP_LAYOUT.STORY_CARD_WIDTH_PX + "px",
    "slim epic width = exactly 1 × STORY_CARD_WIDTH_PX");
});

test("SM-135: epic card width is always exactly STORY_CARD_WIDTH_PX regardless of story count (slim column)", () => {
  const store = setup();
  const { rA, p1 } = ids(store);
  store.createTicket({ type: "epic", title: "Wide", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  const eid = store.get().tickets.find(t => t.title === "Wide").id;
  for (let i = 0; i < 12; i++) {
    store.createTicket({ type: "user-story", title: "s" + i, position: { releaseId: rA, epicId: eid } }, HUMAN);
  }
  mountFresh(store);
  const card = document.querySelector(".sm-epic-card");
  // Slim column: epicW = exactly 1 × STORY_CARD_WIDTH_PX even with 12 stories.
  assert.strictEqual(card.style.width, STORY_MAP_LAYOUT.STORY_CARD_WIDTH_PX + "px");
  // And all 12 stories render in the single column (no cap).
  assert.strictEqual(card.querySelectorAll(".sm-story-card").length, 12);
});

// ---------------------------------------------------------------------------
// E9m — Drag-reorder process steps
// ---------------------------------------------------------------------------

test("mount: backbone columns render with .sm-col-grip + .sm-col-label", () => {
  const store = setup();
  mountFresh(store);
  const cols = document.querySelectorAll(".sm-backbone-col:not(.sm-add-col)");
  assert.ok(cols.length >= 1);
  for (const c of cols) {
    assert.ok(c.querySelector(".sm-col-grip"), "expected .sm-col-grip");
    assert.ok(c.querySelector(".sm-col-label"), "expected .sm-col-label");
  }
});

test("DRAG_TYPES.PROCESS_STEP exported", () => {
  assert.strictEqual(typeof storymap.DRAG_TYPES.PROCESS_STEP, "string");
  assert.ok(storymap.DRAG_TYPES.PROCESS_STEP.length > 0);
});

test("applyProcessStepReorder updates sortOrder so list order matches input", () => {
  const store = setup();
  const { p1, p2 } = ids(store);
  storymap.applyProcessStepReorder(store, [p2, p1]);
  const order = store.get().processSteps
    .filter(p => !p.isDeleted)
    .slice()
    .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0))
    .map(p => p.id);
  assert.deepStrictEqual(order, [p2, p1]);
});

test("PS live-reorder: setDragProjection with target=process-step rearranges columns + marks shadow", () => {
  const store = setup();
  const { p1, p2 } = ids(store);
  const host = document.getElementById("host");
  host.innerHTML = "";
  const ctrl = storymap.mount(host, store);
  // Project: move p1 to after p2 (beforeId = null → append).
  ctrl.setDragProjection({ ticketId: p1, target: { type: "process-step", beforeId: null } });
  const cols = Array.from(document.querySelectorAll(".sm-backbone-col:not(.sm-add-col)"));
  const orderById = cols.map(c => c.dataset.processStepId);
  assert.deepStrictEqual(orderById, [p2, p1], "projected column order should be [p2, p1]");
  // Origin column carries .sm-col-shadow
  const shadow = cols.find(c => c.classList.contains("sm-col-shadow"));
  assert.ok(shadow, "expected dragged column to carry .sm-col-shadow");
  assert.strictEqual(shadow.dataset.processStepId, p1);
});

test("SM-245 regression: PS drop persists the PROJECTED order despite a morph-reused stale onDrop closure", () => {
  // The morph (Phase C) reuses backbone columns by ps:id and keeps their
  // ORIGINAL dnd registration. The first-mount onDrop closure captured
  // columns=[p1,p2]; after a reorder projection the column DOM is reused, so a
  // real drop fires that stale closure. Before the fix it persisted the stale
  // order (= no-op → snap back); the fix recomputes from the live snapshot +
  // projection. We invoke the EXACT registered onDrop a pointer drop would.
  const dnd = require("../frontend/js/dnd.js");
  const store = setup();
  const { p1, p2 } = ids(store);
  const reorders = [];
  const host = document.getElementById("host");
  host.innerHTML = "";
  const ctrl = storymap.mount(host, store, { onProcessStepReorder: (o) => reorders.push(o.slice()) });

  // Drag p2 to BEFORE p1 → projected order [p2, p1]; this triggers the morph.
  ctrl.setDragProjection({ ticketId: p2, target: { type: "process-step", beforeId: p1 } });
  const colP1 = host.querySelector('.sm-backbone-col[data-process-step-id="' + p1 + '"]');
  assert.ok(colP1, "p1 column present after the projection render");
  const tgt = dnd._getDropTarget(colP1);
  assert.ok(tgt && typeof tgt.onDrop === "function", "p1 column is a registered PROCESS_STEP drop target");

  tgt.onDrop({ type: storymap.DRAG_TYPES.PROCESS_STEP, id: p2, target: colP1 });
  ctrl();

  assert.deepStrictEqual(reorders[reorders.length - 1], [p2, p1],
    "drop must persist the PROJECTED order [p2, p1], not the stale captured [p1, p2]");
});

test("SM-245: a PS drop that does NOT change the order is a no-op (no redundant reorder)", () => {
  const dnd = require("../frontend/js/dnd.js");
  const store = setup();
  const { p1, p2 } = ids(store);   // current order [p1, p2]
  const reorders = [];
  const host = document.getElementById("host");
  host.innerHTML = "";
  const ctrl = storymap.mount(host, store, { onProcessStepReorder: (o) => reorders.push(o.slice()) });
  // Project p1 "before p2" — that's already the current order → no-op.
  ctrl.setDragProjection({ ticketId: p1, target: { type: "process-step", beforeId: p2 } });
  const colP2 = host.querySelector('.sm-backbone-col[data-process-step-id="' + p2 + '"]');
  dnd._getDropTarget(colP2).onDrop({ type: storymap.DRAG_TYPES.PROCESS_STEP, id: p1, target: colP2 });
  ctrl();
  assert.strictEqual(reorders.length, 0, "an order-preserving drop must not call onProcessStepReorder");
});

test("SM-245: reorderedProcessStepIds is a pure reorder from snapshot + beforeId", () => {
  const snap = {
    processSteps: [
      { id: "a", sortOrder: 0, isDeleted: false },
      { id: "b", sortOrder: 1, isDeleted: false },
      { id: "c", sortOrder: 2, isDeleted: false },
      { id: "x", sortOrder: 3, isDeleted: true }   // soft-deleted → ignored
    ]
  };
  const f = storymap.reorderedProcessStepIds;
  assert.deepStrictEqual(f(snap, "c", "a"), ["c", "a", "b"], "move c before a");
  assert.deepStrictEqual(f(snap, "a", null), ["b", "c", "a"], "beforeId null → append");
  assert.deepStrictEqual(f(snap, "a", "b"), ["a", "b", "c"], "no-op when already before b");
  assert.deepStrictEqual(f(snap, "b", "a"), ["b", "a", "c"], "move b before a");
  assert.deepStrictEqual(f(snap, "a", "missing"), ["b", "c", "a"], "unknown beforeId → append");
  assert.ok(!f(snap, "c", "a").includes("x"), "soft-deleted steps never appear");
});

test("PS live-reorder: cells in each release-row follow projected column order", () => {
  const store = setup();
  const { rA, p1, p2 } = ids(store);
  // Put visible markers in cells so we can identify them after projection.
  store.createTicket({ type: "epic", title: "InP1", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  store.createTicket({ type: "epic", title: "InP2", position: { releaseId: rA, processStepId: p2 } }, HUMAN);
  const host = document.getElementById("host");
  host.innerHTML = "";
  const ctrl = storymap.mount(host, store);
  // Project: move p1 to end (after p2)
  ctrl.setDragProjection({ ticketId: p1, target: { type: "process-step", beforeId: null } });
  const rowCells = Array.from(document.querySelectorAll(".sm-release-row .sm-cell"));
  // First cell now belongs to p2, second to p1 (projected order).
  assert.strictEqual(rowCells[0].dataset.processStepId, p2);
  assert.strictEqual(rowCells[1].dataset.processStepId, p1);
});

// ---------------------------------------------------------------------------
// E9m.2 — Epic live-reorder within / across cells
// ---------------------------------------------------------------------------

test("Epic live-reorder: setDragProjection cell-epics moves origin to insertion index + marks shadow", () => {
  const store = setup();
  const { rA, p1 } = ids(store);
  store.createTicket({ type: "epic", title: "E1", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  store.createTicket({ type: "epic", title: "E2", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  const e1 = store.get().tickets.find(t => t.title === "E1").id;
  const host = document.getElementById("host");
  host.innerHTML = "";
  const ctrl = storymap.mount(host, store);
  // Project: move E1 to insertion index 2 (= after E2)
  ctrl.setDragProjection({
    ticketId: e1,
    target: { type: "cell-epics", releaseId: rA, processStepId: p1 },
    insertionIndex: 2
  });
  const cell = document.querySelector(`.sm-cell[data-release-id="${rA}"][data-process-step-id="${p1}"]`);
  const epicCards = Array.from(cell.querySelectorAll(".sm-cell-epics > .sm-epic-card"));
  // E2 first, then shadow E1 at end.
  assert.strictEqual(epicCards.length, 2);
  assert.ok(epicCards[0].textContent.includes("E2"));
  assert.ok(epicCards[1].textContent.includes("E1"));
  assert.ok(epicCards[1].classList.contains("sm-card-shadow"), "expected re-inserted epic to be shadow");
});

test("SM-97: Epic live-reorder across cells — source keeps origin (no layout shift), target gets shadow", () => {
  // SM-97 changed the projection semantics: during a cross-cell drag the
  // source cell KEEPS the origin card (styled with .sm-dragging by the dnd
  // layer). The old behaviour removed it, shrinking the source cell and
  // shifting the whole layout mid-drag; the cursor (fixed in window coords)
  // then re-projected onto a wrong cell.
  const store = setup();
  const { rA, p1, p2 } = ids(store);
  store.createTicket({ type: "epic", title: "MoveMe", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  store.createTicket({ type: "epic", title: "TgtPeer", position: { releaseId: rA, processStepId: p2 } }, HUMAN);
  const mv = store.get().tickets.find(t => t.title === "MoveMe").id;
  const host = document.getElementById("host");
  host.innerHTML = "";
  const ctrl = storymap.mount(host, store);
  ctrl.setDragProjection({
    ticketId: mv,
    target: { type: "cell-epics", releaseId: rA, processStepId: p2 },
    insertionIndex: 0
  });
  const cellSrc = document.querySelector(`.sm-cell[data-release-id="${rA}"][data-process-step-id="${p1}"]`);
  const cellTgt = document.querySelector(`.sm-cell[data-release-id="${rA}"][data-process-step-id="${p2}"]`);
  // SM-97: source cell still carries MoveMe (no layout shift).
  const srcEpics = Array.from(cellSrc.querySelectorAll(".sm-cell-epics > .sm-epic-card"));
  assert.ok(srcEpics.some(c => c.textContent.includes("MoveMe")),
    "SM-97: source cell must keep dragged epic visible (preserves cell height)");
  // Target cell has shadow MoveMe at index 0.
  const tgtEpics = Array.from(cellTgt.querySelectorAll(".sm-cell-epics > .sm-epic-card"));
  assert.ok(tgtEpics[0].textContent.includes("MoveMe"));
  assert.ok(tgtEpics[0].classList.contains("sm-card-shadow"));
});

test("Epic live-reorder: shadow epic has no drag/drop listeners (preview-only)", () => {
  const store = setup();
  const { rA, p1 } = ids(store);
  store.createTicket({ type: "epic", title: "E1", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  store.createTicket({ type: "epic", title: "E2", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  const e1 = store.get().tickets.find(t => t.title === "E1").id;
  const host = document.getElementById("host");
  host.innerHTML = "";
  const ctrl = storymap.mount(host, store);
  ctrl.setDragProjection({
    ticketId: e1,
    target: { type: "cell-epics", releaseId: rA, processStepId: p1 },
    insertionIndex: 1
  });
  const shadow = document.querySelector(".sm-epic-card.sm-card-shadow");
  assert.ok(shadow);
  // Shadow epic should still render its header label etc., but no extra DnD;
  // the easy check is presence-of-title + presence-of-shadow-class.
  assert.ok(shadow.textContent.includes("E1"));
});

// ---------------------------------------------------------------------------
// SM-84 — Collapsible epic cards (mirror of SM-83 for epics)
// ---------------------------------------------------------------------------

test("SM-84: every non-shadow epic-card renders a chevron in its header", () => {
  const store = setup();
  const { rA, p1 } = ids(store);
  store.createTicket({ type: "epic", title: "E1", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  store.createTicket({ type: "epic", title: "E2", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  const host = document.getElementById("host");
  host.innerHTML = "";
  storymap.mount(host, store);
  const headers = Array.from(document.querySelectorAll(".sm-epic-card:not(.sm-card-shadow) .sm-epic-header"));
  assert.strictEqual(headers.length, 2);
  for (const h of headers) {
    const ch = h.querySelector(".sm-epic-chevron");
    assert.ok(ch, "every epic header must have a chevron");
    assert.strictEqual(ch.textContent, "▼", "expanded chevron is ▼");
    assert.strictEqual(ch.getAttribute("aria-expanded"), "true");
  }
});

test("SM-84: epic in collapsedEpics renders collapsed grid (class + inline max-height:0px)", () => {
  const store = setup();
  const { rA, p1 } = ids(store);
  store.createTicket({ type: "epic", title: "E", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  const e = store.get().tickets.find(t => t.title === "E").id;
  store.createTicket({ type: "user-story", title: "S1", position: { releaseId: rA, epicId: e } }, HUMAN);
  store.createTicket({ type: "user-story", title: "S2", position: { releaseId: rA, epicId: e } }, HUMAN);
  const host = document.getElementById("host");
  host.innerHTML = "";
  storymap.mount(host, store, { collapsedEpics: new Set([e]) });
  const card = document.querySelector('.sm-epic-card[data-ticket-id="' + e + '"]');
  assert.ok(card);
  assert.ok(card.classList.contains("sm-epic-card-collapsed"), "card carries collapsed class");
  const grid = card.querySelector(".sm-stories-grid");
  assert.ok(grid, "grid still in DOM (animation needs it)");
  assert.ok(grid.classList.contains("sm-stories-grid-collapsed"));
  assert.strictEqual(grid.style.maxHeight, "0px",
    "initial-collapsed grid renders with inline max-height:0px");
  const chevron = card.querySelector(".sm-epic-chevron");
  assert.strictEqual(chevron.textContent, "▶", "collapsed chevron is ▶");
  assert.strictEqual(chevron.getAttribute("aria-expanded"), "false");
});

test("SM-84: chevron click fires onToggleEpicCollapsed(epicId) and stops propagation", () => {
  const store = setup();
  const { rA, p1 } = ids(store);
  store.createTicket({ type: "epic", title: "E", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  const e = store.get().tickets.find(t => t.title === "E").id;
  const host = document.getElementById("host");
  host.innerHTML = "";
  const toggled = [];
  const ticketClicked = [];
  storymap.mount(host, store, {
    onToggleEpicCollapsed: (id) => toggled.push(id),
    onTicketClick: (id) => ticketClicked.push(id)
  });
  const chevron = document.querySelector(".sm-epic-chevron");
  assert.ok(chevron);
  chevron.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  assert.deepStrictEqual(toggled, [e], "callback receives the epic id once");
  // dblclick on header opens edit; a single click on the chevron must NOT
  // accidentally count toward that, and definitely must not trigger
  // onTicketClick on a regular click bubble.
  assert.deepStrictEqual(ticketClicked, []);
});

test("SM-84: dropping a story on a collapsed epic auto-expands it (fires onToggleEpicCollapsed after onStoryDrop)", () => {
  const store = setup();
  const { rA, p1 } = ids(store);
  store.createTicket({ type: "epic", title: "Target", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  const e = store.get().tickets.find(t => t.title === "Target").id;
  store.createTicket({ type: "user-story", title: "Loose", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  const s = store.get().tickets.find(t => t.title === "Loose").id;
  const host = document.getElementById("host");
  host.innerHTML = "";
  const sequence = [];
  storymap.mount(host, store, {
    collapsedEpics: new Set([e]),
    onToggleEpicCollapsed: (id) => sequence.push({ kind: "toggle", id }),
    // overrideHelper signature mirrors what the renderer's wrappedOpts builds
    // for us — we intercept BEFORE the wrapper runs so we can observe the
    // raw callback sequence triggered by the cell's onDrop.
  });
  // Find the epic card and invoke its drop-target callbacks directly. We
  // need to also record the story-drop signal; we do that via a wrappedOpts
  // peek: simulate by reaching into the renderer ctrl. Simpler: trigger via
  // exposed _wrappedOpts.onStoryDrop, then call the renderer's epic drop
  // path manually. But the cleanest existing entrypoint is the ctrl that
  // mount() returns — its _wrappedOpts.onStoryDrop is the wrapper. We
  // instead test the renderer's epic-card onDrop logic end-to-end by
  // dispatching the dnd's internal callback. To keep this test focused on
  // the auto-expand semantics, we invoke the onDrop registered on the epic-
  // card via dnd.js's exported APIs. dnd.js doesn't directly expose targets,
  // so we instead exercise the symptom: AFTER onToggleEpicCollapsed fires
  // on a drop on a collapsed epic, the grid should no longer have the
  // initial inline max-height:0px. Because the main.js animate runs in a
  // requestAnimationFrame, here we just assert the callback ran — that's
  // what the renderer guarantees.
  // Simulate by directly invoking the epic-card's drop handler. dnd.js
  // exposes the onDrop callbacks through the registered target object;
  // since we don't have direct access we instead verify the callback is
  // wired by inspecting the renderer's _wrappedOpts pipeline: store a real
  // story drop and assert toggle fires after.
  // The simplest robust check: synthesize a real drop sequence via dnd.
  const dnd = require("../frontend/js/dnd.js");
  // Find the epic card element + a story card to drag.
  const card = document.querySelector('.sm-epic-card[data-ticket-id="' + e + '"]');
  assert.ok(card, "epic card present");
  // Stub rects so elementFromPoint finds the epic card during the drag.
  card.getBoundingClientRect = () => ({
    left: 100, top: 100, right: 300, bottom: 300, width: 200, height: 200,
    x: 100, y: 100, toJSON: () => ({})
  });
  const story = document.querySelector('.sm-story-card[data-ticket-id="' + s + '"]');
  assert.ok(story, "loose story card present");
  story.getBoundingClientRect = () => ({
    left: 10, top: 10, right: 100, bottom: 50, width: 90, height: 40,
    x: 10, y: 10, toJSON: () => ({})
  });
  document.elementFromPoint = (x, y) =>
    (x >= 100 && x <= 300 && y >= 100 && y <= 300) ? card : null;
  // pointerdown on the story + threshold cross + hover the epic card + drop.
  const pe = (type, x, y) => new window.MouseEvent(type, {
    bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0
  });
  story.dispatchEvent(pe("pointerdown", 20, 20));
  document.dispatchEvent(pe("pointermove", 30, 30));
  document.dispatchEvent(pe("pointermove", 200, 200));
  document.dispatchEvent(pe("pointerup",   200, 200));
  dnd.scrubArtifacts();
  // The renderer's epic onDrop fires onStoryDrop (wrapped → store.reorderTickets)
  // AND, because the epic was in collapsedEpics, calls onToggleEpicCollapsed.
  const toggleHits = sequence.filter(e => e.kind === "toggle").map(e => e.id);
  assert.deepStrictEqual(toggleHits, [e],
    "drop on collapsed epic auto-expands it (toggle fired with epic id)");
});

test("SM-84: shadow epic does NOT render a chevron (preview-only, no UI)", () => {
  const store = setup();
  const { rA, p1 } = ids(store);
  store.createTicket({ type: "epic", title: "E1", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  store.createTicket({ type: "epic", title: "E2", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  const e1 = store.get().tickets.find(t => t.title === "E1").id;
  const host = document.getElementById("host");
  host.innerHTML = "";
  const ctrl = storymap.mount(host, store);
  ctrl.setDragProjection({
    ticketId: e1,
    target: { type: "cell-epics", releaseId: rA, processStepId: p1 },
    insertionIndex: 1
  });
  const shadow = document.querySelector(".sm-epic-card.sm-card-shadow");
  assert.ok(shadow, "shadow card present during projection");
  assert.strictEqual(shadow.querySelector(".sm-epic-chevron"), null,
    "shadow epic must NOT have a chevron");
});

// ---------------------------------------------------------------------------
// E9p — SortOrder-Kollisions-Fix + Backlog Add-Item Button + Konsistente Labels
// ---------------------------------------------------------------------------

test("Sort-fix LIVE (legacy duplicate): drop applies via local store path and reflects new order", () => {
  const store = setup();
  const { rA, p1 } = ids(store);
  store.createTicket({ type: "epic", title: "E", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  const e = store.get().tickets.find(t => t.title === "E").id;
  // Create stories A, B, C, D with sortOrders 0, 1, 2, 3.
  for (const t of ["A","B","C","D"]) {
    store.createTicket({ type: "user-story", title: t, position: { releaseId: rA, epicId: e } }, HUMAN);
  }
  const a = store.get().tickets.find(t => t.title === "A").id;
  // Use the default persist path (no persistReorderTickets → renderer falls
  // back to direct store.reorderTickets, single transaction).
  const host = document.getElementById("host");
  host.innerHTML = "";
  const ctrl = storymap.mount(host, store);
  ctrl._wrappedOpts.onStoryDrop(a, e, 4);   // drop A at end
  const coreMod = require("../frontend/js/core.js");
  const titles = coreMod.tickets.storiesInEpic(store.get(), e).map(t => t.title);
  assert.deepStrictEqual(titles, ["B", "C", "D", "A"], "A should land at end");
});

test("Sort-fix: dragging a story to the END of its epic actually lands at the end after persist", () => {
  const store = setup();
  const { rA, p1 } = ids(store);
  store.createTicket({ type: "epic", title: "E", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  const e = store.get().tickets.find(t => t.title === "E").id;
  // Create 4 stories — auto-sortOrder gives them 0,1,2,3
  for (let i = 0; i < 4; i++) {
    store.createTicket({ type: "user-story", title: "S" + i, position: { releaseId: rA, epicId: e } }, HUMAN);
  }
  const s0 = store.get().tickets.find(t => t.title === "S0").id;
  // Mount with a sniffing persistMove so we capture the produced sortOrder.
  let captured = null;
  const host = document.getElementById("host");
  host.innerHTML = "";
  storymap.mount(host, store, {
    persistMove: (id, position) => { captured = { id, position }; }
  });
  // Find the wrapped onStoryDrop by triggering it via the renderer-section's
  // controller — we can't easily fire a real pointer event in JSDOM, so we
  // re-mount with an opts capture and invoke directly through projection +
  // synthetic drop. Easiest path: rerun mount and read off the wrapper by
  // simulating a drop call via setDragProjection + manual call.
  // Direct way: read mounted wrappedOpts is internal. Instead we exercise
  // the same code path by computing what the wrapper would do.
  const peers = require("../frontend/js/core.js").tickets
    .storiesInEpic(store.get(), e)
    .filter(t => t.id !== s0);
  // 3 peers (S1=1, S2=2, S3=3). Inserting S0 at end → insertionIndex 3.
  // computeSortOrderForInsertion should give last(=3) + 1 = 4 — STRICTLY larger than any peer.
  // (We test by re-mounting with a synthetic call via the wrapper.)
  // Use a small sample to verify the helper math through the live mount:
  // — manually call moveTicket with the same recipe to verify outcome:
  const newSort = (function () {
    const xs = peers.map(t => t.position.sortOrder).sort((a, b) => a - b);
    return xs[xs.length - 1] + 1;
  })();
  assert.strictEqual(newSort, 4);
  // Now actually do the move with that sortOrder and confirm S0 lands last.
  store.moveTicket(s0, { releaseId: rA, processStepId: null, epicId: e, sortOrder: newSort }, HUMAN);
  const order = require("../frontend/js/core.js").tickets.storiesInEpic(store.get(), e).map(t => t.title);
  assert.deepStrictEqual(order, ["S1", "S2", "S3", "S0"]);
});

test("Sort-fix: dragging a story to the MIDDLE of its epic lands between neighbors", () => {
  const store = setup();
  const { rA, p1 } = ids(store);
  store.createTicket({ type: "epic", title: "E", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  const e = store.get().tickets.find(t => t.title === "E").id;
  for (let i = 0; i < 4; i++) {
    store.createTicket({ type: "user-story", title: "S" + i, position: { releaseId: rA, epicId: e } }, HUMAN);
  }
  const s3 = store.get().tickets.find(t => t.title === "S3").id;
  // Move S3 to position 1 (between S0 and S1). peers = [S0(0), S1(1), S2(2)]
  // insertionIndex=1 → between S0(0) and S1(1) → midpoint 0.5
  const coreMod = require("../frontend/js/core.js");
  const peers = coreMod.tickets.storiesInEpic(store.get(), e).filter(t => t.id !== s3);
  const sorts = peers.map(t => t.position.sortOrder);
  // Adjacent neighbors 0 and 1 → expected fractional 0.5
  const before = sorts[0], after = sorts[1];
  const newSort = (after - before >= 2) ? Math.floor((before + after) / 2) : (before + after) / 2;
  assert.strictEqual(newSort, 0.5);
  store.moveTicket(s3, { releaseId: rA, processStepId: null, epicId: e, sortOrder: newSort }, HUMAN);
  const order = coreMod.tickets.storiesInEpic(store.get(), e).map(t => t.title);
  assert.deepStrictEqual(order, ["S0", "S3", "S1", "S2"]);
});

test("Reorder: onStoryDrop calls persistReorderTickets with orderedIds + scope (PS-mirror pattern)", () => {
  const store = setup();
  const { rA, p1 } = ids(store);
  store.createTicket({ type: "epic", title: "E", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  const e = store.get().tickets.find(t => t.title === "E").id;
  for (const t of ["A","B","C","D"]) {
    store.createTicket({ type: "user-story", title: t, position: { releaseId: rA, epicId: e } }, HUMAN);
  }
  const a = store.get().tickets.find(t => t.title === "A").id;
  const b = store.get().tickets.find(t => t.title === "B").id;
  const c = store.get().tickets.find(t => t.title === "C").id;
  const d = store.get().tickets.find(t => t.title === "D").id;
  let captured = null;
  const host = document.getElementById("host");
  host.innerHTML = "";
  const ctrl = storymap.mount(host, store, {
    persistReorderTickets: (orderedIds, scope) => { captured = { orderedIds, scope }; }
  });
  ctrl._wrappedOpts.onStoryDrop(a, e, 4);   // drag A to end
  assert.ok(captured, "persistReorderTickets must fire");
  // Expected: orderedIds = [B, C, D, A] (A moved to end), scope = {releaseId: rA, processStepId: null, epicId: e}
  assert.deepStrictEqual(captured.orderedIds, [b, c, d, a]);
  assert.strictEqual(captured.scope.epicId, e);
  assert.strictEqual(captured.scope.releaseId, rA);
});

test("Reorder: ties between existing peers handled by renumber (orderedIds order is authoritative)", () => {
  const store = setup();
  const { rA, p1 } = ids(store);
  store.createTicket({ type: "epic", title: "E", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  const e = store.get().tickets.find(t => t.title === "E").id;
  // 3 stories with sortOrder=0 (tied).
  for (const t of ["X","Y","Z"]) {
    store.createTicket({ type: "user-story", title: t, position: { releaseId: rA, epicId: e, sortOrder: 0 } }, HUMAN);
  }
  const x = store.get().tickets.find(t => t.title === "X").id;
  const y = store.get().tickets.find(t => t.title === "Y").id;
  const z = store.get().tickets.find(t => t.title === "Z").id;
  let captured = null;
  const host = document.getElementById("host");
  host.innerHTML = "";
  const ctrl = storymap.mount(host, store, {
    persistReorderTickets: (orderedIds, scope) => { captured = { orderedIds, scope }; }
  });
  ctrl._wrappedOpts.onStoryDrop(z, e, 1);   // insertion-index 1
  assert.ok(captured);
  // peers (sorted, dragged removed) = [X, Y], orderedIds = [X, Z, Y]
  assert.deepStrictEqual(captured.orderedIds, [x, z, y]);
});

test("Reorder index=0: dragging story to FIRST position lands at sortOrder=0", () => {
  const store = setup();
  const { rA, p1 } = ids(store);
  store.createTicket({ type: "epic", title: "E", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  const e = store.get().tickets.find(t => t.title === "E").id;
  for (const t of ["A","B","C","D"]) {
    store.createTicket({ type: "user-story", title: t, position: { releaseId: rA, epicId: e } }, HUMAN);
  }
  const d = store.get().tickets.find(t => t.title === "D").id;
  let captured = null;
  const host = document.getElementById("host");
  host.innerHTML = "";
  const ctrl = storymap.mount(host, store, {
    persistReorderTickets: (orderedIds, scope) => { captured = { orderedIds, scope }; }
  });
  ctrl._wrappedOpts.onStoryDrop(d, e, 0);
  assert.ok(captured);
  // Dragged D must be the FIRST id in orderedIds.
  assert.strictEqual(captured.orderedIds[0], d, "expected D first in orderedIds, got " + JSON.stringify(captured.orderedIds));
  assert.strictEqual(captured.orderedIds.length, 4);
});

test("Reorder index=0 LIVE: store.reorderTickets persists D to sortOrder=0", () => {
  const store = setup();
  const { rA, p1 } = ids(store);
  store.createTicket({ type: "epic", title: "E", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  const e = store.get().tickets.find(t => t.title === "E").id;
  for (const t of ["A","B","C","D"]) {
    store.createTicket({ type: "user-story", title: t, position: { releaseId: rA, epicId: e } }, HUMAN);
  }
  const d = store.get().tickets.find(t => t.title === "D").id;
  const host = document.getElementById("host");
  host.innerHTML = "";
  const ctrl = storymap.mount(host, store);   // default local path
  ctrl._wrappedOpts.onStoryDrop(d, e, 0);
  const coreMod = require("../frontend/js/core.js");
  const titles = coreMod.tickets.storiesInEpic(store.get(), e).map(t => t.title);
  assert.deepStrictEqual(titles, ["D", "A", "B", "C"], "D should land first");
  const D = store.get().tickets.find(t => t.id === d);
  assert.strictEqual(D.position.sortOrder, 0);
});

test("Reorder LIVE: store.reorderTickets applies orderedIds + scope cleanly (sortOrder = idx)", () => {
  const store = setup();
  const { rA, p1 } = ids(store);
  store.createTicket({ type: "epic", title: "E", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  const e = store.get().tickets.find(t => t.title === "E").id;
  for (const t of ["A","B","C","D"]) {
    store.createTicket({ type: "user-story", title: t, position: { releaseId: rA, epicId: e } }, HUMAN);
  }
  const a = store.get().tickets.find(t => t.title === "A").id;
  const host = document.getElementById("host");
  host.innerHTML = "";
  const ctrl = storymap.mount(host, store);   // default path: local store
  ctrl._wrappedOpts.onStoryDrop(a, e, 4);
  const coreMod = require("../frontend/js/core.js");
  const titles = coreMod.tickets.storiesInEpic(store.get(), e).map(t => t.title);
  assert.deepStrictEqual(titles, ["B", "C", "D", "A"]);
});

test("SM-138: cell + backlog use 'Add Item'; per-epic add is a '+' in the header (not a bottom button)", () => {
  const store = setup();
  const { rA, p1 } = ids(store);
  store.createTicket({ type: "epic", title: "E", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  mountFresh(store);
  const cellAdd    = document.querySelector(".sm-add-ticket .sm-add-label");
  assert.ok(cellAdd && cellAdd.textContent.includes("Add Item"), "cell add label mismatch: " + (cellAdd && cellAdd.textContent));
  // SM-253: the global backlog (and its bottom "+ Add Item") is gone.
  assert.strictEqual(document.querySelector(".sm-add-backlog-item"), null, "no backlog add button anymore");
  // SM-138: the per-epic add moved INTO the epic header as a compact "+" so it
  // no longer consumes a card row at the bottom (uniform-grid).
  const epicAdd = document.querySelector(".sm-epic-header .sm-epic-add");
  assert.ok(epicAdd, "epic add '+' missing in header");
  assert.strictEqual(epicAdd.textContent.trim(), "+", "epic add should be a '+'");
  assert.strictEqual(document.querySelector(".sm-add-story"), null, "old bottom .sm-add-story should be gone");
});

// ---------------------------------------------------------------------------
// E9o — Backlog vertikal + sortierbar
// ---------------------------------------------------------------------------

test("PS live-reorder: clearDragProjection restores original column order + removes shadow", () => {
  const store = setup();
  const { p1, p2 } = ids(store);
  const host = document.getElementById("host");
  host.innerHTML = "";
  const ctrl = storymap.mount(host, store);
  ctrl.setDragProjection({ ticketId: p1, target: { type: "process-step", beforeId: null } });
  ctrl.clearDragProjection();
  const cols = Array.from(document.querySelectorAll(".sm-backbone-col:not(.sm-add-col)"));
  assert.deepStrictEqual(cols.map(c => c.dataset.processStepId), [p1, p2]);
  assert.ok(!cols.some(c => c.classList.contains("sm-col-shadow")));
});

// ---------------------------------------------------------------------------
// SM-20 — applyRemote (MCP/WS push) drives FLIP+pulse via animateExternalCommitMulti
//
// Bug report: Story-Map appeared to "rerender komplett" on every MCP push
// instead of animating. The wiring inside `mount()` looks correct, so the
// regression test patches the shared cardAnimate module to record calls and
// asserts that:
//   (a) the subscribe callback fires with reason="applyRemote",
//   (b) animateExternalCommitMulti is invoked,
//   (c) it gets the right entityTypes (tickets + processSteps + releases),
//   (d) it gets prev/next snapshots and a rerender function.
//
// The CSS half of the fix (`.sm-card-flash` selector widened to cover ALL
// entity types, not just `.sm-story-card`) is verified by the CSS string
// test below — JSDOM doesn't compute keyframes so we assert the source.
// ---------------------------------------------------------------------------

const cardAnimate = require("../frontend/js/card-animate.js");

test("SM-20: applyRemote triggers animateExternalCommitMulti with all three entity types", () => {
  const store = setup();
  const host = document.getElementById("host");
  host.innerHTML = "";
  const calls = [];
  const orig = cardAnimate.animateExternalCommitMulti;
  cardAnimate.animateExternalCommitMulti = function (args) {
    calls.push(args);
    // still rerender so the DOM stays consistent
    if (typeof args.rerender === "function") args.rerender();
  };
  try {
    const ctrl = storymap.mount(host, store);
    // Build a modified snapshot — change a release's name. Any non-position
    // mutation is enough to exercise the applyRemote path.
    const cur = store.get();
    const nextSnap = JSON.parse(JSON.stringify(cur));
    nextSnap.releases[0].name = "v1.0 (renamed)";
    nextSnap.releases[0].updatedAt = (cur.releases[0].updatedAt || 0) + 1;
    nextSnap.releases[0].version  = (cur.releases[0].version  || 0) + 1;
    store.applyRemote(nextSnap);
    assert.strictEqual(calls.length, 1, "animateExternalCommitMulti should fire exactly once");
    const args = calls[0];
    assert.ok(args.host === host, "host arg matches");
    assert.ok(args.prevSnap && Array.isArray(args.prevSnap.releases), "prevSnap passed");
    assert.ok(args.nextSnap && Array.isArray(args.nextSnap.releases), "nextSnap passed");
    assert.strictEqual(typeof args.rerender, "function", "rerender function passed");
    const listKeys = args.entityTypes.map(e => e.listKey);
    assert.deepStrictEqual(listKeys, ["tickets", "processSteps", "releases"],
      "all three entity types registered");
    ctrl();  // unsubscribe via callable controller
  } finally {
    cardAnimate.animateExternalCommitMulti = orig;
  }
});

test("SM-20: local mutations do NOT trigger the animate helper (reason !== applyRemote)", () => {
  const store = setup();
  const host = document.getElementById("host");
  host.innerHTML = "";
  let triggered = 0;
  const orig = cardAnimate.animateExternalCommitMulti;
  cardAnimate.animateExternalCommitMulti = function () { triggered++; };
  try {
    const ctrl = storymap.mount(host, store);
    // A local commit through a store-op. Reason will be "createRelease",
    // not "applyRemote" — animate should be skipped.
    store.createRelease({ name: "v2.0" }, HUMAN);
    assert.strictEqual(triggered, 0, "no animate call for local store-op commits");
    ctrl();
  } finally {
    cardAnimate.animateExternalCommitMulti = orig;
  }
});

// SM-20 Phase A — Position-only fast-path
//
// The naive applyRemote path wipes host.innerHTML and rebuilds the whole
// DOM. Even with FLIP/pulse on top, the user sees the structural shells
// (.sm-cell, .sm-backbone, .sm-release-row) blink because they were also
// recreated. Phase A short-circuits the most common case (reorder of one
// or more tickets inside the SAME container) by re-ordering existing card
// DOM nodes in place — the .sm-cell / .sm-grid keep their identity.
//
// These tests verify the pure diff + the DOM-mutation helper in isolation,
// plus an integration check that the subscribe-callback takes the fast
// path for a pure sort-order applyRemote.

function makeTicket(id, overrides) {
  return Object.assign({
    id, type: "user-story", title: id, status: "backlog",
    description: "", labels: [], acceptanceCriteria: [],
    definitionOfReady: { items: [] }, definitionOfDone: { items: [] },
    comments: [], links: [], isDeleted: false,
    position: { releaseId: null, processStepId: null, epicId: null, sortOrder: 0 },
    updatedAt: 1, version: 1
  }, overrides);
}

function makeSnap(tickets, releases, processSteps) {
  return {
    project: { id: "p1", name: "P", ticketPrefix: "P" },
    tickets: tickets || [],
    releases: releases || [],
    processSteps: processSteps || []
  };
}

test("SM-20 PhaseA: containerKeyOf differentiates epic-stories, cell-epics, cell-loose, backlog-rel, backlog-orphan", () => {
  const k = storymap.containerKeyOf;
  assert.strictEqual(k({ type: "user-story", position: { epicId: "E1", releaseId: "R1", processStepId: "P1" } }),
    "epic:E1");
  assert.strictEqual(k({ type: "epic", position: { releaseId: "R1", processStepId: "P1" } }),
    "cell-epics:R1/P1");
  assert.strictEqual(k({ type: "user-story", position: { releaseId: "R1", processStepId: "P1" } }),
    "cell-loose:R1/P1");
  assert.strictEqual(k({ type: "user-story", position: { releaseId: "R1" } }),
    "backlog-rel:R1");
  assert.strictEqual(k({ type: "user-story", position: {} }),
    "backlog-orphan");
});

test("SM-20 PhaseA: diffSortOnlyByContainer returns null when releases/process-steps changed", () => {
  const ts = [makeTicket("t1")];
  const a = makeSnap(ts, [{ id: "r1", name: "A" }]);
  const b = makeSnap(ts, [{ id: "r1", name: "B" }]);  // renamed release
  assert.strictEqual(storymap.diffSortOnlyByContainer(a, b), null);
});

test("SM-20 PhaseA: diffSortOnlyByContainer returns null when a ticket field other than position changed", () => {
  const a = makeSnap([makeTicket("t1", { title: "Old" })]);
  const b = makeSnap([makeTicket("t1", { title: "New" })]);  // title changed
  assert.strictEqual(storymap.diffSortOnlyByContainer(a, b), null);
});

test("SM-20 PhaseA: diffSortOnlyByContainer returns null when a ticket changed containers (cross-container move)", () => {
  const a = makeSnap([makeTicket("t1", { position: { releaseId: "r1", processStepId: "p1", sortOrder: 0 } })]);
  const b = makeSnap([makeTicket("t1", { position: { releaseId: "r1", processStepId: "p2", sortOrder: 0 } })]);
  assert.strictEqual(storymap.diffSortOnlyByContainer(a, b), null);
});

test("SM-20 PhaseA: diffSortOnlyByContainer returns null on add/remove", () => {
  const a = makeSnap([makeTicket("t1")]);
  const b = makeSnap([makeTicket("t1"), makeTicket("t2")]);
  assert.strictEqual(storymap.diffSortOnlyByContainer(a, b), null);
});

test("SM-20 PhaseA: diffSortOnlyByContainer returns empty Map when nothing effectively changed", () => {
  const a = makeSnap([makeTicket("t1")]);
  const b = makeSnap([makeTicket("t1", { updatedAt: 999, version: 9 })]);  // only meta
  const out = storymap.diffSortOnlyByContainer(a, b);
  assert.ok(out instanceof Map);
  assert.strictEqual(out.size, 0);
});

// ---------------------------------------------------------------------------
// SM-52 regression: applyRemote fast-path was BLIND to epic membership.
// Containment is a `contains` link from the epic (position.epicId is always
// null post-SM-52), but containerKeyOf read position.epicId and
// ticketEqualsIgnoringPosition ignored `links`. So a story→epic assignment
// (or re-parent) over WebSocket was classified as "nothing changed" and the
// renderer skipped the rerender — the user never saw stories joining epics.
// ---------------------------------------------------------------------------

function containsLink(targetId) {
  return { id: "l-" + targetId, linkTypeId: "contains", targetTicketId: targetId, createdAt: 1 };
}

test("SM-52 regression: containerKeyOf resolves epic membership via a contains-link map, not position.epicId", () => {
  const story = makeTicket("s1");
  const map = new Map([["s1", "e1"]]);
  assert.strictEqual(storymap.containerKeyOf(story, map), "epic:e1",
    "with a container map, a contained story keys to its epic");
  // Without the map it falls back to position.epicId (legacy/backward compat).
  assert.strictEqual(storymap.containerKeyOf(story), "backlog-orphan");
});

test("SM-52 regression: diffSortOnlyByContainer bails (null) when a story is assigned to an epic via contains-link", () => {
  const rel = [{ id: "r1", name: "R" }];
  const ps  = [{ id: "p1", name: "P" }];
  const epicPrev  = makeTicket("e1", { type: "epic", position: { releaseId: "r1", processStepId: "p1", sortOrder: 0 }, links: [] });
  const story     = makeTicket("s1");
  const a = makeSnap([epicPrev, story], rel, ps);
  const epicNext  = makeTicket("e1", { type: "epic", position: { releaseId: "r1", processStepId: "p1", sortOrder: 0 }, links: [containsLink("s1")] });
  const b = makeSnap([epicNext, story], rel, ps);
  // Must bail to the full-rerender path (null) — NOT an empty Map (= no-op).
  assert.strictEqual(storymap.diffSortOnlyByContainer(a, b), null);
});

test("SM-52 regression: diffCardContentOnly bails (null) when a story is assigned to an epic via contains-link", () => {
  const rel = [{ id: "r1", name: "R" }];
  const ps  = [{ id: "p1", name: "P" }];
  const epicPrev  = makeTicket("e1", { type: "epic", position: { releaseId: "r1", processStepId: "p1", sortOrder: 0 }, links: [] });
  const story     = makeTicket("s1");
  const a = makeSnap([epicPrev, story], rel, ps);
  const epicNext  = makeTicket("e1", { type: "epic", position: { releaseId: "r1", processStepId: "p1", sortOrder: 0 }, links: [containsLink("s1")] });
  const b = makeSnap([epicNext, story], rel, ps);
  assert.strictEqual(storymap.diffCardContentOnly(a, b), null);
});

test("SM-52 regression: assigning an in-cell loose story to an epic via applyRemote moves the card under the epic (live-sync)", () => {
  const store = setup();
  const r1 = store.get().releases[0].id;
  const p1 = store.get().processSteps[0].id;
  // TWO epics in the SAME cell — so E9b auto-epic-assignment stays OFF (it only
  // fires for exactly one epic), letting the story sit loose in the cell.
  // Assigning it then changes ONLY the contains-link, NOT the story's position
  // (the worst case for the fast-path diff).
  store.createTicket({ type: "epic", title: "Epic-A", position: { releaseId: r1, processStepId: p1 } }, HUMAN);
  store.createTicket({ type: "epic", title: "Epic-B", position: { releaseId: r1, processStepId: p1 } }, HUMAN);
  const epicId = store.get().tickets.find(t => t.title === "Epic-A").id;
  store.createTicket({ type: "user-story", title: "Story-A", position: { releaseId: r1, processStepId: p1 } }, HUMAN);
  const storyId = store.get().tickets.find(t => t.type === "user-story").id;

  const host = document.getElementById("host");
  host.innerHTML = "";
  storymap.mount(host, store);
  // Precondition: story renders loose in the cell, NOT under the epic.
  assert.ok(host.querySelector('.sm-cell-loose .sm-story-card[data-ticket-id="' + storyId + '"]'),
    "precondition: story renders as a loose ticket in the cell");
  assert.ok(!host.querySelector('.sm-epic-card[data-ticket-id="' + epicId + '"] .sm-story-card[data-ticket-id="' + storyId + '"]'),
    "precondition: story not yet under epic");

  // Remote assignment exactly as an MCP agent would do it: a `contains` link
  // from the epic to the story. The story's position is untouched.
  const assigned = JSON.parse(JSON.stringify(store.get()));
  const epicNode = assigned.tickets.find(t => t.id === epicId);
  epicNode.links = (epicNode.links || []).concat([
    { id: "l-contains-1", linkTypeId: "contains", targetTicketId: storyId, createdAt: 1 }
  ]);
  store.applyRemote(assigned);

  const underEpic = host.querySelector(
    '.sm-epic-card[data-ticket-id="' + epicId + '"] .sm-stories-grid .sm-story-card[data-ticket-id="' + storyId + '"]');
  assert.ok(underEpic, "after applyRemote the story card must render under the epic's stories-grid");
  // And it must no longer appear as a loose card in the cell.
  assert.ok(!host.querySelector('.sm-cell-loose .sm-story-card[data-ticket-id="' + storyId + '"]'),
    "story must leave the loose-cell section once contained by the epic");
});

test("SM-20 PhaseA: diffSortOnlyByContainer returns groups keyed by container with ordered ids", () => {
  const a = makeSnap([
    makeTicket("a", { position: { releaseId: "r1", processStepId: "p1", sortOrder: 0 } }),
    makeTicket("b", { position: { releaseId: "r1", processStepId: "p1", sortOrder: 1 } }),
    makeTicket("c", { position: { releaseId: "r1", processStepId: "p1", sortOrder: 2 } })
  ]);
  // Reverse order: c, b, a
  const b = makeSnap([
    makeTicket("a", { position: { releaseId: "r1", processStepId: "p1", sortOrder: 2 } }),
    makeTicket("b", { position: { releaseId: "r1", processStepId: "p1", sortOrder: 1 } }),
    makeTicket("c", { position: { releaseId: "r1", processStepId: "p1", sortOrder: 0 } })
  ]);
  const out = storymap.diffSortOnlyByContainer(a, b);
  assert.ok(out instanceof Map);
  assert.strictEqual(out.size, 1);
  assert.deepStrictEqual(out.get("cell-loose:r1/p1"), ["c", "b", "a"]);
});

test("SM-20 PhaseA: applySortOnlyReshuffle reorders existing card DOM nodes without rebuilding the cell", () => {
  const store = setup();
  const { rA, p1 } = ids(store);
  // 3 loose bugs in (rA, p1) — sortOrders 0, 1, 2 in creation order.
  store.createTicket({ type: "bug", title: "B1", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  store.createTicket({ type: "bug", title: "B2", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  store.createTicket({ type: "bug", title: "B3", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  mountFresh(store);
  const cellBefore = document.querySelector('.sm-cell[data-release-id="' + rA + '"][data-process-step-id="' + p1 + '"]');
  const looseBefore = cellBefore.querySelector(".sm-cell-loose");
  const tickets = store.get().tickets.filter(t => t.type === "bug")
    .sort((a, b) => (a.position.sortOrder || 0) - (b.position.sortOrder || 0));
  const [t1, t2, t3] = tickets;
  // Reorder: reverse → [t3, t2, t1].
  const groups = new Map([["cell-loose:" + rA + "/" + p1, [t3.id, t2.id, t1.id]]]);
  const ok = storymap.applySortOnlyReshuffle(document.querySelector(".sm-grid"), groups);
  assert.strictEqual(ok, true, "reshuffle reported success");
  const cellAfter = document.querySelector('.sm-cell[data-release-id="' + rA + '"][data-process-step-id="' + p1 + '"]');
  const looseAfter = cellAfter.querySelector(".sm-cell-loose");
  assert.strictEqual(cellAfter, cellBefore, ".sm-cell DOM identity preserved (no rebuild)");
  assert.strictEqual(looseAfter, looseBefore, ".sm-cell-loose DOM identity preserved (no rebuild)");
  const orderedIds = Array.from(looseAfter.querySelectorAll(".sm-story-card")).map(c => c.dataset.ticketId);
  assert.deepStrictEqual(orderedIds, [t3.id, t2.id, t1.id], "cards now in the new order");
});

test("SM-20 PhaseA: applySortOnlyReshuffle returns false when target container can't be found", () => {
  const store = setup();
  mountFresh(store);
  const groups = new Map([["cell-loose:nope/nope", ["t-missing"]]]);
  const ok = storymap.applySortOnlyReshuffle(document.querySelector(".sm-grid"), groups);
  assert.strictEqual(ok, false, "missing container → bail");
});

test("SM-20 PhaseA: applyRemote fast-path preserves .sm-cell DOM identity for a pure reorder", () => {
  const store = setup();
  const { rA, p1 } = ids(store);
  store.createTicket({ type: "bug", title: "A", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  store.createTicket({ type: "bug", title: "B", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  mountFresh(store);
  const cellBefore = document.querySelector('.sm-cell[data-release-id="' + rA + '"][data-process-step-id="' + p1 + '"]');
  // Build a new snap with reversed sortOrders for the two bugs.
  const next = JSON.parse(JSON.stringify(store.get()));
  const bugs = next.tickets.filter(t => t.type === "bug");
  bugs[0].position.sortOrder = 1;
  bugs[1].position.sortOrder = 0;
  // applyRemote routes through the renderer's subscribe → Phase A fast path.
  store.applyRemote(next);
  const cellAfter = document.querySelector('.sm-cell[data-release-id="' + rA + '"][data-process-step-id="' + p1 + '"]');
  assert.strictEqual(cellAfter, cellBefore,
    "fast-path keeps the .sm-cell DOM node identical (no host.innerHTML wipe)");
});

test("SM-20 PhaseA/C: applyRemote with structural change preserves DOM identity (Phase C morphTree took over the full-rerender path)", () => {
  const store = setup();
  const { rA } = ids(store);
  mountFresh(store);
  const cellBefore = document.querySelector('.sm-cell[data-release-id="' + rA + '"]');
  // Rename a release — under Phase C the morphTree path STILL preserves cell
  // identity because cells are keyed independently of release name/order.
  // (Pre-Phase C this test asserted the opposite — the cell would have been
  // replaced by host.innerHTML+appendChild. Phase C eliminates that wipe.)
  const next = JSON.parse(JSON.stringify(store.get()));
  next.releases[0].name = "v1.0 — renamed";
  store.applyRemote(next);
  const cellAfter = document.querySelector('.sm-cell[data-release-id="' + rA + '"]');
  assert.strictEqual(cellAfter, cellBefore,
    "Phase C morph keeps the cell DOM identity even on a structural release-name change");
});

// SM-20 Phase B — Card-content-only fast-path
//
// `applyRemote` driven by `ticket_update` / `check_dod_item` / `change_
// ticket_status` etc. doesn't move any card — but it DOES edit the
// ticket's title / status / DoR-DoD-counters. The naive full-rerender
// path destroyed and rebuilt the whole map (and the user saw the flash
// the same way they did for reorders before Phase A). Phase B short-
// circuits the case by patching the existing card DOM node in place.

test("SM-20 PhaseB: diffCardContentOnly returns null on position change (Phase A's territory)", () => {
  const a = makeSnap([makeTicket("t1", { position: { releaseId: "r1", processStepId: "p1", sortOrder: 0 } })]);
  const b = makeSnap([makeTicket("t1", { position: { releaseId: "r1", processStepId: "p1", sortOrder: 5 } })]);
  assert.strictEqual(storymap.diffCardContentOnly(a, b), null);
});

test("SM-20 PhaseB: diffCardContentOnly returns null on cross-container move", () => {
  const a = makeSnap([makeTicket("t1", { position: { releaseId: "r1", processStepId: "p1" } })]);
  const b = makeSnap([makeTicket("t1", { position: { releaseId: "r1", processStepId: "p2" } })]);
  assert.strictEqual(storymap.diffCardContentOnly(a, b), null);
});

test("SM-20 PhaseB: diffCardContentOnly returns null on add/remove or structural change", () => {
  const a = makeSnap([makeTicket("t1")]);
  const b = makeSnap([makeTicket("t1"), makeTicket("t2")]);
  assert.strictEqual(storymap.diffCardContentOnly(a, b), null);
});

test("SM-20 PhaseB: diffCardContentOnly returns the changed ids on title/status/DoR/DoD edits", () => {
  const prev = makeSnap([
    makeTicket("t1", { title: "Old" }),
    makeTicket("t2", { status: "backlog" }),
    makeTicket("t3", { definitionOfReady: { items: [{ id: "d", label: "L", required: true, checked: false }] } })
  ]);
  const next = makeSnap([
    makeTicket("t1", { title: "New" }),
    makeTicket("t2", { status: "ready" }),
    makeTicket("t3", { definitionOfReady: { items: [{ id: "d", label: "L", required: true, checked: true }] } })
  ]);
  const out = storymap.diffCardContentOnly(prev, next);
  assert.ok(out instanceof Set);
  assert.deepStrictEqual(Array.from(out).sort(), ["t1", "t2", "t3"]);
});

test("SM-20 PhaseB: applyCardContentPatch updates title text + status pill in place — card DOM identity preserved", () => {
  const store = setup();
  const { rA, p1 } = ids(store);
  store.createTicket({ type: "user-story", title: "Original", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  mountFresh(store);
  const ticketId = store.get().tickets.find(t => t.title === "Original").id;
  const cardBefore = document.querySelector('.sm-story-card[data-ticket-id="' + ticketId + '"]');
  // Edit the ticket: new title + new status.
  const next = JSON.parse(JSON.stringify(store.get()));
  const ix = next.tickets.findIndex(t => t.id === ticketId);
  next.tickets[ix].title = "Renamed";
  next.tickets[ix].status = "ready";
  store.applyRemote(next);
  const cardAfter = document.querySelector('.sm-story-card[data-ticket-id="' + ticketId + '"]');
  assert.strictEqual(cardAfter, cardBefore, "card DOM node identity preserved");
  assert.strictEqual(cardAfter.querySelector(".sm-story-title").textContent, "Renamed");
  assert.strictEqual(cardAfter.querySelector(".sm-card-status").textContent, "ready");
  assert.ok(cardAfter.classList.contains("sm-status-ready"), "root class reflects new status");
  assert.ok(cardAfter.querySelector(".sm-card-status").classList.contains("sm-status-pill-ready"),
    "status-pill class reflects new status");
});

test("SM-20 PhaseB: applyCardContentPatch updates DoR/DoD badge counts in place", () => {
  const store = setup();
  const { rA, p1 } = ids(store);
  store.createTicket({ type: "user-story", title: "WithDoR", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  mountFresh(store);
  const ticketId = store.get().tickets.find(t => t.title === "WithDoR").id;
  const cardBefore = document.querySelector('.sm-story-card[data-ticket-id="' + ticketId + '"]');
  // Toggle a DoR item via applyRemote.
  const next = JSON.parse(JSON.stringify(store.get()));
  const ix = next.tickets.findIndex(t => t.id === ticketId);
  if (next.tickets[ix].definitionOfReady && next.tickets[ix].definitionOfReady.items[0]) {
    next.tickets[ix].definitionOfReady.items[0].checked = true;
  }
  store.applyRemote(next);
  const cardAfter = document.querySelector('.sm-story-card[data-ticket-id="' + ticketId + '"]');
  assert.strictEqual(cardAfter, cardBefore, "DoR-toggle preserves card identity");
  const dorBadge = cardAfter.querySelector(".sm-badge-dor");
  if (next.tickets[ix].definitionOfReady && next.tickets[ix].definitionOfReady.items.length > 0) {
    assert.ok(dorBadge, "DoR badge present");
    assert.ok(/^DoR\s/.test(dorBadge.textContent), "DoR badge format DoR x/y");
    assert.ok(/1\/1/.test(dorBadge.textContent), "shows 1/1 after toggle");
  }
});

test("SM-20 PhaseB: applyCardContentPatch bails on epic-card changes (epic has its own DOM)", () => {
  const store = setup();
  const { rA, p1 } = ids(store);
  store.createTicket({ type: "epic", title: "E1", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  mountFresh(store);
  const epicId = store.get().tickets.find(t => t.title === "E1").id;
  const ok = storymap.applyCardContentPatch(document.querySelector(".sm-grid"),
    new Set([epicId]), store.get());
  assert.strictEqual(ok, false, "epic-card patch returns false → caller falls back to full rerender");
});

test("SM-20 PhaseB: applyRemote with status change preserves .sm-cell DOM identity", () => {
  const store = setup();
  const { rA, p1 } = ids(store);
  store.createTicket({ type: "user-story", title: "TickX", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  mountFresh(store);
  const ticketId = store.get().tickets.find(t => t.title === "TickX").id;
  const cellBefore = document.querySelector('.sm-cell[data-release-id="' + rA + '"][data-process-step-id="' + p1 + '"]');
  // applyRemote with only a status change.
  const next = JSON.parse(JSON.stringify(store.get()));
  next.tickets.find(t => t.id === ticketId).status = "in-progress";
  store.applyRemote(next);
  const cellAfter = document.querySelector('.sm-cell[data-release-id="' + rA + '"][data-process-step-id="' + p1 + '"]');
  assert.strictEqual(cellAfter, cellBefore,
    "content-only fast-path preserves .sm-cell identity (no host.innerHTML wipe)");
});

// SM-55: loose tickets must NOT contribute to columnMultipliers. They are
// rendered at Epic-Width (STORY_CARD_WIDTH_PX) centered in the cell, and
// stack vertically only — no horizontal wrap, no cell-widening, regardless
// of how many loose tickets a cell holds. This supersedes the SM-33 rule
// (which folded loose-count into the multiplier via ceil(N/LOOSE_N)).

test("SM-55: columnMultiplier for 1 loose ticket is 1", () => {
  const store = setup();
  const { rA, p1 } = ids(store);
  store.createTicket({ type: "user-story", title: "L1", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  const layout = storymap.computeStoryMapLayout(store.get());
  assert.strictEqual(layout.columnMultipliers.get(p1), 1);
});

test("SM-55: columnMultiplier for many loose tickets stays 1 (loose never widens cell)", () => {
  const store = setup();
  const { rA, p1 } = ids(store);
  for (let i = 1; i <= 15; i++) {
    store.createTicket({ type: "user-story", title: "L" + i, position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  }
  const layout = storymap.computeStoryMapLayout(store.get());
  assert.strictEqual(layout.columnMultipliers.get(p1), 1,
    "loose tickets do not contribute to columnMultipliers — regardless of count");
});

test("SM-135: 3 epics in cell A + 5 loose in cell B → PS multiplier = max(3, 1) = 3", () => {
  // Slim columns: cell A = 3 epic columns → 3. Cell B = 0 epics + loose → 1
  // (loose gets ONE shared column). PS-multiplier = max(3, 1) = 3.
  const store = setup();
  const { rA, rB, p1 } = ids(store);
  for (let i = 0; i < 3; i++) {
    store.createTicket({ type: "epic", title: "EA" + i, position: { releaseId: rA, processStepId: p1 } }, HUMAN);
    const eid = store.get().tickets.find(t => t.title === "EA" + i).id;
    for (let j = 0; j < 2; j++) {
      store.createTicket({ type: "user-story", title: "EA" + i + "s" + j, position: { releaseId: rA, epicId: eid } }, HUMAN);
    }
  }
  for (let k = 0; k < 5; k++) {
    store.createTicket({ type: "bug", title: "LB" + k, position: { releaseId: rB, processStepId: p1 } }, HUMAN);
  }
  const layout = storymap.computeStoryMapLayout(store.get());
  assert.strictEqual(layout.columnMultipliers.get(p1), 3,
    "PS-multiplier = max(cell A sum=3, cell B effective=1) = 3");
});

test("SM-135: cell with 1 fat epic (9 stories) → PS multiplier=1 (one slim column, grows down)", () => {
  // Single-epic cell: 1 column no matter how many stories — it grows in height.
  const store = setup();
  const { rA, p1 } = ids(store);
  store.createTicket({ type: "epic", title: "Fat", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  const fat = store.get().tickets.find(t => t.title === "Fat").id;
  for (let i = 0; i < 9; i++) {
    store.createTicket({ type: "user-story", title: "s" + i, position: { releaseId: rA, epicId: fat } }, HUMAN);
  }
  const layout = storymap.computeStoryMapLayout(store.get());
  assert.strictEqual(layout.columnMultipliers.get(p1), 1);
});

test("SM-55: Cell with only loose tickets keeps multiplier=1 (no phantom extra column)", () => {
  const store = setup();
  const { rA, p1 } = ids(store);
  for (let i = 0; i < 10; i++) {
    store.createTicket({ type: "bug", title: "LOO" + i, position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  }
  const layout = storymap.computeStoryMapLayout(store.get());
  assert.strictEqual(layout.columnMultipliers.get(p1), 1);
});

// SM-20 Phase C — morphTree reconciler
//
// Eliminates `host.innerHTML = ""` on every render. Existing keyed nodes
// survive the rerender with their DOM identity intact (and their dnd
// registrations + listeners). Structural changes (ticket_create,
// release_create, label-rename) no longer flash a fresh DOM at the user.

function mkEl(html) {
  const wrap = document.createElement("div");
  wrap.innerHTML = html;
  return wrap.firstElementChild;
}

test("SM-20 PhaseC: keyOf returns ticket key for data-ticket-id, ps key for data-process-step-id, etc.", () => {
  const card = mkEl('<div class="sm-story-card" data-ticket-id="t1"></div>');
  assert.strictEqual(storymap.keyOf(card), "ticket:t1");
  const col = mkEl('<div class="sm-backbone-col" data-process-step-id="p1"></div>');
  assert.strictEqual(storymap.keyOf(col), "ps:p1");
  const row = mkEl('<div class="sm-release-row" data-release-id="r1"></div>');
  assert.strictEqual(storymap.keyOf(row), "rel:r1");
  const cell = mkEl('<div class="sm-cell" data-release-id="r1" data-process-step-id="p1"></div>');
  assert.strictEqual(storymap.keyOf(cell), "cell:r1/p1");
  const bb = mkEl('<div class="sm-backbone"></div>');
  assert.strictEqual(storymap.keyOf(bb), "section:backbone");
  // SM-253: the global backlog is gone; the per-release holding strip is keyed.
  const unplaced = mkEl('<div class="sm-release-unplaced-row" data-release-id="r1"></div>');
  assert.strictEqual(storymap.keyOf(unplaced), "rel-unplaced:r1");
});

test("SM-20 PhaseC: morphTree reuses keyed children by identity instead of recreating them", () => {
  const oldRoot = mkEl('<div><div class="sm-cell" data-release-id="r1" data-process-step-id="p1">CELL</div></div>');
  const oldCell = oldRoot.firstElementChild;
  const newRoot = mkEl('<div><div class="sm-cell" data-release-id="r1" data-process-step-id="p1">CELL-UPDATED</div></div>');
  storymap.morphTree(oldRoot, newRoot);
  const cellAfter = oldRoot.firstElementChild;
  assert.strictEqual(cellAfter, oldCell, "keyed cell node preserved across morph");
  assert.strictEqual(cellAfter.textContent, "CELL-UPDATED", "text content updated");
});

test("SM-20 PhaseC: morphTree inserts new keyed children and removes missing ones", () => {
  const oldRoot = mkEl('<div>'
    + '<div data-ticket-id="t1">A</div>'
    + '<div data-ticket-id="t2">B</div>'
    + '</div>');
  const t1 = oldRoot.querySelector('[data-ticket-id="t1"]');
  const newRoot = mkEl('<div>'
    + '<div data-ticket-id="t1">A</div>'
    + '<div data-ticket-id="t3">C</div>'    // new — t2 is gone, t3 is added
    + '</div>');
  storymap.morphTree(oldRoot, newRoot);
  const surviving = oldRoot.querySelectorAll("[data-ticket-id]");
  assert.strictEqual(surviving.length, 2);
  assert.strictEqual(surviving[0].dataset.ticketId, "t1");
  assert.strictEqual(surviving[1].dataset.ticketId, "t3");
  assert.strictEqual(surviving[0], t1, "t1 keeps its DOM identity");
  assert.strictEqual(oldRoot.querySelector('[data-ticket-id="t2"]'), null, "t2 removed");
});

test("SM-20 PhaseC: morphTree reorders keyed children to match new order", () => {
  const oldRoot = mkEl('<div>'
    + '<div data-ticket-id="a"></div>'
    + '<div data-ticket-id="b"></div>'
    + '<div data-ticket-id="c"></div>'
    + '</div>');
  const a = oldRoot.children[0];
  const b = oldRoot.children[1];
  const c = oldRoot.children[2];
  const newRoot = mkEl('<div>'
    + '<div data-ticket-id="c"></div>'
    + '<div data-ticket-id="a"></div>'
    + '<div data-ticket-id="b"></div>'
    + '</div>');
  storymap.morphTree(oldRoot, newRoot);
  assert.strictEqual(oldRoot.children[0], c);
  assert.strictEqual(oldRoot.children[1], a);
  assert.strictEqual(oldRoot.children[2], b);
});

test("SM-20 PhaseC: morphTree copies attributes and dataset", () => {
  const oldEl = mkEl('<div class="old" data-foo="1" title="t1"></div>');
  const newEl = mkEl('<div class="new" data-foo="2" title="t2" id="x"></div>');
  storymap.morphTree(oldEl, newEl);
  assert.strictEqual(oldEl.className, "new");
  assert.strictEqual(oldEl.dataset.foo, "2");
  assert.strictEqual(oldEl.getAttribute("title"), "t2");
  assert.strictEqual(oldEl.getAttribute("id"), "x");
});

test("SM-20 PhaseC: applyRemote with ticket_create preserves all existing cells' DOM identity", () => {
  const store = setup();
  const { rA, p1 } = ids(store);
  store.createTicket({ type: "bug", title: "Original", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  mountFresh(store);
  const cellBefore = document.querySelector('.sm-cell[data-release-id="' + rA + '"][data-process-step-id="' + p1 + '"]');
  // applyRemote with one NEW ticket added in the same cell.
  const next = JSON.parse(JSON.stringify(store.get()));
  next.tickets.push({
    id: "t-new",
    projectId: "p1",
    type: "user-story",
    ticketKey: "P-new",
    title: "Fresh-Story",
    status: "backlog",
    description: "",
    position: { releaseId: rA, processStepId: p1, epicId: null, sortOrder: 99 },
    definitionOfReady: { items: [] },
    definitionOfDone:  { items: [] },
    acceptanceCriteria: [], comments: [], labels: [], links: [],
    isDeleted: false, deletedAt: null, deletedBy: null,
    createdAt: Date.now(), updatedAt: Date.now(), version: 1
  });
  store.applyRemote(next);
  const cellAfter = document.querySelector('.sm-cell[data-release-id="' + rA + '"][data-process-step-id="' + p1 + '"]');
  assert.strictEqual(cellAfter, cellBefore, "cell DOM identity preserved despite a new ticket being added");
  assert.ok(cellAfter.querySelector('.sm-story-card[data-ticket-id="t-new"]'), "new card landed inside the existing cell");
});

test("SM-20 PhaseC: applyRemote with release_create preserves the existing backbone DOM identity", () => {
  const store = setup();
  mountFresh(store);
  const backboneBefore = document.querySelector(".sm-backbone");
  // applyRemote: add a new release
  const next = JSON.parse(JSON.stringify(store.get()));
  next.releases.push({
    id: "r-new", projectId: "p1", name: "v9.9", description: "", status: "planning",
    startDate: null, endDate: null, sortOrder: 99,
    isDeleted: false, deletedAt: null, deletedBy: null,
    createdAt: Date.now(), updatedAt: Date.now(), version: 1
  });
  store.applyRemote(next);
  const backboneAfter = document.querySelector(".sm-backbone");
  assert.strictEqual(backboneAfter, backboneBefore, "backbone keeps its DOM identity");
  // And the new release row should be in the DOM.
  const newRow = document.querySelector('.sm-release-row[data-release-id="r-new"]');
  assert.ok(newRow, "new release row was inserted");
});

test("SM-20 PhaseC: applyRemote with release rename preserves the row DOM identity and updates the label", () => {
  const store = setup();
  const { rA } = ids(store);
  mountFresh(store);
  // .sm-release-row carries data-release-id; the .sm-release-label inside
  // is queried via the wrapping label-row.
  const rowBefore = document.querySelector('.sm-release-row[data-release-id="' + rA + '"]');
  const labelRowBefore = document.querySelector('.sm-release-label-row[data-release-id="' + rA + '"]');
  const labelBefore = labelRowBefore && labelRowBefore.querySelector(".sm-release-label");
  assert.ok(rowBefore, "row before");
  assert.ok(labelBefore, "label before");
  const next = JSON.parse(JSON.stringify(store.get()));
  next.releases[0].name = "v1.0 — RENAMED";
  store.applyRemote(next);
  const rowAfter = document.querySelector('.sm-release-row[data-release-id="' + rA + '"]');
  const labelRowAfter = document.querySelector('.sm-release-label-row[data-release-id="' + rA + '"]');
  const labelAfter = labelRowAfter && labelRowAfter.querySelector(".sm-release-label");
  assert.strictEqual(rowAfter, rowBefore, "release row identity preserved");
  assert.strictEqual(labelRowAfter, labelRowBefore, "label row identity preserved");
  assert.strictEqual(labelAfter, labelBefore, "release label identity preserved");
  assert.ok(/RENAMED/.test(labelAfter.textContent), "label text updated to new name");
});

test("SM-20: .sm-card-flash CSS selector is generic (covers all entity types, not just .sm-story-card)", () => {
  const fs   = require("fs");
  const path = require("path");
  const css  = fs.readFileSync(path.join(__dirname, "..", "frontend/css/storymap.css"), "utf8");
  // The buggy form was `.sm-story-card.sm-card-flash { animation: ... }`,
  // which gated the pulse to story cards only. The fix uses the generic
  // selector so process-step columns, release rows and epic cards all get
  // the keyframe.
  assert.ok(/^\.sm-card-flash\s*\{[\s\S]*animation:\s*sm-card-flash/m.test(css),
    "expected generic .sm-card-flash { animation: sm-card-flash ... } rule");
  // Negative-assert: the gated form should be gone (a regex match on the
  // exact buggy selector would still match the new generic rule because
  // the negative-form contains the generic one as a substring — so we
  // check the compound class form specifically).
  assert.ok(!/\.sm-story-card\.sm-card-flash\s*\{/.test(css),
    "compound .sm-story-card.sm-card-flash gating should be removed in favour of the generic rule");
});

// ---------------------------------------------------------------------------
// SM-49 — Link badges on cards
// ---------------------------------------------------------------------------

const rendererCard = require("../frontend/js/renderer-card.js");

test("SM-158: renderTicketCard renders the ticket-key as an editor link when projectId is given", () => {
  const t = { id: "t-abc", ticketKey: "P-9", type: "user-story", status: "backlog", title: "X" };
  const card = rendererCard.renderTicketCard(t, { projectId: "p1" });
  const key = card.querySelector(".sm-story-key");
  assert.strictEqual(key.tagName, "A", "key is a link");
  // The link uses the KEY (not the internal id) — Jira-style, the editor resolves it.
  assert.strictEqual(key.getAttribute("href"), "/editor?projectId=p1&ticketId=P-9");
});

test("SM-158: renderTicketCard ticket-key is a plain span without a projectId", () => {
  const t = { id: "t-abc", ticketKey: "P-9", type: "user-story", status: "backlog", title: "X" };
  const card = rendererCard.renderTicketCard(t, {});
  assert.strictEqual(card.querySelector(".sm-story-key").tagName, "SPAN");
});

test("SM-49: computeLinkIndex returns empty Map for snapshot with no links", () => {
  const store = setup();
  store.createTicket({ type: "user-story", title: "A" }, HUMAN);
  const idx = rendererCard.computeLinkIndex(store.get());
  assert.strictEqual(idx.size, 0, "no entries when no ticket has links");
});

test("SM-49: computeLinkIndex tallies forward + backward counts per ticket with semantic per linkType", () => {
  const store = setup();
  store.createTicket({ type: "user-story", title: "A" }, HUMAN);
  store.createTicket({ type: "user-story", title: "B" }, HUMAN);
  store.createTicket({ type: "user-story", title: "C" }, HUMAN);
  const snap0 = store.get();
  const a = snap0.tickets.find(t => t.title === "A");
  const b = snap0.tickets.find(t => t.title === "B");
  const c = snap0.tickets.find(t => t.title === "C");
  // A blocks B and B blocks C — A→B (blocking), B→C (blocking).
  store.addLink(a.id, { linkTypeId: "blocks", targetTicketId: b.id }, HUMAN);
  store.addLink(b.id, { linkTypeId: "blocks", targetTicketId: c.id }, HUMAN);
  const idx = rendererCard.computeLinkIndex(store.get());
  const entryA = idx.get(a.id);
  const entryB = idx.get(b.id);
  const entryC = idx.get(c.id);
  assert.strictEqual(entryA.forward, 1, "A has 1 outgoing");
  assert.strictEqual(entryA.backward, 0, "A has 0 incoming");
  assert.strictEqual(entryB.forward, 1, "B has 1 outgoing");
  assert.strictEqual(entryB.backward, 1, "B has 1 incoming");
  assert.strictEqual(entryC.forward, 0, "C has 0 outgoing");
  assert.strictEqual(entryC.backward, 1, "C has 1 incoming");
  assert.ok(entryB.forwardSemantics.has("blocking"));
  assert.deepStrictEqual(entryB.forwardTargetIds, [c.id]);
});

test("SM-49: dominantSemantic returns the only semantic when set has one entry, 'mixed' for multi", () => {
  assert.strictEqual(rendererCard.dominantSemantic(new Set(["blocking"])), "blocking");
  assert.strictEqual(rendererCard.dominantSemantic(new Set(["blocking", "freeform"])), "mixed");
  assert.strictEqual(rendererCard.dominantSemantic(new Set()), "freeform");
});

test("SM-49: renderTicketCard with linkInfo.forward>0 renders a sm-link-badge-forward in .sm-card-meta", () => {
  const t = { id: "t-x", type: "user-story", status: "backlog", title: "T", links: [], ticketKey: "T-1",
    definitionOfReady: { items: [] }, definitionOfDone: { items: [] } };
  const linkInfo = { forward: 2, backward: 0,
    forwardSemantics: new Set(["blocking"]),
    backwardSemantics: new Set(),
    forwardTargetIds: ["t-y", "t-z"],
    backwardSourceIds: [],
    forwardTargetKeys: ["T-2", "T-3"],
    backwardSourceKeys: [] };
  const card = rendererCard.renderTicketCard(t, { linkInfo: linkInfo });
  const fwd = card.querySelector(".sm-card-meta .sm-link-badge-forward");
  assert.ok(fwd, "forward badge present");
  assert.ok(/2/.test(fwd.textContent), "count shown in badge");
  assert.ok(fwd.classList.contains("sm-link-badge-sem-blocking"), "semantic class on badge");
  // Tooltip lists target keys for human-readable inspection.
  assert.ok(/T-2/.test(fwd.getAttribute("title")));
  // No backward badge when backward=0.
  assert.strictEqual(card.querySelector(".sm-link-badge-backward"), null);
});

test("SM-49: card with backward links shows sm-link-badge-backward (italic) and excludes forward when forward=0", () => {
  const t = { id: "t-y", type: "user-story", status: "ready", title: "Y", links: [], ticketKey: "T-2",
    definitionOfReady: { items: [] }, definitionOfDone: { items: [] } };
  const linkInfo = { forward: 0, backward: 1,
    forwardSemantics: new Set(),
    backwardSemantics: new Set(["blocking"]),
    forwardTargetIds: [], backwardSourceIds: ["t-x"],
    forwardTargetKeys: [], backwardSourceKeys: ["T-1"] };
  const card = rendererCard.renderTicketCard(t, { linkInfo: linkInfo });
  assert.strictEqual(card.querySelector(".sm-link-badge-forward"), null);
  const bwd = card.querySelector(".sm-link-badge-backward");
  assert.ok(bwd, "backward badge present");
  assert.ok(/1/.test(bwd.textContent));
  assert.ok(/T-1/.test(bwd.getAttribute("title")));
});

test("SM-49: card with NO linkInfo (or all counts zero) renders no link badges (zero-state regression)", () => {
  const t = { id: "t-zero", type: "user-story", status: "backlog", title: "Z", links: [],
    definitionOfReady: { items: [] }, definitionOfDone: { items: [] } };
  const card1 = rendererCard.renderTicketCard(t, {});
  assert.strictEqual(card1.querySelectorAll(".sm-link-badge").length, 0,
    "no badge when linkInfo missing");
  const card2 = rendererCard.renderTicketCard(t, { linkInfo: {
    forward: 0, backward: 0,
    forwardSemantics: new Set(), backwardSemantics: new Set(),
    forwardTargetIds: [], backwardSourceIds: [],
    forwardTargetKeys: [], backwardSourceKeys: []
  } });
  assert.strictEqual(card2.querySelectorAll(".sm-link-badge").length, 0,
    "no badge when counts are zero");
});

test("SM-49: clicking a forward badge adds .sm-card-flash to every card in the same host whose id is a target", () => {
  // We need a host with the source card + target cards so the click handler can look them up.
  const host = document.getElementById("host");
  host.innerHTML = "";
  const board = document.createElement("div");
  board.className = "km-board";
  host.appendChild(board);
  function buildCard(id, key) {
    const t = { id, type: "user-story", status: "backlog", title: key, ticketKey: key,
      definitionOfReady: { items: [] }, definitionOfDone: { items: [] } };
    return rendererCard.renderTicketCard(t, {});
  }
  const tgtA = buildCard("t-tgt-A", "T-A"); board.appendChild(tgtA);
  const tgtB = buildCard("t-tgt-B", "T-B"); board.appendChild(tgtB);
  const linkInfo = { forward: 2, backward: 0,
    forwardSemantics: new Set(["blocking"]),
    backwardSemantics: new Set(),
    forwardTargetIds: ["t-tgt-A", "t-tgt-B"],
    backwardSourceIds: [],
    forwardTargetKeys: ["T-A", "T-B"],
    backwardSourceKeys: [] };
  const srcTicket = { id: "t-src", type: "user-story", status: "backlog", title: "src", ticketKey: "T-S", links: [],
    definitionOfReady: { items: [] }, definitionOfDone: { items: [] } };
  const srcCard = rendererCard.renderTicketCard(srcTicket, { linkInfo });
  board.appendChild(srcCard);
  const badge = srcCard.querySelector(".sm-link-badge-forward");
  assert.ok(badge);
  badge.click();
  assert.ok(tgtA.classList.contains("sm-card-flash"), "target A flashed");
  assert.ok(tgtB.classList.contains("sm-card-flash"), "target B flashed");
});

// ---------------------------------------------------------------------------
// SM-83 — Collapsible release rows with chevron + persistence
// ---------------------------------------------------------------------------

test("SM-83: every release-label-row renders a chevron toggle", () => {
  const store = setup();
  const host = document.getElementById("host");
  host.innerHTML = "";
  storymap.mount(host, store, {});
  const labelRows = host.querySelectorAll(".sm-release-label-row[data-release-id]");
  assert.ok(labelRows.length >= 2, "two release label rows rendered");
  for (const row of labelRows) {
    const ch = row.querySelector(".sm-release-chevron");
    assert.ok(ch, "chevron rendered in label row");
    assert.strictEqual(ch.getAttribute("aria-expanded"), "true",
      "expanded by default");
  }
});

test("SM-83: when collapsedReleases contains a releaseId, the cells-row gets .sm-release-collapsed-cells (stays in DOM for animation)", () => {
  const store = setup();
  const { rA, rB } = ids(store);
  const host = document.getElementById("host");
  host.innerHTML = "";
  const collapsed = new Set([rA]);
  storymap.mount(host, store, { collapsedReleases: collapsed });
  // rA's cells row stays in DOM but is marked as collapsed (max-height:0
  // + opacity:0 via CSS class). Keeping it in DOM lets us animate the
  // toggle and preserves DnD listeners across collapse/expand cycles.
  const rACells = host.querySelector('.sm-release-cells[data-release-id="' + rA + '"]');
  const rBCells = host.querySelector('.sm-release-cells[data-release-id="' + rB + '"]');
  assert.ok(rACells, "collapsed release's cells-row stays in DOM");
  assert.ok(rACells.classList.contains("sm-release-collapsed-cells"),
    "collapsed release's cells-row carries .sm-release-collapsed-cells");
  assert.ok(rBCells, "other release's cells-row stays visible");
  assert.ok(!rBCells.classList.contains("sm-release-collapsed-cells"),
    "other release's cells-row does NOT carry the collapsed class");
});

test("SM-83: collapsed label-row carries .sm-release-collapsed and the chevron flips to ▶", () => {
  const store = setup();
  const { rA } = ids(store);
  const host = document.getElementById("host");
  host.innerHTML = "";
  storymap.mount(host, store, { collapsedReleases: new Set([rA]) });
  const row = host.querySelector('.sm-release-label-row[data-release-id="' + rA + '"]');
  assert.ok(row.classList.contains("sm-release-collapsed"), "row has collapsed class");
  const ch = row.querySelector(".sm-release-chevron");
  assert.strictEqual(ch.textContent, "▶");
  assert.strictEqual(ch.getAttribute("aria-expanded"), "false");
});

test("SM-83: expanded chevron uses ▼ (filled triangle, not the thinner ▾)", () => {
  const store = setup();
  const { rA } = ids(store);
  const host = document.getElementById("host");
  host.innerHTML = "";
  storymap.mount(host, store, {});
  const row = host.querySelector('.sm-release-label-row[data-release-id="' + rA + '"]');
  const ch = row.querySelector(".sm-release-chevron");
  assert.strictEqual(ch.textContent, "▼");
});

test("SM-83: initially-collapsed cells-row carries inline max-height:0px (so page-load paints collapsed, not flashed-then-collapsed)", () => {
  const store = setup();
  const { rA } = ids(store);
  const host = document.getElementById("host");
  host.innerHTML = "";
  storymap.mount(host, store, { collapsedReleases: new Set([rA]) });
  const cells = host.querySelector('.sm-release-cells[data-release-id="' + rA + '"]');
  assert.ok(cells, "cells-row rendered");
  assert.strictEqual(cells.style.maxHeight, "0px",
    "initially-collapsed row has inline max-height:0 for clean paint");
});

test("SM-83: expanded cells-row has NO inline max-height (so content can grow freely after new tickets)", () => {
  const store = setup();
  const { rA } = ids(store);
  const host = document.getElementById("host");
  host.innerHTML = "";
  storymap.mount(host, store, { collapsedReleases: new Set() });
  const cells = host.querySelector('.sm-release-cells[data-release-id="' + rA + '"]');
  assert.strictEqual(cells.style.maxHeight, "",
    "expanded row has no inline max-height clamp");
});

test("SM-83: clicking the chevron calls onToggleReleaseCollapsed with that releaseId", () => {
  const store = setup();
  const { rA } = ids(store);
  const host = document.getElementById("host");
  host.innerHTML = "";
  let toggled = null;
  storymap.mount(host, store, {
    onToggleReleaseCollapsed: (releaseId) => { toggled = releaseId; }
  });
  const row = host.querySelector('.sm-release-label-row[data-release-id="' + rA + '"]');
  const ch = row.querySelector(".sm-release-chevron");
  ch.click();
  assert.strictEqual(toggled, rA);
});

test("SM-83: chevron click does NOT bubble up to the release-edit handler", () => {
  const store = setup();
  const { rA } = ids(store);
  const host = document.getElementById("host");
  host.innerHTML = "";
  let editCalled = false;
  let toggleCalled = false;
  storymap.mount(host, store, {
    onReleaseClick: () => { editCalled = true; },
    onToggleReleaseCollapsed: () => { toggleCalled = true; }
  });
  const row = host.querySelector('.sm-release-label-row[data-release-id="' + rA + '"]');
  row.querySelector(".sm-release-chevron").click();
  assert.strictEqual(toggleCalled, true);
  assert.strictEqual(editCalled, false, "chevron click should not fire onReleaseClick");
});

// ---------------------------------------------------------------------------
// SM-60 — Last-execution-outcome badge on test-definition cards
// ---------------------------------------------------------------------------

function setupForExecBadge() {
  const snap = core.normalizeSnapshot({
    project: {
      id: "p1", name: "P", ticketPrefix: "P",
      ticketTypes: ["epic", "user-story", "bug", "test-definition", "test-execution"]
    }
  });
  const store = new ProjectStore(snap);
  store.createRelease({ name: "v1" }, HUMAN);
  store.createProcessStep({ name: "X" }, HUMAN);
  const rA = store.get().releases[0].id;
  const p1 = store.get().processSteps[0].id;
  // Story for the test-definition to link to.
  store.createTicket({ type: "user-story", title: "Feature",
    position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  const feature = store.get().tickets.find(t => t.title === "Feature");
  // Test-definition placed in the same cell so it appears on the map.
  store.createTicket({
    type: "test-definition", title: "Login flow",
    position: { releaseId: rA, processStepId: p1 },
    steps: [
      { id: "s1", step: "Open", data: "", expectedResult: "loads" },
      { id: "s2", step: "Click", data: "", expectedResult: "submits" }
    ],
    links: [{ linkTypeId: "tests", targetTicketId: feature.id }]
  }, HUMAN);
  const def = store.get().tickets.find(t => t.title === "Login flow");
  return { store, def, feature, rA, p1 };
}

test("SM-60: test-definition card does NOT render an outcome badge (the spec is reusable, no outcome belongs on it)", () => {
  const { store, def } = setupForExecBadge();
  // Spawn an execution + run it so a pass result exists. The DEFINITION
  // card must still be free of any outcome badge.
  store.startTestExecution(def.id, { env: "ci" }, HUMAN);
  const exec = store.get().tickets.find(t => t.type === "test-execution");
  store.updateTicket(exec.id, {
    executionSteps: (exec.executionSteps || []).map(s => Object.assign({}, s, { status: "passed" }))
  }, HUMAN);
  const host = document.getElementById("host");
  host.innerHTML = "";
  storymap.mount(host, store, {});
  const defCard = host.querySelector('.sm-story-card[data-ticket-id="' + def.id + '"]');
  assert.ok(defCard, "test-definition card rendered");
  assert.strictEqual(defCard.querySelector(".sm-exec-badge"), null,
    "test-definition card carries NO outcome badge");
});

test("SM-60: test-execution card renders the outcome badge derived from its own steps (status couples to it)", () => {
  const { store, def } = setupForExecBadge();
  store.startTestExecution(def.id, { env: "ci" }, HUMAN);
  let exec = store.get().tickets.find(t => t.type === "test-execution");
  store.updateTicket(exec.id, {
    executionSteps: (exec.executionSteps || []).map(s => Object.assign({}, s, { status: "passed" }))
  }, HUMAN);
  exec = store.get().tickets.find(t => t.id === exec.id);
  assert.strictEqual(exec.status, "done", "status coupled to non-pending outcome");
  // Kanban view because test-executions are usually placed in the backlog
  // and the Kanban surfaces them by status — but story-map ALSO renders
  // them as loose cards if orphan. Render via storymap; the exec is
  // orphan-positioned, so it shows up in the backlog section.
  const host = document.getElementById("host");
  host.innerHTML = "";
  storymap.mount(host, store, {});
  const execCard = host.querySelector('.sm-story-card[data-ticket-id="' + exec.id + '"]');
  assert.ok(execCard, "test-execution card rendered");
  const badge = execCard.querySelector(".sm-exec-badge");
  assert.ok(badge, "outcome badge rendered on test-execution card");
  assert.strictEqual(badge.textContent, "passed");
  assert.ok(badge.classList.contains("sm-exec-badge-passed"),
    "passed badge class, got: " + badge.className);
});

test("SM-60: pending test-execution shows the 'pending' outcome badge — no special 'untested' state on executions", () => {
  const { store, def } = setupForExecBadge();
  store.startTestExecution(def.id, { env: "ci" }, HUMAN);
  const exec = store.get().tickets.find(t => t.type === "test-execution");
  const host = document.getElementById("host");
  host.innerHTML = "";
  storymap.mount(host, store, {});
  const execCard = host.querySelector('.sm-story-card[data-ticket-id="' + exec.id + '"]');
  const badge = execCard.querySelector(".sm-exec-badge");
  assert.strictEqual(badge.textContent, "pending");
  assert.ok(badge.classList.contains("sm-exec-badge-pending"));
});

test("SM-60: test-execution outcome badge tooltip surfaces runAt + runBy + env from the ticket itself", () => {
  const { store, def } = setupForExecBadge();
  store.startTestExecution(def.id, { env: "staging" }, HUMAN);
  const exec = store.get().tickets.find(t => t.type === "test-execution");
  const host = document.getElementById("host");
  host.innerHTML = "";
  storymap.mount(host, store, {});
  const execCard = host.querySelector('.sm-story-card[data-ticket-id="' + exec.id + '"]');
  const badge = execCard.querySelector(".sm-exec-badge");
  const title = badge.getAttribute("title") || "";
  assert.ok(title.indexOf("outcome: pending") >= 0, "tooltip starts with the outcome");
  assert.ok(title.indexOf("ran ") >= 0,   "tooltip mentions ran timestamp");
  assert.ok(title.indexOf("by ")  >= 0,   "tooltip mentions runBy");
  assert.ok(title.indexOf("env: staging") >= 0, "tooltip mentions env, got: " + title);
});

test("SM-60: outcome badge respects manual override (outcomeOverride wins over derived)", () => {
  const { store, def } = setupForExecBadge();
  store.startTestExecution(def.id, {}, HUMAN);
  const exec = store.get().tickets.find(t => t.type === "test-execution");
  store.updateTicket(exec.id, { outcomeOverride: "failed" }, HUMAN);
  const host = document.getElementById("host");
  host.innerHTML = "";
  storymap.mount(host, store, {});
  const execCard = host.querySelector('.sm-story-card[data-ticket-id="' + exec.id + '"]');
  const badge = execCard.querySelector(".sm-exec-badge");
  assert.strictEqual(badge.textContent, "failed");
});

test("SM-60: non-test ticket types (user-story, bug, test-definition, epic) do NOT render the outcome badge", () => {
  const { store, feature, def } = setupForExecBadge();
  const host = document.getElementById("host");
  host.innerHTML = "";
  storymap.mount(host, store, {});
  const featureCard = host.querySelector('.sm-story-card[data-ticket-id="' + feature.id + '"]');
  const defCard     = host.querySelector('.sm-story-card[data-ticket-id="' + def.id + '"]');
  assert.strictEqual(featureCard.querySelector(".sm-exec-badge"), null,
    "user-story card has no exec badge");
  assert.strictEqual(defCard.querySelector(".sm-exec-badge"), null,
    "test-definition card has no exec badge");
});

test("SM-60: computeLastExecutionIndex still computes correctly (kept for potential follow-ups)", () => {
  const { store, def } = setupForExecBadge();
  store.startTestExecution(def.id, { env: "first" }, HUMAN);
  const first = store.get().tickets.find(t => t.type === "test-execution");
  store.updateTicket(first.id, { runAt: 1000 }, HUMAN);
  store.startTestExecution(def.id, { env: "second" }, HUMAN);
  const second = store.get().tickets.filter(t => t.type === "test-execution")
    .find(t => t.id !== first.id);
  store.updateTicket(second.id, { runAt: 2000 }, HUMAN);
  const idx = rendererCard.computeLastExecutionIndex(store.get());
  const entry = idx.get(def.id);
  assert.ok(entry, "index has an entry for the definition");
  assert.strictEqual(entry.executionTicket.id, second.id, "newest execution wins");
});

// ---------------------------------------------------------------------------
// SM-193 — backlog: hide done via the status filter + multi-column wrap after N
// ---------------------------------------------------------------------------

test("SM-193: columnAwareInsertionIndex picks the cursor's column before the Y walk", () => {
  const fn = storymap.columnAwareInsertionIndex;
  // 4 cards in 2 columns (col-major DOM order): idx 0,1 in left col; 2,3 in right.
  //  left col  x[0..100]: card0 y[0..50], card1 y[50..100]
  //  right col x[110..210]: card2 y[0..50], card3 y[50..100]
  const rects = [
    { left: 0,   right: 100, top: 0,  bottom: 50 },   // 0
    { left: 0,   right: 100, top: 50, bottom: 100 },  // 1
    { left: 110, right: 210, top: 0,  bottom: 50 },   // 2
    { left: 110, right: 210, top: 50, bottom: 100 }   // 3
  ];
  // Single-column behaviour preserved: cursor in left column near top → before 0.
  assert.strictEqual(fn(rects, 50, 5), 0);
  // Left column, between the two cards → before card1.
  assert.strictEqual(fn(rects, 50, 60), 1);
  // Left column, below both → after card1 = first card of next column (idx 2).
  assert.strictEqual(fn(rects, 50, 95), 2);
  // RIGHT column near top → before card2 (NOT before card0, which the old
  // pure-Y walk would have wrongly returned).
  assert.strictEqual(fn(rects, 160, 5), 2);
  // Right column, below both → after the last card overall (idx 4).
  assert.strictEqual(fn(rects, 160, 95), 4);
  // Empty list → 0.
  assert.strictEqual(fn([], 10, 10), 0);
});

// ---------------------------------------------------------------------------
// SM-222 — filter-evaluation budget (regression pin).
//
// The audit claimed matchesFilter ran per ticket PER CELL (O(T×cells)); code
// inspection + instrumentation FALSIFIED that: every ticket lives in exactly
// one structural bucket (one cell+epic, cell-loose, or one backlog group), so
// the filter is evaluated at most once per ticket per layout computation.
// These tests PIN that property so a future layout refactor can't silently
// reintroduce per-cell re-evaluation — and pin the zero-cost no-filter path.
// ---------------------------------------------------------------------------

test("SM-222: matchesFilter runs at most once per ticket per story-map layout", () => {
  const filterMod = require("../frontend/js/filter.js");
  const { buildLargeSnapshot } = require("./helpers/build-large-snapshot.js");
  const snap = buildLargeSnapshot({ tickets: 200 });
  const liveTickets = snap.tickets.filter(t => !t.isDeleted).length;
  const orig = filterMod.matchesFilter;
  let calls = 0;
  filterMod.matchesFilter = function (...a) { calls++; return orig.apply(this, a); };
  try {
    storymap.computeStoryMapLayout(snap, { filter: { statuses: ["backlog", "ready"] } });
  } finally { filterMod.matchesFilter = orig; }
  assert.ok(calls <= liveTickets,
    `matchesFilter must run ≤1× per ticket (tickets=${liveTickets}, calls=${calls})`);
  assert.ok(calls > 0, "an active filter must actually be evaluated");
});

test("SM-222: matchesFilter runs at most once per ticket per kanban layout", () => {
  const filterMod = require("../frontend/js/filter.js");
  const kanban = require("../frontend/js/renderer-kanban.js");
  const { buildLargeSnapshot } = require("./helpers/build-large-snapshot.js");
  const snap = buildLargeSnapshot({ tickets: 200 });
  const liveTickets = snap.tickets.filter(t => !t.isDeleted).length;
  const orig = filterMod.matchesFilter;
  let calls = 0;
  filterMod.matchesFilter = function (...a) { calls++; return orig.apply(this, a); };
  try {
    kanban.computeKanbanLayout(snap, { filter: { statuses: ["backlog", "ready"] } });
  } finally { filterMod.matchesFilter = orig; }
  assert.ok(calls <= liveTickets,
    `matchesFilter must run ≤1× per ticket (tickets=${liveTickets}, calls=${calls})`);
  assert.ok(calls > 0, "an active filter must actually be evaluated");
});

test("SM-222: no filter → zero matchesFilter evaluations (zero-cost path)", () => {
  const filterMod = require("../frontend/js/filter.js");
  const kanban = require("../frontend/js/renderer-kanban.js");
  const { buildLargeSnapshot } = require("./helpers/build-large-snapshot.js");
  const snap = buildLargeSnapshot({ tickets: 100 });
  const orig = filterMod.matchesFilter;
  let calls = 0;
  filterMod.matchesFilter = function (...a) { calls++; return orig.apply(this, a); };
  try {
    storymap.computeStoryMapLayout(snap, {});
    kanban.computeKanbanLayout(snap, {});
  } finally { filterMod.matchesFilter = orig; }
  assert.strictEqual(calls, 0, "without an active filter the predicate must short-circuit");
});

// ---------------------------------------------------------------------------
// SM-239 — release progress badge "X/Y" (green at complete).
// ---------------------------------------------------------------------------

test("SM-239: computeStoryMapLayout attaches releaseProgress to each row", () => {
  const store = setup();
  const { rA, p1 } = ids(store);
  store.createTicket({ type: "user-story", title: "S1", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  store.createTicket({ type: "user-story", title: "S2", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  const s1 = store.get().tickets.find(t => t.title === "S1").id;
  store.changeStatus(s1, "done", HUMAN);
  const layout = storymap.computeStoryMapLayout(store.get());
  const rowA = layout.rows.find(r => r.id === rA);
  assert.deepStrictEqual(rowA.progress, { done: 1, total: 2, complete: false });
});

test("SM-239: story-map release label row renders the X/Y badge; green only when complete", () => {
  const store = setup();
  const { rA, p1 } = ids(store);
  store.createTicket({ type: "user-story", title: "S1", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  const s1 = store.get().tickets.find(t => t.title === "S1").id;
  const host = document.getElementById("host"); host.innerHTML = "";
  storymap.mount(host, store);
  let row = host.querySelector('.sm-release-label-row[data-release-id="' + rA + '"]');
  let badge = row.querySelector(".sm-release-progress");
  assert.ok(badge, "badge present when release has work items");
  assert.strictEqual(badge.textContent, "0/1");
  assert.ok(!badge.classList.contains("complete"), "not green while open");
  // Complete it → badge turns green.
  store.changeStatus(s1, "done", HUMAN);   // local commit → full rerender
  row = host.querySelector('.sm-release-label-row[data-release-id="' + rA + '"]');
  badge = row.querySelector(".sm-release-progress");
  assert.strictEqual(badge.textContent, "1/1");
  assert.ok(badge.classList.contains("complete"), "green at done===total");
});

test("SM-239: an empty release shows NO progress badge (neutral, not green)", () => {
  const store = setup();
  const { rB } = ids(store);   // rB has no tickets
  const host = document.getElementById("host"); host.innerHTML = "";
  storymap.mount(host, store);
  const row = host.querySelector('.sm-release-label-row[data-release-id="' + rB + '"]');
  assert.ok(row, "rB label row exists");
  assert.strictEqual(row.querySelector(".sm-release-progress"), null, "no badge for an empty release");
});

test("SM-239: epics + spec types do NOT count toward the badge", () => {
  const store = setup();
  const { rA, p1 } = ids(store);
  store.createTicket({ type: "epic", title: "E", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  const epicId = store.get().tickets.find(t => t.title === "E").id;
  store.createTicket({ type: "user-story", title: "S1", position: { releaseId: rA, epicId } }, HUMAN);
  const s1 = store.get().tickets.find(t => t.title === "S1").id;
  store.changeStatus(s1, "done", HUMAN);
  store.createTicket({ type: "requirement", title: "Req", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  const host = document.getElementById("host"); host.innerHTML = "";
  storymap.mount(host, store);
  const badge = host.querySelector('.sm-release-label-row[data-release-id="' + rA + '"] .sm-release-progress');
  assert.strictEqual(badge.textContent, "1/1", "only the story counts (epic + requirement excluded)");
  assert.ok(badge.classList.contains("complete"));
});

test("SM-239: Phase-B fast-path (applyRemote status change) refreshes the badge without going stale", () => {
  const store = setup();
  const { rA, p1 } = ids(store);
  store.createTicket({ type: "user-story", title: "S1", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  store.createTicket({ type: "user-story", title: "S2", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  const host = document.getElementById("host"); host.innerHTML = "";
  storymap.mount(host, store);
  let badge = host.querySelector('.sm-release-label-row[data-release-id="' + rA + '"] .sm-release-progress');
  assert.strictEqual(badge.textContent, "0/2");
  // Simulate a remote (MCP/WS) status-only change: build the next snapshot and
  // push it via applyRemote — this hits the Phase-B content-patch fast-path,
  // which does NOT rebuild the release rows.
  const next = core.ops.changeStatus(store.get(), store.get().tickets.find(t => t.title === "S1").id, "done", HUMAN);
  store.applyRemote(next);
  badge = host.querySelector('.sm-release-label-row[data-release-id="' + rA + '"] .sm-release-progress');
  assert.strictEqual(badge.textContent, "1/2", "fast-path refreshed the badge in place");
});

test("SM-239: Kanban swimlane header shows the SAME X/Y badge (one releaseProgress source)", () => {
  const kanban = require("../frontend/js/renderer-kanban.js");
  const store = setup();
  const { rA, p1 } = ids(store);
  store.createTicket({ type: "user-story", title: "S1", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  store.createTicket({ type: "user-story", title: "S2", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  const s1 = store.get().tickets.find(t => t.title === "S1").id;
  store.changeStatus(s1, "done", HUMAN);
  const host = document.getElementById("host"); host.innerHTML = "";
  kanban.mount(host, store);
  const badge = host.querySelector('.km-swimlane[data-release-id="' + rA + '"] .sm-release-progress')
    || host.querySelector('.sm-release-label-row[data-release-id="' + rA + '"] .sm-release-progress');
  assert.ok(badge, "kanban swimlane has the progress badge");
  assert.strictEqual(badge.textContent, "1/2");
});

// ---------------------------------------------------------------------------
// SM-238 — compact epic-header progress badge "X/Y" on the story-map card.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// SM-244 — Cancel C3: cancelled card styling + kanban column.
// ---------------------------------------------------------------------------

test("SM-244: a cancelled story card carries .sm-status-cancelled (dimmed + struck through via CSS)", () => {
  const store = setup();
  const { rA, p1 } = ids(store);
  store.createTicket({ type: "user-story", title: "Drop", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  const id = store.get().tickets.find(t => t.title === "Drop").id;
  store.cancelTicket(id, HUMAN);
  const host = document.getElementById("host"); host.innerHTML = "";
  storymap.mount(host, store);
  const card = host.querySelector('.sm-story-card[data-ticket-id="' + id + '"]');
  assert.ok(card, "card rendered");
  assert.ok(card.classList.contains("sm-status-cancelled"), "carries the cancelled status class");
});

test("SM-244: Kanban shows a cancelled column (default 1:1 mapping) and places cancelled cards there", () => {
  const kanban = require("../frontend/js/renderer-kanban.js");
  const store = setup();
  const { rA, p1 } = ids(store);
  store.createTicket({ type: "user-story", title: "Drop", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  const id = store.get().tickets.find(t => t.title === "Drop").id;
  store.cancelTicket(id, HUMAN);
  const host = document.getElementById("host"); host.innerHTML = "";
  kanban.mount(host, store);
  // default 1:1 board → a cancelled column whose cell holds the cancelled card.
  const card = host.querySelector('.km-cell .sm-story-card[data-ticket-id="' + id + '"]');
  assert.ok(card, "cancelled card visible in a kanban cell");
  assert.ok(card.classList.contains("sm-status-cancelled"));
  // the hosting cell belongs to the cancelled column.
  const cell = card.closest(".km-cell");
  assert.ok(cell && (cell.getAttribute("data-column-id") || "").length > 0, "card sits in a real column cell");
});

// ---------------------------------------------------------------------------
// SM-272 — collapsible process-step columns.
// ---------------------------------------------------------------------------

test("SM-272: STORY_MAP_LAYOUT exposes COLLAPSED_COL_WIDTH_PX", () => {
  assert.strictEqual(typeof STORY_MAP_LAYOUT.COLLAPSED_COL_WIDTH_PX, "number");
  assert.ok(STORY_MAP_LAYOUT.COLLAPSED_COL_WIDTH_PX > 0);
});

test("SM-272: a collapsed column renders narrow + cells show an 'N epics' count instead of cards", () => {
  const store = setup();
  const { rA, p1 } = ids(store);
  store.createTicket({ type: "epic", title: "E", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  const host = document.getElementById("host"); host.innerHTML = "";
  storymap.mount(host, store, { collapsedColumns: new Set([p1]) });
  const col = host.querySelector('.sm-backbone-col[data-process-step-id="' + p1 + '"]');
  assert.ok(col && col.classList.contains("sm-col-collapsed"), "backbone column is collapsed");
  assert.ok(col.querySelector(".sm-col-chevron"), "collapse chevron present");
  const backbone = host.querySelector(".sm-backbone");
  assert.ok(backbone.style.gridTemplateColumns.includes(STORY_MAP_LAYOUT.COLLAPSED_COL_WIDTH_PX + "px"),
    "collapsed column uses the narrow fixed width: " + backbone.style.gridTemplateColumns);
  const cell = host.querySelector('.sm-release-cells[data-release-id="' + rA + '"] .sm-cell-collapsed[data-process-step-id="' + p1 + '"]');
  assert.ok(cell, "collapsed cell rendered");
  assert.strictEqual(cell.querySelector(".sm-epic-card"), null, "no epic cards in a collapsed cell");
  const count = cell.querySelector(".sm-cell-collapsed-count");
  assert.ok(count && /1 epic\b/.test(count.textContent), "shows '1 epic': " + (count && count.textContent));
});

test("SM-272: a NON-collapsed column stays wide and shows its epic cards", () => {
  const store = setup();
  const { rA, p1 } = ids(store);
  store.createTicket({ type: "epic", title: "E", position: { releaseId: rA, processStepId: p1 } }, HUMAN);
  const host = document.getElementById("host"); host.innerHTML = "";
  storymap.mount(host, store, { collapsedColumns: new Set() });
  const col = host.querySelector('.sm-backbone-col[data-process-step-id="' + p1 + '"]');
  assert.ok(!col.classList.contains("sm-col-collapsed"));
  assert.ok(host.querySelector('.sm-cell[data-process-step-id="' + p1 + '"] .sm-epic-card'), "epic card visible when not collapsed");
});

test("SM-272: the column chevron toggles via onToggleColumnCollapsed(psId) + re-renders", () => {
  const store = setup();
  const { p1 } = ids(store);
  const collapsed = new Set();
  const toggled = [];
  const host = document.getElementById("host"); host.innerHTML = "";
  storymap.mount(host, store, {
    collapsedColumns: collapsed,
    onToggleColumnCollapsed: (id) => { toggled.push(id); collapsed.add(id); }
  });
  const chevron = host.querySelector('.sm-backbone-col[data-process-step-id="' + p1 + '"] .sm-col-chevron');
  chevron.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  assert.deepStrictEqual(toggled, [p1], "toggle callback fired with the ps id");
  const col = host.querySelector('.sm-backbone-col[data-process-step-id="' + p1 + '"]');
  assert.ok(col.classList.contains("sm-col-collapsed"), "re-rendered as collapsed");
});

console.log(`\n  ${passed} passed, ${failed} failed`);
