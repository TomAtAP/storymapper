# Storymapper — Architecture

This document is the map for anyone reading or contributing to the code. It
covers the shape of the system, the deliberate design decisions, the data model,
and the few non-obvious mechanisms that make the whole thing work. For install
and usage, see [README.md](README.md).

---

## 1. The three surfaces

One package exposes the same data three ways:

```
                         ┌───────────────────────────┐
   Browser  ── HTTP ───▶ │                           │
     UI     ◀─ WebSocket │       HTTP + WS server    │──▶ SQLite
                         │        (server/*.js)       │    (revisions,
   Claude  ── stdio ───▶ │       MCP server          │     snapshots,
   (agent)   MCP         │        (server/mcp.js)     │     attachments)
                         └───────────────────────────┘
                                     │
                              shared/core.js
                        (pure domain logic, one copy)
```

- **HTTP + WebSocket server** (`server/server.js`) — serves the frontend, exposes
  a REST surface, and pushes live changes to subscribed browsers.
- **MCP server** (`server/mcp.js`) — ~70 stdio tools wrapping the same operations,
  so an AI agent edits the same projects.
- **SQLite storage** (`server/storage.js`) — the single persistence layer both
  servers write through.

A **process bus** (`server/bus.js`, a plain `EventEmitter`) decouples writes from
push: storage emits `change`, the WebSocket layer relays it.

## 2. Principles & deliberate non-goals

These are load-bearing constraints, not preferences. Please honour them in PRs.

- **No build step.** No bundler, transpiler or TypeScript. If you find yourself
  wanting one, stop.
- **No frontend framework, no ES modules in the browser.** Classical
  `<script src>` tags loading UMD modules that attach to a `window.STORYMAP`
  namespace. This keeps the page trivially serveable and debuggable.
- **No HTTP framework.** Raw `http.createServer` with manual routing. It stays
  small and dependency-light on purpose (Express, Fastify, etc. are out).
- **Pure logic lives in exactly one file.** See §4.
- **Single-user, local-first.** No auth layer yet; the seam exists (§13) but RBAC
  is a later stage. The server is meant for loopback only.
- **Constants, not magic numbers.** Layout sizes, limits, timeouts and debounce
  windows live in a named constants block at the top of each module (e.g.
  `STORY_MAP_LAYOUT`, `KANBAN_LAYOUT`, `LIMITS`, `RETENTION`). Tests reference the
  constant, never the literal.

## 3. Directory layout

```
shared/                 Single source of truth for pure logic.
  core.js               normalize*, ops, resolveDefinitions, workflow +
                        governance engines, diff, view-helpers. No I/O, no DOM.
  core/graph.js         Pure graph algorithms (critical path, impact set, …).
  ticket-import.js      CSV / JSON import parsing + value mapping.
  project-io.js         Export / import of a whole project.
  query*.js             The ticket query language + autocomplete.

server/
  core.js               Thin re-export of shared/core.js (legacy require path).
  core/graph.js         Thin re-export of shared/core/graph.js.
  storage.js            better-sqlite3 wrapper: per-project mutex, atomic
                        transactional writes, monotonic revision IDs,
                        count-based retention, attachments on disk.
  validation.js         Per-op validators; delegates status-transition + limit
                        rules to shared/core (no duplicated rules).
  bus.js                Process-wide EventEmitter ('change', 'switch_request', …).
  identity.js           Actor resolution + the pluggable authorize() choke-point.
  server.js             HTTP routing + WebSocket layer. Exports startServer().
  mcp.js                MCP tools wrapping ops + storage.
  index.js              CLI entry: `storymapper server|mcp`. Shutdown handling.
  ingest.js             PDF/DOCX slice-candidate extraction (import pipeline).

frontend/
  storymap.html         The shell: structure + CSS link + script tags + bootstrap.
  css/storymap.css      Paperlike theme.
  js/
    core.js             Symlink → ../../shared/core.js (the single source).
    core/graph.js       Symlink → ../../../shared/core/graph.js.
    store.js            ProjectStore: local ops, undo/redo, applyRemote, hydrate.
    adapters.js         Http / LocalStorage / Memory adapters + WS subscribe.
    renderer-card.js    Shared ticket-card component (used by every view).
    renderer-storymap.js  SVG/DOM Story Map (process steps × releases × epics).
    renderer-kanban.js    Kanban board (status/board-column lanes).
    renderer-ticket-modal.js / ticket-form.js   Ticket editor (modal + full page).
    renderer-dependencies.js   Typed-link dependency graph view.
    view-table.js / view-requirements.js / view-process-steps.js / view-settings.js
    dnd.js              Pointer-event drag-and-drop engine.
    card-animate.js     FLIP + pulse animations for external (live-sync) commits.
    main.js             Bootstrap: pick adapter → store → views → menus.

skill/SKILL.md          The agent-facing skill: how Claude should use the board.
tests/                  Plain-Node test scripts + run.js loader (see §14).
fixtures/               Seed snapshots for demos/smoke.
```

