/**
 * SM-82 — Ticket-Filter (View-Layer)
 *
 * Pure module. No DOM access, no storage, no store. Consumers (renderers,
 * main.js) wire it into their pipelines.
 *
 * Two surface shapes:
 *
 *   1. **Simple filter spec** — what the toolbar UI produces:
 *
 *        { statuses: string[]|null,   // null = no constraint
 *          types:    string[]|null,
 *          hideCompletedReleases: bool }
 *
 *   2. **Internal Boolean-Tree AST** — what matchesFilter actually evaluates:
 *
 *        Node = { op: "AND", children: Node[] }
 *             | { op: "OR",  children: Node[] }
 *             | { op: "NOT", child: Node }
 *             | { op: "CLAUSE", field, clauseOp, value?, values? };
 *
 * `toAST` converts the simple spec into a flat AND-tree of clauses. A future
 * JQL parser (v3+) would produce arbitrary AND/OR/NOT trees consumed by the
 * same `matchesFilter` evaluator — the evaluator is already recursive.
 *
 * Supported clauseOps today: eq, neq, in, not-in.
 *
 * Supported fields:
 *   - "status"          — ticket.status
 *   - "type"            — ticket.type
 *   - "release.status"  — virtual; resolves via ctx.releaseById (built by
 *                         `buildReleaseCtx(snapshot)` once per render).
 *
 * `releaseVisible(release, filter)` is a separate helper because the renderer
 * uses it to skip release-row iteration entirely when `hideCompletedReleases`
 * is on — different shape than per-ticket filtering.
 */

