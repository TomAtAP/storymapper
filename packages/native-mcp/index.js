"use strict";

/**
 * native-mcp — a tiny, ZERO-DEPENDENCY native MCP server toolkit.
 *
 *   const { createRegistry, createStdioServer } = require("native-mcp");
 *
 *   const registry = createRegistry();
 *   registry.register("hello", {
 *     description: "say hi",
 *     inputSchema: { type: "object", properties: { name: { type: "string" } } },
 *     validate: (a) => a,                       // optional; bring any validator
 *   }, async (a) => ({ content: [{ type: "text", text: "hi " + (a.name || "") }] }));
 *
 *   createStdioServer(registry);                // speaks MCP over stdin/stdout
 *
 * See README.md for the full surface. No dependencies — bring your own schema
 * validator (zod / valibot / ajv / hand-rolled / none).
 */

const { createRegistry, ToolError, CODES } = require("./registry.js");
const { createStdioServer, PROTOCOL_VERSION, RPC, SERVER_INFO } = require("./stdio.js");
const { runCli } = require("./cli.js");

module.exports = {
  // core
  createRegistry, ToolError, CODES,
  // MCP-stdio frontend
  createStdioServer, PROTOCOL_VERSION, RPC, SERVER_INFO,
  // pass-through CLI frontend
  runCli
};
