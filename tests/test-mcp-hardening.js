"use strict";

/**
 * SM-145 / SM-148 (S3) — MCP integrity regressions (in-process).
 *
 * - project_update must not change locked fields (ticketPrefix/ticketCounter).
 * - bulk_change_status must preserve the governance errors[] array on a gate
 *   failure (single complete_ticket returns it; bulk used to drop it).
 *
 * The JSON-string patch tolerance for release_update/process_step_update is
 * exercised through the real Zod bridge in test-mcp-stdio.js.
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Storage = require("../server/storage.js");
const core = require("../shared/core.js");
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

const HUMAN = { type: "human", id: "u1", name: "U" };

async function freshStorage() {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "storymap-mcph-"));
  const s = new Storage(dir);
  await s.init();
  return s;
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
    err.kind = parsed.kind; err.missing = parsed.missing; err.statusCode = parsed.statusCode;
    throw err;
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// project_update field-lock
// ---------------------------------------------------------------------------

test("S3: project_update cannot change ticketPrefix / ticketCounter (locked)", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "P", ticketPrefix: "AB" });
    // bump the counter by creating a ticket
    await callTool(server, "ticket_create", { projectId: "p1", type: "user-story", title: "T1" });
    const before = await callTool(server, "project_get", { projectId: "p1" });
    const counter0 = before.snapshot.project.ticketCounter;
    assert.ok(counter0 >= 1, "counter should have advanced");

    const r = await callTool(server, "project_update", {
      projectId: "p1",
      patch: { name: "Renamed", ticketPrefix: "ZZ", ticketCounter: 0 }
    });
    assert.strictEqual(r.project.name, "Renamed", "allowed field applies");
    assert.strictEqual(r.project.ticketPrefix, "AB", "ticketPrefix is locked");
    assert.strictEqual(r.project.ticketCounter, counter0, "ticketCounter is locked");
  } finally { if (s.close) s.close(); }
});

// ---------------------------------------------------------------------------
// bulk_change_status preserves governance errors[]
// ---------------------------------------------------------------------------

test("S3: bulk_change_status preserves errors[] on a governance gate failure", async () => {
  const s = await freshStorage();
  try {
    // Build a project whose workflow allows any → done with no DoR/DoD gate,
    // so the workflow check passes and the SM-93 complete_ticket gate
    // (OPEN_MODIFIES) is what fires. Governance is auto-seeded by normalize.
    let snap = core.normalizeSnapshot({
      project: {
        id: "p1", name: "P",
        workflow: {
          statuses: [
            { id: "backlog", name: "Backlog", category: "todo" },
            { id: "done", name: "Done", category: "done" }
          ],
          transitions: [
            { id: "to-done", name: "Finish", toStatus: "done", allowFromAny: true, requireGate: null }
          ]
        }
      },
      tickets: [
        { id: "t-feat", type: "user-story", title: "Feature", status: "backlog" },
        { id: "t-mod", type: "user-story", title: "Mod", status: "backlog",
          links: [{ linkTypeId: "modifies", targetTicketId: "t-feat" }] }
      ],
      releases: [], processSteps: []
    });
    await s.saveProject("p1", snap, { actor: HUMAN, op: "seed" });

    const server = buildServer(s);
    const r = await callTool(server, "bulk_change_status", {
      projectId: "p1", ticketIds: ["t-feat"], targetStatus: "done"
    });
    assert.strictEqual(r.successful.length, 0, "the gate must block the completion");
    assert.strictEqual(r.failed.length, 1);
    assert.strictEqual(r.failed[0].kind, "OPEN_MODIFIES");
    assert.ok(Array.isArray(r.failed[0].errors) && r.failed[0].errors.length >= 1,
      "the governance errors[] array must be preserved, got: " + JSON.stringify(r.failed[0].errors));
  } finally { if (s.close) s.close(); }
});

test("S3: project_update still rejects an empty name (validation kept after field-lock refactor)", async () => {
  const s = await freshStorage();
  try {
    const server = buildServer(s);
    await callTool(server, "project_create", { id: "p1", name: "P" });
    let threw = null;
    try { await callTool(server, "project_update", { projectId: "p1", patch: { name: "" } }); }
    catch (e) { threw = e; }
    assert.ok(threw, "an empty name must be rejected, not silently persisted");
    assert.strictEqual(threw.statusCode, 400);
  } finally { if (s.close) s.close(); }
});

module.exports.done = (test._chain || Promise.resolve()).then(() => {
  console.log(`\n  ${passed} passed, ${failed} failed`);
});
