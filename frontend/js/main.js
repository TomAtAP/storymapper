/**
 * storymap — bootstrap script.
 *
 * 1. pickAdapter() chooses Http / WindowStorage / LocalStorage / Memory.
 * 2. Mounts the Project menu via ui-shell.mountMenuBar.
 * 3. Loads project list, hydrates first project (or empty state).
 * 4. Mounts the Story-Map renderer + subscribes to live-sync.
 *
 * All user dialogs go through ui-shell.showModal — never prompt/confirm/alert.
 * All status feedback through ui-shell.flashStatus.
 */
(function () {
  "use strict";

  const SM = window.STORYMAP;
  if (!SM || !SM.core || !SM.store || !SM.adapters || !SM.uiShell || !SM.rendererStoryMap || !SM.rendererKanban || !SM.rendererDependencies || !SM.rendererTicketModal || !SM.viewSettings || !SM.viewRequirements) {
    console.error("storymap bootstrap: missing modules", Object.keys(SM || {}));
    return;
  }

  const { core, store, adapters, uiShell, rendererStoryMap, rendererKanban, rendererDependencies, rendererTicketModal, viewSettings, viewRequirements, projectIO } = SM;
  const { ProjectStore, SKIP_PERSIST_REASONS } = store;
  const { pickAdapter } = adapters;
  const { showModal, flashStatus } = uiShell;

  // E18.D: einheitlicher Actor für alle store-ops, die im UI gefeuert werden.
  // MCP-Tools setzen ihren eigenen Actor im Server; hier landen nur lokale
  // User-Klicks.
  const LOCAL_ACTOR = { type: "human", id: "local", name: "Local" };

  // ---- Constants -------------------------------------------------------

  const BOOTSTRAP = {
    PROJECT_ID_PATTERN: /^[a-zA-Z0-9_-]{1,100}$/,
    DEFAULT_TICKET_TYPE: "user-story",
    // Defaults bei Project-Create — ein neues Projekt ist sonst nicht
    // arbeitsfähig (keine Cell sichtbar, kein Drag-Target). Diese Defaults
    // sind im UI-Bootstrap-Pfad eingebaut; MCP / direkter REST-Call kann
    // sie umgehen indem er den Standard-Pfad nicht nutzt.
    DEFAULT_RELEASE_NAME: "v1.0",
    DEFAULT_PROCESS_STEP_NAME: "Activities",
    // E18.C: debounce-Fenster für den Save-Subscriber. Cmapper nutzt 300 ms —
    // genug, um eine Drag-Sequenz aus vielen Mikro-Commits zu einem Save
    // zusammenzufassen, ohne wahrnehmbare Latenz.
    SAVE_DEBOUNCE_MS: 300
  };

  // ---- App state -------------------------------------------------------

  const app = {
    adapter: null,
    store: null,
    currentProjectId: null,
    unsubscribeWs: null,
    unmountStoryMap: null,
    unmountKanban:   null,
    unmountDeps:     null,
    unmountSettings: null,
    unmountRequirements: null,
    activeView:      readActiveViewFromStorage() || "storymap",
    // SM-82: ticket filter (per-project). Hydrated from localStorage when
    // a project loads; null means "no filter" (everything visible).
    filter:          null,
    // SM-16: live free-text search. Highlights matches + fades non-matches
    // across the active view (does NOT remove cards, unlike `filter`).
    search:          "",
    // SM-191: the unified smart-bar's active JQL query result — a Set of
    // matching ticket ids (REMOVES non-matching cards, like `filter`), or null
    // when the bar is in plain free-text-search mode / empty.
    queryMatch:      null,
    // SM-191: the active query string (kept so the match set can be recomputed
    // on every commit — see the query-refresh subscriber). null = no query.
    queryString:     null
  };
  SM.app = app;

  // ---- DOM helpers -----------------------------------------------------

  const $ = (id) => document.getElementById(id);

  function readActiveViewFromStorage() {
    try {
      const v = (typeof localStorage !== "undefined") && localStorage.getItem("storymap-active-view");
      // E23.B: "settings" is no longer a persistent activeView; it's an
      // overlay over whatever view is underneath. Legacy entries map back
      // to storymap on next load.
      return (v === "kanban" || v === "storymap" || v === "dependencies" || v === "requirements" || v === "processSteps" || v === "table") ? v : null;
    } catch (_) { return null; }
  }
  function writeActiveViewToStorage(v) {
    try { if (typeof localStorage !== "undefined") localStorage.setItem("storymap-active-view", v); } catch (_) { /* ignore */ }
  }
  function readLastProjectIdFromStorage() {
    try {
      const v = (typeof localStorage !== "undefined") && localStorage.getItem("storymap-last-project");
      return (typeof v === "string" && v.length > 0) ? v : null;
    } catch (_) { return null; }
  }

  // SM-82 — Per-project filter persistence.
  function filterStorageKey(projectId) {
    return "storymap-filter-" + projectId;
  }
  function readFilterFromStorage(projectId) {
    if (!projectId) return null;
    try {
      if (typeof localStorage === "undefined") return null;
      const v = localStorage.getItem(filterStorageKey(projectId));
      if (!v) return null;
      const parsed = JSON.parse(v);
      // Empty filter ≈ null (no constraints active) — keeps app.filter falsy
      // so the renderer skips the filter pipeline entirely.
      if (!parsed.statuses && !parsed.types && !parsed.hideCompletedReleases) return null;
      return parsed;
    } catch (_) { return null; }
  }
  function writeFilterToStorage(projectId, filter) {
    if (!projectId) return;
    try {
      if (typeof localStorage === "undefined") return;
      const key = filterStorageKey(projectId);
      if (!filter) localStorage.removeItem(key);
      else         localStorage.setItem(key, JSON.stringify(filter));
    } catch (_) { /* ignore */ }
  }

  // SM-83 — Per-project release-collapse persistence. Each entry is a
  // releaseId; presence means "row is collapsed (cells-row hidden)".
  function releaseCollapseStorageKey(projectId) {
    return "storymap-release-collapsed-" + projectId;
  }
  function readCollapsedReleasesFromStorage(projectId) {
    const out = new Set();
    if (!projectId) return out;
    try {
      if (typeof localStorage === "undefined") return out;
      const v = localStorage.getItem(releaseCollapseStorageKey(projectId));
      if (!v) return out;
      const parsed = JSON.parse(v);
      if (Array.isArray(parsed)) parsed.forEach(id => typeof id === "string" && out.add(id));
    } catch (_) { /* ignore */ }
    return out;
  }
  function writeCollapsedReleasesToStorage(projectId, set) {
    if (!projectId) return;
    try {
      if (typeof localStorage === "undefined") return;
      const key = releaseCollapseStorageKey(projectId);
      if (!set || set.size === 0) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(Array.from(set)));
    } catch (_) { /* ignore */ }
  }
  // SM-169 — Per-project Kanban swimlane-collapse persistence. Separate from
  // the Map's release-collapse (SM-83) — the Kanban groups by release into
  // swimlanes and the collapse state is its own concern (it also tracks the
  // synthetic "no release" row). Each entry is a swimlane key (a releaseId, or
  // the renderer's NO_RELEASE_KEY sentinel); presence means "row collapsed".
  function kanbanCollapseStorageKey(projectId) {
    return "storymap-kanban-collapsed-" + projectId;
  }
  function readKanbanCollapsedFromStorage(projectId) {
    if (!projectId) return null;
    try {
      if (typeof localStorage === "undefined") return null;
      const v = localStorage.getItem(kanbanCollapseStorageKey(projectId));
      if (v == null) return null;   // null = no stored state yet (seed defaults)
      const parsed = JSON.parse(v);
      const out = new Set();
      if (Array.isArray(parsed)) parsed.forEach(id => typeof id === "string" && out.add(id));
      return out;
    } catch (_) { return null; }
  }
  function writeKanbanCollapsedToStorage(projectId, set) {
    if (!projectId) return;
    try {
      if (typeof localStorage === "undefined") return;
      // Always write (even empty) so "user un-collapsed everything" is durable
      // and we don't re-seed completed releases on the next load.
      localStorage.setItem(kanbanCollapseStorageKey(projectId), JSON.stringify(Array.from(set || [])));
    } catch (_) { /* ignore */ }
  }
  // First-view default: collapse every completed release's swimlane so a board
  // with 100s of done tickets opens compact. The user's choice persists after.
  function seedKanbanCollapsedDefault(snap) {
    const out = new Set();
    const releases = (snap && snap.releases) || [];
    for (const r of releases) {
      if (!r.isDeleted && r.status === "completed") out.add(r.id);
    }
    return out;
  }

  // SM-84 — Per-project epic-collapse persistence. Mirrors SM-83 for epics.
  // Entry is an epicId; presence means "epic story-grid is hidden".
  function epicCollapseStorageKey(projectId) {
    return "storymap-epic-collapsed-" + projectId;
  }
  function readCollapsedEpicsFromStorage(projectId) {
    const out = new Set();
    if (!projectId) return out;
    try {
      if (typeof localStorage === "undefined") return out;
      const v = localStorage.getItem(epicCollapseStorageKey(projectId));
      if (!v) return out;
      const parsed = JSON.parse(v);
      if (Array.isArray(parsed)) parsed.forEach(id => typeof id === "string" && out.add(id));
    } catch (_) { /* ignore */ }
    return out;
  }
  function writeCollapsedEpicsToStorage(projectId, set) {
    if (!projectId) return;
    try {
      if (typeof localStorage === "undefined") return;
      const key = epicCollapseStorageKey(projectId);
      if (!set || set.size === 0) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(Array.from(set)));
    } catch (_) { /* ignore */ }
  }
  // SM-272: per-project collapsed process-step COLUMNS.
  function columnCollapseStorageKey(projectId) {
    return "storymap-column-collapsed-" + projectId;
  }
  function readCollapsedColumnsFromStorage(projectId) {
    const out = new Set();
    if (!projectId) return out;
    try {
      if (typeof localStorage === "undefined") return out;
      const v = localStorage.getItem(columnCollapseStorageKey(projectId));
      if (!v) return out;
      const parsed = JSON.parse(v);
      if (Array.isArray(parsed)) parsed.forEach(id => typeof id === "string" && out.add(id));
    } catch (_) { /* ignore */ }
    return out;
  }
  function writeCollapsedColumnsToStorage(projectId, set) {
    if (!projectId) return;
    try {
      if (typeof localStorage === "undefined") return;
      const key = columnCollapseStorageKey(projectId);
      if (!set || set.size === 0) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(Array.from(set)));
    } catch (_) { /* ignore */ }
  }
  function writeLastProjectIdToStorage(id) {
    try {
      if (typeof localStorage === "undefined") return;
      if (id) localStorage.setItem("storymap-last-project", id);
      else    localStorage.removeItem("storymap-last-project");
    } catch (_) { /* ignore */ }
  }

  // ---- HTTP request helper (delegates origin-id to adapter) ------------
  // Direct REST endpoints used when adapter is HttpAdapter and we want a
  // specific endpoint (e.g. POST /api/projects, POST /tickets).
  async function httpReq(method, path, body) {
    const res = await fetch(app.adapter.base + path, {
      method,
      headers: { "Content-Type": "application/json", "X-Origin-Id": app.adapter.originId },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    let data = null;
    const text = await res.text();
    if (text) { try { data = JSON.parse(text); } catch (_) { data = text; } }
    if (!res.ok) {
      const err = new Error((data && data.error) || ("HTTP " + res.status));
      err.statusCode = res.status;
      if (data && typeof data === "object") {
        err.kind = data.kind; err.missing = data.missing;
      }
      throw err;
    }
    return data;
  }

  /**
   * After a mutating HTTP call that the originating client made itself,
   * pull a fresh snapshot and applyRemote() into the local store. The
   * server's WS-push for this write is intentionally filtered out by the
   * X-Origin-Id echo guard, so without this explicit pull the originating
   * client would see no UI update for its own changes.
   */
  async function reloadStore() {
    if (!app.currentProjectId || !app.store) return;
    try {
      const snap = await app.adapter.load(app.currentProjectId);
      if (snap) app.store.applyRemote(snap);
    } catch (e) {
      console.warn("reloadStore failed:", e);
    }
  }

  /**
   * Build the ctx object passed to the ticket-modal renderer. Wraps app
   * state + adapter + helpers so the renderer doesn't need to know about
   * `app`. Constructed lazily per call so it picks up the current
   * projectId/adapter.
   */
  // SM-253: the newest release (highest sortOrder) — the Story Map's top row.
  // Used as the default release for toolbar/menu-created tickets so they land
  // in that release's holding strip instead of vanishing (no backlog anymore).
  function newestReleaseId() {
    if (!app.store) return null;
    const rels = (app.store.get().releases || []).filter(r => !r.isDeleted);
    if (rels.length === 0) return null;
    return rels.reduce((a, b) => ((b.sortOrder || 0) > (a.sortOrder || 0) ? b : a)).id;
  }

  function buildTicketModalCtx() {
    return {
      store:         app.store,
      adapter:       app.adapter,
      projectId:     app.currentProjectId,
      uiShell:       uiShell,
      httpReq:       httpReq,
      reloadStore:   reloadStore,
      applySnapshot: (snap) => app.store.applyRemote(snap),
      flashStatus:   flashStatus,
      // SM-185: attachments are a REST feature — only available with the HTTP
      // adapter. The modal hides its dropzone when this is false.
      attachmentsEnabled: !!(app.adapter && app.adapter.name === "Http"),
      attachmentHref: (aid) => app.adapter.base
        + "/api/projects/" + encodeURIComponent(app.currentProjectId)
        + "/attachments/" + encodeURIComponent(aid),
      listAttachments: async (ticketId) => {
        const data = await httpReq("GET", "/api/projects/" + encodeURIComponent(app.currentProjectId)
          + "/attachments?ticketId=" + encodeURIComponent(ticketId));
        return (data && data.attachments) || [];
      },
      uploadAttachment: async (ticketId, file) => {
        // SM-194: "none"/empty = project-level attachment → POST without ?ticketId
        // (the "none" sentinel is a LIST filter only; on upload it must not become
        // a literal ticket_id). A real ticketId scopes the upload to that ticket.
        const scoped = ticketId != null && ticketId !== "" && ticketId !== "none";
        const url = app.adapter.base + "/api/projects/" + encodeURIComponent(app.currentProjectId)
          + "/attachments" + (scoped ? "?ticketId=" + encodeURIComponent(ticketId) : "");
        // Send the raw bytes as an ArrayBuffer rather than the File object: this
        // is deterministic across fetch implementations (a File body is fine in
        // browsers but not every fetch — e.g. Node's undici — serializes it).
        const bytes = (typeof file.arrayBuffer === "function") ? await file.arrayBuffer() : file;
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": file.type || "application/octet-stream",
            "X-Filename": encodeURIComponent(file.name),
            "X-Origin-Id": app.adapter.originId
          },
          body: bytes
        });
        if (!res.ok) {
          let d = null; try { d = JSON.parse(await res.text()); } catch (_) { /* non-JSON */ }
          const e = new Error((d && d.error) || ("HTTP " + res.status));
          e.statusCode = res.status;
          throw e;
        }
        return (await res.json()).attachment;
      },
      deleteAttachment: async (aid) => httpReq("DELETE", "/api/projects/"
        + encodeURIComponent(app.currentProjectId) + "/attachments/" + encodeURIComponent(aid))
    };
  }

  // ---- Project loading -------------------------------------------------

  /**
   * Aktualisiert den Current-Project-Anchor im Header. Klick auf den Anchor
   * öffnet den Load-Project-Dialog (cmapper-Pattern). Ohne aktives Projekt
   * ist der Anchor leer + :empty in CSS versteckt.
   */
  function updateCurrentProjectIndicator() {
    const anchor = $("current-project");
    if (!anchor) return;
    if (!app.currentProjectId || !app.store) {
      anchor.textContent = "";
      return;
    }
    const proj = app.store.get().project || {};
    const name = proj.name || app.currentProjectId;
    anchor.textContent = name;
    anchor.title = "Project: " + app.currentProjectId + " — click to load another";
  }

  function el(tag, props) {
    const e = document.createElement(tag);
    for (const k of Object.keys(props || {})) {
      if (k === "text") e.textContent = props[k];
      else e.setAttribute(k, props[k]);
    }
    return e;
  }

  /**
   * E18.C — Save-Subscriber (cmapper-Pattern). Jeder Store-Commit fließt
   * (gedebounced) als kompletter Snapshot-PUT zurück an den Adapter.
   * Skip-Reasons: `applyRemote` (Snapshot kam GERADE vom Server — re-saven
   * würde ping-pongen) und `hydrate` (initial-load / Projektwechsel —
   * gleicher Grund). Alle anderen Reasons (createTicket, updateProject,
   * undo, redo, …) lösen einen Save aus.
   *
   * SM-214: die Mechanik (Debounce, SM-153-Race-Guard, ein Retry, pagehide-
   * Flush via saveBeacon) lebt im geteilten Modul save-pipeline.js — gleiche
   * Pipeline wie im Vollseiten-Editor. flushPendingSave landet auf `app`,
   * damit E2E-Tests den Tab-Close-Pfad direkt treiben können.
   */
  function installSaveSubscriber() {
    const pipeline = window.STORYMAP.savePipeline.createSavePipeline({
      store: app.store,
      adapter: () => app.adapter,
      projectId: () => app.currentProjectId,
      skipReasons: SKIP_PERSIST_REASONS,
      debounceMs: BOOTSTRAP.SAVE_DEBOUNCE_MS,
      onError: (err) => {
        console.error("[save] failed:", err);
        flashStatus("save failed: " + (err.message || err), { kind: "error" });
      },
      win: window
    });
    app.flushPendingSave = pipeline.flushPendingSave;
  }

  async function loadProject(projectId) {
    if (app.unsubscribeWs) { app.unsubscribeWs(); app.unsubscribeWs = null; }
    unmountActiveView();
    const snap = await app.adapter.load(projectId);
    if (!snap) { flashStatus("project not found: " + projectId, { kind: "error" }); return; }
    app.currentProjectId = projectId;
    writeLastProjectIdToStorage(projectId);
    // SM-82: hydrate per-project filter from localStorage BEFORE mounting
    // the view so the renderer starts with the correct filter applied.
    app.filter = readFilterFromStorage(projectId);
    refreshFilterBadge();
    // SM-83: hydrate per-project release-collapse state.
    app.collapsedReleases = readCollapsedReleasesFromStorage(projectId);
    // SM-169: hydrate Kanban swimlane-collapse. No stored state yet → seed the
    // default (completed releases collapsed) and persist it once.
    {
      const stored = readKanbanCollapsedFromStorage(projectId);
      if (stored) {
        app.kanbanCollapsedReleases = stored;
      } else {
        app.kanbanCollapsedReleases = seedKanbanCollapsedDefault(snap);
        writeKanbanCollapsedToStorage(projectId, app.kanbanCollapsedReleases);
      }
    }
    // SM-84: hydrate per-project epic-collapse state.
    app.collapsedEpics = readCollapsedEpicsFromStorage(projectId);
    app.collapsedColumns = readCollapsedColumnsFromStorage(projectId);
    // SM-16 / SM-191: a new project starts with a clean smart-bar (no search,
    // no active query filter).
    resetSmartBar();
    if (!app.store) {
      app.store = new ProjectStore(snap);
      installSaveSubscriber();
      // SM-16: re-apply the search highlight after every commit (renderers
      // re-render the host, dropping the dim/hit classes). Deferred a tick so
      // it runs after the synchronous re-render.
      app.store.subscribe(() => {
        if (app.search) setTimeout(applySearchHighlight, 0);
      });
      // SM-191 (review fix): keep an active JQL query filter fresh. On every
      // commit (local edit OR MCP/applyRemote) re-run the query; remount only
      // when the match membership changed. Without this app.queryMatch goes
      // stale and the storymap morph fast-path keeps now-non-matching cards.
      app.store.subscribe((snap) => {
        if (!app.queryString) return;
        const engine = window.STORYMAP.queryEngine;
        if (!engine) return;
        const r = engine.queryTickets(snap, app.queryString);
        if (r.error) return;
        const next = new Set(r.tickets.map((t) => t.id));
        if (setsEqual(next, app.queryMatch)) return;
        app.queryMatch = next;
        setSmartBarStatus(next.size + (next.size === 1 ? " match" : " matches"), "ok");
        remountForQuery();
      });
    } else {
      app.store.hydrate(snap);
    }
    // E22: Toolbar action buttons are gone; their disabled-state lives on
    // the Edit menu items now via menu-item `disabled: () => ...` callbacks.
    // The menu evaluates them lazily each time the dropdown opens, so no
    // explicit refresh is needed here.

    mountActiveView();
    updateCurrentProjectIndicator();
    // Keep the indicator in sync if the project name changes via MCP/WS.
    app.store.subscribe(updateCurrentProjectIndicator);
    flashStatus("loaded: " + projectId, { kind: "ok" });

    // Live-sync if the adapter supports it.
    if (typeof app.adapter.subscribe === "function") {
      try {
        app.unsubscribeWs = await app.adapter.subscribe(projectId, async () => {
          const fresh = await app.adapter.load(projectId);
          if (fresh) app.store.applyRemote(fresh);
        });
        // SM-153: close the subscribe-after-load gap — a change that landed
        // between the initial load() and the subscription would otherwise be
        // missed until the next event. applyRemote is a no-op on identical
        // snapshots, so this is free when nothing changed.
        if (app.currentProjectId === projectId) {
          const gapFresh = await app.adapter.load(projectId);
          if (gapFresh) app.store.applyRemote(gapFresh);
        }
      } catch (e) { console.warn("WS subscribe failed:", e); }
    }
  }
  // Expose for the switch-request flow + E2E re-load (re-runs per-project
  // hydration incl. the SM-169 swimlane-collapse seed).
  app.loadProject = loadProject;

  function unmountActiveView() {
    if (app.unmountStoryMap) { app.unmountStoryMap(); app.unmountStoryMap = null; }
    if (app.unmountKanban)   { app.unmountKanban.unmount(); app.unmountKanban = null; }
    if (app.unmountDeps)     { app.unmountDeps.unmount();   app.unmountDeps   = null; }
    if (app.unmountRequirements) { app.unmountRequirements.unmount(); app.unmountRequirements = null; }
    if (app.unmountProcessSteps) { app.unmountProcessSteps.unmount(); app.unmountProcessSteps = null; }
    if (app.unmountTable)    { app.unmountTable.unmount(); app.unmountTable = null; }
  }

  function mountActiveView() {
    const mapHost    = $("story-map-host");
    const kanbanHost = $("kanban-host");
    const depsHost   = $("deps-host");
    const reqHost    = $("requirements-view-host");
    const psHost     = $("process-steps-host");
    const tableHost  = $("table-host");
    mapHost.hidden    = (app.activeView !== "storymap");
    kanbanHost.hidden = (app.activeView !== "kanban");
    if (depsHost) depsHost.hidden = (app.activeView !== "dependencies");
    if (reqHost)  reqHost.hidden  = (app.activeView !== "requirements");
    if (psHost)   psHost.hidden   = (app.activeView !== "processSteps");
    if (tableHost) tableHost.hidden = (app.activeView !== "table");
    // SM-293: the Table view has its OWN query line — showing the global
    // smart-bar + filter row on top of it means two competing query inputs
    // (user finding). Hide that toolbar row while the Table view is active.
    const actionBar = document.querySelector(".toolbar-action");
    if (actionBar) actionBar.hidden = (app.activeView === "table");
    if (app.activeView === "kanban") {
      app.unmountKanban = mountKanbanView();
    } else if (app.activeView === "dependencies") {
      app.unmountDeps = mountDependenciesView();
    } else if (app.activeView === "requirements") {
      app.unmountRequirements = mountRequirementsView();
    } else if (app.activeView === "processSteps") {
      app.unmountProcessSteps = mountProcessStepsView();
    } else if (app.activeView === "table") {
      app.unmountTable = mountTableView();
    } else {
      app.unmountStoryMap = mountStoryMapView();
    }
    applySearchHighlight();
  }

  // SM-16: dim non-matching cards + ring the matches across the active view.
  // A DOM overlay (not a re-render) so it's instant and survives nothing —
  // re-applied after every mount + (debounced) after store commits.
  function applySearchHighlight() {
    const q = app.search || "";
    const hostId = app.activeView === "kanban" ? "kanban-host"
                 : app.activeView === "dependencies" ? "deps-host"
                 : "story-map-host";
    const host = $(hostId);
    if (!host) return;
    // Epic cards (`.sm-epic-card`) carry data-ticket-id too — include them so a
    // search for an epic's key/title rings the epic, not just its stories
    // (SM-208). Their opacity cascades to the contained story cards, so an epic
    // is NEVER dimmed: dimming a non-matching epic would also dim a matching
    // story nested inside it. Only the ring (`sm-search-hit`) applies to epics.
    const cards = host.querySelectorAll(
      ".sm-story-card[data-ticket-id], .sm-epic-card[data-ticket-id]"
    );
    const byId = app.store ? indexTicketsById(app.store.get()) : null;
    const matchesSearch = window.STORYMAP.filter.matchesSearch;
    cards.forEach((card) => {
      if (!q) {
        card.classList.remove("sm-search-dim", "sm-search-hit");
        return;
      }
      const ticket = byId && byId.get(card.getAttribute("data-ticket-id"));
      const hit = matchesSearch(ticket, q);
      const isEpic = card.classList.contains("sm-epic-card");
      card.classList.toggle("sm-search-hit", !!hit);
      card.classList.toggle("sm-search-dim", !isEpic && !hit);
    });
  }

  function indexTicketsById(snap) {
    const m = new Map();
    for (const t of (snap && snap.tickets) || []) m.set(t.id, t);
    return m;
  }

  // SM-191 — Unified smart-bar. ONE input: plain words behave as the SM-16
  // free-text highlight; field syntax (query.looksLikeQuery) runs a structured
  // JQL query (query engine) that FILTERS the active view to its matches, with
  // an inline result count + parse/semantic error. The query AND-combines with
  // the SM-82 chip filter (both stay usable). `app.queryMatch` is the match id
  // Set; the renderers read it via opts.matchTicket = queryMatchPredicate().
  function queryMatchPredicate() {
    const set = app.queryMatch;
    return set ? (t) => set.has(t.id) : null;
  }
  function setSmartBarStatus(text, kind) {
    const el = $("smartbar-status");
    if (!el) return;
    el.textContent = text || "";
    el.classList.remove("smartbar-status-error", "smartbar-status-ok");
    if (text && kind) el.classList.add("smartbar-status-" + kind);
  }
  function remountForQuery() {
    if (!app.store) return;
    // SM-282: the Table view has its OWN query line and ignores the global
    // smart-bar filter (matchTicket) — a remount here would only wipe the
    // user's typed table query + results for zero filtering effect.
    if (app.activeView === "table") return;
    unmountActiveView();
    mountActiveView();
  }
  function applySmartBar(raw) {
    const trimmed = (raw == null ? "" : String(raw)).trim();
    const Q = window.STORYMAP.query;
    const engine = window.STORYMAP.queryEngine;
    const wasFiltering = !!app.queryMatch;
    // Field-aware detection: a query starts with a KNOWN field + operator, so
    // plain searches ("find in files", "price < 100") stay simple search.
    const fieldKeys = (engine && engine.QUERY_FIELDS) ? engine.QUERY_FIELDS.map((f) => f.key) : null;
    if (trimmed && Q && engine && Q.looksLikeQuery(trimmed, fieldKeys)) {
      const r = engine.queryTickets(app.store ? app.store.get() : { tickets: [] }, trimmed);
      if (r.error) {
        // Non-destructive: keep whatever the view currently shows, just report.
        setSmartBarStatus(r.error.message, "error");
        return;
      }
      // SM-293: skip the remount when the match set is unchanged — Enter fires
      // immediately AND the pending 200ms debounce re-fires with the same
      // value; without this guard the view would remount twice (flicker).
      const nextMatch = new Set(r.tickets.map((t) => t.id));
      const unchanged = app.queryString === trimmed && setsEqual(nextMatch, app.queryMatch);
      app.search = "";
      app.queryString = trimmed;
      app.queryMatch = nextMatch;
      setSmartBarStatus(r.tickets.length + (r.tickets.length === 1 ? " match" : " matches"), "ok");
      if (!unchanged) remountForQuery();
      applySearchHighlight();   // clear any stale highlight classes
      return;
    }
    // Simple free-text mode (or empty input).
    app.search = trimmed;
    app.queryString = null;
    setSmartBarStatus("", null);
    if (wasFiltering) { app.queryMatch = null; remountForQuery(); }
    applySearchHighlight();
  }
  function setsEqual(a, b) {
    if (a === b) return true;
    if (!a || !b || a.size !== b.size) return false;
    for (const x of a) if (!b.has(x)) return false;
    return true;
  }
  function resetSmartBar() {
    app.search = "";
    app.queryMatch = null;
    app.queryString = null;
    const input = $("ticket-search");
    if (input) input.value = "";
    setSmartBarStatus("", null);
  }

  /** Switch between Story-Map / Kanban / Dependencies without re-loading
   *  the project. Settings is an overlay (E23.B), not a view. */
  function switchView(next) {
    if (next !== "storymap" && next !== "kanban" && next !== "dependencies" && next !== "requirements" && next !== "processSteps" && next !== "table") return;
    if (next === app.activeView) return;
    unmountActiveView();
    app.activeView = next;
    writeActiveViewToStorage(next);
    // SM-205: the active view is now indicated by the check-marked View-menu
    // item (re-evaluated when the menu opens) — no toolbar buttons to update.
    if (app.store) mountActiveView();
  }

  /**
   * E23.B — Settings overlay. Sits on top of whatever view is currently
   * active (Map or Kanban). Close button + Esc closes it; the underlying
   * view never unmounts.
   */
  function openSettings() {
    const host = $("settings-host");
    if (!host) return;
    if (!host.hidden) return;   // already open
    host.hidden = false;
    // Reset host innerHTML so a previous close left no zombies.
    host.innerHTML = "";
    // Build close button + a content host for view-settings to render into.
    const closeBtn = document.createElement("button");
    closeBtn.className = "vs-overlay-close";
    closeBtn.title = "Close settings (Esc)";
    closeBtn.setAttribute("aria-label", "Close settings");
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", closeSettings);
    host.appendChild(closeBtn);
    const content = document.createElement("div");
    content.className = "vs-overlay-content";
    host.appendChild(content);
    app.unmountSettings = viewSettings.mount(content, app.store, {
      flashStatus: flashStatus
    });
    // Esc closes — install ONCE per open, removed on close.
    app._settingsEscHandler = (ev) => {
      if (ev.key === "Escape") { ev.preventDefault(); closeSettings(); }
    };
    document.addEventListener("keydown", app._settingsEscHandler, true);
  }

  function closeSettings() {
    const host = $("settings-host");
    if (!host || host.hidden) return;
    if (app.unmountSettings) { app.unmountSettings.unmount(); app.unmountSettings = null; }
    if (app._settingsEscHandler) {
      document.removeEventListener("keydown", app._settingsEscHandler, true);
      app._settingsEscHandler = null;
    }
    host.hidden = true;
    host.innerHTML = "";
  }

  // SM-203 R-7: the Requirements reconciliation view — a FULL-PAGE view (like
  // Map / Kanban / Dependencies), not an overlay. Source ingestion (attachment
  // → Markdown) runs server-side, so the source pane only fills in HTTP mode.
  // Requirement statements are contentEditable and mirror straight into their
  // requirement ticket via store.updateTicket.
  function mountRequirementsView() {
    const host = $("requirements-view-host");
    const fetchIngest = (app.adapter && app.adapter.name === "Http")
      ? (aid) => httpReq("GET", "/api/projects/" + encodeURIComponent(app.currentProjectId)
          + "/attachments/" + encodeURIComponent(aid) + "/ingest")
      : null;
    return viewRequirements.mount(host, app.store, {
      flashStatus: flashStatus,
      fetchIngest: fetchIngest,
      // Click a traceability chip → open that ticket.
      onOpenTicket: (id) => rendererTicketModal.openTicketModal(buildTicketModalCtx(), id, {}),
      // Orphan/suspect requirement → spin up an implementing story + realises link.
      // The create + link are two commits; if the link throws (validateLink),
      // catch it so we don't leave an orphan ticket + an uncaught DOM-handler
      // exception (review [major]).
      onCreateImplementer: (req) => {
        try {
          const snap = app.store.createTicket({ type: "user-story", title: "Implement: " + req.title }, LOCAL_ACTOR);
          const story = snap.tickets[snap.tickets.length - 1];
          app.store.addLink(story.id, { linkTypeId: "realises", targetTicketId: req.id }, LOCAL_ACTOR);
          flashStatus("Created " + story.ticketKey + " → realises " + req.ticketKey, { kind: "ok" });
        } catch (e) { flashStatus(e.message || "create failed", { kind: "error" }); }
      },
      // Gap source section → create a requirement from it, contained in the module.
      onCreateRequirement: (moduleId, sec) => {
        try {
          const snap = app.store.createTicket({
            type: "requirement", title: sec.heading || sec.body || "Requirement",
            sectionPath: sec.sectionPath, sourceAnchor: { sectionId: sec.sectionPath }
          }, LOCAL_ACTOR);
          const req = snap.tickets[snap.tickets.length - 1];
          app.store.addLink(moduleId, { linkTypeId: "contains", targetTicketId: req.id }, LOCAL_ACTOR);
          flashStatus("Created requirement " + req.ticketKey, { kind: "ok" });
        } catch (e) { flashStatus(e.message || "create failed", { kind: "error" }); }
      },
      // Inline edit of the requirement statement → mirror into its ticket title.
      onEditRequirement: (reqId, text) => {
        try {
          const t = (app.store.get().tickets || []).find(x => x.id === reqId);
          if (!t || t.title === text) return;
          app.store.updateTicket(reqId, { title: text }, LOCAL_ACTOR);
          flashStatus("Updated " + (t.ticketKey || "requirement"), { kind: "ok" });
        } catch (e) { flashStatus(e.message || "update failed", { kind: "error" }); }
      }
    });
  }

  // SM-282 — query-driven table over ALL tickets (incl. epics + unassigned).
  // Soft dependency (progressive enhancement, same pattern as projectIO).
  function mountTableView() {
    const viewTable = SM.viewTable;
    if (!viewTable) return { unmount() {} };
    return viewTable.mount($("table-host"), app.store, {
      onTicketClick: (id) => {
        rendererTicketModal.openTicketModal(buildTicketModalCtx(), id, {});
      },
      onImport: () => openImportDialog()   // SM-289/295: second entry point
    });
  }

  // SM-289/295 — THE unified import dialog (project envelope OR ticket rows).
  function openImportDialog() {
    const dlg = SM.dialogTicketImport;
    if (!dlg) return;
    dlg.openImportDialog({
      store: app.store,   // may be null — project import works without one
      showModal: showModal,
      flashStatus: flashStatus,
      actor: LOCAL_ACTOR,
      listProjects: () => app.adapter.list(),
      onImportProject: (snap, targetId, overwrite) => importSnapshot(snap, targetId, overwrite)
    });
  }

  // SM-295 — THE unified export chooser (project JSON / tickets CSV).
  function openExportChooser() {
    const dlg = SM.dialogTicketImport;
    if (!dlg || !app.store) return;
    dlg.openExportDialog({
      showModal: showModal,
      onExportProject: () => exportCurrentProject(),
      onExportTickets: () => {
        // Current table state when mounted, else persisted config (SM-292).
        if (app.unmountTable && app.unmountTable.exportCsv) { app.unmountTable.exportCsv(); return; }
        if (SM.viewTable) SM.viewTable.exportTicketsCsv(app.store, app.currentProjectId);
      }
    });
  }

  function mountKanbanView() {
    return rendererKanban.mount($("kanban-host"), app.store, {
      filter: app.filter,
      matchTicket: queryMatchPredicate(),   // SM-191 smart-bar query filter
      collapsedReleases: app.kanbanCollapsedReleases || new Set(),
      onSwimlaneCollapse: (swimlaneKey) => {
        if (!app.kanbanCollapsedReleases) app.kanbanCollapsedReleases = new Set();
        if (app.kanbanCollapsedReleases.has(swimlaneKey)) app.kanbanCollapsedReleases.delete(swimlaneKey);
        else app.kanbanCollapsedReleases.add(swimlaneKey);
        writeKanbanCollapsedToStorage(app.currentProjectId, app.kanbanCollapsedReleases);
        if (app.unmountKanban) { app.unmountKanban.unmount(); app.unmountKanban = null; }
        app.unmountKanban = mountKanbanView();
      },
      onReleaseClick: (id) => openEditReleaseDialog(id),
      onTicketClick: (id) => {
        rendererTicketModal.openTicketModal(buildTicketModalCtx(), id, {});
      },
      onAddItem: (laneStatus) => {
        // Type-picker → Create-Modal mit dem Lane-Status vor-konfiguriert.
        // Position bleibt null (Orphan-Ticket im Backlog mit gewähltem Status).
        rendererTicketModal.openTypePickerThenCreate(buildTicketModalCtx(), { status: laneStatus });
      },
      onTicketStatusChange: (ticketId, newStatus) => {
        try {
          app.store.changeStatusGated(ticketId, newStatus, LOCAL_ACTOR);
          flashStatus("status: " + newStatus, { kind: "ok" });
        } catch (err) {
          if (err.kind && err.missing) {
            flashStatus(err.kind + " gate blocks transition: missing " + err.missing.map(m => m.label || m.id).join(", "), { kind: "error" });
          } else {
            flashStatus(err.message || "status change failed", { kind: "error" });
          }
        }
      },
      onLaneReorder: (_laneStatus, orderedIds) => {
        // Kanban-Reorder: NO scope — only sortOrder gets updated globally.
        // Story-Map within an epic uses the SAME sortOrder field, so this
        // reorder also affects the visible story order in that epic
        // (intentional: Kanban is the operational priority view).
        try {
          app.store.reorderTickets(orderedIds, null, LOCAL_ACTOR);
        } catch (err) {
          flashStatus(err.message || "reorder failed", { kind: "error" });
        }
      },
      onCardContextMenu: (ticket, ev) => openCardContextMenu(ticket, ev)
    });
  }

  /**
   * SM-50 — Dependencies view. Read-only DAG of all tickets + typed links.
   * Single integration point: click-on-node opens the ticket detail modal,
   * same as Story-Map and Kanban. Filters live inside the renderer.
   */
  function mountProcessStepsView() {
    // SM-248/249: the Process-Step editor — journey maintenance as its own view.
    return window.STORYMAP.viewProcessSteps.mount($("process-steps-host"), app.store, {
      flashStatus: flashStatus,
      // SM-248/256: double-click opens the SAME edit dialog the story-map
      // backbone header uses (rename / status / delete) — DRY, no parallel UI.
      onEditProcessStep: (id) => openEditProcessStepDialog(id)
    });
  }

  function mountDependenciesView() {
    return rendererDependencies.mount($("deps-host"), app.store, {
      // SM-163: the board "Filter N" popover (status/type/hide-completed) now
      // applies to the dependency view too. main.js remounts the active view on
      // filter change, so this is fresh each time.
      boardFilter: app.filter,
      onTicketClick: (id) => {
        rendererTicketModal.openTicketModal(buildTicketModalCtx(), id, {});
      }
    });
  }

  /**
   * SM-30 — promote / demote popover. Right-click on a Kanban card opens
   * a small menu with four pile-stack actions:
   *   • Top of Backlog / End of Backlog — force `status: backlog` AND park
   *     the ticket at the start/end of the backlog lane.
   *   • Top of Lane / End of Lane       — keep current status, shuffle to
   *     the start/end of the current status's lane.
   *
   * All four actions go through `store.reorderTickets(orderedIds, null)`
   * (and `store.changeStatus` for the backlog-forcing variants), so undo /
   * redo + the WS-sync round-trip work identically to drag-drop.
   */
  function openCardContextMenu(ticket, ev) {
    const items = [
      { label: "Top of Backlog", onClick: () => moveToBacklog(ticket.id, "top") },
      { label: "End of Backlog", onClick: () => moveToBacklog(ticket.id, "end") },
      { label: "Top of Lane",    onClick: () => moveWithinLane(ticket.id, "top") },
      { label: "End of Lane",    onClick: () => moveWithinLane(ticket.id, "end") }
    ];
    uiShell.showContextMenu({
      clientX: ev.clientX,
      clientY: ev.clientY,
      items
    });
  }

  function moveToBacklog(ticketId, where) {
    try {
      const snap = app.store.get();
      const t = snap.tickets.find(x => x.id === ticketId);
      if (!t) return;
      // Bring it back to the backlog status first. Reverse transitions are
      // ungated in the default workflow (E18.D); a custom workflow that
      // refuses the move surfaces the gate error here.
      if (t.status !== "backlog") {
        try { app.store.changeStatusGated(ticketId, "backlog", LOCAL_ACTOR); }
        catch (err) {
          const msg = err.kind && err.missing
            ? err.kind + " gate blocks → backlog: " + err.missing.map(m => m.label || m.id).join(", ")
            : (err.message || "status change failed");
          flashStatus(msg, { kind: "error" });
          return;
        }
      }
      // Re-read after the (possible) status change, then assemble peers.
      const fresh = app.store.get();
      const peers = fresh.tickets
        .filter(x => !x.isDeleted && x.type !== "epic" && x.status === "backlog" && x.id !== ticketId)
        .sort((a, b) => ((a.position && a.position.sortOrder) || 0)
                       - ((b.position && b.position.sortOrder) || 0));
      const orderedIds = where === "top"
        ? [ticketId, ...peers.map(p => p.id)]
        : [...peers.map(p => p.id), ticketId];
      app.store.reorderTickets(orderedIds, null, LOCAL_ACTOR);
      flashStatus("moved to " + where + " of backlog", { kind: "ok" });
    } catch (err) {
      flashStatus(err.message || "move failed", { kind: "error" });
    }
  }

  function moveWithinLane(ticketId, where) {
    try {
      const snap = app.store.get();
      const t = snap.tickets.find(x => x.id === ticketId);
      if (!t) return;
      const peers = snap.tickets
        .filter(x => !x.isDeleted && x.type !== "epic" && x.status === t.status && x.id !== ticketId)
        .sort((a, b) => ((a.position && a.position.sortOrder) || 0)
                       - ((b.position && b.position.sortOrder) || 0));
      const orderedIds = where === "top"
        ? [ticketId, ...peers.map(p => p.id)]
        : [...peers.map(p => p.id), ticketId];
      app.store.reorderTickets(orderedIds, null, LOCAL_ACTOR);
      flashStatus("moved to " + where + " of lane", { kind: "ok" });
    } catch (err) {
      flashStatus(err.message || "move failed", { kind: "error" });
    }
  }

  /**
   * SM-83 — Animate a release's cells-row collapse / expand.
   *
   * Canonical "animate height:auto" trick: max-height transitions only
   * work between two known values, so we measure scrollHeight, fix the
   * start value, force a reflow, then set the target value. On
   * transitionend the inline max-height is cleared so future content
   * growth (new tickets, etc.) isn't capped by the animation value.
   *
   * The cells-row stays in the DOM throughout (good for animation +
   * keeps DnD listeners attached). The chevron icon + aria-expanded and
   * the label-row's compact class are flipped synchronously so the
   * label is in its target visual state from the first frame.
   */
  function animateReleaseCollapse(releaseId, willCollapse) {
    const cells    = document.querySelector('.sm-release-cells[data-release-id="' + releaseId + '"]');
    const labelRow = document.querySelector('.sm-release-label-row[data-release-id="' + releaseId + '"]');
    if (labelRow) labelRow.classList.toggle("sm-release-collapsed", willCollapse);
    if (labelRow) {
      const ch = labelRow.querySelector(".sm-release-chevron");
      if (ch) {
        ch.textContent = willCollapse ? "▶" : "▼";
        ch.setAttribute("aria-expanded", willCollapse ? "false" : "true");
        ch.setAttribute("title", willCollapse ? "Expand release" : "Collapse release");
      }
    }
    if (!cells) return;
    // Token guards against stale transitionend listeners — if the user
    // toggles again before the animation finishes, the previous
    // listener must NOT clobber the current inline max-height.
    const token = (cells._collapseToken = (cells._collapseToken || 0) + 1);
    if (willCollapse) {
      // Collapse: animate from natural height down to 0.
      const h = cells.scrollHeight;
      cells.style.maxHeight = h + "px";
      // Force reflow so the browser commits the start value before we
      // change it to 0 (otherwise the two updates batch into one paint
      // and the transition is skipped entirely — common Safari pitfall).
      void cells.offsetHeight;
      cells.classList.add("sm-release-collapsed-cells");
      // Schedule the target on the next frame so the browser definitely
      // sees a start state distinct from the end state.
      requestAnimationFrame(() => {
        if (cells._collapseToken !== token) return;
        cells.style.maxHeight = "0px";
      });
    } else {
      // Expand: animate from 0 → natural height. Remove the class FIRST
      // so opacity/padding/border transition back in alongside max-height.
      cells.classList.remove("sm-release-collapsed-cells");
      // Make sure we start at 0 (the inline value persisted from the
      // collapse animation, or the renderer's initial-collapsed mark).
      cells.style.maxHeight = "0px";
      void cells.offsetHeight;
      const target = cells.scrollHeight;
      requestAnimationFrame(() => {
        if (cells._collapseToken !== token) return;
        cells.style.maxHeight = target + "px";
      });
      const onEnd = (ev) => {
        if (ev.propertyName !== "max-height") return;
        if (cells._collapseToken !== token) return;
        // Clear inline max-height so future content growth (new cards
        // added later) isn't clipped at the post-animation value.
        cells.style.maxHeight = "";
        cells.removeEventListener("transitionend", onEnd);
      };
      cells.addEventListener("transitionend", onEnd);
    }
  }

  /**
   * SM-84 — Animate an epic's story-grid collapse / expand.
   *
   * Mirrors animateReleaseCollapse but targets the .sm-stories-grid inside
   * the .sm-epic-card. Same scrollHeight → 0 / 0 → scrollHeight trick with
   * a token to guard against rapid re-toggles, and the same transitionend
   * cleanup so future content growth (new stories added) doesn't get
   * clipped at the post-animation value.
   *
   * Why scope to a per-card lookup rather than a single selector: an epic
   * can appear in the DOM multiple times when filters / live-drag shadows
   * are active; the data-ticket-id selector grabs the real (non-shadow)
   * card only. Shadow cards intentionally render uncollapsed and have no
   * chevron — see renderEpicCard's isShadow guard.
   */
  function animateEpicCollapse(epicId, willCollapse) {
    const card = document.querySelector('.sm-epic-card[data-ticket-id="' + epicId + '"]:not(.sm-card-shadow)');
    if (!card) return;
    card.classList.toggle("sm-epic-card-collapsed", willCollapse);
    const chevron = card.querySelector(".sm-epic-chevron");
    if (chevron) {
      chevron.textContent = willCollapse ? "▶" : "▼";
      chevron.setAttribute("aria-expanded", willCollapse ? "false" : "true");
      chevron.setAttribute("title", willCollapse ? "Expand epic" : "Collapse epic");
    }
    const grid = card.querySelector(".sm-stories-grid");
    if (!grid) return;
    const token = (grid._collapseToken = (grid._collapseToken || 0) + 1);
    if (willCollapse) {
      const h = grid.scrollHeight;
      grid.style.maxHeight = h + "px";
      void grid.offsetHeight;
      grid.classList.add("sm-stories-grid-collapsed");
      requestAnimationFrame(() => {
        if (grid._collapseToken !== token) return;
        grid.style.maxHeight = "0px";
      });
    } else {
      grid.classList.remove("sm-stories-grid-collapsed");
      grid.style.maxHeight = "0px";
      void grid.offsetHeight;
      const target = grid.scrollHeight;
      requestAnimationFrame(() => {
        if (grid._collapseToken !== token) return;
        grid.style.maxHeight = target + "px";
      });
      const onEnd = (ev) => {
        if (ev.propertyName !== "max-height") return;
        if (grid._collapseToken !== token) return;
        grid.style.maxHeight = "";
        grid.removeEventListener("transitionend", onEnd);
      };
      grid.addEventListener("transitionend", onEnd);
    }
  }

  function mountStoryMapView() {
    return rendererStoryMap.mount($("story-map-host"), app.store, {
      filter: app.filter,
      matchTicket: queryMatchPredicate(),   // SM-191 smart-bar query filter
      // SM-83: per-project release collapse state. Renderer reads the set
      // each render for the initial DOM (so a collapsed-on-page-load
      // release renders correctly). Toggling uses in-place DOM animation
      // — no remount — to slide the cells-row up/down and let adjacent
      // rows reflow naturally.
      collapsedReleases: app.collapsedReleases || new Set(),
      onToggleReleaseCollapsed: (releaseId) => {
        if (!app.collapsedReleases) app.collapsedReleases = new Set();
        const willCollapse = !app.collapsedReleases.has(releaseId);
        if (willCollapse) app.collapsedReleases.add(releaseId);
        else app.collapsedReleases.delete(releaseId);
        writeCollapsedReleasesToStorage(app.currentProjectId, app.collapsedReleases);
        animateReleaseCollapse(releaseId, willCollapse);
      },
      // SM-84: per-project epic collapse state. Same pattern as releases —
      // renderer reads the set for initial DOM (so a collapsed-on-load epic
      // renders with max-height:0), toggling owns the in-place animation.
      collapsedEpics: app.collapsedEpics || new Set(),
      onToggleEpicCollapsed: (epicId) => {
        if (!app.collapsedEpics) app.collapsedEpics = new Set();
        const willCollapse = !app.collapsedEpics.has(epicId);
        if (willCollapse) app.collapsedEpics.add(epicId);
        else app.collapsedEpics.delete(epicId);
        writeCollapsedEpicsToStorage(app.currentProjectId, app.collapsedEpics);
        animateEpicCollapse(epicId, willCollapse);
      },
      // SM-272: per-project process-step COLUMN collapse. The Set is mutated in
      // place + persisted; the renderer re-renders itself after the callback
      // (width + cell content change, so no CSS-only animation like release/epic).
      collapsedColumns: app.collapsedColumns || new Set(),
      onToggleColumnCollapsed: (psId) => {
        if (!app.collapsedColumns) app.collapsedColumns = new Set();
        if (app.collapsedColumns.has(psId)) app.collapsedColumns.delete(psId);
        else app.collapsedColumns.add(psId);
        writeCollapsedColumnsToStorage(app.currentProjectId, app.collapsedColumns);
      },
      onTicketClick: (id) => {
        // SM-73: opts.onDelete no longer required — openTicketModal
        // falls back to ctx.store.softDeleteTicket on its own.
        rendererTicketModal.openTicketModal(buildTicketModalCtx(), id, {});
      },
      onAddTicket: (cellCtx) => {
        // Per-cell "+ Add Item" button → type-picker → detail-modal (Create-Mode).
        rendererTicketModal.openTypePickerThenCreate(buildTicketModalCtx(), cellCtx);
      },
      onReleaseClick: (id) => openEditReleaseDialog(id),
      onProcessStepClick: (id) => openEditProcessStepDialog(id),
      onAddRelease: () => openNewReleaseDialog(),
      onAddProcessStep: () => openNewProcessStepDialog(),
      onAddProcessStepWithTicket: (ticketId) => openNewProcessStepDialog({ assignTicketId: ticketId }),
      /**
       * Persistenz-Pfad für alle DnD-Drop-Operationen. E18.D: lokale Mutation
       * via Store-Op; save-Subscriber persistiert debounced. Server schreibt
       * eine Revision pro flush, WS pusht Echo an andere Clients (eigener
       * Echo wird per Origin-Id gefiltert).
       */
      persistMove: (ticketId, position) => {
        try {
          app.store.moveTicket(ticketId, position, LOCAL_ACTOR);
        } catch (err) {
          flashStatus(err.message || "move failed", { kind: "error" });
        }
      },
      /**
       * Ticket-Reorder — mirrors onProcessStepReorder exactly. Takes an
       * orderedIds array and an optional scope ({releaseId, processStepId,
       * epicId}). Store renumbers atomically.
       */
      persistReorderTickets: (orderedIds, scope) => {
        if (!orderedIds || orderedIds.length === 0) return;
        try {
          app.store.reorderTickets(orderedIds, scope || null, LOCAL_ACTOR);
        } catch (err) {
          console.error("[reorder] persistReorderTickets failed:", err, "orderedIds:", orderedIds, "scope:", scope);
          flashStatus(err.message || "reorder failed", { kind: "error" });
        }
      },
      onProcessStepReorder: (orderedIds) => {
        try {
          app.store.reorderProcessSteps(orderedIds, LOCAL_ACTOR);
        } catch (err) {
          flashStatus(err.message || "reorder failed", { kind: "error" });
        }
      }
    });
  }

  // ---- Dialog: New Project --------------------------------------------

  function openNewProjectDialog() {
    // SM-195: allow attaching a source PRD/PLD right at project creation.
    // Attachments are a REST feature → only with the HTTP adapter. Files are
    // collected here and uploaded as project-level attachments AFTER the
    // project row exists (an upload failure never aborts the create).
    const isHttp = !!(app.adapter && app.adapter.name === "Http");
    const pendingFiles = [];
    const attachRowHTML = isHttp ? `
        <div class="modal-row np-attach-row">
          <label>Attachments</label>
          <div class="np-attach-wrap">
            <div class="np-attach-dropzone tm-attach-dropzone" id="np-dropzone">Drop a PRD/document here or click to attach (optional)</div>
            <input id="np-file" type="file" multiple class="tm-attach-input" style="display:none">
            <ul class="np-attach-list tm-attach-list" id="np-pending"></ul>
          </div>
        </div>
      ` : "";
    showModal({
      title: "New project",
      sub: "Project ID must match [a-zA-Z0-9_-] (1–100 chars). DoR/DoD-Definitionen können später in den Projekt-Einstellungen gepflegt werden.",
      bodyHTML: `
        <div class="modal-row">
          <label for="np-id">Project ID</label>
          <input id="np-id" type="text" autofocus>
        </div>
        <div class="modal-row">
          <label for="np-name">Display name</label>
          <input id="np-name" type="text">
        </div>
        <div class="modal-row">
          <label for="np-prefix">Ticket prefix</label>
          <input id="np-prefix" type="text" value="P" maxlength="10">
        </div>
        ${attachRowHTML}
      `,
      onMount: (modal) => {
        const idIn = modal.querySelector("#np-id");
        const nameIn = modal.querySelector("#np-name");
        idIn.addEventListener("input", () => {
          if (!nameIn.value) nameIn.value = idIn.value;
        });
        if (!isHttp) return;
        const drop = modal.querySelector("#np-dropzone");
        const fileIn = modal.querySelector("#np-file");
        const listEl = modal.querySelector("#np-pending");
        function renderPending() {
          listEl.innerHTML = "";
          pendingFiles.forEach((f, i) => {
            const li = document.createElement("li");
            li.className = "tm-attach-item";
            const name = document.createElement("span");
            name.className = "tm-attach-name";
            name.textContent = f.name;
            const del = document.createElement("button");
            del.type = "button"; del.className = "tm-attach-del"; del.textContent = "✕";
            del.title = "Remove";
            del.addEventListener("click", (ev) => { ev.preventDefault(); pendingFiles.splice(i, 1); renderPending(); });
            li.appendChild(name); li.appendChild(del);
            listEl.appendChild(li);
          });
        }
        function addFiles(fileList) {
          for (const f of fileList) pendingFiles.push(f);
          renderPending();
        }
        drop.addEventListener("click", () => fileIn.click());
        fileIn.addEventListener("change", () => { if (fileIn.files) addFiles(fileIn.files); fileIn.value = ""; });
        drop.addEventListener("dragover", (ev) => { ev.preventDefault(); drop.classList.add("tm-attach-dropzone-over"); });
        drop.addEventListener("dragleave", () => drop.classList.remove("tm-attach-dropzone-over"));
        drop.addEventListener("drop", (ev) => {
          ev.preventDefault(); drop.classList.remove("tm-attach-dropzone-over");
          if (ev.dataTransfer && ev.dataTransfer.files) addFiles(ev.dataTransfer.files);
        });
      },
      actions: [
        { label: "Cancel", onClick: () => {} },
        {
          label: "Create", primary: true,
          onClick: async (modal) => {
            const id = modal.querySelector("#np-id").value.trim();
            const name = modal.querySelector("#np-name").value.trim() || id;
            const prefix = (modal.querySelector("#np-prefix").value.trim() || "P").toUpperCase();
            if (!BOOTSTRAP.PROJECT_ID_PATTERN.test(id)) {
              flashStatus("invalid project id", { kind: "error" });
              return false;
            }
            try {
              if (app.adapter.name === "Http") {
                // SM-254: the server seeds the default release + process step on
                // create — the UI no longer double-seeds.
                await httpReq("POST", "/api/projects", { id, name, ticketPrefix: prefix });
              } else {
                // Local adapters have no server; seed via the shared helper (DRY).
                const seed = core.normalizeSnapshot({ project: { id, name, ticketPrefix: prefix } });
                const snap = core.seedDefaultScaffold(seed, { type: "human", id: "local", name: "Local" });
                await app.adapter.save(id, snap);
              }
              await loadProject(id);
              flashStatus("created project: " + id + " (with " + BOOTSTRAP.DEFAULT_RELEASE_NAME + " + " + BOOTSTRAP.DEFAULT_PROCESS_STEP_NAME + ")", { kind: "ok" });
              // SM-195: upload any dropped PRDs as project-level attachments now
              // that the project exists. A failure here does NOT abort the create
              // (the project is already there) — just report it.
              if (isHttp && pendingFiles.length) {
                const ctx = buildTicketModalCtx();
                let okCount = 0;
                for (const f of pendingFiles) {
                  try { await ctx.uploadAttachment("none", f); okCount++; }
                  catch (e) { flashStatus("attachment '" + f.name + "' failed: " + (e.message || "error"), { kind: "error" }); }
                }
                if (okCount) flashStatus("attached " + okCount + " document" + (okCount > 1 ? "s" : "") + " to " + id, { kind: "ok" });
              }
            } catch (err) {
              flashStatus(err.message || "create failed", { kind: "error" });
              return false;
            }
          }
        }
      ]
    });
  }

  // ---- Dialog: New Release (E12) --------------------------------------

  function openNewReleaseDialog() {
    const statusOpts = core.DEFAULT_RELEASE_STATUSES
      .map(s => `<option value="${escapeAttr(s)}"${s === "planning" ? " selected" : ""}>${escapeHtml(s)}</option>`).join("");
    showModal({
      title: "New release",
      sub: "Releases are the vertical slices of the Story Map (e.g. v1.0, MVP, Q3 milestone).",
      bodyHTML: `
        <div class="modal-row">
          <label for="nr-name">Name</label>
          <input id="nr-name" type="text" autofocus>
        </div>
        <div class="modal-row">
          <label for="nr-status">Status</label>
          <select id="nr-status">${statusOpts}</select>
        </div>
        <div class="modal-row">
          <label for="nr-desc">Description</label>
          <textarea id="nr-desc" rows="2" placeholder="Optional — what this release covers."></textarea>
        </div>
      `,
      actions: [
        { label: "Cancel", onClick: () => {} },
        {
          label: "Create", primary: true,
          onClick: async (modal) => {
            const name = modal.querySelector("#nr-name").value.trim();
            const status = modal.querySelector("#nr-status").value;
            const description = modal.querySelector("#nr-desc").value;
            if (!name) { flashStatus("name is required", { kind: "error" }); return false; }
            try {
              app.store.createRelease({ name, status, description }, LOCAL_ACTOR);
              flashStatus("release created", { kind: "ok" });
            } catch (err) {
              flashStatus(err.message || "create failed", { kind: "error" });
              return false;
            }
          }
        }
      ]
    });
  }

  // SM-167: tickets positioned in a release that aren't done. Counted by
  // position.releaseId (NOT by what the board filter shows) — this is what the
  // release-completion warning reports. Sorted by sortOrder for a stable list.
  function openTicketsInRelease(snap, releaseId) {
    // SM-244: "open" = NOT terminal (terminal = done ∪ cancelled). A cancelled
    // ticket is closed work, so it no longer counts against completing a release.
    return (snap.tickets || [])
      .filter(t => !t.isDeleted && t.position && t.position.releaseId === releaseId
        && !core.isTerminalStatus(snap.project, t.status))
      .sort((a, b) => ((a.position && a.position.sortOrder) || 0) - ((b.position && b.position.sortOrder) || 0));
  }

  // ---- Dialog: Edit Release (rename, status, dates, delete) -----------

  function openEditReleaseDialog(releaseId) {
    const snap = app.store.get();
    const release = (snap.releases || []).find(r => r.id === releaseId);
    if (!release) { flashStatus("release not found", { kind: "error" }); return; }
    // SM-255: a project keeps ≥1 release — the last one can't be deleted.
    const isLastRelease = (snap.releases || []).filter(r => !r.isDeleted).length <= 1;
    const statusOpts = core.DEFAULT_RELEASE_STATUSES
      .map(s => `<option value="${escapeAttr(s)}"${s === release.status ? " selected" : ""}>${escapeHtml(s)}</option>`).join("");
    // SM-239: show the same X/Y progress (non-epic work items) as the Map/Kanban.
    const prog = core.releaseProgress(snap, releaseId);
    const progText = prog.total > 0
      ? ` · ${prog.done}/${prog.total} done${prog.complete ? " ✓" : ""}`
      : "";
    showModal({
      title: "Edit release",
      sub: `Release "${escapeHtml(release.name)}" — ${escapeHtml(release.id)}${progText}`,
      bodyHTML: `
        <div class="modal-row">
          <label for="er-name">Name</label>
          <input id="er-name" type="text" value="${escapeAttr(release.name)}">
        </div>
        <div class="modal-row">
          <label for="er-status">Status</label>
          <select id="er-status">${statusOpts}</select>
        </div>
        <div class="modal-row">
          <label for="er-desc">Description</label>
          <textarea id="er-desc" rows="2">${escapeHtml(release.description || "")}</textarea>
        </div>
        <div id="er-open-warning" class="er-open-warning" hidden></div>
      `,
      // SM-167: when "completed" is selected, reactively list the tickets that
      // are POSITIONED in this release and not done — incl. backlog-status ones
      // (the release-completion count is by position.releaseId, independent of
      // any board filter). Replaces the old window.confirm.
      onMount: (modal) => {
        const statusSel = modal.querySelector("#er-status");
        const warn = modal.querySelector("#er-open-warning");
        const refresh = () => {
          const completing = statusSel.value === "completed" && release.status !== "completed";
          const open = completing ? openTicketsInRelease(app.store.get(), releaseId) : [];
          if (open.length === 0) { warn.hidden = true; warn.innerHTML = ""; return; }
          const rows = open.map(t =>
            `<li><span class="er-open-key">${escapeHtml(t.ticketKey || t.id)}</span>` +
            `<span class="er-open-title">${escapeHtml(t.title || "")}</span>` +
            `<span class="er-open-status">${escapeHtml(t.status)}</span></li>`).join("");
          warn.innerHTML =
            `<div class="er-open-head">${open.length} ticket(s) are positioned in this release and still open ` +
            `(not done or cancelled; counted by release, independent of any filter). Completing the release leaves them in it:</div>` +
            `<ul class="er-open-list">${rows}</ul>`;
          warn.hidden = false;
        };
        statusSel.addEventListener("change", refresh);
        refresh();
        // SM-255: disable Delete when this is the last release (≥1 required).
        if (isLastRelease) {
          const delBtn = modal.querySelector(".btn.destructive");
          if (delBtn) {
            delBtn.setAttribute("disabled", "disabled");
            delBtn.title = "At least one release is required";
          }
        }
      },
      actions: [
        { label: "Cancel", onClick: () => {} },
        {
          label: "Delete", destructive: true,
          onClick: () => {
            if (isLastRelease) {   // SM-255: guard even if the disabled button is bypassed
              flashStatus("at least one release is required", { kind: "error" });
              return false;
            }
            try {
              app.store.softDeleteRelease(releaseId, LOCAL_ACTOR);
              flashStatus("release deleted", { kind: "ok" });
            } catch (err) {
              flashStatus(err.message || "delete failed", { kind: "error" });
              return false;
            }
          }
        },
        {
          label: "Save", primary: true,
          onClick: (modal) => {
            const patch = {
              name: modal.querySelector("#er-name").value.trim(),
              status: modal.querySelector("#er-status").value,
              description: modal.querySelector("#er-desc").value
            };
            if (!patch.name) { flashStatus("name is required", { kind: "error" }); return false; }
            // SM-167: the open-ticket warning is now a reactive inline list in
            // the dialog (see onMount). It's informational, not blocking — the
            // user already saw which tickets are positioned in this release
            // before clicking Save, so completing proceeds without a second
            // browser-native confirm. Surface the count once more for the log.
            if (patch.status === "completed" && release.status !== "completed") {
              const stillOpen = openTicketsInRelease(app.store.get(), releaseId);
              if (stillOpen.length > 0) {
                flashStatus("release completed — " + stillOpen.length + " ticket(s) remain positioned in it", { kind: "ok" });
              }
            }
            try {
              app.store.updateRelease(releaseId, patch, LOCAL_ACTOR);
              if (!(patch.status === "completed" && release.status !== "completed")) {
                flashStatus("release updated", { kind: "ok" });
              }
            } catch (err) {
              flashStatus(err.message || "update failed", { kind: "error" });
              return false;
            }
          }
        }
      ]
    });
  }

  // ---- Dialog: New Process Step (E12) --------------------------------

  function openNewProcessStepDialog(opts) {
    opts = opts || {};
    // assignTicketId: works for both epic and non-epic tickets. For a
    // non-epic ticket the move clears epicId so it lands as a loose
    // ticket in the new column.
    const assignTicketId = opts.assignTicketId || opts.assignEpicId || null;
    showModal({
      title: assignTicketId ? "New process step + place ticket" : "New process step",
      sub: assignTicketId
        ? "Create a new process step. The dragged ticket will be moved into the new column on submit."
        : "Process steps form the horizontal Backbone — user activities or workflow stages (e.g. Onboarding, Daily Use, Reporting).",
      bodyHTML: `
        <div class="modal-row">
          <label for="nps-name">Name</label>
          <input id="nps-name" type="text" autofocus>
        </div>
        <div class="modal-row">
          <label for="nps-desc">Description</label>
          <textarea id="nps-desc" rows="2" placeholder="Optional."></textarea>
        </div>
      `,
      actions: [
        { label: "Cancel", onClick: () => {} },
        {
          label: "Create", primary: true,
          onClick: (modal) => {
            const name = modal.querySelector("#nps-name").value.trim();
            const description = modal.querySelector("#nps-desc").value;
            if (!name) { flashStatus("name is required", { kind: "error" }); return false; }
            try {
              app.store.createProcessStep({ name, description }, LOCAL_ACTOR);
              if (assignTicketId) {
                const snap = app.store.get();
                const newStepId = snap.processSteps[snap.processSteps.length - 1].id;
                const ticket = snap.tickets.find(t => t.id === assignTicketId);
                if (ticket) {
                  app.store.moveTicket(assignTicketId, {
                    releaseId:     ticket.position && ticket.position.releaseId,
                    processStepId: newStepId,
                    epicId:        null,
                    sortOrder:     0
                  }, LOCAL_ACTOR);
                }
              }
              flashStatus(assignTicketId
                ? "process step created — ticket placed"
                : "process step created", { kind: "ok" });
            } catch (err) {
              flashStatus(err.message || "create failed", { kind: "error" });
              return false;
            }
          }
        }
      ]
    });
  }

  // ---- Dialog: Edit Process Step --------------------------------------

  function openEditProcessStepDialog(stepId) {
    const snap = app.store.get();
    const step = (snap.processSteps || []).find(p => p.id === stepId);
    if (!step) { flashStatus("process step not found", { kind: "error" }); return; }
    showModal({
      title: "Edit process step",
      sub: `Step "${escapeHtml(step.name)}" — ${escapeHtml(step.id)}`,
      bodyHTML: `
        <div class="modal-row">
          <label for="eps-name">Name</label>
          <input id="eps-name" type="text" value="${escapeAttr(step.name)}">
        </div>
        <div class="modal-row">
          <label for="eps-desc">Description</label>
          <textarea id="eps-desc" rows="2">${escapeHtml(step.description || "")}</textarea>
        </div>
      `,
      actions: [
        { label: "Cancel", onClick: () => {} },
        {
          label: "Delete", destructive: true,
          onClick: () => {
            try {
              app.store.softDeleteProcessStep(stepId, LOCAL_ACTOR);
              flashStatus("process step deleted", { kind: "ok" });
            } catch (err) {
              flashStatus(err.message || "delete failed", { kind: "error" });
              return false;
            }
          }
        },
        {
          label: "Save", primary: true,
          onClick: (modal) => {
            const patch = {
              name: modal.querySelector("#eps-name").value.trim(),
              description: modal.querySelector("#eps-desc").value
            };
            if (!patch.name) { flashStatus("name is required", { kind: "error" }); return false; }
            try {
              app.store.updateProcessStep(stepId, patch, LOCAL_ACTOR);
              flashStatus("process step updated", { kind: "ok" });
            } catch (err) {
              flashStatus(err.message || "update failed", { kind: "error" });
              return false;
            }
          }
        }
      ]
    });
  }

  // ---- Dialog: Delete Project (confirm) -------------------------------

  /**
   * Load-Project-Dialog (cmapper-Pattern). Listet alle nicht-gelöschten
   * Projekte als Cards mit Counts. Klick auf Card → loadProject. Aktuelles
   * Projekt bekommt ein "current"-Badge und ist nicht klickbar. Pro Card
   * gibt's einen Delete-Button (außer für das aktuelle).
   */
  async function openLoadProjectDialog() {
    let ids;
    try { ids = await app.adapter.list(); }
    catch (err) { flashStatus(err.message || "list failed", { kind: "error" }); return; }
    if (!Array.isArray(ids)) ids = [];

    // Fetch counts per project in parallel so the modal opens fast.
    const summaries = await Promise.all(ids.map(async (id) => {
      if (id === app.currentProjectId && app.store) {
        return { id, snap: app.store.get() };
      }
      try { return { id, snap: await app.adapter.load(id) }; }
      catch { return { id, snap: null }; }
    }));
    function countsText(s) {
      if (!s) return "—";
      const t = (s.tickets || []).filter(x => !x.isDeleted).length;
      const r = (s.releases || []).filter(x => !x.isDeleted).length;
      const p = (s.processSteps || []).filter(x => !x.isDeleted).length;
      return t + " tickets · " + r + " releases · " + p + " process steps";
    }
    function nameOf(s) {
      return (s && s.project && s.project.name) || "(unnamed)";
    }
    function descOf(s) {
      return (s && s.project && typeof s.project.description === "string") ? s.project.description : "";
    }
    // SM-209: recency without a server endpoint — the dialog already loads each
    // snapshot, so derive "last touched" as the max updatedAt/createdAt across the
    // project header and all of its entities. Works for Http/Local/Memory alike.
    function recencyOf(s) {
      if (!s) return 0;
      let max = 0;
      const bump = (e) => {
        if (!e) return;
        const v = Number(e.updatedAt || e.createdAt || 0);
        if (v > max) max = v;
      };
      bump(s.project);
      (s.tickets || []).forEach(bump);
      (s.releases || []).forEach(bump);
      (s.processSteps || []).forEach(bump);
      return max;
    }
    function fmtRecency(ms) {
      if (!ms) return "";
      const diff = Date.now() - ms;
      const day = 86400000;
      if (diff < 0) return "just now";
      if (diff < day) {
        try { return "today, " + new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }); }
        catch (_e) { return "today"; }
      }
      if (diff < 2 * day) return "yesterday";
      if (diff < 7 * day) return Math.floor(diff / day) + " days ago";
      try { return new Date(ms).toLocaleDateString(); } catch (_e) { return ""; }
    }

    // Enrich each summary once with the derived fields used for filtering + sort.
    summaries.forEach(it => {
      it.name = nameOf(it.snap);
      it.desc = descOf(it.snap);
      it.mtimeMs = recencyOf(it.snap);
    });

    const SORT_KEY = "storymap-project-sort";
    function readSort() {
      try {
        const v = localStorage.getItem(SORT_KEY);
        if (v === "name-asc" || v === "name-desc" || v === "recent" || v === "oldest") return v;
      } catch (_e) {}
      return "recent";
    }
    function writeSort(v) { try { localStorage.setItem(SORT_KEY, v); } catch (_e) {} }

    function cardHtml(it) {
      const isCurrent = it.id === app.currentProjectId;
      const safeId = escapeHtml(it.id);
      const safeName = escapeHtml(it.name);
      const counts = escapeHtml(countsText(it.snap));
      const recency = it.mtimeMs ? escapeHtml(fmtRecency(it.mtimeMs)) : "";
      return ''
        + '<div class="project-card' + (isCurrent ? ' current' : '') + '" data-id="' + safeId + '">'
        +   '<div class="project-card-header">'
        +     '<span class="project-card-name">' + safeName + '</span>'
        +     '<span class="project-card-id">' + safeId + '</span>'
        +     (isCurrent ? '<span class="project-card-current-badge">current</span>' : '')
        +   '</div>'
        +   '<div class="project-card-counts">' + counts + '</div>'
        +   (it.desc ? '<div class="project-card-desc">' + escapeHtml(it.desc) + '</div>' : '')
        +   (recency ? '<div class="project-card-mtime">' + recency + '</div>' : '')
        +   (!isCurrent ? '<button class="btn btn-delete project-card-delete" data-delete="' + safeId + '" title="Delete project">Delete</button>' : '')
        + '</div>';
    }

    const initialSort = readSort();
    const toolbarHTML = ''
      + '<div class="project-picker-toolbar">'
      +   '<input type="text" class="project-search" id="proj-search" placeholder="Search name, id or description…" autocomplete="off" spellcheck="false">'
      +   '<select class="project-sort" id="proj-sort">'
      +     '<option value="name-asc"' + (initialSort === "name-asc" ? " selected" : "") + '>Name A→Z</option>'
      +     '<option value="name-desc"' + (initialSort === "name-desc" ? " selected" : "") + '>Name Z→A</option>'
      +     '<option value="recent"' + (initialSort === "recent" ? " selected" : "") + '>Newest first</option>'
      +     '<option value="oldest"' + (initialSort === "oldest" ? " selected" : "") + '>Oldest first</option>'
      +   '</select>'
      + '</div>';

    showModal({
      title: "Projects",
      sub: "Click a card to switch. Each project is its own story map.",
      bodyHTML: ids.length
        ? toolbarHTML + '<div class="project-list-cards" id="proj-cards-host"></div>'
        : '<div class="project-list-empty">No projects yet — use <em>Project ▸ New project…</em>.</div>',
      actions: [{ label: "Close", onClick: () => {} }],
      onMount: (modal, close) => {
        const host = modal.querySelector("#proj-cards-host");
        const searchEl = modal.querySelector("#proj-search");
        const sortEl = modal.querySelector("#proj-sort");
        if (!host) return;   // empty-state: nothing to wire.

        const wireCard = (card) => {
          card.addEventListener("click", async (e) => {
            if (e.target.closest("[data-delete]")) return;
            const id = card.getAttribute("data-id");
            if (id === app.currentProjectId) { close(); return; }
            close();
            await loadProject(id);
          });
          const delBtn = card.querySelector("[data-delete]");
          if (delBtn) {
            delBtn.addEventListener("click", async (e) => {
              e.stopPropagation();
              const id = delBtn.getAttribute("data-delete");
              if (!confirm("Delete project \"" + id + "\"? (soft delete — restorable via revision history)")) return;
              try {
                if (app.adapter.name === "Http") await httpReq("DELETE", "/api/projects/" + encodeURIComponent(id));
                else await app.adapter.delete(id);
                flashStatus("deleted: " + id, { kind: "ok" });
                close();
                openLoadProjectDialog();   // re-open with refreshed list
              } catch (err) {
                flashStatus(err.message || "delete failed", { kind: "error" });
              }
            });
          }
        };

        const render = () => {
          const q = (searchEl.value || "").trim().toLowerCase();
          const sort = sortEl.value;
          let items = summaries.slice();
          if (q) {
            items = items.filter(it =>
              it.name.toLowerCase().includes(q) ||
              it.id.toLowerCase().includes(q) ||
              (it.desc || "").toLowerCase().includes(q)
            );
          }
          items.sort((a, b) => {
            if (sort === "name-asc")  return a.name.localeCompare(b.name);
            if (sort === "name-desc") return b.name.localeCompare(a.name);
            if (sort === "recent")    return ((b.mtimeMs || 0) - (a.mtimeMs || 0)) || a.name.localeCompare(b.name);
            if (sort === "oldest")    return ((a.mtimeMs || 0) - (b.mtimeMs || 0)) || a.name.localeCompare(b.name);
            return 0;
          });
          if (items.length === 0) {
            host.innerHTML = '<div class="project-list-empty-filtered">No projects match "' + escapeHtml(q) + '"</div>';
            return;
          }
          host.innerHTML = items.map(cardHtml).join("");
          host.querySelectorAll(".project-card").forEach(wireCard);
        };

        searchEl.addEventListener("input", render);
        sortEl.addEventListener("change", () => { writeSort(sortEl.value); render(); });
        render();   // initial paint applies persisted sort + wires cards.
        setTimeout(() => { try { searchEl.focus(); } catch (_e) {} }, 0);
      }
    });
  }

  /**
   * History-Dialog (E13, cmapper-Pattern). Listet die Revisions des aktiven
   * Projekts (reverse-chrono via storage.listRevisions). Pro Row:
   * Timestamp (parsed from YYYYMMDD-HHmmss-mmm), op-Pille, Actor, Restore-
   * Button. Restore feuert POST /revisions/:rev/restore und appliziert das
   * zurückgegebene Snapshot direkt.
   */
  // SM-194: project-level attachments (e.g. a source PRD that precedes the
  // tickets it will be decomposed into). Reuses the shared dropzone/list
  // component with the "none" sentinel = project-scope (ticket_id IS NULL).
  function openProjectAttachmentsDialog() {
    if (!app.currentProjectId) return;
    const ctx = buildTicketModalCtx();
    if (!ctx.attachmentsEnabled) {
      flashStatus("attachments need the HTTP server (not available in local mode)", { kind: "error" });
      return;
    }
    showModal({
      title: "Project attachments",
      sub: "Project-level reference documents (e.g. a source PRD). Not tied to any ticket.",
      bodyHTML: '<div class="tm-project-attach-host"></div>',
      actions: [{ label: "Close", onClick: () => {} }],
      onMount: (modal) => {
        const host = modal.querySelector(".tm-project-attach-host");
        if (host && SM.ticketForm && SM.ticketForm.buildAttachmentsSection) {
          host.appendChild(SM.ticketForm.buildAttachmentsSection("none", ctx));
        }
      }
    });
  }

  async function openHistoryDialog() {
    if (!app.currentProjectId) return;
    let revisions;
    try {
      revisions = await httpReq("GET",
        "/api/projects/" + encodeURIComponent(app.currentProjectId) + "/revisions");
    } catch (err) {
      flashStatus(err.message || "could not load history", { kind: "error" });
      return;
    }
    if (!Array.isArray(revisions)) revisions = [];

    function fmtRev(rev) {
      // YYYYMMDD-HHmmss-mmm[-NNNN] → "YYYY-MM-DD HH:mm:ss.mmm UTC"
      const m = String(rev).match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-(\d{3})/);
      if (!m) return rev;
      return m[1] + "-" + m[2] + "-" + m[3] + " " + m[4] + ":" + m[5] + ":" + m[6] + "." + m[7] + " UTC";
    }
    function actorLabel(a) {
      if (!a) return "—";
      const kind = a.type || "?";
      const name = a.name || a.id || "";
      return name ? (kind + " · " + name) : kind;
    }

    const rowsHtml = revisions.length
      ? revisions.map(r => ''
          + '<div class="hist-row" data-rev="' + escapeAttr(r.revision) + '">'
          +   '<div class="hist-row-main">'
          +     '<span class="hist-timestamp">' + escapeHtml(fmtRev(r.revision)) + '</span>'
          +     '<span class="hist-op-pill">' + escapeHtml(r.op || "save") + '</span>'
          +     '<span class="hist-actor">' + escapeHtml(actorLabel(r.actor)) + '</span>'
          +   '</div>'
          +   '<button class="btn hist-restore" data-restore="' + escapeAttr(r.revision) + '" title="Restore this revision">Restore</button>'
          + '</div>').join("")
      : '<div class="hist-empty">No revisions yet — make changes and they will be recorded here.</div>';

    showModal({
      title: "History",
      sub: "Each save creates a revision. Restoring an older one writes a NEW revision (the restore itself is undoable).",
      bodyHTML: '<div class="hist-list">' + rowsHtml + '</div>',
      actions: [{ label: "Close", onClick: () => {} }],
      onMount: (modal, close) => {
        modal.querySelectorAll("[data-restore]").forEach(btn => {
          btn.addEventListener("click", async (e) => {
            e.stopPropagation();
            const rev = btn.getAttribute("data-restore");
            if (!confirm("Restore revision\n" + fmtRev(rev) + "?\n\n(creates a new revision, so this is undoable.)")) return;
            try {
              const result = await httpReq("POST",
                "/api/projects/" + encodeURIComponent(app.currentProjectId)
                + "/revisions/" + encodeURIComponent(rev) + "/restore");
              if (result && result.snapshot) app.store.applyRemote(result.snapshot);
              else await reloadStore();
              flashStatus("restored " + fmtRev(rev), { kind: "ok" });
              close();
            } catch (err) {
              flashStatus(err.message || "restore failed", { kind: "error" });
            }
          });
        });
      }
    });
  }

  function openDeleteProjectDialog() {
    if (!app.currentProjectId) return;
    const pid = app.currentProjectId;
    showModal({
      title: "Delete project?",
      sub: `Project "${pid}" wird in den Soft-Delete-Status versetzt. Diese Aktion ist über die Revision-History rückgängig zu machen.`,
      actions: [
        { label: "Cancel", onClick: () => {} },
        {
          label: "Delete", destructive: true,
          onClick: async () => {
            try {
              if (app.adapter.name === "Http") {
                await httpReq("DELETE", "/api/projects/" + encodeURIComponent(pid));
              } else {
                await app.adapter.delete(pid);
              }
              app.currentProjectId = null;
              if (app.unmountStoryMap) { app.unmountStoryMap(); app.unmountStoryMap = null; }
              if (app.unmountKanban)   { app.unmountKanban.unmount(); app.unmountKanban = null; }
              closeSettings();   // if the settings overlay was open, hide it too
              writeLastProjectIdToStorage(null);
              updateCurrentProjectIndicator();
              flashStatus("deleted: " + pid, { kind: "ok" });
            } catch (err) {
              flashStatus(err.message || "delete failed", { kind: "error" });
              return false;
            }
          }
        }
      ]
    });
  }

  // ---- Menu Bar wiring -------------------------------------------------

  // ---- SM-15: project Export / Import (JSON) --------------------------

  function exportCurrentProject() {
    if (!app.currentProjectId || !app.store) {
      flashStatus("no project to export", { kind: "error" });
      return;
    }
    const snap = app.store.get();
    const text = projectIO.serializeProject(snap, { exportedAt: new Date().toISOString() });
    triggerDownload(projectIO.exportFilename(snap), text);
    flashStatus("exported " + (snap.project && snap.project.id), { kind: "ok" });
  }

  // Thin browser glue: stream `text` to the user as a file download. Guarded
  // so a JSDOM smoke (no Blob/URL.createObjectURL) doesn't throw.
  function triggerDownload(filename, text) {
    try {
      const blob = new Blob([text], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => { try { URL.revokeObjectURL(url); } catch (_) {} }, 1000);
    } catch (err) {
      flashStatus("download failed: " + (err.message || "error"), { kind: "error" });
    }
  }

  // SM-295: the old file-picker-only project-import UI (no paste, no preview)
  // is gone — the unified Import… dialog hosts the project branch now.

  // SM-295 (review): THROWS on failure — the import dialog owns the error
  // path (flash + keep the modal open so the pasted text is not lost).
  async function importSnapshot(snap, targetId, isOverwrite) {
    const pinned = projectIO.withProjectId(snap, targetId);
    if (app.adapter.name === "Http") {
      if (!isOverwrite) {
        await httpReq("POST", "/api/projects", {
          id: targetId,
          name: (pinned.project && pinned.project.name) || targetId,
          ticketPrefix: (pinned.project && pinned.project.ticketPrefix) || "P"
        });
      }
      await httpReq("PUT", "/api/projects/" + encodeURIComponent(targetId), pinned);
    } else {
      await app.adapter.save(targetId, pinned);
    }
    await loadProject(targetId);
    flashStatus("imported project: " + targetId, { kind: "ok" });
  }

  function mountMenu() {
    uiShell.mountMenuBar($("menu-bar"), [
      {
        id: "project",
        label: "Project",
        items: [
          { label: "New project…",    shortcut: "Mod+N", action: () => openNewProjectDialog() },
          { label: "Load project…",   shortcut: "Mod+O", action: () => openLoadProjectDialog() },
          { type: "separator" },
          // SM-295: ONE import + ONE export entry (previously four). The
          // import dialog auto-detects project envelope vs. ticket rows;
          // the export chooser offers project JSON vs. tickets CSV.
          { label: "Import…", action: () => openImportDialog() },
          { label: "Export…",
            disabled: () => !app.currentProjectId || !app.store,
            action: () => openExportChooser() },
          { type: "separator" },
          { label: "Settings…",
            disabled: () => !app.currentProjectId,
            action: () => openSettings() },
          { label: "Attachments…",
            disabled: () => !app.currentProjectId,
            action: () => openProjectAttachmentsDialog() },
          { type: "separator" },
          {
            label: "Delete current project…",
            disabled: () => !app.currentProjectId,
            action: () => openDeleteProjectDialog()
          }
        ]
      },
      {
        // E22 — Edit menu. Soaks up the actions that used to live in the
        // toolbar (Undo/Redo, Add Ticket/Release/Process Step) plus History
        // (moved out of Project menu). Cut/Copy/Paste are placeholders for
        // now — storymap has no multi-select / clipboard concept yet, so
        // they're disabled. They occupy the slot so the menu reads like
        // the user's mental model from cmapper.
        id: "edit",
        label: "Edit",
        items: [
          { label: "Undo",  shortcut: "Mod+Z",
            disabled: () => !(app.store && app.store.canUndo()),
            action: () => app.store && app.store.undo() },
          { label: "Redo",  shortcut: "Mod+Shift+Z",
            disabled: () => !(app.store && app.store.canRedo()),
            action: () => app.store && app.store.redo() },
          { type: "separator" },
          { label: "Cut",   shortcut: "Mod+X",
            disabled: () => true,  // E22: placeholder; no selection model yet
            action: () => {} },
          { label: "Copy",  shortcut: "Mod+C",
            disabled: () => true,
            action: () => {} },
          { label: "Paste", shortcut: "Mod+V",
            disabled: () => true,
            action: () => {} },
          { type: "separator" },
          { label: "Add Ticket…",       shortcut: "Mod+T",
            disabled: () => !app.currentProjectId,
            // SM-253: default to the newest release (unplaced) so the ticket is
            // visible in the Story Map's holding strip — there is no backlog to
            // hold release-less tickets anymore.
            action: () => rendererTicketModal.openTypePickerThenCreate(
              buildTicketModalCtx(), { releaseId: newestReleaseId() }) },
          { label: "Add Release…",
            disabled: () => !app.currentProjectId,
            action: () => openNewReleaseDialog() },
          { label: "Add Process Step…",
            disabled: () => !app.currentProjectId,
            action: () => openNewProcessStepDialog() },
          { type: "separator" },
          { label: "History…",
            disabled: () => !app.currentProjectId,
            action: () => openHistoryDialog() }
        ]
      },
      {
        // SM-205 — View menu. View switching used to be toolbar toggle buttons;
        // now it's a top-level menu alongside Project + Edit. The active view
        // shows a ✓ in the check gutter — `checked` is a predicate re-evaluated
        // each time the dropdown is rebuilt on open.
        id: "view",
        label: "View",
        items: [
          viewMenuItem("storymap",     "Map"),
          viewMenuItem("kanban",       "Kanban"),
          viewMenuItem("table",        "Table"),
          viewMenuItem("dependencies", "Dependencies"),
          viewMenuItem("requirements", "Requirements"),
          viewMenuItem("processSteps", "Process Steps"),
          { type: "separator" },
          // SM-271: surface the existing hideCompletedReleases board filter as a
          // discoverable View toggle (it was buried in the Filter popover). The
          // ✓ re-evaluates each time the dropdown opens; setFilter persists +
          // remounts so Map + Kanban hide completed releases immediately.
          {
            label: "Hide completed releases",
            checked: () => !!(app.filter && app.filter.hideCompletedReleases),
            action: () => {
              const cur = Object.assign({ statuses: null, types: null, hideCompletedReleases: false }, app.filter || {});
              cur.hideCompletedReleases = !cur.hideCompletedReleases;
              setFilter(cur);
            }
          }
        ]
      }
    ]);
  }

  // SM-205 — one View-menu entry. `checked` drives the gutter ✓ (re-evaluated
  // each time the dropdown opens), so the label text stays in one column.
  function viewMenuItem(view, name) {
    return {
      label: name,
      checked: () => app.activeView === view,
      action: () => switchView(view)
    };
  }

  function wireToolbar() {
    // E22 + SM-205: the toolbar no longer hosts action buttons OR view toggles
    // — those moved to the Edit and View menus. Only the current-project
    // indicator and the SM-82 filter button remain wired here.
    const cpAnchor = $("current-project");
    if (cpAnchor) cpAnchor.addEventListener("click", () => openLoadProjectDialog());
    // SM-82: filter button + popover.
    const filterBtn = $("btn-filter");
    if (filterBtn) {
      filterBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        toggleFilterPopover(filterBtn);
      });
    }
    refreshFilterBadge();
    // SM-16: live ticket search (highlight matches, fade the rest).
    const searchInput = $("ticket-search");
    if (searchInput) {
      // SM-191: the search box is now the unified smart-bar (simple OR JQL).
      uiShell.wireDebounced(searchInput, () => {
        applySmartBar(searchInput.value || "");
      }, 200);
      searchInput.addEventListener("keydown", (ev) => {
        if (ev.key === "Escape") {
          searchInput.value = "";
          applySmartBar("");
          searchInput.blur();
        } else if (ev.key === "Enter") {
          // SM-293: Enter applies immediately (the autocomplete only consumes
          // Enter for an explicitly arrow-chosen suggestion).
          applySmartBar(searchInput.value || "");
        }
      });
      // SM-216: Jira-style autocomplete dropdown on the smart-bar. The keydown
      // listener is capture-phase (added inside attachAutocomplete), so when the
      // dropdown is open it intercepts Enter/Tab/Esc before the handlers above.
      const ac = window.STORYMAP.smartbarAutocomplete;
      if (ac && ac.attachAutocomplete) {
        // The returned handle (incl. detach()) is intentionally discarded:
        // wireToolbar() runs once at boot and the input lives for the page
        // lifetime, so there is nothing to tear down.
        ac.attachAutocomplete(searchInput, {
          getSnapshot: () => (app.store ? app.store.get() : { tickets: [] }),
          onAccept: () => applySmartBar(searchInput.value || "")
        });
      }
    }
  }

  // ---- SM-82 Filter UI -------------------------------------------------
  //
  // The filter button toggles a fixed-positioned popover anchored under it.
  // The popover hosts checkboxes for statuses + types + a hide-completed
  // toggle. State lives in app.filter; localStorage is `storymap-filter-
  // <projectId>`. Filter changes trigger a remount of the active view so
  // the renderer picks up the new opts.filter.

  function refreshFilterBadge() {
    const btn   = $("btn-filter");
    const badge = $("filter-badge");
    if (!btn || !badge || !window.STORYMAP || !window.STORYMAP.filter) return;
    const n = window.STORYMAP.filter.countActiveRules(app.filter || {});
    btn.classList.toggle("active", n > 0);
    if (n > 0) { badge.hidden = false; badge.textContent = String(n); }
    else       { badge.hidden = true;  badge.textContent = "0"; }
  }

  function setFilter(next) {
    // Empty/no-op filter → null (so renderer skips filter pipeline).
    const fmod = window.STORYMAP && window.STORYMAP.filter;
    const normalised = fmod ? fmod.normalizeFilter(next || {}) : (next || null);
    const active = normalised && (normalised.statuses || normalised.types || normalised.hideCompletedReleases);
    app.filter = active ? normalised : null;
    writeFilterToStorage(app.currentProjectId, app.filter);
    refreshFilterBadge();
    // Remount the active view so it picks up app.filter via opts.
    // SM-282: not the Table view — it ignores the chip filter (own query
    // line); a remount would only wipe the typed query for no effect. The
    // filter still applies on the next switch to Map/Kanban (fresh mount).
    if (app.store && app.activeView !== "table") {
      unmountActiveView();
      mountActiveView();
    }
  }

  let _filterPopoverOpen = false;
  function toggleFilterPopover(anchorBtn) {
    if (_filterPopoverOpen) { closeFilterPopover(); return; }
    openFilterPopover(anchorBtn);
  }
  function closeFilterPopover() {
    const pop = $("filter-popover");
    if (pop && pop.parentNode) pop.parentNode.removeChild(pop);
    document.removeEventListener("click",  _filterPopoverOutsideClick, true);
    document.removeEventListener("keydown", _filterPopoverEsc, true);
    _filterPopoverOpen = false;
    const btn = $("btn-filter");
    if (btn) btn.setAttribute("aria-expanded", "false");
  }
  function _filterPopoverOutsideClick(ev) {
    const pop = document.getElementById("filter-popover");
    const btn = document.getElementById("btn-filter");
    if (!pop) return;
    if (pop.contains(ev.target)) return;
    if (btn && btn.contains(ev.target)) return;
    closeFilterPopover();
  }
  function _filterPopoverEsc(ev) {
    if (ev.key === "Escape") { ev.stopPropagation(); closeFilterPopover(); }
  }

  function openFilterPopover(anchorBtn) {
    const snap = app.store ? app.store.get() : null;
    if (!snap) return;
    const project = snap.project || {};
    const workflowStatuses = (project.workflow && project.workflow.statuses) || [];
    const ticketTypes = (project.ticketTypes && project.ticketTypes.length)
      ? project.ticketTypes : ["epic", "user-story", "bug"];
    const cur = app.filter || { statuses: null, types: null, hideCompletedReleases: false };

    // Bulk-toggle helpers re-open the popover so checkbox visual state
    // reflects the new filter immediately.
    function reopen() {
      closeFilterPopover();
      setTimeout(() => openFilterPopover(anchorBtn), 0);
    }

    const pop = document.createElement("div");
    pop.id = "filter-popover";
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-label", "Filter tickets");

    function section(title, body, bulkActions) {
      const sec = document.createElement("section");
      sec.className = "filter-popover-section";
      const headerRow = document.createElement("div");
      headerRow.className = "filter-popover-section-header";
      const h = document.createElement("div");
      h.className = "filter-popover-section-title";
      h.textContent = title;
      headerRow.appendChild(h);
      if (bulkActions) {
        const actions = document.createElement("div");
        actions.className = "filter-popover-section-actions";
        // Bulk-toggles: All / None for multi-select sections.
        const allBtn  = document.createElement("button");
        allBtn.type = "button";
        allBtn.className = "filter-popover-bulk";
        allBtn.textContent = "All";
        allBtn.addEventListener("click", () => bulkActions.selectAll());
        const noneBtn = document.createElement("button");
        noneBtn.type = "button";
        noneBtn.className = "filter-popover-bulk";
        noneBtn.textContent = "None";
        noneBtn.addEventListener("click", () => bulkActions.selectNone());
        actions.appendChild(allBtn);
        actions.appendChild(noneBtn);
        headerRow.appendChild(actions);
      }
      sec.appendChild(headerRow);
      if (body) sec.appendChild(body);
      return sec;
    }
    function checkrow(labelText, checked, onChange) {
      const row = document.createElement("label");
      row.className = "filter-popover-checkrow";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !!checked;
      cb.addEventListener("change", () => onChange(cb.checked));
      const span = document.createElement("span");
      span.textContent = labelText;
      row.appendChild(cb);
      row.appendChild(span);
      return row;
    }

    // Status section.
    const statusIds = workflowStatuses.map(s => typeof s === "string" ? s : s.id);
    const statusBody = document.createElement("div");
    for (const s of workflowStatuses) {
      const sid = typeof s === "string" ? s : s.id;
      const sName = typeof s === "string" ? s : (s.name || s.id);
      const checked = !!(cur.statuses && cur.statuses.indexOf(sid) >= 0);
      statusBody.appendChild(checkrow(sName, checked, (on) => {
        const list = (cur.statuses ? cur.statuses.slice() : []);
        const idx = list.indexOf(sid);
        if (on && idx < 0) list.push(sid);
        if (!on && idx >= 0) list.splice(idx, 1);
        cur.statuses = list;
        setFilter(cur);
      }));
    }
    pop.appendChild(section("Status", statusBody, {
      selectAll:  () => { cur.statuses = statusIds.slice(); setFilter(cur); reopen(); },
      selectNone: () => { cur.statuses = null;              setFilter(cur); reopen(); }
    }));

    // Type section.
    const typeBody = document.createElement("div");
    for (const t of ticketTypes) {
      const checked = !!(cur.types && cur.types.indexOf(t) >= 0);
      typeBody.appendChild(checkrow(t, checked, (on) => {
        const list = (cur.types ? cur.types.slice() : []);
        const idx = list.indexOf(t);
        if (on && idx < 0) list.push(t);
        if (!on && idx >= 0) list.splice(idx, 1);
        cur.types = list;
        setFilter(cur);
      }));
    }
    pop.appendChild(section("Type", typeBody, {
      selectAll:  () => { cur.types = ticketTypes.slice(); setFilter(cur); reopen(); },
      selectNone: () => { cur.types = null;                setFilter(cur); reopen(); }
    }));

    // Release-Status section: just one toggle.
    const relBody = document.createElement("div");
    relBody.appendChild(checkrow("Hide completed releases", cur.hideCompletedReleases, (on) => {
      cur.hideCompletedReleases = on;
      setFilter(cur);
    }));
    pop.appendChild(section("Releases", relBody));

    // Footer: reset link.
    const footer = document.createElement("div");
    footer.className = "filter-popover-footer";
    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "filter-popover-reset";
    reset.textContent = "Reset filter";
    reset.addEventListener("click", () => {
      setFilter(null);
      closeFilterPopover();
    });
    footer.appendChild(reset);
    pop.appendChild(footer);

    document.body.appendChild(pop);

    // Anchor below the button, right-aligned to the button's right edge.
    const rect = anchorBtn.getBoundingClientRect();
    const popW = pop.offsetWidth || 280;
    let left = rect.right - popW;
    if (left < 8) left = 8;
    pop.style.left = left + "px";
    pop.style.top  = (rect.bottom + 6) + "px";

    _filterPopoverOpen = true;
    anchorBtn.setAttribute("aria-expanded", "true");
    // Outside-click + Esc handlers (capture phase so we win against bubbling).
    setTimeout(() => {
      document.addEventListener("click",  _filterPopoverOutsideClick, true);
      document.addEventListener("keydown", _filterPopoverEsc, true);
    }, 0);
  }

  /**
   * Global keyboard shortcuts. Skip when focus is in an editable element
   * so we don't intercept the user's actual text-input typing/undo.
   */
  function wireKeyboardShortcuts() {
    function isEditable(el) {
      if (!el) return false;
      const tag = (el.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return true;
      if (el.isContentEditable) return true;
      return false;
    }
    document.addEventListener("keydown", (ev) => {
      if (!app.store) return;
      if (isEditable(ev.target)) return;
      const mod = ev.metaKey || ev.ctrlKey;
      if (!mod) return;
      const key = (ev.key || "").toLowerCase();
      if (key === "z" && !ev.shiftKey) {
        ev.preventDefault();
        app.store.undo();
      } else if ((key === "z" && ev.shiftKey) || key === "y") {
        ev.preventDefault();
        app.store.redo();
      }
    }, true);
  }

  /**
   * E20.C — MCP-driven project switch. When the server pushes a
   * `switch_request` frame (because a standalone MCP tool called
   * `request_switch_project`), show a confirm modal and route the verdict
   * back. Accept also triggers `loadProject(workspace)` so the user lands
   * on the prepared project immediately.
   */
  function wireSwitchRequestHandler() {
    if (!app.adapter || typeof app.adapter.onSwitchRequest !== "function") return;
    app.adapter.onSwitchRequest(({ workspace, reason, requestId }) => {
      // SM-29: if the requested project is already the one we're viewing,
      // there's nothing to switch to. Silently accept and short-circuit —
      // no modal interrupts the user for a no-op. The MCP caller still gets
      // its `{accepted:true}` resolution so callers that wait_seconds>0
      // don't time out.
      if (workspace && app.currentProjectId === workspace) {
        app.adapter.sendSwitchResponse(requestId, true);
        return;
      }
      const safeWorkspace = escapeHtml(workspace || "");
      const safeReason = reason ? escapeHtml(reason) : null;
      const bodyHTML = safeReason
        ? `<p>An MCP client wants to switch you to project <code>${safeWorkspace}</code>.</p><p class="modal-sub">${safeReason}</p>`
        : `<p>An MCP client wants to switch you to project <code>${safeWorkspace}</code>.</p>`;
      // If the user closes the modal via Esc / outside-click without
      // clicking either action, the server-side long-poll will time out
      // (default 30 s) — the MCP tool resolves with timedOut:true. We
      // accept that fallback rather than trying to monkey-patch the
      // modal's close handler.
      showModal({
        title: "Switch to another project?",
        sub: "Initiated by Claude / MCP",
        bodyHTML: bodyHTML,
        actions: [
          { label: "Cancel", onClick: () => {
              app.adapter.sendSwitchResponse(requestId, false);
            } },
          { label: "Switch", primary: true, onClick: async () => {
              app.adapter.sendSwitchResponse(requestId, true);
              try { await loadProject(workspace); }
              catch (err) { flashStatus("could not switch: " + err.message, { kind: "error" }); }
            } }
        ]
      });
    });
  }

  // ---- Bootstrap -------------------------------------------------------

  async function fetchBuildInfo() {
    // Only meaningful in Http-Mode — local modes have no server to ask.
    if (!app.adapter || app.adapter.name !== "Http") return;
    try {
      const res = await fetch(app.adapter.base + "/api/build-info");
      if (!res.ok) return;
      const info = await res.json();
      const el = $("build-tag");
      if (el && info.commit) {
        el.textContent = "build " + info.commit;
        el.title = (info.subject || info.commit) + (info.committedAt ? " · " + info.committedAt : "");
      }
    } catch (_) { /* ignore */ }
  }

  async function init() {
    // SM-99: pickAdapter is async — probes /api/health on the current
    // origin before falling back to localStorage. The `?api=<url>`
    // override is still honoured first.
    app.adapter = await pickAdapter({ url: window.location.href });
    $("adapter-badge").textContent = app.adapter.name;
    fetchBuildInfo();
    mountMenu();
    wireToolbar();
    wireKeyboardShortcuts();
    wireSwitchRequestHandler();
    // SM-281: Shift+Scrollrad → horizontal. Safari übersetzt shift+wheel
    // nicht selbst; ohne das kommt eine Maus mit rein vertikalem Rad nie
    // an rechts außerhalb liegende Process-Steps.
    if (SM.wheelPan) SM.wheelPan.installShiftWheelPan($("view-host"));
    // SM-244: when the board page is restored from the browser bfcache (e.g.
    // navigating BACK from the full-page editor after cancelling/deleting a
    // ticket there), the WebSocket was frozen and the store is stale — reload
    // the current project from the server so the change is reflected.
    window.addEventListener("pageshow", (ev) => {
      if (ev && ev.persisted && app.currentProjectId) reloadStore();
    });
    try {
      const ids = await app.adapter.list();
      if (ids.length === 0) {
        flashStatus("no projects yet — Project ▸ New project…");
      } else {
        // Prefer the last-opened project (localStorage). If it's gone (deleted
        // or just doesn't exist on this server), fall back to the first one.
        const lastId = readLastProjectIdFromStorage();
        const target = (lastId && ids.indexOf(lastId) >= 0) ? lastId : ids[0];
        await loadProject(target);
      }
    } catch (err) {
      console.error(err);
      flashStatus("init failed: " + err.message, { kind: "error" });
    }
  }

  // ---- Small helpers ---------------------------------------------------

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }
  function escapeAttr(s) { return escapeHtml(s); }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
}());
