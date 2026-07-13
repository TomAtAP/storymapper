/**
 * SM-15 — Project Export / Import (JSON).
 *
 * Pure, UMD-wrapped helpers for serializing a project snapshot to a JSON
 * export envelope and parsing/validating an uploaded file back into a
 * snapshot. The browser glue (Blob download, <input type=file>, the
 * overwrite-vs-copy dialog and the POST/PUT calls) lives in main.js — these
 * functions carry the logic that's worth unit-testing in isolation.
 *
 * Export envelope:
 *   { format: "storymap-project", version: 1, exportedAt?: ISO, snapshot: {...} }
 *
 * Import is lenient: it accepts the envelope OR a bare snapshot (so a file
 * pulled straight from GET /api/projects/:id also imports).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    (root.STORYMAP = root.STORYMAP || {}).projectIO = factory();
  }
}(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const FORMAT = "storymap-project";
  const VERSION = 1;

  /**
   * Serialize a snapshot into the on-disk export envelope (pretty JSON string).
   * `opts.exportedAt` (ISO string) is included when supplied — kept as a param
   * so the function stays pure/deterministic for tests.
   */
  function serializeProject(snapshot, opts) {
    opts = opts || {};
    const env = { format: FORMAT, version: VERSION };
    if (opts.exportedAt) env.exportedAt = opts.exportedAt;
    env.snapshot = snapshot;
    return JSON.stringify(env, null, 2);
  }

  /** Suggested download filename for a snapshot: `<sanitized-id>.storymap.json`. */
  function exportFilename(snapshot) {
    const id = (snapshot && snapshot.project && snapshot.project.id) || "project";
    return String(id).replace(/[^a-zA-Z0-9_-]/g, "_") + ".storymap.json";
  }

  /**
   * Parse + validate imported text. Accepts the export envelope OR a bare
   * snapshot; returns the snapshot. Throws Error with a human message on bad
   * input (caller surfaces it via flashStatus).
   */
  function parseImport(text) {
    let data;
    try { data = JSON.parse(text); }
    catch (e) { throw new Error("not valid JSON: " + e.message); }
    if (!data || typeof data !== "object") throw new Error("file is not a JSON object");
    const snap = (data.format === FORMAT || data.snapshot) ? data.snapshot : data;
    if (!snap || typeof snap !== "object") throw new Error("no snapshot found in file");
    if (!snap.project || typeof snap.project !== "object"
        || typeof snap.project.id !== "string" || !snap.project.id) {
      throw new Error("snapshot has no project.id");
    }
    for (const k of ["tickets", "releases", "processSteps"]) {
      if (snap[k] != null && !Array.isArray(snap[k])) {
        throw new Error(k + " must be an array");
      }
    }
    return snap;
  }

  /** Derive a unique `<base>-copy[-N]` id given the set of existing ids. */
  function suggestCopyId(baseId, existingIds) {
    const taken = new Set(existingIds || []);
    if (!taken.has(baseId + "-copy")) return baseId + "-copy";
    let n = 2;
    while (taken.has(baseId + "-copy-" + n)) n++;
    return baseId + "-copy-" + n;
  }

  /**
   * Decide the import plan. mode ∈ "overwrite" | "copy".
   * Returns { targetId, isOverwrite, conflict }.
   *   - no conflict           → import under the original id (create)
   *   - conflict + "overwrite" → replace the existing project
   *   - conflict + "copy"      → import under a fresh `<id>-copy` id
   */
  function planImport(snapshot, existingIds, mode) {
    const id = snapshot.project.id;
    const conflict = (existingIds || []).indexOf(id) >= 0;
    if (conflict && mode === "copy") {
      return { targetId: suggestCopyId(id, existingIds), isOverwrite: false, conflict: true };
    }
    return { targetId: id, isOverwrite: conflict, conflict: conflict };
  }

  /** Deep clone of the snapshot with project.id re-pinned to `targetId`. */
  function withProjectId(snapshot, targetId) {
    const next = JSON.parse(JSON.stringify(snapshot));
    next.project = next.project || {};
    next.project.id = targetId;
    return next;
  }

  return {
    FORMAT, VERSION,
    serializeProject, exportFilename, parseImport,
    suggestCopyId, planImport, withProjectId
  };
}));
