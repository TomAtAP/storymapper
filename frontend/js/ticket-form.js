/**
 * ticket-form.js — Geteilte Ticket-Formular-Builder + State-Helfer.
 *
 * SM-116 (Epic B / B1): aus renderer-ticket-modal.js extrahiert, damit der
 * Vollseiten-Editor (B2+) UND das Detail-Modal DIESELBEN Builder benutzen.
 * Reine DOM-Bauer + State-Diff-Helfer — KEINE Modal-Annahmen, kein showModal.
 * UMD-gewickelt: factory(core, dnd). In Node direkt require()-bar, im Browser
 * als window.STORYMAP.ticketForm.
 *
 * Hinweis: buildTestExecutionHeader oeffnet beim Pill-Klick das referenzierte
 * Test-Definition-Ticket ueber ctx.openTicketModal (vom Host injiziert) bzw.
 * window.STORYMAP.rendererTicketModal.openTicketModal als Browser-Fallback.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./core.js"), require("./dnd.js"));
  else (root.STORYMAP = root.STORYMAP || {}).ticketForm = factory(
    root.STORYMAP && root.STORYMAP.core,
    root.STORYMAP && root.STORYMAP.dnd
  );
}(typeof self !== "undefined" ? self : this, function (core, dnd) {
  "use strict";

  if (!core) throw new Error("ticket-form: core module missing");
  if (!dnd)  throw new Error("ticket-form: dnd module missing");

  const DRAG_TYPE_AC = "tm-ac-row";
  const DRAG_TYPE_CHECK = "tm-check-row";   // E19-followup: DoR/DoD rows are drag-sortable
  // SM-54: test-definition sections — Prerequisites + Steps. Distinct drag-types so
  // a prereq row can't be dropped into the steps table and vice versa.
  const DRAG_TYPE_PREREQ    = "tm-prereq-row";
  const DRAG_TYPE_TEST_STEP = "tm-test-step-row";

  // E18.D: lokale Mutationen identifizieren sich als "Local"; Save-Subscriber
  // in main.js persistiert debounced an den HTTP-Adapter.
  const LOCAL_ACTOR = { type: "human", id: "local", name: "Local" };

  // ---- Konstanten (keine Magic Numbers) -------------------------------
  const CONSTANTS = {
    FIELD_DEBOUNCE_MS:        500,   // unbenutzt vorerst (Save ist explizit), reserviert
    TITLE_MAX_LENGTH:         300,
    DESCRIPTION_MAX_LENGTH:   50000,
    LIVE_SYNC_ATTR:           "data-sm-sync-key",  // markiert Felder, die Live-Sync update darf
    FIELD_PULSE_MS:           900,                  // SM-5: Modal-Field-Pulse bei externer Änderung
    FIELD_PULSE_CLASS:        "sm-card-flash"      // reuse Card-Animate keyframe (SM-20 made it generic)
  };

  // ---- DOM-Helper -----------------------------------------------------
  function el(tag, props, children) {
    const e = document.createElement(tag);
    if (props) {
      for (const k of Object.keys(props)) {
        if (k === "class") e.className = props[k];
        else if (k === "dataset") for (const d of Object.keys(props[k])) e.dataset[d] = props[k][d];
        else if (k === "style") Object.assign(e.style, props[k]);
        else if (k === "text") e.textContent = props[k];
        else if (k === "html") e.innerHTML = props[k];
        else if (k.startsWith("on") && typeof props[k] === "function") e.addEventListener(k.slice(2).toLowerCase(), props[k]);
        else e.setAttribute(k, props[k]);
      }
    }
    if (children) for (const c of children) if (c != null) e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    return e;
  }

  // SM-119 (Epic B / B4-lite): the Description is a plain-text contentEditable
  // block (grows with content, no scrollbar) instead of a fixed-height
  // textarea. These helpers let the value read/write paths treat a
  // contentEditable div and a form control (input/select/textarea) uniformly.
  function isEditableNode(node) {
    return !!(node && node.getAttribute && node.getAttribute("contenteditable") === "true");
  }
  // Read the field's text. For a contentEditable we prefer innerText (it
  // renders block/<br> structure back to "\n" line breaks in real browsers);
  // jsdom has no innerText, so we fall back to textContent there.
  function readFieldText(node) {
    if (!node) return "";
    if (isEditableNode(node)) {
      return (typeof node.innerText === "string") ? node.innerText : (node.textContent || "");
    }
    return node.value || "";
  }
  // Write the field's text. For a contentEditable we set textContent (a flat
  // text node); with `white-space: pre-wrap` newlines render correctly and
  // round-trip via readFieldText.
  function writeFieldText(node, text) {
    if (!node) return;
    if (isEditableNode(node)) node.textContent = text;
    else node.value = text;
  }

  // ---- Builders pro Feldgruppe (pure DOM-Bauer) ------------------------

  function buildRow(labelText, controlEl, syncKey) {
    if (syncKey && controlEl) controlEl.setAttribute(CONSTANTS.LIVE_SYNC_ATTR, syncKey);
    const lbl = el("label", { class: "tm-label", text: labelText });
    const row = el("div", { class: "tm-row" }, [lbl, controlEl]);
    return row;
  }

  function buildErrorBanner() {
    const banner = el("div", { class: "tm-error-banner", style: { display: "none" } });
    banner.setAttribute(CONSTANTS.LIVE_SYNC_ATTR, "_error_banner");
    return banner;
  }

  // SM-158: opts.multiline renders the title as an auto-growing textarea so a
  // long title WRAPS across the full width instead of being clipped by a
  // single-line input (the full-page editor uses this for its title hero). The
  // modal keeps the compact single-line input. Both expose `.value` + the
  // "title" sync-key, so collectFormState / syncFieldFromTicket are unchanged.
  function buildTitleField(ticket, opts) {
    opts = opts || {};
    if (opts.multiline) {
      const ta = el("textarea", {
        class: "tm-input tm-title-input",
        rows: "1",
        maxlength: CONSTANTS.TITLE_MAX_LENGTH
      });
      ta.value = ticket.title || "";
      ta.addEventListener("input", function () { autoGrowTextarea(ta); });
      setTimeout(function () { autoGrowTextarea(ta); }, 0);
      return buildRow("Title", ta, "title");
    }
    const input = el("input", {
      type: "text",
      class: "tm-input",
      value: ticket.title || "",
      maxlength: CONSTANTS.TITLE_MAX_LENGTH
    });
    return buildRow("Title", input, "title");
  }

  function buildTypeField(ticket, ticketTypes) {
    const select = el("select", { class: "tm-input" });
    for (const t of ticketTypes) {
      const opt = el("option", { value: t, text: t });
      if (t === ticket.type) opt.setAttribute("selected", "selected");
      select.appendChild(opt);
    }
    return buildRow("Type", select, "type");
  }

  // SM-238: human-readable derivation breakdown for an epic's rolled-up status.
  function epicStatusBreakdownText(stats) {
    const n = stats.total;
    const noun = n === 1 ? "story" : "stories";
    return "derived from " + n + " " + noun + " — " + stats.done + " done, "
      + stats.doing + " in progress, " + stats.todo + " to do";
  }

  function buildStatusField(ticket, statuses, snapshot) {
    // SM-238: an epic's status is DERIVED (roll-up) — show a read-only pill +
    // the derivation breakdown instead of an editable dropdown. The pill carries
    // the "status" sync-key so syncFieldFromTicket can repaint it live. No status
    // patch is ever emitted for an epic: buildUpdatePatch has no status branch
    // and the in-place commit strips status — so the empty read-back is harmless.
    if (ticket.type === "epic") {
      const stats = core.epicChildStats(snapshot || { tickets: [] }, ticket.id);
      const pill = el("span", { class: "tm-status-derived", text: ticket.status });
      pill.setAttribute(CONSTANTS.LIVE_SYNC_ATTR, "status");
      pill.dataset.status = ticket.status;
      const breakdown = el("div", { class: "tm-status-breakdown", text: epicStatusBreakdownText(stats) });
      breakdown.setAttribute(CONSTANTS.LIVE_SYNC_ATTR, "status_breakdown");
      const wrap = el("div", { class: "tm-status-derived-wrap" }, [pill, breakdown]);
      return buildRow("Status", wrap, null);
    }
    const select = el("select", { class: "tm-input tm-status" });
    for (const s of statuses) {
      const opt = el("option", { value: s, text: s });
      if (s === ticket.status) opt.setAttribute("selected", "selected");
      select.appendChild(opt);
    }
    return buildRow("Status", select, "status");
  }

  function buildPositionFields(ticket, snapshot, typeConfig) {
    typeConfig = typeConfig || {};
    const releases = (snapshot.releases || []).filter(r => !r.isDeleted);
    const processSteps = (snapshot.processSteps || []).filter(p => !p.isDeleted);
    const epics = (snapshot.tickets || []).filter(t => t.type === "epic" && !t.isDeleted && t.id !== ticket.id);

    function dropdown(name, items, currentId, withNone) {
      const select = el("select", { class: "tm-input" });
      if (withNone) {
        const noneOpt = el("option", { value: "", text: "— none —" });
        if (!currentId) noneOpt.setAttribute("selected", "selected");
        select.appendChild(noneOpt);
      }
      for (const it of items) {
        const opt = el("option", { value: it.id, text: it.name || it.title || it.id });
        if (it.id === currentId) opt.setAttribute("selected", "selected");
        select.appendChild(opt);
      }
      return select;
    }

    const pos = ticket.position || {};
    // SM-77-followup: the container-epic lives in a `contains`-link from
    // the epic (SM-52 canonical). `ticket.position.epicId` is always null
    // after the SM-52 migration — reading it here used to silently break
    // the Epic-dropdown and erased the container on every no-op save.
    // SM-244 BUGFIX: a CREATE-mode draft has no id yet (so containerEpicIdOf
    // can't find a link), but it CAN carry an intended parent in
    // position.epicId (e.g. the epic card's "+" button). Fall back to it so the
    // Epic dropdown is pre-selected and the contains-link is actually created.
    // For existing tickets pos.epicId is always null, so this is a no-op there.
    const containerEpicId = ((typeof core.containerEpicIdOf === "function")
      ? core.containerEpicIdOf(snapshot, ticket.id) : null) || (pos.epicId || null);

    // SM-67: when this ticket is contained by an epic, its release+
    // processStep are inherited from the epic. The Release + ProcessStep
    // dropdowns become read-only (disabled) with the epic's values pre-
    // selected, and a hint shows which epic dictates them. Changing the
    // Epic dropdown live-updates the disabled values; clearing it
    // (— none —) re-enables them so the story can be detached + relocated.
    const epicById = new Map(epics.map(e => [e.id, e]));
    const initialContainer = (ticket.type !== "epic" && containerEpicId)
      ? epicById.get(containerEpicId) : null;

    const relSelect = dropdown("releaseId", releases,
      initialContainer ? (initialContainer.position && initialContainer.position.releaseId) || "" : pos.releaseId,
      true);
    const psSelect = dropdown("processStepId", processSteps,
      initialContainer ? (initialContainer.position && initialContainer.position.processStepId) || "" : pos.processStepId,
      true);
    const epicSelect = (typeConfig.allowParentEpic !== false)
      ? dropdown("epicId", epics, containerEpicId, true) : null;

    function hintText(epic) {
      return epic ? ("Inherited from " + (epic.ticketKey || epic.title || epic.id)) : "";
    }

    function applyInheritance(epic) {
      if (epic && epic.position) {
        relSelect.value = epic.position.releaseId || "";
        psSelect.value = epic.position.processStepId || "";
        relSelect.disabled = true;
        psSelect.disabled = true;
      } else {
        relSelect.disabled = false;
        psSelect.disabled = false;
      }
      if (relHint) relHint.textContent = hintText(epic);
      if (psHint)  psHint.textContent  = hintText(epic);
    }

    let relHint = null;
    let psHint = null;
    const rows = [];
    if (typeConfig.showRelease !== false) {
      rows.push(buildRow("Release", relSelect, "position.releaseId"));
      relHint = el("div", { class: "tm-field-hint", text: hintText(initialContainer) });
      rows.push(relHint);
    }
    if (typeConfig.showProcessStep !== false) {
      rows.push(buildRow("Process Step", psSelect, "position.processStepId"));
      psHint = el("div", { class: "tm-field-hint", text: hintText(initialContainer) });
      rows.push(psHint);
    }
    if (epicSelect) {
      rows.push(buildRow("Epic", epicSelect, "position.epicId"));
      epicSelect.addEventListener("change", () => {
        const v = epicSelect.value || "";
        applyInheritance(v ? epicById.get(v) : null);
      });
    }
    // Apply the initial inherited state if applicable.
    if (initialContainer) applyInheritance(initialContainer);
    return rows;
  }

  // SM-119: plain-text contentEditable description. Grows with content (no
  // fixed height, no inner scrollbar) and stays a PLAIN string — paste is
  // forced to text/plain so no HTML/styling creeps in, and the value is read
  // back via readFieldText (innerText → "\n", textContent fallback). Shared
  // builder → the modal AND the full-page editor get this automatically.
  //
  // SM-157: when `opts.onCommit(text)` is wired (edit-mode, the ticket exists),
  // a Jira-style ✓/✗ pair APPEARS as soon as the text differs from the saved
  // value, so free-text edits are committed deliberately and never silently
  // lost. ✓ (or focus-out / Cmd+Enter) commits; ✗ (or Esc) reverts. Without
  // onCommit (create-mode / pure render) the field is a plain draft input.
  function buildDescriptionField(ticket, opts) {
    opts = opts || {};
    const ed = el("div", {
      class: "tm-input tm-description-edit",
      contenteditable: "true",
      role: "textbox",
      "aria-multiline": "true",
      spellcheck: "true",
      dataset: { placeholder: "Description…" }
    });
    ed.textContent = ticket.description || "";
    // Force plain-text paste so the contentEditable never accumulates markup.
    ed.addEventListener("paste", function (ev) {
      const cd = ev.clipboardData || (typeof window !== "undefined" && window.clipboardData);
      if (!cd) return;
      ev.preventDefault();
      const text = (cd.getData && (cd.getData("text/plain") || cd.getData("text"))) || "";
      const sel = (typeof window !== "undefined" && window.getSelection) ? window.getSelection() : null;
      if (sel && sel.rangeCount) {
        const range = sel.getRangeAt(0);
        range.deleteContents();
        const node = document.createTextNode(text);
        range.insertNode(node);
        range.setStartAfter(node); range.setEndAfter(node);
        sel.removeAllRanges(); sel.addRange(range);
      } else {
        ed.appendChild(document.createTextNode(text));
      }
    });
    const row = buildRow("Description", ed, "description");

    if (typeof opts.onCommit === "function") {
      let baseline = ticket.description || "";
      let reverting = false;
      const actions = el("div", { class: "tm-desc-actions", style: { display: "none" } });
      const saveBtn   = el("button", { class: "tm-desc-save",   type: "button", title: "Save (⌘/Ctrl+Enter)", text: "✓" });
      const cancelBtn = el("button", { class: "tm-desc-cancel", type: "button", title: "Discard (Esc)",       text: "✕" });
      actions.appendChild(saveBtn);
      actions.appendChild(cancelBtn);
      row.appendChild(actions);

      function isDirty() { return readFieldText(ed) !== baseline; }
      function refresh() { actions.style.display = isDirty() ? "" : "none"; }
      function commit() {
        const text = readFieldText(ed);
        if (text !== baseline) { baseline = text; opts.onCommit(text); }
        refresh();
      }
      function revert() { reverting = true; writeFieldText(ed, baseline); refresh(); reverting = false; }

      ed.addEventListener("input", refresh);
      // Buttons use mousedown+preventDefault so clicking them does NOT blur the
      // editable (which would otherwise fire the blur-commit first).
      saveBtn.addEventListener("mousedown",  function (e) { e.preventDefault(); });
      saveBtn.addEventListener("click",      function () { commit(); });
      cancelBtn.addEventListener("mousedown", function (e) { e.preventDefault(); });
      cancelBtn.addEventListener("click",     function () { revert(); });
      // Focus-out commits (the "focus change saves" behaviour the user expects),
      // unless we're mid-revert.
      ed.addEventListener("blur", function () { if (!reverting) commit(); });
      ed.addEventListener("keydown", function (e) {
        if (e.key === "Escape") { e.preventDefault(); revert(); if (ed.blur) ed.blur(); }
        else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commit(); }
      });
      // Live-sync hook: when an external commit rewrites the field (see
      // syncFieldFromTicket), reset the baseline so ✓/✗ don't show spuriously
      // and a later blur doesn't re-commit a stale value.
      ed.__tfSetBaseline = function (v) { baseline = v || ""; refresh(); };
    }
    return row;
  }

  /**
   * E19-followup: DoR/DoD-Section ist ein vollwertiger per-Ticket-Editor
   * (analog Acceptance Criteria). Pro Row: ⋮⋮-Grip · checked-Checkbox ·
   * Label-Input · `required`-Toggle · Delete-Button. `+ Add Item` am Ende.
   * Drag-sortierbar via dnd.js.
   *
   * collectFormState liest beim Save die Reihenfolge und alle Felder direkt
   * aus dem DOM und persistiert sie als `definitionOfReady`/`definitionOfDone`
   * via Store-Op. Kein inline-Persist mehr — Save-Subscriber kümmert sich.
   */
  function buildChecklistSection(title, items, syncKey, refs) {
    const wrap = el("section", { class: "tm-checklist" });
    wrap.setAttribute(CONSTANTS.LIVE_SYNC_ATTR, syncKey);
    wrap.appendChild(el("h4", { class: "tm-section-title", text: title }));
    const list = el("div", { class: "tm-checklist-list" });
    for (const item of (items || [])) {
      list.appendChild(buildCheckRow(item, refs));
    }
    wrap.appendChild(list);
    const addBtn = el("button", {
      class: "tm-checklist-add",
      type: "button",
      html: '<span class="sm-add-icon">+</span><span class="sm-add-label">Item</span>'
    });
    addBtn.addEventListener("click", () => {
      const fresh = { id: "ci-" + Math.random().toString(36).slice(2, 10), label: "", required: true, checked: false };
      const row = buildCheckRow(fresh, refs);
      list.appendChild(row);
      const labelInput = row.querySelector(".tm-checkitem-text-input");
      if (labelInput) labelInput.focus();
      if (refs && refs.markDirty) refs.markDirty();
    });
    wrap.appendChild(addBtn);
    return wrap;
  }

  function buildCheckRow(item, refs) {
    const row = el("div", { class: "tm-checkitem-row" });
    row.dataset.itemId = item.id;
    const grip = el("span", { class: "tm-checkitem-grip", title: "Drag to reorder", text: "⋮⋮" });
    const checked = el("input", { type: "checkbox", class: "tm-checkitem-checked" });
    if (item.checked) checked.setAttribute("checked", "checked");
    const labelInput = el("input", { type: "text", class: "tm-input tm-checkitem-text-input", value: item.label || "", placeholder: "Item label" });
    const requiredLabel = el("label", { class: "tm-checkitem-required-wrap", title: "Required to pass the gate" });
    const requiredInput = el("input", { type: "checkbox", class: "tm-checkitem-required" });
    if (item.required !== false) requiredInput.setAttribute("checked", "checked");
    requiredLabel.appendChild(requiredInput);
    requiredLabel.appendChild(el("span", { class: "tm-checkitem-required-hint", text: "required" }));
    const remove = el("button", { class: "tm-checkitem-remove", type: "button", title: "Remove item", text: "×" });
    remove.addEventListener("click", () => { row.remove(); if (refs && refs.markDirty) refs.markDirty(); });
    [checked, labelInput, requiredInput].forEach(el => {
      el.addEventListener("change", () => { if (refs && refs.markDirty) refs.markDirty(); });
    });
    labelInput.addEventListener("input", () => { if (refs && refs.markDirty) refs.markDirty(); });
    row.appendChild(grip);
    row.appendChild(checked);
    row.appendChild(labelInput);
    row.appendChild(requiredLabel);
    row.appendChild(remove);

    if (dnd && typeof dnd.enableDraggable === "function") {
      dnd.enableDraggable(row, { dragType: DRAG_TYPE_CHECK, dragId: item.id });
      dnd.enableDropTarget(row, {
        accepts: [DRAG_TYPE_CHECK],
        onEnter: (e) => e.classList.add("tm-checkitem-drop-target"),
        onLeave: (e) => e.classList.remove("tm-checkitem-drop-target"),
        onDrop: ({ id, event }) => {
          row.classList.remove("tm-checkitem-drop-target");
          const list = row.parentNode;
          if (!list) return;
          const dragged = list.querySelector('.tm-checkitem-row[data-item-id="' + cssEscape(id) + '"]');
          if (!dragged || dragged === row) return;
          const rect = row.getBoundingClientRect();
          const before = (event && typeof event.clientY === "number")
            ? event.clientY < rect.top + rect.height / 2 : true;
          if (before) list.insertBefore(dragged, row);
          else        list.insertBefore(dragged, row.nextSibling);
          if (refs && refs.markDirty) refs.markDirty();
        }
      });
    }
    return row;
  }

  function buildAcceptanceCriteriaSection(ticket, refs) {
    const wrap = el("section", { class: "tm-ac-section" });
    wrap.setAttribute(CONSTANTS.LIVE_SYNC_ATTR, "acceptanceCriteria");
    wrap.appendChild(el("h4", { class: "tm-section-title", text: "Acceptance Criteria" }));
    const list = el("div", { class: "tm-ac-list" });
    for (const ac of (ticket.acceptanceCriteria || [])) {
      list.appendChild(buildAcRow(ac, refs));
    }
    wrap.appendChild(list);
    const addBtn = el("button", {
      class: "tm-ac-add",
      type: "button",
      html: '<span class="sm-add-icon">+</span><span class="sm-add-label">Criterion</span>'
    });
    addBtn.addEventListener("click", () => {
      const newAc = { id: "ac-" + Math.random().toString(36).slice(2, 10), text: "", completed: false };
      list.appendChild(buildAcRow(newAc, refs));
      refs.markDirty();
    });
    wrap.appendChild(addBtn);
    return wrap;
  }

  function buildAcRow(ac, refs) {
    const row = el("div", { class: "tm-ac-row" });
    // Grip-handle als visueller Drag-Indikator. Drag-Mechanik: pointerdown
    // auf irgendeinem Teil der Row startet einen Drag (Inputs/Buttons sind
    // durch dnd.js per `closest("button,input,...")`-Guard ausgenommen, sodass
    // Tippen + Checkbox-Click + Remove weiter funktionieren). Der Grip selbst
    // existiert nur als visueller Hinweis und non-input-Aufsetzpunkt.
    const grip  = el("span", { class: "tm-ac-grip", text: "⋮⋮", title: "Drag to reorder" });
    const check = el("input", { type: "checkbox" });
    if (ac.completed) check.setAttribute("checked", "checked");
    const text = el("input", { type: "text", class: "tm-input tm-ac-text", value: ac.text || "" });
    const remove = el("button", { class: "tm-ac-remove", type: "button", title: "Remove", text: "×" });
    check.addEventListener("change", refs.markDirty);
    text.addEventListener("input",  refs.markDirty);
    remove.addEventListener("click", () => { row.remove(); refs.markDirty(); });
    row.dataset.acId = ac.id;
    row.appendChild(grip);
    row.appendChild(check);
    row.appendChild(text);
    row.appendChild(remove);

    // Drag-Reorder: Row ist Drag-Source UND Drop-Target. onDrop bewegt die
    // gezogene Row vor die Target-Row (oder ans Listenende, wenn Cursor im
    // unteren Halb der Target-Row ist). collectFormState liest die neue
    // Reihenfolge dann direkt aus dem DOM beim Save.
    dnd.enableDraggable(row, { dragType: DRAG_TYPE_AC, dragId: ac.id });
    dnd.enableDropTarget(row, {
      accepts: [DRAG_TYPE_AC],
      onEnter: (el) => el.classList.add("tm-ac-drop-target"),
      onLeave: (el) => el.classList.remove("tm-ac-drop-target"),
      onDrop: ({ id, event }) => {
        row.classList.remove("tm-ac-drop-target");
        const list = row.parentNode;
        if (!list) return;
        const dragged = list.querySelector('.tm-ac-row[data-ac-id="' + cssEscape(id) + '"]');
        if (!dragged || dragged === row) return;
        const rect = row.getBoundingClientRect();
        const before = (event && typeof event.clientY === "number")
          ? event.clientY < rect.top + rect.height / 2
          : true;
        if (before) list.insertBefore(dragged, row);
        else        list.insertBefore(dragged, row.nextSibling);
        refs.markDirty();
      }
    });
    return row;
  }

  function cssEscape(s) {
    // Minimal CSS-attribute-selector escaper. dragged.dataset.acId is our id;
    // we use it in [data-ac-id="..."]. Escape backslashes + double-quotes.
    return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  // ---- SM-54: Prerequisites section (test-definition type) ------------
  //
  // Analog der DoR/DoD-Editor-Section: pro Row Grip + checked-Checkbox +
  // Label-Input + required-Toggle + Delete-Button. "+ Add Prerequisite" am
  // Ende. Drag-sortable via dnd.js mit eigenem drag-type. Empty-Label-Rows
  // werden beim Collect verworfen (siehe collectPrerequisites).
  function buildPrerequisitesSection(ticket, refs) {
    const wrap = el("section", { class: "tm-prereqs" });
    wrap.setAttribute(CONSTANTS.LIVE_SYNC_ATTR, "prerequisites");
    wrap.appendChild(el("h4", { class: "tm-section-title", text: "Prerequisites" }));
    const list = el("div", { class: "tm-prereq-list" });
    for (const p of (ticket.prerequisites || [])) {
      list.appendChild(buildPrereqRow(p, refs));
    }
    wrap.appendChild(list);
    const addBtn = el("button", {
      class: "tm-prereq-add",
      type: "button",
      html: '<span class="sm-add-icon">+</span><span class="sm-add-label">Prerequisite</span>'
    });
    addBtn.addEventListener("click", () => {
      const fresh = { id: "tpre-" + Math.random().toString(36).slice(2, 10),
                      label: "", required: true, checked: false };
      const row = buildPrereqRow(fresh, refs);
      list.appendChild(row);
      const labelInput = row.querySelector(".tm-prereq-text-input");
      if (labelInput) labelInput.focus();
      if (refs && refs.markDirty) refs.markDirty();
    });
    wrap.appendChild(addBtn);
    return wrap;
  }

  function buildPrereqRow(item, refs) {
    const row = el("div", { class: "tm-prereq-row" });
    row.dataset.itemId = item.id;
    const grip = el("span", { class: "tm-prereq-grip", title: "Drag to reorder", text: "⋮⋮" });
    const checked = el("input", { type: "checkbox", class: "tm-prereq-checked" });
    if (item.checked) checked.setAttribute("checked", "checked");
    const labelInput = el("input", {
      type: "text", class: "tm-input tm-prereq-text-input",
      value: item.label || "", placeholder: "Prerequisite label"
    });
    const requiredLabel = el("label", { class: "tm-prereq-required-wrap", title: "Required" });
    const requiredInput = el("input", { type: "checkbox", class: "tm-prereq-required" });
    if (item.required !== false) requiredInput.setAttribute("checked", "checked");
    requiredLabel.appendChild(requiredInput);
    requiredLabel.appendChild(el("span", { class: "tm-prereq-required-hint", text: "required" }));
    const remove = el("button", {
      class: "tm-prereq-remove", type: "button", title: "Remove prerequisite", text: "×"
    });
    remove.addEventListener("click", () => {
      row.remove();
      if (refs && refs.markDirty) refs.markDirty();
    });
    [checked, requiredInput].forEach(input => {
      input.addEventListener("change", () => { if (refs && refs.markDirty) refs.markDirty(); });
    });
    labelInput.addEventListener("input", () => { if (refs && refs.markDirty) refs.markDirty(); });

    row.appendChild(grip);
    row.appendChild(checked);
    row.appendChild(labelInput);
    row.appendChild(requiredLabel);
    row.appendChild(remove);

    if (dnd && typeof dnd.enableDraggable === "function") {
      dnd.enableDraggable(row, { dragType: DRAG_TYPE_PREREQ, dragId: item.id });
      dnd.enableDropTarget(row, {
        accepts: [DRAG_TYPE_PREREQ],
        onEnter: (e) => e.classList.add("tm-prereq-drop-target"),
        onLeave: (e) => e.classList.remove("tm-prereq-drop-target"),
        onDrop: ({ id, event }) => {
          row.classList.remove("tm-prereq-drop-target");
          const list = row.parentNode;
          if (!list) return;
          const dragged = list.querySelector('.tm-prereq-row[data-item-id="' + cssEscape(id) + '"]');
          if (!dragged || dragged === row) return;
          const rect = row.getBoundingClientRect();
          const before = (event && typeof event.clientY === "number")
            ? event.clientY < rect.top + rect.height / 2 : true;
          if (before) list.insertBefore(dragged, row);
          else        list.insertBefore(dragged, row.nextSibling);
          if (refs && refs.markDirty) refs.markDirty();
        }
      });
    }
    return row;
  }

  // ---- SM-54: Steps section (test-definition type) -------------------
  //
  // Tabelle mit Header (Step / Data / Expected Result) und einer Row pro
  // Step. Pro Row: ⋮⋮-Grip + drei Text-Inputs + Delete-Button. "+ Add Step"
  // am Ende. Drag-sortable via dnd.js mit eigenem drag-type. Empty-Rows
  // (alle drei Felder leer) werden beim Collect verworfen.
  function buildStepsSection(ticket, refs) {
    const wrap = el("section", { class: "tm-test-steps" });
    wrap.setAttribute(CONSTANTS.LIVE_SYNC_ATTR, "steps");
    wrap.appendChild(el("h4", { class: "tm-section-title", text: "Steps" }));
    // SM-54-followup: header grid mirrors the row grid exactly so labels
    // sit above their columns. Empty cells fill grip + insert + delete
    // positions; explicit grid-column avoids "STEP", "DATA",
    // "EXPECTED RESULT" all landing in the first three columns.
    const tableHead = el("div", { class: "tm-test-step-head" }, [
      el("span", { class: "tm-test-step-head-cell tm-test-step-head-grip" }),
      el("span", { class: "tm-test-step-head-cell tm-test-step-head-step",     text: "Step" }),
      el("span", { class: "tm-test-step-head-cell tm-test-step-head-data",     text: "Data" }),
      el("span", { class: "tm-test-step-head-cell tm-test-step-head-expected", text: "Expected Result" }),
      el("span", { class: "tm-test-step-head-cell tm-test-step-head-insert" }),
      el("span", { class: "tm-test-step-head-cell tm-test-step-head-remove" })
    ]);
    wrap.appendChild(tableHead);
    const list = el("div", { class: "tm-test-step-list" });
    for (const s of (ticket.steps || [])) {
      list.appendChild(buildTestStepRow(s, refs, list));
    }
    wrap.appendChild(list);
    const addBtn = el("button", {
      class: "tm-test-step-add",
      type: "button",
      html: '<span class="sm-add-icon">+</span><span class="sm-add-label">Step</span>'
    });
    addBtn.addEventListener("click", () => {
      const fresh = { id: "tstep-" + Math.random().toString(36).slice(2, 10),
                      step: "", data: "", expectedResult: "" };
      const row = buildTestStepRow(fresh, refs, list);
      list.appendChild(row);
      const stepArea = row.querySelector(".tm-test-step-step");
      if (stepArea) stepArea.focus();
      if (refs && refs.markDirty) refs.markDirty();
    });
    wrap.appendChild(addBtn);
    return wrap;
  }

  // Auto-grow a textarea to fit content. We cap at MAX_TEST_STEP_TA_HEIGHT_PX
  // so a giant paste doesn't blow up the modal — past that, the textarea
  // scrolls internally.
  const MAX_TEST_STEP_TA_HEIGHT_PX = 240;
  function autoGrowTextarea(ta) {
    ta.style.height = "auto";
    ta.style.height = Math.min(MAX_TEST_STEP_TA_HEIGHT_PX, Math.max(ta.scrollHeight, 32)) + "px";
  }

  function buildTestStepRow(item, refs, listRef) {
    const row = el("div", { class: "tm-test-step-row" });
    row.dataset.itemId = item.id;
    const grip = el("span", { class: "tm-test-step-grip", title: "Drag to reorder", text: "⋮⋮" });
    // SM-54-followup: multi-line textareas — test steps often need a
    // paragraph or two, not a one-liner. Auto-grow on input, capped.
    const stepArea = el("textarea", {
      class: "tm-input tm-test-step-step", rows: "2", placeholder: "Action"
    });
    stepArea.value = item.step || "";
    const dataArea = el("textarea", {
      class: "tm-input tm-test-step-data", rows: "2", placeholder: "Data"
    });
    dataArea.value = item.data || "";
    const expectedArea = el("textarea", {
      class: "tm-input tm-test-step-expected", rows: "2", placeholder: "Expected result"
    });
    expectedArea.value = item.expectedResult || "";
    // SM-54-followup: insert-step-above button so the user can splice a
    // new step between two existing ones (not only append at the bottom).
    const insertAbove = el("button", {
      class: "tm-test-step-insert", type: "button",
      title: "Insert step above this one", text: "↑+"
    });
    insertAbove.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const fresh = { id: "tstep-" + Math.random().toString(36).slice(2, 10),
                      step: "", data: "", expectedResult: "" };
      const newRow = buildTestStepRow(fresh, refs, listRef);
      const list = listRef || row.parentNode;
      if (list) list.insertBefore(newRow, row);
      const ta = newRow.querySelector(".tm-test-step-step");
      if (ta) ta.focus();
      if (refs && refs.markDirty) refs.markDirty();
    });
    const remove = el("button", {
      class: "tm-test-step-remove", type: "button", title: "Remove step", text: "×"
    });
    remove.addEventListener("click", () => {
      row.remove();
      if (refs && refs.markDirty) refs.markDirty();
    });
    [stepArea, dataArea, expectedArea].forEach(ta => {
      ta.addEventListener("input", () => {
        autoGrowTextarea(ta);
        if (refs && refs.markDirty) refs.markDirty();
      });
      // Initial size after mount — defer so the element is in the DOM and
      // scrollHeight reflects the actual content.
      setTimeout(() => autoGrowTextarea(ta), 0);
    });

    row.appendChild(grip);
    row.appendChild(stepArea);
    row.appendChild(dataArea);
    row.appendChild(expectedArea);
    row.appendChild(insertAbove);
    row.appendChild(remove);

    if (dnd && typeof dnd.enableDraggable === "function") {
      dnd.enableDraggable(row, { dragType: DRAG_TYPE_TEST_STEP, dragId: item.id });
      dnd.enableDropTarget(row, {
        accepts: [DRAG_TYPE_TEST_STEP],
        onEnter: (e) => e.classList.add("tm-test-step-drop-target"),
        onLeave: (e) => e.classList.remove("tm-test-step-drop-target"),
        onDrop: ({ id, event }) => {
          row.classList.remove("tm-test-step-drop-target");
          const list = row.parentNode;
          if (!list) return;
          const dragged = list.querySelector('.tm-test-step-row[data-item-id="' + cssEscape(id) + '"]');
          if (!dragged || dragged === row) return;
          const rect = row.getBoundingClientRect();
          const before = (event && typeof event.clientY === "number")
            ? event.clientY < rect.top + rect.height / 2 : true;
          if (before) list.insertBefore(dragged, row);
          else        list.insertBefore(dragged, row.nextSibling);
          if (refs && refs.markDirty) refs.markDirty();
        }
      });
    }
    return row;
  }

  function buildLabelsField(ticket) {
    const input = el("input", {
      type: "text",
      class: "tm-input",
      value: (ticket.labels || []).join(", "),
      placeholder: "comma-separated"
    });
    return buildRow("Labels", input, "labels");
  }

  // ---- SM-57: Test-Execution sections --------------------------------
  //
  // For type='test-execution' the modal renders three extra blocks:
  //   1. A "executes → DEF-KEY: Title" pill at the very top of the body
  //      (clickable, opens the definition's modal).
  //   2. A metadata strip (runAt / runBy / env) — read-only after creation.
  //   3. A 6-column execution-steps table. step/data/expectedResult are
  //      frozen from the definition (rendered disabled). actualResult,
  //      status, note are editable and persist via store.updateTicket
  //      executionSteps.
  //   4. An outcome section: derived display + manual-override picker.
  //
  // Add/remove buttons and drag-sort are deliberately absent — the step
  // list is a snapshot of the definition and may not grow or shrink.

  /**
   * Find the test-definition this execution references. Returns null if
   * the link is missing or the target has been deleted.
   */
  function resolveTestDefinition(execTicket, snapshot) {
    if (!execTicket || !execTicket.referencedTestDefinitionId) return null;
    const tickets = (snapshot && snapshot.tickets) || [];
    const def = tickets.find(t => t.id === execTicket.referencedTestDefinitionId);
    if (!def || def.isDeleted) return null;
    return def;
  }

  /**
   * Header pill: "executes → DEF-KEY: Title". Click opens the definition's
   * modal (best-effort — if the definition was deleted between renders the
   * click is a no-op). Returns null when the link is unresolved so the
   * caller skips appending an empty pill.
   */
  function buildTestExecutionHeader(ticket, snapshot, ctx) {
    const def = resolveTestDefinition(ticket, snapshot);
    const wrap = el("section", { class: "tm-exec-header" });
    wrap.setAttribute(CONSTANTS.LIVE_SYNC_ATTR, "referencedTestDefinitionId");
    if (!def) {
      wrap.appendChild(el("span", {
        class: "tm-exec-header-missing",
        text: "executes → (definition unavailable)"
      }));
      return wrap;
    }
    const pill = el("button", {
      class: "tm-exec-header-pill",
      type: "button",
      title: "Open the test-definition this run executes"
    });
    pill.appendChild(el("span", { class: "tm-exec-header-arrow", text: "executes →" }));
    pill.appendChild(el("span", { class: "tm-exec-header-key",   text: def.ticketKey || def.id }));
    pill.appendChild(el("span", { class: "tm-exec-header-title", text: ": " + (def.title || "") }));
    pill.addEventListener("click", (ev) => {
      ev.stopPropagation();
      // SM-116: this builder lives in the shared ticket-form module now, so it
      // cannot see the modal's openTicketModal directly. The host injects it via
      // ctx (Object.assign({}, ctx, { openTicketModal })); a window fallback keeps
      // the browser working even when ctx was not augmented.
      const opener = ctx && (ctx.openTicketModal
        || (typeof window !== "undefined" && window.STORYMAP
            && window.STORYMAP.rendererTicketModal
            && window.STORYMAP.rendererTicketModal.openTicketModal));
      if (typeof opener === "function") opener(ctx, def.id, {});
    });
    wrap.appendChild(pill);
    return wrap;
  }

  /**
   * Read-only metadata strip: runAt (formatted), runBy (actor name),
   * env (string or "—"). Pure presentation; the values come from the
   * starter dialog and aren't editable here.
   */
  function buildExecutionMetadata(ticket) {
    function fmtTime(ms) {
      if (typeof ms !== "number") return "—";
      try {
        const d = new Date(ms);
        // Format: 2026-05-27 10:23 (ISO-ish, no timezone since we use local)
        const pad = (n) => String(n).padStart(2, "0");
        return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate())
             + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
      } catch (_) { return "—"; }
    }
    const wrap = el("section", { class: "tm-exec-meta" });
    wrap.setAttribute(CONSTANTS.LIVE_SYNC_ATTR, "executionMetadata");
    function entry(label, value) {
      const cell = el("div", { class: "tm-exec-meta-cell" });
      cell.appendChild(el("span", { class: "tm-exec-meta-label", text: label }));
      cell.appendChild(el("span", { class: "tm-exec-meta-value", text: value }));
      return cell;
    }
    wrap.appendChild(entry("Run at", fmtTime(ticket.runAt)));
    const runBy = ticket.runBy && ticket.runBy.name ? ticket.runBy.name : "—";
    wrap.appendChild(entry("Run by", runBy));
    wrap.appendChild(entry("Env",    ticket.env || "—"));
    return wrap;
  }

  /**
   * 6-column step table. Header row + data rows. step/data/expectedResult
   * are RENDERED but disabled — they're the frozen contract from the
   * definition. actualResult + status + note are inline-editable and feed
   * collectExecutionSteps via [data-sm-sync-key=executionSteps].
   */
  function buildExecutionStepsSection(ticket, refs) {
    const wrap = el("section", { class: "tm-exec-steps" });
    wrap.setAttribute(CONSTANTS.LIVE_SYNC_ATTR, "executionSteps");
    wrap.appendChild(el("h4", { class: "tm-section-title", text: "Execution Steps" }));
    const head = el("div", { class: "tm-exec-step-head" }, [
      el("span", { class: "tm-exec-step-head-cell tm-exec-step-head-step",     text: "Step" }),
      el("span", { class: "tm-exec-step-head-cell tm-exec-step-head-data",     text: "Data" }),
      el("span", { class: "tm-exec-step-head-cell tm-exec-step-head-expected", text: "Expected" }),
      el("span", { class: "tm-exec-step-head-cell tm-exec-step-head-actual",   text: "Actual" }),
      el("span", { class: "tm-exec-step-head-cell tm-exec-step-head-status",   text: "Status" }),
      el("span", { class: "tm-exec-step-head-cell tm-exec-step-head-note",     text: "Note" })
    ]);
    wrap.appendChild(head);
    const list = el("div", { class: "tm-exec-step-list" });
    for (const s of (ticket.executionSteps || [])) {
      list.appendChild(buildExecutionStepRow(s, refs));
    }
    wrap.appendChild(list);
    return wrap;
  }

  function buildExecutionStepRow(item, refs) {
    const row = el("div", { class: "tm-exec-step-row" });
    row.dataset.itemId = item.id;
    // Read-only columns — disabled textareas so a user can still copy text.
    function ro(extraClass, value) {
      const ta = el("textarea", { class: "tm-input tm-exec-step-ro " + extraClass, rows: "2", disabled: "disabled" });
      ta.value = value || "";
      return ta;
    }
    const stepArea     = ro("tm-exec-step-step",     item.step);
    const dataArea     = ro("tm-exec-step-data",     item.data);
    const expectedArea = ro("tm-exec-step-expected", item.expectedResult);
    const actualArea = el("textarea", {
      class: "tm-input tm-exec-step-actual",
      rows: "2",
      placeholder: "Observed result"
    });
    actualArea.value = item.actualResult || "";
    const statusSel = el("select", { class: "tm-input tm-exec-step-status" });
    const STATUSES = core.TEST_EXEC_STEP_STATUSES
      || ["pending", "passed", "failed", "blocked", "skipped"];
    for (const s of STATUSES) {
      const opt = el("option", { value: s, text: s });
      if (s === (item.status || "pending")) opt.setAttribute("selected", "selected");
      statusSel.appendChild(opt);
    }
    statusSel.dataset.status = item.status || "pending";
    // Color the picker via a status-pill data attribute (CSS handles colors).
    function reflectStatusColor() { statusSel.dataset.status = statusSel.value; }
    statusSel.addEventListener("change", reflectStatusColor);
    const noteArea = el("textarea", {
      class: "tm-input tm-exec-step-note",
      rows: "2",
      placeholder: "Note"
    });
    noteArea.value = item.note || "";
    [actualArea, statusSel, noteArea].forEach(node => {
      node.addEventListener("change", () => { if (refs && refs.markDirty) refs.markDirty(); });
      node.addEventListener("input",  () => { if (refs && refs.markDirty) refs.markDirty(); });
    });

    row.appendChild(stepArea);
    row.appendChild(dataArea);
    row.appendChild(expectedArea);
    row.appendChild(actualArea);
    row.appendChild(statusSel);
    row.appendChild(noteArea);
    return row;
  }

  /**
   * Outcome section: shows derived outcome + count + manual-override
   * picker. Override values: "auto" (= use derived) + the five outcome
   * enum values. When the user picks anything other than auto, the
   * "manual override" hint becomes visible.
   */
  function buildOutcomeSection(ticket, refs) {
    const wrap = el("section", { class: "tm-exec-outcome" });
    wrap.setAttribute(CONSTANTS.LIVE_SYNC_ATTR, "outcomeOverride");
    wrap.appendChild(el("h4", { class: "tm-section-title", text: "Outcome" }));

    const derivedRow = el("div", { class: "tm-exec-outcome-derived" });
    const steps = ticket.executionSteps || [];
    const derived = (typeof core.deriveOutcome === "function")
      ? core.deriveOutcome(steps) : "pending";
    const passedCount = steps.filter(s => s && s.status === "passed").length;
    derivedRow.appendChild(el("span", { class: "tm-exec-outcome-derived-label", text: "Derived:" }));
    const derivedPill = el("span", {
      class: "tm-exec-outcome-pill",
      text: derived + " (" + passedCount + "/" + steps.length + " passed)"
    });
    derivedPill.dataset.outcome = derived;
    derivedRow.appendChild(derivedPill);
    wrap.appendChild(derivedRow);

    const overrideRow = el("div", { class: "tm-exec-outcome-override-row" });
    overrideRow.appendChild(el("span", { class: "tm-exec-outcome-derived-label", text: "Override:" }));
    const sel = el("select", { class: "tm-input tm-exec-outcome-override" });
    const cur = ticket.outcomeOverride || "auto";
    const OPTIONS = ["auto"].concat(core.TEST_EXEC_OUTCOMES
      || ["pending", "passed", "failed", "blocked", "skipped"]);
    for (const v of OPTIONS) {
      const opt = el("option", { value: v, text: v });
      if (v === cur) opt.setAttribute("selected", "selected");
      sel.appendChild(opt);
    }
    overrideRow.appendChild(sel);
    const hint = el("span", { class: "tm-exec-outcome-override-hint", text: "manual override" });
    if (cur === "auto") hint.style.display = "none";
    overrideRow.appendChild(hint);
    sel.addEventListener("change", () => {
      hint.style.display = sel.value === "auto" ? "none" : "";
      if (refs && refs.markDirty) refs.markDirty();
    });
    wrap.appendChild(overrideRow);
    return wrap;
  }

  // ---- SM-48: Links-Section ------------------------------------------
  //
  // Two-pane editor at the bottom of the modal:
  //   Forward links — outgoing from this ticket. Editable (× removes, +
  //     opens add-link dialog).
  //   Backward links — incoming from any ticket whose links[] references
  //     this ticket. Read-only — flip them at the source ticket instead.
  //
  // Each row shows: link-type pill (color from project.linkTypes.color),
  //   inverse/forward label, target ticket-key + title. Click on the
  //   ticket-key portion opens that ticket's modal (best effort — if the
  //   target was just deleted the click is a no-op).
  //
  // Live-sync: `data-sm-sync-key=links` marks the host so the syncField
  //   pulse helpers + the existing observer rebuild it on external commits.

  /**
   * Resolve a linkType id to its catalogue entry. Returns a synthetic
   * fallback for unknown ids so the UI keeps rendering (linkType deleted
   * after the link was created — see SM-47 confirm).
   */
  function lookupLinkType(project, linkTypeId) {
    const list = (project && project.linkTypes) || [];
    const hit = list.find(lt => lt.id === linkTypeId);
    if (hit) return hit;
    return { id: linkTypeId, label: linkTypeId, inverseLabel: linkTypeId, semantic: "freeform" };
  }

  /**
   * Find tickets that link TO `targetTicketId` — backward edges.
   * Pure: returns `[ { sourceTicket, link } ]`. Excludes the target itself
   * defensively (a ticket should never link to itself, but core.validateLink
   * already enforces that).
   */
  function findBackwardLinks(snapshot, targetTicketId) {
    const out = [];
    const tickets = (snapshot && snapshot.tickets) || [];
    for (const t of tickets) {
      if (!t.links || !t.links.length || t.id === targetTicketId) continue;
      for (const l of t.links) {
        if (l.targetTicketId === targetTicketId) out.push({ sourceTicket: t, link: l });
      }
    }
    return out;
  }

  function buildLinkPill(linkType, kind) {
    const text = kind === "backward" ? (linkType.inverseLabel || linkType.label) : linkType.label;
    const pill = el("span", { class: "tm-link-pill tm-link-pill-" + kind, text: text });
    if (linkType.color) pill.style.backgroundColor = linkType.color;
    return pill;
  }

  function buildTargetRef(targetTicket) {
    const span = el("span", { class: "tm-link-target" });
    if (!targetTicket) {
      span.appendChild(el("span", { class: "tm-link-key tm-link-missing", text: "(deleted)" }));
      return span;
    }
    span.appendChild(el("span", { class: "tm-link-key", text: targetTicket.ticketKey || targetTicket.id }));
    span.appendChild(el("span", { class: "tm-link-title", text: " " + (targetTicket.title || "") }));
    return span;
  }

  function buildLinksSection(ticket, snapshot, ctx) {
    const wrap = el("section", { class: "tm-links" });
    wrap.setAttribute(CONSTANTS.LIVE_SYNC_ATTR, "links");
    // Stash ctx on the wrap so live-sync rebuilds re-wire +/× handlers.
    wrap.__tmCtx = ctx || null;
    renderLinksSectionInto(wrap, ticket, snapshot, ctx);
    return wrap;
  }

  function renderLinksSectionInto(wrap, ticket, snapshot, ctx) {
    while (wrap.firstChild) wrap.removeChild(wrap.firstChild);
    const project  = (snapshot && snapshot.project)  || {};
    const tickets  = (snapshot && snapshot.tickets) || [];
    const findTicket = (id) => tickets.find(t => t.id === id) || null;

    // SM-70: In create-mode (ticket.id == null) the inline add-form pushes
    // links onto ticket.links directly (no store), so createOnSave can pass
    // them as `body.links`. Re-render is triggered via this closure.
    const isPending = !ticket.id;
    const rerender  = () => renderLinksSectionInto(wrap, ticket, snapshot, ctx);

    wrap.appendChild(el("h4", { class: "tm-section-title", text: "Links" }));

    // Forward.
    const fwdHost = el("div", { class: "tm-links-list tm-links-forward" });
    const forwardLinks = (ticket.links || []);
    if (!forwardLinks.length) {
      fwdHost.appendChild(el("div", { class: "tm-links-empty", text: "No outgoing links." }));
    } else {
      for (const link of forwardLinks) {
        const lt = lookupLinkType(project, link.linkTypeId);
        const tgt = findTicket(link.targetTicketId);
        const row = el("div", { class: "tm-link-row", dataset: { linkId: link.id } });
        row.appendChild(buildLinkPill(lt, "forward"));
        row.appendChild(buildTargetRef(tgt));
        const del = el("button", { class: "tm-link-delete", title: "Remove link", text: "×" });
        del.addEventListener("click", (ev) => {
          ev.stopPropagation();
          if (isPending) {
            // Mutate the in-memory draft and re-render.
            ticket.links = (ticket.links || []).filter(l => l.id !== link.id);
            rerender();
            return;
          }
          if (!ctx || !ctx.store || !ticket.id) return;
          try {
            ctx.store.removeLink(ticket.id, link.id, LOCAL_ACTOR);
          } catch (err) {
            if (ctx.flashStatus) ctx.flashStatus(err.message || "remove failed", { kind: "error" });
          }
        });
        row.appendChild(del);
        fwdHost.appendChild(row);
      }
    }
    wrap.appendChild(fwdHost);

    // Inline add-form. Edit-mode → store.addLink. Create-mode → push onto
    // ticket.links (pending) and call rerender() so the new row shows up.
    wrap.appendChild(buildInlineAddLinkForm(ticket.id, snapshot, ctx, {
      pendingTicket: isPending ? ticket : null,
      onPendingChange: rerender
    }));

    // Backward.
    const bwdHost = el("div", { class: "tm-links-list tm-links-backward" });
    bwdHost.appendChild(el("h5", { class: "tm-links-subhead", text: "Referenced by" }));
    const backward = ticket.id ? findBackwardLinks(snapshot, ticket.id) : [];
    if (!backward.length) {
      bwdHost.appendChild(el("div", { class: "tm-links-empty", text: "Nothing references this ticket." }));
    } else {
      for (const { sourceTicket, link } of backward) {
        const lt = lookupLinkType(project, link.linkTypeId);
        const row = el("div", { class: "tm-link-row tm-link-row-readonly" });
        row.appendChild(buildLinkPill(lt, "backward"));
        row.appendChild(buildTargetRef(sourceTicket));
        bwdHost.appendChild(row);
      }
    }
    wrap.appendChild(bwdHost);
  }

  /**
   * Inline Add-Link form: lives at the bottom of the Links section in the
   * ticket-detail modal. Replaces the earlier popup-modal flow — the user
   * must never lose the ticket they're editing.
   *
   * Collapsed state: a "+ Add link" button.
   * Expanded state: Type-Select + searchable Target-Combobox (filter input +
   *   popover list) + Add-button + Cancel-button. Submit calls store.addLink
   *   and re-collapses the form so the user sees the new row in the list
   *   above (live-sync rebuild handles that).
   */
  function buildInlineAddLinkForm(sourceTicketId, snapshot, ctx, pendingOpts) {
    const wrap = el("div", { class: "tm-link-add-wrap" });
    const trigger = el("button", { class: "btn tm-link-add", text: "+ Add link", type: "button" });
    const form = el("div", { class: "tm-link-add-form", style: { display: "none" } });
    wrap.appendChild(trigger);
    wrap.appendChild(form);

    // SM-70: pending-mode. When sourceTicketId is null (Create), the form
    // mutates pendingOpts.pendingTicket.links and re-renders the section.
    const pendingTicket = pendingOpts && pendingOpts.pendingTicket;
    const onPendingChange = (pendingOpts && pendingOpts.onPendingChange) || (() => {});

    const project = (snapshot && snapshot.project) || {};
    const allTickets = (snapshot && snapshot.tickets || []).filter(t => !t.isDeleted && t.id !== sourceTicketId);
    const linkTypes = (project.linkTypes && project.linkTypes.length) ? project.linkTypes : [];

    // Track the selected target via a closure variable — the combobox keeps
    // the display string ("T-2 — Story-B") in the input but the underlying
    // id is what we send to addLink.
    let selectedTargetId = null;

    // SM-70: pre-select the link-type that matches the source ticket's
    // semantic role. test-definition → 'tests'; test-execution → 'executes'.
    // Falls back to the first defined linkType.
    const sourceTicket = pendingTicket
      || (sourceTicketId ? allTickets.find(t => t.id === sourceTicketId) ||
          (snapshot && snapshot.tickets || []).find(t => t.id === sourceTicketId) : null);
    const sourceType = (sourceTicket && sourceTicket.type) || null;
    const preferredLinkTypeId =
      sourceType === "test-definition" && linkTypes.some(lt => lt.id === "tests")    ? "tests"
      : sourceType === "test-execution" && linkTypes.some(lt => lt.id === "executes") ? "executes"
      : (linkTypes[0] && linkTypes[0].id);

    // Type row.
    const typeRow = el("div", { class: "tm-link-add-row" });
    typeRow.appendChild(el("label", { class: "tm-label", text: "Type" }));
    const typeSel = el("select", { class: "tm-add-link-type" });
    for (const lt of linkTypes) {
      typeSel.appendChild(el("option", { value: lt.id, text: lt.label }));
    }
    if (preferredLinkTypeId) typeSel.value = preferredLinkTypeId;
    typeRow.appendChild(typeSel);
    form.appendChild(typeRow);

    // Target combobox row: input + popover list of matches.
    const tgtRow = el("div", { class: "tm-link-add-row" });
    tgtRow.appendChild(el("label", { class: "tm-label", text: "Target" }));
    const comboWrap = el("div", { class: "tm-link-combo" });
    const filterInput = el("input", { type: "text", class: "tm-add-link-filter",
      placeholder: "Ticket key or title…", autocomplete: "off" });
    const popover = el("div", { class: "tm-link-combo-popover", style: { display: "none" } });
    comboWrap.appendChild(filterInput);
    comboWrap.appendChild(popover);
    tgtRow.appendChild(comboWrap);
    form.appendChild(tgtRow);

    function refillPopover(term) {
      popover.innerHTML = "";
      const q = (term || "").trim().toLowerCase();
      let matched = 0;
      for (const t of allTickets) {
        const display = (t.ticketKey || t.id) + " — " + (t.title || "");
        if (q && display.toLowerCase().indexOf(q) < 0) continue;
        const opt = el("div", { class: "tm-link-combo-option", dataset: { ticketId: t.id }, text: display });
        opt.addEventListener("mousedown", (ev) => {
          // mousedown (not click) so it fires before input.blur hides the popover.
          ev.preventDefault();
          selectedTargetId = t.id;
          filterInput.value = display;
          popover.style.display = "none";
        });
        popover.appendChild(opt);
        matched++;
        if (matched >= 30) break;   // cap rendered list — keep popover usable
      }
      popover.style.display = matched > 0 ? "block" : "none";
    }
    filterInput.addEventListener("focus", () => refillPopover(filterInput.value));
    filterInput.addEventListener("input", () => {
      selectedTargetId = null;   // typing invalidates the prior selection
      refillPopover(filterInput.value);
    });
    filterInput.addEventListener("blur", () => {
      // Defer-hide so the option's mousedown can fire first.
      setTimeout(() => { popover.style.display = "none"; }, 80);
    });

    // Action buttons (inline, not separate modal).
    const actions = el("div", { class: "tm-link-add-actions" });
    const cancelBtn = el("button", { class: "btn tm-link-add-cancel", text: "Cancel", type: "button" });
    const addBtn    = el("button", { class: "btn tm-link-add-submit", text: "Add", type: "button" });
    actions.appendChild(cancelBtn);
    actions.appendChild(addBtn);
    form.appendChild(actions);

    function reset() {
      filterInput.value = "";
      selectedTargetId = null;
      popover.style.display = "none";
      if (preferredLinkTypeId) typeSel.value = preferredLinkTypeId;
      else if (linkTypes.length) typeSel.value = linkTypes[0].id;
    }
    function collapse() {
      form.style.display = "none";
      trigger.style.display = "";
      reset();
    }
    function expand() {
      trigger.style.display = "none";
      form.style.display = "";
      reset();
      // Defer focus until the form is in the DOM.
      setTimeout(() => filterInput.focus(), 0);
    }

    trigger.addEventListener("click", (ev) => { ev.stopPropagation(); expand(); });
    cancelBtn.addEventListener("click", (ev) => { ev.stopPropagation(); collapse(); });
    addBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const linkTypeId = typeSel.value;
      if (!linkTypeId) {
        if (ctx && ctx.flashStatus) ctx.flashStatus("pick a link type", { kind: "error" });
        return;
      }
      if (!selectedTargetId) {
        if (ctx && ctx.flashStatus) ctx.flashStatus("pick a target ticket from the list", { kind: "error" });
        return;
      }
      // SM-70: pending-mode pushes onto the draft ticket; the rerender call
      // builds a fresh forward-list including the new row.
      if (pendingTicket) {
        const pendingId = "ln-pending-" + Math.random().toString(36).slice(2, 10);
        pendingTicket.links = pendingTicket.links || [];
        // Avoid duplicates (same linkTypeId + targetTicketId).
        const dup = pendingTicket.links.some(l =>
          l.linkTypeId === linkTypeId && l.targetTicketId === selectedTargetId);
        if (dup) {
          if (ctx && ctx.flashStatus) ctx.flashStatus("link already added", { kind: "error" });
          return;
        }
        pendingTicket.links.push({
          id: pendingId,
          linkTypeId: linkTypeId,
          targetTicketId: selectedTargetId,
          createdAt: Date.now()
        });
        collapse();
        onPendingChange();
        return;
      }
      try {
        ctx.store.addLink(sourceTicketId, { linkTypeId, targetTicketId: selectedTargetId }, LOCAL_ACTOR);
        collapse();
      } catch (err) {
        if (ctx && ctx.flashStatus) ctx.flashStatus(err.message || "add failed", { kind: "error" });
      }
    });

    return wrap;
  }

  // ---- Field-Population (Live-Sync) ------------------------------------

  /**
   * Update a single sync-keyed field's value from the latest ticket,
   * UNLESS the field is currently focused (user is typing). Skipping
   * focused fields prevents stomp.
   */
  function syncFieldFromTicket(modal, ticket, snapshot) {
    const focused = document.activeElement;
    function shouldSkip(elNode) { return elNode === focused; }

    function pick(key) { return modal.querySelector('[' + CONSTANTS.LIVE_SYNC_ATTR + '="' + key + '"]'); }

    const titleEl = pick("title");
    if (titleEl && !shouldSkip(titleEl) && titleEl.value !== ticket.title) titleEl.value = ticket.title || "";

    const typeEl = pick("type");
    if (typeEl && !shouldSkip(typeEl) && typeEl.value !== ticket.type) typeEl.value = ticket.type;

    let statusEl = pick("status");
    if (statusEl && !shouldSkip(statusEl)) {
      // SM-238: if the ticket's type no longer matches the rendered control
      // (epic ⇄ work item, e.g. after an in-editor type change), swap it in
      // place — the editable <select> for work items, the read-only derived
      // pill for epics. This keeps the modal AND the full-page editor consistent
      // without each surface wiring its own type-change handler.
      const isEpic = ticket.type === "epic";
      const isPill = !!(statusEl.classList && statusEl.classList.contains("tm-status-derived"));
      if (isEpic !== isPill && statusEl.closest) {
        const row = statusEl.closest(".tm-row");
        if (row && row.parentNode) {
          const wf = (typeof core.getWorkflowForType === "function")
            ? core.getWorkflowForType(snapshot && snapshot.project, ticket.type) : null;
          const statuses = wf ? wf.statuses.map(s => (typeof s === "string" ? s : s.id)) : [ticket.status];
          row.parentNode.replaceChild(buildStatusField(ticket, statuses, snapshot), row);
          statusEl = pick("status");
        }
      }
    }
    if (statusEl && !shouldSkip(statusEl)) {
      // SM-238: the epic derived-status pill is a span, not a <select> — update
      // its textContent + recompute the breakdown from the fresh snapshot (a
      // child status change shifts the counts without touching the epic itself).
      if (statusEl.classList && statusEl.classList.contains("tm-status-derived")) {
        if (statusEl.textContent !== ticket.status) statusEl.textContent = ticket.status;
        statusEl.dataset.status = ticket.status;
        const bd = pick("status_breakdown");
        if (bd && snapshot && typeof core.epicChildStats === "function") {
          bd.textContent = epicStatusBreakdownText(core.epicChildStats(snapshot, ticket.id));
        }
      } else if (statusEl.value !== ticket.status) {
        statusEl.value = ticket.status;
      }
    }

    const releaseEl = pick("position.releaseId");
    const rid = (ticket.position && ticket.position.releaseId) || "";
    if (releaseEl && !shouldSkip(releaseEl) && releaseEl.value !== rid) releaseEl.value = rid;

    const psEl = pick("position.processStepId");
    const psid = (ticket.position && ticket.position.processStepId) || "";
    if (psEl && !shouldSkip(psEl) && psEl.value !== psid) psEl.value = psid;

    // SM-152: the container epic lives in a `contains`-link (SM-52 —
    // ticket.position.epicId is always null). Reading position.epicId here set
    // the dropdown to "— none —" on every external commit and a follow-up save
    // then dropped the contains-link, silently detaching the story. Resolve via
    // containerEpicIdOf and re-run inheritance (dispatch change) so the
    // Release/ProcessStep dropdowns track the container.
    const epicEl = pick("position.epicId");
    if (epicEl && !shouldSkip(epicEl)) {
      const containerId = (snapshot && typeof core.containerEpicIdOf === "function")
        ? (core.containerEpicIdOf(snapshot, ticket.id) || "")
        : ((ticket.position && ticket.position.epicId) || "");
      if (epicEl.value !== containerId) {
        epicEl.value = containerId;
        // The change listener installed in buildPositionFields re-applies
        // inheritance using its own epicById closure.
        try { epicEl.dispatchEvent(new Event("change")); } catch (_) { /* ignore */ }
      }
    }

    const descEl = pick("description");
    if (descEl && !shouldSkip(descEl) && readFieldText(descEl) !== (ticket.description || "")) {
      writeFieldText(descEl, ticket.description || "");
      // SM-157: keep the inline-confirm baseline in step with the external value.
      if (typeof descEl.__tfSetBaseline === "function") descEl.__tfSetBaseline(ticket.description || "");
    }

    const labelsEl = pick("labels");
    const labelsValue = (ticket.labels || []).join(", ");
    if (labelsEl && !shouldSkip(labelsEl) && labelsEl.value !== labelsValue) labelsEl.value = labelsValue;

    // SM-152: Acceptance Criteria — reflect external edits, but skip the
    // rebuild while the user is typing inside the section (focus-guard, same
    // as prerequisites/steps). Pairs with the buildUpdatePatch diff-guard so
    // an unrelated local save can't clobber a freshly-synced AC list.
    const acWrap = pick("acceptanceCriteria");
    if (acWrap && !(document.activeElement && acWrap.contains(document.activeElement))) {
      rebuildAcInPlace(acWrap, ticket.acceptanceCriteria || []);
    }

    // DoR / DoD checklists: rebuild fully (state changes can be sparse). The
    // checkboxes never receive keyboard focus during typing (a click toggles
    // them), so we don't need a focus-aware diff here.
    const dorWrap = pick("definitionOfReady");
    const dodWrap = pick("definitionOfDone");
    if (dorWrap) rebuildChecklistInPlace(dorWrap, (ticket.definitionOfReady || { items: [] }).items, "DoR");
    if (dodWrap) rebuildChecklistInPlace(dodWrap, (ticket.definitionOfDone  || { items: [] }).items, "DoD");

    // SM-48: Links rebuild. Same focus-guard semantics as DoR/DoD — but
    // the Links section has no editable text inputs, so a flat rebuild
    // is safe even when the section is the active area (the +Add modal
    // is a separate overlay; closing it triggers the rebuild). Skip if
    // a target lookup needs `snapshot.tickets` and we have none.
    const linksWrap = pick("links");
    if (linksWrap && snapshot) {
      // ctx is not in scope here; the existing buildLinksSection accepts
      // an undefined ctx for read-only render — × and + buttons re-attach
      // only when called from the modal's own factory (with ctx). For the
      // live-sync path, render-only is enough: the user reopens the modal
      // for any local action and the modal carries ctx itself.
      renderLinksSectionInto(linksWrap, ticket, snapshot, linksWrap.__tmCtx || null);
    }

    // SM-54: Prerequisites + Steps. Rebuild only if no input inside the
    // section currently has focus (don't stomp a typing user). The rebuild
    // re-uses buildPrereqRow / buildTestStepRow so the new rows get fresh
    // event listeners + dnd hooks.
    const prereqsWrap = pick("prerequisites");
    if (prereqsWrap && !(document.activeElement && prereqsWrap.contains(document.activeElement))) {
      rebuildPrereqsInPlace(prereqsWrap, ticket.prerequisites || []);
    }
    const stepsWrap = pick("steps");
    if (stepsWrap && !(document.activeElement && stepsWrap.contains(document.activeElement))) {
      rebuildTestStepsInPlace(stepsWrap, ticket.steps || []);
    }
  }

  // SM-152: live-sync rebuild of the Acceptance-Criteria list. Mirrors
  // rebuildPrereqsInPlace: drop + rebuild rows with a no-op markDirty (the
  // "+ Criterion" trigger is omitted — the user reopens the modal to add).
  function rebuildAcInPlace(wrap, items) {
    while (wrap.firstChild) wrap.removeChild(wrap.firstChild);
    wrap.appendChild(el("h4", { class: "tm-section-title", text: "Acceptance Criteria" }));
    const list = el("div", { class: "tm-ac-list" });
    const refs = { markDirty: () => {} };
    for (const ac of items) list.appendChild(buildAcRow(ac, refs));
    wrap.appendChild(list);
  }

  function rebuildPrereqsInPlace(wrap, items) {
    while (wrap.firstChild) wrap.removeChild(wrap.firstChild);
    wrap.appendChild(el("h4", { class: "tm-section-title", text: "Prerequisites" }));
    const list = el("div", { class: "tm-prereq-list" });
    const refs = { markDirty: () => {} };
    for (const item of items) list.appendChild(buildPrereqRow(item, refs));
    wrap.appendChild(list);
    // Note: live-sync rebuild skips the "+ Add" trigger to avoid wiring two
    // refs.markDirty into the same ticket-modal — the user reopens the modal
    // to add new items, which is consistent with how DoR/DoD live-sync works.
  }

  function rebuildTestStepsInPlace(wrap, items) {
    while (wrap.firstChild) wrap.removeChild(wrap.firstChild);
    wrap.appendChild(el("h4", { class: "tm-section-title", text: "Steps" }));
    // SM-152: header must mirror buildStepsSection's 6-cell grid (grip + step
    // + data + expected + insert + remove) so the labels sit above the right
    // columns after an external commit — the old 3-cell head misaligned them.
    const tableHead = el("div", { class: "tm-test-step-head" }, [
      el("span", { class: "tm-test-step-head-cell tm-test-step-head-grip" }),
      el("span", { class: "tm-test-step-head-cell tm-test-step-head-step",     text: "Step" }),
      el("span", { class: "tm-test-step-head-cell tm-test-step-head-data",     text: "Data" }),
      el("span", { class: "tm-test-step-head-cell tm-test-step-head-expected", text: "Expected Result" }),
      el("span", { class: "tm-test-step-head-cell tm-test-step-head-insert" }),
      el("span", { class: "tm-test-step-head-cell tm-test-step-head-remove" })
    ]);
    wrap.appendChild(tableHead);
    const list = el("div", { class: "tm-test-step-list" });
    const refs = { markDirty: () => {} };
    for (const item of items) list.appendChild(buildTestStepRow(item, refs, list));
    wrap.appendChild(list);
  }

  /**
   * SM-5: Pulse every sync-keyed field that differs between prev and next
   * ticket. Called only when the upstream subscribe sees `reason ===
   * "applyRemote"` (external edit — MCP or another browser); local commits
   * skip this because the user already has direct feedback from typing.
   * Reuses the `.sm-card-flash` keyframe (SM-20 widened that selector to
   * cover anything that gets the class).
   *
   * Returns the set of keys that pulsed, for tests + telemetry.
   */
  function diffSyncFieldKeys(prev, next) {
    const out = new Set();
    if (!prev || !next) return out;
    const simpleKeys = ["title", "type", "status", "description"];
    for (const k of simpleKeys) {
      if ((prev[k] || "") !== (next[k] || "")) out.add(k);
    }
    const prevPos = prev.position || {};
    const nextPos = next.position || {};
    if ((prevPos.releaseId     || "") !== (nextPos.releaseId     || "")) out.add("position.releaseId");
    if ((prevPos.processStepId || "") !== (nextPos.processStepId || "")) out.add("position.processStepId");
    if ((prevPos.epicId        || "") !== (nextPos.epicId        || "")) out.add("position.epicId");
    const prevLabels = (prev.labels || []).join(",");
    const nextLabels = (next.labels || []).join(",");
    if (prevLabels !== nextLabels) out.add("labels");
    if (JSON.stringify(prev.acceptanceCriteria || []) !== JSON.stringify(next.acceptanceCriteria || [])) {
      out.add("acceptanceCriteria");
    }
    const prevDor = JSON.stringify((prev.definitionOfReady && prev.definitionOfReady.items) || []);
    const nextDor = JSON.stringify((next.definitionOfReady && next.definitionOfReady.items) || []);
    if (prevDor !== nextDor) out.add("definitionOfReady");
    const prevDod = JSON.stringify((prev.definitionOfDone  && prev.definitionOfDone.items)  || []);
    const nextDod = JSON.stringify((next.definitionOfDone  && next.definitionOfDone.items)  || []);
    if (prevDod !== nextDod) out.add("definitionOfDone");
    // SM-48: pulse the Links section when forward links on this ticket change.
    // Backward-link changes (on other tickets' links[]) don't pulse — the
    // diff helper only sees this ticket's prev/next.
    const prevLinks = JSON.stringify(prev.links || []);
    const nextLinks = JSON.stringify(next.links || []);
    if (prevLinks !== nextLinks) out.add("links");
    // SM-54: pulse Prereqs / Steps sections when those fields change.
    if (JSON.stringify(prev.prerequisites || []) !== JSON.stringify(next.prerequisites || [])) {
      out.add("prerequisites");
    }
    if (JSON.stringify(prev.steps || []) !== JSON.stringify(next.steps || [])) {
      out.add("steps");
    }
    return out;
  }

  function pulseChangedFields(modal, prevTicket, nextTicket) {
    const keys = diffSyncFieldKeys(prevTicket, nextTicket);
    for (const key of keys) {
      // Multiple matches are possible (theoretically) — pulse all of them.
      const nodes = modal.querySelectorAll('[' + CONSTANTS.LIVE_SYNC_ATTR + '="' + key + '"]');
      for (const node of nodes) {
        // Restart-the-animation pattern: remove → force reflow → re-add.
        node.classList.remove(CONSTANTS.FIELD_PULSE_CLASS);
        // eslint-disable-next-line no-unused-expressions
        void node.offsetWidth;
        node.classList.add(CONSTANTS.FIELD_PULSE_CLASS);
        setTimeout(function () { node.classList.remove(CONSTANTS.FIELD_PULSE_CLASS); }, CONSTANTS.FIELD_PULSE_MS);
      }
    }
    return keys;
  }

  /**
   * E19-followup: Live-sync für DoR/DoD ist jetzt anders — die Section ist
   * ein voll editierbarer Editor mit Inputs. Wenn der User gerade darin
   * tippt (irgendein Input mit Focus), nicht stompen. Sonst Editor neu
   * rendern (Items kommen vom WS-Push). Focus-Guard analog Title-Input.
   */
  function rebuildChecklistInPlace(wrap, items, kind) {
    // Focus-Guard: wenn ein Input innerhalb der Section gerade Focus hat,
    // überspring den Rebuild — der User tippt gerade.
    const focused = document.activeElement;
    if (focused && wrap.contains(focused)) return;
    while (wrap.firstChild) wrap.removeChild(wrap.firstChild);
    wrap.appendChild(el("h4", { class: "tm-section-title", text: "Definition of " + (kind === "DoR" ? "Ready" : "Done") }));
    const list = el("div", { class: "tm-checklist-list" });
    const refs = { markDirty: () => {} };
    for (const item of items) list.appendChild(buildCheckRow(item, refs));
    wrap.appendChild(list);
  }

  // ---- Diff: form-state → patch ---------------------------------------

  function collectFormState(modal) {
    function pick(key) { return modal.querySelector('[' + CONSTANTS.LIVE_SYNC_ATTR + '="' + key + '"]'); }
    // readFieldText handles both form controls (.value) and the contentEditable
    // description block (innerText/textContent). SM-119.
    function val(key) { const n = pick(key); return n ? readFieldText(n) : undefined; }
    function labelsArr() {
      const v = val("labels") || "";
      return v.split(",").map(s => s.trim()).filter(Boolean);
    }
    const acRows = Array.from(modal.querySelectorAll(".tm-ac-row"));
    const acceptanceCriteria = acRows.map(row => {
      const checkbox = row.querySelector('input[type="checkbox"]');
      const text     = row.querySelector('input[type="text"]');
      return { id: row.dataset.acId, text: text.value, completed: !!checkbox.checked };
    });
    return {
      title:       val("title"),
      type:        val("type"),
      status:      val("status"),
      description: val("description"),
      position: {
        releaseId:     val("position.releaseId") || null,
        processStepId: val("position.processStepId") || null,
        epicId:        val("position.epicId") || null
      },
      acceptanceCriteria: acceptanceCriteria,
      labels: labelsArr(),
      definitionOfReady: { items: collectChecklistItems(modal, "definitionOfReady") },
      definitionOfDone:  { items: collectChecklistItems(modal, "definitionOfDone") },
      // SM-54: test-definition sections. `null` (= "not rendered") signals
      // buildUpdatePatch to leave the existing values alone; an array means
      // "this is the new full list".
      prerequisites: collectPrerequisites(modal),
      steps:         collectTestSteps(modal),
      // SM-57: test-execution sections. Same null-vs-array convention.
      // outcomeOverride is `undefined` when the section isn't rendered;
      // null when the user picked "auto"; a string otherwise.
      executionSteps:  collectExecutionSteps(modal),
      outcomeOverride: collectOutcomeOverride(modal)
    };
  }

  /**
   * SM-57: Read execution-step rows. Returns `null` if the section isn't
   * rendered (wrong type / gate off). Steps are NEVER added or removed
   * here — we just read whatever's in the DOM. The frozen step/data/
   * expectedResult fields are sent back as-is (disabled inputs still carry
   * their value).
   */
  function collectExecutionSteps(modal) {
    const wrap = modal.querySelector('section.tm-exec-steps[' + CONSTANTS.LIVE_SYNC_ATTR + '="executionSteps"]');
    if (!wrap) return null;
    const rows = wrap.querySelectorAll(".tm-exec-step-row");
    const out = [];
    rows.forEach((row) => {
      const stepEl     = row.querySelector(".tm-exec-step-step");
      const dataEl     = row.querySelector(".tm-exec-step-data");
      const expectedEl = row.querySelector(".tm-exec-step-expected");
      const actualEl   = row.querySelector(".tm-exec-step-actual");
      const statusEl   = row.querySelector(".tm-exec-step-status");
      const noteEl     = row.querySelector(".tm-exec-step-note");
      const noteVal = (noteEl && noteEl.value || "").trim();
      const item = {
        id:             row.dataset.itemId,
        stepId:         row.dataset.itemId,         // frontend mirrors stepId == itemId on the run-row
        step:           (stepEl     && stepEl.value)     || "",
        data:           (dataEl     && dataEl.value)     || "",
        expectedResult: (expectedEl && expectedEl.value) || "",
        actualResult:   (actualEl   && actualEl.value)   || "",
        status:         (statusEl   && statusEl.value)   || "pending"
      };
      if (noteVal) item.note = noteVal;
      out.push(item);
    });
    return out;
  }

  /**
   * SM-57: Read the outcome-override picker value. Returns:
   *   - undefined → section not rendered (don't touch ticket.outcomeOverride)
   *   - null      → user picked "auto" (= clear the manual override)
   *   - string    → one of the enum values
   */
  function collectOutcomeOverride(modal) {
    const sel = modal.querySelector(".tm-exec-outcome-override");
    if (!sel) return undefined;
    const v = sel.value;
    if (v === "auto" || !v) return null;
    return v;
  }

  /**
   * SM-54: Read Prerequisites rows from the DOM in current order. Empty-label
   * rows are dropped (analog DoR/DoD). Returns `null` if the section isn't
   * rendered (gate off or wrong type), so buildUpdatePatch can leave the
   * existing prerequisites untouched.
   */
  function collectPrerequisites(modal) {
    const wrap = modal.querySelector('section.tm-prereqs[' + CONSTANTS.LIVE_SYNC_ATTR + '="prerequisites"]');
    if (!wrap) return null;
    const rows = wrap.querySelectorAll(".tm-prereq-row");
    const out = [];
    rows.forEach((row) => {
      const labelInput = row.querySelector(".tm-prereq-text-input");
      const label = (labelInput && labelInput.value || "").trim();
      if (!label) return;
      const checkedInput  = row.querySelector(".tm-prereq-checked");
      const requiredInput = row.querySelector(".tm-prereq-required");
      out.push({
        id:       row.dataset.itemId,
        label:    label,
        required: !!(requiredInput && requiredInput.checked),
        checked:  !!(checkedInput  && checkedInput.checked)
      });
    });
    return out;
  }

  /**
   * SM-54: Read Steps rows from the DOM. A row whose THREE text fields are
   * all empty is dropped (empty placeholder added by "+ Add Step" but not
   * filled in). Returns `null` if the section isn't rendered.
   */
  function collectTestSteps(modal) {
    const wrap = modal.querySelector('section.tm-test-steps[' + CONSTANTS.LIVE_SYNC_ATTR + '="steps"]');
    if (!wrap) return null;
    const rows = wrap.querySelectorAll(".tm-test-step-row");
    const out = [];
    rows.forEach((row) => {
      const stepInput     = row.querySelector(".tm-test-step-step");
      const dataInput     = row.querySelector(".tm-test-step-data");
      const expectedInput = row.querySelector(".tm-test-step-expected");
      const step     = (stepInput     && stepInput.value     || "").trim();
      const data     = (dataInput     && dataInput.value     || "").trim();
      const expected = (expectedInput && expectedInput.value || "").trim();
      if (!step && !data && !expected) return;
      out.push({
        id:             row.dataset.itemId,
        step:           step,
        data:           data,
        expectedResult: expected
      });
    });
    return out;
  }

  /**
   * Read DoR/DoD rows from the DOM in current order. Empty-label rows are
   * dropped (analog dialog-definitions-settings). E19-followup.
   */
  function collectChecklistItems(modal, syncKey) {
    const wrap = modal.querySelector('section.tm-checklist[' + CONSTANTS.LIVE_SYNC_ATTR + '="' + syncKey + '"]');
    if (!wrap) return null;   // section not rendered for this type (gate off)
    const rows = wrap.querySelectorAll(".tm-checkitem-row");
    const out = [];
    rows.forEach((row) => {
      const labelInput = row.querySelector(".tm-checkitem-text-input");
      const label = (labelInput && labelInput.value || "").trim();
      if (!label) return;
      const checkedInput  = row.querySelector(".tm-checkitem-checked");
      const requiredInput = row.querySelector(".tm-checkitem-required");
      out.push({
        id:       row.dataset.itemId,
        label:    label,
        required: !!(requiredInput && requiredInput.checked),
        checked:  !!(checkedInput  && checkedInput.checked)
      });
    });
    return out;
  }

  /**
   * Produce a "field patch" suitable for PUT /tickets/:tid (which uses
   * updateTicket allowing: title/description/type/status/position/
   * acceptanceCriteria/labels). Position keeps the existing sortOrder
   * (caller doesn't reorder from the modal).
   */
  function buildUpdatePatch(form, original) {
    const patch = {};
    if (form.title !== original.title)             patch.title = form.title;
    if (form.type !== original.type)               patch.type = form.type;
    if (form.description !== original.description) patch.description = form.description;
    const op = original.position || {};
    const fp = form.position || {};
    if ((fp.releaseId || null)     !== (op.releaseId || null)
     || (fp.processStepId || null) !== (op.processStepId || null)
     || (fp.epicId || null)        !== (op.epicId || null)) {
      patch.position = {
        releaseId:     fp.releaseId || null,
        processStepId: fp.processStepId || null,
        epicId:        fp.epicId || null,
        sortOrder:     (op.sortOrder || 0)
      };
    }
    // SM-152: only include acceptanceCriteria if it actually changed vs the
    // original. Otherwise a save that touched some OTHER field would ship our
    // (possibly stale) local AC list and clobber an external AC edit. Compare
    // by content+order (ignore item ids — new local rows get random ids).
    const acSig = (lst) => JSON.stringify((lst || []).map(a => ({ text: a.text || "", completed: !!a.completed })));
    if (acSig(form.acceptanceCriteria) !== acSig(original.acceptanceCriteria)) {
      patch.acceptanceCriteria = form.acceptanceCriteria;
    }
    // SM-120: labels only when actually changed. (Was unconditional, which made
    // the in-place auto-commit fire on every interaction. The modal Save path is
    // unaffected — it gates on hasNonStatusChanges, which still sees a real
    // labels change.)
    if (JSON.stringify(form.labels || []) !== JSON.stringify(original.labels || [])) {
      patch.labels = form.labels;
    }
    // E19-followup: DoR/DoD-Items als per-Ticket-Patch. Wenn collectChecklistItems
    // null zurückgibt (Section gar nicht gerendert, z.B. gate off), keinen Patch
    // setzen — der Server bewahrt die existierenden Items.
    if (form.definitionOfReady && Array.isArray(form.definitionOfReady.items)) {
      if (!checklistsEqual(form.definitionOfReady.items,
                           (original.definitionOfReady && original.definitionOfReady.items) || [])) {
        patch.definitionOfReady = form.definitionOfReady;
      }
    }
    if (form.definitionOfDone && Array.isArray(form.definitionOfDone.items)) {
      if (!checklistsEqual(form.definitionOfDone.items,
                           (original.definitionOfDone && original.definitionOfDone.items) || [])) {
        patch.definitionOfDone = form.definitionOfDone;
      }
    }
    // SM-54: test-definition fields. `null` means the section wasn't rendered
    // → leave existing values alone. An array means "this is the new full list" —
    // include only when structurally different from the original.
    if (Array.isArray(form.prerequisites)) {
      if (!prereqsEqual(form.prerequisites, original.prerequisites || [])) {
        patch.prerequisites = form.prerequisites;
      }
    }
    if (Array.isArray(form.steps)) {
      if (!testStepsEqual(form.steps, original.steps || [])) {
        patch.steps = form.steps;
      }
    }
    // SM-57: test-execution fields.
    if (Array.isArray(form.executionSteps)) {
      if (!execStepsEqual(form.executionSteps, original.executionSteps || [])) {
        patch.executionSteps = form.executionSteps;
      }
    }
    // outcomeOverride: undefined = section not rendered (skip). null = clear
    // override (write only if currently non-null). string = set explicit value.
    if (form.outcomeOverride !== undefined) {
      const currentOverride = (typeof original.outcomeOverride === "string") ? original.outcomeOverride : null;
      const target = (form.outcomeOverride === null) ? null : form.outcomeOverride;
      if (currentOverride !== target) {
        // core.updateTicket maps null/`"auto"` → null clear; explicit value → set.
        patch.outcomeOverride = (target === null) ? "auto" : target;
      }
    }
    return patch;
  }

  function execStepsEqual(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i].id !== b[i].id) return false;
      if ((a[i].actualResult || "") !== (b[i].actualResult || "")) return false;
      if ((a[i].status       || "pending") !== (b[i].status || "pending")) return false;
      if ((a[i].note         || "") !== (b[i].note || "")) return false;
    }
    return true;
  }

  function prereqsEqual(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i].id !== b[i].id) return false;
      if ((a[i].label    || "") !== (b[i].label    || "")) return false;
      if ((a[i].required !== false) !== (b[i].required !== false)) return false;
      if (!!a[i].checked !== !!b[i].checked) return false;
    }
    return true;
  }

  function testStepsEqual(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i].id !== b[i].id) return false;
      if ((a[i].step           || "") !== (b[i].step           || "")) return false;
      if ((a[i].data           || "") !== (b[i].data           || "")) return false;
      if ((a[i].expectedResult || "") !== (b[i].expectedResult || "")) return false;
    }
    return true;
  }

  function checklistsEqual(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i].id !== b[i].id) return false;
      if ((a[i].label || "") !== (b[i].label || "")) return false;
      if ((a[i].required !== false) !== (b[i].required !== false)) return false;
      if (!!a[i].checked !== !!b[i].checked) return false;
    }
    return true;
  }

  /**
   * Build a draft ticket for Create-Mode given a type + position context.
   * Returns a plain ticket-shaped object (no id, no ticketKey — server
   * assigns those on POST).
   */
  function buildDraftTicket(type, draftCtx) {
    const dc = draftCtx || {};
    return {
      id: null,
      ticketKey: "",
      type: type,
      title: "",
      description: "",
      status: dc.status || "backlog",
      position: {
        releaseId:     dc.releaseId     || null,
        processStepId: dc.processStepId || null,
        epicId:        dc.epicId        || null,
        sortOrder:     0
      },
      acceptanceCriteria: [],
      definitionOfReady: { items: [] },
      definitionOfDone:  { items: [] },
      labels: [],
      links: [],
      comments: []
    };
  }

  // ---- SM-120 (B5): in-place persistence -------------------------------
  //
  // Wire a host so every field change commits a Store-op directly — no Save
  // button. Discrete controls (select/checkbox) commit immediately; text
  // fields commit on focus-out; list-sections (AC/DoR/DoD/prereqs/steps) commit
  // via the returned `markDirty` (debounced, so per-keystroke typing coalesces
  // into one undo entry). Status routes through `changeStatusGated` so the
  // DoR/DoD gate fires; a 422 reverts the picker and reports via onStatusError,
  // leaving the page open. The description is intentionally excluded — it owns
  // its inline ✓/✗ (SM-157).
  //
  // opts: { store, ticketId, actor?, onStatusError?(msgOrNull), flashStatus?,
  //         debounceMs?, win? }. Returns { markDirty, detach }.
  function installInPlaceCommit(host, opts) {
    opts = opts || {};
    const store = opts.store;
    const ticketId = opts.ticketId;
    const actor = opts.actor || LOCAL_ACTOR;
    const win = opts.win || (typeof window !== "undefined" ? window : null);
    const setT = (win && win.setTimeout) || (typeof setTimeout === "function" ? setTimeout : null);
    const clrT = (win && win.clearTimeout) || (typeof clearTimeout === "function" ? clearTimeout : null);
    const debounceMs = typeof opts.debounceMs === "number" ? opts.debounceMs : 450;
    const onStatusError = typeof opts.onStatusError === "function" ? opts.onStatusError : function () {};
    let timer = null;

    function curTicket() {
      const snap = store.get();
      return (snap.tickets || []).find(t => t.id === ticketId) || null;
    }

    function commitFields() {
      const cur = curTicket();
      if (!cur) return;
      const form = collectFormState(host);
      // The description self-commits via its inline ✓/✗; never clobber it here.
      form.description = cur.description;
      // Status is handled by the dedicated gated path — strip from the diff.
      form.status = cur.status;
      // SM-52: resolve the container epic so the position diff is
      // apples-to-apples (position.epicId is always null on the stored ticket).
      const containerId = (typeof core.containerEpicIdOf === "function")
        ? core.containerEpicIdOf(store.get(), ticketId) : null;
      const curCmp = Object.assign({}, cur, {
        position: Object.assign({}, cur.position || {}, { epicId: containerId })
      });
      const patch = buildUpdatePatch(form, curCmp);
      if (Object.keys(patch).length === 0) return;
      try { store.updateTicket(ticketId, patch, actor); }
      catch (e) { if (opts.flashStatus) opts.flashStatus("save failed: " + (e && e.message || e), { kind: "error" }); }
    }

    function schedule() {
      if (!setT) { commitFields(); return; }
      if (timer && clrT) clrT(timer);
      timer = setT(commitFields, debounceMs);
    }

    function commitStatus(sel) {
      const cur = curTicket();
      if (!cur) return;
      const next = sel.value;
      if (!next || next === cur.status) return;
      try {
        store.changeStatusGated(ticketId, next, actor);
        onStatusError(null);
      } catch (e) {
        sel.value = cur.status;   // revert the picker; stay on the page
        const missing = (e && e.missing) ? e.missing.map(m => m.label || m.id).join(", ") : "";
        const kind = (e && e.kind) ? e.kind : "";
        onStatusError(kind ? (kind + " gate blocks this transition. Missing: " + missing)
                           : ((e && e.message) || "transition blocked"));
      }
    }

    function keyOf(node) {
      return node && node.getAttribute ? node.getAttribute(CONSTANTS.LIVE_SYNC_ATTR) : null;
    }
    function onChange(ev) {
      const t = ev.target;
      if (keyOf(t) === "status") { commitStatus(t); return; }
      commitFields();   // discrete control → immediate
    }
    function onFocusOut(ev) {
      const k = keyOf(ev.target);
      if (k === "description" || k === "status") return;   // own handlers
      commitFields();   // text field blur → immediate
    }

    host.addEventListener("change", onChange);
    host.addEventListener("focusout", onFocusOut);

    return {
      markDirty: schedule,
      detach: function () {
        host.removeEventListener("change", onChange);
        host.removeEventListener("focusout", onFocusOut);
        if (timer && clrT) clrT(timer);
      }
    };
  }

  // SM-185: Attachments section — a dropzone + list, bound to a ticket. Files
  // are reference docs (PRDs, designs); they ALWAYS belong to a ticket (no
  // free-floating attachments). Uses ctx helpers (HTTP-only): listAttachments /
  // uploadAttachment / deleteAttachment / attachmentHref / flashStatus.
  function formatBytes(n) {
    if (typeof n !== "number") return "";
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    return (n / (1024 * 1024)).toFixed(1) + " MB";
  }
  function buildAttachmentsSection(ticketId, ctx) {
    const section = el("section", { class: "tm-attachments-section" });
    section.appendChild(el("h4", { class: "tm-section-title", text: "Attachments" }));
    const drop = el("div", { class: "tm-attach-dropzone", text: "Drop a file here or click to attach" });
    const fileInput = el("input", { type: "file", class: "tm-attach-input", style: { display: "none" } });
    const listEl = el("ul", { class: "tm-attach-list" });
    section.appendChild(drop);
    section.appendChild(fileInput);
    section.appendChild(listEl);

    function renderList(items) {
      listEl.innerHTML = "";
      if (!items || !items.length) {
        listEl.appendChild(el("li", { class: "tm-attach-empty", text: "No attachments yet." }));
        return;
      }
      for (const a of items) {
        const li = el("li", { class: "tm-attach-item", dataset: { attachmentId: a.id } });
        const link = el("a", { class: "tm-attach-name", href: ctx.attachmentHref(a.id), text: a.filename, title: "Download" });
        link.setAttribute("download", a.filename);
        li.appendChild(link);
        li.appendChild(el("span", { class: "tm-attach-size", text: formatBytes(a.size) }));
        const del = el("button", { class: "tm-attach-del", type: "button", title: "Remove attachment", text: "✕" });
        del.addEventListener("click", async (ev) => {
          ev.preventDefault(); ev.stopPropagation();
          try {
            await ctx.deleteAttachment(a.id);
            await refresh();
            if (ctx.flashStatus) ctx.flashStatus("attachment removed", { kind: "ok" });
          } catch (e) {
            if (ctx.flashStatus) ctx.flashStatus(e.message || "delete failed", { kind: "error" });
          }
        });
        li.appendChild(del);
        listEl.appendChild(li);
      }
    }
    async function refresh() {
      try { renderList(await ctx.listAttachments(ticketId)); }
      catch (_) { renderList([]); }
    }
    async function upload(file) {
      if (!file) return;
      if (ctx.flashStatus) ctx.flashStatus("uploading " + file.name + " …", { kind: "info" });
      try {
        await ctx.uploadAttachment(ticketId, file);
        await refresh();
        if (ctx.flashStatus) ctx.flashStatus("attached " + file.name, { kind: "ok" });
      } catch (e) {
        if (ctx.flashStatus) ctx.flashStatus(e.message || "upload failed", { kind: "error" });
      }
    }
    drop.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", () => {
      if (fileInput.files && fileInput.files[0]) upload(fileInput.files[0]);
      fileInput.value = "";
    });
    drop.addEventListener("dragover", (ev) => { ev.preventDefault(); drop.classList.add("tm-attach-dropzone-over"); });
    drop.addEventListener("dragleave", () => drop.classList.remove("tm-attach-dropzone-over"));
    drop.addEventListener("drop", (ev) => {
      ev.preventDefault();
      drop.classList.remove("tm-attach-dropzone-over");
      const f = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
      if (f) upload(f);
    });
    refresh();
    return section;
  }

  return {
    CONSTANTS, LOCAL_ACTOR, DRAG_TYPE_AC, DRAG_TYPE_CHECK,
    buildAttachmentsSection,
    DRAG_TYPE_PREREQ, DRAG_TYPE_TEST_STEP, MAX_TEST_STEP_TA_HEIGHT_PX, el,
    buildRow, buildErrorBanner, cssEscape, autoGrowTextarea,
    buildTitleField, buildTypeField, buildStatusField, buildPositionFields,
    buildDescriptionField, buildChecklistSection, buildCheckRow, buildAcceptanceCriteriaSection,
    buildAcRow, buildPrerequisitesSection, buildPrereqRow, buildStepsSection,
    buildTestStepRow, buildLabelsField, resolveTestDefinition, buildTestExecutionHeader,
    buildExecutionMetadata, buildExecutionStepsSection, buildExecutionStepRow, buildOutcomeSection,
    lookupLinkType, findBackwardLinks, buildLinkPill, buildTargetRef,
    buildLinksSection, renderLinksSectionInto, buildInlineAddLinkForm, syncFieldFromTicket,
    rebuildAcInPlace, rebuildPrereqsInPlace, rebuildTestStepsInPlace, diffSyncFieldKeys,
    pulseChangedFields, rebuildChecklistInPlace, buildDraftTicket, collectFormState,
    collectExecutionSteps, collectOutcomeOverride, collectPrerequisites, collectTestSteps,
    collectChecklistItems, buildUpdatePatch, execStepsEqual, prereqsEqual,
    testStepsEqual, checklistsEqual, installInPlaceCommit
  };
}));
