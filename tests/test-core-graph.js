"use strict";

/**
 * SM-51 wave 1: pure graph algorithms over the ticket link graph.
 * Since SM-139 there is a single source (shared/core/graph.js); server and
 * frontend both resolve to it (shim + symlink), so the old mirror-parity
 * block was retired — these tests exercise the one implementation.
 */

const assert = require("assert");
const core = require("../server/core.js");
const graph = require("../server/core/graph.js");

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

// ---------------------------------------------------------------------------
// Fixture helpers
//
// We build snapshots the same way the rest of the suite does — via the
// real normalizers — so the link-type catalogue and default workflow
// match production. Tickets are stamped with explicit ids and statuses
// to make assertions readable.
// ---------------------------------------------------------------------------

const ACTOR = { type: "human", id: "u1", name: "U" };

function makeSnapshot({ tickets = [], releases = [] } = {}) {
  return core.normalizeSnapshot({
    project: { id: "p1", name: "Demo" },
    tickets: tickets,
    releases: releases,
    processSteps: []
  });
}

/**
 * Helper: make a ticket. `links` is an array of
 *   { linkTypeId, target }
 * which we turn into the canonical link shape.
 */
function mkTicket({ id, type = "user-story", status = "backlog", releaseId = null, epicId = null, links = [] }) {
  return {
    id,
    projectId: "p1",
    type,
    title: id,
    status,
    position: {
      releaseId: releaseId,
      epicId: epicId,
      processStepId: null,
      sortOrder: 0
    },
    links: links.map((l, i) => ({
      id: `ln-${id}-${i}`,
      linkTypeId: l.linkTypeId,
      targetTicketId: l.target,
      createdAt: 1700000000000,
      createdBy: ACTOR
    }))
  };
}

// ---------------------------------------------------------------------------
// criticalPath
// ---------------------------------------------------------------------------

test("criticalPath: empty snapshot → empty result", () => {
  const snap = makeSnapshot();
  const r = graph.criticalPath(snap);
  assert.deepStrictEqual(r, { path: [], length: 0 });
});

test("criticalPath: snapshot with tickets but no dependency edges → longest chain is one node", () => {
  // No blocking/precedence edges; every ticket is its own chain of length 1.
  const snap = makeSnapshot({
    tickets: [
      mkTicket({ id: "t-A" }),
      mkTicket({ id: "t-B" }),
      mkTicket({ id: "t-C" })
    ]
  });
  const r = graph.criticalPath(snap);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r.path.length, 1);
  // path is a singleton from the eligible set.
  assert.ok(["t-A", "t-B", "t-C"].indexOf(r.path[0]) >= 0);
});

test("criticalPath: linear chain A→B→C via 'blocks' → length 3, path is [A,B,C]", () => {
  const snap = makeSnapshot({
    tickets: [
      mkTicket({ id: "t-A", links: [{ linkTypeId: "blocks", target: "t-B" }] }),
      mkTicket({ id: "t-B", links: [{ linkTypeId: "blocks", target: "t-C" }] }),
      mkTicket({ id: "t-C" })
    ]
  });
  const r = graph.criticalPath(snap);
  assert.strictEqual(r.length, 3);
  assert.deepStrictEqual(r.path, ["t-A", "t-B", "t-C"]);
});

test("criticalPath: diamond A→B, A→C, B→D, C→D via 'predecessor-of' → length 3", () => {
  // Two equal-length chains: A-B-D and A-C-D. Either is a valid longest.
  const snap = makeSnapshot({
    tickets: [
      mkTicket({ id: "t-A", links: [
        { linkTypeId: "predecessor-of", target: "t-B" },
        { linkTypeId: "predecessor-of", target: "t-C" }
      ]}),
      mkTicket({ id: "t-B", links: [{ linkTypeId: "predecessor-of", target: "t-D" }] }),
      mkTicket({ id: "t-C", links: [{ linkTypeId: "predecessor-of", target: "t-D" }] }),
      mkTicket({ id: "t-D" })
    ]
  });
  const r = graph.criticalPath(snap);
  assert.strictEqual(r.length, 3);
  // Must start at A and end at D; middle is B or C.
  assert.strictEqual(r.path[0], "t-A");
  assert.strictEqual(r.path[2], "t-D");
  assert.ok(r.path[1] === "t-B" || r.path[1] === "t-C");
});

test("criticalPath: done-status tickets are excluded from the chain", () => {
  // A blocks B blocks C, but B is already 'done' — chain breaks into
  // two singletons (A alone, C alone). Edges into/out of the dropped
  // node are gone with it.
  const snap = makeSnapshot({
    tickets: [
      mkTicket({ id: "t-A", links: [{ linkTypeId: "blocks", target: "t-B" }] }),
      mkTicket({ id: "t-B", status: "done", links: [{ linkTypeId: "blocks", target: "t-C" }] }),
      mkTicket({ id: "t-C" })
    ]
  });
  const r = graph.criticalPath(snap);
  assert.strictEqual(r.length, 1);
});

