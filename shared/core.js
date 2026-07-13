/**
 * storymap — core data model (single source of truth)
 *
 * UMD single source of truth (shared/). Consumed two ways from ONE file:
 *   - Node: require() — server/core.js is a 1-line shim, tests require directly.
 *   - Browser: <script src> attaches to window.STORYMAP.core.
 * Pure functions only — no I/O, no DOM. Edit ONLY this file; the server shim
 * and the frontend symlink both resolve here, so drift is impossible.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else (root.STORYMAP = root.STORYMAP || {}).core = factory();
}(typeof self !== "undefined" ? self : this, function () {
"use strict";

/**
 * storymap — core data model.
 *
 * Pure functions only (no I/O). Single source of truth for the snapshot
 * shape and every mutation. Mirrored 1:1 into `frontend/js/core.js` via
 * UMD wrapper; `tests/test-mirror.js` enforces parity.
 *
 * Snapshot shape:
 *   {
 *     version: 1,
 *     project: { id, name, ..., definitions, ticketPrefix, ticketCounter, ... },
 *     tickets: [ { id, projectId, type, ticketKey, ..., definitionOfReady, definitionOfDone, ... } ],
 *     releases: [ { id, projectId, name, status, sortOrder, ... } ],
 *     processSteps: [ { id, projectId, name, epicId, sortOrder, ... } ]
 *   }
 *
 * `ops` are (snapshot, args, actor) → newSnapshot. They never mutate the
 * input; they deep-clone first. Validation is OUT of scope here — see
 * `server/validation.js`. Status-transition checks (DoR/DoD enforcement)
 * live in validation.js too.
 */

const SCHEMA_VERSION = 1;

// Virtual backlog identifiers used by the renderer to group tickets that
// have no release or no epic assignment yet. Never written to the DB —
// `position.releaseId === null` / `position.epicId === null` is the
// canonical "in backlog" state. The IDs exist so views can address the
// backlog as if it were a regular row.
const EPIC_BACKLOG_ID  = "__epic_backlog__";
const STORY_BACKLOG_ID = "__story_backlog__";

const DEFAULT_TICKET_TYPES = [
  "epic",
  "user-story",
  "technical-task-backend",
  "technical-task-ui",
  "bug",
  // SM-53 / SM-56 — first-class test types.
  // test-definition holds the reusable test script (prerequisites + steps
  // with expectedResult). test-execution is a single run that references
  // a definition + records actualResult/status per step + an outcome.
  "test-definition",
  "test-execution",
  // SM-196 R-1 — spec-layer type. A `requirement` is a SpecObject: one
  // sliced PRD section, an atomic statement. It is NOT a work item — it
  // never appears on the kanban board or as a story-card in a story-map
  // cell, carries no DoR/DoD, and serves only as a link target for
  // `realises` (=DOORS satisfies) / `tests` (=validates).
  "requirement",
  // SM-196 R-2 — the spec-module container. One per imported document
  // (DOORS "module" / ReqIF Specification). Holds its requirements via
  // `contains` links, ordered by sectionPath; carries the source
  // attachment id. Board-excluded like requirements.
  "spec-module"
];

// SM-196 — spec-layer types (SpecObjects + their module container). Distinct
// from work items: they live in a spec module / the Requirements view, never
// on a board.
const SPEC_TYPES = ["requirement", "spec-module"];
function isSpecType(type) { return SPEC_TYPES.indexOf(type) >= 0; }
// A ticket that appears as a movable work-card on the kanban board:
// excludes epics (containers shown specially) AND spec types (requirements).
function isBoardWorkItem(type) { return type !== "epic" && !isSpecType(type); }

const DEFAULT_STATUSES = ["backlog", "ready", "in-progress", "review", "done"];

const DEFAULT_RELEASE_STATUSES = ["planning", "active", "completed", "cancelled"];

/**
 * Storymapper-bundled DoR/DoD-Vorgaben. `normalizeProject` seedet diese
 * Items, falls ein neues Projekt OHNE eigene Definitions angelegt wird —
 * damit hat jedes neue Projekt direkt eine arbeitsfähige Vorlage. User
 * kann sie pro Projekt überschreiben (REST/MCP via set_definitions, oder
 * direkt via PUT /projects/:pid).
 */
const STORYMAPPER_DEFAULT_DEFINITIONS = {
  ready: {
    global: [
      { id: "dor-acceptance", label: "Acceptance criteria are defined", required: true },
      { id: "dor-clarity",    label: "Scope is clear to the team",      required: true }
    ],
    byType: {}
  },
  done: {
    global: [
      { id: "dod-tests",   label: "All acceptance criteria are met",  required: true },
      { id: "dod-review",  label: "Code reviewed by a peer",          required: true }
    ],
    byType: {}
  }
};

/**
 * Storymapper-bundled Workflow-Vorgabe. `normalizeProject` seedet diese,
 * falls ein Projekt kein eigenes `workflow`-Feld hat. Bestandsdaten ohne
 * Workflow erben damit das gleiche Verhalten, das vor E13.C hardgekodet
 * war (Gates bei → ready und → done).
 *
 * Shape:
 *   statuses:    geordnete Liste der erlaubten Status — Reihenfolge
 *                bestimmt die "Vorwärts"-Richtung für Sprung-Übergänge.
 *   transitions: pro Target-Status optional `requireGate: "DoR"|"DoD"|null`.
 *                Bei Vorwärts-Sprung werden ALLE Gates der überquerten
 *                Status geprüft (z.B. backlog→done greift DoR UND DoD).
 *   byType:      Per-Type-Overrides (analog definitions.byType).
 *                Pro Type kann `transitions` ganz oder teilweise überschrieben
 *                werden; fehlende Schlüssel fallen auf das globale Workflow
 *                zurück.
 */
// Status-Kategorien (Jira-Modell): treiben Lane-Farben + Board-Column-
// Mapping-Defaults. Erweiterbar bewusst NICHT gehalten — diese vier deckt
// den großen Teil realistischer Workflows ab, weitere Sub-Kategorien
// können sinngemäß rein als Display-Variante kommen.
// SM-242: `cancelled` is the fifth, TERMINAL category alongside done — a
// deliberate non-implementation (scope reduction), distinct from done.
const STATUS_CATEGORIES = ["todo", "doing", "blocked", "done", "cancelled"];

// Heuristik beim Migrieren alter String-Status-Listen: gleicht den Status-
// Identifier mit bekannten Mustern ab und liefert eine sinnvolle Kategorie.
// Unbekannte IDs fallen auf "doing" — der häufigste Fall in der Praxis.
function defaultCategoryForStatusId(id) {
  if (typeof id !== "string") return "doing";
  const s = id.toLowerCase();
  if (s === "backlog" || s === "todo" || s === "to-do" || s === "open"
      || s === "new" || s === "ready") return "todo";
  if (s === "blocked" || s === "on-hold" || s === "hold" || s === "waiting"
      || s === "deferred" || s === "paused") return "blocked";
  // SM-242: cancelled-ish ids map to the cancelled category, NOT done.
  if (s === "cancelled" || s === "canceled" || s === "wontdo" || s === "won't-do"
      || s === "wont-do" || s === "rejected" || s === "abandoned") return "cancelled";
  if (s === "done" || s === "closed" || s === "complete" || s === "completed"
      || s === "shipped") return "done";
  return "doing";
}

// Sehr leichte Humanisierung: kebab-case / snake_case → Title Case.
// "in-progress" → "In Progress", "code_review" → "Code Review".
function humanizeStatusId(id) {
  if (typeof id !== "string" || id.length === 0) return "";
  return id.replace(/[-_]+/g, " ")
           .split(" ")
           .filter(Boolean)
           .map(w => w.charAt(0).toUpperCase() + w.slice(1))
           .join(" ");
}

function normalizeStatusItem(s) {
  if (typeof s === "string") {
    return { id: s, name: humanizeStatusId(s), category: defaultCategoryForStatusId(s) };
  }
  if (!s || typeof s !== "object") return null;
  const id = typeof s.id === "string" ? s.id : null;
  if (!id) return null;
  const name = typeof s.name === "string" && s.name.length > 0 ? s.name : humanizeStatusId(id);
  const category = STATUS_CATEGORIES.includes(s.category) ? s.category : defaultCategoryForStatusId(id);
  return { id: id, name: name, category: category };
}

const STORYMAPPER_DEFAULT_WORKFLOW = {
  statuses: [
    { id: "backlog",     name: "Backlog",     category: "todo" },
    { id: "ready",       name: "Ready",       category: "todo" },
    { id: "in-progress", name: "In Progress", category: "doing" },
    { id: "review",      name: "Review",      category: "doing" },
    { id: "done",        name: "Done",        category: "done" },
    // SM-242: terminal cancel state — a deliberate non-implementation.
    { id: "cancelled",   name: "Cancelled",   category: "cancelled" }
  ],
  // Jira-style named transitions: every status reachable as allowFromAny
  // (= forward moves preserved by default). Gates live on 'ready' (DoR)
  // and 'done' (DoD). Project owners may replace this list with stricter
  // source-restrictions via the Settings UI (E21.F).
  transitions: [
    { id: "to-backlog",     name: "→ Backlog",     fromStatuses: [], toStatus: "backlog",     requireGate: null,  allowFromAny: true },
    { id: "to-ready",       name: "→ Ready",       fromStatuses: [], toStatus: "ready",       requireGate: "DoR", allowFromAny: true },
    { id: "to-in-progress", name: "→ In Progress", fromStatuses: [], toStatus: "in-progress", requireGate: null,  allowFromAny: true },
    { id: "to-review",      name: "→ Review",      fromStatuses: [], toStatus: "review",      requireGate: null,  allowFromAny: true },
    { id: "to-done",        name: "→ Done",        fromStatuses: [], toStatus: "done",        requireGate: "DoD", allowFromAny: true },
    // SM-242: gate-free cancel from any status (Cancel ≠ Delete — keeps history).
    { id: "cancel",         name: "Cancel",        fromStatuses: [], toStatus: "cancelled",   requireGate: null,  allowFromAny: true }
  ],
  byType: {}
};

const LIMITS = {
  maxTicketsPerProject: 5000,
  maxReleases: 200,
  maxProcessSteps: 200,
  maxChecklistItems: 100,
  maxLabelLength: 200,
  maxTitleLength: 300,
  maxDescriptionLength: 50000,
  maxCommentBody: 50000
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uid(prefix) {
  return (prefix || "") + Math.random().toString(36).slice(2, 7) + Date.now().toString(36).slice(-3);
}

function now() {
  return Date.now();
}

function clone(x) {
  return JSON.parse(JSON.stringify(x));
}

// ---------------------------------------------------------------------------
// SM-240 — Copy-on-Write snapshot machinery.
//
// Every op used to start with a FULL deep clone of the snapshot (the real
// `commit` hotspot, ~11ms at N=1000) — destroying structural sharing for the
// undo stack and the renderers' reference-equality fast-paths. cowSnap makes
// a SHALLOW copy (project + the entity arrays are fresh; the entity OBJECTS
// stay shared); cowTicket/cowRelease/cowProcessStep deep-clone exactly the
// one entity about to be mutated and swap it into the array.
//
// The `__cowFresh` WeakSet (non-enumerable — invisible to JSON/Object.keys/
// deep-equal) tracks objects that are already private to this op run, making
// the cow* helpers idempotent: a second cow of the same entity returns the
// SAME object, so helpers that hold a reference never go stale. Freshly
// created entities are registered via markCowFresh for the same reason.
//
// Guardrails live in tests/test-core-cow.js: (a) the input snapshot is
// deep-frozen — any in-place mutation of a shared object throws; (b) untouched
// tickets must come out reference-equal; (c) every op output must be
// normalize-invariant (the store skips the full normalize on the op path).
// ---------------------------------------------------------------------------

function cowSnap(snap) {
  const s = Object.assign({}, snap);
  s.project = Object.assign({}, snap.project);
  s.tickets = (snap.tickets || []).slice();
  s.releases = (snap.releases || []).slice();
  s.processSteps = (snap.processSteps || []).slice();
  Object.defineProperty(s, "__cowFresh", {
    value: new WeakSet(), enumerable: false, configurable: true
  });
  return s;
}

function markCowFresh(s, obj) {
  if (s && s.__cowFresh && obj && typeof obj === "object") s.__cowFresh.add(obj);
  return obj;
}

function cowEntity(s, arrName, id) {
  const arr = s[arrName] || [];
  const i = arr.findIndex(e => e && e.id === id);
  if (i < 0) return null;
  const cur = arr[i];
  if (s.__cowFresh && s.__cowFresh.has(cur)) return cur;   // already private
  const next = clone(cur);
  arr[i] = next;
  if (s.__cowFresh) s.__cowFresh.add(next);
  return next;
}

function cowTicket(s, id)      { return cowEntity(s, "tickets", id); }
function cowRelease(s, id)     { return cowEntity(s, "releases", id); }
function cowProcessStep(s, id) { return cowEntity(s, "processSteps", id); }

function isObject(x) {
  return x !== null && typeof x === "object" && !Array.isArray(x);
}

function normalizeActor(actor) {
  if (!isObject(actor)) return { type: "human", id: "unknown", name: "Unknown" };
  const out = {
    type: actor.type === "ai" ? "ai" : "human",
    id: typeof actor.id === "string" ? actor.id : "unknown",
    name: typeof actor.name === "string" ? actor.name : "Unknown"
  };
  if (typeof actor.sessionId === "string") out.sessionId = actor.sessionId;
  return out;
}

// ---------------------------------------------------------------------------
// normalize* — fill defaults, freeze shape
// ---------------------------------------------------------------------------

function normalizeChecklistItem(item) {
  return {
    id: typeof item.id === "string" ? item.id : uid("ci-"),
    label: typeof item.label === "string" ? item.label : "",
    required: item.required !== false,
    checked: item.checked === true,
    checkedAt: typeof item.checkedAt === "number" ? item.checkedAt : null,
    checkedBy: isObject(item.checkedBy) ? normalizeActor(item.checkedBy) : null
  };
}

function normalizeChecklist(cl) {
  const items = Array.isArray(cl && cl.items) ? cl.items.map(normalizeChecklistItem) : [];
  return { items };
}

function normalizeDefinitionItem(item) {
  return {
    id: typeof item.id === "string" ? item.id : uid("def-"),
    label: typeof item.label === "string" ? item.label : "",
    required: item.required !== false
  };
}

function normalizeDefinitionBlock(block) {
  const out = {
    global: Array.isArray(block && block.global) ? block.global.map(normalizeDefinitionItem) : [],
    byType: {}
  };
  const byType = (block && block.byType) || {};
  for (const key of Object.keys(byType)) {
    const entry = byType[key] || {};
    const norm = {};
    if (Array.isArray(entry.appended)) norm.appended = entry.appended.map(normalizeDefinitionItem);
    if (Array.isArray(entry.overridden)) norm.overridden = entry.overridden.map(normalizeDefinitionItem);
    out.byType[key] = norm;
  }
  return out;
}

function normalizeDefinitions(defs) {
  defs = defs || {};
  return {
    ready: normalizeDefinitionBlock(defs.ready),
    done: normalizeDefinitionBlock(defs.done)
  };
}

function isEmptyDefinitions(defs) {
  if (!defs) return true;
  const ready = (defs.ready && defs.ready.global) || [];
  const done  = (defs.done  && defs.done.global)  || [];
  return ready.length === 0 && done.length === 0;
}

// Legacy form: { [target]: {requireGate} }. New form: array of named
// transitions (Jira-style). normalizeWorkflowTransitions accepts either
// input form and always emits the array form. The conversion needs the
// status list because legacy migration generates one allowFromAny entry
// per known status so existing forward-step behavior is preserved.
function normalizeTransitionItem(raw, knownStatusIds) {
  if (!raw || typeof raw !== "object") return null;
  const toStatus = typeof raw.toStatus === "string" ? raw.toStatus : null;
  if (!toStatus) return null;
  if (knownStatusIds && !knownStatusIds.includes(toStatus)) return null;
  const gate = raw.requireGate;
  const fromStatuses = Array.isArray(raw.fromStatuses)
    ? raw.fromStatuses.filter(s => typeof s === "string" && (!knownStatusIds || knownStatusIds.includes(s)))
    : [];
  // allowFromAny is whatever the caller said. Don't infer it from
  // fromStatuses.length === 0 — that would override a user who's mid-edit
  // (just unchecked "From any", hasn't picked sources yet) by silently
  // re-checking it. A transition with allowFromAny=false AND empty
  // fromStatuses is "unreachable" at validation time, which is fine as a
  // transient state.
  return {
    id: typeof raw.id === "string" && raw.id.length > 0 ? raw.id : uid("tr-"),
    name: typeof raw.name === "string" && raw.name.length > 0 ? raw.name : ("→ " + humanizeStatusId(toStatus)),
    fromStatuses: fromStatuses,
    toStatus: toStatus,
    requireGate: (gate === "DoR" || gate === "DoD") ? gate : null,
    allowFromAny: raw.allowFromAny === true
  };
}

function normalizeWorkflowTransitions(t, knownStatusIds) {
  // New form: array of named transitions.
  if (Array.isArray(t)) {
    const out = [];
    const seenIds = new Set();
    for (const raw of t) {
      const tr = normalizeTransitionItem(raw, knownStatusIds);
      if (!tr) continue;
      if (seenIds.has(tr.id)) continue;
      seenIds.add(tr.id);
      out.push(tr);
    }
    return out;
  }
  // Legacy form: object keyed by target status. Build one allowFromAny
  // transition per known status; entries in the legacy object inject the
  // gate where defined, missing keys default to no gate.
  if (t && typeof t === "object") {
    const ids = Array.isArray(knownStatusIds) ? knownStatusIds : [];
    const legacy = {};
    for (const k of Object.keys(t)) {
      const v = t[k];
      if (!v || typeof v !== "object") continue;
      const gate = v.requireGate;
      legacy[k] = { requireGate: (gate === "DoR" || gate === "DoD") ? gate : null };
    }
    const out = [];
    for (const id of ids) {
      const entry = legacy[id];
      out.push({
        id: "to-" + id,
        name: "→ " + humanizeStatusId(id),
        fromStatuses: [],
        toStatus: id,
        requireGate: entry ? entry.requireGate : null,
        allowFromAny: true
      });
    }
    return out;
  }
  return [];
}

function normalizeStatusList(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const s = normalizeStatusItem(raw);
    if (!s) continue;
    if (seen.has(s.id)) continue;  // dedupe by id
    seen.add(s.id);
    out.push(s);
  }
  return out;
}

// SM-242: additive migration — a workflow with NO cancelled-category status
// gets a `cancelled` status + a gate-free `cancel` transition appended. Never
// touches existing statuses/transitions; a project that already owns a
// cancelled-category status (any id) is left byte-identical. Idempotent.
function ensureCancelledStatus(out) {
  // An empty workflow stays empty so normalizeProject falls back to the default
  // (which already carries cancelled). Only migrate REAL workflows.
  if (!out.statuses.length) return out;
  // SM-244 self-heal: an OLD (pre-SM-242) server that received a snapshot with
  // a cancelled status normalizes its unknown "cancelled" category DOWN to
  // "done" and persists that. After the server is upgraded the corruption
  // survives (done is a valid category). Repair a status whose id is
  // "cancelled" back to the cancelled category so cancel works again.
  for (const s of out.statuses) {
    if (s && s.id === "cancelled" && s.category !== "cancelled") s.category = "cancelled";
  }
  const hasCancelledCat = out.statuses.some(s => s.category === "cancelled");
  const hasCancelledId  = out.statuses.some(s => s.id === "cancelled");
  if (hasCancelledCat || hasCancelledId) return out;
  out.statuses = out.statuses.concat([{ id: "cancelled", name: "Cancelled", category: "cancelled" }]);
  // Guard on BOTH toStatus AND id so the append is idempotent even when the
  // workflow already owns a transition with id "cancel" pointing elsewhere
  // (otherwise normalize² would dedupe the duplicate id and diverge).
  if (!out.transitions.some(t => t.toStatus === "cancelled" || t.id === "cancel")) {
    out.transitions = out.transitions.concat([
      { id: "cancel", name: "Cancel", fromStatuses: [], toStatus: "cancelled", requireGate: null, allowFromAny: true }
    ]);
  }
  return out;
}

function normalizeWorkflow(wf) {
  if (!wf || typeof wf !== "object") return null;
  const statuses = normalizeStatusList(wf.statuses);
  const statusIds = statuses.map(s => s.id);
  const out = ensureCancelledStatus({
    statuses: statuses,
    transitions: normalizeWorkflowTransitions(wf.transitions, statusIds),
    byType: {}
  });
  if (wf.byType && typeof wf.byType === "object") {
    for (const type of Object.keys(wf.byType)) {
      const v = wf.byType[type];
      if (!v || typeof v !== "object") continue;
      const sub = {};
      if (Array.isArray(v.statuses)) sub.statuses = normalizeStatusList(v.statuses);
      if (v.transitions) {
        // Per-type-Override darf entweder array (new) oder object (legacy)
        // sein. Bei legacy-Form generieren wir NICHT die volle Liste pro
        // Status — nur die expliziten Einträge, damit der Merge in
        // getWorkflowForType per-Target gezielt ersetzt.
        if (Array.isArray(v.transitions)) {
          sub.transitions = normalizeWorkflowTransitions(v.transitions, statusIds);
        } else if (typeof v.transitions === "object") {
          // Bauen explizit, nur für die im Legacy-Override genannten Targets.
          const overriddenTargets = Object.keys(v.transitions);
          sub.transitions = [];
          for (const target of overriddenTargets) {
            if (!statusIds.includes(target)) continue;
            const entry = v.transitions[target];
            if (!entry || typeof entry !== "object") continue;
            const gate = entry.requireGate;
            sub.transitions.push({
              id: "to-" + target,
              name: "→ " + humanizeStatusId(target),
              fromStatuses: [],
              toStatus: target,
              requireGate: (gate === "DoR" || gate === "DoD") ? gate : null,
              allowFromAny: true
            });
          }
        }
      }
      out.byType[type] = sub;
    }
  }
  return out;
}

