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

### 4.3 Errors (JSON-RPC error object)

- `-32700` parse error, `-32600` invalid request, `-32601` method not found,
  `-32602` invalid params (Zod validation failure on `tools/call` arguments, or
  unknown tool name), `-32603` internal error.
- A handler that **throws** → `-32603` (should be rare; tool-level failures use
  `isError` instead).

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
