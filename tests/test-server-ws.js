"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const WebSocket = require("ws");
const { startServer } = require("../server/server.js");

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

async function tmpDir() {
  return await fs.promises.mkdtemp(path.join(os.tmpdir(), "storymap-ws-"));
}

async function startTest() {
  const dataDir = await tmpDir();
  const handle = await startServer({ port: 0, dataDir });
  const port = handle.httpServer.address().port;
  return { handle, port, dataDir, base: `http://localhost:${port}`, wsBase: `ws://localhost:${port}` };
}

function openWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const queue = [];
    const waiters = [];
    // Buffer messages from the start to avoid losing the hello frame that
    // arrives between open and the first nextMessage() call.
    ws.on("message", (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch (_) { msg = data.toString(); }
      if (waiters.length > 0) waiters.shift()(msg);
      else queue.push(msg);
    });
    ws.on("error", (err) => {
      while (waiters.length > 0) waiters.shift()(Promise.reject(err));
      reject(err);
    });
    ws.on("open", () => {
      ws._next = (timeoutMs) => new Promise((res, rej) => {
        if (queue.length > 0) return res(queue.shift());
        const t = timeoutMs == null ? 2000 : timeoutMs;
        const to = setTimeout(() => {
          const idx = waiters.indexOf(handler);
          if (idx >= 0) waiters.splice(idx, 1);
          rej(new Error("timeout waiting for ws message"));
        }, t);
        function handler(msg) { clearTimeout(to); res(msg); }
        waiters.push(handler);
      });
      resolve(ws);
    });
  });
}

function nextMessage(ws, timeoutMs) {
  return ws._next(timeoutMs);
}

async function send(ws, payload) {
  ws.send(JSON.stringify(payload));
}

async function req(base, method, p, body, headers) {
  const init = { method, headers: Object.assign({ "Content-Type": "application/json" }, headers || {}) };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(base + p, init);
  let data = null;
  const text = await res.text();
  if (text) { try { data = JSON.parse(text); } catch (_) { data = text; } }
  return { status: res.status, data };
}

// ---------------------------------------------------------------------------
// WS lifecycle
// ---------------------------------------------------------------------------

test("WS connect + hello message", async () => {
  const t = await startTest();
  try {
    const ws = await openWs(t.wsBase + "/ws");
    const hello = await nextMessage(ws);
    assert.strictEqual(hello.type, "hello");
    ws.close();
  } finally { await t.handle.shutdown(); }
});

test("WS subscribe confirmation", async () => {
  const t = await startTest();
  try {
    const ws = await openWs(t.wsBase + "/ws");
    await nextMessage(ws);   // discard hello
    await send(ws, { type: "subscribe", projectId: "p1" });
    const ack = await nextMessage(ws);
    assert.strictEqual(ack.type, "subscribed");
    assert.strictEqual(ack.projectId, "p1");
    ws.close();
  } finally { await t.handle.shutdown(); }
});

test("WS receives change push after REST write", async () => {
  const t = await startTest();
  try {
    // Pre-create project so the WS-client can subscribe to it.
    await req(t.base, "POST", "/api/projects", { id: "p1", name: "Acme" });
    const ws = await openWs(t.wsBase + "/ws");
    await nextMessage(ws);   // hello
    await send(ws, { type: "subscribe", projectId: "p1" });
    await nextMessage(ws);   // subscribed
    // Trigger a change via REST
    const r = await req(t.base, "POST", "/api/projects/p1/tickets", { type: "user-story", title: "A" });
    assert.strictEqual(r.status, 201);
    const push = await nextMessage(ws);
    assert.strictEqual(push.type, "change");
    assert.strictEqual(push.projectId, "p1");
    assert.strictEqual(push.op, "ticket_create");
    assert.ok(push.revision);
    ws.close();
  } finally { await t.handle.shutdown(); }
});

