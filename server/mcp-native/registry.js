"use strict";

/**
 * Native, transport-agnostic MCP tool core (SM-308, Zero Dependency release).
 *
 * A registry of tools + a single `dispatch()` choke-point that validates an
 * argument object and runs the tool's handler. There are NO transport or I/O
 * imports here — every frontend (the MCP-stdio server SM-303, the CLI spike
 * SM-304) owns its own I/O and calls `dispatch()`. This replaces the tool
 * surface of `@modelcontextprotocol/sdk`'s `McpServer` (see
 * docs/native-mcp-layer.md for the target spec).
 *
 * A tool is registered exactly like the SDK's `registerTool`:
 *
 *   registry.register("ticket_get", {
 *     description: "Get a ticket by id",
 *     inputSchema: { projectId: z.string(), ticketId: z.string() }
 *   }, async (args) => ok(...));
 *
 * `inputSchema` is a Zod "shape" (an object mapping arg name → Zod type), not a
 * `z.object(...)` — identical to the SDK — so the existing 70 tool definitions
 * (incl. their `tolerateJsonString` preprocessors) port over verbatim.
 */

const { z } = require("zod");

// Typed errors so a frontend can map them to its own channel: the stdio server
// turns these into JSON-RPC error codes (-32601 / -32602), a CLI turns them
// into a non-zero exit + stderr. A tool-level failure (a gate, not-found, …) is
// NOT one of these — the handler returns `{ isError: true, content }` for that.
const CODES = Object.freeze({
  UNKNOWN_TOOL: "UNKNOWN_TOOL",     // no such tool name
  INVALID_PARAMS: "INVALID_PARAMS"  // arguments failed schema validation
});

class ToolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ToolError";
    this.code = code;
  }
}

function createRegistry() {
  const tools = new Map();   // name → { description, objectSchema, handler }
  // SDK-compatible view (name → { handler, description }) for in-process callers
  // that invoke a tool's raw handler directly, bypassing the transport — e.g.
  // the in-process test harness (tests/test-mcp.js: server._registeredTools[name]
  // .handler(args)). The handler here is the RAW callback (no validation), exactly
  // what @modelcontextprotocol/sdk exposed. Drop this when the core is extracted.
  const registeredTools = Object.create(null);

  function register(name, def, handler) {
    // Accept both call shapes: register(name, {description, inputSchema, handler})
    // and register(name, {description, inputSchema}, handler) — the latter mirrors
    // the SDK's registerTool(name, meta, handler) signature exactly.
    if (typeof def === "object" && def && typeof handler === "undefined" && typeof def.handler === "function") {
      handler = def.handler;
    }
    if (typeof name !== "string" || !name) throw new Error("register: a non-empty tool name is required");
    if (tools.has(name)) throw new Error("register: duplicate tool '" + name + "'");
    if (typeof handler !== "function") throw new Error("register: a handler function is required for '" + name + "'");
    const shape = (def && def.inputSchema) || {};
    if (typeof shape !== "object") throw new Error("register: inputSchema must be a Zod shape object for '" + name + "'");
    // Wrap the shape in an object schema. `.passthrough()` keeps unknown keys so
    // out-of-band args (e.g. the identity seam's `actor`, which no tool declares)
    // still reach the handler — matching the SDK's lenient behaviour.
    const objectSchema = z.object(shape).passthrough();
    const description = (def && def.description) || "";
    tools.set(name, { description, objectSchema, handler });
    registeredTools[name] = { handler, description };
    return api;   // chainable
  }

  function has(name) { return tools.has(name); }

  function size() { return tools.size; }

  /**
   * The MCP `tools/list` payload: one entry per tool with its JSON Schema.
   * Zod v4 emits JSON Schema natively (z.toJSONSchema) — no converter dependency.
   * A schema that can't be represented (an exotic preprocessor) falls back to a
   * permissive object schema rather than breaking the whole listing.
   */
  function listTools() {
    const out = [];
    for (const [name, t] of tools) {
      let inputSchema;
      try {
        inputSchema = z.toJSONSchema(t.objectSchema, { io: "input" });
      } catch (_) {
        inputSchema = { type: "object", additionalProperties: true };
      }
      out.push({ name, description: t.description, inputSchema });
    }
    return out;
  }

  /**
   * Validate `rawArgs` against the tool's schema and run its handler.
   * Returns the handler's MCP CallToolResult ({ content, isError? }).
   * Throws ToolError(UNKNOWN_TOOL) / ToolError(INVALID_PARAMS) for protocol-level
   * failures; a frontend maps those to its error channel.
   */
  async function dispatch(name, rawArgs) {
    const t = tools.get(name);
    if (!t) throw new ToolError(CODES.UNKNOWN_TOOL, "unknown tool: " + name);
    let args;
    try {
      args = t.objectSchema.parse(rawArgs == null ? {} : rawArgs);
    } catch (e) {
      const detail = (e && Array.isArray(e.issues))
        ? e.issues.map(i => (i.path && i.path.length ? i.path.join(".") + ": " : "") + i.message).join("; ")
        : String((e && e.message) || e);
      throw new ToolError(CODES.INVALID_PARAMS, "invalid params for " + name + ": " + detail);
    }
    return t.handler(args);
  }

  // `registerTool` is an alias for `register` matching the SDK's method name, so
  // the 70 existing `server.registerTool(...)` calls port over unchanged.
  const api = { register, registerTool: register, has, size, listTools, dispatch, _registeredTools: registeredTools };
  return api;
}

module.exports = { createRegistry, ToolError, CODES };
