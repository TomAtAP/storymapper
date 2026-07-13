"use strict";

/**
 * Subprocess MCP test: spawn `node server/index.js mcp --data-dir=...`
 * and speak JSON-RPC over stdio. Verifies the same handlers that
 * test-mcp.js exercises in-process are reachable end-to-end.
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

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
  return await fs.promises.mkdtemp(path.join(os.tmpdir(), "storymap-stdio-"));
}

/** Tiny stdio JSON-RPC client. */
class Client {
  constructor(child) {
    this.child = child;
    this.buf = "";
    this.pending = new Map();
    this.nextId = 1;
    child.stdout.on("data", (chunk) => {
      this.buf += chunk.toString();
      let idx;
      while ((idx = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, idx);
        this.buf = this.buf.slice(idx + 1);
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch (_) { continue; }
        if (msg.id != null && this.pending.has(msg.id)) {
          const { resolve } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          resolve(msg);
        }
      }
    });
    child.stderr.on("data", () => {});  // discard log noise
  }
  send(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params: params || {} });
      this.child.stdin.write(msg + "\n");
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error("timeout waiting for response to " + method));
        }
      }, 5000);
    });
  }
  close() {
    try { this.child.stdin.end(); } catch (_) { /* ignore */ }
    try { this.child.kill(); } catch (_) { /* ignore */ }
  }
}

async function spawnMcp(dataDir) {
  const indexPath = path.resolve(__dirname, "..", "server", "index.js");
  const child = spawn(process.execPath, [indexPath, "mcp", "--data-dir=" + dataDir], {
    stdio: ["pipe", "pipe", "pipe"]
  });
  const client = new Client(child);
  // Initialize handshake.
  const init = await client.send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test", version: "0.1.0" }
  });
  if (init.error) throw new Error("initialize failed: " + JSON.stringify(init.error));
  await client.child.stdin.write(JSON.stringify({
    jsonrpc: "2.0", method: "notifications/initialized"
  }) + "\n");
  return client;
}

// ---------------------------------------------------------------------------

test("stdio: initialize + tools/list", async () => {
  const dir = await tmpDir();
  const c = await spawnMcp(dir);
  try {
    const r = await c.send("tools/list", {});
    assert.ok(r.result, "no result: " + JSON.stringify(r));
    const names = r.result.tools.map(t => t.name);
    assert.ok(names.includes("list_projects"));
    assert.ok(names.includes("project_create"));
    assert.ok(names.includes("ticket_create"));
    assert.ok(names.includes("change_ticket_status"));
  } finally { c.close(); }
});

test("stdio: project_create + ticket_create round-trip", async () => {
  const dir = await tmpDir();
  const c = await spawnMcp(dir);
  try {
    let r = await c.send("tools/call", {
      name: "project_create",
      arguments: { id: "p1", name: "Acme",
        definitions: {
          ready: { global: [{ id: "g1", label: "G1", required: true }], byType: {} },
          done:  { global: [{ id: "d1", label: "D1", required: true }], byType: {} }
        }
      }
    });
    assert.ok(r.result, "project_create failed: " + JSON.stringify(r));
    r = await c.send("tools/call", {
      name: "ticket_create",
      arguments: { projectId: "p1", type: "user-story", title: "First" }
    });
    assert.ok(r.result);
    const payload = JSON.parse(r.result.content[0].text);
    assert.strictEqual(payload.ticket.title, "First");
    assert.strictEqual(payload.ticket.ticketKey, "P-1");
  } finally { c.close(); }
});

test("stdio: SM-255 release_delete refuses the last release (LAST_RELEASE)", async () => {
  const dir = await tmpDir();
  const c = await spawnMcp(dir);
  try {
    await c.send("tools/call", { name: "project_create", arguments: { id: "p1", name: "P", ticketPrefix: "P" } });
    const seeded = JSON.parse((await c.send("tools/call", { name: "list_releases", arguments: { projectId: "p1" } })).result.content[0].text);
    const r = await c.send("tools/call", { name: "release_delete", arguments: { projectId: "p1", releaseId: seeded[0].id } });
    assert.ok(r.result && r.result.isError, "deleting the last release should be an error");
    assert.ok(/LAST_RELEASE/.test(r.result.content[0].text), "kind LAST_RELEASE surfaced: " + r.result.content[0].text);
  } finally { c.close(); }
});

test("stdio: SM-254 project_create seeds a default release + process step", async () => {
  const dir = await tmpDir();
  const c = await spawnMcp(dir);
  try {
    const r = await c.send("tools/call", {
      name: "project_create", arguments: { id: "p1", name: "Seeded", ticketPrefix: "P" }
    });
    assert.ok(r.result && !r.result.isError, "project_create failed: " + JSON.stringify(r));
    const snap = JSON.parse(r.result.content[0].text).snapshot;
    assert.strictEqual(snap.releases.filter(x => !x.isDeleted).length, 1, "one default release");
    assert.strictEqual(snap.processSteps.filter(x => !x.isDeleted).length, 1, "one default process step");
  } finally { c.close(); }
});

test("stdio: change_ticket_status surfaces DoR error with structured fields", async () => {
  const dir = await tmpDir();
  const c = await spawnMcp(dir);
  try {
    await c.send("tools/call", {
      name: "project_create",
      arguments: { id: "p1", name: "X",
        definitions: {
          ready: { global: [{ id: "g1", label: "G1", required: true }], byType: {} },
          done:  { global: [], byType: {} }
        }
      }
    });
    const t = await c.send("tools/call", {
      name: "ticket_create",
      arguments: { projectId: "p1", type: "user-story", title: "X" }
    });
    const ticketId = JSON.parse(t.result.content[0].text).ticket.id;
    const r = await c.send("tools/call", {
      name: "change_ticket_status",
      arguments: { projectId: "p1", ticketId, status: "ready" }
    });
    assert.ok(r.result.isError, "expected isError flag");
    const body = JSON.parse(r.result.content[0].text);
    assert.strictEqual(body.kind, "DoR");
    assert.ok(Array.isArray(body.missing));
    assert.strictEqual(body.missing.length, 1);
  } finally { c.close(); }
});

