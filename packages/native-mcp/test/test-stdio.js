"use strict";

/**
 * SM-309 — the native MCP-stdio frontend (server/mcp-native/stdio.js).
 *
 * Drives createStdioServer over a PassThrough stream pair + a tiny registry.
 * Beyond the happy protocol path, this pins exactly the paths the gegencheck
 * flagged as untested and behaviour-changing: error semantics (isError RESULT vs
 * JSON-RPC error), crash-safety on a throwing handler, non-blocking dispatch,
 * one-envelope-per-line framing, and the idempotent close() lifecycle.
 */

const assert = require("assert");
const { PassThrough } = require("stream");
const { createRegistry } = require("../registry.js");
const { createStdioServer, PROTOCOL_VERSION } = require("../stdio.js");

let passed = 0, failed = 0;
let chain = Promise.resolve();
function test(name, fn) {
  chain = chain.then(async () => {
    try { await fn(); console.log(`  ok  - ${name}`); passed++; }
    catch (err) { console.log(`  FAIL - ${name}\n         ${err.stack || err.message}`); failed++; process.exitCode = 1; }
  });
}

function harness(registerFn) {
  const reg = createRegistry();
  if (registerFn) registerFn(reg);
  const input = new PassThrough();
  const output = new PassThrough();
  output.setEncoding("utf8");
  const lines = [];
  let buf = "";
  output.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (line.trim()) lines.push(JSON.parse(line));   // JSON.parse asserts one-envelope-per-line framing
    }
  });
  let ended = false;
  const server = createStdioServer(reg, { input, output, onEnd: () => { ended = true; } });
  return {
    reg, lines, server,
    send: (msg) => input.write(JSON.stringify(msg) + "\n"),
    sendRaw: (str) => input.write(str + "\n"),
    endInput: () => input.end(),
    isEnded: () => ended,
    waitFor: (pred, timeoutMs = 1000) => new Promise((resolve, reject) => {
      const started = Date.now();
      const iv = setInterval(() => {
        const found = lines.find(pred);
        if (found) { clearInterval(iv); resolve(found); }
        else if (Date.now() - started > timeoutMs) { clearInterval(iv); reject(new Error("timeout; lines=" + JSON.stringify(lines))); }
      }, 4);
    }),
    sleep: (ms) => new Promise(r => setTimeout(r, ms))
  };
}

// ---------------------------------------------------------------------------

test("initialize echoes the client protocolVersion + advertises tools capability", async () => {
  const h = harness();
  h.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "c" } } });
  const r = await h.waitFor(l => l.id === 1);
  assert.strictEqual(r.result.protocolVersion, "2025-06-18", "echoes the client's version");
  assert.ok(r.result.capabilities.tools, "advertises the tools capability");
  assert.strictEqual(r.result.serverInfo.name, "storymap");
  h.server.close();
});

test("initialize without a protocolVersion falls back to the server default", async () => {
  const h = harness();
  h.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  const r = await h.waitFor(l => l.id === 1);
  assert.strictEqual(r.result.protocolVersion, PROTOCOL_VERSION);
  h.server.close();
});

test("a notification (no id) produces NO response", async () => {
  const h = harness();
  h.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  await h.sleep(40);
  assert.strictEqual(h.lines.length, 0, "notifications never get a response");
  h.server.close();
});

test("ping → {}", async () => {
  const h = harness();
  h.send({ jsonrpc: "2.0", id: 7, method: "ping" });
  const r = await h.waitFor(l => l.id === 7);
  assert.deepStrictEqual(r.result, {});
  h.server.close();
});

test("tools/list returns registered tools with JSON Schema", async () => {
  const h = harness(reg => reg.register("get", { description: "d", inputSchema: { type: "object", properties: { projectId: { type: "string" } } }, handler: async () => ({ content: [] }) }));
  h.send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  const r = await h.waitFor(l => l.id === 1);
  assert.strictEqual(r.result.tools.length, 1);
  assert.strictEqual(r.result.tools[0].name, "get");
  assert.strictEqual(r.result.tools[0].inputSchema.type, "object");
  h.server.close();
});

test("tools/call happy path returns the handler result", async () => {
  const h = harness(reg => reg.register("echo", { handler: async (a) => ({ content: [{ type: "text", text: a.msg }] }) }));
  h.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "echo", arguments: { msg: "hi" } } });
  const r = await h.waitFor(l => l.id === 2);
  assert.strictEqual(r.result.content[0].text, "hi");
  assert.ok(!r.result.isError);
  h.server.close();
});

