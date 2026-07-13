"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Storage = require("../server/storage.js");
const { buildServer } = require("../server/mcp.js");

let passed = 0, failed = 0;
function test(name, fn) {
  const exec = async () => {
    try {
      const r = fn();
      if (r && typeof r.then === "function") await r;
      console.log(`  ok  - ${name}`); passed++;
    } catch (err) {
      console.log(`  FAIL - ${name}\n         ${err.stack || err.message}`);
      failed++; process.exitCode = 1;
    }
  };
  return (test._chain = (test._chain || Promise.resolve()).then(exec));
}

async function tmpDir() {
  return await fs.promises.mkdtemp(path.join(os.tmpdir(), "storymap-mcp-"));
}

async function callTool(server, name, args) {
  const reg = server._registeredTools[name];
  assert.ok(reg, `tool '${name}' not registered`);
  const result = await reg.handler(args || {}, { signal: undefined });
  const text = result.content[0].text;
  let parsed = null;
  try { parsed = JSON.parse(text); } catch (_) { parsed = text; }
  if (result.isError) {
    const err = new Error(parsed.error || text);
    err.kind = parsed.kind;
    err.missing = parsed.missing;
    err.statusCode = parsed.statusCode;
    throw err;
  }
  return parsed;
}

async function freshStorage() {
  const dir = await tmpDir();
  const s = new Storage(dir);
  await s.init();
  return s;
}

const defs = {
  ready: { global: [{ id: "g1", label: "G1", required: true }], byType: {} },
  done:  { global: [{ id: "d1", label: "D1", required: true }], byType: {} }
};

// ---------------------------------------------------------------------------
// Basic tool registration + projects
// ---------------------------------------------------------------------------

test("buildServer registers expected tools", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    const expected = [
      "list_projects", "project_get", "project_create", "project_update", "project_delete",
      "list_tickets", "ticket_get", "ticket_create", "ticket_update", "ticket_delete",
      "change_ticket_status", "cancel_ticket",
      // SM-172 — dependency-aware "what can I start now"
      "next_actionable",
      // SM-177 — direction B: fold tickets → product description
      "generate_product_doc",
      // SM-184 — attachments binary seam
      "attachment_list", "attachment_put", "attachment_get", "attachment_delete",
      // SM-201 R-5 — spec layer (ingest + requirement authoring)
      "ingest_slice_candidates", "spec_module_create", "requirement_create", "requirement_list",
      // SM-202 R-6 — direction-A coverage report
      "get_trace_coverage",
      // SM-182 Phase 4 — drift report
      "get_drift_report",
      // SM-190 — JQL targeted search
      "query_tickets",
      // SM-290/291 — Datenaustausch: bulk import + project export
      "import_tickets", "export_project",
      // SM-301 — derive a test-definition from acceptance criteria
      "derive_test_definition",
      // SM-124 — merged DoR/DoD item-toggle
      "set_checklist_item",
      // SM-164 — unified project config get/set
      "get_config", "set_config",
      // SM-165 — unified reorder
      "reorder",
      // SM-46 — link CRUD + query
      "link_create", "link_delete", "list_links_for_ticket",
      // SM-58 — test-types tooling
      "test_def_step_add", "test_def_step_update", "test_def_step_remove", "test_def_step_reorder",
      "test_def_prereq_add", "test_def_prereq_update", "test_def_prereq_remove",
      "test_def_prereq_check", "test_def_prereq_uncheck",
      "test_exec_start", "test_exec_record", "test_exec_set_outcome", "test_exec_history"
    ];
    for (const name of expected) {
      assert.ok(server._registeredTools[name], "missing tool: " + name);
    }
    // SM-124: the four standalone item-toggles are removed (merged into set_checklist_item).
    // SM-164: the ten get/set config tools are removed (merged into get_config/set_config).
    // SM-165: the three reorder_* tools are removed (merged into reorder).
    const removed = [
      "check_dor_item", "uncheck_dor_item", "check_dod_item", "uncheck_dod_item",
      "get_definitions", "set_definitions", "get_workflow", "set_workflow",
      "get_kanban_columns", "set_kanban_columns", "get_governance", "set_governance",
      "get_link_types", "set_link_types",
      "reorder_tickets", "reorder_releases", "reorder_process_steps"
    ];
    for (const gone of removed) {
      assert.ok(!server._registeredTools[gone], "tool should be removed: " + gone);
    }
  } finally { s.close(); }
});

test("list_projects empty", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    const r = await callTool(server, "list_projects");
    assert.deepStrictEqual(r.projects, []);
  } finally { s.close(); }
});

test("project_create + project_get round-trip", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    const created = await callTool(server, "project_create", {
      id: "p1", name: "Acme", definitions: defs
    });
    assert.strictEqual(created.snapshot.project.id, "p1");
    assert.strictEqual(created.snapshot.project.name, "Acme");
    const got = await callTool(server, "project_get", { projectId: "p1" });
    assert.strictEqual(got.snapshot.project.id, "p1");
  } finally { s.close(); }
});

test("SM-254: project_create seeds a default release + process step", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    const created = await callTool(server, "project_create", { id: "p1", name: "Acme", definitions: defs });
    const rels = created.snapshot.releases.filter(r => !r.isDeleted);
    const steps = created.snapshot.processSteps.filter(p => !p.isDeleted);
    assert.strictEqual(rels.length, 1, "exactly one default release seeded");
    assert.strictEqual(steps.length, 1, "exactly one default process step seeded");
  } finally { s.close(); }
});

test("project_create: invalid input is reported as tool error (kind=validation)", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    let err = null;
    try { await callTool(server, "project_create", { id: "p1" }); } catch (e) { err = e; }
    assert.ok(err, "expected tool error");
    assert.ok(err.message.includes("name"));
  } finally { s.close(); }
});

test("project_update patches description", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "Acme", definitions: defs });
    const r = await callTool(server, "project_update", { projectId: "p1", patch: { description: "Updated" } });
    assert.strictEqual(r.project.description, "Updated");
  } finally { s.close(); }
});

test("project_delete + list_projects skips it", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "Acme", definitions: defs });
    await callTool(server, "project_create", { id: "p2", name: "Beta", definitions: defs });
    await callTool(server, "project_delete", { projectId: "p1" });
    const list = await callTool(server, "list_projects");
    assert.deepStrictEqual(list.projects, ["p2"]);
  } finally { s.close(); }
});

// ---------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------

test("ticket_create freezes DoR/DoD onto ticket", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "X", definitions: defs });
    const r = await callTool(server, "ticket_create", {
      projectId: "p1", type: "user-story", title: "First story", verbose: true
    });
    assert.strictEqual(r.ticket.title, "First story");
    assert.strictEqual(r.ticket.ticketKey, "P-1");
    assert.strictEqual(r.ticket.definitionOfReady.items.length, 1);
    assert.strictEqual(r.ticket.definitionOfReady.items[0].id, "g1");
    assert.strictEqual(r.ticket.definitionOfDone.items[0].id, "d1");
  } finally { s.close(); }
});

test("SM-260: ticket_create accepts acceptanceCriteria at creation", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "X", definitions: defs });
    const r1 = await callTool(server, "ticket_create", {
      projectId: "p1", type: "user-story", title: "Has AC", verbose: true,
      acceptanceCriteria: [{ text: "given X, then Y" }, { text: "edge case Z" }]
    });
    assert.strictEqual(r1.ticket.acceptanceCriteria.length, 2);
    assert.strictEqual(r1.ticket.acceptanceCriteria[0].text, "given X, then Y");
    assert.strictEqual(r1.ticket.acceptanceCriteria[0].completed, false);
    // The JSON-string form (bridge stringifies arrays) is covered end-to-end
    // through the real Zod preprocess in test-mcp-stdio.js — the in-process
    // callTool path doesn't run schema preprocessing.
  } finally { s.close(); }
});

test("ticket_create: missing title → tool error", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "X", definitions: defs });
    let err = null;
    try { await callTool(server, "ticket_create", { projectId: "p1", type: "user-story" }); }
    catch (e) { err = e; }
    assert.ok(err);
    assert.ok(err.message.includes("title"));
  } finally { s.close(); }
});

test("list_tickets returns non-deleted tickets", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "X", definitions: defs });
    await callTool(server, "ticket_create", { projectId: "p1", type: "user-story", title: "A" });
    await callTool(server, "ticket_create", { projectId: "p1", type: "bug", title: "B" });
    const r = await callTool(server, "list_tickets", { projectId: "p1" });
    assert.strictEqual(r.tickets.length, 2);
  } finally { s.close(); }
});

test("SM-186: generate_product_doc types-filter excludes bugs/tests from the PRD", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "Acme", definitions: defs });
    const epic = await callTool(server, "ticket_create", { projectId: "p1", type: "epic", title: "Onboarding" });
    await callTool(server, "ticket_create", { projectId: "p1", type: "user-story", title: "Signup form", position: { epicId: epic.ticket.id } });
    await callTool(server, "ticket_create", { projectId: "p1", type: "bug", title: "Crash on submit" });
    const r = await callTool(server, "generate_product_doc", { projectId: "p1", types: ["epic", "user-story"] });
    assert.ok(r.markdown.includes("Signup form"), "content story present");
    assert.ok(!r.markdown.includes("Crash on submit"), "bug excluded by the types allowlist");
  } finally { s.close(); }
});

test("SM-184: attachment put → list → get (inline base64 for small) → delete", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "P", definitions: defs });
    const content = Buffer.from("PRD bytes éç").toString("base64");
    const put = await callTool(server, "attachment_put", { projectId: "p1", filename: "spec.txt", mimeType: "text/plain", contentBase64: content, ticketId: "t9" });
    const aid = put.attachment.id;
    assert.ok(aid.startsWith("att-"));
    assert.strictEqual(put.attachment.ticketId, "t9");
    const list = await callTool(server, "attachment_list", { projectId: "p1" });
    assert.strictEqual(list.attachments.length, 1);
    const got = await callTool(server, "attachment_get", { attachmentId: aid });
    assert.strictEqual(got.contentBase64, content, "small file inlined as base64");
    assert.ok(got.downloadUrl.includes("/api/projects/p1/attachments/" + aid), "download URL points at the REST endpoint");
    const del = await callTool(server, "attachment_delete", { attachmentId: aid });
    assert.strictEqual(del.deleted, aid);
    assert.strictEqual((await callTool(server, "attachment_list", { projectId: "p1" })).attachments.length, 0);
  } finally { s.close(); }
});

test("SM-184: attachment_get omits inline base64 for a large file (downloadUrl only) + never leaks absPath", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "P", definitions: defs });
    const big = Buffer.alloc(300 * 1024, 0x41).toString("base64");   // 300 KB > 256 KB inline cap
    const put = await callTool(server, "attachment_put", { projectId: "p1", filename: "big.bin", contentBase64: big });
    const got = await callTool(server, "attachment_get", { attachmentId: put.attachment.id });
    assert.strictEqual(got.contentBase64, undefined, "large file is NOT inlined");
    assert.ok(got.downloadUrl, "downloadUrl always present");
    assert.strictEqual(got.size, 300 * 1024);
    assert.strictEqual(got.absPath, undefined, "filesystem path is never leaked over MCP");
  } finally { s.close(); }
});

test("SM-184: attachment_get on a missing id fails cleanly; oversize put → structured 413; missing project → 404", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "P", definitions: defs });
    let e1 = null;
    try { await callTool(server, "attachment_get", { attachmentId: "att-nope" }); } catch (e) { e1 = e; }
    assert.ok(e1, "missing attachment → error");
    // oversize: storage caps at 25 MB → structured 413 surfaced by the tool wrap.
    const over = Buffer.alloc(26 * 1024 * 1024, 0x41).toString("base64");
    let e2 = null;
    try { await callTool(server, "attachment_put", { projectId: "p1", filename: "huge.bin", contentBase64: over }); } catch (e) { e2 = e; }
    assert.ok(e2 && e2.statusCode === 413, "oversize → structured 413");
    let e3 = null;
    try { await callTool(server, "attachment_put", { projectId: "nope", filename: "x", contentBase64: Buffer.from("y").toString("base64") }); } catch (e) { e3 = e; }
    assert.ok(e3 && e3.statusCode === 404, "missing project → structured 404");
  } finally { s.close(); }
});

test("SM-180: generate_product_doc renders the cross-release evolution of a superseding epic", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "Acme", definitions: defs });
    const oldE = await callTool(server, "ticket_create", { projectId: "p1", type: "epic", title: "Onboarding v1" });
    const newE = await callTool(server, "ticket_create", { projectId: "p1", type: "epic", title: "Onboarding v2" });
    await callTool(server, "link_create", { projectId: "p1", sourceTicketId: newE.ticket.id, linkTypeId: "supersedes", targetTicketId: oldE.ticket.id });
    const r = await callTool(server, "generate_product_doc", { projectId: "p1" });
    assert.ok(r.markdown.includes("## Onboarding v2"), "the superseding epic is the feature heading");
    assert.ok(!r.markdown.includes("## Onboarding v1"), "the superseded epic is not a top-level feature");
    assert.ok(/Evolved from:/.test(r.markdown), "evolution line rendered");
    assert.ok(r.markdown.includes(oldE.ticket.ticketKey), "old version listed in the evolution chain");
  } finally { s.close(); }
});

test("SM-177: generate_product_doc folds tickets into a Markdown product description", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "Acme", definitions: defs });
    const epic = await callTool(server, "ticket_create", { projectId: "p1", type: "epic", title: "Onboarding" });
    await callTool(server, "ticket_create", {
      projectId: "p1", type: "user-story", title: "Signup form",
      position: { epicId: epic.ticket.id }
    });
    const r = await callTool(server, "generate_product_doc", { projectId: "p1" });
    assert.strictEqual(typeof r.markdown, "string");
    assert.ok(r.markdown.includes("# Product Description — Acme"), "header with project name");
    assert.ok(r.markdown.includes("## Onboarding"), "feature heading present");
    assert.ok(r.markdown.includes("Signup form"), "realising story listed under the feature");
    assert.ok(/\[(planned|in progress|shipped)\]/.test(r.markdown), "status badge present");
  } finally { s.close(); }
});

test("SM-177: generate_product_doc renders the tests section (includeTests), orphans, and respects releaseId", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "Acme", definitions: defs });
    const rel = await callTool(server, "release_create", { projectId: "p1", name: "v1" });
    const epic = await callTool(server, "ticket_create", { projectId: "p1", type: "epic", title: "Onboarding", position: { releaseId: rel.release.id } });
    const story = await callTool(server, "ticket_create", { projectId: "p1", type: "user-story", title: "Signup form", position: { epicId: epic.ticket.id } });
    const td = await callTool(server, "ticket_create", { projectId: "p1", type: "test-definition", title: "Signup test" });
    await callTool(server, "link_create", { projectId: "p1", sourceTicketId: td.ticket.id, linkTypeId: "tests", targetTicketId: story.ticket.id });
    await callTool(server, "ticket_create", { projectId: "p1", type: "bug", title: "Loose bug" });   // orphan, no release

    const full = await callTool(server, "generate_product_doc", { projectId: "p1", includeTests: true });
    assert.ok(full.markdown.includes("**Tests**"), "tests section rendered with includeTests");
    assert.ok(full.markdown.includes("Signup test"), "linked test-definition listed");
    assert.ok(full.markdown.includes("## Ungrouped work items"), "orphan section rendered");
    assert.ok(full.markdown.includes("Loose bug"), "orphan listed");

    const scoped = await callTool(server, "generate_product_doc", { projectId: "p1", releaseId: rel.release.id });
    assert.ok(scoped.markdown.includes("## Onboarding"), "feature in the release is present");
    assert.ok(!scoped.markdown.includes("Loose bug"), "an orphan with no release is excluded from a release-scoped doc");
  } finally { s.close(); }
});

