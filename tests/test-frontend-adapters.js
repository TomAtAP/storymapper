"use strict";

const assert = require("assert");
const adapters = require("../frontend/js/adapters.js");
const { MemoryAdapter, LocalStorageAdapter, WindowStorageAdapter, HttpAdapter, pickAdapter } = adapters;

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

function makeFakeLocalStorage() {
  const m = new Map();
  return {
    getItem: (k) => m.has(k) ? m.get(k) : null,
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k)
  };
}

function makeFakeWindowStorage() {
  const m = new Map();
  return {
    get: async (k) => m.has(k) ? m.get(k) : null,
    set: async (k, v) => m.set(k, v),
    delete: async (k) => m.delete(k),
    list: async (prefix) => Array.from(m.keys()).filter(k => k.startsWith(prefix || ""))
  };
}

const SNAP = {
  version: 1,
  project: { id: "p1", name: "X" },
  tickets: [], releases: [], processSteps: []
};

// ---------------------------------------------------------------------------
// MemoryAdapter
// ---------------------------------------------------------------------------

test("MemoryAdapter: round-trip + list + delete", async () => {
  const a = new MemoryAdapter();
  assert.deepStrictEqual(await a.list(), []);
  assert.strictEqual(await a.load("p1"), null);
  const r = await a.save("p1", SNAP);
  assert.ok(r.revision);
  assert.strictEqual((await a.load("p1")).project.id, "p1");
  assert.deepStrictEqual(await a.list(), ["p1"]);
  await a.delete("p1");
  assert.deepStrictEqual(await a.list(), []);
});

test("MemoryAdapter: load returns a deep clone (no aliasing)", async () => {
  const a = new MemoryAdapter();
  await a.save("p1", SNAP);
  const loaded = await a.load("p1");
  loaded.project.name = "MUTATED";
  const reloaded = await a.load("p1");
  assert.notStrictEqual(reloaded.project.name, "MUTATED");
});

// ---------------------------------------------------------------------------
// LocalStorageAdapter
// ---------------------------------------------------------------------------

test("LocalStorageAdapter: round-trip + index", async () => {
  const ls = makeFakeLocalStorage();
  const a = new LocalStorageAdapter(ls);
  assert.deepStrictEqual(await a.list(), []);
  await a.save("p1", SNAP);
  await a.save("p2", Object.assign({}, SNAP, { project: { id: "p2", name: "Y" } }));
  const list = await a.list();
  assert.deepStrictEqual(list.sort(), ["p1", "p2"]);
  assert.strictEqual((await a.load("p1")).project.id, "p1");
});

test("LocalStorageAdapter: delete removes from index", async () => {
  const ls = makeFakeLocalStorage();
  const a = new LocalStorageAdapter(ls);
  await a.save("p1", SNAP);
  await a.save("p2", Object.assign({}, SNAP, { project: { id: "p2", name: "Y" } }));
  await a.delete("p1");
  assert.deepStrictEqual(await a.list(), ["p2"]);
  assert.strictEqual(await a.load("p1"), null);
});

// ---------------------------------------------------------------------------
// WindowStorageAdapter
// ---------------------------------------------------------------------------

test("WindowStorageAdapter: round-trip + list", async () => {
  const ws = makeFakeWindowStorage();
  const a = new WindowStorageAdapter(ws);
  await a.save("p1", SNAP);
  assert.deepStrictEqual(await a.list(), ["p1"]);
  const loaded = await a.load("p1");
  assert.strictEqual(loaded.project.id, "p1");
});

// ---------------------------------------------------------------------------
// pickAdapter priority chain
// ---------------------------------------------------------------------------

test("pickAdapter: ?api=URL → HttpAdapter", async () => {
  const a = await pickAdapter({ url: "http://x.test/?api=http://localhost:8770" });
  assert.strictEqual(a.name, "Http");
  assert.strictEqual(a.base, "http://localhost:8770");
});

test("pickAdapter: window.storage available → WindowStorageAdapter", async () => {
  const a = await pickAdapter({ url: "http://x.test/", windowStorage: makeFakeWindowStorage() });
  assert.strictEqual(a.name, "Window");
});