## 4. Single source for pure logic (the symlink pattern)

Domain logic must run in three contexts — the browser, the HTTP server and the
MCP server — without a build step and without hand-mirroring.

- `shared/core.js` is the **only** copy. It is **UMD-wrapped**: `require()`d in
  Node, and `<script src>`'d in the browser where it attaches to
  `window.STORYMAP.core`.
- `frontend/js/core.js` is a **symlink** to `shared/core.js`. The browser loads
  the real file through it.
- `server/core.js` is a **3-line re-export shim** (`module.exports =
  require("../shared/core.js")`), so historical `require("./core.js")` paths keep
  working.

The same applies to `core/graph.js`, `ticket-import.js`, `project-io.js` and the
query modules.

> **Edit only `shared/…`.** Never edit `server/core.js` (a shim) or
> `frontend/js/core.js` (a symlink). There is no mirror step and no parity test —
> because there is only one file.

## 5. Data model

Everything is stored as **one JSON snapshot per project** (the canonical form),
plus append-only revision rows and on-disk attachments.

| Table | Purpose |
| --- | --- |
| `projects` | `id`, the full `snapshot` JSON, `saved_at`, current `revision`, soft-delete flags. |
| `revisions` | `(project_id, revision)` PK, the full snapshot at that point, `op`, `actor`. Append-only, count-retained. |
| `attachments` | Metadata + on-disk relative path (files live next to the DB, never as blobs). |

Inside a snapshot, the domain entities are:

- **Project** — name, ticket prefix + counter, `definitions` (DoR/DoD),
  `workflow` (statuses/transitions), `boards.kanban.columns`, `ticketTypes`,
  `entityTypeConfig`, labels.
- **Ticket** — type (`epic` / `user-story` / `bug` / `task` / …), key, title,
  description, status, `position` (`{epicId, processStepId, releaseId,
  sortOrder}`), **frozen** `definitionOfReady` / `definitionOfDone`,
  `acceptanceCriteria`, comments, labels, typed `links`.
- **Release** — a shippable product version that bundles many features.
- **ProcessStep** — a phase of the user journey; the columns of the story map.

Every entity carries **audit** columns: `createdAt/By`, `updatedAt/By` (actor is
`{type, id, name, sessionId?}`), and a monotonic `version` for optimistic locking.

## 6. Definition of Ready / Definition of Done (first-class)

Each project owns a `definitions` object with a `ready` and a `done` block. Each
block has `global` items plus per-ticket-type `appended` or `overridden` items.
The pure function `resolveDefinitions(definitions, ticketType)` produces the
effective list for a type.

- **Freeze on create.** When a ticket is created, the resolved checklist is
  copied onto the ticket. Later project-level changes do **not** retroactively
  alter open tickets.
- **Gated transitions.** The workflow marks which transitions require a gate.
  Moving into a `requireGate: "DoR"` status while a required DoR item is unchecked
  throws `{ statusCode: 422, missing: [...] }`; likewise DoD on the way to `done`.
- The MCP layer translates that 422 into a structured tool error, so the agent
  gets a machine-readable list of what's still missing. **A conforming agent
  never forces `done` — it checks the items off first.**

## 7. The workflow engine

`project.workflow` is fully configurable (Jira-style):

