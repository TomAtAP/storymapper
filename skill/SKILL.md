---
name: storymap
description: Plan, organize, and track development work via the Story Mapper MCP server. Trigger when the user wants to plan a feature, shape a backlog, run a sprint, capture work as epics/stories/bugs, track a kanban board, define or evaluate Definition-of-Ready / Definition-of-Done, configure workflows or board columns, link tickets into dependencies, review revisions, or move tickets through statuses. Also trigger on "story map", "user story map", "kanban", "backlog", "epic", "release planning", "process step", "DoR", "DoD", "sprint planning", "ticket", "split into stories", "dependency", "blocks", "what's in progress", "show the backlog". Bidirectional: every MCP write appears live in the user's browser with highlight + movement animation; the user's manual UI edits flow back via list_/get_ reads. Use the Story Mapper as a shared thinking surface, not a write-only database.
---

# Story Mapper skill

An **agent-first** planning surface. I am the primary acting instance: I plan
the work, write the tickets, decompose epics into stories, link dependencies,
move tickets through the workflow, and do the coding the board tracks. The
human directs and reviews — they are not a co-developer sharing the keyboard.

The Story Mapper is two things at once:

1. **My working surface** — where I think in structure (epics, stories, links,
   releases) instead of prose.
2. **My channel to the human** — the MCP server runs alongside their browser;
   every tool call I make appears live with a highlight pulse + movement
   animation, and every manual edit they make flows back to me the next time I
   read. It is a living, navigable plan beyond a static plan file:
   epics/stories/typed-links/revisions evolve in front of the human as I work.

So: speak as the acting instance ("I created v1.0 and three stories under
Build", "the flow here is…"), surface what I'm doing and what's next, and offer
planning options rather than waiting to be told each step. It's a collaborative
whiteboard, not a write-only API — and the board, not my assumptions, is the
contract for what happens next (§4).

**This file is the always-loaded core.** Deep detail lives in `reference/`,
loaded on demand:

- `reference/anatomy.md` — the full concept model (project, release, process
  step, ticket types, status, workflow + rule engine, DoR/DoD, entityTypeConfig,
  board, typed links). The §2 summary below is the index.
- `reference/tools.md` — the full tool catalogue (when-to-use tables + response
  shapes). The §5 index below names every tool.
- `reference/workflows.md` — step-by-step playbooks (greenfield, sprint, bundle,
  plan-from-dependencies, test loop, reorganise, look back).
- `reference/spec-evolution.md` — the governance model (spec changes via
  `modifies`, test-definition lifecycle, what stops `complete_ticket`).

Read the relevant reference file when a task goes past the core.

---

## 1. Paradigm

Three complementary lenses on the SAME body of tickets:

### User Story Map (planning view)
Read top-to-bottom and left-to-right.

- **Horizontal axis = Process Steps** — phases of the **user's journey**
  through the product, e.g. *Sign up → Onboard → Activate → First win*, or for a
  marketplace *Discover → Compare → Buy → Receive → Review*. Process Steps
  describe **what kind of value the user encounters** at that point in their
  journey.

  Process Steps are NOT statuses (todo/doing/done), NOT team workflow stages
  (Design/Build/Test/Validate), and NOT technical layers (Frontend/Backend/
  Infra). If a step name reads like "what the team is doing" rather than "what
  the user is doing", rename it. The Kanban view is where status-driven lanes
  live; the Story Map's horizontal axis is the customer's path through the
  product.
- **Vertical axis = Releases** — slices of scope. Each release row spans every
  process step and contains the work scheduled for that release.
- **Cells** = a (Release × Process Step) intersection. Cells hold **Epics**
  (large groups of work) and the cell's epics hold **Stories** (sprint-sized
  work items). A cell can also hold loose stories without an epic. Epic cards
  and release rows are collapsible to tame large maps.
- **Backlog** sits below the grid: anything not yet placed in a release row or
  process step. Tickets start here.

Use the Story Map to **plan features that deliver user value** — to structure
scope across releases and reorganise as priorities change. The Story Map does
NOT model engineering phases (those belong in statuses) and does NOT track
day-to-day execution (the Kanban does).

### Kanban Board (execution view)
Read left-to-right. Lanes = configured **Board Columns** (one column may group
several statuses). Cards in each lane sorted by `sortOrder`. Epics are NOT shown
— they're containers, not work items.

