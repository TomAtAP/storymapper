"use strict";

/**
 * SM-140 — shared/ single-source bootstrap.
 *
 * Proves the newly-created shared/core.js + shared/core/graph.js (the UMD
 * single source) load in Node, expose the COMPLETE op surface (incl. the
 * 11 SM-54/58 test-ops the frontend mirror was missing), are pure (no DOM),
 * and match the current server surface 1:1 (generation-correctness guard).
 *
 * At this stage the server/frontend consumers still point at the old files —
 * SM-141 (server shims) + SM-142 (frontend symlinks) wire them up.
 */

const assert = require("assert");
const shared = require("../shared/core.js");
const sharedGraph = require("../shared/core/graph.js");
// The server modules are still the full originals here; used only as the
// reference surface to prove the generation captured everything.
const server = require("../server/core.js");
const serverGraph = require("../server/core/graph.js");

let passed = 0, failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ok  - ${name}`); passed++;
  } catch (err) {
    console.log(`  FAIL - ${name}\n         ${err.stack || err.message}`);
    failed++;
    process.exitCode = 1;
  }
}

const TEST_OPS = [
  "addTestStep", "updateTestStep", "removeTestStep", "reorderTestSteps",
  "addTestPrereq", "updateTestPrereq", "removeTestPrereq",
  "checkTestPrereq", "uncheckTestPrereq",
  "recordTestExecStep", "setTestExecOutcome",
];

test("shared/core.js exposes the 11 SM-54/58 test-ops as functions", () => {
  for (const k of TEST_OPS) {
    assert.strictEqual(typeof shared.ops[k], "function", "missing op " + k);
  }
});

test("shared/core.js op surface matches server 1:1 (generation captured everything)", () => {
  assert.deepStrictEqual(
    Object.keys(shared.ops).sort(),
    Object.keys(server.ops).sort()
  );
});

test("shared/core.js top-level export surface matches server 1:1", () => {
  assert.deepStrictEqual(
    Object.keys(shared).sort(),
    Object.keys(server).sort()
  );
});

test("shared/core.js tickets.testExecHistory is present (was missing in mirror)", () => {
  assert.strictEqual(typeof shared.tickets.testExecHistory, "function");
  assert.deepStrictEqual(
    Object.keys(shared.tickets).sort(),
    Object.keys(server.tickets).sort()
  );
});

test("shared/core.js is functional in pure Node (no DOM) — normalize + createTicket", () => {
  const snap = shared.normalizeSnapshot({ project: { id: "p1", name: "Demo" }, tickets: [], releases: [] });
  const next = shared.ops.createTicket(snap, { type: "user-story", title: "T1" }, { type: "human", id: "u1", name: "U" });
  const created = next.tickets.find(t => t.title === "T1");
  assert.ok(created, "ticket should be created");
  assert.strictEqual(created.status, "backlog");
  // diffSnapshots works over the two states
  const diff = shared.diffSnapshots(snap, next);
  assert.ok(diff, "diff produced");
});

test("shared/core.js constants intact (SCHEMA_VERSION + defaults)", () => {
  assert.strictEqual(shared.SCHEMA_VERSION, server.SCHEMA_VERSION);
  assert.deepStrictEqual(shared.DEFAULT_STATUSES, server.DEFAULT_STATUSES);
});

test("shared/core/graph.js loads, surface matches server graph 1:1", () => {
  assert.deepStrictEqual(
    Object.keys(sharedGraph).sort(),
    Object.keys(serverGraph).sort()
  );
  for (const k of Object.keys(sharedGraph)) {
    assert.strictEqual(typeof sharedGraph[k], typeof serverGraph[k]);
  }
});

test("SM-149: ops.addLink stamps the link's createdBy from the acting actor (not 'unknown')", () => {
  const ai = { type: "ai", id: "claude", name: "Claude" };
  let snap = shared.normalizeSnapshot({
    project: { id: "p1", name: "P" },
    tickets: [
      { id: "t-a", type: "user-story", title: "A" },
      { id: "t-b", type: "user-story", title: "B" }
    ],
    releases: [], processSteps: []
  });
  snap = shared.ops.addLink(snap, "t-a", { linkTypeId: "relates-to", targetTicketId: "t-b" }, ai);
  const link = snap.tickets.find(t => t.id === "t-a").links.slice(-1)[0];
  assert.ok(link, "link was added");
  assert.strictEqual(link.createdBy.type, "ai");
  assert.strictEqual(link.createdBy.id, "claude", "createdBy must reflect the actor, not the 'unknown' fallback");
});

test("SM-150: normalizeProject seeds defaults only when definitions are ABSENT", () => {
  const seeded = shared.normalizeProject({ id: "p1", name: "P" });
  assert.ok(seeded.definitions.ready.global.length > 0, "absent → seed bundled defaults");
});

test("SM-150: an explicitly EMPTY definitions object is respected (not re-seeded)", () => {
  const empty = { ready: { global: [], byType: {} }, done: { global: [], byType: {} } };
  const norm = shared.normalizeProject({ id: "p1", name: "P", definitions: empty });
  assert.strictEqual(norm.definitions.ready.global.length, 0, "empty ready kept");
  assert.strictEqual(norm.definitions.done.global.length, 0, "empty done kept");
  // And via the persisted updateProject path (normalizeProject runs on save).
  let snap = shared.normalizeSnapshot({ project: { id: "p1", name: "P" }, tickets: [], releases: [], processSteps: [] });
  snap = shared.ops.updateProject(snap, { definitions: empty }, { type: "human", id: "u1", name: "U" });
  assert.strictEqual(snap.project.definitions.ready.global.length, 0,
    "a deliberately emptied DoR must be persistable");
});

test("SM-150: promoting a contained story to type:epic strips the stale inbound contains-link", () => {
  const ai = { type: "ai", id: "claude", name: "Claude" };
  let snap = shared.normalizeSnapshot({
    project: { id: "p1", name: "P" },
    tickets: [], releases: [{ id: "r1", name: "R" }], processSteps: [{ id: "ps1", name: "PS" }]
  });
  snap = shared.ops.createTicket(snap, { type: "epic", title: "E", position: { releaseId: "r1", processStepId: "ps1" } }, ai);
  const E = snap.tickets.find(t => t.title === "E");
  snap = shared.ops.createTicket(snap, { type: "user-story", title: "S", position: { releaseId: "r1", processStepId: "ps1", epicId: E.id } }, ai);
  const S = snap.tickets.find(t => t.title === "S");
  assert.strictEqual(shared.containerEpicIdOf(snap, S.id), E.id, "story starts contained by E");

  snap = shared.ops.updateTicket(snap, S.id, { type: "epic" }, ai);
  assert.strictEqual(shared.containerEpicIdOf(snap, S.id), null, "promotion strips the inbound contains-link");
  // And it must stay unlinked through a normalize pass (no drag-back).
  snap = shared.normalizeSnapshot(snap);
  assert.strictEqual(shared.containerEpicIdOf(snap, S.id), null, "stays unlinked after normalize");
});

console.log(`\n[test-shared-core] ${passed} passed, ${failed} failed`);
