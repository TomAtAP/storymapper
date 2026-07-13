/**
 * SM-216 — JQL autocomplete suggestion engine (Story S5 of epic SM-187).
 *
 * Pure. No DOM. UMD; shared so it's unit-testable in Node and used by the
 * browser dropdown (frontend/js/smartbar-autocomplete.js). Requires the parser
 * (shared/query.js, for tokenize + keyword/operator catalogue) and the engine
 * (shared/query-engine.js, for QUERY_FIELDS — the SINGLE source of fields + the
 * per-field value lists).
 *
 *   suggest(input, cursor, snapshot) → [{ insertText, label, kind, replaceStart,
 *                                         replaceEnd }]
 *
 * `kind` ∈ field | operator | value | keyword. The dropdown replaces the text in
 * [replaceStart, replaceEnd] (the in-progress token) with insertText. Context is
 * derived from a small state machine over the tokens to the LEFT of the cursor:
 * at the start / after AND·OR·NOT·'(' → fields; after a field → operators; after
 * an operator → that field's values; after a complete clause → AND·OR·')'·ORDER BY.
 */
(function (global, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./query.js"), require("./query-engine.js"));
  } else {
    const ns = (global.STORYMAP = global.STORYMAP || {});
    ns.queryAutocomplete = factory(ns.query, ns.queryEngine);
  }
}(typeof window !== "undefined" ? window : globalThis, function (Q, engine) {
  "use strict";

  const MAX = 20;   // enough to show every field with no prefix; values stay scrollable
  const isKw = (t, kw) => t && t.type === "word" && String(t.value).toUpperCase() === kw;
  const opToInsert = { "=": "= ", "!=": "!= ", "~": "~ ", "<": "< ", ">": "> ", "<=": "<= ", ">=": ">= " };
  // The operators offered per field, derived from the field's clauseOps.
  const OP_SUGGEST = { eq: "=", neq: "!=", contains: "~", in: "IN", "not-in": "NOT IN", lt: "<", gt: ">", lte: "<=", gte: ">=" };

  /** Lenient tokenize of the text up to the cursor — query.tokenize throws on an
   *  unterminated string / unexpected char while typing, so fall back to the
   *  valid prefix + the in-progress tail as a partial token. */
  function leftTokens(left) {
    try {
      return Q.tokenize(left).filter((t) => t.type !== "eof");
    } catch (e) {
      const pos = typeof e.position === "number" ? e.position : left.length;
      let toks = [];
      try { toks = Q.tokenize(left.slice(0, pos)).filter((t) => t.type !== "eof"); } catch (_e) { toks = []; }
      const tail = left.slice(pos);
      const quoted = tail[0] === '"' || tail[0] === "'";
      toks.push({ type: quoted ? "string" : "word", value: quoted ? tail.slice(1) : tail, start: pos, end: left.length, partial: true });
      return toks;
    }
  }

  /** Walk the preceding tokens → { state, lastField }. */
  function analyze(tokens) {
    let state = "field", lastField = null;
    for (const t of tokens) {
      switch (state) {
        case "field":
          if (t.type === "lparen" || isKw(t, "NOT")) break;          // still expecting a field
          if (t.type === "word") { lastField = t.value; state = "operator"; }
          break;
        case "operator":
          if (t.type === "op") state = "value";
          else if (isKw(t, "IN")) state = "list-open";
          else if (isKw(t, "NOT")) state = "notin";
          else state = "value";
          break;
        case "notin":
          if (isKw(t, "IN")) state = "list-open";
          break;
        case "value":
          if (t.type === "word" || t.type === "string") state = "after";
          break;
        case "list-open":
          if (t.type === "lparen") state = "in-list";
          break;
        case "in-list":
          if (t.type === "rparen") state = "after";
          break;                                                     // words / commas stay in-list
        case "after":
          if (isKw(t, "AND") || isKw(t, "OR") || isKw(t, "NOT")) state = "field";
          else if (isKw(t, "ORDER")) state = "order-by";
          break;
        case "order-by":  if (isKw(t, "BY")) state = "order-field"; break;
        case "order-field": if (t.type === "word") state = "order-dir"; break;
        case "order-dir": state = "done"; break;   // a sort direction ends the query → no more suggestions
        default: break;
      }
    }
    return { state: state, lastField: lastField };
  }

  function fieldDefs() { return engine.QUERY_FIELDS; }
  function fieldByKey(key) {
    const k = String(key || "").toLowerCase();
    return fieldDefs().find((f) => f.key.toLowerCase() === k) || null;
  }

  function rank(candidates, prefix, kind, replaceStart, replaceEnd) {
    const p = String(prefix || "").toLowerCase();
    const out = [];
    for (const c of candidates) {
      const label = c.label != null ? c.label : c.insertText.trim();
      const hay = String(c.matchOn != null ? c.matchOn : label).toLowerCase();
      if (p && hay.indexOf(p) < 0) continue;
      out.push({
        insertText: c.insertText, label: label, kind: kind,
        replaceStart: replaceStart, replaceEnd: replaceEnd,
        _exact: p && hay.indexOf(p) === 0 ? 0 : 1
      });
    }
    out.sort((a, b) => (a._exact - b._exact) || a.label.localeCompare(b.label));
    return out.slice(0, MAX).map((s) => { delete s._exact; return s; });
  }

  function quoteIfNeeded(v) {
    const s = String(v);
    return /[\s(),"]/.test(s) ? '"' + s.replace(/"/g, '\\"') + '"' : s;
  }

  /** Main entry. */
  function suggest(input, cursor, snapshot) {
    input = String(input == null ? "" : input);
    cursor = typeof cursor === "number" ? cursor : input.length;
    const left = input.slice(0, cursor);
    const toks = leftTokens(left);

    // The in-progress (partial) token is the last token ending exactly at the
    // cursor; otherwise the cursor sits after whitespace/a delimiter → no prefix.
    let partial = null;
    if (toks.length) {
      const last = toks[toks.length - 1];
      if (last.end === left.length && (last.type === "word" || last.type === "string" || last.partial)) partial = last;
    }
    const preceding = partial ? toks.slice(0, -1) : toks;
    const prefix = partial ? String(partial.value) : "";
    const replaceStart = partial ? partial.start : cursor;
    const replaceEnd = cursor;

    const ctx = analyze(preceding);
    const field = ctx.lastField ? fieldByKey(ctx.lastField) : null;

    // FIELD position.
    if (ctx.state === "field" || ctx.state === "order-field") {
      const cands = fieldDefs().map((f) => ({ insertText: f.key + " ", label: f.key, matchOn: f.key + " " + (f.label || "") }));
      if (ctx.state === "field") { cands.push({ insertText: "NOT ", label: "NOT", matchOn: "not" }); cands.push({ insertText: "(", label: "(", matchOn: "(" }); }
      return rank(cands, prefix, "field", replaceStart, replaceEnd);
    }
    // OPERATOR position — only the operators the field actually allows.
    if (ctx.state === "operator") {
      const ops = field ? field.ops : ["eq", "neq", "contains", "in", "not-in", "lt", "gt", "lte", "gte"];
      const cands = ops.map((op) => {
        const sym = OP_SUGGEST[op];
        const insert = opToInsert[sym] != null ? opToInsert[sym] : (sym + " " + (op === "in" || op === "not-in" ? "(" : ""));
        return { insertText: insert, label: sym, matchOn: sym };
      });
      return rank(cands, prefix, "operator", replaceStart, replaceEnd);
    }
    if (ctx.state === "notin") {
      return rank([{ insertText: "IN (", label: "IN", matchOn: "in" }], prefix, "operator", replaceStart, replaceEnd);
    }
    if (ctx.state === "list-open") {
      return rank([{ insertText: "(", label: "(", matchOn: "(" }], prefix, "operator", replaceStart, replaceEnd);
    }
    // VALUE position — field-specific values (enum/ref/multi/link). Free-input
    // fields (text/number/date) offer nothing.
    if (ctx.state === "value" || ctx.state === "in-list") {
      const cands = [];
      if (field && typeof field.values === "function") {
        let vals = [];
        try { vals = field.values(snapshot || {}) || []; } catch (_e) { vals = []; }
        for (const v of vals) cands.push({ insertText: quoteIfNeeded(v) + " ", label: String(v), matchOn: String(v) });
      }
      if (ctx.state === "in-list") cands.push({ insertText: ")", label: ")", matchOn: ")" });
      return rank(cands, prefix, "value", replaceStart, replaceEnd);
    }
    // After a complete clause.
    if (ctx.state === "after") {
      const cands = [
        { insertText: "AND ", label: "AND", matchOn: "and" },
        { insertText: "OR ", label: "OR", matchOn: "or" },
        { insertText: "ORDER BY ", label: "ORDER BY", matchOn: "order by" },
        { insertText: ")", label: ")", matchOn: ")" }
      ];
      return rank(cands, prefix, "keyword", replaceStart, replaceEnd);
    }
    if (ctx.state === "order-by") {
      return rank([{ insertText: "BY ", label: "BY", matchOn: "by" }], prefix, "keyword", replaceStart, replaceEnd);
    }
    if (ctx.state === "order-dir") {
      return rank([{ insertText: "ASC ", label: "ASC", matchOn: "asc" }, { insertText: "DESC ", label: "DESC", matchOn: "desc" }], prefix, "keyword", replaceStart, replaceEnd);
    }
    return [];
  }

  return { suggest: suggest, _analyze: analyze, _leftTokens: leftTokens };
}));
