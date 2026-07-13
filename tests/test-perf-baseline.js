"use strict";

// SM-219 — unit tests for the perf-baseline fixture generator + a smoke test
// that the benchmark harness runs and produces positive timings.

const assert = require("assert");
const core = require("../shared/core.js");
const { buildLargeSnapshot } = require("./helpers/build-large-snapshot.js");
const { runBenchmark } = require("./perf-baseline.js");

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  - ${name}`); passed++; }
  catch (err) { console.log(`  FAIL - ${name}\n         ${err.stack || err.message}`); failed++; process.exitCode = 1; }
}

test("SM-219: buildLargeSnapshot is deterministic (same opts → deep-equal)", () => {
  for (const N of [100, 500, 1000]) {
    const a = buildLargeSnapshot({ tickets: N });
    const b = buildLargeSnapshot({ tickets: N });
    assert.strictEqual(JSON.stringify(a), JSON.stringify(b), "N=" + N + " must be reproducible");
  }
});

test("SM-219: the snapshot has the requested counts + a realistic structure", () => {
  const snap = buildLargeSnapshot({ tickets: 100, releases: 4, processSteps: 6, epics: 8 });
  assert.strictEqual(snap.tickets.length, 100);
  assert.strictEqual(snap.releases.length, 4);
  assert.strictEqual(snap.processSteps.length, 6);
  const epics = snap.tickets.filter((t) => t.type === "epic");
  assert.strictEqual(epics.length, 8);
  // every epic holds its stories via contains-links (SM-52 containment)
  assert.ok(epics.every((e) => e.links.some((l) => l.linkTypeId === "contains")), "epics contain children");
  const stories = snap.tickets.filter((t) => t.type === "user-story");
  assert.ok(stories.length > 0);
  assert.ok(stories.every((s) => s.acceptanceCriteria.length > 0), "stories have acceptance criteria");
  assert.ok(stories.every((s) => s.definitionOfReady.items.length > 0 && s.definitionOfDone.items.length > 0), "stories have DoR + DoD");
  // a realistic type mix
  assert.ok(snap.tickets.some((t) => t.type === "bug") && snap.tickets.some((t) => t.type === "test-definition"));
});

test("SM-219: generator output is normalize-stable (normalize is idempotent on it)", () => {
  for (const N of [100, 1000]) {
    const gen = buildLargeSnapshot({ tickets: N });
    const n1 = core.normalizeSnapshot(gen);
    const n2 = core.normalizeSnapshot(n1);
    assert.strictEqual(JSON.stringify(n1), JSON.stringify(n2), "normalize must be idempotent (N=" + N + ")");
    assert.strictEqual(n1.tickets.length, N, "normalize preserves the ticket count");
  }
});

test("SM-219: linksPerTicket adds precedence links without breaking determinism", () => {
  const a = buildLargeSnapshot({ tickets: 60, linksPerTicket: 2 });
  const b = buildLargeSnapshot({ tickets: 60, linksPerTicket: 2 });
  assert.strictEqual(JSON.stringify(a), JSON.stringify(b));
  const withPred = a.tickets.filter((t) => (t.links || []).some((l) => l.linkTypeId === "predecessor-of"));
  assert.ok(withPred.length > 0, "some work items carry precedence links");
});

test("SM-219 review: epics are clamped to the ticket budget (never exceeds `tickets`)", () => {
  const snap = buildLargeSnapshot({ tickets: 5, epics: 20 });
  assert.strictEqual(snap.tickets.length, 5, "epics > tickets must not inflate the ticket count");
  assert.ok(snap.tickets.every((t) => t.type === "epic"), "all 5 are epics when epics>=tickets");
  assert.strictEqual(snap.project.ticketCounter, 5, "ticketCounter matches the real count");
});

test("SM-219: the benchmark harness runs and reports positive median timings (smoke)", () => {
  const rows = runBenchmark({ levels: [40], runs: 2, renderRuns: 1 });
  assert.strictEqual(rows.length, 1);
  const r = rows[0];
  assert.strictEqual(r.N, 40);
  for (const k of ["normalize", "commit", "applyRemote", "applyChange", "layout", "dragMove", "render"]) {
    assert.ok(typeof r[k] === "number" && r[k] >= 0 && isFinite(r[k]), k + " must be a finite timing, got " + r[k]);
  }
  assert.ok(r.render > 0, "render must take measurable time");
});

console.log(`\n  ${passed} passed, ${failed} failed`);
