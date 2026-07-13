# End-to-end workflows

> Reference for the Story Mapper skill. The core SKILL.md (§4) carries the
> discipline rules; this file has the step-by-step playbooks.

### Plan a new initiative (greenfield)
1. `project_create` with a kebab-case `id`, a human `name`, a `ticketPrefix`.
2. `request_switch_project` so the user lands on it.
3. `release_create` at least one release (a v1, or "MVP").
4. **Decompose the user's journey FIRST**, then `process_step_create` one step
   per *distinct phase* the user (or agent) passes through, in order. Err toward
   MORE, finer phases — coarse catch-all steps (e.g. just 3 buckets) cram many
   unrelated epics into one column and lose the journey's shape. Each step =
   "what kind of value happens here", never the team's org chart. Decompose the
   journey before placing any epics/stories, so each lands at the right phase.
5. Optionally `set_config` (`section: "workflow"` / `"definitions"`) if the defaults don't fit.
6. Capture top-level features as `ticket_create type=epic`, drop into cells via
   `reorder` with `scope`.
7. Decompose each epic into 2–6 stories (`ticket_create type=user-story`,
   created in backlog), then `reorder` with
   `scope: {releaseId, processStepId, epicId}` to land them under the epic.
8. **Link as you go** — `link_create` `predecessor-of` / `blocks` between
   stories with real ordering or dependency. This powers the Dependency view and
   sprint sequencing.
9. Pause. Let the user see the structure. Talk through it.

### Decompose a source PRD/PLD into tickets (direction A) — the requirements layer
When the starting point is a written spec (a PRD/PLD), the doc precedes the
tickets. Don't decompose straight into epics/stories — first turn the document
into a **traceable requirements layer** (DOORS/ReqIF-style): the source is
sliced into atomic `requirement` SpecObjects that become the addressable truth,
and implementation tickets anchor back to them. The doc itself stays as
provenance; the slice chain is what you trace against.

**Slicing is two-stage, and the second stage is yours.** The server does a
*structural* coarse-slice at headings; you do the *content* analysis that turns
each coarse slice into the atomic requirements it actually contains. Don't
mistake one heading section for one requirement — a single section usually
bundles several testable assertions. One coarse slice → **1..n** requirements.

1. **Bring the spec in.** `project_create` → `attachment_put` with the PRD **and
   no `ticketId`** (omitting it = project-level). In the browser the user can do
   the same: the New-project dialog has a dropzone, and Project ▸ Attachments…
   manages project-level docs.
2. **Stage 1 — coarse-slice (the server, structural).**
   `ingest_slice_candidates` on the attachment id → the server converts it to
   Markdown (officeparser-free stack: md/txt native, docx via fflate, pdf via
   pdf2json — no OCR, no CDN) and pre-slices at headings into an ordered list of
   candidate sections, each with a DOORS-style `sectionPath` ("2.1") + char
   range. This is purely structural — every heading becomes one candidate, so
   nothing is silently dropped. There is **no H1 special-case**: the numbering is
   structural (depth-based), and a document with a single H1 wrapper is fine —
   the generalisation to "what is actually a requirement" happens in stage 2, not
   by reshaping the slice tree.
3. **Open a spec module.** `spec_module_create` with `title` +
   `sourceAttachmentId` — the per-document container (DOORS module). Its
   requirements are board-excluded and ordered by sectionPath.
