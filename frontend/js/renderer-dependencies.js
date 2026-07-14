/**
 * Dependencies-View (SM-50).
 *
 * Third sight (after Story-Map and Kanban): a layered DAG of all tickets and
 * the typed links between them (see SM-44/45/46 for the underlying link
 * model + types). Read-only — links are still authored from the ticket
 * detail modal. Designed so a later highlight overlay (SM-64: critical-path,
 * impact-set, traceability) can wrap the same layout output.
 *
 * Layout algorithm: longest-path layering (Sugiyama-style).
 *   layer(node)  = max(layer(predecessor) + 1, 0)
 *   x(node)      = CANVAS_PADDING_PX + layer * HORIZONTAL_SPACING_PX
 *   y(node)      = CANVAS_PADDING_PX + indexInLayer * VERTICAL_SPACING_PX
 *
 * Within each layer, nodes are sorted alphabetically by `ticketKey` for
 * stable, predictable output. Cycles (which `wouldCreateCycle` mostly
 * prevents) are handled defensively: the late-comer node gets placed one
 * layer past the current max so we never throw.
 *
 * Filtering happens BEFORE layering: filtered-out nodes drop, and edges
 * that reference a dropped node also drop.
 *
 * Mount API:
 *   mount(host, store, opts) → { unmount }
 *     opts.onTicketClick(ticketId)   — click on a node opens detail modal.
 *
 * Hover-highlighting (AC #3): hovering a node tags itself + direct
 * predecessors + successors + the connecting edges with semantic classes
 * (.deps-node-hovered/-pred/-succ, .deps-edge-active). Pure CSS handles
 * the visual treatment.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./core.js"), require("./core/graph.js"), require("./renderer-card.js"), require("./filter.js"));
  } else {
    (root.STORYMAP = root.STORYMAP || {}).rendererDependencies = factory(
      root.STORYMAP && root.STORYMAP.core,
      root.STORYMAP && root.STORYMAP.coreGraph,
      root.STORYMAP && root.STORYMAP.rendererCard,
      root.STORYMAP && root.STORYMAP.filter
    );
  }
}(typeof self !== "undefined" ? self : this, function (core, coreGraph, rendererCard, filterMod) {
  "use strict";

  if (!core) throw new Error("renderer-dependencies: core module missing");
  if (!coreGraph) throw new Error("renderer-dependencies: core/graph module missing");
  if (!rendererCard) throw new Error("renderer-dependencies: renderer-card module missing");
  // filterMod is optional — older callers / tests may mount without the board filter.

  // ---- Constants -----------------------------------------------------
  //
  // Single source of truth for all geometry. Tune here, not at call-sites.
  // HORIZONTAL_SPACING_PX is the inter-layer pitch (column-to-column).
  // VERTICAL_SPACING_PX  is the in-layer pitch (top-to-bottom of two nodes
  // in the same layer). Both include the node itself + gap.
  const DEPENDENCY_LAYOUT = Object.freeze({
    // SM-161: nodes are the SHARED story-cards — the width comes from the SINGLE
    // source rendererCard.CARD_WIDTH_PX (no more 240/280 drift between views).
    // SM-162: tightened the pitch. Node-height is nominal (cards are variable
    // height — edges connect at the nominal center).
    HORIZONTAL_SPACING_PX:   rendererCard.CARD_WIDTH_PX + 28,   // card + 28px gap
    VERTICAL_SPACING_PX:     104,    // nominal card height + a small gap
    NODE_WIDTH_PX:           rendererCard.CARD_WIDTH_PX,        // single source (no drift)
    NODE_HEIGHT_PX:           88,    // nominal card height (layout + edge anchors)
    CANVAS_PADDING_PX:        24,
    EDGE_STROKE_WIDTH_PX:    1.5,
    NODE_BORDER_RADIUS_PX:     6,
    // SM-50 followup — barycenter + center axis + isolated band:
    BARYCENTER_PASSES:         4,    // up/down sweeps for crossing reduction
    ISOLATED_GAP_PX:         100,    // vertical gap between DAG and isolated band
    ISOLATED_PER_ROW:          6,    // grid columns in isolated band
    ISOLATED_COL_GAP_PX:      12,
    ISOLATED_ROW_GAP_PX:      12,
    SEPARATOR_LABEL_OFFSET:   18     // y-offset of "Unrelated" label above isolated band
  });

  // SVG namespace used for canvas + nodes + edges.
  const SVG_NS = "http://www.w3.org/2000/svg";

  // ---- DOM helpers ---------------------------------------------------

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    applyAttrs(node, attrs);
    appendChildren(node, children);
    return node;
  }
  function svg(tag, attrs, ...children) {
    const node = document.createElementNS(SVG_NS, tag);
    applyAttrs(node, attrs);
    appendChildren(node, children);
    return node;
  }
  function applyAttrs(node, attrs) {
    if (!attrs) return;
    for (const k of Object.keys(attrs)) {
      if (k === "class") node.setAttribute("class", attrs[k]);
      else if (k === "dataset" && attrs.dataset && typeof attrs.dataset === "object") {
        for (const dk of Object.keys(attrs.dataset)) node.dataset[dk] = attrs.dataset[dk];
      }
      else if (k === "style" && typeof attrs.style === "object") Object.assign(node.style, attrs.style);
      else if (k === "text") node.textContent = attrs[k];
      else if (k.startsWith("on") && typeof attrs[k] === "function") {
        node.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
      }
      else node.setAttribute(k, attrs[k]);
    }
  }
  function appendChildren(node, children) {
    for (const c of children) {
      if (c == null) continue;
      if (typeof c === "string") node.appendChild(document.createTextNode(c));
      else node.appendChild(c);
    }
  }

  // ---- Pure layout ---------------------------------------------------

  /**
   * Resolve the status-category for a ticket. Mirrors getWorkflowForType to
   * find the canonical status entry; falls back to "doing" if unknown.
   * The category is what colours the node (todo / doing / blocked / done).
   */
  function statusCategoryFor(project, ticket) {
    const wf = core.getWorkflowForType
      ? core.getWorkflowForType(project || {}, ticket && ticket.type)
      : null;
    const statuses = (wf && wf.statuses) || [];
    const entry = statuses.find(s => s.id === (ticket && ticket.status));
    return entry ? entry.category : "doing";
  }

  /**
   * Resolve link semantic via project.linkTypes (SM-45). Falls back to
   * "freeform" — the most-conservative semantic — when the lookup fails.
   */
  function semanticFor(project, linkTypeId) {
    if (project && Array.isArray(project.linkTypes)) {
      const lt = project.linkTypes.find(t => t.id === linkTypeId);
      if (lt) return lt.semantic || "freeform";
    }
    return "freeform";
  }

  function colorFor(project, linkTypeId) {
    if (project && Array.isArray(project.linkTypes)) {
      const lt = project.linkTypes.find(t => t.id === linkTypeId);
      if (lt && typeof lt.color === "string" && lt.color.length > 0) return lt.color;
    }
    return null;
  }

  /**
   * Apply filter to the ticket set. Returns a Set<ticketId> of survivors.
   * Filter fields:
   *   type:      keep only this ticket type
   *   releaseId: keep only tickets whose position.releaseId matches
   *   search:    case-insensitive substring match against ticketKey OR title
   */
  function applyFilter(tickets, filter) {
    if (!filter) return new Set(tickets.map(t => t.id));
    const out = new Set();
    const search = (filter.search || "").toLowerCase().trim();
    for (const t of tickets) {
      if (filter.type && t.type !== filter.type) continue;
      if (filter.releaseId) {
        const rid = t.position && t.position.releaseId;
        if (rid !== filter.releaseId) continue;
      }
      if (search.length > 0) {
        const key = (t.ticketKey || "").toLowerCase();
        const title = (t.title || "").toLowerCase();
        if (key.indexOf(search) < 0 && title.indexOf(search) < 0) continue;
      }
      out.add(t.id);
    }
    return out;
  }

  /**
   * Pure layout. Returns {nodes, edges} ready for rendering.
   *
   * nodes: [{id, ticketKey, title, status, statusCategory, x, y, w, h, type}]
   * edges: [{sourceId, targetId, linkTypeId, semantic, color?, label?}]
   *
   * Layering: longest-path. Iterative single-pass over a topological-ish
   * traversal — for every node we set layer = max(layer(predecessor)+1, 0).
   * We loop until no node's layer changes (bounded by nodes.length to
   * defend against accidental cycles).
   */
  /**
   * Compare two ticketKeys with natural-number-aware ordering: "SM-2" comes
   * before "SM-10", and pure-string keys fall back to lexicographic. Used as
   * the deterministic baseline before the barycenter passes reshuffle.
   */
  function compareKey(a, b) {
    const ka = a.ticketKey || a.id;
    const kb = b.ticketKey || b.id;
    const ma = /^([A-Za-z\-_]+)?-?(\d+)$/.exec(ka);
    const mb = /^([A-Za-z\-_]+)?-?(\d+)$/.exec(kb);
    if (ma && mb && (ma[1] || "") === (mb[1] || "")) {
      return Number(ma[2]) - Number(mb[2]);
    }
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  }

  function computeDependencyLayout(snapshot, opts) {
    opts = opts || {};
    const filter = opts.filter || null;
    const includeIds = opts.includeIds || null;   // Set<string> | null
    const project = (snapshot && snapshot.project) || {};

    // (1) collect live, filter-passing tickets.
    //     If `includeIds` is set, intersect with that allow-list — used by the
    //     "Show only critical" toggle to restrict the visible graph to the
    //     critical-path nodes BEFORE layering (the layout sees only the path
    //     so layers/coordinates collapse correctly).
    const liveTickets = (snapshot && snapshot.tickets || []).filter(t => !t.isDeleted);
    const survivors = applyFilter(liveTickets, filter);
    // SM-163: also honour the BOARD filter (statuses/types/hide-completed-
    // releases — the toolbar "Filter N" popover) so e.g. "hide done" applies in
    // the dependency view too, not just Map/Kanban. Same module + semantics.
    if (filterMod && opts.boardFilter) {
      const ctx = (typeof filterMod.buildReleaseCtx === "function")
        ? filterMod.buildReleaseCtx(snapshot) : null;
      for (const t of liveTickets) {
        if (survivors.has(t.id) && !filterMod.matchesFilter(t, opts.boardFilter, ctx)) {
          survivors.delete(t.id);
        }
      }
    }
    if (includeIds && typeof includeIds.has === "function") {
      for (const id of Array.from(survivors)) {
        if (!includeIds.has(id)) survivors.delete(id);
      }
    }
    const tickets = liveTickets.filter(t => survivors.has(t.id));

    // (2) collect edges — only where BOTH endpoints survived. Legacy compat:
    //     accept either link.linkTypeId (canonical, post-SM-44) or link.type
    //     (pre-SM-44 shape that some snapshots still carry).
    const edges = [];
    for (const t of tickets) {
      const links = Array.isArray(t.links) ? t.links : [];
      for (const ln of links) {
        if (!ln.targetTicketId) continue;
        if (!survivors.has(ln.targetTicketId)) continue;
        const linkTypeId = ln.linkTypeId || ln.type || "relates-to";
        edges.push({
          sourceId: t.id,
          targetId: ln.targetTicketId,
          linkTypeId: linkTypeId,
          semantic: semanticFor(project, linkTypeId),
          color: colorFor(project, linkTypeId) || undefined,
          label: ln.label || undefined
        });
      }
    }

    // (3) Partition into connected vs isolated. A ticket is "connected" if
    //     it touches at least one surviving edge as source OR target. The
    //     layered DAG only contains connected nodes; isolated ones go into
    //     a separate band below the main graph (SM-50 follow-up).
    const connectedIds = new Set();
    for (const e of edges) { connectedIds.add(e.sourceId); connectedIds.add(e.targetId); }
    const connectedTickets = tickets.filter(t => connectedIds.has(t.id));
    const isolatedTickets  = tickets.filter(t => !connectedIds.has(t.id));

    // (4) longest-path layering on connected tickets only.
    const predecessors = new Map();
    const successors   = new Map();
    for (const t of connectedTickets) { predecessors.set(t.id, []); successors.set(t.id, []); }
    for (const e of edges) {
      if (predecessors.has(e.targetId)) predecessors.get(e.targetId).push(e.sourceId);
      if (successors.has(e.sourceId))   successors.get(e.sourceId).push(e.targetId);
    }
    const layer = new Map();
    for (const t of connectedTickets) layer.set(t.id, 0);
    // Iterate until stable. Bounded by node count as cycle-safety net even
    // though wouldCreateCycle prevents cycles at write time.
    const MAX_ITER = connectedTickets.length + 1;
    let changed = true;
    let iter = 0;
    while (changed && iter < MAX_ITER) {
      changed = false;
      for (const t of connectedTickets) {
        const preds = predecessors.get(t.id) || [];
        let want = 0;
        for (const pid of preds) {
          const pl = layer.get(pid);
          if (typeof pl === "number" && pl + 1 > want) want = pl + 1;
        }
        if (want !== layer.get(t.id)) {
          layer.set(t.id, want);
          changed = true;
        }
      }
      iter++;
    }

    // (5) Bucket per layer + initial deterministic order (by ticketKey).
    const byLayer = new Map();
    for (const t of connectedTickets) {
      const l = layer.get(t.id) || 0;
      if (!byLayer.has(l)) byLayer.set(l, []);
      byLayer.get(l).push(t);
    }
    for (const arr of byLayer.values()) arr.sort(compareKey);
    const sortedLayers = Array.from(byLayer.keys()).sort((a, b) => a - b);

    // (6) Barycenter crossing reduction. Alternating L→R and R→L sweeps:
    //     within each layer, sort nodes by the mean index of their neighbours
    //     in the reference layer. Pulls connected pairs into vertical
    //     proximity and slashes edge crossings dramatically vs. fixed-alpha
    //     ordering.
    function barycenterSort(layerArr, refLayerArr, getNeighbours) {
      if (!refLayerArr || refLayerArr.length === 0) return layerArr;
      const refIdx = new Map();
      for (let i = 0; i < refLayerArr.length; i++) refIdx.set(refLayerArr[i].id, i);
      const annotated = layerArr.map((t, currIdx) => {
        const ns = getNeighbours(t.id) || [];
        const positions = [];
        for (const nid of ns) if (refIdx.has(nid)) positions.push(refIdx.get(nid));
        const bc = positions.length === 0
          ? currIdx
          : positions.reduce((a, b) => a + b, 0) / positions.length;
        return { t: t, bc: bc, currIdx: currIdx };
      });
      annotated.sort((a, b) => a.bc !== b.bc ? a.bc - b.bc : a.currIdx - b.currIdx);
      return annotated.map(x => x.t);
    }
    for (let pass = 0; pass < DEPENDENCY_LAYOUT.BARYCENTER_PASSES; pass++) {
      // Forward — re-order each layer L>0 by predecessors in layer L-1.
      for (let i = 1; i < sortedLayers.length; i++) {
        const L = sortedLayers[i], P = sortedLayers[i - 1];
        const newOrder = barycenterSort(
          byLayer.get(L),
          byLayer.get(P),
          (tid) => predecessors.get(tid) || []
        );
        byLayer.set(L, newOrder);
      }
      // Backward — re-order each layer L<last by successors in layer L+1.
      for (let i = sortedLayers.length - 2; i >= 0; i--) {
        const L = sortedLayers[i], N = sortedLayers[i + 1];
        const newOrder = barycenterSort(
          byLayer.get(L),
          byLayer.get(N),
          (tid) => successors.get(tid) || []
        );
        byLayer.set(L, newOrder);
      }
    }

    // (7) Coordinate assignment. SM-162: the CRITICAL PATH forms the central
    //     horizontal axis. In every layer the (first) critical-path node is
    //     pinned to a common axis-Y; the layer's other nodes stack above/below
    //     it in barycenter order. Layers without a critical node are centered on
    //     the same axis. Without a critical path we fall back to plain per-layer
    //     vertical centering around the tallest-layer mid-line.
    const pad = DEPENDENCY_LAYOUT.CANVAS_PADDING_PX;
    const hSp = DEPENDENCY_LAYOUT.HORIZONTAL_SPACING_PX;
    const vSp = DEPENDENCY_LAYOUT.VERTICAL_SPACING_PX;
    const w   = DEPENDENCY_LAYOUT.NODE_WIDTH_PX;
    const h   = DEPENDENCY_LAYOUT.NODE_HEIGHT_PX;
    const maxLayerCount = sortedLayers.length === 0
      ? 0
      : sortedLayers.reduce((m, l) => Math.max(m, byLayer.get(l).length), 0);
    const layerHeightMax = maxLayerCount === 0 ? 0 : (maxLayerCount - 1) * vSp + h;

    // Critical-path node set (union of every longest path), computed on the full
    // graph; only the visible ones get pinned to the axis.
    const criticalAxis = new Set();
    if (coreGraph && typeof coreGraph.criticalPath === "function") {
      const cp = coreGraph.criticalPath(snapshot) || {};
      const paths = (cp.paths && cp.paths.length) ? cp.paths
                  : (cp.path && cp.path.length ? [cp.path] : []);
      for (const p of paths) for (const id of p) criticalAxis.add(id);
    }
    const hasAxis = criticalAxis.size > 0;
    const axisTopY = layerHeightMax > 0 ? (layerHeightMax - h) / 2 : 0;

    const nodes = [];
    for (const l of sortedLayers) {
      const bucket = byLayer.get(l);
      if (bucket.length === 0) continue;
      let yTop;   // y of bucket[0]
      if (hasAxis) {
        let cIdx = -1;
        for (let i = 0; i < bucket.length; i++) {
          if (criticalAxis.has(bucket[i].id)) { cIdx = i; break; }
        }
        if (cIdx < 0) cIdx = (bucket.length - 1) / 2;   // center this layer on the axis
        yTop = axisTopY - cIdx * vSp;
      } else {
        const layerH = (bucket.length - 1) * vSp + h;
        yTop = pad + Math.max(0, (layerHeightMax - layerH) / 2);
      }
      for (let i = 0; i < bucket.length; i++) {
        const t = bucket[i];
        nodes.push({
          id: t.id,
          ticketKey: t.ticketKey,
          title: t.title,
          status: t.status,
          statusCategory: statusCategoryFor(project, t),
          type: t.type,
          x: pad + l * hSp,
          y: yTop + i * vSp,
          w: w,
          h: h,
          band: "connected"
        });
      }
    }
    // Axis-pinning can push nodes above the top — shift the whole connected band
    // down so the top-most node sits at `pad`.
    let minY = Infinity;
    for (const n of nodes) if (n.y < minY) minY = n.y;
    if (minY !== Infinity && minY !== pad) {
      const shift = pad - minY;
      for (const n of nodes) n.y += shift;
    }
    let connectedBottomY = pad;     // tracks where the connected band ends
    for (const n of nodes) if (n.y + n.h > connectedBottomY) connectedBottomY = n.y + n.h;

    // (8) Isolated nodes — grid below the connected DAG. Sorted by ticketKey
    //     for deterministic placement. The separator y is the mid-point
    //     between the connected band bottom and the isolated band top so the
    //     renderer can draw a dashed divider line there.
    let isolatedBandTop = connectedBottomY;
    let separatorY = connectedBottomY;
    if (isolatedTickets.length > 0) {
      isolatedTickets.sort(compareKey);
      const isoCols  = Math.max(1, DEPENDENCY_LAYOUT.ISOLATED_PER_ROW);
      const isoColGap = DEPENDENCY_LAYOUT.ISOLATED_COL_GAP_PX;
      const isoRowGap = DEPENDENCY_LAYOUT.ISOLATED_ROW_GAP_PX;
      // Add a generous gap (only if there ARE connected nodes; otherwise the
      // isolated band starts at the top).
      const gap = connectedTickets.length === 0
        ? 0
        : DEPENDENCY_LAYOUT.ISOLATED_GAP_PX;
      isolatedBandTop = connectedBottomY + gap;
      separatorY = connectedBottomY + Math.max(0, gap / 2);
      for (let i = 0; i < isolatedTickets.length; i++) {
        const t = isolatedTickets[i];
        const row = Math.floor(i / isoCols);
        const col = i % isoCols;
        nodes.push({
          id: t.id,
          ticketKey: t.ticketKey,
          title: t.title,
          status: t.status,
          statusCategory: statusCategoryFor(project, t),
          type: t.type,
          x: pad + col * (w + isoColGap),
          y: isolatedBandTop + row * (h + isoRowGap),
          w: w,
          h: h,
          band: "isolated"
        });
      }
    }

    return {
      nodes: nodes,
      edges: edges,
      // Render-side hints (separator divider, band counts).
      bands: {
        connectedCount: connectedTickets.length,
        isolatedCount:  isolatedTickets.length,
        separatorY:     separatorY,
        isolatedTop:    isolatedBandTop
      }
    };
  }

  // ---- Analysis helpers (SM-64) --------------------------------------
  //
  // These wrap the pure graph helpers in core/graph.js so the renderer
  // can use them without reaching outside of its module boundary.

  /**
   * Returns a Set of `edgeKey(sourceId, targetId)` strings identifying the
   * consecutive edges of a critical-path ID list. Used by render to tag
   * matching edges with `.deps-edge-critical`.
   */
  function criticalEdgeKeySet(pathIds) {
    const out = new Set();
    if (!Array.isArray(pathIds) || pathIds.length === 0) return out;
    // Accept either a flat ID array (legacy) OR an array of arrays (multiple
    // critical paths). For multi-path input, every consecutive pair across
    // every path contributes an edge key.
    const paths = Array.isArray(pathIds[0]) ? pathIds : [pathIds];
    for (const p of paths) {
      if (!Array.isArray(p)) continue;
      for (let i = 0; i + 1 < p.length; i++) {
        out.add(edgeKey(p[i], p[i + 1]));
      }
    }
    return out;
  }
  // Stable, explicit edge-key. The literal arrow keeps grep-ability and
  // avoids any control-char accidents around bare-string-concat.
  function edgeKey(src, tgt) {
    return String(src) + "->" + String(tgt);
  }

  /**
   * Build the JSON export payload (SM-64).
   *   {
   *     criticalPath: [{ticketKey, title, status}, ...],
   *     impact: {[anchorKey]: [...impactedKeys]},
   *     traceability: {[epicKey]: {stories: [keys], tests: [keys]}}
   *   }
   * `impact` is computed for the first ticket on the critical path (a single
   * pragmatic "what's downstream from where the work starts"). `traceability`
   * is computed for every epic in the snapshot.
   */
  // Export-Helpers (buildExportJson / buildExportCsv / triggerDownload)
  // entfernt — wir liefern keinen Analyse-Sub-Report. Full Project-Export
  // läuft über SM-15 (Export/Import von Projekten als JSON) auf Projekt-
  // Ebene.

  // ---- Render helpers ------------------------------------------------

  function renderToolbar(state, opts, rerender) {
    const bar = el("div", { class: "deps-toolbar" });

    // Type filter
    const typeSelect = el("select", { class: "deps-filter-type", title: "Filter by ticket type" });
    typeSelect.appendChild(el("option", { value: "" }, "All types"));
    for (const t of (state.ticketTypes || [])) {
      const opt = el("option", { value: t }, t);
      if (state.filter && state.filter.type === t) opt.setAttribute("selected", "selected");
      typeSelect.appendChild(opt);
    }
    typeSelect.addEventListener("change", () => {
      state.filter = Object.assign({}, state.filter, { type: typeSelect.value || null });
      rerender();
    });
    bar.appendChild(typeSelect);

    // Release filter
    const releaseSelect = el("select", { class: "deps-filter-release", title: "Filter by release" });
    releaseSelect.appendChild(el("option", { value: "" }, "All releases"));
    for (const r of (state.releases || [])) {
      const opt = el("option", { value: r.id }, r.name || r.id);
      if (state.filter && state.filter.releaseId === r.id) opt.setAttribute("selected", "selected");
      releaseSelect.appendChild(opt);
    }
    releaseSelect.addEventListener("change", () => {
      state.filter = Object.assign({}, state.filter, { releaseId: releaseSelect.value || null });
      rerender();
    });
    bar.appendChild(releaseSelect);

    // Search
    const searchInput = el("input", {
      class: "deps-filter-search",
      type: "search",
      placeholder: "Search ticket key or title…",
      value: (state.filter && state.filter.search) || ""
    });
    searchInput.addEventListener("input", () => {
      state.filter = Object.assign({}, state.filter, { search: searchInput.value || "" });
      rerender();
    });
    bar.appendChild(searchInput);

    // ---- Analysis controls (SM-64) --------------------------------
    // Divider separates filter inputs from analysis actions.
    bar.appendChild(el("span", { class: "deps-toolbar-divider", "aria-hidden": "true" }));

    // (1) Critical-Path toggle button — highlights the path's nodes + edges.
    //     Re-Click clears. Persistence is in-state-only (not localStorage).
    const cpBtn = el("button", {
      type: "button",
      class: "deps-toolbar-action deps-action-critical-path"
        + (state.criticalPathHighlight ? " toggled" : ""),
      title: "Highlight the longest dependency chain among open tickets"
    }, "Critical Path");
    cpBtn.addEventListener("click", () => {
      state.criticalPathHighlight = !state.criticalPathHighlight;
      rerender();
    });
    bar.appendChild(cpBtn);

    // (2) Show-only-critical toggle — shrinks the visible graph to the path.
    //     Implies criticalPathHighlight=true so the path stays visually marked
    //     when the filter is active; toggling OFF reverts to full graph.
    const onlyBtn = el("button", {
      type: "button",
      class: "deps-toolbar-action deps-action-critical-only"
        + (state.criticalOnly ? " toggled" : ""),
      title: "Hide every ticket that is not on the critical path"
    }, "Show only critical");
    onlyBtn.addEventListener("click", () => {
      state.criticalOnly = !state.criticalOnly;
      if (state.criticalOnly) state.criticalPathHighlight = true;
      rerender();
    });
    bar.appendChild(onlyBtn);

    // (3) Export buttons were removed — full project export/import will be
    //     covered by SM-15 ("Export/Import von Projekten") at the project
    //     scope, not as a dependency-analysis sub-report.

    // (4) Inline status-colour legend. Right-aligned via flex margin-auto.
    const legend = el("div", { class: "deps-legend", title: "What the node border colours mean" });
    function legendItem(cls, label) {
      const wrap = el("span", { class: "deps-legend-item" });
      wrap.appendChild(el("span", { class: "deps-legend-swatch " + cls }));
      wrap.appendChild(document.createTextNode(label));
      return wrap;
    }
    legend.appendChild(legendItem("legend-todo",     "Todo"));
    legend.appendChild(legendItem("legend-doing",    "Doing"));
    legend.appendChild(legendItem("legend-blocked",  "Blocked"));
    legend.appendChild(legendItem("legend-done",     "Done"));
    legend.appendChild(legendItem("legend-critical", "Critical path"));
    legend.appendChild(legendItem("legend-context",  "Path's epic"));
    bar.appendChild(legend);

    return bar;
  }

  /**
   * Build the SVG canvas with edges underneath and nodes on top. Hover-
   * highlighting is wired here: pointerenter/leave on each node tags the
   * neighbours via dataset-driven querySelectors.
   */
  function renderCanvas(layout, opts) {
    opts = opts || {};
    const criticalSet        = opts.criticalSet        || new Set();    // Set<ticketId>
    const criticalContextSet = opts.criticalContextSet || new Set();    // Set<epicId>
    const criticalEdgeKeys   = opts.criticalEdgeKeys   || new Set();
    // Compute canvas size — extend a little past the right-most + bottom-
    // most node so labels never clip.
    const pad = DEPENDENCY_LAYOUT.CANVAS_PADDING_PX;
    let maxX = 0, maxY = 0;
    for (const n of layout.nodes) {
      if (n.x + n.w > maxX) maxX = n.x + n.w;
      if (n.y + n.h > maxY) maxY = n.y + n.h;
    }
    const canvasW = Math.max(maxX + pad, 200);
    const canvasH = Math.max(maxY + pad, 200);

    const root = el("div", { class: "deps-canvas" });
    const svgEl = svg("svg", {
      class: "deps-svg",
      width: String(canvasW),
      height: String(canvasH),
      viewBox: "0 0 " + canvasW + " " + canvasH
    });

    // Index nodes by id for edge lookups + neighbour computation.
    const byId = new Map(layout.nodes.map(n => [n.id, n]));

    // Build neighbour adjacency (predecessor/successor sets) so hover can
    // tag them in O(1) per hover instead of walking the edges list each time.
    const succ = new Map();   // sourceId → Set<targetId>
    const pred = new Map();   // targetId → Set<sourceId>
    for (const e of layout.edges) {
      if (!succ.has(e.sourceId)) succ.set(e.sourceId, new Set());
      succ.get(e.sourceId).add(e.targetId);
      if (!pred.has(e.targetId)) pred.set(e.targetId, new Set());
      pred.get(e.targetId).add(e.sourceId);
    }

    // ---- separator between connected DAG and isolated band ---------
    // Only render when there are isolated nodes AND at least one connected.
    // A dashed horizontal rule + a small label make the band split explicit.
    if (layout.bands && layout.bands.isolatedCount > 0 && layout.bands.connectedCount > 0) {
      const sepY = layout.bands.separatorY;
      svgEl.appendChild(svg("line", {
        class: "deps-band-separator",
        x1: String(DEPENDENCY_LAYOUT.CANVAS_PADDING_PX / 2),
        x2: String(canvasW - DEPENDENCY_LAYOUT.CANVAS_PADDING_PX / 2),
        y1: String(sepY),
        y2: String(sepY),
        stroke: "currentColor",
        "stroke-width": "1",
        "stroke-dasharray": "4 4"
      }));
      const label = svg("text", {
        class: "deps-band-separator-label",
        x: String(DEPENDENCY_LAYOUT.CANVAS_PADDING_PX),
        y: String(layout.bands.isolatedTop - DEPENDENCY_LAYOUT.SEPARATOR_LABEL_OFFSET)
      });
      label.textContent = "Unrelated tickets (" + layout.bands.isolatedCount + ")";
      svgEl.appendChild(label);
    }

    // SM-161: edges live in the SVG (UNDER), nodes are the shared HTML
    // story-cards in an absolutely-positioned overlay (ABOVE) — both share the
    // canvas coordinate space, so edges still connect at the node anchors.
    const ticketsById = new Map(((opts.snapshot && opts.snapshot.tickets) || []).map(t => [t.id, t]));
    const linkIndex = (rendererCard && typeof rendererCard.computeLinkIndex === "function")
      ? rendererCard.computeLinkIndex(opts.snapshot || {}) : null;
    const lastExecIndex = (rendererCard && typeof rendererCard.computeLastExecutionIndex === "function")
      ? rendererCard.computeLastExecutionIndex(opts.snapshot || {}) : null;

    const edgesLayer = svg("g", { class: "deps-edges-layer" });
    svgEl.appendChild(edgesLayer);
    const nodesHtml = el("div", {
      class: "deps-nodes-html",
      style: { position: "absolute", top: "0", left: "0", width: canvasW + "px", height: canvasH + "px" }
    });

    // ---- edges ------------------------------------------------------
    for (const e of layout.edges) {
      const sNode = byId.get(e.sourceId);
      const tNode = byId.get(e.targetId);
      if (!sNode || !tNode) continue;
      const sx = sNode.x + sNode.w;
      const sy = sNode.y + sNode.h / 2;
      const tx = tNode.x;
      const ty = tNode.y + tNode.h / 2;
      // Simple bezier: control points pushed half-way horizontally.
      const dx = Math.max(40, (tx - sx) / 2);
      const path = "M" + sx + "," + sy +
                   " C" + (sx + dx) + "," + sy +
                   " "  + (tx - dx) + "," + ty +
                   " "  + tx + "," + ty;
      const isCritical = criticalEdgeKeys.has(edgeKey(e.sourceId, e.targetId));
      const edgeEl = svg("path", {
        class: "deps-edge deps-edge-" + (e.semantic || "freeform")
          + (isCritical ? " deps-edge-critical" : ""),
        d: path,
        fill: "none",
        stroke: e.color || "currentColor",
        "stroke-width": String(DEPENDENCY_LAYOUT.EDGE_STROKE_WIDTH_PX),
        "data-source-id": e.sourceId,
        "data-target-id": e.targetId,
        "data-link-type-id": e.linkTypeId || ""
      });
      edgesLayer.appendChild(edgeEl);
    }

    // ---- nodes: shared story-cards in the HTML overlay -------------
    for (const n of layout.nodes) {
      const isCriticalNode = criticalSet.has(n.id);
      const isCriticalContext = !isCriticalNode && criticalContextSet.has(n.id);
      // The .deps-node wrapper carries all the hover/critical/band class hooks
      // and the absolute position; the shared card provides the visuals + the
      // ticket-key → editor link. The wrapper handles the single-click → modal
      // (the dep-view's existing affordance), so the card itself gets no click
      // handler (the key-link stops propagation so it opens the editor instead).
      const nodeEl = el("div", {
        class: "deps-node deps-node-status-" + n.statusCategory + " deps-node-type-" + (n.type || "unknown") + " deps-node-band-" + (n.band || "connected")
          + (isCriticalNode ? " deps-node-critical" : "")
          + (isCriticalContext ? " deps-node-critical-context" : ""),
        dataset: {
          ticketId: n.id,
          status: n.status,
          statusCategory: n.statusCategory,
          type: n.type || "",
          band: n.band || "connected"
        },
        style: { position: "absolute", left: n.x + "px", top: n.y + "px", width: n.w + "px" }
      });
      const fullTicket = ticketsById.get(n.id) || {
        id: n.id, ticketKey: n.ticketKey, title: n.title, type: n.type, status: n.status
      };
      const card = rendererCard.renderTicketCard(fullTicket, {
        projectId: opts.projectId,
        width: n.w,
        linkInfo:      linkIndex     && linkIndex.get(n.id)     || null,
        lastExecution: lastExecIndex && lastExecIndex.get(n.id) || null
      });
      nodeEl.appendChild(card);

      if (typeof opts.onTicketClick === "function") {
        nodeEl.addEventListener("click", () => opts.onTicketClick(n.id));
        nodeEl.style.cursor = "pointer";
      }
      nodeEl.addEventListener("pointerenter", () => applyHoverHighlight(root, n.id, pred, succ));
      nodeEl.addEventListener("pointerleave", () => clearHoverHighlight(root));

      nodesHtml.appendChild(nodeEl);
    }

    // .deps-canvas is the shared coordinate root. The SVG stays in normal flow
    // so its width/height define the scrollable area; the HTML node overlay is
    // absolutely positioned on top of it at the same origin.
    root.appendChild(svgEl);
    root.appendChild(nodesHtml);
    return root;
  }

  /**
   * BFS closure over a neighbour map. Returns Set<id> reachable from `startId`
   * via the given map (excluding `startId` itself). Used for transitive
   * predecessor / successor highlighting on hover.
   */
  function transitiveClosure(startId, neighborMap) {
    const visited = new Set();
    const queue = [startId];
    while (queue.length) {
      const cur = queue.shift();
      const ns = neighborMap.get(cur);
      if (!ns) continue;
      for (const nid of ns) {
        if (nid === startId) continue;
        if (visited.has(nid)) continue;
        visited.add(nid);
        queue.push(nid);
      }
    }
    return visited;
  }

  // SM-161: operates on the `.deps-canvas` root — nodes live in the HTML
  // overlay, edges in the SVG, both children of the root.
  function applyHoverHighlight(root, hoveredId, predMap, succMap) {
    clearHoverHighlight(root);
    // Toggle a class on the canvas so CSS can scope the "dim non-neighbours"
    // rule to "a node is actively hovered" rather than "cursor anywhere".
    root.classList.add("deps-hover-active");
    const hovered = root.querySelector('.deps-node[data-ticket-id="' + cssEscape(hoveredId) + '"]');
    if (hovered) hovered.classList.add("deps-node-hovered");

    // Transitive closures: the full forward chain (all downstream nodes) and
    // the full backward chain (all upstream nodes). Hovering a "source" node
    // therefore reveals the entire dependency path to its furthest sinks —
    // the user's "kritischer Pfad ab hier" mental model.
    const succClosure = transitiveClosure(hoveredId, succMap);
    const predClosure = transitiveClosure(hoveredId, predMap);
    for (const sid of succClosure) {
      const el = root.querySelector('.deps-node[data-ticket-id="' + cssEscape(sid) + '"]');
      if (el) el.classList.add("deps-node-succ");
    }
    for (const pid of predClosure) {
      const el = root.querySelector('.deps-node[data-ticket-id="' + cssEscape(pid) + '"]');
      if (el) el.classList.add("deps-node-pred");
    }

    // Edges: active if both endpoints sit in the same direction-closure
    // (i.e. the edge is part of the forward chain OR the backward chain).
    const forwardSet = new Set([hoveredId, ...succClosure]);
    const backwardSet = new Set([hoveredId, ...predClosure]);
    const edges = root.querySelectorAll(".deps-edge");
    for (const e of edges) {
      const sid = e.getAttribute("data-source-id");
      const tid = e.getAttribute("data-target-id");
      const inForward  = forwardSet.has(sid)  && forwardSet.has(tid);
      const inBackward = backwardSet.has(sid) && backwardSet.has(tid);
      if (inForward || inBackward) e.classList.add("deps-edge-active");
    }
  }

  function clearHoverHighlight(root) {
    root.classList.remove("deps-hover-active");
    const classes = ["deps-node-hovered", "deps-node-pred", "deps-node-succ"];
    for (const c of classes) {
      const els = root.querySelectorAll("." + c);
      for (const el of els) el.classList.remove(c);
    }
    const activeEdges = root.querySelectorAll(".deps-edge-active");
    for (const el of activeEdges) el.classList.remove("deps-edge-active");
  }

  function cssEscape(s) {
    return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  // ---- Mount API -----------------------------------------------------

  function mount(host, store, opts) {
    opts = opts || {};
    // Filter state is owned by the view, not by the store — switching back
    // to Map/Kanban and back resets filters (intentional: keep cross-view
    // navigation simple, don't surprise users with stale filters).
    const state = {
      filter: { type: null, releaseId: null, search: "" },
      releases: [],
      ticketTypes: [],
      // SM-64 analysis toggles. Both default-off; toggles persist for the
      // life of the mount only (re-mount = fresh state).
      criticalPathHighlight: false,
      criticalOnly: false,
      snapshot: null     // most-recently rendered snapshot; toolbar exports use it
    };

    // Expose the live snapshot to the toolbar (export buttons need it
    // at click-time, not just render-time).
    const mergedOpts = Object.assign({}, opts, {
      getSnapshot: () => state.snapshot
    });

    function rerender() {
      const snap = store.get();
      state.snapshot = snap;
      // Refresh filter-source data (releases, ticket types) every render so
      // adding a release elsewhere is visible without a re-mount.
      state.releases = (snap.releases || []).filter(r => !r.isDeleted);
      state.ticketTypes = (snap.project && snap.project.ticketTypes) || [];

      // Compute critical path(s) once per render if either toggle is on.
      // criticalPath returns { path, paths, length } — `paths` is every
      // longest path (diamond ties enumerate both). Highlight UNIONs them,
      // include-filter UNIONs them too.
      let cpAllIds = [];        // union of every node id on any longest path
      let cpAllPaths = [];      // array of arrays for edge highlighting
      let cpContextEpics = new Set();  // containing epics of path tickets
      if (state.criticalPathHighlight || state.criticalOnly) {
        const cp = coreGraph.criticalPath(snap) || { path: [], paths: [] };
        cpAllPaths = (cp.paths && cp.paths.length > 0) ? cp.paths : (cp.path && cp.path.length > 0 ? [cp.path] : []);
        const union = new Set();
        for (const p of cpAllPaths) for (const id of p) union.add(id);
        cpAllIds = Array.from(union);
        // SM-64-followup: also mark the containing epics of every path
        // ticket so the user immediately sees the cluster context.
        if (core && core.tickets && typeof core.tickets.epicForStory === "function") {
          for (const id of cpAllIds) {
            const epic = core.tickets.epicForStory(snap, id);
            if (epic && !union.has(epic.id)) cpContextEpics.add(epic.id);
          }
        }
      }
      const layoutOpts = { filter: state.filter, boardFilter: mergedOpts.boardFilter };
      if (state.criticalOnly && cpAllIds.length > 0) {
        // include-filter takes the path tickets PLUS their containing epics.
        const incl = new Set(cpAllIds);
        for (const eid of cpContextEpics) incl.add(eid);
        layoutOpts.includeIds = incl;
      }
      const layout = computeDependencyLayout(snap, layoutOpts);
      const canvasOpts = Object.assign({}, mergedOpts, {
        criticalSet:        state.criticalPathHighlight ? new Set(cpAllIds) : new Set(),
        criticalContextSet: state.criticalPathHighlight ? cpContextEpics    : new Set(),
        criticalEdgeKeys:   state.criticalPathHighlight ? criticalEdgeKeySet(cpAllPaths) : new Set(),
        // SM-161: the canvas renders the shared story-cards as nodes — it needs
        // the full tickets + project id (for the ticket-key → editor links).
        snapshot:           snap,
        projectId:          snap.project && snap.project.id
      });

      // Build the full subtree fresh each render. The view is read-only and
      // the node count is modest (one node per ticket), so a full rebuild
      // is simpler than diffing and plenty fast.
      const root = el("div", { class: "deps-root" });
      root.appendChild(renderToolbar(state, mergedOpts, rerender));
      root.appendChild(renderCanvas(layout, canvasOpts));
      host.innerHTML = "";
      host.appendChild(root);
    }

    rerender();

    const unsub = store.subscribe(function (_snap, _reason) {
      // No animation gating — the dependency view is read-only and renders
      // are cheap. WS-pushes and local commits both just rerender.
      rerender();
    });

    return {
      unmount: () => {
        unsub();
        host.innerHTML = "";
      }
    };
  }

  return {
    DEPENDENCY_LAYOUT: DEPENDENCY_LAYOUT,
    computeDependencyLayout: computeDependencyLayout,
    mount: mount,
    // SM-64 — exported for unit-tests.
    criticalEdgeKeySet: criticalEdgeKeySet
  };
}));
