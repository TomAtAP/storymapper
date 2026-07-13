"use strict";

/**
 * SM-214 — shared save-pipeline module (frontend/js/save-pipeline.js).
 *
 * Extracted from main.js#installSaveSubscriber + the SM-157 duplicate in
 * renderer-ticket-editor.js so the behaviour is unit-testable:
 *   - debounced whole-snapshot save per store commit (skip applyRemote/hydrate)
 *   - SM-153 race guard: project id captured at SCHEDULE time
 *   - one retry after RETRY_MS on a failed save, then onError
 *   - flushPendingSave(): synchronous flush for pagehide/beforeunload —
 *     prefers adapter.saveBeacon (fetch keepalive) over adapter.save
 */

const assert = require("assert");
const savePipeline = require("../frontend/js/save-pipeline.js");
const { createSavePipeline, SAVE_PIPELINE } = savePipeline;

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

function fakeStore() {
  const subs = [];
  return {
    subscribe(fn) { subs.push(fn); return () => {}; },
    commit(snap, reason) { for (const fn of subs) fn(snap, reason); }
  };
}

function fakeAdapter() {
  const calls = [];
  return {
    calls,
    failures: 0,                 // fail the next N save() calls
    save(pid, snap) {
      calls.push({ kind: "save", pid, snap });
      if (this.failures > 0) { this.failures--; return Promise.reject(new Error("simulated save failure")); }
      return Promise.resolve({ revision: "r" + calls.length });
    },
    saveBeacon(pid, snap) {
      calls.push({ kind: "beacon", pid, snap });
      return true;
    }
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SNAP_A = { project: { id: "pA" }, tickets: [], releases: [], processSteps: [] };
const SKIP = new Set(["applyRemote", "hydrate"]);

test("SAVE_PIPELINE constants block is exported", () => {
  assert.ok(SAVE_PIPELINE, "constants exported");
  for (const k of ["DEBOUNCE_MS_DEFAULT", "RETRY_MS_DEFAULT", "MAX_RETRIES_DEFAULT"]) {
    assert.ok(typeof SAVE_PIPELINE[k] === "number", "SAVE_PIPELINE." + k);
  }
});

test("commit → debounced save with snapshot + project id", async () => {
  const store = fakeStore(), adapter = fakeAdapter();
  createSavePipeline({ store, adapter: () => adapter, projectId: () => "pA",
    skipReasons: SKIP, debounceMs: 10 });
  store.commit(SNAP_A, "updateTicket");
  assert.strictEqual(adapter.calls.length, 0, "not before the debounce");
  await sleep(30);
  assert.strictEqual(adapter.calls.length, 1);
  assert.strictEqual(adapter.calls[0].pid, "pA");
  assert.strictEqual(adapter.calls[0].snap, SNAP_A);
});

test("skip reasons (applyRemote/hydrate) do not trigger a save", async () => {
  const store = fakeStore(), adapter = fakeAdapter();
  createSavePipeline({ store, adapter: () => adapter, projectId: () => "pA",
    skipReasons: SKIP, debounceMs: 5 });
  store.commit(SNAP_A, "applyRemote");
  store.commit(SNAP_A, "hydrate");
  await sleep(25);
  assert.strictEqual(adapter.calls.length, 0);
});

test("SM-153 race: project id is captured at schedule time, not flush time", async () => {
  const store = fakeStore(), adapter = fakeAdapter();
  let current = "pA";
  createSavePipeline({ store, adapter: () => adapter, projectId: () => current,
    skipReasons: SKIP, debounceMs: 15 });
  store.commit(SNAP_A, "updateTicket");
  current = "pB";                      // user switches projects inside the window
  await sleep(40);
  assert.strictEqual(adapter.calls.length, 1);
  assert.strictEqual(adapter.calls[0].pid, "pA", "must PUT under the project that produced the commit");
});

test("a failed save is retried once after retryMs and succeeds silently", async () => {
  const store = fakeStore(), adapter = fakeAdapter();
  const errors = [];
  createSavePipeline({ store, adapter: () => adapter, projectId: () => "pA",
    skipReasons: SKIP, debounceMs: 5, retryMs: 10, onError: (e) => errors.push(e) });
  adapter.failures = 1;
  store.commit(SNAP_A, "updateTicket");
  await sleep(60);
  assert.strictEqual(adapter.calls.length, 2, "initial attempt + one retry");
  assert.strictEqual(errors.length, 0, "recovered without surfacing an error");
});

test("retry exhausted → onError fires exactly once", async () => {
  const store = fakeStore(), adapter = fakeAdapter();
  const errors = [];
  createSavePipeline({ store, adapter: () => adapter, projectId: () => "pA",
    skipReasons: SKIP, debounceMs: 5, retryMs: 10, maxRetries: 3, onError: (e) => errors.push(e) });
  adapter.failures = 4;                // initial + 3 retries all fail
  store.commit(SNAP_A, "updateTicket");
  await sleep(120);
  assert.strictEqual(adapter.calls.length, 4, "initial attempt + 3 retries");
  assert.strictEqual(errors.length, 1, "terminal failure surfaces exactly once");
});

test("SM-244: a transient network error (no statusCode) recovers across several retries", async () => {
  const store = fakeStore(), adapter = fakeAdapter();
  const errors = [];
  createSavePipeline({ store, adapter: () => adapter, projectId: () => "pA",
    skipReasons: SKIP, debounceMs: 5, retryMs: 8, maxRetries: 3, onError: (e) => errors.push(e) });
  adapter.failures = 3;                // simulate stale-connection resets; 4th attempt succeeds
  store.commit(SNAP_A, "updateTicket");
  await sleep(120);
  assert.strictEqual(adapter.calls.length, 4, "kept retrying on a fresh connection until success");
  assert.strictEqual(errors.length, 0, "recovered silently — no surfaced error");
});

test("SM-244: a genuine 4xx rejection is NOT retried (surfaces immediately)", async () => {
  const store = fakeStore();
  const calls = [];
  const adapter = {
    calls,
    save(pid, snap) {
      calls.push({ kind: "save" });
      const e = new Error("bad request"); e.statusCode = 400;
      return Promise.reject(e);
    },
    saveBeacon() { return true; }
  };
  const errors = [];
  createSavePipeline({ store, adapter: () => adapter, projectId: () => "pA",
    skipReasons: SKIP, debounceMs: 5, retryMs: 8, maxRetries: 3, onError: (e) => errors.push(e) });
  store.commit(SNAP_A, "updateTicket");
  await sleep(60);
  assert.strictEqual(calls.length, 1, "deterministic 4xx is not retried");
  assert.strictEqual(errors.length, 1, "surfaced once, immediately");
});

test("a newer commit supersedes a pending retry (no stale overwrite)", async () => {
  const store = fakeStore(), adapter = fakeAdapter();
  const errors = [];
  createSavePipeline({ store, adapter: () => adapter, projectId: () => "pA",
    skipReasons: SKIP, debounceMs: 5, retryMs: 30, onError: (e) => errors.push(e) });
  adapter.failures = 1;
  store.commit(SNAP_A, "updateTicket");        // will fail, schedules retry
  await sleep(15);
  const NEWER = { project: { id: "pA" }, tickets: [{ id: "t1" }], releases: [], processSteps: [] };
  store.commit(NEWER, "updateTicket");         // newer commit lands before the retry fires
  await sleep(80);
  const saves = adapter.calls.filter(c => c.kind === "save");
  assert.strictEqual(saves[saves.length - 1].snap, NEWER, "the newest snapshot wins");
  const staleAfterNew = saves.findIndex(c => c.snap === NEWER) <
                        saves.map(c => c.snap).lastIndexOf(SNAP_A);
  assert.ok(!staleAfterNew, "the stale snapshot must never be saved AFTER the newer one");
});

test("flushPendingSave: flushes via saveBeacon, cancels the timer, returns true", async () => {
  const store = fakeStore(), adapter = fakeAdapter();
  const p = createSavePipeline({ store, adapter: () => adapter, projectId: () => "pA",
    skipReasons: SKIP, debounceMs: 5000 });    // long debounce — flush must beat it
  store.commit(SNAP_A, "updateTicket");
  const did = p.flushPendingSave();
  assert.strictEqual(did, true);
  assert.strictEqual(adapter.calls.length, 1);
  assert.strictEqual(adapter.calls[0].kind, "beacon", "prefers adapter.saveBeacon");
  assert.strictEqual(adapter.calls[0].pid, "pA");
  await sleep(20);
  assert.strictEqual(adapter.calls.length, 1, "the debounce timer must not double-save");
  assert.strictEqual(p.flushPendingSave(), false, "nothing pending → false");
});

test("flushPendingSave falls back to adapter.save when saveBeacon returns false", () => {
  const store = fakeStore(), adapter = fakeAdapter();
  adapter.saveBeacon = function (pid, snap) {
    adapter.calls.push({ kind: "beacon-refused", pid, snap });
    return false;   // e.g. snapshot above the browser keepalive body cap
  };
  const p = createSavePipeline({ store, adapter: () => adapter, projectId: () => "pA",
    skipReasons: SKIP, debounceMs: 5000 });
  store.commit(SNAP_A, "updateTicket");
  assert.strictEqual(p.flushPendingSave(), true);
  const kinds = adapter.calls.map(c => c.kind);
  assert.deepStrictEqual(kinds, ["beacon-refused", "save"], "refused beacon must fall back to save");
});

test("flushPendingSave falls back to adapter.save when no saveBeacon exists", () => {
  const store = fakeStore(), adapter = fakeAdapter();
  delete adapter.saveBeacon;
  const p = createSavePipeline({ store, adapter: () => adapter, projectId: () => "pA",
    skipReasons: SKIP, debounceMs: 5000 });
  store.commit(SNAP_A, "updateTicket");
  assert.strictEqual(p.flushPendingSave(), true);
  assert.strictEqual(adapter.calls.length, 1);
  assert.strictEqual(adapter.calls[0].kind, "save");
});

test("pagehide on the provided window triggers the flush", () => {
  const listeners = {};
  const win = {
    addEventListener: (ev, fn) => { listeners[ev] = fn; },
    removeEventListener: (ev) => { delete listeners[ev]; },
    setTimeout, clearTimeout
  };
  const store = fakeStore(), adapter = fakeAdapter();
  createSavePipeline({ store, adapter: () => adapter, projectId: () => "pA",
    skipReasons: SKIP, debounceMs: 5000, win });
  assert.ok(typeof listeners.pagehide === "function", "pagehide listener registered");
  store.commit(SNAP_A, "updateTicket");
  listeners.pagehide();
  assert.strictEqual(adapter.calls.length, 1, "pending save flushed on pagehide");
});

module.exports.done = (test._chain || Promise.resolve()).then(() => {
  console.log(`\n  ${passed} passed, ${failed} failed`);
});