test("stdio: list_projects after create", async () => {
  const dir = await tmpDir();
  const c = await spawnMcp(dir);
  try {
    await c.send("tools/call", {
      name: "project_create",
      arguments: { id: "p1", name: "X" }
    });
    const r = await c.send("tools/call", { name: "list_projects", arguments: {} });
    const payload = JSON.parse(r.result.content[0].text);
    assert.deepStrictEqual(payload.projects, ["p1"]);
  } finally { c.close(); }
});

test("stdio: ticket_create honors nested position object (releaseId/processStepId)", async () => {
  const dir = await tmpDir();
  const c = await spawnMcp(dir);
  try {
    await c.send("tools/call", {
      name: "project_create",
      arguments: { id: "p1", name: "Pos", ticketPrefix: "P" }
    });
    const rel = JSON.parse((await c.send("tools/call", {
      name: "release_create",
      arguments: { projectId: "p1", name: "v1" }
    })).result.content[0].text).release;
    const ps = JSON.parse((await c.send("tools/call", {
      name: "process_step_create",
      arguments: { projectId: "p1", name: "Build" }
    })).result.content[0].text).processStep;

    const r = await c.send("tools/call", {
      name: "ticket_create",
      arguments: {
        projectId: "p1", type: "user-story", title: "Pinned",
        position: { releaseId: rel.id, processStepId: ps.id }
      }
    });
    assert.ok(r.result && !r.result.isError, "ticket_create failed: " + JSON.stringify(r));
    const ticket = JSON.parse(r.result.content[0].text).ticket;
    assert.strictEqual(ticket.position.releaseId, rel.id,
      "expected releaseId to be persisted, got " + JSON.stringify(ticket.position));
    assert.strictEqual(ticket.position.processStepId, ps.id,
      "expected processStepId to be persisted, got " + JSON.stringify(ticket.position));
  } finally { c.close(); }
});

test("stdio: ticket_create accepts JSON-string position (real-world MCP client behavior)", async () => {
  const dir = await tmpDir();
  const c = await spawnMcp(dir);
  try {
    await c.send("tools/call", {
      name: "project_create",
      arguments: { id: "p1", name: "Pos", ticketPrefix: "P" }
    });
    const rel = JSON.parse((await c.send("tools/call", {
      name: "release_create",
      arguments: { projectId: "p1", name: "v1" }
    })).result.content[0].text).release;
    const ps = JSON.parse((await c.send("tools/call", {
      name: "process_step_create",
      arguments: { projectId: "p1", name: "Build" }
    })).result.content[0].text).processStep;

    // Some MCP clients (incl. Claude Code) appear to stringify nested
    // objects when the schema is z.any() because there is no JSON-schema
    // signal that this is an object. The server must handle that input
    // gracefully — otherwise position fields are silently dropped.
    const r = await c.send("tools/call", {
      name: "ticket_create",
      arguments: {
        projectId: "p1", type: "user-story", title: "Pinned",
        position: JSON.stringify({ releaseId: rel.id, processStepId: ps.id })
      }
    });
    assert.ok(r.result && !r.result.isError, "ticket_create failed: " + JSON.stringify(r));
    const ticket = JSON.parse(r.result.content[0].text).ticket;
    assert.strictEqual(ticket.position.releaseId, rel.id,
      "expected releaseId to land even when position arrived as JSON string; got "
      + JSON.stringify(ticket.position));
    assert.strictEqual(ticket.position.processStepId, ps.id);
  } finally { c.close(); }
});

test("stdio: SM-260 ticket_create accepts acceptanceCriteria (object + JSON-string)", async () => {
  const dir = await tmpDir();
  const c = await spawnMcp(dir);
  try {
    await c.send("tools/call", { name: "project_create", arguments: { id: "p1", name: "AC", ticketPrefix: "P" } });
    // Object form through the real Zod bridge.
    const r1 = await c.send("tools/call", {
      name: "ticket_create",
      arguments: { projectId: "p1", type: "user-story", title: "Has AC", verbose: true,
        acceptanceCriteria: [{ text: "first" }, { text: "second" }] }
    });
    assert.ok(r1.result && !r1.result.isError, "ticket_create(AC) failed: " + JSON.stringify(r1));
    const t1 = JSON.parse(r1.result.content[0].text).ticket;
    assert.strictEqual(t1.acceptanceCriteria.length, 2, "AC persisted: " + JSON.stringify(t1.acceptanceCriteria));
    assert.strictEqual(t1.acceptanceCriteria[0].text, "first");
    // JSON-string form (bridge stringifies arrays).
    const r2 = await c.send("tools/call", {
      name: "ticket_create",
      arguments: { projectId: "p1", type: "user-story", title: "Stringified", verbose: true,
        acceptanceCriteria: JSON.stringify([{ text: "stringified" }]) }
    });
    assert.ok(r2.result && !r2.result.isError, "ticket_create(stringified AC) failed: " + JSON.stringify(r2));
    const t2 = JSON.parse(r2.result.content[0].text).ticket;
    assert.strictEqual(t2.acceptanceCriteria.length, 1);
    assert.strictEqual(t2.acceptanceCriteria[0].text, "stringified");
  } finally { c.close(); }
});

