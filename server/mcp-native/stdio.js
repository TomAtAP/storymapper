"use strict";

/**
 * Native MCP-stdio frontend (SM-309, Zero Dependency release).
 *
 * Speaks newline-delimited JSON-RPC 2.0 over a pair of streams (stdin/stdout by
 * default) and dispatches `tools/call` to a transport-agnostic registry
 * (server/mcp-native/registry.js). Replaces @modelcontextprotocol/sdk's
 * McpServer + StdioServerTransport. Dependency-free.
 *
 * Design obligations (docs/native-mcp-layer.md §4.3 + §5.1), all load-bearing:
 *   1. tools/call failures (unknown tool, invalid args, handler throw) become
 *      `isError` tool RESULTS — never JSON-RPC errors (matches the SDK). Only
 *      genuine protocol faults (parse error, unknown method) are JSON-RPC errors.
 *   2. Every dispatch is wrapped so a handler rejection can NEVER escape the read
 *      loop (an escaped rejection would trip index.js's unhandledRejection → exit).
 *   3. Dispatch is non-blocking: a slow handler (request_switch_project awaits
 *      ~125s) does not stall other requests; responses are id-matched and may
 *      come back out of order.
 *   4. `close()` is idempotent, detaches the input listeners, stops writing.
 *   5. One JSON-RPC envelope per line: stringify the WHOLE envelope + "\n".
 */

const { ToolError } = require("./registry.js");

// The MCP protocol version we advertise when the client doesn't send one. We
// otherwise echo the client's requested version (MCP is negotiated per-session).
const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "storymap", version: "0.1.0" };

// JSON-RPC 2.0 error codes — used ONLY for protocol-level faults (§4.3).
const RPC = Object.freeze({
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INTERNAL: -32603
});

/**
 * Attach a native MCP server to an input/output stream pair.
 *   registry — a createRegistry() instance (register/listTools/dispatch).
 *   opts.input  — readable (default process.stdin)
 *   opts.output — writable (default process.stdout)
 *   opts.onEnd  — called when the input stream ends (stdin EOF)
 * Returns { close } — `close()` is idempotent (the lifecycle contract index.js
 * drives via transport.close()).
 */
function createStdioServer(registry, opts) {
  opts = opts || {};
  const input = opts.input || process.stdin;
  const output = opts.output || process.stdout;
  let buffer = "";
  let closed = false;

  // Obligation 5: write exactly one stringified envelope per line. Stringifying
  // the whole envelope escapes any inner newline (e.g. the pretty-printed JSON in
  // content[].text) to \n, so framing stays one-object-per-line.
  function write(envelope) {
    if (closed) return;
    try { output.write(JSON.stringify(envelope) + "\n"); } catch (_) { /* stream gone */ }
  }
  function sendResult(id, result) { write({ jsonrpc: "2.0", id, result }); }
  function sendError(id, code, message) {
    write({ jsonrpc: "2.0", id: id === undefined ? null : id, error: { code, message } });
  }
  function isErrorResult(text) {
    return { content: [{ type: "text", text }], isError: true };
  }

  // Handle one parsed JSON-RPC message. Never throws (tools/call is guarded), so
  // the read loop can fire-and-forget it (obligation 2 + 3).
  async function handleMessage(msg) {
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
      sendError(null, RPC.INVALID_REQUEST, "invalid request"); return;
    }
    const method = msg.method;
    const isNotification = msg.id === undefined;   // JSON-RPC: no id ⇒ no response

    if (typeof method !== "string") {
      if (!isNotification) sendError(msg.id, RPC.INVALID_REQUEST, "missing method");
      return;
    }

    // Notifications (e.g. notifications/initialized): accept + never respond.
    if (isNotification) return;

    const id = msg.id;
    switch (method) {
      case "initialize": {
        const clientVer = msg.params && msg.params.protocolVersion;
        sendResult(id, {
          protocolVersion: typeof clientVer === "string" ? clientVer : PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO
        });
        return;
      }
      case "ping":
        sendResult(id, {});
        return;
      case "tools/list":
        sendResult(id, { tools: registry.listTools() });
        return;
      case "tools/call": {
        const params = msg.params || {};
        try {
          const result = await registry.dispatch(params.name, params.arguments || {});
          sendResult(id, result);
        } catch (e) {
          // Obligation 1 + 2: unknown-tool, invalid-params AND handler throws all
          // become isError tool RESULTS (matching the SDK), not JSON-RPC errors —
          // and nothing escapes to crash the process.
          const text = (e instanceof ToolError)
            ? "MCP error: " + e.message
            : "tool execution error: " + ((e && e.message) || String(e));
          sendResult(id, isErrorResult(text));
        }
        return;
      }
      default:
        sendError(id, RPC.METHOD_NOT_FOUND, "method not found: " + method);
    }
  }

  function processBuffer() {
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); }
      catch (_) { sendError(null, RPC.PARSE, "parse error"); continue; }
      // Obligation 3: do NOT await here — fire the handler and let it write its
      // response when it settles, so a slow handler never blocks the read loop.
      // Obligation 2: the .catch is a last-resort net; handleMessage itself never
      // throws, but a defensive guard keeps a rejection from ever escaping.
      Promise.resolve().then(() => handleMessage(msg)).catch((e) => {
        try { sendError(msg && msg.id !== undefined ? msg.id : null, RPC.INTERNAL, "internal error"); } catch (_) { /* ignore */ }
      });
    }
  }

  function onData(chunk) { buffer += chunk.toString("utf8"); processBuffer(); }
  function onEnd() { if (typeof opts.onEnd === "function") opts.onEnd(); }

  if (input.setEncoding) input.setEncoding("utf8");
  input.on("data", onData);
  input.on("end", onEnd);
  if (input.resume) input.resume();

  // Obligation 4: idempotent close — detach input, stop writing. We never destroy
  // a shared process.stdout; we just stop emitting.
  function close() {
    if (closed) return;
    closed = true;
    try { input.off("data", onData); } catch (_) { /* ignore */ }
    try { input.off("end", onEnd); } catch (_) { /* ignore */ }
    if (input.pause) { try { input.pause(); } catch (_) { /* ignore */ } }
  }

  // `_handleMessage` is exposed for unit tests that want to drive one message
  // synchronously without the stream plumbing.
  return { close, _handleMessage: handleMessage };
}

module.exports = { createStdioServer, PROTOCOL_VERSION, RPC, SERVER_INFO };
