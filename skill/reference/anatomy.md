# Anatomy — concepts in detail

> Reference for the Story Mapper skill. Read on demand when you need the full
> model of a concept; the core SKILL.md (§2) carries only the index.

### Project
Top-level container. Has an `id`, a display `name`, a `ticketPrefix` (e.g.
`ANI`, used as `ANI-1`, `ANI-2`, …), a `workflow`, a Kanban `boards` config, an
`entityTypeConfig`, a `linkTypes` catalogue, a `governance` config, a
`definitions` block (DoR/DoD templates), and the lists: tickets, releases,
processSteps, revisions. Patch the header with `project_update`; the dedicated
`set_config` sections are sugar for the sub-objects.

### Release
A row in the story map; a **product version** — a vehicle for "what ships
*together* as version N". Has a `name` (`v1.0`, `2026-Q2`), an optional date
range, and a `status` (`planning` / `active` / `completed` / `cancelled`). The
filter can hide completed releases so finished scope stops cluttering the map.

A release **bundles many features** — that is its whole point. Do NOT create one
release per feature/epic; that turns the release axis into a duplicate of the
epic axis and destroys the "what ships as a version" meaning. Many epics share
one release row. Create a *new* release only for a genuine new version/milestone,
then drop several epics/stories into it. (Releases are the time/version axis;
process steps are the user-journey axis — keep them distinct.)

### Process Step
A column on the story map's backbone. Pure flow-of-value label, not a status.
Names describe *what happens* for the user, not *who's working* (good: *Onboard*,
*Configure*; less good: *Backend*, *Frontend* — those fragment a feature across
many cells). See the paradigm note in the core skill.

### Tickets and their types
A ticket lives at a `(release, processStep, epic)` position OR in the backlog
(all three null). Seven default types:

- **epic** — the only container type. Lives in a cell; holds stories via a
  `contains` link (see *Epic membership* below). No DoR/DoD by default. Use when
  a feature is too large for a sprint and benefits from breakdown.
- **user-story** — sprint-sized, user-facing increment. The bread-and-butter
  ticket. DoR and DoD apply.
- **bug** — fix to existing behaviour. Often configured to bypass DoR — check
  the per-type workflow before assuming.
- **technical-task-backend / technical-task-ui** — work not directly visible to
  the user but needed (refactor, infra, plumbing). Treat like a story for
  DoR/DoD purposes.
- **test-definition** — reusable test spec. Carries `prerequisites[]` +
  `steps[]` (each `step` / `data` / `expectedResult`). Carries NO outcome —
  definitions are templates, runnable arbitrarily often. Links to the
  feature/bug it validates via a `tests` link. AC + DoR + DoD sections are hidden
  by default (the prereqs + steps ARE its completeness criteria).
- **test-execution** — a single run of a definition. Carries `executionSteps[]`
  (frozen clone of the definition's steps + per-step `actualResult` +
  `status: pending|passed|failed|blocked|skipped` + optional `note`) plus
  `runAt`, `runBy`, `env`, and optional `outcomeOverride`. Linked to its
  definition via an `executes` link (auto-created by `test_exec_start`). The
  card surfaces the outcome as a colour-coded pill.

`ticketTypes` is configurable per project — if the user has custom types,
respect them rather than mapping onto the defaults.

### Epic membership = a `contains` link (SM-52)
A story belongs to an epic through a `contains` link (epic → story), **not** a
stored field. `position.epicId` is *accepted as input* on `ticket_create` and on
`reorder`'s `scope` (the engine creates the link for you), but it is
**stripped to null on persist** — reading `ticket.position.epicId` back gives
`null`. To find a story's epic, use `list_links_for_ticket(story, backward)` or
`list_tickets(epicId=<epic>)` (that filter resolves through the `contains`
graph). When a story is assigned to an epic it **inherits the epic's
release + processStep** (SM-67) — you don't set those separately.

