"use strict";

// SM-216 — smart-bar autocomplete dropdown (frontend/js/smartbar-autocomplete.js).
// jsdom smoke: attach to an input, render suggestions, accept inserts text.

const assert = require("assert");
const { JSDOM } = require("jsdom");

const dom = new JSDOM("<!doctype html><html><body><input id='q' type='text'></body></html>");
global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;

const queryAutocomplete = require("../shared/query-autocomplete.js");
const sb = require("../frontend/js/smartbar-autocomplete.js");
dom.window.STORYMAP = { queryAutocomplete: queryAutocomplete };

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  - ${name}`); passed++; }
  catch (err) { console.log(`  FAIL - ${name}\n         ${err.stack || err.message}`); failed++; process.exitCode = 1; }
}

const snap = {
  project: { ticketTypes: ["epic", "user-story", "bug"], workflow: { statuses: [{ id: "backlog" }, { id: "ready" }, { id: "done" }] }, labels: [] },
  releases: [], processSteps: [], tickets: []
};

function freshInput() {
  document.body.innerHTML = "<input id='q' type='text'>";
  return document.getElementById("q");
}
function typeInto(input, value, cursor) {
  input.value = value;
  const c = cursor == null ? value.length : cursor;
  try { input.setSelectionRange(c, c); } catch (_e) {}
  input.dispatchEvent(new dom.window.Event("input"));
}
function labels(menu) {
  return Array.prototype.map.call(menu.querySelectorAll(".smartbar-ac-label"), (e) => e.textContent);
}

test("SM-216: a field prefix opens the dropdown with matching fields", () => {
  const input = freshInput();
  const ctl = sb.attachAutocomplete(input, { getSnapshot: () => snap, onAccept: () => {} });
  try {
    typeInto(input, "stat", 4);
    assert.strictEqual(ctl._menu.hidden, false, "dropdown is visible");
    assert.ok(labels(ctl._menu).indexOf("status") >= 0, "status suggested");
  } finally { ctl.detach(); }
});

test("SM-216: accepting a suggestion inserts its text + trailing space at the cursor", () => {
  const input = freshInput();
  let accepted = 0;
  const ctl = sb.attachAutocomplete(input, { getSnapshot: () => snap, onAccept: () => { accepted++; } });
  try {
    typeInto(input, "stat", 4);
    const idx = labels(ctl._menu).indexOf("status");
    ctl._accept(idx);
    assert.strictEqual(input.value, "status ", "field inserted with trailing space");
    assert.ok(accepted >= 1, "onAccept fired");
    // chained: after inserting the field, operators are offered
    assert.ok(labels(ctl._menu).indexOf("=") >= 0, "operator suggestions follow");
  } finally { ctl.detach(); }
});

test("SM-216: after an operator, field VALUES are suggested", () => {
  const input = freshInput();
  const ctl = sb.attachAutocomplete(input, { getSnapshot: () => snap, onAccept: () => {} });
  try {
    typeInto(input, "status = ", 9);
    assert.deepStrictEqual(labels(ctl._menu).slice().sort(), ["backlog", "done", "ready"]);
  } finally { ctl.detach(); }
});

test("SM-216: empty / non-suggesting input hides the dropdown", () => {
  const input = freshInput();
  const ctl = sb.attachAutocomplete(input, { getSnapshot: () => snap, onAccept: () => {} });
  try {
    typeInto(input, "text ~ ", 7);   // free-text value → no suggestions
    assert.strictEqual(ctl._menu.hidden, true, "no suggestions → hidden");
  } finally { ctl.detach(); }
});

test("SM-216/293: nothing is auto-highlighted; ↓/↑ choose and Enter accepts the CHOSEN item", () => {
  const input = freshInput();
  const ctl = sb.attachAutocomplete(input, { getSnapshot: () => snap, onAccept: () => {} });
  try {
    typeInto(input, "status = ", 9);   // values: backlog, done, ready (sorted)
    const key = (k) => input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
    assert.strictEqual(ctl._menu.querySelector(".smartbar-ac-item.active"), null,
      "SM-293: NO item is active before the user navigates");
    key("ArrowDown");
    const activeLabel = () => ctl._menu.querySelector(".smartbar-ac-item.active .smartbar-ac-label").textContent;
    assert.strictEqual(activeLabel(), "backlog", "ArrowDown highlights the first item");
    key("ArrowDown");
    assert.strictEqual(activeLabel(), "done", "ArrowDown moves the highlight");
    key("ArrowUp"); key("ArrowUp");
    assert.strictEqual(activeLabel(), "ready", "ArrowUp wraps around");
    key("Enter");
    assert.strictEqual(input.value, "status = ready ", "Enter accepts the CHOSEN value");
  } finally { ctl.detach(); }
});

test("SM-293: Enter WITHOUT a chosen suggestion falls through (submits) and closes the menu", () => {
  const input = freshInput();
  const ctl = sb.attachAutocomplete(input, { getSnapshot: () => snap, onAccept: () => {} });
  try {
    typeInto(input, "status = ", 9);
    assert.strictEqual(ctl._menu.hidden, false, "suggestions open");
    const ev = new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    input.dispatchEvent(ev);
    assert.strictEqual(ev.defaultPrevented, false, "Enter falls through to the input's own handler");
    assert.strictEqual(input.value, "status = ", "no suggestion inserted");
    assert.strictEqual(ctl._menu.hidden, true, "menu closed on fall-through");
  } finally { ctl.detach(); }
});

test("SM-293: Tab eagerly accepts the first suggestion without navigating", () => {
  const input = freshInput();
  const ctl = sb.attachAutocomplete(input, { getSnapshot: () => snap, onAccept: () => {} });
  try {
    typeInto(input, "status = ", 9);
    const ev = new dom.window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    input.dispatchEvent(ev);
    assert.strictEqual(ev.defaultPrevented, true, "Tab consumed");
    assert.strictEqual(input.value, "status = backlog ", "first suggestion accepted");
  } finally { ctl.detach(); }
});

test("SM-293: ArrowUp from no selection highlights the LAST item", () => {
  const input = freshInput();
  const ctl = sb.attachAutocomplete(input, { getSnapshot: () => snap, onAccept: () => {} });
  try {
    typeInto(input, "status = ", 9);
    input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }));
    const lab = ctl._menu.querySelector(".smartbar-ac-item.active .smartbar-ac-label").textContent;
    assert.strictEqual(lab, "ready", "ArrowUp enters the list from the end");
  } finally { ctl.detach(); }
});

test("SM-216: accepting a field chains into operator suggestions (re-render)", () => {
  const input = freshInput();
  const ctl = sb.attachAutocomplete(input, { getSnapshot: () => snap, onAccept: () => {} });
  try {
    typeInto(input, "stat", 4);
    ctl._accept(labels(ctl._menu).indexOf("status"));
    assert.strictEqual(input.value, "status ");
    assert.ok(!ctl._menu.hidden && labels(ctl._menu).indexOf("=") >= 0, "operators offered after the field");
  } finally { ctl.detach(); }
});

test("SM-216: Escape closes the dropdown without clearing the input", () => {
  const input = freshInput();
  const ctl = sb.attachAutocomplete(input, { getSnapshot: () => snap, onAccept: () => {} });
  try {
    typeInto(input, "stat", 4);
    assert.strictEqual(ctl._menu.hidden, false);
    input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    assert.strictEqual(ctl._menu.hidden, true, "Esc closes the dropdown");
    assert.strictEqual(input.value, "stat", "Esc does not clear the input");
  } finally { ctl.detach(); }
});

console.log(`\n  ${passed} passed, ${failed} failed`);