test("pickAdapter: localStorage available, no api/winStorage → LocalStorageAdapter", async () => {
  const a = await pickAdapter({ url: "http://x.test/", localStorage: makeFakeLocalStorage() });
  assert.strictEqual(a.name, "Local");
});

test("pickAdapter: nothing available → MemoryAdapter", async () => {
  const a = await pickAdapter({ url: "http://x.test/" });
  assert.strictEqual(a.name, "Memory");
});

test("pickAdapter: ?api=URL wins over windowStorage and localStorage", async () => {
  const a = await pickAdapter({
    url: "http://x.test/?api=http://localhost:8770",
    windowStorage: makeFakeWindowStorage(),
    localStorage: makeFakeLocalStorage()
  });
  assert.strictEqual(a.name, "Http");
});

// ---------------------------------------------------------------------------
// SM-99 — same-origin /api/health probe + fallback semantics
// ---------------------------------------------------------------------------

test("SM-99: pickAdapter probes /api/health on http: origin and picks HttpAdapter when name='storymap'", async () => {
  let probed = null;
  const fakeFetch = async (url) => {
    probed = url;
    return { ok: true, status: 200, json: async () => ({ ok: true, name: "storymap" }) };
  };
  const a = await pickAdapter({
    url: "http://x.test/",
    protocol: "http:", origin: "http://x.test",
    fetch: fakeFetch,
    localStorage: makeFakeLocalStorage()   // would be the fallback if probe failed
  });
  assert.strictEqual(probed, "http://x.test/api/health");
  assert.strictEqual(a.name, "Http");
  assert.strictEqual(a.base, "http://x.test");
});

test("SM-99: probe receives non-storymap name → fallback to localStorage", async () => {
  const fakeFetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, name: "something-else" }) });
  const a = await pickAdapter({
    url: "http://x.test/", protocol: "http:", origin: "http://x.test",
    fetch: fakeFetch,
    localStorage: makeFakeLocalStorage()
  });
  assert.strictEqual(a.name, "Local", "wrong-name identity → fallback");
});

test("SM-99: probe network failure → fallback to localStorage", async () => {
  const fakeFetch = async () => { throw new Error("ECONNREFUSED"); };
  const a = await pickAdapter({
    url: "http://x.test/", protocol: "http:", origin: "http://x.test",
    fetch: fakeFetch,
    localStorage: makeFakeLocalStorage()
  });
  assert.strictEqual(a.name, "Local");
});

test("SM-99: probe 404 / non-ok status → fallback to localStorage", async () => {
  const fakeFetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
  const a = await pickAdapter({
    url: "http://x.test/", protocol: "http:", origin: "http://x.test",
    fetch: fakeFetch,
    localStorage: makeFakeLocalStorage()
  });
  assert.strictEqual(a.name, "Local");
});

test("SM-99: file: protocol skips probe — straight to localStorage", async () => {
  let probed = false;
  const fakeFetch = async () => { probed = true; return { ok: true, json: async () => ({ name: "storymap" }) }; };
  const a = await pickAdapter({
    url: "file:///home/user/storymap.html",
    protocol: "file:", origin: "file://",
    fetch: fakeFetch,
    localStorage: makeFakeLocalStorage()
  });
  assert.strictEqual(probed, false, "no probe on file:");
  assert.strictEqual(a.name, "Local");
});

test("SM-99: ?api= override still wins, no probe issued", async () => {
  let probed = false;
  const fakeFetch = async () => { probed = true; return { ok: true, json: async () => ({ name: "storymap" }) }; };
  const a = await pickAdapter({
    url: "http://x.test/?api=http://other.test:9999",
    protocol: "http:", origin: "http://x.test",
    fetch: fakeFetch
  });
  assert.strictEqual(probed, false, "explicit ?api skips the probe");
  assert.strictEqual(a.base, "http://other.test:9999");
});

