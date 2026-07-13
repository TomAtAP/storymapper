/**
 * Story-Map renderer — 3-Ebenen-Modell (E9c + E9j).
 *
 *   ProcessSteps  → horizontale Spalten (Feature-Backbone)
 *   Releases      → vertikale Zeilen
 *   pro (Release × ProcessStep)-Zelle: Epic-Karten als Container,
 *   unter jeder Epic ein Story-Sub-Grid.
 *   Backlog-Section am Boden ist die einzige Holding-Area: Gruppe
 *   "Unscheduled" (kein Release) + pro Release "Scheduled for X but
 *   unplaced" für Tickets mit Release, aber noch ohne Zell-Position.
 *
 * Pure-Funktionen (testbar ohne DOM):
 *   computeStoryMapLayout(snapshot) → { rows, columns, releases, backlog }
 *   applyEpicDrop(store, epicId, targetProcessStepId, actor)
 *   applyStoryDrop(store, storyId, targetEpicId, actor)
 *   applyBacklogDrop(store, ticketId, ticketType, actor)
 *   applyReleaseReorder(store, orderedReleaseIds, actor)
 *   applyProcessStepReorder(store, orderedStepIds, actor)
 *
 * Mount API:
 *   mount(host, store, opts?)
 *     opts.onAddTicket({releaseId, processStepId, epicId?})
 *     opts.onTicketClick(ticketId)
 *
 * Drag-and-Drop: Pointer-Events via dnd.js. Zwei Kontexte:
 *   "epic", "story"
 *
 * Alle Layout-Werte als Konstanten oben — keine Magic Numbers im Code.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./core.js"), require("./dnd.js"), require("./renderer-card.js"), require("./card-animate.js"), require("./filter.js"));
  else (root.STORYMAP = root.STORYMAP || {}).rendererStoryMap = factory(
    root.STORYMAP && root.STORYMAP.core,
    root.STORYMAP && root.STORYMAP.dnd,
    root.STORYMAP && root.STORYMAP.rendererCard,
    root.STORYMAP && root.STORYMAP.cardAnimate,
    root.STORYMAP && root.STORYMAP.filter
  );
}(typeof self !== "undefined" ? self : this, function (core, dnd, rendererCard, cardAnimate, filterMod) {
  "use strict";

  if (!core) throw new Error("renderer-storymap: core module missing");
  if (!dnd)  throw new Error("renderer-storymap: dnd module missing");
  if (!rendererCard) throw new Error("renderer-storymap: renderer-card module missing");
  // filterMod is optional — older callers / tests may mount without it.
  // When absent, all tickets and releases are visible (no-op filter).

  // ---- Konstanten (keine Magic Numbers) -------------------------------

  const STORY_MAP_LAYOUT = {
    // SM-277: fixed width of the release title column. The title truncates with
    // an ellipsis past this, and the progress/pill/Add-release badges line up in
    // stable columns across all release rows (no more fluttering). Flows to CSS
    // as `--sm-release-label-w` (set on .sm-grid in renderInto).
    RELEASE_LABEL_WIDTH_PX:    300,
    // SM-55 follow-up: clean integer multipliers for Epic widths.
    //
    // INVARIANT: STORY_CARD_WIDTH_PX is the canonical "1 unit". It is the
    // exact width of a standalone (loose) ticket card AND the exact width
    // of a 1-sub-col Epic card. An N-sub-col Epic card is exactly
    // N × STORY_CARD_WIDTH_PX wide. Story cards INSIDE an Epic become
    // slightly narrower (epic-width - padding - inter-card gap) / N so
    // they fit inside the Epic's clean N-unit width. The grid column unit
    // BACKBONE_COL_WIDTH_PX is STORY_CARD_WIDTH_PX + 2×CELL_PADDING_PX so
    // cell content area equals the Epic-card width with breathing room.
    //
    // Story card width bumped from 220 → 240 (~+9%) per user feedback —
    // long titles now have room to breathe.
    STORY_CARD_WIDTH_PX:       240,
    CELL_PADDING_PX:             4,   // .sm-cell padding (each side); mirrors css
    // SM-159: one grid unit = STORY_CARD (240) + one inter-column gap (8) = 248.
    // A cell with N columns is N units wide; its content is N×240 cards +
    // (N-1)×8 gaps + 2×4 cell-padding = 248N — an EXACT fit, no residual.
    //
    // It used to be 256 (= card + 2×pad + 8px slack, SM-62). That slack was
    // added PER UNIT to keep the old flex-WRAP layout from wrapping on
    // sub-pixel rounding — but since SM-136 the epic row is `nowrap`, so the
    // slack only over-allocated each column and left an accumulating ~8px×N
    // gap on the right (user-reported). `.sm-epic-card`/`.sm-loose-card` are
    // flex-shrinkable and `.sm-cell` has overflow-x:auto, so a ≤1px sub-pixel
    // overflow is absorbed without a scrollbar.
    BACKBONE_COL_WIDTH_PX:     248,
    // SM-272: a collapsed process-step column shrinks to this fixed narrow
    // width (independent of how many epics it holds) — fixes the runaway-wide
    // columns. Its cells show a compact "N epics" indicator instead of cards.
    COLLAPSED_COL_WIDTH_PX:     72,
    TICKET_GAP_PX:               8,
    // SM-131: uniform grid — feste Höhen, gespiegelt als CSS-Custom-Props
    // (--sm-card-h, --sm-epic-header-h) auf .sm-grid.
    CARD_HEIGHT_PX:             72,   // feste Story-Karten-Höhe (alle Karten gleich)
    EPIC_HEADER_HEIGHT_PX:      56,   // 2-Zeilen-Titel + Key + Padding
    COLLAPSED_RELEASE_HEIGHT_PX: 40,
    ZOOM_MIN:                  0.5,
    ZOOM_MAX:                  1.5,
    ZOOM_STEP:                 0.1,
    ZOOM_DEFAULT:              1.0,
    // SM-135/136 (Schlanke-Säulen-Umbau): die alten Wrap-Konstanten
    // (TICKETS_PER_COLUMN_DEFAULT, LOOSE_TICKETS_PER_COLUMN, EPICS_PER_ROW)
    // und STORIES_GRID_GAP_PX sind entfallen — jede Epic-/Loose-Säule ist
    // einspaltig und wächst beliebig nach unten, es gibt keinen Sub-Spalten-
    // Wrap und keine Inter-Column-Gap-Mathematik mehr.
    // Stories-Grid padding (mirrors .sm-stories-grid CSS) — wird genutzt um
    // die innere Story-Karten-Breite = STORY_CARD - 2×PAD zu berechnen.
    STORIES_GRID_PADDING_PX:     6,
    FLIP_ANIM_MS:              180,
    // SM-193: the backlog grows unbounded downward as tickets pile up. The wrap
    // is driven by the WHOLE backlog (all sub-lists combined): once the total
    // passes BACKLOG_WRAP_THRESHOLD, each long list balances into card-width
    // columns of at most BACKLOG_TICKETS_PER_COLUMN cards. Total-based, because a
    // backlog split across "Unscheduled" + per-release groups (e.g. 9 + 2 = 11)
    // must still wrap even though no single sub-list exceeds the threshold
    // (user-reported regression on the first per-list implementation).
    BACKLOG_WRAP_THRESHOLD:      10,
    BACKLOG_TICKETS_PER_COLUMN:   6,
    // SM-274/SM-275: Map-Eingang (Bodenstreifen) — Sammelbereich für unzugeordnete
    // Tickets (releaseId leer). Spalten-Flow wie in den Zellen (E9k): Karten
    // füllen vertikal, brechen nach rechts um, eigener horizontaler Scroll.
    // Die Zeilenzahl ist VIEWPORT-reaktiv (SM-275): so viele Zeilen, wie unter
    // den Releases bis zum Fensterboden passen — der Rest bricht nach rechts um.
    // So nutzt der Streifen den vertikalen Raum, ohne über den Viewport hinaus
    // zu wachsen. TRAY_ROWS_DEFAULT ist nur noch der Fallback (vor dem ersten
    // Layout-Measure / in JSDOM / bei sehr hohem Board).
    TRAY_ROWS_DEFAULT:            2,
    TRAY_BODY_PADDING_PX:         8,  // mirrors .sm-tray-body padding (each side)
    TRAY_RESIZE_DEBOUNCE_MS:    150,  // SM-275: debounce window-resize → recompute rows
    // SM-223 (a): `content-visibility: auto` on cells skips layout/paint of
    // off-screen cells — a real win on very large boards, but it makes
    // WebKit/Gecko estimate off-screen cell heights (contain-intrinsic-size) and
    // only settle the row height when the cell scrolls in (a visible jump; Blink
    // hides it by rendering eagerly). Gate it by board size so normal boards are
    // pixel-correct and only genuinely large boards (SM-223's 500+ target) pay
    // the jump for the perf. renderInto toggles `.sm-grid-virtualized`.
    VIRTUALIZE_TICKET_THRESHOLD: 400
  };

  // Type→Cluster mapping zog mit renderTicketCard nach renderer-card.js um.

  const DRAG_TYPES = {
    EPIC:         "epic",
    STORY:        "story",
    PROCESS_STEP: "process-step"
  };
  // Legacy alias retained so existing tests that imported DRAG_FORMATS keep
  // compiling — the underlying drag mechanic switched from HTML5-DT-MIME
  // strings to a pointer-events-based string-type registry.
  const DRAG_FORMATS = DRAG_TYPES;

  const ACTOR_LOCAL = { type: "human", id: "local", name: "Local" };

  // ---- Pure layout -----------------------------------------------------

  // SM-221: instrumentation — how many times the (O(R×S×T)) base layout was
  // actually computed. The drag-layout cache (computeBaseLayout) drives this to
  // ≤1 per drag; tests assert it. Reset/read via the exposed test hooks.
  let _layoutComputeCount = 0;
  // SM-223: instrumentation — how many times renderInto built the FULL grid.
  // The drag-incremental path drives this to 0 per mid-drag pointermove.
  let _gridBuildCount = 0;

  function computeStoryMapLayout(snapshot, opts) {
    _layoutComputeCount += 1;
    opts = opts || {};
    const filter = opts.filter || null;
    // SM-82: when a filter is active, we use the filter module to decide
    // per-ticket visibility AND per-release visibility. Without filterMod
    // (older bundles / tests), the predicates are no-ops.
    // SM-191: the unified smart-bar passes a query-engine-backed predicate as
    // opts.matchTicket. It AND-combines with the SM-82 chip filter so both stay
    // usable (a query narrows the chip-filtered set, and vice versa).
    const matchTicket = (typeof opts.matchTicket === "function") ? opts.matchTicket : null;
    const filterMatch = (filterMod && filter)
      ? (t) => filterMod.matchesFilter(t, filter, filterCtx)
      : (_t) => true;
    const matches = matchTicket ? (t) => filterMatch(t) && matchTicket(t) : filterMatch;
    const visibleRelease = (filterMod && filter)
      ? (r) => filterMod.releaseVisible(r, filter)
      : (_r) => true;
    const filterCtx = (filterMod && filter) ? filterMod.buildReleaseCtx(snapshot) : null;

    // SM-252: newest release on TOP. Releases sort DESCENDING by sortOrder so
    // the most recent (highest sortOrder, appended by createRelease) heads the
    // map and old releases sink to the bottom — the board no longer grows
    // top-heavy with completed releases over time. Story-Map only; the Kanban
    // swimlanes (computeKanbanLayout) keep their own order.
    const releases = (snapshot.releases || [])
      .filter(r => !r.isDeleted && visibleRelease(r))
      .slice()
      .sort((a, b) => (b.sortOrder || 0) - (a.sortOrder || 0));
    const processSteps = (snapshot.processSteps || [])
      .filter(p => !p.isDeleted)
      .slice()
      .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));

    // SM-239: each release row carries its X/Y progress over non-epic work
    // items (the single releaseProgress source, shared with the Kanban).
    const rows = releases.map(r => ({
      id: r.id, name: r.name, kind: "release", entity: r,
      progress: core.releaseProgress(snapshot, r.id)
    }));
    const columns = processSteps.map(p => ({ id: p.id, name: p.name, kind: "processStep", entity: p }));

    // SM-253: tickets with a release but no process-step (not in any cell) are
    // shown per-release in a holding strip — NOT in a global backlog. Grouped
    // by release here so each release row can render + accept its own strip.
    const partial = core.tickets.partiallyAssignedByRelease(snapshot);

    const releasesOut = {};
    for (const r of releases) {
      const cells = {};
      for (const p of processSteps) {
        // SM-82: filter epics + stories per-ticket. When an epic is hidden
        // but its stories aren't, the surviving stories slide into the
        // cell's loose-list (so they're not orphaned to the backlog).
        const allEpics = core.tickets.epicsInCell(snapshot, r.id, p.id);
        const epicEntries = [];
        const evictedStories = [];
        for (const epic of allEpics) {
          const allStories = core.tickets.storiesInEpic(snapshot, epic.id);
          const visibleStories = allStories.filter(matches);
          if (matches(epic)) {
            epicEntries.push({ epic: epic, stories: visibleStories });
          } else {
            // Epic hidden — evicted stories appear in cell-loose, not backlog.
            for (const s of visibleStories) evictedStories.push(s);
          }
        }
        const looseFromCell = core.tickets.looseTicketsInCell(snapshot, r.id, p.id)
          .filter(matches);
        const loose = looseFromCell.concat(evictedStories);
        cells[p.id] = { epics: epicEntries, loose };
      }
      // SM-253: per-release holding zone (release set, no process-step). Epic
      // child stories are filtered here too (where `matches` lives) so an active
      // status/type filter doesn't leak hidden stories into a holding-strip epic.
      const g = partial.get(r.id) || { epics: [], stories: [] };
      const unplaced = {
        epics: g.epics.filter(matches).map(epic => ({
          epic: epic,
          stories: core.tickets.storiesInEpic(snapshot, epic.id).filter(matches)
        })),
        stories: g.stories.filter(matches)
      };
      releasesOut[r.id] = { release: r, cells, unplaced };
    }

    // SM-253: the global Backlog section is gone from the Story Map. Release-LESS
    // tickets (orphan stories, backlog epics) are NOT shown here anymore — they
    // live in the Kanban. Release-assigned-but-unplaced tickets now sit in their
    // release's per-row holding zone (releasesOut[rid].unplaced). `partiallyAssigned`
    // stays in the layout for data consumers/tests; the renderer no longer draws it.
    const partiallyAssigned = releases
      .map(r => {
        const g = partial.get(r.id) || { epics: [], stories: [] };
        return {
          release: r,
          epics:   g.epics.filter(matches),
          stories: g.stories.filter(matches)
        };
      })
      .filter(g => g.epics.length > 0 || g.stories.length > 0);

    const backlog = { epics: [], orphans: [], partiallyAssigned };

    // SM-135 (Schlanke-Säulen-Umbau): jedes Epic ist eine schlanke
    // Ein-Spalten-Säule fester Breite (STORY_CARD_WIDTH_PX). Die Cell-Breite
    // ist damit schlicht die ANZAHL der Säulen × Backbone-Col-Unit, NICHT
    // mehr eine Sub-Col-Summe pro Epic.
    //
    // Säulen pro Cell = #Epics + (lose Tickets vorhanden ? 1 : 0) — die
    // losen Tickets bekommen ihre eigene Säule neben den Epics (SM-136).
    // Multiplier = max über alle Releases (alle Release-Rows teilen sich die
    // Backbone-Spaltenbreite). Stories wachsen innerhalb ihrer Epic-Säule
    // beliebig nach unten (kein Wrap, kein 5er-Cap) und vergrößern damit nur
    // die Höhe, nie die Breite.
    const columnMultipliers = new Map();
    for (const p of processSteps) {
      let maxCols = 1;
      for (const r of releases) {
        const cell = releasesOut[r.id].cells[p.id];
        const looseCol = (cell.loose && cell.loose.length > 0) ? 1 : 0;
        const cols = cell.epics.length + looseCol;
        if (cols > maxCols) maxCols = cols;
      }
      columnMultipliers.set(p.id, Math.max(1, maxCols));
    }

    return { rows, columns, releases: releasesOut, backlog, columnMultipliers };
  }

  // ---- SM-274: Map-Eingang (Bodenstreifen) -----------------------------

  /**
   * Pure layout for the Map-Eingang: collect ALL release-LESS tickets (the work
   * that SM-253 dropped from the map and that the Kanban can't show for epics)
   * and chunk them into column-flow columns of `rows` cards each — cards fill a
   * column top-to-bottom, then the next column starts to the right.
   *
   *   items   flat list (epics first, then orphan stories), each already
   *           sorted by sortOrder within its group.
   *   columns 2D array: columns[k] is the k-th vertical column (≤ rows cards).
   *   rows    the effective row count used for chunking (≥ 1).
   *   count   items.length.
   *
   * opts.rows      number of rows per column (default TRAY_ROWS_DEFAULT).
   * opts.matches   optional per-ticket predicate (filter parity with the cells);
   *                defaults to "everything visible".
   */
  function computeUnassignedTrayLayout(snapshot, opts) {
    opts = opts || {};
    const rows = Math.max(1, Math.floor(opts.rows || STORY_MAP_LAYOUT.TRAY_ROWS_DEFAULT));
    const matches = (typeof opts.matches === "function") ? opts.matches : (_t) => true;
    const epics   = core.tickets.backlogEpics(snapshot).filter(matches);
    const orphans = core.tickets.orphanStories(snapshot).filter(matches);
    const items = epics.concat(orphans);
    const columns = [];
    for (let i = 0; i < items.length; i += rows) columns.push(items.slice(i, i + rows));
    return { items, columns, rows, count: items.length };
  }

  /**
   * SM-275: how many tray rows fit in the space BELOW the grid, inside the
   * viewport. Pure (testable): given the scroller height, the grid height and
   * the tray header height, return floor(available / cardSlot). Falls back to
   * TRAY_ROWS_DEFAULT when there is no room yet (pre-layout / JSDOM measure = 0)
   * or when the board already fills the viewport (a tall board → compact inbox,
   * the rest wraps to the right with horizontal scroll).
   */
  function computeTrayRows(scrollerH, gridH, headerH) {
    const cardSlot = STORY_MAP_LAYOUT.CARD_HEIGHT_PX + STORY_MAP_LAYOUT.TICKET_GAP_PX;
    const avail = (scrollerH || 0) - (gridH || 0) - (headerH || 0)
                - STORY_MAP_LAYOUT.TRAY_BODY_PADDING_PX * 2;
    if (avail < cardSlot) return STORY_MAP_LAYOUT.TRAY_ROWS_DEFAULT;
    return Math.max(1, Math.floor(avail / cardSlot));
  }

  // SM-275: measure the live DOM and apply the viewport-reactive row count to a
  // mounted tray's card grid. The cards are a flat list; grid-auto-flow:column +
  // grid-template-rows do the column wrapping, so only the row template changes —
  // no DOM re-chunk. No-op when the tray is collapsed (no body/grid present).
  function sizeTrayBody(host, tray) {
    if (!host || !tray) return;
    const scroller = host.parentElement;                 // #view-host (the scroll container)
    const mapGrid  = host.querySelector(":scope > .sm-grid");
    // Width is handled purely in CSS now: the strip is a block child of the
    // width:max-content grid, so it fills the full map scroll width on its own.
    // Only the row count is genuinely dynamic (depends on the live viewport).
    const grid = tray.querySelector(".sm-tray-grid");
    if (!grid) return;                                   // collapsed → nothing more to size
    const header = tray.querySelector(".sm-tray-header");
    // The tray is now a child of .sm-grid, so mapGrid.offsetHeight INCLUDES the
    // tray — using it directly would feed the tray's own height back into its
    // row count. Sum the grid's other children (backbone + release rows) instead
    // to get the height of everything ABOVE the tray. Non-circular.
    let releasesH = 0;
    if (mapGrid) {
      for (const child of mapGrid.children) {
        if (child !== tray) releasesH += child.offsetHeight;
      }
    }
    const rows = computeTrayRows(
      scroller ? scroller.clientHeight : 0,
      releasesH,
      header ? header.offsetHeight : 0
    );
    grid.style.gridTemplateRows = "repeat(" + rows + ", " + STORY_MAP_LAYOUT.CARD_HEIGHT_PX + "px)";
  }

  // ---- Drop logic ------------------------------------------------------

  function applyEpicDrop(store, epicId, targetProcessStepId, actor, targetReleaseId) {
    const cur = store.get().tickets.find(t => t.id === epicId);
    if (!cur) return;
    // If targetReleaseId is omitted (test-style 3-arg call), keep current.
    const releaseId = targetReleaseId !== undefined
      ? (targetReleaseId || null)
      : (cur.position && cur.position.releaseId);
    store.moveTicket(epicId, {
      releaseId,
      processStepId: targetProcessStepId || null,
      epicId:        null,
      sortOrder:     (cur.position && cur.position.sortOrder) || 0
    }, actor || ACTOR_LOCAL);
  }

  /** Drag-to-Backlog: clears releaseId (and for stories epicId). */
  function applyBacklogDrop(store, ticketId, ticketType, actor) {
    const cur = store.get().tickets.find(t => t.id === ticketId);
    if (!cur) return;
    store.moveTicket(ticketId, {
      releaseId:     null,
      processStepId: null,
      epicId:        null,
      sortOrder:     (cur.position && cur.position.sortOrder) || 0
    }, actor || ACTOR_LOCAL);
  }

  function applyStoryDrop(store, storyId, targetEpicId, actor) {
    const cur = store.get().tickets.find(t => t.id === storyId);
    if (!cur) return;
    store.moveTicket(storyId, {
      releaseId:     cur.position && cur.position.releaseId,
      processStepId: cur.position && cur.position.processStepId,
      epicId:        targetEpicId || null,
      sortOrder:     (cur.position && cur.position.sortOrder) || 0
    }, actor || ACTOR_LOCAL);
  }

  function applyReleaseReorder(store, orderedReleaseIds, actor) {
    store.reorderReleases(orderedReleaseIds, actor || ACTOR_LOCAL);
  }

  function applyProcessStepReorder(store, orderedStepIds, actor) {
    store.reorderProcessSteps(orderedStepIds, actor || ACTOR_LOCAL);
  }

  // ---- SM-20 Phase A: Position-Only Fast-Path -------------------------
  //
  // The naive renderer wipes `host.innerHTML` and rebuilds the whole DOM on
  // every `applyRemote`. Even though FLIP smoothly animates ticket-card
  // positions afterwards, the structural shells (.sm-cell, .sm-backbone,
  // .sm-release-row, .sm-backlog-section) get rebuilt every time — the user
  // perceives that as a flash UNDER the animation.
  //
  // Phase A short-circuits the most common applyRemote case (reorder via
  // MCP `reorder_tickets`): if the diff between prev and next snapshot is
  // a pure within-container sort-order change for one or more tickets, we
  // skip the wipe-and-rebuild entirely. Instead we re-order the existing
  // card DOM nodes inside their existing parent containers. FLIP captures
  // its rects beforehand and animates the move just like before — but now
  // the structural shell keeps its DOM identity, so there's no flash.
  //
  // Cross-container moves, ticket additions/deletions, structural changes
  // (new release, new ps, AC edits, …) bail out via `null` return and the
  // caller falls back to the existing full-rerender + animate path.

  function cssEscape(s) {
    return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  // SM-52: epic containment is a `contains` link FROM the epic, not
  // `ticket.position.epicId` (which is always null after the migration).
  // Mirrors shared/core.js CONTAINS_LINK_TYPE_ID.
  const CONTAINS_LINK_TYPE_ID = "contains";

  /**
   * Build a `Map<storyId, epicId>` of current containment from the epics'
   * outgoing `contains` links. The applyRemote fast-path diffs pass this so a
   * (re)assignment registers as a container change. Without it, containerKeyOf
   * falls back to the legacy position.epicId (always null post-SM-52), and a
   * story joining an epic was silently classified as "no change" — the bug
   * where stories never appeared under epics over live-sync.
   */
  function containerMapOf(snap) {
    const m = new Map();
    for (const t of ((snap && snap.tickets) || [])) {
      if (t.isDeleted || t.type !== "epic" || !t.links) continue;
      for (const l of t.links) {
        if ((l.linkTypeId || l.type) === CONTAINS_LINK_TYPE_ID) m.set(l.targetTicketId, t.id);
      }
    }
    return m;
  }

  /**
   * Stable key identifying the DOM container a ticket lives in. Two tickets
   * with the same key share a parent in the rendered DOM. `containerMap`
   * (optional Map<storyId, epicId> from containerMapOf) is the canonical SM-52
   * containment source; the position.epicId fallback is legacy-only.
   */
  function containerKeyOf(ticket, containerMap) {
    const p = ticket.position || {};
    const epicId = (containerMap && containerMap.get(ticket.id))
      || (typeof p.epicId === "string" ? p.epicId : null);
    if (epicId) return "epic:" + epicId;
    if (p.releaseId && p.processStepId) {
      return (ticket.type === "epic" ? "cell-epics:" : "cell-loose:")
           + p.releaseId + "/" + p.processStepId;
    }
    if (p.releaseId) return "backlog-rel:" + p.releaseId;
    return "backlog-orphan";
  }

  /**
   * True iff `a` and `b` differ only in `position` (and meta — updatedAt/
   * version/updatedBy which always advance on writes). Everything that
   * affects rendering OUTSIDE of where the card lives is compared.
   */
  function ticketEqualsIgnoringPosition(a, b) {
    if (a.title !== b.title) return false;
    if (a.type !== b.type) return false;
    if (a.description !== b.description) return false;
    if (a.status !== b.status) return false;
    if (a.isDeleted !== b.isDeleted) return false;
    // SM-52: `links` carry the `contains` containment edge (epic membership)
    // AND the dependency badges rendered on the card. A change here must force
    // the structural/full-rerender path — otherwise assigning a story to an
    // epic (or any link edit) is invisible over live-sync.
    if (JSON.stringify(a.links || []) !== JSON.stringify(b.links || [])) return false;
    if (JSON.stringify(a.labels || []) !== JSON.stringify(b.labels || [])) return false;
    if (JSON.stringify(a.acceptanceCriteria || []) !== JSON.stringify(b.acceptanceCriteria || [])) return false;
    if (JSON.stringify((a.definitionOfReady && a.definitionOfReady.items) || []) !==
        JSON.stringify((b.definitionOfReady && b.definitionOfReady.items) || [])) return false;
    if (JSON.stringify((a.definitionOfDone  && a.definitionOfDone.items)  || []) !==
        JSON.stringify((b.definitionOfDone  && b.definitionOfDone.items)  || [])) return false;
    return true;
  }

  /**
   * Returns `Map<containerKey, orderedTicketIds[]>` for the affected
   * containers iff the prev→next diff is a pure within-container sort-order
   * change (no structural changes, no field edits, no cross-container
   * moves, no add/remove). Returns `null` otherwise so the caller falls
   * back to the regular full-rerender path.
   */
  function diffSortOnlyByContainer(prevSnap, nextSnap) {
    if (!prevSnap || !nextSnap) return null;
    if ((prevSnap.releases || []).length     !== (nextSnap.releases || []).length)     return null;
    if ((prevSnap.processSteps || []).length !== (nextSnap.processSteps || []).length) return null;
    // Releases/process-steps: any name/order/etc. change → structural rerender.
    for (let i = 0; i < (prevSnap.releases || []).length; i++) {
      if (JSON.stringify(scrubMeta(prevSnap.releases[i])) !==
          JSON.stringify(scrubMeta(nextSnap.releases[i]))) return null;
    }
    for (let i = 0; i < (prevSnap.processSteps || []).length; i++) {
      if (JSON.stringify(scrubMeta(prevSnap.processSteps[i])) !==
          JSON.stringify(scrubMeta(nextSnap.processSteps[i]))) return null;
    }
    if ((prevSnap.tickets || []).length !== (nextSnap.tickets || []).length) return null;
    const prevMap = containerMapOf(prevSnap);   // SM-52 containment
    const nextMap = containerMapOf(nextSnap);
    const prevById = new Map((prevSnap.tickets || []).map(t => [t.id, t]));
    const affected = new Set();
    for (const next of (nextSnap.tickets || [])) {
      const prev = prevById.get(next.id);
      if (!prev) return null;  // added ticket = structural
      if (!ticketEqualsIgnoringPosition(prev, next)) return null;
      const prevKey = containerKeyOf(prev, prevMap);
      const nextKey = containerKeyOf(next, nextMap);
      if (prevKey !== nextKey) return null;  // cross-container move = full rerender
      const prevOrder = (prev.position && prev.position.sortOrder) || 0;
      const nextOrder = (next.position && next.position.sortOrder) || 0;
      if (prevOrder !== nextOrder) affected.add(nextKey);
    }
    if (affected.size === 0) return new Map();  // truly nothing changed
    const groups = new Map();
    for (const key of affected) {
      const ids = (nextSnap.tickets || [])
        .filter(t => !t.isDeleted && containerKeyOf(t, nextMap) === key)
        .sort((a, b) => ((a.position && a.position.sortOrder) || 0)
                       - ((b.position && b.position.sortOrder) || 0))
        .map(t => t.id);
      groups.set(key, ids);
    }
    return groups;
  }

  function scrubMeta(entity) {
    const out = {};
    for (const k of Object.keys(entity)) {
      if (k === "updatedAt" || k === "updatedBy" || k === "version" || k === "createdAt" || k === "createdBy") continue;
      out[k] = entity[k];
    }
    return out;
  }

  /**
   * Locate the existing DOM container for a given container-key. Returns
   * `null` if the container isn't currently in the DOM (e.g. the cell-loose
   * host doesn't exist because the cell had no loose tickets) — caller
   * then falls back to a full rerender.
   */
  function findContainerForKey(host, key) {
    if (key.indexOf("epic:") === 0) {
      const epicId = key.slice("epic:".length);
      const card = host.querySelector('.sm-epic-card[data-ticket-id="' + cssEscape(epicId) + '"]');
      return card ? card.querySelector(".sm-stories-grid") : null;
    }
    if (key.indexOf("cell-epics:") === 0 || key.indexOf("cell-loose:") === 0) {
      const isEpics = key.indexOf("cell-epics:") === 0;
      const path = key.slice(isEpics ? "cell-epics:".length : "cell-loose:".length);
      const slash = path.indexOf("/");
      const releaseId = path.slice(0, slash);
      const psId      = path.slice(slash + 1);
      const cell = host.querySelector(
        '.sm-cell[data-release-id="' + cssEscape(releaseId) +
        '"][data-process-step-id="' + cssEscape(psId) + '"]'
      );
      return cell ? cell.querySelector(isEpics ? ".sm-cell-epics" : ".sm-cell-loose") : null;
    }
    // backlog-* — Phase A bails so the existing rerender handles them.
    return null;
  }

  /**
   * SM-20 Phase B — detect commits whose only effect on the layout is
   * changing per-ticket CONTENT fields (title/status/AC/DoR/DoD/labels)
   * without changing positions, structure, or the ticket set. Returns a
   * `Set<ticketId>` of changed cards, or `null` to bail.
   *
   * Used together with Phase A so applyRemote-driven `ticket_update`,
   * `check_dod_item`, `change_ticket_status`, etc. don't trigger a full
   * host.innerHTML rebuild — we patch the existing card DOM in place.
   */
  function diffCardContentOnly(prevSnap, nextSnap) {
    if (!prevSnap || !nextSnap) return null;
    if ((prevSnap.releases || []).length     !== (nextSnap.releases || []).length)     return null;
    if ((prevSnap.processSteps || []).length !== (nextSnap.processSteps || []).length) return null;
    for (let i = 0; i < (prevSnap.releases || []).length; i++) {
      if (JSON.stringify(scrubMeta(prevSnap.releases[i])) !==
          JSON.stringify(scrubMeta(nextSnap.releases[i]))) return null;
    }
    for (let i = 0; i < (prevSnap.processSteps || []).length; i++) {
      if (JSON.stringify(scrubMeta(prevSnap.processSteps[i])) !==
          JSON.stringify(scrubMeta(nextSnap.processSteps[i]))) return null;
    }
    if ((prevSnap.tickets || []).length !== (nextSnap.tickets || []).length) return null;
    const prevMap = containerMapOf(prevSnap);   // SM-52 containment
    const nextMap = containerMapOf(nextSnap);
    const prevById = new Map((prevSnap.tickets || []).map(t => [t.id, t]));
    const changed  = new Set();
    for (const next of (nextSnap.tickets || [])) {
      const prev = prevById.get(next.id);
      if (!prev) return null;                                       // add → structural
      // isDeleted toggling is a STRUCTURAL change — the card must enter or
      // leave the DOM, which Phase B's in-place patch can't do. Defer to
      // the full-rerender + morph path, which inserts/removes nodes.
      if (prev.isDeleted !== next.isDeleted) return null;
      // Container must be IDENTICAL — otherwise the card belongs under a
      // different parent (cell, epic, backlog) and Phase A (or full rerender)
      // handles the move. SM-52: containment comes from the contains-link map.
      if (containerKeyOf(prev, prevMap) !== containerKeyOf(next, nextMap)) return null;
      const prevOrder = (prev.position && prev.position.sortOrder) || 0;
      const nextOrder = (next.position && next.position.sortOrder) || 0;
      if (prevOrder !== nextOrder) return null;                     // pure position change → Phase A
      // Compare every visible card surface. Anything else → bail
      // (e.g. labels change, comments — keep this list aligned with
      // ticketEqualsIgnoringPosition so we don't miss something the card
      // doesn't render today but might tomorrow).
      const samples = ["title", "type", "status", "description"];
      let cardChanged = false;
      for (const k of samples) {
        if (prev[k] !== next[k]) { cardChanged = true; break; }
      }
      if (!cardChanged) {
        // SM-52: links changed but container didn't → a dependency-badge edit
        // on a card whose epic membership is unchanged. Re-patch the card.
        if (JSON.stringify(prev.links || []) !== JSON.stringify(next.links || [])) cardChanged = true;
        else if (JSON.stringify(prev.labels || []) !== JSON.stringify(next.labels || [])) cardChanged = true;
        else if (JSON.stringify(prev.acceptanceCriteria || []) !== JSON.stringify(next.acceptanceCriteria || [])) cardChanged = true;
        else if (JSON.stringify((prev.definitionOfReady && prev.definitionOfReady.items) || []) !==
                 JSON.stringify((next.definitionOfReady && next.definitionOfReady.items) || [])) cardChanged = true;
        else if (JSON.stringify((prev.definitionOfDone  && prev.definitionOfDone.items)  || []) !==
                 JSON.stringify((next.definitionOfDone  && next.definitionOfDone.items)  || [])) cardChanged = true;
      }
      if (cardChanged) changed.add(next.id);
    }
    return changed;   // may be empty for a no-op echo
  }

  /**
   * Patch every card DOM node listed in `ticketIds` to match the data in
   * `snap`. Returns `true` if every card was found in the DOM and patched;
   * `false` if any card is missing (caller falls back to full rerender).
   */
  function applyCardContentPatch(host, ticketIds, snap, opts) {
    const byId = new Map((snap.tickets || []).map(t => [t.id, t]));
    for (const id of ticketIds) {
      const ticket = byId.get(id);
      if (!ticket) return false;
      // Epic cards have their own DOM structure (.sm-epic-card) — Phase B
      // skips them by bailing whenever an epic is in the changed set. They
      // still get a full rerender on edits; common edits hit story cards.
      if (ticket.type === "epic") return false;
      const card = host.querySelector('.sm-story-card[data-ticket-id="' + cssEscape(id) + '"]');
      if (!card) return false;
      rendererCard.patchTicketCardInPlace(card, ticket,
        _linkIndex     && _linkIndex.get(ticket.id)     || null,
        _lastExecIndex && _lastExecIndex.get(ticket.id) || null,
        { onTicketClick: opts && opts.onTicketClick });
    }
    return true;
  }

  /**
   * Re-arrange the existing card DOM nodes inside each affected container
   * so that their order matches `groups`. Returns `false` if any required
   * container or card can't be found in the current DOM (caller falls back
   * to the regular rerender then).
   */
  function applySortOnlyReshuffle(host, groups) {
    for (const [key, orderedIds] of groups) {
      const container = findContainerForKey(host, key);
      if (!container) return false;
      for (let i = 0; i < orderedIds.length; i++) {
        const id = orderedIds[i];
        const card = container.querySelector(
          ':scope > [data-ticket-id="' + cssEscape(id) + '"]'
        );
        if (!card) return false;
        const slot = container.children[i];
        if (slot !== card) container.insertBefore(card, slot || null);
      }
    }
    return true;
  }

  // ---- SM-20 Phase C: morphTree DOM reconciler ------------------------
  //
  // Naive renderInto builds a fresh grid off-DOM and replaces the host's
  // entire subtree (`host.innerHTML = ""; host.appendChild(grid)`). Phase
  // A/B short-circuit the most common pure-reorder and pure-content cases,
  // but `ticket_create`, `release_create`, label-rename, and the rare
  // mixed-change still take the slow path. Phase C swaps the slow path
  // for an in-place morph: the existing `.sm-grid` is mutated to match
  // the freshly-built one, preserving DOM identity for every node whose
  // stable key matches. Listeners, dnd registrations and CSS state all
  // survive — the user no longer sees a structural refresh-flash.
  //
  // `morphTree` is a lightweight morphdom: it walks two element trees in
  // parallel, pairs children by `keyOf`, reuses paired nodes, inserts new
  // children where the new tree introduces them, removes old children
  // that are absent in the new tree, and recursively morphs the paired
  // pair. For leaf elements (no element children, just text), it copies
  // textContent directly. Attributes are diffed and patched.
  //
  // Keys we recognize (in priority order):
  //   data-ticket-id        — story + epic cards
  //   data-process-step-id  — backbone columns
  //   data-release-id       — release rows + labels
  //   data-section          — singleton structural blocks we tag below
  //   .sm-cell[data-release-id][data-process-step-id]
  //                         — cells (combined key)

  function keyOf(el) {
    if (!el || el.nodeType !== 1) return null;
    const ds = el.dataset || {};
    const cl = el.classList;
    if (!cl) return null;
    // .sm-release-row and .sm-release-label-row BOTH carry data-release-id —
    // disambiguate by class before falling through to the generic dataset
    // keys below.
    if (cl.contains("sm-release-label-row") && ds.releaseId) return "rel-label-row:" + ds.releaseId;
    if (cl.contains("sm-release-cells")     && ds.releaseId) return "rel-cells-row:" + ds.releaseId;
    if (cl.contains("sm-release-unplaced-row") && ds.releaseId) return "rel-unplaced:" + ds.releaseId;   // SM-253
    if (cl.contains("sm-release-label")     && ds.releaseId) return "rel-label:"     + ds.releaseId;
    if (cl.contains("sm-cell") && ds.releaseId && ds.processStepId) {
      // SM-272: a collapsed cell renders an "N epics" indicator instead of the
      // epic cards — give it a DISTINCT key so the morph fully swaps the node
      // (clean content change + fresh/no drag listeners) instead of partial-
      // morphing card children into a count.
      return (cl.contains("sm-cell-collapsed") ? "cell-collapsed:" : "cell:")
        + ds.releaseId + "/" + ds.processStepId;
    }
    // SM-79 followup: shadow cards (live-preview placeholders during a
    // drag projection) carry the SAME ticket-id as the real card. Without
    // a key distinction, morphTree pairs the shadow node with the new real
    // node after a drop — reusing the shadow's DOM (which has NO drag
    // listener, see renderer-card.js l. 194 "if (isShadow) return card")
    // and discarding the freshly built real card. Result: the post-drop
    // card is undraggable and the SECOND drag silently no-ops. Give shadow
    // cards their own key so morphTree treats them as distinct entities;
    // when the shadow→real transition happens at drop, the shadow is
    // REMOVED and the real card is INSERTED fresh with its listener.
    if (ds.ticketId) {
      return cl.contains("sm-card-shadow")
        ? "ticket-shadow:" + ds.ticketId
        : "ticket:" + ds.ticketId;
    }
    if (ds.processStepId)  return (cl.contains("sm-col-collapsed") ? "ps-collapsed:" : "ps:") + ds.processStepId;
    if (ds.releaseId)      return "rel:" + ds.releaseId;
    if (ds.section)        return "section:" + ds.section;
    // Last-resort: class-based singleton keys.
    if (cl.contains("sm-backbone"))         return "section:backbone";
    if (cl.contains("sm-backbone-corner"))  return "section:backbone-corner";
    if (cl.contains("sm-add-col"))          return "section:add-col";
    if (cl.contains("sm-add-release-btn"))  return "section:add-release-btn";
    if (cl.contains("sm-stories-grid"))     return "stories-grid";
    if (cl.contains("sm-cell-epics"))       return "cell-epics";
    if (cl.contains("sm-cell-loose"))       return "cell-loose";
    if (cl.contains("sm-add-ticket"))       return "cell-add-ticket";
    if (cl.contains("sm-card-info"))        return "card-info";
    if (cl.contains("sm-card-meta"))        return "card-meta";
    if (cl.contains("sm-story-key"))        return "story-key";
    if (cl.contains("sm-story-title"))      return "story-title";
    if (cl.contains("sm-card-status"))      return "card-status";
    if (cl.contains("sm-badge-dor"))        return "badge-dor";
    if (cl.contains("sm-badge-dod"))        return "badge-dod";
    if (cl.contains("sm-col-grip"))         return "col-grip";
    if (cl.contains("sm-col-label"))        return "col-label";
    if (cl.contains("sm-epic-header"))      return "epic-header";
    return null;
  }

  /**
   * Copy attributes + dataset from `newEl` onto `oldEl`. Attributes
   * present on `oldEl` but not on `newEl` are removed. Inline `style`
   * is overwritten wholesale via `style.cssText`.
   */
  function morphAttrs(oldEl, newEl) {
    if (oldEl.tagName !== newEl.tagName) return false;  // signal: can't morph
    // dataset
    const newDs = newEl.dataset || {};
    const oldDs = oldEl.dataset || {};
    for (const k of Object.keys(newDs)) {
      if (k === "birthRender") continue;   // SM-20 instrumentation — never overwrite
      if (oldDs[k] !== newDs[k]) oldEl.dataset[k] = newDs[k];
    }
    for (const k of Object.keys(oldDs)) {
      if (k === "birthRender") continue;   // SM-20 instrumentation — never delete
      if (!(k in newDs)) delete oldEl.dataset[k];
    }
    // className. SM-79: preserve transient drag-state classes that the
    // dnd layer toggles imperatively — they are NOT part of the freshly-
    // rendered off-DOM tree, so a naive `oldEl.className = newEl.className`
    // strips them mid-drag and the user never sees the drop-highlight or
    // the dragging-dim.
    if (oldEl.className !== newEl.className) {
      const preserved = [];
      if (oldEl.classList.contains("sm-drop-target")) preserved.push("sm-drop-target");
      if (oldEl.classList.contains("sm-dragging"))    preserved.push("sm-dragging");
      oldEl.className = newEl.className;
      for (const c of preserved) oldEl.classList.add(c);
    }
    // Other attributes (excluding class + style which we handle separately)
    for (const attr of newEl.attributes) {
      const name = attr.name;
      if (name === "class" || name === "style") continue;
      if (name.startsWith("data-")) continue;  // already handled via dataset
      if (oldEl.getAttribute(name) !== attr.value) oldEl.setAttribute(name, attr.value);
    }
    for (const attr of Array.from(oldEl.attributes)) {
      const name = attr.name;
      if (name === "class" || name === "style") continue;
      if (name.startsWith("data-")) continue;
      if (!newEl.hasAttribute(name)) oldEl.removeAttribute(name);
    }
    // style: overwrite whole cssText (cheaper than per-property diff for our cases)
    if (oldEl.style.cssText !== newEl.style.cssText) oldEl.style.cssText = newEl.style.cssText;
    return true;
  }

  /**
   * Recursively morph `oldEl` to match `newEl`. Reuses DOM identity for
   * keyed children. Returns the morphed element (which is `oldEl`).
   *
   * The two roots must already be paired by the caller — typically by tag
   * or by the host directly. For child reconciliation, we use `keyOf`.
   */
  function morphTree(oldEl, newEl) {
    if (!oldEl || !newEl) return oldEl;
    if (oldEl.nodeType !== 1 || newEl.nodeType !== 1) return oldEl;
    if (oldEl.tagName !== newEl.tagName) {
      // Can't morph different tag types — replace entirely.
      if (oldEl.parentNode) oldEl.parentNode.replaceChild(newEl, oldEl);
      return newEl;
    }
    morphAttrs(oldEl, newEl);
    // Leaf with text content only — no element children — copy text wholesale.
    if (newEl.children.length === 0) {
      if (oldEl.textContent !== newEl.textContent) oldEl.textContent = newEl.textContent;
      return oldEl;
    }
    // Build a key→node map of old children for quick lookup.
    const oldByKey    = new Map();
    const oldUnkeyed  = [];
    for (const child of Array.from(oldEl.children)) {
      const k = keyOf(child);
      if (k != null) oldByKey.set(k, child);
      else           oldUnkeyed.push(child);
    }
    const seenKeys    = new Set();
    const seenUnkeyed = new Set();   // tracks which unkeyed olds got paired
    let unkeyedIdx    = 0;
    // Walk new children left-to-right; insert/move into oldEl at the right spot.
    let cursor = oldEl.firstChild;
    for (const newChild of Array.from(newEl.children)) {
      const k = keyOf(newChild);
      let pair = null;
      if (k != null && oldByKey.has(k)) {
        pair = oldByKey.get(k);
        seenKeys.add(k);
      } else if (k == null && unkeyedIdx < oldUnkeyed.length) {
        const candidate = oldUnkeyed[unkeyedIdx++];
        // Position-paired unkeyed nodes must share tag name; on mismatch
        // we DON'T pair (leave candidate for the cleanup loop to remove).
        if (candidate.tagName === newChild.tagName) {
          pair = candidate;
          seenUnkeyed.add(candidate);
        }
      }
      if (pair) {
        // Move pair into the cursor position if it's not already there.
        if (pair !== cursor) oldEl.insertBefore(pair, cursor);
        morphTree(pair, newChild);
        cursor = pair.nextSibling;
      } else {
        // Brand-new child — insert before cursor (or append if cursor is null).
        oldEl.insertBefore(newChild, cursor);
        // cursor stays the same (newChild is now before it).
      }
    }
    // Remove any old keyed children that weren't paired.
    for (const [k, oldChild] of oldByKey) {
      if (!seenKeys.has(k) && oldChild.parentNode === oldEl) {
        oldEl.removeChild(oldChild);
      }
    }
    // Remove every old unkeyed child that didn't end up paired — covers both
    // "advanced past it due to tag mismatch" and "ran out of new children".
    for (const child of oldUnkeyed) {
      if (!seenUnkeyed.has(child) && child.parentNode === oldEl) {
        oldEl.removeChild(child);
      }
    }
    return oldEl;
  }

  // ---- SM-20 instrumentation (opt-in) ----------------------------------
  //
  // OFF by default. Toggle in DevTools console:
  //   window.STORYMAP_DEBUG_RENDER = true   // enable
  //   window.STORYMAP_DEBUG_RENDER = false  // disable
  // (Takes effect on the NEXT renderInto — refresh isn't needed.)
  //
  // When enabled, every keyed structural node gets a `data-birth-render`
  // attribute on first creation. The Phase-C morph deliberately skips this
  // attribute when copying dataset (see morphAttrs), so a survivor keeps
  // its original birth-render while a fresh replacement shows the current
  // counter. After each render, a console summary line lists per-entity-
  // type preserved/fresh counts so a real DOM rebuild stands out.
  //
  // Found Phase D of SM-20 (FLIP-selector-collision) with this — keep it
  // around for future investigations rather than ripping it out.
  let _renderCounter = 0;

  function debugRenderOn() {
    return typeof window !== "undefined" && !!window.STORYMAP_DEBUG_RENDER;
  }

  function tagBirth(node) {
    if (!debugRenderOn()) return node;
    if (!node || node.nodeType !== 1) return node;
    if (node.dataset && !node.dataset.birthRender) {
      node.dataset.birthRender = String(_renderCounter);
    }
    return node;
  }

  function instrumentationReport(host, renderId) {
    if (!debugRenderOn()) return;
    if (typeof console === "undefined" || typeof console.log !== "function") return;
    const groups = [
      [".sm-grid", "grid"],
      [".sm-backbone", "backbone"],
      [".sm-backbone-col", "ps-cols"],
      [".sm-release-row", "rel-rows"],
      [".sm-release-label-row", "label-rows"],
      [".sm-cell", "cells"],
      [".sm-release-unplaced-row", "rel-unplaced"],
      [".sm-epic-card", "epic-cards"],
      [".sm-story-card", "story-cards"]
    ];
    const rid = String(renderId);
    const lines = [];
    for (const [sel, label] of groups) {
      const nodes = host.querySelectorAll(sel);
      if (nodes.length === 0) continue;
      let preserved = 0, fresh = 0;
      for (const n of nodes) {
        if (n.dataset.birthRender === rid) fresh++;
        else preserved++;
      }
      lines.push(label + ": " + preserved + "p/" + fresh + "f");
    }
    console.log("[SM-20] render #" + renderId + " — " + lines.join(", "));
  }

  // ---- DOM helper ------------------------------------------------------

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
        else if (k === "draggable") e.draggable = !!props[k];
        else e.setAttribute(k, props[k]);
      }
    }
    if (children) for (const c of children) if (c != null) e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    return e;
  }

  // ---- Card renderers --------------------------------------------------

  // Story-Karten kommen aus der geteilten renderer-card.js — wir reichen
  // Story-Map-spezifische Optionen (fixe Card-Breite, projection-clear in
  // onEnd) durch und nutzen das gleiche DOM-Markup wie Kanban.
  function renderStoryCard(t, opts, isShadow, widthOverride) {
    return tagBirth(rendererCard.renderTicketCard(t, {
      onTicketClick: opts && opts.onTicketClick,
      // SM-158: ticket-key links to the full-page editor.
      projectId:     currentSnapshot && currentSnapshot.project && currentSnapshot.project.id,
      dragType:      isShadow ? null : DRAG_TYPES.STORY,
      dragId:        t.id,
      dragOnEnd:     isShadow ? null : (() => { if (_dragProjection) setDragProjection(null); }),
      isShadow:      isShadow,
      width:         typeof widthOverride === "number" ? widthOverride : STORY_MAP_LAYOUT.STORY_CARD_WIDTH_PX,
      linkInfo:      _linkIndex     && _linkIndex.get(t.id)     || null,
      // SM-60: test-definition cards get the last-execution badge.
      lastExecution: _lastExecIndex && _lastExecIndex.get(t.id) || null
    }));
  }

  /**
   * Build the effective story-list for an epic given the active drag
   * projection: origin removed if its current epic equals this one, and
   * the dragged ticket inserted as a shadow at insertionIndex if this
   * epic is the projection target.
   */
  function effectiveStoriesFor(epic, baseStories, snapshot) {
    if (!_dragProjection) return baseStories.map(s => ({ ticket: s, shadow: false }));
    const out = baseStories
      .filter(s => s.id !== _dragProjection.ticketId)
      .map(s => ({ ticket: s, shadow: false }));
    const tgt = _dragProjection.target;
    if (tgt && tgt.type === "epic" && tgt.epicId === epic.id) {
      const draggedTicket = (snapshot.tickets || []).find(t => t.id === _dragProjection.ticketId);
      if (draggedTicket) {
        const idx = Math.max(0, Math.min(out.length, _dragProjection.insertionIndex || 0));
        out.splice(idx, 0, { ticket: draggedTicket, shadow: true });
      }
    }
    return out;
  }

  function renderEpicCard(entry, opts) {
    const epic = entry.epic;
    const isShadow = !!entry.shadow;
    // SM-84: epic-level collapse mirrors SM-83's release-level collapse.
    // opts.collapsedEpics is a Set<epicId>; shadow epics (live-drag preview)
    // are never collapsed regardless of their real state — the user is
    // currently interacting with them and needs to see the destination.
    const isCollapsed = !isShadow
      && !!(opts && opts.collapsedEpics && opts.collapsedEpics.has && opts.collapsedEpics.has(epic.id));
    const card = tagBirth(el("div", {
      class: "sm-epic-card sm-cluster-plum sm-status-" + epic.status
             + (isShadow ? " sm-card-shadow" : "")
             + (isCollapsed ? " sm-epic-card-collapsed" : ""),
      dataset: { ticketId: epic.id, ticketType: "epic" }
    }));
    const header = el("div", { class: "sm-epic-header" });
    const info = el("div", { class: "sm-epic-info" });
    info.appendChild(el("span", { class: "sm-epic-title", text: epic.title }));
    // (SM-238's compact epic-header "X/Y" badge was removed — it crowded the
    // header next to the "+"/chevron and confused the add affordance. Release
    // progress is shown by the per-release X/Y badge, which is enough.)
    if (epic.ticketKey) {
      // SM-158: epic key links to the full-page editor too. Reuse the shared
      // helper but keep the .sm-epic-key class for existing styling/selectors.
      const pid = currentSnapshot && currentSnapshot.project && currentSnapshot.project.id;
      const keyEl = rendererCard.buildTicketKeyEl(epic.ticketKey, pid);
      keyEl.classList.add("sm-epic-key");
      info.appendChild(keyEl);
    }
    header.appendChild(info);
    // SM-49: link badges on epic header (epics participate in dependencies too).
    const epicLinkInfo = _linkIndex && _linkIndex.get(epic.id) || null;
    if (epicLinkInfo && (epicLinkInfo.forward > 0 || epicLinkInfo.backward > 0)) {
      const badges = el("div", { class: "sm-epic-badges" });
      if (epicLinkInfo.forward > 0) {
        const sem = rendererCard.dominantSemantic(epicLinkInfo.forwardSemantics);
        badges.appendChild(rendererCard.buildLinkBadge("forward", epicLinkInfo.forward, sem, epicLinkInfo.forwardTargetKeys, epicLinkInfo));
      }
      if (epicLinkInfo.backward > 0) {
        const sem = rendererCard.dominantSemantic(epicLinkInfo.backwardSemantics);
        badges.appendChild(rendererCard.buildLinkBadge("backward", epicLinkInfo.backward, sem, epicLinkInfo.backwardSourceKeys, epicLinkInfo));
      }
      header.appendChild(badges);
    }
    // SM-84: collapse chevron at the rightmost end of the header — sits AFTER
    // the link-badges so the badges keep their familiar position. ▼ = expanded,
    // ▶ = collapsed. Click stopPropagation so the surrounding card's dblclick-
    // to-edit handler doesn't fire. Shadows skip the chevron — they're drag
    // preview, never user-interactive.
    if (!isShadow) {
      // SM-138: Add-„+" im Header (oben rechts) statt am Karten-Boden — so
      // verbraucht der Add-Affordance keine Karten-Zeile und bricht das Raster
      // nicht. Öffnet onAddTicket mit position.epicId vorbelegt.
      const addBtn = el("button", {
        class: "sm-epic-add",
        type: "button",
        title: "Add story under this epic",
        text: "+"
      });
      addBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (opts && typeof opts.onAddTicket === "function") {
          opts.onAddTicket({
            releaseId:     epic.position && epic.position.releaseId,
            processStepId: epic.position && epic.position.processStepId,
            epicId:        epic.id,
            type:          "user-story"
          });
        }
      });
      header.appendChild(addBtn);
      const chevron = el("button", {
        class: "sm-epic-chevron",
        type: "button",
        title: isCollapsed ? "Expand epic" : "Collapse epic",
        text: isCollapsed ? "▶" : "▼"
      });
      chevron.setAttribute("aria-expanded", isCollapsed ? "false" : "true");
      chevron.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (opts && typeof opts.onToggleEpicCollapsed === "function") {
          opts.onToggleEpicCollapsed(epic.id);
        }
      });
      header.appendChild(chevron);
    }
    card.appendChild(header);

    const effStories = effectiveStoriesFor(epic, entry.stories || [], currentSnapshot);
    // SM-135 (Schlanke-Säulen-Umbau): jedes Epic ist eine schlanke
    // Ein-Spalten-Säule fester Breite (= STORY_CARD_WIDTH_PX, exakt die
    // Breite eines losen Tickets). Stories stapeln einspaltig vertikal und
    // wachsen beliebig nach unten — KEIN Sub-Spalten-Wrap, KEIN 5er-Cap mehr.
    // Damit fluchten Header und jede Story-Zeile über alle Epic-Säulen einer
    // Release-Row hinweg (Ausrichtung by construction).
    const epicW = STORY_MAP_LAYOUT.STORY_CARD_WIDTH_PX;
    card.style.width = epicW + "px";
    if (effStories.length > 0) {
      // Eine Spalte: inside-width = epicW − 2×Grid-Padding (kein inter-col-Gap,
      // weil es nur eine Spalte gibt; der vertikale Abstand kommt vom grid-gap).
      const insideStoryW = epicW - 2 * STORY_MAP_LAYOUT.STORIES_GRID_PADDING_PX;
      const grid = el("div", {
        class: "sm-stories-grid" + (isCollapsed ? " sm-stories-grid-collapsed" : "")
      });
      grid.style.gridAutoFlow = "row";
      grid.style.gridTemplateColumns = insideStoryW + "px";
      // Feste Karten-Höhe pro Zeile; gridAutoRows wächst beliebig mit der
      // Story-Zahl (kein repeat(N)-Cap, kein reservierter Leerraum).
      grid.style.gridAutoRows = "var(--sm-card-h)";
      // SM-84: collapsed on initial render starts at max-height:0 (mirrors
      // the SM-83 cells-row pattern). Toggling owns the transition; this is
      // just the "already collapsed at page-load" starting state.
      if (isCollapsed) grid.style.maxHeight = "0px";
      for (const it of effStories) grid.appendChild(renderStoryCard(it.ticket, opts, it.shadow, insideStoryW));
      card.appendChild(grid);
    }

    // SM-138: Der „+ Add"-Button wanderte vom Karten-Boden in den Epic-Header
    // (oben rechts, siehe oben) — kein Boden-Button mehr.

    // Double-click on header opens the epic-detail modal. Single-click stays
    // a no-op so it doesn't compete with the drag-gesture threshold.
    header.addEventListener("dblclick", (ev) => {
      ev.stopPropagation();
      if (opts && typeof opts.onTicketClick === "function") opts.onTicketClick(epic.id);
    });
    if (isShadow) return card;   // preview-only — no DnD on shadows
    dnd.enableDraggable(card, {
      dragType: DRAG_TYPES.EPIC,
      dragId: epic.id,
      onEnd: () => { if (_dragProjection) setDragProjection(null); }
    });

    // The epic card itself is a drop-target for stories (re-assign to this epic).
    dnd.enableDropTarget(card, {
      accepts: [DRAG_TYPES.STORY],
      onEnter: (el) => el.classList.add("sm-drop-target"),
      onLeave: (el) => el.classList.remove("sm-drop-target"),
      onMove: ({ id, clientY }) => {
        // Compute insertion index from cursor Y vs. existing story rects.
        const grid = card.querySelector(".sm-stories-grid");
        let insertionIndex = 0;
        if (grid) {
          const cards = Array.from(grid.querySelectorAll(".sm-story-card"));
          // Exclude the current shadow card from the index search.
          const realCards = cards.filter(c => !c.classList.contains("sm-card-shadow"));
          insertionIndex = realCards.length;
          for (let i = 0; i < realCards.length; i++) {
            const r = realCards[i].getBoundingClientRect();
            if (clientY < r.top + r.height / 2) { insertionIndex = i; break; }
          }
        }
        setDragProjection({
          ticketId: id,
          target: { type: "epic", epicId: epic.id },
          insertionIndex: insertionIndex
        });
      },
      onDrop:  ({ type, id }) => {
        if (type === DRAG_TYPES.STORY && typeof opts.onStoryDrop === "function") {
          const idx = (_dragProjection && _dragProjection.target
                       && _dragProjection.target.type === "epic"
                       && _dragProjection.target.epicId === epic.id)
                      ? _dragProjection.insertionIndex : undefined;
          opts.onStoryDrop(id, epic.id, idx);
          // SM-84: dropping a story on a collapsed epic auto-expands the
          // epic so the user sees the new story land. Without this the
          // story would silently sit inside the still-collapsed grid.
          if (isCollapsed && opts && typeof opts.onToggleEpicCollapsed === "function") {
            opts.onToggleEpicCollapsed(epic.id);
          }
        }
        setDragProjection(null);
      }
    });

    return card;
  }

  // ---- Cell / Row / Backbone renderers ---------------------------------

  // SM-272: compact cell for a collapsed column — just an "N epics" indicator
  // (N = epics mapped into this Release×Step cell). No cards, no add-button, no
  // drop target; the column is a narrow overview strip until expanded again.
  function renderCollapsedCell(releaseId, processStepId, cellData) {
    const nEpics = ((cellData && cellData.epics) || []).length;
    const nLoose = ((cellData && cellData.loose) || []).length;
    const cell = tagBirth(el("div", {
      class: "sm-cell sm-cell-collapsed",
      dataset: { releaseId, processStepId }
    }));
    // Show the epic count, plus a loose-ticket marker so a cell that holds only
    // loose (epic-less) work doesn't collapse to an empty strip (review).
    const parts = [];
    if (nEpics > 0) parts.push(nEpics + " epic" + (nEpics === 1 ? "" : "s"));
    if (nLoose > 0) parts.push(nLoose + " loose");
    if (parts.length) {
      cell.appendChild(el("span", {
        class: "sm-cell-collapsed-count",
        text: parts.join(" · "),
        title: parts.join(" · ") + " in this cell — expand the column to see them"
      }));
    }
    return cell;
  }

  function renderCell(releaseId, processStepId, cellData, opts) {
    const epicEntries = (cellData && cellData.epics) || [];
    const looseList   = effectiveLooseFor(releaseId, processStepId, (cellData && cellData.loose) || [], currentSnapshot);
    const cell = tagBirth(el("div", {
      class: "sm-cell",
      dataset: { releaseId, processStepId }
    }));
    // SM-136 (Schlanke-Säulen-Umbau): Epic-Säulen UND die Loose-Säule stehen
    // in EINER horizontalen, nicht-wrappenden Reihe (.sm-cell-epics) neben-
    // einander. Die Reihe wird auch dann gebaut, wenn es nur lose Tickets gibt.
    const hasEpics = epicEntries.length > 0;
    const hasLoose = looseList.length > 0;
    if (hasEpics || hasLoose) {
      const row = el("div", { class: "sm-cell-epics" });
      for (const entry of epicEntries) row.appendChild(renderEpicCard(entry, opts));
      if (hasLoose) {
        // Lose Tickets bekommen ihre EIGENE schlanke Säule rechts neben den
        // Epics — mit einem Header-Band auf Epic-Header-Höhe, damit die erste
        // lose Karte exakt mit der ersten Story-Zeile der Epics fluchtet
        // (Baseline by construction). Single-Column, wächst nach unten.
        const looseCard = el("div", { class: "sm-loose-card" });
        looseCard.style.width = STORY_MAP_LAYOUT.STORY_CARD_WIDTH_PX + "px";
        const looseHeader = el("div", { class: "sm-loose-header" });
        looseHeader.appendChild(el("span", { class: "sm-loose-title", text: "Unassigned" }));
        looseCard.appendChild(looseHeader);
        const insideW = STORY_MAP_LAYOUT.STORY_CARD_WIDTH_PX
          - 2 * STORY_MAP_LAYOUT.STORIES_GRID_PADDING_PX;
        const looseHost = el("div", {
          class: "sm-cell-loose",
          title: "Loose tickets — not bound to any epic in this cell"
        });
        looseHost.style.gridTemplateColumns = insideW + "px";
        for (const it of looseList) {
          looseHost.appendChild(renderStoryCard(it.ticket, opts, it.shadow, insideW));
        }
        looseCard.appendChild(looseHost);
        row.appendChild(looseCard);
      }
      cell.appendChild(row);
    }
    // Ghost-style add button at the bottom of every cell (sticky to bottom).
    const add = el("button", {
      class: "sm-add-ticket",
      title: "Add ticket in this cell",
      html: '<span class="sm-add-icon">+</span><span class="sm-add-label">Add Item</span>'
    });
    add.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (opts && typeof opts.onAddTicket === "function") {
        opts.onAddTicket({ releaseId, processStepId });
      }
    });
    cell.appendChild(add);

    // Cells accept BOTH epic- and story-drops.
    //  - Epic on cell: move into this (release, processStep) at projected
    //    insertion index — works for inter-cell move AND intra-cell reorder.
    //  - Story on cell (but not on an epic-card): place as loose ticket in
    //    the cell — clears epicId, keeps releaseId+processStepId.
    dnd.enableDropTarget(cell, {
      accepts: [DRAG_TYPES.EPIC, DRAG_TYPES.STORY],
      onEnter: (el) => el.classList.add("sm-drop-target"),
      onLeave: (el) => el.classList.remove("sm-drop-target"),
      onMove: ({ type, id, clientX, clientY }) => {
        if (type === DRAG_TYPES.EPIC) {
          // Insertion index across the side-by-side epic row (.sm-cell-epics).
          // Compare against real (non-shadow) epic-card mid-X.
          const host = cell.querySelector(".sm-cell-epics");
          let insertionIndex = 0;
          if (host) {
            const real = Array.from(host.children).filter(c => !c.classList.contains("sm-card-shadow"));
            insertionIndex = real.length;
            for (let i = 0; i < real.length; i++) {
              const r = real[i].getBoundingClientRect();
              if (clientX < r.left + r.width / 2) { insertionIndex = i; break; }
            }
          }
          setDragProjection({
            ticketId: id,
            target: { type: "cell-epics", releaseId, processStepId },
            insertionIndex: insertionIndex
          });
          return;
        }
        if (type !== DRAG_TYPES.STORY) return;
        // Insertion index over the loose-list only.
        const host = cell.querySelector(".sm-cell-loose");
        let insertionIndex = 0;
        if (host) {
          const real = Array.from(host.children).filter(c => !c.classList.contains("sm-card-shadow"));
          insertionIndex = real.length;
          for (let i = 0; i < real.length; i++) {
            const r = real[i].getBoundingClientRect();
            if (clientY < r.top + r.height / 2) { insertionIndex = i; break; }
          }
        }
        setDragProjection({
          ticketId: id,
          target: { type: "cell", releaseId, processStepId },
          insertionIndex: insertionIndex
        });
      },
      onDrop:  ({ type, id }) => {
        if (type === DRAG_TYPES.EPIC && typeof opts.onEpicDrop === "function") {
          const idx = (_dragProjection && _dragProjection.target
                       && _dragProjection.target.type === "cell-epics"
                       && _dragProjection.target.releaseId === releaseId
                       && _dragProjection.target.processStepId === processStepId)
                      ? _dragProjection.insertionIndex : undefined;
          opts.onEpicDrop(id, processStepId, releaseId, idx);
        } else if (type === DRAG_TYPES.STORY && typeof opts.onCellStoryDrop === "function") {
          const idx = (_dragProjection && _dragProjection.target
                       && _dragProjection.target.type === "cell"
                       && _dragProjection.target.releaseId === releaseId
                       && _dragProjection.target.processStepId === processStepId)
                      ? _dragProjection.insertionIndex : undefined;
          opts.onCellStoryDrop(id, releaseId, processStepId, idx);
        }
        setDragProjection(null);
      }
    });
    return cell;
  }

  /**
   * Build the effective loose-list for a cell given the active drag
   * projection: origin removed if its current cell equals this one, and
   * the dragged ticket inserted as a shadow at insertionIndex if this
   * cell is the projection target.
   */
  function effectiveLooseFor(releaseId, processStepId, base, snapshot) {
    const proj = _dragProjection;
    if (!proj) return base.map(t => ({ ticket: t, shadow: false }));
    const out = base
      .filter(t => t.id !== proj.ticketId)
      .map(t => ({ ticket: t, shadow: false }));
    const tgt = proj.target;
    if (tgt && tgt.type === "cell"
        && tgt.releaseId === releaseId
        && tgt.processStepId === processStepId) {
      const draggedTicket = (snapshot.tickets || []).find(t => t.id === proj.ticketId);
      if (draggedTicket && draggedTicket.type !== "epic") {
        const idx = Math.max(0, Math.min(out.length, proj.insertionIndex || 0));
        out.splice(idx, 0, { ticket: draggedTicket, shadow: true });
      }
    }
    return out;
  }

  /**
   * Erzeugt `grid-template-columns`-String für Backbone und Cells-Row:
   * pro PS-Spalte eine `calc(multiplier * var(--sm-backbone-col-w))`-
   * Sektion + Add-Column-Slot am rechten Rand (variable Breite). Es gibt
   * KEINE führende Release-Label-Spalte mehr — das Release-Label sitzt in
   * einer eigenen Zeile unter den Cells.
   */
  function gridTemplateForColumns(columns, columnMultipliers, withAddSlot, collapsedColumns) {
    const parts = [];
    for (const c of columns) {
      // SM-272: a collapsed column is a fixed narrow strip — NOT the epic-count-
      // driven columnMultiplier width that made busy columns run very wide.
      if (collapsedColumns && collapsedColumns.has && collapsedColumns.has(c.id)) {
        parts.push(STORY_MAP_LAYOUT.COLLAPSED_COL_WIDTH_PX + "px");
      } else {
        const m = (columnMultipliers && columnMultipliers.get(c.id)) || 1;
        parts.push("calc(" + m + " * var(--sm-backbone-col-w))");
      }
    }
    if (withAddSlot) parts.push("auto");
    return parts.join(" ");
  }

  // SM-245: compute the new process-step order from the CURRENT snapshot (the
  // source of truth) + the drag projection's beforeId — NOT from a captured
  // `columns` array. The Phase-C morph reuses backbone columns by ps:id and
  // keeps their ORIGINAL dnd registration, so a column's onDrop closure holds
  // the pre-drag column order; reading it persisted a stale (no-op) order and
  // the column snapped back. Ticket-reorder (onStoryDrop) is robust for exactly
  // this reason — it reads store.get(). Pure + exported for tests.
  function processStepOrder(snapshot) {
    return ((snapshot && snapshot.processSteps) || [])
      .filter(p => !p.isDeleted)
      .slice()
      .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0))
      .map(p => p.id);
  }
  function sameIdOrder(a, b) {
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }
  function reorderedProcessStepIds(snapshot, draggedId, beforeId) {
    const out = processStepOrder(snapshot).filter(id => id !== draggedId);
    if (beforeId == null) { out.push(draggedId); return out; }
    const at = out.indexOf(beforeId);
    if (at < 0) out.push(draggedId);
    else out.splice(at, 0, draggedId);
    return out;
  }

  function renderBackbone(columns, columnMultipliers, opts) {
    const collapsedColumns = (opts && opts.collapsedColumns) || null;
    const backbone = tagBirth(el("div", { class: "sm-backbone" }));
    backbone.style.gridTemplateColumns = gridTemplateForColumns(columns, columnMultipliers, true, collapsedColumns);
    // No corner spacer anymore — there's no release-label column on the left.
    const proj = _dragProjection;
    const isPsProjection = proj && proj.target && proj.target.type === "process-step";
    for (const c of columns) {
      const isShadow = isPsProjection && proj.ticketId === c.id;
      const isColCollapsed = !!(collapsedColumns && collapsedColumns.has && collapsedColumns.has(c.id));
      const col = tagBirth(el("div", {
        class: "sm-backbone-col" + (isShadow ? " sm-col-shadow" : "") + (isColCollapsed ? " sm-col-collapsed" : ""),
        dataset: { processStepId: c.id },
        title: "Click to edit · drag to reorder"
      }));
      // SM-272: collapse chevron (▼ expanded / ▶ collapsed) at the column head.
      // stopPropagation so it doesn't open the edit dialog; toggles the per-
      // project collapsedColumns set + re-renders (width + cell content change).
      const colChevron = el("button", {
        class: "sm-col-chevron",
        type: "button",
        title: isColCollapsed ? "Expand column" : "Collapse column",
        text: isColCollapsed ? "▶" : "▼"
      });
      colChevron.setAttribute("aria-expanded", isColCollapsed ? "false" : "true");
      colChevron.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (opts && typeof opts.onToggleColumnCollapsed === "function") opts.onToggleColumnCollapsed(c.id);
        if (typeof _rerender === "function") _rerender();
      });
      col.appendChild(colChevron);
      // Grip-handle as a visual cue that the column is draggable.
      col.appendChild(el("span", { class: "sm-col-grip", text: "⋮⋮" }));
      col.appendChild(el("span", { class: "sm-col-label", text: c.name }));
      col.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (opts && typeof opts.onProcessStepClick === "function") opts.onProcessStepClick(c.id);
      });
      dnd.enableDraggable(col, {
        dragType: DRAG_TYPES.PROCESS_STEP,
        dragId: c.id,
        onEnd: () => { if (_dragProjection) setDragProjection(null); }
      });
      dnd.enableDropTarget(col, {
        accepts: [DRAG_TYPES.PROCESS_STEP],
        onEnter: (el) => el.classList.add("sm-col-drop-target"),
        onLeave: (el) => el.classList.remove("sm-col-drop-target"),
        onMove: ({ id, clientX }) => {
          // Project insertion based on cursor-X vs. column-rect midpoint:
          // left half → insert before this col, right half → insert before
          // the NEXT col (or append if this is the last column).
          const rect = col.getBoundingClientRect();
          const insertBefore = clientX < rect.left + rect.width / 2;
          let beforeId;
          if (insertBefore) {
            beforeId = c.id;
          } else {
            const idx = columns.findIndex(x => x.id === c.id);
            const next = columns[idx + 1];
            beforeId = next ? next.id : null;
          }
          // Dragging col over its own slot → no-op projection (beforeId same as id).
          if (beforeId === id) return;
          setDragProjection({
            ticketId: id,
            target: { type: "process-step", beforeId }
          });
        },
        onDrop: ({ id }) => {
          if (typeof opts.onProcessStepReorder !== "function") { setDragProjection(null); return; }
          // SM-245: recompute from the live snapshot + projection beforeId, NOT
          // from the captured `columns` (a morph-reused stale closure may hold
          // the pre-drag order → no-op → snap-back).
          const proj = _dragProjection;
          if (!proj || !proj.target || proj.target.type !== "process-step") { setDragProjection(null); return; }
          const order = reorderedProcessStepIds(currentSnapshot, id, proj.target.beforeId);
          // Skip a no-op drop (order unchanged) so it doesn't create a redundant
          // undo entry / persist (review [minor]).
          if (order.includes(id) && !sameIdOrder(order, processStepOrder(currentSnapshot))) {
            opts.onProcessStepReorder(order);
          }
          setDragProjection(null);
        }
      });
      backbone.appendChild(col);
    }
    if (columns.length === 0) {
      backbone.appendChild(el("div", { class: "sm-backbone-col sm-empty", text: "(no process steps)" }));
    }

    // Add-Column-Dropzone am rechten Rand: Click → +Process-Step-Dialog,
    // ODER Drop von Epic → +Process-Step-Dialog + automatischer Move des
    // Epics in die neue Column.
    const addCol = el("div", {
      class: "sm-backbone-col sm-add-col",
      title: "Click to add a new process step, or drag an epic here"
    });
    addCol.appendChild(el("span", { class: "sm-add-icon", text: "+" }));
    addCol.appendChild(el("span", { class: "sm-add-col-label", text: "Add step" }));
    addCol.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (opts && typeof opts.onAddProcessStep === "function") opts.onAddProcessStep();
    });
    dnd.enableDropTarget(addCol, {
      accepts: [DRAG_TYPES.EPIC, DRAG_TYPES.STORY, DRAG_TYPES.PROCESS_STEP],
      onEnter: (el) => el.classList.add("sm-drop-target"),
      onLeave: (el) => el.classList.remove("sm-drop-target"),
      onMove: ({ type, id }) => {
        // PS drop on add-col = "insert at end". Project accordingly so the
        // user sees the column slide to the end in real time.
        if (type !== DRAG_TYPES.PROCESS_STEP) return;
        setDragProjection({
          ticketId: id,
          target: { type: "process-step", beforeId: null }
        });
      },
      onDrop:  ({ type, id }) => {
        if (type === DRAG_TYPES.PROCESS_STEP) {
          if (typeof opts.onProcessStepReorder === "function") {
            // SM-245: drop on the add-col = append. Recompute from the live
            // snapshot (robust against a morph-reused stale closure).
            const order = reorderedProcessStepIds(currentSnapshot, id, null);
            if (order.includes(id) && !sameIdOrder(order, processStepOrder(currentSnapshot))) {
              opts.onProcessStepReorder(order);
            }
          }
          setDragProjection(null);
          return;
        }
        if (typeof opts.onAddProcessStepWithTicket === "function") {
          opts.onAddProcessStepWithTicket(id, type);
        }
      }
    });
    backbone.appendChild(addCol);

    return backbone;
  }

  /** Cells-Zeile pro Release — nur die Cells, kein Label mehr. */
  function renderReleaseCellsRow(row, releaseData, columns, columnMultipliers, opts, isCollapsed) {
    const collapsedColumns = (opts && opts.collapsedColumns) || null;
    const releaseStatus = (row.entity && row.entity.status) || null;
    const r = tagBirth(el("div", {
      class: "sm-release-row sm-release-cells" + (isCollapsed ? " sm-release-collapsed-cells" : ""),
      dataset: { releaseId: row.id, status: releaseStatus || "" }
    }));
    r.style.gridTemplateColumns = gridTemplateForColumns(columns, columnMultipliers, true, collapsedColumns);
    // SM-83: collapsed releases on initial render get an inline max-height:0
    // so the row doesn't paint at full height before JS hooks up. Toggling
    // owns the transition animation; this is just the "already collapsed
    // at page-load" starting state.
    if (isCollapsed) r.style.maxHeight = "0px";
    if (columns.length === 0) {
      r.appendChild(el("div", { class: "sm-cell sm-empty", text: "Add process steps to map epics into columns." }));
    } else {
      for (const c of columns) {
        const cellData = releaseData.cells[c.id] || { epics: [], loose: [] };
        // SM-272: a collapsed column shows a compact epic-count per cell.
        if (collapsedColumns && collapsedColumns.has && collapsedColumns.has(c.id)) {
          r.appendChild(renderCollapsedCell(row.id, c.id, cellData));
        } else {
          r.appendChild(renderCell(row.id, c.id, cellData, opts));
        }
      }
    }
    // Filler on the right to occupy the add-step slot from the backbone.
    r.appendChild(el("div", { class: "sm-row-filler" }));
    return r;
  }

  /**
   * Label-Zeile pro Release: linksbündiges Release-Label (klickbar →
   * Edit-Dialog). Wenn `showAddRelease === true`, kommt zusätzlich ein
   * `+ Add Release`-Button daneben. SM-252: das ist jetzt die OBERSTE
   * Release-Zeile (neueste-oben), nicht mehr die unterste.
   *
   * SM-83: Chevron-Toggle vor dem Label klappt die Cells-Row der Release
   * ein/aus. Collapsed-State ist View-only (lebt in opts.collapsedReleases),
   * Persistenz via main.js (localStorage).
   */
  function renderReleaseLabelRow(row, showAddRelease, opts, isCollapsed) {
    // SM-80: surface release.status as data-status so CSS can dim completed
    // releases and a pill can sit next to the label.
    const releaseStatus = (row.entity && row.entity.status) || null;
    // SM-169: the header (chevron + name + pill) is built by the SHARED
    // component so the Kanban swimlanes render releases identically.
    const trailing = [];
    if (showAddRelease) {
      const add = el("button", {
        class: "sm-add-release-btn",
        title: "Add another release on top",
        html: '<span class="sm-add-icon">+</span><span class="sm-add-label">Add Release</span>'
      });
      add.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (opts && typeof opts.onAddRelease === "function") opts.onAddRelease();
      });
      trailing.push(add);
    }
    const rowEl = tagBirth(rendererCard.renderReleaseLabelRow({
      id:        row.id,
      name:      row.name,
      status:    releaseStatus,
      progress:  row.progress,   // SM-239
      collapsed: isCollapsed,
      onToggleCollapsed: (id) => {
        if (opts && typeof opts.onToggleReleaseCollapsed === "function") opts.onToggleReleaseCollapsed(id);
      },
      onLabelClick: (id) => {
        if (opts && typeof opts.onReleaseClick === "function") opts.onReleaseClick(id);
      },
      trailing
    }));
    // SM-253: the release header is a drop target — dropping a card here
    // re-homes it to THIS release as unplaced (release set, no process-step),
    // so it shows in the release's holding strip. This is the always-present
    // unplace target (the holding strip only renders when non-empty). Clicks
    // still open the edit dialog (dnd uses a drag threshold).
    dnd.enableDropTarget(rowEl, {
      accepts: [DRAG_TYPES.EPIC, DRAG_TYPES.STORY],
      onEnter: (el) => el.classList.add("sm-drop-target"),
      onLeave: (el) => el.classList.remove("sm-drop-target"),
      onDrop: ({ id, type }) => {
        if (opts && typeof opts.onReleaseUnplacedDrop === "function") opts.onReleaseUnplacedDrop(id, type, row.id);
        setDragProjection(null);
      }
    });
    return rowEl;
  }

  // SM-253: per-release holding strip for release-assigned-but-unplaced tickets
  // (release set, no process-step). Cards are drag SOURCES (drag into a cell to
  // place them); the strip is also a drop target (re-home here, unplaced).
  // Rendered only when the release has such tickets — no empty-strip clutter.
  function renderReleaseUnplacedRow(row, unplaced, opts) {
    const strip = tagBirth(el("div", { class: "sm-release-unplaced-row", dataset: { releaseId: row.id } }));
    strip.appendChild(el("div", { class: "sm-release-unplaced-label",
      text: "Unplaced — drag into a step" }));
    const list = el("div", { class: "sm-release-unplaced-list" });
    for (const e of unplaced.epics) {
      list.appendChild(renderEpicCard({ epic: e.epic, stories: e.stories }, opts));
    }
    for (const story of unplaced.stories) {
      list.appendChild(renderStoryCard(story, opts));
    }
    strip.appendChild(list);
    dnd.enableDropTarget(strip, {
      accepts: [DRAG_TYPES.EPIC, DRAG_TYPES.STORY],
      onEnter: (el) => el.classList.add("sm-drop-target"),
      onLeave: (el) => el.classList.remove("sm-drop-target"),
      onDrop: ({ id, type }) => {
        if (opts && typeof opts.onReleaseUnplacedDrop === "function") opts.onReleaseUnplacedDrop(id, type, row.id);
        setDragProjection(null);
      }
    });
    return strip;
  }

  // SM-193: insertion index for a drop into the (possibly multi-column) backlog
  // list. `rects` are the non-shadow card bounding boxes in DOM order — which IS
  // the flat column-major order (CSS columns fill top→bottom, then the next
  // column). A single column reduces to the plain cursor-Y midpoint walk. For
  // multiple columns we FIRST pick the column the cursor is over (by X), then do
  // the Y-midpoint walk WITHIN that column — without this the pure-Y walk matches
  // a card at the top of a later column and drops land visually wrong.
  function columnAwareInsertionIndex(rects, x, y) {
    if (!rects || rects.length === 0) return 0;
    const cols = [];   // [{ left, right, items: [{idx, top, bottom}] }] grouped by left edge
    for (let i = 0; i < rects.length; i++) {
      const r = rects[i];
      let col = null;
      for (let k = 0; k < cols.length; k++) { if (Math.abs(cols[k].left - r.left) < 1) { col = cols[k]; break; } }
      if (!col) { col = { left: r.left, right: r.right, items: [] }; cols.push(col); }
      col.right = Math.max(col.right, r.right);
      col.items.push({ idx: i, top: r.top, bottom: r.bottom });
    }
    cols.sort((a, b) => a.left - b.left);
    // Column whose horizontal band is nearest the cursor X (0 distance = inside).
    let target = cols[0], best = Infinity;
    for (let k = 0; k < cols.length; k++) {
      const c = cols[k];
      const dist = x < c.left ? c.left - x : (x > c.right ? x - c.right : 0);
      if (dist < best) { best = dist; target = c; }
    }
    // First card in that column (DOM order = top→bottom) whose mid-Y is below y.
    for (let j = 0; j < target.items.length; j++) {
      const it = target.items[j];
      if (y < (it.top + it.bottom) / 2) return it.idx;
    }
    // Below every card in this column → after its last card, which in flat
    // column-major order is the first card of the next column.
    return target.items[target.items.length - 1].idx + 1;
  }


  // currentSnapshot is captured per-mount so card renderers (epic story-lists,
  // the per-release holding strip) can grab fresh story-lists from the snapshot.
  let currentSnapshot = null;
  // SM-49: per-render link-index built once at the top of renderInto and
  // consumed by every renderStoryCard / renderEpicCard call further down.
  // O(N+links) up-front beats O(links) per card.
  let _linkIndex = null;
  // SM-60: last-execution per test-definition. Same pattern as _linkIndex —
  // compute once per renderInto, then look up per card.
  let _lastExecIndex = null;

  // _dragProjection drives live-reorder rendering during an active drag.
  // Shape: { ticketId, target: { type:"epic", epicId } | { type:"backlog" },
  //          insertionIndex }. `_rerender` is wired by mount() so the
  //          projection setter can trigger a full re-render.
  let _dragProjection = null;
  let _rerender       = null;

  // SM-274: collapse-state of the Map-Eingang (Bodenstreifen). Module-level so
  // it survives the tray's rebuild-on-every-render (the render reads it; the
  // header toggle flips it + triggers _rerender) — no reliance on DOM identity.
  let _trayCollapsed  = false;

  // SM-221: drag-layout cache. The base story-map layout (computeStoryMapLayout,
  // O(Releases×Steps×Tickets)) is recomputed on EVERY pointermove today because
  // setDragProjection → _rerender → renderInto recomputes it. During a drag the
  // snapshot does not change, so we compute it ONCE and reuse it; only the pure
  // projection helpers (applyEpicCellProjection / applyProcessStepProjection /
  // effectiveStoriesFor) run per move on top of the cached base. Keyed on the
  // (snapshot, filter, matchTicket) REFERENCES — any store commit produces a new
  // snapshot reference, so a commit mid-drag (WS-push from MCP) auto-invalidates.
  let _baseLayoutCache = null;   // { snap, filter, matchTicket, layout } | null

  function computeBaseLayout(snap, filter, matchTicket) {
    if (_baseLayoutCache
        && _baseLayoutCache.snap === snap
        && _baseLayoutCache.filter === filter
        && _baseLayoutCache.matchTicket === matchTicket) {
      return _baseLayoutCache.layout;
    }
    const layout = computeStoryMapLayout(snap, { filter: filter, matchTicket: matchTicket });
    _baseLayoutCache = { snap: snap, filter: filter, matchTicket: matchTicket, layout: layout };
    return layout;
  }

  function setDragProjection(p) {
    // Reference-equality fast path so onMove tick that produces the same
    // {target, insertionIndex/beforeId} doesn't trigger a re-render.
    if (p && _dragProjection
        && p.ticketId === _dragProjection.ticketId
        && p.insertionIndex === _dragProjection.insertionIndex
        && p.target && _dragProjection.target
        && p.target.type === _dragProjection.target.type
        && p.target.epicId === _dragProjection.target.epicId
        && p.target.beforeId === _dragProjection.target.beforeId
        && p.target.releaseId === _dragProjection.target.releaseId
        && p.target.processStepId === _dragProjection.target.processStepId) {
      return;
    }
    // SM-221: drag-end (p == null) drops the cache so the drop render recomputes
    // the base layout once ("Recalc erst beim Drop"). Drop/cancel/end all funnel
    // here via clearDragProjection / onEnd, so this is the single clear point.
    if (!p) _baseLayoutCache = null;
    const prev = _dragProjection;
    _dragProjection = p;
    // SM-223 (d): mid-drag (same dragged ticket, projection → projection) the
    // affected containers are rebuilt + morphed in place — the full grid
    // build+morph (the actual per-move cost) is skipped. Drag start (prev
    // null), drag end (p null) and unsupported shapes take the full path.
    if (p && prev && p.ticketId === prev.ticketId
        && tryIncrementalDragUpdate(prev, p)) {
      return;
    }
    if (typeof _rerender === "function") _rerender();
  }

  /**
   * Apply an active epic-on-cell drag projection: remove the dragged epic
   * from every cell it currently occupies, then insert it as a shadow
   * entry into the target cell at insertionIndex. Pure-ish — the layout's
   * `releases.{rid}.cells.{psid}.epics` arrays are cloned and replaced.
   */
  function applyEpicCellProjection(layout, snapshot) {
    const proj = _dragProjection;
    if (!proj || !proj.target || proj.target.type !== "cell-epics") return layout;
    const draggedId = proj.ticketId;
    const tgtRel    = proj.target.releaseId;
    const tgtPs     = proj.target.processStepId;
    const insertionIndex = proj.insertionIndex || 0;
    const draggedTicket = (snapshot.tickets || []).find(t => t.id === draggedId);
    if (!draggedTicket || draggedTicket.type !== "epic") return layout;
    // SM-97: keep the dragged epic in its HOME cell during cross-cell projections.
    // The dnd layer styles the origin DOM with .sm-dragging for a ghost effect;
    // crucially the source cell does NOT shrink. Removing the epic would
    // shrink the source by one card's height + (when the epic has stories)
    // its sub-grid, shifting the whole layout. The cursor stays at a fixed
    // window-Y while the layout moves under it, so the next pointermove
    // re-projects to a cell the user is no longer aiming at — most visibly
    // for cross-release moves. Intra-cell reorder (source == target) still
    // filters so the shadow can be re-inserted at the projected index.
    const homeRel = draggedTicket.position && draggedTicket.position.releaseId;
    const homePs  = draggedTicket.position && draggedTicket.position.processStepId;

    const newReleases = {};
    for (const rid of Object.keys(layout.releases)) {
      const src = layout.releases[rid];
      const newCells = {};
      for (const psid of Object.keys(src.cells)) {
        const srcCell = src.cells[psid];
        const isHomeCell   = (rid === homeRel && psid === homePs);
        const isTargetCell = (rid === tgtRel  && psid === tgtPs);
        const isCrossCell  = !(homeRel === tgtRel && homePs === tgtPs);
        let epics;
        if (isHomeCell && isCrossCell && !isTargetCell) {
          // Cross-cell, this is the home cell, not the target → keep epic.
          epics = srcCell.epics;
        } else {
          // Either intra-cell reorder, or non-home cell, or home cell that
          // also happens to be the target — filter out so we can re-insert
          // the shadow at the projected index without duplicating.
          epics = srcCell.epics.filter(e => e.epic.id !== draggedId);
        }
        if (isTargetCell) {
          const idx = Math.max(0, Math.min(epics.length, insertionIndex));
          epics = epics.slice();
          epics.splice(idx, 0, {
            epic:    draggedTicket,
            stories: core.tickets.storiesInEpic(snapshot, draggedId),
            shadow:  true
          });
        }
        newCells[psid] = Object.assign({}, srcCell, { epics });
      }
      newReleases[rid] = Object.assign({}, src, { cells: newCells });
    }
    return Object.assign({}, layout, { releases: newReleases });
  }

  /**
   * Apply an active process-step drag projection to the layout's columns
   * array — origin column is removed and re-inserted at the projected
   * position (before `beforeId`, or appended if beforeId == null). Cells
   * follow automatically because renderReleaseRow iterates `columns`.
   */
  function applyProcessStepProjection(layout) {
    const proj = _dragProjection;
    if (!proj || !proj.target || proj.target.type !== "process-step") return layout;
    const draggedId = proj.ticketId;
    const beforeId  = proj.target.beforeId;
    const cols = layout.columns.slice();
    const origIdx = cols.findIndex(c => c.id === draggedId);
    if (origIdx < 0) return layout;
    const [dragged] = cols.splice(origIdx, 1);
    if (beforeId == null) {
      cols.push(dragged);
    } else {
      const insertIdx = cols.findIndex(c => c.id === beforeId);
      if (insertIdx < 0) cols.push(dragged);
      else cols.splice(insertIdx, 0, dragged);
    }
    return Object.assign({}, layout, { columns: cols });
  }
  function clearDragProjection() { setDragProjection(null); }

  // ---- SM-223 (d): drag-incremental DOM update --------------------------
  //
  // SM-221 removed the per-move layout recompute, but the dragMove benchmark
  // showed the REAL per-move cost is renderInto building a fresh full grid +
  // Phase-C morphing every card (~200ms at N=500). Mid-drag, a projection
  // change only affects a handful of containers: the previous target, the new
  // target, and (for epic-cell drags) the dragged epic's home cell. We rebuild
  // ONLY those subtrees with the SAME builder the full path uses (renderCell
  // reads the live _dragProjection) and morph them in place — byte-identical
  // DOM by construction, at a fraction of the work.
  // Unsupported shapes (process-step column reorder, lookup misses, a commit
  // mid-drag) return false and fall back to the full render path.

  // Wired by mount(): { host, opts } — the same wrappedOpts renderInto uses.
  let _dragRenderCtx = null;

  /**
   * The containers a projection touches: a list of cell keys and/or the
   * backlog section. Returns null when the projection type can't be handled
   * incrementally (e.g. process-step column reorder).
   */
  function projectionContainers(proj, snap) {
    const t = (proj && proj.target) || {};
    if (t.type === "epic") {
      const epic = (snap.tickets || []).find(x => x.id === t.epicId);
      if (!epic) return null;
      const rid = epic.position && epic.position.releaseId;
      const pid = epic.position && epic.position.processStepId;
      // SM-253: a fully-placed epic → its cell. A partially-assigned epic (in a
      // holding strip, no process-step) has no cell to morph incrementally —
      // bail to the full render path so its drag preview still updates.
      if (!(rid && pid)) return null;
      return { cells: [{ releaseId: rid, processStepId: pid }] };
    }
    if (t.type === "cell") {
      return { cells: [{ releaseId: t.releaseId, processStepId: t.processStepId }] };
    }
    if (t.type === "cell-epics") {
      // applyEpicCellProjection touches the target cell AND the dragged
      // epic's home cell (SM-97 keep-in-home semantics) — rebuild both.
      const dragged = (snap.tickets || []).find(x => x.id === proj.ticketId);
      const hrid = dragged && dragged.position && dragged.position.releaseId;
      const hpid = dragged && dragged.position && dragged.position.processStepId;
      if (!hrid || !hpid) return null;   // partially-assigned epic dragged over cells — full path
      return {
        cells: [
          { releaseId: t.releaseId, processStepId: t.processStepId },
          { releaseId: hrid, processStepId: hpid }
        ]
      };
    }
    // SM-253: no more "backlog" projection target (the global backlog is gone).
    return null;
  }

  /**
   * Incrementally apply a projection change prev → next on the live DOM.
   * Returns true when handled (full render skipped). Both projections'
   * containers are rebuilt so the shadow disappears from the old target and
   * appears at the new one.
   */
  function tryIncrementalDragUpdate(prev, next) {
    const ctx = _dragRenderCtx;
    if (!ctx || !ctx.host || !ctx.store || !_baseLayoutCache) return false;
    // A commit mid-drag produces a new snapshot reference → the cached base
    // no longer matches → full render (which rebuilds the cache). Guard
    // against the STORE's snapshot, not currentSnapshot: the Phase-A/B
    // fast-paths handle applyRemote commits WITHOUT renderInto, so
    // currentSnapshot and the cache would both be stale together and an
    // incremental morph would visually revert the remote change (review
    // finding on SM-223).
    const snap = ctx.store.get();
    if (!snap || _baseLayoutCache.snap !== snap) return false;
    const a = projectionContainers(prev, snap);
    const b = projectionContainers(next, snap);
    if (!a || !b) return false;
    const cellKeys = new Map();
    for (const c of a.cells.concat(b.cells)) {
      cellKeys.set(c.releaseId + " " + c.processStepId, c);
    }
    // The projected layout for cell-epics targets; a no-op for the others.
    const layout = applyEpicCellProjection(_baseLayoutCache.layout, snap);
    for (const c of cellKeys.values()) {
      const sel = '.sm-cell[data-release-id="' + cssEscape(c.releaseId) +
                  '"][data-process-step-id="' + cssEscape(c.processStepId) + '"]';
      const oldCell = ctx.host.querySelector(sel);
      const rel = layout.releases[c.releaseId];
      const cellData = rel && rel.cells && rel.cells[c.processStepId];
      if (!oldCell || !cellData) return false;
      morphTree(oldCell, renderCell(c.releaseId, c.processStepId, cellData, ctx.opts));
    }
    return true;
  }

  /**
   * Wenn ProcessSteps existieren aber keine Release, zeigen wir leere
   * Phantom-Cells unter dem Backbone + eine Label-Zeile mit reinem
   * "+ Add Release"-Button (kein vorhandenes Label, nur die CTA).
   */
  function renderPhantomReleaseRows(columns, columnMultipliers, opts) {
    const collapsedColumns = (opts && opts.collapsedColumns) || null;
    const cells = el("div", { class: "sm-release-row sm-release-cells sm-phantom-row" });
    cells.style.gridTemplateColumns = gridTemplateForColumns(columns, columnMultipliers, true, collapsedColumns);
    for (const c of columns) {
      cells.appendChild(el("div", {
        class: "sm-cell sm-phantom-cell",
        dataset: { processStepId: c.id }
      }));
    }
    cells.appendChild(el("div", { class: "sm-row-filler" }));

    const labelRow = el("div", { class: "sm-release-label-row sm-phantom-label-row" });
    const btn = el("button", {
      class: "sm-add-release-btn sm-phantom-cta",
      title: "Add release",
      html: '<span class="sm-add-icon">+</span><span class="sm-add-label">Add Release</span>'
    });
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (opts && typeof opts.onAddRelease === "function") opts.onAddRelease();
    });
    labelRow.appendChild(btn);
    // SM-192: label (heading) above the cells, consistent with real releases.
    return [labelRow, cells];
  }

  // SM-274/SM-276: render the Map-Eingang (Bodenstreifen). Returns the `.sm-tray`
  // node or null when there is nothing unassigned (no empty strip clutters the
  // map). SM-276: cards are drag sources (drop on a cell/epic = schedule via the
  // existing cell handlers) and the strip is itself a drop target (drop a
  // scheduled card here = unassign it back to the inbox).
  function renderUnassignedTray(snapshot, opts) {
    // Filter parity with the cells: SM-82 chip filter AND-combined with the
    // SM-191 query predicate, mirroring computeStoryMapLayout.
    const filter      = (opts && opts.filter) || null;
    const matchTicket = (opts && typeof opts.matchTicket === "function") ? opts.matchTicket : null;
    const filterCtx   = (filterMod && filter) ? filterMod.buildReleaseCtx(snapshot) : null;
    const filterMatch = (filterMod && filter)
      ? (t) => filterMod.matchesFilter(t, filter, filterCtx)
      : (_t) => true;
    const matches = matchTicket ? (t) => filterMatch(t) && matchTicket(t) : filterMatch;

    const tray = computeUnassignedTrayLayout(snapshot, {
      rows: STORY_MAP_LAYOUT.TRAY_ROWS_DEFAULT,
      matches: matches
    });
    if (tray.count === 0) return null;

    const onToggle = () => {
      _trayCollapsed = !_trayCollapsed;
      if (typeof _rerender === "function") _rerender();
    };

    const header = el("div", { class: "sm-tray-header" }, [
      el("button", {
        class: "sm-tray-toggle", type: "button",
        "aria-expanded": _trayCollapsed ? "false" : "true",
        title: _trayCollapsed ? "Eingang ausklappen" : "Eingang einklappen",
        onclick: onToggle
      }, [ _trayCollapsed ? "▸" : "▾" ]),
      el("span", { class: "sm-tray-title", text: "Unassigned" }),
      el("span", { class: "sm-tray-count", text: String(tray.count) })
    ]);

    const root = el("div", {
      class: "sm-tray" + (_trayCollapsed ? " sm-tray-collapsed" : ""),
      dataset: { section: "unassigned-tray" }
    }, [ header ]);

    // SM-276: the strip is a drop target — dropping a scheduled card here clears
    // its release (unassign back to the inbox). Accepts both stories and epics.
    dnd.enableDropTarget(root, {
      accepts: [DRAG_TYPES.STORY, DRAG_TYPES.EPIC],
      onDrop: ({ id }) => {
        if (typeof opts.onTrayDrop === "function") opts.onTrayDrop(id);
      }
    });

    if (!_trayCollapsed) {
      const cardGrid = el("div", {
        class: "sm-tray-grid",
        style: {
          gridTemplateRows: "repeat(" + tray.rows + ", " + STORY_MAP_LAYOUT.CARD_HEIGHT_PX + "px)",
          gridAutoColumns:  STORY_MAP_LAYOUT.STORY_CARD_WIDTH_PX + "px"
        }
      });
      for (const t of tray.items) {
        // SM-276: epics drag as EPIC (drop on a cell → schedule via onEpicDrop),
        // everything else as STORY (drop on a cell/epic → onCellStoryDrop /
        // onStoryDrop). Clearing any leftover drag projection on end.
        cardGrid.appendChild(rendererCard.renderTicketCard(t, {
          onTicketClick: opts && opts.onTicketClick,
          projectId:     snapshot && snapshot.project && snapshot.project.id,
          width:         STORY_MAP_LAYOUT.STORY_CARD_WIDTH_PX,
          dragType:      t.type === "epic" ? DRAG_TYPES.EPIC : DRAG_TYPES.STORY,
          dragId:        t.id,
          dragOnEnd:     () => { if (_dragProjection) setDragProjection(null); },
          linkInfo:      _linkIndex     && _linkIndex.get(t.id)     || null,
          lastExecution: _lastExecIndex && _lastExecIndex.get(t.id) || null
        }));
      }
      // No inline max-height: the row count (set by sizeTrayBody after mount)
      // drives the body height, so the strip fills the available vertical space
      // without overflowing the viewport. grid-template-rows starts at the
      // fallback (tray.rows) and is updated to the viewport-reactive count.
      const body = el("div", { class: "sm-tray-body" }, [ cardGrid ]);
      root.appendChild(body);
    }
    return root;
  }

  function renderInto(host, store, opts) {
    const snap = store.get();
    currentSnapshot = snap;
    _linkIndex     = rendererCard.computeLinkIndex(snap);          // SM-49
    _lastExecIndex = rendererCard.computeLastExecutionIndex(snap); // SM-60
    _renderCounter += 1;   // SM-20 instrumentation: unique render id
    _gridBuildCount += 1;  // SM-223 instrumentation: full grid builds
    // SM-221: base layout from the drag-cache (computed once per snapshot);
    // the projection helpers run on top per pointermove without recomputing it.
    // We canonicalise the key here (falsy filter → null; non-function matchTicket
    // → null, mirroring computeStoryMapLayout's own coercion) so a drag's
    // rerenders always hit the same cache entry.
    const baseLayout = computeBaseLayout(snap, opts.filter || null,
                                         (typeof opts.matchTicket === "function") ? opts.matchTicket : null);
    const layout = applyProcessStepProjection(applyEpicCellProjection(baseLayout, snap));

    // Belt + Suspenders: scrub stale drag-artifacts from an incomplete
    // previous drag (orphan ghost, stuck sm-dragging class).
    dnd.scrubArtifacts();
    // Wipe drop-target registry ONLY on the first render (no existing grid
    // in the host yet). Subsequent renders go through the Phase-C morph
    // path, which reuses existing DOM nodes — and with them their original
    // dnd registrations. Wiping the registry mid-flight would orphan the
    // surviving cells/cards and break drag-and-drop until the next remount.
    // Trade-off: the freshly-built (and then discarded by morph) NEW nodes
    // still call enableDropTarget during the build, leaving a small number
    // of dangling registry entries per render. Acceptable for now; address
    // by switching dnd._targets to a WeakMap if it grows into a real issue.
    const hasExistingGrid = !!host.querySelector(":scope > .sm-grid");
    if (!hasExistingGrid) dnd.clearAll();

    const grid = tagBirth(el("div", { class: "sm-grid" }));
    grid.style.setProperty("--sm-release-label-w", STORY_MAP_LAYOUT.RELEASE_LABEL_WIDTH_PX + "px");
    grid.style.setProperty("--sm-backbone-col-w",  STORY_MAP_LAYOUT.BACKBONE_COL_WIDTH_PX + "px");
    // SM-223 (a) gate: only virtualize cells (content-visibility) on very large
    // boards, where the layout/paint win outweighs the WebKit/Gecko row-height
    // jump. Normal boards render every cell eagerly → pixel-correct heights.
    if ((snap.tickets || []).length > STORY_MAP_LAYOUT.VIRTUALIZE_TICKET_THRESHOLD) {
      grid.classList.add("sm-grid-virtualized");
    }

    grid.appendChild(renderBackbone(layout.columns, layout.columnMultipliers, opts));
    // SM-83: opts.collapsedReleases is a Set<releaseId> of releases whose
    // cells-row should be collapsed. The cells-row stays in the DOM (only
    // visually hidden via .sm-release-collapsed-cells) so the toggle can
    // animate max-height. Label row is always rendered.
    const collapsed = (opts && opts.collapsedReleases) || null;
    layout.rows.forEach((row, idx) => {
      const isCollapsed = !!(collapsed && collapsed.has && collapsed.has(row.id));
      // SM-192: the label is a HEADING — render it ABOVE its cells so all the
      // release's tickets appear below the release bar.
      // SM-252: newest-on-top → the '+ Add Release' button lives on the TOP row
      // (a new release appends with the highest sortOrder and lands on top).
      const showAddRelease = idx === 0;
      const releaseData = layout.releases[row.id];
      grid.appendChild(renderReleaseLabelRow(row, showAddRelease, opts, isCollapsed));
      grid.appendChild(renderReleaseCellsRow(row, releaseData, layout.columns, layout.columnMultipliers, opts, isCollapsed));
      // SM-253: per-release holding zone for release-assigned-but-unplaced
      // tickets — only when it has any (no clutter), and not while collapsed.
      const unplaced = releaseData && releaseData.unplaced;
      if (!isCollapsed && unplaced && (unplaced.epics.length > 0 || unplaced.stories.length > 0)) {
        grid.appendChild(renderReleaseUnplacedRow(row, unplaced, opts));
      }
    });
    // Phantom-rows when at least one ProcessStep exists but no Release yet —
    // without them the user sees only the backbone header floating with
    // nothing under it.
    if (layout.rows.length === 0 && layout.columns.length > 0) {
      for (const node of renderPhantomReleaseRows(layout.columns, layout.columnMultipliers, opts)) {
        grid.appendChild(node);
      }
    }
    // SM-253: the global Backlog section is gone — release-assigned-unplaced
    // tickets live in per-release holding strips (rendered in the rows loop);
    // release-less tickets are visible only in the Kanban.

    // SM-274: Map-Eingang (Bodenstreifen) — sticky bottom strip for release-less
    // tickets. It is the LAST child of .sm-grid: the grid is width:max-content
    // (the full map scroll width), so a plain block child gets width:auto = that
    // width for free — the strip's background spans the whole map with pure CSS,
    // no measured width. Its own body is overflow-x:auto (a scroll container),
    // so the cards do NOT feed back into the grid's max-content width. Morph
    // reconciles it by its data-section key like any other section.
    const trayNode = renderUnassignedTray(snap, opts);
    if (trayNode) grid.appendChild(trayNode);

    // SM-20 Phase C — morph the existing .sm-grid in place instead of wiping
    // the host. Preserves DOM identity for every keyed node that survived
    // the diff (cells, ps-cols, release-rows, cards, …) so the user no
    // longer sees a structural refresh-flash for ticket_create / release_
    // create / label-rename etc. The first render (no existing grid yet)
    // takes the appendChild path so the initial mount is unchanged.
    const oldGrid = host.querySelector(":scope > .sm-grid");
    if (oldGrid) {
      morphTree(oldGrid, grid);
    } else {
      host.innerHTML = "";
      host.appendChild(grid);
    }
    // SM-275: viewport-reactive row count — measure the LIVE tray (after morph,
    // the surviving node is the one in the DOM, not `trayNode`).
    const liveTray = host.querySelector(".sm-tray");
    if (liveTray) sizeTrayBody(host, liveTray);
    instrumentationReport(host, _renderCounter);
  }

  // SM-239: in-place refresh of the per-release X/Y badges after the Phase-A/B
  // fast-paths, which keep the release rows' DOM identity. A child status change
  // shifts the count without moving a card, so the badge must be repainted
  // explicitly. The full-rerender path builds them fresh and doesn't need this.
  function refreshReleaseProgressBadges(host, snap) {
    host.querySelectorAll(".sm-release-label-row[data-release-id]").forEach((row) => {
      const relId = row.dataset.releaseId;
      if (relId) rendererCard.updateReleaseProgressBadge(row, core.releaseProgress(snap, relId));
    });
  }

  // ---- Mount API -------------------------------------------------------

  function mount(host, store, opts) {
    opts = opts || {};
    const actor = opts.actor || ACTOR_LOCAL;
    // Persistenz-Strategie: wenn opts.persistMove gegeben ist (main.js
    // setzt das im HTTP-Modus), nutzen wir das für ALLE Drop-Operationen.
    // Sonst gehen wir den lokalen Store-Pfad (für Tests + lokale Adapter).
    function moveVia(ticketId, position) {
      if (typeof opts.persistMove === "function") {
        return opts.persistMove(ticketId, position);
      }
      store.moveTicket(ticketId, position, actor);
    }
    /**
     * Ticket-Reorder — mirrors movesVia for processSteps. Takes orderedIds
     * + scope (the target container's releaseId/processStepId/epicId) and
     * dispatches to opts.persistReorderTickets (HTTP) or the local store
     * fallback. Mirrors the exact pattern of onProcessStepReorder.
     */
    function reorderVia(orderedIds, scope) {
      if (typeof opts.persistReorderTickets === "function") {
        return opts.persistReorderTickets(orderedIds, scope);
      }
      store.reorderTickets(orderedIds, scope || null, actor);
    }
    function getPos(id) {
      const t = store.get().tickets.find(t => t.id === id);
      return (t && t.position) || {};
    }

    /**
     * Build the new orderedIds list for a reorder operation: peers (sorted
     * ascending by sortOrder, dragged ticket already removed) with the
     * dragged ticket inserted at insertionIndex.
     */
    function buildOrderedIds(peers, draggedId, insertionIndex) {
      const idx = Math.max(0, Math.min(peers.length, insertionIndex != null ? insertionIndex : peers.length));
      const ids = peers.map(t => t.id);
      ids.splice(idx, 0, draggedId);
      return ids;
    }
    const wrappedOpts = {
      // SM-82: forward filter spec to renderInto → computeStoryMapLayout.
      filter:             opts.filter || null,
      // SM-191: forward the smart-bar query predicate too.
      matchTicket:        opts.matchTicket || null,
      // SM-83: forward collapsed-releases set + toggle callback.
      collapsedReleases:        opts.collapsedReleases || null,
      onToggleReleaseCollapsed: opts.onToggleReleaseCollapsed,
      // SM-84: same pattern for per-epic collapse.
      collapsedEpics:           opts.collapsedEpics || null,
      onToggleEpicCollapsed:    opts.onToggleEpicCollapsed,
      // SM-272: per-project process-step COLUMN collapse.
      collapsedColumns:         opts.collapsedColumns || null,
      onToggleColumnCollapsed:  opts.onToggleColumnCollapsed,
      onTicketClick:      opts.onTicketClick,
      onAddTicket:        opts.onAddTicket,
      onAddRelease:       opts.onAddRelease,
      onAddProcessStep:   opts.onAddProcessStep,
      onAddProcessStepWithTicket: opts.onAddProcessStepWithTicket,
      onReleaseClick:     opts.onReleaseClick,
      onProcessStepClick: opts.onProcessStepClick,
      onProcessStepReorder: opts.onProcessStepReorder,
      onEpicDrop: (epicId, psId, releaseId, insertionIndex) => {
        const snap = store.get();
        const dragged = snap.tickets.find(t => t.id === epicId);
        if (!dragged) return;
        const cur = dragged.position || {};
        const tgtRel = releaseId !== undefined ? (releaseId || null) : (cur.releaseId || null);
        const tgtPs  = psId || null;
        const peers = (tgtRel && tgtPs)
          ? core.tickets.epicsInCell(snap, tgtRel, tgtPs).filter(t => t.id !== epicId)
          : [];
        const orderedIds = buildOrderedIds(peers, epicId, insertionIndex);
        reorderVia(orderedIds, { releaseId: tgtRel, processStepId: tgtPs, epicId: null });
      },
      onStoryDrop: (storyId, targetEpicId, insertionIndex) => {
        const snap = store.get();
        const dragged = snap.tickets.find(t => t.id === storyId);
        if (!dragged) return;
        const cur = dragged.position || {};
        let releaseId     = cur.releaseId || null;
        let processStepId = cur.processStepId || null;
        if (targetEpicId) {
          const ep = snap.tickets.find(t => t.id === targetEpicId);
          if (ep && ep.position) {
            releaseId     = ep.position.releaseId || null;
            processStepId = ep.position.processStepId || null;
          }
        }
        const peers = targetEpicId
          ? core.tickets.storiesInEpic(snap, targetEpicId).filter(t => t.id !== storyId)
          : [];
        const orderedIds = buildOrderedIds(peers, storyId, insertionIndex);
        reorderVia(orderedIds, { releaseId, processStepId, epicId: targetEpicId || null });
      },
      // SM-253: re-home a dragged card to a release as UNPLACED (release set,
      // no process-step, no epic) — fired by the release header + holding strip.
      onReleaseUnplacedDrop: (ticketId, _type, releaseId) => {
        moveVia(ticketId, { releaseId: releaseId || null, processStepId: null, epicId: null });
      },
      onCellStoryDrop: (storyId, releaseId, processStepId, insertionIndex) => {
        const snap = store.get();
        const dragged = snap.tickets.find(t => t.id === storyId);
        if (!dragged) return;
        const peers = (releaseId && processStepId)
          ? core.tickets.looseTicketsInCell(snap, releaseId, processStepId).filter(t => t.id !== storyId)
          : [];
        const orderedIds = buildOrderedIds(peers, storyId, insertionIndex);
        reorderVia(orderedIds, { releaseId: releaseId || null, processStepId: processStepId || null, epicId: null });
      },
      // SM-276: drop a scheduled card onto the Map-Eingang → clear its release
      // (unassign back to the inbox). Mirrors applyBacklogDrop; sortOrder is
      // preserved so the card keeps its slot among the release-less tickets.
      onTrayDrop: (ticketId) => {
        const cur = store.get().tickets.find(t => t.id === ticketId);
        if (!cur) return;
        moveVia(ticketId, {
          releaseId:     null,
          processStepId: null,
          epicId:        null,
          sortOrder:     (cur.position && cur.position.sortOrder) || 0
        });
      }
    };
    function rerender() { renderInto(host, store, wrappedOpts); }
    _rerender = rerender;
    // SM-223 (d): context for the drag-incremental path — the SAME host +
    // wrappedOpts the full render uses, so subtree rebuilds are identical.
    // store is the staleness authority (see tryIncrementalDragUpdate).
    _dragRenderCtx = { host: host, opts: wrappedOpts, store: store };
    rerender();
    // SM-275: keep the Map-Eingang's row count in sync with the viewport. A
    // debounced window-resize re-measures and re-applies the row template to
    // the mounted tray (cheap — no full re-render, no DOM re-chunk). Guarded
    // for non-browser environments (JSDOM tests have no global `window`).
    let _resizeTimer = null;
    function onResize() {
      if (_resizeTimer) clearTimeout(_resizeTimer);
      _resizeTimer = setTimeout(function () {
        const tray = host.querySelector(":scope > .sm-tray");
        if (tray) sizeTrayBody(host, tray);
      }, STORY_MAP_LAYOUT.TRAY_RESIZE_DEBOUNCE_MS);
    }
    const _win = (typeof window !== "undefined") ? window : null;
    if (_win) _win.addEventListener("resize", onResize);
    // E24 — animate cards on external commits (MCP / WS pushes). Local
    // commits keep the instant rerender, since they already get direct
    // user feedback (drag-ghost, modal save, ...).
    let prevSnap = store.get();
    // E24.E — Story-Map animates THREE entity types: tickets (both story
    // and epic cards share `[data-ticket-id]`), process-step columns,
    // and release rows. The renderer registers the data-* attrs on the
    // respective DOM nodes; the helper does the FLIP + pulse per type.
    // SM-20-Followup: each entity-type's selector must match EXACTLY ONE node
    // per id, otherwise the FLIP helper's Map.set-by-id overwrites and every
    // matched node gets compared to a wrong prev-rect. data-process-step-id
    // sits on both .sm-backbone-col AND every .sm-cell — scope to the col.
    // data-release-id sits on .sm-release-row.sm-release-cells AND on
    // .sm-release-label-row AND on .sm-release-label — scope to the cells-row.
    const STORYMAP_ENTITY_TYPES = [
      { listKey: "tickets",      selector: "[data-ticket-id]",                          idAttr: "ticketId" },
      { listKey: "processSteps", selector: ".sm-backbone-col[data-process-step-id]",   idAttr: "processStepId" },
      { listKey: "releases",     selector: ".sm-release-row[data-release-id]",          idAttr: "releaseId" }
    ];
    const unsub = store.subscribe(function (snap, reason) {
      if (reason === "applyRemote" && cardAnimate) {
        // SM-20 Phase A — try the position-only fast path first. When an
        // applyRemote is a pure sort-order reshuffle inside one or more
        // existing containers, we move cards directly in the DOM (no
        // host.innerHTML wipe, no structural rebuild) and let FLIP animate
        // their travel. The shells (cells, backbone, release rows) keep
        // their DOM identity, so the screen no longer flashes underneath
        // the FLIP. Any non-trivial structural change → null → fallback.
        const groups = diffSortOnlyByContainer(prevSnap, snap);
        let handled = false;
        if (groups) {
          if (groups.size === 0) {
            // No effective change (a remote echo with identical positions).
            handled = true;
          } else {
            const ticketSelector = "[data-ticket-id]";
            const prevRects = cardAnimate.captureRectsBySelector(host, ticketSelector, "ticketId");
            if (applySortOnlyReshuffle(host, groups)) {
              cardAnimate.flipFromCapturedSelector(host, prevRects, ticketSelector, "ticketId");
              const touchedIds = new Set();
              for (const [, ids] of groups) for (const id of ids) touchedIds.add(id);
              cardAnimate.pulseEntities(host, touchedIds, '[data-ticket-id="', '"]');
              handled = true;
            }
            // applySortOnlyReshuffle returned false → a card or container
            // wasn't in the DOM where we expected it; fall through to the
            // full-rerender path so we never silently lose a change.
          }
        }
        // SM-20 Phase B — content-only patch fast-path. Hit by `ticket_update`,
        // `check_dod_item`, `change_ticket_status`, etc.: a ticket's content
        // changed but its container + position are unchanged. We patch the
        // existing card DOM in place — no host.innerHTML wipe.
        if (!handled) {
          const changed = diffCardContentOnly(prevSnap, snap);
          if (changed) {
            if (changed.size === 0) {
              handled = true;
            } else if (applyCardContentPatch(host, changed, snap, wrappedOpts)) {
              cardAnimate.pulseEntities(host, changed, '[data-ticket-id="', '"]');
              handled = true;
            }
          }
        }
        if (!handled) {
          cardAnimate.animateExternalCommitMulti({
            host: host,
            prevSnap: prevSnap,
            nextSnap: snap,
            rerender: rerender,
            entityTypes: STORYMAP_ENTITY_TYPES
          });
        } else {
          // SM-239: the Phase-A/B fast-paths don't rebuild the release rows, so
          // refresh the X/Y progress badges in place (a child status change can
          // shift a release's done-count without moving any card).
          refreshReleaseProgressBadges(host, snap);
        }
      } else {
        rerender();
      }
      prevSnap = snap;
    });
    // Controller is a callable function (unsubscribes when invoked) with
    // attached methods so existing callers like `app.unmountStoryMap()`
    // keep working while new code can do `ctrl.setDragProjection(...)`.
    const ctrl = function () {
      unsub();
      // SM-275: drop the resize listener so a torn-down host isn't measured.
      if (_win) _win.removeEventListener("resize", onResize);
      if (_resizeTimer) clearTimeout(_resizeTimer);
      // SM-153: reset drag state on unmount so the next mount can't render a
      // phantom shadow-card left over from an aborted drag (Kanban does the
      // same). Set the vars directly — clearDragProjection() would trigger a
      // rerender against a host we're tearing down.
      _dragProjection = null;
      _rerender = null;
      _baseLayoutCache = null;   // SM-221: don't leak a stale layout into the next mount
      _dragRenderCtx = null;     // SM-223: don't morph into a torn-down host
    };
    ctrl.unsubscribe       = unsub;
    ctrl.setDragProjection = setDragProjection;
    ctrl.clearDragProjection = clearDragProjection;
    ctrl._wrappedOpts      = wrappedOpts;  // test-only handle
    return ctrl;
  }

  return {
    STORY_MAP_LAYOUT,
    DRAG_TYPES,
    DRAG_FORMATS,
    computeStoryMapLayout,
    computeUnassignedTrayLayout,   // SM-274 — exposed for tests
    computeTrayRows,               // SM-275 — exposed for tests
    applyEpicDrop,
    applyStoryDrop,
    applyBacklogDrop,
    applyReleaseReorder,
    applyProcessStepReorder,
    // SM-20 Phase A — exposed for tests
    containerKeyOf,
    diffSortOnlyByContainer,
    findContainerForKey,
    applySortOnlyReshuffle,
    // SM-20 Phase B — exposed for tests
    diffCardContentOnly,
    applyCardContentPatch,
    // SM-20 Phase C — exposed for tests
    morphTree,
    keyOf,
    // SM-97 — exposed for tests: drive applyEpicCellProjection in isolation.
    applyEpicCellProjection,
    // SM-193 — exposed for tests: column-aware backlog insertion index.
    columnAwareInsertionIndex,
    // SM-245 — exposed for tests: pure process-step reorder from snapshot + beforeId.
    reorderedProcessStepIds,
    _setDragProjectionForTests: function (p) { _dragProjection = p; },
    // SM-221 — exposed for tests: count + reset base-layout computations, and
    // inspect/clear the drag-layout cache.
    _getLayoutComputeCount: function () { return _layoutComputeCount; },
    _resetLayoutComputeCount: function () { _layoutComputeCount = 0; },
    _peekBaseLayoutCache: function () { return _baseLayoutCache; },
    // SM-223 — exposed for tests: count full grid builds (the drag-incremental
    // path keeps this at 0 per mid-drag move) and force a full render to prove
    // DOM identity between the incremental and the full path.
    _getGridBuildCount: function () { return _gridBuildCount; },
    _resetGridBuildCount: function () { _gridBuildCount = 0; },
    _rerenderForTests: function () { if (typeof _rerender === "function") _rerender(); },
    mount
  };
}));
