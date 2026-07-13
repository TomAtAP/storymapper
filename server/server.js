"use strict";

/**
 * HTTP server (raw `http`, no framework).
 *
 * Routes are matched by URL.pathname against a handler table. Each
 * handler receives `(req, res, params, body)` and produces a response
 * via `writeJson(res, status, data)` / `writeError(res, status, msg)`.
 *
 * Mutating endpoints accept an optional `X-Origin-Id` header that is
 * forwarded to bus.emit("change", { ..., originId }) so a WS subscriber
 * can ignore echoes of its own writes.
 *
 * `startServer({port, dataDir})` returns
 *   { httpServer, storage, shutdown(): Promise<void> }
 *
 * The shutdown handler:
 *   1. stops accepting new connections,
 *   2. destroys tracked sockets (WS to come in E5),
 *   3. closes storage.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// E20.A: switch-response cache for the standalone-MCP cross-process bridge.
// Browsers send their accept/cancel verdict over WS; the WS handler caches
// it here AND fires `bus.emit("switch_response", ...)`. The long-poll route
// /api/internal/switch-response checks the cache first (race-safe: browser
// can answer BEFORE the MCP's poll starts) and falls through to a bus
// listener otherwise. 5-min TTL; entries are deleted on consume.
// ---------------------------------------------------------------------------
// SM-213: entries used to be deleted only on consume — never-consumed ones
// leaked forever in a long-running process. Now every insert sweeps expired
// entries and the map is hard-bounded (oldest evicted first; Map preserves
// insertion order).
const SWITCH_CACHE = {
  TTL_MS: 5 * 60 * 1000,
  MAX_ENTRIES: 200
};
const _switchResponseCache = new Map();   // requestId → { accepted, expiresAt }

function cacheSwitchResponse(requestId, accepted, ttlMs) {
  const now = Date.now();
  for (const [k, v] of _switchResponseCache) {
    if (v.expiresAt < now) _switchResponseCache.delete(k);
  }
  while (_switchResponseCache.size >= SWITCH_CACHE.MAX_ENTRIES) {
    const oldest = _switchResponseCache.keys().next().value;
    _switchResponseCache.delete(oldest);
  }
  const ttl = Number.isFinite(ttlMs) ? ttlMs : SWITCH_CACHE.TTL_MS;
  _switchResponseCache.set(requestId, { accepted, expiresAt: now + ttl });
}
function consumeSwitchResponse(requestId) {
  const entry = _switchResponseCache.get(requestId);
  if (!entry) return null;
  _switchResponseCache.delete(requestId);
  if (entry.expiresAt < Date.now()) return null;
  return { accepted: entry.accepted };
}
const { URL } = require("url");
const { WebSocketServer } = require("ws");
const core = require("./core.js");
const validation = require("./validation.js");
const Storage = require("./storage.js");
const bus = require("./bus.js");
const identity = require("./identity.js");
const ingest = require("./ingest.js");   // SM-203 R-7: attachment → Markdown
const slice = require("./slice.js");      // SM-203 R-7: Markdown → sections

const FRONTEND_DIR = path.resolve(__dirname, "..", "frontend");
// SM-213: realpath roots for the static-file jail. shared/ is whitelisted
// because frontend/js/core.js + core/graph.js are legit symlinks into it.
const REAL_FRONTEND_DIR = (() => { try { return fs.realpathSync(FRONTEND_DIR); } catch (_) { return FRONTEND_DIR; } })();
const REAL_SHARED_DIR = (() => {
  try { return fs.realpathSync(path.resolve(__dirname, "..", "shared")); } catch (_) { return null; }
})();
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".json": "application/json"
};

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

// SM-211: security-header policy. The server is a local single-user tool
// WITHOUT auth — CORS must therefore never be `*` (any website the user visits
// could read+write all projects via fetch). Contract:
//   - no Origin header (MCP / curl / tests) → request passes, no ACAO emitted
//   - loopback Origin                       → reflected verbatim + Vary: Origin
//   - foreign Origin (incl. "null" — file:// is deliberately unsupported)
//                                           → no ACAO; mutating methods → 403
// All values live here (Konstanten-Disziplin), applied once per request in
// applyRequestSecurity(); writeJson/writeStatus no longer touch CORS.
const SECURITY_HEADERS = {
  ALLOW_METHODS: "GET, POST, PUT, DELETE, OPTIONS",
  // Actor attribution (SM-129), origin echo-filter, Authorization reserved for
  // the deferred multi-user token gate, X-Base-Revision reserved for deferred
  // optimistic locking — listing them now keeps future preflights working.
  ALLOW_HEADERS: "Content-Type, X-Origin-Id, X-Actor-Type, X-Actor-Id, X-Actor-Name, X-Actor-Session, Authorization, X-Base-Revision",
  MAX_AGE: "86400",
  NOSNIFF: "nosniff",
  // CSP for served HTML. style-src needs 'unsafe-inline' (renderer-generated
  // style attributes) + the Google-Fonts stylesheet; connect-src allows the
  // ?api= cross-port mode against any loopback port (http + ws, incl. [::1]
  // — must stay symmetric with LOOPBACK_HOSTNAMES); frame-ancestors 'self'
  // stops foreign sites from iframing the auth-less UI (clickjacking).
  CSP: "default-src 'self'; script-src 'self'; " +
       "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
       "font-src https://fonts.gstatic.com; " +
       "connect-src 'self' http://localhost:* ws://localhost:* http://127.0.0.1:* ws://127.0.0.1:* http://[::1]:* ws://[::1]:*; " +
       "img-src 'self' data:; " +
       "frame-ancestors 'self'",
  FRAME_OPTIONS: "SAMEORIGIN"
};

/**
 * Apply per-request security headers (SM-211). Returns `{ foreign }` —
 * `foreign: true` means a browser context whose Origin is neither absent nor
 * loopback; the dispatcher rejects mutating methods for those.
 */
function applyRequestSecurity(req, res) {
  res.setHeader("X-Content-Type-Options", SECURITY_HEADERS.NOSNIFF);
  const origin = req.headers.origin;
  if (!origin) return { foreign: false };
  if (!originIsLocal(origin)) return { foreign: true };
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", SECURITY_HEADERS.ALLOW_METHODS);
  res.setHeader("Access-Control-Allow-Headers", SECURITY_HEADERS.ALLOW_HEADERS);
  res.setHeader("Access-Control-Max-Age", SECURITY_HEADERS.MAX_AGE);
  return { foreign: false };
}

function writeJson(res, status, data) {
  res.setHeader("Content-Type", "application/json");
  // API responses must never be cached — a reloadStore() after a mutation
  // needs to see the freshly persisted state, not a 304 from the browser.
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.statusCode = status;
  res.end(JSON.stringify(data));
}

function writeStatus(res, status) {
  res.statusCode = status;
  res.end();
}

function writeError(res, status, message, extras) {
  const body = Object.assign({ error: message }, extras || {});
  writeJson(res, status, body);
}

// --- security helpers (SM-147) -------------------------------------------
// The server is a local single-user tool. Two abuse vectors the review found:
//   (1) Cross-Site WebSocket Hijacking — any page the user visits can open
//       ws://localhost:<port>/ws (browsers don't apply same-origin to WS).
//   (2) Browser-origin forgery of the internal MCP bridge endpoints.
// Both are stopped by: legit non-browser callers (MCP, ws-lib, tests) send NO
// Origin header; the app's own page sends a loopback Origin; a malicious site
// sends its own cross-origin Origin. So "no Origin OR loopback Origin" is the
// allow rule, backed by a loopback remote-address check for /api/internal/*.

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function originIsLocal(origin) {
  if (!origin) return true;            // non-browser client (MCP / ws-lib / tests)
  let u;
  try { u = new URL(origin); } catch (_) { return false; }
  return LOOPBACK_HOSTNAMES.has(u.hostname);
}

function isLoopbackRemote(req) {
  const a = req.socket && req.socket.remoteAddress;
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
}

function readJsonBody(req, maxBytes) {
  const limit = maxBytes || 5 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on("data", (c) => {
      total += c.length;
      if (total > limit) {
        req.destroy();
        reject(Object.assign(new Error("body too large"), { statusCode: 413 }));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.length === 0) return resolve({});
      // SM-213: central prototype-pollution guard — keys that target the
      // prototype chain are dropped for every route in one place.
      // CAVEAT: user-defined ids used as object keys (ticket types, statuses
      // in definitions.byType / workflow.byType / entityTypeConfig) named
      // literally "constructor"/"prototype" would be silently stripped —
      // accepted: those names are pathological and the guard must stay dumb.
      const reviver = (key, value) =>
        (key === "__proto__" || key === "constructor" || key === "prototype") ? undefined : value;
      try { resolve(JSON.parse(raw, reviver)); }
      catch (e) { reject(Object.assign(new Error("invalid JSON: " + e.message), { statusCode: 400 })); }
    });
    req.on("error", reject);
  });
}