test("SM-99: probeStorymapOrigin honours env.probeTimeoutMs", async () => {
  // Fake fetch that never resolves — only the AbortController-based timeout
  // ends the wait. We assert pickAdapter falls back within ~30 ms.
  let aborted = false;
  const fakeFetch = (url, init) => new Promise((resolve, reject) => {
    if (init && init.signal) {
      init.signal.addEventListener("abort", () => {
        aborted = true; reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      });
    }
  });
  const start = Date.now();
  const a = await pickAdapter({
    url: "http://x.test/", protocol: "http:", origin: "http://x.test",
    fetch: fakeFetch, probeTimeoutMs: 30,
    localStorage: makeFakeLocalStorage()
  });
  const elapsed = Date.now() - start;
  assert.strictEqual(a.name, "Local", "probe aborted → fallback to localStorage");
  assert.ok(aborted, "AbortController signal fired");
  assert.ok(elapsed < 200, "probe respected the ~30 ms timeout, got " + elapsed + " ms");
});

// ---------------------------------------------------------------------------
// All adapters expose the same interface
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// E18.C — HttpAdapter.save PUTs the full snapshot, not just the project header
// ---------------------------------------------------------------------------

test("HttpAdapter.save PUTs the whole snapshot body (not just project header)", async () => {
  const captured = { method: null, url: null, body: null, headers: null };
  const realFetch = global.fetch;
  global.fetch = async (url, init) => {
    captured.method = init.method;
    captured.url = url;
    captured.headers = init.headers;
    captured.body = JSON.parse(init.body);
    return {
      ok: true, status: 200,
      text: async () => JSON.stringify({ revision: "x", savedAt: 0 })
    };
  };
  try {
    const a = new HttpAdapter("http://srv.test", { originId: "test-origin" });
    await a.save("p1", SNAP);
  } finally { global.fetch = realFetch; }
  assert.strictEqual(captured.method, "PUT");
  assert.strictEqual(captured.url, "http://srv.test/api/projects/p1");
  assert.strictEqual(captured.headers["X-Origin-Id"], "test-origin");
  // Critical: body must be the full snapshot, not just snapshot.project.
  assert.ok(Array.isArray(captured.body.tickets), "body.tickets must be an array");
  assert.ok(Array.isArray(captured.body.releases), "body.releases must be an array");
  assert.ok(captured.body.project, "body.project must be present");
  assert.strictEqual(captured.body.project.id, "p1");
});

// ---------------------------------------------------------------------------
// E20.C — HttpAdapter switch_request handling
// ---------------------------------------------------------------------------

test("HttpAdapter._handleWsMessage routes switch_request to the registered handler", () => {
  const a = new HttpAdapter("http://srv.test", { originId: "x" });
  let captured = null;
  a.onSwitchRequest((ev) => { captured = ev; });
  // Simulate an incoming WS frame.
  a._handleWsMessage({ data: JSON.stringify({
    type: "switch_request", workspace: "demo", reason: "test", requestId: "rq-1"
  }) });
  assert.ok(captured, "handler should fire");
  assert.strictEqual(captured.workspace, "demo");
  assert.strictEqual(captured.reason, "test");
  assert.strictEqual(captured.requestId, "rq-1");
});

test("HttpAdapter._handleWsMessage ignores switch_request when no handler is registered", () => {
  const a = new HttpAdapter("http://srv.test", { originId: "x" });
  // Should not throw.
  a._handleWsMessage({ data: JSON.stringify({
    type: "switch_request", workspace: "demo", requestId: "rq-2"
  }) });
});

test("HttpAdapter.sendSwitchResponse is a no-op when socket is closed", () => {
  const a = new HttpAdapter("http://srv.test", { originId: "x" });
  // _ws is null — should not throw.
  a.sendSwitchResponse("rq-3", true);
});

test("HttpAdapter.sendSwitchResponse sends WS frame when socket is open", () => {
  const a = new HttpAdapter("http://srv.test", { originId: "x" });
  const sent = [];
  a._ws = { readyState: 1, send: (s) => sent.push(JSON.parse(s)) };
  a.sendSwitchResponse("rq-4", true);
  assert.strictEqual(sent.length, 1);
  assert.deepStrictEqual(sent[0], { type: "switch_response", requestId: "rq-4", accepted: true });
});