test("stdio: ticket_update patch.position lands in the snapshot", async () => {
  const dir = await tmpDir();
  const c = await spawnMcp(dir);
  try {
    await c.send("tools/call", {
      name: "project_create",
      arguments: { id: "p1", name: "Pos", ticketPrefix: "P" }
    });
    const rel = JSON.parse((await c.send("tools/call", {
      name: "release_create",
      arguments: { projectId: "p1", name: "v1" }
    })).result.content[0].text).release;
    const ps = JSON.parse((await c.send("tools/call", {
      name: "process_step_create",
      arguments: { projectId: "p1", name: "Build" }
    })).result.content[0].text).processStep;

    const created = JSON.parse((await c.send("tools/call", {
      name: "ticket_create",
      arguments: { projectId: "p1", type: "user-story", title: "Movable" }
    })).result.content[0].text).ticket;
    assert.strictEqual(created.position.releaseId, null);

    const r = await c.send("tools/call", {
      name: "ticket_update",
      arguments: {
        projectId: "p1", ticketId: created.id,
        patch: { position: { releaseId: rel.id, processStepId: ps.id } }
      }
    });
    assert.ok(r.result && !r.result.isError, "ticket_update failed: " + JSON.stringify(r));
    const ticket = JSON.parse(r.result.content[0].text).ticket;
    assert.strictEqual(ticket.position.releaseId, rel.id);
    assert.strictEqual(ticket.position.processStepId, ps.id);
  } finally { c.close(); }
});

test("stdio: set_config section=kanban_columns accepts a JSON-string value (SM-164 tolerateJsonString)", async () => {
  const dir = await tmpDir();
  const c = await spawnMcp(dir);
  try {
    await c.send("tools/call", {
      name: "project_create",
      arguments: { id: "p1", name: "K", ticketPrefix: "K" }
    });
    // Pass `value` as a JSON string — mirrors how Claude Code's MCP
    // bridge can serialize nested arrays when the input schema is loose.
    const r = await c.send("tools/call", {
      name: "set_config",
      arguments: {
        projectId: "p1",
        section: "kanban_columns",
        value: JSON.stringify([
          { id: "c1", name: "All", statusIds: ["backlog", "ready", "in-progress", "review", "done"] }
        ])
      }
    });
    assert.ok(r.result && !r.result.isError, "set_config(kanban_columns) failed: " + JSON.stringify(r));
    const payload = JSON.parse(r.result.content[0].text);
    assert.strictEqual(payload.value.length, 1);
    assert.strictEqual(payload.value[0].statusIds.length, 5);
  } finally { c.close(); }
});

// ---------------------------------------------------------------------------
// SM-31 — passthrough-object args that Claude Code's MCP bridge might
// stringify. Same tolerateJsonString-pattern as ticket_create.position
// and set_kanban_columns: every one of these tools must accept BOTH a
// nested object and the equivalent JSON-string form.

test("stdio: set_config section=definitions accepts a nested-object value (SM-31/SM-164)", async () => {
  const dir = await tmpDir();
  const c = await spawnMcp(dir);
  try {
    await c.send("tools/call", {
      name: "project_create",
      arguments: { id: "p1", name: "D", ticketPrefix: "D" }
    });
    const r = await c.send("tools/call", {
      name: "set_config",
      arguments: {
        projectId: "p1",
        section: "definitions",
        value: {
          ready: { global: [{ id: "g1", label: "Has AC", required: true }], byType: {} },
          done:  { global: [{ id: "d1", label: "Reviewed",   required: true }], byType: {} }
        }
      }
    });
    assert.ok(r.result && !r.result.isError, "set_config(definitions) failed (object input): " + JSON.stringify(r));
    const payload = JSON.parse(r.result.content[0].text);
    assert.strictEqual(payload.value.ready.global[0].id, "g1");
    assert.strictEqual(payload.value.done.global[0].id,  "d1");
  } finally { c.close(); }
});

test("stdio: set_config section=definitions accepts a JSON-string value (SM-31/SM-164)", async () => {
  const dir = await tmpDir();
  const c = await spawnMcp(dir);
  try {
    await c.send("tools/call", {
      name: "project_create",
      arguments: { id: "p1", name: "D", ticketPrefix: "D" }
    });
    const r = await c.send("tools/call", {
      name: "set_config",
      arguments: {
        projectId: "p1",
        section: "definitions",
        value: JSON.stringify({
          ready: { global: [{ id: "g2", label: "Scope clear", required: true }], byType: {} },
          done:  { global: [{ id: "d2", label: "Tests green",  required: true }], byType: {} }
        })
      }
    });
    assert.ok(r.result && !r.result.isError, "set_config(definitions) failed (string input): " + JSON.stringify(r));
    const payload = JSON.parse(r.result.content[0].text);
    assert.strictEqual(payload.value.ready.global[0].id, "g2");
  } finally { c.close(); }
});

test("stdio: project_update accepts a nested-object `patch` argument (SM-31)", async () => {
  const dir = await tmpDir();
  const c = await spawnMcp(dir);
  try {
    await c.send("tools/call", {
      name: "project_create",
      arguments: { id: "p1", name: "Old", ticketPrefix: "P" }
    });
    const r = await c.send("tools/call", {
      name: "project_update",
      arguments: { projectId: "p1", patch: { name: "Renamed", description: "via object" } }
    });
    assert.ok(r.result && !r.result.isError, "project_update failed (object input): " + JSON.stringify(r));
    const payload = JSON.parse(r.result.content[0].text);
    assert.strictEqual(payload.project.name, "Renamed");
    assert.strictEqual(payload.project.description, "via object");
  } finally { c.close(); }
});

test("stdio: project_update accepts a JSON-string `patch` argument (SM-31)", async () => {
  const dir = await tmpDir();
  const c = await spawnMcp(dir);
  try {
    await c.send("tools/call", {
      name: "project_create",
      arguments: { id: "p1", name: "Old", ticketPrefix: "P" }
    });
    const r = await c.send("tools/call", {
      name: "project_update",
      arguments: { projectId: "p1", patch: JSON.stringify({ name: "Renamed2" }) }
    });
    assert.ok(r.result && !r.result.isError, "project_update failed (string input): " + JSON.stringify(r));
    const payload = JSON.parse(r.result.content[0].text);
    assert.strictEqual(payload.project.name, "Renamed2");
  } finally { c.close(); }
});