/**
 * Resolve the effective workflow for a given ticket type. Layering:
 *   project.workflow.byType[type] (statuses/transitions)
 *     → overrides project.workflow.{statuses, transitions}
 *       → overrides STORYMAPPER_DEFAULT_WORKFLOW.
 * Missing per-type fields fall back to the project-level workflow.
 */
// Merge base transition list with per-type overrides. Override semantics:
// when a per-type transition has the same toStatus as a base transition,
// the per-type one replaces it. Other base transitions stay. This keeps
// the legacy behavior where `byType[type].transitions["ready"]={gate:null}`
// disables the DoR gate for that type only.
function mergeTransitionLists(base, override) {
  if (!Array.isArray(override) || override.length === 0) return (base || []).slice();
  const result = (base || []).slice();
  for (const tr of override) {
    const idx = result.findIndex(b => b.toStatus === tr.toStatus);
    if (idx >= 0) result[idx] = tr;
    else result.push(tr);
  }
  return result;
}

function getWorkflowForType(project, type) {
  const base = (project && project.workflow) || STORYMAPPER_DEFAULT_WORKFLOW;
  const baseStatuses    = (base.statuses && base.statuses.length > 0) ? base.statuses    : STORYMAPPER_DEFAULT_WORKFLOW.statuses;
  const baseTransitions = Array.isArray(base.transitions) ? base.transitions : STORYMAPPER_DEFAULT_WORKFLOW.transitions;
  const perType = (base.byType && base.byType[type]) || null;
  if (!perType) {
    return { statuses: baseStatuses.slice(), transitions: baseTransitions.slice() };
  }
  return {
    statuses:    (perType.statuses && perType.statuses.length > 0) ? perType.statuses.slice() : baseStatuses.slice(),
    transitions: mergeTransitionLists(baseTransitions, perType.transitions || [])
  };
}

function normalizeLabel(l) {
  // Accept either a string (legacy: ticket.labels and old project.labels were
  // string[]; treat the value as the label name) or an object {id?, name, color?}.
  if (typeof l === "string") {
    return { id: uid("lbl-"), name: l, color: "#999999" };
  }
  l = l || {};
  return {
    id: typeof l.id === "string" ? l.id : uid("lbl-"),
    name: typeof l.name === "string" ? l.name : "",
    color: typeof l.color === "string" ? l.color : "#999999"
  };
}

// E21.C: Kanban-Board-Config. Eine Liste von Columns; jede Column bündelt
// einen oder mehrere Statuses zu einer Lane. Default-Mapping ist 1:1
// (eine Column pro Status, gleiche Reihenfolge) — Verhalten bleibt
// rückwärtskompatibel.
function normalizeKanbanColumn(c, knownStatusIds) {
  if (!c || typeof c !== "object") return null;
  const id = typeof c.id === "string" && c.id.length > 0 ? c.id : null;
  const name = typeof c.name === "string" ? c.name : "";
  const statusIds = Array.isArray(c.statusIds)
    ? c.statusIds.filter(s => typeof s === "string" && knownStatusIds.includes(s))
    : [];
  if (!id) return null;
  return { id: id, name: name, statusIds: statusIds };
}

function defaultKanbanColumns(statuses) {
  return (statuses || []).map(s => ({
    id: "col-" + s.id,
    name: s.name,
    statusIds: [s.id]
  }));
}

function normalizeKanbanBoard(board, statuses) {
  const knownStatusIds = statuses.map(s => s.id);
  if (!board || typeof board !== "object" || !Array.isArray(board.columns)) {
    return { columns: defaultKanbanColumns(statuses) };
  }
  const cols = [];
  const seenIds = new Set();
  for (const raw of board.columns) {
    const c = normalizeKanbanColumn(raw, knownStatusIds);
    if (!c) continue;
    if (seenIds.has(c.id)) continue;
    seenIds.add(c.id);
    cols.push(c);
  }
  // Empty columns are allowed (user just created one, or every status was
  // dragged elsewhere). If the board has NO columns at all → fall back to
  // the default 1:1 mapping so the kanban view never goes completely blank.
  if (cols.length === 0) return { columns: defaultKanbanColumns(statuses) };
  return { columns: cols };
}

function normalizeProjectBoards(boards, statuses) {
  return { kanban: normalizeKanbanBoard(boards && boards.kanban, statuses) };
}

// SM-100: test-flags are type-bound. The renderer + editor only honour them
// on the test types; storing them for other types is what created the
// "Epic shows Prerequisites/Steps/Outcome" leak.
const TEST_FLAGS_FOR_TYPE = {
  "test-definition": ["showPrerequisites", "showSteps"],
  "test-execution":  ["showExecutionSteps", "showTestOutcome"]
};

function normalizeEntityTypeConfig(cfg) {
  if (!cfg || typeof cfg !== "object") return {};
  const out = {};
  for (const k of Object.keys(cfg)) {
    const v = cfg[k];
    if (!v || typeof v !== "object") continue;
    const entry = {
      showAcceptanceCriteria: v.showAcceptanceCriteria !== false,
      showDefinitionOfReady:  v.showDefinitionOfReady  !== false,
      showDefinitionOfDone:   v.showDefinitionOfDone   !== false,
      allowParentEpic:        v.allowParentEpic        !== false,
      showProcessStep:        v.showProcessStep        !== false,
      showRelease:            v.showRelease            !== false,
      showLinks:              v.showLinks              !== false
    };
    // SM-100 migration: only carry the test-flags that apply to this type.
    // Stale flags from prior writes are dropped — the snapshot becomes clean
    // on the next save. Non-test types never store test-flags at all.
    const allowed = TEST_FLAGS_FOR_TYPE[k] || [];
    for (const flag of allowed) entry[flag] = v[flag] !== false;
    out[k] = entry;
  }
  return out;
}

/**
 * Resolve the effective config for a given ticket type on a project.
 * Defaults: all sections shown, allowParentEpic=true. Special-case types:
 *   - "epic" hard-codes allowParentEpic=false
 *   - "test-definition" hides AC (they belong on the story) but shows
 *     prerequisites + steps
 *   - "test-execution" hides AC/DoR/DoD (outcome replaces the gate) and
 *     shows executionSteps + testOutcome
 * Per-type overrides from `project.entityTypeConfig` take precedence.
 */
function getEntityTypeConfig(project, type) {
  const isTestDef  = type === "test-definition";
  const isTestExec = type === "test-execution";
  const isAnyTest  = isTestDef || isTestExec;
  // SM-196: spec-layer types (requirement + its spec-module container) are
  // SpecObjects — no AC/DoR/DoD, no board position, no parent epic. Their own
  // text IS the spec. Links stay on (realises/tests point AT a requirement;
  // a module contains its requirements; the modal may still surface them).
  const isReq      = isSpecType(type);
  // SM-237: an epic's status is DERIVED from its stories (roll-up), so the
  // DoR/DoD gates never fire on an epic — the checklist UI is N/A (Lockstep:
  // hidden field ⇒ rule not applicable).
  const isEpic     = type === "epic";
  const defaults = {
    showAcceptanceCriteria: !isAnyTest && !isReq,
    // SM-54-followup: tests have their OWN completeness criteria —
    // prerequisites + steps for a definition, outcome for an execution.
    // The generic DoR/DoD checklist doesn't apply.
    showDefinitionOfReady:  !isAnyTest && !isReq && !isEpic,
    showDefinitionOfDone:   !isAnyTest && !isReq && !isEpic,
    allowParentEpic:        type !== "epic" && !isReq,
    showProcessStep:        !isReq,
    showRelease:            !isReq,
    showLinks:              true,
    // Test-type defaults.
    showPrerequisites:      isTestDef,
    showSteps:              isTestDef,
    showExecutionSteps:     isTestExec,
    showTestOutcome:        isTestExec
  };
  const override = (project && project.entityTypeConfig && project.entityTypeConfig[type]) || null;
  if (!override) return defaults;
  return Object.assign({}, defaults, override, {
    // Hard override: epic + requirement never have a parent epic regardless of config.
    allowParentEpic: (type === "epic" || isReq) ? false : (override.allowParentEpic !== false),
    // SM-237 hard-lock: epics never show DoR/DoD (derived status ⇒ gates N/A),
    // no matter what a stale per-type override carries.
    showDefinitionOfReady: isEpic ? false : (Object.assign({}, defaults, override).showDefinitionOfReady),
    showDefinitionOfDone:  isEpic ? false : (Object.assign({}, defaults, override).showDefinitionOfDone),
    // SM-100 hard-lock: test-flags are bound to their type. An override that
    // (legacy or otherwise) carries a `true` for the wrong type must not be
    // honoured — otherwise epics/stories sprout Prereqs / Steps / Outcome.
    showPrerequisites:  isTestDef  ? (override.showPrerequisites  !== false) : false,
    showSteps:          isTestDef  ? (override.showSteps          !== false) : false,
    showExecutionSteps: isTestExec ? (override.showExecutionSteps !== false) : false,
    showTestOutcome:    isTestExec ? (override.showTestOutcome    !== false) : false
  });
}

function normalizeProject(p) {
  p = p || {};
  const ticketTypes = Array.isArray(p.ticketTypes) && p.ticketTypes.length > 0
    ? p.ticketTypes.slice()
    : DEFAULT_TICKET_TYPES.slice();
  // Definitions: nur seeden, wenn das Projekt GAR KEINE definitions mitbringt
  // (absent → neues Projekt erbt die Bundled-Defaults). Ein EXPLIZIT leeres
  // definitions-Objekt ist eine bewusste User-Wahl und wird respektiert —
  // sonst ließe sich eine geleerte DoR/DoD-Checkliste nie persistieren, weil
  // normalizeProject auf jedem Save läuft. (SM-150)
  const definitions = (p.definitions === undefined || p.definitions === null)
    ? normalizeDefinitions(STORYMAPPER_DEFAULT_DEFINITIONS)
    : normalizeDefinitions(p.definitions);
  // Workflow: project.workflow überschreibt; sonst Default-Workflow.
  const wf = normalizeWorkflow(p.workflow);
  const workflow = (wf && wf.statuses.length > 0)
    ? wf
    : normalizeWorkflow(STORYMAPPER_DEFAULT_WORKFLOW);
  const out = {
    id: typeof p.id === "string" ? p.id : uid("p-"),
    name: typeof p.name === "string" ? p.name : "",
    description: typeof p.description === "string" ? p.description : "",
    ticketPrefix: typeof p.ticketPrefix === "string" && p.ticketPrefix.length > 0 ? p.ticketPrefix : "P",
    ticketCounter: typeof p.ticketCounter === "number" ? p.ticketCounter : 0,
    definitions: definitions,
    workflow: workflow,
    boards: normalizeProjectBoards(p.boards, workflow.statuses),
    ticketTypes: ticketTypes,
    entityTypeConfig: normalizeEntityTypeConfig(p.entityTypeConfig),
    // SM-45: project.linkTypes — seeded with defaults if empty so new
    // projects come with a workable catalogue. Custom lists completely
    // replace the defaults (no merge — explicit project-owner control).
    linkTypes: _ensureContainsLinkType(
      (Array.isArray(p.linkTypes) && p.linkTypes.length > 0)
        ? p.linkTypes.map(normalizeLinkType)
        : STORYMAPPER_DEFAULT_LINK_TYPES.map(normalizeLinkType)
    ),
    labels: Array.isArray(p.labels) ? p.labels.map(normalizeLabel) : [],
    // SM-93 — Governance config (predicates + messages + tool_actions).
    // Seeded with STORYMAPPER_DEFAULT_GOVERNANCE if missing/incomplete so
    // every project gets a workable gate-set out of the box. Per-project
    // overrides supported via updateProject({governance: ...}).
    governance: normalizeGovernance(p.governance),
    isDeleted: p.isDeleted === true,
    deletedAt: typeof p.deletedAt === "number" ? p.deletedAt : null,
    deletedBy: isObject(p.deletedBy) ? normalizeActor(p.deletedBy) : null,
    createdAt: typeof p.createdAt === "number" ? p.createdAt : now(),
    createdBy: isObject(p.createdBy) ? normalizeActor(p.createdBy) : { type: "human", id: "unknown", name: "Unknown" },
    updatedAt: typeof p.updatedAt === "number" ? p.updatedAt : (typeof p.createdAt === "number" ? p.createdAt : now()),
    updatedBy: isObject(p.updatedBy) ? normalizeActor(p.updatedBy) : (isObject(p.createdBy) ? normalizeActor(p.createdBy) : { type: "human", id: "unknown", name: "Unknown" }),
    version: typeof p.version === "number" ? p.version : 1
  };
  return out;
}

function normalizePosition(pos) {
  pos = pos || {};
  return {
    releaseId: typeof pos.releaseId === "string" ? pos.releaseId : null,
    epicId: typeof pos.epicId === "string" ? pos.epicId : null,
    processStepId: typeof pos.processStepId === "string" ? pos.processStepId : null,
    sortOrder: typeof pos.sortOrder === "number" ? pos.sortOrder : 0
  };
}

function normalizeAcceptanceCriterion(ac) {
  return {
    id: typeof ac.id === "string" ? ac.id : uid("ac-"),
    text: typeof ac.text === "string" ? ac.text : "",
    completed: ac.completed === true
  };
}

function normalizeComment(c) {
  return {
    id: typeof c.id === "string" ? c.id : uid("c-"),
    body: typeof c.body === "string" ? c.body : "",
    actor: isObject(c.actor) ? normalizeActor(c.actor) : { type: "human", id: "unknown", name: "Unknown" },
    timestamp: typeof c.timestamp === "number" ? c.timestamp : now()
  };
}

// SM-45: link-type semantics. The semantic determines runtime behaviour
// (cycle-check, inverse-display, status-hooks). Hardcoded set; per-type
// `linkType.semantic` references one of these names.
//   - precedence:  predecessor/successor (cycle-checked)
//   - blocking:    blocks/blocked-by      (cycle-checked)
//   - sequence:    follows-on/precedes    (no cycle check; linear chain)
//   - containment: contains/contained-by  (cycle-checked)
//   - validation:  tests/tested-by        (no cycle check; cross-domain)
//   - freeform:    relates-to             (symmetric, no cycle check)
//   - supersession: supersedes/replaces (cycle-checked; temporal — A obsoletes
//     B). Drives the cross-release feature fold (SM-180): the superseding epic
//     is the current version, the superseded chain is its history.
const LINK_SEMANTICS = ["precedence", "blocking", "sequence", "containment", "validation", "supersession", "freeform"];
const CYCLE_CHECKED_SEMANTICS = ["precedence", "blocking", "containment", "supersession"];

// SM-45: default link-type catalogue seeded into normalizeProject if the
// project doesn't bring its own. Covers the standard Jira-style relations
// every team needs out of the box. Projects can override the list via
// `project.linkTypes` (full replace, no merge).
const STORYMAPPER_DEFAULT_LINK_TYPES = [
  { id: "predecessor-of", label: "Predecessor of", inverseLabel: "Successor of",  semantic: "precedence" },
  { id: "blocks",         label: "Blocks",         inverseLabel: "Blocked by",    semantic: "blocking"   },
  { id: "follows-on",     label: "Follows on from", inverseLabel: "Precedes",     semantic: "sequence"   },
  { id: "contains",       label: "Contains",       inverseLabel: "Contained by",  semantic: "containment" },
  { id: "relates-to",     label: "Relates to",     inverseLabel: "Relates to",    semantic: "freeform"   },
  // SM-56: test-execution → test-definition. Source = the run, target = the
  // reusable spec. Inverse "Executed by" surfaces all runs on a definition.
  { id: "executes",       label: "Executes",       inverseLabel: "Executed by",   semantic: "validation" },
  // SM-54-followup: test-definition → user-story/bug/task. A test-definition
  // MUST have at least one outbound `tests` link before leaving backlog —
  // enforced in validateStatusTransition.
  { id: "tests",          label: "Tests",          inverseLabel: "Tested by",     semantic: "validation" },
  // SM-94: spec-evolution. `A modifies B` means ticket A is a follow-up
  // change that modifies the spec/behaviour of B. Open modifies-tickets
  // make the target's linked test-definitions show derivedHealth=stale and
  // block complete_ticket (OPEN_MODIFIES gate). cycleCheck=true so we don't
  // accidentally build A→mod→B→mod→A loops.
  { id: "modifies",       label: "Modifies",       inverseLabel: "Modified by",   semantic: "freeform", cycleCheck: true },
  // SM-180: temporal / spec links for PRD-traceability (direction A + the
  // cross-release fold). `A supersedes B` / `A replaces B` → B is the older
  // version; the fold treats the superseding epic as the current feature and
  // folds the superseded chain into its history. refines = adds detail (not
  // obsoletes). realises = a ticket realises a PRD requirement/anchor.
  { id: "supersedes",     label: "Supersedes",     inverseLabel: "Superseded by", semantic: "supersession" },
  { id: "replaces",       label: "Replaces",       inverseLabel: "Replaced by",   semantic: "supersession" },
  { id: "refines",        label: "Refines",        inverseLabel: "Refined by",    semantic: "freeform", cycleCheck: true },
  { id: "realises",       label: "Realises",       inverseLabel: "Realised by",   semantic: "freeform" }
];

// SM-44 backwards-compat: the hardcoded list of link-type IDs that get
// cycle-checked when project.linkTypes is missing or doesn't define them.
// Used as a fallback by validateLink — SM-45's project.linkTypes-derived
// resolution takes precedence when available.
const CYCLE_CHECKED_LINK_TYPES = ["blocks", "predecessor-of", "contains", "supersedes", "replaces", "refines"];

// SM-52: Epic-Story containment is canonical via this linkType. The legacy
// `ticket.position.epicId` field is migrated to a `contains` link in
// normalizeSnapshot; all read/write paths use the link as the source of truth.
const CONTAINS_LINK_TYPE_ID = "contains";

// SM-54-followup: the linkType a test-definition uses to point at the
// ticket(s) it validates ("this test exercises user-story X"). Forward
// transitions out of backlog require ≥1 outbound link of this type — see
// validateStatusTransition.
const TEST_TARGET_LINK_TYPE_ID = "tests";

/**
 * Make sure `contains` is in the project linkType catalogue. The migration
 * pass depends on it being there — if the user customized linkTypes and
 * removed it, we re-add the default. Pure helper, returns a new array.
 */
function _ensureContainsLinkType(linkTypes) {
  const list = Array.isArray(linkTypes) ? linkTypes.slice() : [];
  if (list.some(lt => lt.id === CONTAINS_LINK_TYPE_ID)) return list;
  const def = STORYMAPPER_DEFAULT_LINK_TYPES.find(lt => lt.id === CONTAINS_LINK_TYPE_ID);
  if (def) list.push(normalizeLinkType(def));
  return list;
}

function normalizeLinkType(lt) {
  lt = lt || {};
  const semantic = LINK_SEMANTICS.indexOf(lt.semantic) >= 0 ? lt.semantic : "freeform";
  const out = {
    id: typeof lt.id === "string" && lt.id.length > 0 ? lt.id : "relates-to",
    label: typeof lt.label === "string" && lt.label.length > 0 ? lt.label : lt.id || "Relates to",
    inverseLabel: typeof lt.inverseLabel === "string" && lt.inverseLabel.length > 0 ? lt.inverseLabel : (lt.label || lt.id || "Relates to"),
    semantic: semantic
  };
  if (typeof lt.icon === "string"  && lt.icon.length > 0)  out.icon  = lt.icon;
  if (typeof lt.color === "string" && lt.color.length > 0) out.color = lt.color;
  // SM-94: explicit per-linkType cycle-check opt-in. Overrides semantic
  // resolution — useful for "modifies" which is semantically freeform but
  // still wants the no-cycles guarantee.
  if (lt.cycleCheck === true) out.cycleCheck = true;
  return out;
}

function normalizeLink(l) {
  l = l || {};
  // Accept either the new `linkTypeId` or the legacy `type` field. Default
  // to a freeform "relates-to" so legacy snapshots without a linkTypeId
  // still round-trip cleanly.
  const linkTypeId = typeof l.linkTypeId === "string" ? l.linkTypeId
                   : typeof l.type === "string"       ? l.type
                   : "relates-to";
  const out = {
    id: typeof l.id === "string" ? l.id : uid("ln-"),
    linkTypeId: linkTypeId,
    targetTicketId: typeof l.targetTicketId === "string" ? l.targetTicketId : "",
    createdAt: typeof l.createdAt === "number" ? l.createdAt : now(),
    createdBy: isObject(l.createdBy) ? normalizeActor(l.createdBy) : { type: "human", id: "unknown", name: "Unknown" }
  };
  if (typeof l.label === "string" && l.label.length > 0) out.label = l.label;
  return out;
}

// SM-53: test-definition step shape. Pure data — UI lives elsewhere.
//   { id, step: string, data?: string, expectedResult: string }
function normalizeTestStep(s) {
  s = s || {};
  return {
    id:             typeof s.id === "string" ? s.id : uid("tstep-"),
    step:           typeof s.step === "string" ? s.step : "",
    data:           typeof s.data === "string" ? s.data : "",
    expectedResult: typeof s.expectedResult === "string" ? s.expectedResult : ""
  };
}

// SM-53: prerequisites mirror the DoR checklist shape (id/label/required/checked)
// so the same inline-toggle UI can render them. Same idempotent normalizer
// pattern as normalizeAcceptanceCriterion.
function normalizeTestPrerequisite(p) {
  p = p || {};
  return {
    id:       typeof p.id === "string" ? p.id : uid("tpre-"),
    label:    typeof p.label === "string" ? p.label : "",
    required: p.required !== false,
    checked:  p.checked === true
  };
}

// SM-56: a single executed step — the static fields are cloned from the
// definition at run-start; actualResult/status/note are filled during the run.
// status ∈ pending|passed|failed|blocked|skipped.
const TEST_EXEC_STEP_STATUSES = ["pending", "passed", "failed", "blocked", "skipped"];
function normalizeTestExecStep(s) {
  s = s || {};
  const status = TEST_EXEC_STEP_STATUSES.indexOf(s.status) >= 0 ? s.status : "pending";
  const out = {
    id:             typeof s.id === "string" ? s.id : uid("xstep-"),
    stepId:         typeof s.stepId === "string" ? s.stepId : "",
    step:           typeof s.step === "string" ? s.step : "",
    data:           typeof s.data === "string" ? s.data : "",
    expectedResult: typeof s.expectedResult === "string" ? s.expectedResult : "",
    actualResult:   typeof s.actualResult === "string" ? s.actualResult : "",
    status:         status
  };
  if (typeof s.note === "string" && s.note.length > 0) out.note = s.note;
  return out;
}