// SM-29: wireSwitchRequestHandler must short-circuit when the requested
// workspace is already loaded — no modal, just an immediate
// sendSwitchResponse(true). Source-level check (main.js is the bootstrap
// IIFE and isn't directly require-able; we lean on the source string here,
// matched by the existing adapter tests above that prove the WS routing
// reaches the handler in the first place).
test("SM-29: wireSwitchRequestHandler short-circuits when workspace === currentProjectId", () => {
  const fs   = require("fs");
  const path = require("path");
  const src  = fs.readFileSync(path.join(__dirname, "..", "frontend/js/main.js"), "utf8");
  // Must contain the early-return: matches `app.currentProjectId === workspace`
  // followed (within ~200 chars) by a `sendSwitchResponse(requestId, true)` call.
  const window = src.match(/wireSwitchRequestHandler[\s\S]*?function/);   // sanity-check the function exists
  assert.ok(window, "wireSwitchRequestHandler defined in main.js");
  const pattern = /app\.currentProjectId\s*===\s*workspace[\s\S]{0,300}sendSwitchResponse\s*\(\s*requestId\s*,\s*true\s*\)/;
  assert.ok(pattern.test(src),
    "expected early-accept branch: 'if (app.currentProjectId === workspace) { sendSwitchResponse(requestId, true); return }'");
});

test("all adapters expose load/save/list/delete", () => {
  for (const a of [
    new MemoryAdapter(),
    new LocalStorageAdapter(makeFakeLocalStorage()),
    new WindowStorageAdapter(makeFakeWindowStorage())
  ]) {
    for (const m of ["load", "save", "list", "delete"]) {
      assert.strictEqual(typeof a[m], "function", a.name + " missing " + m);
    }
  }
});

// ---------------------------------------------------------------------------
// SM-153 (S8) — HttpAdapter WS auto-reconnect + resubscribe
// ---------------------------------------------------------------------------

let _wsInstances = [];
class MockWS {
  constructor(url) {
    this.url = url; this.readyState = 0; this.sent = [];
    this.onopen = null; this.onclose = null; this.onmessage = null; this.onerror = null;
    _wsInstances.push(this);
    // Auto-open on a microtask so `await adapter.subscribe()` resolves.
    Promise.resolve().then(() => { this.readyState = 1; if (this.onopen) this.onopen(); });
  }
  send(s) { this.sent.push(JSON.parse(s)); }
  close() { this.readyState = 3; if (this.onclose) this.onclose(); }
}
function subsFor(inst, projectId) {
  return inst.sent.filter(m => m.type === "subscribe" && m.projectId === projectId).length;
}

test("SM-153: HttpAdapter re-subscribes active subscriptions after a WS reconnect", async () => {
  const realWS = global.WebSocket, realST = global.setTimeout, realCT = global.clearTimeout;
  _wsInstances = [];
  global.WebSocket = MockWS;
  // Fire the reconnect timer on a microtask so the test stays synchronous.
  global.setTimeout = (fn) => { Promise.resolve().then(fn); return 1; };
  global.clearTimeout = () => {};
  try {
    const a = new HttpAdapter("http://srv.test", { originId: "o" });
    const states = [];
    a.onConnectionState((c) => states.push(c));
    await a.subscribe("p1", () => {});
    assert.strictEqual(_wsInstances.length, 1, "one socket after first subscribe");
    assert.strictEqual(subsFor(_wsInstances[0], "p1"), 1, "initial subscribe frame sent");

    // Simulate the socket dropping (server restart / sleep).
    _wsInstances[0].close();
    // Flush the microtask-driven reconnect + the new socket's auto-open.
    await new Promise((r) => realST(r, 0));

    assert.strictEqual(_wsInstances.length, 2, "a reconnect opened a fresh socket");
    assert.strictEqual(subsFor(_wsInstances[1], "p1"), 1, "subscription was re-sent on reconnect");
    assert.deepStrictEqual(states, [true, false, true], "connection indicator: up → down → up");
  } finally {
    global.WebSocket = realWS; global.setTimeout = realST; global.clearTimeout = realCT;
  }
});

