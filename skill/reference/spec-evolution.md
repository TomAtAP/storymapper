# Spec evolution & test definitions (governance)

> Reference for the Story Mapper skill. The governance model (SM-92/SM-93): how
> spec changes flow, when test-definitions become runnable, what stops
> `complete_ticket`. Three layers, each with a different enforcement mode:

| Layer | What it does | Who enforces |
|---|---|---|
| **HARD** (tool-blocked) | Returns `isError` with `{kind, errors[], message:{title, reason, suggestion, skillRef}}`. The call doesn't go through. | `publish_test_definition`, `reopen_test_definition`, `test_exec_start`, `complete_ticket`, `ticket_update` (frozen-def case). |
| **SOFT** (warning) | Response includes `warnings:[{kind, context, message:{…}}]`. The write happens. | `ticket_update` on a `ready+` ticket with a spec patch (acceptanceCriteria / description / definitionOfReady). |
| **SKILL-only** (this section) | Not enforced by code. Respect it regardless. | Me. |

### Test-definition lifecycle
A `test-definition` is a feature-bound catalog artifact, not a work item. Two states:

- `draft` — being authored. NOT runnable (`test_exec_start` → `DEFINITION_DRAFT`).
- `published` — locked in. Runnable. `ticket_update` rejects step/prereq edits
  (`DEFINITION_FROZEN`); use `update_test_definition_metadata` for cosmetic
  fields, or the `modifies` path below to evolve the spec.

Promote via `publish_test_definition` (gates: ≥1 step, ≥1 `tests`-link, every
step has `expectedResult`, target ≥ `ready`). Revert via
`reopen_test_definition` (blocks with `ACTIVE_EXECUTION` if a run is in-progress).

### Spec changes via `modifies`-tickets, not in-place edits
When you need to change a ticket's spec AFTER it reached `ready+`:

1. Create a NEW ticket describing the change.
2. `link_create({sourceTicketId: newTicket, targetTicketId: original, linkTypeId: "modifies"})`.
3. Work the new ticket.
4. Linked test-definitions become `derivedHealth: stale`, so the next
   `complete_ticket` on the original surfaces `STALE_LINKED_DEF` until you re-run
   the affected definitions via `test_exec_start`.

`modifies` is cycle-checked, giving full traceability of which tickets reshape
which features.

### Workflow shorthand
```
Story (ready+, AC frozen)
  ↓ derive
test-definition (draft) → publish_test_definition → published
  ↓ test_exec_start
test-execution (in-progress) → record steps → auto-flip to done
  ↑
Spec changes? → new modifies-ticket → linked definitions go stale
                                     → re-run before complete_ticket
```

When a gate fires, read `message.suggestion` — it spells out the next MCP
call(s). `get_config` / `set_config` (`section: "governance"`) read/replace the
config (full replace; unknown predicate names are rejected with `UNKNOWN_PREDICATE`).
