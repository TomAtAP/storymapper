"use strict";

/**
 * UI-Shell-Modul Tests. JSDOM stellt window/document; das Modul mountet
 * Modals + Popovers + Flash in den DOM.
 *
 * Was getestet wird (alle aus cmapper portierten Patterns):
 *   showModal, showSettingsPopover, flashStatus, wireDebounced,
 *   bindLongPress, mountMenuBar.
 *
 * Konstanten werden aus dem Modul importiert und in den Tests referenziert
 * (statt Literal-Zahlen).
 */

const assert = require("assert");
const { JSDOM } = require("jsdom");

const dom = new JSDOM(`<!doctype html><html><body></body></html>`);
global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;
global.KeyboardEvent = dom.window.KeyboardEvent;
global.MouseEvent = dom.window.MouseEvent;

const uiShell = require("../frontend/js/ui-shell.js");
const { CONSTANTS } = uiShell;

let passed = 0, failed = 0;
function test(name, fn) {
  const exec = async () => {
    try {
      // Reset DOM body between tests so flash/modal residue doesn't bleed.
      document.body.innerHTML = "";
      const r = fn();
      if (r && typeof r.then === "function") await r;
      console.log(`  ok  - ${name}`); passed++;
    } catch (err) {
      console.log(`  FAIL - ${name}\n         ${err.stack || err.message}`);
      failed++; process.exitCode = 1;
    }
  };
  return (test._chain = (test._chain || Promise.resolve()).then(exec));
}

// ---------------------------------------------------------------------------
// CONSTANTS — sanity check that they are exported, NOT inline numbers
// ---------------------------------------------------------------------------

test("CONSTANTS exported with expected keys", () => {
  for (const k of ["LONGPRESS_MS_DEFAULT", "DEBOUNCE_MS_DEFAULT", "FLASH_TIMEOUT_MS", "POPOVER_VIEWPORT_MARGIN_PX"]) {
    assert.ok(typeof CONSTANTS[k] === "number" && CONSTANTS[k] > 0, "missing CONSTANTS." + k);
  }
});

// ---------------------------------------------------------------------------
// showModal
// ---------------------------------------------------------------------------

test("showModal renders overlay + modal with title, sub, body, action buttons", () => {
  uiShell.showModal({
    title: "Confirm",
    sub: "Are you sure?",
    bodyHTML: '<input id="confirm-input" value="yes">',
    actions: [
      { label: "Cancel", onClick: () => {} },
      { label: "OK", primary: true, onClick: () => {} }
    ]
  });
  const overlay = document.querySelector(".modal-overlay");
  assert.ok(overlay, "no overlay");
  assert.ok(overlay.querySelector(".modal"), "no modal");
  // cmapper-Pattern: Title als <h2>, Sub als .modal-sub div, Body inline.
  const title = overlay.querySelector(".modal h2");
  assert.strictEqual(title.textContent, "Confirm");
  const sub = overlay.querySelector(".modal-sub");
  assert.strictEqual(sub.textContent, "Are you sure?");
  assert.ok(overlay.querySelector("#confirm-input"), "body html not inserted");
  const btns = overlay.querySelectorAll(".modal-actions .btn");
  assert.strictEqual(btns.length, 2);
  assert.ok(btns[1].classList.contains("primary"), "primary class missing");
});

test("showModal: destructive action gets .btn.destructive class", () => {
  uiShell.showModal({
    title: "X",
    actions: [{ label: "Delete", destructive: true, onClick: () => {} }]
  });
  const btn = document.querySelector(".modal-actions .btn");
  assert.ok(btn.classList.contains("destructive"));
});

test("showModal uses #modal-host when present, replaces any prior modal", () => {
  document.body.innerHTML = '<div id="modal-host"></div>';
  uiShell.showModal({ title: "A", actions: [{ label: "OK" }] });
  uiShell.showModal({ title: "B", actions: [{ label: "OK" }] });
  const overlays = document.querySelectorAll(".modal-overlay");
  assert.strictEqual(overlays.length, 1);
  assert.strictEqual(overlays[0].querySelector(".modal h2").textContent, "B");
});