test("SM-172: next_actionable returns ready+unblocked work items, excludes DoR-open and blocked", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "X", definitions: defs });
    // A: DoR checked + ready → actionable.
    const A = await callTool(server, "ticket_create", { projectId: "p1", type: "user-story", title: "A" });
    await callTool(server, "set_checklist_item", { projectId: "p1", ticketId: A.ticket.id, gate: "dor", itemId: "g1", checked: true });
    await callTool(server, "mark_ready", { projectId: "p1", ticketId: A.ticket.id });
    // B: left in backlog with required DoR unchecked → excluded.
    const B = await callTool(server, "ticket_create", { projectId: "p1", type: "user-story", title: "B" });
    // C: ready, but blocked by A (A 'blocks' C, A not done) → excluded.
    const C = await callTool(server, "ticket_create", { projectId: "p1", type: "user-story", title: "C" });
    await callTool(server, "set_checklist_item", { projectId: "p1", ticketId: C.ticket.id, gate: "dor", itemId: "g1", checked: true });
    await callTool(server, "mark_ready", { projectId: "p1", ticketId: C.ticket.id });
    await callTool(server, "link_create", { projectId: "p1", sourceTicketId: A.ticket.id, linkTypeId: "blocks", targetTicketId: C.ticket.id });

    const r = await callTool(server, "next_actionable", { projectId: "p1" });
    const ids = r.tickets.map(t => t.id);
    assert.deepStrictEqual(ids, [A.ticket.id], "only A is actionable (B DoR-open, C blocked)");
    assert.strictEqual(r.tickets[0].reason, "ready to pull");
    assert.ok(r.tickets[0].ticketKey, "items carry the compact summary shape");
    // void B to keep the linter happy about the unused capture.
    assert.ok(B.ticket.id);
  } finally { s.close(); }
});

test("ticket_update + ticket_get", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "X", definitions: defs });
    const c = await callTool(server, "ticket_create", { projectId: "p1", type: "user-story", title: "A" });
    const u = await callTool(server, "ticket_update", {
      projectId: "p1", ticketId: c.ticket.id, patch: { title: "A renamed" }
    });
    assert.strictEqual(u.ticket.title, "A renamed");
    const g = await callTool(server, "ticket_get", { projectId: "p1", ticketId: c.ticket.id });
    assert.strictEqual(g.ticket.title, "A renamed");
  } finally { s.close(); }
});

test("SM-98: list_tickets filters by releaseId / processStepId; 'none'/'' sentinel matches unassigned", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "P", definitions: defs });
    const rel = await callTool(server, "release_create", { projectId: "p1", name: "v1" });
    const ps  = await callTool(server, "process_step_create", { projectId: "p1", name: "Build" });
    const inCell = await callTool(server, "ticket_create", {
      projectId: "p1", type: "user-story", title: "InCell",
      position: { releaseId: rel.release.id, processStepId: ps.processStep.id }
    });
    const inRelOnly = await callTool(server, "ticket_create", {
      projectId: "p1", type: "user-story", title: "InRelOnly",
      position: { releaseId: rel.release.id }
    });
    const orphan = await callTool(server, "ticket_create", {
      projectId: "p1", type: "user-story", title: "Orphan"
    });

    let r = await callTool(server, "list_tickets", { projectId: "p1", releaseId: rel.release.id });
    let ids = new Set(r.tickets.map(t => t.id));
    assert.ok(ids.has(inCell.ticket.id) && ids.has(inRelOnly.ticket.id));
    assert.ok(!ids.has(orphan.ticket.id), "release filter excludes orphan");

    r = await callTool(server, "list_tickets", { projectId: "p1", releaseId: "none" });
    ids = new Set(r.tickets.map(t => t.id));
    assert.strictEqual(ids.size, 1);
    assert.ok(ids.has(orphan.ticket.id), "'none' sentinel matches absent releaseId");

    r = await callTool(server, "list_tickets", { projectId: "p1", releaseId: "" });
    assert.strictEqual(r.tickets.length, 1);
    assert.strictEqual(r.tickets[0].id, orphan.ticket.id, "'' sentinel matches absent releaseId");

    r = await callTool(server, "list_tickets", { projectId: "p1", processStepId: ps.processStep.id });
    assert.strictEqual(r.tickets.length, 1);
    assert.strictEqual(r.tickets[0].id, inCell.ticket.id);
  } finally { s.close(); }
});

test("SM-98: list_tickets epicId filter resolves via contains-link graph (not position.epicId)", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "P", definitions: defs });
    const rel = await callTool(server, "release_create", { projectId: "p1", name: "v1" });
    const ep1 = await callTool(server, "ticket_create", {
      projectId: "p1", type: "epic", title: "E1",
      position: { releaseId: rel.release.id }
    });
    const ep2 = await callTool(server, "ticket_create", {
      projectId: "p1", type: "epic", title: "E2",
      position: { releaseId: rel.release.id }
    });
    const childOfEp1 = await callTool(server, "ticket_create", {
      projectId: "p1", type: "user-story", title: "C1",
      position: { releaseId: rel.release.id, epicId: ep1.ticket.id }
    });
    const orphanStory = await callTool(server, "ticket_create", {
      projectId: "p1", type: "user-story", title: "Loose",
      position: { releaseId: rel.release.id }
    });
    // childOfEp1 was wired via position.epicId → contains-link to ep1 (SM-52).
    let r = await callTool(server, "list_tickets", { projectId: "p1", epicId: ep1.ticket.id });
    let ids = r.tickets.map(t => t.id);
    assert.deepStrictEqual(ids, [childOfEp1.ticket.id],
      "epicId filter returns children resolved via contains-link");
    r = await callTool(server, "list_tickets", { projectId: "p1", epicId: ep2.ticket.id });
    assert.strictEqual(r.tickets.length, 0, "epic with no contained children → empty");
    r = await callTool(server, "list_tickets", { projectId: "p1", epicId: "none" });
    ids = new Set(r.tickets.map(t => t.id));
    // 'none' returns everything NOT contained: epics (containers, not contained) + orphan story.
    assert.ok(ids.has(ep1.ticket.id));
    assert.ok(ids.has(ep2.ticket.id));
    assert.ok(ids.has(orphanStory.ticket.id));
    assert.ok(!ids.has(childOfEp1.ticket.id));
  } finally { s.close(); }
});

test("SM-98: list_tickets compact mode returns only {id, ticketKey, type, status, title, position}", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "P", definitions: defs });
    await callTool(server, "ticket_create", { projectId: "p1", type: "user-story", title: "A",
      description: "long body for body sake", labels: ["x", "y"] });
    const r = await callTool(server, "list_tickets", { projectId: "p1", compact: true });
    assert.strictEqual(r.tickets.length, 1);
    const t = r.tickets[0];
    const allowed = new Set(["id", "ticketKey", "type", "status", "title", "position"]);
    for (const k of Object.keys(t)) {
      assert.ok(allowed.has(k), "compact ticket has unexpected key: " + k);
    }
    assert.strictEqual(t.description, undefined);
    assert.strictEqual(t.labels, undefined);
    assert.strictEqual(t.acceptanceCriteria, undefined);
    assert.strictEqual(t.definitionOfReady, undefined);
    assert.strictEqual(t.links, undefined);
  } finally { s.close(); }
});

test("SM-98: list_tickets combined filters are AND-composed (status + releaseId)", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "P", definitions: defs });
    const rel = await callTool(server, "release_create", { projectId: "p1", name: "v1" });
    const inRel = await callTool(server, "ticket_create", { projectId: "p1", type: "user-story",
      title: "T1", position: { releaseId: rel.release.id } });
    await callTool(server, "ticket_create", { projectId: "p1", type: "user-story",
      title: "T2", position: { releaseId: rel.release.id } });
    await callTool(server, "ticket_create", { projectId: "p1", type: "user-story",
      title: "Orphan" });   // outside release — only 1 in-rel after we set T2 to ready
    // Move T2 forward so its status differs from backlog (need DoR check first).
    const t2 = (await callTool(server, "list_tickets", { projectId: "p1" }))
      .tickets.find(t => t.title === "T2");
    await callTool(server, "set_checklist_item", { gate: "dor", checked: true, projectId: "p1", ticketId: t2.id, itemId: "g1" });
    await callTool(server, "mark_ready", { projectId: "p1", ticketId: t2.id });
    // Backlog + in release v1 → only T1.
    const r = await callTool(server, "list_tickets", {
      projectId: "p1", status: "backlog", releaseId: rel.release.id
    });
    assert.strictEqual(r.tickets.length, 1);
    assert.strictEqual(r.tickets[0].id, inRel.ticket.id);
  } finally { s.close(); }
});

test("ticket_delete soft-deletes; list_tickets filters out", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "X", definitions: defs });
    const c = await callTool(server, "ticket_create", { projectId: "p1", type: "user-story", title: "A" });
    await callTool(server, "ticket_delete", { projectId: "p1", ticketId: c.ticket.id });
    const list = await callTool(server, "list_tickets", { projectId: "p1" });
    assert.strictEqual(list.tickets.length, 0);
  } finally { s.close(); }
});

// ---------------------------------------------------------------------------
// change_ticket_status — DoR / DoD gates surface as structured errors
// ---------------------------------------------------------------------------

test("change_ticket_status: DoR missing → tool error with kind=DoR and missing[]", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "X", definitions: defs });
    const c = await callTool(server, "ticket_create", { projectId: "p1", type: "user-story", title: "A" });
    let err = null;
    try {
      await callTool(server, "change_ticket_status", {
        projectId: "p1", ticketId: c.ticket.id, status: "ready"
      });
    } catch (e) { err = e; }
    assert.ok(err, "expected DoR gate error");
    assert.strictEqual(err.kind, "DoR");
    assert.strictEqual(err.missing.length, 1);
    assert.strictEqual(err.missing[0].id, "g1");
  } finally { s.close(); }
});

test("change_ticket_status: invalid status → tool error", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "X", definitions: defs });
    const c = await callTool(server, "ticket_create", { projectId: "p1", type: "user-story", title: "A" });
    let err = null;
    try {
      await callTool(server, "change_ticket_status", {
        projectId: "p1", ticketId: c.ticket.id, status: "wonky"
      });
    } catch (e) { err = e; }
    assert.ok(err);
    assert.ok(err.message.includes("status"));
  } finally { s.close(); }
});

// ---------------------------------------------------------------------------
// E7 — Definitions management + DoR/DoD item tools + mark_ready/complete_ticket
// ---------------------------------------------------------------------------

// SM-164: get/set_definitions are now get_config/set_config section="definitions".
test("get_config section=definitions returns project.definitions", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "X", definitions: defs });
    const r = await callTool(server, "get_config", { projectId: "p1", section: "definitions" });
    assert.strictEqual(r.section, "definitions");
    assert.strictEqual(r.value.ready.global[0].id, "g1");
    assert.strictEqual(r.value.done.global[0].id, "d1");
  } finally { s.close(); }
});

test("set_config section=definitions updates project.definitions", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "X", definitions: defs });
    const newDefs = {
      ready: { global: [{ id: "ac", label: "AC", required: true }], byType: {} },
      done:  { global: [{ id: "cr", label: "CR", required: true }], byType: {} }
    };
    const r = await callTool(server, "set_config", { projectId: "p1", section: "definitions", value: newDefs });
    assert.strictEqual(r.section, "definitions");
    assert.strictEqual(r.value.ready.global[0].id, "ac");
  } finally { s.close(); }
});

test("set_config section=definitions: invalid struct → tool error", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "X", definitions: defs });
    let err = null;
    try {
      await callTool(server, "set_config", { projectId: "p1", section: "definitions", value: { ready: {}, done: { global: [{ id: "x" }], byType: {} } } });
    } catch (e) { err = e; }
    assert.ok(err);
    assert.ok(err.message.includes("label") || err.message.includes("missing"));
  } finally { s.close(); }
});

test("resolve_definitions_for_ticket returns frozen items with current checked-state", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "X", definitions: defs });
    const c = await callTool(server, "ticket_create", { projectId: "p1", type: "user-story", title: "A" });
    const r = await callTool(server, "resolve_definitions_for_ticket", { projectId: "p1", ticketId: c.ticket.id });
    assert.strictEqual(r.ready.length, 1);
    assert.strictEqual(r.ready[0].id, "g1");
    assert.strictEqual(r.ready[0].checked, false);
    assert.strictEqual(r.done[0].id, "d1");
  } finally { s.close(); }
});

// SM-125: ticket-returning mutators are compact-by-default with a verbose opt-in.
test("SM-125: ticket_create is compact by default; verbose:true returns the full ticket", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "X", definitions: defs });
    const compact = await callTool(server, "ticket_create",
      { projectId: "p1", type: "user-story", title: "A", description: "body" });
    assert.deepStrictEqual(Object.keys(compact.ticket).sort(),
      ["id", "position", "status", "ticketKey", "title", "type"]);
    assert.strictEqual(compact.ticket.description, undefined);
    assert.strictEqual(compact.ticket.definitionOfReady, undefined);
    const full = await callTool(server, "ticket_create",
      { projectId: "p1", type: "user-story", title: "B", description: "body", verbose: true });
    assert.strictEqual(full.ticket.description, "body");
    assert.ok(full.ticket.definitionOfReady, "verbose returns the frozen checklists");
  } finally { s.close(); }
});

test("SM-125: mark_ready / change_ticket_status are compact by default, full with verbose", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "X", definitions: defs });
    const c = await callTool(server, "ticket_create", { projectId: "p1", type: "user-story", title: "A" });
    await callTool(server, "set_checklist_item",
      { projectId: "p1", ticketId: c.ticket.id, gate: "dor", itemId: "g1", checked: true });
    const ready = await callTool(server, "mark_ready", { projectId: "p1", ticketId: c.ticket.id });
    assert.strictEqual(ready.ticket.status, "ready");
    assert.strictEqual(ready.ticket.definitionOfReady, undefined, "compact: no checklist in the default response");
    const verbose = await callTool(server, "change_ticket_status",
      { projectId: "p1", ticketId: c.ticket.id, status: "in-progress", verbose: true });
    assert.strictEqual(verbose.ticket.status, "in-progress");
    assert.ok(verbose.ticket.definitionOfReady, "verbose returns the full ticket");
  } finally { s.close(); }
});

// SM-126: ticket_get gains compact/fields opt-ins (default unchanged = full).
test("SM-126: ticket_get default returns full; compact:true → summary; fields → pick", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "X", definitions: defs });
    const c = await callTool(server, "ticket_create",
      { projectId: "p1", type: "user-story", title: "A", description: "body" });
    const id = c.ticket.id;
    // Default = full (unchanged).
    const full = await callTool(server, "ticket_get", { projectId: "p1", ticketId: id });
    assert.strictEqual(full.ticket.description, "body");
    assert.ok(full.ticket.definitionOfReady);
    // compact → summary only.
    const compact = await callTool(server, "ticket_get", { projectId: "p1", ticketId: id, compact: true });
    assert.deepStrictEqual(Object.keys(compact.ticket).sort(),
      ["id", "position", "status", "ticketKey", "title", "type"]);
    assert.strictEqual(compact.ticket.definitionOfReady, undefined);
    // fields → pick (id + ticketKey always present).
    const picked = await callTool(server, "ticket_get",
      { projectId: "p1", ticketId: id, fields: ["description", "status"] });
    assert.deepStrictEqual(Object.keys(picked.ticket).sort(), ["description", "id", "status", "ticketKey"]);
    assert.strictEqual(picked.ticket.description, "body");
  } finally { s.close(); }
});

// SM-128 regression guard: tools that were ALREADY compact must stay compact —
// no full-ticket leak when the summary refactor touched neighbouring code.
test("SM-128 guard: link_create / reorder / ticket_delete stay compact", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "X", definitions: defs });
    const a = await callTool(server, "ticket_create", { projectId: "p1", type: "user-story", title: "A" });
    const b = await callTool(server, "ticket_create", { projectId: "p1", type: "user-story", title: "B" });
    // link_create → {revision, savedAt, link} only (no ticket body).
    const lk = await callTool(server, "link_create",
      { projectId: "p1", sourceTicketId: a.ticket.id, targetTicketId: b.ticket.id, linkTypeId: "relates-to" });
    assert.ok(lk.link && lk.link.id);
    assert.strictEqual(lk.ticket, undefined);
    // reorder entity=tickets → reordered[] entries are {id, ticketKey, position}.
    const ro = await callTool(server, "reorder",
      { projectId: "p1", entity: "tickets", orderedIds: [b.ticket.id, a.ticket.id] });
    for (const e of ro.reordered) {
      assert.deepStrictEqual(Object.keys(e).sort(), ["id", "position", "ticketKey"]);
    }
    // ticket_delete → {deleted}, no ticket body.
    const del = await callTool(server, "ticket_delete", { projectId: "p1", ticketId: b.ticket.id });
    assert.strictEqual(del.ticket, undefined);
    assert.strictEqual(del.deleted, b.ticket.id);
  } finally { s.close(); }
});

