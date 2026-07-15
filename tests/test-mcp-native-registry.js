"use strict";

/**
 * SM-308 / SM-312 — the native, transport-agnostic, ZERO-DEPENDENCY tool core
 * (server/mcp-native/registry.js). The registry is validator-agnostic: a tool
 * brings a JSON Schema (for tools/list) + an optional validate(args) fn. These
 * tests use plain JSON Schema + hand-rolled validators — no validation library,
 * mirroring the package's zero-dependency contract. (The Zod adapter that wires
 * Storymapper's schemas lives in server/mcp.js and is covered by the MCP tests.)
 */

const assert = require("assert");
const { createRegistry, ToolError, CODES } = require("../server/mcp-native/registry.js");

let passed = 0, failed = 0;
let chain = Promise.resolve();
function test(name, fn) {
  chain = chain.then(async () => {
    try { await fn(); console.log(`  ok  - ${name}`); passed++; }
    catch (err) { console.log(`  FAIL - ${name}\n         ${err.stack || err.message}`); failed++; process.exitCode = 1; }
  });
}

const okResult = (text) => ({ content: [{ type: "text", text }] });
// A hand-rolled validator: require projectId to be a string. Throws on failure.
function requireProjectId(args) {
  if (!args || typeof args.projectId !== "string") throw new Error("projectId must be a string");
  return args;
}

test("register + has + size (def carries the handler)", () => {
  const r = createRegistry();
  r.register("noop", { description: "d", handler: async () => okResult("") });
  assert.strictEqual(r.size(), 1);
  assert.ok(r.has("noop"));
  assert.ok(!r.has("missing"));
});

test("register supports the 3-arg shape register(name, meta, handler)", () => {
  const r = createRegistry();
  r.register("t", { description: "d", inputSchema: { type: "object" } }, async () => okResult("x"));
  assert.ok(r.has("t"));
});

test("register is chainable", () => {
  const r = createRegistry();
  assert.strictEqual(r.register("a", { handler: async () => okResult("") }), r);
});

test("duplicate register throws", () => {
  const r = createRegistry();
  r.register("dup", { handler: async () => okResult("") });
  assert.throws(() => r.register("dup", { handler: async () => okResult("") }), /duplicate tool/);
});

test("register without a handler throws", () => {
  const r = createRegistry();
  assert.throws(() => r.register("bad", { inputSchema: { type: "object" } }), /handler function is required/);
});

test("listTools returns the JSON Schema VERBATIM (no conversion, no dependency)", () => {
  const r = createRegistry();
  const schema = { type: "object", properties: { projectId: { type: "string" } }, required: ["projectId"] };
  r.register("get", { description: "get it", inputSchema: schema, handler: async () => okResult("") });
  const [tool] = r.listTools();
  assert.strictEqual(tool.name, "get");
  assert.strictEqual(tool.description, "get it");
  assert.deepStrictEqual(tool.inputSchema, schema, "inputSchema is passed through unchanged");
});

test("a tool with no inputSchema lists a permissive object schema", () => {
  const r = createRegistry();
  r.register("noargs", { handler: async () => okResult("ok") });
  const [tool] = r.listTools();
  assert.strictEqual(tool.inputSchema.type, "object");
  assert.strictEqual(tool.inputSchema.additionalProperties, true);
});

test("dispatch runs validate() then the handler, returning its result", async () => {
  const r = createRegistry();
  r.register("echo", { validate: (a) => a, handler: async (a) => okResult(a.msg) });
  const res = await r.dispatch("echo", { msg: "hi" });
  assert.strictEqual(res.content[0].text, "hi");
});

test("dispatch WITHOUT a validator passes raw args through (extra keys survive)", async () => {
  const r = createRegistry();
  let seen = null;
  r.register("who", { handler: async (a) => { seen = a; return okResult(""); } });
  await r.dispatch("who", { projectId: "p1", actor: { id: "claude" } });
  assert.strictEqual(seen.projectId, "p1");
  assert.ok(seen.actor && seen.actor.id === "claude", "undeclared keys reach the handler untouched");
});

test("dispatch uses the validator's RETURN value as the handler args (coercion)", async () => {
  const r = createRegistry();
  let seen = null;
  r.register("coerce", { validate: (a) => Object.assign({}, a, { coerced: true }), handler: async (a) => { seen = a; return okResult(""); } });
  await r.dispatch("coerce", { x: 1 });
  assert.strictEqual(seen.coerced, true, "handler receives what validate returned");
});

test("dispatch on an unknown tool throws ToolError(UNKNOWN_TOOL)", async () => {
  const r = createRegistry();
  await assert.rejects(() => r.dispatch("nope", {}), (e) => e instanceof ToolError && e.code === CODES.UNKNOWN_TOOL);
});

test("a validator throw becomes ToolError(INVALID_PARAMS)", async () => {
  const r = createRegistry();
  r.register("need", { validate: requireProjectId, handler: async () => okResult("") });
  await assert.rejects(() => r.dispatch("need", {}), (e) => e instanceof ToolError && e.code === CODES.INVALID_PARAMS && /projectId/.test(e.message));
});

test("a validator's Zod-style issue list is formatted into the INVALID_PARAMS message", async () => {
  const r = createRegistry();
  r.register("issues", {
    validate: () => { const e = new Error("bad"); e.issues = [{ path: ["a", "b"], message: "required" }]; throw e; },
    handler: async () => okResult("")
  });
  await assert.rejects(() => r.dispatch("issues", {}), (e) => e instanceof ToolError && /a\.b: required/.test(e.message));
});

test("dispatch with null args runs a no-validator tool (treated as {})", async () => {
  const r = createRegistry();
  r.register("list", { handler: async (a) => okResult(a && typeof a === "object" ? "obj" : "nope") });
  const res = await r.dispatch("list", null);
  assert.strictEqual(res.content[0].text, "obj");
});

test("registerTool is an SDK-named alias for register", () => {
  const r = createRegistry();
  r.registerTool("t", { handler: async () => okResult("") });
  assert.ok(r.has("t"));
});

test("_registeredTools exposes the raw handler + description for in-process callers", async () => {
  const r = createRegistry();
  r.register("echo", { description: "e", validate: (a) => a, handler: async (a) => okResult(a.msg) });
  const entry = r._registeredTools["echo"];
  assert.ok(entry && typeof entry.handler === "function");
  assert.strictEqual(entry.description, "e");
  const res = await entry.handler({ msg: "raw" });   // raw handler bypasses validate
  assert.strictEqual(res.content[0].text, "raw");
  assert.strictEqual(r._registeredTools["missing"], undefined);
});

module.exports.done = chain.then(() => {
  console.log(`\n  ${passed} passed, ${failed} failed`);
});
