/**
 * SM-188 — JQL-angelehnter Query-Parser (Story S1 of epic SM-187).
 *
 * Pure. No DOM, no I/O. UMD-wrapped so the SAME source is `require()`d on the
 * server (SM-190 MCP `query_tickets`) AND `<script src>`'d in the browser
 * (SM-191 smart-bar) — via the frontend/js/query.js symlink.
 *
 * Text query → Boolean-Tree AST (the SAME node shapes filter.js evaluates,
 * SM-82) + an optional ORDER BY. The engine (SM-189) resolves fields + runs it;
 * the autocomplete (SM-216) reuses `tokenize` + the keyword/operator catalogue.
 *
 * Grammar (recursive descent, AND binds tighter than OR):
 *   query    := orExpr (ORDER BY orderClause)?  EOF
 *   orExpr   := andExpr (OR andExpr)*
 *   andExpr  := unary  (AND unary)*
 *   unary    := NOT unary | primary
 *   primary  := '(' orExpr ')' | clause
 *   clause   := FIELD operator value
 *   operator := '=' | '!=' | '~' | '<' | '>' | '<=' | '>=' | IN | NOT IN
 *   value    := scalar | '(' scalar (',' scalar)* ')'      // list for IN/NOT IN
 *   scalar   := QUOTED | WORD
 *   orderClause := FIELD (ASC | DESC)?
 *
 * AST node shapes (plain objects, == filter.js):
 *   { op:"AND", children:Node[] } | { op:"OR", children:Node[] }
 *   | { op:"NOT", child:Node }
 *   | { op:"CLAUSE", field, clauseOp, value? , values? }
 * clauseOp ∈ eq | neq | contains | in | not-in | lt | gt | lte | gte
 *
 * `parseQuery(text)` NEVER throws — it returns { ast, orderBy, error } so the
 * UI can render an inline error at `error.position`. An empty / whitespace-only
 * query yields { ast:null, orderBy:null, error:null } (ast null = match all).
 */