4. **Stage 2 — content analysis (you, the agent).** Read each coarse slice's
   prose and identify the individual atomic requirements inside it — **one
   `requirement_create` per testable assertion**, not one per heading. A slice
   that says "the user can log in with email+password, reset a forgotten
   password, and stay signed in for 30 days" is **three** requirements, not one.
   For every requirement you extract from a slice:
   - pass the **slice's `sectionPath`** (all requirements distilled from the same
     coarse slice share it — that is what groups them under the source section in
     View ▸ Requirements);
   - pass `sourceAnchor` `{attachmentId, sectionId, charStart, charEnd}` pointing
     at the **specific span** that requirement came from (the n requirements of
     one slice differ here — distinct char-ranges within the slice). `sectionId`
     is provenance only; set it to the slice's `sectionPath` for consistency.
     Grouping into the document section is driven by the requirement's own
     `sectionPath`, never by `sectionId` — so the span is what distinguishes the
     n requirements, and `sectionPath` is what keeps them together.
   The requirement IS the unit of truth — not the doc, and not the coarse slice.
   A coarse slice with only boilerplate/intro prose may yield **zero**
   requirements — that's a legitimate gap, not a miss.
5. **Build + anchor traceability.** As you implement, `link_create` **`realises`**
   from the implementing story/epic → the requirement (DOORS *satisfies*), and
   `tests` from a test-definition → the requirement (*validates*). Anchor as you
   create, not after.
6. **Check completeness + correctness.** `get_trace_coverage` (optionally
   `moduleId`-scoped) classifies every requirement: `covered` (1 realises) /
   `over-covered` (>1) / `orphan` (none) / `suspect` (tested, not implemented).
   The user reviews in **View ▸ Requirements** — a full-page DOORS module view:
   source prose next to each slice (verify the slicing is faithful), un-sliced
   sections flagged as gaps (verify completeness), coverage badge + clickable
   realising/testing tickets per requirement, inline-editable statements, and a
   "create implementing ticket" action on orphans.
7. **Keep it a living document — round-trip + drift (SM-182).** As the tickets
   evolve after the first slice, the doc and the code drift apart. `get_drift_report`
   (optionally `moduleId`-scoped) surfaces four signals on the trace graph:
   `orphanRequirements` (a requirement no ticket realises), `suspectRequirements`
   (only `tests`, no implementer), `danglingLinks` (a realises/tests anchor whose
   target was deleted or isn't a requirement), and `supersededTrace` (a realises
   anchored on a superseded/historical feature version — the implementation moved
   on but the anchor stayed). `summary.clean=true` means no drift. Run it after
   structural ticket changes; fix the anchors; then **regenerate the doc** with
   `generate_product_doc { saveAsAttachment: true }` to write the current
   description back as a project-level attachment next to the source PRD — the
   loop closes.
8. **Pause before mass-creating** — same rule as greenfield. Slice + propose the
   requirement chain, let the user see it, then build.

`tests/mcp-prd-slicing-demo.js` drives this whole round from an example PRD
(`npm run prd-demo`); pass `--data-dir=./.storymap-data --http-url=…` to watch
it populate a live browser via `request_switch_project`.

### Execute a sprint
1. **Map-Check first.** `list_tickets status="backlog"` (add `compact:true`)
   sorted by `sortOrder` — the user may have shuffled since my last read.
2. Propose the next-priority ticket to the user. Wait for confirmation.
3. Once confirmed: check DoR via `resolve_definitions_for_ticket`.
4. `set_checklist_item` (gate `"dor"`, checked:true) for each required item that's met.
5. `mark_ready` to graduate the story. (Gate failure tells you which items are
   missing — relay them.)
6. As the user picks it up: `change_ticket_status → in-progress`.
7. When up for review: `→ review`.
8. `set_checklist_item` (gate `"dod"`, checked:true) for each met item.
9. `complete_ticket` — DoD + governance gates fire, ticket lands in *Done*.
10. After done: stop. Go back to step 1 (Map-Check) before the next ticket —
    **unless** the bundle rule below applies.

For a batch of already-ready stories, `bulk_change_status` moves them together.

### Bundle related stories — don't pause after every data-layer ticket
Within an epic (or a logical implementation sequence), implement **related
stories in one bundle** instead of stopping after every ticket. Stopping after
every "done" shreds multi-story work into pauses with no signal value.

**Auto-complete criteria** (decide per-story):

