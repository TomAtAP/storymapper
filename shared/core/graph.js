/**
 * storymap — graph algorithms (single source of truth)
 *
 * UMD single source of truth (shared/). Consumed two ways from ONE file:
 *   - Node: require() — server/core/graph.js is a 1-line shim, tests require directly.
 *   - Browser: <script src> attaches to window.STORYMAP.coreGraph.
 * Pure functions only — no I/O, no DOM. Edit ONLY this file; the server shim
 * and the frontend symlink both resolve here, so drift is impossible.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else (root.STORYMAP = root.STORYMAP || {}).coreGraph = factory();
}(typeof self !== "undefined" ? self : this, function () {
"use strict";

/**
 * storymap — graph algorithms over the ticket link graph.
 *
 * Pure functions only (no I/O). Mirrored 1:1 into
 * `frontend/js/core/graph.js` via UMD wrapper; the mirror-check at the
 * bottom of `tests/test-core-graph.js` enforces parity.
 *
 * Snapshot shape (see server/core.js): every ticket has
 *   ticket.links: [{ id, linkTypeId, targetTicketId, label? }]
 * — all forward edges; backward links are discovered by inverted scan.
 * Project carries `linkTypes: [{id, semantic, ...}]`; semantic ∈
 *   "precedence" | "blocking" | "sequence" | "containment" | "validation" | "freeform".
 *
 * Workflow statuses live on `project.workflow.statuses` as
 *   [{ id, name, category: "todo"|"doing"|"blocked"|"done" }]
 * and we treat a ticket as "done" iff its status's category === "done".
 */

// Link-semantics that model "X must be done before Y". Used by both
// criticalPath and impactSetForTicket to filter the edge set down to the
// dependency subgraph.
const DEPENDENCY_SEMANTICS = ["blocking", "precedence"];

// Test-typed tickets recognised by traceabilityFor. Defensive trio so any
// of the conventional names (Jira-style 'test', or split lifecycle of
// definition vs. execution) is picked up.
const TEST_TYPES = ["test", "test-definition", "test-execution"];

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Build a fast lookup of linkTypeId → semantic from project.linkTypes.
 * Missing/unknown linkTypeId → undefined; callers treat that as "skip".
 */
function buildLinkTypeSemanticMap(project) {
  const out = new Map();
  if (project && Array.isArray(project.linkTypes)) {
    for (const lt of project.linkTypes) {
      if (lt && typeof lt.id === "string") out.set(lt.id, lt.semantic);
    }
  }
  return out;
}

/**
 * Build a status-id → category lookup from project.workflow.statuses.
 * Unknown / non-object statuses → "doing" (conservative: not-done).
 */
function buildStatusCategoryMap(project) {
  const out = new Map();
  const wf = project && project.workflow;
  if (wf && Array.isArray(wf.statuses)) {
    for (const s of wf.statuses) {
      if (s && typeof s === "object" && typeof s.id === "string") {
        out.set(s.id, s.category || "doing");
      } else if (typeof s === "string") {
        out.set(s, "doing");
      }
    }
  }
  return out;
}

function isDoneTicket(ticket, statusCategoryMap) {
  if (!ticket) return false;
  const cat = statusCategoryMap.get(ticket.status);
  return cat === "done";
}

// SM-242: a ticket is TERMINAL when done OR cancelled — i.e. it no longer
// blocks downstream work (cancelled = the prerequisite was deliberately dropped,
// so dependents shouldn't wait on it forever).
function isTerminalTicket(ticket, statusCategoryMap) {
  if (!ticket) return false;
  const cat = statusCategoryMap.get(ticket.status);
  return cat === "done" || cat === "cancelled";
}

/**
 * Build the dependency-edge adjacency: source ticket id → set of target
 * ticket ids reachable via a single blocking/precedence edge.
 *
 * Only tickets present in `eligibleIds` (a Set) are kept; edges that
 * leave the eligible subgraph are dropped silently. `eligibleIds=null`
 * means "no filter" — every ticket counts.
 */
function buildDependencyAdjacency(snapshot, semanticMap, eligibleIds) {
  const adj = new Map();
  if (!snapshot || !Array.isArray(snapshot.tickets)) return adj;
  for (const t of snapshot.tickets) {
    if (!t || typeof t.id !== "string") continue;
    if (eligibleIds && !eligibleIds.has(t.id)) continue;
    if (!Array.isArray(t.links)) continue;
    for (const l of t.links) {
      if (!l || typeof l.targetTicketId !== "string") continue;
      if (eligibleIds && !eligibleIds.has(l.targetTicketId)) continue;
      const sem = semanticMap.get(l.linkTypeId);
      if (DEPENDENCY_SEMANTICS.indexOf(sem) < 0) continue;
      if (!adj.has(t.id)) adj.set(t.id, new Set());
      adj.get(t.id).add(l.targetTicketId);
    }
  }
  return adj;
}

