"use strict";

/**
 * SQLite-backed storage for storymap projects.
 *
 * The snapshot is the canonical data form: a single JSON blob per project,
 * stored in the `projects` table. Every save appends a row to `revisions`
 * with the full snapshot + actor + op tag, monotonically-sortable revision
 * IDs (UTC timestamp + collision counter).
 *
 * Per-project mutex ensures concurrent saves serialise → unique revision
 * IDs and predictable revision history.
 *
 * Storage API (async):
 *   init()
 *   listProjects()                                      → string[]
 *   loadProject(projectId)                              → snapshot | null
 *   saveProject(projectId, snapshot, { actor, op })     → { revision, savedAt, snapshot }
 *   deleteProject(projectId, { actor })                 → void
 *   listRevisions(projectId, { limit?, beforeRevision? }) → [{ revision, savedAt, op, actor }]
 *       (SM-212: SQL LIMIT, default 100, newest first; beforeRevision pages older)
 *   getRevision(projectId, revision)                    → { revision, savedAt, snapshot }
 *   restoreRevision(projectId, revision, { actor })     → { revision, savedAt, snapshot }
 *   remove(projectId)                                   → void  (hard delete + cascade)
 *   close()
 */

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const bus = require("./bus.js");
const core = require("./core.js");
const identity = require("./identity.js");

const PROJECT_ID_RE = /^[a-zA-Z0-9_-]{1,100}$/;

function validProjectId(id) {
  return typeof id === "string" && PROJECT_ID_RE.test(id);
}

// --- Revision retention (SM-212) --------------------------------------------
// One full snapshot per (debounced) save grows the revisions table without
// bound. On every Nth save — inside the SAME write transaction — revisions
// beyond the newest KEEP_MIN_REVISIONS_PER_PROJECT window are deleted.
// Retention is purely COUNT-based (no age component): with many iterations per
// day an age guard never fires, so a hard per-project cap is what keeps the DB
// bounded (an unbounded history grew a single DB to ~1.8 GB before this cap).
// The History UI + restore keep working for any realistic look-back.
// Tests may override per-instance via `new Storage(dir, { retention: {...} })`.
const RETENTION = {
  KEEP_MIN_REVISIONS_PER_PROJECT: 150,           // newest N per project survive; older are pruned
  PRUNE_EVERY_N_SAVES: 50,                       // prune cadence per project
  LIST_DEFAULT_LIMIT: 100,                       // listRevisions default page
  LIST_MAX_LIMIT: 1000                           // listRevisions hard cap
};

// --- Attachments (SM-183) ---------------------------------------------------
// Binary reference docs live on disk NEXT TO the DB (never as SQLite blobs);
// the `attachments` row carries metadata + the relative path.
const ATTACHMENT_LIMITS = {
  MAX_BYTES: 25 * 1024 * 1024   // 25 MB hard cap per file
};
function safeAttachmentName(name) {
  const base = String(name || "file")
    .replace(/[\\/]/g, "_")        // no path separators
    .replace(/[^\w.\- ]+/g, "_")   // collapse anything exotic
    .trim();
  return base.length ? base.slice(0, 200) : "file";
}
function _safeParseJson(s) { try { return JSON.parse(s); } catch (_) { return null; } }
function attachmentRowToMeta(r) {
  return {
    id: r.id, projectId: r.project_id, ticketId: r.ticket_id || null,
    filename: r.filename, mimeType: r.mime_type, size: r.size,
    uploadedAt: r.uploaded_at,
    uploadedBy: r.uploaded_by ? _safeParseJson(r.uploaded_by) : null
  };
}

// --- Revision IDs -----------------------------------------------------------

function pad(n, w) {
  const s = String(n);
  return s.length >= w ? s : "0".repeat(w - s.length) + s;
}

function utcStamp(d) {
  return (
    pad(d.getUTCFullYear(), 4) +
    pad(d.getUTCMonth() + 1, 2) +
    pad(d.getUTCDate(), 2) + "-" +
    pad(d.getUTCHours(), 2) +
    pad(d.getUTCMinutes(), 2) +
    pad(d.getUTCSeconds(), 2) + "-" +
    pad(d.getUTCMilliseconds(), 3)
  );
}

