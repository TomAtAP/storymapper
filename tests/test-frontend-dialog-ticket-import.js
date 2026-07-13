"use strict";

/**
 * SM-289 — Ticket-import dialog (browser glue over shared/ticket-import.js).
 *
 * applyImportPlan is pure (core.ops on a draft; ONE applySnapshot commit at
 * the surface). The dialog: paste → live preview (create/update/error rows,
 * mode toggle re-plans), Apply writes creates+updates and NEVER error rows.
 */

const assert = require("assert");
const { JSDOM } = require("jsdom");

const dom = new JSDOM(`<!doctype html><html><body><div id="modal-host"></div></body></html>`,
  { url: "http://localhost/" });
global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;

const core = require("../frontend/js/core.js");
const { ProjectStore } = require("../frontend/js/store.js");
const uiShell = require("../frontend/js/ui-shell.js");
const imp = require("../frontend/js/ticket-import.js");
const dlg = require("../frontend/js/dialog-ticket-import.js");

let passed = 0, failed = 0;
// async-aware chain (test-e2e pattern): the modal action handler awaits
// onClick before closing, so close-assertions need a microtask flush.
function test(name, fn) {
  const exec = async () => {
    try { await fn(); console.log(`  ok  - ${name}`); passed++; }
    catch (err) { console.log(`  FAIL - ${name}\n         ${err.stack || err.message}`); failed++; process.exitCode = 1; }
  };
  return (test._chain = (test._chain || Promise.resolve()).then(exec));
}

const HUMAN = { type: "human", id: "u1", name: "U" };

function board() {
  const store = new ProjectStore(core.normalizeSnapshot({
    project: { id: "p1", name: "P", ticketPrefix: "P", ticketTypes: ["epic", "user-story", "bug", "task"] },
    releases: [{ id: "R1", name: "v1", sortOrder: 0 }],
    processSteps: [{ id: "PSA", name: "Discover", sortOrder: 0 }]
  }));
  store.createTicket({ type: "epic", title: "Epic One" }, HUMAN);   // release-less: no auto-assign
  const epic = store.get().tickets[store.get().tickets.length - 1];
  store.createTicket({ type: "user-story", title: "Story One", position: { releaseId: "R1", processStepId: "PSA" } }, HUMAN);
  const story = store.get().tickets[store.get().tickets.length - 1];
  return { store, epic, story };
}

// ---- applyImportPlan (pure) ---------------------------------------------------

test("SM-289: applyImportPlan — creates land incl. contains-link for epicId; updates patch; counts", () => {
  const { store, epic, story } = board();
  const snap = store.get();
  const plan = imp.planTicketImport(snap, imp.parseTicketImport(
    "key,type,title,epic,status\n" +
    ",bug,Imported Bug," + epic.ticketKey + ",backlog\n" +
    story.ticketKey + ",,Renamed by Import,,", "csv").rows, "upsert");
  assert.deepStrictEqual(plan.errors, []);
  const r = dlg.applyImportPlan(snap, plan, HUMAN);
  assert.strictEqual(r.created, 1);
  assert.strictEqual(r.updated, 1);
  const created = r.snapshot.tickets.find(t => t.title === "Imported Bug");
  assert.ok(created, "bug created");
  const epicAfter = r.snapshot.tickets.find(t => t.id === epic.id);
  assert.ok((epicAfter.links || []).some(l => l.linkTypeId === "contains" && l.targetTicketId === created.id),
    "contains-link created for the epic column");
  assert.strictEqual(r.snapshot.tickets.find(t => t.id === story.id).title, "Renamed by Import");
  assert.notStrictEqual(r.snapshot, snap, "input snapshot untouched (new object)");
  assert.strictEqual(snap.tickets.find(t => t.id === story.id).title, "Story One", "original unmutated");
});

