"use strict";

/**
 * E9k: Tests für `frontend/js/dnd.js`.
 *
 * Fokus auf die zwei E9k-Erweiterungen:
 *   1. Proportionales Skalieren des Drag-Offsets, wenn die Ghost-Breite
 *      gegen GHOST_MAX_WIDTH_PX geclampt wird.
 *   2. onMove-Callback, der pro pointermove gefeuert wird und dem Target
 *      die aktuelle Cursor-Position übergibt.
 */

const assert = require("assert");
const { JSDOM } = require("jsdom");

const dom = new JSDOM(`<!doctype html><html><body><div id="host"></div></body></html>`);
global.window      = dom.window;
global.document    = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;
// PointerEvent isn't always defined in JSDOM. We craft synthetic events with
// MouseEvent and add the missing fields manually so we don't depend on it.

const dnd = require("../frontend/js/dnd.js");

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  - ${name}`); passed++; }
  catch (err) { console.log(`  FAIL - ${name}\n         ${err.stack || err.message}`); failed++; process.exitCode = 1; }
}

function makeCard(width) {
  const el = document.createElement("div");
  el.className = "sm-story-card";
  el.style.width = width + "px";
  document.body.appendChild(el);
  // Stub getBoundingClientRect — JSDOM doesn't do layout.
  el.getBoundingClientRect = () => ({
    left: 100, top: 50, right: 100 + width, bottom: 50 + 40,
    width: width, height: 40, x: 100, y: 50, toJSON: () => ({})
  });
  return el;
}

function pointerEvent(type, x, y) {
  const ev = new dom.window.MouseEvent(type, {
    bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0
  });
  // Some handlers consult .button; MouseEvent sets it. Add a noop preventDefault is fine.
  return ev;
}

function startDragViaPointerSequence(el, opts, startX, startY, moveX, moveY) {
  dnd.enableDraggable(el, opts);
  el.dispatchEvent(pointerEvent("pointerdown", startX, startY));
  // Threshold is 4px → move 10px to trigger
  document.dispatchEvent(pointerEvent("pointermove", moveX, moveY));
}

// ---------------------------------------------------------------------------
// Offset-Scaling
// ---------------------------------------------------------------------------

test("offset is scaled proportionally when ghost width is clamped", () => {
  // Card 600px wide, max ghost = 280 → scale = 280/600 ≈ 0.4667
  const card = makeCard(600);
  // Grab at left=120 (inside-offset = 20px / 600). After clamp, expected offset = 20 * (280/600) ≈ 9.33
  startDragViaPointerSequence(card, { dragType: "story", dragId: "t1" }, 120, 60, 130, 70);
  const drag = dnd.currentDrag();
  assert.ok(drag, "drag should be active");
  // Ghost is in body
  const ghost = document.querySelector(".sm-drag-ghost");
  assert.ok(ghost, "ghost should exist");
  assert.strictEqual(ghost.style.width, "280px");
  // We can't read _active.offsetX directly; instead check ghost.left after a move.
  // Move cursor to clientX=400. Expected ghost.left = 400 - offsetX. offsetX was computed at
  // pointermove (the one that crossed threshold) with clientX=130 against rect.left=100:
  // raw=30, scale=280/600 → ~14. So ghost.left should be 400 - 14 = 386.
  document.dispatchEvent(pointerEvent("pointermove", 400, 90));
  const left = parseFloat(ghost.style.left);
  // Allow small float error.
  assert.ok(Math.abs(left - 386) < 2, "expected ghost.left ≈ 386 but got " + left);
  // Cleanup
  document.dispatchEvent(pointerEvent("pointerup", 400, 90));
  dnd.scrubArtifacts();
});

test("offset is NOT scaled when card is narrower than the clamp", () => {
  // Card 200px wide → no clamp → scale=1
  const card = makeCard(200);
  // Grab at clientX=160, rect.left=100 → raw offset = 60 (unscaled)
  startDragViaPointerSequence(card, { dragType: "story", dragId: "t2" }, 160, 60, 170, 70);
  const ghost = document.querySelector(".sm-drag-ghost");
  assert.strictEqual(ghost.style.width, "200px");
  document.dispatchEvent(pointerEvent("pointermove", 400, 90));
  // offsetX = 170 - 100 = 70; ghost.left = 400 - 70 = 330
  const left = parseFloat(ghost.style.left);
  assert.ok(Math.abs(left - 330) < 2, "expected ghost.left ≈ 330 but got " + left);
  document.dispatchEvent(pointerEvent("pointerup", 400, 90));
  dnd.scrubArtifacts();
});

// ---------------------------------------------------------------------------
// onMove callback
// ---------------------------------------------------------------------------

test("onMove fires for every pointermove over the registered target", () => {
  const card = makeCard(220);
  const target = document.createElement("div");
  target.id = "epic-X";
  document.body.appendChild(target);
  target.getBoundingClientRect = () => ({
    left: 300, top: 100, right: 600, bottom: 400,
    width: 300, height: 300, x: 300, y: 100, toJSON: () => ({})
  });

  const moves = [];
  dnd.enableDropTarget(target, {
    accepts: ["story"],
    onMove: (ctx) => moves.push({ x: ctx.clientX, y: ctx.clientY, type: ctx.type, id: ctx.id })
  });

  startDragViaPointerSequence(card, { dragType: "story", dragId: "tt" }, 150, 60, 160, 70);
  // Move over target — elementFromPoint must return the target. Stub it.
  document.elementFromPoint = (x, y) => (x >= 300 && x <= 600 && y >= 100 && y <= 400 ? target : null);
  document.dispatchEvent(pointerEvent("pointermove", 350, 150));
  document.dispatchEvent(pointerEvent("pointermove", 360, 170));
  document.dispatchEvent(pointerEvent("pointermove", 400, 200));
  // Move outside — onMove should not fire (no target under cursor)
  document.dispatchEvent(pointerEvent("pointermove", 50, 50));

  assert.ok(moves.length >= 3, "expected at least 3 onMove calls inside target, got " + moves.length);
  assert.strictEqual(moves[0].type, "story");
  assert.strictEqual(moves[0].id, "tt");
  assert.strictEqual(moves[moves.length - 1].x, 400);

  document.dispatchEvent(pointerEvent("pointerup", 50, 50));
  dnd.scrubArtifacts();
  dnd.clearAll();
});

// ---------------------------------------------------------------------------
// Lifecycle ordering: onDrop must fire BEFORE onEnd (otherwise the
// renderer's onEnd clears _dragProjection before onDrop reads it).
// ---------------------------------------------------------------------------

test("onDrop fires BEFORE onEnd so the drop callback can read drag-time state", () => {
  const card = makeCard(220);
  const target = document.createElement("div");
  target.id = "epic-Y";
  document.body.appendChild(target);
  target.getBoundingClientRect = () => ({
    left: 300, top: 100, right: 600, bottom: 400,
    width: 300, height: 300, x: 300, y: 100, toJSON: () => ({})
  });

  const sequence = [];
  dnd.enableDraggable(card, {
    dragType: "story",
    dragId: "tt",
    onEnd: () => sequence.push("onEnd")
  });
  dnd.enableDropTarget(target, {
    accepts: ["story"],
    onDrop: () => sequence.push("onDrop")
  });

  // Start the drag (pointerdown + threshold pointermove)
  card.dispatchEvent(pointerEvent("pointerdown", 150, 60));
  document.dispatchEvent(pointerEvent("pointermove", 160, 70));
  document.elementFromPoint = (x, y) => (x >= 300 && x <= 600 && y >= 100 && y <= 400 ? target : null);
  document.dispatchEvent(pointerEvent("pointermove", 400, 200));   // hover target
  document.dispatchEvent(pointerEvent("pointerup",   400, 200));   // release on target

  assert.deepStrictEqual(sequence, ["onDrop", "onEnd"],
    "expected onDrop to fire before onEnd, got " + JSON.stringify(sequence));

  dnd.scrubArtifacts();
  dnd.clearAll();
});

// ---------------------------------------------------------------------------
// SM-61 — findTarget must skip registered targets that don't accept the
// active drag-type, walking up to find one that does. Otherwise nested
// drop-targets (e.g. an Epic-card inside a Cell) swallow the search and
// silently prevent the drop.
// ---------------------------------------------------------------------------

test("SM-61: findTarget walks past a non-accepting target to the outer accepting one", () => {
  // Outer Cell accepts EPIC + STORY; inner Epic-card accepts STORY only.
  // When the user drags an EPIC and hovers over the Epic-card (inside the
  // Cell), the drop must resolve to the Cell — not silently fail because
  // the inner Epic-card was the first registered match.
  const card = makeCard(220);
  const outerCell = document.createElement("div");
  outerCell.id = "outer-cell";
  document.body.appendChild(outerCell);
  const innerEpic = document.createElement("div");
  innerEpic.id = "inner-epic";
  outerCell.appendChild(innerEpic);
  outerCell.getBoundingClientRect = () => ({
    left: 300, top: 100, right: 600, bottom: 400,
    width: 300, height: 300, x: 300, y: 100, toJSON: () => ({})
  });
  innerEpic.getBoundingClientRect = () => ({
    left: 320, top: 120, right: 480, bottom: 280,
    width: 160, height: 160, x: 320, y: 120, toJSON: () => ({})
  });

  const drops = [];
  dnd.enableDropTarget(outerCell, {
    accepts: ["epic", "story"],
    onDrop: () => drops.push("outer-cell")
  });
  dnd.enableDropTarget(innerEpic, {
    accepts: ["story"],   // does NOT accept "epic"
    onDrop: () => drops.push("inner-epic")
  });

  // Stub elementFromPoint to return innerEpic when the cursor is in its area.
  document.elementFromPoint = (x, y) => {
    if (x >= 320 && x <= 480 && y >= 120 && y <= 280) return innerEpic;
    if (x >= 300 && x <= 600 && y >= 100 && y <= 400) return outerCell;
    return null;
  };

  // Drag an EPIC card and drop it on top of the innerEpic.
  card.dispatchEvent(pointerEvent("pointerdown", 50, 50));
  document.dispatchEvent(pointerEvent("pointermove", 60, 60));
  dnd.enableDraggable(card, { dragType: "epic", dragId: "ep-1" });
  // Re-dispatch via fresh sequence to trigger the active drag.
  card.dispatchEvent(pointerEvent("pointerdown", 150, 60));
  document.dispatchEvent(pointerEvent("pointermove", 160, 70));   // threshold cross
  document.dispatchEvent(pointerEvent("pointermove", 400, 200));  // hover innerEpic
  document.dispatchEvent(pointerEvent("pointerup",   400, 200));  // drop on innerEpic

  // The drop must have gone to the outer-cell (innerEpic doesn't accept epic).
  assert.ok(drops.indexOf("outer-cell") >= 0,
    "outer cell must receive the drop (got: " + JSON.stringify(drops) + ")");
  assert.strictEqual(drops.indexOf("inner-epic"), -1,
    "inner epic must NOT receive the drop (doesn't accept epic)");

  dnd.scrubArtifacts();
  dnd.clearAll();
});

console.log(`\n  ${passed} passed, ${failed} failed`);
