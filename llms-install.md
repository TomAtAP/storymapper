# Installing Story Mapper (guide for AI agents)

Story Mapper is a local MCP server plus a browser UI backed by the same
SQLite database. Installing it means: get the code, install dependencies,
register the MCP server with the host application.

<!-- mcp-name: io.github.tomatap/storymapper -->

## 1. Get the code

```sh
git clone https://github.com/TomAtAP/storymapper.git
cd storymapper
npm install
```

Requires Node.js >= 20. `better-sqlite3` compiles/loads a native module
during `npm install`; no further build step exists.

## 2. Register the MCP server

**Claude Code:** run `npm run install-code` (registers the server via
`claude mcp add` in user scope and installs the companion skill to
`~/.claude/skills/storymap`).

**Claude Desktop:** run `npm run install-desktop` (writes the entry into
`claude_desktop_config.json`, keeps a `.bak` backup).

**Any other stdio MCP client (Cline, Cursor, ...):** add this server entry
to the client's MCP settings, replacing `/absolute/path/to/storymapper`:

```json
{
  "mcpServers": {
    "storymap": {
      "command": "node",
      "args": [
        "/absolute/path/to/storymapper/server/index.js",
        "mcp",
        "--data-dir=/absolute/path/to/storymapper/.storymap-data"
      ]
    }
  }
}
```

`--data-dir` decides where the SQLite database lives. Use the same
directory for the MCP server and the browser UI so both see the same
projects. Never delete this directory — it holds the user's planning data.

## 3. Optional: the browser UI

```sh
npm start
# → http://localhost:8770/
```

The UI shows the same projects the MCP tools operate on; every MCP write
appears live in the browser within ~100 ms (WebSocket push).

## 4. Verify

Call the `list_projects` MCP tool — an empty list (no error) means the
server runs correctly. Creating a first project with `project_create`
seeds a default release, process step, and DoR/DoD definitions.
