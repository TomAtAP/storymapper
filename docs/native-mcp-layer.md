# Native MCP layer — target specification

> Design spec for the "Zero Dependency" release (SM-302…305). Deliverable of
> **SM-307** (SDK-usage analysis). It defines exactly what a dependency-free,
> transport-agnostic tool layer must implement to replace
> `@modelcontextprotocol/sdk` in Storymapper — and to be extractable as a
> standalone community package.

## 1. Why

`@modelcontextprotocol/sdk` is, by a wide margin, the largest source of
transitive dependencies in Storymapper: it drags in a full **Express 5 + Hono**
HTTP-transport tree (`express`, `hono`, `cors`, `body-parser`, `qs`, `cookie`,
`iconv-lite`, `raw-body`, `send`, `accepts`, …) — of the ~131 production
packages, the overwhelming majority come from it. We execute **none** of that:
Storymapper's own HTTP layer is raw `http`, and MCP is used **only over stdio**.
That tree is also the recurring `npm audit` surface.

The MCP surface we actually use is tiny (see §2), and MCP-over-stdio is just
JSON-RPC 2.0 with newline framing (see §4). A native implementation is small,
removes the biggest dependency, and is exactly the kind of "raw, native JS"
component this project is built around.

## 2. Exact SDK surface used today

Grepped across `server/`. The **entire** used surface:

| SDK symbol | Uses | Where |
|---|---|---|
| `new McpServer({ name, version })` | 1 | `mcp.js:351` |
| `server.registerTool(name, { description, inputSchema }, handler)` | 70 | `mcp.js` |
| `new StdioServerTransport()` | 1 | `mcp.js:2482` |
| `server.connect(transport)` | 1 | `mcp.js:2483` |
| `transport.close()` | 2 | `index.js:166,171` |

That is all. Confirmed **not** used: prompts, resources, sampling, roots,
`outputSchema`, tool `annotations`/`title`, completion, logging, HTTP/SSE
transport. The replacement can ignore every one of those.

### 2.1 `registerTool` shape

```js
server.registerTool(name, {
  description: "…",
  inputSchema: { projectId: z.string(), verbose: z.boolean().optional(), … }
}, async (args) => {
  // args is the validated, parsed object
  return ok(payload);         // or fail(message, extras)
});
```

- `inputSchema` is a **plain object mapping arg name → a Zod type** (a Zod
  "shape"), NOT a `z.object(...)`. The SDK wraps it in an object schema, emits
  JSON Schema for `tools/list`, validates incoming `arguments`, and passes the
  parsed object to the handler.
- Handler is `async (args) => result`, where `result` is the MCP tool-result
  shape (§3). `mcp.js` builds these via two helpers:

```js
function ok(payload)  { return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] }; }
function fail(msg, x) { return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: msg, ...x }) }] }; }
```

- Several schemas are wrapped in `tolerateJsonString(...)` (a `z.preprocess`
  that `JSON.parse`s a string argument) because Claude Code's MCP bridge
  serialises nested objects/arrays as JSON strings. **This must be preserved** —
  it is a `z.preprocess`, so it survives any Zod-based validator unchanged.

## 3. Tool-result content shape

Every handler returns an MCP `CallToolResult`:

```jsonc
{ "content": [ { "type": "text", "text": "…json…" } ], "isError": false }
```

`isError: true` marks a tool-level failure (validation gate, not-found, …) —
the agent still receives the structured JSON body. Protocol-level failures
(unknown method, malformed request, unknown tool, invalid params) are JSON-RPC
**errors** instead (§4.3).

## 4. Protocol subset to implement

MCP stdio = **newline-delimited JSON-RPC 2.0** over stdin/stdout: one JSON
object per line, no embedded newlines, no `Content-Length` framing. Confirmed by
the existing round-trip test (`tests/test-mcp-stdio.js`), whose homegrown client
sends `JSON.stringify({ jsonrpc:"2.0", id, method, params }) + "\n"`.

### 4.1 Messages we must handle (requests → responses)