// ---------------------------------------------------------------------------
// criticalPath
// ---------------------------------------------------------------------------

/**
 * Find the longest chain of unresolved tickets connected by
 * blocking/precedence edges.
 *
 * Edge convention: A → B means "A must be done before B" (predecessor-of
 * and blocks both point in that direction).
 *
 * @param {Snapshot} snapshot
 * @param {Object} [opts]
 * @param {string} [opts.filterByRelease] restrict to tickets whose
 *   `position.releaseId === opts.filterByRelease`.
 * @returns {{ path: string[], length: number }} `path` is the longest
 *   chain in topological order (predecessor first); `length` is its size.
 *   Empty graph or no edges → `{ path: [], length: 0 }`.
 */
function criticalPath(snapshot, opts) {
  opts = opts || {};
  if (!snapshot || !Array.isArray(snapshot.tickets) || snapshot.tickets.length === 0) {
    return { path: [], length: 0 };
  }
  const project = snapshot.project || {};
  const semanticMap = buildLinkTypeSemanticMap(project);
  const statusCatMap = buildStatusCategoryMap(project);

  // Eligible set = not-terminal tickets, optionally release-filtered.
  // SM-242: cancelled is terminal (deliberately dropped) — off the critical path.
  const eligibleIds = new Set();
  for (const t of snapshot.tickets) {
    if (!t || typeof t.id !== "string") continue;
    if (isTerminalTicket(t, statusCatMap)) continue;
    if (opts.filterByRelease) {
      const rel = (t.position && t.position.releaseId) || null;
      if (rel !== opts.filterByRelease) continue;
    }
    eligibleIds.add(t.id);
  }
  if (eligibleIds.size === 0) return { path: [], length: 0 };

  const adj = buildDependencyAdjacency(snapshot, semanticMap, eligibleIds);

  // Compute in-degree for Kahn's topo-sort, scoped to eligible nodes.
  const inDeg = new Map();
  for (const id of eligibleIds) inDeg.set(id, 0);
  for (const [src, targets] of adj) {
    for (const tgt of targets) {
      inDeg.set(tgt, (inDeg.get(tgt) || 0) + 1);
    }
  }

  // Kahn's algorithm: seed with in-degree 0 nodes.
  const queue = [];
  for (const [id, d] of inDeg) {
    if (d === 0) queue.push(id);
  }
  const topo = [];
  // Use index pointer instead of shift() for O(n) instead of O(n^2).
  let qIdx = 0;
  while (qIdx < queue.length) {
    const cur = queue[qIdx++];
    topo.push(cur);
    const ts = adj.get(cur);
    if (!ts) continue;
    for (const tgt of ts) {
      const d = (inDeg.get(tgt) || 0) - 1;
      inDeg.set(tgt, d);
      if (d === 0) queue.push(tgt);
    }
  }
  // Defensive: cycle leftover (shouldn't happen because cycle-checked
  // semantics block at write-time, but if a snapshot was force-loaded
  // with a cycle, skip the leftover nodes rather than throwing).
  if (topo.length < eligibleIds.size) {
    for (const id of eligibleIds) {
      if (!topo.includes(id)) topo.push(id);
    }
  }

  // DP: longest path ending at each node. We track ALL predecessors that
  // produce the maximum length so we can later enumerate every longest
  // path (not just one). Diamond A→B, A→C, B→D, C→D has TWO longest
  // chains (A→B→D and A→C→D) and the user expects both to be highlighted.
  const dist = new Map();  // id → length (node count) of longest path ending here
  const preds = new Map(); // id → Set<predecessorId> contributing the max
  let bestLen = 0;
  for (const id of topo) {
    if (!dist.has(id)) { dist.set(id, 1); preds.set(id, new Set()); }
    const myLen = dist.get(id);
    const ts = adj.get(id);
    if (ts) {
      for (const tgt of ts) {
        const candidate = myLen + 1;
        const cur = dist.get(tgt) || 0;
        if (candidate > cur) {
          dist.set(tgt, candidate);
          preds.set(tgt, new Set([id]));
        } else if (candidate === cur && cur > 0) {
          // Tie — another predecessor reaches `tgt` at the same length;
          // record it so the enumeration includes both paths.
          if (!preds.has(tgt)) preds.set(tgt, new Set());
          preds.get(tgt).add(id);
        }
      }
    }
    if (myLen > bestLen) bestLen = myLen;
  }
  if (bestLen === 0) return { path: [], paths: [], length: 0 };

  // All nodes whose longest-path-ending-here equals bestLen are "best
  // sinks" — every longest path ends at one of them.
  const bestSinks = [];
  for (const [id, d] of dist) if (d === bestLen) bestSinks.push(id);

  // Enumerate every longest path by walking back via `preds`. DFS from each
  // best-sink; deduplicate via stringified path-key. Cap at MAX_PATHS so a
  // pathological wide diamond doesn't explode the count.
  const MAX_PATHS = 32;
  const allPaths = [];
  const seen = new Set();
  function dfs(node, acc) {
    if (allPaths.length >= MAX_PATHS) return;
    const ps = preds.get(node);
    if (!ps || ps.size === 0) {
      const fullForward = acc.slice().reverse();
      const key = fullForward.join("|");
      if (!seen.has(key)) { seen.add(key); allPaths.push(fullForward); }
      return;
    }
    for (const p of ps) {
      acc.push(p);
      dfs(p, acc);
      acc.pop();
    }
  }
  for (const sink of bestSinks) dfs(sink, [sink]);

  // Backward-compatibility: `path` is the FIRST longest path; `paths` is
  // every longest path. Both forms ship so callers can pick.
  const primary = allPaths[0] || [];
  return { path: primary, paths: allPaths, length: bestLen };
}