Use the Kanban to drive day-to-day execution and to see at a glance what is
blocked vs. progressing.

Both views read the SAME underlying tickets. A story you reorder inside an epic
on the story-map ALSO changes its rank inside its kanban lane, because
`sortOrder` is shared. That coupling is intentional.

### Dependency view (impact-analysis lens)
A read-only layered DAG of all tickets connected by **typed links**. Nodes are
coloured by status-category; edges by link semantic; hovering a node highlights
its predecessors + successors, with critical-path highlighting. Use it to see
sequencing, what's ready to pick, and the blast-radius of a change *before*
reorganising. Links are authored via the `link_create` tools or the ticket
detail modal — you inspect here, you don't drag.

---

## 2. Anatomy (index — full model in `reference/anatomy.md`)

- **Project** → **Releases** (rows, `status` planning/active/completed/cancelled)
  × **Process Steps** (backbone columns, user-value labels) form the grid;
  **Cells** hold **Epics** which hold **Stories**.
- **Ticket types** (7 default, `ticketTypes` configurable): `epic` (container),
  `user-story`, `bug`, `technical-task-backend`/`-ui`, `test-definition`
  (reusable spec, no outcome), `test-execution` (one run, carries the result).
- **Tickets start in `backlog`** — every move is an explicit transition.
- **Epic membership is a `contains` link**, not a field. `position.epicId` is
  accepted as input but **reads back null** — find the epic via
  `list_links_for_ticket(story, backward)` or `list_tickets(epicId=…)`. A story
  inherits its epic's release + processStep.
- **Status** `{id, name, category}`, category ∈ `todo|doing|blocked|done`.
  `test-execution` auto-couples status to outcome (`in-progress ↔ done`).
- **Workflow + gates**: named transitions with `requireGate: DoR|DoD|null`,
  per-type overrides, a declarative rule catalog. **Lockstep invariant:** if a
  type hides a field via `entityTypeConfig` (`showDefinitionOfReady/Done`,
  `showTestOutcome`), the matching gate goes **N/A** for that type. Skip-moves
  check only the matched transition's gate; reverse moves are ungated.
- **DoR/DoD**: project templates, frozen onto each ticket at create; required
  items must be checked to pass the gate (`kind, missing[]`).
- **Typed links** (`project.linkTypes`): `predecessor-of`/`blocks` (cycle-checked
  dependencies), `follows-on`, `contains`, `relates-to`, `executes`/`tests`,
  `modifies`. Prefer the specific type over `relates-to`.

---

## 3. Bidirectional collaboration

The user has the browser open while I work. Treat the Story Mapper as a shared
thinking surface.

**I write → user sees instantly:**
- Every MCP write triggers a WebSocket push to the browser.
- New tickets pulse green; moved tickets (lane change OR field edit OR reorder)
  FLIP-animate to their new position AND pulse.
- The user follows along visually, no refresh needed.

**User writes → I see on next read:**
- Manual UI edits persist immediately via REST → SQLite.
- Read with `list_tickets` / `ticket_get` / `project_get` to pick up whatever
  the user changed since my last write.
- There is no server→agent push — I pull when I need current state. (A UI drag
  can move a ticket out of an epic's cell and drop its `contains` link; re-read
  before assuming structure is intact.)