- **Statuses** are objects `{id, name, category}` with `category ∈
  todo | doing | blocked | done`.
- **Transitions** are a named list: `{id, name, fromStatuses[], toStatus,
  requireGate, allowFromAny}`. A transition matches when `toStatus` fits and
  either `allowFromAny` is set or `fromStatuses` includes the current status.
  Specific transitions win over generic ones.
- `validateStatusTransition` (pure, in `shared/core.js`) is the single gate
  checkpoint; the REST route, the store, and every MCP status tool go through it.
  No matching transition → `422 { kind: "TRANSITION" }`.
- Per-type overrides merge over the base workflow via `getWorkflowForType`.

Legacy string-array workflows migrate automatically on load.

## 8. Derived epic status (roll-up)

An **epic has no manual status**. `deriveEpicStatus(snapshot, epicId)` rolls it up
from its contained stories (resolved via `contains` links) over the status
categories: no children → first `todo`; all children `done` → first `done`; any
child in progress → first `doing`; else `todo`. `recomputeEpicStatuses` runs at
the end of every mutating op that can change a child's status or containment, and
as the last pass of `normalizeSnapshot` (which doubles as the migration for
legacy data). It sets only `ticket.status` — never bumps `version` (it is a
derivation, not an actor action). Every manual status path rejects epics with
`{ statusCode: 422, kind: "EPIC_STATUS_DERIVED" }`.

## 9. Kanban board mapping

`project.boards.kanban.columns` is a list of `{id, name, statusIds[]}`. The board
maps **N statuses → 1 column** (like Jira). The default is 1:1 with the workflow.
`computeKanbanLayout` builds lanes from the columns; a status that maps to no
column surfaces in a synthetic trailing lane so tickets are never invisible.
Dropping a card into a column that already contains its status is a pure reorder;
otherwise the card's status changes to the column's first status.

## 10. Live sync

The path from a write to a browser repaint:

1. A write lands in `storage._writeLocked`, which — after the transaction commits
   — calls `bus.emit("change", { projectId, revision, savedAt, op, actor,
   originId })`.
2. The WebSocket layer subscribes to `change` and **broadcasts** to every client
   subscribed to that `projectId`.
3. An **origin-id echo filter** suppresses the echo back to the client that
   caused the change (each mutating client registers an `originId`; the browser
   already applied its own change optimistically via the store).
4. The browser's `ProjectStore.applyRemote(snapshot)` commits the incoming state
   as a regular undo entry (a no-op if structurally identical), and the renderer
   plays a **FLIP + pulse** animation (`card-animate.js`) so external changes are
   visually obvious.

**Cross-process** live sync (the MCP server writing while the HTTP server serves
the browser): the two processes share the SQLite file but have separate buses.
The MCP process forwards its `change` events to the HTTP server via
`POST /api/internal/notify-change`, which re-emits them on the HTTP server's bus —
from there the normal broadcast + echo-filter path runs unchanged. A browser sees
an MCP write within ~50 ms, exactly as if another browser had made it.

The same bridge also powers `request_switch_project`: an agent can ask the human's
browser to switch to a project it just created, resolved through a WebSocket
prompt and a long-poll.

## 11. Storage internals

- **Atomic writes.** Each save is one `better-sqlite3` transaction: upsert the
  project row + insert the revision row + (periodically) prune. A mid-write throw
  rolls the whole thing back; `bus.emit` fires only after commit.
- **Per-project mutex.** An in-memory keyed promise chain serialises writes to a
  project within the process, closing the lost-update window of a separate
  load→save pair (`storage.mutate` does load-modify-write under one acquisition).
- **Monotonic revision IDs.** `YYYYMMDD-HHmmss-mmm[-NNNN]` (UTC), minted by a
  high-water-mark counter so IDs are strictly increasing and string-sortable.
  Across two processes sharing a data dir, a same-millisecond collision on the
  revisions PK is caught and the id re-minted (bounded retry); `busy_timeout`
  makes the second writer wait rather than fail.
- **Bounded retention.** Retention is purely count-based (newest N per project,
  default 150), pruned inside the write transaction every Nth save. (An unbounded
  history once grew a DB to ~1.8 GB — hence a hard cap, not an age window.)