test("SM-289 (review): CSV epic differing from the cell's epic → SINGLE parent (the specified one)", () => {
  // Board with an epic OWNING the cell R1/PSA plus a second, backlog epic.
  const store = new ProjectStore(core.normalizeSnapshot({
    project: { id: "p1", name: "P", ticketPrefix: "P", ticketTypes: ["epic", "user-story", "bug", "task"] },
    releases: [{ id: "R1", name: "v1", sortOrder: 0 }],
    processSteps: [{ id: "PSA", name: "Discover", sortOrder: 0 }]
  }));
  store.createTicket({ type: "epic", title: "Cell Epic", position: { releaseId: "R1", processStepId: "PSA" } }, HUMAN);
  const cellEpic = store.get().tickets[store.get().tickets.length - 1];
  store.createTicket({ type: "epic", title: "Backlog Epic" }, HUMAN);
  const backlogEpic = store.get().tickets[store.get().tickets.length - 1];
  const snap = store.get();
  // Row places the ticket in the cell OWNED by Cell Epic but names Backlog Epic.
  const plan = imp.planTicketImport(snap, imp.parseTicketImport(
    "type,title,release,processStep,epic\nbug,Contested," + "v1,Discover," + backlogEpic.ticketKey, "csv").rows, "create-only");
  assert.deepStrictEqual(plan.errors, []);
  const r = dlg.applyImportPlan(snap, plan, HUMAN);
  const created = r.snapshot.tickets.find(t => t.title === "Contested");
  const parents = r.snapshot.tickets.filter(t =>
    (t.links || []).some(l => l.linkTypeId === "contains" && l.targetTicketId === created.id));
  assert.strictEqual(parents.length, 1, "exactly ONE parent (no double containment)");
  assert.strictEqual(parents[0].id, backlogEpic.id, "the CSV's epic wins over the cell auto-assign");
});

test("SM-289: applyImportPlan — empty (diffed-out) patches are skipped, not written", () => {
  const { store, story } = board();
  const snap = store.get();
  const plan = { creates: [], updates: [{ line: 2, ticketId: story.id, ticketKey: story.ticketKey, patch: {} }], errors: [] };
  const r = dlg.applyImportPlan(snap, plan, HUMAN);
  assert.strictEqual(r.updated, 0, "no-op update not counted");
  assert.strictEqual(r.snapshot, snap, "nothing changed → same snapshot reference");
});

// ---- SM-295: unified import — kind detection + project branch -------------------

test("SM-295: detectImportKind — envelope/snapshot → project; CSV/array → tickets", () => {
  assert.strictEqual(dlg.detectImportKind('{"format":"storymap-project","snapshot":{"project":{"id":"x"}}}'), "project");
  assert.strictEqual(dlg.detectImportKind('{"project":{"id":"x"},"tickets":[]}'), "project", "bare snapshot");
  assert.strictEqual(dlg.detectImportKind('[{"title":"A"}]'), "tickets", "JSON array = ticket rows");
  assert.strictEqual(dlg.detectImportKind("key,title\nP-1,X"), "tickets", "CSV = ticket rows");
  assert.strictEqual(dlg.detectImportKind('{"weird":true}'), "project", "unknown object → project branch reports the error");
});

function openUnified(store, opts) {
  const flashes = [], imports = [];
  dlg.openImportDialog(Object.assign({
    store: store,
    showModal: uiShell.showModal,
    flashStatus: (msg, o) => flashes.push({ msg, o }),
    actor: HUMAN,
    listProjects: () => Promise.resolve((opts && opts.existing) || []),
    onImportProject: (snap, targetId, overwrite) => { imports.push({ snap, targetId, overwrite }); return Promise.resolve(); }
  }, opts || {}));
  const modal = document.querySelector("#modal-host .modal");
  return { modal, root: modal.querySelector(".ti-root"), flashes, imports };
}

function envelope(id, name) {
  return JSON.stringify({
    format: "storymap-project", version: 1,
    snapshot: core.normalizeSnapshot({
      project: { id: id, name: name || id, ticketPrefix: "X" },
      releases: [{ id: "R1", name: "v1", sortOrder: 0 }],
      processSteps: [], tickets: []
    })
  });
}

test("SM-295: pasting a project envelope shows the project preview; Apply calls onImportProject (new id)", async () => {
  const { store } = board();
  const { modal, root, imports } = openUnified(store);
  await Promise.resolve();   // let listProjects resolve
  paste(root, envelope("fresh-proj", "Fresh"));
  const prev = root.querySelector(".ti-project-preview");
  assert.ok(prev, "project preview rendered");
  assert.ok(/Fresh/.test(prev.textContent) && /fresh-proj/.test(prev.textContent), "name + id shown");
  assert.ok(/1 Releases/.test(prev.textContent), "counts shown");
  assert.ok(!root.querySelector('input[name="ti-project-mode"]'), "no conflict → no mode radios");
  assert.strictEqual(root.querySelector(".ti-mode").style.display, "none", "ticket mode row hidden in project branch");
  modal.querySelector('[data-act="1"]').dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));
  assert.strictEqual(imports.length, 1);
  assert.strictEqual(imports[0].targetId, "fresh-proj");
  assert.strictEqual(imports[0].overwrite, false);
  assert.ok(!document.querySelector("#modal-host .modal"), "modal closed");
});