// Max re-mint attempts when a revision id collides on the (project_id,
// revision) PRIMARY KEY. Collisions only happen across PROCESSES (two
// RevisionMinters producing the same id in the same millisecond); the minter's
// collision counter makes each retry strictly different, so a handful suffices.
const WRITE_MAX_RETRIES = 5;

function isRevisionCollision(e) {
  return !!e && (
    e.code === "SQLITE_CONSTRAINT_PRIMARYKEY" ||
    (typeof e.message === "string" && /UNIQUE constraint failed: revisions/.test(e.message))
  );
}

class RevisionMinter {
  constructor() {
    this._last = "";
    this._collisionCounter = 0;
  }
  next() {
    const stamp = utcStamp(new Date());
    // Monotonic high-water mark: if the clock did not advance (same ms) OR
    // moved backward (NTP correction, VM resume), keep `_last` and disambiguate
    // with a counter so revision ids stay strictly increasing and never collide
    // on the (project_id, revision) PRIMARY KEY. (SM-149)
    if (stamp <= this._last) {
      this._collisionCounter++;
      return this._last + "-" + pad(this._collisionCounter, 4);
    }
    this._last = stamp;
    this._collisionCounter = 0;
    return stamp;
  }
}

// --- Per-key mutex (in-memory) ---------------------------------------------

class KeyedMutex {
  constructor() { this._chains = new Map(); }
  run(key, fn) {
    const prev = this._chains.get(key) || Promise.resolve();
    const next = prev.then(fn, fn);  // run fn even after a prior rejection
    // Replace chain; clean up when done so the map doesn't grow unbounded.
    this._chains.set(key, next);
    const cleanup = () => {
      if (this._chains.get(key) === next) this._chains.delete(key);
    };
    next.then(cleanup, cleanup);
    return next;
  }
}

// --- Storage ---------------------------------------------------------------

class Storage {
  constructor(dataDir, opts) {
    if (!dataDir) throw new Error("Storage: dataDir is required");
    this._dataDir = dataDir;
    this._db = null;
    this._minter = new RevisionMinter();
    this._mutex = new KeyedMutex();
    // SM-212: per-instance retention override (tests); defaults from RETENTION.
    this._retention = Object.assign({}, RETENTION, (opts && opts.retention) || {});
    this._saveCounts = new Map();   // projectId → saves since last prune check
  }

  async init() {
    fs.mkdirSync(this._dataDir, { recursive: true });
    const dbPath = path.join(this._dataDir, "storymap.sqlite");
    this._db = new Database(dbPath);
    this._db.pragma("journal_mode = WAL");
    this._db.pragma("foreign_keys = ON");
    // A second process may share this data-dir (the MCP server alongside the
    // HTTP server, per the request_switch_project workflow). WAL permits only
    // one writer at a time; without busy_timeout the second writer throws
    // SQLITE_BUSY immediately. Wait up to 5s for the lock instead of failing.
    this._db.pragma("busy_timeout = 5000");
    this._initSchema();
  }

  _initSchema() {
    const sql = `
      CREATE TABLE IF NOT EXISTS projects (
        id          TEXT PRIMARY KEY,
        snapshot    TEXT NOT NULL,
        saved_at    INTEGER NOT NULL,
        revision    TEXT NOT NULL,
        is_deleted  INTEGER NOT NULL DEFAULT 0,
        deleted_at  INTEGER,
        deleted_by  TEXT
      );
      CREATE TABLE IF NOT EXISTS revisions (
        project_id  TEXT NOT NULL,
        revision    TEXT NOT NULL,
        snapshot    TEXT NOT NULL,
        saved_at    INTEGER NOT NULL,
        op          TEXT,
        actor       TEXT,
        PRIMARY KEY (project_id, revision),
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_revisions_project_saved_at
        ON revisions (project_id, saved_at DESC);
      CREATE TABLE IF NOT EXISTS attachments (
        id          TEXT PRIMARY KEY,
        project_id  TEXT NOT NULL,
        ticket_id   TEXT,
        filename    TEXT NOT NULL,
        mime_type   TEXT NOT NULL,
        size        INTEGER NOT NULL,
        rel_path    TEXT NOT NULL,
        uploaded_at INTEGER NOT NULL,
        uploaded_by TEXT,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_attachments_project ON attachments (project_id);
      CREATE INDEX IF NOT EXISTS idx_attachments_ticket  ON attachments (project_id, ticket_id);
    `;
    this._db.exec(sql);
  }

