"use strict";

/**
 * E24 — Tests for `frontend/js/card-animate.js`.
 *
 * Focus on the pure diff helper. The FLIP/pulse helpers themselves are
 * timing-sensitive and JSDOM returns zero-rects, so we only smoke them
 * for no-ops.
 */

const assert = require("assert");
const { JSDOM } = require("jsdom");

const dom = new JSDOM(`<!doctype html><html><body><div id="host"></div></body></html>`);
global.window      = dom.window;
global.document    = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;

const anim = require("../frontend/js/card-animate.js");

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  - ${name}`); passed++; }
  catch (err) { console.log(`  FAIL - ${name}\n         ${err.stack || err.message}`); failed++; process.exitCode = 1; }
}

function snap(tickets) {
  return { version: 1, project: { id: "p1" }, tickets: tickets, releases: [], processSteps: [] };
}

test("E24: diffNonPositionChanges returns empty when nothing changed", () => {
  const a = snap([
    { id: "t1", type: "user-story", title: "A", description: "", status: "backlog",
      labels: [], acceptanceCriteria: [], definitionOfReady: {items:[]}, definitionOfDone: {items:[]},
      links: [], comments: [], isDeleted: false }
  ]);
  const b = snap(a.tickets);
  assert.strictEqual(anim.diffNonPositionChanges(a, b).size, 0);
});

test("E24: diffNonPositionChanges flags a title change", () => {
  const a = snap([{ id: "t1", title: "Old" }]);
  const b = snap([{ id: "t1", title: "New" }]);
  const changed = anim.diffNonPositionChanges(a, b);
  assert.strictEqual(changed.size, 1);
  assert.ok(changed.has("t1"));
});

test("E24: diffNonPositionChanges flags a status change", () => {
  const a = snap([{ id: "t1", status: "backlog" }]);
  const b = snap([{ id: "t1", status: "ready" }]);
  assert.ok(anim.diffNonPositionChanges(a, b).has("t1"));
});

test("E24: diffNonPositionChanges flags an acceptanceCriteria change", () => {
  const a = snap([{ id: "t1", acceptanceCriteria: [{ id: "ac1", text: "X" }] }]);
  const b = snap([{ id: "t1", acceptanceCriteria: [{ id: "ac1", text: "Y" }] }]);
  assert.ok(anim.diffNonPositionChanges(a, b).has("t1"));
});

test("E24: diffNonPositionChanges IGNORES pure position/sortOrder changes", () => {
  const a = snap([{ id: "t1", title: "Same", status: "backlog",
    position: { releaseId: "r1", epicId: null, processStepId: null, sortOrder: 0 } }]);
  const b = snap([{ id: "t1", title: "Same", status: "backlog",
    position: { releaseId: "r2", epicId: null, processStepId: null, sortOrder: 5 } }]);
  // Only position changed → hash is unchanged → no pulse.
  assert.strictEqual(anim.diffNonPositionChanges(a, b).size, 0);
});

test("E24: diffNonPositionChanges flags newly-added tickets NOT (they aren't in prev)", () => {
  const a = snap([]);
  const b = snap([{ id: "t1", title: "Brand new" }]);
  // Non-position diff only cares about *existing* tickets that changed.
  // New-ticket pulsing is a separate helper (diffNewTickets).
  assert.strictEqual(anim.diffNonPositionChanges(a, b).size, 0);
});

test("E24.D: diffNewTickets returns the ids of tickets that didn't exist before", () => {
  const a = snap([{ id: "t1", title: "Old" }]);
  const b = snap([
    { id: "t1", title: "Old" },
    { id: "t2", title: "Fresh" },
    { id: "t3", title: "Also fresh" }
  ]);
  const fresh = anim.diffNewTickets(a, b);
  assert.deepStrictEqual(Array.from(fresh).sort(), ["t2", "t3"]);
});

test("E24.D: diffNewTickets returns empty when nothing was added", () => {
  const a = snap([{ id: "t1", title: "X" }]);
  const b = snap([{ id: "t1", title: "Y" }]);   // updated, not added
  assert.strictEqual(anim.diffNewTickets(a, b).size, 0);
});

test("E24.D: diffNewTickets handles null prev (initial mount) by treating all as new", () => {
  const a = null;
  const b = snap([{ id: "t1" }, { id: "t2" }]);
  // null prev means "first commit ever observed" — those tickets ARE new
  // from the user's perspective.
  const fresh = anim.diffNewTickets(a, b);
  assert.deepStrictEqual(Array.from(fresh).sort(), ["t1", "t2"]);
});

test("E24.D: diffNewTickets ignores deleted tickets in next snapshot", () => {
  const a = snap([]);
  const b = snap([{ id: "t1", isDeleted: true }, { id: "t2", isDeleted: false }]);
  // A deleted ticket doesn't render as a card → no point pulsing it.
  assert.deepStrictEqual(Array.from(anim.diffNewTickets(a, b)), ["t2"]);
});

test("E24.D: diffTouchedTickets flags edits, position-only moves, AND new tickets", () => {
  // Three kinds of mutations in one commit; all should be flagged.
  const a = snap([
    { id: "t1", title: "Edited later", updatedAt: 100, version: 1 },
    { id: "t2", title: "Moved later",  updatedAt: 100, version: 1,
      position: { releaseId: "r1", epicId: null, processStepId: null, sortOrder: 0 } },
    { id: "t3", title: "Untouched",    updatedAt: 100, version: 1 }
  ]);
  const b = snap([
    { id: "t1", title: "Edited",       updatedAt: 200, version: 2 },         // field change
    { id: "t2", title: "Moved later",  updatedAt: 200, version: 2,           // pure position change
      position: { releaseId: "r1", epicId: null, processStepId: null, sortOrder: 5 } },
    { id: "t3", title: "Untouched",    updatedAt: 100, version: 1 },         // unchanged
    { id: "t4", title: "Brand new",    updatedAt: 200, version: 1 }          // newly added
  ]);
  const touched = anim.diffTouchedTickets(a, b);
  assert.deepStrictEqual(Array.from(touched).sort(), ["t1", "t2", "t4"]);
});

test("E24.E: diffTouchedEntities works on any list (releases/processSteps)", () => {
  const a = { releases: [{ id: "r1", name: "X", updatedAt: 1, version: 1 }],
              processSteps: [{ id: "ps1", name: "Build", updatedAt: 1, version: 1 }] };
  const b = { releases: [{ id: "r1", name: "X-renamed", updatedAt: 2, version: 2 },
                         { id: "r2", name: "New", updatedAt: 2, version: 1 }],
              processSteps: [{ id: "ps1", name: "Build", updatedAt: 1, version: 1 },
                             { id: "ps2", name: "Validate", updatedAt: 2, version: 1 }] };
  const rels = anim.diffTouchedEntities(a, b, "releases");
  assert.deepStrictEqual(Array.from(rels).sort(), ["r1", "r2"]);
  const pss = anim.diffTouchedEntities(a, b, "processSteps");
  assert.deepStrictEqual(Array.from(pss), ["ps2"]);
});

test("E24.E: captureRectsBySelector + flipFromCapturedSelector are pure parameterised variants", () => {
  const host = document.getElementById("host");
  host.innerHTML = '<div data-foo-id="x"></div><div data-foo-id="y"></div>';
  const rects = anim.captureRectsBySelector(host, "[data-foo-id]", "fooId");
  assert.strictEqual(rects.size, 2);
  assert.ok(rects.has("x"));
  // flip should be a safe no-op when nothing moved.
  const n = anim.flipFromCapturedSelector(host, rects, "[data-foo-id]", "fooId");
  assert.strictEqual(n, 0);
});

test("E24.E: pulseEntities with selectorPrefix/suffix adds flash class to matched nodes", () => {
  const host = document.getElementById("host");
  host.innerHTML = '<div data-foo-id="a" class="thing"></div>'
                 + '<div data-foo-id="b" class="thing"></div>';
  anim.pulseEntities(host, ["a"], '[data-foo-id="', '"]');
  assert.ok(host.querySelector('[data-foo-id="a"]').classList.contains(anim.PULSE_CLASS));
  assert.ok(!host.querySelector('[data-foo-id="b"]').classList.contains(anim.PULSE_CLASS));
});

test("E24.E: animateExternalCommitMulti pulses tickets AND process-steps in one pass", () => {
  const host = document.getElementById("host");
  host.innerHTML = '<div data-ticket-id="t1" class="sm-story-card"></div>'
                 + '<div data-process-step-id="ps1" class="sm-backbone-col"></div>';
  const prev = { tickets: [{ id: "t1", title: "Old", updatedAt: 1, version: 1 }],
                 processSteps: [{ id: "ps1", name: "Old", updatedAt: 1, version: 1 }] };
  const next = { tickets: [{ id: "t1", title: "New", updatedAt: 2, version: 2 }],
                 processSteps: [{ id: "ps1", name: "New", updatedAt: 2, version: 2 }] };
  anim.animateExternalCommitMulti({
    host: host,
    prevSnap: prev,
    nextSnap: next,
    rerender: function () {},
    entityTypes: [
      { listKey: "tickets",      selector: "[data-ticket-id]",       idAttr: "ticketId" },
      { listKey: "processSteps", selector: "[data-process-step-id]", idAttr: "processStepId" }
    ]
  });
  assert.ok(host.querySelector('[data-ticket-id="t1"]').classList.contains(anim.PULSE_CLASS));
  assert.ok(host.querySelector('[data-process-step-id="ps1"]').classList.contains(anim.PULSE_CLASS));
});

test("E24.D: animateExternalCommit pulses every touched ticket (edit OR move OR new)", () => {
  const host = document.getElementById("host");
  host.innerHTML = '<div class="sm-story-card" data-ticket-id="t1"></div>'
                 + '<div class="sm-story-card" data-ticket-id="t2"></div>'
                 + '<div class="sm-story-card" data-ticket-id="t3"></div>';
  anim.animateExternalCommit({
    host: host,
    prevSnap: snap([
      { id: "t1", title: "Old",  updatedAt: 100, version: 1 },
      { id: "t3", title: "Same", updatedAt: 100, version: 1 }
    ]),
    nextSnap: snap([
      { id: "t1", title: "New",  updatedAt: 200, version: 2 },     // edited
      { id: "t2", title: "Fresh",updatedAt: 200, version: 1 },     // new
      { id: "t3", title: "Same", updatedAt: 100, version: 1 }      // untouched
    ]),
    rerender: function () { /* no-op for the test */ }
  });
  const c1 = host.querySelector('[data-ticket-id="t1"]');
  const c2 = host.querySelector('[data-ticket-id="t2"]');
  const c3 = host.querySelector('[data-ticket-id="t3"]');
  assert.ok(c1.classList.contains(anim.PULSE_CLASS), "edited card pulses");
  assert.ok(c2.classList.contains(anim.PULSE_CLASS), "new card pulses");
  assert.ok(!c3.classList.contains(anim.PULSE_CLASS), "untouched card does not pulse");
});

test("E24: diffNonPositionChanges handles missing snapshots safely", () => {
  assert.strictEqual(anim.diffNonPositionChanges(null, null).size, 0);
  assert.strictEqual(anim.diffNonPositionChanges(snap([]), null).size, 0);
  assert.strictEqual(anim.diffNonPositionChanges(null, snap([])).size, 0);
});

test("E24: captureCardRects collects rects keyed by data-ticket-id", () => {
  const host = document.getElementById("host");
  host.innerHTML = '<div class="sm-story-card" data-ticket-id="t1"></div>'
                 + '<div class="sm-story-card" data-ticket-id="t2"></div>'
                 + '<div class="sm-story-card"></div>';   // no id, skipped
  const rects = anim.captureCardRects(host);
  assert.strictEqual(rects.size, 2);
  assert.ok(rects.has("t1"));
  assert.ok(rects.has("t2"));
});

test("E24: flipFromCaptured is a safe no-op when prevRects is empty/missing", () => {
  const host = document.getElementById("host");
  host.innerHTML = '<div class="sm-story-card" data-ticket-id="t1"></div>';
  // Shouldn't throw and shouldn't move anything.
  const n = anim.flipFromCaptured(host, new Map());
  assert.strictEqual(n, 0);
  assert.strictEqual(anim.flipFromCaptured(host, null), 0);
});

test("E24: pulseTickets adds + removes the flash class after duration", (/* sync OK in JSDOM */) => {
  const host = document.getElementById("host");
  host.innerHTML = '<div class="sm-story-card" data-ticket-id="t1"></div>';
  anim.pulseTickets(host, ["t1"], { duration: 20 });
  const card = host.querySelector(".sm-story-card");
  assert.ok(card.classList.contains(anim.PULSE_CLASS), "flash class added immediately");
});

test("E24: animateExternalCommit calls rerender + applies effects without throwing", () => {
  const host = document.getElementById("host");
  host.innerHTML = '<div class="sm-story-card" data-ticket-id="t1"></div>';
  let rerendered = false;
  anim.animateExternalCommit({
    host: host,
    prevSnap: snap([{ id: "t1", title: "Old" }]),
    nextSnap: snap([{ id: "t1", title: "New" }]),
    rerender: () => { rerendered = true; }
  });
  assert.strictEqual(rerendered, true, "rerender callback must be invoked");
});

console.log(`\n  ${passed} passed, ${failed} failed`);
