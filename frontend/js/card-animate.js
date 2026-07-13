/**
 * Card animations for MCP/WS-driven changes (E24).
 *
 * Used by Kanban, Story-Map, and Ticket-Modal renderers. Two effects:
 *
 *   1. FLIP: when a card moves between lanes / cells / sort-positions
 *      after an external commit, animate it sliding to its new spot
 *      instead of teleporting. Implementation is the classic FLIP pattern
 *      (First, Last, Invert, Play): capture rects before the rerender,
 *      then after the rerender apply an inverse transform and transition
 *      it back to identity.
 *
 *   2. Pulse: when a card's non-positional fields change (title, status,
 *      acceptance criteria, checklists, labels, etc.) we briefly add a
 *      .sm-card-flash class so the user sees "this card just got
 *      updated". Color comes from --accent so it stays on-theme.
 *
 * Local user actions don't trigger these — only remote commits (reason
 * 'applyRemote') invoke the animation hooks. Local actions already have
 * direct visual feedback (drag-ghost, dialog dismiss, …) and animating
 * them on top would feel laggy.
 *
 * Pure helpers (`diffNonPositionChanges`) are testable in JSDOM. The
 * timing-sensitive FLIP and pulse helpers are no-ops in environments
 * without real layout (JSDOM returns 0×0 rects), so calling them in
 * tests is safe.
 *
 * UMD-wrapped — usable in browser and Node tests.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    (root.STORYMAP = root.STORYMAP || {}).cardAnimate = factory();
  }
}(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const FLIP_DURATION_MS = 320;
  const FLIP_EASING = "cubic-bezier(0.4, 0, 0.2, 1)";
  const PULSE_CLASS = "sm-card-flash";
  const PULSE_DURATION_MS = 900;
  const PULSE_EPSILON_PX = 0.5;   // ignore sub-pixel jitter from layout

  /**
   * Snapshot the position of every visible ticket card inside `hostEl`.
   * Keyed by ticket id (`data-ticket-id` attribute). Used as the "First"
   * pass of FLIP — call this BEFORE you wipe and rerender the host.
   */
  function captureCardRects(hostEl) {
    return captureRectsBySelector(hostEl, ".sm-story-card[data-ticket-id]", "ticketId");
  }

  /**
   * Generic version of captureCardRects (E24.E): walks an arbitrary
   * selector inside `hostEl` and keys the bounding-rects by the named
   * dataset property. Used to animate ticket cards, epic cards, process-
   * step columns, release rows — anything with a stable data-* id.
   */
  function captureRectsBySelector(hostEl, selector, idAttr) {
    const out = new Map();
    if (!hostEl || typeof hostEl.querySelectorAll !== "function") return out;
    const nodes = hostEl.querySelectorAll(selector);
    for (const node of nodes) {
      const id = node.dataset && node.dataset[idAttr];
      if (!id) continue;
      out.set(id, node.getBoundingClientRect());
    }
    return out;
  }

  /**
   * After the host has been rerendered, find each card that existed in
   * `prevRects` and animate it from its old position to the new one.
   * Newly inserted cards (no entry in prevRects) just appear in place.
   * Returns the count of cards that actually moved (useful in tests).
   */
  function flipFromCaptured(hostEl, prevRects, opts) {
    return flipFromCapturedSelector(hostEl, prevRects, ".sm-story-card[data-ticket-id]", "ticketId", opts);
  }

  /**
   * Generic FLIP (E24.E): same idea as flipFromCaptured but parametrised
   * on selector + idAttr. Powers epic / process-step / release animations.
   */
  function flipFromCapturedSelector(hostEl, prevRects, selector, idAttr, opts) {
    if (!hostEl || !prevRects || prevRects.size === 0) return 0;
    opts = opts || {};
    const duration = opts.duration || FLIP_DURATION_MS;
    const easing = opts.easing || FLIP_EASING;
    let animated = 0;
    const nodes = hostEl.querySelectorAll(selector);
    for (const node of nodes) {
      const id = node.dataset && node.dataset[idAttr];
      if (!id) continue;
      const prev = prevRects.get(id);
      if (!prev) continue;
      const next = node.getBoundingClientRect();
      const dx = prev.left - next.left;
      const dy = prev.top - next.top;
      if (Math.abs(dx) < PULSE_EPSILON_PX && Math.abs(dy) < PULSE_EPSILON_PX) continue;
      node.style.transition = "none";
      node.style.transform = "translate(" + dx + "px, " + dy + "px)";
      // eslint-disable-next-line no-unused-expressions
      node.getBoundingClientRect();
      node.style.transition = "transform " + duration + "ms " + easing;
      node.style.transform = "";
      setTimeout(function () {
        node.style.transition = "";
        node.style.transform = "";
      }, duration + 60);
      animated += 1;
    }
    return animated;
  }

  /**
   * Briefly add the flash class to every card whose id is in `ticketIds`.
   * The class triggers an --accent-toned keyframe in CSS. Caller must
   * make sure the keyframe rule is loaded (frontend/css/storymap.css).
   */
  function pulseTickets(hostEl, ticketIds, opts) {
    pulseEntities(hostEl, ticketIds, '[data-ticket-id="', '"]', opts);
  }

  /**
   * Generic pulse (E24.E): briefly add the flash class to any element
   * matching `[data-<idAttr>="<id>"]` for each id. `selectorPrefix`/
   * `selectorSuffix` let callers narrow the selector if they want to
   * only highlight cards (e.g. exclude container wrappers).
   *
   * For typical usage just pass the data-attribute selector pieces:
   *   pulseEntities(host, ids, '[data-ticket-id="', '"]')
   */
  function pulseEntities(hostEl, ids, selectorPrefix, selectorSuffix, opts) {
    if (!hostEl || !ids) return;
    opts = opts || {};
    const cls = opts.className || PULSE_CLASS;
    const duration = opts.duration || PULSE_DURATION_MS;
    const list = (typeof ids.forEach === "function") ? ids : Array.from(ids);
    list.forEach(function (id) {
      if (!id) return;
      const sel = selectorPrefix + cssEscape(id) + selectorSuffix;
      const nodes = hostEl.querySelectorAll(sel);
      for (const node of nodes) {
        node.classList.remove(cls);
        // eslint-disable-next-line no-unused-expressions
        void node.offsetWidth;   // force reflow → restart animation
        node.classList.add(cls);
        setTimeout(function () { node.classList.remove(cls); }, duration);
      }
    });
  }

  function cssEscape(s) {
    return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  /**
   * Pure helper. Compare two snapshots and return the set of ticket ids
   * whose non-positional fields changed. "Non-positional" = anything that
   * doesn't affect which lane/cell a card lives in. Position changes are
   * handled by the FLIP pass and don't need a pulse.
   */
  function diffNonPositionChanges(prevSnap, nextSnap) {
    const out = new Set();
    if (!prevSnap || !nextSnap) return out;
    const prevById = new Map((prevSnap.tickets || []).map(function (t) { return [t.id, t]; }));
    for (const nextT of (nextSnap.tickets || [])) {
      const prevT = prevById.get(nextT.id);
      if (!prevT) continue;   // newly added; the render itself draws attention
      if (nonPositionHash(prevT) !== nonPositionHash(nextT)) out.add(nextT.id);
    }
    return out;
  }

  /**
   * Pure helper. Returns the set of ticket ids that exist in nextSnap
   * but NOT in prevSnap (and aren't tombstoned). When `prevSnap` is null
   * (e.g. very first commit observed on mount), every visible ticket
   * counts as new — matches the user's perspective of "I just opened
   * this and these cards appeared".
   *
   * Used by the animation hook to pulse arriving cards so they don't
   * silently materialise where the user wouldn't notice them.
   */
  function diffNewTickets(prevSnap, nextSnap) {
    const out = new Set();
    if (!nextSnap) return out;
    const prevIds = new Set(prevSnap ? (prevSnap.tickets || []).map(function (t) { return t.id; }) : []);
    for (const t of (nextSnap.tickets || [])) {
      if (t.isDeleted) continue;
      if (!prevIds.has(t.id)) out.add(t.id);
    }
    return out;
  }

  /**
   * Pure helper. Returns the set of ticket ids that were "touched" by
   * the commit between prevSnap and nextSnap. Touched = the ticket is
   * new, OR its `updatedAt`/`version` advanced, OR a structural compare
   * sees any field change. This is the broadest "something happened to
   * this ticket" signal — exactly what the user asked for: every MCP
   * change to a ticket should pulse, no matter which field changed.
   * Lane animation is handled separately by FLIP on rect-deltas.
   */
  function diffTouchedTickets(prevSnap, nextSnap) {
    const out = new Set();
    if (!nextSnap) return out;
    const prevById = new Map();
    if (prevSnap) {
      for (const t of (prevSnap.tickets || [])) prevById.set(t.id, t);
    }
    for (const next of (nextSnap.tickets || [])) {
      if (next.isDeleted) continue;
      const prev = prevById.get(next.id);
      if (!prev) { out.add(next.id); continue; }   // new ticket
      // updatedAt / version cover almost every server-side mutation;
      // fall back to structural compare for the (rare) case where a
      // mutation didn't bump them.
      if (prev.updatedAt !== next.updatedAt) { out.add(next.id); continue; }
      if (prev.version !== next.version)     { out.add(next.id); continue; }
      if (touchedHash(prev) !== touchedHash(next)) out.add(next.id);
    }
    return out;
  }

  /** Wide hash for change detection — includes position too, since the
   *  user wants every change to highlight (lane-move + glow combined). */
  function touchedHash(t) {
    return JSON.stringify({
      type: t.type,
      title: t.title,
      description: t.description,
      status: t.status,
      position: t.position,
      labels: t.labels,
      acceptanceCriteria: t.acceptanceCriteria,
      definitionOfReady: t.definitionOfReady,
      definitionOfDone:  t.definitionOfDone,
      links: t.links,
      comments: t.comments,
      isDeleted: t.isDeleted
    });
  }

  /**
   * Generic "touched ids in this entity list" diff (E24.E). `listKey`
   * picks the snapshot array (tickets/releases/processSteps). Same
   * heuristic as diffTouchedTickets: new id, updatedAt bump, version
   * bump, or structural diff. Used by the Story-Map renderer to
   * highlight changed process-steps and releases on top of tickets.
   */
  function diffTouchedEntities(prevSnap, nextSnap, listKey) {
    const out = new Set();
    if (!nextSnap) return out;
    const prevList = (prevSnap && prevSnap[listKey]) || [];
    const nextList = (nextSnap && nextSnap[listKey]) || [];
    const prevById = new Map();
    for (const e of prevList) prevById.set(e.id, e);
    for (const next of nextList) {
      if (next.isDeleted) continue;
      const prev = prevById.get(next.id);
      if (!prev) { out.add(next.id); continue; }
      if (prev.updatedAt !== next.updatedAt) { out.add(next.id); continue; }
      if (prev.version !== next.version)     { out.add(next.id); continue; }
      if (JSON.stringify(prev) !== JSON.stringify(next)) out.add(next.id);
    }
    return out;
  }

  /**
   * Stable serialisation of every ticket field EXCEPT position metadata.
   * `status` IS included — a status change without a corresponding lane
   * move (e.g. story-map view where status isn't a layout axis) should
   * still pulse the card so the user notices.
   */
  function nonPositionHash(t) {
    return JSON.stringify({
      type: t.type,
      title: t.title,
      description: t.description,
      status: t.status,
      labels: t.labels,
      acceptanceCriteria: t.acceptanceCriteria,
      definitionOfReady: t.definitionOfReady,
      definitionOfDone:  t.definitionOfDone,
      links: t.links,
      comments: t.comments,
      isDeleted: t.isDeleted
    });
  }

  /**
   * High-level helper for renderer subscribe-callbacks. Captures rects
   * + diff, runs the supplied rerender, then plays the animations. Call
   * this only when the commit came from `applyRemote` — local commits
   * already have direct visual feedback.
   *
   *   animateExternalCommit({
   *     host,
   *     prevSnap,        // store snapshot before this commit
   *     nextSnap,        // current store snapshot
   *     rerender: () => renderInto(host, store, opts)
   *   })
   */
  function animateExternalCommit(args) {
    const host = args.host;
    const rerender = args.rerender;
    if (!host || typeof rerender !== "function") {
      if (typeof rerender === "function") rerender();
      return;
    }
    const prevRects = captureCardRects(host);
    const touchedIds = diffTouchedTickets(args.prevSnap, args.nextSnap);
    rerender();
    flipFromCaptured(host, prevRects);
    if (touchedIds.size > 0) pulseTickets(host, touchedIds);
  }

  /**
   * Multi-entity-type version of animateExternalCommit (E24.E). Pass an
   * array of `entityTypes` like
   *
   *   [
   *     { listKey: "tickets",      selector: "[data-ticket-id]",       idAttr: "ticketId" },
   *     { listKey: "processSteps", selector: "[data-process-step-id]", idAttr: "processStepId" },
   *     { listKey: "releases",     selector: "[data-release-id]",       idAttr: "releaseId" }
   *   ]
   *
   * The renderer (Story-Map) uses this to animate epic cards + story
   * cards + process-step columns + release labels all in one rerender
   * cycle. Each entity-type gets its own capture/diff/flip/pulse pass.
   */
  function animateExternalCommitMulti(args) {
    const host = args.host;
    const rerender = args.rerender;
    const types = Array.isArray(args.entityTypes) ? args.entityTypes : [];
    if (!host || typeof rerender !== "function") {
      if (typeof rerender === "function") rerender();
      return;
    }
    // Phase 1: capture rects + diff touched ids per entity type.
    const passes = types.map(function (et) {
      return {
        et: et,
        prevRects: captureRectsBySelector(host, et.selector, et.idAttr),
        touched: diffTouchedEntities(args.prevSnap, args.nextSnap, et.listKey)
      };
    });
    // Phase 2: rerender (DOM wipe).
    rerender();
    // Phase 3: FLIP + pulse per entity type.
    for (const p of passes) {
      flipFromCapturedSelector(host, p.prevRects, p.et.selector, p.et.idAttr);
      if (p.touched.size > 0) {
        const dataAttr = "data-" + camelToDashed(p.et.idAttr);
        pulseEntities(host, p.touched, '[' + dataAttr + '="', '"]');
      }
    }
  }

  function camelToDashed(s) {
    return String(s).replace(/[A-Z]/g, function (c) { return "-" + c.toLowerCase(); });
  }

  return {
    FLIP_DURATION_MS,
    PULSE_CLASS,
    PULSE_DURATION_MS,
    captureCardRects,
    captureRectsBySelector,
    flipFromCaptured,
    flipFromCapturedSelector,
    pulseTickets,
    pulseEntities,
    diffNonPositionChanges,
    diffNewTickets,
    diffTouchedTickets,
    diffTouchedEntities,
    animateExternalCommit,
    animateExternalCommitMulti
  };
}));