// ---------------------------------------------------------------------------
// impactSetForTicket
// ---------------------------------------------------------------------------

/**
 * Forward-closure: all tickets that `ticketId` directly OR transitively
 * blocks / is-predecessor-of. Only edges with semantic in
 * {"blocking", "precedence"} are followed.
 *
 * @returns {string[]} ticket ids in BFS order, deduped, NOT including
 *   `ticketId` itself. Unknown ticketId → [].
 */
function impactSetForTicket(snapshot, ticketId) {
  if (!snapshot || !Array.isArray(snapshot.tickets) || typeof ticketId !== "string") {
    return [];
  }
  const exists = snapshot.tickets.some(t => t && t.id === ticketId);
  if (!exists) return [];
  const semanticMap = buildLinkTypeSemanticMap(snapshot.project || {});
  const adj = buildDependencyAdjacency(snapshot, semanticMap, null);

  const out = [];
  const seen = new Set([ticketId]);
  const queue = [ticketId];
  let qIdx = 0;
  while (qIdx < queue.length) {
    const cur = queue[qIdx++];
    const ts = adj.get(cur);
    if (!ts) continue;
    for (const tgt of ts) {
      if (seen.has(tgt)) continue;
      seen.add(tgt);
      out.push(tgt);
      queue.push(tgt);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// traceabilityFor
// ---------------------------------------------------------------------------

/**
 * Resolve which stories sit under an epic and which test-typed tickets
 * cover at least one of those stories.
 *
 * @returns {{ stories: string[], tests: string[] }}
 *   `stories`: ticket ids contained by the epic (via the epic's outgoing
 *              `contains` link — SM-52 canonical form, with legacy
 *              `position.epicId` as a fallback for pre-migration snapshots),
 *              excluding sub-epics (type === "epic").
 *   `tests`: ticket ids with type ∈ TEST_TYPES that have a link whose
 *            targetTicketId is in `stories`. Link-type semantic is NOT
 *            filtered here — any link from test → story counts as
 *            coverage (typically "validation", but we accept all so a
 *            freeform "relates-to" coverage note still counts).
 */
function traceabilityFor(snapshot, epicId) {
  const empty = { stories: [], tests: [] };
  if (!snapshot || !Array.isArray(snapshot.tickets) || typeof epicId !== "string") {
    return empty;
  }
  // SM-52: read containment from the epic's outgoing contains-links.
  const epicTicket = snapshot.tickets.find(t => t && t.id === epicId);
  const containedIds = new Set();
  if (epicTicket && Array.isArray(epicTicket.links)) {
    for (const l of epicTicket.links) {
      if (!l || typeof l.targetTicketId !== "string") continue;
      const lt = l.linkTypeId || l.type;
      if (lt === "contains") containedIds.add(l.targetTicketId);
    }
  }
  const stories = [];
  for (const t of snapshot.tickets) {
    if (!t || typeof t.id !== "string") continue;
    // SM-196: a spec object accidentally contained by an epic is still not a
    // realising story — never count it toward the feature's traceability.
    if (t.type === "epic" || t.type === "requirement" || t.type === "spec-module") continue;
    // Canonical (contains-link) wins; fall back to legacy field for
    // unmigrated snapshots.
    const inContainer = containedIds.has(t.id)
      || ((t.position && t.position.epicId) === epicId);
    if (!inContainer) continue;
    stories.push(t.id);
  }
  if (stories.length === 0) return { stories: [], tests: [] };

  const storySet = new Set(stories);
  const tests = [];
  const seenTests = new Set();
  for (const t of snapshot.tickets) {
    if (!t || typeof t.id !== "string") continue;
    if (TEST_TYPES.indexOf(t.type) < 0) continue;
    if (!Array.isArray(t.links)) continue;
    for (const l of t.links) {
      if (!l || typeof l.targetTicketId !== "string") continue;
      if (storySet.has(l.targetTicketId)) {
        if (!seenTests.has(t.id)) {
          seenTests.add(t.id);
          tests.push(t.id);
        }
        break;
      }
    }
  }
  return { stories: stories, tests: tests };
}

// ---------------------------------------------------------------------------
// actionableTickets (SM-172) — "what can I start now?"
// ---------------------------------------------------------------------------

/** All required DoR items are checked (or there are none). */
function _dorSatisfied(ticket) {
  const items = (ticket.definitionOfReady && ticket.definitionOfReady.items) || [];
  for (const i of items) if (i && i.required && !i.checked) return false;
  return true;
}

/**
 * Return the ids of tickets that are ready to pull RIGHT NOW:
 *   - a work item (epics are containers → excluded) and not soft-deleted,
 *   - status category "todo" (open, not yet doing/blocked/done),
 *   - DoR met: every required DoR item checked — OR the ticket is already at
 *     status "ready" (it passed the gate at transition time),
 *   - NOT blocked: no incoming blocking/precedence edge from a ticket that
 *     isn't done. Edge convention (as in criticalPath): A → B means "A must
 *     be done before B", so B is blocked while any such A is unresolved.
 *     Same DEPENDENCY_SEMANTICS the rest of the graph uses (blocking +
 *     precedence; sequence/relates/contains never block).
 *
 * @param {Snapshot} snapshot
 * @param {Object} [opts]
 * @param {string} [opts.releaseId] restrict to this release.
 * @param {string} [opts.type]      restrict to this ticket type.
 * @returns {string[]} ticket ids, ordered by position.sortOrder asc then
 *   ticketKey — a stable "do these next" queue.
 */
function actionableTickets(snapshot, opts) {
  opts = opts || {};
  if (!snapshot || !Array.isArray(snapshot.tickets)) return [];
  const project = snapshot.project || {};
  const semanticMap = buildLinkTypeSemanticMap(project);
  const statusCatMap = buildStatusCategoryMap(project);

  // A ticket is blocked if some unresolved (non-done, non-deleted) ticket
  // points to it via a blocking/precedence edge.
  const blocked = new Set();
  for (const src of snapshot.tickets) {
    if (!src || src.isDeleted || !Array.isArray(src.links)) continue;
    if (isTerminalTicket(src, statusCatMap)) continue;   // SM-242: cancelled predecessor doesn't block
    for (const l of src.links) {
      if (!l || typeof l.targetTicketId !== "string") continue;
      if (DEPENDENCY_SEMANTICS.indexOf(semanticMap.get(l.linkTypeId)) < 0) continue;
      blocked.add(l.targetTicketId);
    }
  }

  const out = [];
  for (const t of snapshot.tickets) {
    // SM-196: epics are containers, spec-layer types (requirement/spec-module)
    // are SpecObjects — none is pullable work, so all are excluded from the
    // actionable queue. (Mirrors core.SPEC_TYPES; graph.js stays core-free.)
    if (!t || t.isDeleted || t.type === "epic"
        || t.type === "requirement" || t.type === "spec-module") continue;
    if (statusCatMap.get(t.status) !== "todo") continue;
    if (opts.releaseId && ((t.position && t.position.releaseId) || null) !== opts.releaseId) continue;
    if (opts.type && t.type !== opts.type) continue;
    if (t.status !== "ready" && !_dorSatisfied(t)) continue;
    if (blocked.has(t.id)) continue;
    out.push(t);
  }
  out.sort((a, b) => {
    const sa = (a.position && a.position.sortOrder) || 0;
    const sb = (b.position && b.position.sortOrder) || 0;
    if (sa !== sb) return sa - sb;
    return String(a.ticketKey || a.id).localeCompare(String(b.ticketKey || b.id));
  });
  return out.map(t => t.id);
}

// ---------------------------------------------------------------------------
// foldProductDescription (SM-176) — fold the ticket changelog into the
// current-state product model, grouped by feature (epic).
// ---------------------------------------------------------------------------

function _storySummary(t) {
  return {
    id: t.id, ticketKey: t.ticketKey, type: t.type, status: t.status,
    title: t.title,
    acceptanceCriteria: Array.isArray(t.acceptanceCriteria) ? t.acceptanceCriteria : []
  };
}

// Roll a feature's stories up to a single status: shipped (all done) /
// in-progress (some done or actively worked) / planned (all still todo).
function _deriveFeatureStatus(stories, statusCatMap) {
  if (!stories.length) return "planned";
  // SM-243: cancelled stories are terminal scope-reduction — they neither keep
  // a feature open nor count as work. Consistent with deriveEpicStatus: all
  // terminal (done ∪ cancelled) with ≥1 done → shipped.
  let anyActive = false, anyDone = false, anyOpen = false;
  for (const s of stories) {
    const cat = statusCatMap.get(s.status);
    if (cat === "done") { anyDone = true; }
    else if (cat === "cancelled") { /* terminal — ignore */ }
    else { anyOpen = true; if (cat === "doing" || cat === "blocked") anyActive = true; }
  }
  if (!anyOpen && anyDone) return "shipped";
  if (anyActive || anyDone) return "in-progress";
  return "planned";
}

/**
 * Fold the tickets into a current-state product model (SM-176, direction B —
 * Tickets → product description). Epics are feature-spec units; their
 * contained stories (via traceabilityFor — contains-graph) are the
 * realisation, grouped by release (the time axis); linked test-definitions
 * carry the validation status (derivedHealth). Non-epic work items not claimed
 * by any feature land in `orphans`.
 *
 * @param {Snapshot} snapshot
 * @param {Object} [opts]
 * @param {string} [opts.releaseId] restrict stories (and the features that
 *   have any) to this release.
 * @param {string[]} [opts.types] allowlist of work-item types that count as
 *   content (e.g. ["epic","user-story","technical-task-backend"] for a PRD —
 *   excludes bug/test noise). Narrows shown stories + orphans; epics stay.
 * @returns {{ features: Array, orphans: Array }}
 */
function foldProductDescription(snapshot, opts) {
  opts = opts || {};
  const out = { features: [], orphans: [] };
  if (!snapshot || !Array.isArray(snapshot.tickets)) return out;
  const statusCatMap = buildStatusCategoryMap(snapshot.project || {});
  const byId = new Map();
  for (const t of snapshot.tickets) if (t && typeof t.id === "string") byId.set(t.id, t);

  const releases = (snapshot.releases || []).filter(r => r && !r.isDeleted)
    .slice().sort((a, b) => ((a.sortOrder || 0) - (b.sortOrder || 0)));
  const releaseName  = new Map(releases.map(r => [r.id, r.name]));
  const releaseOrder = new Map(releases.map((r, i) => [r.id, i]));
  const orderOf = (rid) => (releaseOrder.has(rid) ? releaseOrder.get(rid) : Number.MAX_SAFE_INTEGER);

  const relOf = (t) => (t.position && t.position.releaseId) || null;
  const inReleaseScope = (t) => !opts.releaseId || relOf(t) === opts.releaseId;
  const releaseObj = (rid) => rid === null ? null : { id: rid, name: releaseName.get(rid) || null };
  // SM-186: opts.types restricts which work-item types count as content (e.g. a
  // PRD wants epic/user-story/technical-task, NOT bug/test). Undefined = all.
  const typeOk = (t) => !Array.isArray(opts.types) || opts.types.indexOf(t.type) >= 0;

  const claimed = new Set();
  const epics = snapshot.tickets.filter(t => t && !t.isDeleted && t.type === "epic");
  // Order features by their release, then sortOrder, then key.
  epics.sort((a, b) => {
    const ra = orderOf(relOf(a)), rb = orderOf(relOf(b));
    if (ra !== rb) return ra - rb;
    const sa = (a.position && a.position.sortOrder) || 0;
    const sb = (b.position && b.position.sortOrder) || 0;
    if (sa !== sb) return sa - sb;
    return String(a.ticketKey || a.id).localeCompare(String(b.ticketKey || b.id));
  });
  const epicById = new Map(epics.map(e => [e.id, e]));

  // Cache traceability per epic + claim EVERY epic's stories up front (incl.
  // superseded epics) so an old version's stories never leak into orphans.
  const traceById = new Map();
  for (const e of epics) {
    const tr = traceabilityFor(snapshot, e.id);
    traceById.set(e.id, tr);
    tr.stories.forEach(sid => claimed.add(sid));
  }

  // SM-180: supersession edges among epics (`A supersedes/replaces B` → B is the
  // older version). The superseding epic is the current feature; superseded
  // epics fold into its history and drop out of the top-level feature list.
  const semanticMap = buildLinkTypeSemanticMap(snapshot.project || {});
  const supersedesTarget = new Map();   // epicId → [older epicId, …]
  const supersededIds = new Set();
  for (const e of epics) {
    for (const l of (e.links || [])) {
      if (!l || typeof l.targetTicketId !== "string") continue;
      if (semanticMap.get(l.linkTypeId) !== "supersession") continue;
      if (!epicById.has(l.targetTicketId)) continue;   // epic→epic only
      if (!supersedesTarget.has(e.id)) supersedesTarget.set(e.id, []);
      supersedesTarget.get(e.id).push(l.targetTicketId);
      supersededIds.add(l.targetTicketId);
    }
  }
  // The visited-guard is load-bearing, not just defensive: the link cycle-check
  // is per-linkTypeId, so a `supersedes A→B` + `replaces B→A` pair (two ids,
  // same "supersession" semantic) is NOT rejected at link-create time. The
  // guard keeps this fold terminating regardless. (SM-180 review nit.)
  function historyChain(headId) {
    const out = [];
    const visited = new Set([headId]);
    let frontier = (supersedesTarget.get(headId) || []).slice();
    while (frontier.length) {
      const next = [];
      for (const id of frontier) {
        if (visited.has(id)) continue;
        visited.add(id);
        const ep = epicById.get(id);
        if (ep) out.push({
          epic: { id: ep.id, ticketKey: ep.ticketKey, title: ep.title },
          release: releaseObj(relOf(ep))
        });
        for (const t of (supersedesTarget.get(id) || [])) next.push(t);
      }
      frontier = next;
    }
    return out.reverse();   // oldest-first (V1 → V2 → … → head is current)
  }

  // v1 scope note (SM-180 review nit): under opts.releaseId, a feature is shown
  // by its HEAD epic's release. Scoping to an OLD release therefore won't surface
  // a superseded version that lived there — its head was filtered out. Acceptable
  // for v1 (release-scope is a "what's the current state of this release" lens);
  // a future "as-of release" mode would walk the history instead.
  for (const epic of epics) {
    if (supersededIds.has(epic.id)) continue;   // an older version → in some head's history
    const trace = traceById.get(epic.id);
    const allStories = trace.stories.map(id => byId.get(id)).filter(s => s && !s.isDeleted);
    // SM-67: contained stories inherit the epic's release. Release-scope filters
    // features wholesale; the type filter only narrows the SHOWN stories (the
    // epic stays — it IS the feature).
    const inRelease = allStories.filter(inReleaseScope);
    if (opts.releaseId && inRelease.length === 0) continue;
    const stories = inRelease.filter(typeOk);
    const tests = trace.tests.map(id => byId.get(id)).filter(Boolean).map(t => ({
      id: t.id, ticketKey: t.ticketKey, title: t.title, type: t.type,
      health: t.type === "test-definition" ? (t.derivedHealth || "unused") : null
    }));
    out.features.push({
      epic: { id: epic.id, ticketKey: epic.ticketKey, title: epic.title, status: epic.status },
      release: releaseObj(relOf(epic)),
      status: _deriveFeatureStatus(stories, statusCatMap),
      stories: stories.map(_storySummary),
      tests,
      history: historyChain(epic.id)
    });
  }

  // Orphans: non-epic, non-test work items not claimed by any feature. Unlike
  // contained stories they keep their own release, so carry it on each entry.
  const orphans = snapshot.tickets.filter(t =>
    t && !t.isDeleted && t.type !== "epic"
    && TEST_TYPES.indexOf(t.type) < 0
    // SM-196: spec objects (requirement/spec-module) are not work items — they
    // never appear as orphan features in the product-doc fold.
    && t.type !== "requirement" && t.type !== "spec-module"
    && typeOk(t)
    && !claimed.has(t.id)
    && inReleaseScope(t));
  orphans.sort((a, b) => ((a.position && a.position.sortOrder) || 0)
                       - ((b.position && b.position.sortOrder) || 0));
  out.orphans = orphans.map(o => Object.assign(_storySummary(o), { release: releaseObj(relOf(o)) }));
  return out;
}

// ---------------------------------------------------------------------------
// traceCoverage (SM-202 R-6) — the direction-A mirror of foldProductDescription.
// For each `requirement` SpecObject, count the incoming traceability links:
//   realisedBy = tickets with a `realises` link → this requirement (DOORS
//                "satisfies"); testedBy = tickets with a `tests` link.
// Classify each requirement and roll up a summary. This is the completeness/
// quality signal for a sliced PRD: orphan requirements have no implementation.
// ---------------------------------------------------------------------------

function traceCoverage(snapshot, opts) {
  opts = opts || {};
  const out = { requirements: [], summary: { total: 0, covered: 0, orphan: 0, overCovered: 0, suspect: 0 } };
  if (!snapshot || !Array.isArray(snapshot.tickets)) return out;
  const byId = new Map(snapshot.tickets.map(t => [t.id, t]));

  // Optional scope: only the requirements contained by a given spec module.
  let scopeIds = null;
  if (opts.moduleId) {
    scopeIds = new Set();
    const mod = byId.get(opts.moduleId);
    if (mod && Array.isArray(mod.links)) {
      for (const l of mod.links) {
        if ((l.linkTypeId || l.type) === "contains") scopeIds.add(l.targetTicketId);
      }
    }
  }

  // Index incoming realises/tests links per requirement target.
  const realisedBy = new Map();
  const testedBy = new Map();
  for (const t of snapshot.tickets) {
    if (!t || t.isDeleted || !Array.isArray(t.links)) continue;
    for (const l of t.links) {
      if (!l || typeof l.targetTicketId !== "string") continue;
      const lt = l.linkTypeId || l.type;
      const bucket = lt === "realises" ? realisedBy : (lt === "tests" ? testedBy : null);
      if (!bucket) continue;
      if (!bucket.has(l.targetTicketId)) bucket.set(l.targetTicketId, []);
      bucket.get(l.targetTicketId).push(t.id);
    }
  }

  for (const t of snapshot.tickets) {
    if (!t || t.isDeleted || t.type !== "requirement") continue;
    if (scopeIds && !scopeIds.has(t.id)) continue;
    const rb = realisedBy.get(t.id) || [];
    const tb = testedBy.get(t.id) || [];
    // suspect: tested but not implemented — an inverted/incomplete trace.
    let status;
    if (rb.length === 0) status = tb.length > 0 ? "suspect" : "orphan";
    else if (rb.length > 1) status = "over-covered";
    else status = "covered";
    out.requirements.push({
      id: t.id, ticketKey: t.ticketKey, sectionPath: t.sectionPath, title: t.title,
      status: status, realisedBy: rb, testedBy: tb
    });
    out.summary.total++;
    out.summary[status === "over-covered" ? "overCovered" : status]++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// driftReport (SM-182 Phase 4) — close the PRD ↔ Tickets round-trip + keep it
// honest as a living document. Three drift signals on the trace graph:
//
//   1. orphan/suspect requirements — a PRD requirement no implementation ticket
//      `realises` (orphan), or one only a test `tests` without an implementer
//      (suspect). Reuses traceCoverage; honours opts.moduleId.
//   2. danglingLinks — a `realises`/`tests` link whose target is missing, soft-
//      deleted, or not a requirement. The anchor points at nothing real.
//   3. supersededTrace — a `realises` anchored on a HISTORICAL feature version
//      (a superseded epic, or a story contained by one). The implementation has
//      moved on but the trace anchor stayed behind — the requirement looks
//      covered by code that is no longer the current feature.
//
// Pure + read-only: the MCP layer wraps this, and (separately) re-generates the
// product doc and writes it back as an attachment to close the loop.
// ---------------------------------------------------------------------------

function driftReport(snapshot, opts) {
  opts = opts || {};
  const out = {
    orphanRequirements: [],
    suspectRequirements: [],
    danglingLinks: [],
    supersededTrace: [],
    summary: {
      orphanRequirements: 0, suspectRequirements: 0,
      danglingLinks: 0, supersededTrace: 0, clean: true
    }
  };
  if (!snapshot || !Array.isArray(snapshot.tickets)) return out;
  const byId = new Map(snapshot.tickets.map(t => [t.id, t]));

  // 1. Orphan / suspect requirements (delegates classification to traceCoverage).
  const cov = traceCoverage(snapshot, opts.moduleId ? { moduleId: opts.moduleId } : {});
  for (const r of cov.requirements) {
    const entry = { id: r.id, ticketKey: r.ticketKey, sectionPath: r.sectionPath, title: r.title };
    if (r.status === "orphan")  out.orphanRequirements.push(entry);
    if (r.status === "suspect") out.suspectRequirements.push(entry);
  }

  // 2. Dangling realises/tests links — target missing / deleted / wrong-kind.
  //    `realises` MUST point at a requirement (DOORS satisfies), so a non-
  //    requirement target is drift. `tests` is overloaded by design: a
  //    test-definition `tests` either a requirement (direction-A validates) OR a
  //    work-item feature/bug (the publish-gate pattern, core.js#linked_definitions_health)
  //    — both are healthy, so for `tests` only a missing/deleted target is dangling.
  for (const t of snapshot.tickets) {
    if (!t || t.isDeleted || !Array.isArray(t.links)) continue;
    for (const l of t.links) {
      if (!l || typeof l.targetTicketId !== "string") continue;
      const lt = l.linkTypeId || l.type;
      if (lt !== "realises" && lt !== "tests") continue;
      const target = byId.get(l.targetTicketId);
      let reason = null;
      if (!target) reason = "target-missing";
      else if (target.isDeleted) reason = "target-deleted";
      else if (lt === "realises" && target.type !== "requirement") reason = "target-not-requirement";
      if (reason) {
        out.danglingLinks.push({
          sourceId: t.id, sourceKey: t.ticketKey, linkType: lt,
          targetId: l.targetTicketId, reason: reason
        });
      }
    }
  }

  // 3. Superseded trace — realises anchored on a historical feature version.
  //    Superseded epics = the targets of supersession links (same rule the
  //    product-doc fold uses). Their contained stories are historical too.
  const semanticMap = buildLinkTypeSemanticMap(snapshot.project || {});
  const epicById = new Map();
  for (const t of snapshot.tickets) {
    if (t && !t.isDeleted && t.type === "epic") epicById.set(t.id, t);
  }
  const supersededIds = new Set();
  for (const e of epicById.values()) {
    for (const l of (e.links || [])) {
      if (!l || typeof l.targetTicketId !== "string") continue;
      if (semanticMap.get(l.linkTypeId) !== "supersession") continue;
      if (epicById.has(l.targetTicketId)) supersededIds.add(l.targetTicketId);
    }
  }
  // staleSources = superseded epics + the stories they contain. v1 limitation
  // (shared with foldProductDescription's `claimed` set): a story dual-contained
  // by both a superseded AND a current epic is treated as stale here — the model
  // permits dual containment but it's degenerate; not worth a current-epic
  // subtraction pass for v1.
  const staleSources = new Set();
  for (const eid of supersededIds) {
    staleSources.add(eid);
    traceabilityFor(snapshot, eid).stories.forEach(sid => staleSources.add(sid));
  }
  for (const t of snapshot.tickets) {
    if (!t || t.isDeleted || !staleSources.has(t.id) || !Array.isArray(t.links)) continue;
    for (const l of t.links) {
      if (!l || typeof l.targetTicketId !== "string") continue;
      if ((l.linkTypeId || l.type) !== "realises") continue;
      const target = byId.get(l.targetTicketId);
      if (!target || target.isDeleted || target.type !== "requirement") continue;  // dangling, already counted in #2
      out.supersededTrace.push({
        sourceId: t.id, sourceKey: t.ticketKey,
        requirementId: target.id, requirementKey: target.ticketKey, sectionPath: target.sectionPath
      });
    }
  }

  out.summary.orphanRequirements  = out.orphanRequirements.length;
  out.summary.suspectRequirements = out.suspectRequirements.length;
  out.summary.danglingLinks       = out.danglingLinks.length;
  out.summary.supersededTrace     = out.supersededTrace.length;
  out.summary.clean = out.summary.orphanRequirements === 0
    && out.summary.suspectRequirements === 0
    && out.summary.danglingLinks === 0
    && out.summary.supersededTrace === 0;
  return out;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

return {
  DEPENDENCY_SEMANTICS,
  TEST_TYPES,
  criticalPath,
  impactSetForTicket,
  traceabilityFor,
  actionableTickets,
  foldProductDescription,
  traceCoverage,
  driftReport
};

}));
