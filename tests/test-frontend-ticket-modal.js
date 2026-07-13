"use strict";

/**
 * E10 — Tests für `frontend/js/renderer-ticket-modal.js`.
 *
 * Modal-Rendering, Feld-Population, Live-Sync mit Focus-Guard, Save-Pfad
 * mit PUT/status-Endpoints, DoR/DoD-Inline-Toggle, Konflikt-Banner bei
 * validation failure (DoR/DoD-Gate).
 */

const assert = require("assert");
const { JSDOM } = require("jsdom");

const dom = new JSDOM(`<!doctype html><html><body><div id="modal-host"></div></body></html>`);
global.window      = dom.window;
global.document    = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;
global.MutationObserver = dom.window.MutationObserver;

const core = require("../frontend/js/core.js");
const { ProjectStore } = require("../frontend/js/store.js");
const uiShell = require("../frontend/js/ui-shell.js");
const modalMod = require("../frontend/js/renderer-ticket-modal.js");
const ticketForm = require("../frontend/js/ticket-form.js");

let passed = 0, failed = 0;
// Async-aware, sequential test runner. Several tests below have `async` bodies
// (SM-70/71/73); a sync-only helper would log "ok" and count them as passed
// BEFORE the body ran, hiding real failures behind an unhandled rejection.
// Each test is chained onto `runChain`; run.js awaits `module.exports.done`.
let runChain = Promise.resolve();
function test(name, fn) {
  runChain = runChain.then(async () => {
    try { await fn(); console.log(`  ok  - ${name}`); passed++; }
    catch (err) { console.log(`  FAIL - ${name}\n         ${err.stack || err.message}`); failed++; process.exitCode = 1; }
  });
}

const HUMAN = { type: "human", id: "u1", name: "U" };

function buildStore() {
  const snap = core.normalizeSnapshot({
    project: {
      id: "p1", name: "P", ticketPrefix: "P",
      definitions: {
        ready: { global: [{ id: "g1", label: "Has acceptance criteria", required: true }], byType: {} },
        done:  { global: [{ id: "d1", label: "All tests pass", required: true }], byType: {} }
      }
    }
  });
  const store = new ProjectStore(snap);
  store.createRelease({ name: "v1.0" }, HUMAN);
  store.createProcessStep({ name: "Onboarding" }, HUMAN);
  store.createTicket({ type: "epic", title: "E1" }, HUMAN);
  return store;
}

function makeCtx(store, overrides) {
  const calls = { http: [] };
  const ctx = Object.assign({
    store,
    adapter: { name: "Local", save: async () => {} },
    projectId: "p1",
    uiShell,
    httpReq: async (method, path, body) => {
      calls.http.push({ method, path, body });
      return { snapshot: store.get() };
    },
    reloadStore: async () => {},
    applySnapshot: (snap) => store.applyRemote(snap),
    flashStatus: () => {}
  }, overrides || {});
  ctx._calls = calls;
  return ctx;
}