test("SM-295: id conflict offers copy (default) vs overwrite; choices reach onImportProject", async () => {
  const { store } = board();
  // copy path
  let d = openUnified(store, { existing: ["dup-proj"] });
  await Promise.resolve();
  paste(d.root, envelope("dup-proj"));
  assert.ok(/existiert bereits/.test(d.root.querySelector(".ti-project-conflict").textContent));
  const radios = d.root.querySelectorAll('input[name="ti-project-mode"]');
  assert.strictEqual(radios.length, 2, "copy + overwrite radios");
  d.modal.querySelector('[data-act="1"]').dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));
  assert.strictEqual(d.imports.length, 1);
  assert.notStrictEqual(d.imports[0].targetId, "dup-proj", "copy gets a NEW id");
  assert.strictEqual(d.imports[0].overwrite, false);
  // overwrite path
  d = openUnified(store, { existing: ["dup-proj"] });
  await Promise.resolve();
  paste(d.root, envelope("dup-proj"));
  const ow = d.root.querySelector('input[name="ti-project-mode"][value="overwrite"]');
  ow.checked = true;
  ow.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  d.modal.querySelector('[data-act="1"]').dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));
  assert.strictEqual(d.imports[0].targetId, "dup-proj");
  assert.strictEqual(d.imports[0].overwrite, true);
});

test("SM-295: ticket import without a loaded project shows a clear message; project import still works", async () => {
  const d = openUnified(null);
  await Promise.resolve();
  paste(d.root, "key,title\n,X");
  assert.ok(/geladenes Projekt/.test(d.root.querySelector(".ti-parse-error").textContent));
  assert.strictEqual(d.modal.querySelector('[data-act="1"]').disabled, true);
  paste(d.root, envelope("standalone"));
  assert.ok(d.root.querySelector(".ti-project-preview"), "project branch works without a store");
  assert.strictEqual(d.modal.querySelector('[data-act="1"]').disabled, false);
  document.getElementById("modal-host").innerHTML = "";
});

test("SM-295 (review): Apply stays disabled until the project list resolved (no blind overwrite)", async () => {
  const { store } = board();
  let resolveList;
  const d = openUnified(store, { listProjects: () => new Promise((res) => { resolveList = res; }) });
  paste(d.root, envelope("race-proj"));
  assert.ok(/Prüfe bestehende Projekte/.test(d.root.querySelector(".ti-project-preview").textContent),
    "pending list → checking hint");
  assert.strictEqual(d.modal.querySelector('[data-act="1"]').disabled, true, "Apply blocked while pending");
  resolveList(["race-proj"]);
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(/existiert bereits/.test(d.root.querySelector(".ti-project-conflict").textContent),
    "late-arriving conflict is detected before Apply is possible");
  assert.strictEqual(d.modal.querySelector('[data-act="1"]').disabled, false);
  document.getElementById("modal-host").innerHTML = "";
});

test("SM-295 (review): failed onImportProject keeps the modal (and the paste) open", async () => {
  const { store } = board();
  const d = openUnified(store, {
    onImportProject: () => Promise.reject(new Error("server down"))
  });
  await Promise.resolve();
  paste(d.root, envelope("failing-proj"));
  d.modal.querySelector('[data-act="1"]').dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(document.querySelector("#modal-host .modal"), "modal stays open on failure");
  assert.ok(d.flashes.some(f => /server down/.test(f.msg)), "error surfaced");
  assert.strictEqual(document.querySelector(".ti-text").value.length > 0, true, "pasted text preserved");
  document.getElementById("modal-host").innerHTML = "";
});

