"use strict";

/**
 * SM-219 — deterministic large-snapshot generator for perf benchmarking.
 *
 * Pure. NO Math.random / Date.now in the generation logic, so the same opts
 * always yield a deep-equal snapshot (reproducible baselines). Produces a
 * realistic shape: epics holding their stories via `contains` links, work items
 * with acceptance criteria + frozen DoR/DoD, a mix of types (user-story / bug /
 * test-definition), labels, releases, process steps, and optional precedence
 * links. Lives under tests/helpers/ (not a test-*.js file, so tests/run.js
 * never loads it).
 *
 *   buildLargeSnapshot({ tickets, releases, processSteps, epics, linksPerTicket })
 *     → { project, tickets, releases, processSteps }   (raw — feed to normalizeSnapshot)
 */

const DEFAULTS = { tickets: 500, releases: 4, processSteps: 6, epics: null, linksPerTicket: 1 };
const BASE_TS = 1700000000000;   // fixed epoch → deterministic audit fields
const ACTOR = Object.freeze({ type: "ai", id: "perf-gen", name: "Perf Generator" });
const STATUSES = ["backlog", "ready", "in-progress", "review", "done"];

function buildLargeSnapshot(opts) {
  opts = Object.assign({}, DEFAULTS, opts || {});
  const N = Math.max(1, opts.tickets | 0);
  const R = Math.max(1, opts.releases | 0);
  const P = Math.max(1, opts.processSteps | 0);
  // Clamp epics to the ticket budget so `tickets` is never silently exceeded
  // (epics + work items === N). Default ~12 work items per epic.
  const E = Math.max(1, Math.min(N, opts.epics != null ? (opts.epics | 0) : Math.max(1, Math.floor(N / 12))));
  const LPT = Math.max(0, opts.linksPerTicket | 0);
  const ts = (i) => BASE_TS + i * 1000;
  const audit = (i) => ({ createdAt: ts(i), createdBy: ACTOR, updatedAt: ts(i), updatedBy: ACTOR, version: 1 });

  const releases = [];
  for (let i = 0; i < R; i++) {
    releases.push(Object.assign({
      id: "r-" + i, projectId: "perf", name: "v" + i + ".0", description: "Release " + i,
      status: ["planning", "active", "completed"][i % 3], startDate: null, endDate: null,
      sortOrder: i, isDeleted: false
    }, audit(i)));
  }
  const processSteps = [];
  for (let i = 0; i < P; i++) {
    processSteps.push(Object.assign({
      id: "ps-" + i, projectId: "perf", name: "Step " + i, description: "Phase " + i,
      epicId: null, sortOrder: i, isDeleted: false
    }, audit(i)));
  }

  const tickets = [];
  // Epics first (E entries), then E .. N-1 are work items.
  for (let i = 0; i < E; i++) {
    tickets.push(Object.assign({
      id: "t-epic-" + i, projectId: "perf", type: "epic", ticketKey: "PF-E" + i,
      title: "Epic " + i + " — capability group", description: "Epic description for capability group " + i + ".",
      status: "backlog",
      position: { releaseId: "r-" + (i % R), processStepId: "ps-" + (i % P), epicId: null, sortOrder: i },
      links: [], labels: ["area-" + (i % 4)], acceptanceCriteria: [], comments: [], prerequisites: [], steps: []
    }, audit(i)));
  }
  const childrenByEpic = {};
  const M = N - E;
  for (let i = 0; i < M; i++) {
    const epicIdx = i % E;
    const type = (i % 17 === 0) ? "test-definition" : (i % 11 === 0 ? "bug" : "user-story");
    const acN = 2 + (i % 3);
    const acceptanceCriteria = [];
    for (let a = 0; a < acN; a++) {
      acceptanceCriteria.push({ id: "ac-" + i + "-" + a, text: "Acceptance criterion " + a + " for work item " + i + ".", completed: (a % 2 === 0) });
    }
    tickets.push(Object.assign({
      id: "t-" + i, projectId: "perf", type: type, ticketKey: "PF-" + i,
      title: "Work item " + i + " — implement the thing",
      description: "A realistic description paragraph for item " + i + " with enough text to be representative of a real ticket body.",
      status: STATUSES[i % 5],
      position: { releaseId: "r-" + (epicIdx % R), processStepId: "ps-" + (epicIdx % P), epicId: null, sortOrder: i },
      links: [],
      labels: ["label-" + (i % 6), "team-" + (i % 3)],
      acceptanceCriteria: acceptanceCriteria,
      definitionOfReady: { items: [
        { id: "dor-acceptance", label: "Acceptance criteria are defined", required: true, checked: (i % 2 === 0), checkedAt: null, checkedBy: null },
        { id: "dor-clarity", label: "Scope is clear", required: true, checked: (i % 3 === 0), checkedAt: null, checkedBy: null }
      ] },
      definitionOfDone: { items: [
        { id: "dod-ac", label: "All acceptance criteria are met", required: true, checked: false, checkedAt: null, checkedBy: null },
        { id: "dod-test", label: "Has automated test", required: true, checked: false, checkedAt: null, checkedBy: null }
      ] },
      comments: [], prerequisites: [], steps: []
    }, audit(i + E)));
    (childrenByEpic[epicIdx] = childrenByEpic[epicIdx] || []).push("t-" + i);
  }

  const byId = new Map(tickets.map((t) => [t.id, t]));
  // contains-links: each epic → its children (epic containment lives in the link, SM-52).
  for (let i = 0; i < E; i++) {
    const kids = childrenByEpic[i] || [];
    byId.get("t-epic-" + i).links = kids.map((cid, j) => ({
      id: "ln-c-" + i + "-" + j, linkTypeId: "contains", targetTicketId: cid, createdAt: ts(i), createdBy: ACTOR
    }));
  }
  // precedence links among siblings (deterministic, cycle-free: only to LATER siblings).
  if (LPT > 0) {
    for (let i = 0; i < E; i++) {
      const kids = childrenByEpic[i] || [];
      for (let j = 0; j < kids.length; j++) {
        const t = byId.get(kids[j]);
        const links = [];
        for (let l = 1; l <= LPT && j + l < kids.length; l++) {
          links.push({ id: "ln-p-" + i + "-" + j + "-" + l, linkTypeId: "predecessor-of", targetTicketId: kids[j + l], createdAt: ts(j), createdBy: ACTOR });
        }
        t.links = links;
      }
    }
  }

  const project = {
    id: "perf", name: "Perf Fixture",
    description: "Generated large board for performance benchmarking (SM-219).",
    ticketPrefix: "PF", ticketCounter: N,
    labels: ["area-0", "area-1", "area-2", "area-3", "label-0", "team-0"]
  };
  return { project: project, tickets: tickets, releases: releases, processSteps: processSteps };
}

module.exports = { buildLargeSnapshot: buildLargeSnapshot, BASE_TS: BASE_TS };