function setup() {
  document.getElementById("modal-host").innerHTML = "";
  const store = buildStore();
  store.createTicket({ type: "user-story", title: "MyStory", description: "hello" }, HUMAN);
  const story = store.get().tickets.find(t => t.title === "MyStory");
  return { store, story };
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

test("openTicketModal renders h2 title with ticket-key and pre-fills key fields", () => {
  const { store, story } = setup();
  const ctx = makeCtx(store);
  modalMod.openTicketModal(ctx, story.id, {});
  const modal = document.querySelector(".modal");
  assert.ok(modal, "modal should exist in DOM");
  // h2 contains ticket-key + title; no separate sub-line or badge row.
  const h2 = modal.querySelector("h2");
  assert.ok(h2.textContent.includes(story.ticketKey));
  assert.ok(h2.textContent.includes("MyStory"));
  assert.strictEqual(modal.querySelector(".modal-sub"), null, "sub-line should be removed");
  assert.strictEqual(modal.querySelector(".tm-header"), null, "header badge row should be removed");
  // title input pre-filled
  const titleInput = modal.querySelector('[data-sm-sync-key="title"]');
  assert.strictEqual(titleInput.value, "MyStory");
  // description contentEditable block pre-filled (SM-119)
  const descTa = modal.querySelector('[data-sm-sync-key="description"]');
  assert.strictEqual(descTa.getAttribute("contenteditable"), "true");
  assert.strictEqual(descTa.textContent, "hello");
});

test("AC rows are drag-sortable: grip handle present, row registered as drag-target", () => {
  const { store, story } = setup();
  store.updateTicket(story.id, { acceptanceCriteria: [
    { id: "ac-1", text: "first",  completed: false },
    { id: "ac-2", text: "second", completed: false }
  ]}, HUMAN);
  const ctx = makeCtx(store);
  modalMod.openTicketModal(ctx, story.id, {});
  const modal = document.querySelector(".modal");
  const rows = modal.querySelectorAll(".tm-ac-row");
  assert.strictEqual(rows.length, 2);
  for (const r of rows) {
    assert.ok(r.querySelector(".tm-ac-grip"), "each AC row should have a grip handle");
  }
});

test("Create-Mode: draft.status pre-fills the Status dropdown (Kanban-Lane add flow)", () => {
  const { store } = setup();
  const ctx = makeCtx(store);
  modalMod.openTicketModal(ctx, null, { draft: { type: "user-story", status: "in-progress" } });
  const modal = document.querySelector(".modal");
  const statusSel = modal.querySelector('[data-sm-sync-key="status"]');
  assert.ok(statusSel);
  assert.strictEqual(statusSel.value, "in-progress");
});

test("AC reorder via DOM produces new orderedIds in collectFormState", () => {
  const { store, story } = setup();
  store.updateTicket(story.id, { acceptanceCriteria: [
    { id: "ac-1", text: "first",  completed: false },
    { id: "ac-2", text: "second", completed: false },
    { id: "ac-3", text: "third",  completed: false }
  ]}, HUMAN);
  const ctx = makeCtx(store);
  modalMod.openTicketModal(ctx, story.id, {});
  const modal = document.querySelector(".modal");
  const list = modal.querySelector(".tm-ac-list");
  const rows = Array.from(list.children);
  // Move ac-3 to the front (simulating a successful drag-drop).
  list.insertBefore(rows[2], rows[0]);
  const state = modalMod._internals.collectFormState(modal);
  assert.deepStrictEqual(state.acceptanceCriteria.map(ac => ac.id), ["ac-3", "ac-1", "ac-2"]);
});

test("openTicketModal renders DoR + DoD as editable rows with required toggle", () => {
  const { store, story } = setup();
  const ctx = makeCtx(store);
  modalMod.openTicketModal(ctx, story.id, {});
  const modal = document.querySelector(".modal");
  const dor = modal.querySelector('[data-sm-sync-key="definitionOfReady"]');
  const dod = modal.querySelector('[data-sm-sync-key="definitionOfDone"]');
  assert.ok(dor, "DoR section");
  assert.ok(dod, "DoD section");
  // Pre-filled with the frozen items from the ticket.
  const dorRow = dor.querySelector(".tm-checkitem-row");
  assert.ok(dorRow, "DoR should render at least one editable row");
  const labelInput = dorRow.querySelector(".tm-checkitem-text-input");
  assert.strictEqual(labelInput.value, "Has acceptance criteria");
  // Required-toggle present and checked (item.required = true).
  const requiredToggle = dorRow.querySelector(".tm-checkitem-required");
  assert.ok(requiredToggle && requiredToggle.checked);
  // "+ Add Item" button at the end.
  assert.ok(dor.querySelector(".tm-checklist-add"));
});

test("openTicketModal: epic ticket does NOT show an epic-id position dropdown", () => {
  const { store } = setup();
  store.createTicket({ type: "epic", title: "MyEpic" }, HUMAN);
  const epic = store.get().tickets.find(t => t.title === "MyEpic");
  const ctx = makeCtx(store);
  modalMod.openTicketModal(ctx, epic.id, {});
  const modal = document.querySelector(".modal");
  const epicDropdown = modal.querySelector('[data-sm-sync-key="position.epicId"]');
  assert.strictEqual(epicDropdown, null, "epic shouldn't get a parent-epic dropdown");
});

test("SM-100: epic modal does NOT render Prereqs / Steps / Execution / Outcome sections — even when entityTypeConfig carries stale TRUEs", () => {
  // Reproduce the storymap-roadmap SQLite state: an epic-type override that
  // somehow accumulated all four test-flags set to `true`. The hard-lock in
  // getEntityTypeConfig must keep them out of the modal.
  const { store } = setup();
  store.updateProject({
    entityTypeConfig: {
      epic: {
        showPrerequisites: true, showSteps: true,
        showExecutionSteps: true, showTestOutcome: true
      }
    }
  }, HUMAN);
  store.createTicket({ type: "epic", title: "MyEpic2" }, HUMAN);
  const epic = store.get().tickets.find(t => t.title === "MyEpic2");
  const ctx = makeCtx(store);
  modalMod.openTicketModal(ctx, epic.id, {});
  const modal = document.querySelector(".modal");
  assert.strictEqual(modal.querySelector("section.tm-prereqs"),      null, "no Prereqs section on epic");
  assert.strictEqual(modal.querySelector("section.tm-test-steps"),   null, "no Steps section on epic");
  assert.strictEqual(modal.querySelector("section.tm-exec-steps"),   null, "no Execution-Steps section on epic");
  assert.strictEqual(modal.querySelector("section.tm-exec-outcome"), null, "no Outcome section on epic");
});

test("SM-100: test-definition modal still renders Prereqs + Steps", () => {
  const { store } = setup();
  // Ensure project has the test-definition type registered.
  const project = store.get().project;
  if (project.ticketTypes.indexOf("test-definition") < 0) {
    store.updateProject({ ticketTypes: project.ticketTypes.concat(["test-definition"]) }, HUMAN);
  }
  store.createTicket({ type: "test-definition", title: "TD1" }, HUMAN);
  const td = store.get().tickets.find(t => t.title === "TD1");
  const ctx = makeCtx(store);
  modalMod.openTicketModal(ctx, td.id, {});
  const modal = document.querySelector(".modal");
  assert.ok(modal.querySelector("section.tm-prereqs"),    "Prereqs section present on test-definition");
  assert.ok(modal.querySelector("section.tm-test-steps"), "Steps section present on test-definition");
});

// ---------------------------------------------------------------------------
// Live-Sync with focus guard
// ---------------------------------------------------------------------------

test("Live-Sync: store commit updates fields when not focused", () => {
  const { store, story } = setup();
  const ctx = makeCtx(store);
  modalMod.openTicketModal(ctx, story.id, {});
  const modal = document.querySelector(".modal");
  const titleInput = modal.querySelector('[data-sm-sync-key="title"]');
  assert.strictEqual(titleInput.value, "MyStory");
  // External commit changes the title.
  store.updateTicket(story.id, { title: "MyStory (updated)" }, HUMAN);
  assert.strictEqual(titleInput.value, "MyStory (updated)");
});

test("Live-Sync: focused field is NOT overwritten by store commit", () => {
  const { store, story } = setup();
  const ctx = makeCtx(store);
  modalMod.openTicketModal(ctx, story.id, {});
  const modal = document.querySelector(".modal");
  const titleInput = modal.querySelector('[data-sm-sync-key="title"]');
  titleInput.value = "user is typing";
  titleInput.focus();
  assert.strictEqual(document.activeElement, titleInput);
  // External commit while focused.
  store.updateTicket(story.id, { title: "should-be-ignored" }, HUMAN);
  // titleInput.value should retain user's typing.
  assert.strictEqual(titleInput.value, "user is typing");
});

// ---------------------------------------------------------------------------
// Form-collection helpers
// ---------------------------------------------------------------------------

test("collectFormState reads all editable fields", () => {
  const { store, story } = setup();
  const ctx = makeCtx(store);
  modalMod.openTicketModal(ctx, story.id, {});
  const modal = document.querySelector(".modal");
  // Mutate fields directly.
  modal.querySelector('[data-sm-sync-key="title"]').value = "Changed";
  modal.querySelector('[data-sm-sync-key="description"]').textContent = "new desc";  // SM-119: contentEditable
  modal.querySelector('[data-sm-sync-key="labels"]').value = "frontend, dnd";
  const state = modalMod._internals.collectFormState(modal);
  assert.strictEqual(state.title, "Changed");
  assert.strictEqual(state.description, "new desc");
  assert.deepStrictEqual(state.labels, ["frontend", "dnd"]);
  assert.strictEqual(typeof state.status, "string");
});

test("Create-Mode: DoR / DoD are FULLY EDITABLE, seeded from project.definitions", () => {
  const { store } = setup();
  const ctx = makeCtx(store);
  modalMod.openTicketModal(ctx, null, { draft: { type: "user-story" } });
  const modal = document.querySelector(".modal");
  const dorWrap = modal.querySelector('[data-sm-sync-key="definitionOfReady"]');
  const dodWrap = modal.querySelector('[data-sm-sync-key="definitionOfDone"]');
  assert.ok(dorWrap, "DoR section must render in create-mode");
  assert.ok(dodWrap, "DoD section must render in create-mode");
  // Items come from the resolved global definitions (label set in buildStore).
  const rows = dorWrap.querySelectorAll(".tm-checkitem-row");
  assert.strictEqual(rows.length, 1);
  const labelInput = rows[0].querySelector(".tm-checkitem-text-input");
  assert.strictEqual(labelInput.value, "Has acceptance criteria");
  // Editable inputs are NOT disabled — user can tweak before save.
  assert.strictEqual(labelInput.disabled, false);
  const checkedInput = rows[0].querySelector(".tm-checkitem-checked");
  assert.strictEqual(checkedInput.disabled, false);
  // "+ Add Item" is available so user can add ticket-specific items.
  assert.ok(dorWrap.querySelector(".tm-checklist-add"));
});

test("Create-Mode: changing the Type reseeds DoR/DoD from the new type (only if not dirty)", () => {
  const { store } = setup();
  // Add a bug-specific DoR override so user-story and bug differ.
  store.updateProject({
    definitions: {
      ready: { global: store.get().project.definitions.ready.global,
               byType: { "bug": { overridden: [{ id: "bug-dor", label: "Bug-only DoR", required: true }] } } },
      done:  store.get().project.definitions.done
    }
  }, HUMAN);
  const ctx = makeCtx(store);
  modalMod.openTicketModal(ctx, null, { draft: { type: "user-story" } });
  const modal = document.querySelector(".modal");
  const typeSel = modal.querySelector('[data-sm-sync-key="type"]');
  // Initial seed: user-story → "Has acceptance criteria" (the global item).
  let labelInput = modal.querySelector('[data-sm-sync-key="definitionOfReady"] .tm-checkitem-text-input');
  assert.strictEqual(labelInput.value, "Has acceptance criteria");
  // Switch type to bug → reseed with bug-specific override.
  typeSel.value = "bug";
  typeSel.dispatchEvent(new window.Event("change", { bubbles: true }));
  labelInput = modal.querySelector('[data-sm-sync-key="definitionOfReady"] .tm-checkitem-text-input');
  assert.strictEqual(labelInput.value, "Bug-only DoR", "Type switch should reseed DoR from the new type");
});

test("Create-Mode: type switch DOES NOT clobber user edits (dirty-guard)", () => {
  const { store } = setup();
  store.updateProject({
    definitions: {
      ready: { global: store.get().project.definitions.ready.global,
               byType: { "bug": { overridden: [{ id: "bug-dor", label: "Bug-only DoR", required: true }] } } },
      done:  store.get().project.definitions.done
    }
  }, HUMAN);
  const ctx = makeCtx(store);
  modalMod.openTicketModal(ctx, null, { draft: { type: "user-story" } });
  const modal = document.querySelector(".modal");
  // User edits the DoR label.
  let labelInput = modal.querySelector('[data-sm-sync-key="definitionOfReady"] .tm-checkitem-text-input');
  labelInput.value = "Custom DoR";
  labelInput.dispatchEvent(new window.Event("input", { bubbles: true }));
  // Switch type — user edit must be preserved (dirty-guard).
  const typeSel = modal.querySelector('[data-sm-sync-key="type"]');
  typeSel.value = "bug";
  typeSel.dispatchEvent(new window.Event("change", { bubbles: true }));
  labelInput = modal.querySelector('[data-sm-sync-key="definitionOfReady"] .tm-checkitem-text-input');
  assert.strictEqual(labelInput.value, "Custom DoR", "dirty-guard must preserve the user's edit");
});

test("Create-Mode: + Add Item appends a new editable row", () => {
  const { store } = setup();
  const ctx = makeCtx(store);
  modalMod.openTicketModal(ctx, null, { draft: { type: "user-story" } });
  const modal = document.querySelector(".modal");
  const dor = modal.querySelector('[data-sm-sync-key="definitionOfReady"]');
  const before = dor.querySelectorAll(".tm-checkitem-row").length;
  dor.querySelector(".tm-checklist-add").click();
  const after = dor.querySelectorAll(".tm-checkitem-row").length;
  assert.strictEqual(after, before + 1, "+ Add Item should append a row");
});

test("Create-Mode: DoR section hidden when entityTypeConfig disables it for the type", () => {
  const { store } = setup();
  store.updateProject({
    entityTypeConfig: Object.assign({}, store.get().project.entityTypeConfig, {
      "user-story": { showDefinitionOfReady: false }
    })
  }, HUMAN);
  const ctx = makeCtx(store);
  modalMod.openTicketModal(ctx, null, { draft: { type: "user-story" } });
  const modal = document.querySelector(".modal");
  assert.strictEqual(modal.querySelector('[data-sm-sync-key="definitionOfReady"]'), null,
    "DoR must NOT render when gate is off for this type");
  // DoD still shows (it's a separate flag).
  assert.ok(modal.querySelector('[data-sm-sync-key="definitionOfDone"]'));
});

test("Edit-Mode: + Add Item adds a row, collectFormState returns the new item", () => {
  const { store, story } = setup();
  const ctx = makeCtx(store);
  modalMod.openTicketModal(ctx, story.id, {});
  const modal = document.querySelector(".modal");
  const dor = modal.querySelector('[data-sm-sync-key="definitionOfReady"]');
  dor.querySelector(".tm-checklist-add").click();
  const rows = dor.querySelectorAll(".tm-checkitem-row");
  // Original 1 + 1 added.
  assert.strictEqual(rows.length, 2);
  const newInput = rows[1].querySelector(".tm-checkitem-text-input");
  newInput.value = "Added later";
  const state = modalMod._internals.collectFormState(modal);
  assert.strictEqual(state.definitionOfReady.items.length, 2);
  assert.strictEqual(state.definitionOfReady.items[1].label, "Added later");
});

test("Edit-Mode: removing a row removes it from collectFormState output", () => {
  const { store, story } = setup();
  const ctx = makeCtx(store);
  modalMod.openTicketModal(ctx, story.id, {});
  const modal = document.querySelector(".modal");
  const dor = modal.querySelector('[data-sm-sync-key="definitionOfReady"]');
  const removeBtn = dor.querySelector(".tm-checkitem-row .tm-checkitem-remove");
  removeBtn.click();
  const state = modalMod._internals.collectFormState(modal);
  assert.strictEqual(state.definitionOfReady.items.length, 0);
});

test("buildUpdatePatch includes definitionOfReady/Done when items changed", () => {
  const { store, story } = setup();
  const ctx = makeCtx(store);
  modalMod.openTicketModal(ctx, story.id, {});
  const modal = document.querySelector(".modal");
  const dor = modal.querySelector('[data-sm-sync-key="definitionOfReady"]');
  const row = dor.querySelector(".tm-checkitem-row");
  const labelInput = row.querySelector(".tm-checkitem-text-input");
  labelInput.value = "Renamed item";
  const form = modalMod._internals.collectFormState(modal);
  const patch = modalMod._internals.buildUpdatePatch(form, story);
  assert.ok(patch.definitionOfReady, "patch should include definitionOfReady when changed");
  assert.strictEqual(patch.definitionOfReady.items[0].label, "Renamed item");
});

test("buildUpdatePatch only includes fields that actually changed", () => {
  const { story } = setup();
  const form = {
    title: story.title,    // unchanged
    type: story.type,
    description: "changed",
    status: story.status,
    position: { releaseId: null, processStepId: null, epicId: null },
    acceptanceCriteria: [],
    labels: []
  };
  const patch = modalMod._internals.buildUpdatePatch(form, story);
  assert.ok(!("title" in patch));
  assert.strictEqual(patch.description, "changed");
  assert.ok(!("position" in patch));
});

// ---------------------------------------------------------------------------
// SM-5 — Pulse-Animation im Modal bei externen (applyRemote) Änderungen
// ---------------------------------------------------------------------------

test("SM-5: diffSyncFieldKeys returns empty set for identical tickets", () => {
  const a = { title: "T", type: "user-story", status: "backlog", description: "", labels: [], position: {} };
  const b = JSON.parse(JSON.stringify(a));
  const keys = modalMod._internals.diffSyncFieldKeys(a, b);
  assert.strictEqual(keys.size, 0);
});

test("SM-5: diffSyncFieldKeys catches title/type/status/description/labels", () => {
  const a = { title: "A", type: "user-story", status: "backlog", description: "old", labels: ["x"], position: {} };
  const b = { title: "B", type: "bug",        status: "ready",   description: "new", labels: ["y"], position: {} };
  const keys = modalMod._internals.diffSyncFieldKeys(a, b);
  assert.ok(keys.has("title"));
  assert.ok(keys.has("type"));
  assert.ok(keys.has("status"));
  assert.ok(keys.has("description"));
  assert.ok(keys.has("labels"));
});

test("SM-5: diffSyncFieldKeys catches position changes per-axis", () => {
  const a = { title: "T", type: "user-story", status: "backlog", labels: [], position: { releaseId: "r1", processStepId: "p1", epicId: null } };
  const b = { title: "T", type: "user-story", status: "backlog", labels: [], position: { releaseId: "r2", processStepId: "p1", epicId: "e1" } };
  const keys = modalMod._internals.diffSyncFieldKeys(a, b);
  assert.ok(keys.has("position.releaseId"));
  assert.ok(!keys.has("position.processStepId"));
  assert.ok(keys.has("position.epicId"));
});

test("SM-5: diffSyncFieldKeys catches DoR/DoD/AC structural changes", () => {
  const a = {
    title: "T", type: "user-story", status: "backlog", labels: [], position: {},
    acceptanceCriteria: [{ id: "a1", text: "old", completed: false }],
    definitionOfReady: { items: [{ id: "d1", checked: false }] },
    definitionOfDone:  { items: [{ id: "d2", checked: false }] }
  };
  const b = JSON.parse(JSON.stringify(a));
  b.acceptanceCriteria[0].completed = true;
  b.definitionOfReady.items[0].checked = true;
  b.definitionOfDone.items[0].checked  = true;
  const keys = modalMod._internals.diffSyncFieldKeys(a, b);
  assert.ok(keys.has("acceptanceCriteria"));
  assert.ok(keys.has("definitionOfReady"));
  assert.ok(keys.has("definitionOfDone"));
});

test("SM-5: pulseChangedFields adds the flash class to every sync-keyed field that changed", () => {
  // Build a minimal modal-like DOM with sync-keyed nodes by hand — we want to
  // test the helper in isolation, not run a full mount cycle.
  const host = document.getElementById("modal-host");
  host.innerHTML = ''
    + '<div data-sm-sync-key="title"></div>'
    + '<div data-sm-sync-key="status"></div>'
    + '<div data-sm-sync-key="description"></div>';
  const prev = { title: "A", type: "user-story", status: "backlog", description: "old", labels: [], position: {} };
  const next = { title: "A", type: "user-story", status: "ready",   description: "old", labels: [], position: {} };
  const pulsed = modalMod._internals.pulseChangedFields(host, prev, next);
  assert.deepStrictEqual(Array.from(pulsed).sort(), ["status"]);
  assert.ok(host.querySelector('[data-sm-sync-key="status"]').classList.contains("sm-card-flash"),
    "status pulses");
  assert.ok(!host.querySelector('[data-sm-sync-key="title"]').classList.contains("sm-card-flash"),
    "title (unchanged) does not pulse");
});

test("SM-5: openTicketModal subscribe fires pulse ONLY on reason='applyRemote', not on local commits", () => {
  const store = buildStore();
  // Seed a ticket we can edit while the modal is open.
  store.createTicket({ type: "user-story", title: "Pulse-me" }, HUMAN);
  const created = store.get().tickets.find(t => t.title === "Pulse-me");
  const ctx = makeCtx(store);
  modalMod.openTicketModal(ctx, created.id);
  const modal = document.querySelector(".modal");
  assert.ok(modal, "modal opened");

  // Local commit (reason = "updateTicket" via wrapOp) — should NOT pulse.
  store.updateTicket(created.id, { title: "Local edit" }, HUMAN);
  const titleNode = modal.querySelector('[data-sm-sync-key="title"]');
  assert.ok(!titleNode.classList.contains("sm-card-flash"),
    "local commits should not pulse the field");

  // External commit via applyRemote — SHOULD pulse the title field.
  const snap = JSON.parse(JSON.stringify(store.get()));
  const idx = snap.tickets.findIndex(t => t.id === created.id);
  snap.tickets[idx].title = "Remote edit";
  snap.tickets[idx].updatedAt = (snap.tickets[idx].updatedAt || 0) + 1;
  snap.tickets[idx].version  = (snap.tickets[idx].version  || 0) + 1;
  store.applyRemote(snap);
  assert.ok(titleNode.classList.contains("sm-card-flash"),
    "applyRemote should pulse the field that changed");
});

// ---------------------------------------------------------------------------
// SM-48 — Links section
// ---------------------------------------------------------------------------

function setupWithLinks() {
  const store = buildStore();
  // Two stories so we can link between them.
  store.createTicket({ type: "user-story", title: "Story-A" }, HUMAN);
  store.createTicket({ type: "user-story", title: "Story-B" }, HUMAN);
  const a = store.get().tickets.find(t => t.title === "Story-A");
  const b = store.get().tickets.find(t => t.title === "Story-B");
  return { store, a, b };
}

test("SM-48: Links-section is rendered at the bottom of the modal with forward + backward areas", () => {
  document.getElementById("modal-host").innerHTML = "";
  const { store, a } = setupWithLinks();
  const ctx = makeCtx(store);
  modalMod.openTicketModal(ctx, a.id);
  const modal = document.querySelector(".modal");
  const links = modal.querySelector('section.tm-links[data-sm-sync-key="links"]');
  assert.ok(links, "Links section present");
  assert.ok(links.querySelector(".tm-links-forward"), "forward host present");
  assert.ok(links.querySelector(".tm-links-backward"), "backward host present");
  // Empty by default.
  assert.ok(links.querySelector(".tm-links-forward .tm-links-empty"), "no outgoing links");
  assert.ok(links.querySelector(".tm-links-backward .tm-links-empty"), "no incoming links");
});

test("SM-48: forward link row appears after addLink + commits a remove via × button", () => {
  document.getElementById("modal-host").innerHTML = "";
  const { store, a, b } = setupWithLinks();
  // Pre-seed a link before opening the modal.
  store.addLink(a.id, { linkTypeId: "blocks", targetTicketId: b.id }, HUMAN);
  const ctx = makeCtx(store);
  modalMod.openTicketModal(ctx, a.id);
  let row = document.querySelector(".tm-links-forward .tm-link-row");
  assert.ok(row, "forward link row rendered");
  // Pill text = label of the link-type (forward).
  assert.strictEqual(row.querySelector(".tm-link-pill").textContent, "Blocks");
  // Target ref shows the target's ticket key and title.
  assert.ok(row.querySelector(".tm-link-key").textContent === b.ticketKey,
    "target key in row");
  // × removes — fires store.removeLink directly.
  row.querySelector(".tm-link-delete").click();
  const after = store.get().tickets.find(t => t.id === a.id);
  assert.strictEqual((after.links || []).length, 0, "link removed");
});

test("SM-48: backward link is found when another ticket targets this one (inverseLabel rendered)", () => {
  document.getElementById("modal-host").innerHTML = "";
  const { store, a, b } = setupWithLinks();
  // a blocks b → opening b's modal must show a backward link with inverse label.
  store.addLink(a.id, { linkTypeId: "blocks", targetTicketId: b.id }, HUMAN);
  const ctx = makeCtx(store);
  modalMod.openTicketModal(ctx, b.id);
  const bwd = document.querySelector(".tm-links-backward .tm-link-row");
  assert.ok(bwd, "backward link rendered on the target side");
  // The default linkType "blocks" has inverseLabel "Blocked by".
  assert.strictEqual(bwd.querySelector(".tm-link-pill").textContent, "Blocked by");
  // It's read-only — no delete button.
  assert.strictEqual(bwd.querySelector(".tm-link-delete"), null, "no × on backward row");
});

test("SM-48: findBackwardLinks is a pure helper that scans tickets[].links for inbound edges", () => {
  const { store, a, b } = setupWithLinks();
  store.addLink(a.id, { linkTypeId: "predecessor-of", targetTicketId: b.id }, HUMAN);
  const snap = store.get();
  const back = modalMod._internals.findBackwardLinks(snap, b.id);
  assert.strictEqual(back.length, 1, "one inbound edge");
  assert.strictEqual(back[0].sourceTicket.id, a.id);
  assert.strictEqual(back[0].link.targetTicketId, b.id);
  // For a ticket that nothing references: empty array.
  assert.deepStrictEqual(modalMod._internals.findBackwardLinks(snap, a.id), []);
});

test("SM-48: Live-Sync rebuilds the Links section when an external commit changes links", () => {
  document.getElementById("modal-host").innerHTML = "";
  const { store, a, b } = setupWithLinks();
  const ctx = makeCtx(store);
  modalMod.openTicketModal(ctx, a.id);
  const modal = document.querySelector(".modal");
  // Initially empty.
  assert.ok(modal.querySelector(".tm-links-forward .tm-links-empty"), "starts empty");
  // External commit: a snapshot where a links to b.
  const snap = JSON.parse(JSON.stringify(store.get()));
  const ai = snap.tickets.findIndex(t => t.id === a.id);
  snap.tickets[ai].links = [{
    id: "ln-test1", linkTypeId: "blocks", targetTicketId: b.id,
    createdAt: Date.now(), createdBy: HUMAN
  }];
  snap.tickets[ai].updatedAt = (snap.tickets[ai].updatedAt || 0) + 1;
  snap.tickets[ai].version  = (snap.tickets[ai].version  || 0) + 1;
  store.applyRemote(snap);
  const row = modal.querySelector(".tm-links-forward .tm-link-row");
  assert.ok(row, "live-sync rebuilt the forward row");
  assert.strictEqual(row.querySelector(".tm-link-pill").textContent, "Blocks");
});

test("SM-48: diffSyncFieldKeys flags 'links' so pulseChangedFields glows the section", () => {
  const prev = { links: [] };
  const next = { links: [{ id: "x", linkTypeId: "blocks", targetTicketId: "t-target" }] };
  const keys = modalMod._internals.diffSyncFieldKeys(prev, next);
  assert.ok(keys.has("links"), "links key flagged in diff");
});

test("SM-48: + Add link is INLINE (expands a form inside the Links section, no second modal)", () => {
  document.getElementById("modal-host").innerHTML = "";
  const { store, a, b } = setupWithLinks();
  const ctx = makeCtx(store);
  modalMod.openTicketModal(ctx, a.id);
  // Exactly one modal exists — the ticket-detail modal. Clicking "+ Add link"
  // must NOT open a second modal (which would hide the ticket the user is editing).
  const modalsBefore = document.querySelectorAll(".modal").length;
  assert.strictEqual(modalsBefore, 1, "exactly one modal open");
  const addBtn = document.querySelector(".tm-link-add");
  assert.ok(addBtn, "+ Add link trigger present");
  addBtn.click();
  const modalsAfter = document.querySelectorAll(".modal").length;
  assert.strictEqual(modalsAfter, 1, "no second modal opened");
  // Inline form is now visible and the trigger is hidden.
  const form = document.querySelector(".tm-link-add-form");
  assert.ok(form, "inline form is rendered");
  assert.notStrictEqual(form.style.display, "none", "form is visible after click");
  // Form has the three required controls.
  assert.ok(form.querySelector(".tm-add-link-type"),    "type select present");
  assert.ok(form.querySelector(".tm-add-link-filter"),  "filter input present");
  assert.ok(form.querySelector(".tm-link-add-submit"),  "add submit button present");
  assert.ok(form.querySelector(".tm-link-add-cancel"),  "cancel button present");
});

test("SM-48: inline combobox filters target list by ticketKey + title; selecting populates input + enables Add", () => {
  document.getElementById("modal-host").innerHTML = "";
  const { store, a, b } = setupWithLinks();
  const ctx = makeCtx(store);
  modalMod.openTicketModal(ctx, a.id);
  document.querySelector(".tm-link-add").click();
  const filterInput = document.querySelector(".tm-add-link-filter");
  // Focus shows popover with all matches.
  filterInput.dispatchEvent(new dom.window.Event("focus"));
  let options = document.querySelectorAll(".tm-link-combo-option");
  assert.ok(options.length >= 1, "popover renders at least one option");
  // Type the prefix of B's ticketKey or title to filter.
  filterInput.value = "Story-B";
  filterInput.dispatchEvent(new dom.window.Event("input"));
  options = document.querySelectorAll(".tm-link-combo-option");
  assert.strictEqual(options.length, 1, "filter narrows to one");
  assert.ok(options[0].textContent.indexOf("Story-B") >= 0);
  // mousedown selects (chosen over click so it fires before blur hides popover).
  options[0].dispatchEvent(new dom.window.Event("mousedown", { bubbles: true, cancelable: true }));
  assert.ok(filterInput.value.indexOf("Story-B") >= 0, "input populated with display string");
  // Submit creates the link and re-collapses the form.
  document.querySelector(".tm-link-add-submit").click();
  const aAfter = store.get().tickets.find(t => t.id === a.id);
  assert.strictEqual((aAfter.links || []).length, 1, "link created");
  assert.strictEqual(aAfter.links[0].targetTicketId, b.id, "correct target");
  // Form is collapsed again; trigger button is visible.
  const form = document.querySelector(".tm-link-add-form");
  assert.strictEqual(form.style.display, "none", "form collapsed after submit");
  assert.notStrictEqual(document.querySelector(".tm-link-add").style.display, "none",
    "trigger visible again");
});

test("SM-48: Cancel collapses the inline form without committing anything", () => {
  document.getElementById("modal-host").innerHTML = "";
  const { store, a } = setupWithLinks();
  const before = (store.get().tickets.find(t => t.id === a.id).links || []).length;
  const ctx = makeCtx(store);
  modalMod.openTicketModal(ctx, a.id);
  document.querySelector(".tm-link-add").click();
  document.querySelector(".tm-link-add-cancel").click();
  const after = (store.get().tickets.find(t => t.id === a.id).links || []).length;
  assert.strictEqual(after, before, "no link added on cancel");
  const form = document.querySelector(".tm-link-add-form");
  assert.strictEqual(form.style.display, "none", "form is hidden after cancel");
});

test("SM-48: showLinks=false in entityTypeConfig hides the section", () => {
  document.getElementById("modal-host").innerHTML = "";
  const { store, a } = setupWithLinks();
  // Disable links for user-story.
  store.updateProject({ entityTypeConfig: { "user-story": { showLinks: false } } }, HUMAN);
  const ctx = makeCtx(store);
  modalMod.openTicketModal(ctx, a.id);
  const links = document.querySelector('section.tm-links');
  assert.strictEqual(links, null, "section omitted when showLinks=false");
});

// ---------------------------------------------------------------------------
// SM-54 — Test-Definition: Prerequisites + Steps sections
// ---------------------------------------------------------------------------

function setupTestDefinition() {
  document.getElementById("modal-host").innerHTML = "";
  const store = buildStore();
  store.createTicket({
    type: "test-definition",
    title: "Login test",
    prerequisites: [
      { id: "tpre-1", label: "User exists",   required: true,  checked: false },
      { id: "tpre-2", label: "DB seeded",     required: false, checked: false }
    ],
    steps: [
      { id: "tstep-1", step: "Open page",        data: "",         expectedResult: "Page renders" },
      { id: "tstep-2", step: "Enter creds",      data: "u/p",      expectedResult: "Form accepts" }
    ]
  }, HUMAN);
  const ticket = store.get().tickets.find(t => t.title === "Login test");
  return { store, ticket };
}

test("SM-54: test-definition ticket renders Prerequisites + Steps sections (no AC)", () => {
  const { store, ticket } = setupTestDefinition();
  const ctx = makeCtx(store);
  modalMod.openTicketModal(ctx, ticket.id);
  const modal = document.querySelector(".modal");
  assert.ok(modal, "modal opens");
  // Sections render via their data-sm-sync-key wrappers.
  const prereqs = modal.querySelector('[data-sm-sync-key="prerequisites"]');
  const steps   = modal.querySelector('[data-sm-sync-key="steps"]');
  assert.ok(prereqs, "Prerequisites section must render for test-definition");
  assert.ok(steps,   "Steps section must render for test-definition");
  // AC section is hidden for test-definition by default.
  const ac = modal.querySelector(".tm-ac-section");
  assert.strictEqual(ac, null, "AC must be hidden for test-definition by default");
});

test("SM-54: Prerequisites rows render with grip + checked + label + required + delete", () => {
  const { store, ticket } = setupTestDefinition();
  const ctx = makeCtx(store);
  modalMod.openTicketModal(ctx, ticket.id);
  const modal = document.querySelector(".modal");
  const prereqs = modal.querySelector('[data-sm-sync-key="prerequisites"]');
  const rows = prereqs.querySelectorAll(".tm-prereq-row");
  assert.strictEqual(rows.length, 2, "two prereq rows");
  const r0 = rows[0];
  assert.ok(r0.querySelector(".tm-prereq-grip"),          "grip handle");
  assert.ok(r0.querySelector(".tm-prereq-checked"),       "checked checkbox");
  const labelInput = r0.querySelector(".tm-prereq-text-input");
  assert.strictEqual(labelInput.value, "User exists",     "label pre-filled");
  const requiredInput = r0.querySelector(".tm-prereq-required");
  assert.ok(requiredInput.checked,                        "required pre-filled = true");
  assert.ok(r0.querySelector(".tm-prereq-remove"),        "remove button");
  // "+ Add Prerequisite" trigger at end.
  assert.ok(prereqs.querySelector(".tm-prereq-add"), "+ Add Prerequisite present");
});

test("SM-54: Steps render as table rows with step / data / expectedResult inputs + delete", () => {
  const { store, ticket } = setupTestDefinition();
  const ctx = makeCtx(store);
  modalMod.openTicketModal(ctx, ticket.id);
  const modal = document.querySelector(".modal");
  const stepsSec = modal.querySelector('[data-sm-sync-key="steps"]');
  const rows = stepsSec.querySelectorAll(".tm-test-step-row");
  assert.strictEqual(rows.length, 2, "two step rows");
  const r0 = rows[0];
  assert.ok(r0.querySelector(".tm-test-step-grip"),     "grip handle");
  const stepInput = r0.querySelector(".tm-test-step-step");
  const dataInput = r0.querySelector(".tm-test-step-data");
  const expectedInput = r0.querySelector(".tm-test-step-expected");
  assert.strictEqual(stepInput.value,     "Open page",     "step input pre-filled");
  assert.strictEqual(dataInput.value,     "",              "data input pre-filled (empty ok)");
  assert.strictEqual(expectedInput.value, "Page renders",  "expected input pre-filled");
  assert.ok(r0.querySelector(".tm-test-step-remove"),     "remove button");
  // "+ Add Step" trigger at end.
  assert.ok(stepsSec.querySelector(".tm-test-step-add"), "+ Add Step present");
});

test("SM-54: + Add Prerequisite appends a new empty row", () => {
  const { store, ticket } = setupTestDefinition();
  const ctx = makeCtx(store);
  modalMod.openTicketModal(ctx, ticket.id);
  const modal = document.querySelector(".modal");
  const prereqs = modal.querySelector('[data-sm-sync-key="prerequisites"]');
  const before = prereqs.querySelectorAll(".tm-prereq-row").length;
  prereqs.querySelector(".tm-prereq-add").click();
  const after = prereqs.querySelectorAll(".tm-prereq-row").length;
  assert.strictEqual(after, before + 1, "+ Add Prerequisite appends a row");
});

test("SM-54: + Add Step appends a new empty row in the steps table", () => {
  const { store, ticket } = setupTestDefinition();
  const ctx = makeCtx(store);
  modalMod.openTicketModal(ctx, ticket.id);
  const modal = document.querySelector(".modal");
  const stepsSec = modal.querySelector('[data-sm-sync-key="steps"]');
  const before = stepsSec.querySelectorAll(".tm-test-step-row").length;
  stepsSec.querySelector(".tm-test-step-add").click();
  const after = stepsSec.querySelectorAll(".tm-test-step-row").length;
  assert.strictEqual(after, before + 1, "+ Add Step appends a row");
});

test("SM-54: removing a prereq row removes it from collectFormState", () => {
  const { store, ticket } = setupTestDefinition();
  const ctx = makeCtx(store);
  modalMod.openTicketModal(ctx, ticket.id);
  const modal = document.querySelector(".modal");
  const prereqs = modal.querySelector('[data-sm-sync-key="prerequisites"]');
  prereqs.querySelector(".tm-prereq-row .tm-prereq-remove").click();
  const state = modalMod._internals.collectFormState(modal);
  assert.strictEqual(state.prerequisites.length, 1, "one prereq left after remove");
  assert.strictEqual(state.prerequisites[0].label, "DB seeded");
});

test("SM-54: collectFormState reads prerequisites + steps from DOM in current order", () => {
  const { store, ticket } = setupTestDefinition();
  const ctx = makeCtx(store);
  modalMod.openTicketModal(ctx, ticket.id);
  const modal = document.querySelector(".modal");
  // Reorder prereq rows in DOM (swap 0 + 1).
  const prereqList = modal.querySelector('[data-sm-sync-key="prerequisites"] .tm-prereq-list');
  const pRows = Array.from(prereqList.children);
  prereqList.insertBefore(pRows[1], pRows[0]);
  // Edit a step's "data" field.
  const stepDataInputs = modal.querySelectorAll(".tm-test-step-data");
  stepDataInputs[0].value = "edited-data";
  const state = modalMod._internals.collectFormState(modal);
  assert.deepStrictEqual(state.prerequisites.map(p => p.label), ["DB seeded", "User exists"],
    "prereq order follows DOM");
  assert.strictEqual(state.steps[0].data, "edited-data");
  assert.strictEqual(state.steps[0].step, "Open page");
  assert.strictEqual(state.steps[1].expectedResult, "Form accepts");
});

test("SM-54: empty-label prereq + all-empty step are dropped on collect", () => {
  const { store, ticket } = setupTestDefinition();
  const ctx = makeCtx(store);
  modalMod.openTicketModal(ctx, ticket.id);
  const modal = document.querySelector(".modal");
  // Add an empty prereq row (label stays blank).
  modal.querySelector(".tm-prereq-add").click();
  // Add an empty step row (all three inputs blank).
  modal.querySelector(".tm-test-step-add").click();
  const state = modalMod._internals.collectFormState(modal);
  // Still 2 prereqs + 2 steps — the empty rows are dropped.
  assert.strictEqual(state.prerequisites.length, 2, "empty-label prereq dropped");
  assert.strictEqual(state.steps.length, 2,         "all-empty step row dropped");
});

test("SM-54: buildUpdatePatch includes prerequisites + steps when changed", () => {
  const { store, ticket } = setupTestDefinition();
  const ctx = makeCtx(store);
  modalMod.openTicketModal(ctx, ticket.id);
  const modal = document.querySelector(".modal");
  // Mutate a prereq label.
  const firstPrereqInput = modal.querySelector(".tm-prereq-text-input");
  firstPrereqInput.value = "User exists (renamed)";
  // Mutate a step step-text.
  const firstStepInput = modal.querySelector(".tm-test-step-step");
  firstStepInput.value = "Open login page (renamed)";
  const form = modalMod._internals.collectFormState(modal);
  const patch = modalMod._internals.buildUpdatePatch(form, ticket);
  assert.ok(patch.prerequisites, "patch includes prerequisites");
  assert.strictEqual(patch.prerequisites[0].label, "User exists (renamed)");
  assert.ok(patch.steps, "patch includes steps");
  assert.strictEqual(patch.steps[0].step, "Open login page (renamed)");
});

test("SM-54: buildUpdatePatch OMITS prereqs/steps when nothing changed (structural equality)", () => {
  const { ticket } = setupTestDefinition();
  // Form mirrors ticket exactly.
  const form = {
    title: ticket.title, type: ticket.type, status: ticket.status,
    description: ticket.description,
    position: { releaseId: null, processStepId: null, epicId: null },
    acceptanceCriteria: [], labels: [],
    prerequisites: ticket.prerequisites.map(p => ({ id: p.id, label: p.label, required: p.required, checked: p.checked })),
    steps:         ticket.steps.map(s => ({ id: s.id, step: s.step, data: s.data, expectedResult: s.expectedResult }))
  };
  const patch = modalMod._internals.buildUpdatePatch(form, ticket);
  assert.ok(!("prerequisites" in patch), "prerequisites omitted when unchanged");
  assert.ok(!("steps" in patch),         "steps omitted when unchanged");
});

test("SM-54: Type-switch in Create-Mode reveals Prereqs+Steps when switching TO test-definition", () => {
  const { store } = setupTestDefinition();
  const ctx = makeCtx(store);
  // Open Create-mode as user-story (no prereqs/steps visible initially).
  modalMod.openTicketModal(ctx, null, { draft: { type: "user-story" } });
  const modal = document.querySelector(".modal");
  assert.strictEqual(modal.querySelector('[data-sm-sync-key="prerequisites"]'), null,
    "no prereqs initially for user-story");
  assert.strictEqual(modal.querySelector('[data-sm-sync-key="steps"]'), null,
    "no steps initially for user-story");
  // Switch type to test-definition.
  const typeSel = modal.querySelector('[data-sm-sync-key="type"]');
  typeSel.value = "test-definition";
  typeSel.dispatchEvent(new window.Event("change", { bubbles: true }));
  // Sections appear, AC vanishes.
  assert.ok(modal.querySelector('[data-sm-sync-key="prerequisites"]'),
    "Prereqs render after type switch to test-definition");
  assert.ok(modal.querySelector('[data-sm-sync-key="steps"]'),
    "Steps render after type switch to test-definition");
  assert.strictEqual(modal.querySelector(".tm-ac-section"), null,
    "AC hidden after type switch to test-definition");
});

test("SM-54: Live-Sync rebuilds Prereqs + Steps when an external commit changes them", () => {
  const { store, ticket } = setupTestDefinition();
  const ctx = makeCtx(store);
  modalMod.openTicketModal(ctx, ticket.id);
  const modal = document.querySelector(".modal");
  const prereqsWrap = modal.querySelector('[data-sm-sync-key="prerequisites"]');
  const stepsWrap   = modal.querySelector('[data-sm-sync-key="steps"]');
  assert.strictEqual(prereqsWrap.querySelectorAll(".tm-prereq-row").length, 2);
  // External commit: add a 3rd prereq + delete steps.
  store.updateTicket(ticket.id, {
    prerequisites: [
      { id: "tpre-1", label: "User exists", required: true,  checked: false },
      { id: "tpre-2", label: "DB seeded",   required: false, checked: false },
      { id: "tpre-3", label: "External",    required: true,  checked: true }
    ],
    steps: []
  }, HUMAN);
  // Live-sync rebuilds the section.
  assert.strictEqual(prereqsWrap.querySelectorAll(".tm-prereq-row").length, 3,
    "live-sync added the 3rd prereq row");
  const lastLabel = prereqsWrap.querySelectorAll(".tm-prereq-text-input")[2];
  assert.strictEqual(lastLabel.value, "External");
  assert.strictEqual(stepsWrap.querySelectorAll(".tm-test-step-row").length, 0,
    "live-sync emptied the steps table");
});

test("SM-54: diffSyncFieldKeys flags 'prerequisites' and 'steps'", () => {
  const prev = { title: "T", type: "test-definition", status: "backlog", labels: [], position: {},
                 prerequisites: [{ id: "p1", label: "A", required: true, checked: false }],
                 steps: [] };
  const next = { title: "T", type: "test-definition", status: "backlog", labels: [], position: {},
                 prerequisites: [{ id: "p1", label: "A-changed", required: true, checked: false }],
                 steps: [{ id: "s1", step: "do", data: "", expectedResult: "ok" }] };
  const keys = modalMod._internals.diffSyncFieldKeys(prev, next);
  assert.ok(keys.has("prerequisites"));
  assert.ok(keys.has("steps"));
});

test("SM-54: entityTypeConfig.showPrerequisites=false hides only the prereqs section", () => {
  const { store, ticket } = setupTestDefinition();
  store.updateProject({
    entityTypeConfig: { "test-definition": { showPrerequisites: false } }
  }, HUMAN);
  const ctx = makeCtx(store);
  modalMod.openTicketModal(ctx, ticket.id);
  const modal = document.querySelector(".modal");
  assert.strictEqual(modal.querySelector('[data-sm-sync-key="prerequisites"]'), null,
    "Prereqs section hidden when showPrerequisites=false");
  // Steps still render (independent flag).
  assert.ok(modal.querySelector('[data-sm-sync-key="steps"]'),
    "Steps still render when only showPrerequisites is off");
});

// ---------------------------------------------------------------------------
// SM-70 — Test-Definition Modal: outgoing 'tests' link picker in Create-mode
// ---------------------------------------------------------------------------

test("SM-70: Create-mode for test-definition renders the inline + Add link button", () => {
  document.getElementById("modal-host").innerHTML = "";
  const store = buildStore();
  // Need a target ticket to link to.
  store.createTicket({ type: "user-story", title: "Target" }, HUMAN);
  const ctx = makeCtx(store);
  modalMod.openTicketModal(ctx, null, { draft: { type: "test-definition" } });
  const modal = document.querySelector(".modal");
  const links = modal.querySelector('[data-sm-sync-key="links"]');
  assert.ok(links, "Links section renders in create-mode");
  const add = links.querySelector(".tm-link-add");
  assert.ok(add, "+ Add link button is present in create-mode (was hidden before SM-70)");
});

test("SM-70: Type-select pre-selects 'tests' for test-definition", () => {
  document.getElementById("modal-host").innerHTML = "";
  const store = buildStore();
  store.createTicket({ type: "user-story", title: "Target" }, HUMAN);
  const ctx = makeCtx(store);
  modalMod.openTicketModal(ctx, null, { draft: { type: "test-definition" } });
  const modal = document.querySelector(".modal");
  // Expand the add-form.
  modal.querySelector(".tm-link-add").click();
  const typeSel = modal.querySelector(".tm-add-link-type");
  assert.strictEqual(typeSel.value, "tests");
});

test("SM-70: Adding a pending link via inline form renders it in the forward list and clears the empty-state", () => {
  document.getElementById("modal-host").innerHTML = "";
  const store = buildStore();
  store.createTicket({ type: "user-story", title: "Target" }, HUMAN);
  const target = store.get().tickets.find(t => t.title === "Target");
  const ctx = makeCtx(store);
  modalMod.openTicketModal(ctx, null, { draft: { type: "test-definition" } });
  const modal = document.querySelector(".modal");
  const links = modal.querySelector('[data-sm-sync-key="links"]');
  assert.ok(links.querySelector(".tm-links-forward .tm-links-empty"), "starts with forward-empty-state");

  // Simulate selecting + adding the link by driving the same input event the
  // combobox listens for (JSDOM's focus dispatch doesn't always propagate
  // through the handler chain, but input does).
  modal.querySelector(".tm-link-add").click();
  modal.querySelector(".tm-add-link-type").value = "tests";
  const filterInput = modal.querySelector(".tm-add-link-filter");
  filterInput.value = target.ticketKey || target.id;
  filterInput.dispatchEvent(new window.Event("input"));
  const opt = modal.querySelector(".tm-link-combo-option");
  assert.ok(opt, "popover surfaces the target ticket after input event");
  // mousedown is what the form listens for (preempts blur-hide).
  const md = new window.MouseEvent("mousedown", { bubbles: true, cancelable: true });
  opt.dispatchEvent(md);
  modal.querySelector(".tm-link-add-submit").click();

  // After add: forward row visible with the link, forward-empty-state gone.
  const linksAfter = modal.querySelector('[data-sm-sync-key="links"]');
  const fwd = linksAfter.querySelector(".tm-links-forward");
  assert.strictEqual(fwd.querySelectorAll(".tm-link-row").length, 1, "one forward row rendered");
  assert.strictEqual(fwd.querySelector(".tm-links-empty"), null, "forward-empty-state cleared");
});

test("SM-70: createOnSave blocks test-definition WITHOUT any 'tests' link (banner)", async () => {
  document.getElementById("modal-host").innerHTML = "";
  const store = buildStore();
  const ctx = makeCtx(store);
  modalMod.openTicketModal(ctx, null, { draft: { type: "test-definition" } });
  const modal = document.querySelector(".modal");
  // Fill required title so the title-gate doesn't fire first.
  modal.querySelector('[data-sm-sync-key="title"]').value = "Login test";
  // Simulate the Create button.
  const internals = modalMod._internals;
  const ticketsBefore = store.get().tickets.length;
  const result = await internals.createOnSave(ctx, modal,
    { type: "test-definition", title: "", description: "", position: { sortOrder: 0 }, links: [] },
    {});
  assert.strictEqual(result, false, "save refused");
  const banner = modal.querySelector('[data-sm-sync-key="_error_banner"]');
  assert.ok(banner && banner.style.display !== "none", "banner shows");
  assert.match(banner.textContent, /must link to at least one ticket/i);
  assert.strictEqual(store.get().tickets.length, ticketsBefore, "no ticket created");
});

test("SM-70: pending-link dedup blocks adding the same (linkTypeId, targetTicketId) twice", () => {
  document.getElementById("modal-host").innerHTML = "";
  const store = buildStore();
  store.createTicket({ type: "user-story", title: "Target" }, HUMAN);
  const target = store.get().tickets.find(t => t.title === "Target");
  let flashed = null;
  const ctx = makeCtx(store, { flashStatus: (msg, opts) => { flashed = { msg, opts }; } });
  modalMod.openTicketModal(ctx, null, { draft: { type: "test-definition" } });
  const modal = document.querySelector(".modal");

  function addOnce() {
    modal.querySelector(".tm-link-add").click();
    modal.querySelector(".tm-add-link-type").value = "tests";
    const filterInput = modal.querySelector(".tm-add-link-filter");
    filterInput.value = target.ticketKey || target.id;
    filterInput.dispatchEvent(new window.Event("input"));
    const opt = modal.querySelector(".tm-link-combo-option");
    opt.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    modal.querySelector(".tm-link-add-submit").click();
  }

  addOnce();
  const after1 = modal.querySelector(".tm-links-forward").querySelectorAll(".tm-link-row").length;
  assert.strictEqual(after1, 1, "first add lands");
  addOnce();
  const after2 = modal.querySelector(".tm-links-forward").querySelectorAll(".tm-link-row").length;
  assert.strictEqual(after2, 1, "second identical add is suppressed");
  assert.ok(flashed && /already added/i.test(flashed.msg), "user sees the dedup feedback");
});

test("SM-70: createOnSave passes pending links into store.createTicket", async () => {
  document.getElementById("modal-host").innerHTML = "";
  const store = buildStore();
  store.createTicket({ type: "user-story", title: "Target" }, HUMAN);
  const target = store.get().tickets.find(t => t.title === "Target");
  const ctx = makeCtx(store);
  modalMod.openTicketModal(ctx, null, { draft: { type: "test-definition" } });
  const modal = document.querySelector(".modal");
  modal.querySelector('[data-sm-sync-key="title"]').value = "Login test";

  // Run createOnSave with a draftInitial that already carries a pending link
  // (simulates what the inline form mutates into).
  const draftInitial = {
    type: "test-definition", title: "Login test", description: "",
    position: { sortOrder: 0 },
    links: [{ id: "ln-pending-x", linkTypeId: "tests", targetTicketId: target.id }]
  };
  const ticketsBefore = store.get().tickets.length;
  const internals = modalMod._internals;
  await internals.createOnSave(ctx, modal, draftInitial, {});
  assert.strictEqual(store.get().tickets.length, ticketsBefore + 1, "ticket created");
  const created = store.get().tickets.find(t => t.title === "Login test");
  assert.ok(created, "new ticket present");
  const linkToTarget = created.links.find(l => l.linkTypeId === "tests" && l.targetTicketId === target.id);
  assert.ok(linkToTarget, "the 'tests' link was persisted on the new ticket");
});

// ---------------------------------------------------------------------------
// SM-77-followup — Epic-Dropdown reads the live contains-link container
//   (NOT the stale ticket.position.epicId which is always null after SM-52).
//   Regression of the "no-op save deletes container" bug.
// ---------------------------------------------------------------------------

test("SM-77-followup: Epic dropdown selects the actual contains-link container, not position.epicId", () => {
  document.getElementById("modal-host").innerHTML = "";
  const store = buildStore();   // already creates one Epic E1 with no position
  // Re-place E1 into the only release/processStep cell so it's a valid epic
  // candidate, then add a story into the same cell — auto-epic-assignment
  // wires the contains-link.
  const snap0 = store.get();
  const rId = snap0.releases[0].id;
  const psId = snap0.processSteps[0].id;
  const epic = snap0.tickets.find(t => t.type === "epic");
  store.moveTicket(epic.id, { releaseId: rId, processStepId: psId, epicId: null }, HUMAN);
  store.createTicket({ type: "user-story", title: "ContainedStory",
    position: { releaseId: rId, processStepId: psId } }, HUMAN);
  const story = store.get().tickets.find(t => t.title === "ContainedStory");
  // Sanity: position.epicId is null after SM-52, but containerEpicIdOf returns the epic.
  assert.strictEqual(story.position.epicId, null);
  const core = require("../frontend/js/core.js");
  assert.strictEqual(core.containerEpicIdOf(store.get(), story.id), epic.id,
    "container is the epic, via the contains-link");

  const ctx = makeCtx(store);
  modalMod.openTicketModal(ctx, story.id);
  const modal = document.querySelector(".modal");
  const epicSel = modal.querySelector('[data-sm-sync-key="position.epicId"]');
  assert.ok(epicSel, "Epic dropdown rendered");
  assert.strictEqual(epicSel.value, epic.id,
    "Epic dropdown shows the actual container, not '— none —'");
});

test("SM-77-followup: committing an unrelated field in-place does NOT delete the contains-link", () => {
  document.getElementById("modal-host").innerHTML = "";
  const store = buildStore();
  const snap0 = store.get();
  const rId = snap0.releases[0].id;
  const psId = snap0.processSteps[0].id;
  const epic = snap0.tickets.find(t => t.type === "epic");
  store.moveTicket(epic.id, { releaseId: rId, processStepId: psId, epicId: null }, HUMAN);
  store.createTicket({ type: "user-story", title: "StayContained",
    position: { releaseId: rId, processStepId: psId } }, HUMAN);
  const story = store.get().tickets.find(t => t.title === "StayContained");
  const ctx = makeCtx(store);
  modalMod.openTicketModal(ctx, story.id);
  const modal = document.querySelector(".modal");

  // SM-120/B5b: no Save button — edit the title and blur (in-place commit).
  // The position diff must keep the contains-link container (SM-77 regression).
  const titleInput = modal.querySelector('[data-sm-sync-key="title"]');
  titleInput.value = "StayContained (edited)";
  titleInput.dispatchEvent(new window.Event("focusout", { bubbles: true }));

  const after = store.get();
  assert.strictEqual(after.tickets.find(t => t.id === story.id).title, "StayContained (edited)",
    "title committed in place");
  assert.strictEqual(core.containerEpicIdOf(after, story.id), epic.id,
    "contains-link preserved when committing an unrelated field");
});

test("SM-77-followup: clearing the Epic dropdown to '— none —' removes the contains-link (in-place)", () => {
  document.getElementById("modal-host").innerHTML = "";
  const store = buildStore();
  const snap0 = store.get();
  const rId = snap0.releases[0].id;
  const psId = snap0.processSteps[0].id;
  const epic = snap0.tickets.find(t => t.type === "epic");
  store.moveTicket(epic.id, { releaseId: rId, processStepId: psId, epicId: null }, HUMAN);
  store.createTicket({ type: "user-story", title: "BreakAway",
    position: { releaseId: rId, processStepId: psId } }, HUMAN);
  const story = store.get().tickets.find(t => t.title === "BreakAway");
  const ctx = makeCtx(store);
  modalMod.openTicketModal(ctx, story.id);
  const modal = document.querySelector(".modal");
  const epicSel = modal.querySelector('[data-sm-sync-key="position.epicId"]');
  // User clears the dropdown — explicit "remove from epic"; the change event
  // commits in place (no Save button).
  epicSel.value = "";
  epicSel.dispatchEvent(new window.Event("change", { bubbles: true }));

  assert.strictEqual(core.containerEpicIdOf(store.get(), story.id), null,
    "contains-link removed when user explicitly picks '— none —'");
});

test("SM-120/B5b: the modal has NO Save button; a discrete edit commits in place", () => {
  const { store, story } = setup();
  const ctx = makeCtx(store);
  modalMod.openTicketModal(ctx, story.id);
  const modal = document.querySelector(".modal");
  const hasSave = Array.from(modal.querySelectorAll("button")).some(b => b.textContent.trim() === "Save");
  assert.ok(!hasSave, "no Save button in edit-mode");
  const typeSel = modal.querySelector('[data-sm-sync-key="type"]');
  typeSel.value = "bug";
  typeSel.dispatchEvent(new window.Event("change", { bubbles: true }));
  assert.strictEqual(store.get().tickets.find(t => t.id === story.id).type, "bug",
    "type change committed in place (no Save)");
});

test("SM-122/B7: edit-mode modal title is a link to the full-page editor", () => {
  const { store, story } = setup();
  const ctx = makeCtx(store);
  modalMod.openTicketModal(ctx, story.id);
  const modal = document.querySelector(".modal");
  const link = modal.querySelector("h2 a.tm-fullpage-link");
  assert.ok(link, "title is rendered as a full-page link");
  // SM-158: the link uses the human ticket-KEY, not the internal id.
  assert.strictEqual(link.getAttribute("href"), "/editor?projectId=p1&ticketId=" + story.ticketKey);
  assert.ok(/MyStory/.test(link.textContent), "link carries the ticket title");
});

test("SM-122/B7: create-mode modal title is NOT a link (ticket doesn't exist yet)", () => {
  const store = buildStore();
  const ctx = makeCtx(store);
  modalMod.openTicketModal(ctx, null, { draft: { type: "user-story" } });
  const modal = document.querySelector(".modal");
  assert.strictEqual(modal.querySelector("h2 a.tm-fullpage-link"), null, "no full-page link in create-mode");
});

// ---------------------------------------------------------------------------
// SM-73 — Modal Delete falls back to ctx.store.softDeleteTicket when no
//         opts.onDelete is wired by the caller (was a silent no-op before).
// ---------------------------------------------------------------------------

test("SM-73: Delete button without opts.onDelete falls back to ctx.store.softDeleteTicket", async () => {
  document.getElementById("modal-host").innerHTML = "";
  const store = buildStore();
  store.createTicket({ type: "user-story", title: "DeleteMe" }, HUMAN);
  const target = store.get().tickets.find(t => t.title === "DeleteMe");
  assert.strictEqual(target.isDeleted, false, "starts not deleted");
  const ctx = makeCtx(store);
  modalMod.openTicketModal(ctx, target.id, {});   // NO onDelete
  const modal = document.querySelector(".modal");
  const deleteBtn = Array.from(modal.querySelectorAll("button"))
    .find(b => b.textContent.trim() === "Delete");
  assert.ok(deleteBtn, "Delete button rendered in edit-mode");
  deleteBtn.click();
  // Allow async onClick to resolve.
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  const after = store.get().tickets.find(t => t.id === target.id);
  assert.strictEqual(after.isDeleted, true, "ticket was soft-deleted via fallback");
});

test("SM-73: explicit opts.onDelete still wins when supplied", async () => {
  document.getElementById("modal-host").innerHTML = "";
  const store = buildStore();
  store.createTicket({ type: "user-story", title: "DeleteMe2" }, HUMAN);
  const target = store.get().tickets.find(t => t.title === "DeleteMe2");
  let onDeleteCalled = false;
  const ctx = makeCtx(store);
  modalMod.openTicketModal(ctx, target.id, {
    onDelete: () => { onDeleteCalled = true; /* do nothing, override */ }
  });
  const modal = document.querySelector(".modal");
  const deleteBtn = Array.from(modal.querySelectorAll("button"))
    .find(b => b.textContent.trim() === "Delete");
  deleteBtn.click();
  await Promise.resolve(); await Promise.resolve();
  assert.strictEqual(onDeleteCalled, true, "override fired");
  const after = store.get().tickets.find(t => t.id === target.id);
  assert.strictEqual(after.isDeleted, false, "no fallback when override is provided");
});

// ---------------------------------------------------------------------------
// SM-71 — Test-Execution starter: must link a Test-Definition
// ---------------------------------------------------------------------------

test("SM-71: openTestExecutionStarter shows empty-state when no test-definitions exist", () => {
  document.getElementById("modal-host").innerHTML = "";
  const store = buildStore();
  const ctx = makeCtx(store);
  modalMod.openTestExecutionStarter(ctx, {}, {});
  const modal = document.querySelector(".modal");
  assert.ok(modal, "starter modal opens");
  const empty = modal.querySelector(".tm-test-exec-empty");
  assert.ok(empty, "empty-state rendered");
  assert.match(empty.textContent, /No test-definitions/i);
  assert.strictEqual(modal.querySelector(".tm-test-exec-def-select"), null,
    "no picker when there are no defs to pick");
});

test("SM-71: starter renders a Test-Definition select listing all defs in the project", () => {
  document.getElementById("modal-host").innerHTML = "";
  const store = buildStore();
  // Create a user-story to satisfy the SM-70 'tests'-link requirement.
  store.createTicket({ type: "user-story", title: "Target" }, HUMAN);
  const target = store.get().tickets.find(t => t.title === "Target");
  store.createTicket({ type: "test-definition", title: "Def A",
    links: [{ linkTypeId: "tests", targetTicketId: target.id }],
    steps: [{ id: "tstep-1", step: "x", data: "", expectedResult: "ok" }] }, HUMAN);
  store.createTicket({ type: "test-definition", title: "Def B",
    links: [{ linkTypeId: "tests", targetTicketId: target.id }],
    steps: [{ id: "tstep-1", step: "y", data: "", expectedResult: "ok" }] }, HUMAN);
  const ctx = makeCtx(store);
  modalMod.openTestExecutionStarter(ctx, {}, {});
  const modal = document.querySelector(".modal");
  const sel = modal.querySelector(".tm-test-exec-def-select");
  assert.ok(sel, "picker rendered");
  assert.strictEqual(sel.querySelectorAll("option").length, 2, "two defs in the picker");
});

test("SM-71: clicking Start with no defs (empty-state) does NOT create a ticket and shows banner", async () => {
  document.getElementById("modal-host").innerHTML = "";
  const store = buildStore();
  const ctx = makeCtx(store);
  modalMod.openTestExecutionStarter(ctx, {}, {});
  const modal = document.querySelector(".modal");
  const startBtn = Array.from(modal.querySelectorAll("button"))
    .find(b => b.textContent.trim() === "Start");
  assert.ok(startBtn, "Start button present");
  const ticketsBefore = store.get().tickets.length;
  startBtn.click();
  // Allow async onClick to resolve.
  await Promise.resolve(); await Promise.resolve();
  const banner = modal.querySelector(".tm-test-exec-banner");
  assert.ok(banner && banner.style.display !== "none", "banner shows");
  assert.strictEqual(store.get().tickets.length, ticketsBefore, "no ticket created");
});

test("SM-71: Start surfaces a banner when startTestExecution throws (catch-handler path)", async () => {
  document.getElementById("modal-host").innerHTML = "";
  const store = buildStore();
  store.createTicket({ type: "user-story", title: "Target" }, HUMAN);
  const target = store.get().tickets.find(t => t.title === "Target");
  store.createTicket({ type: "test-definition", title: "Def",
    links: [{ linkTypeId: "tests", targetTicketId: target.id }],
    steps: [{ id: "tstep-1", step: "x", data: "", expectedResult: "ok" }] }, HUMAN);
  // Monkey-patch the store-op to force the catch path. `findTicket` doesn't
  // filter isDeleted today, so a soft-delete won't trigger it organically.
  store.startTestExecution = function () { throw new Error("boom from op"); };
  const ctx = makeCtx(store);
  modalMod.openTestExecutionStarter(ctx, {}, {});
  const modal = document.querySelector(".modal");
  const startBtn = Array.from(modal.querySelectorAll("button"))
    .find(b => b.textContent.trim() === "Start");
  startBtn.click();
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  const banner = modal.querySelector(".tm-test-exec-banner");
  assert.ok(banner && banner.style.display !== "none", "banner shown on op failure");
  assert.match(banner.textContent, /boom from op/);
});

test("SM-71: Start creates an exec-ticket via startTestExecution and clones the definition's steps", async () => {
  document.getElementById("modal-host").innerHTML = "";
  const store = buildStore();
  store.createTicket({ type: "user-story", title: "Target" }, HUMAN);
  const target = store.get().tickets.find(t => t.title === "Target");
  store.createTicket({ type: "test-definition", title: "Login flow",
    links: [{ linkTypeId: "tests", targetTicketId: target.id }],
    steps: [
      { id: "tstep-1", step: "Open page",   data: "",    expectedResult: "Page loads" },
      { id: "tstep-2", step: "Enter creds", data: "u/p", expectedResult: "Form accepts" }
    ]
  }, HUMAN);
  const def = store.get().tickets.find(t => t.title === "Login flow");
  const ctx = makeCtx(store);
  modalMod.openTestExecutionStarter(ctx, {}, {});
  const modal = document.querySelector(".modal");
  const sel = modal.querySelector(".tm-test-exec-def-select");
  sel.value = def.id;
  modal.querySelector(".tm-test-exec-env").value = "staging";
  const startBtn = Array.from(modal.querySelectorAll("button"))
    .find(b => b.textContent.trim() === "Start");
  startBtn.click();
  await Promise.resolve(); await Promise.resolve();

  const exec = store.get().tickets.find(t => t.type === "test-execution");
  assert.ok(exec, "execution ticket was created");
  assert.strictEqual(exec.referencedTestDefinitionId, def.id);
  assert.strictEqual(exec.env, "staging");
  assert.strictEqual(exec.executionSteps.length, 2, "steps cloned 1:1");
  assert.strictEqual(exec.executionSteps[0].stepId, "tstep-1", "stepId points back at definition");
  assert.strictEqual(exec.executionSteps[0].status, "pending");
  const execLink = exec.links.find(l => l.linkTypeId === "executes" && l.targetTicketId === def.id);
  assert.ok(execLink, "executes-link wired to the definition");
});

// ---------------------------------------------------------------------------
// SM-67 — Position-inheritance in the modal: Release + ProcessStep are
// read-only for stories with a container epic, and a hint shows which epic
// dictates them.
// ---------------------------------------------------------------------------

function setupContained() {
  document.getElementById("modal-host").innerHTML = "";
  const store = buildStore();
  // Place the epic at v1.0 / Onboarding.
  const snap0 = store.get();
  const rel = snap0.releases.find(r => r.name === "v1.0");
  const ps  = snap0.processSteps.find(p => p.name === "Onboarding");
  const epic = snap0.tickets.find(t => t.title === "E1");
  store.moveTicket(epic.id, { releaseId: rel.id, processStepId: ps.id, sortOrder: 0 }, HUMAN);
  // Contained story (epicId set; release/processStep inherited via SM-67).
  store.createTicket({
    type: "user-story", title: "Contained",
    position: { releaseId: rel.id, processStepId: ps.id, epicId: epic.id }
  }, HUMAN);
  const story = store.get().tickets.find(t => t.title === "Contained");
  return { store, story, epic, rel, ps };
}

test("SM-67: Release + ProcessStep render as disabled when a story has a container epic", () => {
  const { store, story } = setupContained();
  const ctx = makeCtx(store);
  modalMod.openTicketModal(ctx, story.id);
  const modal = document.querySelector(".modal");
  const releaseSel = modal.querySelector('[data-sm-sync-key="position.releaseId"]');
  const psSel = modal.querySelector('[data-sm-sync-key="position.processStepId"]');
  assert.ok(releaseSel, "Release select rendered");
  assert.ok(psSel, "ProcessStep select rendered");
  assert.strictEqual(releaseSel.disabled, true, "Release is disabled (inherited)");
  assert.strictEqual(psSel.disabled, true, "ProcessStep is disabled (inherited)");
});

test("SM-67: hint text identifies which epic dictates the inherited position", () => {
  const { store, story, epic } = setupContained();
  const ctx = makeCtx(store);
  modalMod.openTicketModal(ctx, story.id);
  const modal = document.querySelector(".modal");
  const hints = Array.from(modal.querySelectorAll(".tm-field-hint"));
  assert.ok(hints.length >= 2, "two hints rendered (Release + ProcessStep)");
  const expected = "Inherited from " + (epic.ticketKey || epic.title);
  assert.ok(hints[0].textContent.indexOf(expected) >= 0,
    "hint mentions epic, got: " + hints[0].textContent);
});

test("SM-67: clearing the Epic dropdown re-enables Release + ProcessStep + clears hint", () => {
  const { store, story } = setupContained();
  const ctx = makeCtx(store);
  modalMod.openTicketModal(ctx, story.id);
  const modal = document.querySelector(".modal");
  const epicSel = modal.querySelector('[data-sm-sync-key="position.epicId"]');
  const releaseSel = modal.querySelector('[data-sm-sync-key="position.releaseId"]');
  const psSel = modal.querySelector('[data-sm-sync-key="position.processStepId"]');
  assert.strictEqual(releaseSel.disabled, true);
  epicSel.value = "";
  epicSel.dispatchEvent(new dom.window.Event("change"));
  assert.strictEqual(releaseSel.disabled, false, "Release re-enabled after detach");
  assert.strictEqual(psSel.disabled, false, "ProcessStep re-enabled after detach");
  const hint = modal.querySelector(".tm-field-hint");
  assert.strictEqual(hint.textContent, "", "hint cleared");
});

test("SM-67: an EPIC ticket does NOT get inheritance — Release stays editable", () => {
  document.getElementById("modal-host").innerHTML = "";
  const store = buildStore();
  const snap0 = store.get();
  const rel = snap0.releases.find(r => r.name === "v1.0");
  const ps  = snap0.processSteps.find(p => p.name === "Onboarding");
  const epic = snap0.tickets.find(t => t.title === "E1");
  store.moveTicket(epic.id, { releaseId: rel.id, processStepId: ps.id, sortOrder: 0 }, HUMAN);
  const ctx = makeCtx(store);
  modalMod.openTicketModal(ctx, epic.id);
  const modal = document.querySelector(".modal");
  const releaseSel = modal.querySelector('[data-sm-sync-key="position.releaseId"]');
  assert.ok(releaseSel, "Release select rendered for epic");
  assert.strictEqual(releaseSel.disabled, false, "Epic's release stays editable");
});

// ---------------------------------------------------------------------------
// SM-57 — Test-Execution sections in the ticket-detail modal
// ---------------------------------------------------------------------------

function setupTestExecution() {
  document.getElementById("modal-host").innerHTML = "";
  // Use a project that already has v1.0 release + Onboarding process step
  // (buildStore seeds those + an epic E1). We need test-definition +
  // test-execution types in ticketTypes; buildStore's project doesn't
  // include them, so build a richer one inline.
  const snap = core.normalizeSnapshot({
    project: {
      id: "p1", name: "P", ticketPrefix: "P",
      ticketTypes: ["epic", "user-story", "bug", "test-definition", "test-execution"]
    }
  });
  const store = new ProjectStore(snap);
  // Need a story for the test-definition to link to (gate enforced by validateLink).
  store.createTicket({ type: "user-story", title: "Feature" }, HUMAN);
  const feature = store.get().tickets.find(t => t.title === "Feature");
  // Test-definition with 2 steps, linked to the feature.
  store.createTicket({
    type: "test-definition",
    title: "Login flow",
    steps: [
      { id: "step-1", step: "Open page",   data: "",       expectedResult: "Page loads" },
      { id: "step-2", step: "Enter creds", data: "u/p",    expectedResult: "Form accepts" }
    ],
    links: [{ linkTypeId: "tests", targetTicketId: feature.id }]
  }, HUMAN);
  const def = store.get().tickets.find(t => t.title === "Login flow");
  // Spawn an execution from the definition (clones steps + links).
  store.startTestExecution(def.id, { env: "staging" }, HUMAN);
  const exec = store.get().tickets.find(t => t.type === "test-execution");
  return { store, def, exec, feature };
}

test("SM-57: test-execution modal renders Header pill + Metadata + Steps-table + Outcome section", () => {
  const { store, exec } = setupTestExecution();
  const ctx = makeCtx(store);
  modalMod.openTicketModal(ctx, exec.id);
  const modal = document.querySelector(".modal");
  assert.ok(modal.querySelector(".tm-exec-header"),  "Header section");
  assert.ok(modal.querySelector(".tm-exec-meta"),    "Metadata strip");
  assert.ok(modal.querySelector(".tm-exec-steps"),   "Execution-steps section");
  assert.ok(modal.querySelector(".tm-exec-outcome"), "Outcome section");
});

test("SM-57: Header pill shows 'executes → DEF-KEY: Title' and links to the definition", () => {
  const { store, def, exec } = setupTestExecution();
  const ctx = makeCtx(store);
  modalMod.openTicketModal(ctx, exec.id);
  const pill = document.querySelector(".tm-exec-header-pill");
  assert.ok(pill, "pill rendered");
  assert.strictEqual(pill.querySelector(".tm-exec-header-key").textContent, def.ticketKey);
  assert.ok(pill.querySelector(".tm-exec-header-title").textContent.includes("Login flow"),
    "pill title includes definition title");
  // Click → openTicketModal(ctx, def.id) replaces the modal with the def's.
  pill.click();
  // The modal now shows the definition's ticketKey in the h2.
  const h2 = document.querySelector(".modal h2");
  assert.ok(h2.textContent.includes(def.ticketKey),
    "after click the modal h2 shows definition ticketKey, got: " + h2.textContent);
});

test("SM-57: Execution-steps table renders one row per step with step/data/expectedResult DISABLED", () => {
  const { store, exec } = setupTestExecution();
  const ctx = makeCtx(store);
  modalMod.openTicketModal(ctx, exec.id);
  const modal = document.querySelector(".modal");
  const rows = modal.querySelectorAll(".tm-exec-step-row");
  assert.strictEqual(rows.length, 2, "two rows for two cloned steps");
  for (const row of rows) {
    const stepEl = row.querySelector(".tm-exec-step-step");
    const dataEl = row.querySelector(".tm-exec-step-data");
    const expEl  = row.querySelector(".tm-exec-step-expected");
    assert.strictEqual(stepEl.disabled, true, "step is disabled");
    assert.strictEqual(dataEl.disabled, true, "data is disabled");
    assert.strictEqual(expEl.disabled,  true, "expectedResult is disabled");
  }
});

test("SM-57: actualResult, status, note are editable controls in each step row", () => {
  const { store, exec } = setupTestExecution();
  const ctx = makeCtx(store);
  modalMod.openTicketModal(ctx, exec.id);
  const row = document.querySelector(".tm-exec-step-row");
  const actual = row.querySelector(".tm-exec-step-actual");
  const status = row.querySelector(".tm-exec-step-status");
  const note   = row.querySelector(".tm-exec-step-note");
  assert.strictEqual(actual.disabled, false);
  assert.strictEqual(status.disabled, false);
  assert.strictEqual(note.disabled,   false);
  // Status enum populated from core.TEST_EXEC_STEP_STATUSES.
  const opts = Array.from(status.options).map(o => o.value);
  assert.deepStrictEqual(opts.sort(), ["blocked", "failed", "passed", "pending", "skipped"]);
});

test("SM-57: Add-/Remove-step buttons are NOT present in the execution-step table", () => {
  const { store, exec } = setupTestExecution();
  const ctx = makeCtx(store);
  modalMod.openTicketModal(ctx, exec.id);
  const section = document.querySelector(".tm-exec-steps");
  assert.strictEqual(section.querySelector(".tm-test-step-add"),    null, "no add-step button");
  assert.strictEqual(section.querySelector(".tm-test-step-remove"), null, "no remove-step button");
  assert.strictEqual(section.querySelector(".tm-test-step-insert"), null, "no insert-step button");
});

test("SM-57: Outcome section shows derived outcome + manual-override picker; hint hidden when 'auto'", () => {
  const { store, exec } = setupTestExecution();
  const ctx = makeCtx(store);
  modalMod.openTicketModal(ctx, exec.id);
  const pill = document.querySelector(".tm-exec-outcome-pill");
  assert.ok(pill, "derived pill rendered");
  // Two new exec-steps cloned with status='pending' → derived = 'pending'.
  assert.strictEqual(pill.dataset.outcome, "pending");
  const sel = document.querySelector(".tm-exec-outcome-override");
  assert.strictEqual(sel.value, "auto", "default override is auto");
  const opts = Array.from(sel.options).map(o => o.value);
  assert.deepStrictEqual(opts, ["auto", "pending", "passed", "failed", "blocked", "skipped"]);
  const hint = document.querySelector(".tm-exec-outcome-override-hint");
  assert.strictEqual(hint.style.display, "none", "hint hidden when auto");
});

test("SM-57: collectExecutionSteps reads back current row state (actualResult + status + note)", () => {
  const { store, exec } = setupTestExecution();
  const ctx = makeCtx(store);
  modalMod.openTicketModal(ctx, exec.id);
  const modal = document.querySelector(".modal");
  const row = modal.querySelector(".tm-exec-step-row");
  row.querySelector(".tm-exec-step-actual").value = "Worked";
  row.querySelector(".tm-exec-step-status").value = "passed";
  row.querySelector(".tm-exec-step-note").value   = "no issues";
  const out = modalMod._internals.collectExecutionSteps(modal);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].actualResult, "Worked");
  assert.strictEqual(out[0].status,       "passed");
  assert.strictEqual(out[0].note,         "no issues");
  assert.strictEqual(out[0].step, "Open page", "frozen step value preserved");
  // Row 2 was untouched → defaults.
  assert.strictEqual(out[1].status, "pending");
  assert.strictEqual(out[1].actualResult, "");
});