| Method | Params | Result |
|---|---|---|
| `initialize` | `{ protocolVersion, capabilities, clientInfo }` | `{ protocolVersion, capabilities: { tools: {} }, serverInfo: { name, version } }` |
| `tools/list` | `{}` (optional `cursor`) | `{ tools: [ { name, description, inputSchema: <JSON Schema> } ] }` |
| `tools/call` | `{ name, arguments }` | the handler's `CallToolResult` (§3) |
| `ping` | `{}` | `{}` |

### 4.2 Notifications (no `id`, no response)

- `notifications/initialized` — client signals it is ready; we accept + ignore.
- (We send none today; keep the door open for `notifications/tools/list_changed`.)

### 4.3 Errors — two channels (verified against the real SDK subprocess)

The current SDK does NOT map every failure to a JSON-RPC error. Driving the real
`storymap mcp` subprocess shows two distinct channels — the native frontend MUST
match both, or the client-visible failure shape changes silently (no existing
test covers these paths):

**JSON-RPC error object** — only for genuine PROTOCOL faults on the envelope:
- `-32700` parse error (a malformed JSON line), `-32600` invalid request,
  `-32601` method not found (an unknown top-level method — i.e. not one of
  `initialize` / `tools/list` / `tools/call` / `ping`).

**`isError` tool-RESULT** — for everything that happens INSIDE `tools/call`:
- unknown tool name, failed argument validation, AND a handler that **throws**
  → a normal `{ result: { isError: true, content: [{ type:"text", text }] } }`.
  The SDK renders all three as tool results (not JSON-RPC errors), so the agent
  still receives a structured body. `ping` → `{}`.

Mechanism: `registry.dispatch` THROWS `ToolError(UNKNOWN_TOOL|INVALID_PARAMS)`
and lets handler rejections propagate; the **stdio frontend catches both and
renders an `isError` result** (§5.1). A CLI frontend maps the same throws to a
non-zero exit + stderr — which is exactly why the registry throws typed errors
instead of pre-rendering an MCP result.

### 4.4 Protocol version

Echo the client's `protocolVersion` if we support it; otherwise return our
latest supported version. A single supported version string is enough for now;
do not hard-fail on a mismatch the client can downgrade from.

## 5. Target architecture — transport-agnostic core + frontends

The key design move (enables the CLI idea, SM-304, and the extraction, SM-305):

```
        ┌───────────────────────── tool core (dependency-free) ──────────────────────┐
        │  registry:  register(name, { description, inputSchema, handler })            │
        │  listTools() → [{ name, description, inputSchema: <JSON Schema> }]            │
        │  dispatch(name, rawArgs) → validate(inputSchema) → handler(args) → result    │
        └────────────────────────────────────────────────────────────────────────────┘
              ▲                                   ▲
              │ tools/list + tools/call           │ argv → name + args
     ┌────────┴─────────┐               ┌─────────┴──────────┐
     │  MCP-stdio front  │ (SM-303)      │   CLI front (SM-304)│  (exploration)
     │  JSON-RPC 2.0 I/O │               │  storymap tool …    │
     └───────────────────┘               └────────────────────┘
```

- **`dispatch(name, args)`** is the single choke-point every frontend calls:
  it looks up the tool, validates `args`, runs the handler, returns the
  `CallToolResult`. It throws a typed error (`UNKNOWN_TOOL` / `INVALID_PARAMS`)
  that a frontend maps to its own error channel (JSON-RPC error for stdio, a
  non-zero exit + stderr for the CLI).
- The core imports **nothing transport-related** (no stdio, no http). Frontends
  own the I/O.
- `buildServer(storage, opts)` in the current `mcp.js` becomes
  `buildRegistry(storage, opts)` returning the core registry; the `notify-change`
  bus-forwarder (E20.E) moves into the stdio frontend (it is process/transport
  concern, not tool concern) or stays alongside the registry builder — decide in
  SM-303.

### 5.1 stdio-frontend obligations (SM-309)

