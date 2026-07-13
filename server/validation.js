"use strict";

/**
 * Input validators. Throw { statusCode, message, ... } on violation.
 * HTTP and MCP layers map statusCode → 400/422/413 etc.
 *
 * Status transitions enforce DoR (backlog→ready and any forward jump
 * that crosses → ready) and DoD (any forward jump that crosses → done).
 * Reopens (done → anything backwards) bypass DoR/DoD.
 */

const core = require("./core.js");

function err(statusCode, message, extra) {
  const e = new Error(message);
  e.statusCode = statusCode;
  if (extra) Object.assign(e, extra);
  return e;
}

// ---------------------------------------------------------------------------
// project / ticket / release / process-step input
// ---------------------------------------------------------------------------

const TICKET_PREFIX_RE = /^[A-Z0-9]{1,10}$/;
const ID_RE = /^[a-zA-Z0-9_-]{1,100}$/;

function projectInput(p) {
  if (!p || typeof p !== "object") throw err(400, "project: object required");
  if (typeof p.name !== "string" || p.name.trim().length === 0) {
    throw err(400, "project.name is required");
  }
  if (p.name.length > 200) throw err(400, "project.name too long (max 200)");
  if (p.description != null && (typeof p.description !== "string" ||
      p.description.length > core.LIMITS.maxDescriptionLength)) {
    throw err(400, "project.description invalid or too long");
  }
  if (p.ticketPrefix != null) {
    if (typeof p.ticketPrefix !== "string" || !TICKET_PREFIX_RE.test(p.ticketPrefix)) {
      throw err(400, "project.ticketPrefix must match /^[A-Z0-9]{1,10}$/");
    }
  }
  if (p.definitions) definitionsInput(p.definitions);
}

function ticketInput(t, project) {
  if (!t || typeof t !== "object") throw err(400, "ticket: object required");
  if (typeof t.title !== "string" || t.title.trim().length === 0) {
    throw err(400, "ticket.title is required");
  }
  if (t.title.length > core.LIMITS.maxTitleLength) {
    throw err(400, "ticket.title too long (max " + core.LIMITS.maxTitleLength + ")");
  }
  if (t.description != null) {
    if (typeof t.description !== "string") throw err(400, "ticket.description must be a string");
    if (t.description.length > core.LIMITS.maxDescriptionLength) {
      throw err(400, "ticket.description too long (max " + core.LIMITS.maxDescriptionLength + ")");
    }
  }
  if (t.type != null) {
    if (typeof t.type !== "string") throw err(400, "ticket.type must be a string");
    if (project && Array.isArray(project.ticketTypes) && project.ticketTypes.length > 0) {
      if (project.ticketTypes.indexOf(t.type) < 0) {
        throw err(400, "ticket.type not in project.ticketTypes: " + t.type);
      }
    }
  }
}

function releaseInput(r) {
  if (!r || typeof r !== "object") throw err(400, "release: object required");
  if (typeof r.name !== "string" || r.name.trim().length === 0) {
    throw err(400, "release.name is required");
  }
  if (r.name.length > 200) throw err(400, "release.name too long (max 200)");
  if (r.status != null && core.DEFAULT_RELEASE_STATUSES.indexOf(r.status) < 0) {
    throw err(400, "release.status invalid: " + r.status);
  }
}

// SM-255: the last remaining (non-deleted) release may not be deleted — a
// project always keeps ≥1 release (paired with SM-254's create-time seed, the
// invariant holds end to end). Throws 422 kind=LAST_RELEASE. A no-op (the id
// isn't a live release) is left to the delete op itself.
function releaseDelete(snapshot, releaseId) {
  const live = ((snapshot && snapshot.releases) || []).filter(r => r && !r.isDeleted);
  const target = live.find(r => r.id === releaseId);
  if (target && live.length <= 1) {
    throw err(422, "cannot delete the last release — a project needs at least one",
      { kind: "LAST_RELEASE" });
  }
}

function processStepInput(s) {
  if (!s || typeof s !== "object") throw err(400, "processStep: object required");
  if (typeof s.name !== "string" || s.name.trim().length === 0) {
    throw err(400, "processStep.name is required");
  }
  if (s.name.length > 200) throw err(400, "processStep.name too long (max 200)");
}

// ---------------------------------------------------------------------------
// definitions input (DoR/DoD config on the project level)
// ---------------------------------------------------------------------------

function validateDefinitionItem(item, kind) {
  if (!item || typeof item !== "object") throw err(400, kind + ": each item must be an object");
  if (typeof item.id !== "string" || item.id.length === 0) {
    throw err(400, kind + ": item.id is required");
  }
  if (typeof item.label !== "string" || item.label.length === 0) {
    throw err(400, kind + ": item.label is required");
  }
  if (item.required != null && typeof item.required !== "boolean") {
    throw err(400, kind + ": item.required must be boolean");
  }
}