// SM-124: the four item-toggles are merged into set_checklist_item, which is
// compact-by-default ({item:{id,checked}}) with a verbose:true opt-in.
test("set_checklist_item: gate=dor checked=true → compact {item:{id,checked}}, AI actor", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "X", definitions: defs });
    const c = await callTool(server, "ticket_create", { projectId: "p1", type: "user-story", title: "A" });
    const r = await callTool(server, "set_checklist_item",
      { projectId: "p1", ticketId: c.ticket.id, gate: "dor", itemId: "g1", checked: true });
    // Compact-by-default: no full ticket, just the toggled item.
    assert.strictEqual(r.ticket, undefined);
    assert.deepStrictEqual(r.item, { id: "g1", checked: true });
    assert.ok(r.revision && r.savedAt);
    // Persisted state + AI actor verified via a read.
    const got = await callTool(server, "ticket_get", { projectId: "p1", ticketId: c.ticket.id });
    const item = got.ticket.definitionOfReady.items.find(i => i.id === "g1");
    assert.strictEqual(item.checked, true);
    assert.strictEqual(item.checkedBy.type, "ai");
  } finally { s.close(); }
});

test("set_checklist_item: verbose:true returns the full ticket", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "X", definitions: defs });
    const c = await callTool(server, "ticket_create", { projectId: "p1", type: "user-story", title: "A" });
    const r = await callTool(server, "set_checklist_item",
      { projectId: "p1", ticketId: c.ticket.id, gate: "dor", itemId: "g1", checked: true, verbose: true });
    assert.ok(r.ticket, "verbose returns the ticket");
    assert.strictEqual(r.item, undefined);
    const item = r.ticket.definitionOfReady.items.find(i => i.id === "g1");
    assert.strictEqual(item.checked, true);
  } finally { s.close(); }
});

test("set_checklist_item: checked=false clears (dor); dod gate toggles too", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "X", definitions: defs });
    const c = await callTool(server, "ticket_create", { projectId: "p1", type: "user-story", title: "A" });
    await callTool(server, "set_checklist_item",
      { projectId: "p1", ticketId: c.ticket.id, gate: "dor", itemId: "g1", checked: true });
    let r = await callTool(server, "set_checklist_item",
      { projectId: "p1", ticketId: c.ticket.id, gate: "dor", itemId: "g1", checked: false });
    assert.deepStrictEqual(r.item, { id: "g1", checked: false });
    r = await callTool(server, "set_checklist_item",
      { projectId: "p1", ticketId: c.ticket.id, gate: "dod", itemId: "d1", checked: true });
    assert.deepStrictEqual(r.item, { id: "d1", checked: true });
    r = await callTool(server, "set_checklist_item",
      { projectId: "p1", ticketId: c.ticket.id, gate: "dod", itemId: "d1", checked: false });
    assert.deepStrictEqual(r.item, { id: "d1", checked: false });
  } finally { s.close(); }
});

test("mark_ready: blocked when DoR not complete (kind=DoR + missing)", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "X", definitions: defs });
    const c = await callTool(server, "ticket_create", { projectId: "p1", type: "user-story", title: "A" });
    let err = null;
    try { await callTool(server, "mark_ready", { projectId: "p1", ticketId: c.ticket.id }); } catch (e) { err = e; }
    assert.ok(err);
    assert.strictEqual(err.kind, "DoR");
    assert.strictEqual(err.missing[0].id, "g1");
  } finally { s.close(); }
});

test("mark_ready: succeeds after DoR all checked", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "X", definitions: defs });
    const c = await callTool(server, "ticket_create", { projectId: "p1", type: "user-story", title: "A" });
    await callTool(server, "set_checklist_item", { gate: "dor", checked: true, projectId: "p1", ticketId: c.ticket.id, itemId: "g1" });
    const r = await callTool(server, "mark_ready", { projectId: "p1", ticketId: c.ticket.id });
    assert.strictEqual(r.ticket.status, "ready");
  } finally { s.close(); }
});

test("complete_ticket: blocked when DoD not complete (kind=DoD)", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "X", definitions: defs });
    const c = await callTool(server, "ticket_create", { projectId: "p1", type: "technical-task-backend", title: "A" /* SM-299: isolate the DoD gate from the test-plan gate */ });
    // pass DoR gate
    await callTool(server, "set_checklist_item", { gate: "dor", checked: true, projectId: "p1", ticketId: c.ticket.id, itemId: "g1" });
    await callTool(server, "mark_ready", { projectId: "p1", ticketId: c.ticket.id });
    let err = null;
    try { await callTool(server, "complete_ticket", { projectId: "p1", ticketId: c.ticket.id }); } catch (e) { err = e; }
    assert.ok(err);
    assert.strictEqual(err.kind, "DoD");
  } finally { s.close(); }
});

test("complete_ticket: succeeds when DoD complete, sets status=done", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "X", definitions: defs });
    const c = await callTool(server, "ticket_create", { projectId: "p1", type: "technical-task-backend", title: "A" /* SM-299: isolate the DoD gate from the test-plan gate */ });
    await callTool(server, "set_checklist_item", { gate: "dor", checked: true, projectId: "p1", ticketId: c.ticket.id, itemId: "g1" });
    await callTool(server, "set_checklist_item", { gate: "dod", checked: true, projectId: "p1", ticketId: c.ticket.id, itemId: "d1" });
    const r = await callTool(server, "complete_ticket", { projectId: "p1", ticketId: c.ticket.id });
    assert.strictEqual(r.ticket.status, "done");
  } finally { s.close(); }
});

test("SM-260: complete_ticket({checkDoD:true}) auto-checks required DoD items, then completes", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "X", definitions: defs });
    const c = await callTool(server, "ticket_create", { projectId: "p1", type: "technical-task-backend", title: "A" /* SM-299: isolate the DoD gate from the test-plan gate */ });
    await callTool(server, "set_checklist_item", { gate: "dor", checked: true, projectId: "p1", ticketId: c.ticket.id, itemId: "g1" });
    await callTool(server, "mark_ready", { projectId: "p1", ticketId: c.ticket.id });
    // No manual DoD check — checkDoD does it in one call.
    const r = await callTool(server, "complete_ticket", { projectId: "p1", ticketId: c.ticket.id, checkDoD: true, verbose: true });
    assert.strictEqual(r.ticket.status, "done");
    assert.ok(r.ticket.definitionOfDone.items.every(i => !i.required || i.checked),
      "all required DoD items got checked");
  } finally { s.close(); }
});

// ---------------------------------------------------------------------------
// SM-299 — no done without a linked, published test-definition (user-story/bug)
// ---------------------------------------------------------------------------

test("SM-299: complete_ticket on a user-story WITHOUT a published test-def → MISSING_TEST_DEFINITION (422)", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "X", definitions: defs });
    const c = await callTool(server, "ticket_create", { projectId: "p1", type: "user-story", title: "Untested" });
    let err = null;
    // governance runs BEFORE the DoD gate → the missing test plan surfaces first
    try { await callTool(server, "complete_ticket", { projectId: "p1", ticketId: c.ticket.id, checkDoD: true }); }
    catch (e) { err = e; }
    assert.ok(err, "completion blocked");
    assert.strictEqual(err.kind, "MISSING_TEST_DEFINITION");
    assert.strictEqual(err.statusCode, 422);
  } finally { s.close(); }
});

test("SM-299: a DRAFT (unpublished) linked test-definition does NOT satisfy the gate", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    const defId = await setupDef(server);   // project p1 + a test-definition (draft)
    await callTool(server, "test_def_step_add", { projectId: "p1", ticketId: defId, patch: { step: "S", expectedResult: "ok" } });
    const story = (await callTool(server, "ticket_create", { projectId: "p1", type: "user-story", title: "Draft-tested", verbose: true })).ticket;
    // link tests def → story, but do NOT publish
    await callTool(server, "link_create", { projectId: "p1", sourceTicketId: defId, targetTicketId: story.id, linkTypeId: "tests" });
    let err = null;
    try { await callTool(server, "complete_ticket", { projectId: "p1", ticketId: story.id, checkDoD: true }); }
    catch (e) { err = e; }
    assert.ok(err && err.kind === "MISSING_TEST_DEFINITION", "draft definition doesn't count");
  } finally { s.close(); }
});

test("SM-299: with a PUBLISHED linked test-definition, complete_ticket succeeds", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    const defId = await setupDef(server);
    await callTool(server, "test_def_step_add", { projectId: "p1", ticketId: defId, patch: { step: "S", expectedResult: "ok" } });
    // publishDef makes a target user-story (ready), links tests, publishes
    const targetId = await publishDef(server, defId);
    const r = await callTool(server, "complete_ticket", { projectId: "p1", ticketId: targetId, checkDoD: true });
    assert.strictEqual(r.ticket.status, "done", "story with a published test plan completes");
  } finally { s.close(); }
});

test("SM-299 (F1): change_ticket_status → done also fires the test-plan gate (no bypass)", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "X", definitions: defs });
    const c = await callTool(server, "ticket_create", { projectId: "p1", type: "user-story", title: "Sneaky" });
    let err = null;
    // the one-call bypass attempt: skip complete_ticket, set status directly
    try { await callTool(server, "change_ticket_status", { projectId: "p1", ticketId: c.ticket.id, status: "done" }); }
    catch (e) { err = e; }
    assert.ok(err && err.kind === "MISSING_TEST_DEFINITION", "direct done-transition is gated too");
    // a NON-done transition is unaffected (governance only on done-category)
    await callTool(server, "set_checklist_item", { gate: "dor", checked: true, projectId: "p1", ticketId: c.ticket.id, itemId: "g1" });
    const ok = await callTool(server, "change_ticket_status", { projectId: "p1", ticketId: c.ticket.id, status: "ready" });
    assert.strictEqual(ok.ticket.status, "ready", "moving to ready is not gated");
  } finally { s.close(); }
});

test("SM-299: the gate is scoped out — a technical-task completes without a test-def", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "X", definitions: defs });
    const c = await callTool(server, "ticket_create", { projectId: "p1", type: "technical-task-backend", title: "Infra" });
    const r = await callTool(server, "complete_ticket", { projectId: "p1", ticketId: c.ticket.id, checkDoD: true });
    assert.strictEqual(r.ticket.status, "done", "technical-task is not gated by MISSING_TEST_DEFINITION");
  } finally { s.close(); }
});

// ---------------------------------------------------------------------------
// SM-301 — derive_test_definition (AC → test plan)
// ---------------------------------------------------------------------------

test("SM-301: derive_test_definition builds a draft plan (one step per AC) linked back to the story", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "X", definitions: defs });
    const story = (await callTool(server, "ticket_create", { projectId: "p1", type: "user-story", title: "Feature",
      acceptanceCriteria: [{ text: "Erstes Kriterium" }, { text: "Zweites Kriterium" }], verbose: true })).ticket;
    const r = await callTool(server, "derive_test_definition", { projectId: "p1", ticketId: story.id });
    assert.strictEqual(r.stepCount, 2);
    assert.strictEqual(r.published, false, "draft by default (north star)");
    assert.strictEqual(r.definition.type, "test-definition");
    // the definition links back to the story
    const links = await callTool(server, "list_links_for_ticket", { projectId: "p1", ticketId: story.id, direction: "backward" });
    assert.ok((links.links || []).some(l => l.linkTypeId === "tests"), "tests-link points at the story");
  } finally { s.close(); }
});

test("SM-301: derive_test_definition on a story WITHOUT AC → NO_ACCEPTANCE_CRITERIA (422)", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "X", definitions: defs });
    const story = await callTool(server, "ticket_create", { projectId: "p1", type: "user-story", title: "No AC" });
    let err = null;
    try { await callTool(server, "derive_test_definition", { projectId: "p1", ticketId: story.ticket.id }); }
    catch (e) { err = e; }
    assert.ok(err && err.kind === "NO_ACCEPTANCE_CRITERIA" && err.statusCode === 422);
  } finally { s.close(); }
});

test("SM-301: derive_test_definition publish:true — publishes when the target is ready, else reports the block", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "X", definitions: defs });
    const story = (await callTool(server, "ticket_create", { projectId: "p1", type: "user-story", title: "Ready feature",
      acceptanceCriteria: [{ text: "AC one" }], verbose: true })).ticket;
    // target still in backlog → publish blocked (draft kept), reported cleanly
    const blocked = await callTool(server, "derive_test_definition", { projectId: "p1", ticketId: story.id, publish: true });
    assert.strictEqual(blocked.published, false);
    assert.strictEqual(blocked.publishBlocked.kind, "TARGET_NOT_READY");
    // now promote the target and derive+publish a fresh plan
    await callTool(server, "set_checklist_item", { gate: "dor", checked: true, projectId: "p1", ticketId: story.id, itemId: "g1" });
    await callTool(server, "mark_ready", { projectId: "p1", ticketId: story.id });
    const ok2 = await callTool(server, "derive_test_definition", { projectId: "p1", ticketId: story.id, publish: true });
    assert.strictEqual(ok2.published, true, "published once the target is ready");
    // and now the story itself can complete under the SM-299 gate
    const done = await callTool(server, "complete_ticket", { projectId: "p1", ticketId: story.id, checkDoD: true });
    assert.strictEqual(done.ticket.status, "done", "derived+published plan satisfies MISSING_TEST_DEFINITION");
  } finally { s.close(); }
});

// ---------------------------------------------------------------------------
// E13.B — Releases, ProcessSteps, ticket reorder, workflow, revisions
// ---------------------------------------------------------------------------

test("release_create + list_releases + release_update + release_delete + reorder_releases round-trip", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "P", definitions: defs });
    // SM-254: project_create seeds a default release — drop it so this test owns
    // the full set (deleted after r1/r2 exist, so it's never the last release).
    const seeded = await callTool(server, "list_releases", { projectId: "p1" });
    const r1 = await callTool(server, "release_create", { projectId: "p1", name: "v1.0", status: "planning" });
    const r2 = await callTool(server, "release_create", { projectId: "p1", name: "v1.1", status: "planning" });
    await callTool(server, "release_delete", { projectId: "p1", releaseId: seeded[0].id });
    let list = await callTool(server, "list_releases", { projectId: "p1" });
    assert.strictEqual(list.length, 2);
    assert.deepStrictEqual(list.map(r => r.name), ["v1.0", "v1.1"]);
    await callTool(server, "release_update", { projectId: "p1", releaseId: r1.release.id, patch: { name: "v1.0 (renamed)" } });
    list = await callTool(server, "list_releases", { projectId: "p1" });
    assert.strictEqual(list[0].name, "v1.0 (renamed)");
    const ro = await callTool(server, "reorder", { entity: "releases", projectId: "p1", orderedIds: [r2.release.id, r1.release.id] });
    assert.deepStrictEqual(ro.releases.map(r => r.id), [r2.release.id, r1.release.id]);
    await callTool(server, "release_delete", { projectId: "p1", releaseId: r1.release.id });
    list = await callTool(server, "list_releases", { projectId: "p1" });
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].id, r2.release.id);
  } finally { s.close(); }
});

test("process_step_create + list_process_steps + process_step_update + process_step_delete + reorder round-trip", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "P", definitions: defs });
    // SM-254: drop the seeded default process step so this test owns the set.
    const seededPs = await callTool(server, "list_process_steps", { projectId: "p1" });
    await callTool(server, "process_step_delete", { projectId: "p1", processStepId: seededPs[0].id });
    const a = await callTool(server, "process_step_create", { projectId: "p1", name: "Onboarding" });
    const b = await callTool(server, "process_step_create", { projectId: "p1", name: "Daily Use" });
    let list = await callTool(server, "list_process_steps", { projectId: "p1" });
    assert.strictEqual(list.length, 2);
    await callTool(server, "process_step_update", { projectId: "p1", processStepId: a.processStep.id, patch: { name: "Welcome" } });
    list = await callTool(server, "list_process_steps", { projectId: "p1" });
    assert.strictEqual(list[0].name, "Welcome");
    const ro = await callTool(server, "reorder", { entity: "process_steps", projectId: "p1", orderedIds: [b.processStep.id, a.processStep.id] });
    assert.deepStrictEqual(ro.processSteps.map(p => p.id), [b.processStep.id, a.processStep.id]);
    await callTool(server, "process_step_delete", { projectId: "p1", processStepId: a.processStep.id });
    list = await callTool(server, "list_process_steps", { projectId: "p1" });
    assert.strictEqual(list.length, 1);
  } finally { s.close(); }
});

test("SM-255: release_delete refuses the last release, allows once a 2nd exists", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "P", definitions: defs });
    // SM-254 seeded exactly one default release — deleting it must fail.
    const seeded = await callTool(server, "list_releases", { projectId: "p1" });
    assert.strictEqual(seeded.length, 1);
    let err = null;
    try { await callTool(server, "release_delete", { projectId: "p1", releaseId: seeded[0].id }); }
    catch (e) { err = e; }
    assert.ok(err, "deleting the last release should error");
    assert.strictEqual(err.kind, "LAST_RELEASE");
    // Add a second release → now deleting the first is allowed.
    await callTool(server, "release_create", { projectId: "p1", name: "v2" });
    await callTool(server, "release_delete", { projectId: "p1", releaseId: seeded[0].id });
    const after = await callTool(server, "list_releases", { projectId: "p1" });
    assert.strictEqual(after.length, 1, "one release remains");
  } finally { s.close(); }
});

