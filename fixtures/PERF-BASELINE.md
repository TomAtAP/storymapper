# Performance Baseline (SM-219)

Captured baseline for the **Performance & Qualität** release. The follow-up
optimisation stories (SM-220 commit pipeline, SM-221 drag, SM-222 filter) measure
their before/after against these numbers **on the same harness**.

## How to reproduce

```sh
npm run perf
```

Runs `tests/perf-baseline.js`: a deterministic large board
(`tests/helpers/build-large-snapshot.js`) at N = 100 / 500 / 1000 tickets,
measuring the median of 7 runs (render: 5), with sub-millisecond ops inner-batched
to lift them above the timer's noise floor. The render path runs in JSDOM.

## What each column measures

| Column | Path | Why it matters |
|---|---|---|
| `normalize`   | `core.normalizeSnapshot(snap)`            | runs on **every** commit + WS push |
| `commit`      | `store.updateTicket(...)` → `_commit`     | a local edit (op clone + normalize + undo push) |
| `applyRemote` | `store.applyRemote(sameSnap)`             | WS-echo no-op — `JSON.stringify` deepEqual of the whole snapshot |
| `applyChange` | `store.applyRemote(changedSnap)`          | WS-push of a **real** change (SM-220) — the common case; cheap signal skips the deepEqual |
| `layout`      | `computeStoryMapLayout(snap)`             | pure story-map layout computation |
| `render`      | `storymap.mount(host, store)` (JSDOM)     | a full first `renderInto` (build the whole grid) |

## Baseline numbers

> Indicative, machine-relative (dev laptop, Node 20, JSDOM). Absolute values vary
> run-to-run — especially `render`; what matters for the follow-up stories is the
> **relative** change on this same harness. Re-run `npm run perf` to get current
> numbers for your machine before/after an optimisation.

```
N     |  normalize  |  commit    |  applyRemote  |  layout   |  render
------+-------------+------------+---------------+-----------+-----------
100   |  0.14 ms    |  1.09 ms   |  0.94 ms      |  0.16 ms  |  23.11 ms
500   |  0.24 ms    |  5.27 ms   |  4.68 ms      |  1.08 ms  |  52.15 ms
1000  |  0.55 ms    |  10.92 ms  |  9.45 ms      |  3.59 ms  |  121.93 ms
```

### After SM-220 (cheap signal echo-check in `applyRemote`)

A real WS-pushed change no longer pays the two full-snapshot `JSON.stringify`
passes: an O(N) integer signal (collection lengths + sum of entity `version`s)
short-circuits to a straight commit, falling back to deepEqual only when the
signal matches (true echo or the pathological same-metadata case — AC3).

```
N     |  applyRemote (echo, deepEqual)  |  applyChange (real change, fast path)  |  speedup
------+--------------------------------+----------------------------------------+---------
100   |  1.46 ms                       |  0.12 ms                               |  ~12×
500   |  4.61 ms                       |  0.77 ms                               |  ~6.0×
1000  |  9.39 ms                       |  1.68 ms                               |  ~5.6×
```

- **`applyChange` is the common case** (an MCP / other-client edit arriving over
  the socket); ≥5× faster than the old whole-snapshot deepEqual at N≥500 (AC5).
- **`applyRemote` (echo) is unchanged** — own-echoes are already filtered upstream
  by `originId`, so this no-op path stays at deepEqual cost and is rare.
- **Structural-sharing copy-on-write** (per-ticket reference equality, AC4) was
  **deferred**: the ops still deep-clone (`JSON.parse(JSON.stringify)`), which is
  `commit`'s real cost. At the daily board size (~234 tickets) `commit` /
  `applyRemote` are already sub-3 ms and `render` dominates, so COW is left to
  SM-221/223 where the renderer can actually exploit reference equality.

### After SM-221 (drag-layout cache) — and what it revealed (`dragMove` column)

A drag pointermove (`ctrl.setDragProjection` → `_rerender` → `renderInto`) used to
recompute the base layout every move. SM-221 caches it (computed once per
snapshot), so the `layout` cost is removed from each move. The benchmark's new
`dragMove` column times one such move end-to-end:

```
N     |  layout (per-move saving)  |  dragMove (full per-move render)
------+----------------------------+----------------------------------
100   |  0.20 ms                   |  40.8 ms
500   |  1.09 ms                   |  200.9 ms
1000  |  3.54 ms                   |  347.3 ms
```

