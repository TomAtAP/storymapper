"use strict";

/**
 * SM-288 — shared/ticket-import.js: pure CSV/JSON parsing + import planning.
 *
 * Single source (SM-139 pattern): the SAME file backs the browser import
 * dialog (SM-289) and the MCP import_tickets tool (SM-290). No I/O, no DOM.
 * planTicketImport classifies each row as create / update / error with line
 * numbers; mode 'create-only' rejects known keys, 'upsert' patches them.
 */

const assert = require("assert");
const core = require("../shared/core.js");
const imp = require("../shared/ticket-import.js");

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  - ${name}`); passed++; }
  catch (err) { console.log(`  FAIL - ${name}\n         ${err.stack || err.message}`); failed++; process.exitCode = 1; }
}

const HUMAN = { type: "human", id: "u1", name: "U" };

/** Fixture: project P with release v1, step Discover, one epic + one story (contained). */
function fixture() {
  let snap = core.normalizeSnapshot({
    project: { id: "p1", name: "P", ticketPrefix: "P", ticketTypes: ["epic", "user-story", "bug", "task"] },
    releases: [{ id: "R1", name: "v1", sortOrder: 0 }, { id: "R2", name: "v2", sortOrder: 1 }],
    processSteps: [{ id: "PSA", name: "Discover", sortOrder: 0 }]
  });
  snap = core.ops.createTicket(snap, { type: "epic", title: "Epic One", position: { releaseId: "R1", processStepId: "PSA" } }, HUMAN);
  const epic = snap.tickets[snap.tickets.length - 1];
  // Auto-epic-assignment (E9b): a story created in a cell with exactly ONE
  // epic gets the contains-link automatically — no manual addLink needed.
  snap = core.ops.createTicket(snap, { type: "user-story", title: "Story One", position: { releaseId: "R1", processStepId: "PSA" } }, HUMAN);
  const story = snap.tickets[snap.tickets.length - 1];
  // A loose (uncontained, unplaced) ticket for position-patch tests — a
  // CONTAINED story's release/step follows its epic (SM-67, plan-time error).
  snap = core.ops.createTicket(snap, { type: "task", title: "Loose One" }, HUMAN);
  const loose = snap.tickets[snap.tickets.length - 1];
  return { snap: snap, epic: epic, story: story, loose: loose };
}

// ---- CSV parsing -------------------------------------------------------------

test("SM-288: parseTicketImport CSV — header row = field keys, data rows with 1-based file lines", () => {
  const r = imp.parseTicketImport("key,title,type\nP-9,Alpha,bug\n,Beta,task", "csv");
  assert.strictEqual(r.error, null);
  assert.strictEqual(r.rows.length, 2);
  assert.strictEqual(r.rows[0].line, 2, "first data row is file line 2 (header = 1)");
  assert.deepStrictEqual(r.rows[0].data, { key: "P-9", title: "Alpha", type: "bug" });
  assert.deepStrictEqual(r.rows[1].data, { key: "", title: "Beta", type: "task" });
});

test("SM-288: CSV parser is RFC-4180 tolerant (quotes, commas, embedded newlines) — SM-285 export reimports", () => {
  const csv = 'title,description\r\n"He said ""go, now""","line1\nline2"\r\nPlain,last';
  const r = imp.parseTicketImport(csv, "csv");
  assert.strictEqual(r.error, null);
  assert.strictEqual(r.rows.length, 2);
  assert.strictEqual(r.rows[0].data.title, 'He said "go, now"');
  assert.strictEqual(r.rows[0].data.description, "line1\nline2");
  assert.strictEqual(r.rows[1].data.title, "Plain");
  // line numbers advance past embedded newlines (row 1 spans file lines 2-3)
  assert.strictEqual(r.rows[1].line, 4);
});

test("SM-288: JSON parser accepts an array of ticket objects; auto-detect by leading bracket", () => {
  const r = imp.parseTicketImport('[{"title":"A","type":"bug"},{"title":"B"}]');
  assert.strictEqual(r.error, null);
  assert.strictEqual(r.rows.length, 2);
  assert.strictEqual(r.rows[0].line, 1, "JSON rows are 1-based array indices");
  assert.strictEqual(r.rows[0].data.title, "A");
});

test("SM-288: garbage input yields a structured error, never a throw", () => {
  assert.ok(imp.parseTicketImport("[not json", "json").error);
  assert.ok(imp.parseTicketImport('{"an":"object"}', "json").error, "JSON must be an ARRAY of tickets");
  assert.ok(imp.parseTicketImport("", "csv").error, "empty CSV (no header) is an error");
});

// ---- planTicketImport: creates -------------------------------------------------

test("SM-288: unknown keys plan as creates; refs resolve by NAME or ID; labels split", () => {
  const { snap, epic } = fixture();
  const rows = imp.parseTicketImport(
    "key,type,title,status,release,processStep,epic,labels\n" +
    ",bug,New Bug,backlog,v1,Discover," + epic.ticketKey + ',"frontend, ux"', "csv").rows;
  const plan = imp.planTicketImport(snap, rows, "create-only");
  assert.deepStrictEqual(plan.errors, []);
  assert.strictEqual(plan.updates.length, 0);
  assert.strictEqual(plan.creates.length, 1);
  const c = plan.creates[0];
  assert.strictEqual(c.line, 2);
  assert.strictEqual(c.ticket.type, "bug");
  assert.strictEqual(c.ticket.title, "New Bug");
  assert.strictEqual(c.ticket.position.releaseId, "R1", "release resolved by name");
  assert.strictEqual(c.ticket.position.processStepId, "PSA", "step resolved by name");
  assert.strictEqual(c.ticket.epicId, epic.id, "epic resolved by ticketKey");
  assert.deepStrictEqual(c.ticket.labels, ["frontend", "ux"]);
});

test("SM-288: create validation — title and type required, unknown values error with line + field", () => {
  const { snap } = fixture();
  const rows = imp.parseTicketImport(
    "title,type,status,release\n" +
    ",bug,backlog,v1\n" +            // no title
    "Ok Title,ghost-type,backlog,v1\n" +   // unknown type
    "Ok2,bug,warp-status,v1\n" +     // unknown status
    "Ok3,bug,backlog,v99", "csv").rows;   // unknown release
  const plan = imp.planTicketImport(snap, rows, "create-only");
  assert.strictEqual(plan.creates.length, 0);
  assert.strictEqual(plan.errors.length, 4);
  assert.deepStrictEqual(plan.errors.map(e => [e.line, e.field]),
    [[2, "title"], [3, "type"], [4, "status"], [5, "release"]]);
  plan.errors.forEach(e => assert.ok(e.message && e.message.length));
});

test("SM-288: mode create-only — a row with an EXISTING key is an error", () => {
  const { snap, story } = fixture();
  const rows = imp.parseTicketImport("key,title\n" + story.ticketKey + ",Renamed", "csv").rows;
  const plan = imp.planTicketImport(snap, rows, "create-only");
  assert.strictEqual(plan.creates.length + plan.updates.length, 0);
  assert.strictEqual(plan.errors.length, 1);
  assert.strictEqual(plan.errors[0].field, "key");
});

// ---- planTicketImport: upsert ---------------------------------------------------

test("SM-288: mode upsert — existing key patches ONLY the present columns", () => {
  const { snap, story } = fixture();
  const rows = imp.parseTicketImport(
    "key,title,status\n" + story.ticketKey + ",Renamed Story,ready", "csv").rows;
  const plan = imp.planTicketImport(snap, rows, "upsert");
  assert.deepStrictEqual(plan.errors, []);
  assert.strictEqual(plan.updates.length, 1);
  const u = plan.updates[0];
  assert.strictEqual(u.ticketId, story.id);
  assert.strictEqual(u.ticketKey, story.ticketKey);
  assert.deepStrictEqual(u.patch, { title: "Renamed Story", status: "ready" },
    "absent columns (description, release, …) stay untouched");
});

test("SM-288: upsert — empty CSV cells are ABSENT, not clears; unknown key becomes a create", () => {
  const { snap, story } = fixture();
  const rows = imp.parseTicketImport(
    "key,title,description,type\n" +
    story.ticketKey + ",,New Desc,\n" +      // empty title/type cells → untouched
    "P-999,Fresh One,,bug", "csv").rows;     // unknown key → create (key is server-minted)
  const plan = imp.planTicketImport(snap, rows, "upsert");
  assert.deepStrictEqual(plan.errors, []);
  assert.deepStrictEqual(plan.updates[0].patch, { description: "New Desc" });
  assert.strictEqual(plan.creates.length, 1);
  assert.strictEqual(plan.creates[0].ticket.title, "Fresh One");
});

test("SM-288: upsert — release/processStep CHANGES land as partial position patch, equal values diff out", () => {
  const { snap, story, loose } = fixture();
  // different release on a LOOSE ticket → patched
  let rows = imp.parseTicketImport("key,release\n" + loose.ticketKey + ",v2", "csv").rows;
  let plan = imp.planTicketImport(snap, rows, "upsert");
  assert.deepStrictEqual(plan.errors, []);
  assert.deepStrictEqual(plan.updates[0].patch, { position: { releaseId: "R2" } });
  // same release on the contained story → empty patch (diffed out, no SM-67 flag)
  rows = imp.parseTicketImport("key,release\n" + story.ticketKey + ",v1", "csv").rows;
  plan = imp.planTicketImport(snap, rows, "upsert");
  assert.deepStrictEqual(plan.errors, []);
  assert.deepStrictEqual(plan.updates[0].patch, {});
});

test("SM-288 (review): position CHANGE on a CONTAINED story errors at plan time (SM-67 inheritance)", () => {
  const { snap, story } = fixture();
  const rows = imp.parseTicketImport("key,release\n" + story.ticketKey + ",v2", "csv").rows;
  const plan = imp.planTicketImport(snap, rows, "upsert");
  assert.strictEqual(plan.updates.length, 0);
  assert.strictEqual(plan.errors.length, 1);
  assert.strictEqual(plan.errors[0].field, "release");
  assert.ok(/SM-67/.test(plan.errors[0].message));
});

test("SM-288 (review): a create row with type=epic AND an epic column errors (no epic-in-epic)", () => {
  const { snap, epic } = fixture();
  const rows = imp.parseTicketImport("title,type,epic\nNested,epic," + epic.ticketKey, "csv").rows;
  const plan = imp.planTicketImport(snap, rows, "create-only");
  assert.strictEqual(plan.creates.length, 0);
  assert.strictEqual(plan.errors.length, 1);
  assert.strictEqual(plan.errors[0].field, "epic");
});

test("SM-288: upsert — epic column equal to current containment is a no-op, a DIFFERENT epic errors", () => {
  const { snap, epic, story } = fixture();
  // equal → fine (CSV export roundtrip!)
  let rows = imp.parseTicketImport("key,title,epic\n" + story.ticketKey + ",Same," + epic.ticketKey, "csv").rows;
  let plan = imp.planTicketImport(snap, rows, "upsert");
  assert.deepStrictEqual(plan.errors, []);
  assert.deepStrictEqual(plan.updates[0].patch, { title: "Same" }, "matching epic ignored in the patch");
  // different → explicit error (reassignment via import not supported in v1)
  const snap2 = core.ops.createTicket(snap, { type: "epic", title: "Epic Two" }, HUMAN);
  const epic2 = snap2.tickets[snap2.tickets.length - 1];
  rows = imp.parseTicketImport("key,epic\n" + story.ticketKey + "," + epic2.ticketKey, "csv").rows;
  plan = imp.planTicketImport(snap2, rows, "upsert");
  assert.strictEqual(plan.updates.length, 0);
  assert.strictEqual(plan.errors.length, 1);
  assert.strictEqual(plan.errors[0].field, "epic");
});

test("SM-288: a row with ANY error contributes nothing else (atomic per row)", () => {
  const { snap } = fixture();
  const rows = imp.parseTicketImport(
    "title,type,release\nGood,bug,v1\nBad,bug,v99", "csv").rows;
  const plan = imp.planTicketImport(snap, rows, "create-only");
  assert.strictEqual(plan.creates.length, 1);
  assert.strictEqual(plan.errors.length, 1);
  assert.strictEqual(plan.errors[0].line, 3);
});

test("SM-288: server-managed columns (updated/created/acCount/linkedTo/…) are ignored silently", () => {
  const { snap } = fixture();
  const rows = imp.parseTicketImport(
    "title,type,updated,created,acCount,linkedTo\nX,bug,2026-01-01,2026-01-01,5,P-1", "csv").rows;
  const plan = imp.planTicketImport(snap, rows, "create-only");
  assert.deepStrictEqual(plan.errors, []);
  assert.strictEqual(plan.creates.length, 1);
  assert.ok(!("updated" in plan.creates[0].ticket) && !("acCount" in plan.creates[0].ticket));
});

test("SM-288: JSON rows work end-to-end (labels as array, refs by id)", () => {
  const { snap } = fixture();
  const rows = imp.parseTicketImport(JSON.stringify([
    { title: "From JSON", type: "task", release: "R1", processStep: "PSA", labels: ["a", "b"] }
  ])).rows;
  const plan = imp.planTicketImport(snap, rows, "create-only");
  assert.deepStrictEqual(plan.errors, []);
  const t = plan.creates[0].ticket;
  assert.deepStrictEqual(t.labels, ["a", "b"]);
  assert.strictEqual(t.position.releaseId, "R1");
});

test("SM-288: SM-285 export shape round-trips — INCL. the epic row with its derived status", () => {
  const { snap, epic, story } = fixture();
  const epicNow = snap.tickets.find(t => t.id === epic.id);   // roll-up may have derived a status
  // exactly the default export header (incl. server-managed `updated`); BOTH rows
  const csv = "key,type,title,status,release,processStep,epic,updated\n"
    + [epicNow.ticketKey, "epic", epicNow.title, epicNow.status, "v1", "Discover", "", "2026-07-03 10:00"].join(",") + "\n"
    + [story.ticketKey, story.type, story.title, story.status, "v1", "Discover", epic.ticketKey, "2026-07-03 10:00"].join(",");
  const plan = imp.planTicketImport(snap, imp.parseTicketImport(csv, "csv").rows, "upsert");
  assert.deepStrictEqual(plan.errors, [], "no errors on a straight re-import");
  assert.strictEqual(plan.creates.length, 0);
  assert.strictEqual(plan.updates.length, 2, "both rows land as updates");
  plan.updates.forEach(u => assert.deepStrictEqual(u.patch, {},
    "straight re-import diffs to EMPTY patches — incl. the epic's derived status (no EPIC_STATUS_DERIVED at apply)"));
});

test("SM-288 (review): a DIFFERENT status on an epic row errors at PLAN time (status is derived)", () => {
  const { snap, epic } = fixture();
  const epicNow = snap.tickets.find(t => t.id === epic.id);
  const other = epicNow.status === "done" ? "backlog" : "done";
  const rows = imp.parseTicketImport("key,status\n" + epicNow.ticketKey + "," + other, "csv").rows;
  const plan = imp.planTicketImport(snap, rows, "upsert");
  assert.strictEqual(plan.updates.length, 0);
  assert.strictEqual(plan.errors.length, 1);
  assert.strictEqual(plan.errors[0].field, "status");
});

test("SM-288 (review): type is canonicalized case-insensitively ('Bug' plans as 'bug')", () => {
  const { snap } = fixture();
  const plan = imp.planTicketImport(snap,
    imp.parseTicketImport("title,type\nCased,Bug", "csv").rows, "create-only");
  assert.deepStrictEqual(plan.errors, []);
  assert.strictEqual(plan.creates[0].ticket.type, "bug");
});

test("SM-288 (review): an unterminated quoted cell is a structured parse error, not silent mangling", () => {
  const r = imp.parseTicketImport('title,description\n"abc,def\nx,y', "csv");
  assert.ok(r.error && /unterminated/i.test(r.error));
  assert.deepStrictEqual(r.rows, []);
});

// ---- SM-296: header mapping ---------------------------------------------------

test("SM-296: built-in foreign aliases — a Jira-style export plans without manual mapping", () => {
  const { snap } = fixture();
  const csv = "Issue key,Summary,Issue Type,Status\n,Vom Jira-Export,bug,backlog";
  const parsed = imp.parseTicketImport(csv, "csv");
  assert.deepStrictEqual(parsed.headers.map(h => h.field), ["key", "title", "type", "status"],
    "Issue key→key, Summary→title, Issue Type→type, Status→status");
  const plan = imp.planTicketImport(snap, parsed.rows, "create-only");
  assert.deepStrictEqual(plan.errors, []);
  assert.strictEqual(plan.creates[0].ticket.title, "Vom Jira-Export");
  assert.strictEqual(plan.creates[0].ticket.type, "bug");
});

test("SM-296: opts.headerMapping maps arbitrary columns; explicit mapping beats built-ins", () => {
  const { snap } = fixture();
  // arbitrary foreign headers
  let parsed = imp.parseTicketImport("Col A,Col B\nHallo,bug", "csv",
    { headerMapping: { "col a": "title", "col b": "type" } });
  let plan = imp.planTicketImport(snap, parsed.rows, "create-only");
  assert.deepStrictEqual(plan.errors, []);
  assert.strictEqual(plan.creates[0].ticket.title, "Hallo");
  assert.strictEqual(plan.creates[0].ticket.type, "bug");
  // explicit mapping OVERRIDES: 'summary' → description (not the title alias),
  // 'title' → null (ignored) ⇒ title missing ⇒ row errors
  parsed = imp.parseTicketImport("title,summary,type\nIgnored,Real Desc,bug", "csv",
    { headerMapping: { "title": null, "summary": "description" } });
  assert.deepStrictEqual(parsed.headers.map(h => h.field), [null, "description", "type"]);
  plan = imp.planTicketImport(snap, parsed.rows, "create-only");
  assert.strictEqual(plan.creates.length, 0);
  assert.strictEqual(plan.errors[0].field, "title", "ignored title column → title required error");
});

test("SM-296: headers meta lists every CSV column with its resolved field (null = unused)", () => {
  const parsed = imp.parseTicketImport("key,Story Points,title\nP-9,5,X", "csv");
  assert.deepStrictEqual(parsed.headers, [
    { raw: "key", field: "key" },
    { raw: "Story Points", field: null },
    { raw: "title", field: "title" },
  ]);
  // JSON imports carry no header row
  assert.deepStrictEqual(imp.parseTicketImport('[{"title":"A"}]').headers, []);
});

test("SM-296: a mapping onto an unknown target field is ignored (null), not a crash", () => {
  const parsed = imp.parseTicketImport("Col A\nX", "csv", { headerMapping: { "col a": "ghostfield" } });
  assert.deepStrictEqual(parsed.headers, [{ raw: "Col A", field: null }]);
});

test("SM-296 (review): mapping KEYS are normalized — exact-case CSV headers work and beat the heuristic", () => {
  // caller copies the exact header casing from the CSV
  let parsed = imp.parseTicketImport("Custom Col\nX", "csv", { headerMapping: { "Custom Col": "title" } });
  assert.deepStrictEqual(parsed.headers, [{ raw: "Custom Col", field: "title" }]);
  // an exact-case override must WIN against the FOREIGN_ALIASES heuristic
  parsed = imp.parseTicketImport("Summary\nX", "csv", { headerMapping: { "Summary": "description" } });
  assert.deepStrictEqual(parsed.headers, [{ raw: "Summary", field: "description" }]);
});

test("SM-296 (review): a header named 'constructor' resolves via own-properties only (null, no junk)", () => {
  const parsed = imp.parseTicketImport("constructor,title\nX,Ok", "csv");
  assert.deepStrictEqual(parsed.headers[0], { raw: "constructor", field: null });
  assert.deepStrictEqual(parsed.rows[0].data, { title: "Ok" }, "no prototype-chain junk in the row data");
});

// ---- SM-297: value mapping ------------------------------------------------------

test("SM-297: opts.valueMapping maps foreign status/type values; explicit beats direct resolution", () => {
  const { snap } = fixture();
  const rows = imp.parseTicketImport(
    "title,type,status\nJira Row,Technische Story,IN TESTING", "csv").rows;
  const plan = imp.planTicketImport(snap, rows, "create-only", {
    valueMapping: { type: { "technische story": "user-story" }, status: { "in testing": "review" } }
  });
  assert.deepStrictEqual(plan.errors, []);
  assert.strictEqual(plan.creates[0].ticket.type, "user-story");
  assert.strictEqual(plan.creates[0].ticket.status, "review");
  // explicit mapping OVERRIDES a directly-resolvable value
  const plan2 = imp.planTicketImport(snap, imp.parseTicketImport("title,type,status\nX,bug,done", "csv").rows,
    "create-only", { valueMapping: { status: { "done": "backlog" } } });
  assert.strictEqual(plan2.creates[0].ticket.status, "backlog");
});

test("SM-297: valueMapping null = drop the field (status survives, required type still errors)", () => {
  const { snap } = fixture();
  let plan = imp.planTicketImport(snap,
    imp.parseTicketImport("title,type,status\nOk,bug,Resolved Weird", "csv").rows,
    "create-only", { valueMapping: { status: { "resolved weird": null } } });
  assert.deepStrictEqual(plan.errors, []);
  assert.ok(!("status" in plan.creates[0].ticket), "ignored status → absent (backlog default at apply)");
  plan = imp.planTicketImport(snap,
    imp.parseTicketImport("title,type\nOk,Improvement", "csv").rows,
    "create-only", { valueMapping: { type: { "improvement": null } } });
  assert.strictEqual(plan.errors.length, 1);
  assert.strictEqual(plan.errors[0].field, "type", "ignoring the required type leaves the row invalid — visibly");
});

test("SM-297: built-in value heuristic (Open→backlog, Resolved→done, Story→user-story) — only when the target exists", () => {
  const { snap } = fixture();
  const plan = imp.planTicketImport(snap,
    imp.parseTicketImport("title,type,status\nA,Story,Open\nB,bug,Resolved", "csv").rows, "create-only");
  assert.deepStrictEqual(plan.errors, []);
  assert.strictEqual(plan.creates[0].ticket.type, "user-story");
  assert.strictEqual(plan.creates[0].ticket.status, "backlog");
  assert.strictEqual(plan.creates[1].ticket.status, "done");
  // heuristic target missing in the project → stays unknown
  const noUserStory = core.normalizeSnapshot({
    project: { id: "p2", name: "P2", ticketPrefix: "Q", ticketTypes: ["epic", "bug"] },
    releases: [{ id: "R1", name: "v1", sortOrder: 0 }], processSteps: []
  });
  const plan2 = imp.planTicketImport(noUserStory,
    imp.parseTicketImport("title,type\nX,Story", "csv").rows, "create-only");
  assert.strictEqual(plan2.errors.length, 1);
  assert.strictEqual(plan2.errors[0].field, "type");
});

test("SM-297: plan.unknownValues collects DISTINCT unresolved values (original casing); errors carry value", () => {
  const { snap } = fixture();
  const plan = imp.planTicketImport(snap, imp.parseTicketImport(
    "title,type,status\nA,Improvement,IN TESTING\nB,Improvement,IN TESTING\nC,Epos,Warp", "csv").rows,
    "create-only");
  assert.deepStrictEqual(plan.unknownValues.type, ["Improvement", "Epos"]);
  assert.deepStrictEqual(plan.unknownValues.status, ["IN TESTING", "Warp"]);
  const err = plan.errors.find(e => e.line === 2 && e.field === "status");
  assert.strictEqual(err.value, "IN TESTING", "error carries the offending raw value");
});

test("SM-297 (review): a STALE mapping target self-heals — source lands in unknownValues, error names the TARGET", () => {
  const { snap } = fixture();
  const plan = imp.planTicketImport(snap,
    imp.parseTicketImport("title,type,release\nX,bug,Sprint 1", "csv").rows,
    "create-only", { valueMapping: { release: { "sprint 1": "v99-renamed-away" } } });
  assert.strictEqual(plan.errors.length, 1);
  assert.ok(/mapping target not found: "v99-renamed-away"/.test(plan.errors[0].message),
    "error names the missing TARGET, not just the (known, mapped) source");
  assert.deepStrictEqual(plan.unknownValues.release, ["Sprint 1"],
    "source value re-listed so the dialog panel reappears (self-healing)");
});

test("SM-288: engine is pure — planning does not mutate the snapshot", () => {
  const { snap, story } = fixture();
  const before = JSON.stringify(snap);
  const rows = imp.parseTicketImport("key,title\n" + story.ticketKey + ",Changed", "csv").rows;
  imp.planTicketImport(snap, rows, "upsert");
  assert.strictEqual(JSON.stringify(snap), before);
});

console.log(`\n  ${passed} passed, ${failed} failed`);