test("SM-57: buildUpdatePatch includes executionSteps when actualResult/status/note changed; skips when identical", () => {
  const { store, exec } = setupTestExecution();
  const ctx = makeCtx(store);
  modalMod.openTicketModal(ctx, exec.id);
  const modal = document.querySelector(".modal");
  const original = store.get().tickets.find(t => t.id === exec.id);
  // No-edit case: patch must NOT contain executionSteps.
  let form = modalMod._internals.collectFormState(modal);
  let patch = modalMod._internals.buildUpdatePatch(form, original);
  assert.strictEqual(patch.executionSteps, undefined,
    "patch should skip executionSteps when nothing changed");
  // Edit a row → patch should now include executionSteps.
  modal.querySelector(".tm-exec-step-row .tm-exec-step-actual").value = "Worked";
  modal.querySelector(".tm-exec-step-row .tm-exec-step-status").value = "passed";
  form = modalMod._internals.collectFormState(modal);
  patch = modalMod._internals.buildUpdatePatch(form, original);
  assert.ok(Array.isArray(patch.executionSteps), "executionSteps included after edit");
  assert.strictEqual(patch.executionSteps[0].actualResult, "Worked");
  assert.strictEqual(patch.executionSteps[0].status,       "passed");
});

test("SM-57: buildUpdatePatch sends outcomeOverride='auto' when user clears the override; otherwise the enum value", () => {
  const { store, exec } = setupTestExecution();
  const ctx = makeCtx(store);
  // Seed an existing override on the ticket so the diff is real.
  store.updateTicket(exec.id, { outcomeOverride: "passed" }, HUMAN);
  modalMod.openTicketModal(ctx, exec.id);
  const modal = document.querySelector(".modal");
  const original = store.get().tickets.find(t => t.id === exec.id);
  // No change → no patch.
  let patch = modalMod._internals.buildUpdatePatch(modalMod._internals.collectFormState(modal), original);
  assert.strictEqual(patch.outcomeOverride, undefined);
  // User flips override → 'auto' → clear.
  modal.querySelector(".tm-exec-outcome-override").value = "auto";
  patch = modalMod._internals.buildUpdatePatch(modalMod._internals.collectFormState(modal), original);
  assert.strictEqual(patch.outcomeOverride, "auto",
    "clearing override sends 'auto' so server resets to null");
  // User flips override → 'failed'.
  modal.querySelector(".tm-exec-outcome-override").value = "failed";
  patch = modalMod._internals.buildUpdatePatch(modalMod._internals.collectFormState(modal), original);
  assert.strictEqual(patch.outcomeOverride, "failed");
});