test("stdio: project_create accepts nested-object definitions + workflow + entityTypeConfig (SM-31)", async () => {
  const dir = await tmpDir();
  const c = await spawnMcp(dir);
  try {
    const r = await c.send("tools/call", {
      name: "project_create",
      arguments: {
        id: "p1", name: "WithExtras", ticketPrefix: "P",
        definitions: {
          ready: { global: [{ id: "g1", label: "G1", required: true }], byType: {} },
          done:  { global: [{ id: "d1", label: "D1", required: true }], byType: {} }
        },
        workflow: {
          statuses: ["backlog", "ready", "in-progress", "review", "done"],
          transitions: []
        },
        entityTypeConfig: { "user-story": { showAcceptanceCriteria: true } }
      }
    });
    assert.ok(r.result && !r.result.isError, "project_create failed: " + JSON.stringify(r));
    const payload = JSON.parse(r.result.content[0].text);
    assert.strictEqual(payload.snapshot.project.definitions.ready.global[0].id, "g1");
    assert.strictEqual(payload.snapshot.project.entityTypeConfig["user-story"].showAcceptanceCriteria, true);
  } finally { c.close(); }
});

test("stdio: project_create accepts JSON-string definitions + workflow + entityTypeConfig (SM-31)", async () => {
  const dir = await tmpDir();
  const c = await spawnMcp(dir);
  try {
    const r = await c.send("tools/call", {
      name: "project_create",
      arguments: {
        id: "p1", name: "WithExtras2", ticketPrefix: "P",
        definitions: JSON.stringify({
          ready: { global: [{ id: "g2", label: "G2", required: true }], byType: {} },
          done:  { global: [{ id: "d2", label: "D2", required: true }], byType: {} }
        }),
        workflow: JSON.stringify({
          statuses: ["backlog", "done"],
          transitions: []
        }),
        entityTypeConfig: JSON.stringify({ "bug": { showDefinitionOfReady: false } })
      }
    });
    assert.ok(r.result && !r.result.isError, "project_create failed (string args): " + JSON.stringify(r));
    const payload = JSON.parse(r.result.content[0].text);
    assert.strictEqual(payload.snapshot.project.definitions.ready.global[0].id, "g2");
    assert.strictEqual(payload.snapshot.project.entityTypeConfig.bug.showDefinitionOfReady, false);
  } finally { c.close(); }
});

test("stdio: set_config section=link_types accepts a JSON-string value (SM-46/SM-164)", async () => {
  const dir = await tmpDir();
  const c = await spawnMcp(dir);
  try {
    const created = await c.send("tools/call", {
      name: "project_create",
      arguments: { id: "p1", name: "P", ticketPrefix: "P" }
    });
    assert.ok(created.result && !created.result.isError);
    // The MCP bridge stringifies arrays passed to loose params. set_config's
    // value uses tolerateJsonString so stringified input survives.
    const r = await c.send("tools/call", {
      name: "set_config",
      arguments: {
        projectId: "p1",
        section: "link_types",
        value: JSON.stringify([
          { id: "tests", label: "Tests", inverseLabel: "Tested by", semantic: "validation" }
        ])
      }
    });
    assert.ok(r.result && !r.result.isError, "set_config(link_types) failed: " + JSON.stringify(r));
    const payload = JSON.parse(r.result.content[0].text);
    // SM-52: `contains` is auto-injected. Assert by id presence, not array length.
    const ids = payload.value.map(lt => lt.id).sort();
    assert.deepStrictEqual(ids, ["contains", "tests"]);
  } finally { c.close(); }
});

test("stdio: link_create + list_links_for_ticket round-trip (SM-46)", async () => {
  const dir = await tmpDir();
  const c = await spawnMcp(dir);
  try {
    await c.send("tools/call", { name: "project_create", arguments: { id: "p1", name: "P", ticketPrefix: "P" } });
    const A = JSON.parse((await c.send("tools/call", { name: "ticket_create", arguments: { projectId: "p1", type: "user-story", title: "A" } })).result.content[0].text);
    const B = JSON.parse((await c.send("tools/call", { name: "ticket_create", arguments: { projectId: "p1", type: "user-story", title: "B" } })).result.content[0].text);
    const created = await c.send("tools/call", {
      name: "link_create",
      arguments: { projectId: "p1", sourceTicketId: A.ticket.id, linkTypeId: "blocks", targetTicketId: B.ticket.id }
    });
    assert.ok(created.result && !created.result.isError, "link_create failed: " + JSON.stringify(created));
    const r = await c.send("tools/call", {
      name: "list_links_for_ticket",
      arguments: { projectId: "p1", ticketId: B.ticket.id, direction: "backward" }
    });
    const payload = JSON.parse(r.result.content[0].text);
    assert.strictEqual(payload.links.length, 1);
    assert.strictEqual(payload.links[0].label, "Blocked by");
    assert.strictEqual(payload.links[0].source.id, A.ticket.id);
  } finally { c.close(); }
});

// ---------------------------------------------------------------------------
// SM-58 — test-types tooling roundtrips
// ---------------------------------------------------------------------------

test("stdio: test_def_step_add tolerates JSON-string patch (SM-58)", async () => {
  const dir = await tmpDir();
  const c = await spawnMcp(dir);
  try {
    await c.send("tools/call", { name: "project_create", arguments: { id: "p1", name: "P", ticketPrefix: "P" } });
    const def = JSON.parse((await c.send("tools/call", {
      name: "ticket_create",
      arguments: { projectId: "p1", type: "test-definition", title: "Login" }
    })).result.content[0].text);
    // JSON-string patch (the Claude Code MCP bridge serialises nested
    // objects this way for some param shapes).
    const r = await c.send("tools/call", {
      name: "test_def_step_add",
      arguments: {
        projectId: "p1",
        ticketId:  def.ticket.id,
        patch: JSON.stringify({ step: "Open page", expectedResult: "Renders" })
      }
    });
    assert.ok(r.result && !r.result.isError, "test_def_step_add failed: " + JSON.stringify(r));
    const payload = JSON.parse(r.result.content[0].text);
    assert.strictEqual(payload.step.step, "Open page");
    assert.strictEqual(payload.step.expectedResult, "Renders");
  } finally { c.close(); }
});