test("tools/call on an UNKNOWN tool → isError RESULT, not a JSON-RPC error", async () => {
  const h = harness();
  h.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "nope", arguments: {} } });
  const r = await h.waitFor(l => l.id === 3);
  assert.ok(!r.error, "must NOT be a JSON-RPC error");
  assert.strictEqual(r.result.isError, true, "must be an isError tool result (SDK parity)");
  assert.match(r.result.content[0].text, /unknown tool/);
  h.server.close();
});

test("tools/call with INVALID args → isError RESULT, not a JSON-RPC error", async () => {
  const h = harness(reg => reg.register("need", { validate: (a) => { if (typeof a.projectId !== "string") throw new Error("projectId required"); return a; }, handler: async () => ({ content: [] }) }));
  h.send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "need", arguments: {} } });
  const r = await h.waitFor(l => l.id === 4);
  assert.ok(!r.error, "must NOT be a JSON-RPC error");
  assert.strictEqual(r.result.isError, true);
  assert.match(r.result.content[0].text, /invalid params/);
  h.server.close();
});

test("a THROWING handler → isError RESULT and the loop survives (no crash)", async () => {
  const h = harness(reg => {
    reg.register("boom", { handler: async () => { throw new Error("kaboom"); } });
    reg.register("ok", { handler: async () => ({ content: [{ type: "text", text: "still-alive" }] }) });
  });
  h.send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "boom", arguments: {} } });
  const r = await h.waitFor(l => l.id === 5);
  assert.strictEqual(r.result.isError, true, "handler throw becomes an isError result");
  assert.match(r.result.content[0].text, /kaboom/);
  // The server must still serve the next request.
  h.send({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "ok", arguments: {} } });
  const r2 = await h.waitFor(l => l.id === 6);
  assert.strictEqual(r2.result.content[0].text, "still-alive");
  h.server.close();
});

test("an unknown top-level method → JSON-RPC error -32601", async () => {
  const h = harness();
  h.send({ jsonrpc: "2.0", id: 8, method: "resources/list", params: {} });
  const r = await h.waitFor(l => l.id === 8);
  assert.ok(r.error, "unknown METHOD is a genuine JSON-RPC error");
  assert.strictEqual(r.error.code, -32601);
  h.server.close();
});

test("a malformed JSON line → JSON-RPC parse error -32700 (id null)", async () => {
  const h = harness();
  h.sendRaw("{ this is not json ");
  const r = await h.waitFor(l => l.error && l.error.code === -32700);
  assert.strictEqual(r.id, null);
  h.server.close();
});

test("dispatch is non-blocking: a slow handler does not stall a later request", async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const h = harness(reg => {
    reg.register("slow", { handler: async () => { await gate; return { content: [{ type: "text", text: "slow" }] }; } });
    reg.register("fast", { handler: async () => ({ content: [{ type: "text", text: "fast" }] }) });
  });
  h.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "slow", arguments: {} } });
  h.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "fast", arguments: {} } });
  const fast = await h.waitFor(l => l.id === 2);
  assert.strictEqual(fast.result.content[0].text, "fast", "fast response came back while slow is still pending");
  assert.ok(!h.lines.find(l => l.id === 1), "slow has NOT responded yet");
  release();
  const slow = await h.waitFor(l => l.id === 1);
  assert.strictEqual(slow.result.content[0].text, "slow");
  h.server.close();
});

test("framing survives a result whose text contains newlines", async () => {
  const multiline = "line1\nline2\n{\n  \"a\": 1\n}";
  const h = harness(reg => reg.register("m", { handler: async () => ({ content: [{ type: "text", text: multiline }] }) }));
  h.send({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "m", arguments: {} } });
  const r = await h.waitFor(l => l.id === 9);   // parses only if it was one line
  assert.strictEqual(r.result.content[0].text, multiline, "inner newlines preserved, framing intact");
  h.server.close();
});

test("close() is idempotent and stops processing further input", async () => {
  const h = harness(reg => reg.register("x", { handler: async () => ({ content: [{ type: "text", text: "x" }] }) }));
  h.server.close();
  h.server.close();   // second call must not throw
  h.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "x", arguments: {} } });
  await h.sleep(40);
  assert.strictEqual(h.lines.length, 0, "no responses after close");
});

test("onEnd fires when the input stream ends (stdin EOF lifecycle)", async () => {
  const h = harness();
  h.endInput();
  await h.sleep(30);
  assert.ok(h.isEnded(), "onEnd callback fired on input 'end'");
  h.server.close();
});

module.exports.done = chain.then(() => {
  console.log(`\n  ${passed} passed, ${failed} failed`);
});