test("SM-57: resolveTestDefinition returns null when the link target is missing or deleted", () => {
  const { store, def, exec } = setupTestExecution();
  // Soft-delete the def.
  store.softDeleteTicket(def.id, HUMAN);
  const snap = store.get();
  const resolved = modalMod._internals.resolveTestDefinition(
    snap.tickets.find(t => t.id === exec.id), snap);
  assert.strictEqual(resolved, null, "soft-deleted definitions resolve to null");
});

// ---------------------------------------------------------------------------
// SM-152 (S7) — live-sync: AC clobber, epic detach, test-steps header
// ---------------------------------------------------------------------------

test("SM-152: buildUpdatePatch OMITS acceptanceCriteria when unchanged, includes it when changed", () => {
  const { story } = setup();
  const withAc = Object.assign({}, story, {
    acceptanceCriteria: [{ id: "ac1", text: "must work", completed: false }]
  });
  const form = {
    title: withAc.title, type: withAc.type, description: withAc.description, status: withAc.status,
    position: { releaseId: null, processStepId: null, epicId: null },
    acceptanceCriteria: [{ id: "ac1", text: "must work", completed: false }],
    labels: []
  };
  const unchanged = modalMod._internals.buildUpdatePatch(form, withAc);
  assert.ok(!("acceptanceCriteria" in unchanged), "unchanged AC must NOT be in the patch (no clobber)");
  form.acceptanceCriteria = [{ id: "ac1", text: "must work WELL", completed: false }];
  const changed = modalMod._internals.buildUpdatePatch(form, withAc);
  assert.ok(Array.isArray(changed.acceptanceCriteria), "changed AC must be in the patch");
  assert.strictEqual(changed.acceptanceCriteria[0].text, "must work WELL");
});