(function (global, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else {
    const ns = (global.STORYMAP = global.STORYMAP || {});
    ns.filter = factory();
  }
}(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  /** Normalise the simple filter spec — empty arrays → null. */
  function normalizeFilter(raw) {
    raw = raw || {};
    const statuses = Array.isArray(raw.statuses) && raw.statuses.length > 0
      ? raw.statuses.slice() : null;
    const types = Array.isArray(raw.types) && raw.types.length > 0
      ? raw.types.slice() : null;
    return {
      statuses: statuses,
      types: types,
      hideCompletedReleases: !!raw.hideCompletedReleases
    };
  }

  /**
   * Convert the simple spec into a Boolean-Tree AST. Today's UI generates a
   * flat AND-tree; a future JQL parser produces arbitrary trees with the
   * same node shapes and the same evaluator works unchanged.
   */
  function toAST(filter) {
    const f = normalizeFilter(filter);
    const clauses = [];
    if (f.statuses) {
      clauses.push({ op: "CLAUSE", field: "status", clauseOp: "in", values: f.statuses });
    }
    if (f.types) {
      clauses.push({ op: "CLAUSE", field: "type", clauseOp: "in", values: f.types });
    }
    if (f.hideCompletedReleases) {
      clauses.push({ op: "CLAUSE", field: "release.status", clauseOp: "neq", value: "completed" });
    }
    return { op: "AND", children: clauses };
  }

  function isAST(x) {
    return x && typeof x === "object" && typeof x.op === "string"
      && (x.op === "AND" || x.op === "OR" || x.op === "NOT" || x.op === "CLAUSE");
  }

  /**
   * Test whether `ticket` satisfies the filter. Accepts either a simple spec
   * (will be converted to AST internally) or a pre-built AST. `ctx` provides
   * resolution helpers for virtual fields — pass `buildReleaseCtx(snapshot)`
   * if your filter uses `release.status`.
   */
  function matchesFilter(ticket, filter, ctx) {
    if (!filter) return true;
    const ast = isAST(filter) ? filter : toAST(filter);
    return evalNode(ticket, ast, ctx);
  }

  function evalNode(ticket, node, ctx) {
    if (!node) return true;
    if (node.op === "AND") {
      return (node.children || []).every(function (c) { return evalNode(ticket, c, ctx); });
    }
    if (node.op === "OR") {
      const cs = node.children || [];
      if (cs.length === 0) return true;
      return cs.some(function (c) { return evalNode(ticket, c, ctx); });
    }
    if (node.op === "NOT") {
      return !evalNode(ticket, node.child, ctx);
    }
    if (node.op === "CLAUSE") {
      return evalClause(ticket, node, ctx);
    }
    return true;
  }

  function evalClause(ticket, clause, ctx) {
    const value = resolveField(ticket, clause.field, ctx);
    switch (clause.clauseOp) {
      case "eq":     return value === clause.value;
      case "neq":    return value !== clause.value;
      case "in":     return Array.isArray(clause.values) && clause.values.indexOf(value) >= 0;
      case "not-in": return !Array.isArray(clause.values) || clause.values.indexOf(value) < 0;
      default:       return true;
    }
  }

  function resolveField(ticket, field, ctx) {
    if (!ticket || !field) return null;
    if (field === "status") return ticket.status;
    if (field === "type")   return ticket.type;
    if (field === "release.status") {
      const rid = ticket.position && ticket.position.releaseId;
      if (!rid || !ctx || !ctx.releaseById) return null;
      const r = ctx.releaseById.get(rid);
      return r ? r.status : null;
    }
    return null;
  }

  /**
   * Whether a release-row should be rendered at all. Used by Map to skip
   * the entire row when its status is `completed` and the filter hides it.
   */
  function releaseVisible(release, filter) {
    if (!filter || !release) return true;
    const f = normalizeFilter(filter);
    if (f.hideCompletedReleases && release.status === "completed") return false;
    return true;
  }

  /** Build a release-by-id lookup for use as `ctx` in matchesFilter. */
  function buildReleaseCtx(snapshot) {
    const releaseById = new Map();
    const releases = (snapshot && snapshot.releases) || [];
    for (let i = 0; i < releases.length; i++) {
      releaseById.set(releases[i].id, releases[i]);
    }
    return { releaseById: releaseById };
  }

  /** Count how many filter dimensions are active. Drives the toolbar badge. */
  function countActiveRules(filter) {
    const f = normalizeFilter(filter);
    let n = 0;
    if (f.statuses) n++;
    if (f.types) n++;
    if (f.hideCompletedReleases) n++;
    return n;
  }

  /** Sentinel: a fully-empty filter (no constraint). Useful as a default. */
  const EMPTY_FILTER = Object.freeze({
    statuses: null,
    types: null,
    hideCompletedReleases: false
  });

  /**
   * SM-16 — free-text search match (distinct from the structured board filter:
   * search HIGHLIGHTS, the filter REMOVES). Case-insensitive; an empty/blank
   * query matches everything. Every whitespace-separated term must be found
   * (AND) somewhere in the ticket's key / title / description / labels.
   */
  function searchHaystack(ticket) {
    if (!ticket) return "";
    const labels = Array.isArray(ticket.labels) ? ticket.labels.join(" ") : "";
    return [ticket.ticketKey, ticket.title, ticket.description, labels]
      .filter(function (s) { return typeof s === "string"; })
      .join(" ")
      .toLowerCase();
  }

  function matchesSearch(ticket, query) {
    const q = (query == null ? "" : String(query)).toLowerCase().trim();
    if (q === "") return true;
    const hay = searchHaystack(ticket);
    return q.split(/\s+/).every(function (term) { return hay.indexOf(term) >= 0; });
  }

  return {
    normalizeFilter: normalizeFilter,
    toAST: toAST,
    matchesFilter: matchesFilter,
    matchesSearch: matchesSearch,
    releaseVisible: releaseVisible,
    buildReleaseCtx: buildReleaseCtx,
    countActiveRules: countActiveRules,
    EMPTY_FILTER: EMPTY_FILTER,
    // Exposed for tests / debugging:
    _evalNode: evalNode,
    _resolveField: resolveField
  };
}));
