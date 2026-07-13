# Tool catalogue — when to use what (full detail)

> Reference for the Story Mapper skill. The core SKILL.md (§5) carries a compact
> one-line index; this file has the full when-to-use tables + response shapes.

**Response shapes — compact by default (SM-123).** To keep token cost low, the
write tools and reads return a **compact** payload by default and let you opt
into the full object only when you need it:

- **Ticket-returning mutators** (`ticket_create`, `ticket_update`,
  `change_ticket_status`, `mark_ready`, `complete_ticket`) return
  `{revision, savedAt, ticket: {id, ticketKey, type, status, title, position}}`.
  Pass **`verbose: true`** to get the full ticket (frozen DoR/DoD, AC, links).
- **`set_checklist_item`** returns just `{revision, savedAt, item: {id, checked}}`;
  `verbose: true` for the full ticket.
- **`ticket_get`** returns the full ticket by default; pass `compact: true` for
  the summary, or `fields: [...]` to pick named fields. **`list_tickets`** takes
  `compact: true`.
- `reorder` (tickets), the bulk tools, the link tools, and the test-definition /
  test-execution step+prereq tools are already compact. The test-definition
  lifecycle tools (`publish_test_definition`, `reopen_test_definition`,
  `update_test_definition_metadata`) and `test_exec_start` return the full
  ticket because their meaningful fields (lifecycle, steps, executionSteps)
  aren't in the summary.

Rule of thumb: act on the compact response (it carries `id`/`ticketKey`/`status`/
`position`); only add `verbose: true` when you must read a field the summary
doesn't carry.

### Discovery — "what is here?"
Cheap reads, no side effects. Call before acting in an unfamiliar project.