test("SM-296: foreign CSV headers render the mapping panel; a select change re-plans live + persists", async () => {
  window.localStorage.clear();
  const { store } = board();
  const d = openUnified(store);
  await Promise.resolve();
  // 'Summary' auto-maps (heuristic), 'Custom Col' stays unmapped
  paste(d.root, "Summary,Issue Type,Custom Col\nVom Jira,bug,Egal");
  const panel = d.root.querySelector(".ti-mapping");
  assert.ok(panel, "mapping panel rendered for CSV");
  const selects = panel.querySelectorAll(".ti-mapping-select");
  assert.strictEqual(selects.length, 3, "one select per column");
  assert.strictEqual(selects[0].value, "title", "Summary prefilled via heuristic");
  assert.strictEqual(selects[2].value, "", "unknown column prefilled as ignore");
  assert.ok(/Ignorierte Spalten: Custom Col/.test(d.root.querySelector(".ti-unused").textContent),
    "unused column announced");
  let summary = d.root.querySelector(".ti-summary").textContent;
  assert.ok(/1 neu/.test(summary), "heuristic alone yields the create");
  // map Custom Col → description → replan
  selects[2].value = "description";
  selects[2].dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  assert.ok(!d.root.querySelector(".ti-unused"), "no unused columns after mapping");
  // persisted per project
  const stored = JSON.parse(window.localStorage.getItem(
    dlg.IMPORT_DIALOG.MAPPING_STORAGE_PREFIX + "p1"));
  assert.strictEqual(stored.headers["custom col"], "description", "SM-297 shape: {headers, values}");
  document.getElementById("modal-host").innerHTML = "";
});

test("SM-296: a persisted mapping is applied on the next dialog open", async () => {
  window.localStorage.clear();
  window.localStorage.setItem(dlg.IMPORT_DIALOG.MAPPING_STORAGE_PREFIX + "p1",
    JSON.stringify({ "custom col": "title" }));
  const { store } = board();
  const d = openUnified(store);
  await Promise.resolve();
  paste(d.root, "Custom Col,type\nAus Persistenz,bug");
  const summary = d.root.querySelector(".ti-summary").textContent;
  assert.ok(/1 neu/.test(summary) && /0 Fehler/.test(summary), summary);
  const sel = d.root.querySelector(".ti-mapping-select");
  assert.strictEqual(sel.value, "title", "persisted mapping prefilled");
  document.getElementById("modal-host").innerHTML = "";
  window.localStorage.clear();
});

test("SM-297: unknown values render the value panel; mapping one re-plans live + persists", async () => {
  window.localStorage.clear();
  const { store } = board();
  const d = openUnified(store);
  await Promise.resolve();
  paste(d.root, "title,type,status\nJira Row,Technische Story,IN TESTING");
  let summary = d.root.querySelector(".ti-summary").textContent;
  assert.ok(/2 Fehler/.test(summary), "unmapped type + status error first: " + summary);
  const valueRows = d.root.querySelectorAll(".ti-mapping-value-row");
  assert.strictEqual(valueRows.length, 2, "one nested row per unknown value (type + status)");
  // SM-298: value rows sit DIRECTLY beneath their column's header row
  const allRows = Array.from(d.root.querySelectorAll(".ti-mapping .ti-mapping-row"));
  const typeHeaderIdx = allRows.findIndex(r => r.classList.contains("ti-mapping-header-row") && /^type$/.test(r.querySelector(".ti-mapping-raw").textContent));
  assert.ok(allRows[typeHeaderIdx + 1].classList.contains("ti-mapping-value-row")
    && /Technische Story/.test(allRows[typeHeaderIdx + 1].textContent),
    "unknown type value nested under the type column row");
  // map the type → user-story
  const typeRow = Array.from(valueRows).find(r => /Technische Story/.test(r.textContent));
  const typeSel = typeRow.querySelector("select");
  assert.ok(Array.from(typeSel.options).some(o => o.value === "user-story"), "project types offered");
  typeSel.value = "user-story";
  typeSel.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  // map the status → review (re-query: panel was rebuilt)
  const statusRow = Array.from(d.root.querySelectorAll(".ti-mapping-value-row"))
    .find(r => /IN TESTING/.test(r.textContent));
  const statusSel = statusRow.querySelector("select");
  statusSel.value = "review";
  statusSel.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  summary = d.root.querySelector(".ti-summary").textContent;
  assert.ok(/1 neu/.test(summary) && /0 Fehler/.test(summary), "fully mapped: " + summary);
  assert.ok(!d.root.querySelector(".ti-mapping-value-row"), "no unknown values left → nested rows gone");
  const stored = JSON.parse(window.localStorage.getItem(dlg.IMPORT_DIALOG.MAPPING_STORAGE_PREFIX + "p1"));
  assert.strictEqual(stored.values.type["technische story"], "user-story");
  assert.strictEqual(stored.values.status["in testing"], "review");
  document.getElementById("modal-host").innerHTML = "";
  window.localStorage.clear();
});