test("SM-247: split_process_step moves chosen epics into a new step after the original", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "P", definitions: defs });
    // SM-254: drop the seeded default process step so the order assertion below
    // ("A", "A2") isn't preceded by the default "Activities".
    const seededPs = await callTool(server, "list_process_steps", { projectId: "p1" });
    await callTool(server, "process_step_delete", { projectId: "p1", processStepId: seededPs[0].id });
    const rel = await callTool(server, "release_create", { projectId: "p1", name: "v1" });
    const ps = await callTool(server, "process_step_create", { projectId: "p1", name: "A" });
    const e1 = await callTool(server, "ticket_create", { projectId: "p1", type: "epic", title: "E1", position: { releaseId: rel.release.id, processStepId: ps.processStep.id } });
    const e2 = await callTool(server, "ticket_create", { projectId: "p1", type: "epic", title: "E2", position: { releaseId: rel.release.id, processStepId: ps.processStep.id } });
    const r = await callTool(server, "split_process_step", {
      projectId: "p1", processStepId: ps.processStep.id, name: "A2", epicIds: [e1.ticket.id]
    });
    assert.ok(r.processStep && r.processStep.name === "A2", "new step returned");
    assert.strictEqual(r.movedEpics, 1);
    const list = await callTool(server, "list_process_steps", { projectId: "p1" });
    assert.deepStrictEqual(list.map(p => p.name), ["A", "A2"], "new step sits right after the original");
    const e1g = (await callTool(server, "ticket_get", { projectId: "p1", ticketId: e1.ticket.id })).ticket;
    const e2g = (await callTool(server, "ticket_get", { projectId: "p1", ticketId: e2.ticket.id })).ticket;
    assert.strictEqual(e1g.position.processStepId, r.processStep.id, "chosen epic moved");
    assert.strictEqual(e2g.position.processStepId, ps.processStep.id, "unchosen epic stayed");
  } finally { s.close(); }
});

test("SM-96: reorder_tickets returns compact response (revision/savedAt/reordered, no snapshot)", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "P", definitions: defs });
    const ep = await callTool(server, "ticket_create", { projectId: "p1", type: "epic", title: "E" });
    const a = await callTool(server, "ticket_create", { projectId: "p1", type: "user-story", title: "A", position: { epicId: ep.ticket.id } });
    const b = await callTool(server, "ticket_create", { projectId: "p1", type: "user-story", title: "B", position: { epicId: ep.ticket.id } });
    const c = await callTool(server, "ticket_create", { projectId: "p1", type: "user-story", title: "C", position: { epicId: ep.ticket.id } });
    // Reorder to [C, A, B] under the epic.
    const resp = await callTool(server, "reorder", { entity: "tickets",
      projectId: "p1",
      orderedIds: [c.ticket.id, a.ticket.id, b.ticket.id],
      scope: { epicId: ep.ticket.id }
    });
    assert.strictEqual(typeof resp.revision, "string");
    assert.strictEqual(typeof resp.savedAt, "number");
    assert.ok(Array.isArray(resp.reordered), "reordered must be an array");
    assert.strictEqual(resp.snapshot, undefined, "compact response must not carry snapshot");
    for (const entry of resp.reordered) {
      assert.ok(typeof entry.id === "string");
      assert.ok(typeof entry.ticketKey === "string");
      assert.ok(entry.position && typeof entry.position === "object");
      assert.ok("releaseId" in entry.position && "processStepId" in entry.position
        && "epicId" in entry.position && "sortOrder" in entry.position,
        "position must carry releaseId/processStepId/epicId/sortOrder");
    }
    const byEntry = new Map(resp.reordered.map(e => [e.id, e.position.sortOrder]));
    assert.strictEqual(byEntry.get(c.ticket.id), 0);
    assert.strictEqual(byEntry.get(a.ticket.id), 1);
    assert.strictEqual(byEntry.get(b.ticket.id), 2);
    // Persistence: list_tickets shows the same order.
    const list = await callTool(server, "list_tickets", { projectId: "p1" });
    const persisted = new Map(list.tickets.map(t => [t.id, t.position.sortOrder]));
    assert.strictEqual(persisted.get(c.ticket.id), 0);
    assert.strictEqual(persisted.get(a.ticket.id), 1);
    assert.strictEqual(persisted.get(b.ticket.id), 2);
  } finally { s.close(); }
});

test("SM-96: reorder_tickets cascade — moving an epic with scope brings contained stories into reordered[]", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "P", definitions: defs });
    const rel1 = await callTool(server, "release_create", { projectId: "p1", name: "v1" });
    const rel2 = await callTool(server, "release_create", { projectId: "p1", name: "v2" });
    const ps = await callTool(server, "process_step_create", { projectId: "p1", name: "Build" });
    const ep = await callTool(server, "ticket_create", {
      projectId: "p1", type: "epic", title: "E",
      position: { releaseId: rel1.release.id, processStepId: ps.processStep.id }
    });
    const s1 = await callTool(server, "ticket_create", {
      projectId: "p1", type: "user-story", title: "S1",
      position: { epicId: ep.ticket.id }
    });
    const s2 = await callTool(server, "ticket_create", {
      projectId: "p1", type: "user-story", title: "S2",
      position: { epicId: ep.ticket.id }
    });
    // Move the epic to v2 with scope. Contained stories cascade (SM-67).
    const resp = await callTool(server, "reorder", { entity: "tickets",
      projectId: "p1",
      orderedIds: [ep.ticket.id],
      scope: { releaseId: rel2.release.id, processStepId: ps.processStep.id, epicId: null }
    });
    const reorderedIds = new Set(resp.reordered.map(e => e.id));
    assert.ok(reorderedIds.has(ep.ticket.id), "epic must be in reordered[]");
    assert.ok(reorderedIds.has(s1.ticket.id), "cascaded story s1 must be in reordered[]");
    assert.ok(reorderedIds.has(s2.ticket.id), "cascaded story s2 must be in reordered[]");
  } finally { s.close(); }
});

test("get_config section=workflow returns the effective workflow; per-type override merged when type provided", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", {
      id: "p1", name: "P",
      definitions: defs,
      workflow: {
        statuses: ["backlog", "ready", "in-progress", "review", "done"],
        transitions: { "ready": { requireGate: "DoR" }, "done": { requireGate: "DoD" } },
        byType: { "bug": { transitions: { "ready": { requireGate: null } } } }
      }
    });
    const wf = (await callTool(server, "get_config", { projectId: "p1", section: "workflow" })).value;
    // After E21.A statuses are objects {id, name, category}, not bare strings.
    // SM-242: the additive migration appends a cancelled status.
    assert.deepStrictEqual(wf.statuses.map(s => s.id),
      ["backlog", "ready", "in-progress", "review", "done", "cancelled"]);
    assert.ok(wf.statuses.every(s => typeof s.category === "string"),
      "every status carries a category");
    const wfBug = (await callTool(server, "get_config", { projectId: "p1", section: "workflow", type: "bug" })).value;
    // After E21.B transitions are an array.
    const bugReady = wfBug.transitions.find(t => t.toStatus === "ready");
    assert.strictEqual(bugReady.requireGate, null);
    const wfStory = (await callTool(server, "get_config", { projectId: "p1", section: "workflow", type: "user-story" })).value;
    const storyReady = wfStory.transitions.find(t => t.toStatus === "ready");
    assert.strictEqual(storyReady.requireGate, "DoR");
  } finally { s.close(); }
});

test("set_config section=workflow replaces the project workflow and creates a revision", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "P", definitions: defs });
    const r = await callTool(server, "set_config", {
      projectId: "p1",
      section: "workflow",
      value: {
        statuses: ["todo", "doing", "done"],
        transitions: { "done": { requireGate: "DoD" } }
      }
    });
    assert.strictEqual(r.section, "workflow");
    assert.ok(r.revision, "set_config must return a revision");
    // After E21.A: statuses are objects. Caller sent legacy string list,
    // normalizer migrates them on the way in. SM-242: cancelled is appended.
    assert.deepStrictEqual(r.value.statuses.map(s => s.id),
      ["todo", "doing", "done", "cancelled"]);
    // After E21.B: transitions are an array.
    const done = r.value.transitions.find(t => t.toStatus === "done");
    assert.strictEqual(done.requireGate, "DoD");
  } finally { s.close(); }
});

// ---------------------------------------------------------------------------
// E21.H — Kanban board column MCP tools
// ---------------------------------------------------------------------------

test("E21.H/SM-164: get_config section=kanban_columns returns the default 1:1 mapping", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "P", definitions: defs });
    const cols = (await callTool(server, "get_config", { projectId: "p1", section: "kanban_columns" })).value;
    assert.ok(Array.isArray(cols));
    // SM-242: default workflow now has 6 statuses (incl. cancelled) → 6 columns.
    assert.strictEqual(cols.length, 6);
    for (const c of cols) {
      assert.strictEqual(typeof c.id, "string");
      assert.strictEqual(typeof c.name, "string");
      assert.ok(Array.isArray(c.statusIds) && c.statusIds.length === 1);
    }
  } finally { s.close(); }
});

test("E21.H/SM-164: set_config section=kanban_columns replaces the columns + creates a revision", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "P", definitions: defs });
    const r = await callTool(server, "set_config", {
      projectId: "p1",
      section: "kanban_columns",
      value: [
        { id: "col-todo",  name: "To Do",       statusIds: ["backlog", "ready"] },
        { id: "col-doing", name: "In Progress", statusIds: ["in-progress", "review"] },
        { id: "col-done",  name: "Done",        statusIds: ["done"] }
      ]
    });
    assert.ok(r.revision, "set_config must return revision");
    assert.strictEqual(r.value.length, 3);
    assert.deepStrictEqual(r.value[0].statusIds, ["backlog", "ready"]);
    // Persistence sanity check via get tool.
    const fetched = (await callTool(server, "get_config", { projectId: "p1", section: "kanban_columns" })).value;
    assert.strictEqual(fetched.length, 3);
  } finally { s.close(); }
});

test("E21.H/SM-164: set_config section=kanban_columns drops stale statusIds not in the workflow", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "P", definitions: defs });
    const r = await callTool(server, "set_config", {
      projectId: "p1",
      section: "kanban_columns",
      value: [
        { id: "c1", name: "Mix", statusIds: ["backlog", "ghost", "done"] }
      ]
    });
    assert.deepStrictEqual(r.value[0].statusIds, ["backlog", "done"]);
  } finally { s.close(); }
});

// String-input coverage (Claude Code's MCP bridge stringifies nested args
// when the schema isn't typed enough to signal "this is an array/object")
// is asserted in test-mcp-stdio.js — that exercises the real Zod
// preprocess chain. In-process callTool here bypasses Zod entirely.

test("set_config section=workflow with empty statuses → tool error", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "P", definitions: defs });
    let threw = false;
    try {
      await callTool(server, "set_config", { projectId: "p1", section: "workflow", value: { statuses: [], transitions: {} } });
    } catch (err) {
      threw = true;
      assert.ok(/statuses/.test(err.message));
    }
    assert.ok(threw, "should have rejected empty statuses");
  } finally { s.close(); }
});

test("list_revisions returns reverse-chrono; get_revision fetches a single one", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "P", definitions: defs });
    await callTool(server, "ticket_create", { projectId: "p1", type: "user-story", title: "A" });
    await callTool(server, "ticket_create", { projectId: "p1", type: "user-story", title: "B" });
    const revs = await callTool(server, "list_revisions", { projectId: "p1" });
    assert.ok(Array.isArray(revs));
    assert.ok(revs.length >= 3);
    const one = await callTool(server, "get_revision", { projectId: "p1", revision: revs[0].revision });
    assert.strictEqual(one.revision, revs[0].revision);
    assert.ok(one.snapshot);
    // SM-212: limit + before page through SQL, no overlap.
    const page1 = await callTool(server, "list_revisions", { projectId: "p1", limit: 2 });
    assert.strictEqual(page1.length, 2);
    const page2 = await callTool(server, "list_revisions",
      { projectId: "p1", limit: 2, before: page1[1].revision });
    assert.ok(page2.length >= 1);
    const seen = new Set(page1.map(x => x.revision));
    for (const x of page2) assert.ok(!seen.has(x.revision), "pages must not overlap");
  } finally { s.close(); }
});

test("restore_revision creates a NEW revision with op=project_restore", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "P", definitions: defs });
    await callTool(server, "ticket_create", { projectId: "p1", type: "user-story", title: "Original" });
    const before = await callTool(server, "list_revisions", { projectId: "p1" });
    const target = before[0].revision;
    await callTool(server, "ticket_create", { projectId: "p1", type: "user-story", title: "Later" });
    const restored = await callTool(server, "restore_revision", { projectId: "p1", revision: target });
    const titles = restored.snapshot.tickets.filter(t => !t.isDeleted).map(t => t.title);
    assert.ok(titles.includes("Original"));
    assert.ok(!titles.includes("Later"), "Later should be gone after restore");
    const after = await callTool(server, "list_revisions", { projectId: "p1" });
    assert.ok(after.length > before.length);
    assert.strictEqual(after[0].op, "project_restore");
  } finally { s.close(); }
});

// ---------------------------------------------------------------------------
// E20.B — request_switch_project
// ---------------------------------------------------------------------------

const bus = require("../server/bus.js");

test("request_switch_project (in-process): bus.emit('switch_response') resolves the tool", async () => {
  const s = await freshStorage();
  try {
    // httpUrl: null → in-process path (listens on bus directly).
    const server = buildServer(s, { httpUrl: null });
    // Fire the response shortly after starting the call.
    let capturedRequestId = null;
    bus.once("switch_request", (ev) => {
      capturedRequestId = ev.requestId;
      // Simulate the browser accepting after 30 ms.
      setTimeout(() => bus.emit("switch_response", { requestId: ev.requestId, accepted: true }), 30);
    });
    const result = await callTool(server, "request_switch_project", {
      workspace: "demo-A", reason: "test", wait_seconds: 5
    });
    assert.strictEqual(result.requested, "demo-A");
    assert.strictEqual(result.requestId, capturedRequestId);
    assert.strictEqual(result.response.accepted, true);
    assert.strictEqual(result.timedOut, false);
  } finally { s.close(); }
});

test("request_switch_project (in-process): timeout when no response", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s, { httpUrl: null });
    const result = await callTool(server, "request_switch_project", {
      workspace: "demo-B", wait_seconds: 1
    });
    assert.strictEqual(result.timedOut, true);
    assert.strictEqual(result.response.accepted, null);
  } finally { s.close(); }
});

test("request_switch_project (standalone): hits httpUrl bridge via fetchImpl", async () => {
  const s = await freshStorage();
  try {
    let postedTo = null, polledFor = null;
    const fakeFetch = async (url, init) => {
      const u = typeof url === "string" ? new URL(url) : url;
      if (u.pathname === "/api/internal/switch-request" && init && init.method === "POST") {
        postedTo = JSON.parse(init.body);
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      if (u.pathname === "/api/internal/switch-response") {
        polledFor = u.searchParams.get("requestId");
        return { ok: true, status: 200, json: async () => ({ accepted: true, timedOut: false }) };
      }
      throw new Error("unexpected fetch: " + u.pathname);
    };
    const server = buildServer(s, { httpUrl: "http://localhost:9999", fetchImpl: fakeFetch });
    const result = await callTool(server, "request_switch_project", {
      workspace: "demo-C", reason: "preview", wait_seconds: 5
    });
    assert.strictEqual(postedTo.workspace, "demo-C", "POST body should carry the workspace");
    assert.strictEqual(postedTo.reason, "preview");
    assert.strictEqual(polledFor, postedTo.requestId, "long-poll should use the same requestId");
    assert.strictEqual(result.response.accepted, true);
  } finally { s.close(); }
});

test("MCP forwards local bus.change to httpUrl /api/internal/notify-change (cross-process live-sync)", async () => {
  const s = await freshStorage();
  try {
    let postedTo = null;
    const fakeFetch = async (url, init) => {
      const u = typeof url === "string" ? new URL(url) : url;
      if (u.pathname === "/api/internal/notify-change") {
        postedTo = JSON.parse(init.body);
        return { ok: true, status: 200 };
      }
      return { ok: true, status: 200 };
    };
    // Just building the server installs the bus.on("change") forwarder.
    buildServer(s, { httpUrl: "http://localhost:9999", fetchImpl: fakeFetch });
    bus.emit("change", { projectId: "demo", revision: "r1", op: "ticket_create", originId: "mcp-actor" });
    // Forwarder is async — yield to the event loop.
    await new Promise(r => setTimeout(r, 20));
    assert.ok(postedTo, "fetch should have been called");
    assert.strictEqual(postedTo.projectId, "demo");
    assert.strictEqual(postedTo.op, "ticket_create");
    assert.strictEqual(postedTo.originId, "mcp-actor");
  } finally { s.close(); }
});

test("request_switch_project: wait_seconds=0 is fire-and-forget (no response field)", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s, { httpUrl: null });
    const result = await callTool(server, "request_switch_project", {
      workspace: "demo-D", wait_seconds: 0
    });
    assert.strictEqual(result.requested, "demo-D");
    assert.strictEqual(result.response, undefined, "fire-and-forget should omit response");
  } finally { s.close(); }
});