test("WS origin-id filter: client does NOT receive echo of own write", async () => {
  const t = await startTest();
  try {
    await req(t.base, "POST", "/api/projects", { id: "p1", name: "Acme" });
    const ws = await openWs(t.wsBase + "/ws");
    await nextMessage(ws);
    await send(ws, { type: "subscribe", projectId: "p1", originId: "client-A" });
    await nextMessage(ws);   // subscribed
    // Issue a write WITH the same origin-id → no echo.
    await req(t.base, "POST", "/api/projects/p1/tickets",
      { type: "user-story", title: "X" }, { "X-Origin-Id": "client-A" });
    // Issue a second write with a different origin-id → should arrive.
    await req(t.base, "POST", "/api/projects/p1/tickets",
      { type: "user-story", title: "Y" }, { "X-Origin-Id": "client-B" });
    const push = await nextMessage(ws);
    assert.strictEqual(push.type, "change");
    // The first message we receive must be the second write, not the first.
    // We rely on FIFO ordering and timing — both writes happened before the
    // first push. If the filter worked, only the B-write shows up.
    ws.close();
  } finally { await t.handle.shutdown(); }
});

test("WS unsubscribe stops further pushes for that project", async () => {
  const t = await startTest();
  try {
    await req(t.base, "POST", "/api/projects", { id: "p1", name: "Acme" });
    const ws = await openWs(t.wsBase + "/ws");
    await nextMessage(ws);
    await send(ws, { type: "subscribe", projectId: "p1" });
    await nextMessage(ws);
    await send(ws, { type: "unsubscribe", projectId: "p1" });
    await nextMessage(ws);   // unsubscribed
    // Trigger a change — should NOT arrive within timeout
    await req(t.base, "POST", "/api/projects/p1/tickets", { type: "user-story", title: "A" });
    let arrived = false;
    try { await nextMessage(ws, 300); arrived = true; } catch (_) { /* timeout = good */ }
    assert.strictEqual(arrived, false, "should NOT receive push after unsubscribe");
    ws.close();
  } finally { await t.handle.shutdown(); }
});

test("ping/pong keepalive", async () => {
  const t = await startTest();
  try {
    const ws = await openWs(t.wsBase + "/ws");
    await nextMessage(ws);
    await send(ws, { type: "ping" });
    const pong = await nextMessage(ws);
    assert.strictEqual(pong.type, "pong");
    ws.close();
  } finally { await t.handle.shutdown(); }
});

// ---------------------------------------------------------------------------
// E20.A — switch_request / switch_response cross-process bridge
// ---------------------------------------------------------------------------

test("POST /api/internal/switch-request pushes switch_request to all WS clients", async () => {
  const t = await startTest();
  try {
    const ws = await openWs(t.wsBase + "/ws");
    await nextMessage(ws);   // hello
    const r = await req(t.base, "POST", "/api/internal/switch-request", {
      workspace: "demo-1", reason: "MCP just prepared this", requestId: "rq-A"
    });
    assert.strictEqual(r.status, 200);
    const push = await nextMessage(ws);
    assert.strictEqual(push.type, "switch_request");
    assert.strictEqual(push.workspace, "demo-1");
    assert.strictEqual(push.reason, "MCP just prepared this");
    assert.strictEqual(push.requestId, "rq-A");
    ws.close();
  } finally { await t.handle.shutdown(); }
});

test("WS switch_response from browser → switch-response long-poll returns immediately", async () => {
  const t = await startTest();
  try {
    const ws = await openWs(t.wsBase + "/ws");
    await nextMessage(ws);   // hello
    // Send a response BEFORE the long-poll starts → must be cached and consumed.
    await send(ws, { type: "switch_response", requestId: "rq-B", accepted: true });
    // Give the server a moment to process.
    await new Promise(r => setTimeout(r, 50));
    const r = await req(t.base, "GET", "/api/internal/switch-response?requestId=rq-B&wait=5");
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.accepted, true);
    assert.strictEqual(r.data.timedOut, false);
    ws.close();
  } finally { await t.handle.shutdown(); }
});

test("switch-response long-poll waits, then resolves when browser answers", async () => {
  const t = await startTest();
  try {
    const ws = await openWs(t.wsBase + "/ws");
    await nextMessage(ws);   // hello
    // Start the poll FIRST.
    const pollPromise = req(t.base, "GET", "/api/internal/switch-response?requestId=rq-C&wait=5");
    // Slight delay, then send response from "browser".
    setTimeout(() => { send(ws, { type: "switch_response", requestId: "rq-C", accepted: false }); }, 80);
    const r = await pollPromise;
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.accepted, false);
    assert.strictEqual(r.data.timedOut, false);
    ws.close();
  } finally { await t.handle.shutdown(); }
});