- **Pure data-layer / MCP-tool / core-op / validation story** — no UI change,
  no visible browser effect, AC fully covered by automated tests, all green →
  check DoD + `complete_ticket` directly, then continue to the next story.
  Surface the auto-complete decision in the reply + commit message.
- **UI story** — ALWAYS pause for the user to smoke. The visible effect IS the
  verification; without a human in the loop the DoD-review item has no signal.
- **Hybrid story** — auto-complete the data-layer sub-steps; the final pause
  comes for the UI smoke at the end.

**Bundle flow**: pick the lead story → Map-Check → walk all stories, deciding
auto-complete vs. user-smoke per story → mid-bundle commits (especially before a
UI-touching story, for a clean rollback point) → pause at the bundle end (or
when the next story needs UI smoke). The **first** ticket of a bundle is still
proposed + confirmed; only *subsequent purely-automatable* stories skip the
user-pause while their tests are green.

### Plan from dependencies — sequence + impact + traceability
- **Sequence + ready-pick**: capture the work as tickets, add typed links for
  the relationships you know (`predecessor-of` when B depends on A's outcome,
  `blocks` when A gates B, `relates-to` for soft cross-refs). The Dependency
  view shows which tickets are ready (no unresolved upstream) — pick from the
  ready set, preferring nodes that unblock the most downstream work. (`next_actionable`
  computes this ready set directly.)
- **Impact analysis** (before a structural change): `list_links_for_ticket` on
  the ticket you're about to touch — every **backward** link depends on current
  behaviour and may break. Do this before renames, type changes, deletions,
  API-surface changes.
- **Traceability**: from a goal (epic) walk `contains` into stories, then
  domain links into the tickets that realise it. Answers "is feature X covered?"
- **Link as you create**: when a ticket depends on another, add the link
  *immediately* — hidden dependencies become surprise blockers.

### Validate a feature with the test loop
Tests are tickets in the same workflow you already manage.

1. **Define once.** `ticket_create type=test-definition` with a clear title;
   `link_create … tests …` to the feature; fill prereqs + steps
   (`step` / `data` / `expectedResult`) via `test_def_prereq_add` /
   `test_def_step_add`. The definition has NO outcome.
   `publish_test_definition` when complete.
2. **Run.** `test_exec_start(definitionId, env?)` clones steps into a new
   test-execution (status `in-progress`), links `executes` → definition. Cloned
   steps are frozen — they reflect the definition at run time.
3. **Record.** Walk steps: `test_exec_record(execId, stepId, {status,
   actualResult, note?})`.
4. **Auto-coupling.** Once every step is non-pending (or `outcomeOverride` set),
   the execution auto-flips to `done`; the browser pill updates live.
5. **Iterate on failure.** Fix the code, then `test_exec_start` AGAIN — a NEW
   execution. The failed run stays in history as a permanent record.
6. **Close the feature.** Only `complete_ticket(featureId)` after a passing
   execution exists. Check via `test_exec_history(definitionId)`.

Don't skip the loop because the change "feels small" — even pure-data tickets
benefit from a 2-step definition (does it parse? does it round-trip?), a
permanent regression-net contribution.

### Reorganise
- *"Split this epic"* → `ticket_create` smaller stories, `reorder` them
  under the original epic, optionally `ticket_delete` the original if it's now
  just a label. (A native split-epic tool is roadmap, not built — do it by hand.)
- *"Move epic A into another release"* → `reorder` with
  `scope: {releaseId: newR, processStepId: <epic's step>, epicId: null}`.
- *"Bump this story up the backlog"* → `reorder` with the new
  `orderedIds[]`, no scope.
- Before any of these, `list_links_for_ticket` / the Dependency view to see what
  depends on what.

### Look back
- `list_revisions` to see what happened since the last meeting.
- `get_revision` on an entry to compare snapshots.
- `restore_revision` to roll back. **Always confirm first** — it clobbers
  current state (though it's itself undoable).
