"use strict";

// SM-188 — JQL-angelehnter Query-Parser (shared/query.js). Pure, no DOM.

const assert = require("assert");
const q = require("../shared/query.js");

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  - ${name}`); passed++; }
  catch (err) { console.log(`  FAIL - ${name}\n         ${err.stack || err.message}`); failed++; process.exitCode = 1; }
}
const parse = (s) => q.parseQuery(s);
const ast = (s) => { const r = parse(s); assert.strictEqual(r.error, null, "unexpected parse error: " + JSON.stringify(r.error)); return r.ast; };

// --- single clauses + every operator ---------------------------------------

test("SM-188: a simple equality clause → CLAUSE eq", () => {
  assert.deepStrictEqual(ast("type = user-story"),
    { op: "CLAUSE", field: "type", clauseOp: "eq", value: "user-story" });
});

test("SM-188: every scalar operator maps to its clauseOp", () => {
  assert.strictEqual(ast("type != bug").clauseOp, "neq");
  assert.strictEqual(ast("text ~ login").clauseOp, "contains");
  assert.strictEqual(ast("acCount < 3").clauseOp, "lt");
  assert.strictEqual(ast("acCount > 3").clauseOp, "gt");
  assert.strictEqual(ast("acCount <= 3").clauseOp, "lte");
  assert.strictEqual(ast("acCount >= 3").clauseOp, "gte");
});

test("SM-188: IN and NOT IN produce list clauses", () => {
  assert.deepStrictEqual(ast("status IN (ready, in-progress, done)"),
    { op: "CLAUSE", field: "status", clauseOp: "in", values: ["ready", "in-progress", "done"] });
  assert.deepStrictEqual(ast("status NOT IN (done, cancelled)"),
    { op: "CLAUSE", field: "status", clauseOp: "not-in", values: ["done", "cancelled"] });
});

test("SM-188: quoted strings carry values with spaces (and survive escapes)", () => {
  assert.strictEqual(ast('text ~ "login form"').value, "login form");
  assert.strictEqual(ast("release = 'Durchgängige Traceability'").value, "Durchgängige Traceability");
  assert.strictEqual(ast('label = "with \\"quotes\\""').value, 'with "quotes"');
});

// --- boolean structure + precedence ----------------------------------------

test("SM-188: AND binds tighter than OR", () => {
  // a OR b AND c  ==  a OR (b AND c)
  const tree = ast("type = epic OR status = ready AND type = bug");
  assert.strictEqual(tree.op, "OR");
  assert.strictEqual(tree.children.length, 2);
  assert.strictEqual(tree.children[0].op, "CLAUSE");          // type = epic
  assert.strictEqual(tree.children[1].op, "AND");             // (status = ready AND type = bug)
  assert.strictEqual(tree.children[1].children.length, 2);
});

test("SM-188: parentheses override precedence", () => {
  const tree = ast("(type = epic OR status = ready) AND type = bug");
  assert.strictEqual(tree.op, "AND");
  assert.strictEqual(tree.children[0].op, "OR");
  assert.strictEqual(tree.children[1].op, "CLAUSE");
});

test("SM-188: a single clause is NOT wrapped in an AND/OR node", () => {
  assert.strictEqual(ast("type = bug").op, "CLAUSE");
});

test("SM-188: boolean NOT negates the following term; distinct from NOT IN", () => {
  const tree = ast("NOT type = bug");
  assert.strictEqual(tree.op, "NOT");
  assert.strictEqual(tree.child.op, "CLAUSE");
  assert.strictEqual(tree.child.clauseOp, "eq");
  // NOT IN stays a clause, not a boolean NOT
  assert.strictEqual(ast("status NOT IN (done)").clauseOp, "not-in");
});

test("SM-188: keywords are case-insensitive", () => {
  const tree = ast("type = epic or status = ready And type = bug");
  assert.strictEqual(tree.op, "OR");
  assert.strictEqual(tree.children[1].op, "AND");
  assert.strictEqual(ast("status in (ready, done)").clauseOp, "in");
});

// --- ORDER BY ---------------------------------------------------------------

test("SM-188: ORDER BY yields a separate orderBy (default asc)", () => {
  const r = parse("type = bug ORDER BY created");
  assert.strictEqual(r.error, null);
  assert.strictEqual(r.ast.op, "CLAUSE");
  assert.deepStrictEqual(r.orderBy, { field: "created", dir: "asc" });
});

test("SM-188: ORDER BY ... DESC is honoured, case-insensitively", () => {
  assert.deepStrictEqual(parse("status = ready order by updated desc").orderBy,
    { field: "updated", dir: "desc" });
});

// --- empty + match-all ------------------------------------------------------

test("SM-188: empty / whitespace query → null ast, no error (match all)", () => {
  for (const s of ["", "   ", "\t\n"]) {
    const r = parse(s);
    assert.strictEqual(r.ast, null);
    assert.strictEqual(r.error, null);
  }
});

// --- error cases: clear message + position + expected -----------------------

function errAt(s) { const r = parse(s); assert.ok(r.error, "expected a parse error for: " + s); return r.error; }

test("SM-188: missing value → error with position + expected '<value>'", () => {
  const e = errAt("type =");
  assert.ok(/value/i.test(e.message));
  assert.strictEqual(typeof e.position, "number");
  assert.deepStrictEqual(e.expected, ["<value>"]);
});

test("SM-188: missing operator → error listing the operators, positioned at the bad token", () => {
  const e = errAt("type bug");
  assert.ok(/operator/i.test(e.message));
  assert.ok(e.expected.indexOf("IN") >= 0 && e.expected.indexOf("~") >= 0);
  assert.strictEqual(e.position, 5);   // index of "bug"
});

test("SM-188: unbalanced parenthesis → error expecting ')'", () => {
  const e = errAt("(type = bug");
  assert.deepStrictEqual(e.expected, [")"]);
});

test("SM-188: unterminated string → positioned error", () => {
  const e = errAt('text ~ "login');
  assert.ok(/unterminated/i.test(e.message));
  assert.strictEqual(e.position, 7);
});

test("SM-188: trailing garbage after a complete query → error", () => {
  assert.ok(/unexpected/i.test(errAt("type = bug status = ready").message));
});

test("SM-188: a leading keyword where a field is expected → error", () => {
  assert.ok(/field/i.test(errAt("AND type = bug").message));
});

test("SM-188: parseQuery never throws (errors are returned, not thrown)", () => {
  assert.doesNotThrow(() => parse("((("));
  assert.doesNotThrow(() => parse("§§§ %%%"));
  assert.ok(parse("§§§").error, "unexpected character is reported as an error");
});

test("SM-188: AND/OR are flat n-ary (a AND b AND c → one node, 3 children)", () => {
  const tree = ast("a = 1 AND b = 2 AND c = 3");
  assert.strictEqual(tree.op, "AND");
  assert.strictEqual(tree.children.length, 3);
  const or = ast("a = 1 OR b = 2 OR c = 3");
  assert.strictEqual(or.op, "OR");
  assert.strictEqual(or.children.length, 3);
});

test("SM-188: double negation nests (NOT NOT x)", () => {
  const tree = ast("NOT NOT type = bug");
  assert.strictEqual(tree.op, "NOT");
  assert.strictEqual(tree.child.op, "NOT");
  assert.strictEqual(tree.child.child.op, "CLAUSE");
});

test("SM-188: empty IN list and trailing comma are errors", () => {
  assert.ok(parse("status IN ()").error, "empty IN list must error");
  assert.ok(parse("status IN (a,)").error, "trailing comma must error");
});

test("SM-188: garbage after the ORDER BY direction is an error", () => {
  assert.ok(parse("type = bug ORDER BY created DESC nonsense").error);
});

test("SM-188: pathologically deep nesting returns an error, never throws", () => {
  const deep = "(".repeat(6000) + "type = bug" + ")".repeat(6000);
  let r;
  assert.doesNotThrow(() => { r = parse(deep); });
  assert.ok(r.error, "deep nesting collapses to a structured error");
});

test("SM-191: looksLikeQuery (field-aware) distinguishes plain search from field syntax", () => {
  const F = ["type", "status", "release", "acCount", "text", "epic", "label"];
  // real queries (known field + operator)
  assert.strictEqual(q.looksLikeQuery("status = ready", F), true);
  assert.strictEqual(q.looksLikeQuery("type != bug", F), true);
  assert.strictEqual(q.looksLikeQuery("acCount >= 2", F), true);
  assert.strictEqual(q.looksLikeQuery("text ~ login", F), true);
  assert.strictEqual(q.looksLikeQuery("status IN (ready, done)", F), true);
  assert.strictEqual(q.looksLikeQuery("type = epic AND status = ready", F), true);
  assert.strictEqual(q.looksLikeQuery("NOT type = bug", F), true);
  // plain searches must NOT be hijacked (review false-positives)
  assert.strictEqual(q.looksLikeQuery("login form", F), false);
  assert.strictEqual(q.looksLikeQuery("find in files", F), false);
  assert.strictEqual(q.looksLikeQuery("Search and replace", F), false);
  assert.strictEqual(q.looksLikeQuery("price < 100", F), false);   // 'price' is not a field
  assert.strictEqual(q.looksLikeQuery("type in production", F), false); // IN without '(' = not a query
  assert.strictEqual(q.looksLikeQuery("", F), false);
  // fallback (no field list): any word+operator counts
  assert.strictEqual(q.looksLikeQuery("status = ready"), true);
  assert.strictEqual(q.looksLikeQuery("login form"), false);
});

// --- tokenizer surface (reused by the autocomplete engine, SM-216) ----------

test("SM-188: tokenize exposes typed tokens with positions", () => {
  const toks = q.tokenize("type = bug");
  assert.deepStrictEqual(toks.map(t => t.type), ["word", "op", "word", "eof"]);
  assert.strictEqual(toks[1].value, "=");
  assert.strictEqual(toks[2].start, 7);
});

console.log(`\n  ${passed} passed, ${failed} failed`);
