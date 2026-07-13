/**
 * Kanban-Renderer (E11).
 *
 * Operative Sicht auf das Projekt: eine Lane pro Status, jede Lane zeigt
 * alle non-epic Tickets in diesem Status, sortiert nach `sortOrder`.
 * Epics gehören nicht in die Kanban-Ansicht (sie sind Container, keine
 * Work-Items).
 *
 * Reorder-Mechanik (siehe Memory [[lists-are-sortable-by-default]]):
 *  - Drag zwischen Lanes: Status-Wechsel via POST /tickets/:tid/status.
 *    DoR/DoD-Gates auf dem Server greifen; bei 422 (`{kind, missing}`)
 *    wird das Modal-Banner-Pattern wiederverwendet (flashStatus + Revert).
 *  - Drag innerhalb einer Lane: Sortier-Reorder via POST /tickets/reorder
 *    OHNE scope. Der orderedIds-Set sind alle Tickets dieser Lane in
 *    neuer Reihenfolge. Server setzt sortOrder = idx (Container-Felder
 *    bleiben unverändert). Das wirkt rückwirkend auf die Story-Map-
 *    Sortierung innerhalb des Epic, weil beide Views auf demselben
 *    sortOrder-Feld lesen.
 *
 * Mount API:
 *   mount(host, store, opts) → { unmount }
 *     opts.onTicketClick(ticketId)            — Doppelklick öffnet Detail-Modal
 *     opts.onTicketStatusChange(id, newStatus) → Promise<void>
 *     opts.onLaneReorder(laneStatus, orderedIds) → Promise<void>
 *
 * Alle Layout-Werte in KANBAN_LAYOUT (keine Magic Numbers im Code).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(
    require("./core.js"), require("./dnd.js"), require("./renderer-card.js"), require("./card-animate.js"), require("./filter.js"));
  else (root.STORYMAP = root.STORYMAP || {}).rendererKanban = factory(
    root.STORYMAP && root.STORYMAP.core,
    root.STORYMAP && root.STORYMAP.dnd,
    root.STORYMAP && root.STORYMAP.rendererCard,
    root.STORYMAP && root.STORYMAP.cardAnimate,
    root.STORYMAP && root.STORYMAP.filter
  );
}(typeof self !== "undefined" ? self : this, function (core, dnd, rendererCard, cardAnimate, filterMod) {
  "use strict";

  if (!core) throw new Error("renderer-kanban: core module missing");
  if (!dnd)  throw new Error("renderer-kanban: dnd module missing");
  if (!rendererCard) throw new Error("renderer-kanban: renderer-card module missing");
  // filterMod is optional — older callers / tests may mount without it.

  // ---- Konstanten ----------------------------------------------------
  const KANBAN_LAYOUT = {
    LANE_MIN_WIDTH_PX:     260,
    CARD_GAP_PX:             6,
    HEADER_HEIGHT_PX:       40,
    LANE_PADDING_PX:        10,
    CARD_PADDING_PX:         8
  };

  // Drag-type that's exclusive to the Kanban view (so a card dragged inside
  // Kanban doesn't accidentally trigger a Story-Map drop-target).
  const DRAG_TYPE = "kanban-card";

  // SM-170: which workflow status-categories show the card-aging badge. Aging
  // is a signal for ACTIVE work that's sitting too long — backlog/ready (todo)
  // and done are excluded (a backlog item aging is normal; a done one is moot).
  const AGING_CATEGORIES = ["doing", "blocked"];

  // ---- Drag-projection state (SM-27) --------------------------------
  //
  // Mirrors the Story-Map's `_dragProjection` pattern (see
  // renderer-storymap.js#effectiveStoriesFor). While a card is being
  // dragged, `_dragProjection` holds `{ticketId, columnId, insertionIndex}`
  // — the renderer pulls the dragged ticket out of every lane and inserts
  // a `.sm-card-shadow` placeholder at the projection target. Setting and
  // clearing the projection triggers a re-render, so the lane visibly
  // reflows under the cursor instead of waiting for the drop.
  let _dragProjection = null;
  let _rerender = null;
  let _linkIndex     = null;   // SM-49: per-render cache
  let _lastExecIndex = null;   // SM-60: per-render cache (last-execution per test-definition)
  let _projectId     = null;   // SM-158: for ticket-key → editor links
  let _agingStatuses = null;   // SM-170: Set<statusId> whose cards show the aging badge

  function setProjection(p) {
    if (_dragProjection && p
        && _dragProjection.ticketId       === p.ticketId
        && _dragProjection.swimlaneKey    === p.swimlaneKey
        && _dragProjection.columnId       === p.columnId
        && _dragProjection.insertionIndex === p.insertionIndex) {
      return;   // no-op: same projection, avoid render loops
    }
    _dragProjection = p;
    if (typeof _rerender === "function") _rerender();
  }

  function clearProjection() {
    if (_dragProjection === null) return;
    _dragProjection = null;
    if (typeof _rerender === "function") _rerender();
  }

  /**
   * Compute a cell's tickets after applying the active drag projection. The
   * dragged ticket is removed from every cell and re-inserted as a shadow at
   * insertionIndex in the target cell (same swimlane + same column). Returns
   * `[{ticket, shadow}]` pairs. Cross-swimlane drags never project a shadow —
   * the Kanban only moves within a release row (release changes live in the Map).
   */
  function effectiveCellTickets(swimlaneKey, columnId, cellTickets, snapshot) {
    if (!_dragProjection) return cellTickets.map(t => ({ ticket: t, shadow: false }));
    const out = cellTickets
      .filter(t => t.id !== _dragProjection.ticketId)
      .map(t => ({ ticket: t, shadow: false }));
    if (_dragProjection.swimlaneKey === swimlaneKey && _dragProjection.columnId === columnId) {
      const dragged = (snapshot.tickets || []).find(t => t.id === _dragProjection.ticketId);
      if (dragged) {
        const idx = Math.max(0, Math.min(out.length, _dragProjection.insertionIndex || 0));
        out.splice(idx, 0, { ticket: dragged, shadow: true });
      }
    }
    return out;
  }

  // Type→Cluster mapping kommt aus renderer-card.js (geteilt mit Story-Map).

  // ---- DOM-Helper ----------------------------------------------------
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

  // ---- Pure layout ---------------------------------------------------

  // Sentinel key for the "no release / unscheduled" swimlane.
  const NO_RELEASE_KEY = "__none__";

  /**
   * SM-169: group all non-epic tickets into a (release × status-column) grid.
   * Returns:
   *   { columns:   [{id, name, statusIds, status?, orphan?}],
   *     swimlanes: [{ release: {id,name,status} | null, key, collapsed,
   *                   count, cells: {[columnId]: ticket[]} }] }
   *
   * One swimlane per release that holds ≥1 (filtered) ticket — ordered by the
   * release sortOrder — plus a trailing "No release" swimlane (releaseId=null)
   * that is ALWAYS present (it is the unscheduled/backlog home + hosts the
   * "+ Add Item" button). `columns` is the board's Kanban columns (E21.C) plus
   * synthetic trailing columns for any status that no column covers. A status
   * column's `status` shortcut is set only for 1-status columns (backward-compat
   * with `[data-status]` selectors). `opts.collapsedReleases` is a Set of
   * release-ids whose swimlane should render collapsed (cells hidden).
   */
  function computeKanbanLayout(snapshot, opts) {
    opts = opts || {};
    const filter = opts.filter || null;
    const collapsed = opts.collapsedReleases instanceof Set ? opts.collapsedReleases : new Set();
    // SM-82: per-ticket filter (incl. hideCompletedReleases).
    const filterCtx = (filterMod && filter) ? filterMod.buildReleaseCtx(snapshot) : null;
    // SM-191: smart-bar query predicate, AND-combined with the chip filter.
    const matchTicket = (typeof opts.matchTicket === "function") ? opts.matchTicket : null;
    const filterMatch = (filterMod && filter)
      ? (t) => filterMod.matchesFilter(t, filter, filterCtx)
      : (_t) => true;
    const matches = matchTicket ? (t) => filterMatch(t) && matchTicket(t) : filterMatch;

    const board = snapshot && snapshot.project && snapshot.project.boards
                  && snapshot.project.boards.kanban;
    const fallbackStatuses = core.DEFAULT_STATUSES.slice();
    const baseColumns = (board && Array.isArray(board.columns) && board.columns.length > 0)
      ? board.columns
      : fallbackStatuses.map(s => ({ id: "col-" + s, name: s, statusIds: [s] }));

    const tickets = (snapshot.tickets || [])
      .filter(t => !t.isDeleted && core.isBoardWorkItem(t.type) && matches(t));
    tickets.sort((a, b) => ((a.position && a.position.sortOrder) || 0)
                         - ((b.position && b.position.sortOrder) || 0));

    // Full column set = board columns + synthetic columns for stranded statuses.
    const columns = baseColumns.map(col => {
      const c = { id: col.id, name: col.name, statusIds: (col.statusIds || []).slice() };
      if (c.statusIds.length === 1) c.status = c.statusIds[0];
      return c;
    });
    const covered = new Set(columns.flatMap(c => c.statusIds));
    const orphanStatuses = [];
    for (const t of tickets) {
      if (!covered.has(t.status) && orphanStatuses.indexOf(t.status) < 0) orphanStatuses.push(t.status);
    }
    for (const s of orphanStatuses) {
      columns.push({ id: "col-orphan-" + s, name: s, statusIds: [s], status: s, orphan: true });
    }

    const buildCells = (laneTickets) => {
      const cells = {};
      for (const col of columns) {
        const set = new Set(col.statusIds);
        cells[col.id] = laneTickets.filter(t => set.has(t.status));
      }
      return cells;
    };
    const relIdOf = (t) => (t.position && t.position.releaseId) || null;

    const swimlanes = [];
    const releases = (snapshot.releases || []).filter(r => !r.isDeleted)
      .slice().sort((a, b) => ((a.sortOrder || 0) - (b.sortOrder || 0)));
    for (const r of releases) {
      const lt = tickets.filter(t => relIdOf(t) === r.id);
      if (lt.length === 0) continue;   // only release rows with work
      swimlanes.push({
        release: r, key: r.id, collapsed: collapsed.has(r.id),
        count: lt.length, progress: core.releaseProgress(snapshot, r.id),   // SM-239
        cells: buildCells(lt)
      });
    }
    // "No release" swimlane — always present (unscheduled home + add button).
    const noRel = tickets.filter(t => relIdOf(t) === null);
    swimlanes.push({
      release: null, key: NO_RELEASE_KEY, collapsed: collapsed.has(NO_RELEASE_KEY),
      count: noRel.length, progress: core.releaseProgress(snapshot, null),   // SM-239
      cells: buildCells(noRel)
    });

    return { columns, swimlanes };
  }

  // ---- Card renderer -------------------------------------------------
  //
  // Wir nutzen die geteilte Card-Komponente (renderer-card.js) — gleiches
  // DOM-Markup, gleiches CSS (`.sm-story-card`) wie in der Story-Map. Damit
  // sind beide Views visuell konsistent und Selection-Verhalten beim Drag
  // (.sm-story-card { user-select: none }) wirkt automatisch auch hier.

  function renderCard(ticket, opts, isShadow) {
    const card = rendererCard.renderTicketCard(ticket, {
      onTicketClick: isShadow ? null : (opts && opts.onTicketClick),
      projectId:     _projectId,   // SM-158: ticket-key → editor link
      dragType:      isShadow ? null : DRAG_TYPE,
      dragId:        ticket.id,
      // Clear the projection after the drag ends (drop OR cancel), so the
      // next render shows the real state without the stale shadow.
      dragOnEnd:     isShadow ? null : (() => clearProjection()),
      isShadow:      !!isShadow,
      // SM-49: dependency badges (forward + backward).
      linkInfo:      _linkIndex     && _linkIndex.get(ticket.id)     || null,
      // SM-60: test-definition cards get the last-execution badge.
      lastExecution: _lastExecIndex && _lastExecIndex.get(ticket.id) || null,
      // SM-170: aging badge for cards in active (doing/blocked) statuses.
      showAge:       !!(_agingStatuses && _agingStatuses.has(ticket.status))
      // No width → card stretches to lane width (flex layout).
    });
    // SM-30: right-click on a non-shadow card opens a promote/demote menu.
    // We suppress the native browser menu unconditionally; the actual menu
    // wiring happens in main.js (opts.onCardContextMenu).
    if (!isShadow && opts && typeof opts.onCardContextMenu === "function") {
      card.addEventListener("contextmenu", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        opts.onCardContextMenu(ticket, ev);
      });
    }
    return card;
  }

  // gridTemplateColumns shared by the header row + every swimlane's cells row
  // so the column boundaries line up vertically across all release rows.
  function gridTemplate(columns) {
    return "repeat(" + columns.length + ", minmax("
      + KANBAN_LAYOUT.LANE_MIN_WIDTH_PX + "px, 1fr))";
  }

  // One (release × status-column) cell — a drop target holding that release's
  // cards in that column's statuses.
  function renderCell(swimlane, column, opts, snapshot) {
    const ds = { columnId: column.id, swimlaneKey: swimlane.key };
    if (column.status) ds.status = column.status;
    if (swimlane.release) ds.releaseId = swimlane.release.id;
    const cell = el("div", { class: "km-cell", dataset: ds });

    const cellTickets = swimlane.cells[column.id] || [];
    const effective = effectiveCellTickets(swimlane.key, column.id, cellTickets, snapshot);
    for (const entry of effective) cell.appendChild(renderCard(entry.ticket, opts, entry.shadow));

    // "+ Add Item" lives on the No-release swimlane's backlog column only —
    // new tickets start in backlog with no release and walk the workflow.
    const isBacklogCol = (column.statusIds || []).includes("backlog");
    if (swimlane.release === null && isBacklogCol) {
      const add = el("button", {
        class: "km-add-item",
        title: "Add a new ticket to the backlog",
        html: '<span class="sm-add-icon">+</span><span class="sm-add-label">Add Item</span>'
      });
      add.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (opts && typeof opts.onAddItem === "function") opts.onAddItem("backlog");
      });
      cell.appendChild(add);
    }

    const targetReleaseId = swimlane.release ? swimlane.release.id : null;
    dnd.enableDropTarget(cell, {
      accepts: [DRAG_TYPE],
      onEnter: (e) => e.classList.add("km-cell-drop-target"),
      onLeave: (e) => e.classList.remove("km-cell-drop-target"),
      onMove: ({ id, clientY }) => {
        // SM-169: a Kanban move never changes the release — that's a planning
        // action (Map). Don't project a shadow into another release's row.
        const src = (snapshot.tickets || []).find(t => t.id === id);
        const srcRel = (src && src.position && src.position.releaseId) || null;
        if (srcRel !== targetReleaseId) return;
        const cards = Array.from(cell.querySelectorAll(".sm-story-card"))
          .filter(c => !c.classList.contains("sm-dragging")
                    && !c.classList.contains("sm-card-shadow"));
        let idx = cards.length;
        for (let i = 0; i < cards.length; i++) {
          const r = cards[i].getBoundingClientRect();
          if (clientY < r.top + r.height / 2) { idx = i; break; }
        }
        setProjection({ ticketId: id, swimlaneKey: swimlane.key, columnId: column.id, insertionIndex: idx });
      },
      onDrop: ({ id }) => {
        cell.classList.remove("km-cell-drop-target");
        const src = (snapshot.tickets || []).find(t => t.id === id);
        const srcRel = (src && src.position && src.position.releaseId) || null;
        const sourceStatus = src && src.status;
        const insertionIndex = (_dragProjection
          && _dragProjection.swimlaneKey === swimlane.key
          && _dragProjection.columnId === column.id)
          ? _dragProjection.insertionIndex : 0;
        clearProjection();
        // Cross-swimlane drop → reject (snap back). Release changes live in the
        // Map; the Kanban only moves a ticket within its own release row.
        if (srcRel !== targetReleaseId) return;
        const statusSet = new Set(column.statusIds || []);
        const staysInColumn = sourceStatus && statusSet.has(sourceStatus);
        if (!staysInColumn && (column.statusIds || []).length > 0) {
          if (typeof opts.onTicketStatusChange === "function") {
            opts.onTicketStatusChange(id, column.statusIds[0]);
          }
        } else {
          const peers = cellTickets.filter(t => t.id !== id);
          const ordered = peers.slice();
          ordered.splice(Math.max(0, Math.min(ordered.length, insertionIndex)), 0, { id });
          const orderedIds = ordered.map(t => t.id);
          if (typeof opts.onLaneReorder === "function") {
            opts.onLaneReorder(sourceStatus || (column.statusIds || [])[0], orderedIds);
          }
        }
      }
    });
    return cell;
  }

  // A per-release column-header row (Backlog / Ready / … / Done). SM-169
  // repeats this inside every expanded swimlane so the column→status mapping
  // stays visible no matter how far you scroll (no single floating header).
  function renderColumnHeader(columns) {
    const head = el("div", { class: "km-col-header",
      style: { gridTemplateColumns: gridTemplate(columns) } });
    for (const col of columns) {
      head.appendChild(el("div", {
        class: "km-col-head-cell" + (col.orphan ? " km-col-orphan" : ""),
        text: col.name || (col.statusIds || []).join(", ")
      }));
    }
    return head;
  }

  // One release swimlane: a collapsible release header + a cells row. The
  // header is the SAME component the Story-Map uses (renderer-card.js#
  // renderReleaseLabelRow) — identical chevron, name, completed/cancelled
  // pill + strikethrough across both views (SM-169 visual unification).
  function renderSwimlane(swimlane, columns, opts, snapshot) {
    const rel = swimlane.release;
    const ds = { swimlaneKey: swimlane.key };
    if (rel) ds.releaseId = rel.id;
    if (rel && rel.status) ds.status = rel.status;
    const lane = el("div", {
      class: "km-swimlane" + (swimlane.collapsed ? " km-swimlane-collapsed" : ""),
      dataset: ds
    });

    const toggle = () => {
      if (opts && typeof opts.onSwimlaneCollapse === "function") opts.onSwimlaneCollapse(swimlane.key);
    };
    const header = rendererCard.renderReleaseLabelRow({
      id:       swimlane.key,
      name:     rel ? rel.name : "No release",
      status:   rel ? rel.status : null,
      progress: swimlane.progress,   // SM-239: X/Y replaces the raw count, same source as the Map
      collapsed: swimlane.collapsed,
      onToggleCollapsed: toggle,
      // Real releases: label click opens the edit dialog (Map parity). The
      // synthetic "No release" row has nothing to edit → no label handler
      // (toggle via the chevron, exactly like the Map).
      onLabelClick: (rel && opts && typeof opts.onReleaseClick === "function")
        ? () => opts.onReleaseClick(rel.id)
        : null
    });
    lane.appendChild(header);

    if (!swimlane.collapsed) {
      // Each expanded release carries its own column header + cells grid, so
      // the columns line up vertically (shared grid template) and read as
      // continuous tinted bands from the header down through the cards.
      lane.appendChild(renderColumnHeader(columns));
      const cells = el("div", {
        class: "km-swimlane-cells",
        style: { gridTemplateColumns: gridTemplate(columns) }
      });
      for (const col of columns) cells.appendChild(renderCell(swimlane, col, opts, snapshot));
      lane.appendChild(cells);
    }
    return lane;
  }

  function cssEscape(s) {
    return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  function renderInto(host, store, opts) {
    // Clear stale drag artifacts from a previous mount before rebuilding.
    dnd.scrubArtifacts();
    dnd.clearAll();

    const snap = store.get();
    _linkIndex     = rendererCard.computeLinkIndex(snap);          // SM-49
    _lastExecIndex = rendererCard.computeLastExecutionIndex(snap); // SM-60
    _projectId     = snap.project && snap.project.id;              // SM-158
    // SM-170: which statuses get the aging badge (doing/blocked categories).
    _agingStatuses = new Set();
    const wfStatuses = (snap.project && snap.project.workflow && snap.project.workflow.statuses) || [];
    for (const st of wfStatuses) {
      if (st && AGING_CATEGORIES.indexOf(st.category) >= 0) _agingStatuses.add(st.id);
    }
    const layout = computeKanbanLayout(snap, {
      filter: opts.filter || null,
      matchTicket: opts.matchTicket || null,   // SM-191 smart-bar query filter
      collapsedReleases: opts.collapsedReleases
    });
    // Vertical stack of release swimlanes; each expanded one carries its own
    // repeated column header (SM-169) so the status columns stay labelled.
    const board = el("div", { class: "km-board" });

    for (const swimlane of layout.swimlanes) {
      board.appendChild(renderSwimlane(swimlane, layout.columns, opts, snap));
    }
    host.innerHTML = "";
    host.appendChild(board);
  }

  // ---- Mount API -----------------------------------------------------

  function mount(host, store, opts) {
    opts = opts || {};
    function rerender() { renderInto(host, store, opts); }
    _rerender = rerender;
    rerender();
    // E24: animate cards when the commit came from outside (applyRemote
    // → MCP / WS push). Local commits already have their own visual
    // feedback (drag-ghost, dialog dismiss) so we skip the animation
    // for them — otherwise the user's own click would feel laggy.
    let prevSnap = store.get();
    const unsub = store.subscribe(function (snap, reason) {
      if (reason === "applyRemote" && cardAnimate) {
        cardAnimate.animateExternalCommit({
          host: host,
          prevSnap: prevSnap,
          nextSnap: snap,
          rerender: rerender
        });
      } else {
        rerender();
      }
      prevSnap = snap;
    });
    return {
      unmount: () => {
        unsub();
        _rerender = null;
        _dragProjection = null;
        dnd.clearAll();
        host.innerHTML = "";
      }
    };
  }

  return {
    KANBAN_LAYOUT,
    DRAG_TYPE,
    NO_RELEASE_KEY,
    computeKanbanLayout,
    effectiveCellTickets,
    setProjection,
    clearProjection,
    mount
  };
}));
