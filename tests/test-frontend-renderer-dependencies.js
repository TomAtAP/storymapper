"use strict";

/**
 * SM-50: Tests for the Dependencies-View renderer.
 *
 * The Dependencies-View is the third sight (next to Story-Map and Kanban)
 * and renders the snapshot's typed-link graph (see SM-44/45/46) as a layered
 * DAG: tickets are nodes, links are edges. Layout is Sugiyama-style with
 * longest-path layering: a node's layer = max(layer(predecessor)+1, 0).
 *
 * Tests split into:
 *   (A) Pure `computeDependencyLayout(snapshot, opts?)` — algorithmic.
 *   (B) JSDOM `mount(host, store, opts)` render smoke — structural.
 */

const assert = require("assert");
const { JSDOM } = require("jsdom");

const dom = new JSDOM(`<!doctype html><html><body><div id="host"></div></body></html>`);
global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;

const core = require("../frontend/js/core.js");
const { ProjectStore } = require("../frontend/js/store.js");
const deps = require("../frontend/js/renderer-dependencies.js");
const { DEPENDENCY_LAYOUT } = deps;

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  - ${name}`); passed++; }
  catch (err) { console.log(`  FAIL - ${name}\n         ${err.stack || err.message}`); failed++; process.exitCode = 1; }
}

const HUMAN = { type: "human", id: "u1", name: "U" };

/**
 * Build a project store with N tickets and the supplied links.
 * `linkSpec` is an array of `[sourceIndex, targetIndex, linkTypeId?]`.
 * Returns `{store, tids}` where `tids[i]` is the i-th ticket's id.
 */
function buildStoreWithGraph(ticketSpecs, linkSpec) {
  const snap = core.normalizeSnapshot({
    project: { id: "p1", name: "Deps", ticketPrefix: "P" }
  });
  const store = new ProjectStore(snap);
  store.createRelease({ name: "v1.0" }, HUMAN);
  store.createRelease({ name: "v2.0" }, HUMAN);
  const tids = [];
  for (const spec of ticketSpecs) {
    store.createTicket({
      type: spec.type || "user-story",
      title: spec.title || ("T" + tids.length),
      position: spec.releaseId ? { releaseId: spec.releaseId } : null
    }, HUMAN);
    const all = store.get().tickets.filter(t => !t.isDeleted);
    tids.push(all[all.length - 1].id);
  }
  for (const [si, ti, linkTypeId] of linkSpec) {
    store.addLink(tids[si], {
      linkTypeId: linkTypeId || "predecessor-of",
      targetTicketId: tids[ti]
    }, HUMAN);
  }
  return { store, tids };
}

// ---------------------------------------------------------------------------
// (A) Pure layout — DEPENDENCY_LAYOUT constants
// ---------------------------------------------------------------------------

test("DEPENDENCY_LAYOUT constants exposed and sane", () => {
  const required = [
    "HORIZONTAL_SPACING_PX", "VERTICAL_SPACING_PX",
    "NODE_WIDTH_PX", "NODE_HEIGHT_PX",
    "CANVAS_PADDING_PX"
  ];
  for (const k of required) {
    assert.ok(typeof DEPENDENCY_LAYOUT[k] === "number" && DEPENDENCY_LAYOUT[k] > 0,
      "missing/invalid DEPENDENCY_LAYOUT." + k);
  }
  assert.ok(DEPENDENCY_LAYOUT.HORIZONTAL_SPACING_PX >= DEPENDENCY_LAYOUT.NODE_WIDTH_PX,
    "HORIZONTAL_SPACING_PX should be >= NODE_WIDTH_PX so layers don't overlap");
});

// ---------------------------------------------------------------------------
// (A) Pure layout — computeDependencyLayout
// ---------------------------------------------------------------------------

test("layout: empty snapshot → {nodes:[], edges:[]}", () => {
  const empty = core.normalizeSnapshot({ project: { id: "p", name: "X" } });
  const layout = deps.computeDependencyLayout(empty);
  assert.deepStrictEqual(layout.nodes, []);
  assert.deepStrictEqual(layout.edges, []);
});

test("layout: linear A→B→C → A:layer0, B:layer1, C:layer2; 2 edges", () => {
  const { store, tids } = buildStoreWithGraph(
    [{ title: "A" }, { title: "B" }, { title: "C" }],
    [[0, 1], [1, 2]]
  );
  const layout = deps.computeDependencyLayout(store.get());
  assert.strictEqual(layout.nodes.length, 3);
  assert.strictEqual(layout.edges.length, 2);
  const byTid = new Map(layout.nodes.map(n => [n.id, n]));
  // Layer derived from x: layer = x / HORIZONTAL_SPACING_PX (after padding).
  const layerOf = (id) => Math.round((byTid.get(id).x - DEPENDENCY_LAYOUT.CANVAS_PADDING_PX)
                                   / DEPENDENCY_LAYOUT.HORIZONTAL_SPACING_PX);
  assert.strictEqual(layerOf(tids[0]), 0);
  assert.strictEqual(layerOf(tids[1]), 1);
  assert.strictEqual(layerOf(tids[2]), 2);
});

test("layout: diamond A→B, A→C, B→D, C→D → A:0, B+C:1, D:2; layer1 sorted by ticketKey", () => {
  const { store, tids } = buildStoreWithGraph(
    [{ title: "A" }, { title: "B" }, { title: "C" }, { title: "D" }],
    [[0, 1], [0, 2], [1, 3], [2, 3]]
  );
  const layout = deps.computeDependencyLayout(store.get());
  const byTid = new Map(layout.nodes.map(n => [n.id, n]));
  const layerOf = (id) => Math.round((byTid.get(id).x - DEPENDENCY_LAYOUT.CANVAS_PADDING_PX)
                                   / DEPENDENCY_LAYOUT.HORIZONTAL_SPACING_PX);
  assert.strictEqual(layerOf(tids[0]), 0);
  assert.strictEqual(layerOf(tids[1]), 1);
  assert.strictEqual(layerOf(tids[2]), 1);
  assert.strictEqual(layerOf(tids[3]), 2);
  // Layer 1 stable order: alphabetic by ticketKey (B's key < C's key because
  // tickets are created in order, so ticketKey order matches creation order).
  const layer1 = layout.nodes
    .filter(n => layerOf(n.id) === 1)
    .sort((a, b) => a.y - b.y);
  // Verify the alphabetic order on ticketKey holds top-to-bottom.
  const keys = layer1.map(n => n.ticketKey);
  const sortedKeys = keys.slice().sort();
  assert.deepStrictEqual(keys, sortedKeys, "layer-1 nodes should be alphabetic by ticketKey");
});

test("layout: isolated nodes (no links) all land in the isolated band marked band='isolated'", () => {
  const { store, tids } = buildStoreWithGraph(
    [{ title: "A" }, { title: "B" }, { title: "C" }],
    []
  );
  const layout = deps.computeDependencyLayout(store.get());
  assert.strictEqual(layout.nodes.length, 3);
  assert.strictEqual(layout.edges.length, 0);
  assert.strictEqual(layout.bands.connectedCount, 0, "no connected nodes");
  assert.strictEqual(layout.bands.isolatedCount, 3, "3 isolated nodes");
  for (const n of layout.nodes) {
    assert.strictEqual(n.band, "isolated", "every node is in the isolated band");
  }
  // Coordinates should be unique per node so nodes don't overlap. With the
  // grid layout, isolated nodes within ISOLATED_PER_ROW share y but differ in x.
  const coords = new Set(layout.nodes.map(n => n.x + "_" + n.y));
  assert.strictEqual(coords.size, 3, "isolated nodes get distinct (x,y)");
});

test("layout: filter type='user-story' removes epic nodes + edges touching them", () => {
  const { store, tids } = buildStoreWithGraph(
    [
      { title: "Epic1", type: "epic" },
      { title: "Story1", type: "user-story" },
      { title: "Story2", type: "user-story" }
    ],
    [[0, 1], [1, 2]]   // Epic→Story1, Story1→Story2
  );
  const layout = deps.computeDependencyLayout(store.get(), { filter: { type: "user-story" } });
  // Only stories should be visible.
  assert.strictEqual(layout.nodes.length, 2);
  for (const n of layout.nodes) {
    assert.notStrictEqual(n.id, tids[0], "epic should be filtered out");
  }
  // The Epic→Story1 edge must vanish (epic gone). Story1→Story2 survives.
  assert.strictEqual(layout.edges.length, 1);
  assert.strictEqual(layout.edges[0].sourceId, tids[1]);
  assert.strictEqual(layout.edges[0].targetId, tids[2]);
});

test("layout: filter releaseId restricts to a single release", () => {
  const snap = core.normalizeSnapshot({
    project: { id: "p1", name: "Deps", ticketPrefix: "P" }
  });
  const store = new ProjectStore(snap);
  store.createRelease({ name: "v1.0" }, HUMAN);
  store.createRelease({ name: "v2.0" }, HUMAN);
  const releases = store.get().releases;
  const rA = releases[0].id;
  const rB = releases[1].id;
  store.createTicket({ title: "InA", position: { releaseId: rA } }, HUMAN);
  store.createTicket({ title: "InB", position: { releaseId: rB } }, HUMAN);
  const layoutA = deps.computeDependencyLayout(store.get(), { filter: { releaseId: rA } });
  assert.strictEqual(layoutA.nodes.length, 1);
  assert.strictEqual(layoutA.nodes[0].title, "InA");
});

test("layout: filter search matches ticketKey OR title (case-insensitive)", () => {
  const { store } = buildStoreWithGraph(
    [{ title: "Foo Bar" }, { title: "Baz Qux" }, { title: "Quux" }],
    []
  );
  const fooMatch = deps.computeDependencyLayout(store.get(), { filter: { search: "foo" } });
  assert.strictEqual(fooMatch.nodes.length, 1);
  assert.strictEqual(fooMatch.nodes[0].title, "Foo Bar");

  // ticketKey match: ticketPrefix is "P", so P-1 etc. Search "p-" must hit all.
  const allKeys = deps.computeDependencyLayout(store.get(), { filter: { search: "P-" } });
  assert.strictEqual(allKeys.nodes.length, 3);

  // Case-insensitive title match.
  const upperBaz = deps.computeDependencyLayout(store.get(), { filter: { search: "BAZ" } });
  assert.strictEqual(upperBaz.nodes.length, 1);
  assert.strictEqual(upperBaz.nodes[0].title, "Baz Qux");
});

test("layout: soft-deleted tickets are ignored entirely", () => {
  const { store, tids } = buildStoreWithGraph(
    [{ title: "A" }, { title: "B" }],
    [[0, 1]]
  );
  store.softDeleteTicket(tids[0], HUMAN);
  const layout = deps.computeDependencyLayout(store.get());
  assert.strictEqual(layout.nodes.length, 1);
  assert.strictEqual(layout.nodes[0].id, tids[1]);
  // Edge from A is gone (source deleted).
  assert.strictEqual(layout.edges.length, 0);
});

test("layout: edge.semantic resolves via project.linkTypes (predecessor-of → precedence)", () => {
  const { store, tids } = buildStoreWithGraph(
    [{ title: "A" }, { title: "B" }],
    [[0, 1, "predecessor-of"]]
  );
  const layout = deps.computeDependencyLayout(store.get());
  assert.strictEqual(layout.edges.length, 1);
  assert.strictEqual(layout.edges[0].linkTypeId, "predecessor-of");
  assert.strictEqual(layout.edges[0].semantic, "precedence");
});

test("layout: every node carries id, ticketKey, title, status, statusCategory, x, y, w, h", () => {
  const { store } = buildStoreWithGraph([{ title: "Only" }], []);
  const layout = deps.computeDependencyLayout(store.get());
  const n = layout.nodes[0];
  for (const k of ["id", "ticketKey", "title", "status", "statusCategory", "x", "y", "w", "h"]) {
    assert.ok(Object.prototype.hasOwnProperty.call(n, k), "node missing field " + k);
  }
  assert.strictEqual(n.w, DEPENDENCY_LAYOUT.NODE_WIDTH_PX);
  assert.strictEqual(n.h, DEPENDENCY_LAYOUT.NODE_HEIGHT_PX);
  // Default workflow categorizes "backlog" as todo.
  assert.strictEqual(n.statusCategory, "todo");
});

// ---------------------------------------------------------------------------
// (B) JSDOM render smoke — mount()
// ---------------------------------------------------------------------------

test("mount: renders .deps-root containing .deps-toolbar + .deps-canvas", () => {
  const { store } = buildStoreWithGraph([{ title: "A" }, { title: "B" }], [[0, 1]]);
  const host = document.getElementById("host");
  const ctl = deps.mount(host, store, {});
  assert.ok(host.querySelector(".deps-root"), "missing .deps-root");
  assert.ok(host.querySelector(".deps-toolbar"), "missing .deps-toolbar");
  assert.ok(host.querySelector(".deps-canvas"), "missing .deps-canvas");
  ctl.unmount();
  assert.strictEqual(host.innerHTML, "", "unmount should clear host");
});

test("mount: canvas has .deps-node per ticket and .deps-edge per link", () => {
  const { store, tids } = buildStoreWithGraph(
    [{ title: "A" }, { title: "B" }, { title: "C" }],
    [[0, 1], [1, 2]]
  );
  const host = document.getElementById("host");
  const ctl = deps.mount(host, store, {});
  const nodes = host.querySelectorAll(".deps-node");
  const edges = host.querySelectorAll(".deps-edge");
  assert.strictEqual(nodes.length, 3);
  assert.strictEqual(edges.length, 2);
  // Each node has data-ticket-id pointing at a real ticket.
  const nodeIds = new Set(Array.from(nodes).map(n => n.getAttribute("data-ticket-id")));
  for (const tid of tids) assert.ok(nodeIds.has(tid), "node missing for " + tid);
  // Each edge has data-source-id and data-target-id.
  for (const e of edges) {
    assert.ok(e.getAttribute("data-source-id"), "edge missing data-source-id");
    assert.ok(e.getAttribute("data-target-id"), "edge missing data-target-id");
  }
  ctl.unmount();
});

test("mount: clicking a node fires opts.onTicketClick(ticketId)", () => {
  const { store, tids } = buildStoreWithGraph([{ title: "Only" }], []);
  const host = document.getElementById("host");
  let clickedId = null;
  const ctl = deps.mount(host, store, { onTicketClick: (id) => { clickedId = id; } });
  const node = host.querySelector(".deps-node");
  // Synthesize a click event.
  const ev = new dom.window.Event("click", { bubbles: true });
  node.dispatchEvent(ev);
  assert.strictEqual(clickedId, tids[0]);
  ctl.unmount();
});

test("mount: re-renders on store commit (e.g. new ticket added)", () => {
  const { store } = buildStoreWithGraph([{ title: "Only" }], []);
  const host = document.getElementById("host");
  const ctl = deps.mount(host, store, {});
  assert.strictEqual(host.querySelectorAll(".deps-node").length, 1);
  store.createTicket({ title: "Another" }, HUMAN);
  assert.strictEqual(host.querySelectorAll(".deps-node").length, 2);
  ctl.unmount();
});

// ---------------------------------------------------------------------------
// SM-50 follow-up — barycenter + vertical centering + isolated band
// ---------------------------------------------------------------------------

test("layout (followup): connected vs isolated are partitioned into bands", () => {
  // 3 connected (A→B, B→C) + 2 isolated.
  const { store, tids } = buildStoreWithGraph(
    [{ title: "A" }, { title: "B" }, { title: "C" }, { title: "Orphan-1" }, { title: "Orphan-2" }],
    [[0, 1], [1, 2]]
  );
  const layout = deps.computeDependencyLayout(store.get());
  assert.strictEqual(layout.bands.connectedCount, 3);
  assert.strictEqual(layout.bands.isolatedCount, 2);
  const conn = layout.nodes.filter(n => n.band === "connected").map(n => n.id);
  const iso  = layout.nodes.filter(n => n.band === "isolated").map(n => n.id);
  assert.deepStrictEqual(conn.sort(), [tids[0], tids[1], tids[2]].sort());
  assert.deepStrictEqual(iso.sort(),  [tids[3], tids[4]].sort());
});

test("layout (followup): isolated nodes sit BELOW every connected node (y > max-connected-y)", () => {
  const { store } = buildStoreWithGraph(
    [{ title: "A" }, { title: "B" }, { title: "Orphan" }],
    [[0, 1]]
  );
  const layout = deps.computeDependencyLayout(store.get());
  const connectedMaxY = Math.max(...layout.nodes.filter(n => n.band === "connected").map(n => n.y + n.h));
  const isolatedMinY  = Math.min(...layout.nodes.filter(n => n.band === "isolated").map(n => n.y));
  assert.ok(isolatedMinY > connectedMaxY,
    "isolated band starts strictly below the connected band");
  assert.ok(layout.bands.separatorY > connectedMaxY - 1
         && layout.bands.separatorY < isolatedMinY + 1,
    "separatorY sits between the two bands");
});

test("SM-162: the critical path forms a single horizontal axis (its nodes share one y)", () => {
  // Diamond: A → {B,C,D} → Sink. Every longest path is length 3, so A and Sink
  // are on every critical path. They must sit at the SAME y — the central axis —
  // and a layer-1 critical node must align with them.
  const { store, tids } = buildStoreWithGraph(
    [
      { title: "A" }, { title: "B" }, { title: "C" }, { title: "D" }, { title: "Sink" }
    ],
    [[0, 1], [0, 2], [0, 3], [1, 4], [2, 4], [3, 4]]
  );
  const layout = deps.computeDependencyLayout(store.get());
  const byId = new Map(layout.nodes.map(n => [n.id, n]));
  const A = byId.get(tids[0]), Sink = byId.get(tids[4]);
  assert.strictEqual(A.y, Sink.y, "critical-path endpoints align on the central axis");
  const layer1 = [tids[1], tids[2], tids[3]].map(id => byId.get(id));
  assert.ok(layer1.some(n => n.y === A.y), "a layer-1 critical node sits on the central axis");
});

test("SM-163: the board filter (statuses) applies in the dependency view", () => {
  const snap = core.normalizeSnapshot({
    project: { id: "p1", name: "P", ticketPrefix: "P" },
    tickets: [
      { id: "a", ticketKey: "P-1", type: "user-story", status: "backlog", title: "A",
        links: [{ id: "l1", linkTypeId: "blocks", targetTicketId: "b" }] },
      { id: "b", ticketKey: "P-2", type: "user-story", status: "done", title: "B" }
    ]
  });
  // No board filter → both tickets visible.
  assert.strictEqual(deps.computeDependencyLayout(snap, {}).nodes.length, 2);
  // Board filter "show only backlog" → the done ticket drops out of the graph.
  const filtered = deps.computeDependencyLayout(snap, {
    boardFilter: { statuses: ["backlog"], types: null, hideCompletedReleases: false }
  });
  const ids = filtered.nodes.map(n => n.id);
  assert.ok(ids.indexOf("a") >= 0, "backlog ticket kept");
  assert.ok(ids.indexOf("b") < 0, "done ticket filtered out by the board filter");
});

test("layout (followup): barycenter reduces crossings in a bipartite split", () => {
  // A0→B1, A1→B0 — without barycenter, ordering [A0,A1] vs [B0,B1] yields
  // two crossing edges. After barycenter, layer-1 reorders to [B1,B0] so
  // edges run "straight" and don't cross.
  const { store, tids } = buildStoreWithGraph(
    [
      { title: "A0" }, { title: "A1" },
      { title: "B0" }, { title: "B1" }
    ],
    [[0, 3], [1, 2]]   // A0→B1, A1→B0
  );
  const layout = deps.computeDependencyLayout(store.get());
  const byId = new Map(layout.nodes.map(n => [n.id, n]));
  const A0 = byId.get(tids[0]), A1 = byId.get(tids[1]);
  const B0 = byId.get(tids[2]), B1 = byId.get(tids[3]);
  // Sources: A0 above A1 (alphabetic). Targets should be reordered: B1 above B0
  // so each source connects to the target on its row.
  assert.ok(A0.y < A1.y, "A0 above A1 baseline");
  assert.ok(B1.y < B0.y, "barycenter put B1 (target of A0) above B0");
});

test("layout (followup): legacy `type` field on links is honored (pre-SM-44 schema)", () => {
  // Build a snapshot by hand with the legacy link shape and ensure edges are
  // created. This guards against regressions where the renderer would skip
  // links lacking `linkTypeId`.
  const snap = core.normalizeSnapshot({
    project: { id: "p1", name: "P", ticketPrefix: "P" }
  });
  // Add two tickets + one legacy-shaped link manually.
  const t1 = { id: "t-legacy-1", projectId: "p1", type: "user-story", ticketKey: "L-1", title: "L1",
    status: "backlog", position: { releaseId: null, processStepId: null, epicId: null, sortOrder: 0 },
    definitionOfReady: { items: [] }, definitionOfDone: { items: [] },
    acceptanceCriteria: [], comments: [], labels: [], links: [], isDeleted: false,
    createdAt: 1, createdBy: { type: "human", id: "u", name: "U" },
    updatedAt: 1, updatedBy: { type: "human", id: "u", name: "U" }, version: 1 };
  const t2 = Object.assign({}, t1, { id: "t-legacy-2", ticketKey: "L-2", title: "L2" });
  // Legacy link uses `type` instead of `linkTypeId`.
  t1.links = [{ id: "ln-legacy", type: "relates-to", targetTicketId: "t-legacy-2",
    createdAt: 1, createdBy: { type: "human", id: "u", name: "U" } }];
  snap.tickets = [t1, t2];
  const layout = deps.computeDependencyLayout(snap);
  assert.strictEqual(layout.edges.length, 1, "legacy link still produces an edge");
  assert.strictEqual(layout.edges[0].linkTypeId, "relates-to");
});

test("layout (followup): only-connected snapshot leaves the isolated band empty (no separator emitted)", () => {
  const { store } = buildStoreWithGraph(
    [{ title: "A" }, { title: "B" }],
    [[0, 1]]
  );
  const layout = deps.computeDependencyLayout(store.get());
  assert.strictEqual(layout.bands.isolatedCount, 0);
  // mount: separator line should not be in the DOM.
  const host = document.getElementById("host");
  host.innerHTML = "";
  deps.mount(host, store, {});
  assert.strictEqual(host.querySelectorAll(".deps-band-separator").length, 0,
    "no separator when there are no isolated nodes");
});

test("mount (followup): separator + label appear when both bands are populated", () => {
  const { store } = buildStoreWithGraph(
    [{ title: "A" }, { title: "B" }, { title: "Orphan" }],
    [[0, 1]]
  );
  const host = document.getElementById("host");
  host.innerHTML = "";
  deps.mount(host, store, {});
  assert.strictEqual(host.querySelectorAll(".deps-band-separator").length, 1, "1 separator line");
  const label = host.querySelector(".deps-band-separator-label");
  assert.ok(label, "separator label present");
  assert.ok(/Unrelated tickets/.test(label.textContent), "label says 'Unrelated tickets'");
});

test("mount (followup): .deps-hover-active toggles on the canvas with node pointerenter/leave, not bare canvas-hover", () => {
  // The dim is gated by a class the JS sets on pointerenter on a specific node
  // and clears on pointerleave. SM-161: the class lives on the .deps-canvas root
  // (nodes are an HTML overlay over the SVG edges now).
  const { store, tids } = buildStoreWithGraph(
    [{ title: "A" }, { title: "B" }],
    [[0, 1]]
  );
  const host = document.getElementById("host");
  host.innerHTML = "";
  deps.mount(host, store, {});
  const canvas = host.querySelector(".deps-canvas");
  assert.ok(canvas);
  assert.ok(!canvas.classList.contains("deps-hover-active"), "no hover-active on idle");
  const node = host.querySelector('.deps-node[data-ticket-id="' + tids[0] + '"]');
  node.dispatchEvent(new dom.window.Event("pointerenter"));
  assert.ok(canvas.classList.contains("deps-hover-active"), "hover-active after node pointerenter");
  node.dispatchEvent(new dom.window.Event("pointerleave"));
  assert.ok(!canvas.classList.contains("deps-hover-active"), "hover-active cleared on leave");
});

test("mount (followup): hover marks the TRANSITIVE forward + backward closure, not just direct neighbours", () => {
  // Chain A → B → C → D. Hovering A should highlight B, C, AND D as successors;
  // hovering D should highlight A, B, AND C as predecessors. This is the
  // "full critical path from the selected node" behaviour the user asked for
  // (previously only direct neighbours were highlighted).
  const { store, tids } = buildStoreWithGraph(
    [{ title: "A" }, { title: "B" }, { title: "C" }, { title: "D" }],
    [[0, 1], [1, 2], [2, 3]]
  );
  const host = document.getElementById("host");
  host.innerHTML = "";
  deps.mount(host, store, {});
  // Hover A.
  const nodeA = host.querySelector('.deps-node[data-ticket-id="' + tids[0] + '"]');
  nodeA.dispatchEvent(new dom.window.Event("pointerenter"));
  const succ = Array.from(host.querySelectorAll(".deps-node-succ"))
    .map(n => n.getAttribute("data-ticket-id")).sort();
  assert.deepStrictEqual(succ, [tids[1], tids[2], tids[3]].sort(),
    "all downstream nodes (B, C, D) tagged as successors of A");
  nodeA.dispatchEvent(new dom.window.Event("pointerleave"));
  // Hover D.
  const nodeD = host.querySelector('.deps-node[data-ticket-id="' + tids[3] + '"]');
  nodeD.dispatchEvent(new dom.window.Event("pointerenter"));
  const pred = Array.from(host.querySelectorAll(".deps-node-pred"))
    .map(n => n.getAttribute("data-ticket-id")).sort();
  assert.deepStrictEqual(pred, [tids[0], tids[1], tids[2]].sort(),
    "all upstream nodes (A, B, C) tagged as predecessors of D");
});

test("mount (followup): all chain edges within the closure get .deps-edge-active (not just the one touching hovered)", () => {
  const { store, tids } = buildStoreWithGraph(
    [{ title: "A" }, { title: "B" }, { title: "C" }],
    [[0, 1], [1, 2]]
  );
  const host = document.getElementById("host");
  host.innerHTML = "";
  deps.mount(host, store, {});
  const nodeA = host.querySelector('.deps-node[data-ticket-id="' + tids[0] + '"]');
  nodeA.dispatchEvent(new dom.window.Event("pointerenter"));
  const activeEdges = host.querySelectorAll(".deps-edge.deps-edge-active");
  assert.strictEqual(activeEdges.length, 2,
    "both A→B AND B→C edges glow when hovering A");
});

test("mount (followup): isolated-band nodes get the deps-node-band-isolated class", () => {
  const { store, tids } = buildStoreWithGraph(
    [{ title: "A" }, { title: "B" }, { title: "Orphan" }],
    [[0, 1]]
  );
  const host = document.getElementById("host");
  host.innerHTML = "";
  deps.mount(host, store, {});
  const orphanEl = host.querySelector('.deps-node[data-ticket-id="' + tids[2] + '"]');
  assert.ok(orphanEl, "orphan node rendered");
  assert.ok(orphanEl.classList.contains("deps-node-band-isolated"), "carries isolated band class");
  const connectedEl = host.querySelector('.deps-node[data-ticket-id="' + tids[0] + '"]');
  assert.ok(connectedEl.classList.contains("deps-node-band-connected"), "carries connected band class");
});

// ---------------------------------------------------------------------------
// SM-64 — Critical-Path button + Show-only-critical toggle + Export buttons
// ---------------------------------------------------------------------------

test("mount (SM-64): Critical-Path button marks path nodes with .deps-node-critical", () => {
  // Linear chain A→B→C→D — the critical path is the whole chain.
  const { store, tids } = buildStoreWithGraph(
    [{ title: "A" }, { title: "B" }, { title: "C" }, { title: "D" }],
    [[0, 1], [1, 2], [2, 3]]
  );
  const host = document.getElementById("host");
  host.innerHTML = "";
  deps.mount(host, store, {});

  // Pre-toggle: no nodes are marked critical.
  assert.strictEqual(host.querySelectorAll(".deps-node-critical").length, 0,
    "no critical-class nodes before toggle");

  const cpBtn = host.querySelector(".deps-action-critical-path");
  assert.ok(cpBtn, "Critical-Path button exists");
  cpBtn.dispatchEvent(new dom.window.Event("click", { bubbles: true }));

  // Post-toggle: every chain node carries the .deps-node-critical class.
  const marked = Array.from(host.querySelectorAll(".deps-node-critical"))
    .map(n => n.getAttribute("data-ticket-id")).sort();
  assert.deepStrictEqual(marked, tids.slice().sort(),
    "all 4 chain nodes are marked critical");
  // The button itself should be in toggled-state (re-query after rerender
  // since the old node reference is detached).
  const cpBtnAfter = host.querySelector(".deps-action-critical-path");
  assert.ok(cpBtnAfter.classList.contains("toggled"), "button shows toggled state");
  // Edges between consecutive path ids should also carry .deps-edge-critical.
  const criticalEdges = host.querySelectorAll(".deps-edge-critical");
  assert.strictEqual(criticalEdges.length, 3, "all 3 chain edges marked critical");
});

test("mount (SM-64): re-clicking the Critical-Path button clears the highlight", () => {
  const { store } = buildStoreWithGraph(
    [{ title: "A" }, { title: "B" }, { title: "C" }],
    [[0, 1], [1, 2]]
  );
  const host = document.getElementById("host");
  host.innerHTML = "";
  deps.mount(host, store, {});
  const cpBtn = host.querySelector(".deps-action-critical-path");
  // First click: highlight on.
  cpBtn.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  assert.ok(host.querySelectorAll(".deps-node-critical").length > 0, "highlight on after click 1");
  // Re-click: highlight off.
  const cpBtn2 = host.querySelector(".deps-action-critical-path");   // rerender created a fresh node
  cpBtn2.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  assert.strictEqual(host.querySelectorAll(".deps-node-critical").length, 0,
    "highlight cleared on re-click");
  assert.strictEqual(host.querySelectorAll(".deps-edge-critical").length, 0,
    "no critical-edges remain");
  const cpBtn3 = host.querySelector(".deps-action-critical-path");
  assert.ok(!cpBtn3.classList.contains("toggled"), "button no longer toggled");
});

test("mount (SM-64): Show-only-critical filters visible nodes down to the path", () => {
  // A→B→C is the path; X is an off-path isolated extra. After toggle, only
  // A/B/C should be in the canvas.
  const { store, tids } = buildStoreWithGraph(
    [{ title: "A" }, { title: "B" }, { title: "C" }, { title: "X" }],
    [[0, 1], [1, 2]]
  );
  const host = document.getElementById("host");
  host.innerHTML = "";
  deps.mount(host, store, {});
  assert.strictEqual(host.querySelectorAll(".deps-node").length, 4, "4 nodes before toggle");

  const onlyBtn = host.querySelector(".deps-action-critical-only");
  assert.ok(onlyBtn, "Show-only-critical button exists");
  onlyBtn.dispatchEvent(new dom.window.Event("click", { bubbles: true }));

  const visible = Array.from(host.querySelectorAll(".deps-node"))
    .map(n => n.getAttribute("data-ticket-id")).sort();
  assert.deepStrictEqual(visible, [tids[0], tids[1], tids[2]].sort(),
    "only path nodes remain in canvas");
  // Off-path node X is gone.
  assert.strictEqual(
    host.querySelector('.deps-node[data-ticket-id="' + tids[3] + '"]'),
    null, "off-path node X is removed");
  const onlyBtn2 = host.querySelector(".deps-action-critical-only");
  assert.ok(onlyBtn2.classList.contains("toggled"), "Show-only button shows toggled state");
});

test("mount (SM-64): re-clicking Show-only-critical restores the full graph", () => {
  const { store, tids } = buildStoreWithGraph(
    [{ title: "A" }, { title: "B" }, { title: "X" }],
    [[0, 1]]
  );
  const host = document.getElementById("host");
  host.innerHTML = "";
  deps.mount(host, store, {});
  const onlyBtn = host.querySelector(".deps-action-critical-only");
  onlyBtn.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  // After ON: 2 nodes visible (A, B).
  assert.strictEqual(host.querySelectorAll(".deps-node").length, 2);
  // Re-click → OFF.
  const onlyBtn2 = host.querySelector(".deps-action-critical-only");
  onlyBtn2.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  assert.strictEqual(host.querySelectorAll(".deps-node").length, 3,
    "X is visible again");
  const onlyBtn3 = host.querySelector(".deps-action-critical-only");
  assert.ok(!onlyBtn3.classList.contains("toggled"), "button no longer toggled");
});

test("SM-161: edges live in the SVG; nodes are shared story-cards in an HTML overlay ABOVE the SVG", () => {
  // SM-161: nodes are the shared .sm-story-card components (so the dep view
  // matches Map/Kanban + inherits the ticket-key → editor link). They live in
  // an HTML overlay that paints on top of the SVG edges.
  const { store } = buildStoreWithGraph(
    [{ title: "A" }, { title: "B" }],
    [[0, 1]]
  );
  const host = document.getElementById("host");
  host.innerHTML = "";
  deps.mount(host, store, {});
  const canvas = host.querySelector(".deps-canvas");
  const svgEl  = canvas.querySelector(".deps-svg");
  const overlay = canvas.querySelector(".deps-nodes-html");
  assert.ok(svgEl, "svg present");
  assert.ok(overlay, "html node overlay present");
  // Edges are inside the SVG's edges-layer.
  const edge = svgEl.querySelector(".deps-edge");
  assert.ok(edge && svgEl.querySelector(".deps-edges-layer").contains(edge), "edge nested in svg edges-layer");
  // Nodes are HTML divs in the overlay, each wrapping a shared story-card.
  const node = overlay.querySelector(".deps-node");
  assert.ok(node, "node in the html overlay");
  assert.ok(node.querySelector(".sm-story-card"), "node wraps the shared story-card");
  // Overlay comes AFTER the svg in DOM order → paints on top.
  const children = Array.from(canvas.children);
  assert.ok(children.indexOf(overlay) > children.indexOf(svgEl), "overlay paints above the svg");
});

test("SM-161: dep node card carries the ticket-key link to the full-page editor", () => {
  const { store, tids } = buildStoreWithGraph([{ title: "Only" }], []);
  const host = document.getElementById("host");
  host.innerHTML = "";
  deps.mount(host, store, {});
  const node = host.querySelector('.deps-node[data-ticket-id="' + tids[0] + '"]');
  const keyLink = node.querySelector("a.sm-key-link");
  assert.ok(keyLink, "ticket-key is an editor link");
  const ticket = store.get().tickets.find(t => t.id === tids[0]);
  assert.strictEqual(keyLink.getAttribute("href"),
    "/editor?projectId=" + store.get().project.id + "&ticketId=" + ticket.ticketKey);
});

test("layout (SM-64-followup): criticalPath returns ALL longest paths in `paths` for diamond ties", () => {
  // Diamond A→B, A→C, B→D, C→D — TWO longest paths (A→B→D and A→C→D).
  const coreGraph = require("../frontend/js/core/graph.js");
  const { store, tids } = buildStoreWithGraph(
    [{ title: "A" }, { title: "B" }, { title: "C" }, { title: "D" }],
    [[0, 1], [0, 2], [1, 3], [2, 3]]
  );
  const cp = coreGraph.criticalPath(store.get());
  assert.strictEqual(cp.length, 3, "longest path has length 3");
  assert.ok(Array.isArray(cp.paths), "paths field present");
  assert.strictEqual(cp.paths.length, 2, "diamond yields two longest paths");
  // Each path is A→B→D or A→C→D.
  for (const p of cp.paths) {
    assert.strictEqual(p[0], tids[0], "path starts at A");
    assert.strictEqual(p[2], tids[3], "path ends at D");
  }
  const middles = cp.paths.map(p => p[1]).sort();
  assert.deepStrictEqual(middles, [tids[1], tids[2]].sort(), "middle node is B in one path, C in the other");
});

test("mount (SM-64-followup): critical-path highlight includes nodes from ALL longest paths (diamond ties)", () => {
  const { store, tids } = buildStoreWithGraph(
    [{ title: "A" }, { title: "B" }, { title: "C" }, { title: "D" }],
    [[0, 1], [0, 2], [1, 3], [2, 3]]
  );
  const host = document.getElementById("host");
  host.innerHTML = "";
  deps.mount(host, store, {});
  host.querySelector(".deps-action-critical-path").dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  const critical = Array.from(host.querySelectorAll(".deps-node-critical"))
    .map(n => n.getAttribute("data-ticket-id")).sort();
  // ALL four nodes (A, B, C, D) sit on at least one longest path.
  assert.deepStrictEqual(critical, tids.slice().sort(),
    "every node on a longest path is tagged as critical");
});

test("mount (SM-64): no Export JSON / Export CSV buttons (project export lives at SM-15 scope)", () => {
  const { store } = buildStoreWithGraph(
    [{ title: "A" }, { title: "B" }],
    [[0, 1]]
  );
  const host = document.getElementById("host");
  host.innerHTML = "";
  deps.mount(host, store, {});
  assert.strictEqual(host.querySelector(".deps-action-export-json"), null,
    "Export JSON button removed");
  assert.strictEqual(host.querySelector(".deps-action-export-csv"), null,
    "Export CSV button removed");
});

// ---------------------------------------------------------------------------
// Exit reporting (loader picks this up)
// ---------------------------------------------------------------------------
module.exports = {
  done: Promise.resolve().then(() => {
    console.log(`\n  ${passed} passed, ${failed} failed`);
  })
};