function validateBlock(block, kind) {
  if (!block || typeof block !== "object") {
    throw err(400, "definitions." + kind + " block missing");
  }
  if (block.global != null) {
    if (!Array.isArray(block.global)) throw err(400, "definitions." + kind + ".global must be array");
    if (block.global.length > core.LIMITS.maxChecklistItems) {
      throw err(400, "definitions." + kind + ".global exceeds limit");
    }
    for (const item of block.global) validateDefinitionItem(item, kind + ".global");
  }
  if (block.byType != null) {
    if (typeof block.byType !== "object" || Array.isArray(block.byType)) {
      throw err(400, "definitions." + kind + ".byType must be object");
    }
    for (const t of Object.keys(block.byType)) {
      const entry = block.byType[t];
      // Guard a null / non-object entry — otherwise `entry.appended` throws a
      // raw TypeError that surfaces as a 500 instead of this structured 400.
      // Consistent with validateDefinitionItem's object check. (SM-151)
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw err(400, "definitions." + kind + ".byType." + t + " must be an object");
      }
      if (entry.appended != null) {
        if (!Array.isArray(entry.appended)) throw err(400, kind + ".byType." + t + ".appended must be array");
        if (entry.appended.length > core.LIMITS.maxChecklistItems) {
          throw err(400, kind + ".byType." + t + ".appended exceeds limit");
        }
        for (const it of entry.appended) validateDefinitionItem(it, kind + ".byType." + t + ".appended");
      }
      if (entry.overridden != null) {
        if (!Array.isArray(entry.overridden)) throw err(400, kind + ".byType." + t + ".overridden must be array");
        if (entry.overridden.length > core.LIMITS.maxChecklistItems) {
          throw err(400, kind + ".byType." + t + ".overridden exceeds limit");
        }
        for (const it of entry.overridden) validateDefinitionItem(it, kind + ".byType." + t + ".overridden");
      }
    }
  }
}

function definitionsInput(defs) {
  if (!defs || typeof defs !== "object") throw err(400, "definitions object required");
  if (!defs.ready) throw err(400, "definitions.ready block missing");
  if (!defs.done) throw err(400, "definitions.done block missing");
  validateBlock(defs.ready, "ready");
  validateBlock(defs.done, "done");
}

// ---------------------------------------------------------------------------
// changeStatusTransition — DoR / DoD enforcement
// ---------------------------------------------------------------------------
//
// Status-Sequenz + Gate-Regeln kommen jetzt aus dem per-Projekt + per-Type
// resolvbaren Workflow (E13.C). Pro Vorwärts-Schritt im Workflow wird
// geprüft, ob das Ziel ein `requireGate` hat (DoR/DoD/null); jeder
// überquerte Status mit Gate wird einzeln validiert (Sprung-Übergänge
// greifen alle dazwischenliegenden Gates).

// E18.D: Implementierung liegt jetzt in `core.validateStatusTransition` —
// dieselbe Logik wird vom Frontend-Store vor dem Commit aufgerufen, damit
// die Gate-Validierung im snapshot-PUT-Pfad nicht verloren geht. Hier nur
// noch ein Delegate für Backward-Compat der bestehenden REST-Endpoints.
function changeStatusTransition(ticket, newStatus, project) {
  return core.validateStatusTransition(ticket, newStatus, project);
}

// ---------------------------------------------------------------------------
// snapshotLimits — guard against oversized snapshots before saving
// ---------------------------------------------------------------------------

function snapshotLimits(snap) {
  const t = (snap.tickets || []).length;
  if (t > core.LIMITS.maxTicketsPerProject) {
    throw err(400, "too many tickets: " + t + " (limit " + core.LIMITS.maxTicketsPerProject + ")");
  }
  const r = (snap.releases || []).length;
  if (r > core.LIMITS.maxReleases) {
    throw err(400, "too many releases: " + r + " (limit " + core.LIMITS.maxReleases + ")");
  }
  const ps = (snap.processSteps || []).length;
  if (ps > core.LIMITS.maxProcessSteps) {
    throw err(400, "too many processSteps: " + ps + " (limit " + core.LIMITS.maxProcessSteps + ")");
  }
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

function entityId(id, label) {
  if (typeof id !== "string" || !ID_RE.test(id)) {
    throw err(400, (label || "id") + " invalid: must match [a-zA-Z0-9_-]{1,100}");
  }
}

module.exports = {
  projectInput,
  ticketInput,
  releaseInput,
  releaseDelete,
  processStepInput,
  definitionsInput,
  changeStatusTransition,
  snapshotLimits,
  entityId
};