  close() {
    if (this._db) {
      try { this._db.close(); } catch (_) { /* ignore */ }
      this._db = null;
    }
  }

  // ---- Public API --------------------------------------------------------

  async listProjects() {
    const rows = this._db.prepare(
      "SELECT id FROM projects WHERE is_deleted = 0 ORDER BY id"
    ).all();
    return rows.map(r => r.id);
  }

  async loadProject(projectId) {
    if (!validProjectId(projectId)) return null;
    const row = this._db.prepare(
      "SELECT snapshot FROM projects WHERE id = ? AND is_deleted = 0"
    ).get(projectId);
    if (!row) return null;
    return JSON.parse(row.snapshot);
  }

  async saveProject(projectId, snapshot, opts) {
    if (!validProjectId(projectId)) {
      throw new Error("invalid project id: " + JSON.stringify(projectId));
    }
    opts = opts || {};
    const op = typeof opts.op === "string" ? opts.op : "save";
    const actor = core.normalizeActor(opts.actor);
    const originId = typeof opts.originId === "string" ? opts.originId : null;
    return this._mutex.run(projectId,
      () => this._writeLocked(projectId, snapshot, op, actor, originId));
  }

  /**
   * SM-149 — atomic read-modify-write. Loads the current snapshot, runs
   * `mutateFn(current) → next`, and writes it, ALL inside one mutex acquisition
   * for the project. Eliminates the lost-update window that a separate
   * loadProject()→saveProject() pair has when two writers interleave in the
   * same process. `mutateFn` may be async and may throw (statusCode preserved).
   */
  async mutate(projectId, opts, mutateFn) {
    if (!validProjectId(projectId)) throw new Error("invalid project id");
    opts = opts || {};
    const op = typeof opts.op === "string" ? opts.op : "save";
    const actor = core.normalizeActor(opts.actor);
    const originId = typeof opts.originId === "string" ? opts.originId : null;
    return this._mutex.run(projectId, async () => {
      const row = this._db.prepare(
        "SELECT snapshot FROM projects WHERE id = ? AND is_deleted = 0"
      ).get(projectId);
      const current = row ? JSON.parse(row.snapshot) : null;
      if (!current) {
        throw Object.assign(new Error("project not found: " + projectId), { statusCode: 404 });
      }
      const next = await mutateFn(current);
      return this._writeLocked(projectId, next, op, actor, originId);
    });
  }