test("stdio: test_exec_start + test_exec_record round-trip (SM-58)", async () => {
  const dir = await tmpDir();
  const c = await spawnMcp(dir);
  try {
    await c.send("tools/call", { name: "project_create", arguments: { id: "p1", name: "P", ticketPrefix: "P" } });
    const def = JSON.parse((await c.send("tools/call", {
      name: "ticket_create",
      arguments: { projectId: "p1", type: "test-definition", title: "Login" }
    })).result.content[0].text);
    await c.send("tools/call", {
      name: "test_def_step_add",
      arguments: { projectId: "p1", ticketId: def.ticket.id, patch: { step: "X", expectedResult: "ok" } }
    });
    // SM-94: target story + tests-link + publish before test_exec_start.
    const target = JSON.parse((await c.send("tools/call", {
      name: "ticket_create",
      arguments: { projectId: "p1", type: "user-story", title: "Target", verbose: true }
    })).result.content[0].text).ticket;
    // Check DoR items so mark_ready passes (default defs have 2 required items).
    for (const dorItem of (target.definitionOfReady && target.definitionOfReady.items) || []) {
      if (dorItem.required) {
        await c.send("tools/call", { name: "set_checklist_item",
          arguments: { projectId: "p1", ticketId: target.id, gate: "dor", itemId: dorItem.id, checked: true } });
      }
    }
    await c.send("tools/call", { name: "mark_ready",
      arguments: { projectId: "p1", ticketId: target.id } });
    await c.send("tools/call", { name: "link_create",
      arguments: { projectId: "p1", sourceTicketId: def.ticket.id,
                   targetTicketId: target.id, linkTypeId: "tests" } });
    await c.send("tools/call", { name: "publish_test_definition",
      arguments: { projectId: "p1", ticketId: def.ticket.id } });
    const start = JSON.parse((await c.send("tools/call", {
      name: "test_exec_start",
      arguments: { projectId: "p1", definitionId: def.ticket.id, opts: { env: "ci" } }
    })).result.content[0].text);
    assert.strictEqual(start.execution.type, "test-execution");
    assert.strictEqual(start.execution.env, "ci");
    const stepId = start.execution.executionSteps[0].stepId;
    const rec = JSON.parse((await c.send("tools/call", {
      name: "test_exec_record",
      arguments: { projectId: "p1", executionId: start.execution.id, stepId: stepId,
                   patch: { actualResult: "ok", status: "passed" } }
    })).result.content[0].text);
    assert.strictEqual(rec.step.status, "passed");
    assert.strictEqual(rec.effectiveOutcome, "passed");
  } finally { c.close(); }
});

test("stdio: reorder entity=tickets compact response stays small for projects with many tickets (SM-96/SM-165)", async () => {
  const dir = await tmpDir();
  const c = await spawnMcp(dir);
  try {
    await c.send("tools/call", { name: "project_create", arguments: { id: "p1", name: "Big" } });
    const ids = [];
    for (let i = 0; i < 50; i++) {
      const r = await c.send("tools/call", {
        name: "ticket_create",
        arguments: { projectId: "p1", type: "user-story", title: "T" + i }
      });
      ids.push(JSON.parse(r.result.content[0].text).ticket.id);
    }
    const reversed = ids.slice().reverse();
    const r = await c.send("tools/call", {
      name: "reorder",
      arguments: { projectId: "p1", entity: "tickets", orderedIds: reversed }
    });
    const text = r.result.content[0].text;
    // Compact response: linear in changed-tickets count, NOT in total project size.
    // 50 tickets * ~200 bytes per entry → ~10 KB. Old (verbose) shape was ~50 KB+
    // for the same project. The 20 KB cap proves linear-in-changes growth.
    assert.ok(text.length < 20000,
      "compact reorder response must be < 20KB, got " + text.length + " bytes");
    const payload = JSON.parse(text);
    assert.strictEqual(typeof payload.revision, "string");
    assert.strictEqual(typeof payload.savedAt, "number");
    assert.ok(Array.isArray(payload.reordered));
    assert.strictEqual(payload.reordered.length, 50);
    assert.strictEqual(payload.snapshot, undefined,
      "compact response must not carry snapshot");
  } finally { c.close(); }
});

test("stdio: list_tickets with releaseId filter + compact:true stays small for big projects (SM-98)", async () => {
  const dir = await tmpDir();
  const c = await spawnMcp(dir);
  try {
    await c.send("tools/call", { name: "project_create", arguments: { id: "p1", name: "Big" } });
    const rel = JSON.parse((await c.send("tools/call", {
      name: "release_create", arguments: { projectId: "p1", name: "v1" }
    })).result.content[0].text).release;
    // Create 80 tickets — half in v1, half orphan.
    for (let i = 0; i < 80; i++) {
      await c.send("tools/call", {
        name: "ticket_create",
        arguments: {
          projectId: "p1", type: "user-story", title: "T" + i,
          description: "padding ".repeat(20),   // make per-ticket payload non-trivial
          position: i % 2 === 0 ? { releaseId: rel.id } : {}
        }
      });
    }
    // Filtered compact list — only in-v1 tickets, only discovery fields.
    const r = await c.send("tools/call", {
      name: "list_tickets",
      arguments: { projectId: "p1", releaseId: rel.id, compact: true }
    });
    const text = r.result.content[0].text;
    assert.ok(text.length < 15000,
      "filtered+compact list_tickets must be < 15KB, got " + text.length + " bytes");
    const payload = JSON.parse(text);
    assert.strictEqual(payload.tickets.length, 40, "exactly the 40 in-v1 tickets");
    for (const t of payload.tickets) {
      assert.strictEqual(t.description, undefined, "compact strips description");
      assert.ok(t.id && t.ticketKey && t.title);
      assert.strictEqual(t.position.releaseId, rel.id);
    }
  } finally { c.close(); }
});

