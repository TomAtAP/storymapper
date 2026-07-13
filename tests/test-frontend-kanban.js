"use strict";

/**
 * E11 / SM-169 — Tests für `frontend/js/renderer-kanban.js`.
 *
 * Seit SM-169 ist das Board ein (Release × Status-Column)-Grid:
 *   computeKanbanLayout(snap, opts) → { columns, swimlanes }
 *     columns:   Board-Kanban-Columns (E21.C) + synthetische Orphan-Columns.
 *     swimlanes: eine Zeile pro Release mit ≥1 Ticket (sortiert nach
 *                sortOrder) + IMMER eine trailing "No release"-Zeile.
 *                Jede Swimlane hat `cells: {[columnId]: ticket[]}`.
 *
 * DOM: `.km-col-header` (Spaltennamen) + pro Swimlane `.km-swimlane` mit dem
 * GETEILTEN Release-Header (`.sm-release-label-row`, renderer-card.js) +
 * `.km-swimlane-cells` aus `.km-cell`.
 */

const assert = require("assert");
const { JSDOM } = require("jsdom");

const dom = new JSDOM(`<!doctype html><html><body><div id="host"></div></body></html>`);
global.window      = dom.window;
global.document    = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;

const core    = require("../frontend/js/core.js");
const { ProjectStore } = require("../frontend/js/store.js");
const kanban  = require("../frontend/js/renderer-kanban.js");
const rendererCard = require("../frontend/js/renderer-card.js");

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  - ${name}`); passed++; }
  catch (err) { console.log(`  FAIL - ${name}\n         ${err.stack || err.message}`); failed++; process.exitCode = 1; }
}

const HUMAN = { type: "human", id: "u1", name: "U" };
const NONE  = kanban.NO_RELEASE_KEY;

function buildStore() {
  const snap = core.normalizeSnapshot({
    project: { id: "p1", name: "P", ticketPrefix: "P" }
  });
  return new ProjectStore(snap);
}

// --- layout helpers (new {columns, swimlanes} model) ----------------------
function colByStatus(layout, status) {
  return layout.columns.find(c => c.status === status);
}
function swimlane(layout, key) {
  return layout.swimlanes.find(s => s.key === key);
}
// Tickets of a status inside a given swimlane (default: the No-release row).
function ticketsInStatus(layout, status, key) {
  const col = colByStatus(layout, status);
  if (!col) return [];
  const sl = swimlane(layout, key || NONE);
  return (sl && sl.cells[col.id]) || [];
}
function countTickets(layout) {
  let n = 0;
  for (const sl of layout.swimlanes) for (const id of Object.keys(sl.cells)) n += sl.cells[id].length;
  return n;
}

// ---------------------------------------------------------------------------
// computeKanbanLayout — pure
// ---------------------------------------------------------------------------

test("computeKanbanLayout: returns one column per default status", () => {
  const store = buildStore();
  const layout = kanban.computeKanbanLayout(store.get());
  const statuses = layout.columns.map(c => c.status);
  for (const s of core.DEFAULT_STATUSES) assert.ok(statuses.includes(s), "missing column: " + s);
});

test("computeKanbanLayout: a project with no releases has exactly one (No-release) swimlane", () => {
  const store = buildStore();
  store.createTicket({ type: "user-story", title: "S", status: "backlog" }, HUMAN);
  const layout = kanban.computeKanbanLayout(store.get());
  assert.strictEqual(layout.swimlanes.length, 1);
  assert.strictEqual(layout.swimlanes[0].release, null);
  assert.strictEqual(layout.swimlanes[0].key, NONE);
});

test("computeKanbanLayout: epics are EXCLUDED, non-epics are grouped by status", () => {
  const store = buildStore();
  store.createTicket({ type: "epic", title: "E (no kanban)" }, HUMAN);
  store.createTicket({ type: "user-story", title: "S-backlog", status: "backlog" }, HUMAN);
  store.createTicket({ type: "bug",        title: "B-ready",   status: "ready" }, HUMAN);
  store.createTicket({ type: "user-story", title: "S-done",    status: "done" }, HUMAN);
  const layout = kanban.computeKanbanLayout(store.get());
  assert.deepStrictEqual(ticketsInStatus(layout, "backlog").map(t => t.title), ["S-backlog"]);
  assert.deepStrictEqual(ticketsInStatus(layout, "ready").map(t => t.title),   ["B-ready"]);
  assert.deepStrictEqual(ticketsInStatus(layout, "done").map(t => t.title),    ["S-done"]);
  // The epic appears nowhere.
  assert.ok(!ticketsInStatus(layout, "backlog").some(t => t.title === "E (no kanban)"));
});

test("SM-197 R-1: requirements (SpecObjects) are EXCLUDED from the kanban", () => {
  const store = buildStore();
  store.createTicket({ type: "requirement", title: "REQ §2.1", status: "backlog" }, HUMAN);
  store.createTicket({ type: "user-story",  title: "S-backlog", status: "backlog" }, HUMAN);
  const layout = kanban.computeKanbanLayout(store.get());
  assert.strictEqual(countTickets(layout), 1);
  assert.deepStrictEqual(ticketsInStatus(layout, "backlog").map(t => t.title), ["S-backlog"]);
  assert.ok(!ticketsInStatus(layout, "backlog").some(t => t.title === "REQ §2.1"));
});

test("computeKanbanLayout: tickets within a cell are sorted ascending by sortOrder", () => {
  const store = buildStore();
  store.createTicket({ type: "user-story", title: "C", status: "backlog", position: { sortOrder: 5 } }, HUMAN);
  store.createTicket({ type: "user-story", title: "A", status: "backlog", position: { sortOrder: 1 } }, HUMAN);
  store.createTicket({ type: "user-story", title: "B", status: "backlog", position: { sortOrder: 3 } }, HUMAN);
  const layout = kanban.computeKanbanLayout(store.get());
  assert.deepStrictEqual(ticketsInStatus(layout, "backlog").map(t => t.title), ["A", "B", "C"]);
});

// ---------------------------------------------------------------------------
// SM-169 — Release swimlanes
// ---------------------------------------------------------------------------

function buildStoreWithReleases() {
  const snap = core.normalizeSnapshot({
    project:  { id: "p1", name: "P", ticketPrefix: "P" },
    releases: [
      { id: "r1", name: "v1.0", status: "completed", sortOrder: 0 },
      { id: "r2", name: "v2.0", status: "planned",   sortOrder: 1 }
    ]
  });
  return new ProjectStore(snap);
}

test("SM-169: one swimlane per release with work, ordered by sortOrder, + trailing No-release", () => {
  const store = buildStoreWithReleases();
  store.createTicket({ type: "user-story", title: "A", status: "backlog", position: { releaseId: "r2" } }, HUMAN);
  store.createTicket({ type: "user-story", title: "B", status: "ready",   position: { releaseId: "r1" } }, HUMAN);
  store.createTicket({ type: "user-story", title: "C", status: "backlog" }, HUMAN); // no release
  const layout = kanban.computeKanbanLayout(store.get());
  assert.deepStrictEqual(layout.swimlanes.map(s => s.key), ["r1", "r2", NONE]);
  assert.strictEqual(swimlane(layout, "r1").count, 1);
  assert.strictEqual(swimlane(layout, "r2").count, 1);
  assert.strictEqual(swimlane(layout, NONE).count, 1);
  assert.deepStrictEqual(ticketsInStatus(layout, "ready",   "r1").map(t => t.title), ["B"]);
  assert.deepStrictEqual(ticketsInStatus(layout, "backlog", "r2").map(t => t.title), ["A"]);
  assert.deepStrictEqual(ticketsInStatus(layout, "backlog", NONE).map(t => t.title), ["C"]);
});

test("SM-169: a release with no work gets no swimlane (No-release is still present)", () => {
  const store = buildStoreWithReleases();
  // No tickets anywhere.
  const layout = kanban.computeKanbanLayout(store.get());
  assert.deepStrictEqual(layout.swimlanes.map(s => s.key), [NONE]);
});

test("SM-169: collapsedReleases marks the swimlane collapsed", () => {
  const store = buildStoreWithReleases();
  store.createTicket({ type: "user-story", title: "B", status: "ready", position: { releaseId: "r1" } }, HUMAN);
  const layout = kanban.computeKanbanLayout(store.get(), { collapsedReleases: new Set(["r1"]) });
  assert.strictEqual(swimlane(layout, "r1").collapsed, true);
  assert.strictEqual(swimlane(layout, NONE).collapsed, false);
});

// ---------------------------------------------------------------------------
// mount — DOM
// ---------------------------------------------------------------------------

function fresh() {
  document.getElementById("host").innerHTML = "";
  return buildStore();
}

test("mount: renders a column header + one .km-swimlane with .km-cell per column", () => {
  const store = fresh();
  store.createTicket({ type: "user-story", title: "S", status: "backlog" }, HUMAN);
  kanban.mount(document.getElementById("host"), store);
  const header = document.querySelector(".km-col-header");
  assert.ok(header, "column header row exists");
  assert.ok(header.querySelectorAll(".km-col-head-cell").length >= core.DEFAULT_STATUSES.length);
  const lanes = document.querySelectorAll(".km-swimlane");
  assert.strictEqual(lanes.length, 1, "one No-release swimlane");
  // SM-169: header is the SHARED release-label component (.sm-release-label-row).
  assert.ok(lanes[0].querySelector(".sm-release-label-row"));
  assert.ok(lanes[0].querySelector(".sm-release-chevron"));
  assert.ok(lanes[0].querySelectorAll(".km-cell").length >= core.DEFAULT_STATUSES.length);
});

test("mount: places a card in the cell matching its status", () => {
  const store = fresh();
  store.createTicket({ type: "user-story", title: "MyCard", status: "ready" }, HUMAN);
  kanban.mount(document.getElementById("host"), store);
  const readyCell = document.querySelector('.km-cell[data-status="ready"]');
  assert.ok(readyCell);
  const cards = readyCell.querySelectorAll(".sm-story-card");
  assert.strictEqual(cards.length, 1);
  assert.ok(cards[0].textContent.includes("MyCard"));
});

test("mount: double-click on a card fires onTicketClick (single click is no-op)", () => {
  const store = fresh();
  store.createTicket({ type: "user-story", title: "DC", status: "backlog" }, HUMAN);
  const id = store.get().tickets[0].id;
  let clicked = null;
  kanban.mount(document.getElementById("host"), store, {
    onTicketClick: (tid) => { clicked = tid; }
  });
  const card = document.querySelector('.km-cell .sm-story-card[data-ticket-id="' + id + '"]');
  card.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  assert.strictEqual(clicked, null);
  card.dispatchEvent(new dom.window.MouseEvent("dblclick", { bubbles: true }));
  assert.strictEqual(clicked, id);
});

test("mount: ONLY the No-release backlog cell has a '+Add Item' button", () => {
  const store = fresh();
  let fired = null;
  kanban.mount(document.getElementById("host"), store, {
    onAddItem: (status) => { fired = status; }
  });
  const backlogCell = document.querySelector('.km-cell[data-status="backlog"]');
  assert.ok(backlogCell.querySelector(".km-add-item"), "backlog cell should have +Add Item");
  for (const otherStatus of ["ready", "in-progress", "review", "done"]) {
    const cell = document.querySelector('.km-cell[data-status="' + otherStatus + '"]');
    assert.strictEqual(cell.querySelector(".km-add-item"), null,
      "cell '" + otherStatus + "' must NOT have an Add button — tickets must start in backlog");
  }
  backlogCell.querySelector(".km-add-item").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  assert.strictEqual(fired, "backlog");
});

test("SM-169: a release swimlane's backlog cell has NO add button (only No-release does)", () => {
  document.getElementById("host").innerHTML = "";
  const store = buildStoreWithReleases();
  store.createTicket({ type: "user-story", title: "B", status: "backlog", position: { releaseId: "r2" } }, HUMAN);
  kanban.mount(document.getElementById("host"), store);
  const relLane = document.querySelector('.km-swimlane[data-release-id="r2"]');
  assert.ok(relLane);
  const relBacklog = relLane.querySelector('.km-cell[data-status="backlog"]');
  assert.strictEqual(relBacklog.querySelector(".km-add-item"), null);
});

test("SM-192: the swimlane release label renders ABOVE its cells (heading; cards below)", () => {
  document.getElementById("host").innerHTML = "";
  const store = buildStoreWithReleases();
  store.createTicket({ type: "user-story", title: "B", status: "ready", position: { releaseId: "r1" } }, HUMAN);
  kanban.mount(document.getElementById("host"), store);
  const lane = document.querySelector('.km-swimlane[data-release-id="r1"]');
  const header = lane.querySelector(".sm-release-label-row");
  const cells = lane.querySelector(".km-swimlane-cells");
  assert.ok(header && cells);
  const kids = Array.from(lane.children);
  assert.ok(kids.indexOf(header) < kids.indexOf(cells),
    "release label (heading) precedes the cells in the swimlane");
});

test("SM-169: clicking the chevron fires onSwimlaneCollapse(key); the label opens edit", () => {
  document.getElementById("host").innerHTML = "";
  const store = buildStoreWithReleases();
  store.createTicket({ type: "user-story", title: "B", status: "ready", position: { releaseId: "r1" } }, HUMAN);
  let toggled = null, edited = null;
  kanban.mount(document.getElementById("host"), store, {
    onSwimlaneCollapse: (key) => { toggled = key; },
    onReleaseClick:     (id)  => { edited = id; }
  });
  const lane = document.querySelector('.km-swimlane[data-release-id="r1"]');
  // Chevron → collapse toggle.
  lane.querySelector(".sm-release-chevron").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  assert.strictEqual(toggled, "r1");
  // Label → edit dialog (Map parity), NOT collapse.
  lane.querySelector(".sm-release-label").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  assert.strictEqual(edited, "r1");
});

test("SM-169: a completed release swimlane shows the shared 'Completed' pill + strikethrough label", () => {
  document.getElementById("host").innerHTML = "";
  const store = buildStoreWithReleases();   // r1 is status:"completed"
  store.createTicket({ type: "user-story", title: "B", status: "done", position: { releaseId: "r1" } }, HUMAN);
  kanban.mount(document.getElementById("host"), store);
  const lane = document.querySelector('.km-swimlane[data-release-id="r1"]');
  assert.ok(lane.querySelector(".sm-release-pill-completed"), "completed pill present");
  assert.strictEqual(lane.querySelector(".sm-release-label").dataset.status, "completed",
    "label carries data-status for the strikethrough CSS");
});

test("SM-169: a collapsed swimlane renders no .km-swimlane-cells", () => {
  document.getElementById("host").innerHTML = "";
  const store = buildStoreWithReleases();
  store.createTicket({ type: "user-story", title: "B", status: "ready", position: { releaseId: "r1" } }, HUMAN);
  kanban.mount(document.getElementById("host"), store, { collapsedReleases: new Set(["r1"]) });
  const relLane = document.querySelector('.km-swimlane[data-release-id="r1"]');
  assert.ok(relLane.classList.contains("km-swimlane-collapsed"));
  assert.strictEqual(relLane.querySelector(".km-swimlane-cells"), null);
  // The shared chevron flips to the collapsed glyph + row gets the collapsed class.
  assert.strictEqual(relLane.querySelector(".sm-release-chevron").textContent, "▶");
  assert.ok(relLane.querySelector(".sm-release-label-row").classList.contains("sm-release-collapsed"));
});

test("SM-169: every EXPANDED swimlane repeats its own column header; collapsed ones don't", () => {
  document.getElementById("host").innerHTML = "";
  const store = buildStoreWithReleases();   // r1 completed, r2 planned
  store.createTicket({ type: "user-story", title: "A", status: "ready",   position: { releaseId: "r1" } }, HUMAN);
  store.createTicket({ type: "user-story", title: "B", status: "backlog", position: { releaseId: "r2" } }, HUMAN);
  store.createTicket({ type: "user-story", title: "C", status: "backlog" }, HUMAN);
  // Collapse r1 only.
  kanban.mount(document.getElementById("host"), store, { collapsedReleases: new Set(["r1"]) });
  const host = document.getElementById("host");
  // 3 swimlanes total (r1, r2, No-release); r1 collapsed → 2 expanded → 2 headers.
  assert.strictEqual(host.querySelectorAll(".km-swimlane").length, 3);
  assert.strictEqual(host.querySelectorAll(".km-col-header").length, 2, "one header per expanded swimlane");
  // The collapsed r1 lane has neither a header nor cells.
  const r1 = host.querySelector('.km-swimlane[data-release-id="r1"]');
  assert.strictEqual(r1.querySelector(".km-col-header"), null);
  assert.strictEqual(r1.querySelector(".km-swimlane-cells"), null);
  // An expanded lane's header sits directly above its cells (same column count).
  const r2 = host.querySelector('.km-swimlane[data-release-id="r2"]');
  assert.strictEqual(
    r2.querySelector(".km-col-header").children.length,
    r2.querySelector(".km-swimlane-cells").children.length,
    "header column count matches cell column count"
  );
});

test("mount: store commits re-render the board (subscribe is wired)", () => {
  const store = fresh();
  store.createTicket({ type: "user-story", title: "Initial", status: "backlog" }, HUMAN);
  kanban.mount(document.getElementById("host"), store);
  assert.strictEqual(document.querySelectorAll(".km-cell .sm-story-card").length, 1);
  store.createTicket({ type: "user-story", title: "Second", status: "ready" }, HUMAN);
  assert.strictEqual(document.querySelectorAll(".km-cell .sm-story-card").length, 2);
});

// ---------------------------------------------------------------------------
// E21.C — Multi-status column-mapping
// ---------------------------------------------------------------------------

function buildStoreWithColumns(columns) {
  const snap = core.normalizeSnapshot({
    project: { id: "p1", name: "P", ticketPrefix: "P", boards: { kanban: { columns } } }
  });
  return new ProjectStore(snap);
}

test("E21.C: computeKanbanLayout iterates project.boards.kanban.columns when present", () => {
  const store = buildStoreWithColumns([
    { id: "col-todo",  name: "To Do",       statusIds: ["backlog", "ready"] },
    { id: "col-doing", name: "In Progress", statusIds: ["in-progress", "review"] },
    { id: "col-done",  name: "Done",        statusIds: ["done"] }
  ]);
  store.createTicket({ type: "user-story", title: "A", status: "backlog" }, HUMAN);
  store.createTicket({ type: "user-story", title: "B", status: "ready" }, HUMAN);
  store.createTicket({ type: "user-story", title: "C", status: "in-progress" }, HUMAN);
  store.createTicket({ type: "user-story", title: "D", status: "done" }, HUMAN);
  const layout = kanban.computeKanbanLayout(store.get());
  assert.strictEqual(layout.columns.length, 3, "one column per configured column");
  assert.deepStrictEqual(layout.columns.map(c => c.id), ["col-todo", "col-doing", "col-done"]);
  // To Do column has BOTH backlog and ready tickets bundled (No-release row).
  const noRel = swimlane(layout, NONE);
  assert.deepStrictEqual(noRel.cells["col-todo"].map(t => t.title).sort(), ["A", "B"]);
  // Multi-status column has no single `status` shortcut.
  assert.strictEqual(layout.columns[0].status, undefined, "multi-status column does not expose .status shortcut");
});

test("E21.C: render uses column.name as header cell, not the status id", () => {
  const store = buildStoreWithColumns([
    { id: "col-active", name: "Active Work", statusIds: ["ready", "in-progress", "review"] }
  ]);
  document.getElementById("host").innerHTML = "";
  kanban.mount(document.getElementById("host"), store);
  const head = document.querySelector(".km-col-head-cell");
  assert.ok(head);
  assert.strictEqual(head.textContent, "Active Work");
});

test("E21.C: cells carry data-column-id and data-status only for 1-status columns", () => {
  const store = buildStoreWithColumns([
    { id: "col-todo",  name: "To Do",  statusIds: ["backlog", "ready"] },
    { id: "col-done",  name: "Done",   statusIds: ["done"] }
  ]);
  document.getElementById("host").innerHTML = "";
  kanban.mount(document.getElementById("host"), store);
  const cells = document.querySelectorAll(".km-swimlane .km-cell");
  assert.strictEqual(cells.length, 2);
  assert.strictEqual(cells[0].dataset.columnId, "col-todo");
  assert.strictEqual(cells[0].dataset.status, undefined, "multi-status cell has no data-status");
  assert.strictEqual(cells[1].dataset.columnId, "col-done");
  assert.strictEqual(cells[1].dataset.status, "done", "1-status cell keeps backward-compat data-status");
});

test("E21.C: add-button appears on the column that maps 'backlog', even when bundled", () => {
  const store = buildStoreWithColumns([
    { id: "col-todo",  name: "To Do",  statusIds: ["backlog", "ready"] },
    { id: "col-done",  name: "Done",   statusIds: ["done"] }
  ]);
  document.getElementById("host").innerHTML = "";
  kanban.mount(document.getElementById("host"), store);
  const todoCell = document.querySelector('.km-cell[data-column-id="col-todo"]');
  const doneCell = document.querySelector('.km-cell[data-column-id="col-done"]');
  assert.ok(todoCell.querySelector(".km-add-item"),  "'To Do' cell (contains backlog) shows add button");
  assert.ok(!doneCell.querySelector(".km-add-item"), "'Done' cell does NOT show add button");
});

test("E21.C: orphan statuses (not in any column) get a synthetic trailing column", () => {
  const store = buildStoreWithColumns([
    { id: "col-todo", name: "To Do", statusIds: ["backlog"] }
  ]);
  store.createTicket({ type: "user-story", title: "X", status: "in-progress" }, HUMAN);
  const layout = kanban.computeKanbanLayout(store.get());
  // 1 configured + 1 synthetic for "in-progress".
  assert.strictEqual(layout.columns.length, 2);
  assert.strictEqual(layout.columns[1].statusIds[0], "in-progress");
  assert.strictEqual(layout.columns[1].orphan, true);
  assert.deepStrictEqual(ticketsInStatus(layout, "in-progress").map(t => t.title), ["X"]);
});

// ---------------------------------------------------------------------------
// SM-27 — Live-Reorder-Preview during drag (Story-Map-Pattern in Kanban)
// ---------------------------------------------------------------------------

function buildStoreWithBacklog(n) {
  const store = buildStore();
  for (let i = 0; i < n; i++) {
    store.createTicket({ type: "user-story", title: "T" + (i + 1) }, HUMAN);
  }
  return store;
}

test("SM-27: effectiveCellTickets — no projection → returns cell tickets as {ticket, shadow:false}", () => {
  const store = buildStoreWithBacklog(3);
  const layout = kanban.computeKanbanLayout(store.get());
  const cellTickets = ticketsInStatus(layout, "backlog");
  const col = colByStatus(layout, "backlog");
  const out = kanban.effectiveCellTickets(NONE, col.id, cellTickets, store.get());
  assert.strictEqual(out.length, 3);
  assert.ok(out.every(e => e.shadow === false));
});

test("SM-27: effectiveCellTickets — projection removes dragged from source AND inserts shadow at insertionIndex", () => {
  const store = buildStoreWithBacklog(3);
  const snap = store.get();
  const tickets = snap.tickets.filter(t => t.status === "backlog");
  const dragged = tickets[0];
  const layout = kanban.computeKanbanLayout(snap);
  const col = colByStatus(layout, "backlog");
  const cellTickets = ticketsInStatus(layout, "backlog");
  kanban.setProjection({ ticketId: dragged.id, swimlaneKey: NONE, columnId: col.id, insertionIndex: 2 });
  try {
    const out = kanban.effectiveCellTickets(NONE, col.id, cellTickets, snap);
    assert.strictEqual(out.length, 3, "still 3 entries (2 peers + 1 shadow)");
    assert.strictEqual(out[2].ticket.id, dragged.id);
    assert.strictEqual(out[2].shadow, true);
    assert.deepStrictEqual(
      out.filter(e => !e.shadow).map(e => e.ticket.id),
      [tickets[1].id, tickets[2].id]
    );
  } finally {
    kanban.clearProjection();
  }
});

test("SM-27: effectiveCellTickets — projection into a DIFFERENT swimlane shows no shadow (cross-release drags rejected)", () => {
  const store = buildStoreWithBacklog(3);
  const snap = store.get();
  const dragged = snap.tickets.filter(t => t.status === "backlog")[0];
  const layout = kanban.computeKanbanLayout(snap);
  const col = colByStatus(layout, "backlog");
  const cellTickets = ticketsInStatus(layout, "backlog");
  // Projection targets a fictional other swimlane key.
  kanban.setProjection({ ticketId: dragged.id, swimlaneKey: "r-other", columnId: col.id, insertionIndex: 0 });
  try {
    const out = kanban.effectiveCellTickets(NONE, col.id, cellTickets, snap);
    // Dragged is still removed from the source cell, but no shadow is inserted
    // here because the projection's swimlaneKey doesn't match.
    assert.ok(!out.some(e => e.shadow), "no shadow in a non-target swimlane");
    assert.ok(!out.some(e => e.ticket.id === dragged.id), "dragged removed from source cell");
  } finally {
    kanban.clearProjection();
  }
});

test("SM-27: setProjection during mount() triggers a rerender that renders the shadow card", () => {
  const store = buildStoreWithBacklog(3);
  const dragged = store.get().tickets.find(t => t.status === "backlog");
  const host = document.getElementById("host");
  host.innerHTML = "";
  const ctrl = kanban.mount(host, store);
  try {
    const initialCell = host.querySelector('.km-cell[data-status="backlog"]');
    const colId = initialCell.dataset.columnId;
    const slKey = initialCell.dataset.swimlaneKey;
    assert.ok(!initialCell.querySelector(".sm-card-shadow"), "no shadow before setProjection");
    kanban.setProjection({ ticketId: dragged.id, swimlaneKey: slKey, columnId: colId, insertionIndex: 1 });
    const afterCell = host.querySelector('.km-cell[data-status="backlog"]');
    const afterShadow = afterCell.querySelector(".sm-card-shadow");
    assert.ok(afterShadow, "shadow card appears after setProjection");
    assert.strictEqual(afterShadow.dataset.ticketId, dragged.id);
    const realCard = Array.from(afterCell.querySelectorAll('.sm-story-card[data-ticket-id="' + dragged.id + '"]'))
      .filter(c => !c.classList.contains("sm-card-shadow"));
    assert.strictEqual(realCard.length, 0, "dragged source removed from cell while projection is active");
  } finally {
    kanban.clearProjection();
    ctrl.unmount();
  }
});

test("SM-27: clearProjection rerenders without the shadow and restores the source card", () => {
  const store = buildStoreWithBacklog(3);
  const dragged = store.get().tickets.find(t => t.status === "backlog");
  const host = document.getElementById("host");
  host.innerHTML = "";
  const ctrl = kanban.mount(host, store);
  try {
    const cell = document.querySelector('.km-cell[data-status="backlog"]');
    kanban.setProjection({ ticketId: dragged.id, swimlaneKey: cell.dataset.swimlaneKey, columnId: cell.dataset.columnId, insertionIndex: 0 });
    assert.ok(document.querySelector(".sm-card-shadow"), "shadow rendered");
    kanban.clearProjection();
    assert.ok(!document.querySelector(".sm-card-shadow"), "shadow removed after clearProjection");
    const sources = document.querySelectorAll('.sm-story-card[data-ticket-id="' + dragged.id + '"]');
    assert.strictEqual(sources.length, 1, "exactly one source card again");
    assert.ok(!sources[0].classList.contains("sm-card-shadow"), "source is not a shadow anymore");
  } finally {
    ctrl.unmount();
  }
});

test("SM-27: setProjection with identical args is a no-op (no render thrash)", () => {
  const store = buildStoreWithBacklog(2);
  const dragged = store.get().tickets[0];
  const host = document.getElementById("host");
  host.innerHTML = "";
  const ctrl = kanban.mount(host, store);
  try {
    const cell = document.querySelector('.km-cell[data-status="backlog"]');
    const p = { ticketId: dragged.id, swimlaneKey: cell.dataset.swimlaneKey, columnId: cell.dataset.columnId, insertionIndex: 0 };
    kanban.setProjection(p);
    const firstShadow = document.querySelector(".sm-card-shadow");
    kanban.setProjection({ ...p });
    const sameShadow = document.querySelector(".sm-card-shadow");
    assert.strictEqual(firstShadow, sameShadow, "same DOM node — no rerender happened");
  } finally {
    kanban.clearProjection();
    ctrl.unmount();
  }
});

test("SM-27: shadow card has no drag listeners (preview-only)", () => {
  const store = buildStoreWithBacklog(2);
  const dragged = store.get().tickets[0];
  const host = document.getElementById("host");
  host.innerHTML = "";
  const ctrl = kanban.mount(host, store);
  try {
    const cell = document.querySelector('.km-cell[data-status="backlog"]');
    kanban.setProjection({ ticketId: dragged.id, swimlaneKey: cell.dataset.swimlaneKey, columnId: cell.dataset.columnId, insertionIndex: 0 });
    const shadow = document.querySelector(".sm-card-shadow");
    assert.strictEqual(shadow.ondblclick, null, "shadow has no double-click handler");
  } finally {
    kanban.clearProjection();
    ctrl.unmount();
  }
});

// ---------------------------------------------------------------------------
// SM-30 — Right-click context-menu hook on Kanban cards
// ---------------------------------------------------------------------------

test("SM-30: contextmenu event on a card fires opts.onCardContextMenu(ticket, ev) and preventDefault is called", () => {
  const store = buildStoreWithBacklog(1);
  const ticket = store.get().tickets[0];
  const host = document.getElementById("host");
  host.innerHTML = "";
  const calls = [];
  const ctrl = kanban.mount(host, store, {
    onCardContextMenu: (t, ev) => calls.push({ id: t.id, x: ev.clientX, y: ev.clientY })
  });
  try {
    const card = host.querySelector('.km-cell[data-status="backlog"] .sm-story-card');
    assert.ok(card, "card rendered");
    let defaultPrevented = false;
    const ev = new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 123, clientY: 456 });
    const origPD = ev.preventDefault.bind(ev);
    ev.preventDefault = function () { defaultPrevented = true; origPD(); };
    card.dispatchEvent(ev);
    assert.ok(defaultPrevented, "renderer must call preventDefault on contextmenu");
    assert.strictEqual(calls.length, 1, "onCardContextMenu fires once");
    assert.strictEqual(calls[0].id, ticket.id);
    assert.strictEqual(calls[0].x, 123);
    assert.strictEqual(calls[0].y, 456);
  } finally {
    ctrl.unmount();
  }
});

test("SM-30: shadow card has NO contextmenu wiring (preview-only)", () => {
  const store = buildStoreWithBacklog(2);
  const dragged = store.get().tickets[0];
  const host = document.getElementById("host");
  host.innerHTML = "";
  let fired = 0;
  const ctrl = kanban.mount(host, store, { onCardContextMenu: () => fired++ });
  try {
    const cell = document.querySelector('.km-cell[data-status="backlog"]');
    kanban.setProjection({ ticketId: dragged.id, swimlaneKey: cell.dataset.swimlaneKey, columnId: cell.dataset.columnId, insertionIndex: 0 });
    const shadow = document.querySelector(".sm-card-shadow");
    shadow.dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 0, clientY: 0 }));
    assert.strictEqual(fired, 0, "shadow should not invoke the context-menu callback");
  } finally {
    kanban.clearProjection();
    ctrl.unmount();
  }
});

// ---------------------------------------------------------------------------
// SM-82 — Filter integration
// ---------------------------------------------------------------------------

test("SM-82: kanban with status filter — only matching tickets appear", () => {
  const store = buildStoreWithBacklog(3);
  const snap0 = store.get();
  const ids0 = snap0.tickets.map(t => t.id);
  store.changeStatus(ids0[1], "ready", HUMAN);
  store.changeStatus(ids0[2], "done", HUMAN);
  const layoutAll = kanban.computeKanbanLayout(store.get());
  assert.strictEqual(countTickets(layoutAll), 3, "without filter: all 3 visible");

  const layoutFiltered = kanban.computeKanbanLayout(store.get(), {
    filter: { statuses: ["backlog", "ready"] }
  });
  assert.strictEqual(countTickets(layoutFiltered), 2, "filter: only non-done visible");
  assert.strictEqual(ticketsInStatus(layoutFiltered, "done").length, 0);
});

test("SM-82: kanban with type filter — only matching types (epics are excluded anyway)", () => {
  const store = buildStoreWithBacklog(0);
  store.createTicket({ type: "user-story", title: "Story1" }, HUMAN);
  store.createTicket({ type: "bug",        title: "Bug1"   }, HUMAN);
  const layoutAll = kanban.computeKanbanLayout(store.get());
  assert.strictEqual(countTickets(layoutAll), 2);

  const layoutFiltered = kanban.computeKanbanLayout(store.get(), { filter: { types: ["bug"] } });
  const titles = [];
  for (const sl of layoutFiltered.swimlanes) for (const id of Object.keys(sl.cells)) for (const t of sl.cells[id]) titles.push(t.title);
  assert.deepStrictEqual(titles, ["Bug1"]);
});

// ---------------------------------------------------------------------------
// SM-170 — Card-Aging
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;

test("SM-170: buildAgeBadge is null while fresh, amber at WARN, red at STALE", () => {
  const now = 10 * 365 * DAY;   // arbitrary fixed reference
  const mk = (ageMs) => rendererCard.buildAgeBadge({ statusEnteredAt: now - ageMs }, now);
  assert.strictEqual(mk(0), null, "fresh card → no badge");
  assert.strictEqual(mk(rendererCard.CARD_AGE.WARN_MS - 1), null, "just under WARN → no badge");
  const warn = mk(rendererCard.CARD_AGE.WARN_MS);
  assert.ok(warn && warn.classList.contains("sm-card-age-warn"), "at WARN → amber");
  const stale = mk(rendererCard.CARD_AGE.STALE_MS);
  assert.ok(stale && stale.classList.contains("sm-card-age-stale"), "at STALE → red");
  assert.ok(/3d/.test(warn.textContent), "humanized days: " + warn.textContent);
  assert.ok(/2w/.test(mk(14 * DAY).textContent), "humanized weeks");
});

test("SM-170: buildAgeBadge falls back to createdAt when statusEnteredAt is absent", () => {
  const now = 10 * 365 * DAY;
  const b = rendererCard.buildAgeBadge({ createdAt: now - 8 * DAY }, now);
  assert.ok(b && b.classList.contains("sm-card-age-stale"));
});

function storeWithAgingTicket(status, statusEnteredAt) {
  const snap = core.normalizeSnapshot({
    project: { id: "p1", name: "P", ticketPrefix: "P" },
    tickets: [{ id: "t1", type: "user-story", title: "T", status, statusEnteredAt }]
  });
  return new ProjectStore(snap);
}

test("SM-170: Kanban shows the aging badge on a stale card in an active (doing) status", () => {
  document.getElementById("host").innerHTML = "";
  const store = storeWithAgingTicket("in-progress", Date.now() - 8 * DAY);
  kanban.mount(document.getElementById("host"), store);
  const cell = document.querySelector('.km-cell[data-status="in-progress"]');
  assert.ok(cell.querySelector(".sm-card-age-stale"), "stale doing card shows the red aging badge");
});

test("SM-170: a fresh card in an active status shows NO aging badge", () => {
  document.getElementById("host").innerHTML = "";
  const store = storeWithAgingTicket("in-progress", Date.now());
  kanban.mount(document.getElementById("host"), store);
  const cell = document.querySelector('.km-cell[data-status="in-progress"]');
  assert.strictEqual(cell.querySelector(".sm-card-age"), null);
});

test("SM-170: a long-sitting BACKLOG card shows NO aging badge (todo category is excluded)", () => {
  document.getElementById("host").innerHTML = "";
  const store = storeWithAgingTicket("backlog", Date.now() - 60 * DAY);
  kanban.mount(document.getElementById("host"), store);
  const cell = document.querySelector('.km-cell[data-status="backlog"]');
  assert.strictEqual(cell.querySelector(".sm-card-age"), null, "backlog aging is normal, not flagged");
});

console.log(`\n  ${passed} passed, ${failed} failed`);