- **Attachments** live on disk next to the DB with size caps and path-containment
  checks; the DB stores only metadata + a relative path.

## 12. HTTP + WebSocket layer

- Raw routing in `server/server.js#buildRouter`; handlers delegate to
  `core.ops` + `validation` + `storage` and never contain domain logic.
- A central JSON body reader enforces size caps, rejects invalid JSON, and strips
  `__proto__` / `constructor` / `prototype` (prototype-pollution guard).
- Static file serving resolves within `FRONTEND_DIR`, rejects `..`, and
  re-checks `realpath` against the root (symlink-escape guard).
- The WebSocket layer runs a **ping/pong heartbeat** that terminates
  unresponsive clients so dead subscriptions don't leak.
- Everything is loopback-gated (see the security model in the README).

## 13. MCP layer

- ~70 tools, each defined with a Zod input schema and delegating to the shared
  ops. Responses are **compact by default** (the changed entity + `revision` +
  `savedAt`, not the whole snapshot).
- A shared `persist()` helper wraps load-mutate-write and translates thrown
  `{statusCode, kind, missing}` into a uniform structured tool error, so agents
  get machine-readable failures (e.g. a DoD gate).
- `tolerateJsonString` preprocesses nested arguments (position, patch, workflow,
  board columns) that some MCP bridges serialise as JSON strings, so object and
  string inputs both validate.
- `server/identity.js` is the authorization seam: `resolveActor` /
  `resolveAiActor` never mint an "unknown" actor on a write path, and a single
  `authorize(actor, op, entity)` choke-point (no-op allow-all today) is where RBAC
  will plug in.

## 14. Frontend architecture

- **Store-centric.** `ProjectStore` (`store.js`) is the source of truth in the
  browser. All mutations run locally through `core.ops` and commit via
  `_commit(next, reason)`; a debounced subscriber persists the whole snapshot via
  `PUT /api/projects/:id`. This gives real **undo/redo** (Cmd-Z / Cmd-Shift-Z)
  even over HTTP. `applyRemote` folds WebSocket pushes in as ordinary undo
  entries. The accepted trade-off is last-write-wins at the browser level.
- **Adapters** (`adapters.js`) abstract the backend: `HttpAdapter` (REST + WS
  subscribe), `LocalStorageAdapter`, `MemoryAdapter`, chosen by `pickAdapter`.
- **Shared card component** (`renderer-card.js`) renders the identical ticket card
  in every view (DRY).
- **Views** each mount/unmount against the store and re-render on commit: Story
  Map, Kanban, Table, Dependencies, Requirements, Settings.
- **Drag and drop** is a custom pointer-event engine (`dnd.js`) — HTML5 DnD was
  unreliable across browsers — with live insertion-index previews.

## 15. Testing

- **Plain Node scripts.** `tests/test-*.js` with a tiny `test(name, fn)` helper;
  `tests/run.js` loads them sequentially. No mocha/jest/vitest. `jsdom` in tests
  only. Run with `npm test` (≈1800 assertions); CI runs it on Node 20 and 22.
- **Layered coverage:** pure ops + normalize + workflow/governance;
  storage atomicity/mutex/revisions; validation gates; REST + WebSocket
  live-sync; MCP tools both in-process (`reg.handler`) **and** via a stdio
  JSON-RPC subprocess; JSDOM renderer tests; and a **real-server end-to-end test**
  (`tests/test-e2e.js`) that drives bootstrap → click → server round-trip → DOM
  state, because only the composed test proves the pieces fit.
- **Data safety:** tests only ever use `os.tmpdir()` — the suite never touches a
  user data directory. This is a hard rule for any new test or script.

New behaviour is written test-first; a bug gets a regression test before the fix;
pure-logic changes go in `shared/core.js` and are covered there.

## 16. Security model

Summarised in the README. In short: loopback-only, CORS/CSP/WS-origin locked to
local origins, prototype-pollution and path-traversal guards, body-size caps, and
an authorization seam ready for a future auth stage. Do not expose the server
beyond `127.0.0.1` without adding your own authentication in front.