test("criticalPath: opts.filterByRelease restricts the eligible set", () => {
  // Two parallel chains, one per release. Filtering picks just one. SM-78
  // requires the referenced releases to be present in the snapshot,
  // otherwise stale releaseIds are pruned to null.
  const snap = makeSnapshot({
    tickets: [
      mkTicket({ id: "t-A1", releaseId: "r-1", links: [{ linkTypeId: "blocks", target: "t-A2" }] }),
      mkTicket({ id: "t-A2", releaseId: "r-1" }),
      mkTicket({ id: "t-B1", releaseId: "r-2", links: [
        { linkTypeId: "blocks", target: "t-B2" },
        { linkTypeId: "blocks", target: "t-B3" }
      ]}),
      mkTicket({ id: "t-B2", releaseId: "r-2", links: [{ linkTypeId: "blocks", target: "t-B3" }] }),
      mkTicket({ id: "t-B3", releaseId: "r-2" })
    ],
    releases: [{ id: "r-1", name: "R1" }, { id: "r-2", name: "R2" }]
  });
  const rA = graph.criticalPath(snap, { filterByRelease: "r-1" });
  assert.strictEqual(rA.length, 2);
  assert.deepStrictEqual(rA.path, ["t-A1", "t-A2"]);

  const rB = graph.criticalPath(snap, { filterByRelease: "r-2" });
  assert.strictEqual(rB.length, 3);
  assert.deepStrictEqual(rB.path, ["t-B1", "t-B2", "t-B3"]);
});

// ---------------------------------------------------------------------------
// impactSetForTicket
// ---------------------------------------------------------------------------

test("impactSetForTicket: unknown ticket id → []", () => {
  const snap = makeSnapshot({ tickets: [mkTicket({ id: "t-A" })] });
  assert.deepStrictEqual(graph.impactSetForTicket(snap, "nope"), []);
});

test("impactSetForTicket: ticket with no outgoing dependency links → []", () => {
  const snap = makeSnapshot({ tickets: [mkTicket({ id: "t-A" })] });
  assert.deepStrictEqual(graph.impactSetForTicket(snap, "t-A"), []);
});

test("impactSetForTicket: multi-hop A→B→C returns [B, C], not including A", () => {
  const snap = makeSnapshot({
    tickets: [
      mkTicket({ id: "t-A", links: [{ linkTypeId: "blocks", target: "t-B" }] }),
      mkTicket({ id: "t-B", links: [{ linkTypeId: "blocks", target: "t-C" }] }),
      mkTicket({ id: "t-C" })
    ]
  });
  const r = graph.impactSetForTicket(snap, "t-A");
  assert.deepStrictEqual(r, ["t-B", "t-C"]);
  assert.strictEqual(r.indexOf("t-A"), -1);
});

test("impactSetForTicket: only blocking+precedence semantics count (containment/freeform ignored)", () => {
  // A 'contains' B (containment, NOT dep) and A 'relates-to' C (freeform).
  // Neither should propagate into the impact set.
  const snap = makeSnapshot({
    tickets: [
      mkTicket({ id: "t-A", links: [
        { linkTypeId: "contains", target: "t-B" },
        { linkTypeId: "relates-to", target: "t-C" },
        { linkTypeId: "blocks", target: "t-D" }
      ]}),
      mkTicket({ id: "t-B" }),
      mkTicket({ id: "t-C" }),
      mkTicket({ id: "t-D" })
    ]
  });
  assert.deepStrictEqual(graph.impactSetForTicket(snap, "t-A"), ["t-D"]);
});

test("impactSetForTicket: diamond closure deduplicates the merge node", () => {
  // A→B→D and A→C→D — D appears via two paths, must be listed once.
  const snap = makeSnapshot({
    tickets: [
      mkTicket({ id: "t-A", links: [
        { linkTypeId: "blocks", target: "t-B" },
        { linkTypeId: "blocks", target: "t-C" }
      ]}),
      mkTicket({ id: "t-B", links: [{ linkTypeId: "blocks", target: "t-D" }] }),
      mkTicket({ id: "t-C", links: [{ linkTypeId: "blocks", target: "t-D" }] }),
      mkTicket({ id: "t-D" })
    ]
  });
  const r = graph.impactSetForTicket(snap, "t-A");
  const counts = r.reduce((m, id) => { m[id] = (m[id] || 0) + 1; return m; }, {});
  assert.strictEqual(counts["t-D"], 1, "D must appear exactly once");
  assert.deepStrictEqual(r.slice().sort(), ["t-B", "t-C", "t-D"]);
});

