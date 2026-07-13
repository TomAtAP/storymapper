// SM-246/248/256 — Process-Step editor view.
//
// A SECOND view onto the same map: the process steps that the story-map draws
// as backbone *headers* are drawn here as *cards* — using the SAME shared card
// component as the item cards (rendererCard.renderCard), only with a different
// cluster colour (teal), and reordered with the EXACT same dnd mechanic as the
// Map's item cards (drag → live insertion projection → drop). Architecture
// principle: DRY — no second card component, no parallel drag wiring. Reorder
// projects straight back into the story-map backbone (store.reorderProcessSteps).
//
// Interactions mirror the item cards: double-click opens the existing
// process-step edit dialog (rename/status/delete) — no inline edit, no per-card
// delete. The cards deliberately show NO tickets (the journey, zoomed out). A
// quick-add input at the end lets a whole journey be typed in one go.
//
// UMD-wrapped: same source runs in the browser AND require()s in Node tests.
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./core.js"), require("./dnd.js"), require("./renderer-card.js"));
  } else {
    (root.STORYMAP = root.STORYMAP || {}).viewProcessSteps = factory(
      root.STORYMAP && root.STORYMAP.core,
      root.STORYMAP && root.STORYMAP.dnd,
      root.STORYMAP && root.STORYMAP.rendererCard
    );
  }
}(typeof self !== "undefined" ? self : this, function (core, dnd, rendererCard) {
  "use strict";

  if (!core) throw new Error("view-process-steps: core module missing");
  if (!rendererCard) throw new Error("view-process-steps: renderer-card module missing");

  const PSV_LAYOUT = {
    CARD_WIDTH_PX: 220,        // same fixed card width as the story-map items
    // Process-step cards wear the SAME colour as the story-map backbone spine
    // (green + light text) so the two surfaces read as the same steps. The
    // `process` cluster carries no own colour — .psv-flow paints it from the
    // shared --backbone-* tokens (see storymap.css).
    CLUSTER: "process",
    DRAG_TYPE: "psv-step"
  };

  const LOCAL_ACTOR = { type: "human", id: "local", name: "Local" };

  function el(tag, attrs, text) {
    const d = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      if (k === "class") d.className = attrs[k];
      else if (k === "dataset") for (const dk in attrs[k]) d.dataset[dk] = attrs[k][dk];
      else d.setAttribute(k, attrs[k]);
    }
    if (text != null) d.textContent = text;
    return d;
  }

  /**
   * Pure view model: the live process steps in journey order with ordinals.
   * No tickets / no epic hull — this is the zoomed-out journey surface. (The
   * epic picker for the split lives in the split dialog, P4, via
   * core.tickets.epicsInProcessStep — not on the card.)
   */
  function buildProcessStepModel(snapshot) {
    const steps = (snapshot.processSteps || [])
      .filter(p => !p.isDeleted)
      .slice()
      .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
    return steps.map((ps, idx) => ({ step: ps, ordinal: idx + 1 }));
  }

  /**
   * Pure reorder helper — mirrors the Map's item-reorder model: remove the
   * dragged id, re-insert it at `insertionIndex`, return the new id order.
   * store.reorderProcessSteps then renumbers sortOrder = index.
   */
  function reorderProcessStepIds(steps, draggedId, insertionIndex) {
    const ids = steps.map(s => s.id);
    const from = ids.indexOf(draggedId);
    if (from < 0) return ids;
    ids.splice(from, 1);
    const idx = Math.max(0, Math.min(ids.length, insertionIndex));
    ids.splice(idx, 0, draggedId);
    return ids;
  }

  function mount(host, store, ctx) {
    ctx = ctx || {};

    // Live drag projection — same shape/role as the story-map renderer's
    // _dragProjection: { stepId, insertionIndex }. Drives the shadow preview.
    let proj = null;

    function setProj(next) {
      const same = (proj === next) ||
        (proj && next && proj.stepId === next.stepId && proj.insertionIndex === next.insertionIndex);
      if (same) return;
      proj = next;
      render();
    }

    // Apply the projection: remove the dragged card from its slot and insert
    // it as a shadow at the insertion index (same trick as effectiveStoriesFor).
    function effectiveOrder(model) {
      if (!proj) return model.map(m => ({ step: m.step, shadow: false }));
      const dragged = model.find(m => m.step.id === proj.stepId);
      const without = model.filter(m => m.step.id !== proj.stepId)
        .map(m => ({ step: m.step, shadow: false }));
      if (!dragged) return without;
      const idx = Math.max(0, Math.min(without.length, proj.insertionIndex || 0));
      without.splice(idx, 0, { step: dragged.step, shadow: true });
      return without;
    }

    function renderStepCard(entry) {
      return rendererCard.renderCard({
        cluster: PSV_LAYOUT.CLUSTER,
        dataset: { processStepId: entry.step.id },
        width: PSV_LAYOUT.CARD_WIDTH_PX,
        isShadow: !!entry.shadow,
        title: entry.step.name || "(unnamed step)",
        meta: null,                       // no tickets / no status — the step itself
        onDblClick: function () { if (typeof ctx.onEditProcessStep === "function") ctx.onEditProcessStep(entry.step.id); },
        dragType: PSV_LAYOUT.DRAG_TYPE,
        dragId: entry.step.id,
        dragOnEnd: function () { if (proj) setProj(null); }
      });
    }

    /**
     * Quick-add: a permanent inline input at the end of the flow. Enter creates
     * the step AND keeps the field focused for the next one — a whole journey
     * can be typed in one go (the use-case-analysis tempo). Esc clears.
     */
    function renderQuickAdd() {
      const box = el("div", { class: "psv-quickadd" });
      const input = el("input", {
        class: "psv-quickadd-input", type: "text",
        placeholder: "+ Add step (Enter)", "aria-label": "Add a process step"
      });
      input.addEventListener("keydown", (ev) => {
        if (ev.key === "Escape") { input.value = ""; return; }
        if (ev.key !== "Enter") return;
        const name = input.value.trim();
        if (!name) return;
        // Set the refocus flag BEFORE the commit: createProcessStep fires the
        // store subscriber synchronously, so render() runs inside this call and
        // must already see the flag to refocus the fresh quick-add input.
        ctx._refocusQuickAdd = true;
        try {
          store.createProcessStep({ name }, LOCAL_ACTOR);
        } catch (err) {
          ctx._refocusQuickAdd = false;
          if (ctx.flashStatus) ctx.flashStatus(err.message || "add failed", { kind: "error" });
        }
      });
      box.appendChild(input);
      return box;
    }

    function wireFlowDropTarget(flow, model) {
      if (!dnd || typeof dnd.enableDropTarget !== "function") return;
      dnd.enableDropTarget(flow, {
        accepts: [PSV_LAYOUT.DRAG_TYPE],
        onMove: ({ id, clientX }) => {
          // Insertion index from cursor-X vs the REAL (non-shadow) card mids —
          // identical to the Map's epic-reorder onMove (horizontal flow).
          const cards = Array.from(flow.querySelectorAll(".sm-story-card[data-process-step-id]"))
            .filter(c => !c.classList.contains("sm-card-shadow"));
          let insertionIndex = cards.length;
          for (let i = 0; i < cards.length; i++) {
            const r = cards[i].getBoundingClientRect();
            if (clientX < r.left + r.width / 2) { insertionIndex = i; break; }
          }
          setProj({ stepId: id, insertionIndex: insertionIndex });
        },
        onDrop: ({ id }) => {
          const insertionIndex = (proj && proj.stepId === id) ? proj.insertionIndex : null;
          if (insertionIndex == null) return;   // no projection → no move
          const ordered = reorderProcessStepIds(model.map(m => m.step), id, insertionIndex);
          try { store.reorderProcessSteps(ordered, LOCAL_ACTOR); }
          catch (err) { if (ctx.flashStatus) ctx.flashStatus(err.message || "reorder failed", { kind: "error" }); }
          // proj is cleared by the draggable's onEnd (dragOnEnd → setProj(null)).
        }
      });
    }

    function render() {
      // Focus guard: don't stomp the quick-add input the user is typing into
      // when an EXTERNAL commit (MCP/WS) triggers a re-render. Our own create
      // sets _refocusQuickAdd, which bypasses the guard so the list refreshes.
      const active = host.ownerDocument && host.ownerDocument.activeElement;
      if (!ctx._refocusQuickAdd && active && host.contains(active)
          && active.classList && active.classList.contains("psv-quickadd-input")) {
        return;
      }

      const model = buildProcessStepModel(store.get());
      host.innerHTML = "";
      const rootEl = el("div", { class: "psv-root" });

      const header = el("div", { class: "psv-header" });
      header.appendChild(el("h2", { class: "psv-heading" }, "Process Steps"));
      header.appendChild(el("p", { class: "psv-sub" },
        "The customer journey, left to right — the same process steps as the story-map backbone, zoomed out. "
        + "Drag to reorder; double-click a step to edit it."));
      rootEl.appendChild(header);

      const flow = el("div", { class: "psv-flow" });
      if (model.length === 0) {
        flow.appendChild(el("div", { class: "psv-empty" },
          "No process steps yet — type the first journey step below."));
      } else {
        const display = effectiveOrder(model);
        display.forEach((entry) => flow.appendChild(renderStepCard(entry)));
      }
      flow.appendChild(renderQuickAdd());
      wireFlowDropTarget(flow, model);
      rootEl.appendChild(flow);
      host.appendChild(rootEl);

      if (ctx._refocusQuickAdd) {
        ctx._refocusQuickAdd = false;
        const qa = host.querySelector(".psv-quickadd-input");
        if (qa && typeof qa.focus === "function") qa.focus();
      }
    }

    render();
    const unsub = store.subscribe ? store.subscribe(() => render()) : null;
    return { unmount() { if (typeof unsub === "function") unsub(); host.innerHTML = ""; } };
  }

  return { mount, buildProcessStepModel, reorderProcessStepIds, PSV_LAYOUT };
}));