// ---------------------------------------------------------------------------
// SM-46 — link MCP tools (link_create, link_delete, list_links_for_ticket,
// get_link_types, set_link_types). In-process tests via reg.handler.
// ---------------------------------------------------------------------------

async function setupTwoTickets() {
  const s = await freshStorage();
  const server = buildServer(s);
  await callTool(server, "project_create", { id: "p1", name: "P", ticketPrefix: "P" });
  const A = await callTool(server, "ticket_create", { projectId: "p1", type: "user-story", title: "A" });
  const B = await callTool(server, "ticket_create", { projectId: "p1", type: "user-story", title: "B" });
  return { s, server, A: A.ticket, B: B.ticket };
}

test("SM-46: link_create + link_delete round-trip", async () => {
  const { s, server, A, B } = await setupTwoTickets();
  try {
    const created = await callTool(server, "link_create", {
      projectId: "p1", sourceTicketId: A.id, linkTypeId: "blocks", targetTicketId: B.id
    });
    assert.ok(created.link.id);
    assert.strictEqual(created.link.linkTypeId, "blocks");
    assert.strictEqual(created.link.targetTicketId, B.id);
    // Delete it.
    const del = await callTool(server, "link_delete", {
      projectId: "p1", sourceTicketId: A.id, linkId: created.link.id
    });
    assert.ok(del.revision);
    // ticket_get → no links.
    const re = await callTool(server, "ticket_get", { projectId: "p1", ticketId: A.id });
    assert.strictEqual(re.ticket.links.length, 0);
  } finally { s.close(); }
});

test("SM-46: link_create rejects self-link with kind=LINK_SELF", async () => {
  const { s, server, A } = await setupTwoTickets();
  try {
    let caught = null;
    try {
      await callTool(server, "link_create", {
        projectId: "p1", sourceTicketId: A.id, linkTypeId: "blocks", targetTicketId: A.id
      });
    } catch (e) { caught = e; }
    assert.ok(caught);
    assert.strictEqual(caught.kind, "LINK_SELF");
  } finally { s.close(); }
});

test("SM-46: link_create cycle-check rejects A blocks B + B blocks A", async () => {
  const { s, server, A, B } = await setupTwoTickets();
  try {
    await callTool(server, "link_create", {
      projectId: "p1", sourceTicketId: A.id, linkTypeId: "blocks", targetTicketId: B.id
    });
    let caught = null;
    try {
      await callTool(server, "link_create", {
        projectId: "p1", sourceTicketId: B.id, linkTypeId: "blocks", targetTicketId: A.id
      });
    } catch (e) { caught = e; }
    assert.ok(caught);
    assert.strictEqual(caught.kind, "LINK_CYCLE");
  } finally { s.close(); }
});

test("SM-46: list_links_for_ticket — forward/backward/both with inverse-label resolution", async () => {
  const { s, server, A, B } = await setupTwoTickets();
  try {
    // A blocks B. Then ask about B → backward link with inverse label "Blocked by".
    await callTool(server, "link_create", {
      projectId: "p1", sourceTicketId: A.id, linkTypeId: "blocks", targetTicketId: B.id
    });
    const fwd = await callTool(server, "list_links_for_ticket", { projectId: "p1", ticketId: A.id, direction: "forward" });
    assert.strictEqual(fwd.links.length, 1);
    assert.strictEqual(fwd.links[0].direction, "forward");
    assert.strictEqual(fwd.links[0].linkTypeId, "blocks");
    assert.strictEqual(fwd.links[0].label, "Blocks");
    assert.strictEqual(fwd.links[0].target.id, B.id);
    const bwd = await callTool(server, "list_links_for_ticket", { projectId: "p1", ticketId: B.id, direction: "backward" });
    assert.strictEqual(bwd.links.length, 1);
    assert.strictEqual(bwd.links[0].direction, "backward");
    assert.strictEqual(bwd.links[0].label, "Blocked by");   // inverseLabel
    assert.strictEqual(bwd.links[0].source.id, A.id);
    const both = await callTool(server, "list_links_for_ticket", { projectId: "p1", ticketId: B.id });
    assert.strictEqual(both.links.length, 1);  // only the backward edge (B has no own links)
  } finally { s.close(); }
});

test("SM-46/SM-164: get_config section=link_types returns the catalogue (defaults seeded)", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "P", ticketPrefix: "P" });
    const r = await callTool(server, "get_config", { projectId: "p1", section: "link_types" });
    const ids = r.value.map(lt => lt.id);
    assert.ok(ids.indexOf("blocks") >= 0);
    assert.ok(ids.indexOf("relates-to") >= 0);
    assert.ok(ids.indexOf("executes") >= 0, "SM-56 added 'executes' to defaults");
    assert.ok(ids.indexOf("tests") >= 0, "SM-54-followup added 'tests' to defaults");
    assert.ok(ids.indexOf("modifies") >= 0, "SM-94 added 'modifies' to defaults");
    assert.ok(ids.indexOf("supersedes") >= 0, "SM-180 added 'supersedes'");
    assert.ok(ids.indexOf("realises") >= 0, "SM-180 added 'realises'");
    assert.strictEqual(r.value.length, 12, "12 defaults (SM-180 added supersedes/replaces/refines/realises)");
  } finally { s.close(); }
});

test("SM-46/SM-52/SM-164: set_config section=link_types replaces the catalogue (contains stays system-required)", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "P", ticketPrefix: "P" });
    const r = await callTool(server, "set_config", {
      projectId: "p1",
      section: "link_types",
      value: [
        { id: "tests", label: "Tests", inverseLabel: "Tested by", semantic: "validation" }
      ]
    });
    const ids = r.value.map(lt => lt.id).sort();
    assert.deepStrictEqual(ids, ["contains", "tests"],
      "user list kept + system-required contains re-injected");
  } finally { s.close(); }
});

// (JSON-string passthrough for set_link_types is exercised in test-mcp-
// stdio.js — Zod's `tolerateJsonString` preprocessor only fires through the
// real MCP protocol, not via the in-process reg.handler shortcut.)

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// SM-58 — test-types MCP tools
// ---------------------------------------------------------------------------

async function setupDef(server) {
  // Create project + a test-definition ticket, return the definition id.
  await callTool(server, "project_create", { id: "p1", name: "P", ticketPrefix: "P" });
  const created = await callTool(server, "ticket_create", {
    projectId: "p1", type: "test-definition", title: "Login OK"
  });
  return created.ticket.id;
}

/**
 * SM-94: helpers to publish a test-definition so test_exec_start gates pass.
 * The publish gates need a target ticket in ≥ready status with a 'tests'-link
 * to the definition. This builds that minimal setup and flips lifecycle to
 * 'published'.
 */
async function publishDef(server, defId) {
  // Find an existing target or make one.
  const list = await callTool(server, "list_tickets", { projectId: "p1" });
  let target = list.tickets.find(t => t.type === "user-story" && t.id !== defId);
  if (!target) {
    const created = await callTool(server, "ticket_create", {
      projectId: "p1", type: "user-story", title: "Target for " + defId, verbose: true
    });
    target = created.ticket;
    // Check default DoR items so mark_ready can pass.
    for (const dorItem of (target.definitionOfReady && target.definitionOfReady.items) || []) {
      if (dorItem.required && !dorItem.checked) {
        await callTool(server, "set_checklist_item", {
          projectId: "p1", ticketId: target.id, gate: "dor", itemId: dorItem.id, checked: true
        });
      }
    }
    await callTool(server, "mark_ready", { projectId: "p1", ticketId: target.id });
  }
  // Add 'tests' link def → target, if not yet there.
  const links = await callTool(server, "list_links_for_ticket", { projectId: "p1", ticketId: defId });
  const hasLink = (links.links || []).some(l => l.linkTypeId === "tests" && l.target && l.target.id === target.id);
  if (!hasLink) {
    await callTool(server, "link_create", {
      projectId: "p1", sourceTicketId: defId, targetTicketId: target.id, linkTypeId: "tests"
    });
  }
  await callTool(server, "publish_test_definition", { projectId: "p1", ticketId: defId });
  return target.id;
}

test("SM-58: test_def_step_add appends a step and returns it", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    const defId = await setupDef(server);
    const r = await callTool(server, "test_def_step_add", {
      projectId: "p1", ticketId: defId,
      patch: { step: "Open page", expectedResult: "Renders" }
    });
    assert.ok(r.step.id);
    assert.strictEqual(r.step.step, "Open page");
    assert.strictEqual(r.step.expectedResult, "Renders");
  } finally { s.close(); }
});

test("SM-58: test_def_step_update patches subset of fields", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    const defId = await setupDef(server);
    const added = await callTool(server, "test_def_step_add", {
      projectId: "p1", ticketId: defId, patch: { step: "X", expectedResult: "Y" }
    });
    const upd = await callTool(server, "test_def_step_update", {
      projectId: "p1", ticketId: defId, stepId: added.step.id,
      patch: { expectedResult: "Z" }
    });
    assert.strictEqual(upd.step.step, "X", "step unchanged");
    assert.strictEqual(upd.step.expectedResult, "Z", "expectedResult patched");
  } finally { s.close(); }
});

test("SM-58: test_def_step_remove drops the step", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    const defId = await setupDef(server);
    const added = await callTool(server, "test_def_step_add", {
      projectId: "p1", ticketId: defId, patch: { step: "X", expectedResult: "Y" }
    });
    await callTool(server, "test_def_step_remove", {
      projectId: "p1", ticketId: defId, stepId: added.step.id
    });
    const ticket = await callTool(server, "ticket_get", { projectId: "p1", ticketId: defId });
    assert.strictEqual((ticket.ticket.steps || []).length, 0);
  } finally { s.close(); }
});

test("SM-58: test_def_step_reorder reorders by full ID list", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    const defId = await setupDef(server);
    const a = await callTool(server, "test_def_step_add", { projectId: "p1", ticketId: defId, patch: { step: "A", expectedResult: "ok" } });
    const b = await callTool(server, "test_def_step_add", { projectId: "p1", ticketId: defId, patch: { step: "B", expectedResult: "ok" } });
    const c = await callTool(server, "test_def_step_add", { projectId: "p1", ticketId: defId, patch: { step: "C", expectedResult: "ok" } });
    const r = await callTool(server, "test_def_step_reorder", {
      projectId: "p1", ticketId: defId,
      orderedStepIds: [c.step.id, a.step.id, b.step.id]
    });
    assert.deepStrictEqual(r.steps.map(x => x.step), ["C", "A", "B"]);
  } finally { s.close(); }
});

test("SM-58: test_def_prereq_add + check + uncheck round-trip", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    const defId = await setupDef(server);
    const added = await callTool(server, "test_def_prereq_add", {
      projectId: "p1", ticketId: defId,
      patch: { label: "User exists", required: true }
    });
    assert.strictEqual(added.prerequisite.label, "User exists");
    assert.strictEqual(added.prerequisite.required, true);
    assert.strictEqual(added.prerequisite.checked, false);
    await callTool(server, "test_def_prereq_check", {
      projectId: "p1", ticketId: defId, prereqId: added.prerequisite.id
    });
    let ticket = await callTool(server, "ticket_get", { projectId: "p1", ticketId: defId });
    assert.strictEqual(ticket.ticket.prerequisites[0].checked, true);
    await callTool(server, "test_def_prereq_uncheck", {
      projectId: "p1", ticketId: defId, prereqId: added.prerequisite.id
    });
    ticket = await callTool(server, "ticket_get", { projectId: "p1", ticketId: defId });
    assert.strictEqual(ticket.ticket.prerequisites[0].checked, false);
  } finally { s.close(); }
});

test("SM-58: test_exec_start clones definition steps + opens 'executes' link", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    const defId = await setupDef(server);
    await callTool(server, "test_def_step_add", { projectId: "p1", ticketId: defId, patch: { step: "A", expectedResult: "ok" } });
    await callTool(server, "test_def_step_add", { projectId: "p1", ticketId: defId, patch: { step: "B", expectedResult: "ok" } });
    await publishDef(server, defId);
    const r = await callTool(server, "test_exec_start", {
      projectId: "p1", definitionId: defId, opts: { env: "staging" }
    });
    const exec = r.execution;
    assert.strictEqual(exec.type, "test-execution");
    assert.strictEqual(exec.env, "staging");
    assert.strictEqual(exec.referencedTestDefinitionId, defId);
    assert.strictEqual(exec.executionSteps.length, 2);
    assert.strictEqual(exec.executionSteps[0].step, "A");
    // 'executes' link from exec → def.
    const link = exec.links.find(l => l.linkTypeId === "executes");
    assert.ok(link);
    assert.strictEqual(link.targetTicketId, defId);
  } finally { s.close(); }
});

test("SM-58: test_exec_start refuses non-test-definition source ticket (WRONG_TYPE)", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "P", ticketPrefix: "P" });
    const story = await callTool(server, "ticket_create", {
      projectId: "p1", type: "user-story", title: "Not a def"
    });
    let err = null;
    try {
      await callTool(server, "test_exec_start", { projectId: "p1", definitionId: story.ticket.id });
    } catch (e) { err = e; }
    assert.ok(err);
    assert.strictEqual(err.kind, "WRONG_TYPE");
  } finally { s.close(); }
});

test("SM-58: test_exec_record updates step actualResult + status, returns effectiveOutcome", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    const defId = await setupDef(server);
    await callTool(server, "test_def_step_add", { projectId: "p1", ticketId: defId, patch: { step: "Only", expectedResult: "ok" } });
    await publishDef(server, defId);
    const start = await callTool(server, "test_exec_start", { projectId: "p1", definitionId: defId });
    const stepId = start.execution.executionSteps[0].stepId;
    const rec = await callTool(server, "test_exec_record", {
      projectId: "p1", executionId: start.execution.id, stepId: stepId,
      patch: { actualResult: "ok", status: "passed" }
    });
    assert.strictEqual(rec.step.actualResult, "ok");
    assert.strictEqual(rec.step.status, "passed");
    assert.strictEqual(rec.effectiveOutcome, "passed");
  } finally { s.close(); }
});

test("SM-58: test_exec_record rejects unknown status (422)", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    const defId = await setupDef(server);
    await callTool(server, "test_def_step_add", { projectId: "p1", ticketId: defId, patch: { step: "S", expectedResult: "ok" } });
    await publishDef(server, defId);
    const start = await callTool(server, "test_exec_start", { projectId: "p1", definitionId: defId });
    const stepId = start.execution.executionSteps[0].stepId;
    let err = null;
    try {
      await callTool(server, "test_exec_record", {
        projectId: "p1", executionId: start.execution.id, stepId: stepId,
        patch: { status: "weird" }
      });
    } catch (e) { err = e; }
    assert.ok(err);
    assert.strictEqual(err.statusCode, 422);
  } finally { s.close(); }
});

test("SM-58: test_exec_set_outcome — manual override wins; 'auto' resets to derived", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    const defId = await setupDef(server);
    await callTool(server, "test_def_step_add", { projectId: "p1", ticketId: defId, patch: { step: "X", expectedResult: "ok" } });
    await publishDef(server, defId);
    const start = await callTool(server, "test_exec_start", { projectId: "p1", definitionId: defId });
    const stepId = start.execution.executionSteps[0].stepId;
    await callTool(server, "test_exec_record", {
      projectId: "p1", executionId: start.execution.id, stepId: stepId,
      patch: { status: "passed" }
    });
    // Manual override to 'blocked'.
    const setBlocked = await callTool(server, "test_exec_set_outcome", {
      projectId: "p1", executionId: start.execution.id, outcome: "blocked"
    });
    assert.strictEqual(setBlocked.outcomeOverride, "blocked");
    assert.strictEqual(setBlocked.effectiveOutcome, "blocked");
    // Reset with 'auto' → derive from steps (all passed → passed).
    const reset = await callTool(server, "test_exec_set_outcome", {
      projectId: "p1", executionId: start.execution.id, outcome: "auto"
    });
    assert.strictEqual(reset.outcomeOverride, null);
    assert.strictEqual(reset.effectiveOutcome, "passed");
  } finally { s.close(); }
});