test("SM-153: close() stops auto-reconnect", async () => {
  const realWS = global.WebSocket, realST = global.setTimeout, realCT = global.clearTimeout;
  _wsInstances = [];
  global.WebSocket = MockWS;
  global.setTimeout = (fn) => { Promise.resolve().then(fn); return 1; };
  global.clearTimeout = () => {};
  try {
    const a = new HttpAdapter("http://srv.test", { originId: "o" });
    await a.subscribe("p1", () => {});
    a.close();                               // intentional close → _wantWs=false
    await new Promise((r) => realST(r, 0));  // give any (wrongly) scheduled reconnect a chance
    assert.strictEqual(_wsInstances.length, 1, "no reconnect after an intentional close()");
  } finally {
    global.WebSocket = realWS; global.setTimeout = realST; global.clearTimeout = realCT;
  }
});

// ---------------------------------------------------------------------------
// SM-214 — saveBeacon (keepalive PUT for pagehide flush) + WS shape guard
// ---------------------------------------------------------------------------

test("SM-214: HttpAdapter.saveBeacon PUTs the snapshot with keepalive:true", () => {
  const calls = [];
  const origFetch = global.fetch;
  global.fetch = (url, init) => { calls.push({ url, init }); return Promise.resolve({ ok: true }); };
  try {
    const a = new HttpAdapter("http://x:1", { originId: "o-1" });
    const did = a.saveBeacon("p1", SNAP);
    assert.strictEqual(did, true);
    assert.strictEqual(calls.length, 1);
    assert.ok(calls[0].url.endsWith("/api/projects/p1"));
    assert.strictEqual(calls[0].init.method, "PUT");
    assert.strictEqual(calls[0].init.keepalive, true, "keepalive lets the PUT outlive the page");
    assert.strictEqual(calls[0].init.headers["X-Origin-Id"], "o-1");
    assert.deepStrictEqual(JSON.parse(calls[0].init.body).project, SNAP.project);
    // Review remediation: a snapshot above the browser keepalive cap must be
    // refused (false) so the pipeline falls back to a plain save.
    const big = Object.assign({}, SNAP, { tickets: [{ description: "y".repeat(70 * 1024) }] });
    assert.strictEqual(a.saveBeacon("p1", big), false, "oversized body → false (fallback)");
    assert.strictEqual(calls.length, 1, "no keepalive fetch for the oversized body");
  } finally { global.fetch = origFetch; }
});

test("SM-214: malformed WS frames are ignored without throwing", () => {
  const a = new HttpAdapter("http://x:1");
  let dispatched = 0;
  a._subscriptions.set("p1", new Set([() => { dispatched++; }]));
  a.onSwitchRequest(() => { dispatched++; });
  const frames = [
    "not json at all",
    "42",                                     // JSON, but not an object
    "null",
    JSON.stringify({}),                       // no type
    JSON.stringify({ type: 7 }),              // non-string type
    JSON.stringify({ type: "change" }),       // change without projectId
    JSON.stringify({ type: "change", projectId: 42 }),
    JSON.stringify({ type: "switch_request" }),                       // no requestId/workspace
    JSON.stringify({ type: "switch_request", requestId: 1, workspace: 2 }),
    JSON.stringify({ type: "totally-unknown" })
  ];
  for (const data of frames) a._handleWsMessage({ data });   // must not throw
  assert.strictEqual(dispatched, 0, "no malformed frame may reach a callback");
  // …and a well-formed frame still dispatches.
  a._handleWsMessage({ data: JSON.stringify({ type: "change", projectId: "p1", revision: "r1" }) });
  assert.strictEqual(dispatched, 1);
});

test("SM-214: main.js + editor delegate to the shared save-pipeline (source-level)", () => {
  const fs = require("fs");
  const path = require("path");
  const src = fs.readFileSync(path.join(__dirname, "..", "frontend/js/main.js"), "utf8");
  assert.ok(src.includes("createSavePipeline"), "main.js delegates to the shared save-pipeline");
  assert.ok(src.includes("flushPendingSave"), "main.js references flushPendingSave");
  const editorSrc = fs.readFileSync(path.join(__dirname, "..", "frontend/js/renderer-ticket-editor.js"), "utf8");
  assert.ok(editorSrc.includes("createSavePipeline"), "the full-page editor uses the SAME pipeline (DRY)");
});

module.exports.done = (test._chain || Promise.resolve()).then(() => {
  console.log(`\n  ${passed} passed, ${failed} failed`);
});
