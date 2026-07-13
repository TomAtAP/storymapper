"use strict";

/**
 * SM-116 (Epic B / B1) — Tests für `frontend/js/ticket-form.js`.
 *
 * Die Builder + State-Helfer wurden aus renderer-ticket-modal.js in dieses
 * geteilte Modul gezogen, damit der Vollseiten-Editor (B2+) sie ebenso nutzt.
 * Dieser Test prüft, dass das Modul STANDALONE (ohne das Modal) require-bar
 * ist, die Builder ohne Modal-Annahmen DOM erzeugen, und dass der dünne Host
 * (renderer-ticket-modal.js) dieselben Funktionsidentitäten weiterreicht
 * (kein Doppel-Code-Drift).
 */

const assert = require("assert");
const { JSDOM } = require("jsdom");

const dom = new JSDOM(`<!doctype html><html><body></body></html>`);
global.window      = dom.window;
global.document    = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;

const core      = require("../frontend/js/core.js");
const ticketForm = require("../frontend/js/ticket-form.js");
const modalMod   = require("../frontend/js/renderer-ticket-modal.js");

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  - ${name}`); passed++; }
  catch (err) { console.log(`  FAIL - ${name}\n         ${err.stack || err.message}`); failed++; process.exitCode = 1; }
}

// ---------------------------------------------------------------------------

test("ticket-form is require-able standalone and exports the shared builders + state helpers", () => {
  const expected = [
    "el", "buildRow", "buildErrorBanner", "cssEscape", "autoGrowTextarea",
    "buildTitleField", "buildTypeField", "buildStatusField", "buildPositionFields",
    "buildDescriptionField", "buildLabelsField",
    "buildAcceptanceCriteriaSection", "buildChecklistSection",
    "buildPrerequisitesSection", "buildStepsSection",
    "buildExecutionStepsSection", "buildOutcomeSection",
    "buildTestExecutionHeader", "buildExecutionMetadata",
    "buildLinksSection", "renderLinksSectionInto", "findBackwardLinks", "lookupLinkType",
    "buildDraftTicket", "collectFormState", "buildUpdatePatch",
    "diffSyncFieldKeys", "pulseChangedFields", "syncFieldFromTicket",
    "prereqsEqual", "testStepsEqual", "checklistsEqual", "CONSTANTS", "LOCAL_ACTOR"
  ];
  for (const k of expected) {
    assert.ok(ticketForm[k] !== undefined, "missing export: " + k);
  }
});

test("buildTitleField builds a labelled input with the title value — no modal needed", () => {
  const row = ticketForm.buildTitleField({ title: "Hello" });
  const input = row.querySelector("input");
  assert.ok(input, "input rendered");
  assert.strictEqual(input.value, "Hello");
  assert.strictEqual(input.getAttribute(ticketForm.CONSTANTS.LIVE_SYNC_ATTR), "title");
});

test("SM-158: buildTitleField({multiline}) renders a wrapping textarea; default stays a single-line input", () => {
  const row = ticketForm.buildTitleField({ title: "a very long title that should wrap" }, { multiline: true });
  const ta = row.querySelector('[data-sm-sync-key="title"]');
  assert.strictEqual(ta.tagName, "TEXTAREA", "multiline title is a textarea (wraps)");
  assert.strictEqual(ta.value, "a very long title that should wrap");
  const row2 = ticketForm.buildTitleField({ title: "x" });
  assert.strictEqual(row2.querySelector('[data-sm-sync-key="title"]').tagName, "INPUT", "default title is an input");
});

test("SM-119: buildDescriptionField is a plain-text contentEditable block (grows, no textarea) and round-trips text", () => {
  const row = ticketForm.buildDescriptionField({ description: "line1\nline2" });
  const ed = row.querySelector('[data-sm-sync-key="description"]');
  assert.ok(ed, "description control present");
  assert.strictEqual(ed.tagName, "DIV", "is a DIV, not a TEXTAREA");
  assert.strictEqual(ed.getAttribute("contenteditable"), "true");
  assert.strictEqual(ed.getAttribute("data-placeholder"), "Description…", "has a placeholder");
  // Multi-line content round-trips via textContent (the jsdom read path).
  assert.strictEqual(ed.textContent, "line1\nline2");
});

test("SM-157: description inline ✓/✗ appears on edit; ✓ commits the new text and hides", () => {
  let committed = null;
  const row = ticketForm.buildDescriptionField({ description: "orig" }, { onCommit: (t) => { committed = t; } });
  const ed = row.querySelector('[data-sm-sync-key="description"]');
  const actions = row.querySelector(".tm-desc-actions");
  assert.ok(actions, "actions present when onCommit is wired");
  assert.strictEqual(actions.style.display, "none", "hidden initially (not dirty)");
  ed.textContent = "changed";
  ed.dispatchEvent(new window.Event("input", { bubbles: true }));
  assert.notStrictEqual(actions.style.display, "none", "actions show once the text differs");
  row.querySelector(".tm-desc-save").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  assert.strictEqual(committed, "changed", "✓ commits the new text");
  assert.strictEqual(actions.style.display, "none", "actions hide after commit");
});

test("SM-157: ✗ reverts the description to the last saved value and does not commit", () => {
  let committed = null;
  const row = ticketForm.buildDescriptionField({ description: "orig" }, { onCommit: (t) => { committed = t; } });
  const ed = row.querySelector('[data-sm-sync-key="description"]');
  ed.textContent = "changed";
  ed.dispatchEvent(new window.Event("input", { bubbles: true }));
  row.querySelector(".tm-desc-cancel").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  assert.strictEqual(ed.textContent, "orig", "reverted to the saved value");
  assert.strictEqual(committed, null, "✗ must not commit");
});

test("SM-157: without onCommit there is no inline confirm (plain draft field, e.g. create-mode)", () => {
  const row = ticketForm.buildDescriptionField({ description: "x" });
  assert.strictEqual(row.querySelector(".tm-desc-actions"), null);
});

test("SM-119: collectFormState reads the description from the contentEditable block", () => {
  const host = document.createElement("div");
  host.appendChild(ticketForm.buildTitleField({ title: "T" }));
  host.appendChild(ticketForm.buildDescriptionField({ description: "" }));
  host.appendChild(ticketForm.buildLabelsField({ labels: [] }));
  const descEl = host.querySelector('[data-sm-sync-key="description"]');
  descEl.textContent = "typed body\nsecond line";
  const state = ticketForm.collectFormState(host);
  assert.strictEqual(state.description, "typed body\nsecond line");
});

test("buildDraftTicket returns a backlog-status draft with the given type + position", () => {
  const d = ticketForm.buildDraftTicket("bug", { releaseId: "r1", processStepId: "ps1" });
  assert.strictEqual(d.id, null);
  assert.strictEqual(d.type, "bug");
  assert.strictEqual(d.status, "backlog");
  assert.strictEqual(d.position.releaseId, "r1");
  assert.strictEqual(d.position.processStepId, "ps1");
});

test("buildUpdatePatch (pure) only includes fields that actually changed", () => {
  const original = core.normalizeTicket({
    id: "t1", type: "user-story", title: "A", description: "d",
    position: { releaseId: null, processStepId: null, epicId: null, sortOrder: 0 }
  });
  const form = ticketForm.collectFormState; // sanity: it is a function
  assert.strictEqual(typeof form, "function");
  const patch = ticketForm.buildUpdatePatch(
    { title: "A2", type: "user-story", description: "d", position: {}, labels: [] },
    original
  );
  assert.strictEqual(patch.title, "A2");
  assert.ok(!("type" in patch), "unchanged type omitted");
  assert.ok(!("description" in patch), "unchanged description omitted");
});

test("findBackwardLinks (pure) reports incoming edges and ignores self-links", () => {
  const snap = {
    tickets: [
      { id: "a", links: [{ id: "l1", linkTypeId: "blocks", targetTicketId: "b" }] },
      { id: "b", links: [] }
    ]
  };
  const back = ticketForm.findBackwardLinks(snap, "b");
  assert.strictEqual(back.length, 1);
  assert.strictEqual(back[0].sourceTicket.id, "a");
  assert.deepStrictEqual(ticketForm.findBackwardLinks(snap, "a"), []);
});

test("the thin modal host forwards the SAME builder identities (no drift / no copy)", () => {
  // Every builder the modal exposes via _internals must be the exact function
  // object from ticket-form — proof the host imports rather than re-declares.
  for (const k of ["buildTitleField", "collectFormState", "buildUpdatePatch",
                   "syncFieldFromTicket", "diffSyncFieldKeys", "buildLinksSection",
                   "buildStepsSection", "resolveTestDefinition"]) {
    assert.strictEqual(modalMod._internals[k], ticketForm[k],
      "modal._internals." + k + " is not the shared ticket-form function");
  }
  // createOnSave stays host-only — it is NOT a ticket-form export.
  assert.strictEqual(typeof modalMod._internals.createOnSave, "function");
  assert.strictEqual(ticketForm.createOnSave, undefined);
});

console.log(`\n  ${passed} passed, ${failed} failed`);
module.exports = { passed, failed };