test("stdio: set_config section=governance accepts a JSON-string value (SM-94/SM-164 bridge)", async () => {
  const dir = await tmpDir();
  const c = await spawnMcp(dir);
  try {
    await c.send("tools/call", { name: "project_create",
      arguments: { id: "p1", name: "P" } });
    // Pass the governance as a JSON STRING — exercises tolerateJsonString.
    const custom = {
      gates: { CHECK_TITLE: { predicate: "ticket_field",
        args: { field: "title", check: "non_empty" } } },
      messages: { CHECK_TITLE: { title: "Title required" } },
      tool_actions: {},
      tool_warnings: {}
    };
    const r = await c.send("tools/call", { name: "set_config",
      arguments: { projectId: "p1", section: "governance", value: JSON.stringify(custom) } });
    assert.ok(r.result && !r.result.isError, "set_config(governance) roundtrip: " + JSON.stringify(r));
    const payload = JSON.parse(r.result.content[0].text);
    assert.ok(payload.value.gates.CHECK_TITLE,
      "custom gate landed in stored governance");
  } finally { c.close(); }
});

// ---------------------------------------------------------------------------

test("stdio: release_update + process_step_update accept JSON-string patch (SM-148)", async () => {
  const dir = await tmpDir();
  const c = await spawnMcp(dir);
  try {
    await c.send("tools/call", { name: "project_create", arguments: { id: "p1", name: "P" } });
    const rel = JSON.parse((await c.send("tools/call", {
      name: "release_create", arguments: { projectId: "p1", name: "v1" }
    })).result.content[0].text).release;
    const ps = JSON.parse((await c.send("tools/call", {
      name: "process_step_create", arguments: { projectId: "p1", name: "Build" }
    })).result.content[0].text).processStep;

    // The Claude Code MCP bridge serializes nested objects as JSON strings;
    // without tolerateJsonString the hasOwnProperty loop sees a string and
    // silently no-ops (+ writes an empty revision). These must apply.
    const ru = await c.send("tools/call", {
      name: "release_update",
      arguments: { projectId: "p1", releaseId: rel.id, patch: JSON.stringify({ name: "v2", status: "active" }) }
    });
    assert.ok(ru.result && !ru.result.isError, "release_update failed: " + JSON.stringify(ru));
    const updatedRel = JSON.parse(ru.result.content[0].text).release;
    assert.strictEqual(updatedRel.name, "v2", "stringified release patch must apply");
    assert.strictEqual(updatedRel.status, "active");

    const pu = await c.send("tools/call", {
      name: "process_step_update",
      arguments: { projectId: "p1", processStepId: ps.id, patch: JSON.stringify({ name: "Assemble" }) }
    });
    assert.ok(pu.result && !pu.result.isError, "process_step_update failed: " + JSON.stringify(pu));
    const updatedPs = JSON.parse(pu.result.content[0].text).processStep;
    assert.strictEqual(updatedPs.name, "Assemble", "stringified process-step patch must apply");
  } finally { c.close(); }
});

// SM-123: compact response contract over the real stdio bridge.
test("stdio: set_checklist_item is compact ({item:{id,checked}}); verbose:true → full ticket", async () => {
  const dir = await tmpDir();
  const c = await spawnMcp(dir);
  try {
    await c.send("tools/call", {
      name: "project_create",
      arguments: { id: "p1", name: "X", ticketPrefix: "P",
        definitions: {
          ready: { global: [{ id: "g1", label: "G1", required: true }], byType: {} },
          done:  { global: [{ id: "d1", label: "D1", required: true }], byType: {} }
        }
      }
    });
    const tid = JSON.parse((await c.send("tools/call", {
      name: "ticket_create",
      arguments: { projectId: "p1", type: "user-story", title: "A" }
    })).result.content[0].text).ticket.id;
    // Compact default.
    const set = JSON.parse((await c.send("tools/call", {
      name: "set_checklist_item",
      arguments: { projectId: "p1", ticketId: tid, gate: "dor", itemId: "g1", checked: true }
    })).result.content[0].text);
    assert.deepStrictEqual(set.item, { id: "g1", checked: true });
    assert.strictEqual(set.ticket, undefined, "compact: no full ticket");
    // verbose opt-in.
    const verbose = JSON.parse((await c.send("tools/call", {
      name: "set_checklist_item",
      arguments: { projectId: "p1", ticketId: tid, gate: "dor", itemId: "g1", checked: false, verbose: true }
    })).result.content[0].text);
    assert.ok(verbose.ticket && verbose.ticket.definitionOfReady, "verbose: full ticket");
  } finally { c.close(); }
});

test("stdio: ticket_get compact:true returns the summary; default stays full", async () => {
  const dir = await tmpDir();
  const c = await spawnMcp(dir);
  try {
    await c.send("tools/call", { name: "project_create", arguments: { id: "p1", name: "X", ticketPrefix: "P" } });
    const tid = JSON.parse((await c.send("tools/call", {
      name: "ticket_create",
      arguments: { projectId: "p1", type: "user-story", title: "A", description: "body" }
    })).result.content[0].text).ticket.id;
    const compact = JSON.parse((await c.send("tools/call", {
      name: "ticket_get", arguments: { projectId: "p1", ticketId: tid, compact: true }
    })).result.content[0].text);
    assert.strictEqual(compact.ticket.description, undefined);
    assert.strictEqual(compact.ticket.ticketKey, "P-1");
    const full = JSON.parse((await c.send("tools/call", {
      name: "ticket_get", arguments: { projectId: "p1", ticketId: tid }
    })).result.content[0].text);
    assert.strictEqual(full.ticket.description, "body");
  } finally { c.close(); }
});