(function (global, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else {
    const ns = (global.STORYMAP = global.STORYMAP || {});
    ns.query = factory();
  }
}(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  // Reserved keywords (matched case-insensitively on word tokens). A field name
  // may not be one of these; in value position a bareword keyword is still a
  // value (scalar reads exactly one token).
  const KEYWORDS = Object.freeze(["AND", "OR", "NOT", "IN", "ORDER", "BY", "ASC", "DESC"]);
  // Symbolic operators → clauseOp. Multi-char first so "<=" beats "<".
  const OPERATORS = Object.freeze(["!=", "<=", ">=", "=", "~", "<", ">"]);
  const OP_TO_CLAUSE = Object.freeze({
    "=": "eq", "!=": "neq", "~": "contains", "<": "lt", ">": "gt", "<=": "lte", ">=": "gte"
  });

  const WORD_RE = /[A-Za-z0-9_.\-]/;

  function isKeyword(value, kw) {
    return typeof value === "string" && value.toUpperCase() === kw;
  }

  function mkError(message, position, expected) {
    const e = new Error(message);
    e.isParseError = true;
    e.position = position;
    if (expected) e.expected = expected;
    return e;
  }

  /**
   * Tokenize into { type, value, start, end } tokens, terminated by an `eof`
   * token. Throws a parse error (caught by parseQuery) on an unterminated
   * string or an unexpected character. Exposed for the autocomplete engine.
   * Types: word | string | op | lparen | rparen | comma | eof.
   */
  function tokenize(input) {
    const s = String(input == null ? "" : input);
    const tokens = [];
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (/\s/.test(c)) { i++; continue; }
      if (c === "(") { tokens.push({ type: "lparen", value: "(", start: i, end: i + 1 }); i++; continue; }
      if (c === ")") { tokens.push({ type: "rparen", value: ")", start: i, end: i + 1 }); i++; continue; }
      if (c === ",") { tokens.push({ type: "comma", value: ",", start: i, end: i + 1 }); i++; continue; }
      if (c === '"' || c === "'") {
        const quote = c;
        let j = i + 1, val = "";
        while (j < s.length && s[j] !== quote) {
          if (s[j] === "\\" && j + 1 < s.length) { val += s[j + 1]; j += 2; }
          else { val += s[j]; j++; }
        }
        if (j >= s.length) throw mkError("unterminated string literal", i);
        tokens.push({ type: "string", value: val, start: i, end: j + 1 });
        i = j + 1;
        continue;
      }
      let matchedOp = null;
      for (let k = 0; k < OPERATORS.length; k++) {
        const op = OPERATORS[k];
        if (s.substr(i, op.length) === op) { matchedOp = op; break; }
      }
      if (matchedOp) { tokens.push({ type: "op", value: matchedOp, start: i, end: i + matchedOp.length }); i += matchedOp.length; continue; }
      if (WORD_RE.test(c)) {
        let j = i;
        while (j < s.length && WORD_RE.test(s[j])) j++;
        tokens.push({ type: "word", value: s.slice(i, j), start: i, end: j });
        i = j;
        continue;
      }
      throw mkError("unexpected character '" + c + "'", i);
    }
    tokens.push({ type: "eof", value: "", start: s.length, end: s.length });
    return tokens;
  }

  const OPERATOR_HINT = ["=", "!=", "~", "IN", "NOT IN", "<", ">", "<=", ">="];

  function parseQuery(input) {
    let tokens;
    try { tokens = tokenize(input); }
    catch (e) { return { ast: null, orderBy: null, error: errOf(e) }; }

    // Empty / whitespace-only → match-all, no error.
    if (tokens.length === 1 && tokens[0].type === "eof") {
      return { ast: null, orderBy: null, error: null };
    }

    let pos = 0;
    const peek = () => tokens[pos];
    const next = () => tokens[pos++];
    const atEof = () => peek().type === "eof";
    const isWordKw = (kw) => peek().type === "word" && isKeyword(peek().value, kw);

    function expect(type, label) {
      const t = peek();
      if (t.type !== type) throw mkError("expected " + (label || type) + ", got '" + tokenLabel(t) + "'", t.start, label ? [label] : undefined);
      return next();
    }

    function parseOr() {
      const children = [parseAnd()];
      while (isWordKw("OR")) { next(); children.push(parseAnd()); }
      return children.length === 1 ? children[0] : { op: "OR", children: children };
    }
    function parseAnd() {
      const children = [parseUnary()];
      while (isWordKw("AND")) { next(); children.push(parseUnary()); }
      return children.length === 1 ? children[0] : { op: "AND", children: children };
    }
    function parseUnary() {
      if (isWordKw("NOT")) { next(); return { op: "NOT", child: parseUnary() }; }
      return parsePrimary();
    }
    function parsePrimary() {
      if (peek().type === "lparen") {
        next();
        const inner = parseOr();
        expect("rparen", ")");
        return inner;
      }
      return parseClause();
    }
    function parseClause() {
      const ft = peek();
      if (ft.type !== "word" || KEYWORDS.some((k) => isKeyword(ft.value, k))) {
        throw mkError("expected a field name, got '" + tokenLabel(ft) + "'", ft.start, ["<field>"]);
      }
      const field = next().value;

      // Operator.
      let clauseOp, isList = false;
      const ot = peek();
      if (ot.type === "op") { clauseOp = OP_TO_CLAUSE[next().value]; }
      else if (isWordKw("IN")) { next(); clauseOp = "in"; isList = true; }
      else if (isWordKw("NOT")) {
        next();
        if (!isWordKw("IN")) throw mkError("expected IN after NOT", peek().start, ["IN"]);
        next(); clauseOp = "not-in"; isList = true;
      } else {
        throw mkError("expected an operator after field '" + field + "'", ot.start, OPERATOR_HINT);
      }

      // Value.
      if (isList) {
        expect("lparen", "(");
        const values = [parseScalar()];
        while (peek().type === "comma") { next(); values.push(parseScalar()); }
        expect("rparen", ")");
        return { op: "CLAUSE", field: field, clauseOp: clauseOp, values: values };
      }
      return { op: "CLAUSE", field: field, clauseOp: clauseOp, value: parseScalar() };
    }
    function parseScalar() {
      const t = peek();
      if (t.type === "string") return next().value;
      if (t.type === "word") return next().value;
      throw mkError("expected a value, got '" + tokenLabel(t) + "'", t.start, ["<value>"]);
    }
    function parseOrderBy() {
      // caller has confirmed the current token is the ORDER keyword
      next();                                  // ORDER
      if (!isWordKw("BY")) throw mkError("expected BY after ORDER", peek().start, ["BY"]);
      next();                                  // BY
      const ft = peek();
      if (ft.type !== "word" || KEYWORDS.some((k) => isKeyword(ft.value, k))) {
        throw mkError("expected a field name after ORDER BY", ft.start, ["<field>"]);
      }
      const field = next().value;
      let dir = "asc";
      if (isWordKw("ASC")) { next(); dir = "asc"; }
      else if (isWordKw("DESC")) { next(); dir = "desc"; }
      return { field: field, dir: dir };
    }

    try {
      const ast = parseOr();
      let orderBy = null;
      if (isWordKw("ORDER")) orderBy = parseOrderBy();
      if (!atEof()) {
        const t = peek();
        throw mkError("unexpected '" + tokenLabel(t) + "'", t.start);
      }
      return { ast: ast, orderBy: orderBy, error: null };
    } catch (e) {
      // parseQuery NEVER throws (the smart-bar parses on every keystroke). A
      // structured parse error is returned as-is; anything else (e.g. a
      // RangeError from pathologically deep paren nesting) collapses to a generic
      // positioned error so the contract holds honestly.
      if (e.isParseError) return { ast: null, orderBy: null, error: errOf(e) };
      return { ast: null, orderBy: null, error: { message: "query too complex to parse", position: 0 } };
    }
  }

  function tokenLabel(t) {
    if (!t) return "";
    return t.type === "eof" ? "end of query" : String(t.value);
  }
  function errOf(e) {
    const out = { message: e.message, position: typeof e.position === "number" ? e.position : 0 };
    if (e.expected) out.expected = e.expected;
    return out;
  }

  /**
   * Heuristic for the unified smart-bar (SM-191): does the input look like a
   * structured query rather than free-text search? A query is a `field operator …`
   * clause. When `fieldKeys` is supplied (the UI always does — from QUERY_FIELDS),
   * the heuristic is precise: the input must contain a KNOWN field immediately
   * followed by an operator (or `IN (`). That keeps plain searches like
   * "find in files", "price < 100", "Search and replace" as simple search (their
   * leading word isn't a real field). Without fieldKeys it falls back to a looser
   * "any word followed by an operator" rule (used by unit tests / older callers).
   */
  function looksLikeQuery(input, fieldKeys) {
    const s = String(input == null ? "" : input).trim();
    if (!s) return false;
    const OP = "(?:!=|<=|>=|[=~<>])";
    const IN = "(?:NOT\\s+)?IN\\s*\\(";   // IN must be followed by '(' to count
    if (Array.isArray(fieldKeys) && fieldKeys.length) {
      const keys = fieldKeys.map((k) => String(k).toLowerCase());
      // A clause start: beginning, or just after AND / OR / NOT / '('.
      const re = new RegExp("(?:^|[\\s(]|\\bAND\\b|\\bOR\\b|\\bNOT\\b)\\s*([A-Za-z0-9_.\\-]+)\\s*(?:" + OP + "|" + IN + ")", "ig");
      let m;
      while ((m = re.exec(s))) { if (keys.indexOf(m[1].toLowerCase()) >= 0) return true; }
      return false;
    }
    // Loose fallback: any word directly followed by an operator, or `… IN (`.
    if (new RegExp("[A-Za-z0-9_.\\-]\\s*" + OP).test(s)) return true;
    if (new RegExp("[A-Za-z0-9_.\\-]\\s+" + IN, "i").test(s)) return true;
    return false;
  }

  return {
    KEYWORDS: KEYWORDS,
    OPERATORS: OPERATORS,
    OP_TO_CLAUSE: OP_TO_CLAUSE,
    OPERATOR_HINT: OPERATOR_HINT,
    tokenize: tokenize,
    parseQuery: parseQuery,
    looksLikeQuery: looksLikeQuery
  };
}));