// SM-56: outcome enum — same five values as step.status but at the
// execution-ticket level. getEffectiveOutcome returns the manual override
// when set, else the derived value.
const TEST_EXEC_OUTCOMES = ["pending", "passed", "failed", "blocked", "skipped"];

/**
 * Derive the test-execution outcome from its steps:
 *   - any failed → "failed"
 *   - any blocked (and no failed) → "blocked"
 *   - all passed → "passed"
 *   - otherwise → "pending" (includes the empty-steps case)
 *
 * Pure helper, exported so MCP tools and the UI can call the same logic.
 */
function deriveOutcome(executionSteps) {
  if (!Array.isArray(executionSteps) || executionSteps.length === 0) return "pending";
  let allPassed = true;
  let anyBlocked = false;
  for (const s of executionSteps) {
    if (!s || typeof s.status !== "string") { allPassed = false; continue; }
    if (s.status === "failed")  return "failed";
    if (s.status === "blocked") anyBlocked = true;
    if (s.status !== "passed")  allPassed = false;
  }
  if (anyBlocked) return "blocked";
  return allPassed ? "passed" : "pending";
}

/** Manual outcomeOverride wins; otherwise the derived value. */
function getEffectiveOutcome(ticket) {
  if (!ticket) return "pending";
  if (typeof ticket.outcomeOverride === "string"
      && TEST_EXEC_OUTCOMES.indexOf(ticket.outcomeOverride) >= 0) {
    return ticket.outcomeOverride;
  }
  return deriveOutcome(ticket.executionSteps || []);
}

/**
 * SM-57-followup: keep a test-execution's status in sync with its outcome.
 *   - Outcome != "pending"  → status should be "done" (test produced a result).
 *   - Outcome == "pending"  → status should be "in-progress" (test still running).
 *
 * Only fires the auto-transition when the current status is one of the two
 * states this coupling owns — `in-progress` (forward) or `done` (revert).
 * Manual states like `backlog` / `ready` / `review` are left alone so a user
 * who deliberately parked a test-execution doesn't get steamrolled.
 *
 * Pure — mutates `exec` in place; caller decides whether to bumpAudit.
 */