// ---------------------------------------------------------------------------
// traceabilityFor
// ---------------------------------------------------------------------------

test("traceabilityFor: epic with 3 stories + 2 tests linking 1 story each → 3 stories, 2 tests", () => {
  const snap = makeSnapshot({
    tickets: [
      mkTicket({ id: "t-Epic", type: "epic" }),
      mkTicket({ id: "t-S1", epicId: "t-Epic" }),
      mkTicket({ id: "t-S2", epicId: "t-Epic" }),
      mkTicket({ id: "t-S3", epicId: "t-Epic" }),
      mkTicket({ id: "t-T1", type: "test", links: [{ linkTypeId: "relates-to", target: "t-S1" }] }),
      mkTicket({ id: "t-T2", type: "test-execution", links: [{ linkTypeId: "relates-to", target: "t-S2" }] }),
      // A floating test that doesn't link anything — should NOT count.
      mkTicket({ id: "t-T3", type: "test" })
    ]
  });
  const r = graph.traceabilityFor(snap, "t-Epic");
  assert.deepStrictEqual(r.stories.slice().sort(), ["t-S1", "t-S2", "t-S3"]);
  assert.deepStrictEqual(r.tests.slice().sort(), ["t-T1", "t-T2"]);
  assert.strictEqual(r.tests.indexOf("t-T3"), -1);
});

test("traceabilityFor: unknown epicId → empty", () => {
  const snap = makeSnapshot({
    tickets: [mkTicket({ id: "t-X", epicId: "t-OtherEpic" })]
  });
  assert.deepStrictEqual(graph.traceabilityFor(snap, "t-NoEpic"), { stories: [], tests: [] });
});

test("traceabilityFor: sub-epics under the parent epic are NOT counted as stories", () => {
  const snap = makeSnapshot({
    tickets: [
      mkTicket({ id: "t-Epic", type: "epic" }),
      mkTicket({ id: "t-SubEpic", type: "epic", epicId: "t-Epic" }),
      mkTicket({ id: "t-S1", epicId: "t-Epic" })
    ]
  });
  const r = graph.traceabilityFor(snap, "t-Epic");
  assert.deepStrictEqual(r.stories, ["t-S1"]);
});

test("traceabilityFor: all three test types (test, test-definition, test-execution) are recognised", () => {
  const snap = makeSnapshot({
    tickets: [
      mkTicket({ id: "t-Epic", type: "epic" }),
      mkTicket({ id: "t-S1", epicId: "t-Epic" }),
      mkTicket({ id: "t-Ta", type: "test",            links: [{ linkTypeId: "relates-to", target: "t-S1" }] }),
      mkTicket({ id: "t-Tb", type: "test-definition", links: [{ linkTypeId: "relates-to", target: "t-S1" }] }),
      mkTicket({ id: "t-Tc", type: "test-execution",  links: [{ linkTypeId: "relates-to", target: "t-S1" }] })
    ]
  });
  const r = graph.traceabilityFor(snap, "t-Epic");
  assert.deepStrictEqual(r.tests.slice().sort(), ["t-Ta", "t-Tb", "t-Tc"]);
});

test("SM-196: a requirement under an epic is NOT counted as a realising story (review fix)", () => {
  const snap = makeSnapshot({ tickets: [
    mkTicket({ id: "t-Epic", type: "epic" }),
    mkTicket({ id: "t-S1", epicId: "t-Epic" }),
    mkTicket({ id: "t-R1", type: "requirement", epicId: "t-Epic" })
  ]});
  const r = graph.traceabilityFor(snap, "t-Epic");
  assert.deepStrictEqual(r.stories, ["t-S1"]);   // requirement excluded
});

// ---------------------------------------------------------------------------
// traceCoverage (SM-202 R-6)
// ---------------------------------------------------------------------------

