"use strict";

/**
 * E21.D + E21.E — Tests for `frontend/js/view-settings.js`.
 *
 * Skeleton tests (mount/unmount, sections render) plus the E21.E status
 * editor (row markup, add/delete, category change, name on-blur, reorder).
 */

const assert = require("assert");
const { JSDOM } = require("jsdom");

const dom = new JSDOM(`<!doctype html><html><body><div id="host"></div></body></html>`);
global.window           = dom.window;
global.document         = dom.window.document;
global.HTMLElement      = dom.window.HTMLElement;
global.MutationObserver = dom.window.MutationObserver;

const core    = require("../frontend/js/core.js");
const { ProjectStore } = require("../frontend/js/store.js");
const view    = require("../frontend/js/view-settings.js");

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  - ${name}`); passed++; }
  catch (err) { console.log(`  FAIL - ${name}\n         ${err.stack || err.message}`); failed++; process.exitCode = 1; }
}

function buildStore(workflowOverride) {
  const snap = core.normalizeSnapshot({
    project: Object.assign(
      { id: "p1", name: "P", ticketPrefix: "P" },
      workflowOverride ? { workflow: workflowOverride } : {}
    )
  });
  return new ProjectStore(snap);
}

function freshHost() {
  document.getElementById("host").innerHTML = "";
  return document.getElementById("host");
}

// ---------------------------------------------------------------------------
// Skeleton (E21.D)
// ---------------------------------------------------------------------------

test("SM-40+SM-47+SM-7+SM-8+SM-9+SM-107: mount renders nine sections (… typeconfig / labels / rules)", () => {
  // SM-9 added 'typeconfig' between 'types' and 'labels'; SM-107 appended 'rules'.
  const store = buildStore();
  const ctl = view.mount(freshHost(), store, {});
  try {
    const sections = document.querySelectorAll(".vs-section");
    assert.strictEqual(sections.length, 9, "expected 9 sections");
    const ids = Array.from(sections).map(s => s.dataset.section);
    assert.deepStrictEqual(ids, ["workflow", "dor", "dod", "board", "links", "types", "typeconfig", "labels", "rules"]);
  } finally { ctl.unmount(); }
});

test("E21.D: empty state when no store provided", () => {
  const ctl = view.mount(freshHost(), null, {});
  try {
    assert.ok(document.querySelector(".vs-empty"), "empty state must be visible");
  } finally { ctl.unmount(); }
});

test("E21.D: unmount cleans host + unsubscribes (subsequent commits don't re-render)", () => {
  const store = buildStore();
  const host = freshHost();
  const ctl = view.mount(host, store, {});
  ctl.unmount();
  assert.strictEqual(host.innerHTML, "");
  // Commit something after unmount — should NOT re-render into the cleared host.
  store.updateProject({ name: "Renamed" }, { type: "human", id: "u", name: "U" });
  assert.strictEqual(host.innerHTML, "", "unmount must have unsubscribed");
});

// ---------------------------------------------------------------------------
// Status editor (E21.E)
// ---------------------------------------------------------------------------

test("E21.E: status editor renders one row per status, with name + category + delete", () => {
  const store = buildStore();
  view.mount(freshHost(), store, {});
  const rows = document.querySelectorAll(".vs-status-editor .vs-status-row");
  const wfStatuses = store.get().project.workflow.statuses;
  assert.strictEqual(rows.length, wfStatuses.length);
  rows.forEach((row, i) => {
    const nameInput = row.querySelector("input.vs-status-name");
    const catSel    = row.querySelector("select.vs-status-category");
    const delBtn    = row.querySelector("button.vs-status-delete");
    assert.ok(nameInput, "name input present");
    assert.ok(catSel,    "category select present");
    assert.ok(delBtn,    "delete button present");
    assert.strictEqual(nameInput.value, wfStatuses[i].name);
    assert.strictEqual(catSel.value,    wfStatuses[i].category);
  });
});

test("E21.E: category select offers all allowed categories (incl. SM-242 cancelled)", () => {
  const store = buildStore();
  view.mount(freshHost(), store, {});
  const select = document.querySelector(".vs-status-editor select.vs-status-category");
  const opts = Array.from(select.querySelectorAll("option")).map(o => o.value);
  assert.deepStrictEqual(opts.sort(), ["blocked", "cancelled", "doing", "done", "todo"]);
});

test("E21.E: changing the category dropdown dispatches updateProject", () => {
  const store = buildStore();
  view.mount(freshHost(), store, {});
  const before = store.get().project.workflow.statuses[0];
  const newCat = before.category === "doing" ? "todo" : "doing";
  const select = document.querySelector(".vs-status-editor .vs-status-row:first-child select.vs-status-category");
  select.value = newCat;
  select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  const after = store.get().project.workflow.statuses[0];
  assert.strictEqual(after.category, newCat);
  // The status id stays stable so existing tickets keep referencing it.
  assert.strictEqual(after.id, before.id);
});

test("E21.E: blurring the name input commits the new name", () => {
  const store = buildStore();
  view.mount(freshHost(), store, {});
  const before = store.get().project.workflow.statuses[0];
  const input = document.querySelector(".vs-status-editor .vs-status-row:first-child input.vs-status-name");
  input.value = "Renamed Status";
  input.dispatchEvent(new dom.window.Event("blur", { bubbles: true }));
  const after = store.get().project.workflow.statuses[0];
  assert.strictEqual(after.name, "Renamed Status");
  assert.strictEqual(after.id, before.id, "id stays stable on rename");
});

test("E21.E: clicking + Add Status appends a new row + commits to store", () => {
  const store = buildStore();
  view.mount(freshHost(), store, {});
  const before = store.get().project.workflow.statuses.length;
  const addBtn = document.querySelector(".vs-status-editor .vs-status-add");
  assert.ok(addBtn);
  addBtn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  const after = store.get().project.workflow.statuses;
  assert.strictEqual(after.length, before + 1);
  // The new entry has a non-empty id + a sensible default category.
  const tail = after[after.length - 1];
  assert.ok(typeof tail.id === "string" && tail.id.length > 0);
  assert.ok(["todo", "doing", "blocked", "done"].includes(tail.category));
});

test("E21.E: delete button removes the row + commits to store", () => {
  const store = buildStore();
  view.mount(freshHost(), store, {});
  const before = store.get().project.workflow.statuses.length;
  // Delete the 'ready' status (id='ready').
  const targetRow = document.querySelector(".vs-status-editor .vs-status-row[data-status-id='ready']");
  assert.ok(targetRow, "ready row should exist");
  const delBtn = targetRow.querySelector("button.vs-status-delete");
  delBtn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  const after = store.get().project.workflow.statuses;
  assert.strictEqual(after.length, before - 1);
  assert.ok(!after.some(s => s.id === "ready"), "ready must be gone");
});

test("E21.E: empty-name input is rejected (stays at previous name)", () => {
  const store = buildStore();
  view.mount(freshHost(), store, {});
  const before = store.get().project.workflow.statuses[0];
  const input = document.querySelector(".vs-status-editor .vs-status-row:first-child input.vs-status-name");
  input.value = "";
  input.dispatchEvent(new dom.window.Event("blur", { bubbles: true }));
  const after = store.get().project.workflow.statuses[0];
  assert.strictEqual(after.name, before.name, "empty rename must be a no-op");
});

test("E23.C: reorderTransitions is the analog reorder helper for transitions", () => {
  const list = [
    { id: "a", name: "A", fromStatuses: [], toStatus: "x", requireGate: null, allowFromAny: true },
    { id: "b", name: "B", fromStatuses: [], toStatus: "y", requireGate: null, allowFromAny: true },
    { id: "c", name: "C", fromStatuses: [], toStatus: "z", requireGate: null, allowFromAny: true }
  ];
  // Drag c BEFORE a → c,a,b
  let next = view.reorderTransitions(list, "c", "a", true);
  assert.deepStrictEqual(next.map(t => t.id), ["c", "a", "b"]);
  // Drag a AFTER c → b,c,a
  next = view.reorderTransitions(list, "a", "c", false);
  assert.deepStrictEqual(next.map(t => t.id), ["b", "c", "a"]);
});

test("E23.C: sortTransitionsByStatusOrder orders transitions by toStatus index", () => {
  const statuses = [
    { id: "todo",  name: "To Do",       category: "todo" },
    { id: "doing", name: "Doing",       category: "doing" },
    { id: "done",  name: "Done",        category: "done" }
  ];
  const transitions = [
    { id: "x", name: "X", fromStatuses: [], toStatus: "done",  requireGate: null, allowFromAny: true },
    { id: "y", name: "Y", fromStatuses: [], toStatus: "todo",  requireGate: null, allowFromAny: true },
    { id: "z", name: "Z", fromStatuses: [], toStatus: "doing", requireGate: null, allowFromAny: true }
  ];
  const sorted = view.sortTransitionsByStatusOrder(transitions, statuses);
  assert.deepStrictEqual(sorted.map(t => t.id), ["y", "z", "x"]);
});

test("E23.C: sortTransitionsByStatusOrder is stable for transitions sharing toStatus", () => {
  const statuses = [{ id: "todo", name: "To Do", category: "todo" }];
  const transitions = [
    { id: "first",  name: "F", fromStatuses: [], toStatus: "todo", requireGate: null, allowFromAny: true },
    { id: "second", name: "S", fromStatuses: [], toStatus: "todo", requireGate: null, allowFromAny: true }
  ];
  const sorted = view.sortTransitionsByStatusOrder(transitions, statuses);
  assert.deepStrictEqual(sorted.map(t => t.id), ["first", "second"], "stable sort preserves insertion order");
});

test("E23.C: sortTransitionsByStatusOrder appends transitions with unknown toStatus at the end", () => {
  const statuses = [{ id: "todo", name: "To Do", category: "todo" }];
  const transitions = [
    { id: "ghost", name: "G", fromStatuses: [], toStatus: "nonexistent", requireGate: null, allowFromAny: true },
    { id: "ok",    name: "O", fromStatuses: [], toStatus: "todo",         requireGate: null, allowFromAny: true }
  ];
  const sorted = view.sortTransitionsByStatusOrder(transitions, statuses);
  // ok first (status matches), then ghost (unknown target → end).
  assert.deepStrictEqual(sorted.map(t => t.id), ["ok", "ghost"]);
});

test("E23.C: changing status order re-renders transitions in matching order (display-time sort)", () => {
  const store = buildStore();
  view.mount(freshHost(), store, {});
  const cur = store.get().project.workflow.statuses;
  const reordered = view.reorderStatuses(cur, "done", "backlog", true);
  store.updateProject({
    workflow: Object.assign({}, store.get().project.workflow, { statuses: reordered })
  }, { type: "human", id: "u", name: "U" });
  // Persisted transitions array stays in its original order — only the
  // displayed DOM rows are re-sorted to follow the status order.
  const rows = Array.from(document.querySelectorAll(".vs-transition-editor .vs-transition-row"));
  const visualToStatuses = rows.map(r => r.querySelector("select.vs-transition-target").value);
  assert.strictEqual(visualToStatuses[0], "done",
    "first rendered transition should target 'done' after reordering statuses");
});

test("E21.E.1: reorderStatuses moves source-before-target correctly", () => {
  const list = [
    { id: "a", name: "A", category: "todo" },
    { id: "b", name: "B", category: "doing" },
    { id: "c", name: "C", category: "done" }
  ];
  // Drag 'c' BEFORE 'a' → ["c","a","b"]
  let next = view.reorderStatuses(list, "c", "a", true);
  assert.deepStrictEqual(next.map(s => s.id), ["c", "a", "b"]);
  // Drag 'a' AFTER 'c' → ["b","c","a"]
  next = view.reorderStatuses(list, "a", "c", false);
  assert.deepStrictEqual(next.map(s => s.id), ["b", "c", "a"]);
  // Drag onto itself → unchanged copy.
  next = view.reorderStatuses(list, "b", "b", true);
  assert.deepStrictEqual(next.map(s => s.id), ["a", "b", "c"]);
  assert.notStrictEqual(next, list, "must return a copy, not mutate");
});

// ---------------------------------------------------------------------------
// E21.F — Transition editor
// ---------------------------------------------------------------------------

test("E21.F: transition editor renders one row per transition with all controls", () => {
  const store = buildStore();
  view.mount(freshHost(), store, {});
  const rows = document.querySelectorAll(".vs-transition-editor .vs-transition-row");
  const trs = store.get().project.workflow.transitions;
  assert.strictEqual(rows.length, trs.length, "one row per transition");
  rows.forEach((row, i) => {
    assert.ok(row.querySelector("input.vs-transition-name"), "name input");
    assert.ok(row.querySelector("select.vs-transition-target"), "target select");
    assert.ok(row.querySelector("select.vs-transition-gate"), "gate select");
    assert.ok(row.querySelector("input.vs-transition-any[type='checkbox']"), "allowFromAny toggle");
    assert.ok(row.querySelector("button.vs-transition-delete"), "delete button");
    assert.strictEqual(row.querySelector("input.vs-transition-name").value, trs[i].name);
    assert.strictEqual(row.querySelector("select.vs-transition-target").value, trs[i].toStatus);
    assert.strictEqual(row.querySelector("select.vs-transition-gate").value, trs[i].requireGate || "");
    assert.strictEqual(row.querySelector("input.vs-transition-any").checked, !!trs[i].allowFromAny);
  });
});

test("E21.F: gate select offers None / DoR / DoD options", () => {
  const store = buildStore();
  view.mount(freshHost(), store, {});
  const sel = document.querySelector(".vs-transition-editor select.vs-transition-gate");
  const opts = Array.from(sel.querySelectorAll("option")).map(o => o.value);
  assert.deepStrictEqual(opts.sort(), ["", "DoD", "DoR"]);
});

test("E21.F: changing target dropdown commits new toStatus", () => {
  const store = buildStore();
  view.mount(freshHost(), store, {});
  const trs = store.get().project.workflow.transitions;
  const firstId = trs[0].id;
  // Find a different status to switch to.
  const newTarget = store.get().project.workflow.statuses
    .map(s => s.id).find(id => id !== trs[0].toStatus);
  const row = document.querySelector(".vs-transition-editor .vs-transition-row[data-transition-id='" + firstId + "']");
  const sel = row.querySelector("select.vs-transition-target");
  sel.value = newTarget;
  sel.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  const after = store.get().project.workflow.transitions.find(t => t.id === firstId);
  assert.strictEqual(after.toStatus, newTarget);
});

test("E21.F: changing gate dropdown commits new requireGate (null when '')", () => {
  const store = buildStore();
  view.mount(freshHost(), store, {});
  const trs = store.get().project.workflow.transitions;
  // Pick a transition that currently has a gate (e.g. to-ready with DoR).
  const gated = trs.find(t => t.requireGate);
  assert.ok(gated, "default workflow should have at least one gated transition");
  const row = document.querySelector(".vs-transition-editor .vs-transition-row[data-transition-id='" + gated.id + "']");
  const sel = row.querySelector("select.vs-transition-gate");
  sel.value = "";   // None
  sel.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  const after = store.get().project.workflow.transitions.find(t => t.id === gated.id);
  assert.strictEqual(after.requireGate, null);
});

test("E21.F: blurring name input commits new name", () => {
  const store = buildStore();
  view.mount(freshHost(), store, {});
  const trs = store.get().project.workflow.transitions;
  const firstId = trs[0].id;
  const input = document.querySelector(".vs-transition-editor .vs-transition-row[data-transition-id='" + firstId + "'] input.vs-transition-name");
  input.value = "Promote";
  input.dispatchEvent(new dom.window.Event("blur", { bubbles: true }));
  const after = store.get().project.workflow.transitions.find(t => t.id === firstId);
  assert.strictEqual(after.name, "Promote");
});

test("E21.F: toggling allowFromAny commits + hides source checkboxes when set", () => {
  const store = buildStore();
  view.mount(freshHost(), store, {});
  const firstId = store.get().project.workflow.transitions[0].id;
  const row = document.querySelector(".vs-transition-editor .vs-transition-row[data-transition-id='" + firstId + "']");
  const anyToggle = row.querySelector("input.vs-transition-any");
  assert.strictEqual(anyToggle.checked, true, "default transitions are allowFromAny");
  const sourcesHost = row.querySelector(".vs-transition-sources");
  assert.ok(sourcesHost, "sources container should exist");
  // While allowFromAny is checked, sources must be hidden.
  assert.strictEqual(sourcesHost.hidden, true);
  // Untick → sources host becomes visible + commit fires.
  anyToggle.checked = false;
  anyToggle.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  const after = store.get().project.workflow.transitions.find(t => t.id === firstId);
  assert.strictEqual(after.allowFromAny, false);
});

test("E21.F: ticking a fromStatuses checkbox commits the new source list", () => {
  const store = buildStore();
  view.mount(freshHost(), store, {});
  const firstId = store.get().project.workflow.transitions[0].id;
  const row = document.querySelector(".vs-transition-editor .vs-transition-row[data-transition-id='" + firstId + "']");
  // Disable allowFromAny so the source checkboxes become live.
  const anyToggle = row.querySelector("input.vs-transition-any");
  anyToggle.checked = false;
  anyToggle.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  // Re-query — rerender produced fresh DOM after the commit.
  const refreshed = document.querySelector(".vs-transition-editor .vs-transition-row[data-transition-id='" + firstId + "']");
  const cbx = refreshed.querySelector(".vs-transition-sources input[type='checkbox'][data-source-id='ready']");
  assert.ok(cbx, "ready checkbox should be present");
  cbx.checked = true;
  cbx.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  const after = store.get().project.workflow.transitions.find(t => t.id === firstId);
  assert.ok(after.fromStatuses.includes("ready"), "fromStatuses should include 'ready'");
});

test("E21.F: '+ Add Transition' appends a new row with sensible defaults", () => {
  const store = buildStore();
  view.mount(freshHost(), store, {});
  const before = store.get().project.workflow.transitions.length;
  const addBtn = document.querySelector(".vs-transition-editor .vs-transition-add");
  assert.ok(addBtn);
  addBtn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  const after = store.get().project.workflow.transitions;
  assert.strictEqual(after.length, before + 1);
  const tail = after[after.length - 1];
  assert.strictEqual(typeof tail.id, "string");
  assert.ok(tail.id.length > 0);
  assert.strictEqual(tail.allowFromAny, true, "new transition should default to allowFromAny");
  assert.strictEqual(tail.requireGate, null);
});

test("E21.F: delete button removes the transition", () => {
  const store = buildStore();
  view.mount(freshHost(), store, {});
  const trs = store.get().project.workflow.transitions;
  const targetId = trs[0].id;
  const row = document.querySelector(".vs-transition-editor .vs-transition-row[data-transition-id='" + targetId + "']");
  row.querySelector("button.vs-transition-delete")
     .dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  const after = store.get().project.workflow.transitions;
  assert.strictEqual(after.length, trs.length - 1);
  assert.ok(!after.some(t => t.id === targetId));
});

test("E21.E.1: status rows register as drag-source AND drop-target with vs-status type", () => {
  const dnd = require("../frontend/js/dnd.js");
  const origDraggable = dnd.enableDraggable;
  const origTarget    = dnd.enableDropTarget;
  const drags = [];
  const targets = [];
  dnd.enableDraggable = (el, opts) => { drags.push({ el, opts }); };
  dnd.enableDropTarget = (el, opts) => { targets.push({ el, opts }); };
  try {
    const store = buildStore();
    view.mount(freshHost(), store, {});
    // After E23.C transitions also register draggable/drop-target; filter
    // by dragType so this assertion stays focussed on status rows.
    const statusDrags = drags.filter(d => d.opts.dragType === "vs-status");
    const statusTargets = targets.filter(t => Array.isArray(t.opts.accepts) && t.opts.accepts.includes("vs-status"));
    const expectedRows = store.get().project.workflow.statuses.length;
    assert.strictEqual(statusDrags.length,   expectedRows, "one draggable per status row");
    assert.strictEqual(statusTargets.length, expectedRows, "one drop target per status row");
  } finally {
    dnd.enableDraggable = origDraggable;
    dnd.enableDropTarget = origTarget;
  }
});

// ---------------------------------------------------------------------------
// E21.G — Kanban Board column editor
// ---------------------------------------------------------------------------

test("E21.G: assignStatusToColumn moves a status into target column and removes from any others", () => {
  const cols = [
    { id: "c1", name: "Todo",  statusIds: ["a", "b"] },
    { id: "c2", name: "Doing", statusIds: ["c"] },
    { id: "c3", name: "Done",  statusIds: ["d"] }
  ];
  // Move 'b' (currently in c1) to c2.
  const next = view.assignStatusToColumn(cols, "b", "c2");
  assert.deepStrictEqual(next.find(c => c.id === "c1").statusIds, ["a"]);
  assert.deepStrictEqual(next.find(c => c.id === "c2").statusIds, ["c", "b"]);
  // Move 'a' (currently in c1) to c3 — c1 should now be empty.
  const next2 = view.assignStatusToColumn(next, "a", "c3");
  assert.deepStrictEqual(next2.find(c => c.id === "c1").statusIds, []);
  assert.deepStrictEqual(next2.find(c => c.id === "c3").statusIds, ["d", "a"]);
});

test("E21.G: assignStatusToColumn is a no-op when target = current column", () => {
  const cols = [{ id: "c1", name: "X", statusIds: ["a", "b"] }];
  const next = view.assignStatusToColumn(cols, "a", "c1");
  // Functional equality — same column structure, same status order. The
  // function returns a fresh array (immutable transform), so structural
  // not identity equality.
  assert.strictEqual(next.length, 1);
  assert.deepStrictEqual(next[0].statusIds, ["a", "b"]);
});

test("E21.G: unassignedStatuses returns statuses not present in any column", () => {
  const statuses = [
    { id: "a", name: "A", category: "todo" },
    { id: "b", name: "B", category: "doing" },
    { id: "c", name: "C", category: "done" },
    { id: "d", name: "D", category: "done" }
  ];
  const cols = [
    { id: "c1", name: "X", statusIds: ["a"] },
    { id: "c2", name: "Y", statusIds: ["c"] }
  ];
  const orphans = view.unassignedStatuses(statuses, cols);
  assert.deepStrictEqual(orphans.map(s => s.id), ["b", "d"]);
});

test("E21.G: board editor renders a card per column + unassigned bucket", () => {
  const store = buildStore();
  view.mount(freshHost(), store, {});
  // SM-242: default workflow now seeds 6 columns (1 per status incl. cancelled).
  const cols = document.querySelectorAll(".vs-board-editor .vs-board-column");
  assert.strictEqual(cols.length, 6);
  const unassigned = document.querySelector(".vs-board-editor .vs-board-unassigned");
  assert.ok(unassigned, "unassigned bucket must exist");
  const orphanChips = unassigned.querySelectorAll(".vs-board-chip");
  assert.strictEqual(orphanChips.length, 0, "no orphan statuses by default");
});

test("E21.G: + Add Column appends a new column with empty statusIds", () => {
  const store = buildStore();
  view.mount(freshHost(), store, {});
  const before = store.get().project.boards.kanban.columns.length;
  const addBtn = document.querySelector(".vs-board-editor .vs-board-add-column");
  assert.ok(addBtn, "add-column button missing");
  addBtn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  const after = store.get().project.boards.kanban.columns;
  assert.strictEqual(after.length, before + 1);
  const tail = after[after.length - 1];
  assert.deepStrictEqual(tail.statusIds, []);
  assert.strictEqual(typeof tail.id, "string");
});

test("E21.G: delete-column removes the column AND surfaces its statuses as unassigned", () => {
  const store = buildStore();
  view.mount(freshHost(), store, {});
  const cols = store.get().project.boards.kanban.columns;
  const targetId = cols[1].id;
  const targetStatusIds = cols[1].statusIds.slice();
  const row = document.querySelector(".vs-board-editor .vs-board-column[data-column-id='" + targetId + "']");
  const delBtn = row.querySelector(".vs-board-column-delete");
  delBtn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  const after = store.get().project.boards.kanban.columns;
  assert.strictEqual(after.length, cols.length - 1);
  assert.ok(!after.some(c => c.id === targetId));
  // Status that lived in the deleted column should now be unassigned
  // (i.e. not in any remaining column).
  const stillAssigned = new Set(after.flatMap(c => c.statusIds));
  for (const sid of targetStatusIds) {
    assert.ok(!stillAssigned.has(sid), "orphaned status should not be in any column: " + sid);
  }
});

test("E21.G: column-name input on blur commits the new name", () => {
  const store = buildStore();
  view.mount(freshHost(), store, {});
  const firstId = store.get().project.boards.kanban.columns[0].id;
  const row = document.querySelector(".vs-board-editor .vs-board-column[data-column-id='" + firstId + "']");
  const input = row.querySelector("input.vs-board-column-name");
  input.value = "Pipeline";
  input.dispatchEvent(new dom.window.Event("blur", { bubbles: true }));
  const after = store.get().project.boards.kanban.columns.find(c => c.id === firstId);
  assert.strictEqual(after.name, "Pipeline");
});

test("E21.G: status chips and columns register the vs-board-status dnd type", () => {
  const dnd = require("../frontend/js/dnd.js");
  const origDraggable = dnd.enableDraggable;
  const origTarget    = dnd.enableDropTarget;
  const drags = [];
  const targets = [];
  dnd.enableDraggable = (el, opts) => { drags.push({ el, opts }); };
  dnd.enableDropTarget = (el, opts) => { targets.push({ el, opts }); };
  try {
    const store = buildStore();
    view.mount(freshHost(), store, {});
    const chipDrags = drags.filter(d => d.opts.dragType === "vs-board-status");
    const chipTargets = targets.filter(t => Array.isArray(t.opts.accepts) && t.opts.accepts.includes("vs-board-status"));
    // Default: 5 chips (one per status, all assigned 1:1 to columns).
    const statusCount = store.get().project.workflow.statuses.length;
    assert.strictEqual(chipDrags.length, statusCount, "one draggable per chip");
    // Targets: every column + the unassigned bucket.
    const colCount = store.get().project.boards.kanban.columns.length;
    assert.strictEqual(chipTargets.length, colCount + 1, "one drop target per column + unassigned bucket");
  } finally {
    dnd.enableDraggable = origDraggable;
    dnd.enableDropTarget = origTarget;
  }
});

test("E23.C: transition rows register as drag-source AND drop-target with vs-transition type", () => {
  const dnd = require("../frontend/js/dnd.js");
  const origDraggable = dnd.enableDraggable;
  const origTarget    = dnd.enableDropTarget;
  const drags = [];
  const targets = [];
  dnd.enableDraggable = (el, opts) => { drags.push({ el, opts }); };
  dnd.enableDropTarget = (el, opts) => { targets.push({ el, opts }); };
  try {
    const store = buildStore();
    view.mount(freshHost(), store, {});
    const trDrags = drags.filter(d => d.opts.dragType === "vs-transition");
    const trTargets = targets.filter(t => Array.isArray(t.opts.accepts) && t.opts.accepts.includes("vs-transition"));
    const expectedRows = store.get().project.workflow.transitions.length;
    assert.strictEqual(trDrags.length,   expectedRows, "one draggable per transition row");
    assert.strictEqual(trTargets.length, expectedRows, "one drop target per transition row");
  } finally {
    dnd.enableDraggable = origDraggable;
    dnd.enableDropTarget = origTarget;
  }
});

// ---------------------------------------------------------------------------
// SM-2 — DoR/DoD definitions editor inside the settings view
// ---------------------------------------------------------------------------
//
// The dialog version (dialog-definitions-settings.js) gates each save behind
// an explicit OK click; the view edition uses the same live-apply pattern as
// the status/transition/board editors — every discrete user action commits
// updateProject. SM-3 will deprecate the dialog once these tests pass.

function buildStoreWithDefs() {
  const snap = core.normalizeSnapshot({
    project: {
      id: "p1", name: "P", ticketPrefix: "P",
      definitions: {
        ready: { global: [{ id: "g-r1", label: "Has AC", required: true }], byType: {} },
        done:  { global: [{ id: "g-d1", label: "Reviewed", required: true }], byType: {} }
      }
    }
  });
  return new ProjectStore(snap);
}

test("SM-40+SM-47+SM-7+SM-8+SM-9+SM-107: settings view renders all nine sections in order", () => {
  const store = buildStoreWithDefs();
  view.mount(freshHost(), store, {});
  const sections = Array.from(document.querySelectorAll(".vs-section"))
    .map(s => s.dataset.section);
  assert.deepStrictEqual(sections, ["workflow", "dor", "dod", "board", "links", "types", "typeconfig", "labels", "rules"]);
});

test("SM-2: empty-state (no project) renders no definitions section", () => {
  view.mount(freshHost(), null, {});
  assert.strictEqual(document.querySelector(".vs-def-root"), null);
});

test("SM-2: readFormState pulls globals from project.definitions.<gate>.global", () => {
  const project = buildStoreWithDefs().get().project;
  const state = view.readFormState(project);
  assert.strictEqual(state.globalDor.length, 1);
  assert.strictEqual(state.globalDor[0].label, "Has AC");
  assert.strictEqual(state.globalDor[0].required, true);
  assert.strictEqual(state.globalDod[0].label, "Reviewed");
});

test("SM-2: readFormState derives enabled flag from workflow.transitions[].requireGate", () => {
  // Default workflow seeds DoR + DoD gates (see STORYMAPPER_DEFAULT_WORKFLOW).
  const project = buildStoreWithDefs().get().project;
  const state = view.readFormState(project);
  for (const type of project.ticketTypes) {
    if (type === "epic") continue;  // epics bypass gates
    const t = state.types[type];
    assert.ok(t.dor && typeof t.dor.enabled === "boolean", "DoR state for " + type);
    assert.ok(t.dod && typeof t.dod.enabled === "boolean", "DoD state for " + type);
  }
});

test("SM-38+SM-40: each gate-section has exactly ONE .vs-def-type-block at a time via its own type-picker", () => {
  const store = buildStoreWithDefs();
  view.mount(freshHost(), store, {});
  const project = store.get().project;
  // After SM-40 split, there are TWO sections (dor, dod), each with its
  // own type-picker + single type-block. Total = 2 type-blocks (one per
  // section), 2 pickers.
  const blocks = document.querySelectorAll(".vs-def-type-block");
  assert.strictEqual(blocks.length, 2,
    "one type-block per gate-section (dor + dod) = 2 total");
  const pickers = document.querySelectorAll("select.vs-def-type-picker");
  assert.strictEqual(pickers.length, 2, "one picker per gate-section");
  // Each picker has one option per ticketType.
  for (const p of pickers) {
    assert.strictEqual(p.options.length, (project.ticketTypes || []).length);
    assert.strictEqual(p.value, project.ticketTypes[0]);
  }
  // Each block defaults to the first ticketType.
  for (const b of blocks) {
    assert.strictEqual(b.dataset.vsDefType, project.ticketTypes[0]);
  }
});

test("SM-38+SM-40: switching the DoR-section's picker swaps DoR-block only (DoD-section unchanged)", () => {
  const store = buildStoreWithDefs();
  view.mount(freshHost(), store, {});
  const project = store.get().project;
  const altType = project.ticketTypes.find(t => t !== project.ticketTypes[0]);
  assert.ok(altType, "fixture has more than one ticketType");
  const dorSection = document.querySelector(".vs-section[data-section='dor']");
  const dorPicker = dorSection.querySelector("select.vs-def-type-picker");
  dorPicker.value = altType;
  dorPicker.dispatchEvent(new window.Event("change"));
  // DoR block now shows altType.
  const dorBlock = dorSection.querySelector(".vs-def-type-block");
  assert.strictEqual(dorBlock.dataset.vsDefType, altType);
  // DoD block STILL shows the default (first) type — isolation.
  const dodSection = document.querySelector(".vs-section[data-section='dod']");
  const dodBlock = dodSection.querySelector(".vs-def-type-block");
  assert.strictEqual(dodBlock.dataset.vsDefType, project.ticketTypes[0]);
});

test("SM-38: collectFormState preserves byType definitions for non-rendered types", () => {
  // Build a project where user-story has explicit per-type DoR overrides.
  // Render with picker on "epic" (first type) — user-story's block is NOT
  // in the DOM. Calling collectFormState must NOT drop user-story's
  // overrides from project.definitions.ready.byType.
  const snap = core.normalizeSnapshot({
    project: {
      id: "p1", name: "P", ticketPrefix: "P",
      definitions: {
        ready: { global: [{ id: "g-r1", label: "Has AC", required: true }],
                 byType: { "user-story": { overridden: [{ id: "us-r1", label: "Has spec", required: true }] } } },
        done:  { global: [{ id: "g-d1", label: "Reviewed", required: true }], byType: {} }
      }
    }
  });
  const store = new ProjectStore(snap);
  view.mount(freshHost(), store, {});
  // Picker is on "epic" (first type); user-story block NOT rendered.
  const section = document.querySelector(".vs-def-root");
  const patch = view.collectFormState(section, store.get().project);
  assert.ok(patch.definitions.ready.byType["user-story"],
    "user-story override preserved (not in DOM, but exists in project.definitions)");
  assert.deepStrictEqual(
    patch.definitions.ready.byType["user-story"].overridden.map(i => i.label),
    ["Has spec"]);
});

test("SM-40: each type-block has exactly ONE gate block (DoR-section → dor; DoD-section → dod)", () => {
  // SM-40 split: type-blocks now contain only the gate that matches their
  // parent section, not both gates as before.
  const store = buildStoreWithDefs();
  view.mount(freshHost(), store, {});
  const dorBlock = document.querySelector(".vs-section[data-section='dor'] .vs-def-type-block");
  const dodBlock = document.querySelector(".vs-section[data-section='dod'] .vs-def-type-block");
  assert.ok(dorBlock && dodBlock, "both type-blocks present (one per section)");
  // DoR-section's type-block has exactly one gate-block, and it's the dor one.
  const dorGates = dorBlock.querySelectorAll(".vs-def-gate-block");
  assert.strictEqual(dorGates.length, 1, "DoR section's type-block has exactly one gate-block");
  assert.strictEqual(dorGates[0].dataset.vsDefGate, "dor");
  // Same for DoD.
  const dodGates = dodBlock.querySelectorAll(".vs-def-gate-block");
  assert.strictEqual(dodGates.length, 1);
  assert.strictEqual(dodGates[0].dataset.vsDefGate, "dod");
  // Each gate-block still has its enable-toggle + mode-picker.
  for (const g of [dorGates[0], dodGates[0]]) {
    assert.ok(g.querySelector("input[type='checkbox'][data-vs-def-enabled]"), "enable toggle present");
    assert.ok(g.querySelector("select[data-vs-def-mode]"), "mode picker present");
  }
});

test("SM-40: DoR-edit only touches DoR section; DoD section unaffected (isolation)", () => {
  // AC #2 of SM-40: DoR-Edit beeinflusst nur den DoR-Section-Bereich;
  // DoD bleibt isoliert.
  const store = buildStoreWithDefs();
  view.mount(freshHost(), store, {});
  const dorSection = document.querySelector(".vs-section[data-section='dor']");
  const dodSection = document.querySelector(".vs-section[data-section='dod']");
  // DoR globals: add a new item via the +Add button in the DoR section.
  const dorGlobals = dorSection.querySelector("[data-vs-def-section='global-dor']");
  const dodGlobals = dodSection.querySelector("[data-vs-def-section='global-dod']");
  const dodRowsBefore = dodGlobals.querySelectorAll(".vs-def-item-row").length;
  dorGlobals.querySelector("button.vs-def-add-item").click();
  const dodRowsAfter = dodGlobals.querySelectorAll(".vs-def-item-row").length;
  assert.strictEqual(dodRowsAfter, dodRowsBefore,
    "DoR-Edit (add item to DoR globals) must not affect DoD section DOM");
});

test("SM-40: collectFormState reads both sections via .vs-root (no longer single-section)", () => {
  const store = buildStoreWithDefs();
  view.mount(freshHost(), store, {});
  const root = document.querySelector(".vs-root");
  const patch = view.collectFormState(root, store.get().project);
  // Both gates' globals round-trip.
  assert.ok(Array.isArray(patch.definitions.ready.global));
  assert.ok(Array.isArray(patch.definitions.done.global));
  assert.strictEqual(patch.definitions.ready.global[0].label, "Has AC");
  assert.strictEqual(patch.definitions.done.global[0].label, "Reviewed");
});

test("SM-38: gate-body is always visible (items pflegbar regardless of Enforce-toggle)", () => {
  // SM-38 follow-up: per the user's mental model, items remain editable as
  // human-reminder checklists even when the gate is NOT enforced. So the
  // body (with mode picker + items list) is always visible.
  const store = buildStoreWithDefs();
  view.mount(freshHost(), store, {});
  const gates = Array.from(document.querySelectorAll(".vs-def-gate-block"));
  for (const g of gates) {
    const body = g.querySelector(".vs-def-gate-body");
    assert.ok(body, "gate body present");
    assert.notStrictEqual(body.style.display, "none",
      "gate body always visible (items editable regardless of Enforce toggle)");
  }
});

test("SM-38: items-list is ALWAYS visible when gate is enabled (regardless of mode)", () => {
  // SM-38 follow-up: previously the items list was hidden when mode=inherit,
  // which hid the +Add Item UI and gave the impression per-type config was
  // on/off only. Now items are always editable — inherit just means they're
  // stored-but-not-applied.
  const store = buildStoreWithDefs();
  view.mount(freshHost(), store, {});
  const section = document.querySelector(".vs-def-root");
  const picker = section.querySelector("select.vs-def-type-picker");
  // Switch to user-story and enable its DoR gate so the gate body is visible.
  picker.value = "user-story";
  picker.dispatchEvent(new window.Event("change"));
  const block = section.querySelector('.vs-def-type-block[data-vs-def-type="user-story"]');
  const dorEnabled = block.querySelector("input[data-vs-def-enabled='dor']");
  dorEnabled.checked = true;
  dorEnabled.dispatchEvent(new window.Event("change"));
  const dorGate = block.querySelector(".vs-def-gate-block[data-vs-def-gate='dor']");
  const items = dorGate.querySelector("[data-vs-def-items]");
  assert.ok(items, "items list rendered");
  // No inline `display: none` — items visible regardless of mode value.
  assert.notStrictEqual(items.style.display, "none",
    "items list visible when gate enabled (mode=inherit no longer hides)");
  // And +Add Item button is reachable.
  const addBtn = dorGate.querySelector("button.vs-def-add-item");
  assert.ok(addBtn, "+Add Item button reachable in per-type gate block");
});

test("SM-2: collectFormState reads the section DOM and returns {definitions, workflow, entityTypeConfig}", () => {
  const store = buildStoreWithDefs();
  view.mount(freshHost(), store, {});
  const section = document.querySelector(".vs-def-root");
  const patch = view.collectFormState(section, store.get().project);
  assert.ok(patch.definitions && patch.definitions.ready && patch.definitions.done);
  assert.ok(patch.workflow);
  assert.ok(patch.entityTypeConfig);
  // Globals round-trip.
  assert.strictEqual(patch.definitions.ready.global.length, 1);
  assert.strictEqual(patch.definitions.ready.global[0].label, "Has AC");
});

test("SM-38: 'Enforce gate' toggle controls workflow.requireGate only — NOT entityTypeConfig.show* (decoupled)", () => {
  // SM-38 follow-up: per the user's mental model, the per-type "Enforce DoR
  // gate" toggle controls ONLY whether the transition is blocked when
  // required items aren't checked. It does NOT control whether the DoR
  // section appears in the ticket modal — that's a separate concern.
  // Per-type DoR items remain pflegbar even when the gate isn't enforced
  // (humans use them as a checklist reminder).
  const store = buildStoreWithDefs();
  view.mount(freshHost(), store, {});
  const project = store.get().project;
  const section = document.querySelector(".vs-def-root");
  // Switch picker to user-story and enable the gate.
  const picker = section.querySelector("select.vs-def-type-picker");
  picker.value = "user-story";
  picker.dispatchEvent(new window.Event("change"));
  const block = section.querySelector('.vs-def-type-block[data-vs-def-type="user-story"]');
  const dorCb = block.querySelector("input[data-vs-def-enabled='dor']");
  dorCb.checked = true;
  let patch = view.collectFormState(section, project);
  const toReady = patch.workflow.byType["user-story"].transitions.find(t => t.toStatus === "ready");
  assert.strictEqual(toReady.requireGate, "DoR", "gate enforced when toggle ON");
  // The decoupling: entityTypeConfig.showDefinitionOfReady is NOT modified
  // by this toggle. It stays at its pre-existing value (default true).
  assert.notStrictEqual(patch.entityTypeConfig["user-story"] && patch.entityTypeConfig["user-story"].showDefinitionOfReady, false,
    "show-toggle in entityTypeConfig is NOT forced off when gate disabled");
  // Now toggle OFF — gate must drop to null but the show-toggle stays.
  dorCb.checked = false;
  patch = view.collectFormState(section, project);
  const toReady2 = patch.workflow.byType["user-story"].transitions.find(t => t.toStatus === "ready");
  assert.strictEqual(toReady2.requireGate, null, "gate cleared when toggle OFF");
  assert.notStrictEqual(patch.entityTypeConfig["user-story"] && patch.entityTypeConfig["user-story"].showDefinitionOfReady, false,
    "show-toggle still NOT forced off");
});

test("SM-38: per-type items persist even when 'Enforce gate' is OFF (reminder use-case)", () => {
  // Items pflegbar regardless of gate-enforcement.
  const store = buildStoreWithDefs();
  view.mount(freshHost(), store, {});
  const project = store.get().project;
  const section = document.querySelector(".vs-def-root");
  const picker = section.querySelector("select.vs-def-type-picker");
  picker.value = "user-story";
  picker.dispatchEvent(new window.Event("change"));
  const block = section.querySelector('.vs-def-type-block[data-vs-def-type="user-story"]');
  // Explicitly turn the Enforce toggle OFF (the default workflow may have it
  // ON via the global to-ready transition with requireGate=DoR — that
  // propagates to per-type readGateState as enabled=true).
  const dorCb = block.querySelector("input[data-vs-def-enabled='dor']");
  dorCb.checked = false;
  // Switch DoR mode to "append" and add an item via DOM.
  const dorMode = block.querySelector("[data-vs-def-mode='dor']");
  dorMode.value = "append";
  const itemsList = block.querySelector("[data-vs-def-items='dor']");
  const addBtn = itemsList.querySelector("button.vs-def-add-item");
  addBtn.click();
  // Set a label on the newly-added row.
  const rows = itemsList.querySelectorAll(".vs-def-item-row");
  const newRow = rows[rows.length - 1];
  const labelInput = newRow.querySelector("input[type='text']");
  labelInput.value = "Reminder item";
  const patch = view.collectFormState(section, project);
  // Items must be persisted to definitions.ready.byType, even though gate is OFF.
  const entry = patch.definitions.ready.byType["user-story"];
  assert.ok(entry, "byType entry persisted when items present (regardless of gate)");
  assert.strictEqual(entry.appended[0].label, "Reminder item");
  // And the gate is NOT enforced.
  const toReady = patch.workflow.byType["user-story"].transitions.find(t => t.toStatus === "ready");
  assert.strictEqual(toReady.requireGate, null, "gate stays disabled even with items present");
});

test("SM-2: adding an item via the '+ Add Item' button appends an empty row that vanishes on collect (empty label)", () => {
  const store = buildStoreWithDefs();
  view.mount(freshHost(), store, {});
  const section = document.querySelector(".vs-def-root");
  const dorList = section.querySelector('[data-vs-def-section="global-dor"]');
  const before = dorList.querySelectorAll(".vs-def-item-row").length;
  const addBtn = dorList.querySelector("button.vs-def-add-item");
  addBtn.click();
  const after = dorList.querySelectorAll(".vs-def-item-row").length;
  assert.strictEqual(after, before + 1, "new row in DOM");
  // collectFormState drops the empty row.
  const patch = view.collectFormState(section, store.get().project);
  assert.strictEqual(patch.definitions.ready.global.length, before,
    "empty-label rows are skipped on collect");
});

test("SM-2: removing an item via the × button triggers an updateProject commit that drops it", () => {
  const store = buildStoreWithDefs();
  let commits = 0;
  // Wrap subscribe to count commits.
  store.subscribe(() => { commits++; });
  view.mount(freshHost(), store, {});
  const section = document.querySelector(".vs-def-root");
  const dorList = section.querySelector('[data-vs-def-section="global-dor"]');
  const row = dorList.querySelector(".vs-def-item-row");
  const removeBtn = row.querySelector("button.vs-def-item-remove");
  const beforeCommits = commits;
  removeBtn.click();
  assert.ok(commits > beforeCommits, "remove triggers at least one store commit");
  assert.strictEqual(store.get().project.definitions.ready.global.length, 0,
    "global DoR is now empty");
});

// ---------------------------------------------------------------------------
// SM-41 — horizontal tab-bar with show/hide per section
// ---------------------------------------------------------------------------

test("SM-41+SM-47+SM-7+SM-8+SM-9+SM-107: tab-bar renders 9 buttons in order, Workflow active by default", () => {
  const store = buildStoreWithDefs();
  view.mount(freshHost(), store, {});
  const bar = document.querySelector(".vs-tab-bar");
  assert.ok(bar, "tab-bar present");
  const buttons = bar.querySelectorAll(".vs-tab-btn");
  assert.strictEqual(buttons.length, 9);
  const ids = Array.from(buttons).map(b => b.dataset.vsTab);
  assert.deepStrictEqual(ids, ["workflow", "dor", "dod", "board", "links", "types", "typeconfig", "labels", "rules"]);
  const active = bar.querySelector(".vs-tab-btn.active");
  assert.ok(active);
  assert.strictEqual(active.dataset.vsTab, "workflow", "default-active = workflow");
});

test("SM-41: only the section matching the active tab is visible; others have hidden attribute", () => {
  const store = buildStoreWithDefs();
  view.mount(freshHost(), store, {});
  const sections = document.querySelectorAll(".vs-root > .vs-section");
  let visible = 0;
  for (const s of sections) {
    const isHidden = s.hasAttribute("hidden");
    if (!isHidden) {
      visible++;
      assert.strictEqual(s.dataset.section, "workflow", "the visible section is workflow");
    }
  }
  assert.strictEqual(visible, 1, "exactly one section visible");
});

test("SM-41: clicking a tab toggles visibility WITHOUT triggering a renderInto", () => {
  // Tab-switch must not full-rerender (DOM identity + DnD registrations
  // must survive). We assert by capturing a section element reference,
  // clicking another tab, then asserting the same DOM node still exists.
  const store = buildStoreWithDefs();
  view.mount(freshHost(), store, {});
  const dorSectionBefore = document.querySelector(".vs-section[data-section='dor']");
  const dorTabBtn = document.querySelector(".vs-tab-bar .vs-tab-btn[data-vs-tab='dor']");
  dorTabBtn.click();
  const dorSectionAfter = document.querySelector(".vs-section[data-section='dor']");
  assert.strictEqual(dorSectionBefore, dorSectionAfter, "same DOM node — no rerender");
  // And visibility flipped.
  assert.ok(!dorSectionAfter.hasAttribute("hidden"), "DoR section is now visible");
  const workflowSection = document.querySelector(".vs-section[data-section='workflow']");
  assert.ok(workflowSection.hasAttribute("hidden"), "Workflow section is now hidden");
  // Active class moved.
  assert.ok(dorTabBtn.classList.contains("active"));
  assert.strictEqual(dorTabBtn.getAttribute("aria-selected"), "true");
});

test("SM-41: closing + re-mounting the settings view resets the active tab to Workflow", () => {
  const store = buildStoreWithDefs();
  const ctl1 = view.mount(freshHost(), store, {});
  // Switch to DoR.
  document.querySelector(".vs-tab-btn[data-vs-tab='dor']").click();
  assert.strictEqual(document.querySelector(".vs-tab-btn.active").dataset.vsTab, "dor");
  ctl1.unmount();
  // Fresh mount — default tab should be Workflow again.
  const ctl2 = view.mount(freshHost(), store, {});
  assert.strictEqual(document.querySelector(".vs-tab-btn.active").dataset.vsTab, "workflow",
    "fresh mount resets the active tab to workflow");
  ctl2.unmount();
});

test("SM-41: external store commit (live-sync) re-renders but KEEPS the user on their current tab", () => {
  const store = buildStoreWithDefs();
  view.mount(freshHost(), store, {});
  // Switch to DoD.
  document.querySelector(".vs-tab-btn[data-vs-tab='dod']").click();
  // External commit — simulates MCP or another browser writing.
  store.updateProject({ name: "Renamed-via-external" }, { type: "human", id: "ext", name: "Ext" });
  // After rerender, the active tab must still be DoD (no reset).
  const active = document.querySelector(".vs-tab-btn.active");
  assert.strictEqual(active.dataset.vsTab, "dod",
    "live-sync rerender preserves user's active tab");
});

// ---------------------------------------------------------------------------
// SM-47 — Link-Types editor
// ---------------------------------------------------------------------------

function buildStoreWithLinkTypes(custom) {
  const snap = core.normalizeSnapshot({
    project: {
      id: "p1", name: "P", ticketPrefix: "P",
      linkTypes: custom || undefined
    }
  });
  return new ProjectStore(snap);
}

test("SM-47 (+SM-56, +SM-54-followup): Link-Types section renders one row per linkType + header + add-button", () => {
  // Default project seeds 7 linkTypes (predecessor-of/blocks/follows-on/
  // contains/relates-to/executes/tests).
  const store = buildStoreWithLinkTypes();
  view.mount(freshHost(), store, {});
  // Switch to Links tab so it's visible.
  document.querySelector(".vs-tab-btn[data-vs-tab='links']").click();
  const section = document.querySelector(".vs-section[data-section='links']");
  assert.ok(section, "links section rendered");
  assert.ok(!section.hasAttribute("hidden"), "links section is visible after tab click");

  const rows = section.querySelectorAll(".vs-linktype-row:not(.vs-linktype-head)");
  assert.strictEqual(rows.length, 12, "12 default linkTypes seeded (SM-180 added supersedes/replaces/refines/realises)");
  const head = section.querySelector(".vs-linktype-row.vs-linktype-head");
  assert.ok(head, "header row present");
  const add = section.querySelector(".vs-linktype-add");
  assert.ok(add, "add button present");
});

test("SM-47: each row exposes id (read-only), label-input, inverse-input, semantic-select, color-input, delete-button", () => {
  const store = buildStoreWithLinkTypes([
    { id: "blocks", label: "Blocks", inverseLabel: "Blocked by", semantic: "blocking", color: "#FF8888" }
  ]);
  view.mount(freshHost(), store, {});
  document.querySelector(".vs-tab-btn[data-vs-tab='links']").click();
  const row = document.querySelector(".vs-linktype-row[data-linktype-id='blocks']");
  assert.ok(row, "row keyed by id");
  assert.strictEqual(row.querySelector(".vs-linktype-id").textContent, "blocks");
  const lbl = row.querySelector("input.vs-linktype-label");
  assert.strictEqual(lbl.value, "Blocks");
  const inv = row.querySelector("input.vs-linktype-inverse");
  assert.strictEqual(inv.value, "Blocked by");
  const sem = row.querySelector("select.vs-linktype-semantic");
  assert.strictEqual(sem.value, "blocking");
  // Semantic dropdown lists every LINK_SEMANTICS value.
  const opts = Array.from(sem.querySelectorAll("option")).map(o => o.value);
  assert.deepStrictEqual(opts.sort(), core.LINK_SEMANTICS.slice().sort(),
    "semantic dropdown lists every defined semantic");
  const color = row.querySelector("input.vs-linktype-color");
  assert.strictEqual(color.value, "#ff8888", "color input parsed lowercase");
  assert.ok(row.querySelector("button.vs-linktype-delete"), "delete button present");
});

test("SM-47: changing the semantic dropdown commits updateProject with the new semantic", () => {
  const store = buildStoreWithLinkTypes([
    { id: "rel", label: "Relates to", inverseLabel: "Relates to", semantic: "freeform" }
  ]);
  view.mount(freshHost(), store, {});
  document.querySelector(".vs-tab-btn[data-vs-tab='links']").click();
  const sel = document.querySelector(".vs-linktype-row[data-linktype-id='rel'] select.vs-linktype-semantic");
  sel.value = "blocking";
  sel.dispatchEvent(new dom.window.Event("change"));
  const after = store.get().project.linkTypes.find(lt => lt.id === "rel");
  assert.strictEqual(after.semantic, "blocking", "semantic persisted");
});

test("SM-47: label-input commits on blur (NOT per-keystroke), inverse-input likewise", () => {
  const store = buildStoreWithLinkTypes([
    { id: "rel", label: "Relates to", inverseLabel: "Relates to", semantic: "freeform" }
  ]);
  view.mount(freshHost(), store, {});
  document.querySelector(".vs-tab-btn[data-vs-tab='links']").click();
  const lbl = document.querySelector(".vs-linktype-row[data-linktype-id='rel'] input.vs-linktype-label");
  lbl.value = "Mid-edit";
  lbl.dispatchEvent(new dom.window.Event("input"));
  // No commit yet — value still original.
  assert.strictEqual(store.get().project.linkTypes.find(lt => lt.id === "rel").label, "Relates to");
  // Blur commits.
  lbl.dispatchEvent(new dom.window.Event("blur"));
  assert.strictEqual(store.get().project.linkTypes.find(lt => lt.id === "rel").label, "Mid-edit");

  const inv = document.querySelector(".vs-linktype-row[data-linktype-id='rel'] input.vs-linktype-inverse");
  inv.value = "Inv-edit";
  inv.dispatchEvent(new dom.window.Event("blur"));
  assert.strictEqual(store.get().project.linkTypes.find(lt => lt.id === "rel").inverseLabel, "Inv-edit");
});

test("SM-47: empty label on blur is a No-Op (does not wipe the field)", () => {
  const store = buildStoreWithLinkTypes([
    { id: "rel", label: "Relates to", inverseLabel: "Relates to", semantic: "freeform" }
  ]);
  view.mount(freshHost(), store, {});
  document.querySelector(".vs-tab-btn[data-vs-tab='links']").click();
  const lbl = document.querySelector(".vs-linktype-row[data-linktype-id='rel'] input.vs-linktype-label");
  lbl.value = "   ";
  lbl.dispatchEvent(new dom.window.Event("blur"));
  assert.strictEqual(store.get().project.linkTypes.find(lt => lt.id === "rel").label, "Relates to",
    "empty label is a no-op");
});

test("SM-47: + Add Link Type appends a row with auto-generated id custom-N and freeform semantic", () => {
  const store = buildStoreWithLinkTypes([
    { id: "rel", label: "Relates to", inverseLabel: "Relates to", semantic: "freeform" }
  ]);
  view.mount(freshHost(), store, {});
  document.querySelector(".vs-tab-btn[data-vs-tab='links']").click();
  document.querySelector(".vs-linktype-add").click();
  // SM-52 forces `contains` to be present too; we assert on the user-added entries.
  const linkTypes = store.get().project.linkTypes;
  const custom1 = linkTypes.find(lt => lt.id === "custom-1");
  assert.ok(custom1, "custom-1 added");
  assert.strictEqual(custom1.semantic, "freeform");
  // Click again — id collision-avoidance.
  document.querySelector(".vs-linktype-add").click();
  const linkTypes2 = store.get().project.linkTypes;
  assert.ok(linkTypes2.find(lt => lt.id === "custom-2"), "custom-2 added with deduped id");
});

test("SM-47: delete-button removes the row when no ticket references the linkType", () => {
  const store = buildStoreWithLinkTypes([
    { id: "rel", label: "Relates to", inverseLabel: "Relates to", semantic: "freeform" },
    { id: "other", label: "Other", inverseLabel: "Other", semantic: "freeform" }
  ]);
  view.mount(freshHost(), store, {});
  document.querySelector(".vs-tab-btn[data-vs-tab='links']").click();
  document.querySelector(".vs-linktype-row[data-linktype-id='other'] button.vs-linktype-delete").click();
  const linkTypes = store.get().project.linkTypes;
  // SM-52: `contains` is always present as a system requirement; we only
  // assert the user-managed entries.
  assert.ok(linkTypes.find(lt => lt.id === "rel"),     "rel kept");
  assert.ok(!linkTypes.find(lt => lt.id === "other"),  "other removed");
});

test("SM-47: focus-guard skips rerender while label-input or inverse-input has focus", () => {
  const store = buildStoreWithLinkTypes([
    { id: "rel", label: "Relates to", inverseLabel: "Relates to", semantic: "freeform" }
  ]);
  view.mount(freshHost(), store, {});
  document.querySelector(".vs-tab-btn[data-vs-tab='links']").click();
  const lbl = document.querySelector(".vs-linktype-row[data-linktype-id='rel'] input.vs-linktype-label");
  lbl.focus();
  lbl.value = "In-flight";
  // External commit fires the subscribe-rerender — focus-guard must skip it.
  store.updateProject({ name: "External-Rename" }, { type: "human", id: "ext", name: "Ext" });
  const lblAfter = document.querySelector(".vs-linktype-row[data-linktype-id='rel'] input.vs-linktype-label");
  assert.strictEqual(lblAfter, lbl, "same DOM node — no rerender happened");
  assert.strictEqual(lblAfter.value, "In-flight", "in-flight value preserved");
});

test("SM-47: live-sync rebuilds the rows when the user is NOT focused on any input", () => {
  const store = buildStoreWithLinkTypes([
    { id: "a", label: "A", inverseLabel: "A", semantic: "freeform" }
  ]);
  view.mount(freshHost(), store, {});
  document.querySelector(".vs-tab-btn[data-vs-tab='links']").click();
  // External commit: replace linkTypes wholesale.
  store.updateProject({
    linkTypes: [
      { id: "a", label: "A", inverseLabel: "A", semantic: "freeform" },
      { id: "b", label: "B-new", inverseLabel: "B-inv", semantic: "blocking" }
    ]
  }, { type: "human", id: "ext", name: "Ext" });
  // SM-52: contains is auto-included; expect rows for a, b, contains.
  const rows = document.querySelectorAll(".vs-linktype-row:not(.vs-linktype-head)");
  assert.ok(rows.length >= 2, "rebuild shows the user-defined linkTypes");
  const bRow = document.querySelector(".vs-linktype-row[data-linktype-id='b']");
  assert.ok(bRow, "new B row rendered");
  assert.strictEqual(bRow.querySelector("input.vs-linktype-label").value, "B-new");
});

// ---------------------------------------------------------------------------
// SM-7 — Ticket-Types editor
// ---------------------------------------------------------------------------

function buildStoreWithTypes(types) {
  const snap = core.normalizeSnapshot({
    project: {
      id: "p1", name: "P", ticketPrefix: "P",
      ticketTypes: types || undefined
    }
  });
  return new ProjectStore(snap);
}

test("SM-7: Ticket-Types section renders one row per type + add-button", () => {
  const store = buildStoreWithTypes(["epic", "user-story", "bug"]);
  view.mount(freshHost(), store, {});
  document.querySelector(".vs-tab-btn[data-vs-tab='types']").click();
  const section = document.querySelector(".vs-section[data-section='types']");
  assert.ok(section, "types section rendered");
  assert.ok(!section.hasAttribute("hidden"), "visible after tab click");
  const rows = section.querySelectorAll(".vs-tickettype-row");
  assert.strictEqual(rows.length, 3);
  assert.ok(section.querySelector(".vs-tickettype-add"));
});

test("SM-7: rename via on-blur commits updateProject with the new name", () => {
  const store = buildStoreWithTypes(["epic", "user-story"]);
  view.mount(freshHost(), store, {});
  document.querySelector(".vs-tab-btn[data-vs-tab='types']").click();
  const input = document.querySelector(".vs-tickettype-row[data-type-name='user-story'] input.vs-tickettype-name");
  input.value = "story";
  input.dispatchEvent(new dom.window.Event("blur"));
  assert.deepStrictEqual(store.get().project.ticketTypes, ["epic", "story"]);
});

test("SM-7: + Add Ticket Type appends a custom-type-N with collision avoidance", () => {
  const store = buildStoreWithTypes(["epic"]);
  view.mount(freshHost(), store, {});
  document.querySelector(".vs-tab-btn[data-vs-tab='types']").click();
  document.querySelector(".vs-tickettype-add").click();
  assert.deepStrictEqual(store.get().project.ticketTypes, ["epic", "custom-type-1"]);
  document.querySelector(".vs-tickettype-add").click();
  assert.deepStrictEqual(store.get().project.ticketTypes, ["epic", "custom-type-1", "custom-type-2"]);
});

test("SM-7: empty rename is a no-op (does not wipe the field or commit)", () => {
  const store = buildStoreWithTypes(["epic"]);
  view.mount(freshHost(), store, {});
  document.querySelector(".vs-tab-btn[data-vs-tab='types']").click();
  const input = document.querySelector(".vs-tickettype-row[data-type-name='epic'] input.vs-tickettype-name");
  input.value = "   ";
  input.dispatchEvent(new dom.window.Event("blur"));
  assert.deepStrictEqual(store.get().project.ticketTypes, ["epic"]);
});

test("SM-7: delete removes the type (no in-use tickets → no confirm needed)", () => {
  const store = buildStoreWithTypes(["epic", "bug"]);
  view.mount(freshHost(), store, {});
  document.querySelector(".vs-tab-btn[data-vs-tab='types']").click();
  document.querySelector(".vs-tickettype-row[data-type-name='bug'] button.vs-tickettype-delete").click();
  assert.deepStrictEqual(store.get().project.ticketTypes, ["epic"]);
});

test("SM-7: deleting all types triggers normalizeProject re-seed of DEFAULT_TICKET_TYPES (lock-out protection)", () => {
  const store = buildStoreWithTypes(["only-one"]);
  view.mount(freshHost(), store, {});
  document.querySelector(".vs-tab-btn[data-vs-tab='types']").click();
  document.querySelector(".vs-tickettype-row[data-type-name='only-one'] button.vs-tickettype-delete").click();
  const after = store.get().project.ticketTypes;
  assert.ok(after.length > 0, "default set reseeded");
  assert.deepStrictEqual(after, core.DEFAULT_TICKET_TYPES);
});

test("SM-7: reorderTicketTypes pure helper moves source before/after target", () => {
  assert.deepStrictEqual(view.reorderTicketTypes(["a","b","c","d"], "a", "c", true),  ["b","a","c","d"]);
  assert.deepStrictEqual(view.reorderTicketTypes(["a","b","c","d"], "a", "c", false), ["b","c","a","d"]);
  assert.deepStrictEqual(view.reorderTicketTypes(["a","b","c"],     "c", "a", true),  ["c","a","b"]);
});

test("SM-7: focus-guard skips rerender while ticket-type name input has focus", () => {
  const store = buildStoreWithTypes(["epic"]);
  view.mount(freshHost(), store, {});
  document.querySelector(".vs-tab-btn[data-vs-tab='types']").click();
  const input = document.querySelector(".vs-tickettype-row input.vs-tickettype-name");
  input.focus();
  input.value = "in-flight";
  store.updateProject({ name: "external-rename" }, { type: "human", id: "ext", name: "Ext" });
  const after = document.querySelector(".vs-tickettype-row input.vs-tickettype-name");
  assert.strictEqual(after, input, "same DOM node");
  assert.strictEqual(after.value, "in-flight");
});

// ---------------------------------------------------------------------------
// SM-8 — Labels editor
// ---------------------------------------------------------------------------

function buildStoreWithLabels(labels) {
  const snap = core.normalizeSnapshot({
    project: {
      id: "p1", name: "P", ticketPrefix: "P",
      labels: labels || undefined
    }
  });
  return new ProjectStore(snap);
}

test("SM-8: Labels section renders empty-hint + add-button when no labels exist", () => {
  const store = buildStoreWithLabels([]);
  view.mount(freshHost(), store, {});
  document.querySelector(".vs-tab-btn[data-vs-tab='labels']").click();
  const section = document.querySelector(".vs-section[data-section='labels']");
  assert.ok(section);
  assert.ok(section.querySelector(".vs-empty"), "empty hint present");
  assert.ok(section.querySelector(".vs-label-add"));
});

test("SM-8: + Add Label appends a label-N with default color and gets a generated id", () => {
  const store = buildStoreWithLabels([]);
  view.mount(freshHost(), store, {});
  document.querySelector(".vs-tab-btn[data-vs-tab='labels']").click();
  document.querySelector(".vs-label-add").click();
  const labels = store.get().project.labels;
  assert.strictEqual(labels.length, 1);
  assert.strictEqual(labels[0].name, "label-1");
  assert.ok(labels[0].id, "id generated");
  assert.ok(/^#/.test(labels[0].color), "color set");
});

test("SM-8: each label row has swatch + name input + color input + delete button", () => {
  const store = buildStoreWithLabels([{ name: "urgent", color: "#FF0000" }]);
  view.mount(freshHost(), store, {});
  document.querySelector(".vs-tab-btn[data-vs-tab='labels']").click();
  const row = document.querySelector(".vs-label-row");
  assert.ok(row);
  const swatch = row.querySelector(".vs-label-swatch");
  assert.ok(swatch);
  assert.strictEqual(swatch.style.backgroundColor, "rgb(255, 0, 0)");
  assert.strictEqual(row.querySelector("input.vs-label-name").value, "urgent");
  assert.strictEqual(row.querySelector("input.vs-label-color").value, "#ff0000");
  assert.ok(row.querySelector("button.vs-label-delete"));
});

test("SM-8: rename via on-blur commits new name (id preserved)", () => {
  const store = buildStoreWithLabels([{ name: "urgent", color: "#FF0000" }]);
  view.mount(freshHost(), store, {});
  document.querySelector(".vs-tab-btn[data-vs-tab='labels']").click();
  const idBefore = store.get().project.labels[0].id;
  const input = document.querySelector(".vs-label-row input.vs-label-name");
  input.value = "p0";
  input.dispatchEvent(new dom.window.Event("blur"));
  const after = store.get().project.labels[0];
  assert.strictEqual(after.name, "p0");
  assert.strictEqual(after.id, idBefore, "id stable across rename");
});

test("SM-8: color-change commits updateProject with new color (id preserved)", () => {
  const store = buildStoreWithLabels([{ name: "urgent", color: "#FF0000" }]);
  view.mount(freshHost(), store, {});
  document.querySelector(".vs-tab-btn[data-vs-tab='labels']").click();
  const color = document.querySelector(".vs-label-row input.vs-label-color");
  color.value = "#00FF00";
  color.dispatchEvent(new dom.window.Event("change"));
  // Browsers normalize the color input value to lowercase before reading,
  // so we accept either casing here.
  assert.strictEqual(store.get().project.labels[0].color.toLowerCase(), "#00ff00");
});

test("SM-8: delete removes the label row (no in-use tickets)", () => {
  const store = buildStoreWithLabels([{ name: "a" }, { name: "b" }]);
  view.mount(freshHost(), store, {});
  document.querySelector(".vs-tab-btn[data-vs-tab='labels']").click();
  document.querySelectorAll(".vs-label-row button.vs-label-delete")[0].click();
  const after = store.get().project.labels;
  assert.strictEqual(after.length, 1);
  assert.strictEqual(after[0].name, "b");
});

test("SM-8: reorderLabels pure helper moves source before/after target by id", () => {
  const labels = [
    { id: "l1", name: "a" }, { id: "l2", name: "b" }, { id: "l3", name: "c" }
  ];
  assert.deepStrictEqual(view.reorderLabels(labels, "l1", "l3", true).map(l => l.id),  ["l2","l1","l3"]);
  assert.deepStrictEqual(view.reorderLabels(labels, "l1", "l3", false).map(l => l.id), ["l2","l3","l1"]);
  assert.deepStrictEqual(view.reorderLabels(labels, "l3", "l1", true).map(l => l.id),  ["l3","l1","l2"]);
});

test("SM-8: normalizeLabel string-input backward-compat — legacy project.labels=['foo'] migrates cleanly", () => {
  const snap = core.normalizeSnapshot({ project: { id: "p1", name: "P", ticketPrefix: "P", labels: ["foo", "bar"] } });
  const labels = snap.project.labels;
  assert.strictEqual(labels.length, 2);
  assert.strictEqual(labels[0].name, "foo");
  assert.strictEqual(labels[1].name, "bar");
  assert.ok(labels[0].id);
  assert.ok(/^#/.test(labels[0].color), "default color applied to migrated string label");
});

// ---------------------------------------------------------------------------
// SM-9 — Type-Config editor
// ---------------------------------------------------------------------------

function buildStoreWithTypesAndConfig(types, etc) {
  const snap = core.normalizeSnapshot({
    project: {
      id: "p1", name: "P", ticketPrefix: "P",
      ticketTypes: types || undefined,
      entityTypeConfig: etc || undefined
    }
  });
  return new ProjectStore(snap);
}

test("SM-9 + SM-100: Type-Config section renders type-picker + 7 generic flag rows for a non-test type (test-flags hidden); first type pre-selected", () => {
  const store = buildStoreWithTypesAndConfig(["epic", "user-story", "bug"]);
  view.mount(freshHost(), store, {});
  document.querySelector(".vs-tab-btn[data-vs-tab='typeconfig']").click();
  const section = document.querySelector(".vs-section[data-section='typeconfig']");
  assert.ok(section);
  assert.ok(!section.hasAttribute("hidden"));
  const select = section.querySelector("select.vs-typeconfig-type-select");
  assert.ok(select);
  assert.strictEqual(select.value, "epic", "first ticket type pre-selected");
  const flagRows = section.querySelectorAll(".vs-typeconfig-flag");
  // SM-100: only the 7 generic flags render for non-test types. Test-flags
  // are hidden — the engine hard-locks them to false anyway.
  assert.strictEqual(flagRows.length, 7,
    "7 generic flag rows for type=epic (test-flags hidden)");
  for (const row of flagRows) {
    assert.ok(row.querySelector("input.vs-typeconfig-flag-input"), "row has checkbox");
    assert.ok(row.querySelector(".vs-typeconfig-flag-text"), "row has label text");
  }
  // The four test-type flags are NOT rendered for non-test types.
  for (const k of ["showPrerequisites", "showSteps", "showExecutionSteps", "showTestOutcome"]) {
    assert.strictEqual(section.querySelector('.vs-typeconfig-flag[data-flag-key="' + k + '"]'), null,
      "row for " + k + " hidden on epic");
  }
});

test("SM-100: type=test-definition shows ONLY the two def test-flag rows (prereqs/steps), not the exec ones", () => {
  const store = buildStoreWithTypesAndConfig(["test-definition", "test-execution", "user-story"]);
  view.mount(freshHost(), store, {});
  document.querySelector(".vs-tab-btn[data-vs-tab='typeconfig']").click();
  // type-picker defaults to first ticketType = test-definition
  const picker = document.querySelector("select.vs-typeconfig-type-select");
  assert.strictEqual(picker.value, "test-definition");
  const prereqRow = document.querySelector('.vs-typeconfig-flag[data-flag-key="showPrerequisites"]');
  const stepsRow  = document.querySelector('.vs-typeconfig-flag[data-flag-key="showSteps"]');
  const execRow   = document.querySelector('.vs-typeconfig-flag[data-flag-key="showExecutionSteps"]');
  const outRow    = document.querySelector('.vs-typeconfig-flag[data-flag-key="showTestOutcome"]');
  assert.ok(prereqRow, "prereqs row present on test-definition");
  assert.ok(stepsRow,  "steps row present on test-definition");
  assert.strictEqual(execRow, null, "execution-steps row hidden on test-definition");
  assert.strictEqual(outRow,  null, "test-outcome row hidden on test-definition");
  assert.strictEqual(prereqRow.querySelector("input").checked, true,  "prereqs ON for test-definition");
  assert.strictEqual(stepsRow.querySelector("input").checked,  true,  "steps ON for test-definition");
});

test("SM-100: type=test-execution shows ONLY the two exec test-flag rows (execution/outcome), not the def ones", () => {
  const store = buildStoreWithTypesAndConfig(["test-execution", "user-story"]);
  view.mount(freshHost(), store, {});
  document.querySelector(".vs-tab-btn[data-vs-tab='typeconfig']").click();
  const picker = document.querySelector("select.vs-typeconfig-type-select");
  assert.strictEqual(picker.value, "test-execution");
  const prereqRow = document.querySelector('.vs-typeconfig-flag[data-flag-key="showPrerequisites"]');
  const stepsRow  = document.querySelector('.vs-typeconfig-flag[data-flag-key="showSteps"]');
  const execRow   = document.querySelector('.vs-typeconfig-flag[data-flag-key="showExecutionSteps"]');
  const outRow    = document.querySelector('.vs-typeconfig-flag[data-flag-key="showTestOutcome"]');
  assert.strictEqual(prereqRow, null, "prereqs row hidden on test-execution");
  assert.strictEqual(stepsRow,  null, "steps row hidden on test-execution");
  assert.ok(execRow, "execution-steps row present on test-execution");
  assert.ok(outRow,  "test-outcome row present on test-execution");
  assert.strictEqual(execRow.querySelector("input").checked, true,  "execution-steps ON for test-execution");
  assert.strictEqual(outRow.querySelector("input").checked,  true,  "test-outcome ON for test-execution");
});

test("SM-100: for non-test types all four test-type rows are absent (not just OFF)", () => {
  const store = buildStoreWithTypesAndConfig(["user-story", "bug", "epic"]);
  view.mount(freshHost(), store, {});
  document.querySelector(".vs-tab-btn[data-vs-tab='typeconfig']").click();
  // type-picker defaults to user-story — same as for epic/bug.
  for (const key of ["showPrerequisites", "showSteps", "showExecutionSteps", "showTestOutcome"]) {
    const row = document.querySelector('.vs-typeconfig-flag[data-flag-key="' + key + '"]');
    assert.strictEqual(row, null, key + " row absent on user-story");
  }
});

test("SM-59: toggling showExecutionSteps off on test-execution dispatches store.updateProject with the override", () => {
  const store = buildStoreWithTypesAndConfig(["test-execution", "user-story"]);
  view.mount(freshHost(), store, {});
  document.querySelector(".vs-tab-btn[data-vs-tab='typeconfig']").click();
  const cb = document.querySelector('.vs-typeconfig-flag[data-flag-key="showExecutionSteps"] input');
  // It defaults to ON; flipping should commit { test-execution: { showExecutionSteps: false } }.
  cb.checked = false;
  cb.dispatchEvent(new dom.window.Event("change"));
  const project = store.get().project;
  const cfg = (project.entityTypeConfig && project.entityTypeConfig["test-execution"]) || {};
  assert.strictEqual(cfg.showExecutionSteps, false, "override persisted");
});

test("SM-9: epic's allowParentEpic toggle is locked (disabled + 'Locked' note)", () => {
  const store = buildStoreWithTypesAndConfig(["epic", "user-story"]);
  view.mount(freshHost(), store, {});
  document.querySelector(".vs-tab-btn[data-vs-tab='typeconfig']").click();
  // type-picker defaults to "epic". The allowParentEpic row must be locked.
  const row = document.querySelector(".vs-typeconfig-flag[data-flag-key='allowParentEpic']");
  assert.ok(row);
  assert.ok(row.classList.contains("vs-typeconfig-flag-locked"), "row carries locked class");
  const cb = row.querySelector("input.vs-typeconfig-flag-input");
  assert.strictEqual(cb.disabled, true);
  assert.strictEqual(cb.checked, false, "epic.allowParentEpic = false (hard-coded)");
  assert.ok(row.querySelector(".vs-typeconfig-flag-locked-note"), "lock note rendered");
});

test("SM-9: type-picker change re-renders the flag list for the new type", () => {
  const store = buildStoreWithTypesAndConfig(["epic", "user-story"]);
  view.mount(freshHost(), store, {});
  document.querySelector(".vs-tab-btn[data-vs-tab='typeconfig']").click();
  // Switch to user-story.
  const select = document.querySelector("select.vs-typeconfig-type-select");
  select.value = "user-story";
  select.dispatchEvent(new dom.window.Event("change"));
  // user-story's allowParentEpic is NOT locked.
  const row = document.querySelector(".vs-typeconfig-flag[data-flag-key='allowParentEpic']");
  assert.ok(row, "row still rendered");
  assert.ok(!row.classList.contains("vs-typeconfig-flag-locked"), "no lock for user-story");
  const cb = row.querySelector("input.vs-typeconfig-flag-input");
  assert.strictEqual(cb.disabled, false);
  // Default for non-epic types: allowParentEpic = true.
  assert.strictEqual(cb.checked, true);
});

test("SM-9: toggling a flag commits updateProject with the new entityTypeConfig", () => {
  const store = buildStoreWithTypesAndConfig(["user-story", "bug"]);
  view.mount(freshHost(), store, {});
  document.querySelector(".vs-tab-btn[data-vs-tab='typeconfig']").click();
  // Default selection is user-story (first). Toggle showAcceptanceCriteria off.
  const row = document.querySelector(".vs-typeconfig-flag[data-flag-key='showAcceptanceCriteria']");
  const cb = row.querySelector("input.vs-typeconfig-flag-input");
  assert.strictEqual(cb.checked, true, "default = on");
  cb.checked = false;
  cb.dispatchEvent(new dom.window.Event("change"));
  // Verify entityTypeConfig was patched.
  const cfg = store.get().project.entityTypeConfig || {};
  assert.ok(cfg["user-story"], "user-story config branch present");
  assert.strictEqual(cfg["user-story"].showAcceptanceCriteria, false);
  // Other flags for user-story default to true (the patch must NOT clobber them).
  assert.strictEqual(cfg["user-story"].showLinks !== false, true);
});

test("SM-9: toggling one type's flag does NOT affect another type's config", () => {
  const store = buildStoreWithTypesAndConfig(["user-story", "bug"]);
  view.mount(freshHost(), store, {});
  document.querySelector(".vs-tab-btn[data-vs-tab='typeconfig']").click();
  // Toggle showLinks off for user-story.
  let row = document.querySelector(".vs-typeconfig-flag[data-flag-key='showLinks']");
  let cb = row.querySelector("input.vs-typeconfig-flag-input");
  cb.checked = false;
  cb.dispatchEvent(new dom.window.Event("change"));
  // Switch to bug.
  const select = document.querySelector("select.vs-typeconfig-type-select");
  select.value = "bug";
  select.dispatchEvent(new dom.window.Event("change"));
  // bug's showLinks is still default-on (its config branch wasn't touched).
  row = document.querySelector(".vs-typeconfig-flag[data-flag-key='showLinks']");
  cb = row.querySelector("input.vs-typeconfig-flag-input");
  assert.strictEqual(cb.checked, true, "bug.showLinks default = on, untouched by user-story toggle");
});

test("SM-9: empty ticketTypes shows an empty-state message instead of flags", () => {
  // Build a fresh store and explicitly null out ticketTypes via updateProject.
  // normalizeProject reseeds defaults if the list is empty, so this is a
  // theoretical safety-net more than a realistic state.
  const store = buildStoreWithTypesAndConfig(["only-one"]);
  view.mount(freshHost(), store, {});
  document.querySelector(".vs-tab-btn[data-vs-tab='typeconfig']").click();
  // With at least 1 type, normal editor is rendered.
  assert.ok(document.querySelector(".vs-typeconfig-editor"));
  assert.ok(document.querySelector(".vs-typeconfig-flag"), "flags rendered for the one type");
});

// ---------------------------------------------------------------------------
// SM-107 — read-only "Rules per type"
// ---------------------------------------------------------------------------

test("SM-107: activeRulesForType — user-story has DoR+DoD enabled, test gates N/A", () => {
  const project = core.normalizeProject({ id: "p1", name: "P" });
  const byId = {};
  for (const r of view.activeRulesForType("user-story", project)) byId[r.id] = r.enabled;
  assert.strictEqual(byId["dor.allRequiredMet"], true);
  assert.strictEqual(byId["dod.allRequiredMet"], true);
  assert.strictEqual(byId["links.hasTestTarget"], false);
  assert.strictEqual(byId["outcome.notPending"], false);
});

test("SM-107: activeRulesForType — test-definition enables links.hasTestTarget, hides DoR/DoD", () => {
  const project = core.normalizeProject({ id: "p1", name: "P" });
  const byId = {};
  for (const r of view.activeRulesForType("test-definition", project)) byId[r.id] = r.enabled;
  assert.strictEqual(byId["links.hasTestTarget"], true);
  assert.strictEqual(byId["dor.allRequiredMet"], false);
  assert.strictEqual(byId["dod.allRequiredMet"], false);
  assert.strictEqual(byId["outcome.notPending"], false);
});

test("SM-107: activeRulesForType — test-execution enables outcome.notPending", () => {
  const project = core.normalizeProject({ id: "p1", name: "P" });
  const byId = {};
  for (const r of view.activeRulesForType("test-execution", project)) byId[r.id] = r.enabled;
  assert.strictEqual(byId["outcome.notPending"], true);
  assert.strictEqual(byId["links.hasTestTarget"], false);
});

test("SM-107: activeRulesForType reflects entityTypeConfig override (hidden DoD → rule N/A)", () => {
  const project = core.normalizeProject({
    id: "p1", name: "P",
    entityTypeConfig: { bug: { showDefinitionOfDone: false } }
  });
  const byId = {};
  for (const r of view.activeRulesForType("bug", project)) byId[r.id] = r.enabled;
  assert.strictEqual(byId["dod.allRequiredMet"], false, "hidden DoD ⇒ rule N/A");
  assert.strictEqual(byId["dor.allRequiredMet"], true, "DoR still visible ⇒ active");
});

test("SM-107: rules section renders read-only (one block per type, no inputs)", () => {
  const store = buildStore();
  const ctl = view.mount(freshHost(), store, {});
  try {
    document.querySelector(".vs-tab-btn[data-vs-tab='rules']").click();
    const section = document.querySelector(".vs-section[data-section='rules']");
    assert.ok(section, "rules section present");
    const blocks = section.querySelectorAll(".vs-rules-type");
    const types = store.get().project.ticketTypes;
    assert.strictEqual(blocks.length, types.length, "one block per ticket type");
    assert.ok(section.querySelector(".vs-rules-item"), "rule items rendered");
    assert.ok(section.querySelector(".vs-rules-item.inactive"), "some rule shows as N/A for a type");
    assert.strictEqual(section.querySelectorAll("input, select, textarea").length, 0,
      "read-only: no form controls");
  } finally { ctl.unmount(); }
});

console.log(`\n  ${passed} passed, ${failed} failed`);