test("SM-152: live-sync rebuilds the AC list from an external edit", () => {
  const { store, story } = setup();
  const ctx = makeCtx(store);
  modalMod.openTicketModal(ctx, story.id, {});
  const modal = document.querySelector(".modal");
  const updated = Object.assign({}, store.get().tickets.find(t => t.id === story.id), {
    acceptanceCriteria: [{ id: "acX", text: "Externally added", completed: false }]
  });
  modalMod._internals.syncFieldFromTicket(modal, updated, store.get());
  const acWrap = modal.querySelector('[data-sm-sync-key="acceptanceCriteria"]');
  const texts = Array.from(acWrap.querySelectorAll(".tm-ac-text")).map(i => i.value);
  assert.ok(texts.indexOf("Externally added") >= 0, "external AC must appear after sync, got: " + JSON.stringify(texts));
});

test("SM-152: live-sync keeps the Epic dropdown bound via contains-link (no detach)", () => {
  const store = buildStore();
  const epic = store.get().tickets.find(t => t.title === "E1");
  store.createTicket({ type: "user-story", title: "Child", position: { epicId: epic.id } }, HUMAN);
  const child = store.get().tickets.find(t => t.title === "Child");
  document.getElementById("modal-host").innerHTML = "";
  const ctx = makeCtx(store);
  modalMod.openTicketModal(ctx, child.id, {});
  const modal = document.querySelector(".modal");
  const epicSel = modal.querySelector('[data-sm-sync-key="position.epicId"]');
  assert.ok(epicSel, "epic dropdown present for a user-story");
  assert.strictEqual(epicSel.value, epic.id, "initially bound to the container epic");
  const fresh = store.get().tickets.find(t => t.id === child.id);
  modalMod._internals.syncFieldFromTicket(modal, fresh, store.get());
  assert.strictEqual(epicSel.value, epic.id, "must STAY bound to the epic after sync (position.epicId is null)");
});