test("SM-202 R-6: traceCoverage classifies covered/orphan/over-covered/suspect", () => {
  const snap = makeSnapshot({ tickets: [
    mkTicket({ id: "r1", type: "requirement" }),   // 1 realises → covered
    mkTicket({ id: "r2", type: "requirement" }),   // none → orphan
    mkTicket({ id: "r3", type: "requirement" }),   // 2 realises → over-covered
    mkTicket({ id: "r4", type: "requirement" }),   // tested, not realised → suspect
    mkTicket({ id: "s1", type: "user-story",     links: [{ linkTypeId: "realises", target: "r1" }] }),
    mkTicket({ id: "s2", type: "user-story",     links: [{ linkTypeId: "realises", target: "r3" }] }),
    mkTicket({ id: "s3", type: "user-story",     links: [{ linkTypeId: "realises", target: "r3" }] }),
    mkTicket({ id: "td", type: "test-definition", links: [{ linkTypeId: "tests", target: "r4" }] })
  ]});
  const cov = graph.traceCoverage(snap);
  const byId = Object.fromEntries(cov.requirements.map(r => [r.id, r.status]));
  assert.strictEqual(byId.r1, "covered");
  assert.strictEqual(byId.r2, "orphan");
  assert.strictEqual(byId.r3, "over-covered");
  assert.strictEqual(byId.r4, "suspect");
  assert.deepStrictEqual(cov.summary, { total: 4, covered: 1, orphan: 1, overCovered: 1, suspect: 1 });
  assert.deepStrictEqual(cov.requirements.find(r => r.id === "r3").realisedBy.slice().sort(), ["s2", "s3"]);
  assert.deepStrictEqual(cov.requirements.find(r => r.id === "r4").testedBy, ["td"]);
});

test("SM-202 R-6: traceCoverage moduleId scopes to one module's requirements", () => {
  const snap = makeSnapshot({ tickets: [
    mkTicket({ id: "m1", type: "spec-module", links: [{ linkTypeId: "contains", target: "r1" }] }),
    mkTicket({ id: "r1", type: "requirement" }),
    mkTicket({ id: "r2", type: "requirement" })   // not in m1
  ]});
  const cov = graph.traceCoverage(snap, { moduleId: "m1" });
  assert.deepStrictEqual(cov.requirements.map(r => r.id), ["r1"]);
  assert.strictEqual(cov.summary.total, 1);
});

test("SM-202 R-6: traceCoverage on a snapshot with no requirements → empty", () => {
  const snap = makeSnapshot({ tickets: [mkTicket({ id: "s1", type: "user-story" })] });
  const cov = graph.traceCoverage(snap);
  assert.deepStrictEqual(cov.requirements, []);
  assert.strictEqual(cov.summary.total, 0);
});

test("SM-202 R-6 review: a realises link from a SOFT-DELETED story does not count", () => {
  const snap = makeSnapshot({ tickets: [
    mkTicket({ id: "r1", type: "requirement" }),
    Object.assign(mkTicket({ id: "s1", type: "user-story", links: [{ linkTypeId: "realises", target: "r1" }] }),
      { isDeleted: true })   // deleted implementor must not cover the requirement
  ]});
  const cov = graph.traceCoverage(snap);
  assert.strictEqual(cov.requirements.find(r => r.id === "r1").status, "orphan");
  assert.deepStrictEqual(cov.requirements.find(r => r.id === "r1").realisedBy, []);
});

// ---------------------------------------------------------------------------
// driftReport (SM-182 Phase 4 — PRD ↔ Tickets round-trip / drift)
// ---------------------------------------------------------------------------

test("SM-182: driftReport flags orphan + suspect requirements; clean=false", () => {
  const snap = makeSnapshot({ tickets: [
    mkTicket({ id: "r1", type: "requirement" }),                                                  // covered
    mkTicket({ id: "r2", type: "requirement" }),                                                  // orphan
    mkTicket({ id: "r3", type: "requirement" }),                                                  // suspect
    mkTicket({ id: "s1", type: "user-story",      links: [{ linkTypeId: "realises", target: "r1" }] }),
    mkTicket({ id: "td", type: "test-definition", links: [{ linkTypeId: "tests",    target: "r3" }] })
  ]});
  const d = graph.driftReport(snap);
  assert.deepStrictEqual(d.orphanRequirements.map(r => r.id), ["r2"]);
  assert.deepStrictEqual(d.suspectRequirements.map(r => r.id), ["r3"]);
  assert.strictEqual(d.summary.orphanRequirements, 1);
  assert.strictEqual(d.summary.suspectRequirements, 1);
  assert.strictEqual(d.summary.clean, false);
});

test("SM-182: driftReport flags dangling realises/tests links (deleted target / non-requirement)", () => {
  // normalizeSnapshot strips links to NON-EXISTENT targets, so the surviving
  // dangling cases are: target soft-deleted, and a realises whose target is not a
  // requirement. A `tests` link to a work-item (story) is the publish-gate pattern
  // and must NOT be flagged.
  const snap = makeSnapshot({ tickets: [
    mkTicket({ id: "r1", type: "requirement" }),
    mkTicket({ id: "s2", type: "user-story", links: [{ linkTypeId: "realises", target: "s5" }] }),   // realises non-req
    Object.assign(mkTicket({ id: "r2", type: "requirement" }), { isDeleted: true }),
    mkTicket({ id: "td", type: "test-definition", links: [{ linkTypeId: "tests", target: "r2" }] }), // tests deleted target
    mkTicket({ id: "tdok", type: "test-definition", links: [{ linkTypeId: "tests", target: "s5" }] }), // tests a STORY → healthy
    mkTicket({ id: "s5", type: "user-story", links: [{ linkTypeId: "realises", target: "r1" }] })    // healthy
  ]});
  const d = graph.driftReport(snap);
  const byReason = {};
  d.danglingLinks.forEach(l => { byReason[l.sourceId] = l.reason; });
  assert.strictEqual(byReason.s2, "target-not-requirement");
  assert.strictEqual(byReason.td, "target-deleted");
  assert.strictEqual(d.danglingLinks.length, 2);
  assert.ok(!d.danglingLinks.find(l => l.sourceId === "tdok"), "tests→story is the publish-gate pattern, not drift");
  assert.ok(!d.danglingLinks.find(l => l.sourceId === "s5"), "healthy realises is not dangling");
});