test("stdio: next_actionable returns the ready+unblocked queue", async () => {
  const dir = await tmpDir();
  const c = await spawnMcp(dir);
  try {
    await c.send("tools/call", {
      name: "project_create",
      arguments: { id: "p1", name: "X",
        definitions: {
          ready: { global: [{ id: "g1", label: "G1", required: true }], byType: {} },
          done:  { global: [], byType: {} }
        }
      }
    });
    // A: DoR checked + ready → actionable.
    const a = JSON.parse((await c.send("tools/call", {
      name: "ticket_create", arguments: { projectId: "p1", type: "user-story", title: "A" }
    })).result.content[0].text).ticket.id;
    await c.send("tools/call", { name: "set_checklist_item",
      arguments: { projectId: "p1", ticketId: a, gate: "dor", itemId: "g1", checked: true } });
    await c.send("tools/call", { name: "mark_ready", arguments: { projectId: "p1", ticketId: a } });
    // B: backlog, DoR open → excluded.
    await c.send("tools/call", {
      name: "ticket_create", arguments: { projectId: "p1", type: "user-story", title: "B" }
    });
    const r = await c.send("tools/call", { name: "next_actionable", arguments: { projectId: "p1" } });
    assert.ok(r.result && !r.result.isError, "next_actionable failed: " + JSON.stringify(r));
    const body = JSON.parse(r.result.content[0].text);
    assert.strictEqual(body.tickets.length, 1, "only A is actionable");
    assert.strictEqual(body.tickets[0].id, a);
    assert.strictEqual(body.tickets[0].reason, "ready to pull");
  } finally { c.close(); }
});

test("stdio: generate_product_doc returns a Markdown product description", async () => {
  const dir = await tmpDir();
  const c = await spawnMcp(dir);
  try {
    await c.send("tools/call", { name: "project_create",
      arguments: { id: "p1", name: "Acme",
        definitions: { ready: { global: [], byType: {} }, done: { global: [], byType: {} } } } });
    const epic = JSON.parse((await c.send("tools/call", { name: "ticket_create",
      arguments: { projectId: "p1", type: "epic", title: "Onboarding" } })).result.content[0].text).ticket.id;
    await c.send("tools/call", { name: "ticket_create",
      arguments: { projectId: "p1", type: "user-story", title: "Signup form", position: { epicId: epic } } });
    const r = await c.send("tools/call", { name: "generate_product_doc", arguments: { projectId: "p1" } });
    assert.ok(r.result && !r.result.isError, "generate_product_doc failed: " + JSON.stringify(r));
    const body = JSON.parse(r.result.content[0].text);
    assert.ok(body.markdown.includes("## Onboarding"), "feature heading");
    assert.ok(body.markdown.includes("Signup form"), "realising story");
  } finally { c.close(); }
});

test("stdio: generate_product_doc honors the types allowlist (array arg through the bridge)", async () => {
  const dir = await tmpDir();
  const c = await spawnMcp(dir);
  try {
    await c.send("tools/call", { name: "project_create",
      arguments: { id: "p1", name: "Acme",
        definitions: { ready: { global: [], byType: {} }, done: { global: [], byType: {} } } } });
    const epic = JSON.parse((await c.send("tools/call", { name: "ticket_create",
      arguments: { projectId: "p1", type: "epic", title: "Onboarding" } })).result.content[0].text).ticket.id;
    await c.send("tools/call", { name: "ticket_create",
      arguments: { projectId: "p1", type: "user-story", title: "Signup form", position: { epicId: epic } } });
    await c.send("tools/call", { name: "ticket_create",
      arguments: { projectId: "p1", type: "bug", title: "Crash on submit" } });
    const r = await c.send("tools/call", { name: "generate_product_doc",
      arguments: { projectId: "p1", types: ["epic", "user-story"] } });
    const body = JSON.parse(r.result.content[0].text);
    assert.ok(body.markdown.includes("Signup form"), "content story present");
    assert.ok(!body.markdown.includes("Crash on submit"), "bug excluded by types allowlist");
  } finally { c.close(); }
});

test("stdio: attachment_put + attachment_get round-trips base64 through the bridge", async () => {
  const dir = await tmpDir();
  const c = await spawnMcp(dir);
  try {
    await c.send("tools/call", { name: "project_create",
      arguments: { id: "p1", name: "P",
        definitions: { ready: { global: [], byType: {} }, done: { global: [], byType: {} } } } });
    const content = Buffer.from("hello-stdio-binary").toString("base64");
    const put = JSON.parse((await c.send("tools/call", { name: "attachment_put",
      arguments: { projectId: "p1", filename: "n.txt", mimeType: "text/plain", contentBase64: content } })).result.content[0].text);
    assert.ok(put.attachment.id.startsWith("att-"));
    const got = JSON.parse((await c.send("tools/call", { name: "attachment_get",
      arguments: { attachmentId: put.attachment.id } })).result.content[0].text);
    assert.strictEqual(got.contentBase64, content, "base64 survives the JSON-RPC round-trip");
    assert.strictEqual(Buffer.from(got.contentBase64, "base64").toString("utf8"), "hello-stdio-binary");
  } finally { c.close(); }
});

// ---------------------------------------------------------------------------

test("stdio: requirement_create accepts a JSON-string sourceAnchor (SM-201 tolerateJsonString)", async () => {
  const dir = await tmpDir();
  const c = await spawnMcp(dir);
  try {
    await c.send("tools/call", { name: "project_create", arguments: { id: "p1", name: "Spec", ticketPrefix: "P" } });
    const mod = JSON.parse((await c.send("tools/call", {
      name: "spec_module_create", arguments: { projectId: "p1", title: "PRD" }
    })).result.content[0].text).ticket;

    // The real MCP bridge may stringify the nested sourceAnchor object — it
    // must survive via tolerateJsonString, not silently drop to null.
    const r = await c.send("tools/call", {
      name: "requirement_create",
      arguments: {
        projectId: "p1", moduleId: mod.id, title: "Login", sectionPath: "1",
        sourceAnchor: JSON.stringify({ attachmentId: "att-9", sectionId: "1", charStart: 0, charEnd: 42 })
      }
    });
    assert.ok(r.result && !r.result.isError, "requirement_create failed: " + JSON.stringify(r));

    const list = JSON.parse((await c.send("tools/call", {
      name: "requirement_list", arguments: { projectId: "p1", moduleId: mod.id }
    })).result.content[0].text).requirements;
    assert.strictEqual(list.length, 1);
    assert.deepStrictEqual(list[0].sourceAnchor,
      { attachmentId: "att-9", sectionId: "1", charStart: 0, charEnd: 42 },
      "sourceAnchor must survive the JSON-string bridge; got " + JSON.stringify(list[0].sourceAnchor));
  } finally { c.close(); }
});

