"use strict";

/**
 * Native pass-through CLI frontend (SM-311, Community-Paket release).
 *
 * The SAME transport-agnostic tool core (server/mcp-native/registry.js) the
 * MCP-stdio server dispatches to, exposed over the command line — so a
 * shell-capable coding agent can drive the ~70 tools WITHOUT a wired MCP server
 * (headless / CI / a fresh worktree), and script bulk operations in one shell
 * call. Deliberately a GENERIC pass-through only (agent-only — no ergonomic
 * per-tool subcommands): a tool name + a JSON argument object → dispatch → the
 * tool's JSON result. New tools are covered automatically; no per-tool code.
 *
 *   storymapper tool <name> ['<json-args>']        (or pipe the JSON on stdin)
 *
 * stdout = the tool's result JSON; stderr = errors. Exit codes:
 *   0  ok
 *   1  the tool returned an isError result (a gate / not-found / handler throw)
 *   2  usage / unknown tool / invalid arguments
 */

const { ToolError } = require("./registry.js");

/**
 * Run one pass-through tool call against a registry.
 *   registry — a createRegistry()/buildServer() instance exposing dispatch().
 *   spec     — { name, json } — json is the raw argument STRING (optional).
 *   opts     — { stdout, stderr, stdinData }; streams default to process.*,
 *              stdinData is the piped-stdin string (used when no json is given).
 * Returns the process exit code.
 */
async function runCli(registry, spec, opts) {
  spec = spec || {};
  opts = opts || {};
  const stdout = opts.stdout || process.stdout;
  const stderr = opts.stderr || process.stderr;
  const name = spec.name;

  if (!name || typeof name !== "string") {
    stderr.write("usage: storymapper tool <name> ['<json-args>']   (or pipe JSON on stdin)\n");
    return 2;
  }

  // Argument source: an explicit json string wins; else piped stdin; else {}.
  let rawArgs;
  if (typeof spec.json === "string") rawArgs = spec.json;
  else if (typeof opts.stdinData === "string" && opts.stdinData.trim() !== "") rawArgs = opts.stdinData;

  let args = {};
  if (rawArgs !== undefined && rawArgs.trim() !== "") {
    try { args = JSON.parse(rawArgs); }
    catch (e) { stderr.write("invalid JSON arguments: " + ((e && e.message) || e) + "\n"); return 2; }
  }

  let result;
  try {
    result = await registry.dispatch(name, args);
  } catch (e) {
    // ToolError (unknown tool / invalid params) → usage-ish exit 2; an unguarded
    // handler throw → exit 1. Nothing escapes: the CLI always resolves a code.
    const code = (e instanceof ToolError) ? 2 : 1;
    stderr.write(((e && e.message) || String(e)) + "\n");
    return code;
  }

  const text = (result && result.content && result.content[0] && result.content[0].text) || "";
  if (result && result.isError) { stderr.write(text + "\n"); return 1; }
  stdout.write(text + "\n");
  return 0;
}

module.exports = { runCli };