// SM-183: collect a raw binary request body (attachments upload). Unlike
// readJsonBody this keeps the bytes as a Buffer and does not parse.
function readRawBody(req, maxBytes) {
  const limit = maxBytes || (25 * 1024 * 1024);
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on("data", (c) => {
      total += c.length;
      if (total > limit) {
        req.destroy();
        reject(Object.assign(new Error("body too large"), { statusCode: 413 }));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function actorFromReq(req) {
  // SM-129: identity now lives in the shared seam. resolveActor reads the
  // X-Actor-* header convention (id/type/name/session) and falls back to the
  // generic HTTP actor for anonymous callers — never to "unknown". Token
  // verification plugs in here later without touching the routes.
  return identity.resolveActor(req);
}

function originIdFromReq(req) {
  const v = req.headers["x-origin-id"];
  return typeof v === "string" && v.length > 0 ? v : null;
}

// ---------------------------------------------------------------------------
// Persist-and-emit helper: every write goes load → mutate → save → respond.
// ---------------------------------------------------------------------------

async function persistChange(storage, projectId, op, mutate, opts) {
  // SM-154: run load → mutate → save atomically inside the storage mutex so
  // two concurrent REST writes to the same project can't lose each other's
  // change (the old loadProject()+saveProject() pair had a lost-update window).
  // storage.mutate throws { statusCode: 404 } when the project is absent —
  // same shape the explicit guard used to throw.
  return await storage.mutate(projectId, {
    // SM-129: never mint an ad-hoc "unknown" actor on a write path — fall
    // back to the generic HTTP actor from the identity seam.
    actor: (opts && opts.actor) || identity.DEFAULT_HTTP_ACTOR,
    op,
    originId: (opts && opts.originId) || null
  }, (current) => {
    const next = mutate(current);
    validation.snapshotLimits(next);
    return next;
  });
}

function findEntity(snap, kind, id) {
  const list = snap[kind] || [];
  return list.find(x => x.id === id);
}

// SM-110: list links involving a ticket (forward = owned by this ticket,
// backward = links from other tickets pointing here), resolving display
// labels via project.linkTypes. Mirrors the read logic of the MCP
// list_links_for_ticket tool (server/mcp.js) — kept in lockstep.
function listLinksForTicket(snap, ticketId, direction) {
  const dir = direction || "both";
  const linkTypes = (snap.project && snap.project.linkTypes) || [];
  const ltById = new Map(linkTypes.map(lt => [lt.id, lt]));
  const summary = (t) => t ? { id: t.id, ticketKey: t.ticketKey, title: t.title, type: t.type } : null;
  const resolveLabel = (linkTypeId, fallback, inverse) => {
    const lt = ltById.get(linkTypeId);
    if (lt) return inverse ? lt.inverseLabel : lt.label;
    return fallback || linkTypeId;
  };
  const tickets = snap.tickets || [];
  const ticket = tickets.find(t => t.id === ticketId);
  const out = [];
  if (dir === "forward" || dir === "both") {
    for (const l of (ticket && ticket.links) || []) {
      const target = tickets.find(t => t.id === l.targetTicketId);
      out.push({
        linkId: l.id, linkTypeId: l.linkTypeId,
        label: l.label || resolveLabel(l.linkTypeId, null, false),
        direction: "forward", target: summary(target)
      });
    }
  }
  if (dir === "backward" || dir === "both") {
    for (const other of tickets) {
      if (other.id === ticketId) continue;
      for (const l of other.links || []) {
        if (l.targetTicketId !== ticketId) continue;
        out.push({
          linkId: l.id, sourceTicketId: other.id, linkTypeId: l.linkTypeId,
          label: resolveLabel(l.linkTypeId, l.label, true),
          direction: "backward", source: summary(other)
        });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Route table
// ---------------------------------------------------------------------------

/**
 * Tiny path-pattern matcher: turn ":pid" segments into capture groups.
 * Returns { match: true, params } or { match: false }.
 */
function matchPath(pattern, pathname) {
  const ps = pattern.split("/");
  const xs = pathname.split("/");
  if (ps.length !== xs.length) return { match: false };
  const params = {};
  for (let i = 0; i < ps.length; i++) {
    if (ps[i].startsWith(":")) params[ps[i].slice(1)] = decodeURIComponent(xs[i]);
    else if (ps[i] !== xs[i]) return { match: false };
  }
  return { match: true, params };
}

function buildRouter(storage) {

  const routes = [];
  function route(method, pattern, handler) {
    routes.push({ method, pattern, handler });
  }

  // -------------------- health ---------------------------------------------
  // SM-99: the frontend probes this endpoint to decide whether to use the
  // HttpAdapter without an explicit `?api=` query param. `name:"storymap"`
  // is the identity check — guards against another service that happens to
  // sit on the same origin/port. Kept cheap: no storage hit.
  route("GET", "/api/health", async (req, res) => {
    writeJson(res, 200, { ok: true, name: "storymap", limits: core.LIMITS });
  });

  // -------------------- build-info -----------------------------------------
  // Liest beim ersten Aufruf den Git-HEAD aus dem Repo-Root und cached.
  // Schadlos bei deployments ohne .git — fällt auf "unknown" zurück.
  let _buildInfo = null;
  function readBuildInfo() {
    if (_buildInfo) return _buildInfo;
    const { execSync } = require("child_process");
    const repoRoot = path.resolve(__dirname, "..");
    let commit = "unknown", subject = "", iso = "";
    try {
      commit  = execSync("git rev-parse --short HEAD", { cwd: repoRoot, stdio: ["ignore","pipe","ignore"] }).toString().trim();
      subject = execSync("git log -1 --format=%s", { cwd: repoRoot, stdio: ["ignore","pipe","ignore"] }).toString().trim();
      iso     = execSync("git log -1 --format=%cI", { cwd: repoRoot, stdio: ["ignore","pipe","ignore"] }).toString().trim();
    } catch (_) { /* not a git checkout — leave defaults */ }
    _buildInfo = { commit, subject, committedAt: iso, startedAt: new Date().toISOString() };
    return _buildInfo;
  }
  route("GET", "/api/build-info", async (req, res) => {
    writeJson(res, 200, readBuildInfo());
  });

  // -------------------- internal: switch-project bridge (E20.A) -----------
  // Standalone MCP (separate Node process) POSTs here to broadcast a
  // switch_request via the in-process bus, which the WS layer relays to
  // every connected browser. The browser shows a confirm modal and POSTs
  // its verdict back over WS as { type:"switch_response", requestId,
  // accepted }, which the WS handler then routes back to the MCP via the
  // long-poll GET below.
  route("POST", "/api/internal/switch-request", async (req, res) => {
    const body = await readJsonBody(req);
    if (!body || typeof body !== "object" || typeof body.workspace !== "string") {
      return writeError(res, 400, "body must be { workspace: string, reason?: string, requestId?: string }");
    }
    bus.emit("switch_request", {
      workspace: body.workspace,
      reason: typeof body.reason === "string" ? body.reason : null,
      requestId: typeof body.requestId === "string" ? body.requestId : null
    });
    writeJson(res, 200, { ok: true });
  });

  // POST /api/internal/notify-change — cross-process change forwarding so
  // standalone MCP can push live updates to connected browsers (E20.E). MCP
  // forwards its OWN local bus.change events through this endpoint; we
  // re-emit on the in-process bus, which the WS layer then broadcasts to
  // matching subscribers (with the usual origin-id echo filter applied).
  route("POST", "/api/internal/notify-change", async (req, res) => {
    const body = await readJsonBody(req);
    if (!body || typeof body !== "object" || typeof body.projectId !== "string") {
      return writeError(res, 400, "body must include projectId");
    }
    bus.emit("change", {
      projectId: body.projectId,
      revision: body.revision || null,
      savedAt: body.savedAt || null,
      op: body.op || null,
      actor: body.actor || null,
      originId: typeof body.originId === "string" ? body.originId : null
    });
    writeJson(res, 200, { ok: true });
  });

  route("GET", "/api/internal/switch-response", async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const requestId = url.searchParams.get("requestId");
    if (!requestId) return writeError(res, 400, "requestId query param required");
    const waitRaw = parseInt(url.searchParams.get("wait"), 10);
    const waitSec = Number.isFinite(waitRaw) ? Math.max(0, Math.min(120, waitRaw)) : 30;
    // Fast path: browser beat the MCP poll.
    const cached = consumeSwitchResponse(requestId);
    if (cached) return writeJson(res, 200, { accepted: cached.accepted, timedOut: false });
    if (waitSec === 0) return writeJson(res, 200, { accepted: null, timedOut: true });
    // Slow path: race a bus listener with timeout + client disconnect.
    const result = await new Promise((resolve) => {
      let settled = false;
      const settle = (val) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        bus.off("switch_response", onResp);
        req.removeListener("close", onClose);
        resolve(val);
      };
      const onResp = (ev) => {
        if (!ev || ev.requestId !== requestId) return;
        consumeSwitchResponse(requestId);    // drain the cache the WS handler also wrote
        settle({ accepted: !!ev.accepted });
      };
      const onClose = () => settle(null);
      const timer = setTimeout(() => settle(null), waitSec * 1000);
      bus.on("switch_response", onResp);
      req.once("close", onClose);
    });
    if (result) return writeJson(res, 200, { accepted: result.accepted, timedOut: false });
    writeJson(res, 200, { accepted: null, timedOut: true });
  });

  // -------------------- projects -------------------------------------------
  route("GET", "/api/projects", async (req, res) => {
    const list = await storage.listProjects();
    writeJson(res, 200, list);
  });

  route("POST", "/api/projects", async (req, res) => {
    const body = await readJsonBody(req);
    validation.projectInput(body);
    const actor = actorFromReq(req);
    const originId = originIdFromReq(req);
    const project = core.normalizeProject(Object.assign({}, body, {
      createdBy: actor, updatedBy: actor
    }));
    // SM-254: seed a default release + process step so the project is usable.
    const snap = core.seedDefaultScaffold(core.normalizeSnapshot({
      project,
      tickets: [], releases: [], processSteps: []
    }), actor);
    const saved = await storage.saveProject(project.id, snap, {
      actor, op: "project_create", originId
    });
    writeJson(res, 201, { revision: saved.revision, savedAt: saved.savedAt, snapshot: saved.snapshot });
  });

  route("GET", "/api/projects/:pid", async (req, res, params) => {
    const snap = await storage.loadProject(params.pid);
    if (!snap) return writeError(res, 404, "project not found");
    writeJson(res, 200, snap);
  });

  // PUT /api/projects/:pid accepts two body shapes:
  //
  //   (1) Full-snapshot replace (E18: cmapper-Pattern): body has `tickets` and
  //       `releases` arrays. The whole project state is replaced atomically and
  //       a single revision with op "project_put" is written. This is the
  //       persistence path used by the store-zentrierte Frontend; undo/redo
  //       commits all flow through here.
  //
  //   (2) Backward-compat header merge: body has no `tickets`/`releases` keys
  //       (older callers passed just the project header to rename etc.). Then
  //       only project.* fields are merged; entity arrays are left untouched.
  //
  // Sanity-check for (1): project.id in the body must match :pid. Otherwise
  // a typo could silently re-route writes into the wrong project (cmapper
  // hit this and now pins the workspace explicitly).
  route("PUT", "/api/projects/:pid", async (req, res, params) => {
    const body = await readJsonBody(req);
    const actor = actorFromReq(req);
    const originId = originIdFromReq(req);
    const isSnapshot = body && Array.isArray(body.tickets) && Array.isArray(body.releases);
    if (isSnapshot) {
      if (body.project && body.project.id && body.project.id !== params.pid) {
        return writeError(res, 400, "body.project.id does not match URL :pid");
      }
      const result = await persistChange(storage, params.pid, "project_put",
        (cur) => {
          // Pin the project id to the URL so a snapshot exported from another
          // project can't overwrite this one (mirrors cmapper.applySnapshot).
          const pinnedProject = Object.assign({}, body.project || cur.project, {
            id: params.pid,
            updatedBy: actor
          });
          validation.projectInput(pinnedProject);
          return core.normalizeSnapshot(Object.assign({}, body, { project: pinnedProject }));
        },
        { actor, originId });
      return writeJson(res, 200, {
        revision: result.revision,
        savedAt: result.savedAt,
        snapshot: result.snapshot
      });
    }
    // Backward-compat: header-only merge. Route through core.ops.updateProject
    // so id / ticketPrefix / ticketCounter stay locked (SM-148).
    const result = await persistChange(storage, params.pid, "project_update",
      (cur) => {
        const next = core.ops.updateProject(cur, body, actor);
        validation.projectInput(next.project);   // SM-148: keep header validation
        return next;
      },
      { actor, originId });
    writeJson(res, 200, { revision: result.revision, savedAt: result.savedAt, project: result.snapshot.project });
  });

  route("DELETE", "/api/projects/:pid", async (req, res, params) => {
    const actor = actorFromReq(req);
    await storage.deleteProject(params.pid, { actor });
    writeStatus(res, 204);
  });

  // -------------------- tickets --------------------------------------------
  route("GET", "/api/projects/:pid/tickets", async (req, res, params) => {
    const snap = await storage.loadProject(params.pid);
    if (!snap) return writeError(res, 404, "project not found");
    writeJson(res, 200, snap.tickets.filter(t => !t.isDeleted));
  });

  route("POST", "/api/projects/:pid/tickets", async (req, res, params) => {
    const body = await readJsonBody(req);
    const actor = actorFromReq(req);
    const originId = originIdFromReq(req);
    const result = await persistChange(storage, params.pid, "ticket_create",
      (cur) => {
        validation.ticketInput(body, cur.project);
        return core.ops.createTicket(cur, body, actor);
      },
      { actor, originId });
    const ticket = result.snapshot.tickets[result.snapshot.tickets.length - 1];
    writeJson(res, 201, { revision: result.revision, savedAt: result.savedAt, ticket });
  });

  route("GET", "/api/projects/:pid/tickets/:tid", async (req, res, params) => {
    const snap = await storage.loadProject(params.pid);
    if (!snap) return writeError(res, 404, "project not found");
    const t = findEntity(snap, "tickets", params.tid);
    if (!t || t.isDeleted) return writeError(res, 404, "ticket not found");
    writeJson(res, 200, t);
  });

  route("PUT", "/api/projects/:pid/tickets/:tid", async (req, res, params) => {
    const body = await readJsonBody(req);
    const actor = actorFromReq(req);
    const originId = originIdFromReq(req);
    const result = await persistChange(storage, params.pid, "ticket_update",
      (cur) => {
        const existing = findEntity(cur, "tickets", params.tid);
        if (!existing) throw Object.assign(new Error("ticket not found"), { statusCode: 404 });
        validation.ticketInput(Object.assign({}, existing, body), cur.project);
        return core.ops.updateTicket(cur, params.tid, body, actor);
      },
      { actor, originId });
    writeJson(res, 200, {
      revision: result.revision, savedAt: result.savedAt,
      ticket: findEntity(result.snapshot, "tickets", params.tid)
    });
  });

  route("DELETE", "/api/projects/:pid/tickets/:tid", async (req, res, params) => {
    const actor = actorFromReq(req);
    const originId = originIdFromReq(req);
    await persistChange(storage, params.pid, "ticket_delete",
      (cur) => core.ops.softDeleteTicket(cur, params.tid, actor),
      { actor, originId });
    writeStatus(res, 204);
  });

  /**
   * Ticket-Reorder — mirrors the shape of POST /process-steps/reorder.
   * Body: { orderedIds: string[], scope?: { releaseId, processStepId, epicId } }.
   * Sets sortOrder = idx for every ticket in orderedIds. If `scope` is set,
   * releaseId/processStepId/epicId are ALSO applied to every ticket in the
   * list (handles cross-container moves atomically).
   */
  route("POST", "/api/projects/:pid/tickets/reorder", async (req, res, params) => {
    const body = await readJsonBody(req);
    if (!body || !Array.isArray(body.orderedIds)) {
      return writeError(res, 400, "body.orderedIds must be an array");
    }
    const actor = actorFromReq(req);
    const originId = originIdFromReq(req);
    const result = await persistChange(storage, params.pid, "tickets_reorder",
      (cur) => core.ops.reorderTickets(cur, body.orderedIds, body.scope || null, actor),
      { actor, originId });
    writeJson(res, 200, { revision: result.revision, savedAt: result.savedAt, snapshot: result.snapshot });
  });

  // -------------------- ticket links (SM-110 / A1) -------------------------
  // REST parity with the MCP link_create / link_delete / list_links_for_ticket
  // tools: the write paths go through the SAME core.ops.addLink / removeLink,
  // so the validation error kinds (LINK_TARGET_REQUIRED, LINK_SELF,
  // LINK_TARGET_MISSING, LINK_DUPLICATE, LINK_CYCLE) surface as HTTP 4xx with
  // `kind` via the central router catch.

  route("GET", "/api/projects/:pid/tickets/:tid/links", async (req, res, params) => {
    const snap = await storage.loadProject(params.pid);
    if (!snap) return writeError(res, 404, "project not found");
    const t = findEntity(snap, "tickets", params.tid);
    if (!t || t.isDeleted) return writeError(res, 404, "ticket not found");
    let url; try { url = new URL(req.url, "http://localhost"); } catch { url = null; }
    const direction = (url && url.searchParams.get("direction")) || "both";
    if (["forward", "backward", "both"].indexOf(direction) === -1) {
      return writeError(res, 400, "direction must be forward|backward|both");
    }
    writeJson(res, 200, {
      ticketId: params.tid, direction,
      links: listLinksForTicket(snap, params.tid, direction)
    });
  });

  route("POST", "/api/projects/:pid/tickets/:tid/links", async (req, res, params) => {
    const body = await readJsonBody(req);
    const actor = actorFromReq(req);
    const originId = originIdFromReq(req);
    const linkPatch = {
      linkTypeId:     body && body.linkTypeId,
      targetTicketId: body && body.targetTicketId
    };
    if (body && typeof body.label === "string" && body.label.length > 0) linkPatch.label = body.label;
    const result = await persistChange(storage, params.pid, "link_create",
      (cur) => core.ops.addLink(cur, params.tid, linkPatch, actor),
      { actor, originId });
    const ticket = findEntity(result.snapshot, "tickets", params.tid);
    const newLink = ticket && ticket.links[ticket.links.length - 1];
    writeJson(res, 201, { revision: result.revision, savedAt: result.savedAt, link: newLink });
  });

  route("DELETE", "/api/projects/:pid/tickets/:tid/links/:linkId", async (req, res, params) => {
    const actor = actorFromReq(req);
    const originId = originIdFromReq(req);
    const result = await persistChange(storage, params.pid, "link_delete",
      (cur) => core.ops.removeLink(cur, params.tid, params.linkId, actor),
      { actor, originId });
    writeJson(res, 200, { revision: result.revision, savedAt: result.savedAt });
  });

  // get_link_types parity — the project's link-type catalogue.
  route("GET", "/api/projects/:pid/link-types", async (req, res, params) => {
    const snap = await storage.loadProject(params.pid);
    if (!snap) return writeError(res, 404, "project not found");
    writeJson(res, 200, { linkTypes: (snap.project && snap.project.linkTypes) || [] });
  });

  // -------------------- test-definition spec (SM-111 / A2) -----------------
  // REST parity with the MCP test_def_step_* / test_def_prereq_* tools: same
  // core.ops, so the DEFINITION_FROZEN gate (published test-def spec is locked)
  // fires identically for REST and MCP — surfaced as HTTP 409 with kind via
  // the central router catch. check/uncheck are runtime toggles, not frozen.

  route("POST", "/api/projects/:pid/tickets/:tid/test-steps", async (req, res, params) => {
    const body = await readJsonBody(req);
    const actor = actorFromReq(req);
    const originId = originIdFromReq(req);
    const result = await persistChange(storage, params.pid, "test_def_step_add",
      (cur) => core.ops.addTestStep(cur, params.tid, body || {}, actor),
      { actor, originId });
    const t = findEntity(result.snapshot, "tickets", params.tid);
    const step = t && t.steps[t.steps.length - 1];
    writeJson(res, 201, { revision: result.revision, savedAt: result.savedAt, step });
  });

  route("PUT", "/api/projects/:pid/tickets/:tid/test-steps/:stepId", async (req, res, params) => {
    const body = await readJsonBody(req);
    const actor = actorFromReq(req);
    const originId = originIdFromReq(req);
    const result = await persistChange(storage, params.pid, "test_def_step_update",
      (cur) => core.ops.updateTestStep(cur, params.tid, params.stepId, body || {}, actor),
      { actor, originId });
    const t = findEntity(result.snapshot, "tickets", params.tid);
    const step = t && (t.steps || []).find(x => x.id === params.stepId);
    writeJson(res, 200, { revision: result.revision, savedAt: result.savedAt, step });
  });

  route("DELETE", "/api/projects/:pid/tickets/:tid/test-steps/:stepId", async (req, res, params) => {
    const actor = actorFromReq(req);
    const originId = originIdFromReq(req);
    const result = await persistChange(storage, params.pid, "test_def_step_remove",
      (cur) => core.ops.removeTestStep(cur, params.tid, params.stepId, actor),
      { actor, originId });
    writeJson(res, 200, { revision: result.revision, savedAt: result.savedAt });
  });

  route("POST", "/api/projects/:pid/tickets/:tid/test-steps/reorder", async (req, res, params) => {
    const body = await readJsonBody(req);
    if (!body || !Array.isArray(body.orderedStepIds)) {
      return writeError(res, 400, "body.orderedStepIds must be an array");
    }
    const actor = actorFromReq(req);
    const originId = originIdFromReq(req);
    const result = await persistChange(storage, params.pid, "test_def_step_reorder",
      (cur) => core.ops.reorderTestSteps(cur, params.tid, body.orderedStepIds, actor),
      { actor, originId });
    const t = findEntity(result.snapshot, "tickets", params.tid);
    writeJson(res, 200, { revision: result.revision, savedAt: result.savedAt, steps: t && t.steps });
  });

  route("POST", "/api/projects/:pid/tickets/:tid/test-prereqs", async (req, res, params) => {
    const body = await readJsonBody(req);
    const actor = actorFromReq(req);
    const originId = originIdFromReq(req);
    const result = await persistChange(storage, params.pid, "test_def_prereq_add",
      (cur) => core.ops.addTestPrereq(cur, params.tid, body || {}, actor),
      { actor, originId });
    const t = findEntity(result.snapshot, "tickets", params.tid);
    const prerequisite = t && t.prerequisites[t.prerequisites.length - 1];
    writeJson(res, 201, { revision: result.revision, savedAt: result.savedAt, prerequisite });
  });

  route("PUT", "/api/projects/:pid/tickets/:tid/test-prereqs/:prereqId", async (req, res, params) => {
    const body = await readJsonBody(req);
    const actor = actorFromReq(req);
    const originId = originIdFromReq(req);
    const result = await persistChange(storage, params.pid, "test_def_prereq_update",
      (cur) => core.ops.updateTestPrereq(cur, params.tid, params.prereqId, body || {}, actor),
      { actor, originId });
    const t = findEntity(result.snapshot, "tickets", params.tid);
    const prerequisite = t && (t.prerequisites || []).find(x => x.id === params.prereqId);
    writeJson(res, 200, { revision: result.revision, savedAt: result.savedAt, prerequisite });
  });

  route("DELETE", "/api/projects/:pid/tickets/:tid/test-prereqs/:prereqId", async (req, res, params) => {
    const actor = actorFromReq(req);
    const originId = originIdFromReq(req);
    const result = await persistChange(storage, params.pid, "test_def_prereq_remove",
      (cur) => core.ops.removeTestPrereq(cur, params.tid, params.prereqId, actor),
      { actor, originId });
    writeJson(res, 200, { revision: result.revision, savedAt: result.savedAt });
  });

  route("POST", "/api/projects/:pid/tickets/:tid/test-prereqs/:prereqId/check", async (req, res, params) => {
    const actor = actorFromReq(req);
    const originId = originIdFromReq(req);
    const result = await persistChange(storage, params.pid, "test_def_prereq_check",
      (cur) => core.ops.checkTestPrereq(cur, params.tid, params.prereqId, actor),
      { actor, originId });
    writeJson(res, 200, { revision: result.revision, savedAt: result.savedAt });
  });

  route("POST", "/api/projects/:pid/tickets/:tid/test-prereqs/:prereqId/uncheck", async (req, res, params) => {
    const actor = actorFromReq(req);
    const originId = originIdFromReq(req);
    const result = await persistChange(storage, params.pid, "test_def_prereq_uncheck",
      (cur) => core.ops.uncheckTestPrereq(cur, params.tid, params.prereqId, actor),
      { actor, originId });
    writeJson(res, 200, { revision: result.revision, savedAt: result.savedAt });
  });

  // -------------------- test-execution (SM-112 / A3) -----------------------
  // REST parity with the MCP test_exec_* tools, same core.ops. start replicates
  // the published-definition gate the MCP wrapper enforces (DEFINITION_DRAFT)
  // so a draft can't be executed from either surface. record / set_outcome
  // keep the outcome→status auto-coupling intact (it lives in the core ops).

  route("POST", "/api/projects/:pid/test-executions", async (req, res, params) => {
    const body = await readJsonBody(req);
    const actor = actorFromReq(req);
    const originId = originIdFromReq(req);
    const definitionId = body && body.definitionId;
    const opts = { env: body && body.env, runBy: body && body.runBy };
    const result = await persistChange(storage, params.pid, "test_exec_start",
      (cur) => {
        const def = findEntity(cur, "tickets", definitionId);
        if (!def) throw Object.assign(new Error("test-definition not found: " + definitionId), { statusCode: 404 });
        if (def.type !== "test-definition") {
          throw Object.assign(new Error("not a test-definition: " + definitionId), { statusCode: 422, kind: "WRONG_TYPE" });
        }
        if (def.lifecycle !== "published") {
          throw Object.assign(new Error("test-definition is in draft, not runnable"), { statusCode: 422, kind: "DEFINITION_DRAFT" });
        }
        return core.ops.startTestExecution(cur, definitionId, opts, actor);
      },
      { actor, originId });
    const exec = result.snapshot.tickets
      .filter(t => t.type === "test-execution" && t.referencedTestDefinitionId === definitionId)
      .sort((a, b) => (b.runAt || 0) - (a.runAt || 0))[0];
    writeJson(res, 201, { revision: result.revision, savedAt: result.savedAt, execution: exec });
  });

  route("POST", "/api/projects/:pid/tickets/:tid/execution-steps/:stepId", async (req, res, params) => {
    const body = await readJsonBody(req);
    const actor = actorFromReq(req);
    const originId = originIdFromReq(req);
    const result = await persistChange(storage, params.pid, "test_exec_record",
      (cur) => core.ops.recordTestExecStep(cur, params.tid, params.stepId, body || {}, actor),
      { actor, originId });
    const exec = findEntity(result.snapshot, "tickets", params.tid);
    const step = exec && (exec.executionSteps || []).find(x => x.stepId === params.stepId || x.id === params.stepId);
    writeJson(res, 200, {
      revision: result.revision, savedAt: result.savedAt,
      step, effectiveOutcome: exec && core.getEffectiveOutcome(exec)
    });
  });

  route("POST", "/api/projects/:pid/tickets/:tid/execution-outcome", async (req, res, params) => {
    const body = await readJsonBody(req);
    const actor = actorFromReq(req);
    const originId = originIdFromReq(req);
    const result = await persistChange(storage, params.pid, "test_exec_set_outcome",
      (cur) => core.ops.setTestExecOutcome(cur, params.tid, body && body.outcome, actor),
      { actor, originId });
    const exec = findEntity(result.snapshot, "tickets", params.tid);
    writeJson(res, 200, {
      revision: result.revision, savedAt: result.savedAt,
      outcomeOverride: exec && exec.outcomeOverride,
      effectiveOutcome: exec && core.getEffectiveOutcome(exec)
    });
  });

  // history of executions for a definition (:tid = definitionId), compact summary.
  route("GET", "/api/projects/:pid/tickets/:tid/executions", async (req, res, params) => {
    const snap = await storage.loadProject(params.pid);
    if (!snap) return writeError(res, 404, "project not found");
    let url; try { url = new URL(req.url, "http://localhost"); } catch { url = null; }
    const limitParam = url && url.searchParams.get("limit");
    const limit = limitParam ? parseInt(limitParam, 10) : undefined;
    const history = core.tickets.testExecHistory(snap, params.tid,
      typeof limit === "number" && !isNaN(limit) ? { limit } : undefined);
    const executions = history.map(t => ({
      id: t.id, ticketKey: t.ticketKey, title: t.title, status: t.status,
      runAt: t.runAt, env: t.env || null, effectiveOutcome: core.getEffectiveOutcome(t)
    }));
    writeJson(res, 200, { executions });
  });

  // -------------------- project config (SM-113 / A4) -----------------------
  // get/set for workflow, kanban columns, link-types and governance — REST
  // parity with set_workflow / set_kanban_columns / set_link_types /
  // set_governance. set_* are FULL replaces; set_governance rejects unknown
  // predicate names (HTTP 400 kind=UNKNOWN_PREDICATE).

  route("GET", "/api/projects/:pid/workflow", async (req, res, params) => {
    const snap = await storage.loadProject(params.pid);
    if (!snap) return writeError(res, 404, "project not found");
    let url; try { url = new URL(req.url, "http://localhost"); } catch { url = null; }
    const type = url && url.searchParams.get("type");
    if (type) return writeJson(res, 200, core.getWorkflowForType(snap.project, type));
    writeJson(res, 200, snap.project.workflow || core.STORYMAPPER_DEFAULT_WORKFLOW);
  });

  route("PUT", "/api/projects/:pid/workflow", async (req, res, params) => {
    const body = await readJsonBody(req);
    const actor = actorFromReq(req);
    const originId = originIdFromReq(req);
    const result = await persistChange(storage, params.pid, "workflow_update",
      (cur) => {
        const wf = core.normalizeWorkflow(body);
        if (!wf || wf.statuses.length === 0) {
          throw Object.assign(new Error("workflow.statuses must be a non-empty array"), { statusCode: 400 });
        }
        return core.normalizeSnapshot(Object.assign({}, cur, {
          project: Object.assign({}, cur.project, { workflow: wf })
        }));
      },
      { actor, originId });
    writeJson(res, 200, { revision: result.revision, savedAt: result.savedAt, workflow: result.snapshot.project.workflow });
  });

  route("GET", "/api/projects/:pid/kanban-columns", async (req, res, params) => {
    const snap = await storage.loadProject(params.pid);
    if (!snap) return writeError(res, 404, "project not found");
    const cols = (snap.project.boards && snap.project.boards.kanban && snap.project.boards.kanban.columns) || [];
    writeJson(res, 200, { columns: cols });
  });

  route("PUT", "/api/projects/:pid/kanban-columns", async (req, res, params) => {
    const body = await readJsonBody(req);
    const columns = Array.isArray(body) ? body : (body && body.columns);
    const actor = actorFromReq(req);
    const originId = originIdFromReq(req);
    const result = await persistChange(storage, params.pid, "kanban_columns_update",
      (cur) => {
        const nextBoards = Object.assign({}, cur.project.boards || {}, {
          kanban: { columns: Array.isArray(columns) ? columns : [] }
        });
        return core.normalizeSnapshot(Object.assign({}, cur, {
          project: Object.assign({}, cur.project, { boards: nextBoards })
        }));
      },
      { actor, originId });
    const cols = (result.snapshot.project.boards && result.snapshot.project.boards.kanban
                  && result.snapshot.project.boards.kanban.columns) || [];
    writeJson(res, 200, { revision: result.revision, savedAt: result.savedAt, columns: cols });
  });

  // link-types: GET added in the SM-110 section; PUT here (full replace).
  route("PUT", "/api/projects/:pid/link-types", async (req, res, params) => {
    const body = await readJsonBody(req);
    const list = Array.isArray(body) ? body : (body && Array.isArray(body.linkTypes) ? body.linkTypes : []);
    const actor = actorFromReq(req);
    const originId = originIdFromReq(req);
    const result = await persistChange(storage, params.pid, "link_types_update",
      (cur) => core.ops.updateProject(cur, { linkTypes: list }, actor),
      { actor, originId });
    writeJson(res, 200, { revision: result.revision, savedAt: result.savedAt, linkTypes: result.snapshot.project.linkTypes });
  });

  route("GET", "/api/projects/:pid/governance", async (req, res, params) => {
    const snap = await storage.loadProject(params.pid);
    if (!snap) return writeError(res, 404, "project not found");
    writeJson(res, 200, { governance: snap.project.governance || core.STORYMAPPER_DEFAULT_GOVERNANCE });
  });

  route("PUT", "/api/projects/:pid/governance", async (req, res, params) => {
    const body = await readJsonBody(req);
    const incoming = (body && typeof body === "object") ? (body.governance || body) : {};
    // Reject unknown predicate names up front (parity with set_governance).
    const predicateSet = new Set(Object.keys(core.GOVERNANCE_PREDICATES));
    const gates = incoming.gates || {};
    const unknown = [];
    for (const errorKind of Object.keys(gates)) {
      const cfg = gates[errorKind];
      if (!cfg || typeof cfg.predicate !== "string") continue;
      if (!predicateSet.has(cfg.predicate)) unknown.push({ errorKind, predicate: cfg.predicate });
    }
    if (unknown.length > 0) {
      return writeError(res, 400, "governance references unknown predicate(s)",
        { kind: "UNKNOWN_PREDICATE", unknown, knownPredicates: Array.from(predicateSet) });
    }
    const actor = actorFromReq(req);
    const originId = originIdFromReq(req);
    const result = await persistChange(storage, params.pid, "governance_update",
      (cur) => core.ops.updateProject(cur, { governance: core.normalizeGovernance(incoming) }, actor),
      { actor, originId });
    writeJson(res, 200, { revision: result.revision, savedAt: result.savedAt, governance: result.snapshot.project.governance });
  });

  // -------------------- revisions / history -------------------------------
  //
  // E13: storage.listRevisions/getRevision/restoreRevision sind seit E2 da,
  // die REST-Surface wurde erst hier nachgereicht. restoreRevision erzeugt
  // eine NEUE Revision (op: "project_restore") — damit ist der Restore
  // selbst undoable über einen erneuten Restore auf die vorige Revision.

  // SM-212: limit + before go down into storage (SQL LIMIT) instead of
  // select-all + JS slicing; clamping happens in storage.listRevisions.
  route("GET", "/api/projects/:pid/revisions", async (req, res, params) => {
    let url;
    try { url = new URL(req.url, "http://localhost"); } catch { url = null; }
    const limitParam = url && url.searchParams.get("limit");
    const beforeParam = url && url.searchParams.get("before");
    const opts = {};
    // parseInt result is passed when finite (incl. 0 → storage clamps to 1).
    if (limitParam != null && Number.isFinite(parseInt(limitParam, 10))) {
      opts.limit = parseInt(limitParam, 10);
    }
    if (beforeParam) opts.beforeRevision = beforeParam;
    writeJson(res, 200, await storage.listRevisions(params.pid, opts));
  });

  route("GET", "/api/projects/:pid/revisions/:rev", async (req, res, params) => {
    const r = await storage.getRevision(params.pid, params.rev);
    if (!r) return writeError(res, 404, "revision not found");
    writeJson(res, 200, r);
  });

  route("POST", "/api/projects/:pid/revisions/:rev/restore", async (req, res, params) => {
    const actor = actorFromReq(req);
    try {
      const result = await storage.restoreRevision(params.pid, params.rev, { actor });
      writeJson(res, 200, {
        revision: result.revision,
        savedAt:  result.savedAt,
        snapshot: result.snapshot
      });
    } catch (err) {
      if (/not found/i.test(err.message || "")) return writeError(res, 404, err.message);
      throw err;
    }
  });

  // -------------------- ticket status / DoR / DoD --------------------------
  route("POST", "/api/projects/:pid/tickets/:tid/status", async (req, res, params) => {
    const body = await readJsonBody(req);
    const actor = actorFromReq(req);
    const originId = originIdFromReq(req);
    const newStatus = body.status;
    const result = await persistChange(storage, params.pid, "ticket_change_status",
      (cur) => {
        const t = findEntity(cur, "tickets", params.tid);
        if (!t) throw Object.assign(new Error("ticket not found"), { statusCode: 404 });
        validation.changeStatusTransition(t, newStatus, cur.project);
        return core.ops.changeStatus(cur, params.tid, newStatus, actor);
      },
      { actor, originId });
    writeJson(res, 200, {
      revision: result.revision, savedAt: result.savedAt,
      ticket: findEntity(result.snapshot, "tickets", params.tid)
    });
  });

  function dorDodHandler(kind, action) {
    const op = "ticket_" + kind.toLowerCase() + "_" + action;
    return async (req, res, params) => {
      const actor = actorFromReq(req);
      const originId = originIdFromReq(req);
      const opName = (kind === "DoR")
        ? (action === "check" ? "checkDorItem" : "uncheckDorItem")
        : (action === "check" ? "checkDodItem" : "uncheckDodItem");
      const result = await persistChange(storage, params.pid, op,
        (cur) => core.ops[opName](cur, params.tid, params.itemId, actor),
        { actor, originId });
      writeJson(res, 200, {
        revision: result.revision, savedAt: result.savedAt,
        ticket: findEntity(result.snapshot, "tickets", params.tid)
      });
    };
  }

  route("POST", "/api/projects/:pid/tickets/:tid/dor/:itemId/check",   dorDodHandler("DoR", "check"));
  route("POST", "/api/projects/:pid/tickets/:tid/dor/:itemId/uncheck", dorDodHandler("DoR", "uncheck"));
  route("POST", "/api/projects/:pid/tickets/:tid/dod/:itemId/check",   dorDodHandler("DoD", "check"));
  route("POST", "/api/projects/:pid/tickets/:tid/dod/:itemId/uncheck", dorDodHandler("DoD", "uncheck"));

  // -------------------- releases -------------------------------------------
  route("GET", "/api/projects/:pid/releases", async (req, res, params) => {
    const snap = await storage.loadProject(params.pid);
    if (!snap) return writeError(res, 404, "project not found");
    writeJson(res, 200, snap.releases.filter(r => !r.isDeleted));
  });

  route("POST", "/api/projects/:pid/releases", async (req, res, params) => {
    const body = await readJsonBody(req);
    validation.releaseInput(body);
    const actor = actorFromReq(req);
    const originId = originIdFromReq(req);
    const result = await persistChange(storage, params.pid, "release_create",
      (cur) => core.ops.createRelease(cur, body, actor),
      { actor, originId });
    const release = result.snapshot.releases[result.snapshot.releases.length - 1];
    writeJson(res, 201, { revision: result.revision, savedAt: result.savedAt, release });
  });

  route("PUT", "/api/projects/:pid/releases/:rid", async (req, res, params) => {
    const body = await readJsonBody(req);
    const actor = actorFromReq(req);
    const originId = originIdFromReq(req);
    const result = await persistChange(storage, params.pid, "release_update",
      (cur) => {
        validation.releaseInput(Object.assign({ name: "x" }, body));
        return core.ops.updateRelease(cur, params.rid, body, actor);
      },
      { actor, originId });
    writeJson(res, 200, {
      revision: result.revision, savedAt: result.savedAt,
      release: findEntity(result.snapshot, "releases", params.rid)
    });
  });

  route("DELETE", "/api/projects/:pid/releases/:rid", async (req, res, params) => {
    const actor = actorFromReq(req);
    const originId = originIdFromReq(req);
    await persistChange(storage, params.pid, "release_delete",
      (cur) => {
        validation.releaseDelete(cur, params.rid);   // SM-255: 422 on last release
        return core.ops.softDeleteRelease(cur, params.rid, actor);
      },
      { actor, originId });
    writeStatus(res, 204);
  });

  route("POST", "/api/projects/:pid/releases/reorder", async (req, res, params) => {
    const body = await readJsonBody(req);
    if (!Array.isArray(body.orderedIds)) {
      return writeError(res, 400, "body.orderedIds must be an array");
    }
    const actor = actorFromReq(req);
    const originId = originIdFromReq(req);
    const result = await persistChange(storage, params.pid, "release_reorder",
      (cur) => core.ops.reorderReleases(cur, body.orderedIds, actor),
      { actor, originId });
    writeJson(res, 200, {
      revision: result.revision, savedAt: result.savedAt,
      releases: result.snapshot.releases.filter(r => !r.isDeleted)
    });
  });

  // -------------------- process-steps --------------------------------------
  route("GET", "/api/projects/:pid/process-steps", async (req, res, params) => {
    const snap = await storage.loadProject(params.pid);
    if (!snap) return writeError(res, 404, "project not found");
    writeJson(res, 200, snap.processSteps.filter(p => !p.isDeleted));
  });

  route("POST", "/api/projects/:pid/process-steps", async (req, res, params) => {
    const body = await readJsonBody(req);
    validation.processStepInput(body);
    const actor = actorFromReq(req);
    const originId = originIdFromReq(req);
    const result = await persistChange(storage, params.pid, "process_step_create",
      (cur) => core.ops.createProcessStep(cur, body, actor),
      { actor, originId });
    const processStep = result.snapshot.processSteps[result.snapshot.processSteps.length - 1];
    writeJson(res, 201, { revision: result.revision, savedAt: result.savedAt, processStep });
  });

  route("PUT", "/api/projects/:pid/process-steps/:sid", async (req, res, params) => {
    const body = await readJsonBody(req);
    const actor = actorFromReq(req);
    const originId = originIdFromReq(req);
    const result = await persistChange(storage, params.pid, "process_step_update",
      (cur) => {
        validation.processStepInput(Object.assign({ name: "x" }, body));
        return core.ops.updateProcessStep(cur, params.sid, body, actor);
      },
      { actor, originId });
    writeJson(res, 200, {
      revision: result.revision, savedAt: result.savedAt,
      processStep: findEntity(result.snapshot, "processSteps", params.sid)
    });
  });

  route("DELETE", "/api/projects/:pid/process-steps/:sid", async (req, res, params) => {
    const actor = actorFromReq(req);
    const originId = originIdFromReq(req);
    await persistChange(storage, params.pid, "process_step_delete",
      (cur) => core.ops.softDeleteProcessStep(cur, params.sid, actor),
      { actor, originId });
    writeStatus(res, 204);
  });

  route("POST", "/api/projects/:pid/process-steps/reorder", async (req, res, params) => {
    const body = await readJsonBody(req);
    if (!Array.isArray(body.orderedIds)) {
      return writeError(res, 400, "body.orderedIds must be an array");
    }
    const actor = actorFromReq(req);
    const originId = originIdFromReq(req);
    const result = await persistChange(storage, params.pid, "process_step_reorder",
      (cur) => core.ops.reorderProcessSteps(cur, body.orderedIds, actor),
      { actor, originId });
    writeJson(res, 200, {
      revision: result.revision, savedAt: result.savedAt,
      processSteps: result.snapshot.processSteps.filter(p => !p.isDeleted)
    });
  });

  // -------------------- attachments (SM-183) --------------------------------
  // Binary reference docs (PRDs, designs). Files live on disk next to the DB;
  // the row carries metadata + path. Upload = raw body + X-Filename header +
  // Content-Type mime + optional ?ticketId. Browser dropzone (S3) posts the
  // File blob directly; the MCP binary seam (S2) is a separate surface.
  route("POST", "/api/projects/:pid/attachments", async (req, res, params) => {
    let url; try { url = new URL(req.url, "http://localhost"); } catch (_) { url = null; }
    const ticketId = url ? url.searchParams.get("ticketId") : null;
    const fnHeader = req.headers["x-filename"];
    let filename = "file";
    if (typeof fnHeader === "string" && fnHeader.length) {
      try { filename = decodeURIComponent(fnHeader); } catch (_) { filename = fnHeader; }
    }
    const mimeType = (typeof req.headers["content-type"] === "string" && req.headers["content-type"])
      || "application/octet-stream";
    // Single source for the cap (shared with the storage guard) — reject the
    // over-size body at read time (413) before buffering it all.
    const maxBytes = (storage.constructor.ATTACHMENT_LIMITS || {}).MAX_BYTES;
    const buffer = await readRawBody(req, maxBytes);
    const meta = await storage.addAttachment(params.pid, { ticketId, filename, mimeType, buffer }, actorFromReq(req));
    writeJson(res, 201, { attachment: meta });
  });

  route("GET", "/api/projects/:pid/attachments", async (req, res, params) => {
    let url; try { url = new URL(req.url, "http://localhost"); } catch (_) { url = null; }
    const ticketId = url ? url.searchParams.get("ticketId") : null;
    const list = await storage.listAttachments(params.pid, ticketId != null ? { ticketId } : {});
    writeJson(res, 200, { attachments: list });
  });

  route("GET", "/api/projects/:pid/attachments/:aid", async (req, res, params) => {
    const meta = await storage.getAttachment(params.aid);
    if (!meta || meta.projectId !== params.pid) return writeError(res, 404, "attachment not found");
    if (!fs.existsSync(meta.absPath)) return writeError(res, 404, "attachment file missing");
    res.setHeader("Content-Type", meta.mimeType);
    res.setHeader("Content-Length", String(meta.size));
    res.setHeader("Content-Disposition", 'attachment; filename="' + meta.filename.replace(/"/g, "") + '"');
    res.setHeader("Cache-Control", "no-store");
    res.statusCode = 200;
    const stream = fs.createReadStream(meta.absPath);
    stream.on("error", () => {
      if (res.headersSent) { try { res.destroy(); } catch (_) { /* ignore */ } }
      else { try { writeError(res, 500, "internal error"); } catch (_) { /* ignore */ } }
    });
    stream.pipe(res);
  });

  route("DELETE", "/api/projects/:pid/attachments/:aid", async (req, res, params) => {
    const meta = await storage.getAttachment(params.aid);
    if (!meta || meta.projectId !== params.pid) return writeError(res, 404, "attachment not found");
    await storage.removeAttachment(params.aid, actorFromReq(req));
    writeStatus(res, 204);
  });

  // SM-203 R-7: convert an attachment to Markdown + pre-slice it, server-side.
  // Powers the Requirements reconciliation view's source pane (the browser
  // can't run the pdf2json/fflate ingestion). Returns {format, markdown,
  // sections:[{sectionPath, level, heading, body, charStart, charEnd}]}.
  route("GET", "/api/projects/:pid/attachments/:aid/ingest", async (req, res, params) => {
    const meta = await storage.getAttachment(params.aid);
    if (!meta || meta.projectId !== params.pid) return writeError(res, 404, "attachment not found");
    if (!fs.existsSync(meta.absPath)) return writeError(res, 404, "attachment file missing");
    let converted;
    try {
      const buffer = fs.readFileSync(meta.absPath);
      converted = await ingest.ingestToMarkdown(buffer, { filename: meta.filename, mimeType: meta.mimeType });
    } catch (e) {
      return writeError(res, e.statusCode || 500, e.message || "ingest failed");
    }
    const sections = slice.sliceMarkdown(converted.markdown);
    writeJson(res, 200, { format: converted.format, markdown: converted.markdown, sections: sections });
  });

  // -------------------- dispatcher -----------------------------------------
  return async function dispatch(req, res) {
    // SM-211: CORS reflection + nosniff first — every response path (routes,
    // static, errors) inherits the headers set here. Foreign browser origins
    // get no ACAO (reads stay blocked) and no mutations at all.
    const sec = applyRequestSecurity(req, res);
    if (req.method === "OPTIONS") return writeStatus(res, 204);
    if (sec.foreign && req.method !== "GET" && req.method !== "HEAD") {
      return writeError(res, 403, "cross-origin request denied");
    }
    let url;
    try { url = new URL(req.url, "http://localhost"); }
    catch (e) { return writeError(res, 400, "invalid url"); }

    // Internal MCP-bridge endpoints: loopback-only + no cross-origin browser
    // caller may forge change/switch broadcasts. (SM-147)
    if (url.pathname.startsWith("/api/internal/")) {
      if (!isLoopbackRemote(req) || !originIsLocal(req.headers.origin)) {
        return writeError(res, 403, "forbidden");
      }
    }

    // Static-file branch (only GET, only safe paths under frontend/).
    if (req.method === "GET" && !url.pathname.startsWith("/api/")) {
      if (serveStatic(res, url.pathname)) return;
    }

    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = matchPath(r.pattern, url.pathname);
      if (m.match) {
        try {
          await r.handler(req, res, m.params);
        } catch (err) {
          const status = err.statusCode || 500;
          const extras = {};
          if (err.kind) extras.kind = err.kind;
          if (err.missing) extras.missing = err.missing;
          if (status >= 500) {
            // Never leak raw err.message for server-side faults — it can carry
            // SQL fragments, dataDir paths or stack detail. Log it, send generic.
            console.error("[storymap] " + req.method + " " + url.pathname + " → 500:", err);
            writeError(res, status, "internal error", extras);
          } else {
            // Explicit 4xx are validation/ops errors with curated messages —
            // those are meant to reach the client.
            writeError(res, status, err.message || "error", extras);
          }
        }
        return;
      }
    }
    writeError(res, 404, "not found: " + req.method + " " + url.pathname);
  };
}

// ---------------------------------------------------------------------------
// Static-file handler — frontend/storymap.html at /, /js/*, /css/* …
// ---------------------------------------------------------------------------

function serveStatic(res, pathname) {
  // SM-117 (Epic B / B2): the bookmarkable full-page editor lives at /editor;
  // map it to the ticket-editor.html template (query string is ignored here —
  // serveStatic only ever sees the pathname).
  const rel = pathname === "/" ? "/storymap.html"
            : pathname === "/editor" ? "/ticket-editor.html"
            : pathname;
  // Refuse anything with ".." in it to avoid escapes.
  if (rel.indexOf("..") >= 0) return false;
  const filePath = path.join(FRONTEND_DIR, rel);
  // Ensure final resolved path stays inside FRONTEND_DIR.
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(FRONTEND_DIR + path.sep) && resolved !== FRONTEND_DIR) return false;
  // SM-213: path.resolve does NOT dereference symlinks — a link placed under
  // frontend/ could point anywhere on disk. Realpath the target and require
  // it to live under frontend/ OR under the repo's shared/ dir (frontend/js/
  // core.js and core/graph.js are legit symlinks into shared/, SM-139).
  let real;
  try { real = fs.realpathSync(resolved); } catch (_) { return false; }
  const inside = (p, root) => root && (p === root || p.startsWith(root + path.sep));
  if (!inside(real, REAL_FRONTEND_DIR) && !inside(real, REAL_SHARED_DIR)) return false;
  let stat;
  try { stat = fs.statSync(real); } catch (_) { return false; }
  if (!stat.isFile()) return false;
  const ext = path.extname(resolved).toLowerCase();
  res.setHeader("Content-Type", MIME[ext] || "application/octet-stream");
  // SM-211: defense-in-depth CSP on the HTML documents (scripts/styles are
  // classical <script src>/<link> tags from 'self'; no inline scripts exist).
  // X-Frame-Options doubles the frame-ancestors directive for older engines.
  if (ext === ".html") {
    res.setHeader("Content-Security-Policy", SECURITY_HEADERS.CSP);
    res.setHeader("X-Frame-Options", SECURITY_HEADERS.FRAME_OPTIONS);
  }
  // `no-store` (statt no-cache) verbietet Browser-Caching komplett.
  // Während der Entwicklung kritisch — sonst sieht der User nach
  // Server-Restart weiterhin alte JS/HTML/CSS aus dem Browser-Cache.
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.statusCode = 200;
  const stream = fs.createReadStream(resolved);
  stream.on("error", (err) => {
    // Async I/O failure (EMFILE, file vanished after statSync, permission
    // race). Without this listener the 'error' event is unhandled and takes
    // down the whole process. If headers were already flushed mid-stream we
    // can only tear down the socket; otherwise we can still send a 500.
    if (res.headersSent) {
      try { res.destroy(); } catch (_) { /* ignore */ }
    } else {
      try { writeError(res, 500, "internal error"); } catch (_) { /* ignore */ }
    }
  });
  stream.pipe(res);
  return true;
}

// ---------------------------------------------------------------------------
// WebSocket layer
// ---------------------------------------------------------------------------

/**
 * Per-client state:
 *   { ws, subscriptions: Set<projectId>, originId: string|null }
 *
 * Messages from client:
 *   { type: "subscribe", projectId, originId? }
 *   { type: "unsubscribe", projectId }
 *   { type: "ping" }
 *
 * Messages to client:
 *   { type: "hello", protocolVersion: 1 }
 *   { type: "subscribed", projectId }
 *   { type: "unsubscribed", projectId }
 *   { type: "pong" }
 *   { type: "change", projectId, revision, savedAt, op, actor }
 */
// WebSocket connection health. A client that vanishes without a TCP close
// (laptop sleep, network drop, killed tab) never fires 'close'/'error', so its
// entry — and its subscription Set — would leak forever and be iterated on
// every broadcast. A periodic ping/pong sweep terminates unresponsive sockets.
const WS_HEARTBEAT = {
  INTERVAL_MS: 30 * 1000,   // ping cadence; a client with no pong since the last tick is dead
  OPEN: 1                   // WebSocket.readyState === OPEN
};

function setupWebSocket(httpServer) {
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Map();  // ws → { ws, subscriptions: Set, originId }

  // Heartbeat sweep: terminate sockets that didn't pong since the last tick.
  const heartbeat = setInterval(() => {
    for (const state of clients.values()) {
      const ws = state.ws;
      if (ws.isAlive === false) {
        try { ws.terminate(); } catch (_) { /* ignore */ }
        clients.delete(ws);
        continue;
      }
      ws.isAlive = false;
      try { ws.ping(); } catch (_) { /* ignore */ }
    }
  }, WS_HEARTBEAT.INTERVAL_MS);
  if (typeof heartbeat.unref === "function") heartbeat.unref();

  httpServer.on("upgrade", (req, socket, head) => {
    let url;
    try { url = new URL(req.url, "http://localhost"); }
    catch (e) { socket.destroy(); return; }
    if (url.pathname !== "/ws") { socket.destroy(); return; }
    // Reject cross-site WebSocket hijacking: only same-machine/loopback (or
    // header-less non-browser) clients may upgrade. (SM-147)
    if (!originIsLocal(req.headers.origin)) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws) => {
    const state = { ws, subscriptions: new Set(), originId: null };
    clients.set(ws, state);
    ws.isAlive = true;
    ws.on("pong", () => { ws.isAlive = true; });

    function reply(obj) {
      try { ws.send(JSON.stringify(obj)); } catch (_) { /* ignore */ }
    }

    reply({ type: "hello", protocolVersion: 1 });

    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); }
      catch (e) { reply({ type: "error", message: "invalid JSON" }); return; }
      switch (msg.type) {
        case "subscribe":
          if (typeof msg.projectId === "string") {
            state.subscriptions.add(msg.projectId);
            if (typeof msg.originId === "string") state.originId = msg.originId;
            reply({ type: "subscribed", projectId: msg.projectId });
          } else {
            reply({ type: "error", message: "subscribe requires projectId" });
          }
          break;
        case "unsubscribe":
          if (typeof msg.projectId === "string") {
            state.subscriptions.delete(msg.projectId);
            reply({ type: "unsubscribed", projectId: msg.projectId });
          }
          break;
        case "ping":
          reply({ type: "pong" });
          break;
        case "switch_response":
          // E20.A: Browser's verdict to a switch_request. Cache + emit
          // (the cache lets the MCP long-poll resolve even when the
          // browser answers BEFORE the poll registers a bus listener).
          if (typeof msg.requestId === "string") {
            cacheSwitchResponse(msg.requestId, !!msg.accepted);
            bus.emit("switch_response", { requestId: msg.requestId, accepted: !!msg.accepted });
          }
          break;
        default:
          reply({ type: "error", message: "unknown message type: " + msg.type });
      }
    });

    ws.on("close", () => { clients.delete(ws); });
    ws.on("error", () => { clients.delete(ws); });
  });

  // Subscribe once to the bus; broadcast to matching clients.
  function broadcast(ev) {
    for (const state of clients.values()) {
      if (state.ws.readyState !== WS_HEARTBEAT.OPEN) continue;
      if (!state.subscriptions.has(ev.projectId)) continue;
      // Origin-Id echo filter: skip clients whose registered origin matches.
      if (state.originId && ev.originId && state.originId === ev.originId) continue;
      try {
        state.ws.send(JSON.stringify({
          type: "change",
          projectId: ev.projectId,
          revision: ev.revision,
          savedAt: ev.savedAt,
          op: ev.op,
          actor: ev.actor
        }));
      } catch (_) { /* ignore */ }
    }
  }
  bus.on("change", broadcast);

  // E20.A: switch_request broadcasts to ALL connected clients (not filtered
  // by project subscription — the user might be on a different project but
  // still gets asked whether to switch).
  function broadcastSwitchRequest(ev) {
    for (const state of clients.values()) {
      try {
        state.ws.send(JSON.stringify({
          type: "switch_request",
          workspace: ev.workspace,
          reason: ev.reason,
          requestId: ev.requestId
        }));
      } catch (_) { /* ignore */ }
    }
  }
  bus.on("switch_request", broadcastSwitchRequest);

  // cmapper-Pattern: separately exposed detach so multiple-server-instance
  // test runs (or restart cycles) don't accumulate bus listeners.
  function detachBus() {
    bus.off("change", broadcast);
    bus.off("switch_request", broadcastSwitchRequest);
  }

  async function shutdown() {
    clearInterval(heartbeat);
    detachBus();
    for (const state of clients.values()) {
      try { state.ws.terminate(); } catch (_) { /* ignore */ }
    }
    clients.clear();
    await new Promise((resolve) => wss.close(() => resolve()));
  }

  return { wss, shutdown, detachBus };
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

async function startServer(opts) {
  opts = opts || {};
  const dataDir = opts.dataDir;
  if (!dataDir) throw new Error("startServer: dataDir required");
  const port = typeof opts.port === "number" ? opts.port : 8770;
  const host = opts.host || "localhost";

  const storage = new Storage(dataDir);
  await storage.init();
  const dispatch = buildRouter(storage);

  const sockets = new Set();
  const httpServer = http.createServer((req, res) => {
    dispatch(req, res).catch(err => {
      // Last-resort guard: log full detail server-side, send a generic 500.
      try { console.error("[storymap] unhandled dispatch error:", err); } catch (_) { /* ignore */ }
      try { writeError(res, 500, "internal error"); } catch (_) { /* ignore */ }
    });
  });
  // SM-244: Node's default keepAliveTimeout is 5s — a browser that reuses an
  // idle keep-alive connection (e.g. after sitting in a modal for a few seconds)
  // for a snapshot PUT can hit a connection the server JUST closed, producing
  // an aborted request (ECONNRESET) and a lost save. Widen the keep-alive
  // window so the browser's persistent connection stays valid between actions.
  // headersTimeout must exceed keepAliveTimeout (Node ordering requirement).
  httpServer.keepAliveTimeout = 75 * 1000;
  httpServer.headersTimeout   = 80 * 1000;
  httpServer.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  const ws = setupWebSocket(httpServer);

  await new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => { httpServer.off("error", reject); resolve(); });
  });

  async function shutdown() {
    // 1. tear down WS clients + listener first so they unblock httpServer.close()
    await ws.shutdown();
    // 2. stop accepting new connections
    await new Promise((resolve) => httpServer.close(() => resolve()));
    // 3. destroy any lingering keep-alive sockets
    for (const s of sockets) { try { s.destroy(); } catch (_) { /* ignore */ } }
    sockets.clear();
    // 4. close storage
    storage.close();
  }

  return { httpServer, wss: ws.wss, storage, shutdown };
}

module.exports = { startServer };
// SM-213: switch-cache constants + test hooks (the map is module-global; the
// hardening tests drive bound/TTL/sweep directly against it).
module.exports.SWITCH_CACHE = SWITCH_CACHE;
module.exports._switchCacheHooks = {
  cacheSwitchResponse,
  consumeSwitchResponse,
  map: _switchResponseCache
};
