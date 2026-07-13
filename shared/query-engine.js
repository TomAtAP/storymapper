/**
 * SM-189 — Query engine + field schema (Story S2 of epic SM-187).
 *
 * Pure. No DOM, no I/O. UMD-wrapped; shared by the server (SM-190 MCP
 * query_tickets) and the browser (SM-191 smart-bar) via the
 * frontend/js/query-engine.js symlink. Requires the parser (shared/query.js).
 *
 * The QUERY_FIELDS schema is the SINGLE SOURCE that drives field resolution
 * (here), semantic validation (here), and the autocomplete value-suggestions
 * (SM-216). Each field: { key, label, type, ops, resolve(ticket, ctx),
 * values(snapshot) }. `type` selects the matcher; `ops` is the allow-list of
 * clauseOps the field accepts (validation + autocomplete).
 *
 * Public surface:
 *   QUERY_FIELDS              — the field definitions (array)
 *   fieldsByKey()             — lower-cased key → field def
 *   buildQueryCtx(snapshot)   — resolution indexes (release/step/epic/links)
 *   evaluate(ast, ticket, ctx, fields)  — per-ticket boolean
 *   validateQuery(ast, orderBy, fields) — semantic check → {message,...}|null
 *   queryTickets(snapshot, queryOrAst, opts) → { tickets, orderBy?, error? }
 */
