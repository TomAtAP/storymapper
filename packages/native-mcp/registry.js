"use strict";

/**
 * Native, transport-agnostic, ZERO-DEPENDENCY MCP tool core.
 *
 * A registry of tools + a single `dispatch()` choke-point, plus the stdio
 * (stdio.js) and CLI (cli.js) frontends, form a self-contained native MCP-server
 * toolkit — no transport/I/O imports here, and (SM-312) no validation library
 * either. The registry is VALIDATOR-AGNOSTIC: a tool brings its own JSON Schema
 * (for `tools/list`) and an optional `validate(args)` function. The consumer
 * wires whatever it likes (Storymapper wires Zod via a thin adapter; a caller
 * could use valibot / ajv / a hand-rolled check / nothing).
 *
 *   registry.register("ticket_get", {
 *     description: "Get a ticket by id",
 *     inputSchema: { type: "object", properties: { projectId: { type: "string" } }, required: ["projectId"] },
 *     validate: (args) => { if (typeof args.projectId !== "string") throw new Error("projectId required"); return args; }
 *   }, async (args) => ok(...));
 *
 * `inputSchema` is a plain JSON Schema object (emitted verbatim by `tools/list`).
 * `validate` is optional — when present, `dispatch` runs it before the handler
 * and maps a throw to ToolError(INVALID_PARAMS); when absent, args pass through
 * unvalidated. Both `register(name, {…, handler})` and
 * `register(name, {…}, handler)` shapes are accepted (the latter mirrors the SDK).
 */

// Typed errors so a frontend can map them to its own channel: the stdio server
// turns these into isError tool results, a CLI into a non-zero exit + stderr. A
// tool-level failure (a gate, not-found, …) is NOT one of these — the handler
// returns `{ isError: true, content }` for that.
const CODES = Object.freeze({
  UNKNOWN_TOOL: "UNKNOWN_TOOL",     // no such tool name
  INVALID_PARAMS: "INVALID_PARAMS"  // arguments failed validation
});

class ToolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ToolError";
    this.code = code;
  }
}

const PERMISSIVE_SCHEMA = { type: "object", additionalProperties: true };

function createRegistry() {
  const tools = new Map();   // name → { description, inputSchema, validate, handler }
  // View (name → { handler, description }) for in-process callers that invoke a
  // tool's raw handler directly, bypassing the transport — e.g. the in-process
  // test harness (tests/test-mcp.js: server._registeredTools[name].handler(args)).
  // The handler here is the RAW callback (no validation).
  const registeredTools = Object.create(null);

  function register(name, def, handler) {
    // Accept register(name, {…, handler}) and register(name, {…}, handler).
    if (typeof def === "object" && def && typeof handler === "undefined" && typeof def.handler === "function") {
      handler = def.handler;
    }
    if (typeof name !== "string" || !name) throw new Error("register: a non-empty tool name is required");
    if (tools.has(name)) throw new Error("register: duplicate tool '" + name + "'");
    if (typeof handler !== "function") throw new Error("register: a handler function is required for '" + name + "'");
    const description = (def && def.description) || "";
    const inputSchema = (def && def.inputSchema && typeof def.inputSchema === "object")
      ? def.inputSchema : PERMISSIVE_SCHEMA;
    const validate = (def && typeof def.validate === "function") ? def.validate : null;
    tools.set(name, { description, inputSchema, validate, handler });
    registeredTools[name] = { handler, description };
    return api;   // chainable
  }

  function has(name) { return tools.has(name); }

  function size() { return tools.size; }

  // The MCP `tools/list` payload: one entry per tool with its JSON Schema (as
  // provided at registration — no conversion, no dependency).
  function listTools() {
    const out = [];
    for (const [name, t] of tools) {
      out.push({ name, description: t.description, inputSchema: t.inputSchema });
    }
    return out;
  }

  /**
   * Validate `rawArgs` (if the tool has a validator) and run its handler.
   * Returns the handler's MCP CallToolResult ({ content, isError? }).
   * Throws ToolError(UNKNOWN_TOOL) / ToolError(INVALID_PARAMS); a frontend maps
   * those to its error channel.
   */
  async function dispatch(name, rawArgs) {
    const t = tools.get(name);
    if (!t) throw new ToolError(CODES.UNKNOWN_TOOL, "unknown tool: " + name);
    let args = (rawArgs == null) ? {} : rawArgs;
    if (t.validate) {
      try {
        args = t.validate(args);
      } catch (e) {
        // Prefer a Zod-style issue list if the validator provides one; else the
        // error message. Keeps a readable INVALID_PARAMS for any validator.
        const detail = (e && Array.isArray(e.issues))
          ? e.issues.map(i => (i.path && i.path.length ? i.path.join(".") + ": " : "") + i.message).join("; ")
          : String((e && e.message) || e);
        throw new ToolError(CODES.INVALID_PARAMS, "invalid params for " + name + ": " + detail);
      }
    }
    return t.handler(args);
  }

  // `registerTool` is an alias for `register` matching the SDK's method name.
  const api = { register, registerTool: register, has, size, listTools, dispatch, _registeredTools: registeredTools };
  return api;
}

module.exports = { createRegistry, ToolError, CODES };
