"use strict";

/**
 * SM-219 — perf baseline benchmark. NOT part of the unit suite (the filename is
 * NOT test-*.js, so tests/run.js never loads it). Run it with:  npm run perf
 *
 * Measures the hot paths the perf audit flagged, at N = 100 / 500 / 1000 tickets,
 * reporting the MEDIAN of several runs (a warmup run is discarded):
 *   normalize   core.normalizeSnapshot(snap)        — runs on every commit + WS push
 *   commit      store.updateTicket(...) → _commit   — a local edit (op + normalize)
 *   applyRemote store.applyRemote(sameSnap)         — WS-echo no-op (JSON.stringify deepEqual)
 *   layout      computeStoryMapLayout(snap)         — pure story-map layout
 *   render      storymap.mount(host, store) (JSDOM) — a full first renderInto
 *
 * The follow-up optimisation stories (SM-220/221/222) measure against these
 * numbers — see fixtures/PERF-BASELINE.md. `runBenchmark(opts)` is exported so a
 * smoke test can drive a tiny run; it saves/restores any pre-existing JSDOM
 * globals so it is safe to call from inside the test suite.
 */

const { performance } = require("perf_hooks");
const core = require("../shared/core.js");
const { ProjectStore } = require("../frontend/js/store.js");
const { buildLargeSnapshot } = require("./helpers/build-large-snapshot.js");

const N_LEVELS = [100, 500, 1000];
const RUNS = 7;                                  // median of ≥5 (a 6th/7th smooths outliers)
const RENDER_RUNS = 5;                           // render is the slowest — fewer runs
const BATCH_LIGHT = 20;                          // inner-batch for sub-ms ops (normalize/layout)
const BATCH_MEDIUM = 5;                          // inner-batch for ~ms ops (commit/applyRemote)
const ACTOR = { type: "human", id: "perf", name: "Perf" };

function median(xs) { const s = xs.slice().sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; }
// `batch` calls per timed sample lifts sub-millisecond ops above the timer's
// noise floor; the per-call median is returned. Default batch=1 (heavy ops).
function measure(fn, runs, batch) {
  batch = batch || 1;
  fn();                                          // warmup (JIT + caches), discarded
  const t = [];
  for (let i = 0; i < runs; i++) {
    const a = performance.now();
    for (let b = 0; b < batch; b++) fn();
    t.push((performance.now() - a) / batch);
  }
  return median(t);
}

function runBenchmark(opts) {
  opts = opts || {};
  const levels = opts.levels || N_LEVELS;
  const runs = opts.runs || RUNS;
  const renderRuns = opts.renderRuns || Math.min(runs, RENDER_RUNS);

  const prev = { window: global.window, document: global.document, HTMLElement: global.HTMLElement, performance: global.performance };
  const { JSDOM } = require("jsdom");
  const dom = new JSDOM("<!doctype html><html><body><div id='host'></div></body></html>", { pretendToBeVisual: true });
  global.window = dom.window;
  global.document = dom.window.document;
  global.HTMLElement = dom.window.HTMLElement;
  global.performance = performance;
  try {
    const storymap = require("../frontend/js/renderer-storymap.js");
    const rows = [];
    for (const N of levels) {
      const raw = buildLargeSnapshot({ tickets: N });
      const snap = core.normalizeSnapshot(raw);
      const store = new ProjectStore(snap);
      const aStory = snap.tickets.find((t) => t.type === "user-story") || snap.tickets[0];
      const host = dom.window.document.getElementById("host");

      // SM-220: two distinct "real change" snapshots for applyRemote — each
      // edits one ticket + bumps its version, so the signal differs and the
      // fast path (skip deepEqual) fires. Alternating A/B means every sampled
      // call differs from the just-committed state (otherwise the 2nd call onward
      // would be a no-op echo). This is the COMMON WS-push case (an MCP /
      // other-client edit arriving); `applyRemote` (echo) is the own-echo no-op
      // already filtered upstream by originId.
      const mkChanged = (suffix, bump) => {
        const c = core.normalizeSnapshot(JSON.parse(JSON.stringify(snap)));
        c.tickets[0].title = c.tickets[0].title + suffix;
        c.tickets[0].version = (c.tickets[0].version | 0) + bump;
        return c;
      };
      const changedA = mkChanged(" *", 1), changedB = mkChanged(" #", 2);
      const changeStore = new ProjectStore(snap);
      let toggle = 0;

      // SM-221: one drag pointermove = ctrl.setDragProjection → _rerender →
      // renderInto. With the drag-layout cache the base layout is NOT recomputed
      // per move (the `layout` column is what's saved); the remaining per-move
      // cost is the fresh grid DOM build + morph (SM-223's target). Cycling the
      // insertion index defeats the identical-projection fast-path so each call
      // genuinely re-renders.
      const dragStore = new ProjectStore(snap);
      const epic = snap.tickets.find((t) => t.type === "epic");
      const epicStories = epic ? core.tickets.storiesInEpic(snap, epic.id) : [];
      const dragStory = epicStories[0] || aStory;
      host.innerHTML = "";
      const dragCtrl = storymap.mount(host, dragStore);
      let mv = 0;

      const row = {
        N: N,
        normalize:   measure(() => core.normalizeSnapshot(raw), runs, BATCH_LIGHT),
        commit:      measure(() => store.updateTicket(aStory.id, { description: "edit" }, ACTOR), runs, BATCH_MEDIUM),
        applyRemote: measure(() => store.applyRemote(snap), runs, BATCH_MEDIUM),
        applyChange: measure(() => changeStore.applyRemote((toggle++ & 1) ? changedA : changedB), runs, BATCH_MEDIUM),
        layout:      measure(() => storymap.computeStoryMapLayout(snap), runs, BATCH_LIGHT),
        dragMove:    epic ? measure(() => dragCtrl.setDragProjection({
                       ticketId: dragStory.id, target: { type: "epic", epicId: epic.id }, insertionIndex: (mv++ % 5)
                     }), renderRuns) : 0,
        render:      measure(() => {
          host.innerHTML = "";
          const ctrl = storymap.mount(host, store);
          if (typeof ctrl === "function") ctrl();   // unmount (unsubscribe) immediately
        }, renderRuns)
      };
      if (typeof dragCtrl === "function") dragCtrl();   // unmount the drag store's view
      rows.push(row);
    }
    return rows;
  } finally {
    try { dom.window.close(); } catch (_e) {}
    global.window = prev.window;
    global.document = prev.document;
    global.HTMLElement = prev.HTMLElement;
    global.performance = prev.performance;
  }
}

function printTable(rows) {
  const cols = ["N", "normalize", "commit", "applyRemote", "applyChange", "layout", "dragMove", "render"];
  const cell = (k, v) => k === "N" ? String(v) : v.toFixed(2) + " ms";
  const widths = {};
  for (const k of cols) widths[k] = Math.max(k.length, ...rows.map((r) => cell(k, r[k]).length));
  const pad = (s, w) => s + " ".repeat(Math.max(0, w - s.length));
  console.log("\nPerf baseline — median of " + RUNS + " runs (render " + RENDER_RUNS + "), JSDOM\n");
  console.log(cols.map((k) => pad(k, widths[k])).join("  |  "));
  console.log(cols.map((k) => "-".repeat(widths[k])).join("--+--"));
  for (const r of rows) console.log(cols.map((k) => pad(cell(k, r[k]), widths[k])).join("  |  "));
  console.log("");
}

if (require.main === module) {
  printTable(runBenchmark());
}

module.exports = { runBenchmark: runBenchmark, N_LEVELS: N_LEVELS };
