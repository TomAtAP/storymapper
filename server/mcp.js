"use strict";

/**
 * MCP server. Exposes the same operations as the REST layer via stdio
 * JSON-RPC for Claude Desktop / Claude Code clients.
 *
 * Conventions:
 *  - `ok(payload)` returns `{ content: [{type:"text", text: JSON.stringify(payload)}] }`
 *  - `fail(message, extras)` returns `{ isError: true, content: [...] }` with
 *    a JSON body so coding agents can parse `kind`, `missing[]`, etc.
 *  - Mutating tools default to a COMPACT response: only the changed entity,
 *    plus `revision` and `savedAt`. Use `get_*` to fetch the full snapshot.
 *  - Every write is attributed to an AI actor (so the audit trail shows
 *    "Claude" vs. "HTTP User" on the REST side).
 */

// SM-310: native, dependency-free MCP layer — replaces @modelcontextprotocol/sdk.
const { createRegistry } = require("./mcp-native/registry.js");
const { createStdioServer } = require("./mcp-native/stdio.js");
const { z } = require("zod");
const core = require("./core.js");
const coreGraph = require("./core/graph.js");
const validation = require("./validation.js");
const bus = require("./bus.js");
const identity = require("./identity.js");
const ingest = require("./ingest.js");   // SM-201 R-5: attachment → Markdown
const slice = require("./slice.js");      // SM-201 R-5: Markdown → sections
const queryEngine = require("../shared/query-engine.js");   // SM-190: JQL query engine
const ticketImport = require("../shared/ticket-import.js"); // SM-290: bulk import engine
const projectIO = require("../shared/project-io.js");       // SM-291: export envelope

// SM-129: the MCP actor + override logic now live in the shared identity
// seam so REST and MCP attribute writes through one module. Kept as a local
// alias so the existing AI_ACTOR references below don't churn.
const AI_ACTOR = identity.AI_ACTOR;

// Some MCP clients stringify nested object arguments when the input schema
// is `z.any()` (no visible object shape in the exported JSON schema), so a
// payload like { releaseId: "r-x" } arrives as the literal string
// '{"releaseId":"r-x"}' and downstream normalizers silently drop it.
// `tolerateJsonString` wraps any schema in a preprocess step that parses
// strings back into objects before validation. Combined with the strict
// object schemas below, structured clients get proper JSON-schema hints
// AND defensive clients keep working.
function tolerateJsonString(schema) {
  return z.preprocess((v) => {
    if (typeof v === "string") {
      try { return JSON.parse(v); } catch (_) { return v; }
    }
    return v;
  }, schema);
}

const positionSchema = tolerateJsonString(z.object({
  releaseId:     z.string().nullable().optional(),
  epicId:        z.string().nullable().optional(),
  processStepId: z.string().nullable().optional(),
  sortOrder:     z.number().nullable().optional()
}).partial()).optional();

// SM-260: structured acceptance-criteria schema (key is `text`, never `label`).
// tolerateJsonString so the bridge's stringified array survives — a bare
// z.any() array is silently dropped by Claude Code's MCP bridge.
const acceptanceCriteriaSchema = tolerateJsonString(z.array(z.object({
  text:      z.string(),
  completed: z.boolean().optional(),
  id:        z.string().optional()
}).passthrough())).optional();

const ticketPatchSchema = tolerateJsonString(z.object({
  title:                z.string().optional(),
  description:          z.string().optional(),
  type:                 z.string().optional(),
  status:               z.string().optional(),
  position:             positionSchema,
  labels:               z.array(z.string()).optional(),
  acceptanceCriteria:   acceptanceCriteriaSchema,
  definitionOfReady:    z.any().optional(),
  definitionOfDone:     z.any().optional()
}).partial());

const reorderScopeSchema = tolerateJsonString(z.object({
  releaseId:     z.string().nullable().optional(),
  processStepId: z.string().nullable().optional(),
  epicId:        z.string().nullable().optional()
}).partial()).optional();

// E21.H — Kanban column mapping. Tolerates a JSON-string argument so
// Claude Code's MCP bridge (which stringifies arrays/objects passed to
// `z.any()`-typed params) doesn't silently no-op the call.
const kanbanColumnsSchema = tolerateJsonString(z.array(z.object({
  id:        z.string(),
  name:      z.string().optional(),
  statusIds: z.array(z.string()).optional()
}).passthrough()));

// SM-201 R-5 — a requirement's source anchor (back-ref into the PRD).
// tolerateJsonString so the MCP bridge's stringified object survives.
const sourceAnchorSchema = tolerateJsonString(z.object({
  attachmentId: z.string().optional(),
  sectionId:    z.string().optional(),
  charStart:    z.number().nullable().optional(),
  charEnd:      z.number().nullable().optional()
}).partial());

// SM-31 — shared "any object" schema for tool args whose inner shape the
// schema doesn't constrain (e.g. set_definitions.definitions, project_
// update.patch, project_create.{definitions, workflow, entityTypeConfig}).
// Wraps z.object({}).passthrough() with tolerateJsonString so a stringified
// object survives Claude Code's MCP bridge instead of becoming a silent
// no-op the way `z.any()` did.
const passthroughObjectSchema = tolerateJsonString(z.object({}).passthrough());

// SM-164 — get_config/set_config value: an object (definitions / workflow /
// governance) OR an array (kanban_columns / link_types). Tolerates a JSON-
// string for the Claude Code MCP bridge, same as the schemas above.
const configValueSchema = tolerateJsonString(z.union([
  z.object({}).passthrough(),
  z.array(z.any())
]));

const CONFIG_SECTIONS = ["definitions", "workflow", "kanban_columns", "governance", "link_types"];

function genRequestId() {
  return "sw-" + Math.random().toString(36).slice(2, 10) + "-" + Date.now().toString(36);
}