- **The layout was never the per-move bottleneck.** A drag move is dominated by
  `renderInto` building a *fresh* full grid DOM and then Phase-C **morphing** it
  against the existing grid — at N=500 that's ~200 ms/move, MORE than a from-
  scratch first `render` (~51 ms) because the morph diffs all ~500 cards.
- **SM-221 delivers** the layout-recompute elimination (correct, tested, a real
  but small saving) and the cache plumbing that an incremental path builds on.
- **The order-of-magnitude per-move win is deferred to SM-223** (render fine-
  tuning): during a drag, only the dragged shadow card moves, so the fix is a
  drag-incremental DOM update (touch the affected container(s) / move the shadow
  in place) instead of rebuilding + morphing the whole grid every move. Decided
  with the user.

### After SM-223 (drag-incremental DOM update)

Mid-drag (same dragged ticket, projection → projection) only the affected
containers — previous target, new target, and for epic-cell drags the home
cell — are rebuilt with the SAME builders and morphed in place; the full grid
build+morph is skipped entirely (`_getGridBuildCount` stays at 0 per move).
Result DOM is byte-identical to the full path (pinned by tests across all four
projection types). Drag start/end and process-step column reorders keep the
full path.

```
N     |  dragMove before (SM-221)  |  dragMove after (SM-223)  |  speedup
------+-----------------------------+---------------------------+---------
100   |  40.8 ms                    |  7.1 ms                   |  ~5.7×
500   |  200.9 ms                   |  16.4 ms                  |  ~12×
1000  |  347.3 ms                   |  28.2 ms                  |  ~12×
```

Also in SM-223: `content-visibility: auto` on `.sm-cell` (skip layout/paint
below the fold), `defer` on all classical script tags, and the (c) audit
finding falsified: the dnd registry has been a WeakMap since SM-153 —
discarded build-nodes leak nothing persistent, so post-morph re-registration
is unnecessary.

### After SM-240 (copy-on-write ops + normalize-only-at-edges)

Every op used to start with a FULL deep clone of the snapshot (`clone(snap)` =
JSON round-trip) and the store re-ran `normalizeSnapshot` on every commit.
Now `cowSnap` shallow-copies (project + entity arrays), `cowTicket`/`cowRelease`/
`cowProcessStep` deep-clone exactly the entities being mutated (the COW-aware
`findTicket` converts nearly every op through one seam), and `store._commit`
skips the full normalize on the op path — op outputs are normalize-invariant,
pinned per op by tests/test-core-cow.js ((a) frozen input, (b) reference
sharing, (c) invariance; 108 tests). The undo stack now holds structurally
shared snapshots instead of 200 deep copies.

```
N     |  commit before  |  commit after  |  speedup
------+------------------+----------------+---------
100   |  1.54 ms         |  0.02 ms       |  ~77×
500   |  5.03 ms         |  0.10 ms       |  ~50×
1000  |  11.34 ms        |  0.11 ms       |  ~103×
```

`applyChange` (real WS change) also drops (1.91 → 0.73 ms at N=1000) since
the commit inside it no longer re-normalizes. The two invariance holes the
guardrails caught: `softDeleteRelease` now prunes dangling
`position.releaseId` itself (mirroring SM-167's processStep behaviour), and a
central op-wrapper refreshes `derivedHealth` copy-on-write after every op.

## Reading the baseline

- **`render` dominates** and scales with ticket count (~120 ms at 1000) — the
  full DOM rebuild is the single biggest cost. (SM-221 caches layout during drag;
  SM-223 trims render work.)
- **`commit` and `applyRemote` scale roughly linearly in N** (~10 ms each at
  1000). `commit` is the op's array-clone + `normalizeSnapshot`; `applyRemote` is
  the `JSON.stringify` deepEqual of the whole snapshot per WS push — both are
  SM-220's target (cheap echo-check + normalize only at outer entries).
- **`normalize` itself is cheap** (sub-millisecond up to ~0.5 ms at 1000) — it is
  *not* the bottleneck in isolation; the cost shows up because it runs on every
  commit AND inside `applyRemote`, i.e. twice per WS round-trip.
- **`layout` is moderate** (~3.6 ms at 1000) and is re-run on every drag
  pointermove today — SM-221/222's target.