### Status (workflow lanes)
A ticket's lifecycle position. Default statuses: `backlog → ready →
in-progress → review → done`. Each status is an object `{id, name, category}`
where *category* ∈ `todo | doing | blocked | done` — the UI uses it for styling
and for suggesting Kanban-column groupings.

Tickets ALWAYS start in `backlog`. There's no shortcut into other statuses on
create — every move is an explicit transition.

**Test-execution exception (auto-coupling):** a `test-execution` ticket's status
auto-syncs with its outcome. It spawns in `in-progress`; once the effective
outcome flips to anything non-pending (every step has a status, or
`outcomeOverride` is set), status auto-advances to `done`. Reverting a step to
`pending` flips status back to `in-progress`. The coupling only owns the
`in-progress ↔ done` axis — manual `backlog`/`ready`/`review` are untouched.
Don't fight it: never manually set a test-execution to `done` while steps are
pending (the auto-flip reverts it); use `outcomeOverride` to call the run.

### Workflow + Transitions + the rule engine
A workflow has `statuses[]` and `transitions[]`. A transition is named (e.g.
*Start Progress*, *Cancel*) and declares:

- `toStatus` — where it lands.
- `fromStatuses[]` + `allowFromAny` — which sources can use it.
- `requireGate: "DoR" | "DoD" | null` — quality gate enforced on the move.

Per-type overrides exist (`workflow.byType[type].transitions`): a bug type can
disable the DoR gate without affecting stories.

Gates run through a **declarative rule catalog** (SM-102). `requireGate` maps to
catalog rules; two **global rules** apply to every forward transition on top of
the matched transition's own (each self-limits via the transition context):

- a **test-definition** must have ≥1 outbound `tests` link before leaving
  backlog (`kind: "TEST_TARGETS"`);
- a **test-execution** must have a non-pending outcome before entering a
  `done`-category status (`kind: "TEST_OUTCOME"`).

**The lockstep invariant (internalise this):** a gate is **N/A for a type when
that type hides the backing field** via `entityTypeConfig`. Hiding a field
doesn't only hide UI — it disables the matching gate:

| field hidden (`entityTypeConfig`) | gate that goes N/A |
|---|---|
| `showDefinitionOfReady: false` | DoR |
| `showDefinitionOfDone: false` | DoD |
| `showTestOutcome: false` | test-execution outcome |

So if a `change_ticket_status`/`complete_ticket` you expected to be gated sails
through, check whether the type hides that field. The read-only **Rules** tab in
Settings lists which rules are active per type.

Two transition rules to internalise:

1. **Skip-moves only check the matched transition's gate** — not every crossed
   status's gate. `backlog → done` with gate=DoD checks DoD only. This is the
   "Jira-rein" semantics — the user must define an explicit transition for the
   move to be allowed at all.
2. **Reverse moves (toStatus index ≤ current index) are ungated** — reopening is
   always permitted.

### Definition of Ready / Definition of Done
Templates on the project; *frozen copies* on each ticket. Items are checklists
with `required: true/false`. When a transition's `requireGate` fires, ALL
required items in the relevant block must be checked or the move is blocked with
`kind: "DoR" | "DoD", missing: [...]`. Project-level template changes do NOT
retroactively touch open tickets — only newly created tickets pick them up.

### entityTypeConfig (per-type field visibility)
`project.entityTypeConfig[type]` controls which sections a type shows AND, via
the lockstep above, which gates apply. Flag set (defaults in parentheses):

- `showAcceptanceCriteria` (true; false for test types)
- `showDefinitionOfReady` / `showDefinitionOfDone` (true; false for test types)
- `allowParentEpic` (true; **always false for `epic`**)
- `showProcessStep` / `showRelease` / `showLinks` (true)
- `showPrerequisites` / `showSteps` (test-definition only)
- `showExecutionSteps` / `showTestOutcome` (test-execution only)

Test-flags are hard-locked to their type — you can't switch on
`showPrerequisites` for a story.

### Board (Kanban Columns)
`project.boards.kanban.columns` is the column layout. Each column has `id`,
`name`, `statusIds[]` — a column may bundle multiple statuses into one lane
(e.g. *In Progress* bundling `in-progress` + `review`). Default = 1 column per
status. Statuses in no column show up as a synthetic trailing "orphan" lane so
nothing is hidden.

### Typed links + the Dependency view
Beyond the structural epic→story containment, tickets carry **typed links** to
other tickets. The catalogue lives in `project.linkTypes`. **Semantics matter** —
the type carries behaviour (cycle-checks, graph direction), it's not just a label:

| id | inverse | semantic | cycle-checked | typical use |
|---|---|---|---|---|
| `predecessor-of` | Successor of | precedence | ✅ | "must finish before" ordering |
| `blocks` | Blocked by | blocking | ✅ | "can't start until" hard dependency |
| `follows-on` | Precedes | sequence | — | softer linear chain |
| `contains` | Contained by | containment | ✅ | epic → story (canonical, SM-52) |
| `relates-to` | Relates to | freeform | — | symmetric "see also" |
| `executes` | Executed by | validation | — | test-execution → definition |
| `tests` | Tested by | validation | — | test-definition → feature |
| `modifies` | Modified by | freeform | ✅ | spec-change ticket → original |
| `supersedes` | Superseded by | supersession | ✅ | newer epic obsoletes the older version (drives the cross-release product-doc fold) |
| `replaces` | Replaced by | supersession | ✅ | a ticket replaces another |
| `refines` | Refined by | freeform | ✅ | adds detail without obsoleting |
| `realises` | Realised by | freeform | — | a ticket realises a PRD requirement/anchor (direction A) |

Cycle-checked semantics (precedence, blocking, containment, plus `modifies` via
an explicit flag) reject an edge that would close a loop (`kind: "LINK_CYCLE"`).
Containment is created via `position.epicId` at create time, NOT via
`link_create`; read it via `list_links_for_ticket` or the Dependency view, never
via `ticket.position.epicId`.

**The Dependency view** (third view next to Map and Kanban) renders all tickets
as a layered DAG. Use it to: see **what depends on this ticket** (downstream
impact / forward edges); see **what this ticket waits on** (upstream blockers /
backward edges); trace a feature epic → contained stories → implementing
tickets (the chain documents WHY each ticket exists); spot orphan tickets (no
edges — often a smell that something should have been linked). It's read-only.

**Link as you plan** — typed links + the Dependency view are the planning
surface, not an afterthought. Prefer the specific type (`blocks`,
`predecessor-of`) over generic `relates-to`.