test("showModal: Escape key closes modal", () => {
  uiShell.showModal({ title: "X", actions: [{ label: "OK" }] });
  assert.ok(document.querySelector(".modal-overlay"));
  document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.strictEqual(document.querySelector(".modal-overlay"), null);
});

test("showModal: click on overlay (outside modal) closes it", () => {
  uiShell.showModal({ title: "X", actions: [{ label: "OK" }] });
  const overlay = document.querySelector(".modal-overlay");
  overlay.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  assert.strictEqual(document.querySelector(".modal-overlay"), null);
});

test("showModal: click on modal body does NOT close it", () => {
  uiShell.showModal({ title: "X", actions: [{ label: "OK" }] });
  const modal = document.querySelector(".modal");
  modal.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  assert.ok(document.querySelector(".modal-overlay"), "modal should still be open");
});

test("showModal: action onClick receives (modal, close) and close() removes overlay", () => {
  let got = null;
  uiShell.showModal({
    title: "X",
    actions: [
      { label: "Do", onClick: (modal, close) => { got = { hasModal: !!modal, hasClose: typeof close === "function" }; close(); } }
    ]
  });
  document.querySelector(".modal-actions .btn").click();
  assert.deepStrictEqual(got, { hasModal: true, hasClose: true });
  assert.strictEqual(document.querySelector(".modal-overlay"), null);
});

test("showModal: action onClick returning false keeps modal open", () => {
  uiShell.showModal({
    title: "X",
    actions: [{ label: "Do", onClick: () => false }]
  });
  document.querySelector(".modal-actions .btn").click();
  assert.ok(document.querySelector(".modal-overlay"), "should remain open on false return");
});

test("showModal: onMount receives (modal, close) and is called once", () => {
  let mounts = 0; let captured = null;
  uiShell.showModal({
    title: "X",
    bodyHTML: '<input id="foo">',
    onMount: (modal, close) => { mounts++; captured = modal.querySelector("#foo"); },
    actions: [{ label: "OK" }]
  });
  assert.strictEqual(mounts, 1);
  assert.ok(captured, "modal queryselector failed in onMount");
});

// ---------------------------------------------------------------------------
// showSettingsPopover
// ---------------------------------------------------------------------------

test("showSettingsPopover renders an anchored popover with title + body", () => {
  document.body.innerHTML = '<button id="anchor"></button>';
  const anchor = document.getElementById("anchor");
  uiShell.showSettingsPopover({
    anchorEl: anchor,
    title: "Settings",
    bodyHTML: '<div class="sp-row"><label>Foo</label><input/></div>'
  });
  const pop = document.querySelector(".settings-popover");
  assert.ok(pop);
  assert.strictEqual(pop.querySelector(".sp-title").textContent, "Settings");
  assert.ok(pop.querySelector(".sp-row"));
});

test("showSettingsPopover is a singleton — second call closes the first", () => {
  document.body.innerHTML = '<button id="a"></button><button id="b"></button>';
  uiShell.showSettingsPopover({ anchorEl: document.getElementById("a"), title: "A" });
  uiShell.showSettingsPopover({ anchorEl: document.getElementById("b"), title: "B" });
  const all = document.querySelectorAll(".settings-popover");
  assert.strictEqual(all.length, 1);
  assert.strictEqual(all[0].querySelector(".sp-title").textContent, "B");
});

test("showSettingsPopover: Escape closes; onClose fires with reason='escape'", () => {
  document.body.innerHTML = '<button id="a"></button>';
  let closeReason = null;
  uiShell.showSettingsPopover({
    anchorEl: document.getElementById("a"),
    title: "X",
    onClose: (cause) => { closeReason = cause; }
  });
  document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.strictEqual(document.querySelector(".settings-popover"), null);
  assert.strictEqual(closeReason, "escape");
});

// ---------------------------------------------------------------------------
// flashStatus
// ---------------------------------------------------------------------------

test("flashStatus inserts a flash element with the message", () => {
  uiShell.flashStatus("Hello");
  const flash = document.querySelector(".flash");
  assert.ok(flash);
  assert.ok(flash.textContent.includes("Hello"));
});