test("SM-297 (user finding): errors are LINE-oriented — row content + all problems in one entry", async () => {
  window.localStorage.clear();
  const { store } = board();
  const d = openUnified(store);
  await Promise.resolve();
  paste(d.root, "title,type,status\nMeine Jira-Story,Epos,Warp");
  const errRows = d.root.querySelectorAll(".ti-preview tbody tr.ti-row-error");
  assert.strictEqual(errRows.length, 1, "ONE preview row per CSV line, not per error");
  const cells = errRows[0].querySelectorAll("td");
  assert.strictEqual(cells[2].textContent, "Meine Jira-Story", "row labelled with ITS OWN title");
  assert.ok(/type: unknown ticket type: Epos/.test(cells[3].textContent), "offending type value visible");
  assert.ok(/status: unknown status: Warp/.test(cells[3].textContent), "offending status value visible");
  document.getElementById("modal-host").innerHTML = "";
});

test("SM-298 gate: resizable import modal + ONE scroll region (no nested mini-scrollers)", () => {
  const fs = require("fs");
  const path = require("path");
  const css = fs.readFileSync(path.join(__dirname, "../frontend/css/storymap.css"), "utf8");
  const idx = css.indexOf("#modal-host .modal:has(.ti-root) {");
  const rule = css.slice(idx, css.indexOf("}", idx));
  assert.ok(/resize: both/.test(rule), "modal is resizable");
  assert.ok(/max-height: 92vh/.test(rule) && /min-height: 420px/.test(rule), "sane bounds");
  assert.ok(css.includes(".ti-scroll {"), "unified scroll container exists");
  const mapIdx = css.indexOf(".ti-mapping {");
  const mapRule = css.slice(mapIdx, css.indexOf("}", mapIdx));
  assert.ok(!/max-height/.test(mapRule), "mapping table has no own mini-scroller anymore");
});

test("SM-298: the scroll container wraps mapping + errors + preview", async () => {
  const { store } = board();
  const d = openUnified(store);
  await Promise.resolve();
  const scroll = d.root.querySelector(".ti-scroll");
  assert.ok(scroll, "scroll region present");
  assert.ok(scroll.querySelector(".ti-mapping-host") && scroll.querySelector(".ti-parse-error")
    && scroll.querySelector(".ti-preview-host"), "mapping, errors and preview live inside it");
  document.getElementById("modal-host").innerHTML = "";
});

test("SM-298 (review): JSON imports without headers still get the value-mapping rows", async () => {
  window.localStorage.clear();
  const { store } = board();
  const d = openUnified(store);
  await Promise.resolve();
  paste(d.root, JSON.stringify([{ title: "Aus JSON", type: "Technische Story", status: "IN TESTING" }]));
  const valueRows = d.root.querySelectorAll(".ti-mapping-value-row");
  assert.strictEqual(valueRows.length, 2, "unknown type + status rows render despite headers: []");
  assert.strictEqual(d.root.querySelectorAll(".ti-mapping-header-row").length, 0, "no header rows for JSON");
  // mapping works end-to-end on the JSON branch too
  const typeRow = Array.from(valueRows).find(r => /Technische Story/.test(r.textContent));
  const sel = typeRow.querySelector("select");
  sel.value = "user-story";
  sel.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  const statusRow = Array.from(d.root.querySelectorAll(".ti-mapping-value-row"))
    .find(r => /IN TESTING/.test(r.textContent));
  const ssel = statusRow.querySelector("select");
  ssel.value = "review";
  ssel.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  const summary = d.root.querySelector(".ti-summary").textContent;
  assert.ok(/1 neu/.test(summary) && /0 Fehler/.test(summary), summary);
  document.getElementById("modal-host").innerHTML = "";
  window.localStorage.clear();
});

test("SM-295: export chooser — two targets route to their callbacks", async () => {
  const calls = [];
  dlg.openExportDialog({
    showModal: uiShell.showModal,
    onExportProject: () => calls.push("project"),
    onExportTickets: () => calls.push("tickets"),
  });
  let modal = document.querySelector("#modal-host .modal");
  assert.ok(modal.querySelector(".ti-export-info"), "explainer rendered");
  modal.querySelector('[data-act="1"]').dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));
  assert.deepStrictEqual(calls, ["project"]);
  assert.ok(!document.querySelector("#modal-host .modal"), "chooser closes after export");
  dlg.openExportDialog({
    showModal: uiShell.showModal,
    onExportProject: () => calls.push("project"),
    onExportTickets: () => calls.push("tickets"),
  });
  modal = document.querySelector("#modal-host .modal");
  modal.querySelector('[data-act="2"]').dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));
  assert.deepStrictEqual(calls, ["project", "tickets"]);
});

// ---- dialog DOM ----------------------------------------------------------------

