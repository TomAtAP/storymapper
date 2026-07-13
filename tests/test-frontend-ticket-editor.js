"use strict";

/**
 * SM-117 (Epic B / B2) — Tests für `frontend/js/renderer-ticket-editor.js`.
 *
 * Der Vollseiten-Editor mountet EIN Ticket type-aware mit den GETEILTEN
 * ticket-form-Buildern und live-synct über store.subscribe. Getestet wird die
 * reine `mount(host, store, ctx)`-Funktion (jsdom) + `parseEditorQuery`.
 */

const assert = require("assert");
const { JSDOM } = require("jsdom");

const dom = new JSDOM(`<!doctype html><html><body><div id="editor-host"></div></body></html>`);
global.window      = dom.window;
global.document    = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;
global.MutationObserver = dom.window.MutationObserver;

const core = require("../frontend/js/core.js");
const { ProjectStore } = require("../frontend/js/store.js");
const editor = require("../frontend/js/renderer-ticket-editor.js");

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  - ${name}`); passed++; }
  catch (err) { console.log(`  FAIL - ${name}\n         ${err.stack || err.message}`); failed++; process.exitCode = 1; }
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
  store.createTicket({ type: "epic", title: "Epic-1" }, HUMAN);
  store.createTicket({ type: "user-story", title: "MyStory", description: "hello" }, HUMAN);
  return store;
}

function freshHost() {
  document.getElementById("editor-host").innerHTML = "";
  return document.getElementById("editor-host");
}

function storyId(store)  { return store.get().tickets.find(t => t.title === "MyStory").id; }
function epicId(store)   { return store.get().tickets.find(t => t.type === "epic").id; }

// ---------------------------------------------------------------------------
// parseEditorQuery
// ---------------------------------------------------------------------------

test("parseEditorQuery extracts projectId + ticketId from a search string", () => {
  const q = editor.parseEditorQuery("?projectId=p1&ticketId=t9");
  assert.strictEqual(q.projectId, "p1");
  assert.strictEqual(q.ticketId, "t9");
});

test("parseEditorQuery extracts from a full href and strips a hash", () => {
  const q = editor.parseEditorQuery("http://x/editor?projectId=p2&ticketId=t3#frag");
  assert.strictEqual(q.projectId, "p2");
  assert.strictEqual(q.ticketId, "t3");
});

test("parseEditorQuery returns empty strings when keys are missing", () => {
  const q = editor.parseEditorQuery("?foo=bar");
  assert.strictEqual(q.projectId, "");
  assert.strictEqual(q.ticketId, "");
});

// ---------------------------------------------------------------------------
// mount — render
// ---------------------------------------------------------------------------

test("mount renders a header with the ticket-key + title and the core form fields", () => {
  const store = buildStore();
  const host = freshHost();
  editor.mount(host, store, { projectId: "p1", ticketId: storyId(store) });

  const story = store.get().tickets.find(t => t.title === "MyStory");
  assert.ok(host.querySelector(".te-root"), "te-root mounted");
  assert.strictEqual(host.querySelector(".te-key").textContent, story.ticketKey);
  // SM-118: content-first two-pane layout.
  assert.ok(host.querySelector(".te-layout .te-main"), "main column present");
  assert.ok(host.querySelector(".te-layout .te-side"), "meta sidebar present");
  // Title hero lives at the top of the main column (no separate display h1).
  assert.ok(host.querySelector('.te-main .te-title-row [data-sm-sync-key="title"]'), "title hero in main");
  // Meta fields live in the sidebar; the description in the main column.
  assert.ok(host.querySelector('.te-side [data-sm-sync-key="type"]'), "type in sidebar");
  assert.ok(host.querySelector('.te-side [data-sm-sync-key="status"]'), "status in sidebar");
  assert.ok(host.querySelector('.te-main [data-sm-sync-key="description"]'), "description in main");

  // Shared builders → sync-keyed fields present + pre-filled.
  assert.strictEqual(host.querySelector('[data-sm-sync-key="title"]').value, "MyStory");
  assert.ok(host.querySelector('[data-sm-sync-key="type"]'),   "type field");
  assert.ok(host.querySelector('[data-sm-sync-key="status"]'), "status field");
  // SM-119: description is a plain-text contentEditable block now.
  const descEl = host.querySelector('[data-sm-sync-key="description"]');
  assert.strictEqual(descEl.getAttribute("contenteditable"), "true", "description is contentEditable");
  assert.strictEqual(descEl.textContent, "hello");
});

test("mount renders AC + DoR + DoD sections type-aware for a user-story", () => {
  const store = buildStore();
  const host = freshHost();
  editor.mount(host, store, { projectId: "p1", ticketId: storyId(store) });
  assert.ok(host.querySelector(".tm-ac-section"), "Acceptance Criteria section");
  assert.ok(host.querySelector('.tm-checklist[data-sm-sync-key="definitionOfReady"]'), "DoR section");
  assert.ok(host.querySelector('.tm-checklist[data-sm-sync-key="definitionOfDone"]'),  "DoD section");
  // DoR was frozen from the project definition on create → one row.
  assert.ok(host.querySelector('.tm-checklist[data-sm-sync-key="definitionOfReady"] .tm-checkitem-row'),
    "DoR has the frozen item row");
});

test("mount: an epic ticket does NOT render an epic-id position dropdown (allowParentEpic=false)", () => {
  const store = buildStore();
  const host = freshHost();
  editor.mount(host, store, { projectId: "p1", ticketId: epicId(store) });
  assert.ok(!host.querySelector('[data-sm-sync-key="position.epicId"]'),
    "epic must not get a parent-epic dropdown");
  // But it still shows release + process-step.
  assert.ok(host.querySelector('[data-sm-sync-key="position.releaseId"]'), "release dropdown present");
});

test("SM-160: mount renders the Links section in the MAIN column (below the description), not the sidebar", () => {
  const store = buildStore();
  const host = freshHost();
  editor.mount(host, store, { projectId: "p1", ticketId: storyId(store), store });
  assert.ok(host.querySelector('.te-main .tm-links[data-sm-sync-key="links"]'), "links in main");
  assert.strictEqual(host.querySelector('.te-side .tm-links'), null, "links not in the sidebar");
});

test("mount shows a not-found message when the ticket id is unknown", () => {
  const store = buildStore();
  const host = freshHost();
  const ctrl = editor.mount(host, store, { projectId: "p1", ticketId: "does-not-exist" });
  assert.ok(host.querySelector(".te-missing"), "missing message shown");
  assert.strictEqual(typeof ctrl.unmount, "function");
});

// ---------------------------------------------------------------------------
// mount — live-sync
// ---------------------------------------------------------------------------

test("live-sync: an external commit updates the title field", () => {
  const store = buildStore();
  const host = freshHost();
  const sid = storyId(store);
  editor.mount(host, store, { projectId: "p1", ticketId: sid });

  // External edit arrives (as a WS applyRemote would deliver it).
  const next = core.ops.updateTicket(store.get(), sid, { title: "Renamed" }, HUMAN);
  store.applyRemote(next);

  assert.strictEqual(host.querySelector('[data-sm-sync-key="title"]').value, "Renamed",
    "title input reflects the external rename");
});

test("SM-157: editing the description and clicking ✓ commits to the store (editor persistence)", () => {
  const store = buildStore();
  const host = freshHost();
  const sid = storyId(store);
  editor.mount(host, store, { projectId: "p1", ticketId: sid });
  const ed = host.querySelector('[data-sm-sync-key="description"]');
  ed.textContent = "edited in the full-page editor";
  ed.dispatchEvent(new window.Event("input", { bubbles: true }));
  host.querySelector(".tm-desc-save").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  const t = store.get().tickets.find(x => x.id === sid);
  assert.strictEqual(t.description, "edited in the full-page editor",
    "the ✓ commit reaches the store (which the save-subscriber then persists)");
});

// ---------------------------------------------------------------------------
// SM-120 (B5) — full in-place persistence (no Save button)
// ---------------------------------------------------------------------------

test("SM-120: changing the type (discrete control) commits to the store immediately", () => {
  const store = buildStore();
  const host = freshHost();
  const sid = storyId(store);
  editor.mount(host, store, { projectId: "p1", ticketId: sid });
  const typeSel = host.querySelector('[data-sm-sync-key="type"]');
  typeSel.value = "bug";
  typeSel.dispatchEvent(new window.Event("change", { bubbles: true }));
  assert.strictEqual(store.get().tickets.find(t => t.id === sid).type, "bug");
});

test("SM-120: editing the title and blurring (focus-out) commits to the store", () => {
  const store = buildStore();
  const host = freshHost();
  const sid = storyId(store);
  editor.mount(host, store, { projectId: "p1", ticketId: sid });
  const titleInput = host.querySelector('[data-sm-sync-key="title"]');
  titleInput.value = "Renamed via editor";
  titleInput.dispatchEvent(new window.Event("focusout", { bubbles: true }));
  assert.strictEqual(store.get().tickets.find(t => t.id === sid).title, "Renamed via editor");
});

test("SM-120: editing labels and blurring commits to the store", () => {
  const store = buildStore();
  const host = freshHost();
  const sid = storyId(store);
  editor.mount(host, store, { projectId: "p1", ticketId: sid });
  const labels = host.querySelector('[data-sm-sync-key="labels"]');
  labels.value = "frontend, editor";
  labels.dispatchEvent(new window.Event("focusout", { bubbles: true }));
  assert.deepStrictEqual(store.get().tickets.find(t => t.id === sid).labels, ["frontend", "editor"]);
});

test("SM-120: a blocked status transition reverts the picker + shows an inline gate error", () => {
  const store = buildStore();
  const host = freshHost();
  const sid = storyId(store);  // backlog, DoR has a required-unchecked item
  editor.mount(host, store, { projectId: "p1", ticketId: sid });
  const statusSel = host.querySelector('[data-sm-sync-key="status"]');
  statusSel.value = "ready";   // backlog → ready crosses the DoR gate
  statusSel.dispatchEvent(new window.Event("change", { bubbles: true }));
  const t = store.get().tickets.find(t => t.id === sid);
  assert.strictEqual(t.status, "backlog", "status not changed (gate blocked)");
  assert.strictEqual(statusSel.value, "backlog", "picker reverted to the current status");
  const banner = host.querySelector('[data-sm-sync-key="_error_banner"]');
  assert.notStrictEqual(banner.style.display, "none", "inline gate error is shown");
  assert.ok(/DoR/.test(banner.textContent), "error names the DoR gate, got: " + banner.textContent);
});

test("SM-120: an allowed status transition commits (no gate)", () => {
  const store = buildStore();
  const host = freshHost();
  const sid = storyId(store);
  editor.mount(host, store, { projectId: "p1", ticketId: sid });
  const statusSel = host.querySelector('[data-sm-sync-key="status"]');
  statusSel.value = "in-progress";  // no gate on this transition
  statusSel.dispatchEvent(new window.Event("change", { bubbles: true }));
  assert.strictEqual(store.get().tickets.find(t => t.id === sid).status, "in-progress");
});

test("SM-122/B7: the editor header has a Back-to-board link", () => {
  const store = buildStore();
  const host = freshHost();
  editor.mount(host, store, { projectId: "p1", ticketId: storyId(store) });
  const back = host.querySelector(".te-header .te-back");
  assert.ok(back, "back-to-board link present");
  assert.strictEqual(back.getAttribute("href"), "/");
});

test("unmount detaches the store subscription (no further sync)", () => {
  const store = buildStore();
  const host = freshHost();
  const sid = storyId(store);
  const ctrl = editor.mount(host, store, { projectId: "p1", ticketId: sid });
  ctrl.unmount();
  const next = core.ops.updateTicket(store.get(), sid, { title: "AfterUnmount" }, HUMAN);
  store.applyRemote(next);
  // The field keeps its pre-unmount value — the subscription is gone.
  assert.strictEqual(host.querySelector('[data-sm-sync-key="title"]').value, "MyStory");
});

test("SM-185: the editor renders the attachments dropzone in main when the HTTP adapter is active", () => {
  const store = buildStore();
  const host = freshHost();
  const calls = { list: 0 };
  editor.mount(host, store, {
    projectId: "p1", ticketId: storyId(store), store,
    attachmentsEnabled: true,
    attachmentHref: (aid) => "/dl/" + aid,
    listAttachments: async () => { calls.list++; return []; },
    uploadAttachment: async () => {}, deleteAttachment: async () => {},
    flashStatus: () => {}
  });
  const section = host.querySelector(".te-main .tm-attachments-section");
  assert.ok(section, "attachments section in the editor main column");
  assert.ok(section.querySelector(".tm-attach-dropzone"), "dropzone present");
  assert.strictEqual(calls.list, 1, "loads the list on render");
});

test("SM-185: the editor omits attachments when the adapter is not HTTP (attachmentsEnabled falsy)", () => {
  const store = buildStore();
  const host = freshHost();
  editor.mount(host, store, { projectId: "p1", ticketId: storyId(store), store });
  assert.strictEqual(host.querySelector(".tm-attachments-section"), null);
});

test("SM-238: full-page editor shows the epic's derived status pill + breakdown (no select)", () => {
  const store = buildStore();
  const eid = epicId(store);
  const rid = store.get().releases[0].id;
  store.createTicket({ type: "user-story", title: "S1", position: { releaseId: rid, epicId: eid } }, HUMAN);
  store.changeStatus(store.get().tickets.find(t => t.title === "S1").id, "done", HUMAN);
  const host = freshHost();
  editor.mount(host, store, { projectId: "p1", ticketId: eid });
  const statusEl = host.querySelector('.te-side [data-sm-sync-key="status"]');
  assert.ok(statusEl, "status field in sidebar");
  assert.strictEqual(statusEl.tagName, "SPAN", "epic uses the read-only pill");
  assert.strictEqual(statusEl.textContent, "done", "all stories done → epic done");
  const bd = host.querySelector('.te-side [data-sm-sync-key="status_breakdown"]');
  assert.ok(bd && /1 done/.test(bd.textContent), "breakdown present: " + (bd && bd.textContent));
});

test("SM-238: changing a ticket's type to epic in the editor swaps the status select for the derived pill", () => {
  const store = buildStore();
  const sid = storyId(store);
  const host = freshHost();
  editor.mount(host, store, { projectId: "p1", ticketId: sid });
  let statusEl = host.querySelector('.te-side [data-sm-sync-key="status"]');
  assert.strictEqual(statusEl.tagName, "SELECT", "starts as an editable select");
  const typeEl = host.querySelector('.te-side [data-sm-sync-key="type"]');
  typeEl.value = "epic";
  typeEl.dispatchEvent(new window.Event("change", { bubbles: true }));
  // commit (immediate for discrete controls) → store updates → subscribe →
  // syncFieldFromTicket detects the type/control mismatch and swaps the control.
  statusEl = host.querySelector('.te-side [data-sm-sync-key="status"]');
  assert.strictEqual(statusEl.tagName, "SPAN", "swapped to the derived pill in the editor");
  assert.ok(statusEl.classList.contains("tm-status-derived"));
});

test("SM-244: editor renders an amber Cancel-ticket button that cancels the ticket", () => {
  const store = buildStore();
  const sid = storyId(store);
  const host = freshHost();
  editor.mount(host, store, { projectId: "p1", ticketId: sid });
  const btn = host.querySelector(".te-side .te-cancel-action");
  assert.ok(btn, "Cancel ticket button present in the sidebar");
  assert.ok(btn.classList.contains("warn") && !btn.classList.contains("destructive"), "amber, not red");
  btn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  assert.strictEqual(store.get().tickets.find(t => t.id === sid).status, "cancelled");
});

test("SM-244: editor has a red Delete button alongside the amber Cancel (parity with the modal)", () => {
  const store = buildStore();
  const sid = storyId(store);
  const host = freshHost();
  editor.mount(host, store, { projectId: "p1", ticketId: sid });
  const del = host.querySelector(".te-side .te-delete-action");
  assert.ok(del, "Delete button present in the editor sidebar");
  assert.ok(del.classList.contains("destructive"), "Delete is red/destructive");
  const cancel = host.querySelector(".te-side .te-cancel-action");
  assert.ok(cancel && cancel.classList.contains("warn"), "Cancel is amber, sits next to Delete");
});

console.log(`\n  ${passed} passed, ${failed} failed`);
module.exports = { passed, failed };