test("flashStatus kind='error' adds .flash-error class", () => {
  uiShell.flashStatus("Boom", { kind: "error" });
  const flash = document.querySelector(".flash");
  assert.ok(flash.classList.contains("flash-error"));
});

test("flashStatus spinner=true does NOT auto-dismiss; returns handle with dismiss()", async () => {
  const h = uiShell.flashStatus("Loading", { spinner: true });
  assert.ok(document.querySelector(".flash-spinner"), "spinner missing");
  // Wait longer than FLASH_TIMEOUT_MS to confirm no auto-dismiss
  await new Promise(r => setTimeout(r, CONSTANTS.FLASH_TIMEOUT_MS + 100));
  assert.ok(document.querySelector(".flash"), "should still be visible");
  h.dismiss();
  assert.strictEqual(document.querySelector(".flash"), null);
});

// ---------------------------------------------------------------------------
// wireDebounced
// ---------------------------------------------------------------------------

test("wireDebounced fires fn(value) after delay without further input", async () => {
  document.body.innerHTML = '<input id="x">';
  const input = document.getElementById("x");
  let captured = null;
  uiShell.wireDebounced(input, (v) => { captured = v; }, 50);
  input.value = "abc";
  input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  await new Promise(r => setTimeout(r, 80));
  assert.strictEqual(captured, "abc");
});

test("wireDebounced coalesces rapid input events", async () => {
  document.body.innerHTML = '<input id="x">';
  const input = document.getElementById("x");
  let calls = 0;
  uiShell.wireDebounced(input, () => { calls++; }, 50);
  for (const v of ["a", "ab", "abc", "abcd"]) {
    input.value = v;
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  }
  await new Promise(r => setTimeout(r, 80));
  assert.strictEqual(calls, 1);
});

// ---------------------------------------------------------------------------
// bindLongPress
// ---------------------------------------------------------------------------

test("bindLongPress: short click fires onShort", async () => {
  document.body.innerHTML = '<button id="b">x</button>';
  const btn = document.getElementById("b");
  let shortFired = 0, longFired = 0;
  uiShell.bindLongPress(btn, { onShort: () => shortFired++, onLong: () => longFired++, ms: 50 });
  btn.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true }));
  await new Promise(r => setTimeout(r, 10));
  btn.dispatchEvent(new dom.window.MouseEvent("pointerup", { bubbles: true }));
  await new Promise(r => setTimeout(r, 80));
  assert.strictEqual(shortFired, 1);
  assert.strictEqual(longFired, 0);
});

test("bindLongPress: long hold fires onLong, not onShort", async () => {
  document.body.innerHTML = '<button id="b">x</button>';
  const btn = document.getElementById("b");
  let shortFired = 0, longFired = 0;
  uiShell.bindLongPress(btn, { onShort: () => shortFired++, onLong: () => longFired++, ms: 50 });
  btn.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true }));
  await new Promise(r => setTimeout(r, 80));
  btn.dispatchEvent(new dom.window.MouseEvent("pointerup", { bubbles: true }));
  assert.strictEqual(longFired, 1);
  assert.strictEqual(shortFired, 0);
});

// ---------------------------------------------------------------------------
// mountMenuBar
// ---------------------------------------------------------------------------

test("mountMenuBar renders top-level items and dropdown opens on click", () => {
  document.body.innerHTML = '<div id="bar"></div>';
  const bar = document.getElementById("bar");
  uiShell.mountMenuBar(bar, [
    { id: "project", label: "Project", items: [
      { label: "Load…", action: () => {} },
      { type: "separator" },
      { label: "Delete", action: () => {} }
    ]}
  ]);
  const top = bar.querySelectorAll(".menu-item");
  assert.strictEqual(top.length, 1);
  top[0].dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  const dd = document.querySelector(".menu-dropdown");
  assert.ok(dd);
  const items = dd.querySelectorAll(".menu-dropdown-item");
  assert.strictEqual(items.length, 2, "2 items + 1 separator → 2 selectable rows");
});

test("mountMenuBar: click on dropdown-item invokes action and closes dropdown", () => {
  document.body.innerHTML = '<div id="bar"></div>';
  let fired = 0;
  uiShell.mountMenuBar(document.getElementById("bar"), [
    { id: "p", label: "P", items: [{ label: "Go", action: () => fired++ }] }
  ]);
  document.querySelector(".menu-item").click();
  document.querySelector(".menu-dropdown-item").click();
  assert.strictEqual(fired, 1);
  assert.strictEqual(document.querySelector(".menu-dropdown"), null);
});