  // Unsynchronized write — callers MUST already hold the per-project mutex
  // (saveProject + mutate wrap this). Never call directly.
  _writeLocked(projectId, snapshot, op, actor, originId) {
    const normalized = core.normalizeSnapshot(snapshot);
    // Force project.id to match the storage key.
    normalized.project.id = projectId;
    // SM-129: single write-authorization choke-point. No-op by default;
    // RBAC plugs in via identity.setAuthorizePolicy. A denial throws
    // { statusCode: 403 } and aborts the save before any DB write.
    identity.authorize(actor, op, { projectId, snapshot: normalized });
    const savedAt = Date.now();
    const json = JSON.stringify(normalized);
    const actorJson = JSON.stringify(actor);

    const writeOnce = (revision) => this._db.transaction(() => {
      const upsert = this._db.prepare(`
        INSERT INTO projects (id, snapshot, saved_at, revision, is_deleted, deleted_at, deleted_by)
        VALUES (?, ?, ?, ?, 0, NULL, NULL)
        ON CONFLICT(id) DO UPDATE SET
          snapshot = excluded.snapshot,
          saved_at = excluded.saved_at,
          revision = excluded.revision,
          is_deleted = 0,
          deleted_at = NULL,
          deleted_by = NULL
      `);
      upsert.run(projectId, json, savedAt, revision);
      this._db.prepare(`
        INSERT INTO revisions (project_id, revision, snapshot, saved_at, op, actor)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(projectId, revision, json, savedAt, op, actorJson);
      this._maybePrune(projectId, savedAt);
    });

    // Re-mint + retry on a cross-process revision-id collision (see
    // WRITE_MAX_RETRIES). The whole insert is one transaction, so a collided
    // attempt rolls back cleanly before the next id is tried.
    let revision;
    for (let attempt = 0; ; attempt++) {
      revision = this._minter.next();
      try { writeOnce(revision)(); break; }
      catch (e) {
        if (isRevisionCollision(e) && attempt < WRITE_MAX_RETRIES) continue;
        throw e;
      }
    }

    const result = { revision, savedAt, snapshot: normalized };
    bus.emit("change", { projectId, revision, savedAt, op, actor, originId });
    return result;
  }

  async deleteProject(projectId, opts) {
    if (!validProjectId(projectId)) throw new Error("invalid project id");
    opts = opts || {};
    const actor = core.normalizeActor(opts.actor);
    return this._mutex.run(projectId, async () => {
      // SM-129: deletes flow through the same authorization choke-point.
      identity.authorize(actor, "project_delete", { projectId });
      const deletedAt = Date.now();
      const r = this._db.prepare(
        "UPDATE projects SET is_deleted = 1, deleted_at = ?, deleted_by = ? WHERE id = ?"
      ).run(deletedAt, JSON.stringify(actor), projectId);
      if (r.changes > 0) {
        bus.emit("change", {
          projectId, revision: null, savedAt: deletedAt, op: "project_delete", actor
        });
      }
    });
  }

  // SM-212: prune inside the write transaction every Nth save. Purely
  // count-based — every revision outside the newest-N window (by revision id,
  // which is a zero-padded UTC timestamp, so string order IS time order) is
  // deleted. The newest N (incl. the latest) always survive. Callers hold the
  // per-project mutex via _writeLocked.
  _maybePrune(projectId, _savedAt) {
    const r = this._retention;
    const count = (this._saveCounts.get(projectId) || 0) + 1;
    if (count < r.PRUNE_EVERY_N_SAVES) {
      this._saveCounts.set(projectId, count);
      return;
    }
    this._saveCounts.set(projectId, 0);
    this._db.prepare(`
      DELETE FROM revisions
      WHERE project_id = ?
        AND revision NOT IN (
          SELECT revision FROM revisions
          WHERE project_id = ?
          ORDER BY revision DESC
          LIMIT ?
        )
    `).run(projectId, projectId, r.KEEP_MIN_REVISIONS_PER_PROJECT);
  }

  // SM-212: real SQL LIMIT + beforeRevision cursor — no select-all + JS slice.
  // Revision ids are zero-padded UTC timestamps, so string order IS time order.
  async listRevisions(projectId, opts) {
    if (!validProjectId(projectId)) return [];
    opts = opts || {};
    const ret = this._retention;
    const rawLimit = Number.isFinite(opts.limit) ? Math.floor(opts.limit) : ret.LIST_DEFAULT_LIMIT;
    const limit = Math.max(1, Math.min(ret.LIST_MAX_LIMIT, rawLimit));
    const before = typeof opts.beforeRevision === "string" && opts.beforeRevision ? opts.beforeRevision : null;
    const rows = before
      ? this._db.prepare(`
          SELECT revision, saved_at AS savedAt, op, actor
          FROM revisions
          WHERE project_id = ? AND revision < ?
          ORDER BY revision DESC
          LIMIT ?
        `).all(projectId, before, limit)
      : this._db.prepare(`
          SELECT revision, saved_at AS savedAt, op, actor
          FROM revisions
          WHERE project_id = ?
          ORDER BY revision DESC
          LIMIT ?
        `).all(projectId, limit);
    return rows.map(r => ({
      revision: r.revision,
      savedAt: r.savedAt,
      op: r.op,
      actor: r.actor ? JSON.parse(r.actor) : null
    }));
  }

  async getRevision(projectId, revision) {
    if (!validProjectId(projectId)) return null;
    const row = this._db.prepare(`
      SELECT revision, snapshot, saved_at AS savedAt
      FROM revisions
      WHERE project_id = ? AND revision = ?
    `).get(projectId, revision);
    if (!row) return null;
    return {
      revision: row.revision,
      savedAt: row.savedAt,
      snapshot: JSON.parse(row.snapshot)
    };
  }

  async restoreRevision(projectId, revision, opts) {
    const r = await this.getRevision(projectId, revision);
    if (!r) throw new Error("revision not found: " + revision);
    return this.saveProject(projectId, r.snapshot, {
      // Never freshly mint an "unknown" actor on a write path (identity seam
      // invariant). Fall back to the known default transport. (SM-149)
      actor: (opts && opts.actor) || identity.DEFAULT_HTTP_ACTOR,
      op: "project_restore"
    });
  }

  async remove(projectId) {
    if (!validProjectId(projectId)) throw new Error("invalid project id");
    return this._mutex.run(projectId, async () => {
      let changed = 0;
      const txn = this._db.transaction(() => {
        // CASCADE removes revisions automatically thanks to FK.
        const r = this._db.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
        changed = r.changes;
      });
      txn();
      // Only broadcast if a row was actually deleted (mirror deleteProject) —
      // a no-op remove must not spam connected browsers. (SM-149)
      if (changed > 0) {
        // SM-183: the FK cascade drops attachment ROWS; the FILES on disk are
        // separate — remove the project's whole attachments dir too.
        try { fs.rmSync(path.join(this._attachmentsRoot(), projectId), { recursive: true, force: true }); }
        catch (_) { /* best-effort */ }
        bus.emit("change", {
          projectId, revision: null, savedAt: Date.now(), op: "project_remove", actor: null
        });
      }
    });
  }

  // --- Attachments (SM-183) -------------------------------------------------

  _attachmentsRoot() { return path.join(this._dataDir, "attachments"); }

  // Resolve a stored rel_path to an absolute path, asserting it stays under the
  // attachments root (defends against a tampered/garbage rel_path).
  _attachmentAbsPath(relPath) {
    const abs = path.resolve(this._dataDir, relPath);
    const root = path.resolve(this._attachmentsRoot());
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      throw Object.assign(new Error("attachment path escapes root"), { statusCode: 400 });
    }
    return abs;
  }

  async addAttachment(projectId, file, actor) {
    if (!validProjectId(projectId)) throw Object.assign(new Error("invalid project id"), { statusCode: 400 });
    const buf = file && file.buffer;
    if (!Buffer.isBuffer(buf) || buf.length === 0) {
      throw Object.assign(new Error("attachment body required"), { statusCode: 400 });
    }
    if (buf.length > ATTACHMENT_LIMITS.MAX_BYTES) {
      throw Object.assign(new Error("attachment too large (max " + ATTACHMENT_LIMITS.MAX_BYTES + " bytes)"), { statusCode: 413 });
    }
    return this._mutex.run(projectId, async () => {
      // FK requires the project row to exist — give a clean 404 instead of a
      // raw SQLite constraint error.
      const proj = this._db.prepare("SELECT id FROM projects WHERE id = ?").get(projectId);
      if (!proj) throw Object.assign(new Error("project not found: " + projectId), { statusCode: 404 });
      const id = "att-" + require("crypto").randomUUID();
      const safe = safeAttachmentName(file.filename);
      const relPath = path.join("attachments", projectId, id + "-" + safe);
      const absPath = this._attachmentAbsPath(relPath);
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      fs.writeFileSync(absPath, buf);
      const by = (actor && typeof actor === "object") ? actor : null;
      const meta = {
        id, projectId,
        // SM-194: "none" is the project-level LIST sentinel — it must never be
        // persisted as a literal ticket_id (else the row is orphaned: it shows
        // up in neither the project-level IS NULL list nor any real ticket's
        // list). Normalize "" and "none" to null here, the single write choke-point.
        ticketId: (file.ticketId != null && file.ticketId !== "" && file.ticketId !== "none") ? String(file.ticketId) : null,
        filename: safe,
        mimeType: (typeof file.mimeType === "string" && file.mimeType) ? file.mimeType : "application/octet-stream",
        size: buf.length, uploadedAt: Date.now(), uploadedBy: by
      };
      try {
        this._db.prepare(
          `INSERT INTO attachments
             (id, project_id, ticket_id, filename, mime_type, size, rel_path, uploaded_at, uploaded_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(id, projectId, meta.ticketId, meta.filename, meta.mimeType, meta.size, relPath, meta.uploadedAt,
              by ? JSON.stringify(by) : null);
      } catch (e) {
        // No orphan files: if the row insert fails, drop the bytes we just wrote.
        try { fs.rmSync(absPath, { force: true }); } catch (_) { /* best-effort */ }
        throw e;
      }
      bus.emit("change", {
        projectId, revision: null, savedAt: meta.uploadedAt, op: "attachment_add", actor: by, originId: null
      });
      return meta;
    });
  }

  async listAttachments(projectId, opts) {
    opts = opts || {};
    // Three scopes: a specific ticketId; the "none" sentinel = project-level
    // attachments only (ticket_id IS NULL, e.g. source PRDs, SM-194); or
    // unscoped = everything for the project.
    let rows;
    if (opts.ticketId === "none") {
      rows = this._db.prepare("SELECT * FROM attachments WHERE project_id = ? AND ticket_id IS NULL ORDER BY uploaded_at ASC").all(projectId);
    } else if (opts.ticketId != null && opts.ticketId !== "") {
      rows = this._db.prepare("SELECT * FROM attachments WHERE project_id = ? AND ticket_id = ? ORDER BY uploaded_at ASC").all(projectId, String(opts.ticketId));
    } else {
      rows = this._db.prepare("SELECT * FROM attachments WHERE project_id = ? ORDER BY uploaded_at ASC").all(projectId);
    }
    return rows.map(attachmentRowToMeta);
  }

  // Returns { ...meta, absPath } for streaming, or null if unknown.
  async getAttachment(attachmentId) {
    const row = this._db.prepare("SELECT * FROM attachments WHERE id = ?").get(attachmentId);
    if (!row) return null;
    return Object.assign(attachmentRowToMeta(row), { absPath: this._attachmentAbsPath(row.rel_path) });
  }

  async removeAttachment(attachmentId, actor) {
    const row = this._db.prepare("SELECT * FROM attachments WHERE id = ?").get(attachmentId);
    if (!row) return false;
    return this._mutex.run(row.project_id, async () => {
      try { fs.rmSync(this._attachmentAbsPath(row.rel_path), { force: true }); }
      catch (_) { /* file already gone — drop the row anyway */ }
      this._db.prepare("DELETE FROM attachments WHERE id = ?").run(attachmentId);
      const by = (actor && typeof actor === "object") ? actor : null;
      bus.emit("change", {
        projectId: row.project_id, revision: null, savedAt: Date.now(),
        op: "attachment_remove", actor: by, originId: null
      });
      return true;
    });
  }
}

module.exports = Storage;
// SM-183: single source for the size cap so the server route + the storage
// guard can't drift (Konstanten-Disziplin).
module.exports.ATTACHMENT_LIMITS = ATTACHMENT_LIMITS;
// SM-212: retention + listing-limit constants (tests reference these).
module.exports.RETENTION = RETENTION;
