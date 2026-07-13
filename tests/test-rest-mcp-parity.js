"use strict";

/**
 * SM-114 (A5) — REST ↔ MCP parity.
 *
 * Epic A added REST routes that deliberately go through the SAME core.ops as
 * their MCP-tool counterparts. This suite proves the equivalence end-to-end:
 *
 *  - "same mutation": apply an op via REST to one project and via the MCP tool
 *    to an identical project (sharing ONE storage), then compare the mutated
 *    entity with volatile fields (id / timestamps / actor) stripped.
 *  - "same kind errors": drive the gate/validation failure on both surfaces
 *    and assert the REST HTTP body's `kind` equals the MCP tool error's `kind`.
 *
 * The HTTP server and the in-process MCP server share the handle's Storage
 * instance, so both read/write the exact same SQLite-backed state.
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { startServer } = require("../server/server.js");
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
  return await fs.promises.mkdtemp(path.join(os.tmpdir(), "storymap-parity-"));
}

// Start an HTTP server + an in-process MCP server sharing its Storage.
// fetchImpl is a no-op so the MCP change-forwarder never hits the network.
async function startBoth() {
  const dataDir = await tmpDir();
  const handle = await startServer({ port: 0, dataDir });
  const port = handle.httpServer.address().port;
  const mcp = buildServer(handle.storage, {
    httpUrl: null,
    fetchImpl: async () => ({ ok: true, json: async () => ({}) })
  });
  return { handle, mcp, base: `http://localhost:${port}` };
}

async function req(base, method, p, body, headers) {
  const init = { method, headers: Object.assign({ "Content-Type": "application/json" }, headers || {}) };
  if (body !== undefined) init.body = typeof body === "string" ? body : JSON.stringify(body);
  const res = await fetch(base + p, init);
  let data = null;
  const text = await res.text();
  if (text) { try { data = JSON.parse(text); } catch (_) { data = text; } }
  return { status: res.status, data };
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
    err.kind = parsed.kind; err.statusCode = parsed.statusCode;
    throw err;
  }
  return parsed;
}

// Create a project + two tickets (a, b) via REST. Returns ticket ids.
async function twoTickets(base, pid) {
  await req(base, "POST", "/api/projects", { id: pid, name: pid, ticketPrefix: "P" });
  const a = await req(base, "POST", `/api/projects/${pid}/tickets`, { type: "user-story", title: "A" });
  const b = await req(base, "POST", `/api/projects/${pid}/tickets`, { type: "user-story", title: "B" });
  return { a: a.data.ticket.id, b: b.data.ticket.id };
}

function stripLink(link) {
  if (!link) return null;
  const { id, createdAt, createdBy, targetTicketId, ...rest } = link;
  return rest; // { linkTypeId, label? } — the project-independent shape
}

// ---------------------------------------------------------------------------
// Same mutation
// ---------------------------------------------------------------------------

test("parity: link_create produces the same link mutation via REST and MCP", async () => {
  const t = await startBoth();
  try {
    const r = await twoTickets(t.base, "rest");
    const m = await twoTickets(t.base, "mcp");
    // REST
    await req(t.base, "POST", `/api/projects/rest/tickets/${r.a}/links`,
      { linkTypeId: "relates-to", targetTicketId: r.b });
    // MCP
    await callTool(t.mcp, "link_create",
      { projectId: "mcp", sourceTicketId: m.a, linkTypeId: "relates-to", targetTicketId: m.b });
    // Compare the resulting source-ticket link (volatile fields + target id stripped)
    const restSnap = await t.handle.storage.loadProject("rest");
    const mcpSnap = await t.handle.storage.loadProject("mcp");
    const restLink = restSnap.tickets.find(x => x.id === r.a).links[0];
    const mcpLink = mcpSnap.tickets.find(x => x.id === m.a).links[0];
    assert.deepStrictEqual(stripLink(restLink), stripLink(mcpLink));
    assert.strictEqual(restLink.targetTicketId, r.b);
    assert.strictEqual(mcpLink.targetTicketId, m.b);
  } finally { await t.handle.shutdown(); }
});

test("parity: set_workflow produces the same project.workflow via REST and MCP", async () => {
  const t = await startBoth();
  try {
    await req(t.base, "POST", "/api/projects", { id: "rest", name: "rest", ticketPrefix: "P" });
    await req(t.base, "POST", "/api/projects", { id: "mcp", name: "mcp", ticketPrefix: "P" });
    const wf = {
      statuses: [{ id: "todo", name: "Todo", category: "todo" }, { id: "shipped", name: "Shipped", category: "done" }],
      transitions: [{ id: "ship", name: "Ship", fromStatuses: ["todo"], toStatus: "shipped", allowFromAny: false }]
    };
    await req(t.base, "PUT", "/api/projects/rest/workflow", wf);
    await callTool(t.mcp, "set_config", { projectId: "mcp", section: "workflow", value: wf });
    const restSnap = await t.handle.storage.loadProject("rest");
    const mcpSnap = await t.handle.storage.loadProject("mcp");
    assert.deepStrictEqual(restSnap.project.workflow, mcpSnap.project.workflow);
  } finally { await t.handle.shutdown(); }
});

// ---------------------------------------------------------------------------
// Same kind errors
// ---------------------------------------------------------------------------

async function restKind(base, method, p, body) {
  const r = await req(base, method, p, body);
  return { status: r.status, kind: r.data && r.data.kind };
}
async function mcpKind(server, name, args) {
  try { await callTool(server, name, args); return { kind: null }; }
  catch (e) { return { kind: e.kind }; }
}

test("parity: LINK_CYCLE error kind matches on both surfaces", async () => {
  const t = await startBoth();
  try {
    const r = await twoTickets(t.base, "rest");
    const m = await twoTickets(t.base, "mcp");
    await req(t.base, "POST", `/api/projects/rest/tickets/${r.a}/links`, { linkTypeId: "predecessor-of", targetTicketId: r.b });
    await callTool(t.mcp, "link_create", { projectId: "mcp", sourceTicketId: m.a, linkTypeId: "predecessor-of", targetTicketId: m.b });
    const rest = await restKind(t.base, "POST", `/api/projects/rest/tickets/${r.b}/links`, { linkTypeId: "predecessor-of", targetTicketId: r.a });
    const mcp = await mcpKind(t.mcp, "link_create", { projectId: "mcp", sourceTicketId: m.b, linkTypeId: "predecessor-of", targetTicketId: m.a });
    assert.strictEqual(rest.status, 409);
    assert.strictEqual(rest.kind, "LINK_CYCLE");
    assert.strictEqual(mcp.kind, "LINK_CYCLE");
  } finally { await t.handle.shutdown(); }
});

test("parity: DEFINITION_FROZEN error kind matches on both surfaces", async () => {
  const t = await startBoth();
  try {
    // identical published test-def in both projects
    for (const pid of ["rest", "mcp"]) {
      await req(t.base, "POST", "/api/projects", { id: pid, name: pid, ticketPrefix: "P" });
      const d = await req(t.base, "POST", `/api/projects/${pid}/tickets`, { type: "test-definition", title: "L" });
      await req(t.base, "POST", `/api/projects/${pid}/tickets/${d.data.ticket.id}/test-steps`, { step: "s", expectedResult: "ok" });
      await req(t.base, "PUT", `/api/projects/${pid}/tickets/${d.data.ticket.id}`, { lifecycle: "published" });
      if (pid === "rest") t._restDef = d.data.ticket.id; else t._mcpDef = d.data.ticket.id;
    }
    const rest = await restKind(t.base, "POST", `/api/projects/rest/tickets/${t._restDef}/test-steps`, { step: "x", expectedResult: "ok" });
    const mcp = await mcpKind(t.mcp, "test_def_step_add", { projectId: "mcp", ticketId: t._mcpDef, patch: { step: "x", expectedResult: "ok" } });
    assert.strictEqual(rest.status, 409);
    assert.strictEqual(rest.kind, "DEFINITION_FROZEN");
    assert.strictEqual(mcp.kind, "DEFINITION_FROZEN");
  } finally { await t.handle.shutdown(); }
});

test("parity: UNKNOWN_PREDICATE (governance) error kind matches on both surfaces", async () => {
  const t = await startBoth();
  try {
    await req(t.base, "POST", "/api/projects", { id: "rest", name: "rest", ticketPrefix: "P" });
    await req(t.base, "POST", "/api/projects", { id: "mcp", name: "mcp", ticketPrefix: "P" });
    const badGov = { gates: { SOME_KIND: { predicate: "not_a_real_predicate" } } };
    const rest = await restKind(t.base, "PUT", "/api/projects/rest/governance", { governance: badGov });
    const mcp = await mcpKind(t.mcp, "set_config", { projectId: "mcp", section: "governance", value: badGov });
    assert.strictEqual(rest.status, 400);
    assert.strictEqual(rest.kind, "UNKNOWN_PREDICATE");
    assert.strictEqual(mcp.kind, "UNKNOWN_PREDICATE");
  } finally { await t.handle.shutdown(); }
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

module.exports.done = (test._chain || Promise.resolve()).then(() => {
  console.log(`\n  ${passed} passed, ${failed} failed`);
});
