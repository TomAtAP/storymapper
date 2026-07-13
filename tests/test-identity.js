"use strict";

/**
 * SM-129 (A6) — Identity/Actor seam + authorization choke-point.
 *
 * Covers: resolveActor (header convention + anonymous default), resolveAiActor
 * (override + AI default), the pluggable authorize() hook (allow-by-default,
 * deny → 403, policy receives (actor, op, entity)), and the integration that
 * storage.saveProject / deleteProject route every write through authorize.
 *
 * IMPORTANT: identity._policy is a process-wide singleton and run.js loads
 * test files in ONE process, so every test that installs a policy MUST reset
 * it (finally) — otherwise a leaked deny-policy breaks later test files.
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const core = require("../server/core.js");
const identity = require("../server/identity.js");
const Storage = require("../server/storage.js");

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
    } finally {
      // Belt-and-suspenders: never leak a policy into the next test/file.
      identity.resetAuthorizePolicy();
    }
  };
  return (test._chain = (test._chain || Promise.resolve()).then(exec));
}

async function tmpDir() {
  return await fs.promises.mkdtemp(path.join(os.tmpdir(), "storymap-identity-"));
}

function sampleSnapshot(projectId) {
  return core.normalizeSnapshot({
    project: { id: projectId, name: "Sample", ticketPrefix: "S" },
    tickets: [], releases: [], processSteps: []
  });
}

// ---------------------------------------------------------------------------
// resolveActor — REST header convention
// ---------------------------------------------------------------------------

test("resolveActor: no request → DEFAULT_HTTP_ACTOR", () => {
  assert.deepStrictEqual(identity.resolveActor(), { type: "human", id: "http", name: "HTTP User" });
});

test("resolveActor: request without X-Actor headers → DEFAULT_HTTP_ACTOR (not 'unknown')", () => {
  const a = identity.resolveActor({ headers: { "x-origin-id": "client-abc" } });
  assert.deepStrictEqual(a, { type: "human", id: "http", name: "HTTP User" });
  assert.notStrictEqual(a.id, "unknown");
});

test("resolveActor: X-Actor-Id alone → human actor, name defaults to id", () => {
  const a = identity.resolveActor({ headers: { "x-actor-id": "alice" } });
  assert.strictEqual(a.type, "human");
  assert.strictEqual(a.id, "alice");
  assert.strictEqual(a.name, "alice");
});

test("resolveActor: full X-Actor-* headers → typed actor with sessionId", () => {
  const a = identity.resolveActor({ headers: {
    "x-actor-type": "ai",
    "x-actor-id": "claude",
    "x-actor-name": "Claude Code",
    "x-actor-session": "sess-7"
  }});
  assert.strictEqual(a.type, "ai");
  assert.strictEqual(a.id, "claude");
  assert.strictEqual(a.name, "Claude Code");
  assert.strictEqual(a.sessionId, "sess-7");
});

test("resolveActor: an identified client never degrades to 'unknown'", () => {
  const a = identity.resolveActor({ headers: { "x-actor-id": "  bob  ", "x-actor-name": "  " } });
  assert.strictEqual(a.id, "bob");      // trimmed
  assert.strictEqual(a.name, "bob");    // blank name falls back to id, not "unknown"
  assert.notStrictEqual(a.id, "unknown");
});

// ---------------------------------------------------------------------------
// resolveAiActor — MCP
// ---------------------------------------------------------------------------

test("resolveAiActor: no override → AI_ACTOR", () => {
  assert.deepStrictEqual(identity.resolveAiActor(), { type: "ai", id: "claude", name: "Claude" });
  assert.deepStrictEqual(identity.resolveAiActor({}), { type: "ai", id: "claude", name: "Claude" });
});

test("resolveAiActor: explicit args.actor override is normalized", () => {
  const a = identity.resolveAiActor({ actor: { type: "human", id: "u9", name: "Nine" } });
  assert.strictEqual(a.type, "human");
  assert.strictEqual(a.id, "u9");
  assert.strictEqual(a.name, "Nine");
});

test("REST and MCP defaults are the same shape {type,id,name}", () => {
  const keys = (o) => Object.keys(o).sort();
  assert.deepStrictEqual(keys(identity.DEFAULT_HTTP_ACTOR), ["id", "name", "type"]);
  assert.deepStrictEqual(keys(identity.AI_ACTOR), ["id", "name", "type"]);
});

// ---------------------------------------------------------------------------
// authorize — pluggable choke-point
// ---------------------------------------------------------------------------

test("authorize: default policy allows everything (returns true, no throw)", () => {
  assert.strictEqual(identity.authorize({ id: "x" }, "ticket_create", { projectId: "p" }), true);
});

test("authorize: policy receives (actor, op, entity)", () => {
  const seen = [];
  identity.setAuthorizePolicy((actor, op, entity) => { seen.push({ actor, op, entity }); return true; });
  try {
    identity.authorize({ id: "alice" }, "ticket_update", { projectId: "p1" });
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].actor.id, "alice");
    assert.strictEqual(seen[0].op, "ticket_update");
    assert.deepStrictEqual(seen[0].entity, { projectId: "p1" });
  } finally {
    identity.resetAuthorizePolicy();
  }
});

test("authorize: a denying policy throws { statusCode: 403, kind: 'AUTHZ' }", () => {
  identity.setAuthorizePolicy(() => false);
  try {
    let err = null;
    try { identity.authorize({ id: "x" }, "ticket_delete", {}); }
    catch (e) { err = e; }
    assert.ok(err, "expected a throw");
    assert.strictEqual(err.statusCode, 403);
    assert.strictEqual(err.kind, "AUTHZ");
  } finally {
    identity.resetAuthorizePolicy();
  }
});

test("resetAuthorizePolicy restores allow-all", () => {
  identity.setAuthorizePolicy(() => false);
  identity.resetAuthorizePolicy();
  assert.strictEqual(identity.authorize({ id: "x" }, "any", {}), true);
});

// ---------------------------------------------------------------------------
// Integration — storage routes every write through authorize
// ---------------------------------------------------------------------------

test("storage.saveProject calls authorize with (actor, op, {projectId, snapshot})", async () => {
  const dir = await tmpDir();
  const s = new Storage(dir); await s.init();
  const calls = [];
  identity.setAuthorizePolicy((actor, op, entity) => { calls.push({ actor, op, entity }); return true; });
  try {
    await s.saveProject("p1", sampleSnapshot("p1"), { actor: { type: "human", id: "alice", name: "Alice" }, op: "project_create" });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].actor.id, "alice");
    assert.strictEqual(calls[0].op, "project_create");
    assert.strictEqual(calls[0].entity.projectId, "p1");
    assert.ok(calls[0].entity.snapshot && calls[0].entity.snapshot.project, "entity carries the normalized snapshot");
  } finally {
    identity.resetAuthorizePolicy();
    s.close();
  }
});

test("storage.saveProject: a denying policy aborts the save (403, no revision written)", async () => {
  const dir = await tmpDir();
  const s = new Storage(dir); await s.init();
  identity.setAuthorizePolicy(() => false);
  try {
    let err = null;
    try { await s.saveProject("p1", sampleSnapshot("p1"), { actor: { id: "x" }, op: "project_create" }); }
    catch (e) { err = e; }
    assert.ok(err, "expected save to reject");
    assert.strictEqual(err.statusCode, 403);
    // Reset so we can read back; the denied save must not have persisted.
    identity.resetAuthorizePolicy();
    const loaded = await s.loadProject("p1");
    assert.strictEqual(loaded, null, "denied save must not persist the project");
    assert.deepStrictEqual(await s.listRevisions("p1"), [], "denied save must not write a revision");
  } finally {
    identity.resetAuthorizePolicy();
    s.close();
  }
});

test("storage.deleteProject routes through authorize (deny → 403, project stays)", async () => {
  const dir = await tmpDir();
  const s = new Storage(dir); await s.init();
  try {
    await s.saveProject("p1", sampleSnapshot("p1"), { actor: { id: "a" }, op: "project_create" });
    identity.setAuthorizePolicy(() => false);
    let err = null;
    try { await s.deleteProject("p1", { actor: { id: "a" } }); }
    catch (e) { err = e; }
    assert.ok(err, "expected delete to reject");
    assert.strictEqual(err.statusCode, 403);
    identity.resetAuthorizePolicy();
    assert.ok(await s.loadProject("p1"), "denied delete must leave the project intact");
  } finally {
    identity.resetAuthorizePolicy();
    s.close();
  }
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

module.exports.done = (test._chain || Promise.resolve()).then(() => {
  identity.resetAuthorizePolicy();
  console.log(`\n  ${passed} passed, ${failed} failed`);
});
