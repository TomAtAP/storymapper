"use strict";

// SM-15 — unit tests for the pure project export/import helpers.

const assert = require("assert");
const io = require("../frontend/js/project-io.js");

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  - ${name}`); passed++; }
  catch (err) { console.log(`  FAIL - ${name}\n         ${err.stack || err.message}`); failed++; process.exitCode = 1; }
}

const SNAP = {
  project: { id: "proj-a", name: "Project A", ticketPrefix: "PA" },
  tickets: [{ id: "t1", title: "x" }],
  releases: [{ id: "r1", name: "v1" }],
  processSteps: [{ id: "p1", name: "Build" }]
};

test("serializeProject wraps the snapshot in the export envelope", () => {
  const txt = io.serializeProject(SNAP);
  const obj = JSON.parse(txt);
  assert.strictEqual(obj.format, "storymap-project");
  assert.strictEqual(obj.version, 1);
  assert.strictEqual(obj.exportedAt, undefined, "no timestamp unless supplied");
  assert.deepStrictEqual(obj.snapshot, SNAP);
});

test("serializeProject includes exportedAt when supplied (deterministic)", () => {
  const obj = JSON.parse(io.serializeProject(SNAP, { exportedAt: "2026-06-04T00:00:00Z" }));
  assert.strictEqual(obj.exportedAt, "2026-06-04T00:00:00Z");
});

test("exportFilename sanitizes the project id", () => {
  assert.strictEqual(io.exportFilename(SNAP), "proj-a.storymap.json");
  assert.strictEqual(io.exportFilename({ project: { id: "a b/c" } }), "a_b_c.storymap.json");
  assert.strictEqual(io.exportFilename({}), "project.storymap.json");
});

test("serialize → parse round-trips back to the snapshot", () => {
  const snap = io.parseImport(io.serializeProject(SNAP, { exportedAt: "2026-06-04T00:00:00Z" }));
  assert.deepStrictEqual(snap, SNAP);
});

test("parseImport accepts a BARE snapshot (no envelope)", () => {
  const snap = io.parseImport(JSON.stringify(SNAP));
  assert.strictEqual(snap.project.id, "proj-a");
});

test("parseImport rejects invalid JSON", () => {
  assert.throws(() => io.parseImport("{not json"), /not valid JSON/);
});

test("parseImport rejects a snapshot without project.id", () => {
  assert.throws(() => io.parseImport(JSON.stringify({ tickets: [] })), /project\.id/);
  assert.throws(() => io.parseImport(JSON.stringify({ project: {} })), /project\.id/);
});

test("parseImport rejects non-array entity collections", () => {
  assert.throws(() => io.parseImport(JSON.stringify({ project: { id: "x" }, tickets: "nope" })), /tickets must be an array/);
});

test("suggestCopyId picks the first free <id>-copy[-N]", () => {
  assert.strictEqual(io.suggestCopyId("a", []), "a-copy");
  assert.strictEqual(io.suggestCopyId("a", ["a"]), "a-copy");
  assert.strictEqual(io.suggestCopyId("a", ["a", "a-copy"]), "a-copy-2");
  assert.strictEqual(io.suggestCopyId("a", ["a", "a-copy", "a-copy-2"]), "a-copy-3");
});

test("planImport: no conflict → create under original id", () => {
  const plan = io.planImport(SNAP, ["other"], "copy");
  assert.deepStrictEqual(plan, { targetId: "proj-a", isOverwrite: false, conflict: false });
});

test("planImport: conflict + overwrite → replace existing", () => {
  const plan = io.planImport(SNAP, ["proj-a"], "overwrite");
  assert.deepStrictEqual(plan, { targetId: "proj-a", isOverwrite: true, conflict: true });
});

test("planImport: conflict + copy → fresh -copy id, not overwrite", () => {
  const plan = io.planImport(SNAP, ["proj-a"], "copy");
  assert.deepStrictEqual(plan, { targetId: "proj-a-copy", isOverwrite: false, conflict: true });
});

test("withProjectId re-pins project.id and deep-clones (no mutation)", () => {
  const next = io.withProjectId(SNAP, "renamed");
  assert.strictEqual(next.project.id, "renamed");
  assert.strictEqual(SNAP.project.id, "proj-a", "original is untouched");
  next.tickets[0].title = "changed";
  assert.strictEqual(SNAP.tickets[0].title, "x", "deep clone — nested arrays not shared");
});

setImmediate(() => { console.log(`\n  ${passed} passed, ${failed} failed`); });