| Tool | When |
|------|------|
| `list_projects` | "Show me all projects" / orient yourself first. |
| `project_get` | Full snapshot of one project. Use sparingly — big payload. |
| `list_tickets` | Just the tickets. Filters (AND-combined): `status`, `type`, `releaseId`, `processStepId`, `epicId` (resolves via `contains`). Pass `"none"` or `""` for *absence* (backlog tickets, orphans). Pass `compact: true` for `{id, ticketKey, type, status, title, position}` only — shrinks an ~80-ticket project from ~400 KB to ~10 KB. The right read for most "what's in progress" / Map-Check questions. |
| `list_releases`, `list_process_steps` | Layout dimensions of the story map. |
| `get_config` | Read a project config section: `section ∈ definitions \| workflow \| kanban_columns \| governance \| link_types`. Returns `{section, value}`. For `section: "workflow"`, pass `type=` for the effective per-ticket-type workflow. |
| `resolve_definitions_for_ticket` | Effective DoR/DoD for a *specific* ticket (after byType merge + current checked-state). |
| `list_links_for_ticket` | Links touching a ticket. `direction: forward` (owned) / `backward` (pointing here) / `both`. The impact-analysis workhorse. |
| `next_actionable` | "What can I start NOW?" — the do-next queue: work items that are `todo`, DoR-met (or already `ready`), and not blocked by an unresolved blocking/precedence predecessor. Optional `releaseId` / `type`. Prefer this over eyeballing `list_tickets` when picking the next task. |
| `generate_product_doc` | "Describe the product as it stands." Folds the tickets into a Markdown product description — each epic is a feature with its release, derived status (shipped/in-progress/planned), realising stories + AC, and (with `includeTests`) its linked test-definitions + health. Optional `releaseId` scopes to one release; optional `types` is an allowlist of content types — pass e.g. `["epic","user-story","technical-task-backend","technical-task-ui"]` for a PRD so bugs + tests are excluded. It's the deterministic, traceable skeleton (direction B) — narrate/refine the prose yourself. Pass `saveAsAttachment: true` (+ optional `attachmentFilename`) to write the rendered doc back as a project-level attachment — the SM-182 round-trip. |
| `get_trace_coverage` | Direction-A coverage (mirror of the fold): per requirement, counts incoming `realises` + `tests` and classifies `covered` / `over-covered` / `orphan` / `suspect`. Optional `moduleId` scope. "Is the PRD fully covered, what's missing?" |
| `get_drift_report` | Round-trip / drift between the PRD and the tickets (SM-182): `orphanRequirements`, `suspectRequirements`, `danglingLinks` (realises/tests anchor whose target was deleted or isn't a requirement), `supersededTrace` (realises anchored on a superseded feature version). `summary.clean=true` = no drift. Run after structural ticket changes, then re-`generate_product_doc` to close the loop. |

### Setup — "let's start"
| Tool | When |
|------|------|
| `project_create` | Brand-new initiative. Pass `id`, `name`, `ticketPrefix`. Optionally seed `workflow`, `definitions`, `ticketTypes`, `entityTypeConfig`. |
| `project_update` | Patch the project header (name, description, definitions, workflow, boards). |
| `request_switch_project` | After `project_create`, ask the browser to switch so the user lands on it. |
| `release_create` | Add a release row. Use real names (`v1.0`, `Beta`). |
| `process_step_create` | Add a backbone column. Names describe *user-visible value*, not job-titles. |
| `set_config` | Replace a config section (full replace, no merge): `section ∈ definitions \| workflow \| kanban_columns \| governance \| link_types`, `value` = the new block (object for definitions/workflow/governance, array for kanban_columns/link_types). workflow needs ≥1 status; governance rejects unknown predicates; definitions only affect FUTURE tickets. |

### Authoring tickets — "capture this work"
| Tool | When |
|------|------|
| `ticket_create` | New ticket. Specify `type` + `title`. `position.{releaseId, epicId, processStepId}` to land it in a cell; omit to drop in the backlog. Never go past `status: backlog` on create. **`acceptanceCriteria:[{text}]` IS settable at creation** (SM-260) — no create-then-update. Do NOT pass `prerequisites`/`steps`/`links` arrays here — they no-op through the MCP bridge; use the dedicated tools. |
| `ticket_update` | Change title, description, labels, `acceptanceCriteria`, type, position, `definitionOfReady`/`definitionOfDone`. AC items use key **`text`**. **Position is a partial merge** (SM-260): patch `{releaseId}` to move the release only — omitted keys are kept, explicit `null` clears. Same array caveat: don't patch `prerequisites`/`steps`/`links` here. |
| `ticket_delete` | Soft-delete. Stays in revision history; restorable. |

**Acceptance criteria are a first-class field, never inline prose.** Every
testable expectation goes into `acceptanceCriteria[]` as a discrete item — NOT
bullets inside `description`. Reasons:

- The Ticket-Detail Modal renders `acceptanceCriteria[]` as a sortable,
  individually-editable list. AC in prose are invisible to that UI and to the
  DoR/DoD machinery.
- The DoR-item *"Acceptance criteria are defined"* is meant to be satisfied by
  the array being populated. AC in prose make the DoR check vacuously true while
  the ticket is actually unready.
- AC are the contract for `complete_ticket` — a reviewer reads them as a
  checklist; a wall of prose can't serve that.

Pass `acceptanceCriteria` as objects `{text: "..."}` (the system fills `id` and
`completed: false`). Keep the description for *context* (the why, the symptom,
constraints). When you meet an older ticket with AC in the description, migrate
them into the array, trim the prose section, then check `dor-acceptance`.

### Typed links — "express dependencies + traceability"
| Tool | When |
|------|------|
| `link_create` | Add `source --linkTypeId--> target`. Cycle-checked for precedence/blocking/containment/`modifies`. Throws `LINK_SELF`, `LINK_TARGET_MISSING`, `LINK_DUPLICATE`, `LINK_CYCLE`. Use the specific type. |
| `link_delete` | Remove a link by `linkId` (no-op if gone). |
| `list_links_for_ticket` | Read links (see Discovery). Use before structural edits — every backward link is something you may break. |
| `get_config` / `set_config` (`section: "link_types"`) | Read / replace the catalogue. |

Containment (epic→story) is set via `position.epicId` at create time, NOT
`link_create`.

### Movement — "reorganise"
| Tool | When |
|------|------|
| `reorder` (`entity: "tickets"`) | Pure ordering OR bulk move into a cell/epic. `orderedIds[]` + optional `scope: {releaseId, processStepId, epicId}`. With `scope`, every listed ticket moves into that container (setting `scope.epicId` creates the `contains` link); without it, only `sortOrder` changes. The tool for "drag this story into that epic", "shuffle backlog priorities", "move the whole epic into another release". |
| `reorder` (`entity: "releases"` / `"process_steps"`) | Same idea for the story-map dimensions (no `scope`). |

### Bulk operations — "do this to many at once"
Best-effort by default (per-item failures reported, the rest proceed); pass
`opts.atomic: true` to roll back all on any failure.

| Tool | When |
|------|------|
| `bulk_change_status` | Move many tickets to one `targetStatus`. Per-item gate validation; failures return their `kind`/`missing`. |
| `bulk_ticket_update` | Apply one `patch` to many tickets. Respects spec-frozen gates; collects `SPEC_FROZEN_EDIT` warnings. |
| `bulk_link_create` | Create the same `linkTypeId` from many `sourceTicketIds[]` to one `targetTicketId` (e.g. tag many tickets as `modifies` one feature). |

### Workflow transitions — "advance this ticket"
| Tool | When |
|------|------|
| `change_ticket_status` | Generic status change. Respects DoR/DoD gates if the transition has them. |
| `mark_ready` | Shortcut for `→ ready`. Surfaces a clear `kind: "DoR", missing[]` on gate failure. |
| `complete_ticket` | Shortcut for `→ done`. ALWAYS use this (not `change_ticket_status: done`) so the DoD + governance gates fire explicitly. Coding-agent contract. Pass `checkDoD:true` (SM-260) to tick every required DoD item in the same call instead of N× `set_checklist_item` — but only when those items are genuinely true (don't auto-tick an "independent review" item that didn't happen). |
| `set_checklist_item` | Check/uncheck a single DoR/DoD item: `gate: "dor"\|"dod"`, `checked: true\|false`. Inline-persisted. Compact response by default (`{item:{id,checked}}`); pass `verbose:true` for the full ticket. |

### Test types — "specify once, run repeatedly"
The **definition** is reusable and carries the spec; the **execution** is
per-run and carries the result.

| Tool | When |
|------|------|
| `ticket_create type=test-definition` | New test spec. After create, `link_create … tests …` to the feature it validates (the gate enforces this before it can leave backlog). |
| `test_def_prereq_add` / `test_def_prereq_update` / `test_def_prereq_remove` | Manage the prerequisites list. |
| `test_def_prereq_check` / `test_def_prereq_uncheck` | Tick a prereq on the definition itself (rare — usually checked on the execution). |
| `test_def_step_add` / `test_def_step_update` / `test_def_step_remove` / `test_def_step_reorder` | Manage the 3-tuple steps (`step` / `data` / `expectedResult`). Use `_reorder`, never `ticket_update`. |
| `publish_test_definition` | Promote `draft → published` (runnable). Fires gates (≥1 step, ≥1 `tests`-link, every step has `expectedResult`, target ≥ `ready`). |
| `reopen_test_definition` | Demote `published → draft`. Blocks (`ACTIVE_EXECUTION`) if a run is in-progress. |
| `update_test_definition_metadata` | Edit title/description/labels on a published definition (spec stays frozen). |
| `test_exec_start` | Spawn an execution from a published definition. Clones steps, links `executes` → definition, starts `in-progress`. |
| `test_exec_record` | Record one step: `{status, actualResult, note?}`. Status auto-flips to `done` when the outcome settles. |
| `test_exec_set_outcome` | Manual outcome override. Pass `"auto"` to clear. Status syncs. |
| `test_exec_history` | Past runs of a definition, reverse-chrono. "Did this ever pass?" |

### Attachments — "binary reference docs (PRDs, designs)"
Files live on disk next to the DB; the agent reads/writes them over the channel
(base64 for small, a downloadUrl for large) — never via filesystem paths.

Two scopes: **project-level** (omit `ticketId`) for an initiative-wide source
doc like a PRD/PLD, and **ticket-level** (pass `ticketId`) for an item-specific
doc. There are no free-floating attachments — every one belongs to a project,
optionally to a ticket.

| Tool | When |
|------|------|
| `attachment_put` | Upload a binary (base64): `{projectId, filename, contentBase64, mimeType?, ticketId?}`. Max 25 MB. **OMIT `ticketId` for a project-level source PRD/PLD** — that's how you bring a spec into the tool to read + decompose it. Pass `ticketId` only to attach to one specific ticket. |
| `attachment_list` | Metadata only (no content). `ticketId` scopes to one ticket; `ticketId:"none"` lists project-level attachments only; omit for everything. |
| `attachment_get` | Always returns metadata + `downloadUrl`; inlines `contentBase64` for files ≤256 KB. For a big PDF, fetch the URL out-of-band instead of bloating the context. |
| `attachment_delete` | Remove an attachment by id. |

### Reflection — "look back"
| Tool | When |
|------|------|
| `list_revisions` | Reverse-chrono history. Each entry has an `op` label + `actor`. |
| `get_revision` | Inspect a single revision's snapshot. |
| `restore_revision` | Roll back to a revision. Creates a NEW revision (itself undoable). **Confirm with the user first.** |
