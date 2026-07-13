/**
 * Ticket-Detail-Modal — schwebt über der Seite (E10).
 *
 * Rendert ein editierbares Detail-Modal für ein Ticket. Felder:
 *   Title, Type, Status, Release, ProcessStep, Epic, Description,
 *   Acceptance-Criteria, DoR-Checklist, DoD-Checklist, Labels.
 *
 * Pattern: nutzt `showModal` aus `ui-shell.js` als Host und baut den
 * Body via DOM-Manipulation im `onMount`-Callback (rich form statt
 * HTML-String, weil dynamische Inputs + Live-Sync nötig sind).
 *
 * Live-Sync: solange das Modal offen ist, abonniert es Store-Commits.
 * Auf jedes Commit wird das Ticket frisch aus dem Store gelesen und die
 * Felder aktualisiert — AUSSER dem Feld, in dem der User gerade tippt
 * (`document.activeElement`-Guard), sodass tippender Input nicht
 * überschrieben wird.
 *
 * Persistenz: Save-Button feuert PUT /tickets/:tid für die "normalen"
 * Felder. Status-Wechsel feuert separat POST /tickets/:tid/status
 * (damit DoR/DoD-Gates auf dem Server greifen — bei 422 wird die
 * Missing-Liste im Modal als Fehlerbanner angezeigt). DoR/DoD-Items
 * werden INLINE bei Click via POST /tickets/:tid/dor/:itemId/{check,uncheck}
 * persistiert (kein Save nötig — sofortiger Effekt).
 *
 * Mount API:
 *   openTicketModal(ctx, ticketId, opts) → { close }
 *     ctx.store              ProjectStore-Instanz
 *     ctx.projectId          string — für die HTTP-Pfade
 *     ctx.adapter            adapter mit .name === "Http" oder Local
 *     ctx.httpReq(method, path, body) — async, throws on non-2xx (siehe main.js)
 *     ctx.reloadStore()      — async, GET + applyRemote (nach Status/Item-Ops)
 *     ctx.applySnapshot(snap) — appliziert direkt zurückgegebenen Snapshot
 *     ctx.flashStatus(msg, opts?) — User-Feedback
 *     opts.onDelete(ticketId) — optional: separater Delete-Pfad (Soft-Delete via DELETE-Endpoint)
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./core.js"), require("./dnd.js"), require("./ticket-form.js"));
  else (root.STORYMAP = root.STORYMAP || {}).rendererTicketModal = factory(
    root.STORYMAP && root.STORYMAP.core,
    root.STORYMAP && root.STORYMAP.dnd,
    root.STORYMAP && root.STORYMAP.ticketForm
  );
}(typeof self !== "undefined" ? self : this, function (core, dnd, ticketForm) {
  "use strict";

  if (!core) throw new Error("renderer-ticket-modal: core module missing");
  if (!dnd)  throw new Error("renderer-ticket-modal: dnd module missing");
  if (!ticketForm) throw new Error("renderer-ticket-modal: ticket-form module missing");

  // SM-116 (Epic B / B1): the form builders + state helpers live in the shared
  // ticket-form.js so the full-page editor (B2+) reuses them. This module is now
  // a thin host — it pulls the builders into scope under their original names so
  // every call site below is unchanged, and keeps only the modal-specific
  // orchestration (showModal lifecycle, create/edit save, type-picker, starter).
  const {
    CONSTANTS, LOCAL_ACTOR, el, buildErrorBanner,
    buildTitleField, buildTypeField, buildStatusField, buildPositionFields,
    buildDescriptionField, buildChecklistSection, buildAcceptanceCriteriaSection, buildPrerequisitesSection,
    buildStepsSection, buildLabelsField, buildTestExecutionHeader, buildExecutionMetadata,
    buildExecutionStepsSection, buildOutcomeSection, buildLinksSection, syncFieldFromTicket,
    pulseChangedFields, buildDraftTicket, collectFormState, buildUpdatePatch,
    installInPlaceCommit, buildAttachmentsSection
  } = ticketForm;

  // SM-244: build the "Cancel ticket" action (or null). Cancel ≠ Delete —
  // amber, not red; keeps the ticket visible with its history. Hidden for spec
  // types (own lifecycle) and already-cancelled tickets. Cancelling an epic with
  // open stories asks for confirmation (the cascade) before committing.
  function maybeCancelAction(ctx, initial, ticketId) {
    if (!initial) return null;
    const isSpec = !core.isBoardWorkItem(initial.type) && initial.type !== "epic";
    if (isSpec) return null;
    const snap0 = ctx.store.get();
    if (core.statusCategoryOf(snap0.project, initial.status) === "cancelled") return null;
    // SM-244: an epic that is already DONE (its shipped work dominates the
    // roll-up) can't be meaningfully cancelled — cancelling its (zero) open
    // stories leaves it done. Hide the action instead of offering a no-op.
    if (initial.type === "epic" && core.statusCategoryOf(snap0.project, initial.status) === "done") return null;

    function doCancel() {
      try {
        ctx.store.cancelTicket(ticketId, LOCAL_ACTOR);
        if (ctx.flashStatus) ctx.flashStatus("ticket cancelled", { kind: "ok" });
      } catch (err) {
        if (ctx.flashStatus) ctx.flashStatus(err.message || "cancel failed", { kind: "error" });
      }
    }

    return [{
      label: "Cancel ticket",
      className: "warn",
      onClick: () => {
        const fresh = ctx.store.get();
        if (initial.type === "epic") {
          const st = core.epicChildStats(fresh, ticketId);
          const open = st.doing + st.todo;   // non-terminal contained stories
          // Resolve uiShell the same way openTicketModal does (ctx → window
          // fallback). Without it, degrade gracefully to a direct cancel.
          const shell = ctx.uiShell
            || (typeof window !== "undefined" && window.STORYMAP && window.STORYMAP.uiShell);
          // SM-244: ALWAYS confirm an epic cancel (even with no contained stories)
          // so the action gives clear feedback. The message names the cascade.
          if (shell && typeof shell.showModal === "function") {
            const sub = open > 0
              ? "This also cancels " + open + " open " + (open === 1 ? "story" : "stories") + " contained in the epic."
              : "This epic has no open contained stories — only the epic is cancelled.";
            shell.showModal({
              title: "Cancel epic?",
              sub: sub,
              // SM-278: these open a NEW modal into the single #modal-host. They
              // MUST return false so showModal does not run its post-onClick
              // close() — which does host.innerHTML="" and would destroy the very
              // modal we just opened (the root cause of "epic cancel does nothing").
              actions: [
                { label: "Back", onClick: () => { openTicketModal(ctx, ticketId, {}); return false; } },
                { label: "Cancel epic", className: "warn", onClick: () => doCancel() }
              ]
            });
            // SM-278: return false so the outer action handler does NOT call
            // close() and wipe the confirm modal we just opened into the host.
            return false;
          }
        }
        doCancel();
      }
    }];
  }

  // ---- Mount API ------------------------------------------------------

  /**
   * Open the ticket-detail modal for a ticket id. Returns { close }.
   *
   * The modal lifecycle:
   *   open → onMount fires → wire fields + subscribe to store
   *   close → unsubscribe + remove DOM (showModal handles DOM teardown)
   *
   * For Esc / click-outside / Cancel → close fn fires the showModal close.
   * For Save → POST/PUT, await, then close on success (or stay open + show
   *   error banner on validation failure).
   * For Delete → DELETE endpoint, await, then close.
   */
  function openTicketModal(ctx, ticketId, opts) {
    opts = opts || {};
    if (!ctx || !ctx.store) throw new Error("openTicketModal: ctx.store missing");
    const showModal = (ctx.uiShell && ctx.uiShell.showModal)
      || (typeof window !== "undefined" && window.STORYMAP && window.STORYMAP.uiShell && window.STORYMAP.uiShell.showModal);
    if (typeof showModal !== "function") throw new Error("openTicketModal: showModal helper missing on uiShell");

    // Create-Mode: ticketId === null. opts.draft = { type, releaseId, processStepId, epicId }.
    const isCreate = (ticketId == null);

    function readTicket() {
      const snap = ctx.store.get();
      return (snap.tickets || []).find(t => t.id === ticketId) || null;
    }

    const initial = isCreate
      ? buildDraftTicket((opts.draft && opts.draft.type) || "user-story", opts.draft || {})
      : readTicket();
    if (!initial) {
      if (ctx.flashStatus) ctx.flashStatus("ticket not found: " + ticketId, { kind: "error" });
      return { close: () => {} };
    }
    // Effective config for this ticket type (resolves data-driven defaults).
    const project = ctx.store.get().project || {};
    const typeConfig = (typeof core.getEntityTypeConfig === "function")
      ? core.getEntityTypeConfig(project, initial.type)
      : { showAcceptanceCriteria: true, showDefinitionOfReady: true, showDefinitionOfDone: true, allowParentEpic: initial.type !== "epic", showRelease: true, showProcessStep: true };

    const refs = { markDirty: () => {} };   // set after onMount fires
    const actions = isCreate
      ? [
          { label: "Cancel", onClick: () => {} },
          { label: "Create", primary: true, onClick: async (modal) => createOnSave(ctx, modal, initial, opts) }
        ]
      : [
          { label: "Delete", destructive: true, onClick: async () => {
              // SM-73: Delete used to rely on opts.onDelete being plumbed
              // by every caller — Kanban and Dependencies didn't pass it,
              // so the button silently no-op'd. Centralise the soft-delete
              // here so it works regardless of how the modal was opened.
              // opts.onDelete still wins when a caller wants a custom path.
              try {
                if (typeof opts.onDelete === "function") {
                  await opts.onDelete(ticketId);
                } else if (ctx && ctx.store && typeof ctx.store.softDeleteTicket === "function") {
                  ctx.store.softDeleteTicket(ticketId, LOCAL_ACTOR);
                  if (ctx.flashStatus) ctx.flashStatus("ticket deleted", { kind: "ok" });
                }
              } catch (err) {
                if (ctx && ctx.flashStatus) ctx.flashStatus(err.message || "delete failed", { kind: "error" });
                console.error("[ticket-modal] delete failed:", err);
                return false;   // keep the modal open so the user sees the error
              }
            }
          },
          // SM-244: Cancel ticket — a deliberate non-implementation. NOT red
          // (Delete stays red); cancel keeps the ticket visible with history.
          // Hidden for spec types (own lifecycle) and already-cancelled tickets.
          ...(maybeCancelAction(ctx, initial, ticketId) || []),
          // SM-120/B5b: no Save button — every field commits in place (see
          // installInPlaceCommit below). Just a Close action.
          { label: "Close", onClick: () => {} }
        ];

    const handle = showModal({
      title: isCreate
        ? "New " + (initial.type || "ticket")
        : (initial.ticketKey ? initial.ticketKey + " — " : "") + (initial.title || "(no title)"),
      bodyHTML: '<div class="tm-body-host"></div>',
      actions: actions,
      onMount: (modal, close) => {
        const host = modal.querySelector(".tm-body-host");
        const snapshot = ctx.store.get();
        const projectInner = snapshot.project || {};
        const ticketTypes = (projectInner.ticketTypes && projectInner.ticketTypes.length)
          ? projectInner.ticketTypes : core.DEFAULT_TICKET_TYPES;
        // SM-244: the status dropdown must reflect the PROJECT workflow (which
        // includes cancelled), not the hardcoded 5-status default — otherwise a
        // cancelled ticket has no matching option and falls back to "backlog",
        // and there is no way to reopen it. Reopen = pick an earlier status
        // (ungated reverse move); cancel = pick cancelled (gate-free transition).
        const statuses = (typeof core.getWorkflowForType === "function")
          ? core.getWorkflowForType(projectInner, initial.type).statuses.map(s => (typeof s === "string" ? s : s.id))
          : core.DEFAULT_STATUSES;

        // SM-122/B7: turn the modal title into a link to the full-page editor
        // (edit-mode only — the full page needs an existing ticket). Plain click
        // navigates; right/middle-click opens a new tab — a real <a>.
        if (!isCreate && ctx.projectId && ticketId) {
          const h2 = modal.querySelector("h2");
          if (h2) {
            // SM-158: link by the human ticket-KEY (SM-140) when available, so
            // the URL is memorable/type-able (the editor resolves key→id).
            const keyForLink = initial.ticketKey || ticketId;
            const href = "/editor?projectId=" + encodeURIComponent(ctx.projectId)
                       + "&ticketId=" + encodeURIComponent(keyForLink);
            const link = el("a", { class: "tm-fullpage-link", href: href,
              title: "Open this ticket in the full-page editor" });
            link.textContent = h2.textContent;
            h2.textContent = "";
            h2.appendChild(link);
            h2.appendChild(el("span", { class: "tm-fullpage-icon", title: "Open full view", text: " ↗" }));
          }
        }

        // SM-120/B5b: in-place commit controller (installed after the body is
        // built, edit-mode only). The section refs below call inplace.markDirty
        // so add/remove/reorder/toggle in AC/DoR/DoD/prereqs/steps auto-commits.
        let inplace = null;

        host.appendChild(buildErrorBanner());
        host.appendChild(buildTitleField(initial));
        host.appendChild(buildTypeField(initial, ticketTypes));
        host.appendChild(buildStatusField(initial, statuses, snapshot));
        for (const row of buildPositionFields(initial, snapshot, typeConfig)) host.appendChild(row);
        // SM-157: in edit-mode the description self-commits via inline ✓/✗ (and
        // on focus-out), so free-text edits aren't lost if the user forgets the
        // Save button. Create-mode collects the description on Create instead.
        host.appendChild(buildDescriptionField(initial, isCreate ? {} : {
          onCommit: (text) => ctx.store.updateTicket(ticketId, { description: text }, LOCAL_ACTOR)
        }));
        // SM-57: Test-Execution header pill + metadata strip. Only relevant in
        // edit-mode — create-mode for test-execution goes through the dedicated
        // starter dialog (openTestExecutionStarter), not this modal.
        if (!isCreate && initial.type === "test-execution") {
          host.appendChild(buildTestExecutionHeader(initial, snapshot, Object.assign({}, ctx, { openTicketModal })));
          host.appendChild(buildExecutionMetadata(initial));
        }

        // SM-54: Prereqs + Steps + AC are all type-driven and re-rendered on
        // type change in Create-mode. Encapsulated in a single helper so a
        // Type switch can re-evaluate visibility uniformly.
        let prereqsDirty = false, stepsDirty = false, acDirty = false;
        function renderTypeDrivenSections(opts) {
          const reseed = !!(opts && opts.reseed);
          // Strip prior renders before re-mounting.
          host.querySelectorAll('section.tm-ac-section').forEach(n => n.remove());
          host.querySelectorAll('section.tm-prereqs').forEach(n => n.remove());
          host.querySelectorAll('section.tm-test-steps').forEach(n => n.remove());
          // Re-resolve typeConfig from the CURRENT form type so the visibility
          // decisions follow the type the user has chosen, not the initial type.
          const currentType = (modal.querySelector('[' + CONSTANTS.LIVE_SYNC_ATTR + '="type"]')
            || { value: initial.type }).value || initial.type;
          const liveTypeConfig = (typeof core.getEntityTypeConfig === "function")
            ? core.getEntityTypeConfig(projectInner, currentType)
            : typeConfig;
          // SM-119: the description is a contentEditable div now (was a textarea),
          // so match by the sync-key attribute, not the tag.
          const descNode = host.querySelector('[' + CONSTANTS.LIVE_SYNC_ATTR + '="description"]');
          const descRow  = descNode ? descNode.closest(".tm-row") : null;
          const anchor   = descRow ? descRow.nextSibling : null;
          // Anchor everything below the description, preserving append order:
          // Prereqs (if shown) → Steps (if shown) → AC (if shown).
          function appendBelowDesc(node) {
            if (anchor) host.insertBefore(node, anchor);
            else        host.appendChild(node);
          }
          if (liveTypeConfig.showPrerequisites) {
            const prereqRefs = { markDirty: () => { prereqsDirty = true; if (inplace) inplace.markDirty(); } };
            // In create-mode we start with an empty list; in edit-mode use the
            // ticket's existing prerequisites. The user fills the list in by
            // adding rows ("+ Add Prerequisite").
            const seedTicket = isCreate ? { prerequisites: [] } : initial;
            appendBelowDesc(buildPrerequisitesSection(seedTicket, prereqRefs));
          }
          if (liveTypeConfig.showSteps) {
            const stepRefs = { markDirty: () => { stepsDirty = true; if (inplace) inplace.markDirty(); } };
            const seedTicket = isCreate ? { steps: [] } : initial;
            appendBelowDesc(buildStepsSection(seedTicket, stepRefs));
          }
          // SM-57: Execution-step + Outcome sections for type='test-execution'.
          // In create-mode they're not rendered — the dedicated starter dialog
          // (openTestExecutionStarter) clones the steps + sets refDef, so this
          // modal only sees the finished execution.
          if (!isCreate && liveTypeConfig.showExecutionSteps) {
            const execRefs = { markDirty: () => { if (inplace) inplace.markDirty(); } };
            appendBelowDesc(buildExecutionStepsSection(initial, execRefs));
          }
          if (!isCreate && liveTypeConfig.showTestOutcome) {
            const outcomeRefs = { markDirty: () => { if (inplace) inplace.markDirty(); } };
            appendBelowDesc(buildOutcomeSection(initial, outcomeRefs));
          }
          if (liveTypeConfig.showAcceptanceCriteria) {
            const acRefs = { markDirty: () => { acDirty = true; if (inplace) inplace.markDirty(); } };
            appendBelowDesc(buildAcceptanceCriteriaSection(initial, acRefs));
          }
          if (reseed) { prereqsDirty = false; stepsDirty = false; acDirty = false; }
        }
        renderTypeDrivenSections({ reseed: true });

        // DoR + DoD: vollwertiger per-Ticket-Editor (E19-followup) —
        //  EDIT mode → vorhandene frozen Items werden ediertbar gerendert;
        //   Save persistiert via store.updateTicket({ definitionOfReady, ... }).
        //  CREATE mode → Items werden aus `resolveDefinitions(projectInner.defs,
        //   type)` vorgeseedet, der User kann sie editieren bevor er auf
        //   Create klickt. Beim Type-Wechsel im Modal wird nur die Section
        //   reseeded, wenn der User noch nichts daran geändert hat (Flag
        //   `dorDirty`/`dodDirty`).
        let dorDirty = false, dodDirty = false;
        function renderDorDodSections(opts) {
          const reseed = !!(opts && opts.reseed);
          // Remove any prior sections (re-render on type change or first mount).
          host.querySelectorAll('section.tm-checklist').forEach(n => n.remove());
          // Re-resolve typeConfig from the CURRENT form type.
          const currentType = (modal.querySelector('[' + CONSTANTS.LIVE_SYNC_ATTR + '="type"]') || { value: initial.type }).value || initial.type;
          const liveTypeConfig = (typeof core.getEntityTypeConfig === "function")
            ? core.getEntityTypeConfig(projectInner, currentType)
            : typeConfig;
          let dorItems, dodItems;
          if (isCreate) {
            const resolved = (typeof core.resolveDefinitions === "function")
              ? core.resolveDefinitions(projectInner.definitions, currentType)
              : { ready: [], done: [] };
            dorItems = resolved.ready.map(it => Object.assign({}, it, { checked: false }));
            dodItems = resolved.done.map(it => Object.assign({}, it, { checked: false }));
          } else {
            dorItems = (initial.definitionOfReady || { items: [] }).items;
            dodItems = (initial.definitionOfDone  || { items: [] }).items;
          }
          const dorRefs = { markDirty: () => { dorDirty = true; if (inplace) inplace.markDirty(); } };
          const dodRefs = { markDirty: () => { dodDirty = true; if (inplace) inplace.markDirty(); } };
          if (liveTypeConfig.showDefinitionOfReady) {
            host.insertBefore(buildChecklistSection("Definition of Ready", dorItems, "definitionOfReady", dorRefs), labelsRow);
          }
          if (liveTypeConfig.showDefinitionOfDone) {
            host.insertBefore(buildChecklistSection("Definition of Done", dodItems, "definitionOfDone", dodRefs), labelsRow);
          }
          if (reseed) { dorDirty = false; dodDirty = false; }
        }

        // SM-238: rebuild the Status control on a type change so it swaps between
        // the editable <select> (work items) and the read-only derived pill +
        // breakdown (epics). Preserves the currently displayed status value.
        function renderStatusField() {
          const statusEl = modal.querySelector('[' + CONSTANTS.LIVE_SYNC_ATTR + '="status"]');
          const row = statusEl && statusEl.closest ? statusEl.closest(".tm-row") : null;
          if (!row || !row.parentNode) return;
          const currentType = (modal.querySelector('[' + CONSTANTS.LIVE_SYNC_ATTR + '="type"]') || { value: initial.type }).value || initial.type;
          const shownStatus = (statusEl.value != null && statusEl.tagName === "SELECT")
            ? statusEl.value : (statusEl.textContent || initial.status);
          const freshTicket = Object.assign({}, initial, { type: currentType, status: shownStatus });
          const snap = (ctx.store && typeof ctx.store.get === "function") ? ctx.store.get() : snapshot;
          row.parentNode.replaceChild(buildStatusField(freshTicket, statuses, snap), row);
        }

        const labelsRow = buildLabelsField(initial);
        host.appendChild(labelsRow);
        renderDorDodSections({ reseed: true });

        // SM-48: Links-Section. Append last (after DoR/DoD + Labels).
        // In Create-mode the ticket has no id yet, so backward-links are
        // empty and the + Add link button is hidden — the section still
        // renders for visual parity.
        if (typeConfig.showLinks !== false) {
          host.appendChild(buildLinksSection(initial, snapshot, Object.assign({}, ctx, { uiShell: ctx.uiShell })));
        }

        // SM-185: Attachments — ticket-scoped only, edit-mode only (needs a
        // ticket id), and only when the HTTP adapter is active (attachments are
        // a REST feature; no server → no attachments). No project-level UI.
        if (!isCreate && ticketId && ctx.attachmentsEnabled) {
          host.appendChild(buildAttachmentsSection(ticketId, ctx));
        }

        // Type-Wechsel in Create-Mode reseedet die Items aus dem neuen
        // Type — aber NUR wenn der User die jeweilige Liste noch nicht
        // angefasst hat (sonst würde sein Edit verloren gehen).
        if (isCreate) {
          const typeEl = modal.querySelector('[' + CONSTANTS.LIVE_SYNC_ATTR + '="type"]');
          if (typeEl) typeEl.addEventListener("change", () => {
            renderStatusField();   // SM-238: swap select ↔ derived pill
            // Re-render the type-driven sections (Prereqs, Steps, AC) — but
            // preserve any user edits via the dirty flags. Currently we only
            // skip the full re-render when a section is dirty AND visibility
            // hasn't changed; for simplicity, if any of them is dirty, leave
            // the existing sections as-is.
            if (!prereqsDirty && !stepsDirty && !acDirty) {
              renderTypeDrivenSections({ reseed: true });
            }
            if (!dorDirty && !dodDirty) {
              renderDorDodSections({ reseed: true });
            }
          });
        }

        // Live-sync + in-place persistence: only in EDIT mode (Create collects
        // on the Create button — no ticket-id to commit against yet).
        if (!isCreate) {
          // SM-120/B5b: wire in-place commit on the body host. Discrete controls
          // commit on change, text fields on blur, sections via the refs above;
          // status routes through the gate and a 422 lands in the error banner.
          inplace = installInPlaceCommit(host, {
            store: ctx.store, ticketId: ticketId, actor: LOCAL_ACTOR,
            flashStatus: ctx.flashStatus,
            onStatusError: (msg) => {
              const b = host.querySelector('[' + CONSTANTS.LIVE_SYNC_ATTR + '="_error_banner"]');
              if (!b) return;
              if (msg) { b.style.display = "block"; b.textContent = msg; }
              else { b.style.display = "none"; b.textContent = ""; }
            }
          });
          // SM-238: edit-mode type change (e.g. story → epic) swaps the status
          // control and re-gates DoR/DoD. Fires on the type select directly,
          // BEFORE the host-delegated in-place commit, reading the new type from
          // the select value (the commit then persists it via store.updateTicket).
          const editTypeEl = modal.querySelector('[' + CONSTANTS.LIVE_SYNC_ATTR + '="type"]');
          if (editTypeEl) editTypeEl.addEventListener("change", () => {
            renderStatusField();
            renderDorDodSections();
          });
          // SM-5: prevTicket snapshot lets us diff sync-keyed fields per
          // commit and pulse exactly the ones the upstream changed. Only
          // pulses when reason === "applyRemote" (external edit); a local
          // commit gives the user direct feedback through their own typing.
          let prevTicket = readTicket();
          const unsubscribe = ctx.store.subscribe((snap, reason) => {
            const fresh = readTicket();
            if (!fresh) return;
            syncFieldFromTicket(modal, fresh, ctx.store.get());
            if (reason === "applyRemote") pulseChangedFields(modal, prevTicket, fresh);
            prevTicket = fresh;
          });
          observeRemoval(modal, () => { unsubscribe(); if (inplace) inplace.detach(); });
        }
      }
    });

    return handle;
  }

  /**
   * Watch for the modal's removal from DOM. When it disappears, fire onGone
   * (used for unsubscribing without intercepting every close-path).
   */
  function observeRemoval(modalEl, onGone) {
    if (typeof MutationObserver === "undefined") return;
    const host = modalEl.parentNode && modalEl.parentNode.parentNode;   // modal-host > overlay > modal
    if (!host) return;
    const mo = new MutationObserver(() => {
      if (!host.contains(modalEl)) {
        mo.disconnect();
        try { onGone(); } catch (_) { /* ignore */ }
      }
    });
    mo.observe(host, { childList: true, subtree: true });
  }

  // SM-120/B5b: the edit-mode Save path (editOnSave/hasNonStatusChanges/
  // putTicket/postStatus) is gone — every field commits in place via
  // installInPlaceCommit. Only the create-mode collect-on-Create remains.

  /** Create action — POSTs a new ticket with the form's fields. */
  async function createOnSave(ctx, modal, draftInitial, opts) {
    const banner = modal.querySelector('[' + CONSTANTS.LIVE_SYNC_ATTR + '="_error_banner"]');
    try {
      const form = collectFormState(modal);
      if (!form.title || !form.title.trim()) {
        if (banner) {
          banner.style.display = "block";
          banner.textContent = "Title is required.";
        }
        return false;
      }
      const effectiveType = form.type || draftInitial.type;
      // SM-70: Pending links live on draftInitial.links (mutated by the
      // inline add-form). Required-target gate for test-definition is
      // enforced HERE at create-time so the user gets immediate feedback
      // (and never lands a half-broken ticket that can't be mark_ready'd).
      const pendingLinks = Array.isArray(draftInitial.links) ? draftInitial.links : [];
      if (effectiveType === "test-definition") {
        const hasTarget = pendingLinks.some(l => l.linkTypeId === "tests");
        if (!hasTarget) {
          if (banner) {
            banner.style.display = "block";
            banner.textContent = "A test-definition must link to at least one ticket it tests. Add a 'tests' link in the Links section before saving.";
          }
          return false;
        }
      }
      const body = {
        type:        effectiveType,
        title:       form.title,
        description: form.description || "",
        position: {
          releaseId:     form.position.releaseId     || draftInitial.position.releaseId || null,
          processStepId: form.position.processStepId || draftInitial.position.processStepId || null,
          epicId:        form.position.epicId        || draftInitial.position.epicId || null,
          sortOrder:     draftInitial.position.sortOrder || 0
        },
        acceptanceCriteria: form.acceptanceCriteria || [],
        labels:             form.labels || []
      };
      // SM-70: forward the pending links to the server (strip the synthetic
      // pending id; the server normalises and assigns a real one).
      if (pendingLinks.length) {
        body.links = pendingLinks.map(l => ({
          linkTypeId:     l.linkTypeId,
          targetTicketId: l.targetTicketId,
          createdBy:      LOCAL_ACTOR
        }));
      }
      // E19-followup: per-Ticket Items aus dem Editor an Create durchreichen.
      // Wenn die Section gar nicht gerendert war (Gate off), bleibt der Server
      // beim Default-Freeze (oder leeren Items).
      if (form.definitionOfReady && Array.isArray(form.definitionOfReady.items)) {
        body.definitionOfReady = form.definitionOfReady;
      }
      if (form.definitionOfDone && Array.isArray(form.definitionOfDone.items)) {
        body.definitionOfDone = form.definitionOfDone;
      }
      // SM-54: pass test-definition fields through to create. `null` means
      // the section wasn't rendered (type isn't test-definition or gate off)
      // → server leaves the field at its empty default.
      if (Array.isArray(form.prerequisites)) body.prerequisites = form.prerequisites;
      if (Array.isArray(form.steps))         body.steps         = form.steps;
      await postCreateTicket(ctx, body);
      if (ctx.flashStatus) ctx.flashStatus("ticket created", { kind: "ok" });
      if (typeof opts.onCreated === "function") opts.onCreated();
    } catch (err) {
      console.error("[ticket-modal] create failed:", err);
      if (banner) {
        banner.style.display = "block";
        banner.textContent = err.message || "create failed";
      }
      return false;
    }
  }

  // E18.D: alle Persistenz-Shims kollabieren zu einem reinen Store-Mutate.
  // Der Save-Subscriber in main.js debounced den Snapshot-PUT an den Adapter.
  // Der Status-Wechsel läuft über `changeStatusGated`, das die DoR/DoD-Gates
  // VOR dem Commit prüft (snapshot-PUT validiert nicht — by design).
  // (LOCAL_ACTOR is declared near the top of the factory body so the
  //  SM-48 Links-section helpers — which run BEFORE the Persistenz-Shims —
  //  can reference it too.)

  async function postCreateTicket(ctx, body) {
    ctx.store.createTicket(body, LOCAL_ACTOR);
  }

  /**
   * Show a type-picker modal first; on selection, opens the full ticket
   * modal in CREATE mode with the chosen type. Same modal shape for every
   * type — the type-config layer governs which sections are shown.
   *
   * @param {object} ctx — same as openTicketModal
   * @param {object} draftCtx — { releaseId?, processStepId?, epicId? } — position context
   * @param {object} [opts] — { onCreated }
   */
  function openTypePickerThenCreate(ctx, draftCtx, opts) {
    opts = opts || {};
    const showModal = (ctx.uiShell && ctx.uiShell.showModal)
      || (typeof window !== "undefined" && window.STORYMAP && window.STORYMAP.uiShell && window.STORYMAP.uiShell.showModal);
    if (typeof showModal !== "function") throw new Error("openTypePickerThenCreate: showModal missing on uiShell");
    const project = ctx.store.get().project || {};
    // SM-196: the "+ Add Item" picker excludes only the SPEC types
    // (requirement/spec-module — authored through the requirements flow). Epics
    // ARE offerable here: they're the story-map containers, created from a cell/
    // release/backlog like any other card. (Bug fix: isBoardWorkItem also
    // excludes epic, which wrongly hid it from the picker.)
    const types = ((project.ticketTypes && project.ticketTypes.length)
      ? project.ticketTypes : core.DEFAULT_TICKET_TYPES)
      .filter(t => t === "epic" || core.isBoardWorkItem(t));

    showModal({
      title: "New ticket — pick type",
      bodyHTML: '<div class="tm-type-picker"></div>',
      actions: [
        { label: "Cancel", onClick: () => {} }
      ],
      onMount: (modal, close) => {
        const host = modal.querySelector(".tm-type-picker");
        for (const type of types) {
          const btn = el("button", { class: "tm-type-pick-btn", type: "button" });
          btn.appendChild(el("span", { class: "tm-type-pick-name", text: type }));
          btn.addEventListener("click", () => {
            close();
            // Defer to next tick so the picker DOM teardown is complete
            // before showModal swaps in the create-modal (single modal-host).
            Promise.resolve().then(() => {
              // SM-71: test-execution gets a specialised starter dialog —
              // step-cloning + the executes-link are wired via
              // core.ops.startTestExecution, so the generic detail-modal
              // create flow doesn't apply.
              if (type === "test-execution") {
                openTestExecutionStarter(ctx, draftCtx, opts);
                return;
              }
              openTicketModal(ctx, null, {
                // The PICKED type must win — draftCtx may carry a default type
                // (e.g. the epic "+" passes type:"user-story") that must not
                // override the user's explicit choice in the picker.
                draft: Object.assign({}, draftCtx || {}, { type: type }),
                onCreated: opts.onCreated
              });
            });
          });
          host.appendChild(btn);
        }
      }
    });
  }

  /**
   * SM-71: Dedicated starter dialog for test-execution. Required field is
   * the test-definition to clone steps from. Optional: env tag. On Start
   * the store-op `startTestExecution` runs — that handles step-cloning,
   * the executes-link, and ticket-counter bump. After save the new
   * execution ticket is opened in the detail modal so the user can
   * immediately record per-step actuals.
   */
  function openTestExecutionStarter(ctx, draftCtx, opts) {
    opts = opts || {};
    const showModal = (ctx.uiShell && ctx.uiShell.showModal)
      || (typeof window !== "undefined" && window.STORYMAP && window.STORYMAP.uiShell && window.STORYMAP.uiShell.showModal);
    if (typeof showModal !== "function") throw new Error("openTestExecutionStarter: showModal missing on uiShell");

    const snap = ctx.store.get();
    const allDefs = (snap.tickets || []).filter(t => !t.isDeleted && t.type === "test-definition");

    let selectedDefId = allDefs.length ? allDefs[0].id : null;

    const startAction = {
      label: "Start", primary: true,
      onClick: async (modal) => {
        const banner = modal.querySelector(".tm-test-exec-banner");
        if (!selectedDefId) {
          if (banner) {
            banner.style.display = "block";
            banner.textContent = "Pick a test-definition before starting.";
          }
          return false;
        }
        const envInput = modal.querySelector(".tm-test-exec-env");
        const env = envInput ? (envInput.value || "").trim() : "";
        try {
          ctx.store.startTestExecution(selectedDefId, { env: env || undefined }, LOCAL_ACTOR);
          if (ctx.flashStatus) ctx.flashStatus("test-execution started", { kind: "ok" });
          // Re-read snapshot to find the just-pushed execution ticket
          // (highest-keyed test-execution referencing the chosen definition).
          const after = ctx.store.get();
          const newExec = (after.tickets || []).slice().reverse()
            .find(t => t.type === "test-execution" && t.referencedTestDefinitionId === selectedDefId);
          if (newExec) {
            Promise.resolve().then(() => openTicketModal(ctx, newExec.id, {
              onDelete: opts.onDelete
            }));
          }
          if (typeof opts.onCreated === "function") opts.onCreated();
        } catch (err) {
          if (banner) {
            banner.style.display = "block";
            banner.textContent = err.message || "start failed";
          }
          return false;
        }
      }
    };

    showModal({
      title: "Start test execution",
      bodyHTML: '<div class="tm-test-exec-host"></div>',
      actions: [
        { label: "Cancel", onClick: () => {} },
        startAction
      ],
      onMount: (modal, close) => {
        const host = modal.querySelector(".tm-test-exec-host");
        const banner = el("div", { class: "tm-test-exec-banner", style: { display: "none" } });
        host.appendChild(banner);

        if (!allDefs.length) {
          const empty = el("div", { class: "tm-test-exec-empty",
            text: "No test-definitions exist in this project yet. Create one first, then come back here to record a run." });
          host.appendChild(empty);
          // Disable Start by blanking selectedDefId; the action handler bails.
          selectedDefId = null;
          return;
        }

        // Definition picker.
        const defRow = el("div", { class: "tm-row" });
        defRow.appendChild(el("label", { class: "tm-label", text: "Test-Definition" }));
        const defSel = el("select", { class: "tm-test-exec-def-select" });
        for (const def of allDefs) {
          const optEl = el("option", { value: def.id,
            text: (def.ticketKey || def.id) + " — " + (def.title || "") });
          defSel.appendChild(optEl);
        }
        defSel.value = selectedDefId;
        defSel.addEventListener("change", () => { selectedDefId = defSel.value; });
        defRow.appendChild(defSel);
        host.appendChild(defRow);

        // Optional env field.
        const envRow = el("div", { class: "tm-row" });
        envRow.appendChild(el("label", { class: "tm-label", text: "Environment (optional)" }));
        const envInput = el("input", { type: "text", class: "tm-test-exec-env",
          placeholder: "e.g. staging, prod, local-chrome" });
        envRow.appendChild(envInput);
        host.appendChild(envRow);
      }
    });
  }

  return {
    CONSTANTS,
    openTicketModal,
    openTypePickerThenCreate,
    openTestExecutionStarter,
    // exposed for testing — shared builders/state come from ticket-form,
    // createOnSave stays here (host-only). SM-278: maybeCancelAction so the
    // epic-confirm "return false" contract is pinned.
    _internals: Object.assign({}, ticketForm, { createOnSave, maybeCancelAction })
  };
}));