test("SM-182: driftReport on an empty / requirement-free snapshot → clean=true", () => {
  assert.strictEqual(graph.driftReport(makeSnapshot()).summary.clean, true);
  assert.strictEqual(graph.driftReport({}).summary.clean, true);   // defensive: no tickets array
  const noReqs = makeSnapshot({ tickets: [mkTicket({ id: "s1", type: "user-story" })] });
  assert.strictEqual(graph.driftReport(noReqs).summary.clean, true);
});

test("SM-182: driftReport detects a target-missing realises (defensive, e.g. un-normalized snapshot)", () => {
  // normalize prunes missing-target links, so simulate the un-normalized case by
  // re-attaching one after normalization — proves the defensive branch holds.
  const snap = makeSnapshot({ tickets: [ mkTicket({ id: "s1", type: "user-story" }) ] });
  snap.tickets[0].links = [{ id: "x", linkTypeId: "realises", targetTicketId: "ghost", createdAt: 1, createdBy: ACTOR }];
  const d = graph.driftReport(snap);
  assert.deepStrictEqual(d.danglingLinks, [
    { sourceId: "s1", sourceKey: snap.tickets[0].ticketKey, linkType: "realises", targetId: "ghost", reason: "target-missing" }
  ]);
});

test("SM-182: driftReport flags realises anchored on a superseded feature version", () => {
  const snap = makeSnapshot({ tickets: [
    mkTicket({ id: "rq", type: "requirement" }),
    mkTicket({ id: "epicV2", type: "epic", links: [{ linkTypeId: "supersedes", target: "epicV1" }] }),
    mkTicket({ id: "epicV1", type: "epic" }),
    // old story under the superseded V1 still carries the realises anchor
    mkTicket({ id: "oldStory", type: "user-story", epicId: "epicV1",
      links: [{ linkTypeId: "realises", target: "rq" }] }),
    // current story under V2 realises it too → that one is NOT stale
    mkTicket({ id: "newStory", type: "user-story", epicId: "epicV2",
      links: [{ linkTypeId: "realises", target: "rq" }] })
  ]});
  const d = graph.driftReport(snap);
  assert.deepStrictEqual(d.supersededTrace.map(s => s.sourceId), ["oldStory"]);
  assert.strictEqual(d.supersededTrace[0].requirementId, "rq");
  assert.strictEqual(d.summary.supersededTrace, 1);
});

test("SM-182: driftReport on a fully-covered, link-clean snapshot → clean=true", () => {
  const snap = makeSnapshot({ tickets: [
    mkTicket({ id: "r1", type: "requirement" }),
    mkTicket({ id: "s1", type: "user-story", links: [{ linkTypeId: "realises", target: "r1" }] })
  ]});
  const d = graph.driftReport(snap);
  assert.deepStrictEqual(d.orphanRequirements, []);
  assert.deepStrictEqual(d.danglingLinks, []);
  assert.deepStrictEqual(d.supersededTrace, []);
  assert.strictEqual(d.summary.clean, true);
});

test("SM-182: driftReport moduleId scopes the requirement drift to one module", () => {
  const snap = makeSnapshot({ tickets: [
    mkTicket({ id: "m1", type: "spec-module", links: [{ linkTypeId: "contains", target: "r1" }] }),
    mkTicket({ id: "r1", type: "requirement" }),   // orphan, in m1
    mkTicket({ id: "r2", type: "requirement" })    // orphan, NOT in m1 → excluded by scope
  ]});
  const d = graph.driftReport(snap, { moduleId: "m1" });
  assert.deepStrictEqual(d.orphanRequirements.map(r => r.id), ["r1"]);
});

// ---------------------------------------------------------------------------
// actionableTickets (SM-172)
// ---------------------------------------------------------------------------