test("SM-152: test-steps live-sync header has 6 cells aligned with the row grid", () => {
  const refs = { markDirty: () => {} };
  const host = document.createElement("div");
  const seed = { id: "t1", type: "test-definition", title: "T",
    steps: [{ id: "s1", step: "do", data: "", expectedResult: "ok" }] };
  host.appendChild(modalMod._internals.buildStepsSection(seed, refs));
  const updated = { id: "t1", type: "test-definition", title: "T", steps: [
    { id: "s1", step: "do", data: "", expectedResult: "ok" },
    { id: "s2", step: "more", data: "x", expectedResult: "y" }
  ]};
  modalMod._internals.syncFieldFromTicket(host, updated, null);
  const head = host.querySelector(".tm-test-step-head");
  assert.strictEqual(head.children.length, 6, "rebuilt steps head must have 6 cells");
  assert.strictEqual(host.querySelectorAll(".tm-test-step-row").length, 2, "rebuild reflects new step count");
});

test("SM-185: buildAttachmentsSection renders a dropzone + list and loads the ticket's attachments on build", () => {
  const calls = { list: 0, listTicket: null, uploaded: [], deleted: [] };
  const ctx = {
    attachmentsEnabled: true,
    attachmentHref: (aid) => "/dl/" + aid,
    listAttachments: async (tid) => { calls.list++; calls.listTicket = tid; return []; },
    uploadAttachment: async (tid, file) => { calls.uploaded.push({ tid, name: file && file.name }); },
    deleteAttachment: async (aid) => { calls.deleted.push(aid); },
    flashStatus: () => {}
  };
  const section = ticketForm.buildAttachmentsSection("t9", ctx);
  assert.ok(section.querySelector(".tm-attach-dropzone"), "dropzone present");
  assert.ok(section.querySelector("input.tm-attach-input[type=file]"), "hidden file input present");
  assert.ok(section.querySelector(".tm-attach-list"), "list container present");
  assert.strictEqual(calls.list, 1, "loads the attachment list on build");
  assert.strictEqual(calls.listTicket, "t9", "scoped to this ticket");
});

