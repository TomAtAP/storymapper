/**
 * ProjectStore — local mutable wrapper around a snapshot with undo/redo and
 * the same applyRemote/hydrate semantics cmapper proved out.
 *
 * Three ways to install a fresh snapshot:
 *   - applySnapshot(snap)  → user-driven (paste / load), commits as undo entry
 *   - applyRemote(snap)    → WebSocket push, commits as undo entry but is a
 *                            no-op when the incoming snapshot equals current
 *   - hydrate(snap)        → initial load / project switch, WIPES undo stack
 *
 * applyRemote MUST NOT call hydrate — otherwise every WS round-trip nukes
 * the user's undo history.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./core.js"));
  else (root.STORYMAP = root.STORYMAP || {}).store = factory(root.STORYMAP && root.STORYMAP.core);
}(typeof self !== "undefined" ? self : this, function (core) {
  "use strict";

  if (!core) throw new Error("store.js: core module missing (load order: core.js BEFORE store.js)");

  const MAX_UNDO = 200;

  /**
   * Named reasons that the store may pass to subscribers. The save-subscriber
   * in main.js skips persistence on `applyRemote` (echo from WS) and `hydrate`
   * (initial load / project switch); every other reason → debounced PUT.
   * `op:*` is a stand-in for every dynamically wrapped core.ops entry
   * (createTicket, updateProject, reorderTickets, …) — wrapOp uses the op
   * name verbatim as the reason.
   */
  const STORE_REASONS = Object.freeze({
    APPLY_REMOTE:   "applyRemote",
    HYDRATE:        "hydrate",
    APPLY_SNAPSHOT: "applySnapshot",
    UNDO:           "undo",
    REDO:           "redo"
  });

  /** Reasons the save-subscriber MUST NOT persist (would echo back to the
   *  server and cause a ping-pong). */
  const SKIP_PERSIST_REASONS = Object.freeze(new Set([
    STORE_REASONS.APPLY_REMOTE,
    STORE_REASONS.HYDRATE
  ]));

  function deepEqual(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  // SM-220: a cheap O(N) change-signal over the snapshot. Every op bumps the
  // touched entity's monotonic `version` (and create/delete changes a
  // collection length), so this integer signature differs for essentially
  // every real mutation — letting `applyRemote` skip the expensive
  // JSON.stringify deepEqual on the common WS-push (real-change) path and
  // commit straight away. A signal MATCH is NOT proof of equality (versions +
  // lengths can coincide), so the echo path still confirms with deepEqual:
  // AC3 — same metadata, different content is still detected as a change.
  function snapshotSignal(snap) {
    if (!snap) return "0|0|0|0";
    const t = snap.tickets || [], r = snap.releases || [], p = snap.processSteps || [];
    let v = (snap.project && (snap.project.version | 0)) || 0;
    for (let i = 0; i < t.length; i++) v += (t[i].version | 0);
    for (let i = 0; i < r.length; i++) v += (r[i].version | 0);
    for (let i = 0; i < p.length; i++) v += (p[i].version | 0);
    return t.length + "|" + r.length + "|" + p.length + "|" + v;
  }

  function emptySnapshot(projectId) {
    return core.normalizeSnapshot({
      project: { id: projectId || "untitled", name: projectId || "Untitled" }
    });
  }

  function ProjectStore(initial) {
    this._snap = core.normalizeSnapshot(initial || emptySnapshot());
    this._signal = snapshotSignal(this._snap);   // SM-220: cached change-signal
    this._past = [];
    this._future = [];
    this._listeners = new Set();
  }

  ProjectStore.prototype.get = function () {
    return this._snap;
  };

  ProjectStore.prototype.subscribe = function (fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  };

  ProjectStore.prototype._emit = function (reason) {
    for (const fn of this._listeners) {
      try { fn(this._snap, reason); } catch (_) { /* ignore listener errors */ }
    }
  };

  // SM-240 (normalize-only-at-edges): _commit no longer runs the full
  // normalizeSnapshot — every caller hands it an already-normalized snapshot.
  // The OUTER entry points normalize (applySnapshot below, applyRemote,
  // hydrate, the constructor); the op path doesn't need to: core.ops outputs
  // are normalize-invariant (pinned per op by tests/test-core-cow.js (c)),
  // and re-normalizing here would destroy the structural sharing COW just
  // created (every entity object rebuilt → no reference equality, bloated
  // undo stack).
  ProjectStore.prototype._commit = function (next, reason) {
    this._past.push(this._snap);
    if (this._past.length > MAX_UNDO) this._past.shift();
    this._future = [];
    this._snap = next;
    this._signal = snapshotSignal(this._snap);   // SM-220: keep signal in lockstep with _snap
    this._emit(reason || "commit");
  };

  // ---- The three install paths ------------------------------------------

  ProjectStore.prototype.applySnapshot = function (snap) {
    this._commit(core.normalizeSnapshot(snap), "applySnapshot");
  };

  ProjectStore.prototype.applyRemote = function (snap) {
    const incoming = core.normalizeSnapshot(snap);
    // SM-220: cheap signal first. A differing signal proves a real change —
    // commit straight away, skipping the two full JSON.stringify passes. Only
    // when the signal matches (true echo, or the pathological same-metadata
    // case) do we pay the authoritative deepEqual. WS-echo no-op is preserved.
    if (snapshotSignal(incoming) === this._signal && deepEqual(incoming, this._snap)) {
      return;  // confirmed echo → no-op, no undo entry
    }
    this._commit(incoming, "applyRemote");
  };

  ProjectStore.prototype.hydrate = function (snap) {
    this._snap = core.normalizeSnapshot(snap || emptySnapshot());
    this._signal = snapshotSignal(this._snap);   // SM-220
    this._past = [];
    this._future = [];
    this._emit("hydrate");
  };

  // ---- Undo / Redo ------------------------------------------------------

  ProjectStore.prototype.canUndo = function () { return this._past.length > 0; };
  ProjectStore.prototype.canRedo = function () { return this._future.length > 0; };

  ProjectStore.prototype.undo = function () {
    if (this._past.length === 0) return false;
    this._future.push(this._snap);
    this._snap = this._past.pop();
    this._signal = snapshotSignal(this._snap);   // SM-220
    this._emit("undo");
    return true;
  };

  ProjectStore.prototype.redo = function () {
    if (this._future.length === 0) return false;
    this._past.push(this._snap);
    this._snap = this._future.pop();
    this._signal = snapshotSignal(this._snap);   // SM-220
    this._emit("redo");
    return true;
  };

  // ---- Op wrappers — each commit becomes a single undo entry -----------

  function wrapOp(opName) {
    return function (...args) {
      const actor = args[args.length - 1] && typeof args[args.length - 1] === "object" && args[args.length - 1].type
        ? args.pop()
        : { type: "human", id: "local", name: "Local" };
      const next = core.ops[opName](this._snap, ...args, actor);
      this._commit(next, opName);
      return this._snap;
    };
  }

  for (const opName of Object.keys(core.ops)) {
    ProjectStore.prototype[opName] = wrapOp(opName);
  }

  // E18.D: changeStatusGated validiert die Transition (DoR/DoD) VOR dem
  // Commit. Wirft `{statusCode, kind, missing}` bei Verletzung — Callsite
  // fängt ab und zeigt `flashStatus(err.kind + ...)`. Bei Erfolg läuft
  // dieselbe `changeStatus`-Op wie sonst auch (1 Undo-Eintrag).
  ProjectStore.prototype.changeStatusGated = function (ticketId, newStatus, actor) {
    const ticket = this._snap.tickets.find(t => t.id === ticketId);
    if (!ticket) {
      const e = new Error("ticket not found: " + ticketId);
      e.statusCode = 404;
      throw e;
    }
    core.validateStatusTransition(ticket, newStatus, this._snap.project);
    return this.changeStatus(ticketId, newStatus, actor);
  };

  return { ProjectStore, emptySnapshot, deepEqual, snapshotSignal, STORE_REASONS, SKIP_PERSIST_REASONS };
}));