function openDialog(store) {
  const flashes = [];
  dlg.openTicketImportDialog({
    store: store,
    showModal: uiShell.showModal,
    flashStatus: (msg, o) => flashes.push({ msg, o }),
    actor: HUMAN
  });
  const modal = document.querySelector("#modal-host .modal");
  const root = modal.querySelector(".ti-root");
  return { modal, root, flashes };
}

function paste(root, text) {
  const ta = root.querySelector(".ti-text");
  ta.value = text;
  ta.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
}

test("SM-289: dialog opens with source step; Apply disabled until a plan has writable rows", () => {
  const { store } = board();
  const { modal, root } = openDialog(store);
  assert.ok(root.querySelector(".ti-text") && root.querySelector(".ti-file"), "paste + file inputs");
  const applyBtn = modal.querySelector('[data-act="1"]');
  assert.strictEqual(applyBtn.disabled, true, "Apply disabled without input");
  document.getElementById("modal-host").innerHTML = "";
});

test("SM-289: pasting CSV renders the preview with summary + rows; mode toggle re-plans", () => {
  const { store, story } = board();
  const { modal, root } = openDialog(store);
  paste(root, "key,type,title\n,bug,Fresh Bug\n" + story.ticketKey + ",,Renamed");
  let summary = root.querySelector(".ti-summary").textContent;
  assert.ok(/1 neu/.test(summary) && /1 aktualisiert/.test(summary) && /0 Fehler/.test(summary), summary);
  assert.ok(root.querySelector(".ti-preview tbody tr.ti-row-create"), "create row rendered");
  assert.strictEqual(modal.querySelector('[data-act="1"]').disabled, false, "Apply enabled");
  // switch to create-only → the existing key becomes an error
  const rb = root.querySelector('input[name="ti-mode"][value="create-only"]');
  rb.checked = true;
  rb.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  summary = root.querySelector(".ti-summary").textContent;
  assert.ok(/1 neu/.test(summary) && /0 aktualisiert/.test(summary) && /1 Fehler/.test(summary), summary);
  assert.ok(root.querySelector(".ti-preview tbody tr.ti-row-error"), "error row rendered");
  document.getElementById("modal-host").innerHTML = "";
});

test("SM-289: a parse error shows and never reaches the preview", () => {
  const { store } = board();
  const { modal, root } = openDialog(store);
  paste(root, 'title\n"broken');
  assert.ok(/unterminated/i.test(root.querySelector(".ti-parse-error").textContent));
  assert.ok(!root.querySelector(".ti-preview"), "no preview on parse error");
  assert.strictEqual(modal.querySelector('[data-act="1"]').disabled, true);
  document.getElementById("modal-host").innerHTML = "";
});

test("SM-289: Apply writes creates+updates as ONE undo step; error rows are never written; modal closes", async () => {
  const { store, story } = board();
  const before = store.get().tickets.length;
  const canUndoBefore = store.canUndo();
  const { modal, root, flashes } = openDialog(store);
  paste(root,
    "key,type,title,release\n" +
    ",bug,Good Import,v1\n" +
    story.ticketKey + ",,Import Rename,\n" +
    ",bug,Bad Row,v99");   // error row
  const summary = root.querySelector(".ti-summary").textContent;
  assert.ok(/1 Fehler/.test(summary), "error row visible in the preview");
  modal.querySelector('[data-act="1"]').dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));   // let the async action handler close the modal
  const snap = store.get();
  assert.strictEqual(snap.tickets.length, before + 1, "exactly the good create landed");
  assert.ok(snap.tickets.some(t => t.title === "Good Import"));
  assert.ok(!snap.tickets.some(t => t.title === "Bad Row"), "error row NOT written");
  assert.strictEqual(snap.tickets.find(t => t.id === story.id).title, "Import Rename");
  assert.ok(flashes.length === 1 && /1 neu, 1 aktualisiert/.test(flashes[0].msg), "success flash");
  // ONE undo step reverts the whole import
  store.undo();
  const reverted = store.get();
  assert.strictEqual(reverted.tickets.length, before, "undo removes the created ticket");
  assert.strictEqual(reverted.tickets.find(t => t.id === story.id).title, "Story One", "undo reverts the update too");
  assert.strictEqual(store.canUndo(), canUndoBefore, "exactly one undo entry was added");
  assert.ok(!document.querySelector("#modal-host .modal"), "modal closed after apply");
});

module.exports.done = (test._chain || Promise.resolve()).then(() => {
  console.log(`\n  ${passed} passed, ${failed} failed`);
});