test("stdio: get_drift_report flags an orphan requirement over the real bridge", async () => {
  const dir = await tmpDir();
  const c = await spawnMcp(dir);
  try {
    await c.send("tools/call", { name: "project_create", arguments: { id: "p1", name: "Spec", ticketPrefix: "P" } });
    const mod = JSON.parse((await c.send("tools/call", {
      name: "spec_module_create", arguments: { projectId: "p1", title: "PRD" }
    })).result.content[0].text).ticket;
    await c.send("tools/call", {
      name: "requirement_create", arguments: { projectId: "p1", moduleId: mod.id, title: "Login", sectionPath: "1" }
    });
    const r = await c.send("tools/call", { name: "get_drift_report", arguments: { projectId: "p1" } });
    assert.ok(r.result && !r.result.isError, "get_drift_report failed: " + JSON.stringify(r));
    const report = JSON.parse(r.result.content[0].text);
    assert.strictEqual(report.orphanRequirements.length, 1, "the un-realised requirement is an orphan");
    assert.strictEqual(report.summary.clean, false);
  } finally { c.close(); }
});

test("stdio: query_tickets filters by JQL over the real bridge", async () => {
  const dir = await tmpDir();
  const c = await spawnMcp(dir);
  try {
    await c.send("tools/call", { name: "project_create", arguments: { id: "p1", name: "Q", ticketPrefix: "P" } });
    await c.send("tools/call", { name: "ticket_create", arguments: { projectId: "p1", type: "user-story", title: "Alpha" } });
    await c.send("tools/call", { name: "ticket_create", arguments: { projectId: "p1", type: "bug", title: "Beta" } });
    const r = await c.send("tools/call", { name: "query_tickets", arguments: { projectId: "p1", query: "type = bug" } });
    assert.ok(r.result && !r.result.isError, "query_tickets failed: " + JSON.stringify(r));
    const body = JSON.parse(r.result.content[0].text);
    assert.strictEqual(body.count, 1);
    assert.strictEqual(body.tickets[0].title, "Beta");
    // a bad query comes back as a structured error
    const e = await c.send("tools/call", { name: "query_tickets", arguments: { projectId: "p1", query: "nope = x" } });
    assert.ok(e.result && e.result.isError, "expected isError for an unknown field");
    assert.strictEqual(JSON.parse(e.result.content[0].text).kind, "QUERY");
  } finally { c.close(); }
});

test("stdio: split_process_step accepts a JSON-string epicIds array (real-world MCP client)", async () => {
  const dir = await tmpDir();
  const c = await spawnMcp(dir);
  try {
    await c.send("tools/call", { name: "project_create", arguments: { id: "p1", name: "Sp", ticketPrefix: "P" } });
    const rel = JSON.parse((await c.send("tools/call", {
      name: "release_create", arguments: { projectId: "p1", name: "v1" }
    })).result.content[0].text).release;
    const ps = JSON.parse((await c.send("tools/call", {
      name: "process_step_create", arguments: { projectId: "p1", name: "A" }
    })).result.content[0].text).processStep;
    const epic = JSON.parse((await c.send("tools/call", {
      name: "ticket_create",
      arguments: { projectId: "p1", type: "epic", title: "E1", position: { releaseId: rel.id, processStepId: ps.id } }
    })).result.content[0].text).ticket;

    // epicIds arrives as a JSON STRING — tolerateJsonString must parse it (E20.F).
    const r = await c.send("tools/call", {
      name: "split_process_step",
      arguments: { projectId: "p1", processStepId: ps.id, name: "A2", epicIds: JSON.stringify([epic.id]) }
    });
    assert.ok(r.result && !r.result.isError, "split failed: " + JSON.stringify(r));
    const body = JSON.parse(r.result.content[0].text);
    assert.strictEqual(body.movedEpics, 1);
    assert.ok(body.processStep && body.processStep.name === "A2");
    const eg = JSON.parse((await c.send("tools/call", {
      name: "ticket_get", arguments: { projectId: "p1", ticketId: epic.id }
    })).result.content[0].text).ticket;
    assert.strictEqual(eg.position.processStepId, body.processStep.id,
      "epic moved into the new step even though epicIds arrived as a string");
  } finally { c.close(); }
});

test("stdio: SM-290/291 import_tickets (rows as JSON STRING through the real zod bridge) + export_project round-trip", async () => {
  const dir = await tmpDir();
  const c = await spawnMcp(dir);
  try {
    await c.send("tools/call", {
      name: "project_create",
      arguments: { id: "p1", name: "IO", ticketPrefix: "P" }
    });
    // rows serialized as a STRING — exactly the MCP-bridge footgun that
    // tolerateJsonString exists for (E20.F).
    const imp = JSON.parse((await c.send("tools/call", {
      name: "import_tickets",
      arguments: { projectId: "p1", rows: JSON.stringify([
        { type: "user-story", title: "Bridge A" },
        { type: "bug", title: "Bridge B" }
      ]) }
    })).result.content[0].text);
    assert.deepStrictEqual(imp.applied, { created: 2, updated: 0 });
    const exp = JSON.parse((await c.send("tools/call", {
      name: "export_project",
      arguments: { projectId: "p1" }
    })).result.content[0].text);
    assert.strictEqual(exp.filename, "p1.storymap.json");
    assert.strictEqual(exp.envelope.format, "storymap-project");
    const titles = exp.envelope.snapshot.tickets.map(t => t.title);
    assert.ok(titles.includes("Bridge A") && titles.includes("Bridge B"),
      "imported tickets round-trip through the export envelope");
  } finally { c.close(); }
});

module.exports.done = (test._chain || Promise.resolve()).then(() => {
  console.log(`\n  ${passed} passed, ${failed} failed`);
});
