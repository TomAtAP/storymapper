"use strict";

/**
 * SM-281 — Tests for `frontend/js/wheel-pan.js`.
 *
 * Shift+vertical-wheel → horizontal pan on the view scroller. Safari never
 * translates shift+wheel into horizontal scrolling natively (Chrome does),
 * and a mouse with only a vertical wheel produces no deltaX at all — without
 * this translation such users cannot scroll the map horizontally.
 */

const assert = require("assert");
const { JSDOM } = require("jsdom");

const dom = new JSDOM(`<!doctype html><html><body><div id="vh"></div></body></html>`);
global.window      = dom.window;
global.document    = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;

const wheelPan = require("../frontend/js/wheel-pan.js");

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  - ${name}`); passed++; }
  catch (err) { console.log(`  FAIL - ${name}\n         ${err.stack || err.message}`); failed++; process.exitCode = 1; }
}

function wheel(opts) {
  return new dom.window.WheelEvent("wheel", Object.assign({ bubbles: true, cancelable: true }, opts));
}

// ---- pure helper: translateShiftWheel ------------------------------------

test("SM-281: translateShiftWheel — shift + vertical delta translates to horizontal", () => {
  assert.strictEqual(wheelPan.translateShiftWheel(wheel({ shiftKey: true, deltaY: 120, deltaX: 0 })), 120);
  assert.strictEqual(wheelPan.translateShiftWheel(wheel({ shiftKey: true, deltaY: -80, deltaX: 0 })), -80);
});

test("SM-281: translateShiftWheel — no shift → no translation", () => {
  assert.strictEqual(wheelPan.translateShiftWheel(wheel({ shiftKey: false, deltaY: 120, deltaX: 0 })), 0);
});

test("SM-281: translateShiftWheel — engine already produced deltaX (Chrome) → no double-translation", () => {
  assert.strictEqual(wheelPan.translateShiftWheel(wheel({ shiftKey: true, deltaY: 0, deltaX: 120 })), 0);
  assert.strictEqual(wheelPan.translateShiftWheel(wheel({ shiftKey: true, deltaY: 40, deltaX: 120 })), 0);
});

test("SM-281: translateShiftWheel — deltaMode LINE is scaled to pixels", () => {
  const lineEv = wheel({ shiftKey: true, deltaY: 3, deltaX: 0, deltaMode: 1 /* DOM_DELTA_LINE */ });
  assert.strictEqual(wheelPan.translateShiftWheel(lineEv), 3 * wheelPan.WHEEL_PAN.LINE_HEIGHT_PX);
});

// ---- installShiftWheelPan -------------------------------------------------

test("SM-281: installShiftWheelPan — shift+wheel pans the element horizontally and consumes the event", () => {
  const el = document.getElementById("vh");
  el.scrollLeft = 0;
  const uninstall = wheelPan.installShiftWheelPan(el);
  const ev = wheel({ shiftKey: true, deltaY: 100, deltaX: 0 });
  el.dispatchEvent(ev);
  assert.strictEqual(el.scrollLeft, 100, "scrollLeft moved by deltaY");
  assert.strictEqual(ev.defaultPrevented, true, "event consumed (no vertical scroll)");
  uninstall();
});

test("SM-281: installShiftWheelPan — plain vertical wheel is untouched", () => {
  const el = document.getElementById("vh");
  el.scrollLeft = 0;
  const uninstall = wheelPan.installShiftWheelPan(el);
  const ev = wheel({ shiftKey: false, deltaY: 100, deltaX: 0 });
  el.dispatchEvent(ev);
  assert.strictEqual(el.scrollLeft, 0, "no horizontal pan");
  assert.strictEqual(ev.defaultPrevented, false, "vertical scroll not hijacked");
  uninstall();
});

test("SM-281: installShiftWheelPan — uninstall removes the listener", () => {
  const el = document.getElementById("vh");
  el.scrollLeft = 0;
  const uninstall = wheelPan.installShiftWheelPan(el);
  uninstall();
  el.dispatchEvent(wheel({ shiftKey: true, deltaY: 100, deltaX: 0 }));
  assert.strictEqual(el.scrollLeft, 0, "listener gone after uninstall");
});

console.log(`\n  ${passed} passed, ${failed} failed`);
