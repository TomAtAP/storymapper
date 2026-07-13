"use strict";

// SM-203 R-7: view-requirements.js — DOORS-style multi-column module view.
// Pure model builder tested directly; mount + interactions smoke-tested in jsdom.

const assert = require("assert");
const { JSDOM } = require("jsdom");

const dom = new JSDOM(`<!doctype html><html><body><div id="host"></div></body></html>`);
global.window      = dom.window;
global.document    = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;

const core = require("../frontend/js/core.js");
const { ProjectStore } = require("../frontend/js/store.js");
const view = require("../frontend/js/view-requirements.js");

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  - ${name}`); passed++; }
  catch (err) { console.log(`  FAIL - ${name}\n         ${err.stack || err.message}`); failed++; process.exitCode = 1; }
}
function freshHost() { document.getElementById("host").innerHTML = ""; return document.getElementById("host"); }
function cellsByText(sel, needle) {
  return Array.from(document.querySelectorAll(sel)).find(e => e.textContent.indexOf(needle) >= 0);
}

function buildSpecStore() {
  const snap = core.normalizeSnapshot({
    project: { id: "p1", name: "P", ticketPrefix: "P" },
    tickets: [
      { id: "m1", type: "spec-module", title: "PRD", sourceAttachmentId: "att-1", links: [
        { linkTypeId: "contains", targetTicketId: "r1" },
        { linkTypeId: "contains", targetTicketId: "r2" }
      ] },
      { id: "r1", type: "requirement", title: "Login req", sectionPath: "1" },
      { id: "r2", type: "requirement", title: "Profile req", sectionPath: "2" },
      { id: "s1", type: "user-story", title: "Build login", links: [{ linkTypeId: "realises", targetTicketId: "r1" }] }
    ]
  });
  return new ProjectStore(snap);
}

const SECTIONS = [
  { sectionPath: "1", level: 1, heading: "Login", body: "the login prose" },
  { sectionPath: "2", level: 1, heading: "Profile", body: "the profile prose" },
  { sectionPath: "3", level: 1, heading: "Extra", body: "unsliced prose" }   // no requirement → gap
];

test("SM-203 R-7: buildDocumentModel (doc mode) groups requirements under their source section", () => {
  const model = view.buildDocumentModel(buildSpecStore().get(), "m1", SECTIONS);
  assert.strictEqual(model.mode, "doc");
  assert.deepStrictEqual(model.sections.map(s => [s.sectionPath, s.requirements.length, s.gap]),
    [["1", 1, false], ["2", 1, false], ["3", 0, true]]);
  assert.strictEqual(model.sections[0].requirements[0].status, "covered");
  assert.strictEqual(model.sections[1].requirements[0].status, "orphan");
  assert.deepStrictEqual(model.slicing, { sections: 3, sliced: 2, gaps: 1 });
});

test("SM-207: one coarse slice → n requirements all render under that section (sectionPath grouping)", () => {
  // Two requirements distilled from ONE coarse slice (sectionPath "1"); each is
  // anchored to a distinct source char-span. The agent set sourceAnchor.sectionId
  // to an internal slice id that differs from the sectionPath — grouping must NOT
  // rely on it, or both requirements vanish from the doc view.
  const snap = core.normalizeSnapshot({
    project: { id: "p1", name: "P", ticketPrefix: "P" },
    tickets: [
      { id: "m1", type: "spec-module", title: "PRD", sourceAttachmentId: "att-1", links: [
        { linkTypeId: "contains", targetTicketId: "r1" },
        { linkTypeId: "contains", targetTicketId: "r2" }
      ] },
      { id: "r1", type: "requirement", title: "Req A", sectionPath: "1",
        sourceAnchor: { attachmentId: "att-1", sectionId: "slice-xyz", charStart: 0,  charEnd: 10 } },
      { id: "r2", type: "requirement", title: "Req B", sectionPath: "1",
        sourceAnchor: { attachmentId: "att-1", sectionId: "slice-xyz", charStart: 11, charEnd: 20 } }
    ]
  });
  const sections = [{ sectionPath: "1", level: 1, heading: "Login", body: "prose" }];
  const model = view.buildDocumentModel(snap, "m1", sections);
  assert.strictEqual(model.sections.length, 1);
  assert.deepStrictEqual(model.sections[0].requirements.map(r => r.title), ["Req A", "Req B"],
    "both requirements of the slice must list under section 1");
  assert.strictEqual(model.sections[0].gap, false, "a section with requirements is not a gap");
  assert.deepStrictEqual(model.slicing, { sections: 1, sliced: 1, gaps: 0 });
});

test("SM-203 R-7: buildDocumentModel resolves incoming trace links to ticket info", () => {
  const model = view.buildDocumentModel(buildSpecStore().get(), "m1", SECTIONS);
  const r1 = model.sections[0].requirements[0];
  assert.strictEqual(r1.realisedBy.length, 1);
  assert.strictEqual(r1.realisedBy[0].title, "Build login");
  assert.strictEqual(r1.realisedBy[0].id, "s1");
});

test("SM-203 R-7: mount renders separate ID + Coverage attribute columns; source text stays pure", () => {
  const store = buildSpecStore();
  let fetchedAid = null;
  const ctl = view.mount(freshHost(), store, { fetchIngest: (aid) => { fetchedAid = aid; return new Promise(() => {}); } });
  try {
    assert.ok(document.querySelector(".vr-module-picker"));
    assert.ok(document.querySelector(".vr-grid"), "document grid present");
    // requirement text cell carries ONLY the statement — no id / no count mixed in
    const reqCell = cellsByText(".vr-cell-req", "Login req");
    assert.ok(reqCell, "requirement text cell present");
    assert.strictEqual(reqCell.querySelector(".vr-req-text").textContent, "Login req");
    assert.ok(!/P-|RD-|↳/.test(reqCell.querySelector(".vr-req-text").textContent), "no id/count in the text");
    // id + coverage live in their own attribute cells
    assert.ok(document.querySelector(".vr-cell-id"), "separate ID column");
    assert.ok(document.querySelector(".vr-cell-cov .vr-badge-covered"), "coverage badge in its own column");
    assert.strictEqual(fetchedAid, "att-1");
  } finally { ctl.unmount(); }
});

test("SM-203 R-7: clicking the coverage cell expands traceability; chips open the ticket", () => {
  const store = buildSpecStore();
  let opened = null;
  const ctl = view.mount(freshHost(), store, { onOpenTicket: (id) => { opened = id; } });
  try {
    const reqCell = cellsByText(".vr-cell-req", "Login req");
    reqCell.nextElementSibling.dispatchEvent(new dom.window.Event("click"));   // coverage cell toggles detail
    const chip = reqCell.querySelector(".vr-trace-chip");
    assert.ok(chip, "realised-by chip present after expanding via coverage cell");
    chip.dispatchEvent(new dom.window.Event("click"));
    assert.strictEqual(opened, "s1", "clicking the chip opens the realising ticket");
  } finally { ctl.unmount(); }
});

test("SM-203 R-7: an orphan requirement offers a 'create implementing ticket' action", () => {
  const store = buildSpecStore();
  let created = null;
  const ctl = view.mount(freshHost(), store, { onCreateImplementer: (req) => { created = req; } });
  try {
    const reqCell = cellsByText(".vr-cell-req", "Profile req");   // r2 is orphan
    reqCell.nextElementSibling.dispatchEvent(new dom.window.Event("click"));   // expand via coverage cell
    const action = reqCell.querySelector(".vr-action");
    assert.ok(action, "create-implementer action present on an orphan");
    action.dispatchEvent(new dom.window.Event("click"));
    assert.ok(created && created.id === "r2", "action fires with the requirement");
  } finally { ctl.unmount(); }
});

test("SM-203 R-7: editing the requirement statement mirrors into the ticket (onEditRequirement)", () => {
  const store = buildSpecStore();
  let edit = null;
  const ctl = view.mount(freshHost(), store, { onEditRequirement: (id, text) => { edit = { id, text }; } });
  try {
    const textEl = cellsByText(".vr-req-text", "Login req");
    assert.strictEqual(textEl.getAttribute("contenteditable"), "true", "statement is editable");
    textEl.textContent = "The user can sign in with email + password.";
    textEl.dispatchEvent(new dom.window.Event("blur"));
    assert.deepStrictEqual(edit, { id: "r1", text: "The user can sign in with email + password." });
  } finally { ctl.unmount(); }
});

test("SM-203 R-7: an unchanged / empty edit does not fire onEditRequirement", () => {
  const store = buildSpecStore();
  let fired = false;
  const ctl = view.mount(freshHost(), store, { onEditRequirement: () => { fired = true; } });
  try {
    const textEl = cellsByText(".vr-req-text", "Login req");
    textEl.textContent = "  Login req  ";   // whitespace-only change → normalized equal
    textEl.dispatchEvent(new dom.window.Event("blur"));
    textEl.textContent = "";                // empty → reverted, no commit
    textEl.dispatchEvent(new dom.window.Event("blur"));
    assert.strictEqual(fired, false);
    assert.strictEqual(textEl.textContent, "Login req", "empty edit reverts to the prior text");
  } finally { ctl.unmount(); }
});

test("SM-203 R-7: empty state when the project has no spec modules", () => {
  const store = new ProjectStore(core.normalizeSnapshot({ project: { id: "p", name: "P", ticketPrefix: "P" } }));
  const ctl = view.mount(freshHost(), store, {});
  try {
    assert.ok(document.querySelector(".vr-empty"), "empty state must show");
    assert.strictEqual(document.querySelectorAll(".vr-cell-req").length, 0);
  } finally { ctl.unmount(); }
});

test("SM-206: clampFrac keeps the Source/Requirement split in [0.2, 0.85]", () => {
  assert.strictEqual(view.clampFrac(0.5), 0.5);
  assert.strictEqual(view.clampFrac(0.05), 0.2);
  assert.strictEqual(view.clampFrac(0.99), 0.85);
});

test("SM-206: docGridCols puts more flex on Source by default; ID + Coverage fixed", () => {
  const cols = view.docGridCols(0.6);
  assert.deepStrictEqual(cols.split(" "), ["0.600fr", "52px", "0.400fr", "112px"]);
  // Source fraction > Requirement fraction → source column is wider.
  const [srcFr, , reqFr] = cols.split(" ");
  assert.ok(parseFloat(srcFr) > parseFloat(reqFr), "Source default wider than Requirement");
  // out-of-range fractions are clamped
  assert.ok(view.docGridCols(2).startsWith("0.850fr"));
});

console.log(`\n  ${passed} passed, ${failed} failed`);