function ok(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function fail(message, extras) {
  const body = Object.assign({ error: message }, extras || {});
  return { isError: true, content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
}

// SM-129: delegate to the shared identity seam (args.actor override → AI_ACTOR).
function actorFromArgs(args) {
  return identity.resolveAiActor(args);
}

function findEntity(snap, kind, id) {
  return (snap[kind] || []).find(x => x.id === id);
}

// SM-125: the single compact ticket shape — identical to list_tickets' compact
// mode (one source of truth). Ticket-returning mutators return this by default;
// pass verbose:true on the tool to get the full ticket instead.
function ticketSummary(t) {
  return t ? {
    id: t.id, ticketKey: t.ticketKey, type: t.type,
    status: t.status, title: t.title, position: t.position
  } : t;
}

// SM-177: render the foldProductDescription model (SM-176) to a Markdown
// product description — the deterministic, traceable skeleton (direction B).
const PRODUCT_DOC_BADGE = { shipped: "shipped", "in-progress": "in progress", planned: "planned" };
function renderProductDoc(model, opts) {
  opts = opts || {};
  const L = [];
  L.push("# Product Description — " + (opts.projectName || "Product"));
  L.push("");
  L.push("_" + model.features.length + " feature(s)"
    + (model.orphans.length ? ", " + model.orphans.length + " ungrouped item(s)" : "") + "._");
  L.push("");
  for (const f of model.features) {
    L.push("## " + (f.epic.title || f.epic.ticketKey));
    const rel = f.release ? (f.release.name || f.release.id) : "Unscheduled";
    L.push("*[" + (PRODUCT_DOC_BADGE[f.status] || f.status) + "] · " + rel + " · " + f.epic.ticketKey + "*");
    // SM-180: cross-release evolution — the superseded chain folded into this feature.
    if (Array.isArray(f.history) && f.history.length) {
      const chain = f.history.map(h =>
        h.epic.ticketKey + (h.release ? " (" + (h.release.name || h.release.id) + ")" : ""));
      L.push("");
      L.push("_Evolved from: " + chain.join(" → ") + " → current._");
    }
    L.push("");
    if (f.stories.length) {
      L.push("**Stories**");
      for (const s of f.stories) {
        L.push("- `" + s.status + "` " + s.ticketKey + " — " + s.title);
        for (const ac of (s.acceptanceCriteria || [])) {
          if (ac && ac.text) L.push("  - " + ac.text);
        }
      }
      L.push("");
    }
    if (opts.includeTests && f.tests.length) {
      L.push("**Tests**");
      for (const t of f.tests) {
        L.push("- " + t.ticketKey + " — " + t.title + (t.health ? " (" + t.health + ")" : ""));
      }
      L.push("");
    }
  }
  if (model.orphans.length) {
    L.push("## Ungrouped work items");
    for (const o of model.orphans) {
      const rel = o.release ? (o.release.name || o.release.id) : "Unscheduled";
      L.push("- `" + o.status + "` " + o.ticketKey + " — " + o.title + " · " + rel);
    }
    L.push("");
  }
  return L.join("\n");
}

// SM-164 — unified project-config dispatch. Each section keeps its own read +
// validate + apply path (no behaviour change vs. the former ten get/set tools);
// only the tool envelope is unified into get_config / set_config.

function readConfigSection(project, section, type) {
  switch (section) {
    case "definitions":    return project.definitions;
    case "workflow":
      return type ? core.getWorkflowForType(project, type)
                  : (project.workflow || core.STORYMAPPER_DEFAULT_WORKFLOW);
    case "kanban_columns": return (project.boards && project.boards.kanban
                                   && project.boards.kanban.columns) || [];
    case "governance":     return project.governance || core.STORYMAPPER_DEFAULT_GOVERNANCE;
    case "link_types":     return project.linkTypes || [];
    default:               return undefined;
  }
}

// Apply a config-section write to `cur`, returning the next snapshot. Throws
// { statusCode, kind? } on invalid input — persist() translates that to fail().
// Governance's UNKNOWN_PREDICATE check runs in the handler (richer error body).
function applyConfigSection(section, cur, value, actor) {
  switch (section) {
    case "definitions": {
      validation.definitionsInput(value);
      const merged = Object.assign({}, cur.project, { definitions: value });
      return Object.assign({}, cur, { project: core.normalizeProject(merged) });
    }
    case "workflow": {
      const wf = core.normalizeWorkflow(value);
      if (!wf || wf.statuses.length === 0) {
        throw Object.assign(new Error("workflow.statuses must be a non-empty array"), { statusCode: 400 });
      }
      const next = Object.assign({}, cur, {
        project: Object.assign({}, cur.project, { workflow: wf })
      });
      return core.normalizeSnapshot(next);
    }
    case "kanban_columns": {
      const cols = Array.isArray(value) ? value : [];
      const nextBoards = Object.assign({}, cur.project.boards || {}, { kanban: { columns: cols } });
      const next = Object.assign({}, cur, {
        project: Object.assign({}, cur.project, { boards: nextBoards })
      });
      return core.normalizeSnapshot(next);
    }
    case "governance": {
      const incoming = (value && typeof value === "object") ? value : {};
      return core.ops.updateProject(cur, { governance: core.normalizeGovernance(incoming) }, actor);
    }
    case "link_types": {
      const list = Array.isArray(value) ? value : [];
      return core.ops.updateProject(cur, { linkTypes: list }, actor);
    }
    default:
      throw Object.assign(new Error("unknown config section: " + section), { statusCode: 400 });
  }
}

/**
 * SM-94 — Run the SM-93 governance gates for a tool action against a
 * specific ticket. If any gate fails, returns a complete fail() response
 * with kind = first failing errorKind, the full errors[] array, and a
 * rendered message (title/reason/suggestion/skillRef). Returns null when
 * everything passes — caller proceeds with its persist().
 *
 * The `extraContext` object provides values for the message templater
 * (e.g. {definitionKey, targetKey} so the rendered suggestion can name
 * the actual ticket the agent was working on).
 */
function runGovernanceGates(snap, toolAction, ticket, extraContext) {
  const result = core.evaluateGates(toolAction, snap, ticket, snap.project.governance);
  if (result.ok) return null;
  const first = result.errors[0];
  const template = ((snap.project.governance || {}).messages || {})[first.kind];
  const ctx = Object.assign({}, extraContext || {}, first.context || {});
  const message = core.renderMessage(template, ctx);
  return fail(message.reason || ("gate failed: " + first.kind), {
    kind: first.kind,
    errors: result.errors,
    message: message,
    statusCode: 422
  });
}

/**
 * SM-94 — soft-warning variant of runGovernanceGates. Returns a `warnings`
 * array that the caller can include in its successful response. Each
 * warning carries its rendered message so the agent doesn't need to
 * re-render templates client-side.
 */
function collectGovernanceWarnings(snap, toolAction, ticket, extraContext) {
  const result = core.evaluateWarnings(toolAction, snap, ticket, snap.project.governance);
  if (!result.warnings || result.warnings.length === 0) return [];
  return result.warnings.map(w => {
    const template = ((snap.project.governance || {}).messages || {})[w.kind];
    const ctx = Object.assign({}, extraContext || {}, w.context || {});
    return { kind: w.kind, context: w.context, message: core.renderMessage(template, ctx) };
  });
}

/**
 * Run a load → mutate → save cycle. The `mutate` callback receives the
 * current snapshot and returns the next one. Throws from `mutate` are
 * caught and translated to fail() with statusCode/kind/missing preserved.
 */
async function persist(storage, projectId, op, mutate, actor) {
  // SM-149: run load → mutate → save atomically inside the storage mutex so
  // two concurrent tool calls on the same project can't lose each other's
  // write (the old loadProject()+saveProject() pair had a lost-update window).
  let before = null;
  try {
    const saved = await storage.mutate(projectId, { actor, op }, (current) => {
      before = current;
      const next = mutate(current);
      validation.snapshotLimits(next);
      return next;
    });
    return { saved, before };
  } catch (err) {
    return { error: fail(err.message || "error", {
      statusCode: err.statusCode || 500,
      kind: err.kind,
      missing: err.missing
    })};
  }
}

/**
 * Build the MCP server.
 *
 *   storage      — shared Storage instance (SQLite via better-sqlite3)
 *   opts.httpUrl — base URL of the HTTP server for the standalone-MCP
 *                  cross-process bridge (request_switch_project). When set,
 *                  the tool POSTs to /api/internal/switch-request and long-
 *                  polls /api/internal/switch-response. When null, falls
 *                  back to in-process bus emit (useful for unit tests that
 *                  share the same process).
 *   opts.fetchImpl — fetch override for tests (defaults to global fetch).
 */
function buildServer(storage, opts) {
  opts = opts || {};
  const httpUrl = typeof opts.httpUrl === "string" ? opts.httpUrl : null;
  const fetchImpl = opts.fetchImpl || (typeof fetch === "function" ? fetch : null);
  const server = createRegistry();   // native tool registry (SM-308/310), was new McpServer(...)

  // E20.E: cross-process live-sync. The HTTP server's bus is in its OWN
  // process; MCP subprocess writes never reach connected browsers unless
  // we explicitly forward them. We listen on our local bus and POST each
  // change event to the HTTP server's `/api/internal/notify-change` endpoint,
  // which re-emits on its bus and broadcasts to matching subscribers.
  if (httpUrl && fetchImpl) {
    bus.on("change", async (ev) => {
      try {
        await fetchImpl(new URL("/api/internal/notify-change", httpUrl), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(ev)
        });
      } catch (e) {
        process.stderr.write(`[storymap-mcp] notify-change POST failed: ${e.message}\n`);
      }
    });
  }

  // -------------------- projects -----------------------------------------

  server.registerTool("list_projects", {
    description: "List all (non-deleted) project IDs",
    inputSchema: {}
  }, async () => {
    const projects = await storage.listProjects();
    return ok({ projects });
  });

  server.registerTool("project_get", {
    description: "Load the full snapshot of a project",
    inputSchema: { projectId: z.string() }
  }, async ({ projectId }) => {
    const snap = await storage.loadProject(projectId);
    if (!snap) return fail("project not found: " + projectId);
    return ok({ snapshot: snap });
  });

  server.registerTool("project_create", {
    description: "Create a new project. Optional fields: definitions (DoR/DoD), workflow (statuses + transitions + per-type overrides), entityTypeConfig (per-type modal config), ticketTypes (allowed type names).",
    inputSchema: {
      id: z.string(),
      name: z.string(),
      description: z.string().optional(),
      ticketPrefix: z.string().optional(),
      definitions:      passthroughObjectSchema.optional(),   // SM-31
      workflow:         passthroughObjectSchema.optional(),   // SM-31
      entityTypeConfig: passthroughObjectSchema.optional(),   // SM-31
      ticketTypes: z.array(z.string()).optional()
    }
  }, async (args) => {
    const actor = actorFromArgs(args);
    const body = {
      id: args.id, name: args.name,
      description: args.description,
      ticketPrefix: args.ticketPrefix,
      definitions: args.definitions,
      workflow: args.workflow,
      entityTypeConfig: args.entityTypeConfig,
      ticketTypes: args.ticketTypes
    };
    try { validation.projectInput(body); }
    catch (err) { return fail(err.message, { statusCode: err.statusCode || 400 }); }
    const project = core.normalizeProject(Object.assign({}, body, { createdBy: actor, updatedBy: actor }));
    // SM-254: seed a default release + process step so the project is usable.
    const snap = core.seedDefaultScaffold(
      core.normalizeSnapshot({ project, tickets: [], releases: [], processSteps: [] }), actor);
    const r = await storage.saveProject(project.id, snap, { actor, op: "project_create" });
    return ok({ revision: r.revision, savedAt: r.savedAt, snapshot: r.snapshot });
  });

  server.registerTool("project_update", {
    description: "Patch project header fields (name, description, ticketPrefix, definitions)",
    inputSchema: { projectId: z.string(), patch: passthroughObjectSchema }   // SM-31
  }, async ({ projectId, patch }) => {
    const actor = AI_ACTOR;
    // Route through core.ops.updateProject so the allowed-field list applies
    // (id / ticketPrefix / ticketCounter are locked — a blind Object.assign
    // would let a patch reset the counter and break existing ticketKeys). SM-148.
    const r = await persist(storage, projectId, "project_update", (cur) => {
      const next = core.ops.updateProject(cur, patch || {}, actor);
      validation.projectInput(next.project);   // SM-148: keep header validation (name/prefix)
      return next;
    }, actor);
    if (r.error) return r.error;
    return ok({ revision: r.saved.revision, savedAt: r.saved.savedAt, project: r.saved.snapshot.project });
  });

  server.registerTool("project_delete", {
    description: "Soft-delete a project (filtered out of list_projects)",
    inputSchema: { projectId: z.string() }
  }, async ({ projectId }) => {
    await storage.deleteProject(projectId, { actor: AI_ACTOR });
    return ok({ deleted: projectId });
  });

  // -------------------- tickets ------------------------------------------

  server.registerTool("list_tickets", {
    description: "List non-deleted tickets of a project. Filters (all optional, AND-combined): "
      + "`status` (exact match), `type` (exact match), `releaseId` / `processStepId` / `epicId` "
      + "(exact match, OR pass 'none' or '' to filter for tickets WITHOUT that assignment — "
      + "e.g. backlog tickets or orphans). `epicId` resolves via the `contains` link graph "
      + "(position.epicId is never persisted — SM-52). Set `compact: true` to return only "
      + "{id, ticketKey, type, status, title, position} per ticket — shrinks ~80-ticket "
      + "projects from ~400 KB to ~10 KB (SM-98).",
    inputSchema: {
      projectId: z.string(),
      status: z.string().optional(),
      type: z.string().optional(),
      releaseId: z.string().optional(),
      processStepId: z.string().optional(),
      epicId: z.string().optional(),
      compact: z.boolean().optional()
    }
  }, async ({ projectId, status, type, releaseId, processStepId, epicId, compact }) => {
    const snap = await storage.loadProject(projectId);
    if (!snap) return fail("project not found: " + projectId);
    let list = snap.tickets.filter(t => !t.isDeleted);
    if (status) list = list.filter(t => t.status === status);
    if (type)   list = list.filter(t => t.type === type);
    // Sentinel: "" or "none" → absent. Any other string → exact match.
    const isAbsentSentinel = (v) => v === "" || v === "none";
    const matchField = (filterVal, ticketVal) => {
      if (filterVal === undefined) return true;
      if (isAbsentSentinel(filterVal)) return ticketVal == null;
      return ticketVal === filterVal;
    };
    if (releaseId !== undefined) {
      list = list.filter(t => matchField(releaseId, t.position && t.position.releaseId));
    }
    if (processStepId !== undefined) {
      list = list.filter(t => matchField(processStepId, t.position && t.position.processStepId));
    }
    // epicId: position.epicId is always null (containers live on contains-links).
    // Resolve via the link graph instead.
    if (epicId !== undefined) {
      const containerByChild = new Map();
      for (const t of snap.tickets) {
        for (const ln of (t.links || [])) {
          if (ln.linkTypeId === "contains") containerByChild.set(ln.targetTicketId, t.id);
        }
      }
      if (isAbsentSentinel(epicId)) {
        list = list.filter(t => !containerByChild.has(t.id));
      } else {
        list = list.filter(t => containerByChild.get(t.id) === epicId);
      }
    }
    if (compact === true) {
      list = list.map(ticketSummary);
    }
    return ok({ tickets: list });
  });

  server.registerTool("next_actionable", {
    description: "What can I start NOW? Returns the work-item tickets that are ready to pull: "
      + "status category 'todo', DoR met (all required DoR items checked) OR already at status "
      + "'ready', and NOT blocked by an unresolved blocking/precedence predecessor (a linked "
      + "ticket that isn't done). Epics are excluded (containers, not work). Ordered as a do-next "
      + "queue: position.sortOrder then ticketKey. Each item is the compact ticket summary "
      + "{id, ticketKey, type, status, title, position} plus a `reason`. Optional `releaseId` / "
      + "`type` narrow the queue. Use this to decide the next task instead of scanning list_tickets.",
    inputSchema: {
      projectId: z.string(),
      releaseId: z.string().optional(),
      type: z.string().optional()
    }
  }, async ({ projectId, releaseId, type }) => {
    const snap = await storage.loadProject(projectId);
    if (!snap) return fail("project not found: " + projectId);
    const ids = coreGraph.actionableTickets(snap, { releaseId, type });
    const byId = new Map(snap.tickets.map(t => [t.id, t]));
    const tickets = ids.map(id => {
      const t = byId.get(id);
      const s = ticketSummary(t);
      s.reason = t.status === "ready" ? "ready to pull" : "DoR met, unblocked";
      return s;
    });
    return ok({ tickets });
  });

  server.registerTool("generate_product_doc", {
    description: "Generate a current-state product description (Markdown) by FOLDING the tickets "
      + "(SM-176/177, direction B). Each epic is a feature: its release, a derived status "
      + "(shipped/in-progress/planned from its stories), the realising stories + their acceptance "
      + "criteria, and — with includeTests:true — its linked test-definitions and their health. "
      + "Optional releaseId scopes to one release. Optional `types` is an allowlist of work-item "
      + "types that count as content — pass e.g. [\"epic\",\"user-story\",\"technical-task-backend\","
      + "\"technical-task-ui\"] for a PRD so bugs and tests are excluded (the noise the raw fold "
      + "shows). This is the deterministic, TRACEABLE skeleton — narrate/refine the prose yourself. "
      + "Pass saveAsAttachment:true to ALSO write the generated Markdown back as a project-level "
      + "attachment (SM-182 round-trip — closes the loop so the current doc is persisted alongside "
      + "the source PRD); attachmentFilename defaults to 'product-description.md'.",
    inputSchema: {
      projectId: z.string(),
      releaseId: z.string().optional(),
      includeTests: z.boolean().optional(),
      types: tolerateJsonString(z.array(z.string())).optional(),
      saveAsAttachment: z.boolean().optional(),
      attachmentFilename: z.string().optional()
    }
  }, async ({ projectId, releaseId, includeTests, types, saveAsAttachment, attachmentFilename }) => {
    const snap = await storage.loadProject(projectId);
    if (!snap) return fail("project not found: " + projectId);
    const model = coreGraph.foldProductDescription(snap, {
      releaseId,
      types: Array.isArray(types) ? types : undefined
    });
    const markdown = renderProductDoc(model, {
      projectName: (snap.project && snap.project.name) || projectId,
      includeTests: includeTests === true
    });
    const result = { markdown };
    if (saveAsAttachment === true) {
      const filename = (attachmentFilename && String(attachmentFilename).trim()) || "product-description.md";
      try {
        // Project-level (no ticketId): the regenerated doc lives next to the source PRD.
        result.attachment = await storage.addAttachment(projectId,
          { filename, mimeType: "text/markdown", buffer: Buffer.from(markdown, "utf8") },
          actorFromArgs({}));
      } catch (e) {
        return fail(e.message || "doc write-back failed", e.statusCode ? { statusCode: e.statusCode } : undefined);
      }
    }
    return ok(result);
  });

  // -------------------- attachments — binary seam (SM-184) ------------------
  // Transport-agnostic agent access to binary reference docs (PRDs, designs):
  // content flows over the MCP channel as base64 for SMALL files, and via a
  // downloadUrl (out-of-band HTTP) for large ones — never via filesystem paths,
  // so this survives a multi-user/remote server future.
  const ATTACHMENT_INLINE_MAX = 256 * 1024;   // inline base64 only up to 256 KB
  function attachmentDownloadUrl(meta) {
    const base = httpUrl ? httpUrl.replace(/\/$/, "") : "";
    return base + "/api/projects/" + encodeURIComponent(meta.projectId)
      + "/attachments/" + encodeURIComponent(meta.id);
  }

  server.registerTool("attachment_list", {
    description: "List binary attachments (metadata only — no content) of a project. Pass ticketId "
      + "to scope to one ticket, or ticketId=\"none\" for project-level attachments only (e.g. a "
      + "source PRD). Returns [{id, filename, mimeType, size, ticketId, uploadedAt}].",
    inputSchema: { projectId: z.string(), ticketId: z.string().optional() }
  }, async ({ projectId, ticketId }) => {
    const list = await storage.listAttachments(projectId, ticketId != null ? { ticketId } : {});
    return ok({ attachments: list });
  });

  server.registerTool("attachment_put", {
    description: "Upload a binary attachment (base64) to a project. OMIT ticketId for a "
      + "PROJECT-LEVEL attachment (e.g. a source PRD/PLD that precedes the tickets it will be "
      + "decomposed into) — this is the standard create flow: project_create → attachment_put "
      + "(no ticketId) → attachment_get it back to read + decompose. Pass ticketId only to attach "
      + "a doc to one specific ticket. Returns {id, filename, mimeType, size, ...}. Max 25 MB.",
    inputSchema: {
      projectId: z.string(),
      filename: z.string(),
      contentBase64: z.string(),
      mimeType: z.string().optional(),
      ticketId: z.string().optional()
    }
  }, async ({ projectId, filename, contentBase64, mimeType, ticketId }) => {
    // Buffer.from(…,"base64") never throws (lenient); empty/garbage falls through
    // to storage's own length/limit guards, which we translate to a clean error.
    const buffer = Buffer.from(String(contentBase64 || ""), "base64");
    try {
      const meta = await storage.addAttachment(projectId, { ticketId, filename, mimeType, buffer }, actorFromArgs({}));
      return ok({ attachment: meta });
    } catch (e) {
      // Parity with the rest of the surface: storage throws { statusCode } for
      // project-not-found (404) / too-large (413) — emit the structured shape.
      return fail(e.message || "attachment upload failed", e.statusCode ? { statusCode: e.statusCode } : undefined);
    }
  });

  server.registerTool("attachment_get", {
    description: "Read a binary attachment. ALWAYS returns metadata + a downloadUrl (the REST "
      + "endpoint — fetch out-of-band for large files). For SMALL files (<=256 KB) it also inlines "
      + "contentBase64 so you can read it directly off the channel. For a big PDF, use the URL "
      + "instead of bloating the context.",
    inputSchema: { attachmentId: z.string() }
  }, async ({ attachmentId }) => {
    const meta = await storage.getAttachment(attachmentId);
    if (!meta) return fail("attachment not found: " + attachmentId);
    const out = {
      id: meta.id, projectId: meta.projectId, ticketId: meta.ticketId,
      filename: meta.filename, mimeType: meta.mimeType, size: meta.size,
      downloadUrl: attachmentDownloadUrl(meta)
    };
    if (meta.size <= ATTACHMENT_INLINE_MAX) {
      try { out.contentBase64 = require("fs").readFileSync(meta.absPath).toString("base64"); }
      catch (_) { /* file missing — metadata + url still useful */ }
    }
    return ok(out);
  });

  server.registerTool("attachment_delete", {
    description: "Delete a binary attachment by id. Returns {deleted: id|null}.",
    inputSchema: { attachmentId: z.string() }
  }, async ({ attachmentId }) => {
    const removed = await storage.removeAttachment(attachmentId, actorFromArgs({}));
    return ok({ deleted: removed ? attachmentId : null });
  });

  // ---------------------------------------------------------------------------
  // SM-196/R-5 — spec layer: ingest a PRD into candidate sections, then author
  // requirement SpecObjects under a spec module. The DECOMPOSITION is the
  // agent's job; these tools are only the substrate (no NLP on the server).
  // ---------------------------------------------------------------------------

  server.registerTool("ingest_slice_candidates", {
    description: "Read a project attachment (a source PRD), convert it to Markdown server-side "
      + "(pdf2json/fflate — no OCR, no CDN), and algorithmically pre-slice it at headings into an "
      + "ORDERED list of candidate sections, each with a DOORS-style sectionPath + char range. This "
      + "is the substrate for requirement extraction: call it on a project-level attachment, then "
      + "YOU (the agent) turn each section's body into atomic `requirement` tickets via "
      + "requirement_create (anchoring sourceAnchor.{attachmentId,sectionId,charStart,charEnd}). "
      + "Pass includeMarkdown:true to also get the full converted Markdown.",
    inputSchema: { attachmentId: z.string(), includeMarkdown: z.boolean().optional() }
  }, async ({ attachmentId, includeMarkdown }) => {
    const meta = await storage.getAttachment(attachmentId);
    if (!meta) return fail("attachment not found: " + attachmentId);
    let buffer;
    try { buffer = require("fs").readFileSync(meta.absPath); }
    catch (_e) { return fail("attachment file unreadable: " + attachmentId, { statusCode: 404 }); }
    let converted;
    try {
      converted = await ingest.ingestToMarkdown(buffer, { filename: meta.filename, mimeType: meta.mimeType });
    } catch (e) {
      return fail(e.message || "ingest failed", { statusCode: e.statusCode || 500, kind: e.kind });
    }
    const sections = slice.sliceMarkdown(converted.markdown);
    const out = {
      attachmentId, filename: meta.filename, format: converted.format,
      sectionCount: sections.length,
      sections: sections.map(s => ({
        sectionPath: s.sectionPath, level: s.level, heading: s.heading,
        body: s.body, charStart: s.charStart, charEnd: s.charEnd
      }))
    };
    if (includeMarkdown) out.markdown = converted.markdown;
    return ok(out);
  });

  server.registerTool("spec_module_create", {
    description: "Create a spec module — the container for the requirements sliced from ONE source "
      + "PRD (DOORS module / ReqIF Specification). Bind it to its source via sourceAttachmentId. "
      + "Requirements created with this module's id are contained (ordered by sectionPath). The "
      + "module is board-excluded (not on kanban/story-map). Compact response by default.",
    inputSchema: {
      projectId: z.string(),
      title: z.string(),
      sourceAttachmentId: z.string().optional(),
      description: z.string().optional(),
      verbose: z.boolean().optional()
    }
  }, async (args) => {
    const actor = AI_ACTOR;
    const r = await persist(storage, args.projectId, "spec_module_create", (cur) => {
      validation.ticketInput({ title: args.title, type: "spec-module", description: args.description }, cur.project);
      return core.ops.createTicket(cur, {
        type: "spec-module", title: args.title, description: args.description,
        sourceAttachmentId: args.sourceAttachmentId
      }, actor);
    }, actor);
    if (r.error) return r.error;
    const ticket = r.saved.snapshot.tickets[r.saved.snapshot.tickets.length - 1];
    return ok({ revision: r.saved.revision, savedAt: r.saved.savedAt,
      ticket: args.verbose ? ticket : { id: ticket.id, ticketKey: ticket.ticketKey, type: ticket.type,
        title: ticket.title, sourceAttachmentId: ticket.sourceAttachmentId } });
  });

  server.registerTool("requirement_create", {
    description: "Create a `requirement` SpecObject — one atomic, sliced PRD statement. Provide its "
      + "sectionPath (DOORS object id, e.g. '2.1') and sourceAnchor (back-ref into the PRD). Pass "
      + "moduleId to contain it under a spec module (so it joins the ordered chain). The requirement "
      + "is board-excluded and carries no DoR/DoD — it is a link TARGET for `realises` (an "
      + "implementing story/epic → this requirement) and `tests`. Compact response by default.",
    inputSchema: {
      projectId: z.string(),
      title: z.string(),
      moduleId: z.string().optional(),
      sectionPath: z.string().optional(),
      sourceAnchor: sourceAnchorSchema.optional(),
      description: z.string().optional(),
      verbose: z.boolean().optional()
    }
  }, async (args) => {
    const actor = AI_ACTOR;
    // Capture the created id INSIDE the mutate closure — re-finding it
    // afterwards by title+sectionPath returns the wrong (older) ticket when two
    // requirements share those, silently mis-anchoring downstream trace links.
    let createdId = null;
    const r = await persist(storage, args.projectId, "requirement_create", (cur) => {
      validation.ticketInput({ title: args.title, type: "requirement", description: args.description }, cur.project);
      let next = core.ops.createTicket(cur, {
        type: "requirement", title: args.title, description: args.description,
        sectionPath: args.sectionPath, sourceAnchor: args.sourceAnchor
      }, actor);
      const req = next.tickets[next.tickets.length - 1];
      createdId = req.id;
      if (args.moduleId) {
        next = core.ops.addLink(next, args.moduleId, { linkTypeId: "contains", targetTicketId: req.id }, actor);
      }
      return next;
    }, actor);
    if (r.error) return r.error;
    const ticket = r.saved.snapshot.tickets.find(t => t.id === createdId);
    return ok({ revision: r.saved.revision, savedAt: r.saved.savedAt,
      ticket: args.verbose ? ticket : { id: ticket.id, ticketKey: ticket.ticketKey, type: ticket.type,
        title: ticket.title, sectionPath: ticket.sectionPath, moduleId: args.moduleId || null } });
  });

  server.registerTool("requirement_list", {
    description: "List requirement SpecObjects of a project, in document order (by sectionPath). "
      + "Pass moduleId to scope to one spec module's contained requirements. Returns "
      + "[{id, ticketKey, sectionPath, title, sourceAnchor}].",
    inputSchema: { projectId: z.string(), moduleId: z.string().optional() }
  }, async ({ projectId, moduleId }) => {
    const snap = await storage.loadProject(projectId);
    if (!snap) return fail("project not found: " + projectId);
    let reqs;
    if (moduleId) {
      reqs = core.tickets.requirementsInModule(snap, moduleId);
    } else {
      reqs = (snap.tickets || []).filter(t => !t.isDeleted && t.type === "requirement")
        .slice().sort((a, b) => core.compareSectionPath(a.sectionPath, b.sectionPath));
    }
    return ok({ requirements: reqs.map(r => ({
      id: r.id, ticketKey: r.ticketKey, sectionPath: r.sectionPath, title: r.title, sourceAnchor: r.sourceAnchor
    })) });
  });

  server.registerTool("get_trace_coverage", {
    description: "Direction-A coverage report (mirror of generate_product_doc). For each requirement, "
      + "counts the incoming `realises` (implementing story/epic — DOORS satisfies) and `tests` links "
      + "and classifies it: covered (exactly 1 realises) / over-covered (>1) / orphan (none) / "
      + "suspect (tested but not implemented). Returns per-requirement rows (ordered by sectionPath) + "
      + "a summary. Pass moduleId to scope to one spec module. Use this to answer 'is the PRD fully "
      + "covered, and what's missing?'.",
    inputSchema: { projectId: z.string(), moduleId: z.string().optional() }
  }, async ({ projectId, moduleId }) => {
    const snap = await storage.loadProject(projectId);
    if (!snap) return fail("project not found: " + projectId);
    const cov = coreGraph.traceCoverage(snap, moduleId ? { moduleId } : {});
    cov.requirements.sort((a, b) => core.compareSectionPath(a.sectionPath, b.sectionPath));
    return ok(cov);
  });

  server.registerTool("get_drift_report", {
    description: "Round-trip / drift report (SM-182, direction-A Phase 4) — keeps the PRD a living "
      + "document by surfacing where the doc and the tickets have diverged. Three signals: "
      + "orphanRequirements (a requirement no ticket `realises`), suspectRequirements (only `tests`, "
      + "no implementer), danglingLinks (a realises/tests link whose target is deleted or not a "
      + "requirement), and supersededTrace (a `realises` anchored on a superseded/historical feature "
      + "version — the implementation moved on but the anchor stayed). Pass moduleId to scope the "
      + "requirement checks to one spec module. summary.clean=true means no drift. Run it after big "
      + "ticket changes, then re-generate the product doc (generate_product_doc) to close the loop.",
    inputSchema: { projectId: z.string(), moduleId: z.string().optional() }
  }, async ({ projectId, moduleId }) => {
    const snap = await storage.loadProject(projectId);
    if (!snap) return fail("project not found: " + projectId);
    const report = coreGraph.driftReport(snap, moduleId ? { moduleId } : {});
    return ok(report);
  });

  server.registerTool("query_tickets", {
    description: "Targeted ticket search (SM-187) with a JQL-angelehnter query language — the precise "
      + "alternative to list_tickets + manual sieving once a project is large. Same language as the "
      + "browser smart-bar. Fields: type, status, key, title, description, text (~ full-text over "
      + "key+title+description+labels), release, processStep, epic (containing epic, by key), label, "
      + "linkedTo / linkedFrom (by ticket key), acCount, created, updated. Operators: = != ~ IN "
      + "'NOT IN' < > <= >= ; AND/OR/NOT (AND binds tighter), "
      + "parentheses, optional 'ORDER BY <field> [ASC|DESC]'. Quote values with spaces. Examples: "
      + "`type = user-story AND status IN (ready, in-progress)`, "
      + "`epic = SM-173 AND type != bug ORDER BY updated DESC`, `text ~ login AND label = frontend`. "
      + "Returns { count, tickets:[{id,ticketKey,type,status,title,position}] } (ordered). A syntax or "
      + "semantic error (unknown field / disallowed operator) comes back as a structured isError with "
      + "kind:\"QUERY\" + message + position.",
    inputSchema: { projectId: z.string(), query: z.string() }
  }, async ({ projectId, query }) => {
    const snap = await storage.loadProject(projectId);
    if (!snap) return fail("project not found: " + projectId);
    // SM-260: strictRefs — an unknown release/processStep/epic value comes back
    // as a QUERY error instead of a misleading empty result.
    const r = queryEngine.queryTickets(snap, query, { strictRefs: true });
    if (r.error) {
      return fail(r.error.message, { kind: "QUERY", position: r.error.position, field: r.error.field });
    }
    return ok({ count: r.tickets.length, tickets: r.tickets.map(ticketSummary) });
  });

  server.registerTool("ticket_get", {
    description: "Get a ticket by id (includes frozen DoR/DoD checklists). Default "
      + "returns the FULL ticket. Pass compact:true for the {id, ticketKey, type, status, "
      + "title, position} summary, or fields:[...] to pick only the named top-level fields "
      + "(id + ticketKey are always included). compact wins over fields if both are passed.",
    inputSchema: {
      projectId: z.string(),
      ticketId:  z.string(),
      compact:   z.boolean().optional(),
      fields:    z.array(z.string()).optional()
    }
  }, async ({ projectId, ticketId, compact, fields }) => {
    const snap = await storage.loadProject(projectId);
    if (!snap) return fail("project not found: " + projectId);
    const t = findEntity(snap, "tickets", ticketId);
    if (!t || t.isDeleted) return fail("ticket not found: " + ticketId);
    if (compact === true) return ok({ ticket: ticketSummary(t) });
    if (Array.isArray(fields) && fields.length > 0) {
      const picked = { id: t.id, ticketKey: t.ticketKey };
      for (const f of fields) {
        if (Object.prototype.hasOwnProperty.call(t, f)) picked[f] = t[f];
      }
      return ok({ ticket: picked });
    }
    return ok({ ticket: t });
  });

  server.registerTool("ticket_create", {
    description: "Create a ticket. Pass acceptanceCriteria as [{text}] to set them at creation (no more create-then-update). The DoR/DoD checklists are resolved from the project's definitions for this ticket type and FROZEN onto the ticket. Compact response by default ({revision, savedAt, ticket:{id, ticketKey, type, status, title, position}}); pass verbose:true for the full ticket.",
    inputSchema: {
      projectId: z.string(),
      type: z.string(),
      title: z.string(),
      description: z.string().optional(),
      position: positionSchema,
      labels: z.array(z.string()).optional(),
      acceptanceCriteria: acceptanceCriteriaSchema,
      verbose: z.boolean().optional()
    }
  }, async (args) => {
    const actor = AI_ACTOR;
    const r = await persist(storage, args.projectId, "ticket_create", (cur) => {
      validation.ticketInput(args, cur.project);
      return core.ops.createTicket(cur, args, actor);
    }, actor);
    if (r.error) return r.error;
    const ticket = r.saved.snapshot.tickets[r.saved.snapshot.tickets.length - 1];
    return ok({ revision: r.saved.revision, savedAt: r.saved.savedAt,
      ticket: args.verbose ? ticket : ticketSummary(ticket) });
  });

  server.registerTool("ticket_update", {
    description: "Patch a ticket (title, description, type, position, labels, acceptanceCriteria). "
      + "SM-94 HARD gate: published test-definitions reject step/prereq edits (use "
      + "`update_test_definition_metadata` for title/description/labels OR create a "
      + "`modifies`-ticket on the target story to evolve the spec). SOFT gate: editing "
      + "acceptanceCriteria/description/definitionOfReady on a ready+ ticket surfaces "
      + "`warnings:[{kind:'SPEC_FROZEN_EDIT', ...}]` in the response but doesn't block — "
      + "cosmetic edits go through; behavioural changes should be modelled via `modifies`. "
      + "A `status` in the patch is rejected for epics (kind=EPIC_STATUS_DERIVED) — epic status is derived from its stories.",
    inputSchema: { projectId: z.string(), ticketId: z.string(), patch: ticketPatchSchema, verbose: z.boolean().optional() }
  }, async ({ projectId, ticketId, patch, verbose }) => {
    const actor = AI_ACTOR;
    // SM-94 hard gate: published test-definition rejects step/prereq edits.
    const snap0 = await storage.loadProject(projectId);
    if (!snap0) return fail("project not found: " + projectId, { statusCode: 404 });
    const ticket0 = findEntity(snap0, "tickets", ticketId);
    if (!ticket0) return fail("ticket not found: " + ticketId, { statusCode: 404 });
    const p = patch || {};
    if (ticket0.type === "test-definition" && ticket0.lifecycle === "published") {
      const forbidden = ["steps", "prerequisites"].filter(k =>
        Object.prototype.hasOwnProperty.call(p, k));
      if (forbidden.length > 0) {
        return fail("steps/prerequisites are frozen on a published test-definition", {
          kind: "DEFINITION_FROZEN",
          message: {
            title: "Definition is frozen",
            reason: "Definition " + (ticket0.ticketKey || ticket0.id) + " is published. The "
              + "fields " + forbidden.join(", ") + " are part of the spec and cannot be edited.",
            suggestion: "Use `update_test_definition_metadata` for title/description/labels, OR "
              + "create a `modifies`-ticket on the target story (link_create with "
              + "linkTypeId='modifies') to evolve the spec, then reopen the definition.",
            skillRef: "Published test-definitions are immutable spec records. Evolve via modifies-tickets."
          },
          statusCode: 422
        });
      }
    }
    // SM-94 soft warn: editing spec fields on a ready+ ticket.
    const SPEC_FIELDS = ["acceptanceCriteria", "description", "definitionOfReady"];
    let specFrozenWarning = null;
    if (ticket0.status && ticket0.status !== "backlog" && ticket0.status !== "ready") {
      // status > backlog OR ready is technically also ≥ ready (statuses ordered).
    }
    // For simplicity: ANY non-backlog status is "frozen" for spec edits.
    if (ticket0.status && ticket0.status !== "backlog") {
      const touched = SPEC_FIELDS.filter(k => Object.prototype.hasOwnProperty.call(p, k));
      if (touched.length > 0) {
        specFrozenWarning = {
          kind: "SPEC_FROZEN_EDIT",
          context: { fields: touched, ticketKey: ticket0.ticketKey, status: ticket0.status },
          message: {
            title: "Editing spec on a ready+ ticket",
            reason: "Ticket " + (ticket0.ticketKey || ticket0.id) + " is in status='" + ticket0.status
              + "'. Editing spec fields (" + touched.join(", ") + ") after the spec is frozen "
              + "is allowed but discouraged for behavioural changes.",
            suggestion: "For cosmetic edits (typos, formatting), proceed. For behavioural changes, "
              + "consider creating a `modifies`-ticket pointing at this ticket so the change is "
              + "auditable and linked test-definitions can detect staleness.",
            skillRef: "Specs frieren ein. Aenderungen werden zu Tickets."
          }
        };
      }
    }
    const r = await persist(storage, projectId, "ticket_update", (cur) => {
      const existing = findEntity(cur, "tickets", ticketId);
      if (!existing) throw Object.assign(new Error("ticket not found"), { statusCode: 404 });
      validation.ticketInput(Object.assign({}, existing, p), cur.project);
      return core.ops.updateTicket(cur, ticketId, p, actor);
    }, actor);
    if (r.error) return r.error;
    const full = findEntity(r.saved.snapshot, "tickets", ticketId);
    const response = {
      revision: r.saved.revision, savedAt: r.saved.savedAt,
      ticket: verbose ? full : ticketSummary(full)
    };
    if (specFrozenWarning) response.warnings = [specFrozenWarning];
    return ok(response);
  });

  server.registerTool("ticket_delete", {
    description: "Soft-delete a ticket",
    inputSchema: { projectId: z.string(), ticketId: z.string() }
  }, async ({ projectId, ticketId }) => {
    const actor = AI_ACTOR;
    const r = await persist(storage, projectId, "ticket_delete",
      (cur) => core.ops.softDeleteTicket(cur, ticketId, actor), actor);
    if (r.error) return r.error;
    return ok({ revision: r.saved.revision, savedAt: r.saved.savedAt, deleted: ticketId });
  });

  server.registerTool("change_ticket_status", {
    description: "Change a ticket's status. Forward transitions crossing → ready check DoR; crossing → done check DoD. A transition INTO the done category ALSO fires the complete_ticket governance gates (SM-299: MISSING_TEST_DEFINITION for user-story/bug, STALE_LINKED_DEF, OPEN_MODIFIES) — there is no bypass around complete_ticket. Failures come back as isError with kind/missing. NOT applicable to epics — an epic's status is DERIVED (roll-up) from its contained stories; an attempt returns kind=EPIC_STATUS_DERIVED. Move the stories instead. Compact response by default ({…, ticket: summary}); pass verbose:true for the full ticket.",
    inputSchema: { projectId: z.string(), ticketId: z.string(), status: z.string(), verbose: z.boolean().optional() }
  }, async ({ projectId, ticketId, status, verbose }) => {
    const actor = AI_ACTOR;
    // SM-299: a status change INTO the done category must fire the same
    // governance gates as complete_ticket — otherwise change_ticket_status:done
    // is a one-call bypass of MISSING_TEST_DEFINITION / STALE_LINKED_DEF /
    // OPEN_MODIFIES (review finding F1 on a0c6dde).
    const snap0 = await storage.loadProject(projectId);
    if (!snap0) return fail("project not found: " + projectId, { statusCode: 404 });
    const ticket0 = findEntity(snap0, "tickets", ticketId);
    if (!ticket0) return fail("ticket not found: " + ticketId, { statusCode: 404 });
    if (core.statusCategoryOf(snap0.project, status) === "done") {
      const gateFail = runGovernanceGates(snap0, "complete_ticket", ticket0, {
        targetKey: ticket0.ticketKey || ticketId, targetType: ticket0.type
      });
      if (gateFail) return gateFail;
    }
    const r = await persist(storage, projectId, "ticket_change_status", (cur) => {
      const t = findEntity(cur, "tickets", ticketId);
      if (!t) throw Object.assign(new Error("ticket not found"), { statusCode: 404 });
      validation.changeStatusTransition(t, status, cur.project);
      return core.ops.changeStatus(cur, ticketId, status, actor);
    }, actor);
    if (r.error) return r.error;
    const full = findEntity(r.saved.snapshot, "tickets", ticketId);
    return ok({
      revision: r.saved.revision, savedAt: r.saved.savedAt,
      ticket: verbose ? full : ticketSummary(full)
    });
  });

  server.registerTool("cancel_ticket", {
    description: "Cancel a ticket — record a deliberate non-implementation (scope reduction), gate-free. Cancel ≠ Delete: cancel keeps the ticket VISIBLE with its full history + links (use ticket_delete only for mistakes). Cancelling an EPIC cascades: every contained non-terminal story is cancelled in one revision and the epic rolls up to cancelled (or done, if some stories had already shipped). Cancelled tickets drop out of release progress and never block completing a release; reopen by moving them to any earlier status (ungated). Spec types (requirement/spec-module) have their own lifecycle and are rejected. Compact response by default; verbose:true for the full ticket.",
    inputSchema: { projectId: z.string(), ticketId: z.string(), verbose: z.boolean().optional() }
  }, async ({ projectId, ticketId, verbose }) => {
    const actor = AI_ACTOR;
    // op-tag distinguishes a single cancel from the epic cascade in the history.
    const snap0 = await storage.loadProject(projectId);
    if (!snap0) return fail("project not found: " + projectId, { statusCode: 404 });
    const t0 = findEntity(snap0, "tickets", ticketId);
    const opTag = (t0 && t0.type === "epic") ? "epic_cancel" : "ticket_cancel";
    const r = await persist(storage, projectId, opTag, (cur) => {
      const t = findEntity(cur, "tickets", ticketId);
      if (!t) throw Object.assign(new Error("ticket not found"), { statusCode: 404 });
      return core.ops.cancelTicket(cur, ticketId, actor);
    }, actor);
    if (r.error) return r.error;
    const full = findEntity(r.saved.snapshot, "tickets", ticketId);
    return ok({
      revision: r.saved.revision, savedAt: r.saved.savedAt,
      ticket: verbose ? full : ticketSummary(full)
    });
  });

  // -------------------- DoR/DoD definitions + item checks (E7) ------------

  // SM-164: get_config / set_config replace the ten get/set_{definitions,
  // workflow, kanban_columns, governance, link_types} tools. See the
  // readConfigSection / applyConfigSection dispatchers up top.
  server.registerTool("get_config", {
    description: "Read a project config section. section ∈ definitions | workflow | "
      + "kanban_columns | governance | link_types. Returns {section, value}. For "
      + "section='workflow', pass optional `type` to get the EFFECTIVE per-ticket-type "
      + "workflow (byType overrides merged in).",
    inputSchema: {
      projectId: z.string(),
      section:   z.enum(CONFIG_SECTIONS),
      type:      z.string().optional()
    }
  }, async ({ projectId, section, type }) => {
    const snap = await storage.loadProject(projectId);
    if (!snap) return fail("project not found: " + projectId, { statusCode: 404 });
    return ok({ section, value: readConfigSection(snap.project, section, type) });
  });

  server.registerTool("set_config", {
    description: "Replace a project config section (full replace, no merge). section ∈ "
      + "definitions | workflow | kanban_columns | governance | link_types. `value` is the "
      + "new block: an object for definitions/workflow/governance, an array for "
      + "kanban_columns/link_types (JSON-string tolerated for the MCP bridge). Per-section "
      + "validation is preserved: workflow needs ≥1 status; governance gate predicates must "
      + "be in the closed set (else kind=UNKNOWN_PREDICATE); definitions only affect tickets "
      + "created AFTER this call (existing keep their frozen checklists). Returns "
      + "{revision, savedAt, section, value}.",
    inputSchema: {
      projectId: z.string(),
      section:   z.enum(CONFIG_SECTIONS),
      value:     configValueSchema
    }
  }, async ({ projectId, section, value }) => {
    const actor = AI_ACTOR;
    // Governance: validate predicate names up-front so we can return the rich
    // {unknown, knownPredicates} body (persist's catch only forwards kind/missing).
    if (section === "governance") {
      const predicateSet = new Set(Object.keys(core.GOVERNANCE_PREDICATES));
      const incoming = (value && typeof value === "object") ? value : {};
      const gates = incoming.gates || {};
      const unknown = [];
      for (const errorKind of Object.keys(gates)) {
        const cfg = gates[errorKind];
        if (!cfg || typeof cfg.predicate !== "string") continue;
        if (!predicateSet.has(cfg.predicate)) unknown.push({ errorKind, predicate: cfg.predicate });
      }
      if (unknown.length > 0) {
        return fail("governance references unknown predicate(s)", {
          kind: "UNKNOWN_PREDICATE", statusCode: 400,
          unknown, knownPredicates: Array.from(predicateSet)
        });
      }
    }
    const r = await persist(storage, projectId, section + "_update",
      (cur) => applyConfigSection(section, cur, value, actor), actor);
    if (r.error) return r.error;
    return ok({
      revision: r.saved.revision, savedAt: r.saved.savedAt,
      section, value: readConfigSection(r.saved.snapshot.project, section)
    });
  });

  server.registerTool("resolve_definitions_for_ticket", {
    description: "Return the EFFECTIVE DoR/DoD checklists for a ticket — i.e. the per-ticket frozen items with their current checked-state. Use this to see what's left to do for mark_ready / complete_ticket.",
    inputSchema: { projectId: z.string(), ticketId: z.string() }
  }, async ({ projectId, ticketId }) => {
    const snap = await storage.loadProject(projectId);
    if (!snap) return fail("project not found: " + projectId);
    const t = findEntity(snap, "tickets", ticketId);
    if (!t || t.isDeleted) return fail("ticket not found: " + ticketId);
    return ok({
      ready: t.definitionOfReady.items,
      done: t.definitionOfDone.items
    });
  });

  // SM-124: one tool replaces the former four (check/uncheck × DoR/DoD).
  // `gate` selects the checklist, `checked` selects check vs uncheck.
  // Compact-by-default: returns just the toggled item's id + checked-state.
  // The full ticket (with both frozen checklists) is large and rarely needed
  // by the caller right after a toggle — pass verbose:true to get it.
  server.registerTool("set_checklist_item", {
    description: "Check or uncheck a single DoR/DoD item on a ticket. gate ∈ 'dor'|'dod' "
      + "selects the checklist; checked:true marks the item, checked:false clears it. "
      + "Compact response by default: {revision, savedAt, item:{id, checked}}. Pass "
      + "verbose:true for the full ticket (both frozen checklists, AC, links, …).",
    inputSchema: {
      projectId: z.string(),
      ticketId:  z.string(),
      gate:      z.enum(["dor", "dod"]),
      itemId:    z.string(),
      checked:   z.boolean(),
      verbose:   z.boolean().optional()
    }
  }, async ({ projectId, ticketId, gate, itemId, checked, verbose }) => {
    const actor = AI_ACTOR;
    const opName = (gate === "dor")
      ? (checked ? "checkDorItem" : "uncheckDorItem")
      : (checked ? "checkDodItem" : "uncheckDodItem");
    const op = "ticket_" + gate + "_" + (checked ? "check" : "uncheck");
    const r = await persist(storage, projectId, op,
      (cur) => core.ops[opName](cur, ticketId, itemId, actor), actor);
    if (r.error) return r.error;
    const ticket = findEntity(r.saved.snapshot, "tickets", ticketId);
    if (verbose) {
      return ok({ revision: r.saved.revision, savedAt: r.saved.savedAt, ticket });
    }
    const items = (gate === "dor")
      ? ((ticket.definitionOfReady && ticket.definitionOfReady.items) || [])
      : ((ticket.definitionOfDone  && ticket.definitionOfDone.items)  || []);
    const item = items.find(i => i.id === itemId);
    return ok({
      revision: r.saved.revision, savedAt: r.saved.savedAt,
      item: item ? { id: item.id, checked: item.checked } : { id: itemId, checked: checked }
    });
  });

  server.registerTool("mark_ready", {
    description: "Shortcut for change_ticket_status → 'ready'. Fails with kind=DoR + missing[] if the DoR is not satisfied. NOT applicable to epics (kind=EPIC_STATUS_DERIVED) — epic status is derived from its stories. Compact response by default; pass verbose:true for the full ticket.",
    inputSchema: { projectId: z.string(), ticketId: z.string(), verbose: z.boolean().optional() }
  }, async ({ projectId, ticketId, verbose }) => {
    const actor = AI_ACTOR;
    const r = await persist(storage, projectId, "ticket_mark_ready", (cur) => {
      const t = findEntity(cur, "tickets", ticketId);
      if (!t) throw Object.assign(new Error("ticket not found"), { statusCode: 404 });
      validation.changeStatusTransition(t, "ready", cur.project);
      return core.ops.changeStatus(cur, ticketId, "ready", actor);
    }, actor);
    if (r.error) return r.error;
    const full = findEntity(r.saved.snapshot, "tickets", ticketId);
    return ok({
      revision: r.saved.revision, savedAt: r.saved.savedAt,
      ticket: verbose ? full : ticketSummary(full)
    });
  });

  server.registerTool("complete_ticket", {
    description: "Shortcut for change_ticket_status → 'done'. Coding agents MUST call this so the DoD gate fires explicitly. NOT applicable to epics — an epic's status is DERIVED from its contained stories (kind=EPIC_STATUS_DERIVED); complete the stories and the epic rolls up to done on its own. Pass checkDoD:true to auto-check every required DoD item first (one call instead of N× set_checklist_item + complete). Fails with kind=DoD + missing[] if any required DoD item is unchecked. SM-94: also runs SM-93 governance gates. SM-299: a user-story/bug is blocked with kind=MISSING_TEST_DEFINITION until a PUBLISHED test-definition is linked to it via a `tests`-link (create the test-definition, add steps, link_create tests→ticket, publish_test_definition, THEN complete). STALE_LINKED_DEF + OPEN_MODIFIES still apply (open `modifies`-tickets or a stale/failing linked test-definition also block).",
    inputSchema: { projectId: z.string(), ticketId: z.string(), checkDoD: z.boolean().optional(), verbose: z.boolean().optional() }
  }, async ({ projectId, ticketId, checkDoD, verbose }) => {
    const actor = AI_ACTOR;
    // SM-94: run governance gates first (STALE_LINKED_DEF + OPEN_MODIFIES).
    const snap0 = await storage.loadProject(projectId);
    if (!snap0) return fail("project not found: " + projectId, { statusCode: 404 });
    const ticket0 = findEntity(snap0, "tickets", ticketId);
    if (!ticket0) return fail("ticket not found: " + ticketId, { statusCode: 404 });
    const gateFail = runGovernanceGates(snap0, "complete_ticket", ticket0, {
      targetKey: ticket0.ticketKey || ticketId,
      targetType: ticket0.type   // SM-299: for the MISSING_TEST_DEFINITION message
    });
    if (gateFail) return gateFail;
    // DoD gate runs inside persist via validation.changeStatusTransition.
    const r = await persist(storage, projectId, "ticket_complete", (cur) => {
      let next = cur;
      let t = findEntity(next, "tickets", ticketId);
      if (!t) throw Object.assign(new Error("ticket not found"), { statusCode: 404 });
      // SM-260: checkDoD — tick every required DoD item before the gate, so a
      // completion is one call instead of N× set_checklist_item + complete.
      if (checkDoD) {
        const items = (t.definitionOfDone && t.definitionOfDone.items) || [];
        for (const it of items) {
          if (it.required && !it.checked) next = core.ops.checkDodItem(next, ticketId, it.id, actor);
        }
        t = findEntity(next, "tickets", ticketId);
      }
      validation.changeStatusTransition(t, "done", next.project);
      return core.ops.changeStatus(next, ticketId, "done", actor);
    }, actor);
    if (r.error) return r.error;
    const full = findEntity(r.saved.snapshot, "tickets", ticketId);
    return ok({
      revision: r.saved.revision, savedAt: r.saved.savedAt,
      ticket: verbose ? full : ticketSummary(full)
    });
  });

  // -------------------- releases -----------------------------------------

  server.registerTool("list_releases", {
    description: "List all non-deleted releases of a project. Returns an array of release objects sorted by sortOrder.",
    inputSchema: { projectId: z.string() }
  }, async ({ projectId }) => {
    const snap = await storage.loadProject(projectId);
    if (!snap) return fail("project not found: " + projectId, { statusCode: 404 });
    const list = (snap.releases || []).filter(r => !r.isDeleted)
      .slice().sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
    return ok(list);
  });

  server.registerTool("release_create", {
    description: "Create a new release on the project. Returns the created release plus revision/savedAt.",
    inputSchema: {
      projectId: z.string(),
      name: z.string(),
      description: z.string().optional(),
      status: z.string().optional(),
      startDate: z.string().optional(),
      endDate: z.string().optional()
    }
  }, async ({ projectId, ...partial }) => {
    const actor = AI_ACTOR;
    const r = await persist(storage, projectId, "release_create", (cur) => {
      validation.releaseInput(partial);
      return core.ops.createRelease(cur, partial, actor);
    }, actor);
    if (r.error) return r.error;
    const release = r.saved.snapshot.releases[r.saved.snapshot.releases.length - 1];
    return ok({ revision: r.saved.revision, savedAt: r.saved.savedAt, release });
  });

  server.registerTool("release_update", {
    description: "Patch fields on a release (name, description, status, startDate, endDate, sortOrder).",
    inputSchema: {
      projectId: z.string(),
      releaseId: z.string(),
      patch: passthroughObjectSchema
    }
  }, async ({ projectId, releaseId, patch }) => {
    const actor = AI_ACTOR;
    const r = await persist(storage, projectId, "release_update", (cur) => {
      const ex = findEntity(cur, "releases", releaseId);
      if (!ex) throw Object.assign(new Error("release not found"), { statusCode: 404 });
      return core.ops.updateRelease(cur, releaseId, patch || {}, actor);
    }, actor);
    if (r.error) return r.error;
    return ok({
      revision: r.saved.revision, savedAt: r.saved.savedAt,
      release: findEntity(r.saved.snapshot, "releases", releaseId)
    });
  });

  server.registerTool("release_delete", {
    description: "Soft-delete a release (recoverable via history). Refuses the LAST remaining release (422 kind=LAST_RELEASE) — a project always keeps ≥1 release.",
    inputSchema: { projectId: z.string(), releaseId: z.string() }
  }, async ({ projectId, releaseId }) => {
    const actor = AI_ACTOR;
    const r = await persist(storage, projectId, "release_delete",
      (cur) => {
        validation.releaseDelete(cur, releaseId);   // SM-255: 422 on last release
        return core.ops.softDeleteRelease(cur, releaseId, actor);
      },
      actor);
    if (r.error) return r.error;
    return ok({ revision: r.saved.revision, savedAt: r.saved.savedAt, deleted: releaseId });
  });

  // release reorder moved to the unified `reorder` tool (entity='releases', SM-165).

  // -------------------- process steps ------------------------------------

  server.registerTool("list_process_steps", {
    description: "List all non-deleted process steps of a project, sorted by sortOrder.",
    inputSchema: { projectId: z.string() }
  }, async ({ projectId }) => {
    const snap = await storage.loadProject(projectId);
    if (!snap) return fail("project not found: " + projectId, { statusCode: 404 });
    const list = (snap.processSteps || []).filter(p => !p.isDeleted)
      .slice().sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
    return ok(list);
  });

  server.registerTool("process_step_create", {
    description: "Create a new process step (a column on the story-map backbone).",
    inputSchema: {
      projectId: z.string(),
      name: z.string(),
      description: z.string().optional(),
      epicId: z.string().optional()
    }
  }, async ({ projectId, ...partial }) => {
    const actor = AI_ACTOR;
    const r = await persist(storage, projectId, "process_step_create", (cur) => {
      validation.processStepInput(partial);
      return core.ops.createProcessStep(cur, partial, actor);
    }, actor);
    if (r.error) return r.error;
    const processStep = r.saved.snapshot.processSteps[r.saved.snapshot.processSteps.length - 1];
    return ok({ revision: r.saved.revision, savedAt: r.saved.savedAt, processStep });
  });

  server.registerTool("process_step_update", {
    description: "Patch fields on a process step (name, description, epicId, sortOrder).",
    inputSchema: {
      projectId: z.string(),
      processStepId: z.string(),
      patch: passthroughObjectSchema
    }
  }, async ({ projectId, processStepId, patch }) => {
    const actor = AI_ACTOR;
    const r = await persist(storage, projectId, "process_step_update", (cur) => {
      const ex = findEntity(cur, "processSteps", processStepId);
      if (!ex) throw Object.assign(new Error("process step not found"), { statusCode: 404 });
      return core.ops.updateProcessStep(cur, processStepId, patch || {}, actor);
    }, actor);
    if (r.error) return r.error;
    return ok({
      revision: r.saved.revision, savedAt: r.saved.savedAt,
      processStep: findEntity(r.saved.snapshot, "processSteps", processStepId)
    });
  });

  server.registerTool("process_step_delete", {
    description: "Soft-delete a process step.",
    inputSchema: { projectId: z.string(), processStepId: z.string() }
  }, async ({ projectId, processStepId }) => {
    const actor = AI_ACTOR;
    const r = await persist(storage, projectId, "process_step_delete",
      (cur) => core.ops.softDeleteProcessStep(cur, processStepId, actor),
      actor);
    if (r.error) return r.error;
    return ok({ revision: r.saved.revision, savedAt: r.saved.savedAt, deleted: processStepId });
  });

  server.registerTool("split_process_step", {
    description: "Split a process step (SM-247): create a NEW step directly after it and move the chosen epics (with their contained stories) into the new step. Loose stories stay with the original. epicIds must reference epics currently in this step (else 422 with `missing`). Empty/omitted epicIds inserts an empty step after the original. One revision.",
    inputSchema: {
      projectId: z.string(),
      processStepId: z.string(),
      name: z.string(),
      description: z.string().optional(),
      // tolerateJsonString: Claude Code's MCP bridge may serialise the array
      // as a JSON string when the schema isn't an explicit object/array (E20.F).
      epicIds: tolerateJsonString(z.array(z.string())).optional()
    }
  }, async ({ projectId, processStepId, name, description, epicIds }) => {
    const actor = AI_ACTOR;
    const r = await persist(storage, projectId, "process_step_split",
      (cur) => core.ops.splitProcessStep(cur, processStepId,
        { name, description, epicIds: epicIds || [] }, actor),
      actor);
    if (r.error) return r.error;
    const before = new Set((r.before && r.before.processSteps || []).map(p => p.id));
    const newStep = (r.saved.snapshot.processSteps || []).find(p => !before.has(p.id));
    return ok({
      revision: r.saved.revision, savedAt: r.saved.savedAt,
      processStep: newStep || null,
      movedEpics: (epicIds || []).length
    });
  });

  // process-step reorder moved to the unified `reorder` tool (entity='process_steps', SM-165).

  // -------------------- SM-165: unified reorder --------------------------
  //
  // One tool replaces reorder_tickets / reorder_releases / reorder_process_steps.
  // `entity` dispatches; `scope` is honoured only for entity='tickets'. Each
  // path keeps its existing response shape (no behaviour change).
  server.registerTool("reorder", {
    description: "Reorder entities by full id list. entity ∈ 'tickets' | 'releases' | "
      + "'process_steps'. orderedIds is the new order (sortOrder = index). For "
      + "entity='tickets', an optional `scope` {releaseId, processStepId, epicId} is ALSO "
      + "applied to every listed ticket (clean cross-container move); scope is IGNORED for "
      + "releases/process_steps. Compact response: tickets → {revision, savedAt, "
      + "reordered:[{id, ticketKey, position}]} (only tickets whose position actually "
      + "changed, incl. stories cascaded by an epic move; the browser still gets the full "
      + "snapshot via the WebSocket bus). releases → {…, releases:[…]}; process_steps → "
      + "{…, processSteps:[…]} (the reordered non-deleted list).",
    inputSchema: {
      projectId:  z.string(),
      entity:     z.enum(["tickets", "releases", "process_steps"]),
      orderedIds: z.array(z.string()),
      scope:      reorderScopeSchema
    }
  }, async ({ projectId, entity, orderedIds, scope }) => {
    const actor = AI_ACTOR;
    if (entity === "releases") {
      const r = await persist(storage, projectId, "release_reorder",
        (cur) => core.ops.reorderReleases(cur, orderedIds, actor), actor);
      if (r.error) return r.error;
      return ok({ revision: r.saved.revision, savedAt: r.saved.savedAt,
        releases: (r.saved.snapshot.releases || []).filter(x => !x.isDeleted) });
    }
    if (entity === "process_steps") {
      const r = await persist(storage, projectId, "process_step_reorder",
        (cur) => core.ops.reorderProcessSteps(cur, orderedIds, actor), actor);
      if (r.error) return r.error;
      return ok({ revision: r.saved.revision, savedAt: r.saved.savedAt,
        processSteps: (r.saved.snapshot.processSteps || []).filter(x => !x.isDeleted) });
    }
    // entity === "tickets"
    const r = await persist(storage, projectId, "tickets_reorder",
      (cur) => core.ops.reorderTickets(cur, orderedIds, scope || null, actor), actor);
    if (r.error) return r.error;
    const beforeById = new Map((r.before.tickets || []).map(t => [t.id, t.position]));
    const reordered = [];
    for (const t of (r.saved.snapshot.tickets || [])) {
      if (t.isDeleted) continue;
      const prev = beforeById.get(t.id);
      if (!prev) continue;
      if (prev.releaseId === t.position.releaseId
          && prev.processStepId === t.position.processStepId
          && prev.epicId === t.position.epicId
          && prev.sortOrder === t.position.sortOrder) continue;
      reordered.push({ id: t.id, ticketKey: t.ticketKey, position: t.position });
    }
    return ok({ revision: r.saved.revision, savedAt: r.saved.savedAt, reordered });
  });

  // -------------------- SM-22/SM-23/SM-24: Bulk operations --------------
  //
  // Three bulk tools, one consistent contract:
  //
  //   {
  //     revision, savedAt,
  //     successful: [{id, ticketKey, ...}],
  //     failed:     [{id, ticketKey?, kind, message:{title,reason,suggestion}}],
  //     warnings:   [{kind, ticketId, ticketKey, context, message:{...}}]  // optional
  //   }
  //
  // Semantics:
  //   - Default = best-effort. Failed items are reported but the call
  //     persists the successful ones in a single revision. Total atomicity
  //     at SQLite-tx level: either all successful mutations land or none do.
  //   - `opts.atomic: true` → all-or-nothing. ANY per-item failure aborts
  //     the whole call. The response carries `kind: BULK_ABORTED` and the
  //     full failed[] list. No write happens.
  //
  // Per-item gate-checking respects SM-93 governance: bulk_change_status
  // runs evaluateGates for the target action (mapped from targetStatus),
  // bulk_ticket_update runs the SM-94 DEFINITION_FROZEN block and collects
  // SPEC_FROZEN_EDIT warnings, bulk_link_create defers to core.ops.addLink
  // which already does cycle/dup/self validation.

  /**
   * Generic runner. Three phases:
   *   1. Validate each item via `perItemPlan`. Collect plan or failed entry.
   *   2. Sequentially apply each plan.mutate against a working snapshot.
   *      Mutations that throw (e.g. addLink hitting LINK_DUPLICATE or
   *      LINK_CYCLE) get moved from successful[] to failed[].
   *   3. Single saveProject for the resulting snapshot (one revision).
   *
   * `opts.atomic:true` aborts at the first failure (validation or apply).
   * Default = best-effort: persist whatever survives.
   */
  async function runBulkOp(projectId, op, ticketIds, perItemPlan, opts) {
    const actor = AI_ACTOR;
    const atomic = !!(opts && opts.atomic);

    // Accumulators populated inside the atomic mutate below (closure).
    let failed = [];
    let warnings = [];
    let successful = [];
    // Sentinels to short-circuit storage.mutate WITHOUT writing a revision:
    // either nothing survived (no-op) or an atomic run hit a failure.
    const NO_WRITE = "__bulk_no_write__";
    const ATOMIC_ABORT = "__bulk_atomic_abort__";

    let saved;
    try {
      // SM-154: the whole plan → apply → save now runs inside ONE storage
      // mutex acquisition, so a concurrent writer can't slip a save in between
      // the snapshot we planned against and the snapshot we persist.
      saved = await storage.mutate(projectId, { actor, op }, (snap0) => {
        // mutate() runs the callback exactly once; reset accumulators anyway
        // so a hypothetical retry can't double-count.
        failed = []; warnings = []; successful = [];
        const planned = [];

        // Phase 1: validate / plan against the freshly-locked snapshot.
        for (const ticketId of ticketIds) {
          const t = findEntity(snap0, "tickets", ticketId);
          if (!t || t.isDeleted) {
            failed.push({ id: ticketId, kind: "NOT_FOUND", message: {
              title: "Ticket not found",
              reason: "Ticket " + ticketId + " is not present in the snapshot (or is soft-deleted).",
              suggestion: "Verify the id and that it has not been deleted; re-fetch via list_tickets.",
              skillRef: ""
            }});
            continue;
          }
          const plan = perItemPlan(snap0, t);
          if (plan.failed) {
            failed.push(Object.assign({ id: t.id, ticketKey: t.ticketKey }, plan.failed));
          } else {
            planned.push({ ticketId: t.id, ticketKey: t.ticketKey, mutate: plan.mutate });
            if (plan.warning) warnings.push(Object.assign({ ticketId: t.id, ticketKey: t.ticketKey }, plan.warning));
          }
        }
        if (atomic && failed.length > 0) throw new Error(ATOMIC_ABORT);

        // Phase 2: apply mutations sequentially. Late failures (e.g. addLink
        // throws on dup/cycle) get moved to failed[].
        let workingSnap = snap0;
        for (const p of planned) {
          try {
            workingSnap = p.mutate(workingSnap);
            successful.push({ id: p.ticketId, ticketKey: p.ticketKey });
          } catch (err) {
            failed.push({ id: p.ticketId, ticketKey: p.ticketKey,
              kind: err.kind || "MUTATE_ERROR",
              message: {
                title: "Apply failed",
                reason: err.message || "mutate threw",
                suggestion: err.kind === "LINK_DUPLICATE" ? "Link already exists; nothing to add."
                          : err.kind === "LINK_CYCLE"    ? "Adding this link would close a cycle in the linkType graph."
                          : "Inspect the per-item state and retry individually.",
                skillRef: ""
              }
            });
          }
        }
        if (atomic && failed.length > 0) throw new Error(ATOMIC_ABORT);
        if (successful.length === 0) throw new Error(NO_WRITE);

        // Phase 3: hand the working snapshot to mutate() for the single write.
        validation.snapshotLimits(workingSnap);
        return workingSnap;
      });
    } catch (err) {
      // No-op: nothing survived — return the failure breakdown, no revision.
      if (err && err.message === NO_WRITE) {
        return ok({ revision: null, savedAt: null, successful: [], failed: failed,
          warnings: warnings.length > 0 ? warnings : undefined });
      }
      // Atomic abort: caller asked all-or-nothing and something failed.
      if (err && err.message === ATOMIC_ABORT) {
        return fail("atomic bulk aborted: " + failed.length + " item(s) failed", {
          kind: "BULK_ABORTED", statusCode: 422, failed: failed
        });
      }
      // Project missing (storage.mutate 404) or a save-time error.
      return fail(err.message || "bulk save failed", {
        statusCode: err.statusCode || 500, kind: err.kind
      });
    }

    const enriched = successful.map(s => {
      const after = findEntity(saved.snapshot, "tickets", s.id);
      if (!after) return s;
      return { id: s.id, ticketKey: s.ticketKey,
        status: after.status, position: after.position };
    });
    const payload = { revision: saved.revision, savedAt: saved.savedAt,
      successful: enriched, failed: failed };
    if (warnings.length > 0) payload.warnings = warnings;
    return ok(payload);
  }

  server.registerTool("bulk_change_status", {
    description: "Change the status of multiple tickets in one revision. Each ticket "
      + "is independently validated (workflow transition + SM-93 governance gates). "
      + "Best-effort by default — items that fail their gate land in `failed[]`, the "
      + "rest persist in a single revision. Pass `opts.atomic:true` for all-or-nothing.",
    inputSchema: {
      projectId:    z.string(),
      ticketIds:    z.array(z.string()),
      targetStatus: z.string(),
      opts:         passthroughObjectSchema.optional()
    }
  }, async ({ projectId, ticketIds, targetStatus, opts }) => {
    const actor = AI_ACTOR;
    return runBulkOp(projectId, "bulk_change_status", ticketIds, (snap, t) => {
      // Per-item validation: workflow transition (DoR/DoD via existing
      // validation), then SM-93 governance gates for the *resulting* tool
      // action when status === "done" (mirrors complete_ticket).
      try {
        validation.changeStatusTransition(t, targetStatus, snap.project);
      } catch (err) {
        return { failed: {
          kind: err.kind || "TRANSITION", missing: err.missing,
          message: {
            title: "Status transition refused",
            reason: (err.message || "transition denied") + " (target=" + targetStatus + ")",
            suggestion: err.kind === "DoR" || err.kind === "DoD"
              ? "Check the missing items via set_checklist_item (gate dor/dod, checked:true), then retry."
              : "Inspect get_workflow for the allowed transitions.",
            skillRef: ""
          }
        }};
      }
      if (targetStatus === "done") {
        const gateFail = runGovernanceGates(snap, "complete_ticket", t,
          { targetKey: t.ticketKey || t.id, targetType: t.type });   // SM-299 F2: name the type in the message
        if (gateFail) {
          const parsed = JSON.parse(gateFail.content[0].text);
          // Preserve the full per-gate detail array — single complete_ticket
          // returns parsed.errors, bulk must not drop it. SM-148.
          return { failed: { kind: parsed.kind, message: parsed.message, errors: parsed.errors } };
        }
      }
      return { mutate: (cur) => core.ops.changeStatus(cur, t.id, targetStatus, actor) };
    }, opts);
  });

  server.registerTool("bulk_ticket_update", {
    description: "Apply the same `patch` to multiple tickets in one revision. Per-item: "
      + "the SM-94 DEFINITION_FROZEN block fires on published test-definitions whose "
      + "patch touches steps/prereqs (such items land in `failed[]`); editing spec "
      + "fields on a ready+ ticket surfaces SPEC_FROZEN_EDIT in `warnings[]` but "
      + "still goes through. Default is best-effort; pass `opts.atomic:true` for "
      + "all-or-nothing.",
    inputSchema: {
      projectId: z.string(),
      ticketIds: z.array(z.string()),
      patch:     ticketPatchSchema,
      opts:      passthroughObjectSchema.optional()
    }
  }, async ({ projectId, ticketIds, patch, opts }) => {
    const actor = AI_ACTOR;
    const p = patch || {};
    return runBulkOp(projectId, "bulk_ticket_update", ticketIds, (snap, t) => {
      // SM-94 hard gate: published test-definition rejects step/prereq edits.
      if (t.type === "test-definition" && t.lifecycle === "published") {
        const forbidden = ["steps", "prerequisites"].filter(k =>
          Object.prototype.hasOwnProperty.call(p, k));
        if (forbidden.length > 0) {
          return { failed: { kind: "DEFINITION_FROZEN", message: {
            title: "Definition is frozen",
            reason: "Definition " + t.ticketKey + " is published; cannot patch " + forbidden.join(", ") + ".",
            suggestion: "Use update_test_definition_metadata for cosmetics, or reopen the definition first.",
            skillRef: "Published test-definitions are immutable spec records."
          }}};
        }
      }
      // SM-94 soft warn: ready+-status + spec-patch.
      let warning = null;
      const SPEC_FIELDS = ["acceptanceCriteria", "description", "definitionOfReady"];
      if (t.status && t.status !== "backlog") {
        const touched = SPEC_FIELDS.filter(k => Object.prototype.hasOwnProperty.call(p, k));
        if (touched.length > 0) {
          warning = { kind: "SPEC_FROZEN_EDIT",
            context: { fields: touched, status: t.status },
            message: {
              title: "Editing spec on a ready+ ticket",
              reason: "Spec fields (" + touched.join(", ") + ") edited on " + t.ticketKey + " (status=" + t.status + ").",
              suggestion: "For behavioural changes, consider a `modifies`-ticket linked to " + t.ticketKey + ".",
              skillRef: "Specs frieren ein. Aenderungen werden zu Tickets."
            }};
        }
      }
      try {
        validation.ticketInput(Object.assign({}, t, p), snap.project);
      } catch (err) {
        return { failed: { kind: err.kind || "VALIDATION", message: {
          title: "Patch invalid", reason: err.message || "validation failed",
          suggestion: "Inspect the input and retry per item.", skillRef: ""
        }}};
      }
      return {
        mutate: (cur) => core.ops.updateTicket(cur, t.id, p, actor),
        warning: warning
      };
    }, opts);
  });

  server.registerTool("bulk_link_create", {
    description: "Create the same-typed link from each ticket in sourceTicketIds[] to "
      + "the single targetTicketId. Use case: bulk-tag a refactor — many tickets all "
      + "`modifies` one feature. Each link is validated via core.ops.addLink (no self, "
      + "no duplicate, cycle-check per linkType). Best-effort default.",
    inputSchema: {
      projectId:       z.string(),
      sourceTicketIds: z.array(z.string()),
      targetTicketId:  z.string(),
      linkTypeId:      z.string(),
      opts:            passthroughObjectSchema.optional()
    }
  }, async ({ projectId, sourceTicketIds, targetTicketId, linkTypeId, opts }) => {
    const actor = AI_ACTOR;
    return runBulkOp(projectId, "bulk_link_create", sourceTicketIds, (snap, src) => {
      if (src.id === targetTicketId) {
        return { failed: { kind: "LINK_SELF", message: {
          title: "Self-link refused", reason: "A ticket cannot link to itself.",
          suggestion: "Drop this id from sourceTicketIds.", skillRef: ""
        }}};
      }
      return { mutate: (cur) => {
        try {
          return core.ops.addLink(cur, src.id, {
            linkTypeId: linkTypeId, targetTicketId: targetTicketId
          }, actor);
        } catch (err) {
          // Re-throw with structured kind so the persist catch path can
          // bubble it. Since runBulkOp pre-plans, we shouldn't reach here
          // unless the snapshot drifted — but be defensive.
          throw err;
        }
      }};
    }, opts);
  });

  // workflow + kanban_columns config moved to get_config/set_config (SM-164).

  // -------------------- links (SM-46) ------------------------------------

  server.registerTool("link_create", {
    description: "Add a typed link from one ticket to another. linkTypeId references a project.linkTypes entry (predecessor-of / blocks / follows-on / contains / relates-to by default — get_link_types for the catalogue). Throws LINK_SELF for self-links, LINK_TARGET_MISSING for unknown target, LINK_DUPLICATE for duplicate (linkTypeId, targetTicketId), LINK_CYCLE if the new edge would close a cycle in a cycle-checked semantic.",
    inputSchema: {
      projectId:       z.string(),
      sourceTicketId:  z.string(),
      linkTypeId:      z.string(),
      targetTicketId:  z.string(),
      label:           z.string().optional()
    }
  }, async ({ projectId, sourceTicketId, linkTypeId, targetTicketId, label }) => {
    const actor = AI_ACTOR;
    const linkPatch = { linkTypeId: linkTypeId, targetTicketId: targetTicketId };
    if (typeof label === "string" && label.length > 0) linkPatch.label = label;
    const r = await persist(storage, projectId, "link_create",
      (cur) => core.ops.addLink(cur, sourceTicketId, linkPatch, actor), actor);
    if (r.error) return r.error;
    const ticket = r.saved.snapshot.tickets.find(t => t.id === sourceTicketId);
    const newLink = ticket && ticket.links[ticket.links.length - 1];
    return ok({ revision: r.saved.revision, savedAt: r.saved.savedAt, link: newLink });
  });

  server.registerTool("link_delete", {
    description: "Remove a single link from a ticket by linkId. No-op if the linkId is not on the source ticket.",
    inputSchema: {
      projectId:      z.string(),
      sourceTicketId: z.string(),
      linkId:         z.string()
    }
  }, async ({ projectId, sourceTicketId, linkId }) => {
    const actor = AI_ACTOR;
    const r = await persist(storage, projectId, "link_delete",
      (cur) => core.ops.removeLink(cur, sourceTicketId, linkId, actor), actor);
    if (r.error) return r.error;
    return ok({ revision: r.saved.revision, savedAt: r.saved.savedAt });
  });

  server.registerTool("list_links_for_ticket", {
    description: "List links involving a ticket. direction: 'forward' = links this ticket owns; 'backward' = links from OTHER tickets pointing here (resolved via project.linkTypes.inverseLabel); 'both' (default) = combined. Each entry has linkTypeId, label (project-resolved or the link's stored label), direction, target { id, ticketKey, title, type }. Use this to power a Ticket-Detail-Modal's Links-section.",
    inputSchema: {
      projectId:  z.string(),
      ticketId:   z.string(),
      direction:  z.enum(["forward", "backward", "both"]).optional()
    }
  }, async ({ projectId, ticketId, direction }) => {
    const dir = direction || "both";
    const current = await storage.loadProject(projectId);
    if (!current) return fail("project not found: " + projectId, { statusCode: 404 });
    const ticket = current.tickets.find(t => t.id === ticketId);
    if (!ticket) return fail("ticket not found: " + ticketId, { statusCode: 404 });
    const linkTypes = (current.project && current.project.linkTypes) || [];
    const ltById = new Map(linkTypes.map(lt => [lt.id, lt]));
    function summary(t) {
      return t ? { id: t.id, ticketKey: t.ticketKey, title: t.title, type: t.type } : null;
    }
    function resolveLabel(linkTypeId, fallback, inverse) {
      const lt = ltById.get(linkTypeId);
      if (lt) return inverse ? lt.inverseLabel : lt.label;
      return fallback || linkTypeId;
    }
    const out = [];
    if (dir === "forward" || dir === "both") {
      for (const l of ticket.links || []) {
        const target = current.tickets.find(t => t.id === l.targetTicketId);
        out.push({
          linkId:     l.id,
          linkTypeId: l.linkTypeId,
          label:      l.label || resolveLabel(l.linkTypeId, null, false),
          direction:  "forward",
          target:     summary(target)
        });
      }
    }
    if (dir === "backward" || dir === "both") {
      for (const other of current.tickets) {
        if (other.id === ticketId) continue;
        for (const l of other.links || []) {
          if (l.targetTicketId !== ticketId) continue;
          out.push({
            linkId:     l.id,
            sourceTicketId: other.id,
            linkTypeId: l.linkTypeId,
            label:      resolveLabel(l.linkTypeId, l.label, true),
            direction:  "backward",
            source:     summary(other)
          });
        }
      }
    }
    return ok({ ticketId: ticketId, direction: dir, links: out });
  });

  // link_types config (get/set) moved to get_config/set_config (SM-164).
  // list_links_for_ticket stays here — it's a per-ticket read, not config.

  // -------------------- revisions / history ------------------------------

  server.registerTool("list_revisions", {
    description: "List the revision history of a project (reverse-chrono). Returns up to `limit` entries (default 100); pass `before` (a revision id) to page older entries.",
    inputSchema: { projectId: z.string(), limit: z.number().int().positive().optional(), before: z.string().optional() }
  }, async ({ projectId, limit, before }) => {
    // SM-212: limit/before run as SQL LIMIT + cursor inside storage.
    const opts = {};
    if (limit != null) opts.limit = limit;
    if (before) opts.beforeRevision = before;
    return ok(await storage.listRevisions(projectId, opts));
  });

  server.registerTool("get_revision", {
    description: "Fetch a single revision (full snapshot at that point in time). Returns 404-error if the revision does not exist.",
    inputSchema: { projectId: z.string(), revision: z.string() }
  }, async ({ projectId, revision }) => {
    const r = await storage.getRevision(projectId, revision);
    if (!r) return fail("revision not found: " + revision, { statusCode: 404 });
    return ok(r);
  });

  // -------------------- request_switch_project (E20.B) -------------------
  server.registerTool("request_switch_project", {
    description: "Ask every connected browser to switch to the named project. The browser shows a confirm dialog; the tool waits up to wait_seconds (default 30) for the user's verdict and returns { requested, requestId, response:{accepted}, timedOut? }. Pass wait_seconds:0 for fire-and-forget. Use this AFTER preparing a project so the user lands on the right place and can verify your work.",
    inputSchema: {
      workspace:    z.string().describe("The project id to switch to."),
      reason:       z.string().optional().describe("Short rationale shown in the confirm dialog."),
      wait_seconds: z.number().int().min(0).max(120).optional().describe("Seconds to wait for the user's verdict (default 30, max 120). 0 = fire-and-forget.")
    }
  }, async ({ workspace, reason, wait_seconds }) => {
    const requestId = genRequestId();
    const waitSec = (typeof wait_seconds === "number")
      ? Math.max(0, Math.min(120, wait_seconds | 0))
      : 30;

    // Start the listener BEFORE broadcasting so a fast browser response
    // can't race past us. The two paths (in-process bus vs standalone
    // long-poll) resolve to the same shape.
    let waitPromise = null;
    if (waitSec > 0) {
      if (httpUrl && fetchImpl) {
        // Standalone: server holds the cache + bus, we poll it. Add a
        // safety margin to the AbortController so the HTTP timeout fires
        // before the AbortController kicks in (cleaner error messages).
        const ctrl = new AbortController();
        const safety = setTimeout(() => ctrl.abort(), (waitSec + 5) * 1000);
        waitPromise = (async () => {
          try {
            const url = new URL("/api/internal/switch-response", httpUrl);
            url.searchParams.set("requestId", requestId);
            url.searchParams.set("wait", String(waitSec));
            const res = await fetchImpl(url, { signal: ctrl.signal });
            clearTimeout(safety);
            if (!res.ok) return { accepted: null, timedOut: true };
            return await res.json();
          } catch (e) {
            clearTimeout(safety);
            return { accepted: null, timedOut: true };
          }
        })();
      } else {
        // In-process: same bus that the WS layer emits on (useful for tests
        // that share the process).
        waitPromise = new Promise((resolve) => {
          let settled = false;
          const settle = (val) => { if (settled) return; settled = true; clearTimeout(t); bus.off("switch_response", onResp); resolve(val); };
          const onResp = (ev) => { if (!ev || ev.requestId !== requestId) return; settle({ accepted: !!ev.accepted, timedOut: false }); };
          const t = setTimeout(() => settle({ accepted: null, timedOut: true }), waitSec * 1000);
          bus.on("switch_response", onResp);
        });
      }
    }

    // Broadcast. Local bus first (in-process tests rely on it), then HTTP
    // bridge (standalone subprocess relies on it).
    bus.emit("switch_request", { workspace, reason: reason || null, requestId });
    if (httpUrl && fetchImpl) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 2000);
        const res = await fetchImpl(new URL("/api/internal/switch-request", httpUrl), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workspace, reason: reason || null, requestId }),
          signal: ctrl.signal
        });
        clearTimeout(t);
        if (!res.ok) {
          process.stderr.write(`[storymap-mcp] switch-request POST failed: ${res.status}\n`);
        }
      } catch (e) {
        process.stderr.write(`[storymap-mcp] switch-request POST error: ${e.message}\n`);
      }
    }

    const out = { requested: workspace, reason: reason || null, requestId };
    if (waitPromise) {
      const r = await waitPromise;
      out.response = { accepted: r.accepted };
      out.timedOut = !!r.timedOut;
    }
    return ok(out);
  });

  // -------------------- SM-58: test-types tooling -----------------------
  //
  // Definition-side: step + prereq CRUD. Execution-side: start a run,
  // record per-step results, set/auto-reset the outcome, list history.
  // Object-args use passthroughObjectSchema so the Claude Code MCP bridge's
  // JSON-string serialisation survives the round trip (SM-31 pattern).

  server.registerTool("test_def_step_add", {
    description: "Append a step to a test-definition. patch = { step: string, data?: string, expectedResult: string, position?: number }. Returns the created step.",
    inputSchema: {
      projectId: z.string(),
      ticketId:  z.string(),
      patch:     passthroughObjectSchema
    }
  }, async ({ projectId, ticketId, patch }) => {
    const actor = AI_ACTOR;
    const r = await persist(storage, projectId, "test_def_step_add",
      (cur) => core.ops.addTestStep(cur, ticketId, patch || {}, actor), actor);
    if (r.error) return r.error;
    const ticket = r.saved.snapshot.tickets.find(t => t.id === ticketId);
    const newStep = ticket && ticket.steps[ticket.steps.length - 1];
    return ok({ revision: r.saved.revision, savedAt: r.saved.savedAt, step: newStep });
  });

  server.registerTool("test_def_step_update", {
    description: "Update a step on a test-definition. patch = { step?, data?, expectedResult? } (subset).",
    inputSchema: {
      projectId: z.string(),
      ticketId:  z.string(),
      stepId:    z.string(),
      patch:     passthroughObjectSchema
    }
  }, async ({ projectId, ticketId, stepId, patch }) => {
    const actor = AI_ACTOR;
    const r = await persist(storage, projectId, "test_def_step_update",
      (cur) => core.ops.updateTestStep(cur, ticketId, stepId, patch || {}, actor), actor);
    if (r.error) return r.error;
    const ticket = r.saved.snapshot.tickets.find(t => t.id === ticketId);
    const step = ticket && (ticket.steps || []).find(x => x.id === stepId);
    return ok({ revision: r.saved.revision, savedAt: r.saved.savedAt, step: step });
  });

  server.registerTool("test_def_step_remove", {
    description: "Remove a step from a test-definition.",
    inputSchema: { projectId: z.string(), ticketId: z.string(), stepId: z.string() }
  }, async ({ projectId, ticketId, stepId }) => {
    const actor = AI_ACTOR;
    const r = await persist(storage, projectId, "test_def_step_remove",
      (cur) => core.ops.removeTestStep(cur, ticketId, stepId, actor), actor);
    if (r.error) return r.error;
    return ok({ revision: r.saved.revision, savedAt: r.saved.savedAt });
  });

  server.registerTool("test_def_step_reorder", {
    description: "Reorder steps on a test-definition by full ID list. orderedStepIds is the new sequence; missing steps are appended at the end (defensive). Pass tolerated JSON-string for Claude Code MCP bridge.",
    inputSchema: {
      projectId:      z.string(),
      ticketId:       z.string(),
      orderedStepIds: tolerateJsonString(z.array(z.string()))
    }
  }, async ({ projectId, ticketId, orderedStepIds }) => {
    const actor = AI_ACTOR;
    const r = await persist(storage, projectId, "test_def_step_reorder",
      (cur) => core.ops.reorderTestSteps(cur, ticketId, orderedStepIds, actor), actor);
    if (r.error) return r.error;
    const ticket = r.saved.snapshot.tickets.find(t => t.id === ticketId);
    return ok({ revision: r.saved.revision, savedAt: r.saved.savedAt, steps: ticket && ticket.steps });
  });

  server.registerTool("test_def_prereq_add", {
    description: "Append a prerequisite to a test-definition. patch = { label: string, required?: boolean }. Default required=true.",
    inputSchema: {
      projectId: z.string(),
      ticketId:  z.string(),
      patch:     passthroughObjectSchema
    }
  }, async ({ projectId, ticketId, patch }) => {
    const actor = AI_ACTOR;
    const r = await persist(storage, projectId, "test_def_prereq_add",
      (cur) => core.ops.addTestPrereq(cur, ticketId, patch || {}, actor), actor);
    if (r.error) return r.error;
    const ticket = r.saved.snapshot.tickets.find(t => t.id === ticketId);
    const newPre = ticket && ticket.prerequisites[ticket.prerequisites.length - 1];
    return ok({ revision: r.saved.revision, savedAt: r.saved.savedAt, prerequisite: newPre });
  });

  server.registerTool("test_def_prereq_update", {
    description: "Update a prerequisite. patch = { label?, required? }.",
    inputSchema: {
      projectId: z.string(),
      ticketId:  z.string(),
      prereqId:  z.string(),
      patch:     passthroughObjectSchema
    }
  }, async ({ projectId, ticketId, prereqId, patch }) => {
    const actor = AI_ACTOR;
    const r = await persist(storage, projectId, "test_def_prereq_update",
      (cur) => core.ops.updateTestPrereq(cur, ticketId, prereqId, patch || {}, actor), actor);
    if (r.error) return r.error;
    const ticket = r.saved.snapshot.tickets.find(t => t.id === ticketId);
    const item = ticket && (ticket.prerequisites || []).find(x => x.id === prereqId);
    return ok({ revision: r.saved.revision, savedAt: r.saved.savedAt, prerequisite: item });
  });

  server.registerTool("test_def_prereq_remove", {
    description: "Remove a prerequisite from a test-definition.",
    inputSchema: { projectId: z.string(), ticketId: z.string(), prereqId: z.string() }
  }, async ({ projectId, ticketId, prereqId }) => {
    const actor = AI_ACTOR;
    const r = await persist(storage, projectId, "test_def_prereq_remove",
      (cur) => core.ops.removeTestPrereq(cur, ticketId, prereqId, actor), actor);
    if (r.error) return r.error;
    return ok({ revision: r.saved.revision, savedAt: r.saved.savedAt });
  });

  server.registerTool("test_def_prereq_check", {
    description: "Mark a prerequisite as checked.",
    inputSchema: { projectId: z.string(), ticketId: z.string(), prereqId: z.string() }
  }, async ({ projectId, ticketId, prereqId }) => {
    const actor = AI_ACTOR;
    const r = await persist(storage, projectId, "test_def_prereq_check",
      (cur) => core.ops.checkTestPrereq(cur, ticketId, prereqId, actor), actor);
    if (r.error) return r.error;
    return ok({ revision: r.saved.revision, savedAt: r.saved.savedAt });
  });

  server.registerTool("test_def_prereq_uncheck", {
    description: "Mark a prerequisite as unchecked.",
    inputSchema: { projectId: z.string(), ticketId: z.string(), prereqId: z.string() }
  }, async ({ projectId, ticketId, prereqId }) => {
    const actor = AI_ACTOR;
    const r = await persist(storage, projectId, "test_def_prereq_uncheck",
      (cur) => core.ops.uncheckTestPrereq(cur, ticketId, prereqId, actor), actor);
    if (r.error) return r.error;
    return ok({ revision: r.saved.revision, savedAt: r.saved.savedAt });
  });

  server.registerTool("test_exec_start", {
    description: "Start a test-execution run. Creates a new test-execution ticket, clones the definition's steps (snapshot semantics — later definition edits don't bleed back), opens an 'executes' link to the definition, sets runAt=now and runBy=actor (or opts.runBy). opts = { env?, runBy? }. Returns the new execution ticket. SM-94: definition must be in lifecycle='published' — fails with kind=DEFINITION_DRAFT otherwise.",
    inputSchema: {
      projectId:    z.string(),
      definitionId: z.string(),
      opts:         passthroughObjectSchema.optional()
    }
  }, async ({ projectId, definitionId, opts: startOpts }) => {
    const actor = AI_ACTOR;
    // SM-94: only published test-definitions can be executed. Drafts are not
    // runnable — promote them via publish_test_definition first.
    const snap0 = await storage.loadProject(projectId);
    if (!snap0) return fail("project not found: " + projectId, { statusCode: 404 });
    const def = findEntity(snap0, "tickets", definitionId);
    if (!def) return fail("test-definition not found: " + definitionId, { statusCode: 404 });
    if (def.type !== "test-definition") {
      return fail("not a test-definition: " + definitionId, { statusCode: 422, kind: "WRONG_TYPE" });
    }
    if (def.lifecycle !== "published") {
      return fail("test-definition is in draft, not runnable", {
        kind: "DEFINITION_DRAFT",
        message: {
          title: "Test-definition is still a draft",
          reason: "Definition " + (def.ticketKey || definitionId) + " has lifecycle='"
            + (def.lifecycle || "draft") + "'. Executions can only be spawned from PUBLISHED "
            + "definitions so the spec is locked-in at run time.",
          suggestion: "Call publish_test_definition({projectId, ticketId:'" + definitionId
            + "'}) first — that runs the publish-gates and flips the lifecycle to 'published'. "
            + "Then retry test_exec_start.",
          skillRef: "Test-definitions live in draft while you author them. Publish locks them in for execution."
        },
        statusCode: 422
      });
    }
    const r = await persist(storage, projectId, "test_exec_start",
      (cur) => core.ops.startTestExecution(cur, definitionId, startOpts || {}, actor), actor);
    if (r.error) return r.error;
    const exec = r.saved.snapshot.tickets
      .filter(t => t.type === "test-execution" && t.referencedTestDefinitionId === definitionId)
      .sort((a, b) => (b.runAt || 0) - (a.runAt || 0))[0];
    return ok({ revision: r.saved.revision, savedAt: r.saved.savedAt, execution: exec });
  });

  // -------------------- SM-94: test-definition lifecycle ----------------

  server.registerTool("publish_test_definition", {
    description: "Promote a test-definition from lifecycle='draft' to 'published'. Runs the SM-93 governance publish-gates: ≥1 step, ≥1 outgoing 'tests'-link, every step has expectedResult, target ticket has reached 'ready'+. On gate failure returns isError with kind/errors/message{title,reason,suggestion,skillRef}.",
    inputSchema: { projectId: z.string(), ticketId: z.string() }
  }, async ({ projectId, ticketId }) => {
    const actor = AI_ACTOR;
    const snap0 = await storage.loadProject(projectId);
    if (!snap0) return fail("project not found: " + projectId, { statusCode: 404 });
    const def = findEntity(snap0, "tickets", ticketId);
    if (!def) return fail("ticket not found: " + ticketId, { statusCode: 404 });
    if (def.type !== "test-definition") {
      return fail("not a test-definition: " + ticketId, { statusCode: 400 });
    }
    if (def.lifecycle === "published") {
      return ok({ revision: snap0.revision || null, savedAt: snap0.savedAt || null,
                  ticket: def, alreadyPublished: true });
    }
    const gateFail = runGovernanceGates(snap0, "publish_test_definition", def, {
      definitionKey: def.ticketKey || ticketId
    });
    if (gateFail) return gateFail;
    const r = await persist(storage, projectId, "publish_test_definition", (cur) => {
      const t = findEntity(cur, "tickets", ticketId);
      if (!t) throw Object.assign(new Error("ticket not found"), { statusCode: 404 });
      return core.ops.updateTicket(cur, ticketId, { lifecycle: "published" }, actor);
    }, actor);
    if (r.error) return r.error;
    return ok({ revision: r.saved.revision, savedAt: r.saved.savedAt,
                ticket: findEntity(r.saved.snapshot, "tickets", ticketId) });
  });

  server.registerTool("derive_test_definition", {
    description: "SM-301: derive a test-definition from a ticket's ACCEPTANCE CRITERIA — one step per AC (step = the criterion, expectedResult = its observable outcome), linked back via a `tests`-link. The acceptance criteria ARE the test plan: set them first, then call this immediately as the north-star plan (refine steps during implementation). Draft by default; pass publish:true to also publish (the target must be `ready`+, else the response comes back published:false with the TARGET_NOT_READY reason — promote the target, then publish_test_definition). Errors with kind=NO_ACCEPTANCE_CRITERIA (422) if the ticket has no AC. Returns { definition, stepCount, published }.",
    inputSchema: {
      projectId: z.string(),
      ticketId: z.string(),
      title: z.string().optional(),
      publish: z.boolean().optional(),
      verbose: z.boolean().optional()
    }
  }, async ({ projectId, ticketId, title, publish, verbose }) => {
    const actor = AI_ACTOR;
    let createdId = null;
    const r = await persist(storage, projectId, "derive_test_definition", (cur) => {
      const next = core.ops.deriveTestDefinition(cur, ticketId, { title: title }, actor);
      createdId = next.tickets[next.tickets.length - 1].id;
      return next;
    }, actor);
    if (r.error) return r.error;
    let def = findEntity(r.saved.snapshot, "tickets", createdId);
    let revision = r.saved.revision, savedAt = r.saved.savedAt;
    const stepCount = (def.steps || []).length;

    if (publish) {
      const snap1 = await storage.loadProject(projectId);
      const def1 = findEntity(snap1, "tickets", createdId);
      const gateFail = runGovernanceGates(snap1, "publish_test_definition", def1, {
        definitionKey: def1.ticketKey || createdId
      });
      if (gateFail) {
        // derive succeeded (draft persisted) — report the block, don't lose it.
        const parsed = JSON.parse(gateFail.content[0].text);
        return ok({ revision: revision, savedAt: savedAt, stepCount: stepCount,
          definition: verbose ? def : ticketSummary(def),
          published: false, publishBlocked: { kind: parsed.kind, message: parsed.message } });
      }
      const pr = await persist(storage, projectId, "publish_test_definition", (cur) =>
        core.ops.updateTicket(cur, createdId, { lifecycle: "published" }, actor), actor);
      if (pr.error) return pr.error;
      def = findEntity(pr.saved.snapshot, "tickets", createdId);
      revision = pr.saved.revision; savedAt = pr.saved.savedAt;
    }

    return ok({ revision: revision, savedAt: savedAt, stepCount: stepCount,
      definition: verbose ? def : ticketSummary(def),
      published: def.lifecycle === "published" });
  });

  server.registerTool("reopen_test_definition", {
    description: "Revert a test-definition from lifecycle='published' to 'draft' so its spec can be edited again. Blocks with kind=ACTIVE_EXECUTION if any associated test-execution is currently in 'in-progress' — finish or cancel the run first.",
    inputSchema: { projectId: z.string(), ticketId: z.string() }
  }, async ({ projectId, ticketId }) => {
    const actor = AI_ACTOR;
    const snap0 = await storage.loadProject(projectId);
    if (!snap0) return fail("project not found: " + projectId, { statusCode: 404 });
    const def = findEntity(snap0, "tickets", ticketId);
    if (!def) return fail("ticket not found: " + ticketId, { statusCode: 404 });
    if (def.type !== "test-definition") {
      return fail("not a test-definition: " + ticketId, { statusCode: 400 });
    }
    if (def.lifecycle === "draft") {
      return ok({ revision: snap0.revision || null, savedAt: snap0.savedAt || null,
                  ticket: def, alreadyDraft: true });
    }
    const activeExecs = (snap0.tickets || []).filter(t =>
      t.type === "test-execution" && !t.isDeleted
      && t.referencedTestDefinitionId === ticketId
      && t.status === "in-progress");
    if (activeExecs.length > 0) {
      return fail("cannot reopen — active execution(s) running", {
        kind: "ACTIVE_EXECUTION",
        message: {
          title: "Test-definition has active executions",
          reason: "Definition " + (def.ticketKey || ticketId) + " is referenced by " + activeExecs.length
            + " in-progress test-execution(s): " + activeExecs.map(e => e.ticketKey).join(", ") + ".",
          suggestion: "Finish (record all steps) or cancel those executions first, then retry reopen_test_definition.",
          skillRef: "Reopening a published definition would diverge its spec from the running executions."
        },
        statusCode: 422
      });
    }
    const r = await persist(storage, projectId, "reopen_test_definition", (cur) => {
      return core.ops.updateTicket(cur, ticketId, { lifecycle: "draft" }, actor);
    }, actor);
    if (r.error) return r.error;
    return ok({ revision: r.saved.revision, savedAt: r.saved.savedAt,
                ticket: findEntity(r.saved.snapshot, "tickets", ticketId) });
  });

  server.registerTool("update_test_definition_metadata", {
    description: "Edit cosmetic metadata on a test-definition (title, description, labels). Deliberately small surface — does NOT touch steps, prerequisites, or lifecycle. Safe to call on both draft and published definitions: the spec stays frozen, only the human-facing labelling changes.",
    inputSchema: {
      projectId: z.string(),
      ticketId:  z.string(),
      patch:     tolerateJsonString(z.object({}).passthrough())
    }
  }, async ({ projectId, ticketId, patch }) => {
    const actor = AI_ACTOR;
    const p = (patch && typeof patch === "object") ? patch : {};
    const allowed = ["title", "description", "labels"];
    const filtered = {};
    for (const k of allowed) {
      if (Object.prototype.hasOwnProperty.call(p, k)) filtered[k] = p[k];
    }
    if (Object.keys(filtered).length === 0) {
      return fail("patch must contain at least one of: title, description, labels", {
        statusCode: 400, kind: "EMPTY_PATCH"
      });
    }
    const r = await persist(storage, projectId, "update_test_definition_metadata", (cur) => {
      const existing = findEntity(cur, "tickets", ticketId);
      if (!existing) throw Object.assign(new Error("ticket not found"), { statusCode: 404 });
      if (existing.type !== "test-definition") {
        throw Object.assign(new Error("not a test-definition: " + ticketId), { statusCode: 400 });
      }
      return core.ops.updateTicket(cur, ticketId, filtered, actor);
    }, actor);
    if (r.error) return r.error;
    return ok({ revision: r.saved.revision, savedAt: r.saved.savedAt,
                ticket: findEntity(r.saved.snapshot, "tickets", ticketId) });
  });

  // -------------------- SM-94: governance config ------------------------

  // governance config (get/set) moved to get_config/set_config (SM-164).

  server.registerTool("test_exec_record", {
    description: "Record per-step result on a test-execution. stepId may be either the definition-step id (clone source) or the execution-step's own id. patch = { actualResult?, status?, note? } where status ∈ pending|passed|failed|blocked|skipped.",
    inputSchema: {
      projectId:   z.string(),
      executionId: z.string(),
      stepId:      z.string(),
      patch:       passthroughObjectSchema
    }
  }, async ({ projectId, executionId, stepId, patch }) => {
    const actor = AI_ACTOR;
    const r = await persist(storage, projectId, "test_exec_record",
      (cur) => core.ops.recordTestExecStep(cur, executionId, stepId, patch || {}, actor), actor);
    if (r.error) return r.error;
    const exec = r.saved.snapshot.tickets.find(t => t.id === executionId);
    const step = exec && (exec.executionSteps || [])
      .find(x => x.stepId === stepId || x.id === stepId);
    return ok({
      revision: r.saved.revision, savedAt: r.saved.savedAt,
      step: step,
      effectiveOutcome: exec && core.getEffectiveOutcome(exec)
    });
  });

  server.registerTool("test_exec_set_outcome", {
    description: "Set the manual outcome override on a test-execution. outcome ∈ pending|passed|failed|blocked|skipped or 'auto' to reset (let deriveOutcome take over). The 'auto' form clears outcomeOverride.",
    inputSchema: {
      projectId:   z.string(),
      executionId: z.string(),
      outcome:     z.string()
    }
  }, async ({ projectId, executionId, outcome }) => {
    const actor = AI_ACTOR;
    const r = await persist(storage, projectId, "test_exec_set_outcome",
      (cur) => core.ops.setTestExecOutcome(cur, executionId, outcome, actor), actor);
    if (r.error) return r.error;
    const exec = r.saved.snapshot.tickets.find(t => t.id === executionId);
    return ok({
      revision: r.saved.revision, savedAt: r.saved.savedAt,
      outcomeOverride: exec && exec.outcomeOverride,
      effectiveOutcome: exec && core.getEffectiveOutcome(exec)
    });
  });

  server.registerTool("test_exec_history", {
    description: "List test-execution tickets for a given test-definition, sorted by runAt descending. Use the resulting executions[].id to recordTestExecStep / setTestExecOutcome.",
    inputSchema: {
      projectId:    z.string(),
      definitionId: z.string(),
      limit:        z.number().optional()
    }
  }, async ({ projectId, definitionId, limit }) => {
    const current = await storage.loadProject(projectId);
    if (!current) return fail("project not found: " + projectId, { statusCode: 404 });
    const history = core.tickets.testExecHistory(current, definitionId,
      typeof limit === "number" ? { limit: limit } : undefined);
    // Compact form to keep the response small for large histories.
    const summary = history.map(t => ({
      id:               t.id,
      ticketKey:        t.ticketKey,
      title:            t.title,
      status:           t.status,
      runAt:            t.runAt,
      env:              t.env || null,
      effectiveOutcome: core.getEffectiveOutcome(t)
    }));
    return ok({ executions: summary });
  });

  server.registerTool("restore_revision", {
    description: "Restore a project to a previous revision. The restore creates a NEW revision with op='project_restore', so the restore itself is undoable.",
    inputSchema: { projectId: z.string(), revision: z.string() }
  }, async ({ projectId, revision }) => {
    const actor = AI_ACTOR;
    try {
      const result = await storage.restoreRevision(projectId, revision, { actor });
      return ok({ revision: result.revision, savedAt: result.savedAt, snapshot: result.snapshot });
    } catch (err) {
      if (/not found/i.test(err.message || "")) {
        return fail(err.message, { statusCode: 404 });
      }
      return fail(err.message || "restore failed", { statusCode: err.statusCode || 500 });
    }
  });

  // ---- SM-290/291: Datenaustausch — bulk ticket import + project export ----

  server.registerTool("import_tickets", {
    description: "Bulk-import tickets from CSV (header row = field keys: key, type, title, description, "
      + "status, release, processStep, epic, labels — the export_tickets/SM-285 format) or `rows` (array "
      + "of ticket objects, same fields). Replaces N × ticket_create for mass creates. mode 'create-only' "
      + "(default): rows with an EXISTING ticket key error; 'upsert': existing keys are PATCHED with only "
      + "the present, actually-changed fields (empty cells never clear). Refs resolve by name OR id; epic "
      + "by ticketKey. ALWAYS run dryRun:true first and show the human the plan ({creates, updates, "
      + "errors} with line numbers) before applying. Apply writes everything in ONE revision; error rows "
      + "are never written. When both csv and rows are given, rows wins. POLICY: import is a migration "
      + "surface — statuses apply WITHOUT DoR/DoD gates.",
    inputSchema: {
      projectId: z.string(),
      csv: z.string().optional(),
      rows: tolerateJsonString(z.array(z.object({}).passthrough())).optional(),
      mode: z.enum(["create-only", "upsert"]).optional(),
      dryRun: z.boolean().optional(),
      // SM-296: {csvHeader → field | null=ignore} — per-column override of the
      // built-in header resolution (foreign exports: Jira, Excel, …).
      headerMapping: tolerateJsonString(z.record(z.string().nullable())).optional(),
      // SM-297: {field: {sourceValue → target | null=drop}} for status/type/
      // release/processStep — the dryRun plan lists unknownValues to map.
      valueMapping: tolerateJsonString(z.record(z.record(z.string().nullable()))).optional()
    }
  }, async (args) => {
    const actor = actorFromArgs(args);
    const mode = args.mode || "create-only";
    if (!args.csv && !args.rows) return fail("either csv or rows is required", { statusCode: 400 });
    // Belt+braces vs. the bridge footgun: tolerateJsonString covers the zod
    // path, but in-process callers (tests, embedding) hit the handler raw —
    // a string `rows` is treated as its JSON text directly (same for
    // headerMapping).
    const rowsText = args.rows == null ? null
      : (typeof args.rows === "string" ? args.rows : JSON.stringify(args.rows));
    let headerMapping = args.headerMapping || null;
    if (typeof headerMapping === "string") {
      // Loud, not silent: a typo'd mapping string must not degrade to
      // heuristic-only (review finding on aac77aa).
      try { headerMapping = JSON.parse(headerMapping); }
      catch (_e) { return fail("headerMapping is not valid JSON", { statusCode: 400 }); }
    }
    let valueMapping = args.valueMapping || null;
    if (typeof valueMapping === "string") {
      try { valueMapping = JSON.parse(valueMapping); }
      catch (_e) { return fail("valueMapping is not valid JSON", { statusCode: 400 }); }
    }
    const planOpts = { valueMapping: valueMapping };
    const parsed = rowsText != null
      ? ticketImport.parseTicketImport(rowsText, "json")
      : ticketImport.parseTicketImport(args.csv, "csv", { headerMapping: headerMapping });
    if (parsed.error) return fail(parsed.error, { kind: "IMPORT_PARSE", statusCode: 400 });

    const planSummary = (plan) => ({
      creates: plan.creates.map(c => ({ line: c.line, title: c.ticket.title, type: c.ticket.type })),
      updates: plan.updates.map(u => ({ line: u.line, ticketKey: u.ticketKey, fields: Object.keys(u.patch) })),
      errors: plan.errors,
      // SM-297: what an agent still needs to map (distinct source values)
      unknownValues: plan.unknownValues
    });

    if (args.dryRun) {
      const snap = await storage.loadProject(args.projectId);
      if (!snap) return fail("project not found: " + args.projectId, { statusCode: 404 });
      const plan = ticketImport.planTicketImport(snap, parsed.rows, mode, planOpts);
      return ok({ dryRun: true, mode: mode, plan: planSummary(plan) });
    }

    // Plan + apply INSIDE the storage mutex (SM-154 pattern) so a concurrent
    // writer can't invalidate the plan between planning and persisting.
    // storage.mutate directly (not persist()) so the no-write sentinel is
    // identified by its FLAG — a counts-based inference could mask a real
    // mid-apply error as "nothing to write" (review finding on a14c8ae).
    let plan = null, counts = null;
    let saved;
    try {
      saved = await storage.mutate(args.projectId, { actor, op: "import_tickets" }, (cur) => {
        plan = ticketImport.planTicketImport(cur, parsed.rows, mode, planOpts);
        const applied = ticketImport.applyImportPlan(cur, plan, actor);
        counts = { created: applied.created, updated: applied.updated };
        if (applied.created + applied.updated === 0) {
          const e = new Error("__import_no_write__");
          e.__noWrite = true;
          throw e;   // abort the mutate — no empty revision
        }
        validation.snapshotLimits(applied.snapshot);
        return applied.snapshot;
      });
    } catch (err) {
      if (err && err.__noWrite) {
        return ok({ applied: counts, mode: mode, plan: planSummary(plan),
          note: "nothing to write (errors only or all no-op) — no revision created" });
      }
      return fail(err.message || "import failed",
        { statusCode: err.statusCode || 500, kind: err.kind, missing: err.missing });
    }
    return ok({
      revision: saved.revision, savedAt: saved.savedAt,
      applied: counts, mode: mode,
      errors: plan.errors,
      // SM-297: what an agent still needs to map (distinct source values)
      unknownValues: plan.unknownValues
    });
  });

  server.registerTool("export_project", {
    description: "Export a whole project as the re-importable storymap-project JSON envelope "
      + "({format, version, exportedAt, snapshot}) — the SAME format as the browser's Export… → "
      + "Projekt (JSON). Use for post-processing, backups and transfers (the envelope re-imports "
      + "via the browser Import… dialog). Prefer project_get when you only need to READ data.",
    inputSchema: { projectId: z.string() }
  }, async ({ projectId }) => {
    const snap = await storage.loadProject(projectId);
    if (!snap) return fail("project not found: " + projectId, { statusCode: 404 });
    const envelope = projectIO.serializeProject(snap, { exportedAt: new Date().toISOString() });
    return ok({
      filename: projectIO.exportFilename(snap),
      envelope: JSON.parse(envelope)   // structured, not double-encoded
    });
  });

  return server;
}

async function runStdio(storage, opts) {
  opts = opts || {};
  const httpUrl = (typeof opts.httpUrl === "string")
    ? opts.httpUrl
    : (process.env.STORYMAP_HTTP_URL || "http://localhost:8770");
  const server = buildServer(storage, { httpUrl, fetchImpl: opts.fetchImpl });
  // SM-309/310: the native stdio frontend replaces StdioServerTransport +
  // server.connect(). Returns { close } — index.js drives transport.close().
  const transport = createStdioServer(server, { input: process.stdin, output: process.stdout });
  return { server, transport };
}

module.exports = { buildServer, runStdio };