test("mountMenuBar: disabled (function) skips action and visually marks item", () => {
  document.body.innerHTML = '<div id="bar"></div>';
  let fired = 0;
  uiShell.mountMenuBar(document.getElementById("bar"), [
    { id: "p", label: "P", items: [{ label: "Go", disabled: () => true, action: () => fired++ }] }
  ]);
  document.querySelector(".menu-item").click();
  const item = document.querySelector(".menu-dropdown-item");
  assert.ok(item.classList.contains("disabled"), "should have disabled class");
  item.click();
  assert.strictEqual(fired, 0);
});

// SM-30 — showContextMenu
test("SM-30: showContextMenu renders one .context-menu with N .context-menu-item buttons", () => {
  document.body.innerHTML = "";
  uiShell.showContextMenu({
    clientX: 100, clientY: 100,
    items: [
      { label: "Alpha", onClick: () => {} },
      { label: "Bravo", onClick: () => {} },
      { label: "Charlie", onClick: () => {} }
    ]
  });
  const menu = document.querySelector(".context-menu");
  assert.ok(menu, "context menu mounted");
  const items = menu.querySelectorAll(".context-menu-item");
  assert.strictEqual(items.length, 3);
  assert.strictEqual(items[0].textContent, "Alpha");
});

test("SM-30: showContextMenu item click fires onClick and closes the menu", () => {
  document.body.innerHTML = "";
  let fired = 0;
  uiShell.showContextMenu({
    clientX: 50, clientY: 50,
    items: [{ label: "Do", onClick: () => { fired++; } }]
  });
  document.querySelector(".context-menu-item").click();
  assert.strictEqual(fired, 1, "onClick fired");
  assert.strictEqual(document.querySelector(".context-menu"), null, "menu closed after click");
});

test("SM-30: showContextMenu positions at clientX/clientY", () => {
  document.body.innerHTML = "";
  uiShell.showContextMenu({
    clientX: 42, clientY: 84,
    items: [{ label: "X", onClick: () => {} }]
  });
  const menu = document.querySelector(".context-menu");
  // JSDOM has no layout engine — offsetHeight/Width are 0, so clamping doesn't
  // kick in. The positioner sets `top` to clientY and `left` to clientX as-is.
  assert.strictEqual(menu.style.top,  "84px");
  assert.strictEqual(menu.style.left, "42px");
});

test("SM-30: showContextMenu disabled item does not fire onClick", () => {
  document.body.innerHTML = "";
  let fired = 0;
  uiShell.showContextMenu({
    clientX: 0, clientY: 0,
    items: [{ label: "Nope", onClick: () => { fired++; }, disabled: true }]
  });
  const item = document.querySelector(".context-menu-item");
  assert.ok(item.classList.contains("context-menu-item-disabled"));
  item.click();
  assert.strictEqual(fired, 0);
});

test("SM-30: showContextMenu Esc closes the menu", () => {
  document.body.innerHTML = "";
  uiShell.showContextMenu({
    clientX: 0, clientY: 0,
    items: [{ label: "X", onClick: () => {} }]
  });
  assert.ok(document.querySelector(".context-menu"));
  document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.strictEqual(document.querySelector(".context-menu"), null);
});

test("SM-30: opening a second showContextMenu replaces the first (singleton)", () => {
  document.body.innerHTML = "";
  uiShell.showContextMenu({ clientX: 0, clientY: 0, items: [{ label: "A", onClick: () => {} }] });
  uiShell.showContextMenu({ clientX: 10, clientY: 10, items: [{ label: "B", onClick: () => {} }] });
  const menus = document.querySelectorAll(".context-menu");
  assert.strictEqual(menus.length, 1);
  assert.strictEqual(menus[0].querySelector(".context-menu-item").textContent, "B");
});

module.exports.done = (test._chain || Promise.resolve()).then(() => {
  console.log(`\n  ${passed} passed, ${failed} failed`);
});