// ---------------------------------------------------------------------------
// SM-238 — epic status is read-only (derived pill + breakdown); DoR/DoD hidden.
// ---------------------------------------------------------------------------

// Build a store with an epic that contains 3 stories in known states.
function setupEpic() {
  document.getElementById("modal-host").innerHTML = "";
  const store = buildStore();   // already has an epic "E1"
  const epic = store.get().tickets.find(t => t.title === "E1");
  const rid = store.get().releases[0].id;
  for (const [title, status] of [["A", "done"], ["B", "in-progress"], ["C", "backlog"]]) {
    store.createTicket({ type: "user-story", title, position: { releaseId: rid, epicId: epic.id } }, HUMAN);
    const t = store.get().tickets.find(x => x.title === title);
    if (status !== "backlog") store.changeStatus(t.id, status, HUMAN);
  }
  return { store, epic: store.get().tickets.find(t => t.title === "E1") };
}

test("SM-238: epic modal shows a read-only derived status pill + breakdown (no <select>)", () => {
  const { store, epic } = setupEpic();
  modalMod.openTicketModal(makeCtx(store), epic.id, {});
  const modal = document.querySelector(".modal");
  const statusEl = modal.querySelector('[data-sm-sync-key="status"]');
  assert.ok(statusEl, "status sync-key element present");
  assert.strictEqual(statusEl.tagName, "SPAN", "epic status is a read-only pill, not a select");
  assert.ok(statusEl.classList.contains("tm-status-derived"));
  assert.strictEqual(modal.querySelector("select.tm-status"), null, "no status dropdown for an epic");
  // The epic rolled up to in-progress (1 done, 1 in progress, 1 backlog).
  assert.strictEqual(statusEl.textContent, "in-progress");
  const bd = modal.querySelector('[data-sm-sync-key="status_breakdown"]');
  assert.ok(bd, "breakdown line present");
  assert.ok(/3 stories/.test(bd.textContent), "states the story count: " + bd.textContent);
  assert.ok(/1 done/.test(bd.textContent) && /1 in progress/.test(bd.textContent) && /1 to do/.test(bd.textContent),
    "breakdown shows X done / Y in progress / Z to do: " + bd.textContent);
});

