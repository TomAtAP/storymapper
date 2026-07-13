"use strict";

/**
 * End-to-end test: spin up a real storymap server, load the actual HTML
 * into JSDOM with `runScripts: dangerously` so the bootstrap (`main.js`)
 * executes inside the DOM, then drive the UI through user actions.
 *
 * This is the test class the isolated-module tests cannot replace —
 * showModal-Tests proved that the modal renders, Adapter-Tests proved
 * that pickAdapter chooses Http, etc. But none of them prove that
 * "Menu ▸ New project… → fill form → click Create" actually shows
 * the new project in the UI. That's what this file is for.
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { JSDOM } = require("jsdom");
const WebSocket = require("ws");
const { startServer } = require("../server/server.js");

let passed = 0, failed = 0;
function test(name, fn) {
  const exec = async () => {
    try {
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

async function tmpDir() {
  return await fs.promises.mkdtemp(path.join(os.tmpdir(), "storymap-e2e-"));
}

async function bootUI() {
  const dir = await tmpDir();
  const handle = await startServer({ port: 0, dataDir: dir });
  const port = handle.httpServer.address().port;
  const base = `http://localhost:${port}`;
  const url = `${base}/?api=${base}`;

  // Load the actual HTML the server serves, then JSDOM rewrites <script>
  // src to absolute URLs and executes them.
  const dom = await JSDOM.fromURL(url, {
    runScripts: "dangerously",
    resources: "usable",
    pretendToBeVisual: true
  });
  // Inject globals the in-page code expects (Node's fetch + ws).
  dom.window.fetch = (input, init) => fetch(input, init);
  dom.window.WebSocket = WebSocket;
  // Wait for the page to settle: DOMContentLoaded plus an extra tick for
  // the async init() call inside main.js to complete (it does an
  // adapter.list() roundtrip).
  await new Promise(r => dom.window.addEventListener("load", r));
  await tick(dom, 300);

  return { dom, handle, base, dir };
}

function tick(dom, ms = 0) {
  return new Promise(r => dom.window.setTimeout(r, ms));
}

async function shutdown(t) {
  try { await t.handle.shutdown(); } catch (_) {}
  try { t.dom.window.close(); } catch (_) {}
}

// ---------------------------------------------------------------------------

test("Bootstrap: page loads, adapter is Http, no project yet", async () => {
  const t = await bootUI();
  try {
    const doc = t.dom.window.document;
    const badge = doc.getElementById("adapter-badge");
    assert.ok(badge);
    assert.strictEqual(badge.textContent, "Http");
    // Project-select dropdown is gone (E11.4 replaced it with the Load-Project
    // menu entry + current-project indicator). Without an active project the
    // indicator must be empty and the current-project span hidden by CSS.
    assert.strictEqual(doc.getElementById("project-select"), null);
    const indicator = doc.getElementById("current-project");
    assert.ok(indicator, "current-project indicator missing");
    assert.strictEqual(indicator.textContent, "");
  } finally { await shutdown(t); }
});

async function createProject(t, { id, name, prefix }) {
  const doc = t.dom.window.document;
  const projectMenuBtn = doc.querySelector('.menu-bar .menu-item[data-menu-id="project"]');
  projectMenuBtn.dispatchEvent(new t.dom.window.MouseEvent("click", { bubbles: true }));
  await tick(t.dom, 30);
  const dropdownItems = doc.querySelectorAll(".menu-dropdown .menu-dropdown-item");
  const newItem = Array.from(dropdownItems).find(d => /new project/i.test(d.textContent));
  newItem.dispatchEvent(new t.dom.window.MouseEvent("click", { bubbles: true }));
  await tick(t.dom, 30);
  const modal = doc.querySelector(".modal");
  modal.querySelector("#np-id").value = id;
  modal.querySelector("#np-id").dispatchEvent(new t.dom.window.Event("input", { bubbles: true }));
  modal.querySelector("#np-name").value = name;
  modal.querySelector("#np-name").dispatchEvent(new t.dom.window.Event("input", { bubbles: true }));
  modal.querySelector("#np-prefix").value = prefix || "P";
  modal.querySelector("#np-prefix").dispatchEvent(new t.dom.window.Event("input", { bubbles: true }));
  const createBtn = Array.from(modal.querySelectorAll(".modal-actions .btn"))
    .find(b => /create/i.test(b.textContent));
  createBtn.dispatchEvent(new t.dom.window.MouseEvent("click", { bubbles: true }));
  await tick(t.dom, 500);
}

// E22 helper: open a top-level menu, find the dropdown item by regex on
// its visible text, click it. Returns true if the item was found + clicked.
async function clickMenuItem(t, menuId, labelRegex) {
  const doc = t.dom.window.document;
  const top = doc.querySelector('.menu-bar .menu-item[data-menu-id="' + menuId + '"]');
  if (!top) throw new Error("menu-bar entry not found: " + menuId);
  top.dispatchEvent(new t.dom.window.MouseEvent("click", { bubbles: true }));
  await tick(t.dom, 30);
  // Match against the label span specifically so shortcut text (Mod+Z etc.)
  // doesn't bleed into the comparison.
  const items = doc.querySelectorAll(".menu-dropdown .menu-dropdown-item");
  const hit = Array.from(items).find(d => {
    const lbl = d.querySelector(".menu-label");
    return lbl && labelRegex.test(lbl.textContent);
  });
  if (!hit) throw new Error("menu item not found: " + labelRegex + " under " + menuId);
  hit.dispatchEvent(new t.dom.window.MouseEvent("click", { bubbles: true }));
  await tick(t.dom, 30);
  return true;
}

async function createTicket(t, { type, title, description }) {
  const doc = t.dom.window.document;
  await clickMenuItem(t, "edit", /add ticket/i);
  await tick(t.dom, 30);
  // Step 1: type-picker modal opens first.
  let modal = doc.querySelector(".modal");
  if (!modal) throw new Error("type-picker modal did not open");
  const picker = modal.querySelector(".tm-type-picker");
  if (!picker) throw new Error("expected type-picker host inside modal");
  const wantedType = type || "user-story";
  const typeBtn = Array.from(picker.querySelectorAll(".tm-type-pick-btn"))
    .find(b => (b.textContent || "").trim() === wantedType);
  if (!typeBtn) throw new Error("type-picker has no option for " + wantedType);
  typeBtn.dispatchEvent(new t.dom.window.MouseEvent("click", { bubbles: true }));
  await tick(t.dom, 30);
  // Step 2: create-mode ticket modal opens.
  modal = doc.querySelector(".modal");
  if (!modal) throw new Error("ticket modal did not open after type pick");
  const titleInput = modal.querySelector('[data-sm-sync-key="title"]');
  if (!titleInput) throw new Error("ticket modal missing title field");
  titleInput.value = title;
  if (description) {
    const descTa = modal.querySelector('[data-sm-sync-key="description"]');
    if (descTa) descTa.value = description;
  }
  const createBtn = Array.from(modal.querySelectorAll(".modal-actions .btn"))
    .find(b => /create/i.test(b.textContent));
  createBtn.dispatchEvent(new t.dom.window.MouseEvent("click", { bubbles: true }));
  await tick(t.dom, 500);
}

test("Flow: Menu ▸ New project ▸ fill ▸ Create → project visible in select + Story-Map rendered", async () => {
  const t = await bootUI();
  try {
    const doc = t.dom.window.document;

    // 1) Open the Project menu.
    const projectMenuBtn = doc.querySelector('.menu-bar .menu-item[data-menu-id="project"]');
    assert.ok(projectMenuBtn, "no Project menu button");
    projectMenuBtn.dispatchEvent(new t.dom.window.MouseEvent("click", { bubbles: true }));
    await tick(t.dom, 30);

    // 2) Click "New project…" entry in the dropdown.
    const dropdownItems = doc.querySelectorAll(".menu-dropdown .menu-dropdown-item");
    assert.ok(dropdownItems.length > 0, "no dropdown items");
    const newItem = Array.from(dropdownItems).find(d => /new project/i.test(d.textContent));
    assert.ok(newItem, "no 'New project' item");
    newItem.dispatchEvent(new t.dom.window.MouseEvent("click", { bubbles: true }));
    await tick(t.dom, 30);

    // 3) Modal should now be open with three inputs.
    const modal = doc.querySelector(".modal");
    assert.ok(modal, "modal did not open");
    const idIn = modal.querySelector("#np-id");
    const nameIn = modal.querySelector("#np-name");
    const prefixIn = modal.querySelector("#np-prefix");
    assert.ok(idIn && nameIn && prefixIn, "modal inputs missing");

    // 4) Fill the form.
    idIn.value = "myapp";
    idIn.dispatchEvent(new t.dom.window.Event("input", { bubbles: true }));
    nameIn.value = "My App";
    nameIn.dispatchEvent(new t.dom.window.Event("input", { bubbles: true }));
    prefixIn.value = "MA";
    prefixIn.dispatchEvent(new t.dom.window.Event("input", { bubbles: true }));

    // 5) Click "Create".
    const createBtn = Array.from(modal.querySelectorAll(".modal-actions .btn"))
      .find(b => /create/i.test(b.textContent));
    assert.ok(createBtn, "no Create button");
    createBtn.dispatchEvent(new t.dom.window.MouseEvent("click", { bubbles: true }));
    await tick(t.dom, 400);   // server roundtrip + refreshProjectList + loadProject

    // 6) Modal should be closed.
    assert.strictEqual(doc.querySelector(".modal"), null, "modal did not close after Create");

    // 7) Current-project indicator now shows the new project name.
    const indicator = doc.getElementById("current-project");
    assert.ok(indicator.textContent.length > 0, "current-project indicator should show name after create");

    // 8) Story-Map host should be populated (.sm-grid present).
    const grid = doc.querySelector("#story-map-host .sm-grid");
    assert.ok(grid, "story-map grid not rendered after project create");

    // 9) Edit ▸ Add Ticket… is enabled (no toolbar button anymore).
    const editTop = doc.querySelector('.menu-bar .menu-item[data-menu-id="edit"]');
    editTop.dispatchEvent(new t.dom.window.MouseEvent("click", { bubbles: true }));
    await tick(t.dom, 30);
    const addTicketItem = Array.from(doc.querySelectorAll(".menu-dropdown .menu-dropdown-item"))
      .find(d => /add ticket/i.test(d.textContent));
    assert.ok(addTicketItem, "Edit ▸ Add Ticket… should exist");
    assert.ok(!addTicketItem.classList.contains("disabled"), "Add Ticket should be enabled after project load");
  } finally { await shutdown(t); }
});

test("Flow: After project create, + Ticket dialog creates a ticket and it lands in the newest release's holding strip", async () => {
  const t = await bootUI();
  try {
    await createProject(t, { id: "demo", name: "Demo", prefix: "DEMO" });
    await createTicket(t, { type: "user-story", title: "First story" });
    const doc = t.dom.window.document;
    // Modal closed.
    assert.strictEqual(doc.querySelector(".modal"), null, "ticket modal stayed open");
    // SM-253: a menu-created ticket defaults to the newest release (unplaced)
    // and lands in that release's per-release holding strip (no backlog anymore).
    const orphanCards = doc.querySelectorAll("#story-map-host .sm-release-unplaced-row .sm-story-card");
    assert.strictEqual(orphanCards.length, 1, "expected 1 story card in the holding strip, got " + orphanCards.length);
    assert.ok(orphanCards[0].textContent.includes("First story"), "card missing title");
    assert.ok(orphanCards[0].textContent.includes("DEMO-1"), "card missing ticket key DEMO-1");
  } finally { await shutdown(t); }
});

test("Flow: Reload preserves project selection (project still in select after re-bootstrap)", async () => {
  // Two-phase test: create on first bootstrap, verify on second against same data dir.
  const dir = await tmpDir();
  // Phase 1
  let handle = await startServer({ port: 0, dataDir: dir });
  let port = handle.httpServer.address().port;
  let dom = await JSDOM.fromURL(`http://localhost:${port}/?api=http://localhost:${port}`, {
    runScripts: "dangerously", resources: "usable", pretendToBeVisual: true
  });
  dom.window.fetch = (i, x) => fetch(i, x);
  dom.window.WebSocket = WebSocket;
  await new Promise(r => dom.window.addEventListener("load", r));
  await tick(dom, 300);
  await createProject({ dom, handle }, { id: "persist", name: "Persistent", prefix: "P" });
  dom.window.close();
  await handle.shutdown();

  // Phase 2: fresh server against same data dir, fresh JSDOM.
  handle = await startServer({ port: 0, dataDir: dir });
  port = handle.httpServer.address().port;
  dom = await JSDOM.fromURL(`http://localhost:${port}/?api=http://localhost:${port}`, {
    runScripts: "dangerously", resources: "usable", pretendToBeVisual: true
  });
  dom.window.fetch = (i, x) => fetch(i, x);
  dom.window.WebSocket = WebSocket;
  await new Promise(r => dom.window.addEventListener("load", r));
  await tick(dom, 400);   // adapter.list() + auto-load first project
  const doc = dom.window.document;
  // No more project-select dropdown — the indicator shows the loaded project.
  assert.strictEqual(doc.getElementById("project-select"), null);
  const indicator = doc.getElementById("current-project");
  assert.ok(indicator.textContent.length > 0, "current-project indicator empty after reload");
  // Grid is rendered on reload (auto-load from list).
  assert.ok(doc.querySelector("#story-map-host .sm-grid"), "grid not rendered on reload");
  dom.window.close();
  await handle.shutdown();
});

test("Flow: WebSocket live-sync — second client sees ticket created by first", async () => {
  // Two windows on the SAME server.
  const dir = await tmpDir();
  const handle = await startServer({ port: 0, dataDir: dir });
  const port = handle.httpServer.address().port;
  const url = `http://localhost:${port}/?api=http://localhost:${port}`;

  async function boot() {
    const d = await JSDOM.fromURL(url, { runScripts: "dangerously", resources: "usable", pretendToBeVisual: true });
    d.window.fetch = (i, x) => fetch(i, x);
    d.window.WebSocket = WebSocket;
    await new Promise(r => d.window.addEventListener("load", r));
    await tick(d, 300);
    return d;
  }

  const w1 = await boot();
  try {
    await createProject({ dom: w1, handle }, { id: "live", name: "Live", prefix: "L" });

    // Second window opens AFTER project is created — adapter.list picks it up.
    const w2 = await boot();
    try {
      // w1 creates a ticket → w2 should see it via WS-push.
      await createTicket({ dom: w1, handle }, { type: "user-story", title: "Live story" });
      // Give the second client a couple of polling ticks.
      await tick(w2, 800);
      // Orphan story (no release given) lands in the backlog section as a story card.
      const cards = w2.window.document.querySelectorAll("#story-map-host .sm-release-unplaced-row .sm-story-card");
      assert.strictEqual(cards.length, 1, "second window did not pick up live-sync change: " + cards.length);
    } finally { w2.window.close(); }
  } finally {
    w1.window.close();
    await handle.shutdown();
  }
});

// ---------------------------------------------------------------------------
// E17 — Layout-Polish: Tool-Rename, Menu-Divider, Bottom-Statusbar, Toolbar
// ---------------------------------------------------------------------------

test("E17/E9h: tool is renamed to 'Story Mapper' (cmapper-Pattern: <b>Story</b><em>Mapper</em>)", async () => {
  const t = await bootUI();
  try {
    const doc = t.dom.window.document;
    assert.ok(doc.title.includes("Story Mapper"), "title should include 'Story Mapper', got: " + doc.title);
    const brand = doc.querySelector(".brand");
    assert.ok(brand, "brand element missing");
    // cmapper pattern uses concatenated <b><em> without space in DOM — visually
    // separated by weight. Both parts must be present.
    assert.ok(/story/i.test(brand.textContent) && /mapper/i.test(brand.textContent),
      "brand should contain 'Story' and 'Mapper', got: " + brand.textContent);
    assert.ok(brand.querySelector("b"), "brand should use <b>+<em> markup like cmapper");
  } finally { await shutdown(t); }
});

test("E11.4 (post-E22/SM-205): header has two toolbar rows — menu (top) + search/filter (bottom)", async () => {
  const t = await bootUI();
  try {
    const doc = t.dom.window.document;
    const header = doc.querySelector("header.app-header");
    assert.ok(header, "expected <header class='app-header'>");
    assert.ok(header.querySelector(".toolbar.toolbar-menu .brand"), "brand should be in toolbar-menu row");
    assert.ok(header.querySelector(".toolbar.toolbar-menu #menu-bar.menu-bar"), "menu-bar should be in toolbar-menu row");
    assert.ok(header.querySelector(".toolbar.toolbar-menu #current-project"), "current-project anchor should be in toolbar-menu row");
    // E22: + Ticket / + Release / + Process Step moved to the Edit menu.
    // SM-205: the view-toggle moved to a top-level View menu; toolbar-action now
    // carries only search + filter.
    assert.strictEqual(header.querySelector("#btn-new-ticket"), null, "+Ticket toolbar button removed in E22");
    assert.strictEqual(header.querySelector(".view-toggle"), null, "view-toggle removed (now a View menu)");
    assert.ok(header.querySelector(".toolbar.toolbar-action #ticket-search"), "search stays in the toolbar-action row");
    assert.ok(header.querySelector('.menu-bar .menu-item[data-menu-id="view"]'), "View menu present in the menu bar");
    assert.strictEqual(header.querySelector("#project-select"), null);
    assert.strictEqual(header.querySelector("#adapter-badge"), null);
  } finally { await shutdown(t); }
});

test("E17/E9h: there is a divider element (.sep, cmapper-Pattern) in header", async () => {
  const t = await bootUI();
  try {
    const doc = t.dom.window.document;
    const divider = doc.querySelector(".app-header .sep");
    assert.ok(divider, "expected .sep element (renamed from .toolbar-divider to match cmapper)");
  } finally { await shutdown(t); }
});

test("E22: Add Ticket lives in the Edit menu (not in the toolbar)", async () => {
  const t = await bootUI();
  try {
    const doc = t.dom.window.document;
    assert.strictEqual(doc.getElementById("btn-new-ticket"), null, "old toolbar button gone");
    // Open Edit menu and assert Add Ticket… is present.
    const editTop = doc.querySelector('.menu-bar .menu-item[data-menu-id="edit"]');
    assert.ok(editTop, "Edit menu entry must exist");
    editTop.dispatchEvent(new t.dom.window.MouseEvent("click", { bubbles: true }));
    await tick(t.dom, 30);
    const hit = Array.from(doc.querySelectorAll(".menu-dropdown .menu-dropdown-item"))
      .find(d => /add ticket/i.test(d.textContent));
    assert.ok(hit, "Edit ▸ Add Ticket… must exist");
  } finally { await shutdown(t); }
});

// ---------------------------------------------------------------------------
// E12 — Releases & Process-Steps UI (toolbar buttons, modals)
// ---------------------------------------------------------------------------

async function createRelease(t, { name, description, status }) {
  const doc = t.dom.window.document;
  await clickMenuItem(t, "edit", /add release/i);
  const modal = doc.querySelector(".modal");
  assert.ok(modal, "release modal did not open");
  modal.querySelector("#nr-name").value = name;
  if (description) modal.querySelector("#nr-desc").value = description;
  if (status) modal.querySelector("#nr-status").value = status;
  const createBtn = Array.from(modal.querySelectorAll(".modal-actions .btn"))
    .find(b => /create/i.test(b.textContent));
  createBtn.dispatchEvent(new t.dom.window.MouseEvent("click", { bubbles: true }));
  await tick(t.dom, 500);
}

async function createProcessStep(t, { name, description }) {
  const doc = t.dom.window.document;
  await clickMenuItem(t, "edit", /add process step/i);
  const modal = doc.querySelector(".modal");
  assert.ok(modal, "process-step modal did not open");
  modal.querySelector("#nps-name").value = name;
  if (description) modal.querySelector("#nps-desc").value = description;
  const createBtn = Array.from(modal.querySelectorAll(".modal-actions .btn"))
    .find(b => /create/i.test(b.textContent));
  createBtn.dispatchEvent(new t.dom.window.MouseEvent("click", { bubbles: true }));
  await tick(t.dom, 500);
}

test("SM-239: release progress badge counts up live (WS push) and turns green when all done", async () => {
  const t = await bootUI();
  try {
    await createProject(t, { id: "rp", name: "RP", prefix: "R" });
    const doc = t.dom.window.document;
    // SM-254 seeded a default release + process step on create. Find their ids.
    const seed = await (await fetch(`${t.base}/api/projects/rp`)).json();
    assert.ok(seed.releases.length >= 1, "expected a seeded release");
    const rid = seed.releases[0].id;
    const psid = seed.processSteps[0].id;
    // Two stories into that cell via REST (an external write → WS push to the page).
    for (const title of ["S1", "S2"]) {
      await fetch(`${t.base}/api/projects/rp/tickets`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "user-story", title, position: { releaseId: rid, processStepId: psid } })
      });
    }
    await tick(t.dom, 700);
    const badgeSel = `#story-map-host .sm-release-label-row[data-release-id="${rid}"] .sm-release-progress`;
    let badge = doc.querySelector(badgeSel);
    assert.ok(badge, "progress badge rendered after stories land");
    assert.strictEqual(badge.textContent, "0/2");
    assert.ok(!badge.classList.contains("complete"), "not green while open");
    // Mark ONE story done via snapshot PUT (state-replace bypasses the DoD gate).
    let cur = await (await fetch(`${t.base}/api/projects/rp`)).json();
    cur.tickets.find(x => x.title === "S1").status = "done";
    await fetch(`${t.base}/api/projects/rp`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(cur) });
    await tick(t.dom, 700);
    badge = doc.querySelector(badgeSel);
    assert.strictEqual(badge.textContent, "1/2", "badge counted up live via WS push");
    assert.ok(!badge.classList.contains("complete"));
    // Mark the LAST story done → badge turns green.
    cur = await (await fetch(`${t.base}/api/projects/rp`)).json();
    cur.tickets.forEach(x => { if (x.type === "user-story") x.status = "done"; });
    await fetch(`${t.base}/api/projects/rp`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(cur) });
    await tick(t.dom, 700);
    badge = doc.querySelector(badgeSel);
    assert.strictEqual(badge.textContent, "2/2");
    assert.ok(badge.classList.contains("complete"), "badge turned green when all done");
  } finally { await shutdown(t); }
});

test("SM-272: collapsing a process-step column makes it narrow with an 'N epics' count, persisted", async () => {
  const t = await bootUI();
  try {
    await createProject(t, { id: "cc", name: "CC", prefix: "C" });
    const doc = t.dom.window.document;
    const seed = await (await fetch(`${t.base}/api/projects/cc`)).json();
    const rid = seed.releases[0].id, psid = seed.processSteps[0].id;
    // An epic mapped into the (release × step) cell.
    await fetch(`${t.base}/api/projects/cc/tickets`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "epic", title: "BigEpic", position: { releaseId: rid, processStepId: psid } })
    });
    await tick(t.dom, 700);
    const col = () => doc.querySelector(`#story-map-host .sm-backbone-col[data-process-step-id="${psid}"]`);
    assert.ok(col() && !col().classList.contains("sm-col-collapsed"), "column starts expanded");
    // click the collapse chevron
    col().querySelector(".sm-col-chevron").dispatchEvent(new t.dom.window.MouseEvent("click", { bubbles: true }));
    await tick(t.dom, 200);
    assert.ok(col().classList.contains("sm-col-collapsed"), "column collapsed after chevron click");
    const cell = doc.querySelector(`#story-map-host .sm-release-cells[data-release-id="${rid}"] .sm-cell-collapsed[data-process-step-id="${psid}"]`);
    assert.ok(cell, "collapsed cell present");
    assert.ok(/1 epic\b/.test((cell.querySelector(".sm-cell-collapsed-count") || {}).textContent || ""), "shows the epic count");
    // persisted to localStorage
    const stored = t.dom.window.localStorage.getItem("storymap-column-collapsed-cc");
    assert.ok(stored && JSON.parse(stored).includes(psid), "collapsed column persisted: " + stored);
  } finally { await shutdown(t); }
});

test("SM-271: View ▸ Hide completed releases toggles the completed release row in the Map", async () => {
  const t = await bootUI();
  try {
    await createProject(t, { id: "hc", name: "HC", prefix: "H" });
    const doc = t.dom.window.document;
    await createRelease(t, { name: "OldShipped", status: "completed" });
    const labelTexts = () => Array.from(doc.querySelectorAll("#story-map-host .sm-release-label")).map(e => e.textContent);
    assert.ok(labelTexts().some(l => /OldShipped/.test(l)), "completed release visible before hiding");
    // toggle on
    await clickMenuItem(t, "view", /hide completed releases/i);
    await tick(t.dom, 200);
    assert.ok(!labelTexts().some(l => /OldShipped/.test(l)), "completed release hidden after toggle ON");
    // toggle off → back
    await clickMenuItem(t, "view", /hide completed releases/i);
    await tick(t.dom, 200);
    assert.ok(labelTexts().some(l => /OldShipped/.test(l)), "completed release visible again after toggle OFF");
  } finally { await shutdown(t); }
});

test("SM-274: a release-less ticket shows in the Map-Eingang strip (.sm-tray)", async () => {
  const t = await bootUI();
  try {
    await createProject(t, { id: "tray", name: "Tray", prefix: "T" });
    const win = t.dom.window;
    const doc = win.document;
    const store = win.STORYMAP.app.store;
    const ACTOR = { type: "human", id: "e2e", name: "E2E" };
    // A release-LESS epic — invisible in both views before SM-274.
    store.createTicket({ type: "epic", title: "Unplaced epic" }, ACTOR);
    await tick(t.dom, 60);
    const tray = doc.querySelector("#story-map-host .sm-tray");
    assert.ok(tray, "Map-Eingang strip is present when there is unassigned work");
    assert.ok(tray.textContent.includes("Unplaced epic"), "the release-less epic is visible in the tray");
    assert.ok(tray.querySelector(".sm-tray-grid .sm-story-card"), "epic rendered as a card in the tray grid");
  } finally {
    await shutdown(t);
  }
});

test("SM-276: schedule from the Map-Eingang onto a cell, then unassign back — round trip", async () => {
  const t = await bootUI();
  try {
    await createProject(t, { id: "tray2", name: "Tray2", prefix: "T" });
    const win = t.dom.window;
    const doc = win.document;
    const store = win.STORYMAP.app.store;
    const dnd = win.STORYMAP.dnd;
    const STORY = win.STORYMAP.rendererStoryMap.DRAG_TYPES.STORY;
    const ACTOR = { type: "human", id: "e2e", name: "E2E" };
    // Release-less → starts in the inbox. (createProject seeds one release + step.)
    store.createTicket({ type: "user-story", title: "InboxStory" }, ACTOR);
    await tick(t.dom, 60);
    let tray = doc.querySelector("#story-map-host .sm-tray");
    assert.ok(tray && tray.textContent.includes("InboxStory"), "starts in the inbox");
    const sid = store.get().tickets.find(x => x.title === "InboxStory").id;

    // Schedule: drop the inbox card onto the (seeded) cell.
    const cell = doc.querySelector("#story-map-host .sm-cell[data-release-id][data-process-step-id]");
    assert.ok(cell, "a cell exists");
    dnd._getDropTarget(cell).onDrop({ type: STORY, id: sid, target: cell });
    await tick(t.dom, 60);
    let pos = store.get().tickets.find(x => x.id === sid).position;
    assert.ok(pos.releaseId && pos.processStepId, "scheduled into the cell");
    tray = doc.querySelector("#story-map-host .sm-tray");
    assert.ok(!tray || !tray.textContent.includes("InboxStory"), "left the inbox after scheduling");

    // Unassign: drop it back onto the tray (need the tray present → seed another inbox card).
    store.createTicket({ type: "user-story", title: "Keeper" }, ACTOR);
    await tick(t.dom, 60);
    tray = doc.querySelector("#story-map-host .sm-tray");
    assert.ok(tray, "inbox present again");
    dnd._getDropTarget(tray).onDrop({ type: STORY, id: sid, target: tray });
    await tick(t.dom, 60);
    pos = store.get().tickets.find(x => x.id === sid).position;
    assert.strictEqual(pos.releaseId, null, "release cleared → back in the inbox");
    assert.ok(doc.querySelector("#story-map-host .sm-tray").textContent.includes("InboxStory"), "back in the inbox");
  } finally {
    await shutdown(t);
  }
});

test("SM-244: a cancelled ticket does NOT count as open when completing a release", async () => {
  const t = await bootUI();
  try {
    await createProject(t, { id: "cx", name: "CX", prefix: "C" });
    const doc = t.dom.window.document;
    const seed = await (await fetch(`${t.base}/api/projects/cx`)).json();
    const rid = seed.releases[0].id, psid = seed.processSteps[0].id;
    for (const title of ["KeepOpen", "Dropped"]) {
      await fetch(`${t.base}/api/projects/cx/tickets`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "user-story", title, position: { releaseId: rid, processStepId: psid } })
      });
    }
    // Cancel "Dropped" via snapshot PUT (external write → WS push).
    const cur = await (await fetch(`${t.base}/api/projects/cx`)).json();
    cur.tickets.find(x => x.title === "Dropped").status = "cancelled";
    await fetch(`${t.base}/api/projects/cx`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(cur) });
    await tick(t.dom, 700);
    // Open the edit-release dialog (click the release label), select completed.
    const label = doc.querySelector(`#story-map-host .sm-release-label[data-release-id="${rid}"]`)
      || doc.querySelector("#story-map-host .sm-release-label");
    label.dispatchEvent(new t.dom.window.MouseEvent("click", { bubbles: true }));
    await tick(t.dom, 50);
    const statusSel = doc.querySelector("#er-status");
    statusSel.value = "completed";
    statusSel.dispatchEvent(new t.dom.window.Event("change", { bubbles: true }));
    await tick(t.dom, 50);
    const warn = doc.querySelector("#er-open-warning");
    const warnText = warn ? warn.textContent : "";
    assert.ok(/KeepOpen/.test(warnText), "the open story is still flagged: " + warnText);
    assert.ok(!/Dropped/.test(warnText), "the cancelled story must NOT count as open: " + warnText);
  } finally { await shutdown(t); }
});

test("E12: + Release button creates release, label visible in grid", async () => {
  const t = await bootUI();
  try {
    await createProject(t, { id: "rs", name: "RS", prefix: "R" });
    await createRelease(t, { name: "v1.0" });
    const doc = t.dom.window.document;
    const labels = Array.from(doc.querySelectorAll(".sm-release-label")).map(e => e.textContent);
    assert.ok(labels.some(l => l.includes("v1.0")), "release label v1.0 missing; got " + JSON.stringify(labels));
  } finally { await shutdown(t); }
});

test("E12: + Process Step button creates step, column visible in backbone", async () => {
  const t = await bootUI();
  try {
    await createProject(t, { id: "ps", name: "PS", prefix: "P" });
    await createProcessStep(t, { name: "Onboarding" });
    const doc = t.dom.window.document;
    const cols = Array.from(doc.querySelectorAll(".sm-backbone-col"))
      .map(e => e.textContent);
    assert.ok(cols.some(c => c.includes("Onboarding")), "process-step column missing; got " + JSON.stringify(cols));
  } finally { await shutdown(t); }
});

test("E12: after creating a release + a process step, the grid has cells", async () => {
  const t = await bootUI();
  try {
    await createProject(t, { id: "full", name: "Full", prefix: "F" });
    // openNewProjectDialog seeds default release+PS (E9i), then we add one more of each.
    // Total: 2 releases × 2 processSteps = 4 cells.
    await createRelease(t, { name: "v1.1" });
    await createProcessStep(t, { name: "Onboarding" });
    const doc = t.dom.window.document;
    assert.strictEqual(doc.querySelector("#story-map-host .sm-empty-state"), null);
    const cells = doc.querySelectorAll(".sm-release-row .sm-cell");
    assert.ok(cells.length >= 1, "expected at least 1 cell, got " + cells.length);
  } finally { await shutdown(t); }
});

test("E9i: new project creates a default release + default process step → first cell visible", async () => {
  const t = await bootUI();
  try {
    await createProject(t, { id: "defs", name: "Defaults", prefix: "D" });
    await tick(t.dom, 400);
    const doc = t.dom.window.document;
    // We expect at least one release-row + at least one backbone-col → exactly one .sm-cell.
    const cells = doc.querySelectorAll(".sm-release-row .sm-cell");
    assert.ok(cells.length >= 1, "expected at least one cell after project create, got " + cells.length);
    const cols = Array.from(doc.querySelectorAll(".sm-backbone-col")).map(e => e.textContent);
    const labels = Array.from(doc.querySelectorAll(".sm-release-label")).map(e => e.textContent);
    assert.ok(cols.length >= 1, "expected at least one process-step column: " + JSON.stringify(cols));
    assert.ok(labels.length >= 1, "expected at least one release label: " + JSON.stringify(labels));
  } finally { await shutdown(t); }
});

test("E9i: backbone has an add-column dropzone at the right edge", async () => {
  const t = await bootUI();
  try {
    await createProject(t, { id: "addcol", name: "AddCol", prefix: "A" });
    await tick(t.dom, 400);
    const doc = t.dom.window.document;
    const addCol = doc.querySelector(".sm-backbone .sm-add-col");
    assert.ok(addCol, "expected .sm-add-col element at backbone right edge");
    assert.ok(/add|new|process/i.test(addCol.textContent), "should hint at adding a process step");
  } finally { await shutdown(t); }
});

test("E12: clicking a release label opens edit modal (rename + delete)", async () => {
  const t = await bootUI();
  try {
    await createProject(t, { id: "ed", name: "Ed", prefix: "E" });
    await createRelease(t, { name: "v1.0" });
    const doc = t.dom.window.document;
    const label = doc.querySelector(".sm-release-label");
    label.dispatchEvent(new t.dom.window.MouseEvent("click", { bubbles: true }));
    await tick(t.dom, 30);
    const modal = doc.querySelector(".modal");
    assert.ok(modal, "edit modal did not open on label click");
    const nameInput = modal.querySelector("#er-name");
    assert.ok(nameInput, "edit modal missing #er-name input");
    assert.strictEqual(nameInput.value, "v1.0");
    // Delete button must be present.
    const del = Array.from(modal.querySelectorAll(".btn")).find(b => /delete/i.test(b.textContent));
    assert.ok(del, "delete button missing in release-edit modal");
  } finally { await shutdown(t); }
});

test("SM-255: the last release's Delete button is disabled in the edit modal", async () => {
  const t = await bootUI();
  try {
    // A freshly created project has exactly one (seeded) release — the last one.
    await createProject(t, { id: "lr", name: "LastRel", prefix: "L" });
    const doc = t.dom.window.document;
    const label = doc.querySelector(".sm-release-label");
    assert.ok(label, "seeded release label should render");
    label.dispatchEvent(new t.dom.window.MouseEvent("click", { bubbles: true }));
    await tick(t.dom, 30);
    const modal = doc.querySelector(".modal");
    const del = Array.from(modal.querySelectorAll(".btn")).find(b => /delete/i.test(b.textContent));
    assert.ok(del, "delete button present");
    assert.ok(del.hasAttribute("disabled"), "delete is disabled for the last release");
  } finally { await shutdown(t); }
});

// ---------------------------------------------------------------------------
// E9d — Keyboard shortcuts + empty-state + drag affordance
// ---------------------------------------------------------------------------

test("E9d: Cmd-Z / Ctrl-Z triggers store.undo()", async () => {
  const t = await bootUI();
  try {
    await createProject(t, { id: "kb", name: "Kb", prefix: "K" });
    await createTicket(t, { type: "user-story", title: "Will be undone" });
    const doc = t.dom.window.document;
    // Card present.
    let cards = doc.querySelectorAll("#story-map-host .sm-story-card");
    assert.strictEqual(cards.length, 1, "expected 1 story card before undo");
    // Dispatch Cmd-Z on document (the global handler should listen here).
    doc.dispatchEvent(new t.dom.window.KeyboardEvent("keydown", {
      key: "z", code: "KeyZ", metaKey: true, bubbles: true
    }));
    await tick(t.dom, 100);
    cards = doc.querySelectorAll("#story-map-host .sm-story-card");
    assert.strictEqual(cards.length, 0, "undo should remove the just-created ticket");
  } finally { await shutdown(t); }
});

// SM-3: the standalone "DoR / DoD Settings" modal has been removed. The
// DoR/DoD editor now lives inside the Settings view (Project ▸ Settings…)
// as its own section between Workflow and Kanban Board — see SM-2 +
// test-frontend-view-settings.js for coverage.

test("E18.E (post-E22): Undo/Redo live in the Edit menu and reflect store-stack state", async () => {
  const t = await bootUI();
  try {
    const doc = t.dom.window.document;
    const win = t.dom.window;
    function readEditItem(labelRegex) {
      const top = doc.querySelector('.menu-bar .menu-item[data-menu-id="edit"]');
      top.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
      // Each item has <span class="menu-label">…</span> + optional shortcut
      // span. Match on the label only, otherwise the shortcut characters
      // (Mod+Z, etc.) bleed into textContent and break a tight regex.
      const item = Array.from(doc.querySelectorAll(".menu-dropdown .menu-dropdown-item"))
        .find(d => {
          const lbl = d.querySelector(".menu-label");
          return lbl && labelRegex.test(lbl.textContent);
        });
      doc.body.dispatchEvent(new win.MouseEvent("mousedown", { bubbles: true }));
      return item;
    }
    // Before project load: undo/redo are disabled (no store yet).
    assert.ok(readEditItem(/^undo$/i).classList.contains("disabled"));
    assert.ok(readEditItem(/^redo$/i).classList.contains("disabled"));

    await createProject(t, { id: "ur", name: "U", prefix: "U" });
    await createTicket(t, { type: "user-story", title: "First" });
    // Now at least one commit → undo enabled, redo still disabled.
    assert.ok(!readEditItem(/^undo$/i).classList.contains("disabled"), "undo should be enabled after commit");
    assert.ok( readEditItem(/^redo$/i).classList.contains("disabled"), "redo still disabled before any undo");

    // Click undo via the menu → redo becomes enabled.
    await clickMenuItem(t, "edit", /^undo$/i);
    await tick(t.dom, 100);
    assert.ok(!readEditItem(/^redo$/i).classList.contains("disabled"), "redo should be enabled after undo");
  } finally { await shutdown(t); }
});

test("E9f: empty state hint REMOVED (user feedback) — no .sm-empty-state in DOM", async () => {
  const t = await bootUI();
  try {
    await createProject(t, { id: "empty", name: "E", prefix: "E" });
    const hint = t.dom.window.document.querySelector("#story-map-host .sm-empty-state");
    assert.strictEqual(hint, null, "Setup-the-Story-Map box should be gone");
  } finally { await shutdown(t); }
});

test("E17: bottom statusbar exists with adapter slot + spacer", async () => {
  const t = await bootUI();
  try {
    const doc = t.dom.window.document;
    const sb = doc.querySelector("footer.statusbar");
    assert.ok(sb, "expected <footer class='statusbar'>");
    const adapter = sb.querySelector("#adapter-badge");
    assert.ok(adapter, "adapter-badge must be in statusbar now");
    assert.strictEqual(adapter.textContent, "Http");
    // build-tag also lives in statusbar (sub-info)
    assert.ok(sb.querySelector("#build-tag"), "build-tag should be in statusbar");
  } finally { await shutdown(t); }
});

test("E21.G: Project ▸ Settings → '+ Add Column' grows project.boards.kanban.columns", async () => {
  const t = await bootUI();
  try {
    await createProject(t, { id: "bed", name: "B", prefix: "B" });
    const doc = t.dom.window.document;
    const win = t.dom.window;
    await clickMenuItem(t, "project", /^settings/i);
    await tick(t.dom, 50);
    const before = win.STORYMAP.app.store.get().project.boards.kanban.columns.length;
    const addBtn = doc.querySelector(".vs-board-editor .vs-board-add-column");
    assert.ok(addBtn, "add-column button missing");
    addBtn.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    await tick(t.dom, 50);
    const after = win.STORYMAP.app.store.get().project.boards.kanban.columns;
    assert.strictEqual(after.length, before + 1);
    const tail = after[after.length - 1];
    assert.strictEqual(tail.name, "New Column");
    assert.ok(Array.isArray(tail.statusIds), "statusIds must be an array");
    assert.strictEqual(tail.statusIds.length, 0, "new column starts empty");
  } finally { await shutdown(t); }
});

test("E21.F: Project ▸ Settings → '+ Add Transition' grows workflow.transitions", async () => {
  const t = await bootUI();
  try {
    await createProject(t, { id: "trd", name: "T", prefix: "T" });
    const doc = t.dom.window.document;
    const win = t.dom.window;
    await clickMenuItem(t, "project", /^settings/i);
    await tick(t.dom, 50);
    const before = win.STORYMAP.app.store.get().project.workflow.transitions.length;
    const addBtn = doc.querySelector(".vs-transition-editor .vs-transition-add");
    assert.ok(addBtn, "add-transition button missing");
    addBtn.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    await tick(t.dom, 50);
    const after = win.STORYMAP.app.store.get().project.workflow.transitions;
    assert.strictEqual(after.length, before + 1, "transitions should grow by one");
    const tail = after[after.length - 1];
    assert.strictEqual(tail.name, "New Transition");
    assert.strictEqual(tail.allowFromAny, true);
    assert.strictEqual(tail.requireGate, null);
  } finally { await shutdown(t); }
});

test("E21.E (post-E22): Project ▸ Settings → '+ Add Status' grows the project's workflow.statuses", async () => {
  const t = await bootUI();
  try {
    await createProject(t, { id: "sed", name: "S", prefix: "S" });
    const doc = t.dom.window.document;
    const win = t.dom.window;
    // E22: Settings is now reached via the Project menu, not the view-toggle.
    await clickMenuItem(t, "project", /^settings/i);
    await tick(t.dom, 50);
    const before = win.STORYMAP.app.store.get().project.workflow.statuses.length;
    const addBtn = doc.querySelector(".vs-status-editor .vs-status-add");
    assert.ok(addBtn, "add-status button missing");
    addBtn.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    await tick(t.dom, 50);
    const after = win.STORYMAP.app.store.get().project.workflow.statuses;
    assert.strictEqual(after.length, before + 1, "workflow.statuses should grow by one");
    assert.strictEqual(after[after.length - 1].name, "New Status");
  } finally { await shutdown(t); }
});

test("E23.B: Settings is an overlay over the active view (Map stays mounted underneath)", async () => {
  const t = await bootUI();
  try {
    await createProject(t, { id: "sview", name: "S", prefix: "S" });
    const doc = t.dom.window.document;
    const win = t.dom.window;
    // SM-205: view switching lives in a top-level View menu — no toolbar toggles.
    assert.strictEqual(doc.querySelectorAll(".view-toggle-btn").length, 0, "no view-toggle buttons");
    assert.ok(doc.querySelector('.menu-bar .menu-item[data-menu-id="view"]'), "View menu present in the menu bar");
    // Overlay host exists and is hidden by default.
    const settingsHost = doc.getElementById("settings-host");
    assert.ok(settingsHost, "settings-host element must exist");
    assert.strictEqual(settingsHost.hidden, true);
    // Project ▸ Settings → overlay opens; the Map host stays mounted.
    await clickMenuItem(t, "project", /^settings/i);
    await tick(t.dom, 50);
    assert.strictEqual(settingsHost.hidden, false, "overlay should be visible after menu click");
    assert.strictEqual(doc.getElementById("story-map-host").hidden, false,
      "Map should stay mounted under the overlay");
    assert.ok(settingsHost.querySelector(".vs-root"),
      "settings view should mount its root inside the overlay");
    assert.ok(settingsHost.querySelector(".vs-overlay-close"),
      "overlay must expose a close button");
    // localStorage should NOT have switched activeView — overlay is not a view.
    assert.notStrictEqual(win.localStorage.getItem("storymap-active-view"), "settings");
    // Click the close X → overlay hides, Map stays.
    settingsHost.querySelector(".vs-overlay-close")
      .dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    await tick(t.dom, 50);
    assert.strictEqual(settingsHost.hidden, true);
    assert.strictEqual(doc.getElementById("story-map-host").hidden, false);
  } finally { await shutdown(t); }
});

test("SM-203 R-7: Requirements is a full-page view (toggle shows it; empty state without a module)", async () => {
  const t = await bootUI();
  try {
    await createProject(t, { id: "rqv", name: "R", prefix: "R" });
    const doc = t.dom.window.document;
    const win = t.dom.window;
    const reqHost = doc.getElementById("requirements-view-host");
    assert.ok(reqHost, "requirements view host exists");
    assert.strictEqual(reqHost.hidden, true, "hidden by default");
    // Switch to the Requirements view via the View menu (full page, not an overlay).
    await clickMenuItem(t, "view", /requirements/i);
    await tick(t.dom, 50);
    assert.strictEqual(reqHost.hidden, false, "requirements host visible after toggle");
    assert.strictEqual(doc.getElementById("story-map-host").hidden, true, "map hidden underneath");
    assert.ok(reqHost.querySelector(".vr-root"), "vr-root mounted full-page");
    assert.ok(reqHost.querySelector(".vr-empty"), "empty state shown (no spec module yet)");
    assert.strictEqual(win.localStorage.getItem("storymap-active-view"), "requirements",
      "Requirements is a persisted activeView, not an overlay");
    // SM-205: the active view is check-marked in the View menu, labels in one column.
    doc.querySelector('.menu-bar .menu-item[data-menu-id="view"]')
      .dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    await tick(t.dom, 30);
    const items = Array.from(doc.querySelectorAll(".menu-dropdown .menu-dropdown-item"));
    const reqItem = items.find(d => /requirements/i.test(d.querySelector(".menu-label").textContent));
    const mapItem = items.find(d => /^map$/i.test(d.querySelector(".menu-label").textContent));
    assert.ok(reqItem.querySelector(".menu-check"), "every item has a check gutter");
    assert.strictEqual(reqItem.querySelector(".menu-check").textContent, "✓", "active view shows the check");
    assert.strictEqual(mapItem.querySelector(".menu-check").textContent, "", "inactive view has an empty gutter");
    assert.strictEqual(reqItem.querySelector(".menu-label").textContent, "Requirements",
      "label text carries no inline check (it lives in the gutter)");
  } finally { await shutdown(t); }
});

test("SM-248: Process Steps is a full-page view (toggle shows it + persists; cards render)", async () => {
  const t = await bootUI();
  try {
    await createProject(t, { id: "psv", name: "PS", prefix: "P" });
    const doc = t.dom.window.document;
    const win = t.dom.window;
    // The default-boot project already seeds a release + one process step.
    const psHost = doc.getElementById("process-steps-host");
    assert.ok(psHost, "process-steps view host exists");
    assert.strictEqual(psHost.hidden, true, "hidden by default");
    await clickMenuItem(t, "view", /process steps/i);
    await tick(t.dom, 50);
    assert.strictEqual(psHost.hidden, false, "process-steps host visible after toggle");
    assert.strictEqual(doc.getElementById("story-map-host").hidden, true, "map hidden underneath");
    assert.ok(psHost.querySelector(".psv-root"), "psv-root mounted full-page");
    // SM-256: steps render via the SHARED card component (teal cluster), not a
    // parallel .psv-card — DRY.
    assert.ok(psHost.querySelector(".sm-story-card[data-process-step-id].sm-cluster-process"),
      "at least one step card rendered via the shared component");
    assert.strictEqual(win.localStorage.getItem("storymap-active-view"), "processSteps",
      "Process Steps is a persisted activeView");
  } finally { await shutdown(t); }
});

test("E23.B: Esc closes the Settings overlay", async () => {
  const t = await bootUI();
  try {
    await createProject(t, { id: "sesc", name: "Esc", prefix: "E" });
    const doc = t.dom.window.document;
    const win = t.dom.window;
    await clickMenuItem(t, "project", /^settings/i);
    await tick(t.dom, 50);
    const settingsHost = doc.getElementById("settings-host");
    assert.strictEqual(settingsHost.hidden, false);
    // Esc anywhere closes the overlay.
    doc.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await tick(t.dom, 50);
    assert.strictEqual(settingsHost.hidden, true);
  } finally { await shutdown(t); }
});

test("E11: View-Toggle switches between Story-Map and Kanban", async () => {
  const t = await bootUI();
  try {
    await createProject(t, { id: "kview", name: "K", prefix: "K" });
    const doc = t.dom.window.document;
    // Initial: storymap visible, kanban hidden.
    const mapHost = doc.getElementById("story-map-host");
    const kanbanHost = doc.getElementById("kanban-host");
    assert.ok(mapHost, "story-map-host missing");
    assert.ok(kanbanHost, "kanban-host missing");
    assert.strictEqual(mapHost.hidden, false, "story-map should be visible by default");
    assert.strictEqual(kanbanHost.hidden, true, "kanban should be hidden by default");
    // Switch to Kanban via the View menu (SM-205).
    await clickMenuItem(t, "view", /kanban/i);
    await tick(t.dom, 50);
    assert.strictEqual(mapHost.hidden, true,  "story-map should hide after switching to kanban");
    assert.strictEqual(kanbanHost.hidden, false, "kanban should show after switch");
    assert.ok(kanbanHost.querySelector(".km-board"), "kanban board should be mounted");
    // Switch back to Map.
    await clickMenuItem(t, "view", /map/i);
    await tick(t.dom, 50);
    assert.strictEqual(mapHost.hidden, false);
    assert.strictEqual(kanbanHost.hidden, true);
  } finally { await shutdown(t); }
});

test("SM-169: Kanban renders release swimlanes; completed releases collapse by default; label toggles", async () => {
  const t = await bootUI();
  try {
    await createProject(t, { id: "swim", name: "Swim", prefix: "S" });
    const win = t.dom.window;
    const doc = win.document;
    const store = win.STORYMAP.app.store;
    const ACTOR = { type: "human", id: "e2e", name: "E2E" };
    // Two releases: one completed, one active; plus an unscheduled ticket.
    // createRelease mints its own id — capture the real ids by (distinct) name.
    store.createRelease({ name: "Done-rel", status: "completed", sortOrder: 0 }, ACTOR);
    store.createRelease({ name: "Live-rel", status: "planning",  sortOrder: 1 }, ACTOR);
    const rels = store.get().releases;
    const rDone = rels.find(r => r.name === "Done-rel").id;
    const rLive = rels.find(r => r.name === "Live-rel").id;
    store.createTicket({ type: "user-story", title: "Shipped", status: "done",    position: { releaseId: rDone } }, ACTOR);
    store.createTicket({ type: "user-story", title: "Active",  status: "backlog", position: { releaseId: rLive } }, ACTOR);
    store.createTicket({ type: "user-story", title: "Loose",   status: "backlog" }, ACTOR);
    // Let the debounced save-subscriber (300ms) flush to the server before we
    // re-load — loadProject reads the server snapshot, not the local store.
    await tick(t.dom, 450);

    // The collapse-seed ran on the first loadProject (before these releases
    // existed) and persisted an empty set. Clear it + re-load so the seed
    // re-runs with the completed release present.
    win.localStorage.removeItem("storymap-kanban-collapsed-swim");
    await win.STORYMAP.app.loadProject("swim");
    await tick(t.dom, 50);
    await clickMenuItem(t, "view", /kanban/i);
    await tick(t.dom, 80);

    const host = doc.getElementById("kanban-host");
    const sel = (rid) => '.km-swimlane[data-release-id="' + rid + '"]';
    // Three swimlanes: completed, active, and the always-present No-release row.
    assert.ok(host.querySelector(sel(rDone)), "completed-release swimlane present");
    assert.ok(host.querySelector(sel(rLive)), "active-release swimlane present");
    assert.ok(host.querySelector('.km-swimlane[data-swimlane-key="__none__"]'), "No-release swimlane present");

    // Completed release defaults to collapsed (no cells); active does not.
    const doneLane = host.querySelector(sel(rDone));
    const liveLane = host.querySelector(sel(rLive));
    assert.ok(doneLane.classList.contains("km-swimlane-collapsed"), "completed release collapsed by default");
    assert.strictEqual(doneLane.querySelector(".km-swimlane-cells"), null, "collapsed lane hides cells");
    assert.ok(!liveLane.classList.contains("km-swimlane-collapsed"), "active release expanded by default");
    assert.ok(liveLane.querySelector(".km-swimlane-cells"), "active lane shows cells");

    // Click the completed-release chevron → it expands (re-mount). The header
    // is the shared Story-Map release-label component (.sm-release-chevron).
    doneLane.querySelector(".sm-release-chevron").dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    await tick(t.dom, 80);
    const doneLane2 = doc.querySelector(sel(rDone));
    assert.ok(!doneLane2.classList.contains("km-swimlane-collapsed"), "label click expands the collapsed lane");
    assert.ok(doneLane2.querySelector(".km-swimlane-cells"), "expanded lane shows cells");
  } finally { await shutdown(t); }
});

test("E13 (post-E22): Edit menu has History entry; opening shows revisions; Restore reverts", async () => {
  const t = await bootUI();
  try {
    await createProject(t, { id: "hist", name: "Hist", prefix: "H" });
    await createTicket(t, { type: "user-story", title: "Original" });
    await createTicket(t, { type: "user-story", title: "Later" });
    const doc = t.dom.window.document;
    // E22: History moved from Project menu to Edit menu.
    await clickMenuItem(t, "edit", /history/i);
    await tick(t.dom, 300);
    const modal = doc.querySelector(".modal");
    assert.ok(modal, "history modal did not open");
    const rows = modal.querySelectorAll(".hist-row");
    // SM-254: the server bakes the default release+step into the single
    // project_create revision (the UI no longer POSTs them separately), so the
    // history is project_create + 2× ticket_create.
    assert.ok(rows.length >= 3, "expected >=3 rows (project_create, ticket_create, ticket_create), got " + rows.length);
    // Find the row whose timestamp corresponds to the revision BEFORE "Later"
    // was created. The list is reverse-chrono. The 1st row = most recent
    // (ticket_create of "Later"); the 2nd = create of "Original". We restore
    // to the 2nd row (before "Later").
    const restoreBtns = Array.from(modal.querySelectorAll("[data-restore]"));
    assert.ok(restoreBtns.length >= 2);
    // Stub confirm() to auto-accept.
    t.dom.window.confirm = () => true;
    restoreBtns[1].dispatchEvent(new t.dom.window.MouseEvent("click", { bubbles: true }));
    await tick(t.dom, 400);
    // Modal should be closed. Map should NOT show "Later" anymore.
    assert.strictEqual(doc.querySelector(".modal"), null, "modal should close after restore");
    const titles = Array.from(doc.querySelectorAll(".sm-story-title")).map(e => e.textContent);
    assert.ok(titles.includes("Original"), "Original should be restored: " + JSON.stringify(titles));
    assert.ok(!titles.includes("Later"), "Later should be gone after restore: " + JSON.stringify(titles));
  } finally { await shutdown(t); }
});

test("SM-82: Filter button + popover hide tickets in both views", async () => {
  const t = await bootUI();
  try {
    await createProject(t, { id: "filter-e2e", name: "FilterE2E", prefix: "F" });
    await createTicket(t, { type: "user-story", title: "Open-story" });
    await createTicket(t, { type: "bug",        title: "Open-bug" });
    const doc = t.dom.window.document;

    // Pre-filter: both tickets visible in Map and Kanban.
    const initialBacklogCards = doc.querySelectorAll("#story-map-host .sm-release-unplaced-row .sm-story-card");
    assert.strictEqual(initialBacklogCards.length, 2, "expected 2 backlog cards pre-filter");

    // Filter button + badge exist.
    const filterBtn = doc.getElementById("btn-filter");
    assert.ok(filterBtn, "Filter button missing in toolbar");
    const badge = doc.getElementById("filter-badge");
    assert.ok(badge, "Filter badge missing");
    assert.strictEqual(badge.hidden, true, "badge hidden when no filter active");

    // Open popover.
    filterBtn.dispatchEvent(new t.dom.window.MouseEvent("click", { bubbles: true }));
    await tick(t.dom, 30);
    const popover = doc.getElementById("filter-popover");
    assert.ok(popover, "Filter popover did not open");
    // Check at least one Status checkbox + one Type checkbox present.
    const checkrows = popover.querySelectorAll(".filter-popover-checkrow");
    assert.ok(checkrows.length >= 3, "popover should have status + type + hide-completed-releases checkboxes");

    // Activate Type filter: bug only. The popover has THREE sections — Status,
    // Type, Releases. Find the Type-section explicitly to avoid grabbing a
    // status row that happens to contain the word "bug".
    const sections = popover.querySelectorAll(".filter-popover-section");
    const typeSection = Array.from(sections).find(
      s => /^type$/i.test((s.querySelector(".filter-popover-section-title") || {}).textContent || ""));
    assert.ok(typeSection, "Type section missing in popover");
    const bugRow = Array.from(typeSection.querySelectorAll(".filter-popover-checkrow"))
      .find(r => /bug/i.test(r.textContent));
    assert.ok(bugRow, "no 'bug' Type checkbox found");
    const bugCb = bugRow.querySelector("input");
    bugCb.checked = true;
    bugCb.dispatchEvent(new t.dom.window.Event("change", { bubbles: true }));
    await tick(t.dom, 200);

    // After filter applied: only the bug ticket should remain visible.
    const win = t.dom.window;
    const appFilter = win.STORYMAP && win.STORYMAP.app && win.STORYMAP.app.filter;
    assert.ok(appFilter, "app.filter should be set after Type checkbox change; was " + JSON.stringify(appFilter));
    assert.strictEqual(JSON.stringify(appFilter.types), JSON.stringify(["bug"]),
      "app.filter.types should be ['bug']");

    // Diagnostic: confirm filter module is loaded in the browser realm.
    const filterModInWin = t.dom.window.STORYMAP && t.dom.window.STORYMAP.filter;
    assert.ok(filterModInWin, "STORYMAP.filter must be present in JSDOM window");
    // Diagnostic: query the cards in the backlog and what their data-ticket-types are.
    const allBacklog = doc.querySelectorAll("#story-map-host .sm-release-unplaced-row .sm-story-card");
    const types = Array.from(allBacklog).map(c => c.dataset.ticketType);
    const filteredCards = allBacklog;
    assert.strictEqual(filteredCards.length, 1,
      "expected 1 backlog card after type=bug filter, got " + filteredCards.length + " (types: " + JSON.stringify(types) + ")");
    assert.ok(filteredCards[0].textContent.includes("Open-bug"), "remaining card should be the bug");

    // Badge shows 1 active rule.
    const badgeAfter = doc.getElementById("filter-badge");
    assert.strictEqual(badgeAfter.hidden, false, "badge should be visible with active filter");
    assert.strictEqual(badgeAfter.textContent, "1", "badge should show 1 active rule");
    assert.ok(doc.getElementById("btn-filter").classList.contains("active"),
      "filter button gets .active class when filter is on");

    // Click Reset filter → all cards reappear.
    const popoverAfter = doc.getElementById("filter-popover");
    const reset = popoverAfter && popoverAfter.querySelector(".filter-popover-reset");
    assert.ok(reset, "reset button missing");
    reset.dispatchEvent(new t.dom.window.MouseEvent("click", { bubbles: true }));
    await tick(t.dom, 100);
    const resetCards = doc.querySelectorAll("#story-map-host .sm-release-unplaced-row .sm-story-card");
    assert.strictEqual(resetCards.length, 2, "reset → all 2 cards visible again");
  } finally { await shutdown(t); }
});

test("SM-82 followup: bulk All/None toggles select/clear all checkboxes in a section", async () => {
  const t = await bootUI();
  try {
    await createProject(t, { id: "filter-bulk", name: "FilterBulk", prefix: "FB" });
    await createTicket(t, { type: "user-story", title: "S1" });
    await createTicket(t, { type: "bug",        title: "B1" });
    const doc = t.dom.window.document;

    const filterBtn = doc.getElementById("btn-filter");
    filterBtn.dispatchEvent(new t.dom.window.MouseEvent("click", { bubbles: true }));
    await tick(t.dom, 30);
    let popover = doc.getElementById("filter-popover");
    assert.ok(popover, "popover did not open");

    // Find the Type section + its All button.
    function typeSection() {
      return Array.from(doc.querySelectorAll("#filter-popover .filter-popover-section"))
        .find(s => /^type$/i.test((s.querySelector(".filter-popover-section-title") || {}).textContent || ""));
    }
    const allBtn = Array.from(typeSection().querySelectorAll(".filter-popover-bulk"))
      .find(b => /all/i.test(b.textContent));
    assert.ok(allBtn, "Type-section 'All' button missing");

    // Click All on Type → app.filter.types contains every project ticketType.
    allBtn.dispatchEvent(new t.dom.window.MouseEvent("click", { bubbles: true }));
    await tick(t.dom, 100);
    const win = t.dom.window;
    const appFilter1 = win.STORYMAP && win.STORYMAP.app && win.STORYMAP.app.filter;
    assert.ok(appFilter1, "filter should be active after All click");
    assert.ok(Array.isArray(appFilter1.types) && appFilter1.types.length > 0,
      "All click should populate filter.types with project's ticketTypes");

    // Popover has been re-opened (reopen()). Find None button now.
    popover = doc.getElementById("filter-popover");
    assert.ok(popover, "popover should re-open after All click");
    const noneBtn = Array.from(typeSection().querySelectorAll(".filter-popover-bulk"))
      .find(b => /none/i.test(b.textContent));
    assert.ok(noneBtn, "Type-section 'None' button missing");
    noneBtn.dispatchEvent(new t.dom.window.MouseEvent("click", { bubbles: true }));
    await tick(t.dom, 100);
    const appFilter2 = win.STORYMAP && win.STORYMAP.app && win.STORYMAP.app.filter;
    assert.strictEqual(appFilter2, null,
      "None click clears filter.types; with no other dimension active, app.filter becomes null");
  } finally { await shutdown(t); }
});

test("SM-80: Edit Release dialog status → completed → pill appears + filter hides row", async () => {
  const t = await bootUI();
  try {
    await createProject(t, { id: "rel-life", name: "RelLife", prefix: "RL" });
    await createRelease(t, { name: "v1" });
    await createProcessStep(t, { name: "P1" });
    const doc = t.dom.window.document;

    // Open Edit Release dialog by clicking the release label.
    const label = doc.querySelector(".sm-release-label");
    assert.ok(label, "release label rendered");
    label.dispatchEvent(new t.dom.window.MouseEvent("click", { bubbles: true }));
    await tick(t.dom, 50);
    const modal = doc.querySelector(".modal");
    assert.ok(modal, "edit release modal opened");

    // Status dropdown exists and has all four values.
    const statusSel = modal.querySelector("#er-status");
    assert.ok(statusSel, "status dropdown present");
    const opts = Array.from(statusSel.options).map(o => o.value);
    assert.deepStrictEqual(opts.sort(), ["active", "cancelled", "completed", "planning"]);

    // Set status to completed + click Save.
    statusSel.value = "completed";
    const saveBtn = Array.from(modal.querySelectorAll(".modal-actions .btn"))
      .find(b => /save/i.test(b.textContent));
    assert.ok(saveBtn, "Save button present");
    saveBtn.dispatchEvent(new t.dom.window.MouseEvent("click", { bubbles: true }));
    await tick(t.dom, 300);

    // Modal closed; one release in DOM now has data-status="completed" + a pill.
    assert.strictEqual(doc.querySelector(".modal"), null, "modal closed after save");
    const completedLabel = doc.querySelector('.sm-release-label[data-status="completed"]');
    assert.ok(completedLabel, "label with data-status='completed' rendered");
    const pill = doc.querySelector(".sm-release-pill-completed");
    assert.ok(pill, "Completed pill visible in map");

    // Activate "Hide completed releases" filter → release row vanishes.
    doc.getElementById("btn-filter").dispatchEvent(new t.dom.window.MouseEvent("click", { bubbles: true }));
    await tick(t.dom, 30);
    const popover = doc.getElementById("filter-popover");
    assert.ok(popover, "filter popover opened");
    const hideRow = Array.from(popover.querySelectorAll(".filter-popover-checkrow"))
      .find(r => /completed/i.test(r.textContent));
    assert.ok(hideRow, "'Hide completed releases' toggle missing");
    const hideCb = hideRow.querySelector("input");
    hideCb.checked = true;
    hideCb.dispatchEvent(new t.dom.window.Event("change", { bubbles: true }));
    await tick(t.dom, 200);

    // Filter must hide ONLY the completed release. Other releases (seeded
    // default + any we didn't touch) remain visible.
    const visibleLabelRows = Array.from(doc.querySelectorAll(
      '.sm-release-label-row[data-release-id]:not([data-release-id=""])'));
    for (const r of visibleLabelRows) {
      assert.notStrictEqual(r.dataset.status, "completed",
        "no completed release-row should remain after filter");
    }
  } finally { await shutdown(t); }
});

test("SM-80/SM-167: completing a release with open tickets shows a reactive inline list (no window.confirm)", async () => {
  const t = await bootUI();
  try {
    await createProject(t, { id: "rel-warn", name: "RelWarn", prefix: "RW" });
    await createRelease(t, { name: "v1" });
    await createProcessStep(t, { name: "P1" });
    await createTicket(t, { type: "user-story", title: "StillOpen" });
    // Put ONE open ticket into the release. createTicket lands it in backlog;
    // move it into the (release, processStep) cell via the exposed store.
    const win = t.dom.window;
    const snap = win.STORYMAP.app.store.get();
    const ticketId = snap.tickets[0].id;
    const releaseId = snap.releases[0].id;
    const psId = snap.processSteps[0].id;
    win.STORYMAP.app.store.moveTicket(ticketId, { releaseId: releaseId, processStepId: psId },
      { type: "human", id: "local", name: "Local" });
    await tick(t.dom, 100);

    const doc = win.document;
    // SM-252: releases render newest-on-top, so target the label by id (the
    // release that actually holds the open ticket) rather than the first one.
    // data-release-id lives on the .sm-release-label-row wrapper.
    const labelRow = doc.querySelector('.sm-release-label-row[data-release-id="' + releaseId + '"]');
    const label = (labelRow && labelRow.querySelector(".sm-release-label")) || doc.querySelector(".sm-release-label");
    label.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    await tick(t.dom, 50);
    const modal = doc.querySelector(".modal");
    const statusSel = modal.querySelector("#er-status");

    // Selecting "completed" reveals the inline warning listing the open ticket.
    statusSel.value = "completed";
    statusSel.dispatchEvent(new win.Event("change", { bubbles: true }));
    await tick(t.dom, 40);
    const warn = modal.querySelector("#er-open-warning");
    assert.ok(warn && !warn.hidden, "inline warning visible when completing with open tickets");
    assert.ok(/StillOpen/.test(warn.textContent), "warning lists the open ticket title");
    const statusEl = warn.querySelector(".er-open-status");
    assert.ok(statusEl && statusEl.textContent.trim().length > 0, "warning shows the ticket status as a pill");

    // It is informational, not blocking: Save proceeds and completes the release.
    const saveBtn = Array.from(modal.querySelectorAll(".modal-actions .btn"))
      .find(b => /save/i.test(b.textContent));
    saveBtn.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    await tick(t.dom, 200);
    assert.strictEqual(win.STORYMAP.app.store.get().releases[0].status, "completed",
      "Save proceeds (non-blocking warning) — release is completed");
  } finally { await shutdown(t); }
});

test("SM-84: chevron click collapses the epic and persists the state per-project in localStorage", async () => {
  const t = await bootUI();
  try {
    await createProject(t, { id: "epcol", name: "EC", prefix: "E" });
    await createRelease(t, { name: "v1" });
    await createProcessStep(t, { name: "Build" });
    const doc = t.dom.window.document;
    const win = t.dom.window;
    const store = win.STORYMAP.app.store;
    const HUMAN = { type: "human", id: "u1", name: "U" };
    const snap = store.get();
    const rId = snap.releases[0].id;
    const pId = snap.processSteps[0].id;
    // Build an epic with 2 stories so the story-grid actually renders.
    store.createTicket({ type: "epic", title: "BigEpic",
      position: { releaseId: rId, processStepId: pId } }, HUMAN);
    const epicId = store.get().tickets.find(t => t.title === "BigEpic").id;
    store.createTicket({ type: "user-story", title: "S1",
      position: { releaseId: rId, epicId: epicId } }, HUMAN);
    store.createTicket({ type: "user-story", title: "S2",
      position: { releaseId: rId, epicId: epicId } }, HUMAN);
    await tick(t.dom, 50);
    // Initial state: chevron expanded, no localStorage entry.
    const key = "storymap-epic-collapsed-epcol";
    assert.strictEqual(win.localStorage.getItem(key), null,
      "no localStorage entry until first toggle");
    const card = doc.querySelector('.sm-epic-card[data-ticket-id="' + epicId + '"]');
    assert.ok(card, "epic card must be in DOM");
    const chevron = card.querySelector(".sm-epic-chevron");
    assert.ok(chevron, "chevron must be in epic header");
    assert.strictEqual(chevron.textContent, "▼", "starts expanded");
    // Click chevron → epic collapses + localStorage persists.
    chevron.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true }));
    await tick(t.dom, 50);
    assert.ok(card.classList.contains("sm-epic-card-collapsed"),
      "card carries collapsed class after click");
    const persisted = JSON.parse(win.localStorage.getItem(key) || "[]");
    assert.deepStrictEqual(persisted, [epicId],
      "localStorage holds the collapsed epic id");
    // Click again to expand → localStorage cleared (set went empty).
    chevron.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true }));
    await tick(t.dom, 50);
    assert.ok(!card.classList.contains("sm-epic-card-collapsed"),
      "card loses collapsed class on second click");
    assert.strictEqual(win.localStorage.getItem(key), null,
      "empty set removes the localStorage entry");
  } finally { await shutdown(t); }
});

test("SM-117 (B2): /editor loads a ticket type-aware against a real server", async () => {
  const dir = await tmpDir();
  const handle = await startServer({ port: 0, dataDir: dir });
  const port = handle.httpServer.address().port;
  const base = `http://localhost:${port}`;
  try {
    // Seed a project + a user-story directly via REST.
    await fetch(base + "/api/projects", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "ep1", name: "EditorProj", ticketPrefix: "E" })
    });
    const tRes = await fetch(base + "/api/projects/ep1/tickets", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "user-story", title: "Editable Story", description: "body text" })
    });
    const created = (await tRes.json()).ticket;

    // SM-158: open the editor by the human ticket-KEY (not the internal id) —
    // the editor resolves key → id. This is the memorable/type-able URL form.
    const url = `${base}/editor?projectId=ep1&ticketId=${encodeURIComponent(created.ticketKey)}&api=${base}`;
    const dom = await JSDOM.fromURL(url, {
      runScripts: "dangerously", resources: "usable", pretendToBeVisual: true
    });
    dom.window.fetch = (i, x) => fetch(i, x);
    dom.window.WebSocket = WebSocket;
    await new Promise(r => dom.window.addEventListener("load", r));
    await tick(dom, 400);

    const doc = dom.window.document;
    assert.strictEqual(doc.querySelector(".te-key").textContent, "E-1", "ticket-key breadcrumb");
    // SM-118: content-first — title hero in the main column, meta in the sidebar.
    assert.strictEqual(doc.querySelector('.te-main .te-title-row [data-sm-sync-key="title"]').value, "Editable Story",
      "title hero pre-filled from the loaded ticket");
    // SM-119: description is a plain-text contentEditable block (in the main column).
    const descEl = doc.querySelector('.te-main [data-sm-sync-key="description"]');
    assert.strictEqual(descEl.getAttribute("contenteditable"), "true");
    assert.strictEqual(descEl.textContent, "body text");
    assert.ok(doc.querySelector('.te-main .tm-links[data-sm-sync-key="links"]'), "links section below the description in main");
    // Document title carries the ticket key (bookmark/tab affordance).
    assert.ok(/Editable Story/.test(doc.title), "document.title reflects the ticket, got: " + doc.title);
    dom.window.close();
  } finally {
    await handle.shutdown();
  }
});

test("SM-157 (B5-slice): editing the description in the editor + ✓ persists to the server", async () => {
  const dir = await tmpDir();
  const handle = await startServer({ port: 0, dataDir: dir });
  const port = handle.httpServer.address().port;
  const base = `http://localhost:${port}`;
  try {
    await fetch(base + "/api/projects", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "ep2", name: "EditorProj2", ticketPrefix: "E" })
    });
    const tRes = await fetch(base + "/api/projects/ep2/tickets", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "user-story", title: "Persist me", description: "before" })
    });
    const ticketId = (await tRes.json()).ticket.id;

    const url = `${base}/editor?projectId=ep2&ticketId=${ticketId}&api=${base}`;
    const dom = await JSDOM.fromURL(url, {
      runScripts: "dangerously", resources: "usable", pretendToBeVisual: true
    });
    dom.window.fetch = (i, x) => fetch(i, x);
    dom.window.WebSocket = WebSocket;
    await new Promise(r => dom.window.addEventListener("load", r));
    await tick(dom, 400);
    const doc = dom.window.document;

    // Edit the description, then confirm with the inline ✓.
    const ed = doc.querySelector('[data-sm-sync-key="description"]');
    ed.textContent = "after — saved via the inline checkmark";
    ed.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    const save = doc.querySelector(".tm-desc-save");
    assert.ok(save, "inline save (✓) button present in the editor");
    save.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));

    // Let the debounced save-subscriber PUT the snapshot, then verify on the server.
    await tick(dom, 700);
    const check = await fetch(base + "/api/projects/ep2/tickets/" + ticketId);
    const persisted = await check.json();
    assert.strictEqual(persisted.description, "after — saved via the inline checkmark",
      "description edit must survive on the server (no more lost edits)");
    dom.window.close();
  } finally {
    await handle.shutdown();
  }
});

test("SM-120 (B5): editing a scalar field in the editor persists to the server (in-place, no Save)", async () => {
  const dir = await tmpDir();
  const handle = await startServer({ port: 0, dataDir: dir });
  const port = handle.httpServer.address().port;
  const base = `http://localhost:${port}`;
  try {
    await fetch(base + "/api/projects", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "ep3", name: "EditorProj3", ticketPrefix: "E" })
    });
    const tRes = await fetch(base + "/api/projects/ep3/tickets", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "user-story", title: "Old title" })
    });
    const ticketId = (await tRes.json()).ticket.id;

    const url = `${base}/editor?projectId=ep3&ticketId=${ticketId}&api=${base}`;
    const dom = await JSDOM.fromURL(url, {
      runScripts: "dangerously", resources: "usable", pretendToBeVisual: true
    });
    dom.window.fetch = (i, x) => fetch(i, x);
    dom.window.WebSocket = WebSocket;
    await new Promise(r => dom.window.addEventListener("load", r));
    await tick(dom, 400);
    const doc = dom.window.document;

    // Edit the title and blur — no Save button anywhere.
    assert.strictEqual(doc.querySelector('.tm-row .btn[data-role="save"]'), null);
    const titleInput = doc.querySelector('[data-sm-sync-key="title"]');
    titleInput.value = "New title from editor";
    titleInput.dispatchEvent(new dom.window.Event("focusout", { bubbles: true }));

    await tick(dom, 700);  // debounced snapshot PUT
    const check = await fetch(base + "/api/projects/ep3/tickets/" + ticketId);
    const persisted = await check.json();
    assert.strictEqual(persisted.title, "New title from editor",
      "scalar edit must persist on the server without a Save button");
    dom.window.close();
  } finally {
    await handle.shutdown();
  }
});

// SM-15: Export / Import menu entries are wired into the Project menu.
test("SM-15: Project menu exposes Export + Import items; Export enabled with a project", async () => {
  const t = await bootUI();
  try {
    const doc = t.dom.window.document;
    await createProject(t, { id: "exp-test", name: "Export Test", prefix: "ET" });
    const projectMenuBtn = doc.querySelector('.menu-bar .menu-item[data-menu-id="project"]');
    projectMenuBtn.dispatchEvent(new t.dom.window.MouseEvent("click", { bubbles: true }));
    await tick(t.dom, 30);
    const items = Array.from(doc.querySelectorAll(".menu-dropdown .menu-dropdown-item"));
    // SM-295: exactly ONE Import… and ONE Export… entry — the four
    // pre-consolidation entries must be gone.
    const importItems = items.filter(d => /^import/i.test((d.querySelector(".menu-label") || d).textContent.trim()));
    const exportItems = items.filter(d => /^export/i.test((d.querySelector(".menu-label") || d).textContent.trim()));
    assert.strictEqual(importItems.length, 1, "exactly one Import… entry");
    assert.strictEqual(exportItems.length, 1, "exactly one Export… entry");
    assert.ok(!items.some(d => /import project|export project|export tickets|import tickets/i.test(d.textContent)),
      "old per-scope entries removed");
    // A project is loaded → Export must not be disabled.
    assert.ok(!exportItems[0].classList.contains("disabled") && exportItems[0].getAttribute("aria-disabled") !== "true",
      "Export should be enabled when a project is loaded");
  } finally { await shutdown(t); }
});

// SM-16: live ticket search dims non-matching cards, highlights matches.
test("SM-16: typing in the search box dims non-matching cards, keeps matches", async () => {
  const t = await bootUI();
  try {
    const doc = t.dom.window.document;
    await createProject(t, { id: "search-test", name: "Search", prefix: "SR" });
    await createTicket(t, { type: "user-story", title: "Apple harvest" });
    await createTicket(t, { type: "user-story", title: "Banana split" });
    await tick(t.dom, 100);
    const search = doc.getElementById("ticket-search");
    assert.ok(search, "ticket-search input missing");
    search.value = "apple";
    search.dispatchEvent(new t.dom.window.Event("input", { bubbles: true }));
    await tick(t.dom, 280);  // wait out the 150ms debounce
    const cards = Array.from(doc.querySelectorAll(".sm-story-card[data-ticket-id]"));
    const apple = cards.find(c => /apple/i.test(c.textContent));
    const banana = cards.find(c => /banana/i.test(c.textContent));
    assert.ok(apple && banana, "both cards should be rendered");
    assert.ok(!apple.classList.contains("sm-search-dim"), "match must not be dimmed");
    assert.ok(apple.classList.contains("sm-search-hit"), "match must be highlighted");
    assert.ok(banana.classList.contains("sm-search-dim"), "non-match must be dimmed");
    // Clearing the search un-dims everything.
    search.value = "";
    search.dispatchEvent(new t.dom.window.Event("input", { bubbles: true }));
    await tick(t.dom, 280);
    assert.ok(!banana.classList.contains("sm-search-dim"), "clearing search removes the dim");
    assert.ok(!apple.classList.contains("sm-search-hit"), "clearing search removes the highlight");
  } finally { await shutdown(t); }
});

// SM-208: searching an epic's key/title must ring the EPIC card, not only its
// stories. Regression: applySearchHighlight selected only .sm-story-card, so an
// epic (rendered as .sm-epic-card) was never highlighted.
test("SM-208: searching for an epic highlights the epic card (not just stories)", async () => {
  const t = await bootUI();
  try {
    const doc = t.dom.window.document;
    const win = t.dom.window;
    await createProject(t, { id: "epic-search", name: "EpicSearch", prefix: "ES" });
    // Epics aren't offered in the "+ Add Ticket" type-picker (containers, not
    // board work items), so seed via the store like the other epic E2E tests.
    const store = win.STORYMAP.app.store;
    const HUMAN = { type: "human", id: "u1", name: "U" };
    // SM-253: place the epic in a cell so it renders in the Story Map (a
    // release-less epic isn't shown anymore).
    const rid = store.get().releases[0].id, psid = store.get().processSteps[0].id;
    store.createTicket({ type: "epic", title: "Authentication epic", position: { releaseId: rid, processStepId: psid } }, HUMAN);
    await createTicket(t, { type: "user-story", title: "Reporting story" });
    await tick(t.dom, 100);
    const epicCard = Array.from(doc.querySelectorAll(".sm-epic-card[data-ticket-id]"))
      .find(c => /authentication/i.test(c.textContent));
    assert.ok(epicCard, "epic card must be rendered");
    const search = doc.getElementById("ticket-search");
    search.value = "Authentication";
    search.dispatchEvent(new t.dom.window.Event("input", { bubbles: true }));
    await tick(t.dom, 280);  // wait out the 150ms debounce
    assert.ok(epicCard.classList.contains("sm-search-hit"), "matching epic must be ringed");
    assert.ok(!epicCard.classList.contains("sm-search-dim"), "epic is never dimmed (opacity cascades to nested stories)");
    // A non-matching epic stays un-dimmed too (so nested matches stay visible),
    // but is not ringed.
    search.value = "no-such-text-xyz";
    search.dispatchEvent(new t.dom.window.Event("input", { bubbles: true }));
    await tick(t.dom, 280);
    assert.ok(!epicCard.classList.contains("sm-search-hit"), "non-match epic loses the ring");
    assert.ok(!epicCard.classList.contains("sm-search-dim"), "non-match epic still not dimmed");
  } finally { await shutdown(t); }
});

test("SM-185: the ticket modal shows a ticket-scoped attachments section that lists server attachments", async () => {
  const t = await bootUI();
  try {
    await createProject(t, { id: "attproj", name: "Att", prefix: "A" });
    await createTicket(t, { type: "user-story", title: "Needs a doc" });
    const win = t.dom.window;
    const doc = win.document;
    const tid = win.STORYMAP.app.store.get().tickets.find(x => x.title === "Needs a doc").id;
    const base = win.STORYMAP.app.adapter.base;

    // Upload an attachment for THIS ticket directly via the REST endpoint.
    const up = await fetch(base + "/api/projects/attproj/attachments?ticketId=" + tid, {
      method: "POST",
      headers: { "Content-Type": "text/plain", "X-Filename": encodeURIComponent("design.txt") },
      body: Buffer.from("design notes")
    });
    assert.strictEqual(up.status, 201);

    // Open the ticket modal (edit-mode) by double-clicking its backlog card.
    const card = doc.querySelector('#story-map-host .sm-story-card[data-ticket-id="' + tid + '"]');
    assert.ok(card, "ticket card present");
    card.dispatchEvent(new win.MouseEvent("dblclick", { bubbles: true }));
    await tick(t.dom, 120);   // modal mounts + the section's async list-load resolves

    const section = doc.querySelector(".modal .tm-attachments-section");
    assert.ok(section, "attachments section renders in the edit-mode modal");
    assert.ok(section.querySelector(".tm-attach-dropzone"), "dropzone present");
    const items = section.querySelectorAll(".tm-attach-list .tm-attach-item");
    assert.strictEqual(items.length, 1, "the server attachment is listed");
    assert.ok(items[0].textContent.includes("design.txt"), "shows the uploaded filename");
  } finally { await shutdown(t); }
});

test("SM-194: Project ▸ Attachments… shows a project-level panel listing only project-scoped attachments", async () => {
  const t = await bootUI();
  try {
    await createProject(t, { id: "pattproj", name: "PAtt", prefix: "P" });
    await createTicket(t, { type: "user-story", title: "Has its own doc" });
    const win = t.dom.window;
    const doc = win.document;
    const tid = win.STORYMAP.app.store.get().tickets.find(x => x.title === "Has its own doc").id;
    const base = win.STORYMAP.app.adapter.base;

    // One ticket-scoped attachment and one project-level (no ?ticketId).
    await fetch(base + "/api/projects/pattproj/attachments?ticketId=" + tid, {
      method: "POST", headers: { "Content-Type": "text/plain", "X-Filename": "ticket-doc.txt" }, body: Buffer.from("t")
    });
    await fetch(base + "/api/projects/pattproj/attachments", {
      method: "POST", headers: { "Content-Type": "text/plain", "X-Filename": "source-prd.txt" }, body: Buffer.from("prd")
    });

    await clickMenuItem(t, "project", /attachments/i);
    await tick(t.dom, 120);   // modal mounts + section's async project-level list resolves

    const section = doc.querySelector(".modal .tm-project-attach-host .tm-attachments-section");
    assert.ok(section, "project attachments panel renders");
    assert.ok(section.querySelector(".tm-attach-dropzone"), "dropzone present");
    const items = section.querySelectorAll(".tm-attach-list .tm-attach-item");
    assert.strictEqual(items.length, 1, "only the project-level attachment is listed (ticket-scoped excluded)");
    assert.ok(items[0].textContent.includes("source-prd.txt"), "shows the project-level filename");
  } finally { await shutdown(t); }
});

test("SM-195: New project dialog has an attachment dropzone; a dropped file lands as a project-level attachment", async () => {
  const t = await bootUI();
  try {
    const win = t.dom.window;
    const doc = win.document;
    // Open Project ▸ New project…
    const projectMenuBtn = doc.querySelector('.menu-bar .menu-item[data-menu-id="project"]');
    projectMenuBtn.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    await tick(t.dom, 30);
    const items = doc.querySelectorAll(".menu-dropdown .menu-dropdown-item");
    Array.from(items).find(d => /new project/i.test(d.textContent))
      .dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    await tick(t.dom, 30);

    const modal = doc.querySelector(".modal");
    const dz = modal.querySelector("#np-dropzone");
    assert.ok(dz, "dropzone present in the New project dialog (HTTP adapter)");

    // Fill the form.
    modal.querySelector("#np-id").value = "prdcreate";
    modal.querySelector("#np-id").dispatchEvent(new win.Event("input", { bubbles: true }));
    modal.querySelector("#np-name").value = "PRD Create";
    modal.querySelector("#np-name").dispatchEvent(new win.Event("input", { bubbles: true }));

    // Simulate dropping a file onto the dropzone.
    const file = new win.File(["PRD CONTENT"], "source-prd.txt", { type: "text/plain" });
    const dropEv = new win.Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(dropEv, "dataTransfer", { value: { files: [file] } });
    dz.dispatchEvent(dropEv);
    await tick(t.dom, 20);
    const pending = modal.querySelectorAll("#np-pending .tm-attach-item");
    assert.strictEqual(pending.length, 1, "dropped file shows in the pending list");
    assert.ok(pending[0].textContent.includes("source-prd.txt"));

    // Create.
    Array.from(modal.querySelectorAll(".modal-actions .btn"))
      .find(b => /create/i.test(b.textContent))
      .dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    await tick(t.dom, 600);   // create + seed + upload

    // The file should now be a project-level attachment (ticket_id IS NULL).
    const base = win.STORYMAP.app.adapter.base;
    const res = await fetch(base + "/api/projects/prdcreate/attachments?ticketId=none");
    const body = await res.json();
    assert.strictEqual(body.attachments.length, 1, "one project-level attachment after create");
    assert.strictEqual(body.attachments[0].filename, "source-prd.txt");
    assert.strictEqual(body.attachments[0].ticketId, null, "stored as project-level (no ticket)");
  } finally { await shutdown(t); }
});

// SM-209: project load dialog gains a search field + sort select (cmapper parity).
test("SM-209: load dialog filters cards by search and reorders by sort", async () => {
  const t = await bootUI();
  try {
    const doc = t.dom.window.document;
    const win = t.dom.window;
    // Names deliberately DON'T contain the ids, so a search for an id ("beta")
    // exercises the id-only filter branch in isolation. Created alpha → beta →
    // gamma, so gamma is the most-recently-touched.
    await createProject(t, { id: "alpha", name: "First Map",  prefix: "AL" });
    await createProject(t, { id: "beta",  name: "Second Map", prefix: "BE" });
    await createProject(t, { id: "gamma", name: "Third Map",  prefix: "GA" });
    // Give the current project (gamma) a description so the description-search
    // branch is covered. The dialog reads the current project from the live
    // store, so the description is visible without waiting for persistence.
    win.STORYMAP.app.store.updateProject({ description: "needle-xyz reporting flow" },
      { type: "human", id: "u1", name: "U" });
    await tick(t.dom, 20);

    await clickMenuItem(t, "project", /load project/i);
    await tick(t.dom, 400);   // list + per-project snapshot loads
    const modal = doc.querySelector(".modal");
    assert.ok(modal, "load dialog modal opened");
    const search = modal.querySelector("#proj-search");
    const sort = modal.querySelector("#proj-sort");
    assert.ok(search, "search input present");
    assert.ok(sort, "sort select present");

    const idsInOrder = () => Array.from(modal.querySelectorAll(".project-card"))
      .map(c => c.getAttribute("data-id"));
    assert.strictEqual(idsInOrder().length, 3, "all three projects listed");

    const typeSearch = async (v) => {
      search.value = v;
      search.dispatchEvent(new win.Event("input", { bubbles: true }));
      await tick(t.dom, 10);
    };
    const pickSort = async (v) => {
      sort.value = v;
      sort.dispatchEvent(new win.Event("change", { bubbles: true }));
      await tick(t.dom, 10);
    };

    // --- search by name ---
    await typeSearch("second");
    assert.deepStrictEqual(idsInOrder(), ["beta"], "search narrows by name");
    // --- search by id only (name 'Second Map' does NOT contain 'beta') ---
    await typeSearch("beta");
    assert.deepStrictEqual(idsInOrder(), ["beta"], "search matches by id in isolation");
    // --- search by description (only gamma carries the needle) ---
    await typeSearch("needle-xyz");
    assert.deepStrictEqual(idsInOrder(), ["gamma"], "search matches by description");
    // --- no match → filtered-empty notice, zero cards ---
    await typeSearch("zzz-nope");
    assert.strictEqual(idsInOrder().length, 0, "no cards when nothing matches");
    assert.ok(modal.querySelector(".project-list-empty-filtered"), "filtered-empty notice shown");

    // --- clear search, sort by name ascending then descending ---
    await typeSearch("");
    await pickSort("name-asc");
    assert.deepStrictEqual(idsInOrder(), ["alpha", "beta", "gamma"], "name A→Z (First<Second<Third)");
    await pickSort("name-desc");
    assert.deepStrictEqual(idsInOrder(), ["gamma", "beta", "alpha"], "name Z→A order");

    // --- sort by recency (gamma newest, alpha oldest) ---
    await pickSort("recent");
    assert.deepStrictEqual(idsInOrder(), ["gamma", "beta", "alpha"], "newest-first order");
    await pickSort("oldest");
    assert.deepStrictEqual(idsInOrder(), ["alpha", "beta", "gamma"], "oldest-first order");

    // sort choice persists to localStorage
    assert.strictEqual(win.localStorage.getItem("storymap-project-sort"), "oldest",
      "sort mode persisted");
  } finally { await shutdown(t); }
});

// SM-191: the unified smart-bar — plain words highlight (SM-16), field syntax
// runs a JQL query that FILTERS the view; result count + inline error.
test("SM-191: smart-bar filters on field syntax, highlights on plain text, shows errors", async () => {
  const t = await bootUI();
  try {
    const doc = t.dom.window.document;
    const win = t.dom.window;
    await createProject(t, { id: "smartbar", name: "SB", prefix: "SB" });
    const store = win.STORYMAP.app.store;
    const HUMAN = { type: "human", id: "u1", name: "U" };
    // SM-253: give them a release (no process-step) so they show in the Story
    // Map's per-release holding strip — release-less tickets aren't in the SM.
    const rid = store.get().releases[0].id;
    store.createTicket({ type: "user-story", title: "Apple",  status: "ready",   position: { releaseId: rid } }, HUMAN);
    store.createTicket({ type: "user-story", title: "Banana", status: "done",    position: { releaseId: rid } }, HUMAN);
    store.createTicket({ type: "user-story", title: "Cherry", status: "ready",   position: { releaseId: rid } }, HUMAN);
    store.createTicket({ type: "bug",        title: "Durian", status: "backlog", position: { releaseId: rid } }, HUMAN);
    await tick(t.dom, 100);

    const bar = doc.getElementById("ticket-search");
    const status = doc.getElementById("smartbar-status");
    assert.ok(bar && status, "smart-bar input + status element present");
    const cards = () => Array.from(doc.querySelectorAll(".sm-release-unplaced-row .sm-story-card[data-ticket-id]"));
    const titles = () => cards().map((c) => c.textContent);
    const type = async (v) => { bar.value = v; bar.dispatchEvent(new win.Event("input", { bubbles: true })); await tick(t.dom, 280); };

    assert.strictEqual(cards().length, 4, "all four tickets visible initially");

    // --- query mode: field syntax filters the view to matches ---
    await type("status = ready");
    let ts = titles();
    assert.strictEqual(ts.length, 2, "only the two ready tickets remain");
    assert.ok(ts.some((x) => /Apple/.test(x)) && ts.some((x) => /Cherry/.test(x)));
    assert.ok(!ts.some((x) => /Banana|Durian/.test(x)), "non-matching removed");
    assert.ok(/2 matches/.test(status.textContent), "result count shown: " + status.textContent);

    // --- plain text: highlight mode (does NOT remove cards) ---
    await type("apple");
    assert.strictEqual(cards().length, 4, "plain search keeps all cards (highlight, not filter)");
    const appleCard = cards().find((c) => /Apple/.test(c.textContent));
    assert.ok(appleCard.classList.contains("sm-search-hit"), "match is highlighted");
    assert.strictEqual(status.textContent, "", "no query count in simple-search mode");

    // --- invalid query: inline error, view not destroyed ---
    await type("status ~ ready");
    assert.ok(/not allowed/i.test(status.textContent), "semantic error shown: " + status.textContent);
    assert.strictEqual(cards().length, 4, "an erroring query does not blow away the view");

    // --- clear: back to everything, no status ---
    await type("");
    assert.strictEqual(cards().length, 4, "cleared bar shows all tickets");
    assert.strictEqual(status.textContent, "");
  } finally { await shutdown(t); }
});

// SM-191 review fix: with a query filter active, an external (applyRemote / MCP)
// status change must drop a now-non-matching card — the storymap morph path used
// to keep it, and app.queryMatch went stale.
test("SM-191: an active query filter stays correct after a remote status change", async () => {
  const t = await bootUI();
  try {
    const doc = t.dom.window.document;
    const win = t.dom.window;
    await createProject(t, { id: "qfresh", name: "QF", prefix: "QF" });
    const store = win.STORYMAP.app.store;
    const HUMAN = { type: "human", id: "u1", name: "U" };
    // SM-253: release (no step) → visible in the per-release holding strip.
    const rid = store.get().releases[0].id;
    store.createTicket({ type: "user-story", title: "Apple",  status: "ready", position: { releaseId: rid } }, HUMAN);
    store.createTicket({ type: "user-story", title: "Cherry", status: "ready", position: { releaseId: rid } }, HUMAN);
    await tick(t.dom, 100);
    const bar = doc.getElementById("ticket-search");
    const status = doc.getElementById("smartbar-status");
    const titles = () => Array.from(doc.querySelectorAll(".sm-release-unplaced-row .sm-story-card[data-ticket-id]")).map((c) => c.textContent);

    bar.value = "status = ready";
    bar.dispatchEvent(new win.Event("input", { bubbles: true }));
    await tick(t.dom, 280);
    assert.strictEqual(titles().length, 2, "both ready stories visible");

    // simulate an MCP/remote edit: Apple → done (applyRemote → morph path).
    const snap2 = JSON.parse(JSON.stringify(store.get()));
    snap2.tickets.find((x) => x.title === "Apple").status = "done";
    store.applyRemote(snap2);
    await tick(t.dom, 120);
    const ts = titles();
    assert.strictEqual(ts.length, 1, "Apple drops from the filtered view after going done");
    assert.ok(ts.some((x) => /Cherry/.test(x)) && !ts.some((x) => /Apple/.test(x)));
    assert.ok(/1 match/.test(status.textContent), "count refreshed: " + status.textContent);
  } finally { await shutdown(t); }
});

// SM-216: the autocomplete dropdown is wired to the smart-bar in the real page.
test("SM-216: typing a field prefix opens the autocomplete dropdown", async () => {
  const t = await bootUI();
  try {
    const doc = t.dom.window.document;
    const win = t.dom.window;
    await createProject(t, { id: "acwire", name: "AC", prefix: "AC" });
    await tick(t.dom, 80);
    const bar = doc.getElementById("ticket-search");
    bar.focus();
    bar.value = "stat";
    try { bar.setSelectionRange(4, 4); } catch (_e) {}
    bar.dispatchEvent(new win.Event("input", { bubbles: true }));
    await tick(t.dom, 40);
    const menu = doc.querySelector(".smartbar-ac");
    assert.ok(menu && !menu.hidden, "autocomplete dropdown is visible");
    const labels = Array.from(menu.querySelectorAll(".smartbar-ac-label")).map((e) => e.textContent);
    assert.ok(labels.indexOf("status") >= 0, "field suggestion present: " + JSON.stringify(labels));
  } finally { await shutdown(t); }
});

test("SM-282: View ▸ Table shows the query-driven table; query filters; row-click opens the modal", async () => {
  const t = await bootUI();
  try {
    const win = t.dom.window;
    const doc = win.document;
    await createProject(t, { id: "tbl", name: "Tbl", prefix: "T" });
    const store = win.STORYMAP.app.store;
    const ACTOR = { type: "human", id: "e2e", name: "E2E" };
    store.createTicket({ type: "user-story", title: "Table Story" }, ACTOR);
    store.createTicket({ type: "bug", title: "Table Bug" }, ACTOR);
    await tick(t.dom, 60);

    await clickMenuItem(t, "view", /^table$/i);
    const host = doc.getElementById("table-host");
    assert.ok(host && !host.hidden, "table host visible after View ▸ Table");
    assert.ok(doc.getElementById("story-map-host").hidden, "map host hidden");
    // SM-293: the global smart-bar/filter row hides while the Table view is
    // active (the view has its own query line — no duplicate query inputs).
    assert.ok(doc.querySelector(".toolbar-action").hidden, "smart-bar toolbar row hidden in Table view");
    assert.strictEqual(win.localStorage.getItem("storymap-active-view"), "table", "view persisted");
    assert.ok(host.querySelector(".tv-query-input"), "query line present");
    const rows = host.querySelectorAll(".tv-table tbody tr");
    assert.ok(rows.length >= 2, "all tickets listed (got " + rows.length + ")");

    // Query filters the table (debounced input).
    const input = host.querySelector(".tv-query-input");
    input.value = "type = bug";
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
    await tick(t.dom, 350);
    const filtered = host.querySelectorAll(".tv-table tbody tr");
    assert.strictEqual(filtered.length, 1, "query narrowed to the bug");

    // Row click opens the ticket modal.
    filtered[0].dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    await tick(t.dom, 60);
    const modal = doc.querySelector("#modal-host .modal");
    assert.ok(modal && /Table Bug/.test(modal.textContent), "ticket modal opened from the row");
  } finally { await shutdown(t); }
});

test("SM-289: Project ▸ Import tickets — upsert preview 2 neu/1 aktualisiert → Apply → store AND server", async () => {
  const t = await bootUI();
  try {
    const win = t.dom.window;
    const doc = win.document;
    await createProject(t, { id: "imp", name: "Imp", prefix: "I" });
    const store = win.STORYMAP.app.store;
    const ACTOR = { type: "human", id: "e2e", name: "E2E" };
    store.createTicket({ type: "user-story", title: "Existing Story" }, ACTOR);
    const existing = store.get().tickets[store.get().tickets.length - 1];
    await tick(t.dom, 400);   // let the save pipeline flush the fixture

    await clickMenuItem(t, "project", /^import/i);
    const modal = doc.querySelector("#modal-host .modal");
    assert.ok(modal && modal.querySelector(".ti-root"), "import dialog open");
    const ta = modal.querySelector(".ti-text");
    ta.value = "key,type,title\n,bug,Imported A\n,user-story,Imported B\n" + existing.ticketKey + ",,Imported Rename";
    ta.dispatchEvent(new win.Event("input", { bubbles: true }));
    await tick(t.dom, 30);
    const summary = modal.querySelector(".ti-summary").textContent;
    assert.ok(/2 neu/.test(summary) && /1 aktualisiert/.test(summary) && /0 Fehler/.test(summary), summary);

    modal.querySelector('[data-act="1"]').dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    await tick(t.dom, 30);
    const titles = store.get().tickets.map(x => x.title);
    assert.ok(titles.includes("Imported A") && titles.includes("Imported B"), "creates in the store");
    assert.strictEqual(store.get().tickets.find(x => x.id === existing.id).title, "Imported Rename");

    // server roundtrip: the debounced save pipeline persists the ONE commit
    await tick(t.dom, 600);
    const res = await fetch(`${t.base}/api/projects/imp`);
    const server = await res.json();
    const serverTitles = (server.tickets || []).map(x => x.title);
    assert.ok(serverTitles.includes("Imported A") && serverTitles.includes("Imported Rename"),
      "import persisted on the server");
  } finally { await shutdown(t); }
});

test("SM-295: unified Import\u2026 \u2014 pasting a project envelope creates + loads the project", async () => {
  const t = await bootUI();
  try {
    const win = t.dom.window;
    const doc = win.document;
    await createProject(t, { id: "base", name: "Base", prefix: "B" });

    await clickMenuItem(t, "project", /^import/i);
    const modal = doc.querySelector("#modal-host .modal");
    assert.ok(modal && modal.querySelector(".ti-root"), "unified import dialog open");
    const envelope = JSON.stringify({
      format: "storymap-project", version: 1,
      snapshot: {
        project: { id: "pasted-proj", name: "Pasted", ticketPrefix: "PP" },
        releases: [{ id: "R1", name: "v1", sortOrder: 0 }],
        processSteps: [], tickets: []
      }
    });
    const ta = modal.querySelector(".ti-text");
    ta.value = envelope;
    ta.dispatchEvent(new win.Event("input", { bubbles: true }));
    await tick(t.dom, 50);
    assert.ok(modal.querySelector(".ti-project-preview"), "project branch preview shown");
    assert.ok(/Pasted/.test(modal.querySelector(".ti-project-preview").textContent));

    modal.querySelector('[data-act="1"]').dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    await tick(t.dom, 400);
    assert.strictEqual(win.STORYMAP.app.currentProjectId, "pasted-proj", "imported project loaded");
    const res = await fetch(`${t.base}/api/projects/pasted-proj`);
    assert.strictEqual(res.status, 200, "project exists on the server");
    const server = await res.json();
    assert.strictEqual(server.project.name, "Pasted");
  } finally { await shutdown(t); }
});

module.exports.done = (test._chain || Promise.resolve()).then(() => {
  console.log(`\n  ${passed} passed, ${failed} failed`);
});
