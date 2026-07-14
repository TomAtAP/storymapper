"use strict";

/**
 * SM-308 — the native, transport-agnostic tool core (server/mcp-native/registry.js).
 *
 * Covers register (both call shapes), listTools JSON-Schema emission (incl. a
 * tolerateJsonString-style preprocessor), and dispatch (happy path, passthrough
 * of out-of-band keys, unknown-tool + invalid-params errors, null-args).
 */

const assert = require("assert");
const { z } = require("zod");
const { createRegistry, ToolError, CODES } = require("../server/mcp-native/registry.js");

let passed = 0, failed = 0;
let chain = Promise.resolve();
function test(name, fn) {
  chain = chain.then(async () => {
    try { await fn(); console.log(`  ok  - ${name}`); passed++; }
    catch (err) { console.log(`  FAIL - ${name}\n         ${err.stack || err.message}`); failed++; process.exitCode = 1; }
  });
}

// A tolerateJsonString-style field (mirrors server/mcp.js) — the MCP bridge may
// serialise nested objects as JSON strings; a z.preprocess must survive both
// the JSON-Schema emission and validation.
function tolerateJsonString(schema) {
  return z.preprocess((v) => {
    if (typeof v === "string") { try { return JSON.parse(v); } catch (_) { return v; } }
    return v;
  }, schema);
}
const positionSchema = tolerateJsonString(z.object({
  releaseId: z.string().nullable().optional(),
  epicId: z.string().nullable().optional()
}).partial()).optional();

test("register + has + size (def carries the handler)", () => {
  const r = createRegistry();
  r.register("noop", { description: "d", inputSchema: {}, handler: async () => ({ content: [] }) });
  assert.strictEqual(r.size(), 1);
  assert.ok(r.has("noop"));
  assert.ok(!r.has("missing"));
});

test("register supports the SDK 3-arg shape register(name, meta, handler)", () => {
  const r = createRegistry();
  r.register("t", { description: "d", inputSchema: { a: z.string() } }, async (args) => ({ content: [{ type: "text", text: args.a }] }));
  assert.ok(r.has("t"));
});

test("register is chainable", () => {
  const r = createRegistry();
  const ret = r.register("a", { inputSchema: {}, handler: async () => ({ content: [] }) });
  assert.strictEqual(ret, r, "register returns the registry for chaining");
});

test("duplicate register throws", () => {
  const r = createRegistry();
  r.register("dup", { inputSchema: {}, handler: async () => ({ content: [] }) });
  assert.throws(() => r.register("dup", { inputSchema: {}, handler: async () => ({ content: [] }) }), /duplicate tool/);
});

test("register without a handler throws", () => {
  const r = createRegistry();
  assert.throws(() => r.register("bad", { inputSchema: {} }), /handler function is required/);
});

test("register with an empty/absent inputSchema is a no-arg tool", () => {
  const r = createRegistry();
  r.register("noargs", { handler: async () => ({ content: [{ type: "text", text: "ok" }] }) });
  const list = r.listTools();
  assert.strictEqual(list[0].inputSchema.type, "object");
});

test("listTools emits JSON Schema with required + properties", () => {
  const r = createRegistry();
  r.register("get", { description: "get it", inputSchema: { projectId: z.string(), verbose: z.boolean().optional() }, handler: async () => ({ content: [] }) });
  const [tool] = r.listTools();
  assert.strictEqual(tool.name, "get");
  assert.strictEqual(tool.description, "get it");
  assert.strictEqual(tool.inputSchema.type, "object");
  assert.ok(tool.inputSchema.properties.projectId, "projectId property present");
  assert.deepStrictEqual(tool.inputSchema.required, ["projectId"], "only projectId is required");
});

test("listTools handles a tolerateJsonString preprocessor field without throwing", () => {
  const r = createRegistry();
  r.register("mv", { inputSchema: { position: positionSchema }, handler: async () => ({ content: [] }) });
  const [tool] = r.listTools();
  assert.strictEqual(tool.inputSchema.type, "object", "schema still emits as an object");
});

test("dispatch validates + runs the handler, returning its result", async () => {
  const r = createRegistry();
  r.register("echo", { inputSchema: { msg: z.string() }, handler: async (args) => ({ content: [{ type: "text", text: args.msg }] }) });
  const res = await r.dispatch("echo", { msg: "hi" });
  assert.strictEqual(res.content[0].text, "hi");
});

test("dispatch passes through out-of-band keys (identity seam's actor survives)", async () => {
  const r = createRegistry();
  let seen = null;
  r.register("who", { inputSchema: { projectId: z.string() }, handler: async (args) => { seen = args; return { content: [] }; } });
  await r.dispatch("who", { projectId: "p1", actor: { type: "ai", id: "claude" } });
  assert.ok(seen.actor && seen.actor.id === "claude", "undeclared 'actor' key reaches the handler");
});

test("dispatch tolerates a JSON-string argument via the preprocessor", async () => {
  const r = createRegistry();
  let seen = null;
  r.register("mv", { inputSchema: { position: positionSchema }, handler: async (args) => { seen = args; return { content: [] }; } });
  await r.dispatch("mv", { position: JSON.stringify({ releaseId: "r1" }) });
  assert.strictEqual(seen.position.releaseId, "r1", "stringified object parsed back before the handler");
});

test("dispatch on an unknown tool throws ToolError(UNKNOWN_TOOL)", async () => {
  const r = createRegistry();
  await assert.rejects(() => r.dispatch("nope", {}), (e) => e instanceof ToolError && e.code === CODES.UNKNOWN_TOOL);
});

test("dispatch with a missing required arg throws ToolError(INVALID_PARAMS)", async () => {
  const r = createRegistry();
  r.register("need", { inputSchema: { projectId: z.string() }, handler: async () => ({ content: [] }) });
  await assert.rejects(() => r.dispatch("need", {}), (e) => e instanceof ToolError && e.code === CODES.INVALID_PARAMS);
});

test("dispatch with a wrong-typed arg throws ToolError(INVALID_PARAMS)", async () => {
  const r = createRegistry();
  r.register("typed", { inputSchema: { n: z.number() }, handler: async () => ({ content: [] }) });
  await assert.rejects(() => r.dispatch("typed", { n: "not-a-number" }), (e) => e instanceof ToolError && e.code === CODES.INVALID_PARAMS);
});

test("dispatch with null args runs a no-arg tool (treated as {})", async () => {
  const r = createRegistry();
  r.register("list", { inputSchema: {}, handler: async () => ({ content: [{ type: "text", text: "listed" }] }) });
  const res = await r.dispatch("list", null);
  assert.strictEqual(res.content[0].text, "listed");
});

module.exports.done = chain.then(() => {
  console.log(`\n  ${passed} passed, ${failed} failed`);
});