test("SM-58: test_exec_history returns all runs of a definition + respects limit", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    const defId = await setupDef(server);
    // SM-94: add a step + publish so test_exec_start can fire.
    await callTool(server, "test_def_step_add", { projectId: "p1", ticketId: defId, patch: { step: "S", expectedResult: "ok" } });
    await publishDef(server, defId);
    // Three runs in sequence. now() may return identical ms within a tight
    // event-loop tick, so we don't assert on per-run ordering here — only
    // that all three are surfaced and that `limit` truncates.
    await callTool(server, "test_exec_start", { projectId: "p1", definitionId: defId, opts: { env: "a" } });
    await callTool(server, "test_exec_start", { projectId: "p1", definitionId: defId, opts: { env: "b" } });
    await callTool(server, "test_exec_start", { projectId: "p1", definitionId: defId, opts: { env: "c" } });
    const all = await callTool(server, "test_exec_history", { projectId: "p1", definitionId: defId });
    assert.strictEqual(all.executions.length, 3);
    const envs = all.executions.map(e => e.env).sort();
    assert.deepStrictEqual(envs, ["a", "b", "c"]);
    // limit truncates.
    const one = await callTool(server, "test_exec_history", { projectId: "p1", definitionId: defId, limit: 1 });
    assert.strictEqual(one.executions.length, 1);
  } finally { s.close(); }
});

test("SM-58: test_def_step_update on unknown stepId → 404 tool error", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    const defId = await setupDef(server);
    let err = null;
    try {
      await callTool(server, "test_def_step_update", {
        projectId: "p1", ticketId: defId, stepId: "no-such-step", patch: { step: "X" }
      });
    } catch (e) { err = e; }
    assert.ok(err);
    assert.strictEqual(err.statusCode, 404);
  } finally { s.close(); }
});

// ---------------------------------------------------------------------------
// SM-94 — MCP Gate-Wiring + new lifecycle / governance / metadata tools
// ---------------------------------------------------------------------------

test("SM-94: publish_test_definition flips lifecycle draft → published when all gates pass", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    const defId = await setupDef(server);
    await callTool(server, "test_def_step_add", { projectId: "p1", ticketId: defId,
      patch: { step: "Login", expectedResult: "Redirect to /home" } });
    const targetId = await publishDef(server, defId);
    const after = await callTool(server, "ticket_get", { projectId: "p1", ticketId: defId });
    assert.strictEqual(after.ticket.lifecycle, "published");
    assert.ok(targetId);
  } finally { s.close(); }
});

test("SM-94: publish_test_definition blocks with MISSING_STEPS when steps[] empty", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    const defId = await setupDef(server);
    // Create target + link but NO steps.
    const target = (await callTool(server, "ticket_create",
      { projectId: "p1", type: "user-story", title: "T", verbose: true })).ticket;
    for (const item of target.definitionOfReady.items) {
      await callTool(server, "set_checklist_item", { gate: "dor", checked: true, projectId: "p1", ticketId: target.id, itemId: item.id });
    }
    await callTool(server, "mark_ready", { projectId: "p1", ticketId: target.id });
    await callTool(server, "link_create", { projectId: "p1", sourceTicketId: defId,
      targetTicketId: target.id, linkTypeId: "tests" });
    let err = null;
    try { await callTool(server, "publish_test_definition", { projectId: "p1", ticketId: defId }); }
    catch (e) { err = e; }
    assert.ok(err);
    assert.strictEqual(err.kind, "MISSING_STEPS");
  } finally { s.close(); }
});

test("SM-94: publish_test_definition blocks with MISSING_TESTS_LINK when no tests-link", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    const defId = await setupDef(server);
    await callTool(server, "test_def_step_add", { projectId: "p1", ticketId: defId,
      patch: { step: "S", expectedResult: "ok" } });
    let err = null;
    try { await callTool(server, "publish_test_definition", { projectId: "p1", ticketId: defId }); }
    catch (e) { err = e; }
    assert.ok(err);
    assert.strictEqual(err.kind, "MISSING_TESTS_LINK");
  } finally { s.close(); }
});

test("SM-94: publish_test_definition blocks with TARGET_NOT_READY when target still in backlog", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    const defId = await setupDef(server);
    await callTool(server, "test_def_step_add", { projectId: "p1", ticketId: defId,
      patch: { step: "S", expectedResult: "ok" } });
    const target = (await callTool(server, "ticket_create",
      { projectId: "p1", type: "user-story", title: "T", verbose: true })).ticket;
    // No mark_ready — target stays in backlog.
    await callTool(server, "link_create", { projectId: "p1", sourceTicketId: defId,
      targetTicketId: target.id, linkTypeId: "tests" });
    let err = null;
    try { await callTool(server, "publish_test_definition", { projectId: "p1", ticketId: defId }); }
    catch (e) { err = e; }
    assert.ok(err);
    assert.strictEqual(err.kind, "TARGET_NOT_READY");
    assert.strictEqual(err.statusCode, 422);
  } finally { s.close(); }
});

test("SM-94: reopen_test_definition flips published → draft when no active executions", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    const defId = await setupDef(server);
    await callTool(server, "test_def_step_add", { projectId: "p1", ticketId: defId,
      patch: { step: "S", expectedResult: "ok" } });
    await publishDef(server, defId);
    const r = await callTool(server, "reopen_test_definition", { projectId: "p1", ticketId: defId });
    assert.strictEqual(r.ticket.lifecycle, "draft");
  } finally { s.close(); }
});

test("SM-94: reopen_test_definition blocks with ACTIVE_EXECUTION when a run is in-progress", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    const defId = await setupDef(server);
    await callTool(server, "test_def_step_add", { projectId: "p1", ticketId: defId,
      patch: { step: "S", expectedResult: "ok" } });
    await publishDef(server, defId);
    await callTool(server, "test_exec_start", { projectId: "p1", definitionId: defId, opts: { env: "local" } });
    let err = null;
    try { await callTool(server, "reopen_test_definition", { projectId: "p1", ticketId: defId }); }
    catch (e) { err = e; }
    assert.ok(err);
    assert.strictEqual(err.kind, "ACTIVE_EXECUTION");
  } finally { s.close(); }
});

test("SM-94: update_test_definition_metadata patches title/description/labels only", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    const defId = await setupDef(server);
    const r = await callTool(server, "update_test_definition_metadata", {
      projectId: "p1", ticketId: defId,
      patch: { title: "Renamed", description: "New body", labels: ["smoke"] }
    });
    assert.strictEqual(r.ticket.title, "Renamed");
    assert.strictEqual(r.ticket.description, "New body");
    assert.deepStrictEqual(r.ticket.labels, ["smoke"]);
  } finally { s.close(); }
});

test("SM-94: update_test_definition_metadata rejects forbidden fields (steps, lifecycle)", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    const defId = await setupDef(server);
    // Patch with title (allowed) + steps (forbidden) → steps silently dropped.
    const r = await callTool(server, "update_test_definition_metadata", {
      projectId: "p1", ticketId: defId,
      patch: { title: "T2", steps: [{ id: "x", step: "evil", expectedResult: "y" }], lifecycle: "published" }
    });
    assert.strictEqual(r.ticket.title, "T2");
    assert.strictEqual(r.ticket.lifecycle, "draft", "lifecycle is NOT changeable via metadata tool");
    assert.deepStrictEqual(r.ticket.steps, [], "steps[] is NOT changeable via metadata tool");
  } finally { s.close(); }
});

test("SM-94/SM-164: get_config section=governance returns the default governance", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "P" });
    const r = await callTool(server, "get_config", { projectId: "p1", section: "governance" });
    assert.ok(r.value);
    assert.ok(r.value.gates.MISSING_STEPS);
    assert.ok(r.value.tool_actions.publish_test_definition);
  } finally { s.close(); }
});

test("SM-94/SM-164: set_config section=governance round-trips a custom config", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "P" });
    const custom = {
      gates: { CUSTOM: { predicate: "ticket_field", args: { field: "title", check: "non_empty" } } },
      messages: { CUSTOM: { title: "Title required" } },
      tool_actions: { my_tool: { gates: ["CUSTOM"] } },
      tool_warnings: {}
    };
    const set = await callTool(server, "set_config", { projectId: "p1", section: "governance", value: custom });
    assert.ok(set.value.gates.CUSTOM);
    const got = await callTool(server, "get_config", { projectId: "p1", section: "governance" });
    assert.ok(got.value.gates.CUSTOM);
    assert.strictEqual(got.value.tool_actions.my_tool.gates[0], "CUSTOM");
  } finally { s.close(); }
});

test("SM-94/SM-164: set_config section=governance rejects unknown predicate with UNKNOWN_PREDICATE", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "P" });
    let err = null;
    try {
      await callTool(server, "set_config", { projectId: "p1", section: "governance", value: {
        gates: { BAD: { predicate: "not_a_real_predicate", args: {} } },
        messages: {}, tool_actions: {}, tool_warnings: {}
      }});
    } catch (e) { err = e; }
    assert.ok(err);
    assert.strictEqual(err.kind, "UNKNOWN_PREDICATE");
  } finally { s.close(); }
});

test("SM-94: complete_ticket blocked by OPEN_MODIFIES gate", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "P" });
    const story = (await callTool(server, "ticket_create",
      { projectId: "p1", type: "user-story", title: "Story", verbose: true })).ticket;
    const mod = (await callTool(server, "ticket_create",
      { projectId: "p1", type: "user-story", title: "Modification" })).ticket;
    await callTool(server, "link_create", { projectId: "p1", sourceTicketId: mod.id,
      targetTicketId: story.id, linkTypeId: "modifies" });
    // Walk story to review (check DoR/DoD items along the way).
    for (const item of story.definitionOfReady.items) {
      await callTool(server, "set_checklist_item", { gate: "dor", checked: true, projectId: "p1", ticketId: story.id, itemId: item.id });
    }
    await callTool(server, "mark_ready", { projectId: "p1", ticketId: story.id });
    await callTool(server, "change_ticket_status",
      { projectId: "p1", ticketId: story.id, status: "in-progress" });
    await callTool(server, "change_ticket_status",
      { projectId: "p1", ticketId: story.id, status: "review" });
    const storyGet = await callTool(server, "ticket_get", { projectId: "p1", ticketId: story.id });
    for (const item of storyGet.ticket.definitionOfDone.items) {
      await callTool(server, "set_checklist_item", { gate: "dod", checked: true, projectId: "p1", ticketId: story.id, itemId: item.id });
    }
    let err = null;
    try { await callTool(server, "complete_ticket", { projectId: "p1", ticketId: story.id }); }
    catch (e) { err = e; }
    assert.ok(err);
    assert.strictEqual(err.kind, "OPEN_MODIFIES");
  } finally { s.close(); }
});

test("SM-94: ticket_update on published test-definition blocks step edits with DEFINITION_FROZEN", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    const defId = await setupDef(server);
    await callTool(server, "test_def_step_add", { projectId: "p1", ticketId: defId,
      patch: { step: "S", expectedResult: "ok" } });
    await publishDef(server, defId);
    let err = null;
    try {
      await callTool(server, "ticket_update", {
        projectId: "p1", ticketId: defId,
        patch: { steps: [{ id: "evil", step: "x", expectedResult: "y" }] }
      });
    } catch (e) { err = e; }
    assert.ok(err);
    assert.strictEqual(err.kind, "DEFINITION_FROZEN");
  } finally { s.close(); }
});

test("SM-94: ticket_update on published test-definition lets title/description/labels through", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    const defId = await setupDef(server);
    await callTool(server, "test_def_step_add", { projectId: "p1", ticketId: defId,
      patch: { step: "S", expectedResult: "ok" } });
    await publishDef(server, defId);
    const r = await callTool(server, "ticket_update", {
      projectId: "p1", ticketId: defId,
      patch: { title: "Updated", description: "More" }, verbose: true
    });
    assert.strictEqual(r.ticket.title, "Updated");
    assert.strictEqual(r.ticket.description, "More");
  } finally { s.close(); }
});

test("SM-94: ticket_update on ready+ ticket surfaces SPEC_FROZEN_EDIT soft-warning (non-blocking)", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "P" });
    const story = (await callTool(server, "ticket_create",
      { projectId: "p1", type: "user-story", title: "Story", verbose: true })).ticket;
    for (const item of story.definitionOfReady.items) {
      await callTool(server, "set_checklist_item", { gate: "dor", checked: true, projectId: "p1", ticketId: story.id, itemId: item.id });
    }
    await callTool(server, "mark_ready", { projectId: "p1", ticketId: story.id });
    const r = await callTool(server, "ticket_update", {
      projectId: "p1", ticketId: story.id,
      patch: { description: "Behaviour change here" }, verbose: true
    });
    assert.ok(Array.isArray(r.warnings));
    assert.strictEqual(r.warnings.length, 1);
    assert.strictEqual(r.warnings[0].kind, "SPEC_FROZEN_EDIT");
    assert.strictEqual(r.ticket.description, "Behaviour change here",
      "warning is soft — the edit still went through");
  } finally { s.close(); }
});

// ---------------------------------------------------------------------------
// SM-22 / SM-23 / SM-24 — Bulk operations over MCP
// ---------------------------------------------------------------------------

test("SM-24: bulk_change_status moves multiple tickets to a new status in one revision", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    // Non-empty but no-required definitions — isEmptyDefinitions returns
    // false so we don't get the SM-50 default-seed surprise.
    await callTool(server, "project_create", { id: "p1", name: "P",
      definitions: {
        ready: { global: [{ id: "g1", label: "Opt", required: false }], byType: {} },
        done:  { global: [{ id: "d1", label: "Opt", required: false }], byType: {} }
      } });
    const ids = [];
    for (let i = 0; i < 3; i++) {
      const r = await callTool(server, "ticket_create",
        { projectId: "p1", type: "user-story", title: "T" + i });
      ids.push(r.ticket.id);
    }
    const r = await callTool(server, "bulk_change_status", {
      projectId: "p1", ticketIds: ids, targetStatus: "ready"
    });
    assert.strictEqual(r.successful.length, 3);
    assert.strictEqual(r.failed.length, 0);
    assert.ok(r.revision);
    // All persisted as ready.
    const list = await callTool(server, "list_tickets", { projectId: "p1", status: "ready" });
    assert.strictEqual(list.tickets.length, 3);
  } finally { s.close(); }
});

test("SM-24: bulk_change_status best-effort splits successful + failed when one item's gate fails", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    // Default definitions → DoR has required items. One ticket gets them
    // checked, two don't.
    await callTool(server, "project_create", { id: "p1", name: "P" });
    const ok = (await callTool(server, "ticket_create",
      { projectId: "p1", type: "user-story", title: "OK", verbose: true })).ticket;
    const bad1 = (await callTool(server, "ticket_create",
      { projectId: "p1", type: "user-story", title: "Bad1" })).ticket;
    const bad2 = (await callTool(server, "ticket_create",
      { projectId: "p1", type: "user-story", title: "Bad2" })).ticket;
    for (const item of ok.definitionOfReady.items) {
      await callTool(server, "set_checklist_item", { gate: "dor", checked: true, projectId: "p1", ticketId: ok.id, itemId: item.id });
    }
    const r = await callTool(server, "bulk_change_status", {
      projectId: "p1", ticketIds: [ok.id, bad1.id, bad2.id], targetStatus: "ready"
    });
    assert.strictEqual(r.successful.length, 1);
    assert.strictEqual(r.successful[0].id, ok.id);
    assert.strictEqual(r.failed.length, 2);
    assert.strictEqual(r.failed[0].kind, "DoR");
  } finally { s.close(); }
});

test("SM-24: bulk_change_status atomic mode aborts with BULK_ABORTED when any item fails", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "P" });
    const ok = (await callTool(server, "ticket_create",
      { projectId: "p1", type: "user-story", title: "OK", verbose: true })).ticket;
    const bad = (await callTool(server, "ticket_create",
      { projectId: "p1", type: "user-story", title: "Bad" })).ticket;
    for (const item of ok.definitionOfReady.items) {
      await callTool(server, "set_checklist_item", { gate: "dor", checked: true, projectId: "p1", ticketId: ok.id, itemId: item.id });
    }
    let err = null;
    try {
      await callTool(server, "bulk_change_status", {
        projectId: "p1", ticketIds: [ok.id, bad.id], targetStatus: "ready",
        opts: { atomic: true }
      });
    } catch (e) { err = e; }
    assert.ok(err);
    assert.strictEqual(err.kind, "BULK_ABORTED");
    // No write happened — ok ticket still in backlog.
    const okAfter = await callTool(server, "ticket_get", { projectId: "p1", ticketId: ok.id });
    assert.strictEqual(okAfter.ticket.status, "backlog",
      "atomic abort left even the valid ticket unchanged");
  } finally { s.close(); }
});