function _syncExecStatusToOutcome(exec) {
  if (!exec || exec.type !== "test-execution") return false;
  const outcome = getEffectiveOutcome(exec);
  // SM-170: route through _setTicketStatus so the aging clock resets when the
  // outcome flip actually re-opens / closes the run (not a bare assignment).
  if (outcome !== "pending" && exec.status === "in-progress") {
    _setTicketStatus(exec, "done");
    return true;
  }
  if (outcome === "pending" && exec.status === "done") {
    _setTicketStatus(exec, "in-progress");
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// SM-93 — Spec-Evolution Governance (Predicate-Library + Evaluator +
// Template-Renderer + DEFAULT_GOVERNANCE). Pure, no I/O. The MCP wiring
// (SM-94) consumes these to gate tools and surface clear errors.
// ---------------------------------------------------------------------------

const TEST_DEFINITION_LIFECYCLES = ["draft", "published"];
const TEST_DEFINITION_HEALTH_STATES = ["unused", "passing", "failing", "stale", "orphaned"];

const STORYMAPPER_DEFAULT_GOVERNANCE = {
  gates: {
    TARGET_NOT_READY: { predicate: "linked_target_status",
      args: { linkTypeId: "tests", minStatus: "ready" } },
    MISSING_TESTS_LINK: { predicate: "outgoing_link",
      args: { linkTypeId: "tests", minCount: 1 } },
    MISSING_STEPS: { predicate: "ticket_field",
      args: { field: "steps", check: "non_empty" } },
    EMPTY_EXPECTED: { predicate: "for_each_step",
      args: { field: "expectedResult", check: "non_empty" } },
    STALE_LINKED_DEF: { predicate: "linked_definitions_health",
      args: { allowed: ["passing", "unused"] } },
    OPEN_MODIFIES: { predicate: "incoming_modifies_open", args: {} },
    // SM-299: no done without a test plan. A user-story/bug must have a
    // PUBLISHED test-definition linked via `tests` before it can complete.
    // Hard-gate, plan-only (a passing execution is NOT required — that would
    // be a stricter variant; `allowed`/exec health stays with STALE_LINKED_DEF).
    MISSING_TEST_DEFINITION: {
      predicate: "incoming_link",
      args: { linkTypeId: "tests", sourceType: "test-definition", sourceLifecycle: "published", minCount: 1 },
      appliesToTypes: ["user-story", "bug"]
    }
  },
  messages: {
    TARGET_NOT_READY: {
      title: "Target ticket is not ready",
      reason: "Definition's target {targetKey} is in status={targetStatus}. Tests can only be published once their target reaches '{minStatus}'+.",
      suggestion: "Promote {targetKey} to ready first (mark_ready). Once AC are frozen, retry publish_test_definition on {definitionKey}.",
      skillRef: "Test-Definitions require their target to be in ready+. Specs must be frozen before tests are derived."
    },
    MISSING_TESTS_LINK: {
      title: "Definition has no target",
      reason: "Definition {definitionKey} has no outgoing 'tests'-link.",
      suggestion: "Add a 'tests'-link via link_create pointing at the feature/bug to be validated, then retry publish_test_definition.",
      skillRef: "A test-definition without a target is orphaned. Every definition tests a specific feature."
    },
    MISSING_STEPS: {
      title: "Definition has no steps",
      reason: "Definition {definitionKey} has 0 steps.",
      suggestion: "Add at least one step via test_def_step_add (each step needs a non-empty expectedResult), then retry publish_test_definition.",
      skillRef: "A test-definition needs steps with expectedResult — that's the spec being tested."
    },
    EMPTY_EXPECTED: {
      title: "Step has empty expectedResult",
      reason: "At least one step in {definitionKey} has an empty expectedResult.",
      suggestion: "Fill in the expectedResult for every step via test_def_step_update, then retry publish_test_definition.",
      skillRef: "Each step's expectedResult defines pass-criteria — empty makes the step un-verifiable."
    },
    STALE_LINKED_DEF: {
      title: "Linked test-definition is stale",
      reason: "Definition(s) {staleReasons} block completion of {targetKey}.",
      suggestion: "Resolve the blocking changes first, THEN re-run the affected definition(s) via test_exec_start, THEN retry complete_ticket on {targetKey}.",
      skillRef: "Specs frieren ein. Aenderungen werden zu Tickets. Stale tests block done-transitions."
    },
    OPEN_MODIFIES: {
      title: "Open modification ticket(s) block completion",
      reason: "Open modifies-ticket(s) {modBlockerKeys} point at {targetKey}.",
      suggestion: "Resolve {modBlockerKeys} (move them to done) before completing {targetKey}.",
      skillRef: "An open modifies-link means the spec is mid-change. complete_ticket must wait."
    },
    MISSING_TEST_DEFINITION: {
      title: "No test plan linked",
      reason: "{targetKey} ({targetType}) has no PUBLISHED test-definition linked via 'tests' — a test plan is required before done.",
      suggestion: "1) ticket_create type=test-definition (the test plan). 2) test_def_step_add for each step (with expectedResult). 3) link_create linkTypeId='tests' from the definition to {targetKey}. 4) publish_test_definition (target must be ready+). THEN complete_ticket on {targetKey}.",
      skillRef: "Kein done ohne Testplan: jede user-story/bug braucht eine publizierte, per 'tests'-Link verknuepfte test-definition (SM-299)."
    }
  },
  tool_actions: {
    publish_test_definition: {
      gates: ["MISSING_STEPS", "MISSING_TESTS_LINK", "TARGET_NOT_READY", "EMPTY_EXPECTED"]
    },
    complete_ticket: {
      // SM-299: MISSING_TEST_DEFINITION ordered LAST — when a story ALSO
      // trips STALE_LINKED_DEF/OPEN_MODIFIES, that more-specific gate stays
      // errors[0] (the one surfaced to the caller).
      gates: ["STALE_LINKED_DEF", "OPEN_MODIFIES", "MISSING_TEST_DEFINITION"]
    }
  },
  tool_warnings: {}
};

/**
 * Normalize `project.governance` — accepts caller-supplied overrides, falls
 * back to STORYMAPPER_DEFAULT_GOVERNANCE when the payload is missing or
 * structurally incomplete. Idempotent.
 */
function normalizeGovernance(g) {
  const fallback = STORYMAPPER_DEFAULT_GOVERNANCE;
  if (!isObject(g)) return clone(fallback);
  const out = {
    gates:         (isObject(g.gates))         ? g.gates         : clone(fallback.gates),
    messages:      (isObject(g.messages))      ? g.messages      : clone(fallback.messages),
    tool_actions:  (isObject(g.tool_actions))  ? g.tool_actions  : clone(fallback.tool_actions),
    tool_warnings: (isObject(g.tool_warnings)) ? g.tool_warnings : {}
  };
  return out;
}

// ---- Predicate library (closed set of pure functions) ----------------------
// Each predicate signature: (snapshot, ticket, args) -> { ok: bool, context?: object }.
// `context` is used by the renderer to fill in error messages.

function _matchCheck(value, check) {
  if (typeof check === "string") {
    if (check === "non_empty") {
      if (value == null) return false;
      if (typeof value === "string") return value.length > 0;
      if (Array.isArray(value)) return value.length > 0;
      return true;
    }
  }
  if (isObject(check)) {
    if (check.equals !== undefined) return value === check.equals;
    if (check.gte !== undefined)    return typeof value === "number" && value >= check.gte;
    if (check.lte !== undefined)    return typeof value === "number" && value <= check.lte;
    if (Array.isArray(check.in))    return check.in.indexOf(value) >= 0;
  }
  return false;
}

const GOVERNANCE_PREDICATES = {
  ticket_field(snap, ticket, args) {
    args = args || {};
    if (!ticket || !args.field) return { ok: false, context: { reason: "missing field" } };
    const v = ticket[args.field];
    return _matchCheck(v, args.check)
      ? { ok: true }
      : { ok: false, context: { field: args.field, value: v } };
  },
  outgoing_link(snap, ticket, args) {
    args = args || {};
    const links = (ticket && ticket.links) || [];
    let matching = links.filter(l => l.linkTypeId === args.linkTypeId);
    if (args.targetStatus) {
      matching = matching.filter(l => {
        const tgt = ((snap && snap.tickets) || []).find(t => t.id === l.targetTicketId);
        return tgt && tgt.status === args.targetStatus;
      });
    }
    const minCount = args.minCount || 1;
    return matching.length >= minCount
      ? { ok: true }
      : { ok: false, context: { linkTypeId: args.linkTypeId, count: matching.length, required: minCount } };
  },
  incoming_link(snap, ticket, args) {
    args = args || {};
    if (!ticket || !snap || !snap.tickets) return { ok: false, context: { reason: "no snapshot" } };
    let matching = snap.tickets.filter(t =>
      !t.isDeleted &&   // SM-299: a soft-deleted source cannot satisfy the gate
      (t.links || []).some(l => l.linkTypeId === args.linkTypeId && l.targetTicketId === ticket.id));
    if (args.sourceStatus) matching = matching.filter(t => t.status === args.sourceStatus);
    // SM-299: optional source-ticket filters (a test-plan gate wants an
    // incoming `tests`-link specifically from a PUBLISHED test-definition).
    if (args.sourceType) matching = matching.filter(t => t.type === args.sourceType);
    if (args.sourceLifecycle) matching = matching.filter(t => t.lifecycle === args.sourceLifecycle);
    const minCount = args.minCount || 1;
    return matching.length >= minCount
      ? { ok: true }
      : { ok: false, context: { linkTypeId: args.linkTypeId, count: matching.length, required: minCount } };
  },
  linked_target_status(snap, ticket, args) {
    args = args || {};
    const links = ((ticket && ticket.links) || []).filter(l => l.linkTypeId === args.linkTypeId);
    if (links.length === 0) return { ok: false, context: { reason: "no outgoing " + args.linkTypeId + "-link" } };
    const wf = snap && snap.project && snap.project.workflow;
    const statuses = (wf && Array.isArray(wf.statuses)) ? wf.statuses : [];
    const minIdx = statuses.findIndex(s => s.id === args.minStatus);
    if (minIdx < 0) return { ok: true };  // unknown status floor → can't validate, treat as pass
    for (const l of links) {
      const tgt = ((snap && snap.tickets) || []).find(t => t.id === l.targetTicketId);
      if (!tgt) continue;
      const tgtIdx = statuses.findIndex(s => s.id === tgt.status);
      if (tgtIdx < minIdx) {
        return { ok: false, context: {
          targetKey: tgt.ticketKey, targetStatus: tgt.status, minStatus: args.minStatus
        }};
      }
    }
    return { ok: true };
  },
  linked_definitions_health(snap, ticket, args) {
    args = args || {};
    if (!ticket || !snap || !snap.tickets) return { ok: true };
    const allowed = new Set(args.allowed || ["passing", "unused"]);
    const definitions = snap.tickets.filter(t =>
      t.type === "test-definition" && !t.isDeleted &&
      (t.links || []).some(l => l.linkTypeId === "tests" && l.targetTicketId === ticket.id));
    const offending = definitions.filter(d => !allowed.has(d.derivedHealth || "unused"));
    if (offending.length === 0) return { ok: true };
    const staleReasons = offending.map(d => d.ticketKey + " is " + (d.derivedHealth || "unused")).join("; ");
    return { ok: false, context: {
      stale: offending.map(d => ({ defKey: d.ticketKey, health: d.derivedHealth || "unused" })),
      staleReasons: staleReasons,
      count: offending.length
    }};
  },
  incoming_modifies_open(snap, ticket, args) {
    if (!ticket || !snap || !snap.tickets) return { ok: true };
    const proj = snap.project;
    const openMods = snap.tickets.filter(t =>
      !t.isDeleted && !isTerminalStatus(proj, t.status) &&   // SM-242: cancelled is terminal too
      (t.links || []).some(l => l.linkTypeId === "modifies" && l.targetTicketId === ticket.id));
    if (openMods.length === 0) return { ok: true };
    return { ok: false, context: {
      modBlockerKeys: openMods.map(t => t.ticketKey).join(", "),
      count: openMods.length
    }};
  },
  for_each_step(snap, ticket, args) {
    args = args || {};
    const steps = (ticket && ticket.steps) || [];
    if (steps.length === 0) return { ok: false, context: { reason: "no steps" } };
    for (const s of steps) {
      if (!_matchCheck(s[args.field], args.check)) {
        return { ok: false, context: { field: args.field, stepId: s.id } };
      }
    }
    return { ok: true };
  },
  for_each_prereq(snap, ticket, args) {
    args = args || {};
    const prereqs = (ticket && ticket.prerequisites) || [];
    for (const p of prereqs) {
      if (!_matchCheck(p[args.field], args.check)) {
        return { ok: false, context: { field: args.field, prereqId: p.id } };
      }
    }
    return { ok: true };
  }
};

/**
 * Run all gates configured for a given tool action. Pure — no side effects.
 * Returns `{ ok: true }` when every gate passes, otherwise
 * `{ ok: false, errors: [{kind, predicate, args, context}, ...] }`.
 *
 * Unknown error-kinds (referenced in tool_actions but not defined in
 * governance.gates) are silently skipped — they may be remnants of a stale
 * config; rejecting them outright would brick the project on schema-drift.
 */
function evaluateGates(toolAction, snapshot, ticket, governance) {
  governance = governance || STORYMAPPER_DEFAULT_GOVERNANCE;
  const action = (governance.tool_actions || {})[toolAction];
  if (!action || !Array.isArray(action.gates) || action.gates.length === 0) return { ok: true };
  const errors = [];
  for (const errorKind of action.gates) {
    const gateCfg = (governance.gates || {})[errorKind];
    if (!gateCfg || !gateCfg.predicate) continue;
    // SM-299: per-gate type scoping. An absent/empty appliesToTypes = every
    // type (backward compatible); otherwise the gate only evaluates for the
    // listed ticket types (e.g. MISSING_TEST_DEFINITION → user-story + bug).
    if (Array.isArray(gateCfg.appliesToTypes) && gateCfg.appliesToTypes.length > 0
        && (!ticket || gateCfg.appliesToTypes.indexOf(ticket.type) < 0)) continue;
    const pred = GOVERNANCE_PREDICATES[gateCfg.predicate];
    if (!pred) {
      errors.push({ kind: errorKind, predicate: gateCfg.predicate,
        args: gateCfg.args || {}, context: { error: "unknown predicate" } });
      continue;
    }
    const result = pred(snapshot, ticket, gateCfg.args || {});
    if (!result.ok) {
      errors.push({ kind: errorKind, predicate: gateCfg.predicate,
        args: gateCfg.args || {}, context: result.context || {} });
    }
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors: errors };
}

/**
 * Same shape as evaluateGates but for soft warnings — never blocks. Reads
 * governance.tool_warnings[toolAction].gates. Always returns
 * `{ warnings: [...] }` (possibly empty).
 */
function evaluateWarnings(toolAction, snapshot, ticket, governance) {
  governance = governance || STORYMAPPER_DEFAULT_GOVERNANCE;
  const action = (governance.tool_warnings || {})[toolAction];
  if (!action || !Array.isArray(action.gates) || action.gates.length === 0) return { warnings: [] };
  const warnings = [];
  for (const errorKind of action.gates) {
    const gateCfg = (governance.gates || {})[errorKind];
    if (!gateCfg || !gateCfg.predicate) continue;
    if (Array.isArray(gateCfg.appliesToTypes) && gateCfg.appliesToTypes.length > 0   // SM-299
        && (!ticket || gateCfg.appliesToTypes.indexOf(ticket.type) < 0)) continue;
    const pred = GOVERNANCE_PREDICATES[gateCfg.predicate];
    if (!pred) continue;
    const result = pred(snapshot, ticket, gateCfg.args || {});
    if (!result.ok) {
      warnings.push({ kind: errorKind, predicate: gateCfg.predicate,
        args: gateCfg.args || {}, context: result.context || {} });
    }
  }
  return { warnings: warnings };
}

// ---- Template-Renderer ----------------------------------------------------
// Minimal-deps templater for governance.messages. Supports:
//   {var}                — interpolate context[var]
//   {var | format}       — apply formatter (shortdate, join, ticketKeyList, statusName)
//   {#count > N}...{/count}  — conditional based on context.count

function _formatShortDate(v) {
  const d = (typeof v === "number") ? new Date(v) : new Date(String(v));
  if (isNaN(d.getTime())) return String(v);
  return d.toISOString().slice(0, 10);
}

function _interpolate(str, ctx) {
  if (typeof str !== "string") return "";
  ctx = ctx || {};
  // Step 1: pluralization conditionals.
  str = str.replace(/\{#count\s*>\s*(\d+)\}([\s\S]*?)\{\/count\}/g, (_m, n, content) =>
    (Number(ctx.count) || 0) > Number(n) ? content : "");
  // Step 2: variable interpolation, optional pipe-format.
  return str.replace(/\{(\w+)(?:\s*\|\s*(\w+))?\}/g, (_m, name, fmt) => {
    const val = ctx[name];
    if (val === undefined || val === null) return "";
    if (fmt === "join")          return Array.isArray(val) ? val.join(", ") : String(val);
    if (fmt === "shortdate")     return _formatShortDate(val);
    if (fmt === "ticketKeyList") return Array.isArray(val) ? val.join(", ") : String(val);
    if (fmt === "statusName")    return String(val);
    return String(val);
  });
}

/**
 * Render a message-template (one of governance.messages[errorKind]) with the
 * provided context. Returns `{title, reason, suggestion, skillRef}` — every
 * field is always a string (empty when the template field is missing).
 */
function renderMessage(template, context) {
  template = template || {};
  return {
    title:      _interpolate(template.title || "", context),
    reason:     _interpolate(template.reason || "", context),
    suggestion: _interpolate(template.suggestion || "", context),
    skillRef:   _interpolate(template.skillRef || "", context)
  };
}

// ---- derivedHealth for test-definition tickets ----------------------------
// Computed at snapshot-load time (post-pass in normalizeSnapshot). Not
// persisted on the ticket — pure derivation from the link graph + execution
// history. Five states:
//   unused    — no execution yet
//   passing   — latest execution passed, no spec change since
//   failing   — latest execution failed or blocked
//   stale     — latest run was green but definition/target updated since
//   orphaned  — every linked target is soft-deleted or missing

function computeDerivedHealth(snap, td) {
  if (!td || td.type !== "test-definition") return "";
  const tickets = (snap && snap.tickets) || [];
  const targetLinks = (td.links || []).filter(l => l.linkTypeId === "tests");
  // Resolve targets — only non-deleted, existing tickets count as "live".
  let liveTargets = 0;
  let liveTargetMaxUpdatedAt = 0;
  let anyTargetLink = targetLinks.length > 0;
  for (const l of targetLinks) {
    const tgt = tickets.find(t => t.id === l.targetTicketId);
    if (!tgt || tgt.isDeleted) continue;
    liveTargets++;
    if ((tgt.updatedAt || 0) > liveTargetMaxUpdatedAt) liveTargetMaxUpdatedAt = (tgt.updatedAt || 0);
  }
  if (anyTargetLink && liveTargets === 0) return "orphaned";

  const executions = tickets.filter(t =>
    t.type === "test-execution" && !t.isDeleted && t.referencedTestDefinitionId === td.id);
  if (executions.length === 0) return "unused";
  const latest = executions.slice().sort((a, b) => (b.runAt || 0) - (a.runAt || 0))[0];
  const outcome = getEffectiveOutcome(latest);
  if (outcome === "failed" || outcome === "blocked") return "failing";
  if (outcome === "passed") {
    const lastRun = latest.runAt || 0;
    if ((td.updatedAt || 0) > lastRun) return "stale";
    if (liveTargetMaxUpdatedAt > lastRun) return "stale";
    return "passing";
  }
  // pending / skipped — no green run on record, treat as unused-equivalent.
  return "unused";
}

function _annotateDerivedHealth(snap) {
  const tickets = (snap && snap.tickets) || [];
  for (const td of tickets) {
    if (td.type !== "test-definition") continue;
    td.derivedHealth = computeDerivedHealth(snap, td);
  }
}

// ---------------------------------------------------------------------------

// SM-196 R-1: a requirement's back-reference into its source PRD. Points at
// the project attachment + (once the Markdown pre-slicer runs, R-3/R-4) the
// section id and char span that produced this slice — the anchor that powers
// the reconciliation UI (R-7). Tolerates partial/missing input; null when no
// anchor is set (the common case until a slice is imported).
function normalizeSourceAnchor(a) {
  if (!isObject(a)) return null;
  return {
    attachmentId: typeof a.attachmentId === "string" ? a.attachmentId : "",
    sectionId:    typeof a.sectionId === "string" ? a.sectionId : "",
    charStart:    typeof a.charStart === "number" ? a.charStart : null,
    charEnd:      typeof a.charEnd === "number" ? a.charEnd : null
  };
}

function normalizeTicket(t) {
  t = t || {};
  const createdBy = isObject(t.createdBy) ? normalizeActor(t.createdBy) : { type: "human", id: "unknown", name: "Unknown" };
  const createdAt = typeof t.createdAt === "number" ? t.createdAt : now();
  const type = typeof t.type === "string" ? t.type : "user-story";

  // SM-196 R-1: spec-layer fields. `sectionPath` is the DOORS-style object
  // identifier ("2.1") that orders requirements within their spec module;
  // `sourceAnchor` points back to the source PRD section. Gated to the
  // requirement type so every other ticket keeps a uniform empty shape.
  const sectionPath  = (type === "requirement" && typeof t.sectionPath === "string") ? t.sectionPath : "";
  const sourceAnchor = (type === "requirement") ? normalizeSourceAnchor(t.sourceAnchor) : null;
  // SM-196 R-2: a spec-module is bound to exactly one source attachment (the
  // PRD it slices). Gated to the spec-module type; "" otherwise.
  const sourceAttachmentId = (type === "spec-module" && typeof t.sourceAttachmentId === "string") ? t.sourceAttachmentId : "";

  // SM-53 / SM-56 — type-specific test fields. Stored on every ticket but
  // only populated for the matching type; non-test tickets carry empty
  // arrays so the JSON shape stays uniform (cheap, simplifies all readers).
  const prerequisites = (type === "test-definition" && Array.isArray(t.prerequisites))
    ? t.prerequisites.map(normalizeTestPrerequisite) : [];
  const steps         = (type === "test-definition" && Array.isArray(t.steps))
    ? t.steps.map(normalizeTestStep) : [];
  const executionSteps = (type === "test-execution" && Array.isArray(t.executionSteps))
    ? t.executionSteps.map(normalizeTestExecStep) : [];
  const refDefId = (type === "test-execution" && typeof t.referencedTestDefinitionId === "string")
    ? t.referencedTestDefinitionId : "";
  const runAt = (type === "test-execution" && typeof t.runAt === "number") ? t.runAt : null;
  const runBy = (type === "test-execution" && isObject(t.runBy)) ? normalizeActor(t.runBy) : null;
  const env   = (type === "test-execution" && typeof t.env === "string") ? t.env : "";
  const outcomeOverride = (type === "test-execution"
                           && typeof t.outcomeOverride === "string"
                           && TEST_EXEC_OUTCOMES.indexOf(t.outcomeOverride) >= 0)
    ? t.outcomeOverride : null;

  // SM-93: lifecycle for test-definition only. draft = still being authored,
  // published = locked-in spec runnable via test_exec_start. Default = draft.
  // Other types get a stable "" so the JSON shape stays uniform.
  const lifecycle = (type === "test-definition")
    ? (TEST_DEFINITION_LIFECYCLES.indexOf(t.lifecycle) >= 0 ? t.lifecycle : "draft")
    : "";

  return {
    id: typeof t.id === "string" ? t.id : uid("t-"),
    projectId: typeof t.projectId === "string" ? t.projectId : "",
    type: type,
    ticketKey: typeof t.ticketKey === "string" ? t.ticketKey : "",
    title: typeof t.title === "string" ? t.title : "",
    description: typeof t.description === "string" ? t.description : "",
    status: typeof t.status === "string" ? t.status : "backlog",
    position: normalizePosition(t.position),
    // SM-196 — spec-layer fields (requirement: sectionPath/sourceAnchor;
    // spec-module: sourceAttachmentId). Empty/null on every other type.
    sectionPath:        sectionPath,
    sourceAnchor:       sourceAnchor,
    sourceAttachmentId: sourceAttachmentId,
    definitionOfReady: normalizeChecklist(t.definitionOfReady),
    definitionOfDone: normalizeChecklist(t.definitionOfDone),
    acceptanceCriteria: Array.isArray(t.acceptanceCriteria) ? t.acceptanceCriteria.map(normalizeAcceptanceCriterion) : [],
    comments: Array.isArray(t.comments) ? t.comments.map(normalizeComment) : [],
    labels: Array.isArray(t.labels) ? t.labels.slice() : [],
    links: Array.isArray(t.links) ? t.links.map(normalizeLink) : [],
    // SM-53 / SM-56 — test-type fields.
    prerequisites:               prerequisites,
    steps:                       steps,
    executionSteps:              executionSteps,
    referencedTestDefinitionId:  refDefId,
    runAt:                       runAt,
    runBy:                       runBy,
    env:                         env,
    outcomeOverride:             outcomeOverride,
    // SM-93 — test-definition lifecycle + derived health (the latter gets
    // recomputed in normalizeSnapshot's post-pass, so the per-ticket field
    // here just carries the persisted hint or "" until then).
    lifecycle:                   lifecycle,
    derivedHealth:               typeof t.derivedHealth === "string" ? t.derivedHealth : "",
    isDeleted: t.isDeleted === true,
    deletedAt: typeof t.deletedAt === "number" ? t.deletedAt : null,
    deletedBy: isObject(t.deletedBy) ? normalizeActor(t.deletedBy) : null,
    createdAt: createdAt,
    createdBy: createdBy,
    updatedAt: typeof t.updatedAt === "number" ? t.updatedAt : createdAt,
    updatedBy: isObject(t.updatedBy) ? normalizeActor(t.updatedBy) : createdBy,
    // SM-170 (Card-Aging): when the ticket last ENTERED its current status.
    // Distinct from updatedAt (which bumps on any edit) — this only resets on
    // an actual status transition. Legacy tickets fall back to createdAt.
    statusEnteredAt: typeof t.statusEnteredAt === "number" ? t.statusEnteredAt : createdAt,
    version: typeof t.version === "number" ? t.version : 1
  };
}

function normalizeRelease(r) {
  r = r || {};
  const createdBy = isObject(r.createdBy) ? normalizeActor(r.createdBy) : { type: "human", id: "unknown", name: "Unknown" };
  const createdAt = typeof r.createdAt === "number" ? r.createdAt : now();
  return {
    id: typeof r.id === "string" ? r.id : uid("r-"),
    projectId: typeof r.projectId === "string" ? r.projectId : "",
    name: typeof r.name === "string" ? r.name : "",
    description: typeof r.description === "string" ? r.description : "",
    startDate: typeof r.startDate === "string" || typeof r.startDate === "number" ? r.startDate : null,
    endDate: typeof r.endDate === "string" || typeof r.endDate === "number" ? r.endDate : null,
    status: DEFAULT_RELEASE_STATUSES.indexOf(r.status) >= 0 ? r.status : "planning",
    sortOrder: typeof r.sortOrder === "number" ? r.sortOrder : 0,
    isDeleted: r.isDeleted === true,
    deletedAt: typeof r.deletedAt === "number" ? r.deletedAt : null,
    deletedBy: isObject(r.deletedBy) ? normalizeActor(r.deletedBy) : null,
    createdAt: createdAt,
    createdBy: createdBy,
    updatedAt: typeof r.updatedAt === "number" ? r.updatedAt : createdAt,
    updatedBy: isObject(r.updatedBy) ? normalizeActor(r.updatedBy) : createdBy,
    version: typeof r.version === "number" ? r.version : 1
  };
}

function normalizeProcessStep(s) {
  s = s || {};
  const createdBy = isObject(s.createdBy) ? normalizeActor(s.createdBy) : { type: "human", id: "unknown", name: "Unknown" };
  const createdAt = typeof s.createdAt === "number" ? s.createdAt : now();
  return {
    id: typeof s.id === "string" ? s.id : uid("ps-"),
    projectId: typeof s.projectId === "string" ? s.projectId : "",
    name: typeof s.name === "string" ? s.name : "",
    description: typeof s.description === "string" ? s.description : "",
    epicId: typeof s.epicId === "string" ? s.epicId : null,
    sortOrder: typeof s.sortOrder === "number" ? s.sortOrder : 0,
    isDeleted: s.isDeleted === true,
    deletedAt: typeof s.deletedAt === "number" ? s.deletedAt : null,
    deletedBy: isObject(s.deletedBy) ? normalizeActor(s.deletedBy) : null,
    createdAt: createdAt,
    createdBy: createdBy,
    updatedAt: typeof s.updatedAt === "number" ? s.updatedAt : createdAt,
    updatedBy: isObject(s.updatedBy) ? normalizeActor(s.updatedBy) : createdBy,
    version: typeof s.version === "number" ? s.version : 1
  };
}

function normalizeSnapshot(snap) {
  snap = snap || {};
  const out = {
    version: SCHEMA_VERSION,
    project: normalizeProject(snap.project),
    tickets: Array.isArray(snap.tickets) ? snap.tickets.map(normalizeTicket) : [],
    releases: Array.isArray(snap.releases) ? snap.releases.map(normalizeRelease) : [],
    processSteps: Array.isArray(snap.processSteps) ? snap.processSteps.map(normalizeProcessStep) : []
  };
  // SM-44: post-process tickets — drop ticket.links whose targetTicketId no
  // longer exists in the snapshot (stale-target cleanup). This keeps the
  // model self-consistent even after a referenced ticket is hard-deleted.
  // Soft-deleted (isDeleted=true) tickets STILL count as valid targets so
  // restoring them preserves their links.
  const validIds = new Set(out.tickets.map(t => t.id));
  for (const t of out.tickets) {
    if (t.links && t.links.length > 0) {
      t.links = t.links.filter(l => validIds.has(l.targetTicketId));
    }
  }
  // SM-52: migrate legacy ticket.position.epicId → outgoing contains-link
  // from the parent epic. Idempotent: if the link already exists, just
  // clear the legacy field.
  migrateEpicContainsLinks(out);
  // SM-78: defensive cleanup — null any ticket.position.processStepId or
  // releaseId that no longer references a live (non-soft-deleted) entry.
  // Without this, stale positions left over from a deleted PS/Release make
  // the ticket invisible on the Map (no matching cell) while still visible
  // on the Kanban (status-based) — a confusing inconsistency. Runs BEFORE
  // SM-67's sync-pass so that a stale epic position doesn't get cascaded
  // to its contained stories. Idempotent.
  pruneStaleContainerRefs(out);
  // SM-67: sync-pass — any contained story whose releaseId/processStepId
  // diverged from its container epic gets pulled back into alignment.
  // Idempotent: aligned stories are untouched.
  syncContainedStoryPositions(out);
  // SM-236: derive every epic's status from its contained stories. Runs after
  // the contains-link migration + position sync so the children are final.
  // This is the MIGRATION pass for legacy data (epics manually walked to a
  // status that no longer matches their stories) and the safety net behind
  // the per-op recompute calls (the SM-220 invariance test is the
  // completeness check that no mutating op forgets to call it).
  recomputeEpicStatuses(out);
  // SM-93: annotate every test-definition with its derivedHealth, based on
  // the link-graph + execution history. Runs LAST so all link / position /
  // execution data is in its final form.
  _annotateDerivedHealth(out);
  return out;
}

/**
 * SM-78: defensive pass that clears stale ticket.position.processStepId /
 * releaseId references. A reference is "stale" when the target Release /
 * ProcessStep is either hard-removed from the snapshot or soft-deleted
 * (isDeleted=true). Cleared fields land in the Backlog, which is at least
 * VISIBLE — better than the silent disappearance from the Map cells.
 * Idempotent.
 */
function pruneStaleContainerRefs(snap) {
  const tickets = snap.tickets || [];
  if (!tickets.length) return;
  const liveReleaseIds = new Set();
  for (const r of (snap.releases || [])) {
    if (r && r.id && !r.isDeleted) liveReleaseIds.add(r.id);
  }
  const livePsIds = new Set();
  for (const ps of (snap.processSteps || [])) {
    if (ps && ps.id && !ps.isDeleted) livePsIds.add(ps.id);
  }
  for (const t of tickets) {
    const p = t.position;
    if (!p) continue;
    const curRel = p.releaseId || null;
    const curPs  = p.processStepId || null;
    const newRel = (curRel && !liveReleaseIds.has(curRel)) ? null : curRel;
    const newPs  = (curPs  && !livePsIds.has(curPs))       ? null : curPs;
    if (newRel === curRel && newPs === curPs) continue;
    t.position = normalizePosition(Object.assign({}, p, {
      releaseId: newRel,
      processStepId: newPs
    }));
  }
}

/**
 * SM-67: idempotent pass that aligns every contained story's release+
 * processStep to its container epic's. Runs after migration so legacy
 * snapshots with mis-aligned positions get repaired on load.
 */
function syncContainedStoryPositions(snap) {
  const tickets = snap.tickets || [];
  if (!tickets.length) return;
  const byId = new Map(tickets.map(t => [t.id, t]));
  for (const epic of tickets) {
    if (epic.type !== "epic" || epic.isDeleted || !epic.links || !epic.links.length) continue;
    if (!epic.position) continue;
    const epicRel = epic.position.releaseId     || null;
    const epicPs  = epic.position.processStepId || null;
    for (const l of epic.links) {
      const lt = l.linkTypeId || l.type;
      if (lt !== CONTAINS_LINK_TYPE_ID) continue;
      const story = byId.get(l.targetTicketId);
      if (!story || story.isDeleted) continue;
      const sp = story.position || {};
      if ((sp.releaseId || null) === epicRel && (sp.processStepId || null) === epicPs) continue;
      story.position = normalizePosition(Object.assign({}, sp, {
        releaseId: epicRel,
        processStepId: epicPs
      }));
    }
  }
}

// SM-52 helpers ------------------------------------------------------------

/**
 * Migrate every ticket carrying a non-null `position.epicId` to the canonical
 * representation: an outgoing `contains` link from the epic, with the legacy
 * field cleared. Idempotent — running multiple times on an already-migrated
 * snapshot is a no-op (the link check prevents duplicates).
 */
function migrateEpicContainsLinks(snap) {
  const tickets = snap.tickets || [];
  if (!tickets.length) return;
  const byId = new Map(tickets.map(t => [t.id, t]));
  for (const t of tickets) {
    const epicId = t.position && t.position.epicId;
    if (!epicId) continue;
    const epic = byId.get(epicId);
    if (epic && epic.id !== t.id && epic.type === "epic") {
      _ensureContainsLink(snap, epic.id, t.id, t.createdBy);
    }
    // Always clear — the link is canonical; if the epic doesn't exist
    // anymore we drop the legacy pointer silently.
    t.position = Object.assign({}, t.position, { epicId: null });
  }
}

/**
 * Ensure that `epicId` has an outgoing `contains` link to `targetId`. No-op
 * if the link already exists. Returns true if added, false if pre-existing.
 */
function _ensureContainsLink(snap, epicId, targetId, actor) {
  if (!epicId || !targetId || epicId === targetId) return false;
  // Read first (cheap), COW only when we actually add the link (SM-240).
  const probe = (snap.tickets || []).find(t => t.id === epicId);
  if (!probe) return false;
  for (const l of (probe.links || [])) {
    const lt = l.linkTypeId || l.type;
    if (lt === CONTAINS_LINK_TYPE_ID && l.targetTicketId === targetId) return false;
  }
  const epic = findTicket(snap, epicId);   // COW-aware on cow snapshots
  epic.links = epic.links || [];
  const a = isObject(actor) ? normalizeActor(actor) : { type: "system", id: "sm-52", name: "SM-52 migration" };
  epic.links.push(normalizeLink({
    linkTypeId: CONTAINS_LINK_TYPE_ID,
    targetTicketId: targetId,
    createdBy: a
  }));
  return true;
}

/**
 * Strip any incoming `contains` link to `ticketId`. Used when re-parenting
 * a ticket or removing it from its epic container.
 *
 * SM-166: when `actor` is supplied, every epic that actually loses a link is
 * bumpAudit'd — a containment change is a real edit to that epic and must be
 * versioned + visible (previously it was silent: no version bump on the epic).
 */
function _removeContainsLinksTo(snap, ticketId, actor) {
  // Iterate a snapshot of the array — cowTicket swaps entries in place.
  for (const t of (snap.tickets || []).slice()) {
    if (t.type !== "epic" || !t.links || !t.links.length) continue;
    const hasLink = t.links.some(l => {
      const lt = l.linkTypeId || l.type;
      return lt === CONTAINS_LINK_TYPE_ID && l.targetTicketId === ticketId;
    });
    if (!hasLink) continue;
    const epic = findTicket(snap, t.id);   // COW-aware (SM-240)
    epic.links = epic.links.filter(l => {
      const lt = l.linkTypeId || l.type;
      return !(lt === CONTAINS_LINK_TYPE_ID && l.targetTicketId === ticketId);
    });
    if (actor) bumpAudit(epic, actor);
  }
}

/**
 * Re-parent `ticketId` so its container is `newEpicId` (or none, if null).
 * Strips any existing inbound contains-link first to guarantee uniqueness.
 * SM-166: bumpAudit fires on both the old container (via _removeContainsLinksTo)
 * and the new container (here) so the re-parent is reflected in their versions.
 */
function _setContainerEpic(snap, ticketId, newEpicId, actor) {
  _removeContainsLinksTo(snap, ticketId, actor);
  if (newEpicId) {
    const added = _ensureContainsLink(snap, newEpicId, ticketId, actor);
    if (added && actor) {
      const epic = findTicket(snap, newEpicId);   // COW-aware (SM-240)
      if (epic) bumpAudit(epic, actor);
    }
  }
}

/**
 * Map<storyId, epicId> — which epic currently contains each story (via
 * inbound contains-link). Used by read-side helpers.
 */
function _containerEpicByStoryId(snap) {
  const map = new Map();
  for (const t of (snap.tickets || [])) {
    if (t.type !== "epic" || t.isDeleted) continue;
    if (!t.links || !t.links.length) continue;
    for (const l of t.links) {
      const lt = l.linkTypeId || l.type;
      if (lt === CONTAINS_LINK_TYPE_ID) map.set(l.targetTicketId, t.id);
    }
  }
  return map;
}

/**
 * Public: which epic currently contains the given ticket, via outbound
 * `contains` link? Returns the epic-id or `null`. SM-52: this is the
 * canonical source for the Epic-parent — `ticket.position.epicId` is
 * stripped to null on every write, so do NOT read it for display either.
 *
 * Bug context (SM-77-followup): the Epic-dropdown in the ticket-detail
 * modal used to read `ticket.position.epicId` directly. That value is
 * always null after SM-52, so the dropdown showed "— none —" even when
 * the ticket was contained. Worse, the no-op-save path then persisted
 * the null choice and dropped the contains-link silently. Always use
 * this helper to display + diff the current container.
 */
function containerEpicIdOf(snap, ticketId) {
  if (!snap || !ticketId) return null;
  for (const t of (snap.tickets || [])) {
    if (t.type !== "epic" || t.isDeleted || !t.links) continue;
    for (const l of t.links) {
      const lt = l.linkTypeId || l.type;
      if (lt === CONTAINS_LINK_TYPE_ID && l.targetTicketId === ticketId) return t.id;
    }
  }
  return null;
}

// SM-67 helpers ------------------------------------------------------------

/**
 * SM-67: a contained story inherits its containerEpic's releaseId+processStepId.
 * Given an input position-patch and a target container-epic-id, return a
 * position object where releaseId+processStepId are forced to the epic's
 * values (other fields — sortOrder — kept from input). If the epic doesn't
 * exist or has no position, the input is returned unchanged.
 *
 * Pure: does not mutate `inputPos`.
 */
function _inheritPositionFromEpic(snap, containerEpicId, inputPos) {
  const pos = Object.assign({}, inputPos || {});
  if (!containerEpicId) return pos;
  const epic = (snap.tickets || []).find(t =>
    t.id === containerEpicId && t.type === "epic" && !t.isDeleted);
  if (!epic || !epic.position) return pos;
  pos.releaseId     = epic.position.releaseId     || null;
  pos.processStepId = epic.position.processStepId || null;
  return pos;
}

/**
 * SM-67: when an epic's release/processStep changes, every story contained
 * via `contains` link cascades to the new position (release+processStep
 * only; sortOrder is preserved per story). bumpAudit fires for each
 * touched story so the audit trail reflects the cascade.
 */
function _cascadeEpicPositionToContainedStories(snap, epicId, actor) {
  const epic = (snap.tickets || []).find(t =>
    t.id === epicId && t.type === "epic" && !t.isDeleted);
  if (!epic || !epic.position || !epic.links || !epic.links.length) return;
  const epicRel = epic.position.releaseId     || null;
  const epicPs  = epic.position.processStepId || null;
  for (const l of epic.links) {
    const lt = l.linkTypeId || l.type;
    if (lt !== CONTAINS_LINK_TYPE_ID) continue;
    const probe = (snap.tickets || []).find(t => t.id === l.targetTicketId);
    if (!probe || probe.isDeleted) continue;
    const sp = probe.position || {};
    if ((sp.releaseId || null) === epicRel && (sp.processStepId || null) === epicPs) continue;
    const story = findTicket(snap, probe.id);   // COW-aware (SM-240)
    story.position = normalizePosition(Object.assign({}, story.position || {}, {
      releaseId: epicRel,
      processStepId: epicPs
    }));
    bumpAudit(story, actor);
  }
}

// ---------------------------------------------------------------------------
// resolveDefinitions + buildTicketChecklists
// ---------------------------------------------------------------------------

function resolveBlock(block, ticketType) {
  block = block || { global: [], byType: {} };
  const byType = (block.byType && block.byType[ticketType]) || null;
  if (byType && Array.isArray(byType.overridden)) {
    return byType.overridden.map(it => Object.assign({}, it));
  }
  const list = (block.global || []).map(it => Object.assign({}, it));
  if (byType && Array.isArray(byType.appended)) {
    for (const it of byType.appended) list.push(Object.assign({}, it));
  }
  return list;
}

function resolveDefinitions(definitions, ticketType) {
  const defs = normalizeDefinitions(definitions);
  return {
    ready: resolveBlock(defs.ready, ticketType),
    done: resolveBlock(defs.done, ticketType)
  };
}

function freezeChecklist(items) {
  return {
    items: items.map(it => ({
      id: it.id,
      label: it.label,
      required: it.required !== false,
      checked: false,
      checkedAt: null,
      checkedBy: null
    }))
  };
}

function buildTicketChecklists(project, ticketPartial) {
  const resolved = resolveDefinitions(project.definitions, (ticketPartial && ticketPartial.type) || "user-story");
  return {
    definitionOfReady: freezeChecklist(resolved.ready),
    definitionOfDone: freezeChecklist(resolved.done)
  };
}

// ---------------------------------------------------------------------------
// ops — pure (snapshot, args, actor) → newSnapshot
// ---------------------------------------------------------------------------

function bumpAudit(entity, actor) {
  const a = normalizeActor(actor);
  entity.updatedAt = now();
  entity.updatedBy = a;
  entity.version = (entity.version || 1) + 1;
}

// SM-170 (Card-Aging): set a ticket's status, resetting `statusEnteredAt` ONLY
// when the status actually changes. A no-op transition (same status) keeps the
// original entry time, so re-saving a ticket doesn't reset its aging clock.
function _setTicketStatus(t, newStatus) {
  if (t.status !== newStatus) t.statusEnteredAt = now();
  t.status = newStatus;
}

// SM-240: ops resolve their mutation target through findTicket. On a COW
// snapshot (cowSnap output) this returns the PRIVATE clone of the ticket —
// the one central seam that converts nearly every op to copy-on-write. On a
// plain snapshot (read paths, normalize) it behaves exactly as before.
function findTicket(snap, ticketId) {
  if (snap && snap.__cowFresh) return cowTicket(snap, ticketId) || undefined;
  return snap.tickets.find(t => t.id === ticketId);
}

// SM-111 (A2): a PUBLISHED test-definition's spec is frozen. Structural
// spec edits (steps add/update/remove/reorder, prerequisites add/update/
// remove) throw DEFINITION_FROZEN so neither REST nor MCP can mutate a
// locked spec out from under the executions cloned from it. Runtime state
// toggles (prereq check/uncheck) are intentionally NOT frozen — they don't
// change the spec. Drafts (lifecycle !== "published") edit freely.
function assertSpecEditable(ticket) {
  if (ticket && ticket.type === "test-definition" && ticket.lifecycle === "published") {
    const e = new Error("test-definition spec is frozen (published): " + (ticket.ticketKey || ticket.id));
    e.statusCode = 409;
    e.kind = "DEFINITION_FROZEN";
    throw e;
  }
}

// ---------------------------------------------------------------------------
// SM-236 — Epic status is DERIVED (roll-up) from the categories of the epic's
// contained board-work-item children. It is NEVER set manually (SM-237 locks
// the manual paths). Pure + deterministic: aggregates over the project
// workflow's status CATEGORIES (todo/doing/blocked/done) so custom workflows
// work without hard-coded status ids.
// ---------------------------------------------------------------------------

// Build id → category lookup across the base workflow AND every per-type
// workflow status list, so a child carrying a per-type status still resolves.
// Ids absent from the workflow fall back to the kebab-id heuristic.
function _statusCategoryLookup(project) {
  const map = new Map();
  const add = (list) => {
    for (const s of (list || [])) {
      const n = normalizeStatusItem(s);
      if (n && !map.has(n.id)) map.set(n.id, n.category);
    }
  };
  const wf = (project && project.workflow) || STORYMAPPER_DEFAULT_WORKFLOW;
  add(wf.statuses && wf.statuses.length ? wf.statuses : STORYMAPPER_DEFAULT_WORKFLOW.statuses);
  if (wf.byType) for (const k of Object.keys(wf.byType)) add(wf.byType[k] && wf.byType[k].statuses);
  return (id) => (map.has(id) ? map.get(id) : defaultCategoryForStatusId(id));
}

// SM-242: the first status id of a given category in the project's base
// workflow (used by cancelTicket to resolve the cancelled-category status).
function firstStatusOfCategory(project, category) {
  const wf = getWorkflowForType(project, null);
  const statuses = (wf.statuses && wf.statuses.length) ? wf.statuses : STORYMAPPER_DEFAULT_WORKFLOW.statuses;
  const s = statuses.find(x => normalizeStatusItem(x).category === category);
  return s ? (typeof s === "string" ? s : s.id) : null;
}

// SM-242: category of a status id (custom-workflow-safe, heuristic fallback).
function statusCategoryOf(project, statusId) {
  return _statusCategoryLookup(project)(statusId);
}

// SM-242: a status is TERMINAL when its category is done OR cancelled — i.e. the
// work item is closed (successfully or deliberately dropped). Replaces hardcoded
// `status === "done"` checks so cancelled items don't count as open.
function isTerminalStatus(project, statusId) {
  const c = statusCategoryOf(project, statusId);
  return c === "done" || c === "cancelled";
}

// Counts of contained board-work-item children by aggregated category.
// blocked is folded into "doing" (work is underway, just stuck).
// NOTE (by design, SM-236): children resolve via `storiesInEpic`, which counts
// only board-work-items — nested epics and spec types do NOT count. The model
// is 3-level (Cell → Epic → Story); an epic that contains ONLY sub-epics has
// total=0 and therefore derives to the first todo status (backlog). Epic-of-
// epics roll-up is intentionally unsupported.
function epicChildStats(snap, epicId) {
  const children = tickets.storiesInEpic(snap || { tickets: [] }, epicId);
  const catOf = _statusCategoryLookup(snap && snap.project);
  let done = 0, doing = 0, todo = 0, cancelled = 0;
  for (const c of children) {
    const cat = catOf(c.status);
    if (cat === "done") done++;
    else if (cat === "cancelled") cancelled++;   // SM-243: terminal, not open work
    else if (cat === "doing" || cat === "blocked") doing++;
    else todo++;
  }
  return { total: children.length, done, doing, todo, cancelled };
}

// Pure: the status an epic SHOULD have given its children.
//   no children          → first todo status (unstarted plan), UNLESS the epic
//                          was deliberately cancelled (empty-epic cancel, SM-243)
//   all children cancelled         → first cancelled status (SM-243)
//   all terminal, ≥1 done          → first done status (done dominates cancelled)
//   any active doing/blocked/done  → first doing status (work is live)
//   else (all active todo)         → first todo status
// "active" = children NOT in the cancelled category — cancelled is scope
// reduction and never counts as open work. Defensive: when the workflow lacks a
// status of the needed category, the epic's current status is preserved.
function deriveEpicStatus(snap, epicId) {
  const epic = ((snap && snap.tickets) || []).find(t => t && t.id === epicId);
  if (!epic) return null;
  const wf = getWorkflowForType(snap && snap.project, "epic");
  const statuses = (wf.statuses && wf.statuses.length) ? wf.statuses : STORYMAPPER_DEFAULT_WORKFLOW.statuses;
  const firstOf = (cat) => {
    const s = statuses.find(x => normalizeStatusItem(x).category === cat);
    return s ? (typeof s === "string" ? s : s.id) : null;
  };
  const stats = epicChildStats(snap, epicId);
  const active = stats.total - stats.cancelled;   // SM-243: cancelled ≠ open
  let target;
  if (stats.total === 0) {
    // Empty epic: unstarted plan, unless it was deliberately cancelled.
    target = (statusCategoryOf(snap && snap.project, epic.status) === "cancelled")
      ? epic.status : firstOf("todo");
  } else if (active === 0) {
    // every child cancelled → cancelled. NEVER fall back to done here (an
    // all-cancelled epic is not "done"); keep the current status if the
    // workflow can't resolve a cancelled-category status (defensive).
    target = firstOf("cancelled") || epic.status;
  } else if (stats.done === active) {
    target = firstOf("done");                           // all non-cancelled done
  } else if (stats.doing > 0 || stats.done > 0) {
    target = firstOf("doing");
  } else {
    target = firstOf("todo");
  }
  return target || epic.status;
}

// Recompute every (non-deleted) epic's status from its children. Only epics
// whose derived status actually differs are COW-cloned + mutated, so untouched
// epics stay reference-equal (SM-240 structural sharing). Sets ONLY .status —
// the derivation is not an actor action, so it never bumps version/updatedBy/
// statusEnteredAt (keeps normalize-invariance + audit-noise-free). Called at
// the end of every op that can change child status/containment, and as the
// last pass of normalizeSnapshot (migration + safety net).
function recomputeEpicStatuses(s) {
  if (!s || !Array.isArray(s.tickets)) return s;
  for (const t of s.tickets) {
    if (!t || t.isDeleted || t.type !== "epic") continue;
    const derived = deriveEpicStatus(s, t.id);
    if (derived && derived !== t.status) {
      const fresh = cowTicket(s, t.id);
      if (fresh) fresh.status = derived;
    }
  }
  return s;
}

// SM-239 — release progress over its NON-EPIC, non-spec work items (exactly the
// set the Kanban renders, so the count never includes tickets you can't see —
// that was the root of the SM-226 confusion). `done` counts items whose status
// is in the done CATEGORY (custom-workflow-safe, not the hard-coded "done" id).
// Returns { done, total, complete } — complete is false for an empty release.
function releaseProgress(snap, releaseId) {
  const catOf = _statusCategoryLookup(snap && snap.project);
  let total = 0, done = 0;
  for (const t of ((snap && snap.tickets) || [])) {
    if (!t || t.isDeleted || !isBoardWorkItem(t.type)) continue;
    if (!t.position || t.position.releaseId !== releaseId) continue;
    const cat = catOf(t.status);
    if (cat === "cancelled") continue;   // SM-244: cancelled = scope reduction, out of X AND Y
    total++;
    if (cat === "done") done++;
  }
  return { done, total, complete: total > 0 && done === total };
}

const ops = {

  createTicket(snap, partial, actor) {
    const s = cowSnap(snap);
    s.project = normalizeProject(s.project);
    s.project.ticketCounter = (s.project.ticketCounter || 0) + 1;
    const ticketKey = s.project.ticketPrefix + "-" + s.project.ticketCounter;
    const checklists = buildTicketChecklists(s.project, partial);
    const a = normalizeActor(actor);

    // Auto-Epic-Assignment: ein Story-Ticket (kein Epic), das in eine
    // (releaseId, processStepId)-Zelle gelegt wird, die GENAU EIN Epic
    // enthält, bekommt automatisch dieses Epic als Container. Bei 0 oder
    // ≥2 Epics bleibt der Container leer (zu ambig). Explizit gesetzter
    // epicId-Wert im partial wird respektiert. Epics selbst bekommen
    // niemals einen Container.
    // SM-52: containment is expressed as a `contains` link from the epic;
    // position.epicId is the legacy input shape but never persisted.
    // SM-196: a spec object (requirement/spec-module) is never contained by an
    // epic — it lives in a spec module. Block BOTH explicit and inferred epic
    // containment for spec types (defense-in-depth: the MCP surface could
    // otherwise pass a position that triggers the auto-assign below).
    const isSpecNew = isSpecType(partial && partial.type);
    let inferredEpicId = null;
    const inputPos = partial && partial.position;
    const explicitEpicId = (!isSpecNew && inputPos && typeof inputPos.epicId === "string") ? inputPos.epicId : null;
    if (!explicitEpicId && !isSpecNew && partial && partial.type !== "epic"
        && inputPos && inputPos.releaseId && inputPos.processStepId) {
      const candidates = (s.tickets || []).filter(t =>
        !t.isDeleted
        && t.type === "epic"
        && t.position
        && t.position.releaseId === inputPos.releaseId
        && t.position.processStepId === inputPos.processStepId);
      if (candidates.length === 1) inferredEpicId = candidates[0].id;
    }
    const containerEpicId = explicitEpicId || inferredEpicId || null;

    // The merged partial may still carry epicId in its position; we strip it
    // BEFORE normalizeTicket so the persisted shape never holds the legacy
    // pointer (the contains-link gets added at the end).
    let mergedPartial = partial;

    // SM-67: when the new ticket is contained by an epic, its release+
    // processStep are inherited from the epic — not from the input. Apply
    // inheritance to the merged partial's position BEFORE the auto-sortOrder
    // peer filter, so peer grouping matches the values that will actually
    // be persisted.
    if (partial && partial.type !== "epic" && containerEpicId) {
      const inheritedPos = _inheritPositionFromEpic(s,
        containerEpicId, mergedPartial && mergedPartial.position || {});
      mergedPartial = Object.assign({}, mergedPartial, { position: inheritedPos });
    }

    // Auto-sortOrder: neue Tickets landen IMMER am Ende ihrer Peer-Liste,
    // egal ob in einer Cell, unter einem Epic, oder als Orphan im Backlog.
    // SM-52: peers are now grouped by "same release × processStep × container-
    // epic" — and container-epic is read from the contains-link, not from
    // position.epicId. For Orphans the container is null on both sides.
    const containerByStory = _containerEpicByStoryId(s);
    const mergedPos = mergedPartial && mergedPartial.position;
    const hasNoExplicitSort = !mergedPos || typeof mergedPos.sortOrder !== "number" || mergedPos.sortOrder === 0;
    if (hasNoExplicitSort) {
      const peerRel  = (mergedPos && mergedPos.releaseId)     || null;
      const peerPs   = (mergedPos && mergedPos.processStepId) || null;
      const peerEpic = containerEpicId;
      const peers = (s.tickets || []).filter(tk => {
        if (tk.isDeleted) return false;
        const tp = tk.position || {};
        const tkEpic = (tk.type === "epic") ? null : (containerByStory.get(tk.id) || null);
        return (tp.releaseId     || null) === peerRel
            && (tp.processStepId || null) === peerPs
            && tkEpic === peerEpic;
      });
      const maxSort = peers.reduce((m, tk) => Math.max(m, (tk.position && tk.position.sortOrder) || 0), -1);
      mergedPartial = Object.assign({}, mergedPartial, {
        position: Object.assign({}, mergedPos || {}, { sortOrder: maxSort + 1 })
      });
    }

    // Allow the caller (UI / MCP) to override the auto-frozen checklists by
    // passing their own `definitionOfReady`/`definitionOfDone` in the partial.
    // Per-ticket configuration: items can be customized at create time
    // (E19-followup). Missing → fall back to the project-default freeze.
    const explicitDor = mergedPartial && mergedPartial.definitionOfReady;
    const explicitDod = mergedPartial && mergedPartial.definitionOfDone;
    // SM-52: position.epicId is stripped here — never persisted on the ticket.
    // SM-67 inheritance was already applied above (mergedPartial.position
    // carries the epic's release+processStep if there's a container).
    const cleanedPos = Object.assign({}, mergedPartial && mergedPartial.position || {}, { epicId: null });
    const t = normalizeTicket(Object.assign({}, mergedPartial, {
      id: uid("t-"),
      projectId: s.project.id,
      ticketKey: ticketKey,
      position: cleanedPos,
      definitionOfReady: explicitDor ? normalizeChecklist(explicitDor) : checklists.definitionOfReady,
      definitionOfDone:  explicitDod ? normalizeChecklist(explicitDod) : checklists.definitionOfDone,
      createdBy: a,
      updatedBy: a,
      createdAt: now(),
      updatedAt: now(),
      version: 1
    }));
    s.tickets.push(markCowFresh(s, t));
    // SM-52: add the canonical contains-link if the new ticket has a parent epic.
    if (containerEpicId) _setContainerEpic(s, t.id, containerEpicId, a);
    bumpAudit(s.project, actor);
    recomputeEpicStatuses(s);   // SM-236
    return s;
  },

  updateTicket(snap, ticketId, patch, actor) {
    const s = cowSnap(snap);
    let t = findTicket(s, ticketId);
    if (!t) return s;
    // SM-237: an epic's status is derived (roll-up) — reject an explicit
    // status patch rather than silently ignoring it. The check uses the
    // FINAL type (a patch may convert away from epic, which is allowed).
    if (patch && Object.prototype.hasOwnProperty.call(patch, "status")) {
      const finalType = Object.prototype.hasOwnProperty.call(patch, "type") ? patch.type : t.type;
      if (finalType === "epic") {
        const e = new Error("epic status is derived from its contained stories — move the stories instead");
        e.statusCode = 422;
        e.kind = "EPIC_STATUS_DERIVED";
        throw e;
      }
    }
    const allowed = ["title", "description", "type", "status", "position",
      "acceptanceCriteria", "labels", "definitionOfReady", "definitionOfDone",
      // SM-54 — modal patches for test-definition.
      "prerequisites", "steps",
      // SM-57 — modal patches for test-execution.
      "executionSteps", "outcomeOverride", "env",
      // SM-94 — test-definition lifecycle (draft|published). Driven by the
      // publish_test_definition / reopen_test_definition MCP tools.
      "lifecycle"];
    for (const k of allowed) {
      if (Object.prototype.hasOwnProperty.call(patch, k)) {
        if (k === "position") {
          // SM-52: patch.position.epicId means "re-parent to this epic" —
          // never persisted on the ticket itself.
          // SM-166: only an EXPLICIT epicId key re-parents. An absent key means
          // "leave the container as-is", NOT "detach" — otherwise a sortOrder-
          // only position patch would silently strip the inbound contains-link.
          const posHasEpicId = patch.position
            && Object.prototype.hasOwnProperty.call(patch.position, "epicId");
          const newEpicId = posHasEpicId && typeof patch.position.epicId === "string"
            ? patch.position.epicId : null;
          // SM-260: a PARTIAL position patch merges with the current position —
          // an absent key keeps its current value (e.g. `{releaseId}` moves the
          // release only; processStepId + sortOrder survive). An EXPLICIT null
          // still clears a field. (Previously the patch replaced the position
          // wholesale, so a partial patch silently nulled the omitted fields.)
          let cleanedPos = Object.assign({}, t.position || {}, patch.position || {}, { epicId: null });
          // SM-67: contained stories inherit release+processStep from their
          // container. If the patch keeps/sets a container epic, override
          // the position with the epic's values. SM-240 review: when the
          // patch OMITS epicId (SM-166: keep container as-is), the KEPT
          // container must dictate release+processStep too — normalize's
          // syncContainedStoryPositions used to repair this; the op path no
          // longer runs it.
          const keptEpicId = (!posHasEpicId && t.type !== "epic")
            ? containerEpicIdOf(s, ticketId) : null;
          if (t.type !== "epic" && (newEpicId || keptEpicId)) {
            cleanedPos = _inheritPositionFromEpic(s, newEpicId || keptEpicId, cleanedPos);
          }
          t.position = normalizePosition(cleanedPos);
          if (t.type !== "epic" && posHasEpicId) _setContainerEpic(s, ticketId, newEpicId, actor);
          // SM-67: when an epic's position changes, every contained story
          // cascades to the new release+processStep.
          if (t.type === "epic") {
            _cascadeEpicPositionToContainedStories(s, ticketId, actor);
          }
        }
        else if (k === "type") {
          const becameEpic = patch.type === "epic" && t.type !== "epic";
          t.type = patch.type;
          // An epic cannot be contained by another epic — strip any stale
          // inbound contains-link so syncContainedStoryPositions won't later
          // drag the now-epic back to its ex-parent's position. (SM-150)
          if (becameEpic) _removeContainsLinksTo(s, ticketId, actor);
          // SM-240 review: re-gate the type-conditional fields (steps/
          // prerequisites/lifecycle/execution fields) exactly the way
          // normalizeTicket would — the commit path no longer runs the full
          // normalize, so a type change must not leave e.g. test-definition
          // steps on a converted user-story. Swap the re-gated object in.
          const regated = markCowFresh(s, normalizeTicket(t));
          const ti = s.tickets.indexOf(t);
          if (ti >= 0) s.tickets[ti] = regated;
          t = regated;
        }
        else if (k === "acceptanceCriteria" && Array.isArray(patch.acceptanceCriteria)) {
          t.acceptanceCriteria = patch.acceptanceCriteria.map(normalizeAcceptanceCriterion);
        }
        else if (k === "definitionOfReady" || k === "definitionOfDone") {
          t[k] = normalizeChecklist(patch[k]);
        }
        else if (k === "prerequisites" && Array.isArray(patch.prerequisites)) {
          t.prerequisites = patch.prerequisites.map(normalizeTestPrerequisite);
        }
        else if (k === "steps" && Array.isArray(patch.steps)) {
          t.steps = patch.steps.map(normalizeTestStep);
        }
        else if (k === "executionSteps" && Array.isArray(patch.executionSteps)) {
          t.executionSteps = patch.executionSteps.map(normalizeTestExecStep);
          // SM-57-followup: outcome derived from these steps may have
          // flipped — sync status. The exec.outcomeOverride field may
          // still be patched in a later loop iteration; calling sync
          // here covers the executionSteps-only patch path. The override
          // path below calls sync again, idempotent.
          _syncExecStatusToOutcome(t);
        }
        else if (k === "outcomeOverride") {
          if (patch.outcomeOverride == null || patch.outcomeOverride === "auto") {
            t.outcomeOverride = null;
          } else if (TEST_EXEC_OUTCOMES.indexOf(patch.outcomeOverride) >= 0) {
            t.outcomeOverride = patch.outcomeOverride;
          }
          // Invalid values are silently ignored — UI-level validation should
          // prevent this from reaching us; defensive on the data layer.
          // SM-57-followup: outcome flipped — sync status accordingly.
          _syncExecStatusToOutcome(t);
        }
        else if (k === "status") _setTicketStatus(t, patch.status);   // SM-170: aging clock
        // SM-240: object values (labels, …) are cloned — with the full
        // normalize gone from the op path, a shared caller reference would
        // otherwise leak straight into the store.
        else t[k] = (patch[k] && typeof patch[k] === "object") ? clone(patch[k]) : patch[k];
      }
    }
    bumpAudit(t, actor);
    recomputeEpicStatuses(s);   // SM-236 (status/type/containment change may roll up)
    return s;
  },

  softDeleteTicket(snap, ticketId, actor) {
    const s = cowSnap(snap);
    const t = findTicket(s, ticketId);
    if (!t) return s;
    t.isDeleted = true;
    t.deletedAt = now();
    t.deletedBy = normalizeActor(actor);
    bumpAudit(t, actor);
    recomputeEpicStatuses(s);   // SM-236 (a removed child may complete its epic)
    return s;
  },

  changeStatus(snap, ticketId, newStatus, actor) {
    const s = cowSnap(snap);
    const t = findTicket(s, ticketId);
    if (!t) return s;
    // SM-237: an epic's status is derived — reject a manual change at the op
    // layer itself, so the rule is structural (not call-site discipline). The
    // roll-up recompute below mutates ticket.status directly, never via this op.
    if (t.type === "epic") {
      const e = new Error("epic status is derived from its contained stories — move the stories instead");
      e.statusCode = 422;
      e.kind = "EPIC_STATUS_DERIVED";
      throw e;
    }
    _setTicketStatus(t, newStatus);   // SM-170: resets statusEnteredAt on change
    bumpAudit(t, actor);
    recomputeEpicStatuses(s);   // SM-236 (child status change rolls up to its epic)
    return s;
  },

  // SM-242: cancel a ticket WITHOUT any gate check — the documented, explicit
  // way to record a deliberate non-implementation (Cancel ≠ Delete: the ticket
  // stays visible with its history + links). Sets the first cancelled-category
  // status of the project workflow. Epics are rejected here (kind=EPIC_CANCEL —
  // the cascade arrives in SM-243); spec types have their own lifecycle.
  cancelTicket(snap, ticketId, actor) {
    const s = cowSnap(snap);
    const t = findTicket(s, ticketId);
    if (!t) { const e = new Error("ticket not found: " + ticketId); e.statusCode = 404; throw e; }
    if (isSpecType(t.type)) {
      const e = new Error("spec objects have their own lifecycle — cannot be cancelled");
      e.statusCode = 422; e.kind = "SPEC_CANCEL"; throw e;
    }
    const cancelledId = firstStatusOfCategory(s.project, "cancelled");
    if (!cancelledId) {
      const e = new Error("workflow has no cancelled-category status");
      e.statusCode = 422; e.kind = "NO_CANCEL_STATUS"; throw e;
    }
    if (t.type === "epic") {
      // SM-243: cancelling an epic CASCADES — every contained non-terminal
      // story is cancelled in this one snapshot (atomic; the persist layer tags
      // it "epic_cancel"). done/cancelled children are left untouched. The epic
      // status is then DERIVED by the roll-up — EXCEPT an empty epic, which is
      // set directly (the only allowed manual epic-status change, SM-237).
      const children = tickets.storiesInEpic(s, ticketId);
      if (children.length === 0) {
        _setTicketStatus(t, cancelledId);
        bumpAudit(t, actor);
      } else {
        for (const child of children) {
          if (isTerminalStatus(s.project, child.status)) continue;   // skip done + cancelled
          const fresh = cowTicket(s, child.id);
          _setTicketStatus(fresh, cancelledId);
          bumpAudit(fresh, actor);
        }
      }
      recomputeEpicStatuses(s);
      return s;
    }
    _setTicketStatus(t, cancelledId);
    bumpAudit(t, actor);
    recomputeEpicStatuses(s);   // SM-236/243 (a cancelled child rolls up to its epic)
    return s;
  },

  moveTicket(snap, ticketId, position, actor) {
    const s = cowSnap(snap);
    const t = findTicket(s, ticketId);
    if (!t) return s;
    // SM-52: position.epicId in the input is interpreted as a re-parenting
    // request (which epic should contain this ticket). It's translated into
    // contains-link updates and never persisted on the ticket itself.
    const newEpicId = position && typeof position.epicId === "string" ? position.epicId : null;
    let cleanedPos = Object.assign({}, position || {}, { epicId: null });
    // SM-67: contained stories inherit release+processStep from container.
    if (t.type !== "epic" && newEpicId) {
      cleanedPos = _inheritPositionFromEpic(s, newEpicId, cleanedPos);
    }
    t.position = normalizePosition(cleanedPos);
    if (t.type !== "epic") _setContainerEpic(s, ticketId, newEpicId, actor);
    // SM-67: epic move cascades to contained stories.
    if (t.type === "epic") {
      _cascadeEpicPositionToContainedStories(s, ticketId, actor);
    }
    bumpAudit(t, actor);
    recomputeEpicStatuses(s);   // SM-236 (re-parenting changes both epics' children)
    return s;
  },

  addComment(snap, ticketId, comment, actor) {
    const s = cowSnap(snap);
    const t = findTicket(s, ticketId);
    if (!t) return s;
    t.comments.push(normalizeComment(Object.assign({}, comment, {
      actor: normalizeActor(actor),
      timestamp: now()
    })));
    bumpAudit(t, actor);
    return s;
  },

  checkDorItem(snap, ticketId, itemId, actor) {
    const s = cowSnap(snap);
    const t = findTicket(s, ticketId);
    if (!t) return s;
    const item = t.definitionOfReady.items.find(i => i.id === itemId);
    if (!item) return s;
    item.checked = true;
    item.checkedAt = now();
    item.checkedBy = normalizeActor(actor);
    bumpAudit(t, actor);
    return s;
  },

  uncheckDorItem(snap, ticketId, itemId, actor) {
    const s = cowSnap(snap);
    const t = findTicket(s, ticketId);
    if (!t) return s;
    const item = t.definitionOfReady.items.find(i => i.id === itemId);
    if (!item) return s;
    item.checked = false;
    item.checkedAt = null;
    item.checkedBy = null;
    bumpAudit(t, actor);
    return s;
  },

  checkDodItem(snap, ticketId, itemId, actor) {
    const s = cowSnap(snap);
    const t = findTicket(s, ticketId);
    if (!t) return s;
    const item = t.definitionOfDone.items.find(i => i.id === itemId);
    if (!item) return s;
    item.checked = true;
    item.checkedAt = now();
    item.checkedBy = normalizeActor(actor);
    bumpAudit(t, actor);
    return s;
  },

  uncheckDodItem(snap, ticketId, itemId, actor) {
    const s = cowSnap(snap);
    const t = findTicket(s, ticketId);
    if (!t) return s;
    const item = t.definitionOfDone.items.find(i => i.id === itemId);
    if (!item) return s;
    item.checked = false;
    item.checkedAt = null;
    item.checkedBy = null;
    bumpAudit(t, actor);
    return s;
  },

  // ---- SM-58: test-definition step + prereq ops -------------------------
  //
  // These operate on type='test-definition' tickets. Mutations append/edit/
  // delete/reorder the prerequisites or steps arrays in-place. Every op
  // returns a fresh cloned snapshot so the store-wrapper can capture an
  // undoable commit. Throws { statusCode } for not-found.

  // SM-301: derive a test-definition from a story's acceptance criteria —
  // each AC becomes one step (step = the criterion, expectedResult = the
  // criterion as the observable outcome). The plan is a "north star" created
  // at AC-time (draft by default) and refined during implementation; the
  // SM-299 gate then requires it published before done. Returns the snapshot
  // with the new definition appended LAST (createTicket appends) and a
  // `tests`-link from the definition back to the story. Compound but ONE
  // logical op → ONE revision at the surface.
  deriveTestDefinition(snap, ticketId, opts, actor) {
    opts = opts || {};
    const target = findTicket(snap, ticketId);
    if (!target) { const e = new Error("ticket not found: " + ticketId); e.statusCode = 404; throw e; }
    if (target.isDeleted) { const e = new Error("cannot derive from a deleted ticket: " + ticketId); e.statusCode = 404; throw e; }
    // Deriving a test plan FOR a test plan (or an execution) is nonsensical —
    // review finding on f714cfa.
    if (target.type === "test-definition" || target.type === "test-execution") {
      const e = new Error("cannot derive a test-definition from a " + target.type + ": " + ticketId);
      e.statusCode = 400; throw e;
    }
    const acs = (Array.isArray(target.acceptanceCriteria) ? target.acceptanceCriteria : [])
      .filter((a) => a && String(a.text || "").trim());
    if (acs.length === 0) {
      const e = new Error("cannot derive a test-definition: " + (target.ticketKey || ticketId)
        + " has no acceptance criteria (add AC first — they are the test plan)");
      e.statusCode = 422; e.kind = "NO_ACCEPTANCE_CRITERIA";
      throw e;
    }
    const title = (opts.title && String(opts.title).trim())
      || ("Testplan: " + (target.title || target.ticketKey || ticketId));
    let s = ops.createTicket(snap, { type: "test-definition", title: title }, actor);
    const def = s.tickets[s.tickets.length - 1];
    acs.forEach((ac) => {
      const text = String(ac.text).trim();
      s = ops.addTestStep(s, def.id, { step: text, expectedResult: text }, actor);
    });
    s = ops.addLink(s, def.id, { linkTypeId: "tests", targetTicketId: ticketId }, actor);
    return s;
  },

  addTestStep(snap, ticketId, patch, actor) {
    const s = cowSnap(snap);
    const t = findTicket(s, ticketId);
    if (!t) { const e = new Error("ticket not found: " + ticketId); e.statusCode = 404; throw e; }
    assertSpecEditable(t);
    const step = normalizeTestStep(patch || {});
    const list = Array.isArray(t.steps) ? t.steps : (t.steps = []);
    const pos = patch && typeof patch.position === "number" ? patch.position : list.length;
    list.splice(Math.max(0, Math.min(list.length, pos)), 0, step);
    bumpAudit(t, actor);
    return s;
  },

  updateTestStep(snap, ticketId, stepId, patch, actor) {
    const s = cowSnap(snap);
    const t = findTicket(s, ticketId);
    if (!t) { const e = new Error("ticket not found: " + ticketId); e.statusCode = 404; throw e; }
    assertSpecEditable(t);
    const step = (t.steps || []).find(x => x.id === stepId);
    if (!step) { const e = new Error("step not found: " + stepId); e.statusCode = 404; throw e; }
    if (patch && typeof patch.step === "string")           step.step = patch.step;
    if (patch && typeof patch.data === "string")           step.data = patch.data;
    if (patch && typeof patch.expectedResult === "string") step.expectedResult = patch.expectedResult;
    bumpAudit(t, actor);
    return s;
  },

  removeTestStep(snap, ticketId, stepId, actor) {
    const s = cowSnap(snap);
    const t = findTicket(s, ticketId);
    if (!t) { const e = new Error("ticket not found: " + ticketId); e.statusCode = 404; throw e; }
    assertSpecEditable(t);
    const before = (t.steps || []).length;
    t.steps = (t.steps || []).filter(x => x.id !== stepId);
    if (t.steps.length !== before) bumpAudit(t, actor);
    return s;
  },

  reorderTestSteps(snap, ticketId, orderedStepIds, actor) {
    const s = cowSnap(snap);
    const t = findTicket(s, ticketId);
    if (!t) { const e = new Error("ticket not found: " + ticketId); e.statusCode = 404; throw e; }
    assertSpecEditable(t);
    const byId = new Map((t.steps || []).map(x => [x.id, x]));
    const reordered = [];
    for (const id of (orderedStepIds || [])) {
      const x = byId.get(id);
      if (x) { reordered.push(x); byId.delete(id); }
    }
    // Append any steps the caller didn't list (defensive — keep them).
    for (const remaining of byId.values()) reordered.push(remaining);
    t.steps = reordered;
    bumpAudit(t, actor);
    return s;
  },

  addTestPrereq(snap, ticketId, patch, actor) {
    const s = cowSnap(snap);
    const t = findTicket(s, ticketId);
    if (!t) { const e = new Error("ticket not found: " + ticketId); e.statusCode = 404; throw e; }
    assertSpecEditable(t);
    const item = normalizeTestPrerequisite(patch || {});
    if (!Array.isArray(t.prerequisites)) t.prerequisites = [];
    t.prerequisites.push(item);
    bumpAudit(t, actor);
    return s;
  },

  updateTestPrereq(snap, ticketId, prereqId, patch, actor) {
    const s = cowSnap(snap);
    const t = findTicket(s, ticketId);
    if (!t) { const e = new Error("ticket not found: " + ticketId); e.statusCode = 404; throw e; }
    assertSpecEditable(t);
    const item = (t.prerequisites || []).find(x => x.id === prereqId);
    if (!item) { const e = new Error("prereq not found: " + prereqId); e.statusCode = 404; throw e; }
    if (patch && typeof patch.label === "string") item.label = patch.label;
    if (patch && typeof patch.required === "boolean") item.required = patch.required;
    bumpAudit(t, actor);
    return s;
  },

  removeTestPrereq(snap, ticketId, prereqId, actor) {
    const s = cowSnap(snap);
    const t = findTicket(s, ticketId);
    if (!t) { const e = new Error("ticket not found: " + ticketId); e.statusCode = 404; throw e; }
    assertSpecEditable(t);
    const before = (t.prerequisites || []).length;
    t.prerequisites = (t.prerequisites || []).filter(x => x.id !== prereqId);
    if (t.prerequisites.length !== before) bumpAudit(t, actor);
    return s;
  },

  checkTestPrereq(snap, ticketId, prereqId, actor) {
    const s = cowSnap(snap);
    const t = findTicket(s, ticketId);
    if (!t) { const e = new Error("ticket not found: " + ticketId); e.statusCode = 404; throw e; }
    const item = (t.prerequisites || []).find(x => x.id === prereqId);
    if (!item) { const e = new Error("prereq not found: " + prereqId); e.statusCode = 404; throw e; }
    item.checked = true;
    bumpAudit(t, actor);
    return s;
  },

  uncheckTestPrereq(snap, ticketId, prereqId, actor) {
    const s = cowSnap(snap);
    const t = findTicket(s, ticketId);
    if (!t) { const e = new Error("ticket not found: " + ticketId); e.statusCode = 404; throw e; }
    const item = (t.prerequisites || []).find(x => x.id === prereqId);
    if (!item) { const e = new Error("prereq not found: " + prereqId); e.statusCode = 404; throw e; }
    item.checked = false;
    bumpAudit(t, actor);
    return s;
  },

  // ---- SM-58: test-execution lifecycle ops ------------------------------
  //
  // startTestExecution clones a test-definition's steps onto a new
  // test-execution ticket (snapshot-freeze semantic — later definition
  // changes don't bleed back). Also creates the "executes" link from the
  // run → definition, and bumps the project ticketCounter for the new key.

  startTestExecution(snap, definitionId, opts, actor) {
    const s = cowSnap(snap);
    const def = findTicket(s, definitionId);
    if (!def) { const e = new Error("definition not found: " + definitionId); e.statusCode = 404; throw e; }
    if (def.type !== "test-definition") {
      const e = new Error("ticket is not a test-definition: " + definitionId);
      e.statusCode = 422; e.kind = "WRONG_TYPE";
      throw e;
    }
    const a = normalizeActor(actor);
    const env  = opts && typeof opts.env  === "string" ? opts.env  : "";
    const runBy = (opts && isObject(opts.runBy)) ? normalizeActor(opts.runBy) : a;

    // Clone steps with snapshot semantics: each execution step keeps a
    // pointer to the definition's stepId so MCP recording can address by id.
    const clonedSteps = (def.steps || []).map(src => normalizeTestExecStep({
      stepId:         src.id,
      step:           src.step,
      data:           src.data,
      expectedResult: src.expectedResult,
      status:         "pending"
    }));

    s.project = normalizeProject(s.project);
    s.project.ticketCounter = (s.project.ticketCounter || 0) + 1;
    const ticketKey = s.project.ticketPrefix + "-" + s.project.ticketCounter;

    const exec = normalizeTicket({
      id: uid("t-"),
      projectId: s.project.id,
      ticketKey: ticketKey,
      type: "test-execution",
      title: "Run of " + (def.ticketKey || def.id),
      description: "Execution of test-definition " + (def.ticketKey || def.id),
      status: "in-progress",
      // Place in the same release as the definition so it's visible nearby.
      position: { releaseId: (def.position && def.position.releaseId) || null,
                  processStepId: (def.position && def.position.processStepId) || null,
                  epicId: null,
                  sortOrder: 0 },
      executionSteps:             clonedSteps,
      referencedTestDefinitionId: def.id,
      runAt:                      now(),
      runBy:                      runBy,
      env:                        env,
      createdBy: a,
      updatedBy: a,
      createdAt: now(),
      updatedAt: now(),
      version: 1
    });
    s.tickets.push(markCowFresh(s, exec));

    // Wire the 'executes' link: source = exec, target = def.
    exec.links = exec.links || [];
    exec.links.push(normalizeLink({
      linkTypeId: "executes",
      targetTicketId: def.id,
      createdBy: a
    }));
    bumpAudit(s.project, a);
    return s;
  },

  recordTestExecStep(snap, executionId, stepId, patch, actor) {
    const s = cowSnap(snap);
    const exec = findTicket(s, executionId);
    if (!exec) { const e = new Error("execution not found: " + executionId); e.statusCode = 404; throw e; }
    if (exec.type !== "test-execution") {
      const e = new Error("ticket is not a test-execution: " + executionId);
      e.statusCode = 422; e.kind = "WRONG_TYPE";
      throw e;
    }
    // Match by execution-step.stepId (the cloned reference to the definition)
    // OR by execution-step.id (the execution's own id). Either is fine —
    // callers usually have the definition step id at hand.
    const step = (exec.executionSteps || []).find(x => x.stepId === stepId || x.id === stepId);
    if (!step) { const e = new Error("step not found: " + stepId); e.statusCode = 404; throw e; }
    if (patch && typeof patch.actualResult === "string") step.actualResult = patch.actualResult;
    if (patch && typeof patch.status === "string") {
      if (TEST_EXEC_STEP_STATUSES.indexOf(patch.status) < 0) {
        const e = new Error("invalid status: " + patch.status + " (allowed: " + TEST_EXEC_STEP_STATUSES.join(",") + ")");
        e.statusCode = 422; throw e;
      }
      step.status = patch.status;
    }
    if (patch && typeof patch.note === "string") {
      if (patch.note.length > 0) step.note = patch.note;
      else delete step.note;
    }
    // SM-57-followup: outcome may have flipped — sync status accordingly.
    _syncExecStatusToOutcome(exec);
    bumpAudit(exec, actor);
    return s;
  },

  setTestExecOutcome(snap, executionId, outcome, actor) {
    const s = cowSnap(snap);
    const exec = findTicket(s, executionId);
    if (!exec) { const e = new Error("execution not found: " + executionId); e.statusCode = 404; throw e; }
    if (exec.type !== "test-execution") {
      const e = new Error("ticket is not a test-execution: " + executionId);
      e.statusCode = 422; e.kind = "WRONG_TYPE";
      throw e;
    }
    // "auto" resets the override so derive-from-steps takes over.
    if (outcome === "auto" || outcome == null) {
      exec.outcomeOverride = null;
    } else if (TEST_EXEC_OUTCOMES.indexOf(outcome) >= 0) {
      exec.outcomeOverride = outcome;
    } else {
      const e = new Error("invalid outcome: " + outcome + " (allowed: " + TEST_EXEC_OUTCOMES.join(",") + " or 'auto')");
      e.statusCode = 422; throw e;
    }
    // SM-57-followup: outcome flipped — sync status accordingly.
    _syncExecStatusToOutcome(exec);
    bumpAudit(exec, actor);
    return s;
  },

  // E18.B: Project-Header-Update als Store-Op (für undo/redo + snapshot-PUT
  // Pipeline). Erlaubte Felder: name, description, definitions, workflow,
  // ticketTypes, entityTypeConfig, labels. id/ticketPrefix/ticketCounter sind
  // bewusst gesperrt — id ist Identität, ticketPrefix/Counter würden bestehende
  // ticketKeys brechen.
  updateProject(snap, patch, actor) {
    const s = cowSnap(snap);
    const allowed = ["name", "description", "definitions", "workflow",
      "boards", "ticketTypes", "entityTypeConfig", "labels", "linkTypes",
      // SM-93
      "governance"];
    const merged = Object.assign({}, s.project);
    for (const k of allowed) {
      if (patch && Object.prototype.hasOwnProperty.call(patch, k)) {
        // SM-240: clone object values — see updateTicket fall-through.
        merged[k] = (patch[k] && typeof patch[k] === "object") ? clone(patch[k]) : patch[k];
      }
    }
    s.project = normalizeProject(merged);
    bumpAudit(s.project, actor);
    return s;
  },

  createRelease(snap, partial, actor) {
    const s = cowSnap(snap);
    const a = normalizeActor(actor);
    const maxSortOrder = s.releases.reduce((m, r) => Math.max(m, r.sortOrder), -1);
    const r = normalizeRelease(Object.assign({}, partial, {
      id: uid("r-"),
      projectId: s.project.id,
      sortOrder: typeof partial.sortOrder === "number" ? partial.sortOrder : maxSortOrder + 1,
      createdBy: a,
      updatedBy: a,
      createdAt: now(),
      updatedAt: now(),
      version: 1
    }));
    s.releases.push(markCowFresh(s, r));
    return s;
  },

  updateRelease(snap, releaseId, patch, actor) {
    const s = cowSnap(snap);
    const r = cowRelease(s, releaseId);
    if (!r) return s;
    const allowed = ["name", "description", "startDate", "endDate", "status", "sortOrder"];
    for (const k of allowed) {
      if (Object.prototype.hasOwnProperty.call(patch, k)) r[k] = patch[k];
    }
    bumpAudit(r, actor);
    return s;
  },

  softDeleteRelease(snap, releaseId, actor) {
    const s = cowSnap(snap);
    const r = cowRelease(s, releaseId);
    if (!r) return s;
    r.isDeleted = true;
    r.deletedAt = now();
    r.deletedBy = normalizeActor(actor);
    bumpAudit(r, actor);
    // SM-240 (normalize-only-at-edges): normalizeSnapshot used to prune the
    // now-dangling position.releaseId on the next pass; with the op path no
    // longer running a full normalize, the op must leave an invariant
    // snapshot itself — mirror SM-167's processStep behaviour.
    for (const probe of s.tickets.slice()) {
      if (!probe.position || probe.position.releaseId !== releaseId) continue;
      const t = cowTicket(s, probe.id);
      t.position = normalizePosition(Object.assign({}, t.position, { releaseId: null }));
      // SM-240 review: prune soft-deleted tickets too (normalize parity),
      // without an audit bump.
      if (!t.isDeleted) bumpAudit(t, actor);
    }
    return s;
  },

  reorderReleases(snap, orderedIds, actor) {
    const s = cowSnap(snap);
    const byId = new Map(s.releases.map(r => [r.id, r]));
    const newList = [];
    orderedIds.forEach((id, idx) => {
      if (byId.has(id)) {
        const r = cowRelease(s, id);   // COW-aware (SM-240)
        r.sortOrder = idx;
        bumpAudit(r, actor);
        newList.push(r);
        byId.delete(id);
      }
    });
    // any releases not in orderedIds keep relative order at the end
    for (const r of byId.values()) newList.push(r);
    s.releases = newList;
    return s;
  },

  createProcessStep(snap, partial, actor) {
    const s = cowSnap(snap);
    const a = normalizeActor(actor);
    const maxSortOrder = s.processSteps.reduce((m, p) => Math.max(m, p.sortOrder), -1);
    const ps = normalizeProcessStep(Object.assign({}, partial, {
      id: uid("ps-"),
      projectId: s.project.id,
      sortOrder: typeof partial.sortOrder === "number" ? partial.sortOrder : maxSortOrder + 1,
      createdBy: a,
      updatedBy: a,
      createdAt: now(),
      updatedAt: now(),
      version: 1
    }));
    s.processSteps.push(markCowFresh(s, ps));
    return s;
  },

  updateProcessStep(snap, stepId, patch, actor) {
    const s = cowSnap(snap);
    const ps = cowProcessStep(s, stepId);
    if (!ps) return s;
    const allowed = ["name", "description", "epicId", "sortOrder"];
    for (const k of allowed) {
      if (Object.prototype.hasOwnProperty.call(patch, k)) ps[k] = patch[k];
    }
    bumpAudit(ps, actor);
    return s;
  },

  softDeleteProcessStep(snap, stepId, actor) {
    const s = cowSnap(snap);
    const ps = cowProcessStep(s, stepId);
    if (!ps) return s;
    ps.isDeleted = true;
    ps.deletedAt = now();
    ps.deletedBy = normalizeActor(actor);
    bumpAudit(ps, actor);
    // SM-167: tickets positioned in this step would otherwise keep a dangling
    // processStepId — they render in NO cell (the step is gone) AND are excluded
    // from the backlog's per-release group (which treats a truthy processStepId
    // as "placed in a cell"). Result: invisible in the map yet still counted
    // toward their release (e.g. the release-completion warning). Clear the
    // processStepId — keep the releaseId — so they resurface in the backlog's
    // "Scheduled for <release> but unplaced" group, where the user can re-place
    // or unschedule them. Contained stories follow their epic via
    // syncContainedStoryPositions on the next normalize.
    for (const probe of s.tickets.slice()) {
      if (!probe.position || probe.position.processStepId !== stepId) continue;
      const t = cowTicket(s, probe.id);   // COW-aware (SM-240)
      t.position = normalizePosition(Object.assign({}, t.position, { processStepId: null }));
      // SM-240 review: soft-deleted tickets are pruned too (normalize's
      // pruneStaleContainerRefs does) — but without an audit bump.
      if (!t.isDeleted) bumpAudit(t, actor);
    }
    return s;
  },

  reorderProcessSteps(snap, orderedIds, actor) {
    const s = cowSnap(snap);
    const byId = new Map(s.processSteps.map(p => [p.id, p]));
    const newList = [];
    orderedIds.forEach((id, idx) => {
      if (byId.has(id)) {
        const ps = cowProcessStep(s, id);   // COW-aware (SM-240)
        ps.sortOrder = idx;
        bumpAudit(ps, actor);
        newList.push(ps);
        byId.delete(id);
      }
    });
    for (const ps of byId.values()) newList.push(ps);
    s.processSteps = newList;
    return s;
  },

  /**
   * SM-247 — split a process step: insert a NEW step directly after the
   * original and move the chosen epics (and, via the SM-67 cascade, their
   * contained stories) into it. Loose stories stay with the original — the
   * split decision is expressed in epics, the unit the user sees. One
   * snapshot transition (one revision when persisted).
   *
   * opts: { name (required), description?, epicIds? } — every epicId must
   * be a non-deleted epic currently positioned in `processStepId`, else
   * 422 with the offending ids in `missing`. Empty epicIds = pure
   * insert-after (an empty new column).
   */
  splitProcessStep(snap, processStepId, opts, actor) {
    const s = cowSnap(snap);
    const orig = s.processSteps.find(p => p.id === processStepId && !p.isDeleted);
    if (!orig) {
      const e = new Error("process step not found: " + processStepId);
      e.statusCode = 404;
      throw e;
    }
    const name = (opts && typeof opts.name === "string") ? opts.name.trim() : "";
    if (!name) {
      const e = new Error("split requires a name for the new process step");
      e.statusCode = 400;
      throw e;
    }
    const epicIds = (opts && Array.isArray(opts.epicIds)) ? opts.epicIds : [];
    const notInStep = epicIds.filter(id => {
      const t = (s.tickets || []).find(x => x.id === id);
      return !t || t.isDeleted || t.type !== "epic"
        || !t.position || t.position.processStepId !== processStepId;
    });
    if (notInStep.length > 0) {
      const e = new Error("epics not in step " + processStepId + ": " + notInStep.join(", "));
      e.statusCode = 422;
      e.kind = "SPLIT_EPICS_NOT_IN_STEP";
      e.missing = notInStep;
      throw e;
    }
    const a = normalizeActor(actor);
    const newPs = normalizeProcessStep({
      id: uid("ps-"),
      projectId: s.project.id,
      name: name,
      description: (opts && typeof opts.description === "string") ? opts.description : "",
      sortOrder: (orig.sortOrder || 0) + 1,   // renumbered below
      createdBy: a, updatedBy: a,
      createdAt: now(), updatedAt: now(),
      version: 1
    });
    s.processSteps.push(markCowFresh(s, newPs));
    // Renumber the LIVE steps contiguously with newPs directly after orig.
    const live = s.processSteps.filter(p => !p.isDeleted && p.id !== newPs.id)
      .slice().sort((x, y) => (x.sortOrder || 0) - (y.sortOrder || 0));
    const order = [];
    for (const p of live) {
      order.push(p.id);
      if (p.id === processStepId) order.push(newPs.id);
    }
    order.forEach((id, idx) => {
      const probe = s.processSteps.find(p => p.id === id);
      if (!probe || probe.sortOrder === idx) return;
      const ps = cowProcessStep(s, id);
      ps.sortOrder = idx;
      if (id !== newPs.id) bumpAudit(ps, actor);
    });
    // Move the chosen epics; contained stories follow via the SM-67 cascade.
    for (const id of epicIds) {
      const epic = findTicket(s, id);   // COW-aware
      epic.position = normalizePosition(Object.assign({}, epic.position, {
        processStepId: newPs.id
      }));
      bumpAudit(epic, actor);
      _cascadeEpicPositionToContainedStories(s, id, actor);
    }
    return s;
  },

  /**
   * Reorder tickets within a scope (epic, cell, or backlog). Mirrors the
   * exact shape of reorderProcessSteps: takes an `orderedIds` array and
   * assigns sortOrder = idx to each. If `scope` is provided (with
   * releaseId/processStepId/epicId fields), it is ALSO applied to every
   * ticket in the list — which covers cross-container moves cleanly.
   * Tickets not in orderedIds are untouched.
   */
  reorderTickets(snap, orderedIds, scope, actor) {
    const s = cowSnap(snap);
    const byId = new Map(s.tickets.map(t => [t.id, t]));
    // SM-52: scope.epicId is interpreted as the target container; it never
    // lands on position.epicId. We re-parent via contains-links instead.
    const scopeEpicId = scope && typeof scope.epicId === "string" ? scope.epicId : null;
    // SM-67: when scope re-parents into an epic, the epic's release+processStep
    // dictate the final position for contained stories — override whatever
    // releaseId/processStepId scope passed in.
    const epicPos = scopeEpicId ? _inheritPositionFromEpic(s, scopeEpicId, {}) : null;
    orderedIds.forEach((id, idx) => {
      const probe = byId.get(id);
      if (!probe || probe.isDeleted) return;
      const t = cowTicket(s, id);   // COW-aware (SM-240)
      if (scope) {
        const useInherit = (t.type !== "epic" && epicPos);
        t.position = normalizePosition({
          releaseId:     useInherit ? (epicPos.releaseId || null)
                                    : (scope.releaseId != null     ? scope.releaseId     : null),
          processStepId: useInherit ? (epicPos.processStepId || null)
                                    : (scope.processStepId != null ? scope.processStepId : null),
          epicId:        null,                                     // never persisted
          sortOrder:     idx
        });
        if (t.type !== "epic") _setContainerEpic(s, id, scopeEpicId, actor);
        // SM-67: if an epic is among the reordered tickets and scope changed
        // its position, cascade to its contained stories.
        if (t.type === "epic") {
          _cascadeEpicPositionToContainedStories(s, id, actor);
        }
      } else {
        t.position = normalizePosition(Object.assign({}, t.position, { sortOrder: idx, epicId: null }));
      }
      bumpAudit(t, actor);
    });
    recomputeEpicStatuses(s);   // SM-236 (scope.epicId re-parents → roll up)
    return s;
  },

  // SM-44 — typed ticket links --------------------------------------------
  //
  // ticket.links is an array of `{id, linkTypeId, targetTicketId, label?,
  // createdAt, createdBy}`. linkTypeId references a project.linkTypes entry
  // (SM-45 will introduce the per-project list; defaults work without it).
  //
  // Validation enforced on add/setLinks:
  //   - self-link forbidden (sourceId === targetId)
  //   - target must exist in snapshot.tickets
  //   - duplicate forbidden (same linkTypeId + targetTicketId)
  //   - for cycle-checked types (blocks, predecessor-of, contains): adding
  //     the link must not introduce a cycle in the same-type subgraph.

  addLink(snap, sourceTicketId, link, actor) {
    const s = cowSnap(snap);
    const source = findTicket(s, sourceTicketId);   // COW-aware (SM-240)
    if (!source) {
      const e = new Error("source ticket not found: " + sourceTicketId);
      e.statusCode = 404;
      throw e;
    }
    const normalized = normalizeLink(link || {});
    // Stamp the link's createdBy from the acting actor when the caller didn't
    // supply one explicitly — otherwise normalizeLink defaults it to the
    // "unknown" fallback even though we know who is adding the link. (SM-149)
    if (actor != null && (!link || link.createdBy == null)) {
      normalized.createdBy = normalizeActor(actor);
    }
    validateLink(s, sourceTicketId, normalized, source.links || []);
    source.links = (source.links || []).concat([normalized]);
    bumpAudit(source, actor);
    recomputeEpicStatuses(s);   // SM-236 (a contains-link adds a child to an epic)
    return s;
  },

  removeLink(snap, sourceTicketId, linkId, actor) {
    const s = cowSnap(snap);
    const source = findTicket(s, sourceTicketId);   // COW-aware (SM-240)
    if (!source) {
      const e = new Error("source ticket not found: " + sourceTicketId);
      e.statusCode = 404;
      throw e;
    }
    const before = (source.links || []).length;
    source.links = (source.links || []).filter(l => l.id !== linkId);
    if (source.links.length !== before) bumpAudit(source, actor);
    recomputeEpicStatuses(s);   // SM-236 (removing a contains-link drops a child)
    return s;
  },

  setLinks(snap, sourceTicketId, links, actor) {
    const s = cowSnap(snap);
    const source = findTicket(s, sourceTicketId);   // COW-aware (SM-240)
    if (!source) {
      const e = new Error("source ticket not found: " + sourceTicketId);
      e.statusCode = 404;
      throw e;
    }
    const normalized = (Array.isArray(links) ? links : []).map(normalizeLink);
    // Validate each link against the snapshot. Run validation against the
    // accumulating set so duplicates within the new list are also caught.
    const accepted = [];
    for (const link of normalized) {
      validateLink(s, sourceTicketId, link, accepted);
      accepted.push(link);
    }
    source.links = accepted;
    bumpAudit(source, actor);
    recomputeEpicStatuses(s);   // SM-236 (contains-links may have changed)
    return s;
  }
};

// ---------------------------------------------------------------------------
// SM-254 — default scaffold. Every project should be immediately usable: a
// fresh project gets one default release + one default process step, so the
// Story Map has a real cell from the first load. Seeded by BOTH server and MCP
// create paths (the UI no longer double-seeds). Idempotent: only fills what's
// missing, so re-running it (or running it on a non-empty snapshot) is a no-op.
const DEFAULT_RELEASE_NAME = "v1.0";
const DEFAULT_PROCESS_STEP_NAME = "Activities";

function seedDefaultScaffold(snap, actor) {
  let s = snap;
  const hasRelease = (s.releases || []).some(r => !r.isDeleted);
  const hasStep    = (s.processSteps || []).some(p => !p.isDeleted);
  if (!hasRelease) s = ops.createRelease(s, { name: DEFAULT_RELEASE_NAME }, actor);
  if (!hasStep)    s = ops.createProcessStep(s, { name: DEFAULT_PROCESS_STEP_NAME }, actor);
  return s;
}

// ---------------------------------------------------------------------------
// SM-240 — op-path normalize-invariance: derivedHealth post-pass.
//
// normalizeSnapshot annotates every test-definition with its derivedHealth
// (_annotateDerivedHealth). With the store no longer running a full normalize
// on the op path, the ops themselves must leave that projection consistent —
// empirically the ONLY normalize-divergence an op can produce (the COW
// guardrail suite proves it per op). Instead of analysing 35 ops one by one
// (and re-analysing every future op), every op is wrapped: when its output is
// a COW snapshot, refresh derivedHealth copy-on-write — touching only the
// test-definitions whose value actually changed, so structural sharing for
// everything else is preserved.
// ---------------------------------------------------------------------------

function refreshDerivedHealthCow(s) {
  const tickets = s.tickets || [];
  for (const probe of tickets.slice()) {
    if (probe.type !== "test-definition" || probe.isDeleted) continue;
    const h = computeDerivedHealth(s, probe);
    if ((probe.derivedHealth || "") === h) continue;
    const td = cowTicket(s, probe.id);
    td.derivedHealth = h;
  }
}

for (const _opName of Object.keys(ops)) {
  const _orig = ops[_opName];
  ops[_opName] = function () {
    const out = _orig.apply(this, arguments);
    if (out && out.__cowFresh) refreshDerivedHealthCow(out);
    return out;
  };
}

// ---------------------------------------------------------------------------
// SM-44 — link validation helpers (pure, throwing)
// ---------------------------------------------------------------------------

function validateLink(snap, sourceTicketId, link, existingLinks) {
  if (!link.targetTicketId) {
    const e = new Error("link.targetTicketId is required");
    e.statusCode = 400; e.kind = "LINK_TARGET_REQUIRED";
    throw e;
  }
  if (link.targetTicketId === sourceTicketId) {
    const e = new Error("self-link forbidden (source === target)");
    e.statusCode = 400; e.kind = "LINK_SELF";
    throw e;
  }
  const target = snap.tickets.find(t => t.id === link.targetTicketId);
  if (!target) {
    const e = new Error("link.targetTicketId not found: " + link.targetTicketId);
    e.statusCode = 404; e.kind = "LINK_TARGET_MISSING";
    throw e;
  }
  // Duplicate-check on (linkTypeId, targetTicketId).
  for (const existing of existingLinks) {
    if (existing.linkTypeId === link.linkTypeId && existing.targetTicketId === link.targetTicketId) {
      const e = new Error("duplicate link (" + link.linkTypeId + " -> " + link.targetTicketId + ")");
      e.statusCode = 409; e.kind = "LINK_DUPLICATE";
      throw e;
    }
  }
  // Cycle-check for directional semantics. SM-45: resolve via the
  // project's linkType catalogue when available — falls back to the
  // hardcoded ID list (SM-44 behaviour) if linkTypes is missing or the
  // ID isn't registered. A cycle in the same-linkType subgraph is
  // rejected.
  if (isCycleChecked(snap.project, link.linkTypeId)) {
    if (wouldCreateCycle(snap, sourceTicketId, link.linkTypeId, link.targetTicketId)) {
      const e = new Error("link would create a cycle (" + link.linkTypeId + ")");
      e.statusCode = 409; e.kind = "LINK_CYCLE";
      throw e;
    }
  }
}

/**
 * SM-45: resolve whether a given linkTypeId is cycle-checked. Prefer the
 * project's linkType.semantic lookup; fall back to the SM-44 hardcoded
 * ID list (so snapshots created before SM-45 still behave identically).
 */
function isCycleChecked(project, linkTypeId) {
  if (project && Array.isArray(project.linkTypes)) {
    const lt = project.linkTypes.find(t => t.id === linkTypeId);
    if (lt) {
      // SM-94: explicit per-linkType cycleCheck:true overrides semantic check.
      if (lt.cycleCheck === true) return true;
      return CYCLE_CHECKED_SEMANTICS.indexOf(lt.semantic) >= 0;
    }
  }
  // Fallback for snapshots/tests without a registered linkTypes catalogue.
  return CYCLE_CHECKED_LINK_TYPES.indexOf(linkTypeId) >= 0;
}

/**
 * Build the existing same-linkTypeId adjacency (source → set<target>) and
 * check if `target` can reach `source` by following edges of the same type.
 * If yes, adding source → target would close a cycle.
 */
function wouldCreateCycle(snap, sourceId, linkTypeId, targetId) {
  if (sourceId === targetId) return true;   // belt+suspenders; caller already checked
  const adj = new Map();
  for (const t of snap.tickets) {
    for (const l of t.links || []) {
      if (l.linkTypeId !== linkTypeId) continue;
      if (!adj.has(t.id)) adj.set(t.id, new Set());
      adj.get(t.id).add(l.targetTicketId);
    }
  }
  // BFS from target — if we can reach source, the new edge source→target
  // would form a cycle.
  const visited = new Set([targetId]);
  const queue = [targetId];
  while (queue.length > 0) {
    const cur = queue.shift();
    if (cur === sourceId) return true;
    const neighbours = adj.get(cur);
    if (!neighbours) continue;
    for (const n of neighbours) {
      if (visited.has(n)) continue;
      visited.add(n);
      queue.push(n);
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Transition rule catalog + walker (SM-102 / SM-103)
// ---------------------------------------------------------------------------
//
// A closed, declarative catalog of transition gates. Each rule owns BOTH its
// applicability (`enabledFor(type, project)`) and its check
// (`check(ticket, project, ctx)`). This makes the SM-100 / SM-101 bug class
// structurally impossible: a rule cannot fire for a type whose backing field
// is configured off, because the same predicate that hides the field is the
// one that gates the rule.
//
// Rule shape:
//   {
//     id:    string,                          // stable catalog key
//     label: string,                          // human-readable
//     enabledFor(type, project): boolean,     // does this rule apply to the type?
//     check(ticket, project, ctx):            // null = satisfied,
//        null | { kind, missing?, message? }  // non-null = violation
//   }
//
// `ctx` is the transition context { currIdx, nextIdx, toStatus, toCategory }.
//
// SM-103 shipped the seam (catalog + walker). SM-104 fills in the DoR/DoD
// rules and wires the walker into validateStatusTransition; the SM-101
// lockstep skip now lives INSIDE each rule's `enabledFor`. SM-105/106 add the
// global test-type rules and remove the last hardcoded gate blocks.

const TRANSITION_RULES = {
  "dor.allRequiredMet": {
    id: "dor.allRequiredMet",
    label: "Definition of Ready met",
    enabledFor: (type, project) =>
      getEntityTypeConfig(project || {}, type).showDefinitionOfReady !== false,
    check: (ticket) => {
      const items = (ticket && ticket.definitionOfReady && ticket.definitionOfReady.items) || [];
      const missing = items.filter(it => it.required !== false && !it.checked);
      if (missing.length === 0) return null;
      return {
        kind: "DoR",
        message: "definition of ready not met",
        missing: missing.map(it => ({ id: it.id, label: it.label }))
      };
    }
  },
  "dod.allRequiredMet": {
    id: "dod.allRequiredMet",
    label: "Definition of Done met",
    enabledFor: (type, project) =>
      getEntityTypeConfig(project || {}, type).showDefinitionOfDone !== false,
    check: (ticket) => {
      const items = (ticket && ticket.definitionOfDone && ticket.definitionOfDone.items) || [];
      const missing = items.filter(it => it.required !== false && !it.checked);
      if (missing.length === 0) return null;
      return {
        kind: "DoD",
        message: "definition of done not met",
        missing: missing.map(it => ({ id: it.id, label: it.label }))
      };
    }
  },
  // SM-105: test-definition backlog-exit gate. A test must point at ≥1 ticket
  // it validates (outbound `tests` link) before leaving backlog. This is a
  // GLOBAL rule (see GLOBAL_TRANSITION_RULES) — it isn't attached to a
  // workflow transition; the backlog-exit condition lives in check via ctx.
  "links.hasTestTarget": {
    id: "links.hasTestTarget",
    label: "Test-definition links to at least one target",
    enabledFor: (type) => type === "test-definition",
    check: (ticket, project, ctx) => {
      // Only gate the transition OUT of backlog (currIdx === 0). A test can
      // leave backlog once; later forward moves aren't re-checked (a user may
      // have removed the last link after the fact — the gate is on the exit).
      if (!ctx || ctx.currIdx !== 0) return null;
      const links = Array.isArray(ticket && ticket.links) ? ticket.links : [];
      const hasTarget = links.some(l => l && l.linkTypeId === TEST_TARGET_LINK_TYPE_ID);
      if (hasTarget) return null;
      return {
        kind: "TEST_TARGETS",
        message: "a test-definition must link to at least one ticket it tests (linkType: 'tests') before leaving backlog"
      };
    }
  },
  // SM-106: test-execution outcome gate. Moving a test-execution to a
  // done-category status requires a non-pending outcome (the outcome IS the
  // gate — the DoD checklist isn't the right tool for tests). enabledFor uses
  // showTestOutcome — lockstep by design: hide the outcome section ⇒ gate N/A.
  "outcome.notPending": {
    id: "outcome.notPending",
    label: "Test-execution outcome is not pending",
    enabledFor: (type, project) =>
      getEntityTypeConfig(project || {}, type).showTestOutcome !== false,
    check: (ticket, project, ctx) => {
      if (!ctx || ctx.toCategory !== "done") return null;
      if (getEffectiveOutcome(ticket) !== "pending") return null;
      return {
        kind: "TEST_OUTCOME",
        message: "test-execution outcome is still pending — record per-step results or set outcomeOverride before closing"
      };
    }
  }
};

// Rules evaluated on EVERY forward transition, in addition to the matched
// transition's own rules. Their applicability is decided entirely by each
// rule's enabledFor + the transition ctx inside its check (e.g. backlog-exit
// only, or done-category only). These are the gates that used to be hardcoded
// as type-checks inside validateStatusTransition.
const GLOBAL_TRANSITION_RULES = ["links.hasTestTarget", "outcome.notPending"];

/**
 * Legacy adapter: map a workflow transition to its catalog rule ids. Existing
 * snapshots carry `requireGate: 'DoR'|'DoD'`; newer ones may carry an explicit
 * `rules: [...]`. requireGate wins (back-compat); otherwise the transition's
 * own rules[] is used. No snapshot migration needed.
 */
function transitionRuleIds(transition) {
  if (!transition) return [];
  if (transition.requireGate === "DoR") return ["dor.allRequiredMet"];
  if (transition.requireGate === "DoD") return ["dod.allRequiredMet"];
  return Array.isArray(transition.rules) ? transition.rules : [];
}

/**
 * Pure walker. Evaluates the given rule ids against the catalog and returns
 * the list of violations in ruleIds order. A rule is skipped when its id is
 * not in the catalog or when `enabledFor(type, project)` is false.
 *
 * @param {string[]} ruleIds
 * @param {{ ticket: object, project: object, ctx?: object }} context
 * @param {object} [catalog]  defaults to TRANSITION_RULES; tests inject their own.
 * @returns {Array<{ kind, missing?, message? }>}
 */
function evaluateTransitionRules(ruleIds, context, catalog) {
  catalog = catalog || TRANSITION_RULES;
  const ticket = context && context.ticket;
  const project = context && context.project;
  const ctx = context && context.ctx;
  const type = ticket && ticket.type;
  const failures = [];
  const ids = Array.isArray(ruleIds) ? ruleIds : [];
  for (const id of ids) {
    const rule = catalog[id];
    if (!rule) continue;
    if (typeof rule.enabledFor === "function" && !rule.enabledFor(type, project)) continue;
    const result = typeof rule.check === "function" ? rule.check(ticket, project, ctx) : null;
    if (result) failures.push(result);
  }
  return failures;
}

// ---------------------------------------------------------------------------
// validateStatusTransition — DoR / DoD-Gate-Check (pure, throwing)
// ---------------------------------------------------------------------------
//
// Identische Logik wie server/validation.js#changeStatusTransition (das ist
// jetzt ein Thin-Delegate). Wurde nach core gezogen, damit das Frontend
// dieselbe Validierung VOR dem `store.changeStatus`-Commit fahren kann —
// snapshot-PUT bypasst Transition-Validation by design (state-replace,
// nicht workflow-step), also muss das Gate clientseitig greifen, bevor
// der Commit überhaupt entsteht. Wirft `{statusCode, kind, missing}` bei
// Verletzung.

function validateStatusTransition(ticket, newStatus, project) {
  // SM-237: an epic's status is DERIVED (roll-up from its contained stories) —
  // no path may set it manually. This is the single choke-point shared by the
  // REST status route, store.changeStatusGated and the MCP status tools.
  if (ticket && ticket.type === "epic") {
    const e = new Error("epic status is derived from its contained stories — move the stories instead");
    e.statusCode = 422;
    e.kind = "EPIC_STATUS_DERIVED";
    throw e;
  }
  if (typeof newStatus !== "string") {
    const e = new Error("status invalid: " + newStatus);
    e.statusCode = 400;
    throw e;
  }
  const wf = getWorkflowForType(project || {}, ticket && ticket.type);
  const statusIds = wf.statuses.map(s => (typeof s === "string" ? s : s.id));
  if (!statusIds.includes(newStatus)) {
    const e = new Error("status invalid: " + newStatus + " (workflow: " + statusIds.join(", ") + ")");
    e.statusCode = 400;
    throw e;
  }
  // Reverse moves (target index < current index) and same-state moves are
  // unrestricted: a Reopen-style move shouldn't require gates. Forward
  // moves go through the named-transition matcher.
  const order = {};
  statusIds.forEach((id, i) => { order[id] = i; });
  const currIdx = order[ticket.status];
  const nextIdx = order[newStatus];
  if (currIdx == null || nextIdx == null || nextIdx <= currIdx) return;
  // Find matching named transition: target equals newStatus AND
  // (allowFromAny OR ticket.status in fromStatuses).
  const transitions = Array.isArray(wf.transitions) ? wf.transitions : [];
  const matching = transitions.filter(tr =>
    tr.toStatus === newStatus &&
    (tr.allowFromAny || (Array.isArray(tr.fromStatuses) && tr.fromStatuses.includes(ticket.status)))
  );
  if (matching.length === 0) {
    const e = new Error("transition not allowed: " + ticket.status + " → " + newStatus);
    e.statusCode = 422; e.kind = "TRANSITION";
    throw e;
  }
  // If multiple match (source-specific + allowFromAny), prefer the source-
  // specific one — that's the more restrictive author intent. Both should
  // typically carry the same gate, but if not, the specific transition's
  // gate wins.
  matching.sort((a, b) => Number(!!a.allowFromAny) - Number(!!b.allowFromAny));
  const matched = matching[0];
  // SM-104: gate evaluation is table-driven. The matched transition's
  // requireGate (or explicit rules[]) maps to catalog rule ids; each rule
  // decides its OWN applicability via enabledFor — the SM-101 lockstep skip
  // (entityTypeConfig hides the section ⇒ gate N/A) now lives inside the
  // rule, not here. The first violation is thrown with the same shape as
  // before ({ statusCode: 422, kind, missing? }).
  const wfStatus = wf.statuses.find(s => (typeof s === "string" ? s : s.id) === newStatus);
  const toCategory = wfStatus && typeof wfStatus === "object" ? wfStatus.category : null;
  const ctx = { currIdx, nextIdx, toStatus: newStatus, toCategory };
  const failures = evaluateTransitionRules(
    [...transitionRuleIds(matched), ...GLOBAL_TRANSITION_RULES],
    { ticket, project, ctx });
  if (failures.length > 0) {
    const f = failures[0];
    const e = new Error(f.message || "transition gate not met");
    e.statusCode = 422;
    e.kind = f.kind;
    if (f.missing) e.missing = f.missing;
    throw e;
  }
  // SM-106: validateStatusTransition is now fully walker-driven — every gate
  // (DoR, DoD, test-targets, test-outcome) is a declarative catalog rule. No
  // type-specific gate code remains here.
}

// ---------------------------------------------------------------------------
// tickets — render-aggregation helpers (consumed by the Story-Map renderer)
// ---------------------------------------------------------------------------
//
// Diese Helper sind PURE — sie selektieren/sortieren nur, mutieren nichts.
// Sie konsumieren das normalisierte Snapshot-Format und liefern Listen,
// die der Renderer 1:1 in Zellen / Spalten / Zeilen umsetzt. Tests gegen
// die Helper sind robuster als Tests gegen den Renderer.

function _byTypeStory(t) {
  // SM-196: spec-layer types (requirement/spec-module) are NOT story cards —
  // they never appear in story-map cells or the backlog. isBoardWorkItem also
  // excludes epics (containers), preserving the prior behaviour.
  return !t.isDeleted && isBoardWorkItem(t.type);
}
function _byTypeEpic(t) {
  return !t.isDeleted && t.type === "epic";
}
function _sortBySortOrder(a, b) {
  return ((a.position && a.position.sortOrder) || 0) - ((b.position && b.position.sortOrder) || 0);
}

// SM-196 R-2: natural compare of dotted section paths ("2.1" < "2.10" < "10.1").
// Each dot-segment is compared numerically when both sides are numeric, else
// lexically — so "2.1a" still orders sanely. Empty paths sort first.
function compareSectionPath(a, b) {
  const pa = String(a == null ? "" : a).split(".");
  const pb = String(b == null ? "" : b).split(".");
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const sa = pa[i] === undefined ? "" : pa[i];
    const sb = pb[i] === undefined ? "" : pb[i];
    const na = parseInt(sa, 10), nb = parseInt(sb, 10);
    const bothNum = String(na) === sa && String(nb) === sb;
    if (bothNum) {
      if (na !== nb) return na - nb;
    } else if (sa !== sb) {
      return sa < sb ? -1 : 1;
    }
  }
  return 0;
}

const tickets = {
  /**
   * SM-58: history of test-execution tickets for a given test-definition,
   * sorted by `runAt` descending (newest first). Reads the definition's
   * inbound "executes" links from every test-execution ticket. Optional
   * `limit` caps the result list.
   */
  testExecHistory(snapshot, definitionId, opts) {
    if (!snapshot || !Array.isArray(snapshot.tickets) || typeof definitionId !== "string") {
      return [];
    }
    const out = [];
    for (const t of snapshot.tickets) {
      if (t.isDeleted || t.type !== "test-execution") continue;
      if (!Array.isArray(t.links)) continue;
      const has = t.links.some(l =>
        (l.linkTypeId || l.type) === "executes" && l.targetTicketId === definitionId);
      if (has || t.referencedTestDefinitionId === definitionId) out.push(t);
    }
    out.sort((a, b) => (b.runAt || 0) - (a.runAt || 0));
    const limit = opts && typeof opts.limit === "number" ? opts.limit : null;
    return limit != null ? out.slice(0, Math.max(0, limit)) : out;
  },

  /** Epic-Karten in einer konkreten (releaseId, processStepId)-Zelle. */
  epicsInCell(snapshot, releaseId, processStepId) {
    return (snapshot.tickets || [])
      .filter(_byTypeEpic)
      .filter(t => t.position
                && t.position.releaseId === releaseId
                && t.position.processStepId === processStepId)
      .slice()
      .sort(_sortBySortOrder);
  },

  /**
   * SM-248 — every epic positioned in a process step ACROSS ALL RELEASES,
   * each annotated with its release (id+name) and contained-story count.
   * Powers the Process-Step editor's "epic hull" + the split-dialog epic
   * picker. Sorted by release sortOrder then epic sortOrder so the list
   * reads top-to-bottom like the story-map column.
   */
  epicsInProcessStep(snapshot, processStepId) {
    const releaseById = new Map(
      (snapshot.releases || []).map(r => [r.id, r]));
    return (snapshot.tickets || [])
      .filter(_byTypeEpic)
      .filter(t => t.position && t.position.processStepId === processStepId)
      .slice()
      .sort((a, b) => {
        const ra = releaseById.get(a.position && a.position.releaseId);
        const rb = releaseById.get(b.position && b.position.releaseId);
        const rd = ((ra && ra.sortOrder) || 0) - ((rb && rb.sortOrder) || 0);
        return rd !== 0 ? rd : _sortBySortOrder(a, b);
      })
      .map(epic => {
        const rel = releaseById.get(epic.position && epic.position.releaseId) || null;
        return {
          epic: epic,
          releaseId: rel ? rel.id : null,
          releaseName: rel ? rel.name : null,
          storyCount: tickets.storiesInEpic(snapshot, epic.id).length
        };
      });
  },

  /** Story-Karten, die zu einem bestimmten Epic gehören. SM-52: containment
   *  is canonical via the epic's outgoing `contains` links. */
  storiesInEpic(snapshot, epicId) {
    const epic = (snapshot.tickets || []).find(t => t.id === epicId);
    if (!epic || !epic.links || !epic.links.length) return [];
    const containedIds = new Set();
    for (const l of epic.links) {
      const lt = l.linkTypeId || l.type;
      if (lt === CONTAINS_LINK_TYPE_ID) containedIds.add(l.targetTicketId);
    }
    return (snapshot.tickets || [])
      .filter(_byTypeStory)
      .filter(t => containedIds.has(t.id))
      .slice()
      .sort(_sortBySortOrder);
  },

  /** Return the epic that currently contains the given story (via inbound
   *  contains-link), or null. SM-52. */
  epicForStory(snapshot, storyId) {
    for (const t of (snapshot.tickets || [])) {
      if (t.isDeleted || t.type !== "epic" || !t.links) continue;
      for (const l of t.links) {
        const lt = l.linkTypeId || l.type;
        if (lt === CONTAINS_LINK_TYPE_ID && l.targetTicketId === storyId) return t;
      }
    }
    return null;
  },

  /**
   * Lose Tickets in einer (releaseId, processStepId)-Zelle: alle Nicht-Epic-
   * Tickets, die in der Zelle platziert sind, aber KEINEM Epic angehören.
   * SM-52: containment is read from the contains-link, not position.epicId.
   */
  looseTicketsInCell(snapshot, releaseId, processStepId) {
    const containerByStory = _containerEpicByStoryId(snapshot);
    return (snapshot.tickets || [])
      .filter(_byTypeStory)
      .filter(t => t.position
                && t.position.releaseId === releaseId
                && t.position.processStepId === processStepId
                && !containerByStory.has(t.id))
      .slice()
      .sort(_sortBySortOrder);
  },

  /** Epics, die noch keiner Release zugeordnet sind — gehören in die
   *  Backlog-Section am Ende der Story-Map (Sub-Gruppe "Unscheduled"). */
  backlogEpics(snapshot) {
    return (snapshot.tickets || [])
      .filter(_byTypeEpic)
      .filter(t => !t.position || t.position.releaseId == null)
      .slice()
      .sort(_sortBySortOrder);
  },

  /** Stories ohne Release UND ohne Epic — orphan-Tickets (Backlog
   *  "Unscheduled"-Gruppe). SM-52: containment via link. */
  orphanStories(snapshot) {
    const containerByStory = _containerEpicByStoryId(snapshot);
    return (snapshot.tickets || [])
      .filter(_byTypeStory)
      .filter(t => (!t.position || t.position.releaseId == null) && !containerByStory.has(t.id))
      .slice()
      .sort(_sortBySortOrder);
  },

  /**
   * Tickets die EINER Release zugeordnet sind, aber noch nicht voll in der
   * Matrix platziert (Epic ohne processStepId, Story ohne epicId). Werden
   * im Backlog unter der jeweiligen Release als "Scheduled for X" gruppiert.
   *
   * Returnt eine Map<releaseId, {epics: Ticket[], stories: Ticket[]}>.
   */
  partiallyAssignedByRelease(snapshot) {
    const containerByStory = _containerEpicByStoryId(snapshot);
    const out = new Map();
    for (const t of (snapshot.tickets || [])) {
      if (t.isDeleted) continue;
      if (isSpecType(t.type)) continue;  // SM-196: spec objects never sit on the board
      const pos = t.position || {};
      if (!pos.releaseId) continue;     // unscheduled goes elsewhere
      if (t.type === "epic") {
        if (pos.processStepId) continue;  // fully placed → in cell
        if (!out.has(pos.releaseId)) out.set(pos.releaseId, { epics: [], stories: [] });
        out.get(pos.releaseId).epics.push(t);
      } else {
        // SM-52: a story is "fully placed" if it has an epic container (via
        // contains-link) — not via the legacy position.epicId.
        if (containerByStory.has(t.id)) continue;
        if (pos.processStepId) continue;  // loose ticket placed in cell — rendered there, not in backlog
        if (!out.has(pos.releaseId)) out.set(pos.releaseId, { epics: [], stories: [] });
        out.get(pos.releaseId).stories.push(t);
      }
    }
    for (const v of out.values()) {
      v.epics.sort(_sortBySortOrder);
      v.stories.sort(_sortBySortOrder);
    }
    return out;
  },

  /** SM-196 R-2: all spec-module tickets, ordered by sortOrder. */
  specModules(snapshot) {
    return (snapshot.tickets || [])
      .filter(t => !t.isDeleted && t.type === "spec-module")
      .slice()
      .sort(_sortBySortOrder);
  },

  /**
   * SM-196 R-2: the requirement-slices contained by a spec module, in stable
   * DOCUMENT order — by sectionPath first (the DOORS object id), sortOrder as
   * tiebreak. Containment is the module's outgoing `contains` links (same
   * canonical mechanism as epic→story). Returns [] for an unknown module.
   */
  requirementsInModule(snapshot, moduleId) {
    const mod = (snapshot.tickets || []).find(t => t.id === moduleId);
    if (!mod || !Array.isArray(mod.links)) return [];
    const contained = new Set();
    for (const l of mod.links) {
      if ((l.linkTypeId || l.type) === CONTAINS_LINK_TYPE_ID) contained.add(l.targetTicketId);
    }
    return (snapshot.tickets || [])
      .filter(t => !t.isDeleted && t.type === "requirement" && contained.has(t.id))
      .slice()
      .sort((a, b) => compareSectionPath(a.sectionPath, b.sectionPath) || _sortBySortOrder(a, b));
  }
};

// ---------------------------------------------------------------------------
// diffSnapshots
// ---------------------------------------------------------------------------

function diffList(prev, next) {
  const prevById = new Map(prev.map(x => [x.id, x]));
  const nextById = new Map(next.map(x => [x.id, x]));
  const added = [], updated = [], removed = [];
  for (const [id, n] of nextById) {
    const p = prevById.get(id);
    if (!p) added.push(n);
    else if (JSON.stringify(p) !== JSON.stringify(n)) updated.push(n);
  }
  for (const [id, p] of prevById) {
    if (!nextById.has(id)) removed.push(p);
  }
  return { added, updated, removed };
}

function diffSnapshots(prev, next) {
  prev = normalizeSnapshot(prev);
  next = normalizeSnapshot(next);
  return {
    tickets: diffList(prev.tickets, next.tickets),
    releases: diffList(prev.releases, next.releases),
    processSteps: diffList(prev.processSteps, next.processSteps)
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

return {
  SCHEMA_VERSION,
  EPIC_BACKLOG_ID,
  STORY_BACKLOG_ID,
  DEFAULT_TICKET_TYPES,
  // SM-196 R-1 — spec-layer type helpers.
  SPEC_TYPES,
  isSpecType,
  isBoardWorkItem,
  normalizeSourceAnchor,
  compareSectionPath,
  DEFAULT_STATUSES,
  DEFAULT_RELEASE_STATUSES,
  DEFAULT_RELEASE_NAME,
  DEFAULT_PROCESS_STEP_NAME,
  seedDefaultScaffold,
  STORYMAPPER_DEFAULT_DEFINITIONS,
  STORYMAPPER_DEFAULT_WORKFLOW,
  STATUS_CATEGORIES,
  defaultCategoryForStatusId,
  humanizeStatusId,
  normalizeStatusItem,
  LIMITS,
  uid,
  now,
  normalizeActor,
  normalizeProject,
  getEntityTypeConfig,
  getWorkflowForType,
  normalizeTicket,
  // SM-53 / SM-56 — test-type helpers (pure)
  normalizeTestStep,
  normalizeTestPrerequisite,
  normalizeTestExecStep,
  deriveOutcome,
  getEffectiveOutcome,
  TEST_EXEC_STEP_STATUSES,
  TEST_EXEC_OUTCOMES,
  normalizeRelease,
  normalizeProcessStep,
  normalizeSnapshot,
  normalizeDefinitions,
  normalizeWorkflow,
  resolveDefinitions,
  buildTicketChecklists,
  ops,
  tickets,
  // SM-236 — derived epic status (roll-up)
  deriveEpicStatus,
  epicChildStats,
  recomputeEpicStatuses,
  releaseProgress,
  // SM-242 — cancel workflow helpers
  firstStatusOfCategory,
  statusCategoryOf,
  isTerminalStatus,
  validateStatusTransition,
  // SM-102 / SM-103 / SM-104 / SM-105 / SM-106 — declarative transition-rule catalog + walker
  TRANSITION_RULES,
  GLOBAL_TRANSITION_RULES,
  evaluateTransitionRules,
  transitionRuleIds,
  diffSnapshots,
  // SM-44
  CYCLE_CHECKED_LINK_TYPES,
  normalizeLink,
  validateLink,
  wouldCreateCycle,
  // SM-45
  LINK_SEMANTICS,
  CYCLE_CHECKED_SEMANTICS,
  STORYMAPPER_DEFAULT_LINK_TYPES,
  normalizeLinkType,
  // SM-52 / SM-54-followup
  CONTAINS_LINK_TYPE_ID,
  TEST_TARGET_LINK_TYPE_ID,
  containerEpicIdOf,
  // SM-93 — Governance layer (predicates + evaluator + templater + defaults)
  TEST_DEFINITION_LIFECYCLES,
  TEST_DEFINITION_HEALTH_STATES,
  STORYMAPPER_DEFAULT_GOVERNANCE,
  normalizeGovernance,
  GOVERNANCE_PREDICATES,
  evaluateGates,
  evaluateWarnings,
  renderMessage,
  computeDerivedHealth
};

}));
