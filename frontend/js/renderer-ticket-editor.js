/**
 * renderer-ticket-editor.js — Vollseiten-Ticket-Editor (Epic B / B2, SM-117).
 *
 * Bookmarkbare Seite `/editor?projectId=&ticketId=`. Lädt das Projekt in einen
 * ProjectStore und rendert EIN Ticket type-aware mit DENSELBEN Buildern wie das
 * Detail-Modal (frontend/js/ticket-form.js) — keine Builder-Duplikation. B2
 * liefert Laden + type-aware Sektionen + /ws-Live-Sync; die In-Place-Persistenz
 * (kein Save-Button) folgt in B5, daher ist `markDirty` hier noch ein No-Op.
 *
 * UMD-gewickelt: factory(core, ticketForm). `mount(host, store, ctx)` ist rein
 * (jsdom-testbar); `bootstrap()` macht das I/O (pickAdapter → load → store →
 * mount → WS) und wird von ticket-editor.html auf DOMContentLoaded gerufen.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./core.js"), require("./ticket-form.js"));
  else (root.STORYMAP = root.STORYMAP || {}).rendererTicketEditor = factory(
    root.STORYMAP && root.STORYMAP.core,
    root.STORYMAP && root.STORYMAP.ticketForm
  );
}(typeof self !== "undefined" ? self : this, function (core, ticketForm) {
  "use strict";

  if (!core)       throw new Error("renderer-ticket-editor: core module missing");
  if (!ticketForm) throw new Error("renderer-ticket-editor: ticket-form module missing");

  const {
    el, buildErrorBanner, buildTitleField, buildTypeField, buildStatusField,
    buildPositionFields, buildDescriptionField, buildLabelsField,
    buildAcceptanceCriteriaSection, buildChecklistSection,
    buildPrerequisitesSection, buildStepsSection,
    buildExecutionStepsSection, buildOutcomeSection,
    buildTestExecutionHeader, buildExecutionMetadata,
    buildLinksSection, buildAttachmentsSection, syncFieldFromTicket, LOCAL_ACTOR
  } = ticketForm;

  /**
   * Parse the editor query string into { projectId, ticketId }. Accepts a raw
   * search string ("?a=b") or a full href. Missing keys come back as "".
   */
  function parseEditorQuery(search) {
    let qs = String(search || "");
    const qIdx = qs.indexOf("?");
    if (qIdx >= 0) qs = qs.slice(qIdx + 1);
    const hIdx = qs.indexOf("#");
    if (hIdx >= 0) qs = qs.slice(0, hIdx);
    const params = new URLSearchParams(qs);
    return { projectId: params.get("projectId") || "", ticketId: params.get("ticketId") || "" };
  }

  /**
   * Resolve the effective type-config for a ticket (data-driven section
   * visibility), with the same all-true defaults the modal uses as a fallback
   * when core.getEntityTypeConfig isn't available.
   */
  function typeConfigFor(project, type) {
    if (typeof core.getEntityTypeConfig === "function") return core.getEntityTypeConfig(project, type);
    return {
      showAcceptanceCriteria: true, showDefinitionOfReady: true, showDefinitionOfDone: true,
      allowParentEpic: type !== "epic", showRelease: true, showProcessStep: true,
      showLinks: true
    };
  }

  /**
   * Render the ticket's fields into `host` using the shared ticket-form
   * builders, in the same order the modal uses. Returns nothing; the caller
   * owns `host`. `ctx` carries { projectId, store, flashStatus?, uiShell? } and
   * is threaded into buildLinksSection (which needs store + flashStatus).
   *
   * Edit-mode only — the editor always opens an EXISTING ticket. Persistence is
   * deferred to B5, so the builders get a no-op markDirty for now.
   */
  function renderTicketInto(host, ticket, snapshot, ctx) {
    const project = (snapshot && snapshot.project) || {};
    const typeConfig = typeConfigFor(project, ticket.type);
    const ticketTypes = (project.ticketTypes && project.ticketTypes.length)
      ? project.ticketTypes : core.DEFAULT_TICKET_TYPES;
    // SM-244: status options from the project workflow (incl. cancelled), so a
    // cancelled ticket shows "cancelled" and can be reopened by picking an
    // earlier status — not the hardcoded 5-status default that hid cancelled.
    const statuses = (typeof core.getWorkflowForType === "function")
      ? core.getWorkflowForType(project, ticket.type).statuses.map(s => (typeof s === "string" ? s : s.id))
      : core.DEFAULT_STATUSES;
    // SM-120: the in-place controller (installed by mount) drives section commits
    // through this shared refs.markDirty. Set after build — the builders read the
    // property at event time, so a later assignment takes effect.
    const refs = ctx.refs || { markDirty: function () {} };

    // SM-118: content-first two-pane layout. The error banner spans full width
    // at the top; below it `.te-main` (the content — title hero, description,
    // checklists/steps) takes the room and `.te-side` holds the meta fields
    // (type/status/position/labels/links).
    host.appendChild(buildErrorBanner());
    const layout = el("div", { class: "te-layout" });
    const main = el("div", { class: "te-main" });
    const side = el("aside", { class: "te-side" });
    layout.appendChild(main);
    layout.appendChild(side);
    host.appendChild(layout);

    // --- Main column: title hero + description + content sections ---
    // SM-158: multiline title hero — wraps across the full width (no clipping).
    const titleRow = buildTitleField(ticket, { multiline: true });
    titleRow.classList.add("te-title-row");   // CSS renders this large + label-less
    main.appendChild(titleRow);
    // SM-157: the description self-commits via inline ✓/✗ (and focus-out).
    main.appendChild(buildDescriptionField(ticket, ctx.onDescriptionCommit
      ? { onCommit: ctx.onDescriptionCommit } : {}));

    if (ticket.type === "test-execution") {
      main.appendChild(buildTestExecutionHeader(ticket, snapshot, ctx));
      main.appendChild(buildExecutionMetadata(ticket));
    }
    if (typeConfig.showPrerequisites)   main.appendChild(buildPrerequisitesSection(ticket, refs));
    if (typeConfig.showSteps)           main.appendChild(buildStepsSection(ticket, refs));
    if (typeConfig.showExecutionSteps)  main.appendChild(buildExecutionStepsSection(ticket, refs));
    if (typeConfig.showTestOutcome)     main.appendChild(buildOutcomeSection(ticket, refs));
    if (typeConfig.showAcceptanceCriteria) main.appendChild(buildAcceptanceCriteriaSection(ticket, refs));
    if (typeConfig.showDefinitionOfReady) {
      main.appendChild(buildChecklistSection("Definition of Ready",
        (ticket.definitionOfReady || { items: [] }).items, "definitionOfReady", refs));
    }
    if (typeConfig.showDefinitionOfDone) {
      main.appendChild(buildChecklistSection("Definition of Done",
        (ticket.definitionOfDone || { items: [] }).items, "definitionOfDone", refs));
    }
    // SM-160: Links belong with the content (below the description), not in the
    // compact meta sidebar — they're a list of related tickets, not a control.
    if (typeConfig.showLinks !== false) {
      main.appendChild(buildLinksSection(ticket, snapshot, ctx));
    }
    // SM-185: ticket-scoped attachments (same component as the modal). Only with
    // the HTTP adapter (REST feature); the editor always loads an existing
    // ticket so there's always a ticket id.
    if (ctx.attachmentsEnabled && ctx.ticketId) {
      main.appendChild(buildAttachmentsSection(ctx.ticketId, ctx));
    }

    // --- Sidebar: compact meta fields only ---
    side.appendChild(buildTypeField(ticket, ticketTypes));
    side.appendChild(buildStatusField(ticket, statuses, snapshot));
    for (const row of buildPositionFields(ticket, snapshot, typeConfig)) side.appendChild(row);
    side.appendChild(buildLabelsField(ticket));
    // SM-244: editor action row — Delete (red) + Cancel ticket (amber), parity
    // with the modal which has both.
    const actionsRow = el("div", { class: "te-side-actions" });
    const delBtn = buildDeleteButton(ctx, ticket);
    const cancelBtn = maybeCancelButton(ctx, ticket);
    if (delBtn) actionsRow.appendChild(delBtn);
    if (cancelBtn) actionsRow.appendChild(cancelBtn);
    if (actionsRow.children.length) side.appendChild(actionsRow);
  }

  // SM-244: full-page editor Delete button (red, destructive) — parity with the
  // modal. Confirms first (uiShell modal when available, else window.confirm),
  // soft-deletes, then navigates back if possible. Delete HIDES the ticket; the
  // amber Cancel keeps it visible (scope reduction).
  function buildDeleteButton(ctx, ticket) {
    if (!ticket || !ctx || !ctx.store) return null;
    const ticketId = ctx.ticketId;
    const btn = el("button", { class: "btn destructive te-delete-action", type: "button", text: "Delete" });
    function doDelete() {
      try {
        ctx.store.softDeleteTicket(ticketId, LOCAL_ACTOR);
        if (ctx.flashStatus) ctx.flashStatus("ticket deleted", { kind: "ok" });
        if (typeof window !== "undefined" && window.history && window.history.length > 1) window.history.back();
      } catch (e) {
        if (ctx.flashStatus) ctx.flashStatus((e && e.message) || "delete failed", { kind: "error" });
      }
    }
    btn.addEventListener("click", () => {
      const msg = "This hides the ticket. Use Cancel to drop scope but keep it visible.";
      if (ctx.uiShell && typeof ctx.uiShell.showModal === "function") {
        ctx.uiShell.showModal({
          title: "Delete ticket?", sub: msg,
          actions: [
            { label: "Back", onClick: () => {} },
            { label: "Delete", destructive: true, onClick: () => doDelete() }
          ]
        });
        return;
      }
      if (typeof window !== "undefined" && typeof window.confirm === "function"
          && !window.confirm("Delete this ticket? " + msg)) return;
      doDelete();
    });
    return btn;
  }

  // SM-244: build the editor's "Cancel ticket" button (or null). Mirrors the
  // modal: amber, hidden for spec types + already-cancelled tickets, asks to
  // confirm an epic cascade (via uiShell.showModal when available, else
  // window.confirm) before committing through store.cancelTicket.
  function maybeCancelButton(ctx, ticket) {
    if (!ticket || !ctx || !ctx.store) return null;
    const isSpec = !core.isBoardWorkItem(ticket.type) && ticket.type !== "epic";
    if (isSpec) return null;
    const snap = ctx.store.get();
    if (core.statusCategoryOf(snap.project, ticket.status) === "cancelled") return null;
    // SM-244: a done epic can't be meaningfully cancelled (roll-up keeps it
    // done) — hide the action rather than offer a no-op.
    if (ticket.type === "epic" && core.statusCategoryOf(snap.project, ticket.status) === "done") return null;
    const ticketId = ctx.ticketId;
    const btn = el("button", { class: "btn warn te-cancel-action", type: "button", text: "Cancel ticket" });
    function doCancel() {
      try {
        ctx.store.cancelTicket(ticketId, LOCAL_ACTOR);
        if (ctx.flashStatus) ctx.flashStatus("ticket cancelled", { kind: "ok" });
        // SM-244: close the full-page editor after cancelling (parity with the
        // modal, which closes on cancel) by navigating back.
        if (typeof window !== "undefined" && window.history && window.history.length > 1) window.history.back();
      } catch (e) {
        if (ctx.flashStatus) ctx.flashStatus((e && e.message) || "cancel failed", { kind: "error" });
      }
    }
    btn.addEventListener("click", () => {
      const fresh = ctx.store.get();
      if (ticket.type === "epic") {
        const st = core.epicChildStats(fresh, ticketId);
        const open = st.doing + st.todo;
        // SM-244: always confirm an epic cancel (feedback), naming the cascade.
        const msg = open > 0
          ? "This also cancels " + open + " open " + (open === 1 ? "story" : "stories") + " contained in the epic."
          : "This epic has no open contained stories — only the epic is cancelled.";
        if (ctx.uiShell && typeof ctx.uiShell.showModal === "function") {
          ctx.uiShell.showModal({
            title: "Cancel epic?", sub: msg,
            actions: [
              { label: "Back", onClick: () => {} },
              { label: "Cancel epic", className: "warn", onClick: () => doCancel() }
            ]
          });
          return;
        }
        if (typeof window !== "undefined" && typeof window.confirm === "function"
            && !window.confirm("Cancel this epic? " + msg)) return;
      }
      doCancel();
    });
    return btn;
  }

  /**
   * Mount the editor for `ctx.ticketId` against a ProjectStore. Renders a header
   * (ticket-key + title) + the type-aware field body, then subscribes for
   * live-sync: every store commit re-syncs the sync-keyed fields (focus-guard
   * inside syncFieldFromTicket prevents stomping a field the user is editing).
   *
   * Returns { unmount } — call it to detach the store subscription.
   */
  function mount(host, store, ctx) {
    ctx = ctx || {};
    const ticketId = ctx.ticketId;
    host.innerHTML = "";

    function readTicket() {
      const snap = store.get();
      return (snap.tickets || []).find(t => t.id === ticketId) || null;
    }

    const root = el("div", { class: "te-root" });
    host.appendChild(root);

    const ticket = readTicket();
    if (!ticket) {
      root.appendChild(el("div", { class: "te-missing",
        text: "Ticket not found: " + (ticketId || "(none)") }));
      return { unmount: function () {} };
    }

    // SM-118: content-first — the header is a slim breadcrumb.
    // SM-122/B7: a "← Board" link back to the board so the full-page editor
    // isn't a dead end. The editable title is the hero in the main column.
    const header = el("div", { class: "te-header" });
    header.appendChild(el("a", { class: "te-back", href: "/", title: "Back to the board", text: "← Board" }));
    header.appendChild(el("span", { class: "te-key", text: ticket.ticketKey || "" }));
    root.appendChild(header);

    const body = el("div", { class: "te-body" });
    root.appendChild(body);
    // SM-157: description self-commits to the store; bootstrap's save-subscriber
    // then debounce-PUTs the snapshot so it survives a reload.
    const onDescriptionCommit = function (text) {
      try { store.updateTicket(ticketId, { description: text }, LOCAL_ACTOR); }
      catch (e) { if (ctx.flashStatus) ctx.flashStatus("description save failed: " + (e && e.message || e), { kind: "error" }); }
    };
    // SM-120: full in-place persistence — every field commits a Store-op (no
    // Save button). The shared `refs` is driven by installInPlaceCommit below.
    const refs = { markDirty: function () {} };
    renderTicketInto(body, ticket, store.get(), Object.assign({}, ctx, { store, onDescriptionCommit, refs }));

    // SM-120: inline gate-error reporting reuses the error banner at the top.
    function showStatusError(msg) {
      const banner = body.querySelector('[data-sm-sync-key="_error_banner"]');
      if (!banner) return;
      if (!msg) { banner.style.display = "none"; banner.textContent = ""; return; }
      banner.style.display = "block";
      banner.textContent = msg;
    }
    const inplace = ticketForm.installInPlaceCommit(body, {
      store: store, ticketId: ticketId, actor: LOCAL_ACTOR,
      onStatusError: showStatusError, flashStatus: ctx.flashStatus
    });
    refs.markDirty = inplace.markDirty;   // section edits now auto-commit

    // Live-sync: re-sync fields on every commit. syncFieldFromTicket carries
    // its own focus-guard + section rebuilds (AC / DoR / DoD / prereqs / steps
    // / links), so an external edit (board, modal, MCP) reflects here.
    const unsubscribe = store.subscribe(function () {
      const fresh = readTicket();
      if (!fresh) return;
      syncFieldFromTicket(body, fresh, store.get());
    });

    return { unmount: function () {
      try { unsubscribe(); } catch (_) { /* ignore */ }
      try { inplace.detach(); } catch (_) { /* ignore */ }
    } };
  }

  /**
   * SM-157: debounced whole-snapshot save-subscriber (mirrors
   * main.js#installSaveSubscriber). Persists every store commit EXCEPT
   * applyRemote/hydrate (those came from the server — re-saving would
   * ping-pong). Without it the editor store is local-only and edits vanish on
   * reload.
   */
  // SM-214: delegates to the shared save-pipeline module (debounce, SM-153
  // race guard, one retry, pagehide flush via saveBeacon) — the exact same
  // pipeline main.js uses. Keeps the editor surface DRY with the map/kanban.
  function installSaveSubscriber(store, adapter, projectId, SM, flashStatus, win) {
    const sp = (SM && SM.savePipeline) ||
               (typeof require === "function" ? require("./save-pipeline.js") : null);
    if (!sp) throw new Error("renderer-ticket-editor: save-pipeline module missing (load order)");
    const skip = (SM && SM.store && SM.store.SKIP_PERSIST_REASONS) || null;
    return sp.createSavePipeline({
      store: store,
      adapter: adapter,
      projectId: projectId,
      skipReasons: skip,
      onError: function (err) {
        if (flashStatus) flashStatus("save failed: " + ((err && err.message) || err), { kind: "error" });
      },
      win: win
    });
  }

  /**
   * Page entry-point: parse the URL, pick an adapter, load the project into a
   * ProjectStore, mount the editor, and wire /ws live-sync. Called from
   * ticket-editor.html on DOMContentLoaded. Needs window.STORYMAP.{adapters,
   * store, uiShell}. Resolves to the mount controller (or null on failure).
   */
  async function bootstrap(opts) {
    opts = opts || {};
    const win = (typeof window !== "undefined") ? window : {};
    const SM = win.STORYMAP || {};
    const adapters = opts.adapters || SM.adapters;
    const ProjectStore = (opts.store && opts.store.ProjectStore) || (SM.store && SM.store.ProjectStore);
    const uiShell = opts.uiShell || SM.uiShell;
    const hostEl = opts.host || (win.document && win.document.getElementById("editor-host"));
    const flashStatus = (uiShell && uiShell.flashStatus) || function (m) { /* no shell */ if (win.console) win.console.log("[editor] " + m); };

    const href = opts.href || (win.location && win.location.href) || "";
    const search = opts.search || (win.location && win.location.search) || href;
    const q = parseEditorQuery(search);
    if (!q.projectId || !q.ticketId) {
      if (hostEl) hostEl.appendChild(el("div", { class: "te-missing", text: "Missing ?projectId= or ?ticketId= in the URL." }));
      return null;
    }

    const adapter = await adapters.pickAdapter({ url: href });
    const snap = await adapter.load(q.projectId);
    if (!snap) {
      if (hostEl) hostEl.appendChild(el("div", { class: "te-missing", text: "Project not found: " + q.projectId }));
      return null;
    }
    const store = new ProjectStore(snap);

    // SM-158: the URL's ticketId may be the human ticket-KEY (SM-140) or the
    // internal id (t-…) — resolve either to the internal id so links built from
    // the key (Jira-style, memorable, type-able) work. All store-ops below use
    // the resolved internal id.
    const t = (snap.tickets || []).find(x => x.id === q.ticketId || x.ticketKey === q.ticketId);
    if (!t) {
      if (hostEl) hostEl.appendChild(el("div", { class: "te-missing", text: "Ticket not found: " + q.ticketId }));
      return null;
    }
    const ticketId = t.id;

    // SM-157: persist store commits (e.g. the description inline-confirm) back
    // to the server via a debounced whole-snapshot PUT — same cmapper pattern
    // as the board (main.js#installSaveSubscriber). Without this the editor's
    // store would be a local-only copy and edits would vanish on reload.
    installSaveSubscriber(store, adapter, q.projectId, SM, flashStatus, win);

    // SM-185: attachment helpers (HTTP adapter only — REST feature), so the
    // full-page editor shows the same ticket-scoped dropzone as the modal.
    const attBase = function (p) { return adapter.base + "/api/projects/" + encodeURIComponent(q.projectId) + p; };
    const attHeaders = function () { return { "X-Origin-Id": adapter.originId }; };
    const ctx = {
      projectId: q.projectId, ticketId: ticketId, store, uiShell, flashStatus,
      attachmentsEnabled: !!(adapter && adapter.name === "Http"),
      attachmentHref: function (aid) { return attBase("/attachments/" + encodeURIComponent(aid)); },
      listAttachments: async function (tid) {
        const res = await fetch(attBase("/attachments?ticketId=" + encodeURIComponent(tid)));
        if (!res.ok) return [];
        const d = await res.json(); return (d && d.attachments) || [];
      },
      uploadAttachment: async function (tid, file) {
        // Send raw bytes as an ArrayBuffer for cross-fetch determinism (a File
        // body works in browsers but not every fetch impl), matching main.js.
        const bytes = (typeof file.arrayBuffer === "function") ? await file.arrayBuffer() : file;
        const res = await fetch(attBase("/attachments?ticketId=" + encodeURIComponent(tid)), {
          method: "POST",
          headers: Object.assign({ "Content-Type": file.type || "application/octet-stream", "X-Filename": encodeURIComponent(file.name) }, attHeaders()),
          body: bytes
        });
        if (!res.ok) {
          let d = null; try { d = JSON.parse(await res.text()); } catch (_) { /* non-JSON */ }
          const e = new Error((d && d.error) || ("HTTP " + res.status)); e.statusCode = res.status; throw e;
        }
        return (await res.json()).attachment;
      },
      deleteAttachment: async function (aid) {
        const res = await fetch(attBase("/attachments/" + encodeURIComponent(aid)), { method: "DELETE", headers: attHeaders() });
        if (!res.ok && res.status !== 204) { const e = new Error("HTTP " + res.status); e.statusCode = res.status; throw e; }
      }
    };
    const ctrl = mount(hostEl, store, ctx);

    // Reflect the ticket key in the document title / tab.
    if (win.document) win.document.title = (t.ticketKey ? t.ticketKey + " — " : "") + (t.title || "Editor") + " · Story Mapper";

    // /ws live-sync: on any change, reload the snapshot and applyRemote.
    if (typeof adapter.subscribe === "function") {
      try {
        await adapter.subscribe(q.projectId, async function () {
          const fresh = await adapter.load(q.projectId);
          if (fresh) store.applyRemote(fresh);
        });
      } catch (e) { if (win.console) win.console.warn("editor WS subscribe failed:", e); }
    }

    return ctrl;
  }

  return {
    mount,
    bootstrap,
    parseEditorQuery,
    // exposed for tests
    _internals: { renderTicketInto, typeConfigFor }
  };
}));