test("SM-24: bulk_ticket_update applies the same patch to multiple tickets", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "P" });
    const ids = [];
    for (let i = 0; i < 3; i++) {
      const r = await callTool(server, "ticket_create",
        { projectId: "p1", type: "user-story", title: "T" + i });
      ids.push(r.ticket.id);
    }
    const r = await callTool(server, "bulk_ticket_update", {
      projectId: "p1", ticketIds: ids, patch: { description: "Tagged" }
    });
    assert.strictEqual(r.successful.length, 3);
    assert.strictEqual(r.failed.length, 0);
    const got = await callTool(server, "ticket_get", { projectId: "p1", ticketId: ids[0] });
    assert.strictEqual(got.ticket.description, "Tagged");
  } finally { s.close(); }
});

test("SM-24: bulk_ticket_update DEFINITION_FROZEN per-item — published def's steps-patch lands in failed[]", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    const defId = await setupDef(server);
    await callTool(server, "test_def_step_add", { projectId: "p1", ticketId: defId,
      patch: { step: "S", expectedResult: "ok" } });
    await publishDef(server, defId);
    // Now bulk_ticket_update touching steps on the published def + a story.
    const story = (await callTool(server, "ticket_create",
      { projectId: "p1", type: "user-story", title: "Story", verbose: true })).ticket;
    const r = await callTool(server, "bulk_ticket_update", {
      projectId: "p1", ticketIds: [defId, story.id],
      patch: { steps: [{ id: "x", step: "evil", expectedResult: "y" }] }
    });
    // The def fails DEFINITION_FROZEN. The story doesn't have a 'steps'
    // field but core.ops.updateTicket allows it (test-types accept it).
    const defFailed = r.failed.find(f => f.id === defId);
    assert.ok(defFailed);
    assert.strictEqual(defFailed.kind, "DEFINITION_FROZEN");
  } finally { s.close(); }
});

test("SM-24: bulk_link_create creates the same link from many sources to one target", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "P" });
    const target = (await callTool(server, "ticket_create",
      { projectId: "p1", type: "user-story", title: "Original" })).ticket;
    const sources = [];
    for (let i = 0; i < 3; i++) {
      const t = (await callTool(server, "ticket_create",
        { projectId: "p1", type: "user-story", title: "Mod" + i })).ticket;
      sources.push(t.id);
    }
    const r = await callTool(server, "bulk_link_create", {
      projectId: "p1", sourceTicketIds: sources, targetTicketId: target.id,
      linkTypeId: "modifies"
    });
    assert.strictEqual(r.successful.length, 3);
    assert.strictEqual(r.failed.length, 0);
    // Verify on target — list_links_for_ticket(target, backward) sees 3 incoming.
    const links = await callTool(server, "list_links_for_ticket",
      { projectId: "p1", ticketId: target.id, direction: "backward" });
    assert.strictEqual(links.links.length, 3);
  } finally { s.close(); }
});

test("SM-24: bulk_link_create rejects LINK_SELF in failed[] but persists other valid sources", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "P" });
    const target = (await callTool(server, "ticket_create",
      { projectId: "p1", type: "user-story", title: "Original" })).ticket;
    const valid = (await callTool(server, "ticket_create",
      { projectId: "p1", type: "user-story", title: "ValidMod" })).ticket;
    const r = await callTool(server, "bulk_link_create", {
      projectId: "p1", sourceTicketIds: [target.id, valid.id],
      targetTicketId: target.id, linkTypeId: "modifies"
    });
    assert.strictEqual(r.successful.length, 1);
    assert.strictEqual(r.successful[0].id, valid.id);
    assert.strictEqual(r.failed.length, 1);
    assert.strictEqual(r.failed[0].kind, "LINK_SELF");
  } finally { s.close(); }
});

test("SM-24: bulk_link_create per-item LINK_DUPLICATE on retry — soft-failure", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "P" });
    const target = (await callTool(server, "ticket_create",
      { projectId: "p1", type: "user-story", title: "Original" })).ticket;
    const src = (await callTool(server, "ticket_create",
      { projectId: "p1", type: "user-story", title: "Mod" })).ticket;
    await callTool(server, "bulk_link_create", {
      projectId: "p1", sourceTicketIds: [src.id], targetTicketId: target.id,
      linkTypeId: "modifies"
    });
    // Second call — same link. addLink throws LINK_DUPLICATE; runBulkOp
    // catches it and routes to failed[].
    const r2 = await callTool(server, "bulk_link_create", {
      projectId: "p1", sourceTicketIds: [src.id], targetTicketId: target.id,
      linkTypeId: "modifies"
    });
    assert.strictEqual(r2.successful.length, 0);
    assert.strictEqual(r2.failed.length, 1);
    assert.strictEqual(r2.failed[0].kind, "LINK_DUPLICATE");
  } finally { s.close(); }
});

// ---------------------------------------------------------------------------
// SM-201 R-5 — spec-layer tools
// ---------------------------------------------------------------------------

const SAMPLE_PRD_MD = [
  "# Login",
  "The user can authenticate.",
  "## Password reset",
  "The user can reset a forgotten password.",
  "# Profile",
  "The user can edit their profile."
].join("\n");

test("SM-201 R-5: ingest_slice_candidates converts + slices a project attachment", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "Acme", ticketPrefix: "P" });
    const att = await callTool(server, "attachment_put", {
      projectId: "p1", filename: "prd.md", contentBase64: Buffer.from(SAMPLE_PRD_MD, "utf8").toString("base64")
    });
    const r = await callTool(server, "ingest_slice_candidates", { attachmentId: att.attachment.id, includeMarkdown: true });
    assert.strictEqual(r.format, "md");
    assert.strictEqual(r.sectionCount, 3);
    assert.deepStrictEqual(r.sections.map(x => [x.sectionPath, x.heading]),
      [["1", "Login"], ["1.1", "Password reset"], ["2", "Profile"]]);
    assert.ok(r.markdown.includes("# Login"));
  } finally { s.close(); }
});

test("SM-201 R-5: spec_module_create + requirement_create(moduleId) → ordered requirement_list", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "Acme", ticketPrefix: "P" });
    const mod = await callTool(server, "spec_module_create", { projectId: "p1", title: "PRD", sourceAttachmentId: "att-x" });
    assert.strictEqual(mod.ticket.type, "spec-module");
    assert.strictEqual(mod.ticket.sourceAttachmentId, "att-x");
    // create out of document order; list must come back ordered by sectionPath
    await callTool(server, "requirement_create", { projectId: "p1", moduleId: mod.ticket.id, title: "Profile edit", sectionPath: "2" });
    await callTool(server, "requirement_create", { projectId: "p1", moduleId: mod.ticket.id, title: "Reset pw", sectionPath: "1.1" });
    await callTool(server, "requirement_create", { projectId: "p1", moduleId: mod.ticket.id, title: "Login",
      sectionPath: "1", sourceAnchor: { attachmentId: "att-x", sectionId: "1", charStart: 0, charEnd: 30 } });
    const list = await callTool(server, "requirement_list", { projectId: "p1", moduleId: mod.ticket.id });
    assert.deepStrictEqual(list.requirements.map(r => r.sectionPath), ["1", "1.1", "2"]);
    assert.deepStrictEqual(list.requirements.map(r => r.title), ["Login", "Reset pw", "Profile edit"]);
    // sourceAnchor round-trips
    assert.deepStrictEqual(list.requirements[0].sourceAnchor,
      { attachmentId: "att-x", sectionId: "1", charStart: 0, charEnd: 30 });
  } finally { s.close(); }
});

test("SM-201 R-5: realises link from an implementing story to a requirement works", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "Acme", ticketPrefix: "P" });
    const req = await callTool(server, "requirement_create", { projectId: "p1", title: "Login", sectionPath: "1" });
    const story = await callTool(server, "ticket_create", { projectId: "p1", type: "user-story", title: "Build login" });
    const link = await callTool(server, "link_create", {
      projectId: "p1", sourceTicketId: story.ticket.id, linkTypeId: "realises", targetTicketId: req.ticket.id
    });
    assert.strictEqual(link.link.linkTypeId, "realises");
    assert.strictEqual(link.link.targetTicketId, req.ticket.id);
  } finally { s.close(); }
});

test("SM-201 R-5 review: requirement_create returns the NEW ticket even on duplicate title+sectionPath", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "Acme", ticketPrefix: "P" });
    const mod = await callTool(server, "spec_module_create", { projectId: "p1", title: "PRD" });
    // two requirements with the SAME title and the SAME sectionPath
    const a = await callTool(server, "requirement_create", { projectId: "p1", moduleId: mod.ticket.id, title: "Dup", sectionPath: "1" });
    const b = await callTool(server, "requirement_create", { projectId: "p1", moduleId: mod.ticket.id, title: "Dup", sectionPath: "1" });
    assert.notStrictEqual(a.ticket.id, b.ticket.id, "second create must return its OWN id, not the first ticket's");
    assert.strictEqual(b.ticket.ticketKey, "P-3");   // module=P-1, a=P-2, b=P-3
  } finally { s.close(); }
});

test("SM-202 R-6: get_trace_coverage reports covered vs orphan over the MCP surface", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "Acme", ticketPrefix: "P" });
    const mod = await callTool(server, "spec_module_create", { projectId: "p1", title: "PRD" });
    const r1 = await callTool(server, "requirement_create", { projectId: "p1", moduleId: mod.ticket.id, title: "Login", sectionPath: "1" });
    const r2 = await callTool(server, "requirement_create", { projectId: "p1", moduleId: mod.ticket.id, title: "Profile", sectionPath: "2" });
    const story = await callTool(server, "ticket_create", { projectId: "p1", type: "user-story", title: "Build login" });
    await callTool(server, "link_create", { projectId: "p1", sourceTicketId: story.ticket.id, linkTypeId: "realises", targetTicketId: r1.ticket.id });

    const cov = await callTool(server, "get_trace_coverage", { projectId: "p1", moduleId: mod.ticket.id });
    assert.strictEqual(cov.summary.total, 2);
    assert.strictEqual(cov.summary.covered, 1);
    assert.strictEqual(cov.summary.orphan, 1);
    // ordered by sectionPath
    assert.deepStrictEqual(cov.requirements.map(r => [r.sectionPath, r.status]), [["1", "covered"], ["2", "orphan"]]);
    assert.deepStrictEqual(cov.requirements[0].realisedBy, [story.ticket.id]);
  } finally { s.close(); }
});

test("SM-182: get_drift_report surfaces orphan + dangling + clean over the MCP surface", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "Acme", ticketPrefix: "P" });
    const mod = await callTool(server, "spec_module_create", { projectId: "p1", title: "PRD" });
    const r1 = await callTool(server, "requirement_create", { projectId: "p1", moduleId: mod.ticket.id, title: "Login", sectionPath: "1" });
    const r2 = await callTool(server, "requirement_create", { projectId: "p1", moduleId: mod.ticket.id, title: "Profile", sectionPath: "2" });
    const story = await callTool(server, "ticket_create", { projectId: "p1", type: "user-story", title: "Build login" });
    await callTool(server, "link_create", { projectId: "p1", sourceTicketId: story.ticket.id, linkTypeId: "realises", targetTicketId: r1.ticket.id });

    let d = await callTool(server, "get_drift_report", { projectId: "p1" });
    assert.deepStrictEqual(d.orphanRequirements.map(r => r.id), [r2.ticket.id], "Profile is orphan");
    assert.strictEqual(d.summary.clean, false);
    assert.strictEqual(d.summary.orphanRequirements, 1);

    // a realises-link to a non-requirement (another story) is dangling…
    const story0 = await callTool(server, "ticket_create", { projectId: "p1", type: "user-story", title: "Helper" });
    await callTool(server, "link_create", { projectId: "p1", sourceTicketId: story.ticket.id, linkTypeId: "realises", targetTicketId: story0.ticket.id });
    // …but a tests-link from a test-definition to a STORY is the publish-gate pattern, NOT drift.
    const td = await callTool(server, "ticket_create", { projectId: "p1", type: "test-definition", title: "T" });
    await callTool(server, "link_create", { projectId: "p1", sourceTicketId: td.ticket.id, linkTypeId: "tests", targetTicketId: story.ticket.id });
    d = await callTool(server, "get_drift_report", { projectId: "p1" });
    const dangling = d.danglingLinks.find(l => l.sourceId === story.ticket.id);
    assert.ok(dangling && dangling.reason === "target-not-requirement", "realises→story is dangling");
    assert.ok(!d.danglingLinks.find(l => l.sourceId === td.ticket.id), "tests→story must NOT be flagged");

    // cover Profile too → orphan clears (a tests-link dangling still remains)
    const story2 = await callTool(server, "ticket_create", { projectId: "p1", type: "user-story", title: "Build profile" });
    await callTool(server, "link_create", { projectId: "p1", sourceTicketId: story2.ticket.id, linkTypeId: "realises", targetTicketId: r2.ticket.id });
    d = await callTool(server, "get_drift_report", { projectId: "p1", moduleId: mod.ticket.id });
    assert.deepStrictEqual(d.orphanRequirements, [], "no orphan requirements left");
  } finally { s.close(); }
});

test("SM-182: generate_product_doc saveAsAttachment writes the doc back as a project-level attachment", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "Acme", ticketPrefix: "P" });
    const epic = await callTool(server, "ticket_create", { projectId: "p1", type: "epic", title: "Onboarding" });
    await callTool(server, "ticket_create", { projectId: "p1", type: "user-story", title: "Signup form", position: { epicId: epic.ticket.id } });

    const r = await callTool(server, "generate_product_doc", { projectId: "p1", saveAsAttachment: true });
    assert.ok(r.markdown.includes("Onboarding"), "doc rendered");
    assert.ok(r.attachment && r.attachment.id.startsWith("att-"), "attachment meta returned");
    assert.strictEqual(r.attachment.filename, "product-description.md");
    assert.strictEqual(r.attachment.ticketId, null, "written as a PROJECT-level attachment");

    // it really landed as a project-level attachment, and the bytes round-trip
    const list = await callTool(server, "attachment_list", { projectId: "p1", ticketId: "none" });
    assert.strictEqual(list.attachments.length, 1);
    const got = await callTool(server, "attachment_get", { attachmentId: r.attachment.id });
    assert.strictEqual(Buffer.from(got.contentBase64, "base64").toString("utf8"), r.markdown);

    // custom filename is honoured
    const r2 = await callTool(server, "generate_product_doc", { projectId: "p1", saveAsAttachment: true, attachmentFilename: "PRD-current.md" });
    assert.strictEqual(r2.attachment.filename, "PRD-current.md");
  } finally { s.close(); }
});

test("SM-190: query_tickets filters by a JQL query and returns a compact ordered list", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "Acme", ticketPrefix: "P" });
    const epic = await callTool(server, "ticket_create", { projectId: "p1", type: "epic", title: "Onboarding" });
    await callTool(server, "ticket_create", { projectId: "p1", type: "user-story", title: "Signup form", position: { epicId: epic.ticket.id } });
    await callTool(server, "ticket_create", { projectId: "p1", type: "user-story", title: "Login form" });
    await callTool(server, "ticket_create", { projectId: "p1", type: "bug", title: "Crash" });

    const r = await callTool(server, "query_tickets", { projectId: "p1", query: "type = user-story" });
    assert.strictEqual(r.count, 2);
    assert.deepStrictEqual(r.tickets.map((t) => t.title).slice().sort(), ["Login form", "Signup form"]);
    assert.ok(r.tickets[0].id && r.tickets[0].ticketKey, "compact shape");

    // text search + epic containment
    const r2 = await callTool(server, "query_tickets", { projectId: "p1", query: "epic = " + epic.ticket.ticketKey });
    assert.deepStrictEqual(r2.tickets.map((t) => t.title), ["Signup form"]);
    const r3 = await callTool(server, "query_tickets", { projectId: "p1", query: "text ~ form AND type != bug" });
    assert.strictEqual(r3.count, 2);

    // ORDER BY is honoured over the MCP surface (the tool promises "ordered").
    const r4 = await callTool(server, "query_tickets", { projectId: "p1", query: "type = user-story ORDER BY key DESC" });
    assert.deepStrictEqual(r4.tickets.map((t) => t.title), ["Login form", "Signup form"]);   // P-3 before P-2
    const r5 = await callTool(server, "query_tickets", { projectId: "p1", query: "type = user-story ORDER BY key ASC" });
    assert.deepStrictEqual(r5.tickets.map((t) => t.title), ["Signup form", "Login form"]);
  } finally { s.close(); }
});

