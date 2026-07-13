"use strict";

/**
 * SM-129 (A6) — Identity/Actor seam + authorization choke-point.
 *
 * One place that decides "who is acting" for every write path (REST + MCP),
 * and ONE pluggable `authorize(actor, op, entity)` hook that every persist
 * passes through. Today the hook is a no-op (allow everything) and identity
 * is header/convention-based — but the seam exists so:
 *
 *   - no write path ever invents an ad-hoc `{ id: "unknown" }` actor again
 *     (the only place "unknown" appears is core.normalizeActor's defensive
 *     fallback for legacy/stored data, never freshly minted on a write);
 *   - real token-verified identity (later) plugs into `resolveActor`;
 *   - real RBAC (the SM-130 outlook epic) plugs into `setAuthorizePolicy`
 *     without touching a single route or tool.
 *
 * Server-only module (REST + MCP). Not mirrored to the frontend.
 *
 * TRUST MODEL (SM-211): this is a LOCAL SINGLE-USER tool. The X-Actor-*
 * headers are attribution (who shows up in the revision history), NOT
 * authentication — nothing verifies them. That is acceptable because the
 * server binds to loopback and CORS rejects foreign browser origins
 * (server.js applyRequestSecurity). Never bind to a non-loopback interface
 * as-is. Verified identity + token gate + RBAC are the deferred multi-user
 * stage (epic SM-130) and plug into resolveActor / setAuthorizePolicy here.
 */

const core = require("./core.js");

// Default actor for an HTTP client that does not identify itself via the
// X-Actor-* header convention. NOT "unknown" — an anonymous-but-present HTTP
// caller is still a known transport ("http"). Frozen so callers can't mutate
// the shared default.
const DEFAULT_HTTP_ACTOR = Object.freeze({ type: "human", id: "http", name: "HTTP User" });

// Default actor for MCP tool calls (the coding agent driving the stdio server).
const AI_ACTOR = Object.freeze({ type: "ai", id: "claude", name: "Claude" });

// Header convention for identifying a REST caller. Node lower-cases all
// incoming header names, so we read the lower-case keys.
const HDR = Object.freeze({
  TYPE:    "x-actor-type",
  ID:      "x-actor-id",
  NAME:    "x-actor-name",
  SESSION: "x-actor-session"
});

/**
 * Resolve the actor for a REST request from the X-Actor-* header convention.
 *
 * - `X-Actor-Id` present  → identified client; build the actor from the
 *   headers (id is mandatory, type defaults to "human", name defaults to id).
 *   Token verification is a later concern — for now the headers ARE the
 *   identity. An identified client never degrades to "unknown".
 * - no `X-Actor-Id`       → anonymous HTTP caller → DEFAULT_HTTP_ACTOR.
 *
 * Passing no request (or a request without headers) yields the default,
 * which is what server-internal callers want.
 */
function resolveActor(req) {
  const headers = (req && req.headers) || null;
  if (headers) {
    const get = (h) => {
      const v = headers[h];
      return (typeof v === "string" && v.trim()) ? v.trim() : null;
    };
    const id = get(HDR.ID);
    if (id) {
      const raw = { type: get(HDR.TYPE) || "human", id: id, name: get(HDR.NAME) || id };
      const session = get(HDR.SESSION);
      if (session) raw.sessionId = session;
      return core.normalizeActor(raw);
    }
  }
  return Object.assign({}, DEFAULT_HTTP_ACTOR);
}

/**
 * Resolve the actor for an MCP tool call. Honours an explicit `args.actor`
 * override (normalized) and otherwise attributes the write to the AI agent.
 * Replaces the per-module AI_ACTOR literal + actorFromArgs in mcp.js so REST
 * and MCP share one identity module.
 */
function resolveAiActor(args) {
  if (args && args.actor && typeof args.actor === "object") {
    return core.normalizeActor(args.actor);
  }
  return Object.assign({}, AI_ACTOR);
}

// --- Authorization choke-point -------------------------------------------

// The default policy: allow every write. RBAC plugs in via setAuthorizePolicy.
function allowAll(/* actor, op, entity */) { return true; }

let _policy = allowAll;

/**
 * The single write-authorization choke-point. Every persist (REST + MCP)
 * passes through here via storage.saveProject / storage.deleteProject.
 *
 * The policy returns truthy to allow, falsy to deny. A denial throws a
 * `{ statusCode: 403, kind: "AUTHZ" }` error so the REST router maps it to
 * HTTP 403 and the MCP layer surfaces it as a structured tool error — the
 * same translation path validation errors already use.
 */
function authorize(actor, op, entity) {
  const allowed = _policy(actor, op, entity);
  if (!allowed) {
    throw Object.assign(new Error("not authorized: " + op), { statusCode: 403, kind: "AUTHZ" });
  }
  return true;
}

/** Install an RBAC policy. Pass nothing / a non-function to reset to allow-all. */
function setAuthorizePolicy(fn) {
  _policy = (typeof fn === "function") ? fn : allowAll;
}

/** Restore the default allow-all policy (mainly for tests). */
function resetAuthorizePolicy() {
  _policy = allowAll;
}

module.exports = {
  DEFAULT_HTTP_ACTOR,
  AI_ACTOR,
  resolveActor,
  resolveAiActor,
  authorize,
  setAuthorizePolicy,
  resetAuthorizePolicy
};
