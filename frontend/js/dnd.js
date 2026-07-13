/**
 * Pointer-Events-basiertes Drag-and-Drop.
 *
 * Ersetzt die HTML5-`draggable`-API, die in Safari und einigen anderen
 * Browsern unzuverlässig ist. Pointer-Events funktionieren konsistent in
 * Maus + Touch, lassen sich präzise hooken und erlauben uns ein eigenes
 * Ghost-Element zu rendern.
 *
 * API:
 *   enableDraggable(element, { dragType, dragId, onStart?, onEnd? }) → cleanup
 *   enableDropTarget(element, { accepts, onEnter?, onLeave?, onDrop }) → cleanup
 *   clearAll()                            — drop all registered targets (used by renderer rerender)
 *
 * Der Drop-Callback bekommt `{ type, id, target, event }`.
 *
 * Ghost-Preview folgt der Maus mit ~0.7 Opacity. Drop-Target-Discovery
 * via `elementFromPoint`, Walk-Up zum nächsten registrierten Target.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else (root.STORYMAP = root.STORYMAP || {}).dnd = factory();
}(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const CONSTANTS = {
    DRAG_THRESHOLD_PX: 4,
    GHOST_OPACITY:     0.78,
    GHOST_Z_INDEX:     1000,
    GHOST_TILT_DEG:    2,
    GHOST_MAX_WIDTH_PX: 280
  };

  // Global registry — keyed by element via a WeakMap (SM-153). The story-map
  // builds-then-discards DOM nodes on every morph render; with a Set those
  // discarded nodes' target entries leaked (unbounded growth + linear
  // findTarget). A WeakMap lets the GC reclaim entries for detached nodes and
  // makes findTarget an O(depth) per-element lookup. `clearAll()` swaps in a
  // fresh map.
  let _targetsByEl = new WeakMap();
  let _active = null;   // { type, id, ghost, originEl, offsetX, offsetY, currentTarget, onEnd }

  /**
   * Walk up from `node` and return the FIRST registered drop target that
   * also accepts `dragType`. Without the type-filter, nested targets that
   * don't accept the active drag (e.g. an Epic-Card inside a Cell — the
   * Epic-Card accepts STORY but not EPIC) would swallow the search and
   * leave the user without a valid drop target — causing same-cell
   * Epic-reorders to silently no-op (SM-61).
   *
   * When `dragType` is omitted (or for backwards compatibility), falls
   * back to the original "first registered target wins" semantics.
   */
  function findTarget(node, dragType) {
    let cur = node;
    while (cur && cur !== document.body && cur !== document) {
      const t = _targetsByEl.get(cur);
      if (t) {
        if (!dragType || (t.accepts && t.accepts.indexOf(dragType) >= 0)) return t;
        // Registered but doesn't accept this type — keep walking up.
      }
      cur = cur.parentNode;
    }
    return null;
  }

  function startDrag(originEl, opts, pointerEvent) {
    const rect = originEl.getBoundingClientRect();
    const targetW = Math.min(rect.width, CONSTANTS.GHOST_MAX_WIDTH_PX);
    // Proportional scale: if the ghost's width was clamped, the grab-offset
    // must shrink in the same ratio so the cursor stays at the same relative
    // x within the (smaller) ghost. Without this, stretched origin cards
    // produce a ghost that jumps sideways from the cursor.
    const scale = rect.width > 0 ? (targetW / rect.width) : 1;
    const ghost = originEl.cloneNode(true);
    ghost.style.position = "fixed";
    ghost.style.left = rect.left + "px";
    ghost.style.top  = rect.top  + "px";
    ghost.style.width = targetW + "px";
    ghost.style.zIndex = String(CONSTANTS.GHOST_Z_INDEX);
    ghost.style.pointerEvents = "none";
    ghost.style.opacity = String(CONSTANTS.GHOST_OPACITY);
    ghost.style.transform = "rotate(" + CONSTANTS.GHOST_TILT_DEG + "deg)";
    ghost.style.boxShadow = "0 10px 28px rgba(0,0,0,0.18), 0 4px 10px rgba(0,0,0,0.10)";
    ghost.classList.add("sm-drag-ghost");
    document.body.appendChild(ghost);

    originEl.classList.add("sm-dragging");

    _active = {
      type: opts.dragType,
      id: opts.dragId,
      originEl,
      ghost,
      offsetX: (pointerEvent.clientX - rect.left) * scale,
      offsetY: (pointerEvent.clientY - rect.top),
      currentTarget: null,
      onEnd: opts.onEnd
    };

    if (typeof opts.onStart === "function") opts.onStart();

    document.addEventListener("pointermove", onDragMove, true);
    document.addEventListener("pointerup",   onDragEnd,  true);
    document.addEventListener("pointercancel", onDragCancel, true);
  }

  function onDragMove(ev) {
    if (!_active) return;
    ev.preventDefault();
    _active.ghost.style.left = (ev.clientX - _active.offsetX) + "px";
    _active.ghost.style.top  = (ev.clientY - _active.offsetY) + "px";

    // Hide ghost temporarily so elementFromPoint sees what's under it.
    _active.ghost.style.display = "none";
    const under = document.elementFromPoint(ev.clientX, ev.clientY);
    _active.ghost.style.display = "";

    // Pass the active drag-type so findTarget skips registered targets that
    // don't accept it and walks up to the nearest one that DOES — required
    // for same-cell Epic-reorders where the Epic-Card (accepts STORY only)
    // would otherwise swallow the EPIC-drop search (SM-61).
    const target = under ? findTarget(under, _active.type) : null;
    const acceptedTarget = target;   // findTarget already type-filtered.

    if (acceptedTarget !== _active.currentTarget) {
      if (_active.currentTarget && typeof _active.currentTarget.onLeave === "function") {
        try { _active.currentTarget.onLeave(_active.currentTarget.element); } catch (_) {}
      }
      _active.currentTarget = acceptedTarget;
      if (_active.currentTarget && typeof _active.currentTarget.onEnter === "function") {
        try { _active.currentTarget.onEnter(_active.currentTarget.element); } catch (_) {}
      }
    }

    // Per-pointermove notification to the active target, used by the
    // live-reorder mechanism to compute the insertion index from clientY.
    if (_active.currentTarget && typeof _active.currentTarget.onMove === "function") {
      try {
        _active.currentTarget.onMove({
          type: _active.type,
          id: _active.id,
          target: _active.currentTarget.element,
          clientX: ev.clientX,
          clientY: ev.clientY
        });
      } catch (_) {}
    }
  }

  /**
   * Visuelle Aufräumarbeiten (Ghost entfernen, sm-dragging entfernen,
   * Drop-Target-Highlight clearen). Wird VOR dem onDrop-Callback aufgerufen,
   * damit der re-render danach saubere DOM-State sieht — selbst wenn das
   * Drop-Callback asynchron ist (HTTP-PUT + reloadStore).
   */
  function cleanupVisualOnly() {
    if (!_active) return;
    if (_active.ghost && _active.ghost.parentNode) _active.ghost.parentNode.removeChild(_active.ghost);
    if (_active.originEl) _active.originEl.classList.remove("sm-dragging");
    if (_active.currentTarget && typeof _active.currentTarget.onLeave === "function") {
      try { _active.currentTarget.onLeave(_active.currentTarget.element); } catch (_) {}
    }
  }

  function resetActiveState() {
    if (!_active) return;
    if (typeof _active.onEnd === "function") {
      try { _active.onEnd(); } catch (_) {}
    }
    document.removeEventListener("pointermove", onDragMove, true);
    document.removeEventListener("pointerup",   onDragEnd,  true);
    document.removeEventListener("pointercancel", onDragCancel, true);
    _active = null;
  }

  function onDragEnd(ev) {
    if (!_active) return;
    // Order is load-bearing:
    //   1. cleanupVisualOnly — ghost off, dragging-class off (visual reset).
    //   2. target.onDrop — fires the drop callback. MUST happen BEFORE
    //      resetActiveState, because resetActiveState invokes the draggable's
    //      onEnd, which (in the storymap renderer) calls
    //      setDragProjection(null). If we cleared the projection first, the
    //      drop callback would read a null projection and silently fall back
    //      to "no insertion index" (= splice at end), losing the user's
    //      intended drop position.
    //   3. resetActiveState — fires onEnd, removes listeners, _active=null.
    const target = _active.currentTarget;
    const type   = _active.type;
    const id     = _active.id;
    cleanupVisualOnly();
    if (target && typeof target.onDrop === "function") {
      try { target.onDrop({ type, id, target: target.element, event: ev }); } catch (e) { console.error(e); }
    }
    resetActiveState();
  }

  function onDragCancel() {
    cleanupVisualOnly();
    resetActiveState();
  }

  /**
   * Brute-force cleanup of orphan drag artifacts. Called by the renderer
   * before each mount so a previous incomplete drag can't leave stale
   * ghosts / dragging-classes in the document.
   */
  function scrubArtifacts() {
    if (typeof document === "undefined") return;
    // Never remove the CURRENTLY ACTIVE drag's ghost — only orphans from
    // a previous incomplete drag. Live-reorder triggers a renderer
    // re-render mid-drag; without this guard the active ghost would be
    // deleted on every projection change and the user loses cursor-follow.
    const activeGhost = _active && _active.ghost;
    const activeOrigin = _active && _active.originEl;
    // SM-79: same exclusion-pattern as ghost + dragging — DON'T strip the
    // currently-hovered drop-target's highlight class mid-drag. Without this
    // guard, every `setDragProjection` (fires per pointermove inside any
    // drop target) triggers a renderer rerender → scrubArtifacts → wipes
    // .sm-drop-target → user never sees a drop-zone highlight at all.
    const activeDrop = _active && _active.currentTarget && _active.currentTarget.element;
    const ghosts = document.querySelectorAll(".sm-drag-ghost");
    for (const g of ghosts) if (g !== activeGhost && g.parentNode) g.parentNode.removeChild(g);
    const stuck = document.querySelectorAll(".sm-dragging");
    for (const d of stuck) if (d !== activeOrigin) d.classList.remove("sm-dragging");
    const targets = document.querySelectorAll(".sm-drop-target");
    for (const t of targets) if (t !== activeDrop) t.classList.remove("sm-drop-target");
    // Orphan live-reorder shadow cards from an aborted drag — but ONLY
    // when no drag is active. During an active drag the shadow card is
    // re-emitted by the renderer at the new insertion position.
    if (!_active) {
      const shadows = document.querySelectorAll(".sm-card-shadow");
      for (const s of shadows) if (s.parentNode) s.parentNode.removeChild(s);
    }
  }

  // ---- Public API ----------------------------------------------------

  /**
   * Mark an element draggable. Returns a cleanup function that
   * removes the pointerdown listener.
   *
   * The threshold-based gesture avoids stealing clicks: short taps
   * still propagate to click-handlers, only movement > threshold
   * starts a drag.
   */
  function enableDraggable(element, opts) {
    function onDown(ev) {
      if (ev.button !== 0 || _active) return;
      // SM-158: `a` added — clicking a ticket-key link inside a draggable card
      // must navigate, not start a drag.
      if (ev.target && ev.target.closest && ev.target.closest("button,input,select,textarea,a")) return;
      // Stop the pointerdown from bubbling to ancestor draggables. A Story-
      // Card inside an Epic-Card needs its own drag to win — without this
      // the Epic's onDown also fires and the two drags race for _active.
      ev.stopPropagation();
      const startX = ev.clientX, startY = ev.clientY;
      function maybeStart(mEv) {
        if (Math.hypot(mEv.clientX - startX, mEv.clientY - startY) < CONSTANTS.DRAG_THRESHOLD_PX) return;
        document.removeEventListener("pointermove", maybeStart, true);
        document.removeEventListener("pointerup",   cancel,     true);
        if (_active) return;   // belt+suspenders: another draggable beat us to it
        startDrag(element, opts, mEv);
      }
      function cancel() {
        document.removeEventListener("pointermove", maybeStart, true);
        document.removeEventListener("pointerup",   cancel,     true);
      }
      document.addEventListener("pointermove", maybeStart, true);
      document.addEventListener("pointerup",   cancel,     true);
    }
    element.addEventListener("pointerdown", onDown);
    return function detach() {
      element.removeEventListener("pointerdown", onDown);
    };
  }

  /**
   * Register an element as a drop target.
   *   accepts: Array<string>  — only drag-types in this list will activate enter/drop.
   *   onEnter(el), onLeave(el), onDrop({type, id, target, event})
   * Returns a cleanup function that removes it from the registry.
   */
  function enableDropTarget(element, opts) {
    const target = {
      element,
      accepts: opts.accepts || [],
      onEnter: opts.onEnter,
      onLeave: opts.onLeave,
      onMove:  opts.onMove,
      onDrop:  opts.onDrop
    };
    _targetsByEl.set(element, target);
    return function detach() {
      if (_targetsByEl.get(element) === target) _targetsByEl.delete(element);
    };
  }

  /**
   * Wipe all registered drop targets. The renderer calls this at the
   * start of each remount so stale targets from the previous DOM tree
   * are cleared before new ones are registered.
   */
  function clearAll() { _targetsByEl = new WeakMap(); }

  function isDragging() { return _active != null; }
  function currentDrag() { return _active ? { type: _active.type, id: _active.id } : null; }

  return {
    CONSTANTS,
    enableDraggable,
    enableDropTarget,
    clearAll,
    scrubArtifacts,
    isDragging,
    currentDrag,
    // Test seam: the registered drop-target entry for an element (handlers +
    // accepts). Lets tests invoke the EXACT onDrop closure that a real pointer
    // drop would fire — including a morph-reused node's (possibly stale) one.
    _getDropTarget: function (el) { return _targetsByEl.get(el); }
  };
}));