test("actionableTickets: a ready, unblocked work item is returned", () => {
  const snap = makeSnapshot({ tickets: [mkTicket({ id: "t-A", status: "ready" })] });
  assert.deepStrictEqual(graph.actionableTickets(snap), ["t-A"]);
});

test("actionableTickets: epics + non-todo statuses are excluded (only todo work items)", () => {
  const snap = makeSnapshot({ tickets: [
    mkTicket({ id: "t-epic", type: "epic", status: "ready" }),
    mkTicket({ id: "t-doing", status: "in-progress" }),
    mkTicket({ id: "t-done",  status: "done" }),
    mkTicket({ id: "t-ready", status: "ready" })
  ]});
  assert.deepStrictEqual(graph.actionableTickets(snap), ["t-ready"]);
});

test("actionableTickets: blocked by a non-done predecessor → excluded; unblocked once it's done", () => {
  const mk = (blockerStatus) => makeSnapshot({ tickets: [
    mkTicket({ id: "t-A", status: blockerStatus, links: [{ linkTypeId: "blocks", target: "t-B" }] }),
    mkTicket({ id: "t-B", status: "ready" })
  ]});
  // Blocker open → B excluded (A itself is actionable iff it's todo).
  assert.deepStrictEqual(graph.actionableTickets(mk("in-progress")), []);
  // Blocker done → B actionable.
  assert.deepStrictEqual(graph.actionableTickets(mk("done")), ["t-B"]);
});

test("actionableTickets: only blocking/precedence block; relates-to / sequence do not", () => {
  const snap = makeSnapshot({ tickets: [
    mkTicket({ id: "t-rel", status: "in-progress", links: [{ linkTypeId: "relates-to",  target: "t-B" }] }),
    mkTicket({ id: "t-seq", status: "in-progress", links: [{ linkTypeId: "follows-on",   target: "t-B" }] }),
    mkTicket({ id: "t-pre", status: "in-progress", links: [{ linkTypeId: "predecessor-of", target: "t-C" }] }),
    mkTicket({ id: "t-B", status: "ready" }),
    mkTicket({ id: "t-C", status: "ready" })
  ]});
  const res = graph.actionableTickets(snap);
  assert.ok(res.indexOf("t-B") >= 0, "relates-to + follows-on do not block t-B");
  assert.ok(res.indexOf("t-C") < 0, "precedence blocks t-C");
});

test("actionableTickets: DoR gate — backlog with unchecked required DoR excluded; checked → included", () => {
  const withDor = (checked) => core.normalizeSnapshot({
    project: { id: "p1", name: "Demo" },
    tickets: [{
      id: "t-A", projectId: "p1", type: "user-story", title: "A", status: "backlog",
      position: { releaseId: null, epicId: null, processStepId: null, sortOrder: 0 },
      definitionOfReady: { items: [{ id: "d1", label: "x", required: true, checked: checked }] }
    }]
  });
  assert.deepStrictEqual(graph.actionableTickets(withDor(false)), [], "DoR open → not actionable");
  assert.deepStrictEqual(graph.actionableTickets(withDor(true)),  ["t-A"], "DoR met → actionable");
});

test("actionableTickets: opts.releaseId and opts.type filter the queue", () => {
  const snap = makeSnapshot({
    // Releases must exist or normalizePosition (SM-78) prunes the dangling ref.
    releases: [{ id: "r1", name: "R1" }, { id: "r2", name: "R2" }],
    tickets: [
      mkTicket({ id: "t-r1", status: "ready", releaseId: "r1" }),
      mkTicket({ id: "t-r2", status: "ready", releaseId: "r2" }),
      mkTicket({ id: "t-bug", status: "ready", releaseId: "r1", type: "bug" })
    ]
  });
  assert.deepStrictEqual(graph.actionableTickets(snap, { releaseId: "r1" }).sort(), ["t-bug", "t-r1"]);
  assert.deepStrictEqual(graph.actionableTickets(snap, { releaseId: "r1", type: "bug" }), ["t-bug"]);
});

test("actionableTickets: stable order by sortOrder then id", () => {
  const mkOrdered = (id, sortOrder) => {
    const t = mkTicket({ id, status: "ready" });
    t.position.sortOrder = sortOrder;
    return t;
  };
  const snap = makeSnapshot({ tickets: [mkOrdered("t-C", 5), mkOrdered("t-A", 1), mkOrdered("t-B", 1)] });
  assert.deepStrictEqual(graph.actionableTickets(snap), ["t-A", "t-B", "t-C"]);
});

test("actionableTickets: a soft-deleted blocker does not block (review nit)", () => {
  const snap = makeSnapshot({ tickets: [
    mkTicket({ id: "t-A", status: "in-progress", links: [{ linkTypeId: "blocks", target: "t-B" }] }),
    mkTicket({ id: "t-B", status: "ready" })
  ]});
  snap.tickets.find(t => t.id === "t-A").isDeleted = true;
  assert.deepStrictEqual(graph.actionableTickets(snap), ["t-B"]);
});

