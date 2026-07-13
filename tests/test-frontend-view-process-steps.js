"use strict";

/**
 * SM-248/256 — Process-Step editor view.
 *
 * The view is a SECOND surface onto the map: process steps render as cards via
 * the SHARED card component (rendererCard.renderCard, teal cluster) and reorder
 * with the same dnd mechanic as the Map's item cards, wired to
 * store.reorderProcessSteps. Double-click opens the existing edit dialog. No
 * inline edit, no per-card delete, no tickets on the cards.
 */

const assert = require("assert");
const { JSDOM } = require("jsdom");

const dom = new JSDOM(`<!doctype html><html><body><div id="host"></div></body></html>`);
global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;

const core = require("../frontend/js/core.js");
const dnd = require("../frontend/js/dnd.js");
const { ProjectStore } = require("../frontend/js/store.js");
const view = require("../frontend/js/view-process-steps.js");

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  - ${name}`); passed++; }
  catch (err) { console.log(`  FAIL - ${name}\n         ${err.stack || err.message}`); failed++; process.exitCode = 1; }
}

const HUMAN = { type: "human", id: "u1", name: "U" };

function boardWithSteps() {
  const store = new ProjectStore(core.normalizeSnapshot({
    project: { id: "p1", name: "P", ticketPrefix: "P" },
    releases: [{ id: "R1", name: "v1", sortOrder: 0 }],
    processSteps: [{ id: "PSA", name: "Discover", sortOrder: 0 }, { id: "PSB", name: "Buy", sortOrder: 1 }]
  }));
  store.createTicket({ type: "epic", title: "E1", position: { releaseId: "R1", processStepId: "PSA" } }, HUMAN);
  return { store };
}

function freshHost() { const h = document.getElementById("host"); h.innerHTML = ""; return h; }

test("SM-248: buildProcessStepModel returns steps in journey order with ordinals", () => {
  const { store } = boardWithSteps();
  const model = view.buildProcessStepModel(store.get());
  assert.deepStrictEqual(model.map(m => m.step.name), ["Discover", "Buy"]);
  assert.deepStrictEqual(model.map(m => m.ordinal), [1, 2]);
});

test("SM-256: each step renders via the SHARED card component (.sm-story-card, teal), no tickets/meta", () => {
  const { store } = boardWithSteps();
  const host = freshHost();
  const ctrl = view.mount(host, store, {});
  const cards = host.querySelectorAll(".sm-story-card[data-process-step-id]");
  assert.strictEqual(cards.length, 2, "one shared card per step");
  assert.ok(cards[0].classList.contains("sm-cluster-process"),
    "process-step colour coding = process cluster (painted from the backbone tokens)");
  // No ordinal number; the step name is the shared title.
  assert.strictEqual(cards[0].querySelector(".sm-story-key"), null, "no ordinal number on the card");
  assert.strictEqual(cards[0].querySelector(".sm-story-title").textContent, "Discover");
  // No tickets / no epic hull / no meta row (deliberately the zoomed-out journey).
  assert.strictEqual(host.querySelectorAll(".psv-hull, .psv-hull-epic").length, 0, "no epic hull");
  assert.strictEqual(cards[0].querySelector(".sm-card-meta"), null, "no meta row on a step card");
  ctrl.unmount();
});

test("SM-248: double-click a step card opens the existing edit dialog (ctx.onEditProcessStep)", () => {
  const { store } = boardWithSteps();
  const host = freshHost();
  let edited = null;
  const ctrl = view.mount(host, store, { onEditProcessStep: (id) => { edited = id; } });
  const card = Array.from(host.querySelectorAll(".sm-story-card[data-process-step-id]"))
    .find(c => c.dataset.processStepId === "PSB");
  card.dispatchEvent(new dom.window.MouseEvent("dblclick", { bubbles: true }));
  assert.strictEqual(edited, "PSB", "dblclick routes to the shared edit dialog with the step id");
  ctrl.unmount();
});

test("SM-256: reorderProcessStepIds removes the dragged id and re-inserts at insertionIndex", () => {
  const steps = [{ id: "a" }, { id: "b" }, { id: "c" }];
  assert.deepStrictEqual(view.reorderProcessStepIds(steps, "a", 2), ["b", "c", "a"]);
  assert.deepStrictEqual(view.reorderProcessStepIds(steps, "c", 0), ["c", "a", "b"]);
  assert.deepStrictEqual(view.reorderProcessStepIds(steps, "b", 1), ["a", "b", "c"], "same slot → unchanged");
});

test("SM-256: dropping a step on the flow reorders via store.reorderProcessSteps (Map mechanic)", () => {
  const { store } = boardWithSteps();   // PSA (Discover), PSB (Buy)
  const host = freshHost();
  const ctrl = view.mount(host, store, {});
  // Same mechanic as the Map: the flow is the drop target; onMove sets the
  // projection (JSDOM rects are 0 → cursor past every mid → insertion at end),
  // onDrop persists. Invoke the EXACT registered closures (SM-245 lesson).
  const reg1 = dnd._getDropTarget(host.querySelector(".psv-flow"));
  assert.ok(reg1 && typeof reg1.onMove === "function" && typeof reg1.onDrop === "function",
    "flow is a drop target with onMove + onDrop");
  reg1.onMove({ type: "psv-step", id: "PSA", clientX: 0, clientY: 0 });
  // onMove re-rendered (live shadow) → re-grab the current flow's registration.
  const reg2 = dnd._getDropTarget(host.querySelector(".psv-flow"));
  reg2.onDrop({ type: "psv-step", id: "PSA" });
  const order = store.get().processSteps.filter(p => !p.isDeleted)
    .slice().sort((a, b) => a.sortOrder - b.sortOrder).map(p => p.id);
  assert.deepStrictEqual(order, ["PSB", "PSA"], "PSA reordered after PSB");
  ctrl.unmount();
});

test("SM-249: quick-add creates a step on Enter and keeps the field focused", () => {
  const { store } = boardWithSteps();
  const host = freshHost();
  const ctrl = view.mount(host, store, {});
  const before = store.get().processSteps.length;
  const qa = host.querySelector(".psv-quickadd-input");
  qa.focus();
  qa.value = "Onboard";
  qa.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  const steps = store.get().processSteps;
  assert.strictEqual(steps.length, before + 1, "a step was created");
  assert.ok(steps.some(p => p.name === "Onboard"));
  const qa2 = host.querySelector(".psv-quickadd-input");
  assert.strictEqual(host.ownerDocument.activeElement, qa2, "quick-add refocused for the next step");
  ctrl.unmount();
});

test("SM-249: quick-add ignores an empty entry", () => {
  const { store } = boardWithSteps();
  const host = freshHost();
  const ctrl = view.mount(host, store, {});
  const before = store.get().processSteps.length;
  const qa = host.querySelector(".psv-quickadd-input");
  qa.value = "   ";
  qa.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  assert.strictEqual(store.get().processSteps.length, before, "no step for an empty entry");
  ctrl.unmount();
});

test("SM-248: empty state when there are no process steps", () => {
  const store = new ProjectStore(core.normalizeSnapshot({ project: { id: "p1", name: "P", ticketPrefix: "P" } }));
  const host = freshHost();
  const ctrl = view.mount(host, store, {});
  assert.ok(host.querySelector(".psv-empty"), "empty-state shown");
  assert.strictEqual(host.querySelectorAll(".sm-story-card[data-process-step-id]").length, 0);
  ctrl.unmount();
});

test("SM-248: live-sync — a non-focused external commit re-renders the cards", () => {
  const { store } = boardWithSteps();
  const host = freshHost();
  const ctrl = view.mount(host, store, {});
  assert.strictEqual(host.querySelectorAll(".sm-story-card[data-process-step-id]").length, 2);
  store.createProcessStep({ name: "Review" }, HUMAN);
  assert.strictEqual(host.querySelectorAll(".sm-story-card[data-process-step-id]").length, 3, "new step appears live");
  ctrl.unmount();
});

test("SM-248: focus guard — an external commit does NOT stomp the quick-add input being typed", () => {
  const { store } = boardWithSteps();
  const host = freshHost();
  const ctrl = view.mount(host, store, {});
  const qa = host.querySelector(".psv-quickadd-input");
  qa.focus();
  qa.value = "typing in progress";
  // An external commit (e.g. MCP/WS) fires the subscriber.
  store.createTicket({ type: "epic", title: "E2", position: { releaseId: "R1", processStepId: "PSB" } }, HUMAN);
  assert.strictEqual(host.querySelector(".psv-quickadd-input").value, "typing in progress",
    "in-progress quick-add text survives an external re-render");
  ctrl.unmount();
});

console.log(`\n  ${passed} passed, ${failed} failed`);