The core leaves these to the frontend; miss one and behaviour changes silently
(the existing round-trip test cannot catch any of them):

1. **Catch everything from `dispatch`.** Wrap every `dispatch` call in
   try/catch and convert `ToolError` AND handler rejections into `isError` tool
   results (§4.3). If a rejection escapes the read loop, `index.js`'s
   `unhandledRejection` handler runs `stop()` and the MCP process **exits** — a
   transient storage error inside a read tool would kill the server. Many read
   handlers and `project_create` / `project_delete` / `attachment_*` throw
   rather than return `fail()`; today the SDK's try/catch absorbs that.
2. **Non-blocking dispatch, out-of-order responses.** Do NOT `await` a handler
   before reading the next line. `request_switch_project` awaits up to ~125 s
   (`wait_seconds` ≤ 120 + safety); a serial loop would freeze the whole server
   for every other tool call meanwhile. Dispatch each request concurrently and
   write each id-matched response when its promise settles — exactly what the
   SDK's stdio transport does.
3. **Preserve the notify-change forwarder (E20.E).** The `bus.on("change")` →
   POST `/api/internal/notify-change` bridge is what makes MCP writes appear
   live in the browser. `buildRegistry(storage, opts)` must thread
   `opts.httpUrl` / `opts.fetchImpl` into BOTH the forwarder and
   `request_switch_project`'s closures. Its loss is invisible to the stdio test
   (the only forwarder tests are in-process).
4. **Lifecycle contract.** `runStdio(storage, opts)` must still return
   `{ transport }` with an **idempotent** `close()` that stops reading stdin and
   ends output; the `connect(registry)` equivalent wires transport → dispatch and
   starts the read loop. `index.js` calls `transport.close()` on stdin `end` and
   in `installShutdown`.
5. **stdout framing invariant.** Write exactly one JSON-RPC envelope per line:
   `stdout.write(JSON.stringify(envelope) + "\n")` — stringify the WHOLE envelope
   (so the pretty-printed newlines inside `content[].text` are escaped to `\n`),
   never concatenate pre-serialized fragments. All diagnostics stay on stderr —
   any stray stdout write corrupts the stream. (Currently clean: no
   `console.log` / `process.stdout.write` anywhere in the tool/core chain.)

## 6. Validation — the zod decision (input to SM-308)

**Recommendation: keep `zod`.** It is a direct dependency with **zero transitive
dependencies**, so it does not contribute to the bloat this release targets. It
also removes the need for a JSON-Schema converter dependency:

- Zod **v4** (we are on `^4.4.3`) ships native JSON-Schema export via
  `z.toJSONSchema(schema)` — so `tools/list` schemas come for free, no
  `zod-to-json-schema` package.
- The existing 70 tool schemas + the `tolerateJsonString` preprocessors carry
  over verbatim; a rewrite to a hand-rolled validator would be high-risk churn
  for no dependency saving.

The core wraps the per-tool `inputSchema` shape in `z.object(shape)` for
validation and `z.toJSONSchema` for listing — exactly what the SDK did.
(Revisit only if we later want a truly zero-dependency extracted package; then a
minimal native validator is a separate, optional story.)

## 7. Non-goals

- No HTTP or SSE transport (Storymapper's HTTP is raw `http`; MCP is stdio-only).
- No prompts, resources, sampling, roots, completion, logging capabilities.
- No `outputSchema` / structured-content, tool `annotations`, or `title` — unused.
- Not a general MCP framework; just the subset Storymapper (and a typical
  stdio tool server) needs. Extra capabilities are additive later.

## 8. Acceptance for the Core epic (SM-302)

The core is done when: a `registry` supports `register` / `listTools`
(JSON-Schema out) / `dispatch` (validate → run), is transport-agnostic (no I/O
imports), and has unit tests covering register, list-schema emission, dispatch
happy-path, unknown-tool, and invalid-params. The MCP-stdio frontend (SM-303)
and the port of `mcp.js` (SM-310) build on this contract.