test("actionableTickets: a 'ready' ticket counts even if a required DoR item is later unchecked (review nit)", () => {
  const snap = core.normalizeSnapshot({
    project: { id: "p1", name: "Demo" },
    tickets: [{
      id: "t-A", projectId: "p1", type: "user-story", title: "A", status: "ready",
      position: { releaseId: null, epicId: null, processStepId: null, sortOrder: 0 },
      definitionOfReady: { items: [{ id: "d1", label: "x", required: true, checked: false }] }
    }]
  });
  assert.deepStrictEqual(graph.actionableTickets(snap), ["t-A"]);
});

// ---------------------------------------------------------------------------
// foldProductDescription (SM-176)
// ---------------------------------------------------------------------------

test("foldProductDescription: empty snapshot → no features, no orphans", () => {
  assert.deepStrictEqual(graph.foldProductDescription(makeSnapshot()), { features: [], orphans: [] });
});

test("foldProductDescription: a feature carries its (single) release; stories share it; mixed status → in-progress", () => {
  // SM-67: contained stories inherit the epic's release, so a feature lives in
  // one release. (Cross-release evolution is phase 2 / temporal links.)
  const snap = makeSnapshot({
    releases: [{ id: "r1", name: "v1" }],
    tickets: [
      mkTicket({ id: "e1", type: "epic", status: "in-progress", releaseId: "r1" }),
      mkTicket({ id: "s1", epicId: "e1", status: "done" }),
      mkTicket({ id: "s2", epicId: "e1", status: "in-progress" })
    ]
  });
  const f = graph.foldProductDescription(snap).features[0];
  assert.strictEqual(f.epic.id, "e1");
  assert.deepStrictEqual(f.release, { id: "r1", name: "v1" });
  assert.strictEqual(f.status, "in-progress");                       // mixed done + doing
  assert.deepStrictEqual(f.stories.map(s => s.id).sort(), ["s1", "s2"]);
});

test("foldProductDescription: status shipped when all stories done; planned when all todo", () => {
  const shipped = makeSnapshot({ tickets: [
    mkTicket({ id: "e", type: "epic" }),
    mkTicket({ id: "s1", epicId: "e", status: "done" }),
    mkTicket({ id: "s2", epicId: "e", status: "done" })
  ]});
  assert.strictEqual(graph.foldProductDescription(shipped).features[0].status, "shipped");
  const planned = makeSnapshot({ tickets: [
    mkTicket({ id: "e", type: "epic" }),
    mkTicket({ id: "s1", epicId: "e", status: "backlog" }),
    mkTicket({ id: "s2", epicId: "e", status: "ready" })
  ]});
  assert.strictEqual(graph.foldProductDescription(planned).features[0].status, "planned");
});

test("foldProductDescription: a linked test-definition surfaces with its derivedHealth", () => {
  const snap = makeSnapshot({ tickets: [
    mkTicket({ id: "e", type: "epic" }),
    mkTicket({ id: "s1", epicId: "e", status: "done" }),
    mkTicket({ id: "td", type: "test-definition", links: [{ linkTypeId: "tests", target: "s1" }] })
  ]});
  const td = graph.foldProductDescription(snap).features[0].tests.find(t => t.id === "td");
  assert.ok(td, "test-definition linked to a story appears in feature.tests");
  assert.strictEqual(typeof td.health, "string");                   // derivedHealth
});

test("foldProductDescription: non-epic work items with no feature land in orphans", () => {
  const snap = makeSnapshot({ tickets: [
    mkTicket({ id: "e", type: "epic" }),
    mkTicket({ id: "s1", epicId: "e", status: "done" }),
    mkTicket({ id: "loose", status: "backlog" })
  ]});
  const r = graph.foldProductDescription(snap);
  assert.deepStrictEqual(r.orphans.map(o => o.id), ["loose"]);
  assert.ok(!r.features[0].stories.some(s => s.id === "loose"));
});

test("SM-196: requirements + spec-modules are never product-doc orphans (review fix)", () => {
  const snap = makeSnapshot({ tickets: [
    mkTicket({ id: "t-R1", type: "requirement" }),
    mkTicket({ id: "t-M1", type: "spec-module" }),
    mkTicket({ id: "loose", type: "user-story" })   // a genuine orphan
  ]});
  const ids = graph.foldProductDescription(snap).orphans.map(o => o.id);
  assert.deepStrictEqual(ids, ["loose"]);
});