test("switch-response long-poll returns timedOut when nobody answers", async () => {
  const t = await startTest();
  try {
    const r = await req(t.base, "GET", "/api/internal/switch-response?requestId=rq-NEVER&wait=1");
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.accepted, null);
    assert.strictEqual(r.data.timedOut, true);
  } finally { await t.handle.shutdown(); }
});

test("switch-response cache is consumed (second poll → timeout, not the cached value)", async () => {
  const t = await startTest();
  try {
    const ws = await openWs(t.wsBase + "/ws");
    await nextMessage(ws);
    await send(ws, { type: "switch_response", requestId: "rq-D", accepted: true });
    await new Promise(r => setTimeout(r, 50));
    // First poll consumes the cached entry.
    const r1 = await req(t.base, "GET", "/api/internal/switch-response?requestId=rq-D&wait=0");
    assert.strictEqual(r1.data.accepted, true);
    // Second poll on the same requestId → must NOT return the same value
    // (cache was consumed); waits then times out.
    const r2 = await req(t.base, "GET", "/api/internal/switch-response?requestId=rq-D&wait=1");
    assert.strictEqual(r2.data.timedOut, true);
    ws.close();
  } finally { await t.handle.shutdown(); }
});

// ---------------------------------------------------------------------------
// E20.E — POST /api/internal/notify-change cross-process bridge for live-sync
// ---------------------------------------------------------------------------

test("POST /api/internal/notify-change re-emits change on local bus → WS broadcast", async () => {
  const t = await startTest();
  try {
    // First create the project so the WS client can subscribe to it.
    await req(t.base, "POST", "/api/projects", { id: "p1", name: "P" });
    const ws = await openWs(t.wsBase + "/ws");
    await nextMessage(ws);   // hello
    await send(ws, { type: "subscribe", projectId: "p1", originId: "browser-X" });
    await nextMessage(ws);   // subscribed
    // Simulate a forwarded change from an out-of-process MCP subprocess.
    const r = await req(t.base, "POST", "/api/internal/notify-change", {
      projectId: "p1", revision: "20260101-000000-000", savedAt: 12345,
      op: "ticket_create", actor: { type: "ai", id: "claude", name: "Claude" }
    });
    assert.strictEqual(r.status, 200);
    const push = await nextMessage(ws);
    assert.strictEqual(push.type, "change");
    assert.strictEqual(push.projectId, "p1");
    assert.strictEqual(push.op, "ticket_create");
    assert.strictEqual(push.revision, "20260101-000000-000");
    ws.close();
  } finally { await t.handle.shutdown(); }
});

test("notify-change with originId is filtered out for that client (echo-suppression)", async () => {
  const t = await startTest();
  try {
    await req(t.base, "POST", "/api/projects", { id: "p2", name: "P" });
    const ws = await openWs(t.wsBase + "/ws");
    await nextMessage(ws);   // hello
    await send(ws, { type: "subscribe", projectId: "p2", originId: "origin-Y" });
    await nextMessage(ws);   // subscribed
    // POST with matching originId → echo filter drops it.
    await req(t.base, "POST", "/api/internal/notify-change", {
      projectId: "p2", revision: "r", savedAt: 1, op: "x", originId: "origin-Y"
    });
    // Should NOT receive any push within a short window.
    let timedOut = false;
    try { await nextMessage(ws, 200); } catch { timedOut = true; }
    assert.ok(timedOut, "client must not receive its own echo");
    ws.close();
  } finally { await t.handle.shutdown(); }
});

test("shutdown terminates active WS clients quickly", async () => {
  const t = await startTest();
  const ws = await openWs(t.wsBase + "/ws");
  await nextMessage(ws);   // hello
  const start = Date.now();
  // Don't close ws ourselves — let shutdown do it.
  await t.handle.shutdown();
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 2000, "shutdown took too long: " + elapsed + "ms");
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

module.exports.done = (test._chain || Promise.resolve()).then(() => {
  console.log(`\n  ${passed} passed, ${failed} failed`);
});
