/**
 * SM-288 — Ticket-Import engine (pure).
 *
 * Single source (SM-139 pattern): this file backs BOTH the browser import
 * dialog (SM-289, via the frontend symlink + script tag) and the MCP
 * `import_tickets` tool (SM-290, via require). No I/O, no DOM.
 *
 *   parseTicketImport(text, format?) → { rows: [{line, data}], error }
 *       CSV (RFC-4180 tolerant; header row = field keys, compatible with the
 *       SM-285 export) or JSON (array of ticket objects). format is
 *       auto-detected by the leading bracket when omitted.
 *
 *   planTicketImport(snapshot, rows, mode) → { creates, updates, errors }
 *       mode 'create-only' | 'upsert'. Classifies every row; a row with any
 *       error contributes ONLY its error (atomic per row). Ticket keys are
 *       server-minted: unknown keys become creates, the provided key is
 *       dropped. Ref fields (release/processStep/epic) resolve by NAME or
 *       ID (epic: ticketKey or id), analogous to the query engine's ref
 *       fields. Empty CSV cells mean ABSENT (untouched), never "clear".
 *
 * The APPLY step lives with the surfaces (dialog / MCP tool) — this module
 * only parses and plans.
 *
 * Caller contract:
 *  - check parse.error BEFORE planning — a failed parse yields rows:[] and
 *    planTicketImport would report an indistinguishable empty plan.
 *  - the snapshot must be NORMALIZED (normalizeSnapshot) — raw snapshots
 *    without workflow/ticketTypes fail every enum resolution.
 *  - an unknown mode falls back to 'create-only' (the non-destructive one).
 *  - name resolution is last-wins on duplicates (two releases with the same
 *    name resolve to the later one) — ids are always unambiguous.
 *  - JSON `labels: []` is PRESENT and therefore clears labels; only absent /
 *    empty-string values are skipped.
 *  - POLICY: import is a MIGRATION surface. Statuses are planned/applied
 *    WITHOUT DoR/DoD gates (a re-imported export must be able to carry
 *    done tickets); only the epic-status-derived rule is enforced.
 *
 * UMD-wrapped — same file loads in Node (require) and browser (script tag).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./core.js"));
  } else {
    (root.STORYMAP = root.STORYMAP || {}).ticketImport = factory(root.STORYMAP && root.STORYMAP.core);
  }
}(typeof self !== "undefined" ? self : this, function (core) {
  "use strict";

  const TICKET_IMPORT = {
    MODES: ["create-only", "upsert"],
    // Canonical field keys the planner understands. Aliases map onto them;
    // anything else in a header is ignored silently (server-managed exports
    // like updated/created/acCount must round-trip without noise).
    FIELDS: ["key", "type", "title", "description", "status", "release", "processStep", "epic", "labels"],
    ALIASES: { ticketkey: "key", processstep: "processStep", label: "labels" },
    // SM-296: auto-mapping heuristic for FOREIGN exports (Jira, Excel, German
    // sheets). Applied when no explicit headerMapping entry exists; the
    // mapping panel prefills from the resolved result and can override.
    FOREIGN_ALIASES: {
      "summary": "title",
      "issue key": "key",
      "issue id": "key",
      "issue type": "type",
      "issuetype": "type",
      "fix version": "release",
      "fix version/s": "release",
      "fixversion": "release",
      "titel": "title",
      "beschreibung": "description",
      "typ": "type",
    },
    // SM-297: VALUE heuristic for foreign exports — applied only when the
    // TARGET actually exists in the project (guarded at resolution time),
    // overridable via opts.valueMapping.
    FOREIGN_VALUE_ALIASES: {
      status: {
        "open": "backlog", "to do": "backlog", "todo": "backlog", "reopened": "backlog",
        "closed": "done", "resolved": "done",
        "in review": "review",
      },
      type: { "story": "user-story" },
    },
  };

  // ---- CSV (RFC 4180) --------------------------------------------------------

  /** Parse CSV text into rows of cell arrays + the 1-based file line each ROW starts on. */
  function parseCsvCells(text) {
    const rows = [];
    let cells = [], cell = "", inQuotes = false, line = 1, rowLine = 1, sawAny = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQuotes) {
        if (ch === '"') {
          if (text[i + 1] === '"') { cell += '"'; i++; }
          else inQuotes = false;
        } else {
          if (ch === "\n") line++;
          cell += ch;
        }
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        cells.push(cell); cell = ""; sawAny = true;
      } else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && text[i + 1] === "\n") i++;
        line++;
        if (cell !== "" || cells.length || sawAny) rows.push({ line: rowLine, cells: cells.concat([cell]) });
        cells = []; cell = ""; sawAny = false; rowLine = line;
      } else {
        cell += ch;
      }
    }
    if (cell !== "" || cells.length || sawAny) rows.push({ line: rowLine, cells: cells.concat([cell]) });
    // EOF inside quotes: a stray quote silently swallowing the rest of the
    // file mangles rows AND line numbers — report it (review finding).
    return { rows: rows, unterminated: inQuotes };
  }

  const hasOwn = Object.prototype.hasOwnProperty;

  function canonicalField(name) {
    const raw = String(name == null ? "" : name).trim();
    const lc = raw.toLowerCase();
    // hasOwn guard: a header named 'constructor' must not resolve via the
    // prototype chain (review finding on aac77aa).
    if (hasOwn.call(TICKET_IMPORT.ALIASES, lc)) return TICKET_IMPORT.ALIASES[lc];
    const hit = TICKET_IMPORT.FIELDS.find((f) => f.toLowerCase() === lc);
    return hit || null;   // null = unknown header → ignored
  }

  /**
   * SM-296: resolve a CSV header to a field. Precedence: explicit
   * headerMapping entry (keys lowercased; null/''/'ignore' = drop the
   * column, a value must name a known field) → canonical field/alias →
   * FOREIGN_ALIASES heuristic → null (unused). Pure.
   */
  function resolveHeader(name, headerMapping) {
    const raw = String(name == null ? "" : name).trim();
    const lcName = raw.toLowerCase();
    if (headerMapping && hasOwn.call(headerMapping, lcName)) {
      const v = headerMapping[lcName];
      if (v == null || v === "" || v === "ignore") return null;
      return canonicalField(v);   // unknown mapping target → null, never a crash
    }
    return canonicalField(raw)
      || (hasOwn.call(TICKET_IMPORT.FOREIGN_ALIASES, lcName) ? TICKET_IMPORT.FOREIGN_ALIASES[lcName] : null);
  }

  /**
   * Parse import text into { rows: [{line, data}], headers, error }. `data`
   * maps CANONICAL field keys to raw values (strings from CSV; anything from
   * JSON). `headers` (CSV only; [] for JSON) lists every column as
   * {raw, field|null} — the base for the SM-296 mapping panel; field=null
   * means the column is unused. opts.headerMapping ({lcHeader → field|null})
   * overrides the built-in resolution per column.
   */
  function parseTicketImport(text, format, opts) {
    const src = String(text == null ? "" : text);
    // Normalize mapping KEYS once (trim + lowercase): a caller copying the
    // exact header casing from their CSV ({"Summary": …}) must not be
    // silently ignored — or worse, lose against the heuristic (review
    // finding on aac77aa).
    let headerMapping = (opts && opts.headerMapping) || null;
    if (headerMapping) {
      const norm = {};
      Object.keys(headerMapping).forEach((k) => {
        norm[String(k).trim().toLowerCase()] = headerMapping[k];
      });
      headerMapping = norm;
    }
    const fmt = format || (src.trim().charAt(0) === "[" || src.trim().charAt(0) === "{" ? "json" : "csv");
    if (fmt === "json") {
      let data;
      try { data = JSON.parse(src); }
      catch (e) { return { rows: [], headers: [], error: "not valid JSON: " + e.message }; }
      if (!Array.isArray(data)) return { rows: [], headers: [], error: "JSON import must be an ARRAY of ticket objects" };
      const rows = data.map((obj, i) => {
        const out = {};
        if (obj && typeof obj === "object") {
          Object.keys(obj).forEach((k) => {
            const f = canonicalField(k);
            if (f) out[f] = obj[k];
          });
        }
        return { line: i + 1, data: out };
      });
      return { rows: rows, headers: [], error: null };
    }
    const parsed = parseCsvCells(src);
    if (parsed.unterminated) return { rows: [], headers: [], error: "unterminated quoted cell — check for a stray \" in the file" };
    if (!parsed.rows.length) return { rows: [], headers: [], error: "empty CSV — a header row with field keys is required" };
    const headers = parsed.rows[0].cells.map((raw) => ({
      raw: String(raw == null ? "" : raw).trim(),
      field: resolveHeader(raw, headerMapping)
    }));
    const rows = parsed.rows.slice(1).map((r) => {
      const out = {};
      headers.forEach((h, i) => { if (h.field) out[h.field] = r.cells[i] != null ? r.cells[i] : ""; });
      return { line: r.line, data: out };
    });
    return { rows: rows, headers: headers, error: null };
  }

  // ---- planning ---------------------------------------------------------------

  function lc(s) { return String(s == null ? "" : s).trim().toLowerCase(); }

  /** Resolution maps from the snapshot: name OR id → id (SM-260 ref-field convention). */
  function buildResolution(snapshot) {
    const proj = (snapshot && snapshot.project) || {};
    const res = { release: new Map(), processStep: new Map(), epic: new Map(), byKey: new Map(), epicOfStory: new Map() };
    ((snapshot && snapshot.releases) || []).filter((r) => !r.isDeleted).forEach((r) => {
      res.release.set(lc(r.id), r.id); res.release.set(lc(r.name), r.id);
    });
    ((snapshot && snapshot.processSteps) || []).filter((p) => !p.isDeleted).forEach((p) => {
      res.processStep.set(lc(p.id), p.id); res.processStep.set(lc(p.name), p.id);
    });
    const tickets = ((snapshot && snapshot.tickets) || []).filter((t) => !t.isDeleted);
    tickets.forEach((t) => {
      res.byKey.set(lc(t.ticketKey), t);
      if (t.type === "epic") { res.epic.set(lc(t.ticketKey), t.id); res.epic.set(lc(t.id), t.id); }
    });
    // containment: contains-links live on the EPIC (SM-52: position.epicId is dead)
    tickets.forEach((t) => {
      if (t.type !== "epic") return;
      (t.links || []).forEach((l) => {
        if (l && l.linkTypeId === "contains") res.epicOfStory.set(l.targetTicketId, t.id);
      });
    });
    // Map lc → CANONICAL id (like every other enum/ref field): 'Bug' must
    // plan as 'bug', not carry its casing into type-sensitive downstream
    // comparisons (review finding on da889f1).
    res.types = new Map((proj.ticketTypes || []).map((t) => [lc(t), t]));
    res.statuses = new Map();
    (((proj.workflow || {}).statuses) || []).forEach((s) => {
      const id = s && typeof s === "object" ? s.id : s;
      const name = s && typeof s === "object" ? s.name : s;
      res.statuses.set(lc(id), id); res.statuses.set(lc(name), id);
    });
    return res;
  }

  /** CSV empty string / JSON null-undefined → absent. */
  function present(v) {
    if (v == null) return false;
    if (typeof v === "string") return v.trim() !== "";
    return true;
  }

  function asLabels(v) {
    if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
    return String(v).split(",").map((x) => x.trim()).filter(Boolean);
  }

  /**
   * Classify rows → { creates: [{line, ticket}], updates: [{line, ticketId,
   * ticketKey, patch}], errors: [{line, field?, message}] }. Pure.
   */
  function planTicketImport(snapshot, rows, mode, opts) {
    const m = TICKET_IMPORT.MODES.indexOf(mode) >= 0 ? mode : "create-only";
    const res = buildResolution(snapshot);
    // SM-297: normalize valueMapping keys once ({field: {lcValue → target|null}}).
    const rawVm = (opts && opts.valueMapping) || null;
    const vm = {};
    if (rawVm && typeof rawVm === "object") {
      Object.keys(rawVm).forEach((field) => {
        const entries = rawVm[field];
        if (!entries || typeof entries !== "object") return;
        const norm = {};
        Object.keys(entries).forEach((k) => { norm[lc(k)] = entries[k]; });
        vm[field] = norm;
      });
    }
    const unknownSeen = { status: new Map(), type: new Map(), release: new Map(), processStep: new Map() };
    const plan = { creates: [], updates: [], errors: [], unknownValues: {} };

    // SM-297 resolution precedence per enum/ref value:
    // explicit valueMapping (null = drop the field) → direct name/id hit →
    // FOREIGN_VALUE_ALIASES heuristic (only if its target resolves).
    // → { id } | { ignored: true } | null (unknown).
    function recordUnknown(field, rawVal) {
      const key = lc(rawVal);
      if (unknownSeen[field] && !unknownSeen[field].has(key)) unknownSeen[field].set(key, String(rawVal).trim());
    }

    function resolveValue(field, rawVal, resolveFn) {
      const lcv = lc(rawVal);
      if (vm[field] && hasOwn.call(vm[field], lcv)) {
        const t = vm[field][lcv];
        if (t == null || String(t).trim() === "") return { ignored: true };
        const viaMap = resolveFn(lc(t));
        if (viaMap) return { id: viaMap };
        // Mapped onto a target that (no longer) exists — e.g. a persisted
        // mapping after a release rename. The SOURCE value must land in
        // unknownValues so the dialog's panel reappears and the user can
        // re-map (self-healing; review finding on 2a40a63).
        recordUnknown(field, rawVal);
        return { badTarget: String(t) };
      }
      const direct = resolveFn(lcv);
      if (direct) return { id: direct };
      const aliases = TICKET_IMPORT.FOREIGN_VALUE_ALIASES[field];
      if (aliases && hasOwn.call(aliases, lcv)) {
        const viaAlias = resolveFn(lc(aliases[lcv]));
        if (viaAlias) return { id: viaAlias };
      }
      recordUnknown(field, rawVal);
      return null;
    }

    const FIELD_LABEL = { status: "status", type: "ticket type", release: "release", processStep: "process step" };

    // Shared error wording: a bad mapping TARGET is named as such — 'unknown
    // release: Sprint 1' would point at the (known, mapped) source.
    function applyEnum(field, rawVal, resolveFn, onId, errs, line) {
      const r = resolveValue(field, rawVal, resolveFn);
      if (r && r.id) { onId(r.id); return; }
      if (r && r.ignored) return;
      const src = String(rawVal).trim();
      if (r && r.badTarget != null) {
        errs.push({ line: line, field: field,
          message: 'mapping target not found: "' + r.badTarget + '" (for "' + src + '")', value: src });
      } else {
        errs.push({ line: line, field: field, message: "unknown " + FIELD_LABEL[field] + ": " + src, value: src });
      }
    }

    (rows || []).forEach((row) => {
      const d = (row && row.data) || {};
      const line = row && row.line;
      const errs = [];
      const fail = (field, message, value) => errs.push({ line: line, field: field, message: message, value: value });

      // resolve shared ref/enum fields once
      let releaseId, processStepId, epicId, status, type;
      if (present(d.release)) applyEnum("release", d.release, (v) => res.release.get(v), (id) => { releaseId = id; }, errs, line);
      if (present(d.processStep)) applyEnum("processStep", d.processStep, (v) => res.processStep.get(v), (id) => { processStepId = id; }, errs, line);
      if (present(d.epic)) {
        epicId = res.epic.get(lc(d.epic));
        if (!epicId) fail("epic", "unknown epic: " + d.epic, String(d.epic).trim());
      }
      if (present(d.status)) applyEnum("status", d.status, (v) => res.statuses.get(v), (id) => { status = id; }, errs, line);
      if (present(d.type)) applyEnum("type", d.type, (v) => res.types.get(v), (id) => { type = id; }, errs, line);

      const existing = present(d.key) ? res.byKey.get(lc(d.key)) : null;

      if (existing && m === "create-only") {
        // The conflict IS the row's verdict — don't pile create-validation
        // errors (missing type etc.) on top of it.
        fail("key", "ticket key already exists (mode create-only): " + d.key);
        plan.errors.push.apply(plan.errors, errs);
        return;
      }

      if (existing && m === "upsert") {
        // UPDATE: patch only the present columns, and DIFF OUT values equal
        // to the current ticket — a straight re-import of the SM-285 export
        // must plan as no-op patches, not as writes (review finding: epics
        // export their DERIVED status; an equal-value status patch would
        // throw EPIC_STATUS_DERIVED at apply time).
        const patch = {};
        if (present(d.title) && String(d.title).trim() !== existing.title) patch.title = String(d.title).trim();
        if (present(d.description) && String(d.description) !== (existing.description || "")) patch.description = String(d.description);
        if (status && status !== existing.status) {
          if (existing.type === "epic" && !(type && type !== "epic")) {
            fail("status", "epic status is derived from its stories — move them instead (SM-237)");
          } else {
            patch.status = status;
          }
        }
        if (type && type !== existing.type) patch.type = type;
        if (present(d.labels)) {
          const labels = asLabels(d.labels);
          if (JSON.stringify(labels) !== JSON.stringify(existing.labels || [])) patch.labels = labels;
        }
        const curPos = existing.position || {};
        const pos = {};
        if (releaseId && releaseId !== curPos.releaseId) pos.releaseId = releaseId;
        if (processStepId && processStepId !== curPos.processStepId) pos.processStepId = processStepId;
        if (Object.keys(pos).length) {
          // SM-67: a CONTAINED story inherits release/processStep from its
          // epic — updateTicket would silently revert this patch. Flag it at
          // plan time instead of showing a change that will not stick.
          if (res.epicOfStory.get(existing.id)) {
            fail(pos.releaseId ? "release" : "processStep",
              "contained story follows its epic's release/process step (SM-67) — move the epic instead");
          } else {
            patch.position = pos;
          }
        }
        if (epicId) {
          // v1: the import cannot REASSIGN containment (that is link surgery,
          // not a field patch). Equal values pass silently so the SM-285 CSV
          // export round-trips; different values are an explicit error.
          const current = res.epicOfStory.get(existing.id) || null;
          if (current !== epicId) fail("epic", "epic reassignment is not supported by import (use ticket links): " + d.epic);
        }
        if (errs.length) { plan.errors.push.apply(plan.errors, errs); return; }
        plan.updates.push({ line: line, ticketId: existing.id, ticketKey: existing.ticketKey, patch: patch });
        return;
      }

      // CREATE (no key, unknown key, or create-only without conflicts)
      if (!present(d.title)) fail("title", "title is required");
      // required against the RESOLVED type: absent column, ignored-by-mapping
      // and empty cell all end here; an unknown value already carries its
      // own error (no double-report).
      if (!type && !errs.some((e) => e.field === "type")) fail("type", "type is required");
      if (epicId && type === "epic") fail("epic", "an epic cannot be contained in another epic");
      if (errs.length) { plan.errors.push.apply(plan.errors, errs); return; }
      const ticket = { type: type, title: String(d.title).trim() };
      if (present(d.description)) ticket.description = String(d.description);
      if (status) ticket.status = status;
      if (present(d.labels)) ticket.labels = asLabels(d.labels);
      const pos = {};
      if (releaseId) pos.releaseId = releaseId;
      if (processStepId) pos.processStepId = processStepId;
      ticket.position = pos;
      if (epicId) ticket.epicId = epicId;
      plan.creates.push({ line: line, ticket: ticket });
    });

    // SM-297: distinct unresolved values per field (original casing) — the
    // base for the dialog's value-mapping panel and the MCP dryRun response.
    Object.keys(unknownSeen).forEach((field) => {
      if (unknownSeen[field].size) plan.unknownValues[field] = Array.from(unknownSeen[field].values());
    });

    return plan;
  }

  /**
   * SM-290: apply a plan via core.ops — PURE (returns next snapshot +
   * counts, input untouched). Shared by the browser dialog (which commits
   * once via store.applySnapshot) and the MCP import_tickets tool (which
   * persists once via storage.mutate — one revision either way).
   *
   * Creates pass ticket.epicId through position.epicId: createTicket's
   * explicit-parent path enforces the single-parent invariant, applies the
   * SM-67 inheritance and suppresses the E9b cell auto-assign. Diffed-out
   * empty update patches are skipped (not counted, not written).
   */
  function applyImportPlan(snapshot, plan, actor) {
    if (!core) throw new Error("ticket-import: core module missing (applyImportPlan)");
    let snap = snapshot;
    let created = 0, updated = 0;
    (plan.creates || []).forEach((c) => {
      const pos = Object.assign({}, c.ticket.position || {});
      if (c.ticket.epicId) pos.epicId = c.ticket.epicId;
      const partial = {
        type: c.ticket.type,
        title: c.ticket.title,
        description: c.ticket.description,
        status: c.ticket.status,
        labels: c.ticket.labels,
        position: pos,
      };
      snap = core.ops.createTicket(snap, partial, actor);
      created++;
    });
    (plan.updates || []).forEach((u) => {
      if (!u.patch || !Object.keys(u.patch).length) return;   // diffed-out no-op rows
      snap = core.ops.updateTicket(snap, u.ticketId, u.patch, actor);
      updated++;
    });
    return { snapshot: snap, created: created, updated: updated };
  }

  return {
    TICKET_IMPORT: TICKET_IMPORT,
    parseTicketImport: parseTicketImport,
    planTicketImport: planTicketImport,
    applyImportPlan: applyImportPlan,
    _parseCsvCells: parseCsvCells,
  };
}));