test("SM-238: epic modal hides the DoR and DoD sections (lockstep with getEntityTypeConfig)", () => {
  const { store, epic } = setupEpic();
  modalMod.openTicketModal(makeCtx(store), epic.id, {});
  const modal = document.querySelector(".modal");
  const sections = Array.from(modal.querySelectorAll(".tm-checklist"));
  const titles = sections.map(s => (s.textContent || ""));
  assert.ok(!titles.some(t => /Definition of Ready/.test(t)), "no DoR section for an epic");
  assert.ok(!titles.some(t => /Definition of Done/.test(t)), "no DoD section for an epic");
});

test("SM-238: a non-epic ticket still shows the editable status <select> (regression)", () => {
  const { store } = setup();
  const story = store.get().tickets.find(t => t.title === "MyStory");
  modalMod.openTicketModal(makeCtx(store), story.id, {});
  const modal = document.querySelector(".modal");
  const statusEl = modal.querySelector('[data-sm-sync-key="status"]');
  assert.strictEqual(statusEl.tagName, "SELECT", "non-epic keeps the editable select");
});

test("SM-238: live-sync — a contained story's status change updates the epic pill + breakdown", () => {
  const { store, epic } = setupEpic();
  modalMod.openTicketModal(makeCtx(store), epic.id, {});
  const modal = document.querySelector(".modal");
  let pill = modal.querySelector('[data-sm-sync-key="status"]');
  assert.strictEqual(pill.textContent, "in-progress");
  // Move the last two stories to done → epic rolls up to done.
  const b = store.get().tickets.find(t => t.title === "B").id;
  const c = store.get().tickets.find(t => t.title === "C").id;
  store.applyRemote(core.ops.changeStatus(core.ops.changeStatus(store.get(), b, "done", HUMAN), c, "done", HUMAN));
  pill = modal.querySelector('[data-sm-sync-key="status"]');
  assert.strictEqual(pill.textContent, "done", "pill rolled up to done live");
  const bd = modal.querySelector('[data-sm-sync-key="status_breakdown"]');
  assert.ok(/3 done/.test(bd.textContent), "breakdown updated: " + bd.textContent);
});

test("SM-238: changing the type to epic in the form swaps the select for the derived pill", () => {
  const { store } = setup();
  modalMod.openTicketModal(makeCtx(store), null, { draft: { type: "user-story" } });
  const modal = document.querySelector(".modal");
  let statusEl = modal.querySelector('[data-sm-sync-key="status"]');
  assert.strictEqual(statusEl.tagName, "SELECT", "starts as a select for user-story");
  const typeEl = modal.querySelector('[data-sm-sync-key="type"]');
  typeEl.value = "epic";
  typeEl.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  statusEl = modal.querySelector('[data-sm-sync-key="status"]');
  assert.strictEqual(statusEl.tagName, "SPAN", "swapped to the derived pill after type → epic");
  assert.ok(statusEl.classList.contains("tm-status-derived"));
});

// ---------------------------------------------------------------------------
// SM-244 — Cancel C3: modal cancel action (amber) + epic-cascade confirm.
// ---------------------------------------------------------------------------

test("SM-244: modal shows an amber 'Cancel ticket' action (not destructive-red)", () => {
  const { store, story } = setup();
  modalMod.openTicketModal(makeCtx(store), story.id, {});
  const modal = document.querySelector(".modal");
  const cancelBtn = Array.from(modal.querySelectorAll(".modal-actions .btn"))
    .find(b => /cancel ticket/i.test(b.textContent));
  assert.ok(cancelBtn, "Cancel ticket action present");
  assert.ok(cancelBtn.classList.contains("warn"), "uses the amber .warn style");
  assert.ok(!cancelBtn.classList.contains("destructive"), "NOT the red Delete style");
});

test("SM-244: clicking Cancel on a story cancels it (gate-free, stays visible)", () => {
  const { store, story } = setup();
  modalMod.openTicketModal(makeCtx(store), story.id, {});
  const modal = document.querySelector(".modal");
  const cancelBtn = Array.from(modal.querySelectorAll(".modal-actions .btn"))
    .find(b => /cancel ticket/i.test(b.textContent));
  cancelBtn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  assert.strictEqual(store.get().tickets.find(t => t.id === story.id).status, "cancelled");
});

test("SM-244: a DONE epic shows no Cancel action (roll-up keeps it done — cancel would be a no-op)", () => {
  document.getElementById("modal-host").innerHTML = "";
  const store = buildStore();
  const epic = store.get().tickets.find(t => t.title === "E1");
  const rid = store.get().releases[0].id;
  store.createTicket({ type: "user-story", title: "S", position: { releaseId: rid, epicId: epic.id } }, HUMAN);
  store.changeStatus(store.get().tickets.find(t => t.title === "S").id, "done", HUMAN);
  // epic rolled up to done
  assert.strictEqual(store.get().tickets.find(t => t.id === epic.id).status, "done");
  modalMod.openTicketModal(makeCtx(store), epic.id, {});
  const modal = document.querySelector(".modal");
  const cancelBtn = Array.from(modal.querySelectorAll(".modal-actions .btn"))
    .find(b => /cancel ticket/i.test(b.textContent));
  assert.ok(!cancelBtn, "no Cancel action on a done epic");
});

test("SM-244: an already-cancelled ticket shows no Cancel action", () => {
  const { store, story } = setup();
  store.cancelTicket(story.id, HUMAN);
  modalMod.openTicketModal(makeCtx(store), story.id, {});
  const modal = document.querySelector(".modal");
  const cancelBtn = Array.from(modal.querySelectorAll(".modal-actions .btn"))
    .find(b => /cancel ticket/i.test(b.textContent));
  assert.ok(!cancelBtn, "no Cancel action for an already-cancelled ticket");
});

test("SM-244: cancelling an epic with open stories shows a confirm naming the count, then cascades", () => {
  // An epic with TWO open stories (no done) → cancel cascades → epic cancelled.
  document.getElementById("modal-host").innerHTML = "";
  const store = buildStore();
  const epic = store.get().tickets.find(t => t.title === "E1");
  const rid = store.get().releases[0].id;
  store.createTicket({ type: "user-story", title: "X", position: { releaseId: rid, epicId: epic.id } }, HUMAN);
  store.createTicket({ type: "user-story", title: "Y", position: { releaseId: rid, epicId: epic.id } }, HUMAN);
  store.changeStatus(store.get().tickets.find(t => t.title === "X").id, "in-progress", HUMAN);
  modalMod.openTicketModal(makeCtx(store), epic.id, {});
  let modal = document.querySelector(".modal");
  const cancelBtn = Array.from(modal.querySelectorAll(".modal-actions .btn"))
    .find(b => /cancel ticket/i.test(b.textContent));
  cancelBtn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  modal = document.querySelector(".modal");   // confirm replaced the ticket modal
  assert.ok(/cancel epic/i.test(modal.textContent), "confirm titled Cancel epic");
  assert.ok(/2 open stories/i.test(modal.textContent), "names the 2 open stories: " + modal.textContent);
  const confirmBtn = Array.from(modal.querySelectorAll(".modal-actions .btn"))
    .find(b => /cancel epic/i.test(b.textContent));
  confirmBtn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  assert.strictEqual(store.get().tickets.find(t => t.id === epic.id).status, "cancelled");
  assert.strictEqual(store.get().tickets.find(t => t.title === "X").status, "cancelled");
});

test("SM-244 bugfix: creating a story from the epic '+' (draft epicId) actually contains it (contains-link)", () => {
  document.getElementById("modal-host").innerHTML = "";
  const store = buildStore();   // has epic E1
  const epic = store.get().tickets.find(t => t.title === "E1");
  const rid = store.get().releases[0].id, ps = store.get().processSteps[0].id;
  // Epic '+' button → create modal with a draft carrying epicId.
  modalMod.openTicketModal(makeCtx(store), null, {
    draft: { type: "user-story", releaseId: rid, processStepId: ps, epicId: epic.id }
  });
  const modal = document.querySelector(".modal");
  // The Epic dropdown must be pre-selected to the parent (the bug: it was "— none —").
  const epicSel = modal.querySelector('[data-sm-sync-key="position.epicId"]');
  assert.ok(epicSel, "epic dropdown present for a user-story");
  assert.strictEqual(epicSel.value, epic.id, "epic dropdown pre-selected to the parent from the draft");
  modal.querySelector('[data-sm-sync-key="title"]').value = "Plus-Story";
  Array.from(modal.querySelectorAll(".modal-actions .btn"))
    .find(b => /create/i.test(b.textContent))
    .dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  const contained = core.tickets.storiesInEpic(store.get(), epic.id).map(t => t.title);
  assert.ok(contained.includes("Plus-Story"), "the created story is contained in the epic: " + JSON.stringify(contained));
});

test("SM-244: dragging a ticket into / out of an epic sets / clears the contains-link", () => {
  const store = buildStore();
  const epic = store.get().tickets.find(t => t.title === "E1").id;
  const rid = store.get().releases[0].id, ps = store.get().processSteps[0].id;
  store.createTicket({ type: "user-story", title: "Loose" }, HUMAN);
  const loose = store.get().tickets.find(t => t.title === "Loose").id;
  store.moveTicket(loose, { releaseId: rid, processStepId: ps, epicId: epic }, HUMAN);
  assert.ok(core.tickets.storiesInEpic(store.get(), epic).some(t => t.id === loose), "drag INTO epic → contained");
  store.moveTicket(loose, { releaseId: null, processStepId: null, epicId: null }, HUMAN);
  assert.ok(!core.tickets.storiesInEpic(store.get(), epic).some(t => t.id === loose), "drag OUT → link cleared");
});

test("SM-244 bugfix: a cancelled ticket's status select shows 'cancelled' (not backlog) and can be reopened", () => {
  const { store, story } = setup();
  store.cancelTicket(story.id, HUMAN);
  modalMod.openTicketModal(makeCtx(store), story.id, {});
  const modal = document.querySelector(".modal");
  const sel = modal.querySelector('select[data-sm-sync-key="status"]');
  assert.ok(sel, "non-epic keeps an editable status select");
  const opts = Array.from(sel.querySelectorAll("option")).map(o => o.value);
  assert.ok(opts.includes("cancelled"), "the workflow's cancelled status is an option: " + JSON.stringify(opts));
  assert.strictEqual(sel.value, "cancelled", "shows the real status, not a fallback to backlog");
  // reopen: an earlier status is available to pick.
  assert.ok(opts.includes("backlog"), "backlog is selectable to reopen");
});

test("SM-244 bugfix: the picked type wins over a draftCtx default type (epic '+' passes user-story)", () => {
  document.getElementById("modal-host").innerHTML = "";
  const { store } = setup();
  const rid = store.get().releases[0].id, ps = store.get().processSteps[0].id;
  // The epic "+" button passes draftCtx.type = "user-story"; the user picks "bug".
  modalMod.openTypePickerThenCreate(makeCtx(store), { releaseId: rid, processStepId: ps, type: "user-story" });
  let modal = document.querySelector(".modal");
  const bugBtn = Array.from(modal.querySelectorAll(".tm-type-pick-btn")).find(b => b.textContent.trim() === "bug");
  bugBtn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  return Promise.resolve().then(() => {
    const m = document.querySelector(".modal");
    const typeEl = m.querySelector('[data-sm-sync-key="type"]');
    assert.strictEqual(typeEl.value, "bug", "the create modal honors the PICKED type, not the draft default");
  });
});

test("SM-244 bugfix: the +Add Item type-picker offers 'epic' (and excludes spec types)", () => {
  const { store } = setup();
  modalMod.openTypePickerThenCreate(makeCtx(store), {}, {});
  const picker = document.querySelector(".tm-type-picker");
  assert.ok(picker, "type-picker rendered");
  const types = Array.from(picker.querySelectorAll(".tm-type-pick-btn"))
    .map(b => b.textContent.trim());
  assert.ok(types.includes("epic"), "epic must be offerable: " + JSON.stringify(types));
  assert.ok(!types.includes("requirement") && !types.includes("spec-module"),
    "spec types stay out of the picker: " + JSON.stringify(types));
});

test("SM-278: epic-cancel action opens the confirm AND returns false (single modal-host isn't self-wiped)", () => {
  document.getElementById("modal-host").innerHTML = "";
  const store = buildStore();
  const epic = store.get().tickets.find(t => t.title === "E1");   // empty epic, backlog
  const ctx = makeCtx(store);
  const initial = { type: "epic", status: epic.status };
  const actions = modalMod._internals.maybeCancelAction(ctx, initial, epic.id);
  assert.ok(actions && actions.length === 1, "cancel action offered for a non-done epic");
  const ret = actions[0].onClick();
  assert.ok(document.getElementById("modal-host").textContent.includes("Cancel epic?"),
    "clicking Cancel opens the epic-cancel confirm modal");
  // The onClick MUST return false so showModal's post-onClick close() does not
  // run host.innerHTML="" and wipe the confirm we just opened (SM-278 root cause).
  assert.strictEqual(ret, false, "epic-cancel action returns false so the confirm survives");
});

test("SM-278: story-cancel action cancels immediately (no confirm needed)", () => {
  const { store, story } = setup();
  const ctx = makeCtx(store);
  const initial = { type: story.type, status: story.status };
  const actions = modalMod._internals.maybeCancelAction(ctx, initial, story.id);
  assert.ok(actions && actions.length === 1, "cancel action offered for a story");
  actions[0].onClick();
  assert.strictEqual(store.get().tickets.find(t => t.id === story.id).status, "cancelled",
    "story is cancelled directly through the store");
});

const done = runChain.then(() => {
  console.log(`\n  ${passed} passed, ${failed} failed`);
});
module.exports = { done };