test("foldProductDescription: opts.releaseId scopes to features in that release; drops the rest", () => {
  const snap = makeSnapshot({
    releases: [{ id: "r1", name: "v1" }, { id: "r2", name: "v2" }],
    tickets: [
      mkTicket({ id: "e1", type: "epic", releaseId: "r1" }),
      mkTicket({ id: "s1", epicId: "e1", status: "done" }),
      mkTicket({ id: "e2", type: "epic", releaseId: "r2" }),
      mkTicket({ id: "s2", epicId: "e2", status: "done" })
    ]
  });
  const r = graph.foldProductDescription(snap, { releaseId: "r1" });
  assert.deepStrictEqual(r.features.map(f => f.epic.id), ["e1"]);    // e2 has nothing in r1
  assert.deepStrictEqual(r.features[0].stories.map(s => s.id), ["s1"]);
  assert.deepStrictEqual(r.orphans, []);                             // s2 is claimed by e2, not orphaned
});

test("foldProductDescription: opts.types filters bug/test out; epics stay, content stories + orphans kept", () => {
  const snap = makeSnapshot({ tickets: [
    mkTicket({ id: "e", type: "epic" }),
    mkTicket({ id: "s-story", epicId: "e", type: "user-story", status: "done" }),
    mkTicket({ id: "s-bug", epicId: "e", type: "bug", status: "done" }),
    mkTicket({ id: "o-story", type: "user-story", status: "backlog" }),
    mkTicket({ id: "o-bug", type: "bug", status: "backlog" })
  ]});
  const r = graph.foldProductDescription(snap, { types: ["epic", "user-story"] });
  const f = r.features.find(x => x.epic.id === "e");
  assert.ok(f, "epic feature kept");
  assert.deepStrictEqual(f.stories.map(s => s.id), ["s-story"], "bug story excluded from the feature");
  assert.deepStrictEqual(r.orphans.map(o => o.id), ["o-story"], "bug orphan excluded; user-story orphan kept");
});

test("foldProductDescription: a feature whose stories are all type-filtered out still renders (review nit)", () => {
  const snap = makeSnapshot({ tickets: [
    mkTicket({ id: "e", type: "epic" }),
    mkTicket({ id: "s-bug", epicId: "e", type: "bug", status: "done" })
  ]});
  const r = graph.foldProductDescription(snap, { types: ["epic", "user-story"] });
  const f = r.features.find(x => x.epic.id === "e");
  assert.ok(f, "epic still shown as a feature even with no surviving stories");
  assert.deepStrictEqual(f.stories, []);
  assert.strictEqual(f.status, "planned");
});

test("SM-180: a superseding epic is the feature; the superseded epic folds into its history (cross-release)", () => {
  const snap = makeSnapshot({
    releases: [{ id: "r1", name: "v1" }, { id: "r2", name: "v2" }],
    tickets: [
      mkTicket({ id: "e-old", type: "epic", releaseId: "r1" }),
      mkTicket({ id: "e-new", type: "epic", releaseId: "r2", links: [{ linkTypeId: "supersedes", target: "e-old" }] }),
      mkTicket({ id: "s-new", epicId: "e-new", type: "user-story", status: "done" }),
      mkTicket({ id: "s-old", epicId: "e-old", type: "user-story", status: "done" })
    ]
  });
  const r = graph.foldProductDescription(snap);
  assert.deepStrictEqual(r.features.map(f => f.epic.id), ["e-new"], "only the superseding epic is top-level");
  const f = r.features[0];
  assert.deepStrictEqual(f.history.map(h => h.epic.id), ["e-old"], "old epic folded into history");
  assert.strictEqual(f.history[0].release.name, "v1");
  assert.ok(!r.orphans.some(o => o.id === "s-old"), "superseded epic's stories are NOT orphans");
});

test("SM-180: a supersedes chain (V1 → V2 → V3) folds to the head with oldest-first history", () => {
  const snap = makeSnapshot({
    releases: [{ id: "r1", name: "v1" }, { id: "r2", name: "v2" }, { id: "r3", name: "v3" }],
    tickets: [
      mkTicket({ id: "v1", type: "epic", releaseId: "r1" }),
      mkTicket({ id: "v2", type: "epic", releaseId: "r2", links: [{ linkTypeId: "supersedes", target: "v1" }] }),
      mkTicket({ id: "v3", type: "epic", releaseId: "r3", links: [{ linkTypeId: "supersedes", target: "v2" }] })
    ]
  });
  const r = graph.foldProductDescription(snap);
  assert.deepStrictEqual(r.features.map(f => f.epic.id), ["v3"], "only the chain head is a feature");
  assert.deepStrictEqual(r.features[0].history.map(h => h.epic.id), ["v1", "v2"], "history oldest-first");
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

setImmediate(() => {
  console.log(`\n  ${passed} passed, ${failed} failed`);
});