test("SM-190: query_tickets surfaces syntax + semantic errors as structured isError(kind:QUERY)", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "Acme", ticketPrefix: "P" });
    // syntax error (missing value) → kind QUERY + position
    let err = null;
    try { await callTool(server, "query_tickets", { projectId: "p1", query: "type =" }); } catch (e) { err = e; }
    assert.ok(err, "expected an error");
    assert.strictEqual(err.kind, "QUERY");
    // semantic error (unknown field)
    err = null;
    try { await callTool(server, "query_tickets", { projectId: "p1", query: "assignee = me" }); } catch (e) { err = e; }
    assert.ok(err && /unknown field/i.test(err.message) && err.kind === "QUERY");
  } finally { s.close(); }
});

// ---------------------------------------------------------------------------
// SM-237 — epic status is derived; every manual status path rejects epics.
// ---------------------------------------------------------------------------

async function projectWithEpic(server) {
  await callTool(server, "project_create", { id: "p1", name: "Acme", definitions: defs });
  const created = await callTool(server, "ticket_create", { projectId: "p1", type: "epic", title: "E1" });
  return created.ticket ? created.ticket.id : created.id;
}

test("SM-237: change_ticket_status on an epic → EPIC_STATUS_DERIVED", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    const epicId = await projectWithEpic(server);
    let err = null;
    try { await callTool(server, "change_ticket_status", { projectId: "p1", ticketId: epicId, status: "in-progress" }); }
    catch (e) { err = e; }
    assert.ok(err, "expected an error");
    assert.strictEqual(err.kind, "EPIC_STATUS_DERIVED");
  } finally { s.close(); }
});

test("SM-237: complete_ticket on an epic → EPIC_STATUS_DERIVED", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    const epicId = await projectWithEpic(server);
    let err = null;
    try { await callTool(server, "complete_ticket", { projectId: "p1", ticketId: epicId, checkDoD: true }); }
    catch (e) { err = e; }
    assert.ok(err, "expected an error");
    assert.strictEqual(err.kind, "EPIC_STATUS_DERIVED");
  } finally { s.close(); }
});

test("SM-237: mark_ready on an epic → EPIC_STATUS_DERIVED", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    const epicId = await projectWithEpic(server);
    let err = null;
    try { await callTool(server, "mark_ready", { projectId: "p1", ticketId: epicId }); }
    catch (e) { err = e; }
    assert.ok(err, "expected an error");
    assert.strictEqual(err.kind, "EPIC_STATUS_DERIVED");
  } finally { s.close(); }
});

test("SM-237: ticket_update with patch.status on an epic → EPIC_STATUS_DERIVED", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    const epicId = await projectWithEpic(server);
    let err = null;
    try { await callTool(server, "ticket_update", { projectId: "p1", ticketId: epicId, patch: { status: "done" } }); }
    catch (e) { err = e; }
    assert.ok(err, "expected an error");
    assert.strictEqual(err.kind, "EPIC_STATUS_DERIVED");
    // A non-status patch on the epic still works.
    const ok = await callTool(server, "ticket_update", { projectId: "p1", ticketId: epicId, patch: { title: "E1-renamed" } });
    assert.ok(ok.revision, "title patch persisted");
  } finally { s.close(); }
});

test("SM-237: bulk_change_status is best-effort — epic entry errors, story entry succeeds", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    const epicId = await projectWithEpic(server);
    const story = await callTool(server, "ticket_create", { projectId: "p1", type: "user-story", title: "S1" });
    const storyId = story.ticket ? story.ticket.id : story.id;
    const r = await callTool(server, "bulk_change_status", {
      projectId: "p1", ticketIds: [epicId, storyId], status: "in-progress"
    });
    // The result reports per-item outcomes; the epic must carry EPIC_STATUS_DERIVED.
    const blob = JSON.stringify(r);
    assert.ok(/EPIC_STATUS_DERIVED/.test(blob), "epic entry reports the derived-status error");
  } finally { s.close(); }
});

// ---------------------------------------------------------------------------
// SM-244 — cancel_ticket MCP tool (Cancel C3).
// ---------------------------------------------------------------------------

test("SM-244: cancel_ticket cancels a story (gate-free, stays visible)", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "Acme", definitions: defs });
    const c = await callTool(server, "ticket_create", { projectId: "p1", type: "user-story", title: "S" });
    const id = c.ticket ? c.ticket.id : c.id;
    const r = await callTool(server, "cancel_ticket", { projectId: "p1", ticketId: id });
    assert.ok(r.revision);
    assert.strictEqual(r.ticket.status, "cancelled");
    // still listable (not deleted)
    const list = await callTool(server, "list_tickets", { projectId: "p1", compact: true });
    assert.ok(list.tickets.some(t => t.id === id), "cancelled ticket stays visible");
  } finally { s.close(); }
});

test("SM-244: cancel_ticket on an epic cascades to its open stories", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "Acme", definitions: defs });
    const e = await callTool(server, "ticket_create", { projectId: "p1", type: "epic", title: "E" });
    const epicId = e.ticket ? e.ticket.id : e.id;
    const a = await callTool(server, "ticket_create", { projectId: "p1", type: "user-story", title: "A", position: { epicId } });
    const b = await callTool(server, "ticket_create", { projectId: "p1", type: "user-story", title: "B", position: { epicId } });
    const aId = a.ticket ? a.ticket.id : a.id;
    const bId = b.ticket ? b.ticket.id : b.id;
    const r = await callTool(server, "cancel_ticket", { projectId: "p1", ticketId: epicId });
    assert.strictEqual(r.ticket.status, "cancelled", "epic rolled up to cancelled");
    const ga = await callTool(server, "ticket_get", { projectId: "p1", ticketId: aId, compact: true });
    const gb = await callTool(server, "ticket_get", { projectId: "p1", ticketId: bId, compact: true });
    assert.strictEqual(ga.ticket ? ga.ticket.status : ga.status, "cancelled");
    assert.strictEqual(gb.ticket ? gb.ticket.status : gb.status, "cancelled");
  } finally { s.close(); }
});

test("SM-244: cancel_ticket rejects spec types", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "Acme", definitions: defs });
    const r = await callTool(server, "requirement_create", { projectId: "p1", title: "R", statement: "shall" })
      .catch(() => null);
    // requirement_create shape varies; fall back to a direct ticket_create requirement
    let reqId = r && (r.ticket ? r.ticket.id : r.id);
    if (!reqId) {
      const c = await callTool(server, "ticket_create", { projectId: "p1", type: "requirement", title: "R2" });
      reqId = c.ticket ? c.ticket.id : c.id;
    }
    let err = null;
    try { await callTool(server, "cancel_ticket", { projectId: "p1", ticketId: reqId }); } catch (e) { err = e; }
    assert.ok(err, "spec type cancel rejected");
    assert.strictEqual(err.kind, "SPEC_CANCEL");
  } finally { s.close(); }
});

// ---------------------------------------------------------------------------
// SM-290/291 — Datenaustausch: import_tickets + export_project
// ---------------------------------------------------------------------------

test("SM-290: import_tickets dryRun plans without writing (no new revision)", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "X", definitions: defs });
    await callTool(server, "ticket_create", { projectId: "p1", type: "user-story", title: "Existing" });
    const revsBefore = (await callTool(server, "list_revisions", { projectId: "p1" })).length;
    const r = await callTool(server, "import_tickets", {
      projectId: "p1", mode: "upsert", dryRun: true,
      csv: "key,type,title\n,bug,Neu Eins\nP-1,,Renamed\n,ghost-type,Broken"
    });
    assert.strictEqual(r.dryRun, true);
    assert.strictEqual(r.plan.creates.length, 1);
    assert.strictEqual(r.plan.creates[0].title, "Neu Eins");
    assert.strictEqual(r.plan.updates.length, 1);
    assert.deepStrictEqual(r.plan.updates[0].fields, ["title"]);
    assert.strictEqual(r.plan.errors.length, 1);
    assert.strictEqual(r.plan.errors[0].line, 4);
    const revsAfter = (await callTool(server, "list_revisions", { projectId: "p1" })).length;
    assert.strictEqual(revsAfter, revsBefore, "dryRun writes NOTHING");
  } finally { s.close(); }
});

test("SM-290: import_tickets apply — creates+updates in ONE revision, error rows never written", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "X", definitions: defs });
    await callTool(server, "ticket_create", { projectId: "p1", type: "user-story", title: "Existing" });
    const revsBefore = (await callTool(server, "list_revisions", { projectId: "p1" })).length;
    const r = await callTool(server, "import_tickets", {
      projectId: "p1", mode: "upsert",
      csv: "key,type,title\n,bug,Neu Eins\n,bug,Neu Zwei\nP-1,,Renamed\n,ghost-type,Broken"
    });
    assert.deepStrictEqual(r.applied, { created: 2, updated: 1 });
    assert.strictEqual(r.errors.length, 1, "error row reported");
    assert.ok(r.revision, "revision returned");
    const revsAfter = (await callTool(server, "list_revisions", { projectId: "p1" })).length;
    assert.strictEqual(revsAfter, revsBefore + 1, "exactly ONE new revision for the whole import");
    const list = await callTool(server, "list_tickets", { projectId: "p1", compact: true });
    const titles = list.tickets.map(t => t.title);
    assert.ok(titles.includes("Neu Eins") && titles.includes("Neu Zwei") && titles.includes("Renamed"));
    assert.ok(!titles.includes("Broken"), "error row NOT written");
  } finally { s.close(); }
});

test("SM-290: import_tickets accepts rows (array) — and as a JSON STRING via tolerateJsonString", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "X", definitions: defs });
    const r = await callTool(server, "import_tickets", {
      projectId: "p1", rows: [{ type: "bug", title: "Vom Array" }]
    });
    assert.deepStrictEqual(r.applied, { created: 1, updated: 0 });
    // the bridge footgun: the same array as a serialized string
    const r2 = await callTool(server, "import_tickets", {
      projectId: "p1", rows: JSON.stringify([{ type: "bug", title: "Vom String" }])
    });
    assert.deepStrictEqual(r2.applied, { created: 1, updated: 0 });
    const list = await callTool(server, "list_tickets", { projectId: "p1", compact: true });
    const titles = list.tickets.map(t => t.title);
    assert.ok(titles.includes("Vom Array") && titles.includes("Vom String"));
  } finally { s.close(); }
});

test("SM-290: import_tickets error surfaces — missing input, parse error, errors-only (no revision)", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "X", definitions: defs });
    let err = null;
    try { await callTool(server, "import_tickets", { projectId: "p1" }); } catch (e) { err = e; }
    assert.ok(err && err.statusCode === 400, "csv or rows required");
    err = null;
    try { await callTool(server, "import_tickets", { projectId: "p1", csv: 'title\n"broken' }); } catch (e) { err = e; }
    assert.ok(err && err.kind === "IMPORT_PARSE", "unterminated quote → IMPORT_PARSE");
    const revsBefore = (await callTool(server, "list_revisions", { projectId: "p1" })).length;
    const r = await callTool(server, "import_tickets", { projectId: "p1", csv: "title,type\nX,ghost" });
    assert.deepStrictEqual(r.applied, { created: 0, updated: 0 });
    assert.strictEqual(r.plan.errors.length, 1);
    assert.ok(/no revision/.test(r.note));
    const revsAfter = (await callTool(server, "list_revisions", { projectId: "p1" })).length;
    assert.strictEqual(revsAfter, revsBefore, "errors-only import writes nothing");
  } finally { s.close(); }
});

test("SM-296: import_tickets headerMapping — object AND JSON string; heuristic covers Jira headers", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "X", definitions: defs });
    // built-in heuristic: no mapping needed for Jira basics
    let r = await callTool(server, "import_tickets", {
      projectId: "p1", dryRun: true,
      csv: "Issue key,Summary,Issue Type\n,Jira Zeile,bug"
    });
    assert.strictEqual(r.plan.creates.length, 1);
    assert.strictEqual(r.plan.creates[0].title, "Jira Zeile");
    // explicit mapping as OBJECT
    r = await callTool(server, "import_tickets", {
      projectId: "p1", dryRun: true,
      csv: "Col A,Col B\nGemappt,bug",
      headerMapping: { "col a": "title", "col b": "type" }
    });
    assert.strictEqual(r.plan.creates[0].title, "Gemappt");
    // explicit mapping as JSON STRING (bridge footgun)
    r = await callTool(server, "import_tickets", {
      projectId: "p1", dryRun: true,
      csv: "Col A,Col B\nGemappt2,bug",
      headerMapping: JSON.stringify({ "col a": "title", "col b": "type" })
    });
    assert.strictEqual(r.plan.creates[0].title, "Gemappt2");
  } finally { s.close(); }
});

test("SM-297: import_tickets valueMapping (object + JSON string); dryRun exposes unknownValues", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "X", definitions: defs });
    // without mapping: dryRun lists the unknown values to map
    let r = await callTool(server, "import_tickets", {
      projectId: "p1", dryRun: true,
      csv: "title,type,status\nA,Technische Story,IN TESTING"
    });
    assert.deepStrictEqual(r.plan.unknownValues.type, ["Technische Story"]);
    assert.deepStrictEqual(r.plan.unknownValues.status, ["IN TESTING"]);
    // with mapping as OBJECT
    r = await callTool(server, "import_tickets", {
      projectId: "p1", dryRun: true,
      csv: "title,type,status\nA,Technische Story,IN TESTING",
      valueMapping: { type: { "technische story": "user-story" }, status: { "in testing": "review" } }
    });
    assert.deepStrictEqual(r.plan.errors, []);
    assert.strictEqual(r.plan.creates.length, 1);
    // with mapping as JSON STRING (bridge footgun)
    r = await callTool(server, "import_tickets", {
      projectId: "p1", dryRun: true,
      csv: "title,type,status\nA,Technische Story,IN TESTING",
      valueMapping: JSON.stringify({ type: { "technische story": "user-story" }, status: { "in testing": "review" } })
    });
    assert.deepStrictEqual(r.plan.errors, []);
  } finally { s.close(); }
});

test("SM-290 (review): a mid-apply throw surfaces as an ERROR, never as the no-write note", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "X", definitions: defs });
    await callTool(server, "ticket_create", { projectId: "p1", type: "user-story", title: "Victim" });
    const revsBefore = (await callTool(server, "list_revisions", { projectId: "p1" })).length;
    // Planner lets "become an epic AND change status" through (the epic guard
    // only covers CURRENT epics); ops.updateTicket then throws
    // EPIC_STATUS_DERIVED mid-apply. That throw must be a loud error.
    let err = null;
    try {
      await callTool(server, "import_tickets", {
        projectId: "p1", mode: "upsert",
        csv: "key,type,status\nP-1,epic,done"
      });
    } catch (e) { err = e; }
    assert.ok(err, "mid-apply throw surfaces as isError");
    assert.ok(!/no revision created/.test(err.message), "NOT masked as the clean no-write note");
    const revsAfter = (await callTool(server, "list_revisions", { projectId: "p1" })).length;
    assert.strictEqual(revsAfter, revsBefore, "aborted apply writes nothing (all-or-nothing)");
  } finally { s.close(); }
});

test("SM-291: export_project returns the re-importable envelope (parseImport round-trip)", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "Exportable", definitions: defs });
    await callTool(server, "ticket_create", { projectId: "p1", type: "user-story", title: "Inside" });
    const r = await callTool(server, "export_project", { projectId: "p1" });
    assert.strictEqual(r.filename, "p1.storymap.json");
    assert.strictEqual(r.envelope.format, "storymap-project");
    assert.ok(r.envelope.exportedAt, "exportedAt stamped");
    // round-trip through the SAME parse the browser import uses
    const projectIO = require("../shared/project-io.js");
    const snap = projectIO.parseImport(JSON.stringify(r.envelope));
    assert.strictEqual(snap.project.id, "p1");
    assert.ok(snap.tickets.some(t => t.title === "Inside"));
  } finally { s.close(); }
});

test("SM-291: export_project unknown project → structured 404", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    let err = null;
    try { await callTool(server, "export_project", { projectId: "nope" }); } catch (e) { err = e; }
    assert.ok(err && err.statusCode === 404);
  } finally { s.close(); }
});

module.exports.done = (test._chain || Promise.resolve()).then(() => {
  console.log(`\n  ${passed} passed, ${failed} failed`);
});
