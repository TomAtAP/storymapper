"use strict";

/**
 * SM-311 — the native pass-through CLI frontend (server/mcp-native/cli.js).
 *
 * Drives runCli against a tiny registry with mock stdout/stderr streams and
 * pins the exit-code contract: 0 ok, 1 tool isError, 2 usage / unknown-tool /
 * invalid-args — plus the argument sources (positional/--json vs piped stdin).
 */

const assert = require("assert");
const { createRegistry } = require("../registry.js");
const { runCli } = require("../cli.js");

let passed = 0, failed = 0;
let chain = Promise.resolve();
function test(name, fn) {
  chain = chain.then(async () => {
    try { await fn(); console.log(`  ok  - ${name}`); passed++; }
    catch (err) { console.log(`  FAIL - ${name}\n         ${err.stack || err.message}`); failed++; process.exitCode = 1; }
  });
}

function mockStream() { return { buf: "", write(s) { this.buf += s; return true; } }; }
function buildRegistry() {
  const r = createRegistry();
  r.register("echo",   { handler: async (a) => ({ content: [{ type: "text", text: JSON.stringify({ echoed: a.msg }) }] }) });
  r.register("noargs", { handler: async () => ({ content: [{ type: "text", text: JSON.stringify({ ok: true }) }] }) });
  r.register("need",   { validate: (a) => { if (typeof a.projectId !== "string") throw new Error("projectId required"); return a; }, handler: async () => ({ content: [{ type: "text", text: "{}" }] }) });
  r.register("gate",   { handler: async () => ({ content: [{ type: "text", text: JSON.stringify({ error: "DoD missing" }) }], isError: true }) });
  return r;
}

test("happy path: dispatch ok → result JSON on stdout, exit 0", async () => {
  const out = mockStream(), err = mockStream();
  const code = await runCli(buildRegistry(), { name: "echo", json: '{"msg":"hi"}' }, { stdout: out, stderr: err });
  assert.strictEqual(code, 0);
  assert.strictEqual(err.buf, "", "nothing on stderr");
  assert.deepStrictEqual(JSON.parse(out.buf), { echoed: "hi" });
});

test("no args (name only) dispatches with {}", async () => {
  const out = mockStream(), err = mockStream();
  const code = await runCli(buildRegistry(), { name: "noargs" }, { stdout: out, stderr: err });
  assert.strictEqual(code, 0);
  assert.deepStrictEqual(JSON.parse(out.buf), { ok: true });
});

test("tool isError result → body on stderr, exit 1", async () => {
  const out = mockStream(), err = mockStream();
  const code = await runCli(buildRegistry(), { name: "gate" }, { stdout: out, stderr: err });
  assert.strictEqual(code, 1);
  assert.strictEqual(out.buf, "", "no result on stdout for an isError");
  assert.match(err.buf, /DoD missing/);
});

test("unknown tool → ToolError → stderr, exit 2", async () => {
  const out = mockStream(), err = mockStream();
  const code = await runCli(buildRegistry(), { name: "nope" }, { stdout: out, stderr: err });
  assert.strictEqual(code, 2);
  assert.match(err.buf, /unknown tool/);
});

test("invalid params → ToolError → stderr, exit 2", async () => {
  const out = mockStream(), err = mockStream();
  const code = await runCli(buildRegistry(), { name: "need", json: "{}" }, { stdout: out, stderr: err });
  assert.strictEqual(code, 2);
  assert.match(err.buf, /invalid params/);
});

test("invalid JSON argument string → stderr, exit 2", async () => {
  const out = mockStream(), err = mockStream();
  const code = await runCli(buildRegistry(), { name: "echo", json: "{not json" }, { stdout: out, stderr: err });
  assert.strictEqual(code, 2);
  assert.match(err.buf, /invalid JSON/);
});

test("missing tool name → usage, exit 2", async () => {
  const out = mockStream(), err = mockStream();
  const code = await runCli(buildRegistry(), {}, { stdout: out, stderr: err });
  assert.strictEqual(code, 2);
  assert.match(err.buf, /usage/);
});

test("piped stdin is used as the JSON args when no json is given", async () => {
  const out = mockStream(), err = mockStream();
  const code = await runCli(buildRegistry(), { name: "echo" }, { stdout: out, stderr: err, stdinData: '{"msg":"from-stdin"}' });
  assert.strictEqual(code, 0);
  assert.deepStrictEqual(JSON.parse(out.buf), { echoed: "from-stdin" });
});

test("explicit json wins over piped stdin", async () => {
  const out = mockStream(), err = mockStream();
  const code = await runCli(buildRegistry(), { name: "echo", json: '{"msg":"explicit"}' }, { stdout: out, stderr: err, stdinData: '{"msg":"stdin"}' });
  assert.strictEqual(code, 0);
  assert.deepStrictEqual(JSON.parse(out.buf), { echoed: "explicit" });
});

module.exports.done = chain.then(() => {
  console.log(`\n  ${passed} passed, ${failed} failed`);
});