**Direct the user's attention** with `request_switch_project(workspace, reason,
wait_seconds)`: the browser shows a confirm dialog with my `reason`; the tool
blocks until Accept/Cancel (or timeout; default 30 s, max 120) and returns
`{requested, reason, requestId, response:{accepted}, timedOut?}`. Use after
creating/preparing a project so the user lands in the right place — not for
every navigation.

**Surface what I've done** in the conversational reply. Don't make the user
mentally diff the snapshot — say *"I created v1.0, three process steps, an epic
'Onboarding revamp' with three stories under Build, and linked the DB story as a
predecessor of the UI story"* and let the animations reinforce it.

---

## 4. Working from the map: tickets-first + priority discipline

The Story Mapper is not a passive log of work — it is **the contract that
governs what I do next**. These rules together; not optional. Violating them
quickly desynchronises my work from what the user expects.

### Tickets-first
Every substantial activity in a Story-Mapper-backed project happens **inside a
ticket**. If there isn't a ticket for what I'm about to do, I create one and
pause for the user to acknowledge it — I do NOT free-form through the work and
back-fill the ticket afterwards. The user watches the Kanban to see what I'm
touching; editing files without a ticket in `in-progress` makes that invisible.

When I finish one ticket, I do NOT silently roll into the next. Stop. Propose.
Ask. See the priority rule.

**Walk the workflow as I build, not after.** A ticket's status tracks reality:
move it `backlog → ready` (DoR met) when I start, `→ in-progress` while editing
files, `→ review` when it's implemented and tested, `→ done` only when the DoD
gate is genuinely met. Don't build first and back-fill the ticket afterwards —
that drift once even collided a commit tag with an auto-assigned ticket key.

**Honest status.** Built-but-unmerged / not-yet-independently-reviewed work
belongs in `review`, not `done`. Check DoD items only when they are actually
true (AC met, automated test green); `done` requires every required DoD item —
including independent review — so a parallel reviewer (a separate agent or
session) is part of closing, not a rubber stamp.

**Epic status is DERIVED — never walk an epic.** An epic has no manual status:
it rolls up from its contained stories (empty → backlog; any story in progress →
in-progress; every story done → done). Every status path rejects an epic with
`kind=EPIC_STATUS_DERIVED` (`change_ticket_status`, `mark_ready`,
`complete_ticket`, `bulk_change_status`, and a `status` in `ticket_update.patch`).
To advance or complete an epic, move its **stories** — the epic follows. Epics
also carry no DoR/DoD (the gates are N/A). A release shows real progress as
"X/Y done" over its non-epic work items, so a release whose stories are all done
closes cleanly even though the epic was never manually touched.

### Structure: name releases by content, keep process steps atomic
When I introduce roadmap structure, I mirror how the user thinks about it:

- **Releases are named by content, never by time.** No "Now" / "Next" /
  "Future" — the name carries the substantive activity (e.g. "Durchgängige
  Traceability"). An active slice with no fitting open release needs a *new*
  one; never dump current work into a `completed` release.
- **Process Steps are atomic — one activity per step.** Don't fuse distinct
  activities (Specify ≠ Trace ≠ Agent Planning — the last is its own step
  because another actor may intervene and communication is part of it).
  Decompose the journey into fine-grained steps first, then place epics.
- **Content coherence.** Don't fold unrelated work into a thematically-named
  release just to avoid creating a second one.

### Map-Check before every action
Before any substantial tool action (writing code, creating tickets, picking the
next thing), refresh the view of the map — the user may have moved tickets,
re-prioritised the backlog, renamed a Process Step, or added tickets via the UI
since my last read. Minimum read set:

- `list_tickets status="backlog"` — the priority ordering of queueable work.
- `list_process_steps` / `list_releases` — only if I might affect structure.
- `list_tickets status="in-progress"` — to confirm what's already being touched.

Map-Check is a cheap read (`compact: true` makes it cheaper). Acting on a stale
view is expensive — undoing structural changes is painful.

### Priority comes from the map, not from my assumptions
Ticket priority is **`sortOrder` within the backlog lane** (Kanban view), or
**position within an epic** (Story Map view). Higher up = higher priority. The
user maintains this order; I read from it. To pick the next ticket:

1. `list_tickets status="backlog"`, sort by `sortOrder` (or `next_actionable`
   for the DoR-ready + unblocked subset).
2. The top entry is the next candidate — **unless** the user signalled otherwise
   ("let's do SM-X next" overrides map order).
3. **Propose explicitly**: "Next per the map is SM-X — *Title*. OK?"
4. Wait for confirmation. Do NOT auto-advance.

Never narrate "next I'll take X" without giving the user a chance to redirect.
The user owns the queue. (Mirror my internal task tracker — TaskCreate/Update —
to the Story-Mapper status; they are two views of the same work.)

---

## 5. Tool index (full when-to-use + response shapes in `reference/tools.md`)

**Compact by default (SM-123).** Ticket-returning mutators (`ticket_create`,
`ticket_update`, `change_ticket_status`, `mark_ready`, `complete_ticket`) and
`set_checklist_item` return a compact `{revision, savedAt, ticket|item:…}`; pass
**`verbose: true`** for the full object. `ticket_get` is full by default
(`compact: true` / `fields:[…]` to slim); `list_tickets` takes `compact: true`.
Act on the compact response; only go verbose when you need a field it omits.

- **Discovery** (cheap reads): `list_projects`, `project_get` (big — sparingly),
  `list_tickets` (filters + `compact`), `list_releases`, `list_process_steps`,
  `get_config` (`section: definitions|workflow|kanban_columns|governance|link_types`),
  `resolve_definitions_for_ticket`, `list_links_for_ticket`, `next_actionable`
  (the DoR-ready + unblocked do-next queue), `query_tickets` (JQL-style search;
  `release`/`processStep`/`epic` match by **name OR id**, and an unknown ref
  value errors loudly instead of returning a silent empty set — SM-260).
- **Setup**: `project_create`, `project_update`, `request_switch_project`,
  `release_create`, `process_step_create`, `set_config` (full-replace a section).
- **Authoring**: `ticket_create`, `ticket_update`, `ticket_delete`. Acceptance
  criteria are a **first-class field** — `acceptanceCriteria:[{text:…}]`, never
  prose bullets in the description (AC in prose are invisible to the modal +
  DoR/DoD and make `dor-acceptance` vacuously pass). **`ticket_create` accepts
  `acceptanceCriteria` at creation** (SM-260) — set them up front, no
  create-then-update dance. **`ticket_update` position is a partial merge**:
  patch just `{releaseId}` to change the release and keep processStep + sortOrder
  (omitted keys are preserved; an explicit `null` clears a field).
- **Typed links**: `link_create` (use the specific type; cycle-checked),
  `link_delete`, `list_links_for_ticket`.
- **Movement**: `reorder` (`entity: tickets|releases|process_steps`; for tickets,
  `orderedIds[]` + optional `scope:{releaseId,processStepId,epicId}` — `scope`
  moves into a container, `scope.epicId` creates the `contains` link). Never set
  `sortOrder` via `ticket_update`.
- **Bulk** (best-effort; `opts.atomic` to roll back): `bulk_change_status`,
  `bulk_ticket_update`, `bulk_link_create`.
- **Datenaustausch** (SM-290/291): `import_tickets` (CSV — the export format —
  or `rows:[{…}]`; mode `create-only` (default) vs `upsert` patches existing
  keys with only the changed fields). Replaces N× `ticket_create` for mass
  creates. Foreign CSVs (Jira, Excel): common headers auto-map (Summary→title,
  Issue key→key, Issue type→type, Fix version→release); anything else via
  `headerMapping: {"csv header": "field" | null}` (SM-296). Foreign VALUES
  (statuses/types like `IN TESTING`, `Story`): common ones auto-map
  (Open/To Do→backlog, Closed/Resolved→done, In Review→review,
  Story→user-story — only if the target exists); the rest via
  `valueMapping: {status: {"src": "target" | null}, type: {…}, release: {…},
  processStep: {…}}` (SM-297). The dryRun plan lists `unknownValues` —
  ALWAYS dryRun first, map what it lists, then apply. **ALWAYS `dryRun: true` first** and show the human the plan
  (`{creates, updates, errors}` with line numbers) before applying — apply
  writes everything in ONE revision, error rows are never written. Import is a
  migration surface: statuses apply **without** DoR/DoD gates. `export_project`
  returns the re-importable `storymap-project` envelope (same format as the
  browser's Export… → Projekt (JSON)) — use it when the human wants a file/
  backup/transform artifact; for plain reads stick to `project_get`.
- **Transitions**: `change_ticket_status`, `mark_ready` (→ ready, loud DoR),
  `complete_ticket` (→ done — ALWAYS use this so DoD + governance gates fire;
  pass `checkDoD:true` to tick every required DoD item in the same call instead
  of N× `set_checklist_item` — SM-260),
  `cancel_ticket` (→ cancelled, gate-free — see below),
  `set_checklist_item` (`gate: dor|dod`, inline-persisted).
- **Cancel vs Delete** (`cancel_ticket`): cancel records a deliberate
  non-implementation (scope reduction) — the ticket stays VISIBLE with its
  history + links, just marked cancelled (a 5th terminal status category).
  `ticket_delete` is for MISTAKES only (soft-delete, hidden). Cancel is
  gate-free from any status; reopen by moving to an earlier status (ungated).
  Cancelling an EPIC cascades: every open contained story is cancelled in one
  revision and the epic rolls up to cancelled (or done, if some stories had
  already shipped — the work that shipped dominates). Cancelled tickets drop
  out of release progress (X/Y) and never block completing a release. Spec
  types (requirement/spec-module) have their own lifecycle and reject cancel.
- **Test types**: **`derive_test_definition`** (AC → one-step-per-AC draft plan
  linked back; the fast path, SM-301), `ticket_create type=test-definition`
  (+ `link_create … tests`) for hand-built plans,
  `test_def_prereq_add`/`_update`/`_remove`/`_check`/`_uncheck`,
  `test_def_step_add`/`_update`/`_remove`/`_reorder`, `publish_test_definition`,
  `reopen_test_definition`, `update_test_definition_metadata`, `test_exec_start`,
  `test_exec_record`, `test_exec_set_outcome`, `test_exec_history`.
- **Reflection**: `list_revisions`, `get_revision`, `restore_revision`
  (**confirm with the user first**).

---

## 6. End-to-end workflows → `reference/workflows.md`

Step-by-step playbooks for: plan a new initiative (greenfield), **decompose a
source PRD into a traceable requirements layer (direction A — two-stage slicing:
the server coarse-slices at headings, then YOU content-analyse each slice into
1..n atomic requirements)**, execute a sprint, bundle related stories
(auto-complete pure-data, pause for UI smoke), plan from dependencies (sequence +
impact + traceability), validate a feature with the test loop, reorganise, and
look back. Read it when running one of these.

---

## 7. Spec evolution & test definitions → `reference/spec-evolution.md`

The governance model (SM-92/SM-93): HARD (tool-blocked) / SOFT (warning) /
SKILL-only layers; the test-definition lifecycle (`draft → publish → run`); and
the rule that spec changes after `ready+` go through a NEW `modifies`-ticket, not
an in-place edit. Read it before evolving a frozen spec or debugging a gate.

**Test-definitions are MANDATORY for user-story + bug (SM-299, hard gate).**
`complete_ticket` on a `user-story` or `bug` is **blocked with
`MISSING_TEST_DEFINITION` (422)** until a **published** test-definition is
linked to it via a `tests`-link. Structural, not advisory — you cannot mark
such a ticket done without an explicit test plan in the system. The flow:

**The fast path — `derive_test_definition` (SM-301):** the acceptance criteria
ARE the test plan. The instant you set AC on a story/bug, call
`derive_test_definition(projectId, ticketId)` — it scaffolds a test-definition
with **one step per AC** (step = the criterion) and `tests`-links it back, in
one call. Treat it as the **north star**: create it up front, refine the steps
as you implement (you'll learn what the AC missed), and `publish` it before
done (`publish:true` when the target is already `ready`+, else publish later).
Only hand-build the definition (steps below) when you need steps the AC don't
express:

1. `ticket_create type=test-definition` — the plan.
2. `test_def_step_add` per step (each needs a non-empty `expectedResult`).
3. `link_create linkTypeId=tests` from the definition → the story/bug.
4. `publish_test_definition` (the target must be `ready`+ first).
5. `complete_ticket` on the story/bug.

The plan's **content scales with the work**: for user-facing / browser-
acceptance stories capture the real steps (pan feel, live render, submenu
visibility, drag feel) and `test_exec_record` an execution so acceptance is an
artifact. For pure-logic / data-layer / DRY refactors a lightweight definition
that points at the automated suite ("`node tests/run.js` green covers X") is
enough — but it must still exist and be published. `technical-task-*`, `epic`,
`requirement`, `spec-module` are NOT gated. (Lesson from the cmapper double-
strand: 0 test-defs, 0 executions despite ~40 closed tickets — SM-299 makes
that impossible.)

---

## 8. Anti-patterns

- **Do not** work on anything without a ticket. About to touch files for a
  non-trivial change and no ticket covers it? Pause, create one, get
  acknowledgement, THEN code.
- **Do not** pick the next ticket autonomously. After finishing, stop, read the
  backlog by `sortOrder` (or `next_actionable`), name the candidate, **ask**.
- **Do not** skip the Map-Check before substantial actions. Acting on a stale
  snapshot ends in undo.
- **Do not** build first and back-fill the ticket, or mark a ticket `done`
  before it's merged + independently reviewed. Walk the workflow as you go;
  `review` ≠ `done`.
- **Do not** name Process Steps after team stages (Design/Build/Test) or layers
  (Frontend/Backend) — those are statuses, not the customer-journey axis. And
  don't use too few/coarse steps: decompose the journey BEFORE placing epics.
- **Do not** name releases by time ("Now"/"Future") or fold unrelated work into
  a thematically-named release. Content names, content coherence, atomic steps.
- **Do not** call `change_ticket_status: done` directly. Use `complete_ticket`
  so the DoD + governance gates fire with clean `kind` errors.
- **Do not** try to `complete_ticket` a `user-story`/`bug` without a **published,
  `tests`-linked test-definition** — the gate blocks it (`MISSING_TEST_DEFINITION`,
  422). Write the test plan (create test-definition → steps → `link_create tests`
  → `publish_test_definition`) BEFORE, not "done, please review". Don't just tick
  `dod-tests` — that's the unrecorded verbal claim SM-299 exists to stop.
- **Do not** `ticket_delete` work you decided not to build — that hides it.
  `cancel_ticket` instead (stays visible with history; cancelling an epic
  cascades to its open stories). Delete is for genuine mistakes only.
- **Do not** create tickets in non-backlog statuses (backlog-start is enforced).
- **Do not** try to move/complete an epic via any status tool — epic status is
  derived from its stories (`kind=EPIC_STATUS_DERIVED`). Advance the **stories**
  and the epic rolls up on its own.
- **Do not** assume the default workflow. `get_config` (`section: workflow`,
  optionally `type=`) first — and a gate is N/A if the type hides its field
  (the lockstep).
- **Do not** read `position.epicId` to find a story's epic — it's always `null`.
  Use `list_links_for_ticket(story, backward)` or `list_tickets(epicId=…)`.
- **Do not** pass `prerequisites`/`steps`/`links` arrays through
  `ticket_create`/`ticket_update` — the MCP bridge silently drops them. Use the
  dedicated `test_def_step_add` / `link_create` tools. (`acceptanceCriteria` is
  the exception: it has a structured, bridge-safe schema — settable at
  `ticket_create` and `ticket_update`. AC items use key `text`, never `label`.)
- **Do not** put acceptance criteria as prose in the description — they belong in
  `acceptanceCriteria[]` (settable at `ticket_create`). Migrate prose AC before
  doing anything else with the ticket.
- **Do not** edit `sortOrder` via `ticket_update` — use `reorder`. Don't
  hand-loop a status change when `bulk_change_status` fits.
- **Do not** restructure aggressively without `list_revisions` /
  `list_links_for_ticket` first — you may erase context or break a dependency.
- **Do not** leave related tickets unlinked, or abuse `relates-to` when a
  specific type (`predecessor-of`, `blocks`, `contains`) carries the behaviour.
- **Do not** pause after every pure-data-layer story (auto-complete in a bundle
  when tests are green); UI stories still pause for smoke.
- **Do not** assume a write succeeded just because the tool returned — surface
  any `error`/`kind` (a per-type override or gate may have blocked it).
- **Do not** treat a `test-definition` as carrying an outcome, reuse a
  `test-execution` for a second run, force a pending execution to `done`, or
  `complete_ticket` a feature without a passing execution on its linked
  definition. (Test-loop detail → `reference/spec-evolution.md`.)
- **Do not** mass-create epics + stories silently. Pause after the outline — the
  animations are designed for human-paced review.

---

## TL;DR

The Story Mapper is an agent-first planning + execution surface, not a CRUD
database. I am the acting instance; the human directs, reviews, and owns the
queue. The Story Map plans **features** (user value, along the customer's
journey) — never engineering phases; the Kanban tracks status; the Dependency
view shows what blocks what. Every substantial activity goes through a
**ticket**, walked through the workflow as I build (`review` ≠ `done`); priority
is the backlog `sortOrder`. Do a **Map-Check** (`list_tickets status="backlog"`,
`compact:true`) — or `next_actionable` — before picking the next thing,
**propose it, wait**. **Link as you plan** (`link_create`) and check
`list_links_for_ticket` before reorganising. Epic membership is a `contains`
link — `position.epicId` reads back null. Gates are declarative: hiding a field
for a type disables its gate (the lockstep). Use **`mark_ready`** /
**`complete_ticket`** to make gate failures loud, **`reorder`** to move/rank,
**`bulk_*`** for fan-out. Auto-complete pure-data stories in a bundle; pause for
UI smoke. Releases are content-named, process steps atomic. Deep detail is in
`reference/` — read the relevant file when a task goes past this core.