(function (global, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./query.js"));
  } else {
    const ns = (global.STORYMAP = global.STORYMAP || {});
    ns.queryEngine = factory(ns.query);
  }
}(typeof window !== "undefined" ? window : globalThis, function (queryParser) {
  "use strict";

  const parseQuery = queryParser && queryParser.parseQuery;

  // -- matchers (per field type) ---------------------------------------------

  const ci = (x) => String(x == null ? "" : x).toLowerCase();

  function matchScalar(resolved, clause) {
    if (clause.clauseOp === "neq") return !(resolved != null && ci(resolved) === ci(clause.value));
    if (clause.clauseOp === "not-in") return !(resolved != null && clause.values.some((v) => ci(resolved) === ci(v)));
    if (resolved == null) return false;
    switch (clause.clauseOp) {
      case "eq":       return ci(resolved) === ci(clause.value);
      case "contains": return ci(resolved).indexOf(ci(clause.value)) >= 0;
      case "in":       return clause.values.some((v) => ci(resolved) === ci(v));
      default:         return false;
    }
  }

  // SM-260: ref fields resolve to a SET of acceptable values (name + id, or
  // ticketKey + id for epic). A clause matches if it hits ANY candidate, so
  // `release = r1` (id) and `release = v1.0` (name) both work.
  function matchRef(cands, clause) {
    const arr = (cands || []).filter((x) => x != null).map(String);
    const eqAny = (v) => arr.some((x) => ci(x) === ci(v));
    switch (clause.clauseOp) {
      case "eq":       return eqAny(clause.value);
      case "neq":      return !eqAny(clause.value);
      case "contains": return arr.some((x) => ci(x).indexOf(ci(clause.value)) >= 0);
      case "in":       return (clause.values || []).some(eqAny);
      case "not-in":   return !(clause.values || []).some(eqAny);
      default:         return false;
    }
  }

  // membership semantics for array-valued fields (labels, linked keys)
  function matchMulti(resolved, clause) {
    const arr = Array.isArray(resolved) ? resolved : [];
    const has = (v) => arr.some((x) => ci(x) === ci(v));
    switch (clause.clauseOp) {
      case "eq": case "contains": return has(clause.value);
      case "neq":                 return !has(clause.value);
      case "in":                  return clause.values.some(has);
      case "not-in":              return !clause.values.some(has);
      default:                    return false;
    }
  }

  function cmp(a, b, op) {
    switch (op) {
      case "eq":  return a === b;  case "neq": return a !== b;
      case "lt":  return a < b;    case "gt":  return a > b;
      case "lte": return a <= b;   case "gte": return a >= b;
      default:    return false;
    }
  }
  function matchNumber(resolved, clause) {
    const a = Number(resolved), b = Number(clause.value);
    if (Number.isNaN(a) || Number.isNaN(b)) return false;
    return cmp(a, b, clause.clauseOp);
  }
  function matchDate(resolved, clause) {
    const a = Number(resolved), b = Date.parse(clause.value);
    if (Number.isNaN(a) || Number.isNaN(b)) return false;
    return cmp(a, b, clause.clauseOp);
  }

  const MATCHERS = { enum: matchScalar, ref: matchScalar, text: matchScalar, multi: matchMulti, number: matchNumber, date: matchDate };

  // -- helpers for values() + resolve ----------------------------------------

  function uniq(/* ...arrays */) {
    const seen = new Set(), out = [];
    for (let i = 0; i < arguments.length; i++) {
      for (const v of (arguments[i] || [])) {
        if (v == null || v === "") continue;
        const k = ci(v);
        if (!seen.has(k)) { seen.add(k); out.push(v); }
      }
    }
    return out;
  }
  const proj = (snap) => (snap && snap.project) || {};
  const liveTickets = (snap) => ((snap && snap.tickets) || []).filter((t) => t && !t.isDeleted);
  function haystack(t) {
    const labels = Array.isArray(t.labels) ? t.labels.join(" ") : "";
    return [t.ticketKey, t.title, t.description, labels].filter((s) => typeof s === "string").join(" ");
  }

  const SCALAR_OPS = ["eq", "neq", "in", "not-in"];
  const NUM_OPS    = ["eq", "neq", "lt", "gt", "lte", "gte"];
  const MULTI_OPS  = ["eq", "neq", "contains", "in", "not-in"];

  // -- the field schema (single source) --------------------------------------

  const QUERY_FIELDS = [
    { key: "type", label: "Type", type: "enum", ops: SCALAR_OPS,
      resolve: (t) => t.type,
      values: (s) => uniq(proj(s).ticketTypes, liveTickets(s).map((t) => t.type)) },
    { key: "status", label: "Status", type: "enum", ops: SCALAR_OPS,
      resolve: (t) => t.status,
      values: (s) => uniq(((proj(s).workflow || {}).statuses || []).map((x) => x.id || x), liveTickets(s).map((t) => t.status)) },
    { key: "key", label: "Ticket key", type: "text", ops: ["eq", "neq", "contains", "in", "not-in"],
      resolve: (t) => t.ticketKey,
      values: (s) => liveTickets(s).map((t) => t.ticketKey) },
    { key: "title", label: "Title", type: "text", ops: ["contains", "eq", "neq"],
      resolve: (t) => t.title, values: () => [] },
    { key: "description", label: "Description", type: "text", ops: ["contains", "eq", "neq"],
      resolve: (t) => t.description, values: () => [] },
    { key: "text", label: "Full text", type: "text", ops: ["contains"],
      resolve: (t) => haystack(t), values: () => [] },
    // SM-260: ref fields match by NAME *or* ID (resolve = display name for sort
    // + autocomplete; matchset = every acceptable filter value; known = all
    // valid values in the snapshot, for the strictRefs unknown-value check).
    { key: "release", label: "Release", type: "ref", ops: SCALAR_OPS,
      resolve: (t, ctx) => { const r = ctx.releaseById.get(t.position && t.position.releaseId); return r ? r.name : null; },
      matchset: (t, ctx) => { const r = ctx.releaseById.get(t.position && t.position.releaseId); return r ? [r.name, r.id] : []; },
      known: (s) => [].concat.apply([], ((s && s.releases) || []).filter((r) => !r.isDeleted).map((r) => [r.name, r.id])),
      values: (s) => ((s && s.releases) || []).filter((r) => !r.isDeleted).map((r) => r.name) },
    { key: "processStep", label: "Process step", type: "ref", ops: SCALAR_OPS,
      resolve: (t, ctx) => { const p = ctx.stepById.get(t.position && t.position.processStepId); return p ? p.name : null; },
      matchset: (t, ctx) => { const p = ctx.stepById.get(t.position && t.position.processStepId); return p ? [p.name, p.id] : []; },
      known: (s) => [].concat.apply([], ((s && s.processSteps) || []).filter((p) => !p.isDeleted).map((p) => [p.name, p.id])),
      values: (s) => ((s && s.processSteps) || []).filter((p) => !p.isDeleted).map((p) => p.name) },
    { key: "epic", label: "Epic", type: "ref", ops: SCALAR_OPS,
      resolve: (t, ctx) => ctx.epicKeyByStory.get(t.id) || null,
      matchset: (t, ctx) => [ctx.epicKeyByStory.get(t.id), ctx.epicIdByStory.get(t.id)].filter((x) => x != null),
      known: (s) => [].concat.apply([], liveTickets(s).filter((t) => t.type === "epic").map((t) => [t.ticketKey, t.id])),
      values: (s) => liveTickets(s).filter((t) => t.type === "epic").map((t) => t.ticketKey) },
    { key: "label", label: "Label", type: "multi", ops: MULTI_OPS,
      resolve: (t) => t.labels || [],
      values: (s) => uniq(proj(s).labels, [].concat.apply([], liveTickets(s).map((t) => t.labels || []))) },
    { key: "linkedTo", label: "Links to (key)", type: "multi", ops: MULTI_OPS,
      resolve: (t, ctx) => ctx.linkedTo.get(t.id) || [],
      values: (s) => liveTickets(s).map((t) => t.ticketKey) },
    { key: "linkedFrom", label: "Linked from (key)", type: "multi", ops: MULTI_OPS,
      resolve: (t, ctx) => ctx.linkedFrom.get(t.id) || [],
      values: (s) => liveTickets(s).map((t) => t.ticketKey) },
    { key: "acCount", label: "# acceptance criteria", type: "number", ops: NUM_OPS,
      resolve: (t) => (t.acceptanceCriteria || []).length, values: () => [] },
    { key: "created", label: "Created", type: "date", ops: NUM_OPS,
      resolve: (t) => t.createdAt, values: () => [] },
    { key: "updated", label: "Updated", type: "date", ops: NUM_OPS,
      resolve: (t) => t.updatedAt, values: () => [] }
  ];

  function fieldsByKey() {
    const m = {};
    for (const f of QUERY_FIELDS) m[f.key.toLowerCase()] = f;
    return m;
  }

  // -- resolution context ----------------------------------------------------

  function buildQueryCtx(snapshot) {
    const tickets = (snapshot && snapshot.tickets) || [];
    const keyById = new Map();
    for (const t of tickets) keyById.set(t.id, t.ticketKey);
    const releaseById = new Map(((snapshot && snapshot.releases) || []).map((r) => [r.id, r]));
    const stepById = new Map(((snapshot && snapshot.processSteps) || []).map((p) => [p.id, p]));
    const epicKeyByStory = new Map();
    const epicIdByStory = new Map();
    const linkedTo = new Map();
    const linkedFrom = new Map();
    for (const t of tickets) {
      if (t.isDeleted) continue;
      for (const l of (t.links || [])) {
        if (!l || typeof l.targetTicketId !== "string") continue;
        const lt = l.linkTypeId || l.type;
        const tgtKey = keyById.get(l.targetTicketId);
        if (tgtKey) {
          if (!linkedTo.has(t.id)) linkedTo.set(t.id, []);
          linkedTo.get(t.id).push(tgtKey);
          if (!linkedFrom.has(l.targetTicketId)) linkedFrom.set(l.targetTicketId, []);
          linkedFrom.get(l.targetTicketId).push(t.ticketKey);
          if (lt === "contains" && t.type === "epic") { epicKeyByStory.set(l.targetTicketId, t.ticketKey); epicIdByStory.set(l.targetTicketId, t.id); }
        }
      }
    }
    return { snapshot: snapshot, keyById, releaseById, stepById, epicKeyByStory, epicIdByStory, linkedTo, linkedFrom };
  }

  // -- evaluate + validate ---------------------------------------------------

  function evaluate(node, ticket, ctx, fields) {
    if (!node) return true;                                  // null AST = match all
    if (node.op === "AND") return (node.children || []).every((c) => evaluate(c, ticket, ctx, fields));
    if (node.op === "OR")  { const cs = node.children || []; return cs.length === 0 || cs.some((c) => evaluate(c, ticket, ctx, fields)); }
    if (node.op === "NOT") return !evaluate(node.child, ticket, ctx, fields);
    if (node.op === "CLAUSE") {
      const f = fields[String(node.field).toLowerCase()];
      if (!f) return false;                                 // unknown field (validation catches first)
      if (f.type === "ref" && typeof f.matchset === "function") return matchRef(f.matchset(ticket, ctx), node);
      const matcher = MATCHERS[f.type] || matchScalar;
      return matcher(f.resolve(ticket, ctx), node);
    }
    return true;
  }

  /** Semantic check: unknown field, operator not allowed on the field, unknown
   *  ORDER BY field. With strictRefs (SM-260) a positive ref clause (eq/in)
   *  whose value matches no known release/step/epic is reported as an error
   *  instead of silently returning 0 rows. Returns the first
   *  { message, field?, position } or null. */
  function validateQuery(node, orderBy, fields, snapshot, strictRefs) {
    let err = null;
    (function walk(n) {
      if (err || !n) return;
      if (n.op === "AND" || n.op === "OR") { (n.children || []).forEach(walk); return; }
      if (n.op === "NOT") { walk(n.child); return; }
      if (n.op === "CLAUSE") {
        const f = fields[String(n.field).toLowerCase()];
        if (!f) { err = { message: "unknown field '" + n.field + "'", field: n.field, position: 0 }; return; }
        if (f.ops.indexOf(n.clauseOp) < 0) {
          err = { message: "operator '" + n.clauseOp + "' is not allowed on field '" + n.field + "' (allowed: " + f.ops.join(", ") + ")", field: n.field, position: 0 };
          return;
        }
        if (strictRefs && f.type === "ref" && typeof f.known === "function"
            && (n.clauseOp === "eq" || n.clauseOp === "in")) {
          const knownSet = new Set((f.known(snapshot) || []).filter((x) => x != null).map((x) => ci(x)));
          const vals = n.clauseOp === "in" ? (n.values || []) : [n.value];
          for (const v of vals) {
            if (!knownSet.has(ci(v))) {
              err = { message: "no " + String(f.label || f.key).toLowerCase() + " matches '" + v + "'", field: n.field, position: 0 };
              return;
            }
          }
        }
      }
    })(node);
    if (!err && orderBy && !fields[String(orderBy.field).toLowerCase()]) {
      err = { message: "unknown ORDER BY field '" + orderBy.field + "'", field: orderBy.field, position: 0 };
    }
    return err;
  }

  // -- ordering --------------------------------------------------------------

  function defaultCompare(a, b) {
    const sa = (a.position && a.position.sortOrder) || 0;
    const sb = (b.position && b.position.sortOrder) || 0;
    if (sa !== sb) return sa - sb;
    return String(a.ticketKey || a.id).localeCompare(String(b.ticketKey || b.id));
  }
  function sortTickets(list, orderBy, fields, ctx) {
    const out = list.slice();
    if (!orderBy) { out.sort(defaultCompare); return out; }
    const f = fields[String(orderBy.field).toLowerCase()];
    const dir = orderBy.dir === "desc" ? -1 : 1;
    const numeric = f && (f.type === "number" || f.type === "date");
    out.sort((a, b) => {
      let va = f ? f.resolve(a, ctx) : null, vb = f ? f.resolve(b, ctx) : null;
      let c;
      if (numeric) { c = (Number(va) || 0) - (Number(vb) || 0); }
      else { c = ci(Array.isArray(va) ? va.join(",") : va).localeCompare(ci(Array.isArray(vb) ? vb.join(",") : vb)); }
      if (c !== 0) return dir * c;
      return defaultCompare(a, b);   // stable tiebreak
    });
    return out;
  }

  // -- top-level -------------------------------------------------------------

  /**
   * Run a query (string or pre-built AST) over a snapshot.
   * Returns { tickets: ordered[], orderBy?, error? }. A parse error (string
   * input) or a semantic error (unknown field / bad operator) yields an empty
   * list + the structured error. opts.orderBy overrides any ORDER BY in the
   * string. opts.includeDeleted (default false) keeps soft-deleted tickets out.
   */
  function queryTickets(snapshot, queryOrAst, opts) {
    opts = opts || {};
    let ast = null, orderBy = opts.orderBy || null;
    if (typeof queryOrAst === "string") {
      if (!parseQuery) return { tickets: [], error: { message: "parser unavailable", position: 0 } };
      const parsed = parseQuery(queryOrAst);
      if (parsed.error) return { tickets: [], error: parsed.error };
      ast = parsed.ast;
      if (!orderBy && parsed.orderBy) orderBy = parsed.orderBy;
    } else {
      ast = queryOrAst || null;
    }
    // validate + evaluate are recursive; a pathologically deep (hand-built) AST
    // could overflow the stack. Honour the no-throw contract on this path too
    // (the string path is already guarded inside the parser).
    try {
      const fields = fieldsByKey();
      const vErr = validateQuery(ast, orderBy, fields, snapshot, !!opts.strictRefs);
      if (vErr) return { tickets: [], error: vErr };
      const ctx = buildQueryCtx(snapshot);
      const base = ((snapshot && snapshot.tickets) || [])
        .filter((t) => t && (opts.includeDeleted || !t.isDeleted));
      const matched = base.filter((t) => evaluate(ast, t, ctx, fields));
      const ordered = sortTickets(matched, orderBy, fields, ctx);
      return { tickets: ordered, orderBy: orderBy || null, error: null };
    } catch (e) {
      return { tickets: [], error: { message: "query too complex to evaluate", position: 0 } };
    }
  }

  return {
    QUERY_FIELDS: QUERY_FIELDS,
    fieldsByKey: fieldsByKey,
    buildQueryCtx: buildQueryCtx,
    evaluate: evaluate,
    validateQuery: validateQuery,
    queryTickets: queryTickets
  };
}));
