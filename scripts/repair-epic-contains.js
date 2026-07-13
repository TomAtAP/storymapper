#!/usr/bin/env node
// One-shot repair: convert all epic→non-epic relates-to links to contains
// links (with proper linkTypeId field, not legacy `type:`). Source = the
// running server's persisted snapshot. After mutating in memory we PUT the
// full snapshot back through /api/projects/:pid — that runs the normaliser,
// fixes any other legacy fields, bumps a revision, and broadcasts to all
// connected browsers via WS.
//
// Strict read-only against the SQLite — we never write to it directly.

const Database = require("better-sqlite3");
const http = require("http");

const DB_PATH = "./.storymap-data/storymap.sqlite";
const PROJECT_ID = "storymap-roadmap";
const SERVER = "http://localhost:8770";

function httpPut(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const url = new URL(SERVER + path);
    const req = http.request({
      hostname: url.hostname, port: url.port, path: url.pathname,
      method: "PUT",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data),
                 "X-Origin-Id": "repair-script-" + Date.now() }
    }, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        resolve({ status: res.statusCode, body: text });
      });
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

(async () => {
  const db = new Database(DB_PATH, { readonly: true });
  const row = db.prepare("SELECT snapshot FROM projects WHERE id = ?").get(PROJECT_ID);
  db.close();
  if (!row) { console.error("project not found:", PROJECT_ID); process.exit(1); }
  const snap = JSON.parse(row.snapshot);

  const tickets = snap.tickets || [];
  const typeById = new Map(tickets.map(t => [t.id, t.type]));

  let convertedRelToContains = 0;
  let renamedTypeToLinkTypeId = 0;
  let droppedSelfOrInvalid = 0;
  const perEpic = {};   // ticketKey -> count

  for (const t of tickets) {
    if (t.type !== "epic" || !Array.isArray(t.links)) continue;
    const next = [];
    for (const l of t.links) {
      const targetType = typeById.get(l.targetTicketId);
      const linkType = l.linkTypeId || l.type;
      // Drop self-links / unknown targets (defensive).
      if (!l.targetTicketId || l.targetTicketId === t.id || !targetType) {
        droppedSelfOrInvalid++;
        continue;
      }
      // Epic → non-epic with relates-to is the bug signature. Convert it.
      // Keep links to other epics as-is (might be legitimate cross-epic links).
      let newLinkType = linkType;
      if (targetType !== "epic" && linkType === "relates-to") {
        newLinkType = "contains";
        convertedRelToContains++;
        perEpic[t.ticketKey] = (perEpic[t.ticketKey] || 0) + 1;
      }
      // Drop the legacy `type` field, write canonical `linkTypeId`.
      const clean = {
        id: l.id,
        linkTypeId: newLinkType,
        targetTicketId: l.targetTicketId,
        createdAt: l.createdAt,
        createdBy: l.createdBy
      };
      if (l.label) clean.label = l.label;
      if (l.type && !l.linkTypeId) renamedTypeToLinkTypeId++;
      next.push(clean);
    }
    t.links = next;
  }

  // Also fix legacy `type:` on non-epic tickets' links (other linkType-Ids
  // might also be persisted as `type:` rather than `linkTypeId:`).
  let renamedOnNonEpic = 0;
  for (const t of tickets) {
    if (t.type === "epic" || !Array.isArray(t.links)) continue;
    for (const l of t.links) {
      if (l.type && !l.linkTypeId) {
        l.linkTypeId = l.type;
        delete l.type;
        renamedOnNonEpic++;
      }
    }
  }

  console.log("\n=== Repair summary ===");
  console.log("Epic→non-epic 'relates-to' converted to 'contains':", convertedRelToContains);
  console.log("Legacy `type:` renamed to `linkTypeId:` on epic links:", renamedTypeToLinkTypeId);
  console.log("Legacy `type:` renamed to `linkTypeId:` on non-epic links:", renamedOnNonEpic);
  console.log("Dropped self-links / dangling targets:", droppedSelfOrInvalid);
  console.log("\nPer-epic conversion counts:");
  for (const [k, n] of Object.entries(perEpic)) console.log("  " + k + ": " + n);

  console.log("\nPUTting cleaned snapshot to server...");
  const r = await httpPut("/api/projects/" + PROJECT_ID, snap);
  console.log("HTTP " + r.status);
  if (r.status >= 300) {
    console.error("PUT failed:", r.body.slice(0, 500));
    process.exit(2);
  }
  const parsed = JSON.parse(r.body);
  console.log("New revision:", parsed.revision || "(unknown)");
  console.log("Browsers connected via WS should refresh automatically.");
})();
