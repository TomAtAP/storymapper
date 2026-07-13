"use strict";

/**
 * SM-282 — Table view skeleton (Jira Issue Navigator style).
 *
 * Own query line on top (SM-187 language via shared/query-engine), result
 * table below with the DEFAULT columns resolved through QUERY_FIELDS (no
 * parallel field logic), row click opens the ticket modal, live-sync via
 * store subscribe with a focus guard on the query input.
 */

const assert = require("assert");
const { JSDOM } = require("jsdom");

// url needed: without it jsdom has an opaque origin and window.localStorage
// throws (SM-283 persists the column config there).
const dom = new JSDOM(`<!doctype html><html><body><div id="host"></div></body></html>`,
  { url: "http://localhost/" });
global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;

const core = require("../frontend/js/core.js");
const { ProjectStore } = require("../frontend/js/store.js");
const view = require("../frontend/js/view-table.js");

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  - ${name}`); passed++; }
  catch (err) { console.log(`  FAIL - ${name}\n         ${err.stack || err.message}`); failed++; process.exitCode = 1; }
}

const HUMAN = { type: "human", id: "u1", name: "U" };

function board() {
  const store = new ProjectStore(core.normalizeSnapshot({
    project: { id: "p1", name: "P", ticketPrefix: "P" },
    releases: [{ id: "R1", name: "v1", sortOrder: 0 }],
    processSteps: [{ id: "PSA", name: "Discover", sortOrder: 0 }]
  }));
  store.createTicket({ type: "epic", title: "Epic One", position: { releaseId: "R1", processStepId: "PSA" } }, HUMAN);
  store.createTicket({ type: "user-story", title: "Story One", position: { releaseId: "R1", processStepId: "PSA" } }, HUMAN);
  store.createTicket({ type: "bug", title: "Loose Bug" }, HUMAN);   // unassigned — must be visible
  return { store };
}

function freshHost() { const h = document.getElementById("host"); h.innerHTML = ""; return h; }

// ---- pure model ------------------------------------------------------------

test("SM-282: TABLE_VIEW constants block exists with DEFAULT_COLUMNS", () => {
  assert.ok(Array.isArray(view.TABLE_VIEW.DEFAULT_COLUMNS));
  assert.deepStrictEqual(
    view.TABLE_VIEW.DEFAULT_COLUMNS,
    ["key", "type", "title", "status", "release", "processStep", "epic", "updated"]
  );
});

test("SM-282: computeTableModel with empty query returns ALL live tickets (incl. epics + unassigned)", () => {
  const { store } = board();
  const model = view.computeTableModel(store.get(), "");
  assert.strictEqual(model.error, null);
  assert.strictEqual(model.rows.length, 3, "epic + story + loose bug");
  const titles = model.rows.map(r => r.cells.find(c => c.key === "title").value);
  assert.ok(titles.includes("Epic One") && titles.includes("Loose Bug"));
});

test("SM-282: computeTableModel columns come from QUERY_FIELDS (label + resolved value)", () => {
  const { store } = board();
  const model = view.computeTableModel(store.get(), "");
  assert.deepStrictEqual(model.columns.map(c => c.key), view.TABLE_VIEW.DEFAULT_COLUMNS);
  assert.strictEqual(model.columns.find(c => c.key === "processStep").label, "Process step");
  const story = model.rows.find(r => r.cells.find(c => c.key === "title").value === "Story One");
  assert.strictEqual(story.cells.find(c => c.key === "release").value, "v1", "ref field resolves to display name");
  assert.strictEqual(story.cells.find(c => c.key === "processStep").value, "Discover");
});

test("SM-282: computeTableModel runs a JQL query", () => {
  const { store } = board();
  const model = view.computeTableModel(store.get(), "type = bug");
  assert.strictEqual(model.error, null);
  assert.strictEqual(model.rows.length, 1);
  assert.strictEqual(model.rows[0].cells.find(c => c.key === "title").value, "Loose Bug");
});

test("SM-282: computeTableModel surfaces a structured error on a bad query", () => {
  const { store } = board();
  const model = view.computeTableModel(store.get(), "nonsensefield = x");
  assert.ok(model.error && typeof model.error.message === "string");
  assert.ok(typeof model.error.position === "number");
});

test("SM-282: soft-deleted tickets never appear", () => {
  const { store } = board();
  const bug = store.get().tickets.find(t => t.type === "bug");
  store.softDeleteTicket(bug.id, HUMAN);
  const model = view.computeTableModel(store.get(), "");
  assert.strictEqual(model.rows.length, 2);
});

// ---- mount / DOM ------------------------------------------------------------

test("SM-282: mount renders query input + table with default columns and one row per ticket", () => {
  const { store } = board();
  const host = freshHost();
  const ctrl = view.mount(host, store, {});
  assert.ok(host.querySelector(".tv-query-input"), "query input present");
  const headers = Array.from(host.querySelectorAll(".tv-table thead th")).map(th => th.textContent);
  assert.strictEqual(headers.length, view.TABLE_VIEW.DEFAULT_COLUMNS.length);
  assert.strictEqual(host.querySelectorAll(".tv-table tbody tr").length, 3);
  ctrl.unmount();
});

test("SM-282: row click reports the ticket id via onTicketClick", () => {
  const { store } = board();
  const host = freshHost();
  let clicked = null;
  const ctrl = view.mount(host, store, { onTicketClick: (id) => { clicked = id; } });
  const row = host.querySelector(".tv-table tbody tr[data-ticket-id]");
  row.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  assert.strictEqual(clicked, row.getAttribute("data-ticket-id"));
  ctrl.unmount();
});

test("SM-282: store commits re-render the table (live-sync)", () => {
  const { store } = board();
  const host = freshHost();
  const ctrl = view.mount(host, store, {});
  assert.strictEqual(host.querySelectorAll(".tv-table tbody tr").length, 3);
  store.createTicket({ type: "task", title: "Late Task" }, HUMAN);
  assert.strictEqual(host.querySelectorAll(".tv-table tbody tr").length, 4, "new ticket appears without remount");
  ctrl.unmount();
});

test("SM-282: focus guard — a commit while typing in the query input does not rebuild the input", () => {
  const { store } = board();
  const host = freshHost();
  const ctrl = view.mount(host, store, {});
  const input = host.querySelector(".tv-query-input");
  input.focus();
  input.value = "type = ";
  store.createTicket({ type: "task", title: "Other" }, HUMAN);
  const inputAfter = host.querySelector(".tv-query-input");
  assert.strictEqual(inputAfter, input, "input element not replaced while focused");
  assert.strictEqual(inputAfter.value, "type = ", "typed text survives the commit");
  assert.strictEqual(host.querySelectorAll(".tv-table tbody tr").length, 4, "table body still updates");
  ctrl.unmount();
});

test("SM-282: focus guard reruns the LAST APPLIED query, not the half-typed one (real input path)", () => {
  const { store } = board();
  const host = freshHost();
  const ctrl = view.mount(host, store, {});
  const input = host.querySelector(".tv-query-input");
  // Apply a real query through the input path (Enter applies synchronously).
  input.value = "type = bug";
  input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  assert.strictEqual(host.querySelectorAll(".tv-table tbody tr").length, 1, "applied query narrows to the bug");
  // Now mid-edit: focused input holds garbage that must NOT be evaluated.
  input.focus();
  input.value = "nonsensefield =";
  store.createTicket({ type: "bug", title: "Second Bug" }, HUMAN);
  assert.strictEqual(host.querySelectorAll(".tv-table tbody tr").length, 2,
    "external commit reran 'type = bug' (last applied) against the new snapshot — not the garbage");
  assert.ok(!host.querySelector(".tv-query-error"), "no parse error surfaced for the half-typed input");
  ctrl.unmount();
});

test("SM-282: bad query shows the error line and keeps the last good result", () => {
  const { store } = board();
  const host = freshHost();
  const ctrl = view.mount(host, store, {});
  view._applyQueryForTest(host, store, "type = bug");
  assert.strictEqual(host.querySelectorAll(".tv-table tbody tr").length, 1);
  view._applyQueryForTest(host, store, "nonsensefield = x");
  const err = host.querySelector(".tv-query-error");
  assert.ok(err && err.textContent.length > 0, "error line visible");
  assert.strictEqual(host.querySelectorAll(".tv-table tbody tr").length, 1, "last good result kept");
  view._applyQueryForTest(host, store, "type = bug");
  assert.ok(!host.querySelector(".tv-query-error"), "error line clears on next good query");
  ctrl.unmount();
});

// ---- SM-283: column configuration ------------------------------------------

test("SM-283: reorderColumnKeys moves a key before/after a target", () => {
  const keys = ["key", "type", "title", "status"];
  assert.deepStrictEqual(view.reorderColumnKeys(keys, "status", "type", true), ["key", "status", "type", "title"]);
  assert.deepStrictEqual(view.reorderColumnKeys(keys, "key", "title", false), ["type", "title", "key", "status"]);
  assert.deepStrictEqual(view.reorderColumnKeys(keys, "key", "key", true), keys, "self-drop is a no-op");
});

test("SM-283: normalizeColumnKeys filters unknown keys and falls back to defaults when empty", () => {
  assert.deepStrictEqual(view.normalizeColumnKeys(["title", "ghostfield", "status"]), ["title", "status"]);
  assert.deepStrictEqual(view.normalizeColumnKeys(["onlyghosts"]), view.TABLE_VIEW.DEFAULT_COLUMNS);
  assert.deepStrictEqual(view.normalizeColumnKeys(null), view.TABLE_VIEW.DEFAULT_COLUMNS);
});

test("SM-283: columns button opens the picker; every QUERY_FIELDS field is listed", () => {
  const { store } = board();
  const host = freshHost();
  const ctrl = view.mount(host, store, {});
  const btn = host.querySelector(".tv-columns-btn");
  assert.ok(btn, "columns button present");
  btn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  const panel = host.querySelector(".tv-columns-panel");
  assert.ok(panel, "picker panel opens");
  const engine = require("../frontend/js/query-engine.js");
  assert.strictEqual(panel.querySelectorAll(".tv-columns-row").length, engine.QUERY_FIELDS.length,
    "one row per QUERY_FIELDS field");
  ctrl.unmount();
});

test("SM-283: unchecking a column removes it from the table; checking adds it (persisted per project)", () => {
  window.localStorage.clear();
  const { store } = board();
  const host = freshHost();
  const ctrl = view.mount(host, store, {});
  host.querySelector(".tv-columns-btn").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  const typeRow = host.querySelector('.tv-columns-row[data-col-key="type"]');
  const cb = typeRow.querySelector("input[type=checkbox]");
  assert.strictEqual(cb.checked, true, "default column starts checked");
  cb.checked = false;
  cb.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  const headers = Array.from(host.querySelectorAll(".tv-table thead th")).map(th => th.getAttribute("data-col"));
  assert.ok(!headers.includes("type"), "type column removed from the table");
  const stored = JSON.parse(window.localStorage.getItem(view.TABLE_VIEW.COLUMNS_STORAGE_PREFIX + "p1"));
  assert.ok(!stored.keys.includes("type") && stored.keys.includes("title"), "config persisted per project ({keys, widths} shape)");
  // check a previously-inactive field
  const descRow = host.querySelector('.tv-columns-row[data-col-key="description"]');
  const dcb = descRow.querySelector("input[type=checkbox]");
  dcb.checked = true;
  dcb.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  const headers2 = Array.from(host.querySelectorAll(".tv-table thead th")).map(th => th.getAttribute("data-col"));
  assert.ok(headers2.includes("description"), "newly checked field appears as a column");
  ctrl.unmount();
});

test("SM-283: a fresh mount restores the persisted column config", () => {
  const { store } = board();
  window.localStorage.setItem(view.TABLE_VIEW.COLUMNS_STORAGE_PREFIX + "p1", JSON.stringify(["key", "title"]));
  const host = freshHost();
  const ctrl = view.mount(host, store, {});
  const headers = Array.from(host.querySelectorAll(".tv-table thead th")).map(th => th.getAttribute("data-col"));
  assert.deepStrictEqual(headers, ["key", "title"]);
  ctrl.unmount();
  window.localStorage.clear();
});

test("SM-283: the last active column cannot be unchecked (min 1)", () => {
  const { store } = board();
  window.localStorage.setItem(view.TABLE_VIEW.COLUMNS_STORAGE_PREFIX + "p1", JSON.stringify(["title"]));
  const host = freshHost();
  const ctrl = view.mount(host, store, {});
  host.querySelector(".tv-columns-btn").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  const row = host.querySelector('.tv-columns-row[data-col-key="title"]');
  const cb = row.querySelector("input[type=checkbox]");
  cb.checked = false;
  cb.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  const headers = Array.from(host.querySelectorAll(".tv-table thead th")).map(th => th.getAttribute("data-col"));
  assert.deepStrictEqual(headers, ["title"], "last column survives the uncheck attempt");
  ctrl.unmount();
  window.localStorage.clear();
});

test("SM-283: reset restores the default columns", () => {
  const { store } = board();
  window.localStorage.setItem(view.TABLE_VIEW.COLUMNS_STORAGE_PREFIX + "p1", JSON.stringify(["key", "title"]));
  const host = freshHost();
  const ctrl = view.mount(host, store, {});
  host.querySelector(".tv-columns-btn").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  host.querySelector(".tv-columns-reset").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  const headers = Array.from(host.querySelectorAll(".tv-table thead th")).map(th => th.getAttribute("data-col"));
  assert.deepStrictEqual(headers, view.TABLE_VIEW.DEFAULT_COLUMNS);
  ctrl.unmount();
  window.localStorage.clear();
});

test("SM-283: active column rows are drag-sortable (dnd registration + grip present)", () => {
  const { store } = board();
  const host = freshHost();
  const ctrl = view.mount(host, store, {});
  host.querySelector(".tv-columns-btn").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  const activeRow = host.querySelector('.tv-columns-row[data-col-key="key"]');
  assert.ok(activeRow.querySelector(".tv-columns-grip"), "grip handle on active rows");
  ctrl.unmount();
});

// ---- SM-284: header sort ----------------------------------------------------

test("SM-284: computeTableModel honours an explicit orderBy (same semantics as ORDER BY)", () => {
  const { store } = board();
  const asc = view.computeTableModel(store.get(), "", null, { field: "title", dir: "asc" });
  const desc = view.computeTableModel(store.get(), "", null, { field: "title", dir: "desc" });
  const ascTitles = asc.rows.map(r => r.cells.find(c => c.key === "title").value);
  const descTitles = desc.rows.map(r => r.cells.find(c => c.key === "title").value);
  assert.deepStrictEqual(descTitles, ascTitles.slice().reverse());
  assert.deepStrictEqual(asc.orderBy, { field: "title", dir: "asc" }, "model reports the active sort");
});

test("SM-284: a query's own ORDER BY is reported in model.orderBy", () => {
  const { store } = board();
  const model = view.computeTableModel(store.get(), "type != epic ORDER BY title DESC");
  assert.strictEqual(model.error, null);
  assert.strictEqual(String(model.orderBy.field).toLowerCase(), "title");
  assert.strictEqual(model.orderBy.dir, "desc");
});

test("SM-284: header click sorts asc, second click desc; indicator on the th", () => {
  const { store } = board();
  const host = freshHost();
  const ctrl = view.mount(host, store, {});
  const titleTh = host.querySelector('.tv-table thead th[data-col="title"]');
  titleTh.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  let titles = Array.from(host.querySelectorAll('.tv-table tbody td[data-col="title"]')).map(td => td.textContent);
  assert.deepStrictEqual(titles, titles.slice().sort((a, b) => a.localeCompare(b)), "ascending after first click");
  let th = host.querySelector('.tv-table thead th[data-sort-dir]');
  assert.ok(th && th.getAttribute("data-col") === "title" && th.getAttribute("data-sort-dir") === "asc");
  host.querySelector('.tv-table thead th[data-col="title"]')
    .dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  titles = Array.from(host.querySelectorAll('.tv-table tbody td[data-col="title"]')).map(td => td.textContent);
  assert.deepStrictEqual(titles, titles.slice().sort((a, b) => b.localeCompare(a)), "descending after second click");
  th = host.querySelector('.tv-table thead th[data-sort-dir]');
  assert.strictEqual(th.getAttribute("data-sort-dir"), "desc");
  ctrl.unmount();
});

test("SM-284: header sort overrides a query ORDER BY; the query's sort shows until then", () => {
  const { store } = board();
  const host = freshHost();
  const ctrl = view.mount(host, store, {});
  const input = host.querySelector(".tv-query-input");
  input.value = "type != epic ORDER BY title DESC";
  input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  let th = host.querySelector('.tv-table thead th[data-sort-dir]');
  assert.ok(th && th.getAttribute("data-col") === "title" && th.getAttribute("data-sort-dir") === "desc",
    "query ORDER BY reflected in the header");
  const statusTh = host.querySelector('.tv-table thead th[data-col="status"]');
  statusTh.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  th = host.querySelector('.tv-table thead th[data-sort-dir]');
  assert.ok(th && th.getAttribute("data-col") === "status" && th.getAttribute("data-sort-dir") === "asc",
    "header click overrides the query sort");
  ctrl.unmount();
});

test("SM-284 (review): a NEW query resets the header sort — a later typed ORDER BY wins", () => {
  const { store } = board();
  const host = freshHost();
  const ctrl = view.mount(host, store, {});
  // 1. header click establishes a sort
  host.querySelector('.tv-table thead th[data-col="status"]')
    .dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  assert.ok(host.querySelector('.tv-table thead th[data-col="status"][data-sort-dir]'), "header sort active");
  // 2. user types a query WITH its own ORDER BY → that must win now
  const input = host.querySelector(".tv-query-input");
  input.value = "type != epic ORDER BY title DESC";
  input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  const th = host.querySelector(".tv-table thead th[data-sort-dir]");
  assert.ok(th && th.getAttribute("data-col") === "title" && th.getAttribute("data-sort-dir") === "desc",
    "typed ORDER BY is honoured, stale header sort cleared");
  // 3. a query WITHOUT ORDER BY falls back to the default order (no indicator)
  input.value = "type != epic";
  input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  assert.ok(!host.querySelector(".tv-table thead th[data-sort-dir]"), "no sort indicator on default order");
  ctrl.unmount();
});

test("SM-283 (review): normalizeColumnKeys dedupes repeated keys", () => {
  assert.deepStrictEqual(view.normalizeColumnKeys(["title", "title", "status"]), ["title", "status"]);
});

// ---- SM-285: CSV export ------------------------------------------------------

test("SM-285: toCsv — header row = field keys, one line per row, CRLF", () => {
  const columns = [{ key: "key" }, { key: "title" }];
  const rows = [
    { cells: [{ key: "key", value: "P-1" }, { key: "title", value: "Alpha" }] },
    { cells: [{ key: "key", value: "P-2" }, { key: "title", value: "Beta" }] },
  ];
  assert.strictEqual(view.toCsv(columns, rows), "key,title\r\nP-1,Alpha\r\nP-2,Beta");
});

test("SM-285: toCsv — RFC-4180 quoting (comma, quote, newline)", () => {
  const columns = [{ key: "title" }, { key: "description" }];
  const rows = [{ cells: [
    { key: "title", value: 'He said "go, now"' },
    { key: "description", value: "line1\nline2" },
  ] }];
  assert.strictEqual(view.toCsv(columns, rows),
    'title,description\r\n"He said ""go, now""","line1\nline2"');
});

test("SM-285: csvFilename contains the project id", () => {
  assert.strictEqual(view.csvFilename("p1"), "p1-tickets.csv");
  assert.strictEqual(view.csvFilename("weird/id"), "weird_id-tickets.csv");
  assert.strictEqual(view.csvFilename(null), "project-tickets.csv");
});

test("SM-285/292: export lives on the controller (Project menu), NOT as a view button", () => {
  const { store } = board();
  const host = freshHost();
  const ctrl = view.mount(host, store, {});
  assert.ok(!host.querySelector(".tv-export-btn"), "no export button in the view (moved to Project menu, SM-292)");
  assert.strictEqual(typeof ctrl.exportCsv, "function", "mounted controller exposes exportCsv for the menu");
  // Model round-trip: same inputs the export uses.
  const model = view.computeTableModel(store.get(), "type != epic", ["key", "title"], { field: "title", dir: "desc" });
  const csv = view.toCsv(model.columns, model.rows);
  const lines = csv.split("\r\n");
  assert.strictEqual(lines[0], "key,title");
  assert.strictEqual(lines.length, 3, "two non-epic tickets");
  assert.ok(lines[1].includes("Story One"), "desc sort: Story One before Loose Bug");
  // Neither export path may throw in jsdom (data: URI anchor fallback).
  ctrl.exportCsv();
  view.exportTicketsCsv(store, "p1");
  ctrl.unmount();
});

// ---- SM-292: full width, column widths + resize ------------------------------

test("SM-292: .tv-root has no max-width cap (full available width)", () => {
  const fs = require("fs");
  const path = require("path");
  const css = fs.readFileSync(path.join(__dirname, "../frontend/css/storymap.css"), "utf8");
  const rootIdx = css.indexOf(".tv-root {");
  const rule = css.slice(rootIdx, css.indexOf("}", rootIdx));
  assert.ok(!rule.includes("max-width"), ".tv-root must not cap the width");
  assert.ok(css.includes("table-layout: fixed"), "fixed layout so colgroup widths rule");
});

test("SM-292: widthForColumn — user width > default > null; epic/updated have wide-enough defaults", () => {
  assert.strictEqual(view.widthForColumn("epic", {}), view.TABLE_VIEW.DEFAULT_COL_WIDTHS.epic);
  assert.strictEqual(view.widthForColumn("updated", {}), view.TABLE_VIEW.DEFAULT_COL_WIDTHS.updated);
  assert.strictEqual(view.widthForColumn("epic", { epic: 200 }), 200, "user-resized width wins");
  assert.strictEqual(view.widthForColumn("title", {}), null, "title stays flexible (takes the rest)");
  assert.ok(view.TABLE_VIEW.DEFAULT_COL_WIDTHS.updated >= 130, "updated wide enough for 'YYYY-MM-DD HH:mm'");
});

test("SM-292: colgroup carries the widths; resize handles on the headers", () => {
  const { store } = board();
  window.localStorage.setItem(view.TABLE_VIEW.COLUMNS_STORAGE_PREFIX + "p1",
    JSON.stringify({ keys: ["key", "title", "epic"], widths: { key: 123 } }));
  const host = freshHost();
  const ctrl = view.mount(host, store, {});
  const keyCol = host.querySelector('.tv-table colgroup col[data-col="key"]');
  assert.strictEqual(keyCol.style.width, "123px", "persisted user width applied");
  const epicCol = host.querySelector('.tv-table colgroup col[data-col="epic"]');
  assert.strictEqual(epicCol.style.width, view.TABLE_VIEW.DEFAULT_COL_WIDTHS.epic + "px", "default width applied");
  const titleCol = host.querySelector('.tv-table colgroup col[data-col="title"]');
  assert.strictEqual(titleCol.style.width, "", "title has no width (flexible)");
  assert.ok(host.querySelector('.tv-table thead th[data-col="key"] .tv-resize-handle'), "resize handle present");
  ctrl.unmount();
  window.localStorage.clear();
});

test("SM-292: legacy array storage format is migrated (keys restored, widths empty)", () => {
  window.localStorage.setItem(view.TABLE_VIEW.COLUMNS_STORAGE_PREFIX + "p1", JSON.stringify(["key", "status"]));
  const cfg = view.readColumnsFromStorage("p1");
  assert.deepStrictEqual(cfg.keys, ["key", "status"]);
  assert.deepStrictEqual(cfg.widths, {});
  window.localStorage.clear();
});

test("SM-292: resizing via the handle persists the width with the config", () => {
  window.localStorage.clear();
  const { store } = board();
  const host = freshHost();
  const ctrl = view.mount(host, store, {});
  const handle = host.querySelector('.tv-table thead th[data-col="key"] .tv-resize-handle');
  handle.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true, clientX: 100 }));
  document.dispatchEvent(new dom.window.MouseEvent("pointermove", { bubbles: true, clientX: 160 }));
  document.dispatchEvent(new dom.window.MouseEvent("pointerup", { bubbles: true, clientX: 160 }));
  const stored = JSON.parse(window.localStorage.getItem(view.TABLE_VIEW.COLUMNS_STORAGE_PREFIX + "p1"));
  assert.ok(stored && stored.widths && typeof stored.widths.key === "number", "width persisted");
  assert.ok(stored.widths.key >= view.TABLE_VIEW.COL_MIN_WIDTH_PX, "min width respected");
  const keyCol = host.querySelector('.tv-table colgroup col[data-col="key"]');
  assert.strictEqual(keyCol.style.width, stored.widths.key + "px", "rerendered colgroup uses the new width");
  ctrl.unmount();
  window.localStorage.clear();
});

// ---- SM-294: linear resize (compensated drag) --------------------------------

test("SM-294: clampResizeDelta — passthrough in range, clips at BOTH minimums", () => {
  const MIN = view.TABLE_VIEW.COL_MIN_WIDTH_PX;
  assert.strictEqual(view.clampResizeDelta(30, 100, 200, MIN), 30, "in range: 1:1");
  assert.strictEqual(view.clampResizeDelta(-30, 100, 200, MIN), -30, "in range left: 1:1 (symmetric)");
  assert.strictEqual(view.clampResizeDelta(-80, 100, 200, MIN), MIN - 100, "clips when the dragged column hits min");
  assert.strictEqual(view.clampResizeDelta(500, 100, 200, MIN), 200 - MIN, "clips when the compensator hits min");
});

test("SM-294: pickCompensator — flexible column preferred; neighbor when dragging the flexible one", () => {
  const keys = ["key", "type", "title", "status"];
  assert.strictEqual(view.pickCompensator(keys, "key", {}), "title", "title (no width) compensates");
  assert.strictEqual(view.pickCompensator(keys, "title", {}), "status", "dragging title → next column compensates");
  assert.strictEqual(view.pickCompensator(["key", "type"], "type", {}), "key", "last column → previous compensates");
  assert.strictEqual(view.pickCompensator(["key"], "key", {}), null, "single column → nothing to compensate");
});

test("SM-294 (review): clamp never inverts when one side is already below min", () => {
  const MIN = view.TABLE_VIEW.COL_MIN_WIDTH_PX;
  // compensator (e.g. squeezed title) already at 40 < MIN: dragging right must
  // clamp to 0, NOT to a negative jump.
  assert.strictEqual(view.clampResizeDelta(30, 90, 40, MIN), 0, "no forced shrink when comp < min");
  // dragged column itself below min: shrinking clamps to 0, widening allowed.
  assert.strictEqual(view.clampResizeDelta(-30, 40, 200, MIN), 0, "no forced grow-inversion");
  assert.strictEqual(view.clampResizeDelta(30, 40, 200, MIN), 30, "widening the sub-min column stays allowed");
});

test("SM-294 (review): with TWO flexible columns, dragging one prefers a WIDTH-CARRYING partner", () => {
  // description/text carry no default width → second flexible column.
  assert.strictEqual(view.pickCompensator(["key", "title", "description"], "title", {}), "key",
    "width-carrying neighbor wins over the other flexible column (else the patch would be empty = silent no-op)");
  assert.strictEqual(view.pickCompensator(["title", "description"], "title", {}), "description",
    "all partners flexible → plain neighbor as last resort");
});

test("SM-294: dragging a width column compensates on title — title stays unpersisted (flexible)", () => {
  window.localStorage.clear();
  const { store } = board();
  const host = freshHost();
  const ctrl = view.mount(host, store, {});
  const handle = host.querySelector('.tv-table thead th[data-col="key"] .tv-resize-handle');
  handle.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true, clientX: 100 }));
  document.dispatchEvent(new dom.window.MouseEvent("pointermove", { bubbles: true, clientX: 140 }));
  document.dispatchEvent(new dom.window.MouseEvent("pointerup", { bubbles: true, clientX: 140 }));
  const stored = JSON.parse(window.localStorage.getItem(view.TABLE_VIEW.COLUMNS_STORAGE_PREFIX + "p1"));
  assert.strictEqual(typeof stored.widths.key, "number", "dragged column persisted");
  assert.strictEqual(stored.widths.title, undefined, "title never gets a persisted width (slack absorber)");
  ctrl.unmount();
  window.localStorage.clear();
});

test("SM-294: dragging TITLE compensates on the next column — neighbor persisted, title not", () => {
  window.localStorage.clear();
  const { store } = board();
  const host = freshHost();
  const ctrl = view.mount(host, store, {});
  const handle = host.querySelector('.tv-table thead th[data-col="title"] .tv-resize-handle');
  handle.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true, clientX: 100 }));
  document.dispatchEvent(new dom.window.MouseEvent("pointermove", { bubbles: true, clientX: 130 }));
  document.dispatchEvent(new dom.window.MouseEvent("pointerup", { bubbles: true, clientX: 130 }));
  const stored = JSON.parse(window.localStorage.getItem(view.TABLE_VIEW.COLUMNS_STORAGE_PREFIX + "p1"));
  // DEFAULT_COLUMNS: title is followed by status → status compensates −30.
  assert.strictEqual(stored.widths.title, undefined, "title itself never persisted");
  assert.strictEqual(stored.widths.status, view.TABLE_VIEW.DEFAULT_COL_WIDTHS.status - 30,
    "the next column absorbed the delta and is persisted");
  ctrl.unmount();
  window.localStorage.clear();
});

test("SM-294: live drag freezes all columns and moves dragged/compensator inversely (1:1)", () => {
  window.localStorage.clear();
  const { store } = board();
  const host = freshHost();
  const ctrl = view.mount(host, store, {});
  const handle = host.querySelector('.tv-table thead th[data-col="key"] .tv-resize-handle');
  handle.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true, clientX: 100 }));
  document.dispatchEvent(new dom.window.MouseEvent("pointermove", { bubbles: true, clientX: 125 }));
  // jsdom th rects are 0 → start falls back to configured widths (key 90, title 150-fallback).
  const keyCol = host.querySelector('.tv-table colgroup col[data-col="key"]');
  const titleCol = host.querySelector('.tv-table colgroup col[data-col="title"]');
  assert.strictEqual(keyCol.style.width, (view.TABLE_VIEW.DEFAULT_COL_WIDTHS.key + 25) + "px", "dragged +dx");
  assert.strictEqual(titleCol.style.width, (150 - 25) + "px", "compensator −dx (frozen fallback 150)");
  const statusCol = host.querySelector('.tv-table colgroup col[data-col="status"]');
  assert.strictEqual(statusCol.style.width, view.TABLE_VIEW.DEFAULT_COL_WIDTHS.status + "px", "other columns frozen");
  document.dispatchEvent(new dom.window.MouseEvent("pointerup", { bubbles: true, clientX: 125 }));
  ctrl.unmount();
  window.localStorage.clear();
});

test("SM-292 (review): pointercancel aborts the drag — nothing persisted, listeners cleaned up", () => {
  window.localStorage.clear();
  const { store } = board();
  const host = freshHost();
  const ctrl = view.mount(host, store, {});
  const handle = host.querySelector('.tv-table thead th[data-col="key"] .tv-resize-handle');
  handle.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true, clientX: 100 }));
  document.dispatchEvent(new dom.window.MouseEvent("pointermove", { bubbles: true, clientX: 160 }));
  document.dispatchEvent(new dom.window.Event("pointercancel", { bubbles: true }));
  assert.strictEqual(window.localStorage.getItem(view.TABLE_VIEW.COLUMNS_STORAGE_PREFIX + "p1"), null,
    "cancelled drag persists nothing");
  const keyCol = host.querySelector('.tv-table colgroup col[data-col="key"]');
  assert.strictEqual(keyCol.style.width, view.TABLE_VIEW.DEFAULT_COL_WIDTHS.key + "px",
    "live preview reverted to the configured width");
  // Listeners are gone: a stray pointermove/pointerup after the cancel must not resize/persist.
  document.dispatchEvent(new dom.window.MouseEvent("pointermove", { bubbles: true, clientX: 400 }));
  document.dispatchEvent(new dom.window.MouseEvent("pointerup", { bubbles: true, clientX: 400 }));
  assert.strictEqual(window.localStorage.getItem(view.TABLE_VIEW.COLUMNS_STORAGE_PREFIX + "p1"), null,
    "no zombie listeners after pointercancel");
  ctrl.unmount();
});

test("SM-293 gate: columns are visually separated (border-right on th/td, last column exempt)", () => {
  const fs = require("fs");
  const path = require("path");
  const css = fs.readFileSync(path.join(__dirname, "../frontend/css/storymap.css"), "utf8");
  const sepIdx = css.indexOf(".tv-table thead th,\n.tv-table tbody td { border-right:");
  assert.ok(sepIdx > -1, "vertical separators between columns");
  assert.ok(css.includes(".tv-table tbody td:last-child { border-right: none; }"), "last column has no trailing separator");
  assert.ok(css.includes(".tv-table thead th:hover .tv-resize-handle"), "resize handle visible on header hover (affordance)");
  assert.ok(css.includes(".toolbar-action[hidden] { display: none; }"), "smart-bar row hideable despite flex display");
});

test("SM-282: unmount unsubscribes and clears the host", () => {
  const { store } = board();
  const host = freshHost();
  const ctrl = view.mount(host, store, {});
  ctrl.unmount();
  assert.strictEqual(host.innerHTML, "");
  store.createTicket({ type: "task", title: "After unmount" }, HUMAN);   // must not throw
});

console.log(`\n  ${passed} passed, ${failed} failed`);
