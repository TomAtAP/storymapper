/**
 * Settings view (E21.D — skeleton).
 *
 * Third view alongside Story Map and Kanban. Editors for Workflow (E21.E
 * status editor, E21.F transition editor) and Board (E21.G kanban-column
 * mapping) plug into this shell. This skeleton renders a section
 * scaffold + empty bodies; following etappes fill the bodies.
 *
 * The view is NOT a modal — it owns its host area, gets mounted/unmounted
 * by main.js's view-toggle (E21.D wiring), and stays in sync with the
 * store via subscribe + rerender (same pattern as Kanban).
 *
 * UMD-wrapped so the same source works in the browser AND can be
 * require()-d in Node tests.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./core.js"), require("./dnd.js"));
  } else {
    (root.STORYMAP = root.STORYMAP || {}).viewSettings =
      factory(root.STORYMAP.core, root.STORYMAP.dnd);
  }
}(typeof self !== "undefined" ? self : this, function (core, dnd) {
  "use strict";

  const LOCAL_ACTOR = { type: "human", id: "local", name: "Local" };

  // SM-2 — DoR/DoD editor constants (ported from dialog-definitions-settings).
  const DDS_DRAG_TYPE      = "vs-defs-item";
  const DDS_ITEM_ID_PREFIX = "vs-def-";
  function freshDefItemId() {
    return DDS_ITEM_ID_PREFIX + Math.random().toString(36).slice(2, 10);
  }

  // E21.E: Auto-id generator for new statuses. Kebab-case "new-status" with
  // a short random suffix so identical names don't clash.
  function freshStatusId(existing) {
    let i = 1;
    let candidate = "new-status";
    const ids = new Set((existing || []).map(s => s.id));
    while (ids.has(candidate)) {
      i += 1;
      candidate = "new-status-" + i;
    }
    return candidate;
  }

  // ---- DOM helpers ---------------------------------------------------

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        if (k === "class") node.className = attrs[k];
        else if (k === "dataset") {
          for (const dk of Object.keys(attrs.dataset)) node.dataset[dk] = attrs.dataset[dk];
        }
        else if (k === "html") node.innerHTML = attrs[k];
        else if (k === "text") node.textContent = attrs[k];
        else if (k === "style" && typeof attrs.style === "object") Object.assign(node.style, attrs.style);
        else node.setAttribute(k, attrs[k]);
      }
    }
    for (const c of children) {
      if (c == null) continue;
      if (typeof c === "string") node.appendChild(document.createTextNode(c));
      else node.appendChild(c);
    }
    return node;
  }

  // ---- Sections ------------------------------------------------------
  //
  // Each section is an isolated render function so future etappes can
  // swap one out without touching the shell. The contract:
  //   renderXxx(project, ctx) → DOM element
  // ctx exposes `store`, `flashStatus`, etc. — the same shape main.js
  // builds for ticket-modal and dialogs.

  // ---- E21.E status editor -----------------------------------------
  //
  // Pure reorder helper — exported so tests don't have to drive the dnd
  // module to validate the order math.
  function reorderStatuses(allStatuses, sourceId, targetId, before) {
    if (sourceId === targetId) return allStatuses.slice();
    const fromIdx = allStatuses.findIndex(s => s.id === sourceId);
    if (fromIdx < 0) return allStatuses.slice();
    const next = allStatuses.slice();
    const [moved] = next.splice(fromIdx, 1);
    let insertAt = next.findIndex(s => s.id === targetId);
    if (insertAt < 0) insertAt = next.length;
    if (!before) insertAt += 1;
    next.splice(insertAt, 0, moved);
    return next;
  }

  //
  // Live-apply pattern: discrete actions (Add, Delete, Reorder, category-
  // change) dispatch updateProject immediately; the name input commits on
  // blur (avoids a commit per keystroke). External commits re-render the
  // section, but the actively edited input is skipped — focus-guard so the
  // user doesn't lose their caret mid-edit (mirrors the ticket-modal
  // pattern).

  function commitStatuses(ctx, nextStatuses) {
    if (!ctx || !ctx.store) return;
    try {
      const cur = ctx.store.get().project.workflow || {};
      const nextWf = Object.assign({}, cur, { statuses: nextStatuses });
      ctx.store.updateProject({ workflow: nextWf }, LOCAL_ACTOR);
    } catch (err) {
      if (ctx.flashStatus) ctx.flashStatus(err.message || "save failed", { kind: "error" });
    }
  }

  function renderStatusRow(status, ctx, allStatuses, idx) {
    const row = el("div", {
      class: "vs-status-row",
      dataset: { statusId: status.id }
    });
    const grip = el("span", { class: "vs-grip", text: "⋮⋮", title: "Drag to reorder" });
    const nameInput = el("input", {
      type: "text",
      class: "vs-status-name",
      value: status.name
    });
    nameInput.addEventListener("blur", () => {
      const v = String(nameInput.value || "").trim();
      if (!v || v === status.name) {
        nameInput.value = status.name;   // revert on empty / unchanged
        return;
      }
      const next = allStatuses.slice();
      next[idx] = Object.assign({}, status, { name: v });
      commitStatuses(ctx, next);
    });

    const categorySelect = el("select", { class: "vs-status-category" });
    for (const cat of (core.STATUS_CATEGORIES || ["todo", "doing", "blocked", "done"])) {
      const opt = el("option", { value: cat, text: cat });
      if (cat === status.category) opt.selected = true;
      categorySelect.appendChild(opt);
    }
    categorySelect.addEventListener("change", () => {
      const next = allStatuses.slice();
      next[idx] = Object.assign({}, status, { category: categorySelect.value });
      commitStatuses(ctx, next);
    });

    const delBtn = el("button", {
      class: "vs-status-delete",
      title: "Delete status",
      text: "×"
    });
    delBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      // Soft warning if the status is currently in use — but allow the
      // delete; normalizeWorkflow will leave the ticket's status string in
      // place (it just no longer maps to a workflow entry). The user can
      // re-add the status if needed.
      const snap = ctx.store ? ctx.store.get() : null;
      const inUse = snap && (snap.tickets || []).some(t => !t.isDeleted && t.status === status.id);
      if (inUse && typeof confirm === "function") {
        if (!confirm(`Status "${status.name}" is still used by tickets. Delete anyway?`)) return;
      }
      const next = allStatuses.filter((_, i) => i !== idx);
      commitStatuses(ctx, next);
    });

    row.appendChild(grip);
    row.appendChild(nameInput);
    row.appendChild(categorySelect);
    row.appendChild(delBtn);

    // E21.E reorder: row is both drag-source and drop-target. onDrop
    // rebuilds the order array and commits — focus-guard in renderInto
    // ensures the rerender doesn't fight an active edit on another row.
    if (dnd && typeof dnd.enableDraggable === "function") {
      dnd.enableDraggable(row, { dragType: "vs-status", dragId: status.id });
      dnd.enableDropTarget(row, {
        accepts: ["vs-status"],
        onEnter: (e) => e.classList.add("vs-status-drop-target"),
        onLeave: (e) => e.classList.remove("vs-status-drop-target"),
        onDrop: ({ id, event }) => {
          row.classList.remove("vs-status-drop-target");
          if (id === status.id) return;
          const rect = row.getBoundingClientRect();
          const before = (event && typeof event.clientY === "number")
            ? event.clientY < rect.top + rect.height / 2 : true;
          const next = reorderStatuses(allStatuses, id, status.id, before);
          commitStatuses(ctx, next);
        }
      });
    }
    return row;
  }

  function renderStatusEditor(workflow, ctx) {
    const statuses = (workflow && workflow.statuses) || [];
    const wrap = el("div", { class: "vs-status-editor" });
    const rowsHost = el("div", { class: "vs-status-rows" });
    statuses.forEach((s, idx) => {
      rowsHost.appendChild(renderStatusRow(s, ctx, statuses, idx));
    });
    wrap.appendChild(rowsHost);
    const add = el("button", {
      class: "vs-status-add",
      title: "Add a new status",
      html: '<span class="sm-add-icon">+</span><span class="sm-add-label">Add Status</span>'
    });
    add.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const id = freshStatusId(statuses);
      const next = statuses.concat([{ id: id, name: "New Status", category: "doing" }]);
      commitStatuses(ctx, next);
    });
    wrap.appendChild(add);
    return wrap;
  }

  // ---- E23.C transition reorder + auto-sort -----------------------
  //
  // Two flavors: explicit DnD-driven reorder (pure helper, mirrors the
  // status one) AND auto-sort so transitions follow the status order after
  // any status reorder. User wants both: "Transitions sollten in der
  // gleichen Reihenfolge wie die Statuses erscheinen, wenn der Nutzer die
  // Statuses umsortiert hat."

  function reorderTransitions(allTransitions, sourceId, targetId, before) {
    if (sourceId === targetId) return allTransitions.slice();
    const fromIdx = allTransitions.findIndex(t => t.id === sourceId);
    if (fromIdx < 0) return allTransitions.slice();
    const next = allTransitions.slice();
    const [moved] = next.splice(fromIdx, 1);
    let insertAt = next.findIndex(t => t.id === targetId);
    if (insertAt < 0) insertAt = next.length;
    if (!before) insertAt += 1;
    next.splice(insertAt, 0, moved);
    return next;
  }

  function sortTransitionsByStatusOrder(transitions, statuses) {
    if (!Array.isArray(transitions) || transitions.length === 0) return [];
    const order = new Map();
    (statuses || []).forEach((s, i) => order.set(s.id, i));
    const indexOf = (tr) => order.has(tr.toStatus) ? order.get(tr.toStatus) : Number.MAX_SAFE_INTEGER;
    // Decorate with original index for stable sort, then sort, then strip.
    return transitions
      .map((tr, i) => ({ tr, orderKey: indexOf(tr), origIdx: i }))
      .sort((a, b) => (a.orderKey - b.orderKey) || (a.origIdx - b.origIdx))
      .map(x => x.tr);
  }

  // ---- E21.F transition editor ------------------------------------
  //
  // Pattern mirrors the status editor: live-apply on discrete actions, on-
  // blur for the name input. The source-multiselect lives in a sub-host
  // that toggles visibility based on `allowFromAny`.

  function commitTransitions(ctx, nextTransitions) {
    if (!ctx || !ctx.store) return;
    try {
      const cur = ctx.store.get().project.workflow || {};
      const nextWf = Object.assign({}, cur, { transitions: nextTransitions });
      ctx.store.updateProject({ workflow: nextWf }, LOCAL_ACTOR);
    } catch (err) {
      if (ctx.flashStatus) ctx.flashStatus(err.message || "save failed", { kind: "error" });
    }
  }

  function freshTransitionId(existing) {
    let i = 1;
    let candidate = "tr-" + i;
    const ids = new Set((existing || []).map(t => t.id));
    while (ids.has(candidate)) { i += 1; candidate = "tr-" + i; }
    return candidate;
  }

  // Build a patched transition by replacing one field. Pure for testability.
  function patchTransitionAt(allTransitions, idx, field, value) {
    const next = allTransitions.slice();
    next[idx] = Object.assign({}, next[idx], { [field]: value });
    return next;
  }

  function renderTransitionRow(tr, ctx, allStatuses, allTransitions, idx) {
    const row = el("div", {
      class: "vs-transition-row",
      dataset: { transitionId: tr.id }
    });

    // Header line: grip + name + delete (delete on the right).
    const header = el("div", { class: "vs-transition-header" });
    const grip = el("span", { class: "vs-grip", text: "⋮⋮", title: "Drag to reorder" });
    const nameInput = el("input", {
      type: "text",
      class: "vs-transition-name",
      value: tr.name,
      placeholder: "Transition name"
    });
    nameInput.addEventListener("blur", () => {
      const v = String(nameInput.value || "").trim();
      if (!v || v === tr.name) { nameInput.value = tr.name; return; }
      commitTransitions(ctx, patchTransitionAt(allTransitions, idx, "name", v));
    });
    const delBtn = el("button", {
      class: "vs-transition-delete",
      title: "Delete transition",
      text: "×"
    });
    delBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const next = allTransitions.filter((_, i) => i !== idx);
      commitTransitions(ctx, next);
    });
    header.appendChild(grip);
    header.appendChild(nameInput);
    header.appendChild(delBtn);

    // Body line: target + gate + allow-from-any toggle.
    const body = el("div", { class: "vs-transition-body" });
    const arrow = el("span", { class: "vs-transition-arrow", text: "→" });
    const targetSel = el("select", { class: "vs-transition-target", title: "Target status" });
    for (const s of allStatuses) {
      const opt = el("option", { value: s.id, text: s.name || s.id });
      if (s.id === tr.toStatus) opt.selected = true;
      targetSel.appendChild(opt);
    }
    targetSel.addEventListener("change", () => {
      commitTransitions(ctx, patchTransitionAt(allTransitions, idx, "toStatus", targetSel.value));
    });

    const gateLabel = el("span", { class: "vs-transition-gate-label", text: "Gate:" });
    const gateSel = el("select", { class: "vs-transition-gate", title: "Gate to enforce" });
    for (const g of ["", "DoR", "DoD"]) {
      const opt = el("option", { value: g, text: g || "None" });
      if ((tr.requireGate || "") === g) opt.selected = true;
      gateSel.appendChild(opt);
    }
    gateSel.addEventListener("change", () => {
      const v = gateSel.value === "" ? null : gateSel.value;
      commitTransitions(ctx, patchTransitionAt(allTransitions, idx, "requireGate", v));
    });

    const anyWrap = el("label", { class: "vs-transition-any-wrap", title: "Allow from any source status" });
    const anyCb = el("input", { type: "checkbox", class: "vs-transition-any" });
    anyCb.checked = !!tr.allowFromAny;
    anyCb.addEventListener("change", () => {
      commitTransitions(ctx, patchTransitionAt(allTransitions, idx, "allowFromAny", anyCb.checked));
    });
    anyWrap.appendChild(anyCb);
    anyWrap.appendChild(document.createTextNode(" From any"));

    body.appendChild(arrow);
    body.appendChild(targetSel);
    body.appendChild(gateLabel);
    body.appendChild(gateSel);
    body.appendChild(anyWrap);

    // Sources sub-section: one checkbox per status. Visible only when the
    // transition is NOT allowFromAny.
    const sources = el("div", {
      class: "vs-transition-sources",
      dataset: { hint: "Pick source statuses" }
    });
    sources.hidden = !!tr.allowFromAny;
    const fromSet = new Set(tr.fromStatuses || []);
    for (const s of allStatuses) {
      const lbl = el("label", { class: "vs-transition-source-item" });
      const cbx = el("input", { type: "checkbox", dataset: { sourceId: s.id } });
      cbx.checked = fromSet.has(s.id);
      cbx.addEventListener("change", () => {
        // Collect every checked source checkbox in this row's source host
        // and commit the resulting array — using the DOM as source-of-truth
        // is robust against fast multi-clicks before a rerender.
        const checked = Array.from(sources.querySelectorAll("input[type='checkbox']"))
          .filter(c => c.checked).map(c => c.dataset.sourceId);
        commitTransitions(ctx, patchTransitionAt(allTransitions, idx, "fromStatuses", checked));
      });
      lbl.appendChild(cbx);
      lbl.appendChild(document.createTextNode(" " + (s.name || s.id)));
      sources.appendChild(lbl);
    }

    row.appendChild(header);
    row.appendChild(body);
    row.appendChild(sources);

    // E23.C — DnD-Reorder analog to the status editor.
    if (dnd && typeof dnd.enableDraggable === "function") {
      dnd.enableDraggable(row, { dragType: "vs-transition", dragId: tr.id });
      dnd.enableDropTarget(row, {
        accepts: ["vs-transition"],
        onEnter: (e) => e.classList.add("vs-transition-drop-target"),
        onLeave: (e) => e.classList.remove("vs-transition-drop-target"),
        onDrop: ({ id, event }) => {
          row.classList.remove("vs-transition-drop-target");
          if (id === tr.id) return;
          const rect = row.getBoundingClientRect();
          const before = (event && typeof event.clientY === "number")
            ? event.clientY < rect.top + rect.height / 2 : true;
          const next = reorderTransitions(allTransitions, id, tr.id, before);
          commitTransitions(ctx, next);
        }
      });
    }
    return row;
  }

  function renderTransitionEditor(workflow, ctx) {
    const statuses = (workflow && workflow.statuses) || [];
    const rawTransitions = Array.isArray(workflow && workflow.transitions) ? workflow.transitions : [];
    // E23.C: display-time sort by status order. Persisted order in the
    // snapshot is left untouched; render simply projects the visual order
    // that matches the user's mental model ("transitions follow statuses").
    const transitions = sortTransitionsByStatusOrder(rawTransitions, statuses);
    const wrap = el("div", { class: "vs-transition-editor" });
    const rowsHost = el("div", { class: "vs-transition-rows" });
    transitions.forEach((tr, idx) => {
      rowsHost.appendChild(renderTransitionRow(tr, ctx, statuses, transitions, idx));
    });
    wrap.appendChild(rowsHost);
    const add = el("button", {
      class: "vs-transition-add",
      title: "Add a new transition",
      html: '<span class="sm-add-icon">+</span><span class="sm-add-label">Add Transition</span>'
    });
    add.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const id = freshTransitionId(transitions);
      // Default target: first status. requireGate=null, allowFromAny=true.
      const firstStatusId = statuses[0] ? statuses[0].id : "";
      const newTr = {
        id: id,
        name: "New Transition",
        fromStatuses: [],
        toStatus: firstStatusId,
        requireGate: null,
        allowFromAny: true
      };
      commitTransitions(ctx, transitions.concat([newTr]));
    });
    wrap.appendChild(add);
    return wrap;
  }

  function renderWorkflowSection(project, ctx) {
    const wf = (project && project.workflow) || core.STORYMAPPER_DEFAULT_WORKFLOW;
    return el("section", { class: "vs-section", dataset: { section: "workflow" } },
      el("header", { class: "vs-section-header" },
        el("h2", { text: "Workflow" }),
        el("p", { class: "vs-section-hint",
          text: "Statuses + transitions between them. Drag to reorder, pick a category, click + to add." })
      ),
      el("div", { class: "vs-section-body" },
        el("h3", { class: "vs-subhead", text: "Statuses" }),
        renderStatusEditor(wf, ctx),
        el("h3", { class: "vs-subhead", text: "Transitions" }),
        renderTransitionEditor(wf, ctx)
      )
    );
  }

  // ---- E21.G board editor -----------------------------------------
  //
  // Edits `project.boards.kanban.columns`. UI: per column a card with name
  // input, status-chip list, and delete button. Above the columns a
  // bucket of "unassigned" status chips (statuses not in any column).
  // Status chips are draggable between buckets — each drop reassigns the
  // status to exactly one column.

  function commitBoardColumns(ctx, nextColumns) {
    if (!ctx || !ctx.store) return;
    try {
      const cur = ctx.store.get().project.boards || {};
      const nextKanban = Object.assign({}, cur.kanban || {}, { columns: nextColumns });
      const nextBoards = Object.assign({}, cur, { kanban: nextKanban });
      ctx.store.updateProject({ boards: nextBoards }, LOCAL_ACTOR);
    } catch (err) {
      if (ctx.flashStatus) ctx.flashStatus(err.message || "save failed", { kind: "error" });
    }
  }

  function freshColumnId(existing) {
    let i = 1;
    let candidate = "col-" + i;
    const ids = new Set((existing || []).map(c => c.id));
    while (ids.has(candidate)) { i += 1; candidate = "col-" + i; }
    return candidate;
  }

  // Pure: ensure statusId lives only inside targetColumnId. No-op when the
  // status was already in the target (preserves its existing position).
  function assignStatusToColumn(columns, statusId, targetColumnId) {
    return columns.map(c => {
      if (c.id === targetColumnId) {
        const ids = c.statusIds || [];
        // Already there → keep order untouched (functional no-op).
        if (ids.includes(statusId)) return Object.assign({}, c, { statusIds: ids.slice() });
        return Object.assign({}, c, { statusIds: ids.concat([statusId]) });
      }
      // Non-target: strip the status (no-op if it wasn't here).
      return Object.assign({}, c, {
        statusIds: (c.statusIds || []).filter(s => s !== statusId)
      });
    });
  }

  // Pure: status entries from the workflow that are NOT in any column.
  function unassignedStatuses(statuses, columns) {
    const assigned = new Set((columns || []).flatMap(c => c.statusIds || []));
    return (statuses || []).filter(s => !assigned.has(s.id));
  }

  function renderStatusChip(status, ctx) {
    const chip = el("span", {
      class: "vs-board-chip",
      dataset: { statusId: status.id, statusCategory: status.category || "doing" },
      text: status.name || status.id
    });
    if (dnd && typeof dnd.enableDraggable === "function") {
      dnd.enableDraggable(chip, { dragType: "vs-board-status", dragId: status.id });
    }
    return chip;
  }

  function renderBoardColumn(col, ctx, statuses, allColumns) {
    const card = el("div", {
      class: "vs-board-column",
      dataset: { columnId: col.id }
    });
    const header = el("div", { class: "vs-board-column-header" });
    const nameInput = el("input", {
      type: "text",
      class: "vs-board-column-name",
      value: col.name || "",
      placeholder: "Column name"
    });
    nameInput.addEventListener("blur", () => {
      const v = String(nameInput.value || "").trim();
      if (!v || v === col.name) { nameInput.value = col.name || ""; return; }
      const next = allColumns.map(c => c.id === col.id ? Object.assign({}, c, { name: v }) : c);
      commitBoardColumns(ctx, next);
    });
    const delBtn = el("button", {
      class: "vs-board-column-delete",
      title: "Delete column (statuses become unassigned)",
      text: "×"
    });
    delBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const next = allColumns.filter(c => c.id !== col.id);
      commitBoardColumns(ctx, next);
    });
    header.appendChild(nameInput);
    header.appendChild(delBtn);
    card.appendChild(header);

    // Status chips inside the column. We render them in the order they
    // appear in column.statusIds (caller can rearrange via drag in the
    // future; for now order tracks insertion).
    const chipsHost = el("div", { class: "vs-board-chips" });
    const byStatusId = new Map(statuses.map(s => [s.id, s]));
    for (const sid of (col.statusIds || [])) {
      const s = byStatusId.get(sid);
      if (!s) continue;   // stale ref — normalize will drop it
      chipsHost.appendChild(renderStatusChip(s, ctx));
    }
    card.appendChild(chipsHost);

    // Column is a drop target — dropping a chip here reassigns it.
    if (dnd && typeof dnd.enableDropTarget === "function") {
      dnd.enableDropTarget(card, {
        accepts: ["vs-board-status"],
        onEnter: (e) => e.classList.add("vs-board-drop-target"),
        onLeave: (e) => e.classList.remove("vs-board-drop-target"),
        onDrop: ({ id }) => {
          card.classList.remove("vs-board-drop-target");
          const next = assignStatusToColumn(allColumns, id, col.id);
          commitBoardColumns(ctx, next);
        }
      });
    }
    return card;
  }

  function renderBoardEditor(project, ctx) {
    const statuses = (project.workflow && project.workflow.statuses) || [];
    const columns = (project.boards && project.boards.kanban && project.boards.kanban.columns) || [];
    const wrap = el("div", { class: "vs-board-editor" });

    // Unassigned bucket — shows statuses that aren't in any column. Also a
    // drop target: dropping a chip here removes it from all columns.
    const orphans = unassignedStatuses(statuses, columns);
    const bucket = el("div", { class: "vs-board-unassigned" });
    const bucketLabel = el("div", { class: "vs-board-unassigned-label",
      text: "Unassigned statuses" });
    const bucketChips = el("div", { class: "vs-board-chips" });
    for (const s of orphans) bucketChips.appendChild(renderStatusChip(s, ctx));
    if (orphans.length === 0) {
      bucketChips.appendChild(el("span", { class: "vs-board-empty",
        text: "Every status is mapped to a column." }));
    }
    bucket.appendChild(bucketLabel);
    bucket.appendChild(bucketChips);
    // Drop-target: "remove from every column" by mapping to a sentinel id
    // that doesn't exist → assignStatusToColumn just strips it.
    if (dnd && typeof dnd.enableDropTarget === "function") {
      dnd.enableDropTarget(bucket, {
        accepts: ["vs-board-status"],
        onEnter: (e) => e.classList.add("vs-board-drop-target"),
        onLeave: (e) => e.classList.remove("vs-board-drop-target"),
        onDrop: ({ id }) => {
          bucket.classList.remove("vs-board-drop-target");
          // Strip the status from all columns; no target column means
          // nothing is appended → status becomes unassigned.
          const next = columns.map(c => Object.assign({}, c, {
            statusIds: (c.statusIds || []).filter(s => s !== id)
          }));
          commitBoardColumns(ctx, next);
        }
      });
    }
    wrap.appendChild(bucket);

    // Columns row.
    const colsHost = el("div", { class: "vs-board-columns" });
    for (const c of columns) {
      colsHost.appendChild(renderBoardColumn(c, ctx, statuses, columns));
    }
    wrap.appendChild(colsHost);

    // Add column.
    const add = el("button", {
      class: "vs-board-add-column",
      title: "Add a new column",
      html: '<span class="sm-add-icon">+</span><span class="sm-add-label">Add Column</span>'
    });
    add.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const id = freshColumnId(columns);
      const next = columns.concat([{ id: id, name: "New Column", statusIds: [] }]);
      commitBoardColumns(ctx, next);
    });
    wrap.appendChild(add);
    return wrap;
  }

  function renderBoardSection(project, ctx) {
    return el("section", { class: "vs-section", dataset: { section: "board" } },
      el("header", { class: "vs-section-header" },
        el("h2", { text: "Kanban Board" }),
        el("p", { class: "vs-section-hint",
          text: "Group statuses into Kanban columns. Drag a status chip between buckets to remap." })
      ),
      el("div", { class: "vs-section-body" },
        renderBoardEditor(project, ctx)
      )
    );
  }

  // ---- SM-47: Link-Types editor ----------------------------------------
  //
  // List the project's linkTypes catalogue with inline-editable label and
  // inverseLabel inputs, semantic-picker dropdown, color-picker, and
  // delete-button. Same live-apply pattern as the rest of view-settings:
  // discrete actions (add/remove/semantic-change/color-change) commit
  // immediately; text inputs commit on-blur (caret-stable across the
  // rerender via focus-guard in renderInto).

  function commitLinkTypes(ctx, nextLinkTypes) {
    if (!ctx || !ctx.store) return;
    try {
      ctx.store.updateProject({ linkTypes: nextLinkTypes }, LOCAL_ACTOR);
    } catch (err) {
      if (ctx.flashStatus) ctx.flashStatus(err.message || "save failed", { kind: "error" });
    }
  }

  function renderLinkTypeRow(lt, ctx, allLinkTypes, idx) {
    const row = el("div", { class: "vs-linktype-row", dataset: { linktypeId: lt.id } });

    const idDisp = el("span", { class: "vs-linktype-id", text: lt.id, title: "Stable ID (referenced by links — not editable)" });

    const labelInput = el("input", { type: "text", class: "vs-linktype-label", value: lt.label });
    labelInput.addEventListener("blur", () => {
      const v = String(labelInput.value || "").trim();
      if (!v || v === lt.label) { labelInput.value = lt.label; return; }
      const next = allLinkTypes.slice();
      next[idx] = Object.assign({}, lt, { label: v });
      commitLinkTypes(ctx, next);
    });

    const inverseInput = el("input", { type: "text", class: "vs-linktype-inverse", value: lt.inverseLabel });
    inverseInput.addEventListener("blur", () => {
      const v = String(inverseInput.value || "").trim();
      if (!v || v === lt.inverseLabel) { inverseInput.value = lt.inverseLabel; return; }
      const next = allLinkTypes.slice();
      next[idx] = Object.assign({}, lt, { inverseLabel: v });
      commitLinkTypes(ctx, next);
    });

    const semSelect = el("select", { class: "vs-linktype-semantic" });
    const semantics = (core.LINK_SEMANTICS || ["precedence", "blocking", "sequence", "containment", "validation", "freeform"]);
    for (const sem of semantics) {
      const opt = el("option", { value: sem, text: sem });
      if (sem === lt.semantic) opt.selected = true;
      semSelect.appendChild(opt);
    }
    semSelect.addEventListener("change", () => {
      const next = allLinkTypes.slice();
      next[idx] = Object.assign({}, lt, { semantic: semSelect.value });
      commitLinkTypes(ctx, next);
    });

    const colorInput = el("input", { type: "color", class: "vs-linktype-color", value: lt.color || "#888888" });
    colorInput.addEventListener("change", () => {
      const next = allLinkTypes.slice();
      next[idx] = Object.assign({}, lt, { color: colorInput.value });
      commitLinkTypes(ctx, next);
    });

    const delBtn = el("button", { class: "vs-linktype-delete", title: "Delete link type", text: "×" });
    delBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      // Confirm if the link-type is currently referenced by any link.
      const snap = ctx.store ? ctx.store.get() : null;
      let inUse = 0;
      if (snap) {
        for (const t of snap.tickets || []) {
          for (const l of t.links || []) if (l.linkTypeId === lt.id) inUse++;
        }
      }
      if (inUse > 0 && typeof confirm === "function") {
        if (!confirm("Link type \"" + lt.label + "\" is used in " + inUse + " link(s). Delete anyway? The links themselves stay but lose their resolved label.")) return;
      }
      const next = allLinkTypes.filter((_, i) => i !== idx);
      commitLinkTypes(ctx, next);
    });

    row.appendChild(idDisp);
    row.appendChild(labelInput);
    row.appendChild(inverseInput);
    row.appendChild(semSelect);
    row.appendChild(colorInput);
    row.appendChild(delBtn);
    return row;
  }

  function renderLinkTypeAddRow(ctx, allLinkTypes) {
    const wrap = el("div", { class: "vs-linktype-add-wrap" });
    const btn = el("button", { class: "btn vs-linktype-add", text: "+ Add Link Type" });
    btn.addEventListener("click", () => {
      // Generate a unique id (custom-N).
      let n = 1, newId = "custom-" + n;
      while (allLinkTypes.some(lt => lt.id === newId)) { n++; newId = "custom-" + n; }
      const next = allLinkTypes.concat([{
        id: newId, label: "Custom " + n, inverseLabel: "Custom " + n, semantic: "freeform"
      }]);
      commitLinkTypes(ctx, next);
    });
    wrap.appendChild(btn);
    return wrap;
  }

  function renderLinkTypesEditor(project, ctx) {
    const linkTypes = (project && project.linkTypes) || [];
    const wrap = el("div", { class: "vs-linktypes-editor" });
    // Column headers (above the rows) so labels are self-documenting.
    const head = el("div", { class: "vs-linktype-row vs-linktype-head" });
    head.appendChild(el("span", { class: "vs-linktype-id", text: "ID" }));
    head.appendChild(el("span", { class: "vs-linktype-col-label", text: "Label" }));
    head.appendChild(el("span", { class: "vs-linktype-col-label", text: "Inverse label" }));
    head.appendChild(el("span", { class: "vs-linktype-col-label", text: "Semantic" }));
    head.appendChild(el("span", { class: "vs-linktype-col-label", text: "Color" }));
    head.appendChild(el("span", { class: "vs-linktype-col-label", text: "" }));
    wrap.appendChild(head);
    const rowsHost = el("div", { class: "vs-linktype-rows" });
    linkTypes.forEach((lt, i) => rowsHost.appendChild(renderLinkTypeRow(lt, ctx, linkTypes, i)));
    wrap.appendChild(rowsHost);
    wrap.appendChild(renderLinkTypeAddRow(ctx, linkTypes));
    return wrap;
  }

  function renderLinkTypesSection(project, ctx) {
    return el("section", { class: "vs-section", dataset: { section: "links" } },
      el("header", { class: "vs-section-header" },
        el("h2", { text: "Link Types" }),
        el("p", { class: "vs-section-hint",
          text: "Typed relations between tickets (predecessor, blocks, contains, …). The semantic controls runtime behaviour (cycle-check) and inverse-label rendering. Deleting a type doesn't delete its links — they stay but lose the catalogue-resolved label." })
      ),
      el("div", { class: "vs-section-body" },
        renderLinkTypesEditor(project, ctx)
      )
    );
  }

  // ---- SM-7: Ticket-Types editor ---------------------------------------
  //
  // project.ticketTypes is a simple string[] (e.g. ["epic", "user-story",
  // "bug", "technical-task-backend", "technical-task-ui"]). The editor is
  // a sortable list of name inputs with on-blur rename, + Add, ×, and DnD-
  // reorder. Live-apply: every discrete action commits via store.updateProject.
  // normalizeProject reseeds defaults if the list ends up empty, which
  // protects against lock-out — but we still confirm deletion when the user
  // tries to remove a type that's currently in use.

  function commitTicketTypes(ctx, nextTypes) {
    if (!ctx || !ctx.store) return;
    try {
      ctx.store.updateProject({ ticketTypes: nextTypes }, LOCAL_ACTOR);
    } catch (err) {
      if (ctx.flashStatus) ctx.flashStatus(err.message || "save failed", { kind: "error" });
    }
  }

  function countTicketsOfType(snapshot, typeName) {
    if (!snapshot) return 0;
    let n = 0;
    for (const t of (snapshot.tickets || [])) if (t.type === typeName && !t.isDeleted) n++;
    return n;
  }

  function renderTicketTypeRow(typeName, ctx, allTypes, idx) {
    const row = el("div", { class: "vs-tickettype-row", dataset: { typeName: typeName } });
    row.appendChild(el("span", { class: "vs-grip", text: "⋮⋮" }));
    const input = el("input", { type: "text", class: "vs-tickettype-name", value: typeName });
    input.addEventListener("blur", () => {
      const v = String(input.value || "").trim();
      if (!v || v === typeName) { input.value = typeName; return; }
      if (allTypes.indexOf(v) >= 0 && v !== typeName) {
        if (ctx.flashStatus) ctx.flashStatus("type \"" + v + "\" already exists", { kind: "error" });
        input.value = typeName;
        return;
      }
      const next = allTypes.slice();
      next[idx] = v;
      commitTicketTypes(ctx, next);
    });

    const del = el("button", { class: "vs-tickettype-delete", title: "Delete ticket type", text: "×" });
    del.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const snap = ctx.store ? ctx.store.get() : null;
      const inUse = countTicketsOfType(snap, typeName);
      if (inUse > 0 && typeof confirm === "function") {
        if (!confirm("Ticket type \"" + typeName + "\" is used by " + inUse + " ticket(s). They will keep their type label even after deletion. Delete anyway?")) return;
      }
      const next = allTypes.filter((_, i) => i !== idx);
      commitTicketTypes(ctx, next);
    });

    row.appendChild(input);
    row.appendChild(del);
    return row;
  }

  function reorderTicketTypes(types, sourceName, targetName, before) {
    const list = types.slice();
    const srcIdx = list.indexOf(sourceName);
    if (srcIdx < 0) return list;
    const [moved] = list.splice(srcIdx, 1);
    let dstIdx = list.indexOf(targetName);
    if (dstIdx < 0) { list.push(moved); return list; }
    list.splice(before ? dstIdx : dstIdx + 1, 0, moved);
    return list;
  }

  function attachTicketTypeRowDnD(row, typeName, allTypes, ctx) {
    if (!dnd) return;
    dnd.enableDraggable(row, { dragType: "vs-tickettype", dragId: typeName });
    dnd.enableDropTarget(row, {
      accepts: ["vs-tickettype"],
      onMove: (info) => {
        if (info.draggedId === typeName) return;
        row.classList.add("vs-tickettype-drop-target");
      },
      onLeave: () => row.classList.remove("vs-tickettype-drop-target"),
      onDrop: (info) => {
        row.classList.remove("vs-tickettype-drop-target");
        if (info.draggedId === typeName) return;
        const rect = row.getBoundingClientRect();
        const before = info.clientY < rect.top + rect.height / 2;
        const next = reorderTicketTypes(allTypes, info.draggedId, typeName, before);
        commitTicketTypes(ctx, next);
      }
    });
  }

  function renderTicketTypesEditor(project, ctx) {
    const types = (project && project.ticketTypes) || [];
    const wrap = el("div", { class: "vs-tickettypes-editor" });
    const rowsHost = el("div", { class: "vs-tickettype-rows" });
    types.forEach((name, i) => {
      const row = renderTicketTypeRow(name, ctx, types, i);
      attachTicketTypeRowDnD(row, name, types, ctx);
      rowsHost.appendChild(row);
    });
    wrap.appendChild(rowsHost);
    const addBtn = el("button", { class: "btn vs-tickettype-add", text: "+ Add Ticket Type" });
    addBtn.addEventListener("click", () => {
      let n = 1, name = "custom-type-" + n;
      while (types.indexOf(name) >= 0) { n++; name = "custom-type-" + n; }
      commitTicketTypes(ctx, types.concat([name]));
    });
    wrap.appendChild(addBtn);
    return wrap;
  }

  function renderTicketTypesSection(project, ctx) {
    return el("section", { class: "vs-section", dataset: { section: "types" } },
      el("header", { class: "vs-section-header" },
        el("h2", { text: "Ticket Types" }),
        el("p", { class: "vs-section-hint",
          text: "The types tickets can have (epic / user-story / bug / …). Rename on blur. Deleting a type does not retype the tickets that use it. If the list becomes empty, the default set is reseeded automatically." })
      ),
      el("div", { class: "vs-section-body" },
        renderTicketTypesEditor(project, ctx)
      )
    );
  }

  // ---- SM-9: Type Config editor (entityTypeConfig per ticket-type) -----
  //
  // project.entityTypeConfig maps ticket-type → flags that govern what the
  // ticket-detail modal shows or allows. Defaults: every flag = true except
  // allowParentEpic = false for type === "epic" (epics never nest under
  // an epic). The editor: type-picker dropdown + 7 toggles. Live-apply:
  // each toggle change commits via store.updateProject. The type "epic"
  // is special — its allowParentEpic toggle is always disabled (engine
  // hard-codes false), surfaced as a read-only marker.

  // Module-state: which type is currently being edited. Resets to first
  // ticketType on every fresh mount.
  let _typeConfigSelectedType = null;

  const TYPE_CONFIG_FLAGS = [
    { key: "allowParentEpic",        label: "Allow parent epic",
      hint: "Ticket may live under an epic via the contains-link." },
    { key: "showAcceptanceCriteria", label: "Show acceptance criteria",
      hint: "Section appears in the ticket detail modal." },
    { key: "showDefinitionOfReady",  label: "Show Definition of Ready",
      hint: "DoR checklist section appears in the modal." },
    { key: "showDefinitionOfDone",   label: "Show Definition of Done",
      hint: "DoD checklist section appears in the modal." },
    { key: "showRelease",            label: "Show release picker",
      hint: "Release dropdown appears in the position fields." },
    { key: "showProcessStep",        label: "Show process-step picker",
      hint: "Process-step dropdown appears in the position fields." },
    { key: "showLinks",              label: "Show links section",
      hint: "Links section appears in the modal (forward + backward)." },
    // SM-59 — test-type sections. SM-100: only offered for the matching test
    // type; the engine hard-locks them to false for every other type, so
    // showing the toggle elsewhere would just confuse the user.
    { key: "showPrerequisites",      label: "Show prerequisites",
      hint: "Prerequisites checklist appears in the modal.",
      appliesTo: ["test-definition"] },
    { key: "showSteps",              label: "Show steps editor",
      hint: "3-column step table (Step / Data / Expected).",
      appliesTo: ["test-definition"] },
    { key: "showExecutionSteps",     label: "Show execution steps",
      hint: "6-column run table with actual + status + note.",
      appliesTo: ["test-execution"] },
    { key: "showTestOutcome",        label: "Show outcome section",
      hint: "Derived outcome + manual override picker.",
      appliesTo: ["test-execution"] }
  ];

  function commitTypeConfig(ctx, nextConfig) {
    if (!ctx || !ctx.store) return;
    try {
      ctx.store.updateProject({ entityTypeConfig: nextConfig }, LOCAL_ACTOR);
    } catch (err) {
      if (ctx.flashStatus) ctx.flashStatus(err.message || "save failed", { kind: "error" });
    }
  }

  function renderTypeConfigEditor(project, ctx) {
    const wrap = el("div", { class: "vs-typeconfig-editor" });
    const types = (project && project.ticketTypes) || [];
    if (!types.length) {
      wrap.appendChild(el("div", { class: "vs-empty",
        text: "No ticket types defined yet — add some in the Ticket Types tab first." }));
      return wrap;
    }
    // Choose the type to edit. Default to the first ticketType; preserve
    // user selection across rerenders so an external commit doesn't drop them.
    if (!_typeConfigSelectedType || types.indexOf(_typeConfigSelectedType) < 0) {
      _typeConfigSelectedType = types[0];
    }
    const currentType = _typeConfigSelectedType;

    // Type-picker row.
    const pickerRow = el("div", { class: "vs-typeconfig-picker-row" });
    pickerRow.appendChild(el("label", { class: "tm-label", text: "Type" }));
    const picker = el("select", { class: "vs-typeconfig-type-select" });
    for (const t of types) {
      const opt = el("option", { value: t, text: t });
      if (t === currentType) opt.selected = true;
      picker.appendChild(opt);
    }
    picker.addEventListener("change", () => {
      _typeConfigSelectedType = picker.value;
      // Re-render the editor to reflect the new selection.
      const newEditor = renderTypeConfigEditor(project, ctx);
      wrap.parentNode.replaceChild(newEditor, wrap);
    });
    pickerRow.appendChild(picker);
    wrap.appendChild(pickerRow);

    // Resolve the effective config so defaults render correctly when a type
    // has no override yet.
    const effective = (typeof core.getEntityTypeConfig === "function")
      ? core.getEntityTypeConfig(project, currentType)
      : null;
    if (!effective) {
      wrap.appendChild(el("div", { class: "vs-empty", text: "Core helper missing." }));
      return wrap;
    }

    // Flag-toggle list.
    const flagList = el("div", { class: "vs-typeconfig-flags" });
    for (const flag of TYPE_CONFIG_FLAGS) {
      // SM-100: test-flags only render for their matching type. The engine
      // hard-locks them to false elsewhere, so showing the control would
      // mislead the user into thinking it could be flipped.
      if (flag.appliesTo && flag.appliesTo.indexOf(currentType) < 0) continue;
      // Epic-special: allowParentEpic is hard-coded false for type "epic".
      const isEpicLock = (currentType === "epic" && flag.key === "allowParentEpic");
      const row = el("div", { class: "vs-typeconfig-flag" + (isEpicLock ? " vs-typeconfig-flag-locked" : ""),
        dataset: { flagKey: flag.key } });
      const cb = el("input", { type: "checkbox", class: "vs-typeconfig-flag-input" });
      cb.checked = effective[flag.key] !== false;
      if (isEpicLock) cb.disabled = true;
      cb.addEventListener("change", () => {
        // Read the current override (if any) so we patch onto it; otherwise
        // start fresh from the defaults.
        const allCfg = Object.assign({}, project.entityTypeConfig || {});
        const typeCfg = Object.assign({}, allCfg[currentType] || {});
        typeCfg[flag.key] = !!cb.checked;
        allCfg[currentType] = typeCfg;
        commitTypeConfig(ctx, allCfg);
      });
      const lbl = el("label", { class: "vs-typeconfig-flag-label" });
      lbl.appendChild(cb);
      lbl.appendChild(el("span", { class: "vs-typeconfig-flag-text", text: flag.label }));
      row.appendChild(lbl);
      if (flag.hint) row.appendChild(el("div", { class: "vs-typeconfig-flag-hint", text: flag.hint }));
      if (isEpicLock) row.appendChild(el("div", { class: "vs-typeconfig-flag-locked-note",
        text: "Locked: epics never nest under another epic." }));
      flagList.appendChild(row);
    }
    wrap.appendChild(flagList);
    return wrap;
  }

  function renderTypeConfigSection(project, ctx) {
    return el("section", { class: "vs-section", dataset: { section: "typeconfig" } },
      el("header", { class: "vs-section-header" },
        el("h2", { text: "Type Config" }),
        el("p", { class: "vs-section-hint",
          text: "Per ticket-type: which sections appear in the detail modal and whether the type may live under an epic. Pick a type above, toggle the flags — changes apply live to every modal of that type." })
      ),
      el("div", { class: "vs-section-body" },
        renderTypeConfigEditor(project, ctx)
      )
    );
  }

  // ---- SM-8: Labels editor ---------------------------------------------
  //
  // project.labels is normalized to `[{id, name, color}]`. ticket.labels
  // remains a string[] of label-names — the modal renders ticket labels
  // by looking up the catalogue color via name match. Editor: sortable
  // rows with name-input (on-blur), color-picker (on-change), delete (with
  // confirm if labels are referenced).

  function commitLabels(ctx, nextLabels) {
    if (!ctx || !ctx.store) return;
    try {
      ctx.store.updateProject({ labels: nextLabels }, LOCAL_ACTOR);
    } catch (err) {
      if (ctx.flashStatus) ctx.flashStatus(err.message || "save failed", { kind: "error" });
    }
  }

  function countLabelUses(snapshot, labelName) {
    if (!snapshot) return 0;
    let n = 0;
    for (const t of (snapshot.tickets || [])) {
      if (t.isDeleted) continue;
      const labels = t.labels || [];
      for (const l of labels) {
        const lname = typeof l === "string" ? l : (l && l.name) || "";
        if (lname === labelName) { n++; break; }
      }
    }
    return n;
  }

  function renderLabelRow(label, ctx, allLabels, idx) {
    const row = el("div", { class: "vs-label-row", dataset: { labelId: label.id } });
    row.appendChild(el("span", { class: "vs-grip", text: "⋮⋮" }));

    const swatch = el("span", { class: "vs-label-swatch" });
    swatch.style.backgroundColor = label.color || "#999999";

    const nameInput = el("input", { type: "text", class: "vs-label-name", value: label.name });
    nameInput.addEventListener("blur", () => {
      const v = String(nameInput.value || "").trim();
      if (!v || v === label.name) { nameInput.value = label.name; return; }
      const next = allLabels.slice();
      next[idx] = Object.assign({}, label, { name: v });
      commitLabels(ctx, next);
    });

    const colorInput = el("input", { type: "color", class: "vs-label-color", value: label.color || "#999999" });
    colorInput.addEventListener("change", () => {
      const next = allLabels.slice();
      next[idx] = Object.assign({}, label, { color: colorInput.value });
      commitLabels(ctx, next);
    });

    const del = el("button", { class: "vs-label-delete", title: "Delete label", text: "×" });
    del.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const snap = ctx.store ? ctx.store.get() : null;
      const inUse = countLabelUses(snap, label.name);
      if (inUse > 0 && typeof confirm === "function") {
        if (!confirm("Label \"" + label.name + "\" is used on " + inUse + " ticket(s). Delete from the catalogue? Tickets keep the label string but lose the color.")) return;
      }
      const next = allLabels.filter((_, i) => i !== idx);
      commitLabels(ctx, next);
    });

    row.appendChild(swatch);
    row.appendChild(nameInput);
    row.appendChild(colorInput);
    row.appendChild(del);
    return row;
  }

  function reorderLabels(labels, sourceId, targetId, before) {
    const list = labels.slice();
    const srcIdx = list.findIndex(l => l.id === sourceId);
    if (srcIdx < 0) return list;
    const [moved] = list.splice(srcIdx, 1);
    let dstIdx = list.findIndex(l => l.id === targetId);
    if (dstIdx < 0) { list.push(moved); return list; }
    list.splice(before ? dstIdx : dstIdx + 1, 0, moved);
    return list;
  }

  function attachLabelRowDnD(row, label, allLabels, ctx) {
    if (!dnd) return;
    dnd.enableDraggable(row, { dragType: "vs-label", dragId: label.id });
    dnd.enableDropTarget(row, {
      accepts: ["vs-label"],
      onMove: (info) => {
        if (info.draggedId === label.id) return;
        row.classList.add("vs-label-drop-target");
      },
      onLeave: () => row.classList.remove("vs-label-drop-target"),
      onDrop: (info) => {
        row.classList.remove("vs-label-drop-target");
        if (info.draggedId === label.id) return;
        const rect = row.getBoundingClientRect();
        const before = info.clientY < rect.top + rect.height / 2;
        const next = reorderLabels(allLabels, info.draggedId, label.id, before);
        commitLabels(ctx, next);
      }
    });
  }

  function renderLabelsEditor(project, ctx) {
    const labels = (project && project.labels) || [];
    const wrap = el("div", { class: "vs-labels-editor" });
    if (!labels.length) {
      wrap.appendChild(el("div", { class: "vs-empty",
        text: "No labels yet. Add one below — they'll become available in the ticket-detail modal's Labels field." }));
    }
    const rowsHost = el("div", { class: "vs-label-rows" });
    labels.forEach((label, i) => {
      const row = renderLabelRow(label, ctx, labels, i);
      attachLabelRowDnD(row, label, labels, ctx);
      rowsHost.appendChild(row);
    });
    wrap.appendChild(rowsHost);
    const addBtn = el("button", { class: "btn vs-label-add", text: "+ Add Label" });
    addBtn.addEventListener("click", () => {
      let n = 1, name = "label-" + n;
      while (labels.some(l => l.name === name)) { n++; name = "label-" + n; }
      commitLabels(ctx, labels.concat([{ name: name, color: "#999999" }]));
    });
    wrap.appendChild(addBtn);
    return wrap;
  }

  function renderLabelsSection(project, ctx) {
    return el("section", { class: "vs-section", dataset: { section: "labels" } },
      el("header", { class: "vs-section-header" },
        el("h2", { text: "Labels" }),
        el("p", { class: "vs-section-hint",
          text: "Catalogue of labels (name + color) that can be applied to tickets. Tickets reference labels by name — renaming here does not retroactively update existing tickets." })
      ),
      el("div", { class: "vs-section-body" },
        renderLabelsEditor(project, ctx)
      )
    );
  }

  // ---- SM-2: DoR/DoD definitions editor ----------------------------
  //
  // Ported from the deprecated dialog-definitions-settings.js (removed in SM-3).
  // Same UI shape: global DoR/DoD blocks + per-ticket-type configuration
  // (enable toggle, mode-picker inherit/append/override, items list).
  //
  // Live-apply pattern matching the rest of view-settings: each discrete
  // user action (add/remove/reorder/required-toggle/mode-change/enable-
  // toggle/label-blur) re-reads the entire section's DOM via collectFormState
  // and commits a single store.updateProject({definitions, workflow,
  // entityTypeConfig}) — the workflow+entityTypeConfig changes piggyback so
  // the gate-enabled toggle stays in lockstep with the ticket-modal's
  // showDefinitionOfReady/Done visibility flags.
  //
  // Pure helpers (readFormState, collectFormState) are exported for tests.

  function cssEscape(s) {
    if (typeof window !== "undefined" && window.CSS && typeof window.CSS.escape === "function") {
      return window.CSS.escape(s);
    }
    return String(s || "").replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  function cloneDefItem(it) {
    return {
      id: typeof it.id === "string" && it.id ? it.id : freshDefItemId(),
      label: typeof it.label === "string" ? it.label : "",
      required: it.required !== false
    };
  }

  /**
   * Per-(type, gate) state: enabled flag is derived from the workflow's
   * `transitions[].requireGate`; mode + items come from `definitions.<gate>
   * .byType[type]` (missing → inherit).
   */
  function readGateState(project, type, statusKey, gateLabel) {
    const wf = core.getWorkflowForType(project, type);
    const trans = Array.isArray(wf.transitions) ? wf.transitions : [];
    const match = trans.find(t => t.toStatus === statusKey);
    const enabled = !!(match && match.requireGate === gateLabel);
    const defsBlock = (statusKey === "ready")
      ? (project.definitions && project.definitions.ready)
      : (project.definitions && project.definitions.done);
    const perType = defsBlock && defsBlock.byType && defsBlock.byType[type];
    let mode = "inherit", items = [];
    if (perType) {
      if (Array.isArray(perType.overridden))   { mode = "override"; items = perType.overridden.map(cloneDefItem); }
      else if (Array.isArray(perType.appended)) { mode = "append";   items = perType.appended.map(cloneDefItem); }
    }
    return { enabled, mode, items };
  }

  function readFormState(project) {
    const types = {};
    (project.ticketTypes || []).forEach((t) => {
      types[t] = {
        dor: readGateState(project, t, "ready", "DoR"),
        dod: readGateState(project, t, "done",  "DoD")
      };
    });
    return {
      globalDor: ((project.definitions && project.definitions.ready && project.definitions.ready.global) || []).map(cloneDefItem),
      globalDod: ((project.definitions && project.definitions.done  && project.definitions.done.global)  || []).map(cloneDefItem),
      types: types
    };
  }

  function readItemsFrom(host) {
    if (!host) return [];
    const rows = host.querySelectorAll(".vs-def-item-row");
    const out = [];
    rows.forEach((row) => {
      const labelInput = row.querySelector("input[type='text']");
      const checkbox   = row.querySelector("input[type='checkbox']");
      const label = (labelInput && labelInput.value || "").trim();
      if (!label) return;   // drop empty rows
      out.push({
        id: row.dataset.itemId || freshDefItemId(),
        label: label,
        required: !!(checkbox && checkbox.checked)
      });
    });
    return out;
  }

  /**
   * Read the section's full DOM into a patch `{ definitions, workflow,
   * entityTypeConfig }`. Workflow's `byType[type].transitions` for `ready`
   * and `done` are replaced; other transitions in the array are preserved.
   */
  function collectFormState(sectionEl, project) {
    const gDor = readItemsFrom(sectionEl.querySelector("[data-vs-def-section='global-dor']"));
    const gDod = readItemsFrom(sectionEl.querySelector("[data-vs-def-section='global-dod']"));

    // SM-38: preserve byType entries for types whose blocks are NOT in the
    // DOM (the dropdown-based UI renders one type at a time). Without
    // pre-seeding, switching the dropdown would silently delete the
    // per-type definitions of every other type on the next commit.
    const baseDefs = project.definitions || {};
    const baseDefsReadyByType = (baseDefs.ready && baseDefs.ready.byType) || {};
    const baseDefsDoneByType  = (baseDefs.done  && baseDefs.done.byType)  || {};
    const newDefs = {
      ready: { global: gDor, byType: Object.assign({}, baseDefsReadyByType) },
      done:  { global: gDod, byType: Object.assign({}, baseDefsDoneByType) }
    };

    const baseWf = project.workflow || {};
    const newWf = {
      statuses: Array.isArray(baseWf.statuses) ? baseWf.statuses.slice() : undefined,
      transitions: Array.isArray(baseWf.transitions) ? baseWf.transitions.slice() : baseWf.transitions,
      byType: Object.assign({}, baseWf.byType || {})
    };

    const baseEtc = project.entityTypeConfig || {};
    const newEtc = Object.assign({}, baseEtc);

    // SM-38: iterate the DOM blocks present (could be just one in dropdown
    // mode, or all of them in legacy/test scenarios). Pull the type from
    // dataset rather than from project.ticketTypes.
    const blocks = sectionEl.querySelectorAll(".vs-def-type-block[data-vs-def-type]");
    blocks.forEach((block) => {
      const type = block.dataset.vsDefType;
      if (!type) return;
      const dorEnabled = !!(block.querySelector("[data-vs-def-enabled='dor']") || {}).checked;
      const dodEnabled = !!(block.querySelector("[data-vs-def-enabled='dod']") || {}).checked;

      const prevByType = newWf.byType[type] || {};
      const prevTrans = Array.isArray(prevByType.transitions) ? prevByType.transitions : [];
      const otherTrans = prevTrans.filter(t => t.toStatus !== "ready" && t.toStatus !== "done");
      newWf.byType[type] = Object.assign({}, prevByType, {
        transitions: otherTrans.concat([
          { id: "to-ready", name: "→ Ready", fromStatuses: [], toStatus: "ready",
            requireGate: dorEnabled ? "DoR" : null, allowFromAny: true },
          { id: "to-done",  name: "→ Done",  fromStatuses: [], toStatus: "done",
            requireGate: dodEnabled ? "DoD" : null, allowFromAny: true }
        ])
      });

      // SM-38 follow-up: DO NOT couple entityTypeConfig.show* to the Required
      // toggle. Whether the DoR/DoD section appears in the ticket modal is a
      // separate concern from whether the gate is enforced on transitions.
      // newEtc[type] stays at its pre-existing value (default true), so per-
      // type DoR/DoD checklists remain visible as human reminders even when
      // not gate-enforced. Users who want to hide the section can set
      // entityTypeConfig.showDefinitionOf* via project_update.

      // For the RENDERED type, the byType entry must reflect the current UI
      // state — including "deleted" when mode=inherit. The pre-seed from
      // baseDefs handles non-rendered types; here we explicitly drop /
      // override entries for this visible type, INDEPENDENTLY of whether
      // the gate is enforced ("Required" off + items present = stored
      // reminder items the modal shows but no gate fires).
      const dorMode = (block.querySelector("[data-vs-def-mode='dor']") || { value: "inherit" }).value;
      if (dorMode !== "inherit") {
        const items = readItemsFrom(block.querySelector("[data-vs-def-items='dor']"));
        newDefs.ready.byType[type] = (dorMode === "override") ? { overridden: items } : { appended: items };
      } else {
        delete newDefs.ready.byType[type];
      }
      const dodMode = (block.querySelector("[data-vs-def-mode='dod']") || { value: "inherit" }).value;
      if (dodMode !== "inherit") {
        const items = readItemsFrom(block.querySelector("[data-vs-def-items='dod']"));
        newDefs.done.byType[type] = (dodMode === "override") ? { overridden: items } : { appended: items };
      } else {
        delete newDefs.done.byType[type];
      }
    });

    return { definitions: newDefs, workflow: newWf, entityTypeConfig: newEtc };
  }

  /**
   * Live-apply commit: read the section DOM, build the patch, dispatch
   * updateProject. Errors surface via flashStatus.
   */
  function commitDefinitions(anyDescendantEl, ctx) {
    if (!ctx || !ctx.store) return;
    try {
      // SM-40: DoR + DoD now live in two separate .vs-section elements.
      // collectFormState needs the .vs-root container so it can iterate
      // .vs-def-type-block + .vs-def-section across both sections. Resolve
      // .vs-root by walking up from whichever descendant was passed.
      const rootEl = anyDescendantEl && anyDescendantEl.closest
        ? (anyDescendantEl.closest(".vs-root") || anyDescendantEl)
        : anyDescendantEl;
      const cur = ctx.store.get().project;
      const patch = collectFormState(rootEl, cur);
      ctx.store.updateProject(patch, LOCAL_ACTOR);
    } catch (err) {
      if (ctx.flashStatus) ctx.flashStatus(err.message || "settings save failed", { kind: "error" });
    }
  }

  // ---- DOM builders ------------------------------------------------

  function renderDefItemRow(item, listHost, sectionEl, ctx) {
    const row = el("div", { class: "vs-def-item-row" });
    row.dataset.itemId = item.id;
    const grip = el("span", { class: "vs-def-item-grip", title: "Drag to reorder", text: "⋮⋮" });
    const reqLabel = el("label", { class: "vs-def-item-required-wrap", title: "Required to pass the gate" });
    const reqInput = el("input", { type: "checkbox" });
    if (item.required) reqInput.setAttribute("checked", "checked");
    reqInput.addEventListener("change", () => commitDefinitions(sectionEl, ctx));
    const reqHint = el("span", { class: "vs-def-item-required-hint", text: "required" });
    reqLabel.appendChild(reqInput); reqLabel.appendChild(reqHint);
    const labelInput = el("input", {
      type: "text", class: "vs-def-item-label",
      value: item.label || "", placeholder: "Item label"
    });
    labelInput.addEventListener("blur", () => commitDefinitions(sectionEl, ctx));
    const remove = el("button", {
      class: "vs-def-item-remove btn", type: "button",
      title: "Remove item", text: "×"
    });
    remove.addEventListener("click", () => {
      row.remove();
      commitDefinitions(sectionEl, ctx);
    });
    row.appendChild(grip);
    row.appendChild(reqLabel);
    row.appendChild(labelInput);
    row.appendChild(remove);

    if (dnd && typeof dnd.enableDraggable === "function") {
      const listId = listHost.dataset.listId;
      dnd.enableDraggable(row, { dragType: DDS_DRAG_TYPE + ":" + listId, dragId: item.id });
      dnd.enableDropTarget(row, {
        accepts: [DDS_DRAG_TYPE + ":" + listId],
        onEnter: (e) => e.classList.add("vs-def-item-drop-target"),
        onLeave: (e) => e.classList.remove("vs-def-item-drop-target"),
        onDrop: ({ id, event }) => {
          row.classList.remove("vs-def-item-drop-target");
          const list = row.parentNode;
          if (!list) return;
          const dragged = list.querySelector('.vs-def-item-row[data-item-id="' + cssEscape(id) + '"]');
          if (!dragged || dragged === row) return;
          const rect = row.getBoundingClientRect();
          const before = (event && typeof event.clientY === "number")
            ? event.clientY < rect.top + rect.height / 2 : true;
          if (before) list.insertBefore(dragged, row);
          else        list.insertBefore(dragged, row.nextSibling);
          commitDefinitions(sectionEl, ctx);
        }
      });
    }
    return row;
  }

  function renderDefItemsList(host, items, listId, sectionEl, ctx) {
    host.dataset.listId = listId;
    host.classList.add("vs-def-items-list");
    items.forEach((it) => host.appendChild(renderDefItemRow(it, host, sectionEl, ctx)));
    const addBtn = el("button", {
      class: "btn vs-def-add-item", type: "button", text: "+ Add Item"
    });
    addBtn.addEventListener("click", () => {
      const row = renderDefItemRow({ id: freshDefItemId(), label: "", required: true }, host, sectionEl, ctx);
      host.insertBefore(row, addBtn);
      const input = row.querySelector("input[type='text']");
      if (input) input.focus();
      // No commit yet — empty label rows are dropped by readItemsFrom anyway.
      // The commit will fire on label blur once the user types something.
    });
    host.appendChild(addBtn);
  }

  function renderGlobalDefSection(host, label, sectionKey, items, sectionEl, ctx) {
    const wrap = el("section", { class: "vs-def-block" });
    wrap.dataset.vsDefSection = sectionKey;
    wrap.appendChild(el("h4", { class: "vs-def-block-title", text: label }));
    const list = el("div");
    wrap.appendChild(list);
    renderDefItemsList(list, items, sectionKey, sectionEl, ctx);
    host.appendChild(wrap);
  }

  function renderGateBlock(typeBlock, gateLabel, gateKey, state, sectionEl, ctx) {
    const wrap = el("div", { class: "vs-def-gate-block" });
    wrap.dataset.vsDefGate = gateKey;
    const header = el("div", { class: "vs-def-gate-header" });
    const enabled = el("input", { type: "checkbox" });
    enabled.dataset.vsDefEnabled = gateKey;
    if (state.enabled) enabled.setAttribute("checked", "checked");
    const enabledLabel = el("label", { class: "vs-def-gate-toggle" });
    enabledLabel.appendChild(enabled);
    // SM-38 follow-up: the toggle was previously labelled "DoR required for
    // this type" and gated the visibility of the entire body — that conflated
    // two concerns. "Required" now means ONLY gate enforcement (must check
    // off required items before the transition). The items list itself stays
    // editable regardless, so humans get a checklist reminder even when the
    // gate isn't enforced.
    enabledLabel.appendChild(el("span", { text: " Enforce " + gateLabel + " gate (block transition until required items checked)" }));
    header.appendChild(enabledLabel);
    wrap.appendChild(header);

    // Body is always visible — items list is editable whether or not the gate
    // is enforced.
    const body = el("div", { class: "vs-def-gate-body" });
    const modeRow = el("div", { class: "vs-def-mode-row" });
    modeRow.appendChild(el("span", { class: "vs-def-mode-label", text: "Items" }));
    const sel = el("select");
    sel.dataset.vsDefMode = gateKey;
    for (const [val, lbl] of [
      ["inherit",  "Inherit global"],
      ["append",   "Append to global"],
      ["override", "Override global"]
    ]) {
      const opt = el("option", { value: val, text: lbl });
      if (val === state.mode) opt.setAttribute("selected", "selected");
      sel.appendChild(opt);
    }
    modeRow.appendChild(sel);
    body.appendChild(modeRow);

    // SM-38 follow-up: items list is ALWAYS visible when the gate is enabled
    // (previously hidden when mode=inherit, which made the per-type +Add Item
    // UI hard to discover — users assumed per-type was on/off only). In
    // inherit mode the items are stored but not applied; switching mode to
    // append or override activates them. A hint explains this.
    const list = el("div");
    list.dataset.vsDefItems = gateKey;
    renderDefItemsList(list, state.items, "type-" + typeBlock.dataset.vsDefType + "-" + gateKey, sectionEl, ctx);
    body.appendChild(list);
    const hint = el("p", { class: "vs-def-mode-hint",
      text: "Inherit: per-type items are stored but ignored. Append: added to globals. Override: replaces globals." });
    body.appendChild(hint);

    sel.addEventListener("change", () => {
      commitDefinitions(sectionEl, ctx);
    });
    enabled.addEventListener("change", () => {
      commitDefinitions(sectionEl, ctx);
    });

    wrap.appendChild(body);
    typeBlock.appendChild(wrap);
  }

  function renderTypeBlock(host, type, typeState, rootEl, ctx, gateKey) {
    const block = el("section", { class: "vs-def-type-block" });
    block.dataset.vsDefType = type;
    block.appendChild(el("h4", { class: "vs-def-type-title", text: type }));
    // SM-40: gateKey filters which gate(s) this block renders. When omitted
    // (legacy callers), both gates are rendered (no behaviour change for
    // any code still passing only 5 args). When passed as "dor" or "dod",
    // only that gate's block is rendered — used by the split DoR/DoD
    // sections.
    if (!gateKey || gateKey === "dor") {
      renderGateBlock(block, "Definition of Ready", "dor", typeState.dor, rootEl, ctx);
    }
    if (!gateKey || gateKey === "dod") {
      renderGateBlock(block, "Definition of Done",  "dod", typeState.dod, rootEl, ctx);
    }
    host.appendChild(block);
  }

  /**
   * SM-40: helper for a single-gate Definitions section. `gateKey` ∈ {"dor","dod"};
   * `sectionLabel`/`globalLabel` are display strings; `globalKey` = "global-dor"
   * or "global-dod" (matches the readItemsFrom selector); `globalItems` is the
   * state slice for that gate's globals. Renders one .vs-section with the
   * single-gate globals + the type-picker + a single-gate per-type block.
   */
  function renderSingleGateSection(project, ctx, rootEl, opts) {
    const { gateKey, sectionId, sectionLabel, globalLabel, globalKey, globalItems, typeStateKey } = opts;
    const section = el("section", { class: "vs-section vs-def-root", dataset: { section: sectionId } });
    section.appendChild(el("header", { class: "vs-section-header" },
      el("h2", { text: sectionLabel }),
      el("p", { class: "vs-section-hint",
        text: "Checklist gating ticket transitions for this stage. Globals apply to every ticket type; per-type configuration can append to or override them." })
    ));
    const body = el("div", { class: "vs-section-body" });
    section.appendChild(body);

    const state = readFormState(project);

    const globals = el("div", { class: "vs-def-globals" });
    globals.appendChild(el("h3", { class: "vs-subhead", text: "Global items" }));
    renderGlobalDefSection(globals, globalLabel, globalKey, globalItems, rootEl, ctx);
    body.appendChild(globals);

    // SM-38: per-type configuration is now a Type-Picker + single edit-block.
    // Switching the picker re-renders the block for the newly-selected type
    // (UI-only, no commit). Edits inside the block still live-apply via
    // commitDefinitions, which now preserves byType-entries for types whose
    // block is NOT in the DOM (see collectFormState).
    if ((project.ticketTypes || []).length > 0) {
      body.appendChild(el("h3", { class: "vs-subhead", text: "Per-type configuration" }));
      const perType = el("div", { class: "vs-def-per-type" });

      const pickerRow = el("div", { class: "vs-def-type-picker-row" });
      pickerRow.appendChild(el("label", { class: "vs-def-type-picker-label", text: "Configure for type:" }));
      const picker = el("select", { class: "vs-def-type-picker" });
      (project.ticketTypes || []).forEach((t) => {
        picker.appendChild(el("option", { value: t, text: t }));
      });
      pickerRow.appendChild(picker);
      perType.appendChild(pickerRow);

      const blockHost = el("div", { class: "vs-def-type-host" });
      perType.appendChild(blockHost);

      function renderBlockFor(type) {
        blockHost.innerHTML = "";
        renderTypeBlock(
          blockHost, type,
          state.types[type] || { dor: { enabled: false, mode: "inherit", items: [] },
                                 dod: { enabled: false, mode: "inherit", items: [] } },
          rootEl, ctx, gateKey
        );
      }

      // Default selection = first ticketType. Switching the picker is a
      // pure UI re-render; no commit fires.
      const firstType = project.ticketTypes[0];
      picker.value = firstType;
      renderBlockFor(firstType);

      picker.addEventListener("change", () => {
        renderBlockFor(picker.value);
      });

      body.appendChild(perType);
    }
    return section;
  }

  function renderDorSection(project, ctx, rootEl) {
    const state = readFormState(project);
    return renderSingleGateSection(project, ctx, rootEl, {
      gateKey:    "dor",
      sectionId:  "dor",
      sectionLabel: "Definition of Ready",
      globalLabel: "Global Definition of Ready items",
      globalKey:  "global-dor",
      globalItems: state.globalDor
    });
  }

  function renderDodSection(project, ctx, rootEl) {
    const state = readFormState(project);
    return renderSingleGateSection(project, ctx, rootEl, {
      gateKey:    "dod",
      sectionId:  "dod",
      sectionLabel: "Definition of Done",
      globalLabel: "Global Definition of Done items",
      globalKey:  "global-dod",
      globalItems: state.globalDod
    });
  }

  // ---- Mount / render -----------------------------------------------

  // SM-41: module-state for the active tab. Reset to "workflow" on every
  // fresh mount (no persist across open/close — bewusste User-Entscheidung).
  // Survives renderInto re-runs (live-sync), so external commits don't snap
  // the user back to Workflow.
  // ---------------------------------------------------------------------------
  // SM-107 — read-only "Rules per type" (derived from the catalog)
  // ---------------------------------------------------------------------------

  // Pure: walk the transition-rule catalog and report, per ticket type, which
  // rules are enabled (enabledFor true) vs N/A. Read-only derivation from
  // core.TRANSITION_RULES + the project's entityTypeConfig — no persistence.
  // This is the UI face of the SM-102 lockstep invariant: a rule shows as N/A
  // exactly when its backing field is configured off for that type.
  function activeRulesForType(type, project) {
    const catalog = (core && core.TRANSITION_RULES) || {};
    return Object.keys(catalog).map((id) => {
      const rule = catalog[id];
      const enabled = typeof rule.enabledFor === "function"
        ? !!rule.enabledFor(type, project || {})
        : true;
      return { id: id, label: (rule && rule.label) || id, enabled: enabled };
    });
  }

  function renderRulesSection(project, ctx) {
    const types = (project && Array.isArray(project.ticketTypes) && project.ticketTypes.length)
      ? project.ticketTypes
      : (core.DEFAULT_TICKET_TYPES || []);
    const bodyChildren = [];
    for (const type of types) {
      const block = el("div", { class: "vs-rules-type", dataset: { type: type } });
      block.appendChild(el("h3", { class: "vs-subhead", text: type }));
      const list = el("ul", { class: "vs-rules-list" });
      for (const r of activeRulesForType(type, project)) {
        const li = el("li", {
          class: "vs-rules-item" + (r.enabled ? " active" : " inactive"),
          dataset: { ruleId: r.id, enabled: r.enabled ? "1" : "0" }
        });
        li.appendChild(el("span", { class: "vs-rules-state", text: r.enabled ? "✓" : "—" }));
        li.appendChild(el("code", { class: "vs-rules-id selectable", text: r.id }));
        li.appendChild(el("span", { class: "vs-rules-label", text: r.label }));
        if (!r.enabled) li.appendChild(el("span", { class: "vs-rules-na", text: "N/A for this type" }));
        list.appendChild(li);
      }
      block.appendChild(list);
      bodyChildren.push(block);
    }
    return el("section", { class: "vs-section", dataset: { section: "rules" } },
      el("header", { class: "vs-section-header" },
        el("h2", { text: "Rules" }),
        el("p", { class: "vs-section-hint",
          text: "Read-only. Which transition-gate rules apply to each ticket type, derived from the rule catalog + this project's type config. A rule shows N/A when its backing field (e.g. DoD section) is hidden for that type — the SM-102 lockstep invariant made visible." })
      ),
      el("div", { class: "vs-section-body" }, ...bodyChildren));
  }

  let _activeTab = "workflow";

  const SETTINGS_TABS = [
    { id: "workflow",   label: "Workflow" },
    { id: "dor",        label: "Definition of Ready" },
    { id: "dod",        label: "Definition of Done" },
    { id: "board",      label: "Kanban Board" },
    { id: "links",      label: "Link Types" },
    { id: "types",      label: "Ticket Types" },
    { id: "typeconfig", label: "Type Config" },
    { id: "labels",     label: "Labels" },
    { id: "rules",      label: "Rules" }
  ];

  function renderSettingsTabBar(activeId, onSelect) {
    const bar = el("div", { class: "vs-tab-bar", role: "tablist" });
    for (const tab of SETTINGS_TABS) {
      const btn = el("button", {
        class: "vs-tab-btn" + (tab.id === activeId ? " active" : ""),
        type: "button", role: "tab",
        text: tab.label
      });
      btn.dataset.vsTab = tab.id;
      btn.setAttribute("aria-selected", tab.id === activeId ? "true" : "false");
      btn.addEventListener("click", () => onSelect(tab.id));
      bar.appendChild(btn);
    }
    return bar;
  }

  function setActiveTab(rootEl, tabId) {
    _activeTab = tabId;
    const sections = rootEl.querySelectorAll(":scope > .vs-section");
    sections.forEach((s) => {
      if (s.dataset.section === tabId) s.removeAttribute("hidden");
      else                              s.setAttribute("hidden", "");
    });
    const buttons = rootEl.querySelectorAll(".vs-tab-bar > .vs-tab-btn");
    buttons.forEach((b) => {
      const active = b.dataset.vsTab === tabId;
      b.classList.toggle("active", active);
      b.setAttribute("aria-selected", active ? "true" : "false");
    });
  }

  function renderInto(host, store, ctx) {
    const snap = store.get();
    const project = (snap && snap.project) || null;
    // Focus-Guard: if the user is currently typing in a name input inside
    // the view, skip a full rerender — otherwise they lose caret position
    // and the in-flight edit. The blur-commit handler will trigger the
    // next external commit anyway, which then DOES re-render.
    const active = document.activeElement;
    if (active && host.contains(active) && active.matches
        && active.matches("input.vs-status-name, input.vs-transition-name, input.vs-board-column-name, input.vs-def-item-label, input.vs-linktype-label, input.vs-linktype-inverse, input.vs-tickettype-name, input.vs-label-name")) {
      return;
    }
    // Renderers and event handlers expect ctx.store on the ctx object;
    // mount() takes store as a separate parameter, so merge it here so
    // we don't sprinkle store-threading through every helper.
    const fullCtx = Object.assign({}, ctx || {}, { store: store });
    const root = el("div", { class: "vs-root" });
    if (!project) {
      root.appendChild(el("p", { class: "vs-empty",
        text: "Load a project to configure its workflow and board." }));
    } else {
      // SM-41: tab-bar first, then the four sections. Only the section
      // matching _activeTab is visible; the others are hidden via the
      // hidden attribute. Tab-click toggles via setActiveTab WITHOUT
      // re-running renderInto (DOM-identity + DnD-Registrierungen bleiben).
      root.appendChild(renderSettingsTabBar(_activeTab, (tabId) => setActiveTab(root, tabId)));
      root.appendChild(renderWorkflowSection(project, fullCtx));
      root.appendChild(renderDorSection(project, fullCtx, root));
      root.appendChild(renderDodSection(project, fullCtx, root));
      root.appendChild(renderBoardSection(project, fullCtx));
      root.appendChild(renderLinkTypesSection(project, fullCtx));
      root.appendChild(renderTicketTypesSection(project, fullCtx));
      root.appendChild(renderTypeConfigSection(project, fullCtx));
      root.appendChild(renderLabelsSection(project, fullCtx));
      root.appendChild(renderRulesSection(project, fullCtx));
      // Apply the initial visibility AFTER all sections are appended so
      // setActiveTab can find them via :scope > .vs-section.
      setActiveTab(root, _activeTab);
    }
    host.innerHTML = "";
    host.appendChild(root);
  }

  /**
   * Mount the settings view into `host`. Returns `{unmount}`. Subscribes
   * to the store so external commits re-render the sections (E21.E/F/G
   * editors rely on this for live-sync). When no store is provided yet
   * (no project loaded), renders the empty state once.
   */
  function mount(host, store, ctx) {
    ctx = ctx || {};
    // SM-41: fresh mount resets the active tab to "workflow". Closing and
    // re-opening the Settings overlay (Project ▸ Settings…) returns the
    // user to the first tab — no persist. Live-sync re-runs of renderInto
    // do NOT pass through here, so they keep the user's current tab.
    _activeTab = "workflow";
    // SM-9: also reset the per-type editor's selection so a fresh open
    // always lands on the first ticket-type.
    _typeConfigSelectedType = null;
    if (!store) {
      host.innerHTML = "";
      host.appendChild(el("div", { class: "vs-root" },
        el("p", { class: "vs-empty",
          text: "Load a project to configure its workflow and board." })));
      return { unmount: () => { host.innerHTML = ""; } };
    }
    function rerender() { renderInto(host, store, ctx); }
    rerender();
    const unsub = store.subscribe(rerender);
    return {
      unmount: () => {
        try { unsub(); } catch (_) { /* ignore */ }
        host.innerHTML = "";
      }
    };
  }

  return {
    mount,
    reorderStatuses,
    reorderTransitions,
    sortTransitionsByStatusOrder,
    assignStatusToColumn,
    unassignedStatuses,
    // SM-2 — DoR/DoD editor exports
    readFormState,
    collectFormState,
    // SM-40 split — two separate single-gate section renderers replace
    // the old combined renderDefinitionsSection.
    renderDorSection,
    renderDodSection,
    // SM-7 + SM-8 — pure reorder helpers exposed for unit testing
    reorderTicketTypes,
    reorderLabels,
    // SM-107 — read-only rules-per-type derivation
    activeRulesForType
  };
}));
