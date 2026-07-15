# native-mcp

**A tiny, zero-dependency native [MCP](https://modelcontextprotocol.io) server
toolkit** — a validator-agnostic tool registry with a JSON-RPC 2.0 **stdio**
frontend and a pass-through **CLI**. No transport framework, no validation
library, no dependencies at all. Bring your own schemas.

It exists to replace `@modelcontextprotocol/sdk` for the common case — a
stdio MCP server that exposes a set of tools — without pulling an entire
Express/Hono HTTP stack you never run. Extracted from
[Storymapper](https://github.com/TomAtAP/storymapper).

## Install

```sh
npm install native-mcp
```

Requires Node ≥ 20. `dependencies: {}` — really.

## Use

```js
const { createRegistry, createStdioServer } = require("native-mcp");

const registry = createRegistry();

registry.register("greet", {
  description: "Greet someone",
  // A plain JSON Schema — emitted verbatim by tools/list.
  inputSchema: {
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"]
  },
  // Optional. Any validator: return the (possibly coerced) args, or throw.
  validate: (args) => {
    if (typeof args.name !== "string") throw new Error("name must be a string");
    return args;
  }
}, async (args) => ({
  content: [{ type: "text", text: "Hello, " + args.name + "!" }]
}));

createStdioServer(registry);   // now speaks MCP over stdin/stdout
```

That's a complete MCP server: `initialize`, `tools/list`, `tools/call`, `ping`,
notifications, and JSON-RPC framing are handled for you.

## The three pieces

- **`createRegistry()`** — the transport-agnostic core.
  - `register(name, { description, inputSchema, validate? }, handler)` —
    `inputSchema` is a plain JSON Schema (for `tools/list`); `validate` is an
    optional `(args) => parsedArgs` that throws on bad input (mapped to a
    `ToolError(INVALID_PARAMS)`). `handler(args)` returns an MCP tool result
    `{ content: [{ type: "text", text }], isError? }`.
  - `listTools()` → `[{ name, description, inputSchema }]`.
  - `dispatch(name, args)` → runs validate + handler; throws
    `ToolError(UNKNOWN_TOOL | INVALID_PARAMS)`.
- **`createStdioServer(registry, opts?)`** — the MCP-stdio frontend. Speaks
  newline-delimited JSON-RPC 2.0. `tools/call` failures (unknown tool, invalid
  args, a throwing handler) come back as `isError` tool results, not JSON-RPC
  errors — matching the SDK. Non-blocking dispatch (a slow handler doesn't stall
  the loop). Returns `{ close }`.
- **`runCli(registry, spec, opts?)`** — a generic pass-through CLI so the same
  tools are reachable from a shell without an MCP client: run one tool by name
  with a JSON argument string (or piped stdin), print the result JSON on stdout.
  Exit codes: `0` ok, `1` tool `isError`, `2` unknown tool / bad args.

## Validator-agnostic

The registry knows nothing about how you validate. Wire whatever you like:

```js
// with zod (v4): emit the JSON Schema + a validate() from a zod shape
const { z } = require("zod");
const shape = { name: z.string() };
const objectSchema = z.object(shape).passthrough();
registry.register("greet", {
  description: "…",
  inputSchema: z.toJSONSchema(objectSchema, { io: "input" }),
  validate: (args) => objectSchema.parse(args)
}, handler);
```

Or valibot, ajv, a hand-rolled check, or nothing at all (omit `validate` and
args pass straight through).

## License

Apache-2.0. See [LICENSE](LICENSE).
