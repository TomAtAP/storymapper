"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { startServer } = require("../server/server.js");

let passed = 0, failed = 0;
function test(name, fn) {
  const exec = async () => {
    try {
      const r = fn();
      if (r && typeof r.then === "function") await r;
      console.log(`  ok  - ${name}`); passed++;
    } catch (err) {
      console.log(`  FAIL - ${name}\n         ${err.stack || err.message}`);
      failed++; process.exitCode = 1;
    }
  };
  return (test._chain = (test._chain || Promise.resolve()).then(exec));
}

async function tmpDir() {
  return await fs.promises.mkdtemp(path.join(os.tmpdir(), "storymap-server-"));
}

async function startTest() {
  const dataDir = await tmpDir();
  const handle = await startServer({ port: 0, dataDir });
  const port = handle.httpServer.address().port;
  return { handle, port, dataDir, base: `http://localhost:${port}` };
}

async function req(base, method, p, body, headers) {
  const init = { method, headers: Object.assign({ "Content-Type": "application/json" }, headers || {}) };
  if (body !== undefined) init.body = typeof body === "string" ? body : JSON.stringify(body);
  const res = await fetch(base + p, init);
  let data = null;
  const text = await res.text();
  if (text) {
    try { data = JSON.parse(text); } catch (_) { data = text; }
  }
  return { status: res.status, headers: res.headers, data };
}

const HUMAN = { type: "human", id: "u1", name: "Test" };

// ---------------------------------------------------------------------------
// Health + CORS
// ---------------------------------------------------------------------------

test("SM-244: server widens keepAliveTimeout beyond Node's 5s default (avoids aborted PUTs)", async () => {
  const t = await startTest();
  try {
    assert.ok(t.handle.httpServer.keepAliveTimeout >= 60 * 1000,
      "keepAliveTimeout must be widened, got " + t.handle.httpServer.keepAliveTimeout);
    assert.ok(t.handle.httpServer.headersTimeout > t.handle.httpServer.keepAliveTimeout,
      "headersTimeout must exceed keepAliveTimeout");
  } finally { await t.handle.shutdown(); }
});

test("GET /api/health → 200 + limits", async () => {
  const t = await startTest();
  try {
    const r = await req(t.base, "GET", "/api/health");
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.ok, true);
    assert.ok(r.data.limits);
    assert.ok(typeof r.data.limits.maxTicketsPerProject === "number");
  } finally { await t.handle.shutdown(); }
});

test("SM-99: GET /api/health carries name:'storymap' identity marker", async () => {
  const t = await startTest();
  try {
    const r = await req(t.base, "GET", "/api/health");
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.name, "storymap",
      "frontend probe checks body.name to avoid latching onto an unrelated server");
  } finally { await t.handle.shutdown(); }
});

test("CORS preflight reflects a loopback Origin (never *) — SM-211", async () => {
  const t = await startTest();
  try {
    const r = await req(t.base, "OPTIONS", "/api/projects", undefined, { Origin: t.base });
    assert.strictEqual(r.status, 204);
    assert.strictEqual(r.headers.get("access-control-allow-origin"), t.base,
      "loopback origin is reflected verbatim; the old wildcard let any website write");
    assert.ok((r.headers.get("access-control-allow-methods") || "").includes("PUT"));
    // No Origin → no ACAO needed (non-browser callers are unaffected by CORS).
    const bare = await req(t.base, "OPTIONS", "/api/projects");
    assert.strictEqual(bare.status, 204);
    assert.strictEqual(bare.headers.get("access-control-allow-origin"), null);
  } finally { await t.handle.shutdown(); }
});

// ---------------------------------------------------------------------------
// Projects CRUD
// ---------------------------------------------------------------------------

test("GET /api/projects empty initially", async () => {
  const t = await startTest();
  try {
    const r = await req(t.base, "GET", "/api/projects");
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.data, []);
  } finally { await t.handle.shutdown(); }
});

test("POST /api/projects creates a project", async () => {
  const t = await startTest();
  try {
    const r = await req(t.base, "POST", "/api/projects", {
      id: "p1", name: "Acme"
    });
    assert.strictEqual(r.status, 201);
    assert.ok(r.data.snapshot);
    assert.strictEqual(r.data.snapshot.project.id, "p1");
    // SM-254: a created project is immediately usable — one default release + step.
    assert.strictEqual(r.data.snapshot.releases.filter(x => !x.isDeleted).length, 1,
      "default release seeded");
    assert.strictEqual(r.data.snapshot.processSteps.filter(x => !x.isDeleted).length, 1,
      "default process step seeded");
    const list = await req(t.base, "GET", "/api/projects");
    assert.deepStrictEqual(list.data, ["p1"]);
  } finally { await t.handle.shutdown(); }
});

test("POST /api/projects: missing name → 400", async () => {
  const t = await startTest();
  try {
    const r = await req(t.base, "POST", "/api/projects", { id: "p1" });
    assert.strictEqual(r.status, 400);
    assert.ok(r.data.error);
  } finally { await t.handle.shutdown(); }
});

test("GET /api/projects/:pid → snapshot or 404", async () => {
  const t = await startTest();
  try {
    let r = await req(t.base, "GET", "/api/projects/missing");
    assert.strictEqual(r.status, 404);
    await req(t.base, "POST", "/api/projects", { id: "p1", name: "Acme" });
    r = await req(t.base, "GET", "/api/projects/p1");
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.project.name, "Acme");
  } finally { await t.handle.shutdown(); }
});

test("DELETE /api/projects/:pid → 204, then GET → 404", async () => {
  const t = await startTest();
  try {
    await req(t.base, "POST", "/api/projects", { id: "p1", name: "Acme" });
    const r = await req(t.base, "DELETE", "/api/projects/p1");
    assert.strictEqual(r.status, 204);
    const r2 = await req(t.base, "GET", "/api/projects/p1");
    assert.strictEqual(r2.status, 404);
  } finally { await t.handle.shutdown(); }
});

// ---------------------------------------------------------------------------
// E18.A — PUT /api/projects/:pid: full-snapshot replace (cmapper-Pattern)
// ---------------------------------------------------------------------------

test("PUT /api/projects/:pid with full snapshot replaces tickets/releases/process-steps", async () => {
  const t = await startTest();
  try {
    await req(t.base, "POST", "/api/projects", { id: "p1", name: "Acme" });
    // Populate via per-op REST so we have content to overwrite.
    await req(t.base, "POST", "/api/projects/p1/tickets", { type: "user-story", title: "Original" });
    await req(t.base, "POST", "/api/projects/p1/releases", { name: "v0.1" });

    const snap = (await req(t.base, "GET", "/api/projects/p1")).data;
    // Mutate the snapshot client-side: rename project, drop the ticket, add a new one.
    const next = Object.assign({}, snap, {
      project: Object.assign({}, snap.project, { name: "Renamed" }),
      tickets: [
        { id: "t-new", type: "user-story", title: "Replacement", status: "backlog",
          position: { sortOrder: 0 }, ticketKey: "P-99" }
      ],
      releases: [],   // wiped
      processSteps: []
    });
    const r = await req(t.base, "PUT", "/api/projects/p1", next);
    assert.strictEqual(r.status, 200);
    assert.ok(r.data.revision);
    assert.ok(r.data.snapshot);
    assert.strictEqual(r.data.snapshot.project.name, "Renamed");
    assert.strictEqual(r.data.snapshot.tickets.length, 1);
    assert.strictEqual(r.data.snapshot.tickets[0].title, "Replacement");
    assert.strictEqual(r.data.snapshot.releases.length, 0);

    const reload = (await req(t.base, "GET", "/api/projects/p1")).data;
    assert.strictEqual(reload.tickets.length, 1);
    assert.strictEqual(reload.tickets[0].id, "t-new");
  } finally { await t.handle.shutdown(); }
});

test("PUT /api/projects/:pid snapshot creates exactly one revision with op project_put", async () => {
  const t = await startTest();
  try {
    await req(t.base, "POST", "/api/projects", { id: "p1", name: "Acme" });
    const before = (await req(t.base, "GET", "/api/projects/p1/revisions")).data.length;
    const snap = (await req(t.base, "GET", "/api/projects/p1")).data;
    const next = Object.assign({}, snap, {
      tickets: [{ id: "t-x", type: "user-story", title: "X", status: "backlog", position: { sortOrder: 0 } }]
    });
    await req(t.base, "PUT", "/api/projects/p1", next);
    const after = (await req(t.base, "GET", "/api/projects/p1/revisions")).data;
    assert.strictEqual(after.length, before + 1, "expected exactly one new revision");
    assert.strictEqual(after[0].op, "project_put");
  } finally { await t.handle.shutdown(); }
});

test("PUT /api/projects/:pid snapshot fires bus.change with snapshot + originId", async () => {
  const t = await startTest();
  try {
    await req(t.base, "POST", "/api/projects", { id: "p1", name: "Acme" });
    const bus = require("../server/bus.js");
    let captured = null;
    const handler = (ev) => { if (ev.projectId === "p1") captured = ev; };
    bus.on("change", handler);
    try {
      const snap = (await req(t.base, "GET", "/api/projects/p1")).data;
      const next = Object.assign({}, snap, {
        tickets: [{ id: "t-evt", type: "task", title: "Y", status: "backlog", position: { sortOrder: 0 } }]
      });
      await req(t.base, "PUT", "/api/projects/p1", next, { "X-Origin-Id": "browser-zzz" });
      assert.ok(captured, "expected bus event");
      assert.strictEqual(captured.originId, "browser-zzz");
      assert.strictEqual(captured.op, "project_put");
      assert.ok(captured.revision);
    } finally { bus.off("change", handler); }
  } finally { await t.handle.shutdown(); }
});

test("PUT /api/projects/:pid snapshot is normalized (partial input → defaults filled)", async () => {
  const t = await startTest();
  try {
    await req(t.base, "POST", "/api/projects", { id: "p1", name: "Acme" });
    const snap = (await req(t.base, "GET", "/api/projects/p1")).data;
    // Minimal ticket — no audit/version/labels/links etc.
    const next = Object.assign({}, snap, {
      tickets: [{ id: "t-min", type: "user-story", title: "Min", status: "backlog", position: { sortOrder: 0 } }]
    });
    const r = await req(t.base, "PUT", "/api/projects/p1", next);
    assert.strictEqual(r.status, 200);
    const tk = r.data.snapshot.tickets[0];
    // normalizeTicket fills these defaults — proves snapshot ran through normalize.
    assert.ok(tk.acceptanceCriteria);
    assert.ok(tk.labels);
    assert.strictEqual(tk.isDeleted, false);
    assert.ok(typeof tk.version === "number");
  } finally { await t.handle.shutdown(); }
});

test("PUT /api/projects/:pid snapshot with mismatched project.id → 400", async () => {
  const t = await startTest();
  try {
    await req(t.base, "POST", "/api/projects", { id: "p1", name: "Acme" });
    const snap = (await req(t.base, "GET", "/api/projects/p1")).data;
    const next = Object.assign({}, snap, {
      project: Object.assign({}, snap.project, { id: "evil-id" })
    });
    const r = await req(t.base, "PUT", "/api/projects/p1", next);
    assert.strictEqual(r.status, 400);
    assert.ok(/project\.id/i.test(JSON.stringify(r.data)));
  } finally { await t.handle.shutdown(); }
});

test("PUT /api/projects/:pid without tickets/releases keys → backward-compat header merge", async () => {
  const t = await startTest();
  try {
    await req(t.base, "POST", "/api/projects", { id: "p1", name: "Acme" });
    await req(t.base, "POST", "/api/projects/p1/tickets", { type: "user-story", title: "Keep me" });
    // Header-only PUT must NOT wipe tickets.
    const r = await req(t.base, "PUT", "/api/projects/p1", { name: "Renamed Acme" });
    assert.strictEqual(r.status, 200);
    const reload = (await req(t.base, "GET", "/api/projects/p1")).data;
    assert.strictEqual(reload.project.name, "Renamed Acme");
    assert.strictEqual(reload.tickets.length, 1, "tickets must survive header-merge PUT");
    assert.strictEqual(reload.tickets[0].title, "Keep me");
  } finally { await t.handle.shutdown(); }
});

test("PUT /api/projects/:pid snapshot on unknown project → 404", async () => {
  const t = await startTest();
  try {
    const r = await req(t.base, "PUT", "/api/projects/nope", {
      project: { id: "nope", name: "X" }, tickets: [], releases: [], processSteps: []
    });
    assert.strictEqual(r.status, 404);
  } finally { await t.handle.shutdown(); }
});

// ---------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------

async function setupProjectWithDoR(t) {
  await req(t.base, "POST", "/api/projects", {
    id: "p1", name: "Acme",
    definitions: {
      ready: { global: [{ id: "g1", label: "G1", required: true }], byType: {} },
      done:  { global: [{ id: "d1", label: "D1", required: true }], byType: {} }
    }
  });
}

test("POST /api/projects/:pid/tickets creates a ticket with frozen checklists", async () => {
  const t = await startTest();
  try {
    await setupProjectWithDoR(t);
    const r = await req(t.base, "POST", "/api/projects/p1/tickets", {
      type: "user-story", title: "First story"
    });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.data.ticket.title, "First story");
    assert.strictEqual(r.data.ticket.ticketKey, "P-1");
    assert.strictEqual(r.data.ticket.definitionOfReady.items.length, 1);
    assert.strictEqual(r.data.ticket.definitionOfReady.items[0].id, "g1");
  } finally { await t.handle.shutdown(); }
});

test("PUT /api/projects/:pid/tickets/:tid updates the ticket", async () => {
  const t = await startTest();
  try {
    await setupProjectWithDoR(t);
    const c = await req(t.base, "POST", "/api/projects/p1/tickets", {
      type: "user-story", title: "A"
    });
    const tid = c.data.ticket.id;
    const r = await req(t.base, "PUT", `/api/projects/p1/tickets/${tid}`, {
      title: "A renamed"
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.ticket.title, "A renamed");
  } finally { await t.handle.shutdown(); }
});

test("POST /api/projects/:pid/tickets/:tid/status: DoR missing → 422 with missing[]", async () => {
  const t = await startTest();
  try {
    await setupProjectWithDoR(t);
    const c = await req(t.base, "POST", "/api/projects/p1/tickets", { type: "user-story", title: "A" });
    const tid = c.data.ticket.id;
    const r = await req(t.base, "POST", `/api/projects/p1/tickets/${tid}/status`, { status: "ready" });
    assert.strictEqual(r.status, 422);
    assert.strictEqual(r.data.kind, "DoR");
    assert.ok(Array.isArray(r.data.missing));
    assert.strictEqual(r.data.missing.length, 1);
    assert.strictEqual(r.data.missing[0].id, "g1");
  } finally { await t.handle.shutdown(); }
});

test("SM-237: POST status on an epic → 422 kind=EPIC_STATUS_DERIVED", async () => {
  const t = await startTest();
  try {
    await setupProjectWithDoR(t);
    const c = await req(t.base, "POST", "/api/projects/p1/tickets", { type: "epic", title: "E1" });
    const eid = c.data.ticket.id;
    const r = await req(t.base, "POST", `/api/projects/p1/tickets/${eid}/status`, { status: "in-progress" });
    assert.strictEqual(r.status, 422);
    assert.strictEqual(r.data.kind, "EPIC_STATUS_DERIVED");
  } finally { await t.handle.shutdown(); }
});

test("status transition succeeds after DoR items are checked", async () => {
  const t = await startTest();
  try {
    await setupProjectWithDoR(t);
    const c = await req(t.base, "POST", "/api/projects/p1/tickets", { type: "user-story", title: "A" });
    const tid = c.data.ticket.id;
    // Check the DoR item via dedicated endpoint
    const chk = await req(t.base, "POST", `/api/projects/p1/tickets/${tid}/dor/g1/check`);
    assert.strictEqual(chk.status, 200);
    assert.strictEqual(chk.data.ticket.definitionOfReady.items[0].checked, true);
    const r = await req(t.base, "POST", `/api/projects/p1/tickets/${tid}/status`, { status: "ready" });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.ticket.status, "ready");
  } finally { await t.handle.shutdown(); }
});

test("review → done blocked by DoD until items checked", async () => {
  const t = await startTest();
  try {
    await setupProjectWithDoR(t);
    const c = await req(t.base, "POST", "/api/projects/p1/tickets", { type: "user-story", title: "A" });
    const tid = c.data.ticket.id;
    // Bring through gates: check DoR
    await req(t.base, "POST", `/api/projects/p1/tickets/${tid}/dor/g1/check`);
    await req(t.base, "POST", `/api/projects/p1/tickets/${tid}/status`, { status: "ready" });
    await req(t.base, "POST", `/api/projects/p1/tickets/${tid}/status`, { status: "in-progress" });
    await req(t.base, "POST", `/api/projects/p1/tickets/${tid}/status`, { status: "review" });
    // → done: blocked
    let r = await req(t.base, "POST", `/api/projects/p1/tickets/${tid}/status`, { status: "done" });
    assert.strictEqual(r.status, 422);
    assert.strictEqual(r.data.kind, "DoD");
    // Check DoD item, then allow
    await req(t.base, "POST", `/api/projects/p1/tickets/${tid}/dod/d1/check`);
    r = await req(t.base, "POST", `/api/projects/p1/tickets/${tid}/status`, { status: "done" });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.ticket.status, "done");
  } finally { await t.handle.shutdown(); }
});

test("DELETE /api/projects/:pid/tickets/:tid (soft) → 204", async () => {
  const t = await startTest();
  try {
    await setupProjectWithDoR(t);
    const c = await req(t.base, "POST", "/api/projects/p1/tickets", { type: "user-story", title: "A" });
    const tid = c.data.ticket.id;
    const r = await req(t.base, "DELETE", `/api/projects/p1/tickets/${tid}`);
    assert.strictEqual(r.status, 204);
    const list = await req(t.base, "GET", "/api/projects/p1/tickets");
    assert.strictEqual(list.data.length, 0);
  } finally { await t.handle.shutdown(); }
});

// ---------------------------------------------------------------------------
// Releases + ProcessSteps
// ---------------------------------------------------------------------------

test("Releases CRUD", async () => {
  const t = await startTest();
  try {
    await req(t.base, "POST", "/api/projects", { id: "p1", name: "Acme" });
    let r = await req(t.base, "POST", "/api/projects/p1/releases", { name: "v1.0" });
    assert.strictEqual(r.status, 201);
    const rid = r.data.release.id;
    r = await req(t.base, "PUT", `/api/projects/p1/releases/${rid}`, { status: "active" });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.release.status, "active");
    r = await req(t.base, "GET", "/api/projects/p1/releases");
    assert.strictEqual(r.data.length, 2);   // SM-254: default release + the created one
    r = await req(t.base, "DELETE", `/api/projects/p1/releases/${rid}`);
    assert.strictEqual(r.status, 204);
  } finally { await t.handle.shutdown(); }
});

test("SM-255: DELETE the last release → 422 LAST_RELEASE; deleting one of two is ok", async () => {
  const t = await startTest();
  try {
    await req(t.base, "POST", "/api/projects", { id: "p1", name: "Acme" });
    // SM-254 seeded one default release.
    let rels = (await req(t.base, "GET", "/api/projects/p1/releases")).data;
    assert.strictEqual(rels.length, 1);
    let r = await req(t.base, "DELETE", `/api/projects/p1/releases/${rels[0].id}`);
    assert.strictEqual(r.status, 422, "last release is protected");
    assert.strictEqual(r.data.kind, "LAST_RELEASE");
    // Add a second, then deleting the first succeeds.
    await req(t.base, "POST", "/api/projects/p1/releases", { name: "v2" });
    r = await req(t.base, "DELETE", `/api/projects/p1/releases/${rels[0].id}`);
    assert.strictEqual(r.status, 204);
    rels = (await req(t.base, "GET", "/api/projects/p1/releases")).data;
    assert.strictEqual(rels.length, 1);
  } finally { await t.handle.shutdown(); }
});

test("ProcessSteps CRUD", async () => {
  const t = await startTest();
  try {
    await req(t.base, "POST", "/api/projects", { id: "p1", name: "Acme" });
    let r = await req(t.base, "POST", "/api/projects/p1/process-steps", { name: "Onboarding" });
    assert.strictEqual(r.status, 201);
    const sid = r.data.processStep.id;
    r = await req(t.base, "PUT", `/api/projects/p1/process-steps/${sid}`, { name: "Onboarding 2" });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.processStep.name, "Onboarding 2");
    r = await req(t.base, "GET", "/api/projects/p1/process-steps");
    assert.strictEqual(r.data.length, 2);   // SM-254: default step + the created one
    r = await req(t.base, "DELETE", `/api/projects/p1/process-steps/${sid}`);
    assert.strictEqual(r.status, 204);
  } finally { await t.handle.shutdown(); }
});

// ---------------------------------------------------------------------------
// Misc — bad JSON, origin-id, listing
// ---------------------------------------------------------------------------

test("Bad JSON body → 400", async () => {
  const t = await startTest();
  try {
    const res = await fetch(t.base + "/api/projects", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{not-json"
    });
    assert.strictEqual(res.status, 400);
  } finally { await t.handle.shutdown(); }
});

test("X-Origin-Id header is captured for write requests (bus echoes it)", async () => {
  const t = await startTest();
  try {
    const bus = require("../server/bus.js");
    let captured = null;
    const handler = (ev) => { captured = ev; };
    bus.on("change", handler);
    try {
      await req(t.base, "POST", "/api/projects", { id: "p1", name: "X" }, { "X-Origin-Id": "abc-123" });
      assert.ok(captured);
      assert.strictEqual(captured.originId, "abc-123");
    } finally { bus.off("change", handler); }
  } finally { await t.handle.shutdown(); }
});

test("GET /api/projects/:pid/tickets lists non-deleted tickets", async () => {
  const t = await startTest();
  try {
    await setupProjectWithDoR(t);
    await req(t.base, "POST", "/api/projects/p1/tickets", { type: "user-story", title: "A" });
    await req(t.base, "POST", "/api/projects/p1/tickets", { type: "bug", title: "B" });
    const list = await req(t.base, "GET", "/api/projects/p1/tickets");
    assert.strictEqual(list.data.length, 2);
  } finally { await t.handle.shutdown(); }
});

test("POST /api/projects/:pid/tickets/reorder renumbers atomically (mirror of /process-steps/reorder)", async () => {
  const t = await startTest();
  try {
    await setupProjectWithDoR(t);
    const a = (await req(t.base, "POST", "/api/projects/p1/tickets", { type: "user-story", title: "A" })).data.ticket;
    const b = (await req(t.base, "POST", "/api/projects/p1/tickets", { type: "user-story", title: "B" })).data.ticket;
    const c = (await req(t.base, "POST", "/api/projects/p1/tickets", { type: "user-story", title: "C" })).data.ticket;
    // Renumber: [C, A, B] → sortOrders 0,1,2
    const res = await req(t.base, "POST", "/api/projects/p1/tickets/reorder", {
      orderedIds: [c.id, a.id, b.id]
    });
    assert.strictEqual(res.status, 200);
    const snap = (await req(t.base, "GET", "/api/projects/p1")).data;
    const byId = new Map(snap.tickets.map(t => [t.id, t.position.sortOrder]));
    assert.strictEqual(byId.get(c.id), 0);
    assert.strictEqual(byId.get(a.id), 1);
    assert.strictEqual(byId.get(b.id), 2);
  } finally { await t.handle.shutdown(); }
});

test("POST /api/projects/:pid/tickets/reorder with scope sets releaseId/processStepId/epicId atomically", async () => {
  const t = await startTest();
  try {
    await setupProjectWithDoR(t);
    const rel = (await req(t.base, "POST", "/api/projects/p1/releases", { name: "v1" })).data.release;
    const ps  = (await req(t.base, "POST", "/api/projects/p1/process-steps", { name: "X" })).data.processStep;
    // SM-67: a story's release+processStep are inherited from its container
    // epic, so the epic must already be at the target cell before scoping
    // stories into it. (Otherwise the inheritance pulls them to the epic's
    // location, ignoring the scope values.)
    const ep = (await req(t.base, "POST", "/api/projects/p1/tickets", {
      type: "epic", title: "E",
      position: { releaseId: rel.id, processStepId: ps.id }
    })).data.ticket;
    const a = (await req(t.base, "POST", "/api/projects/p1/tickets", { type: "user-story", title: "A" })).data.ticket;
    const b = (await req(t.base, "POST", "/api/projects/p1/tickets", { type: "user-story", title: "B" })).data.ticket;
    // Place both stories under the epic via scope on reorder.
    const res = await req(t.base, "POST", "/api/projects/p1/tickets/reorder", {
      orderedIds: [a.id, b.id],
      scope: { releaseId: rel.id, processStepId: ps.id, epicId: ep.id }
    });
    assert.strictEqual(res.status, 200);
    const snap = (await req(t.base, "GET", "/api/projects/p1")).data;
    const A = snap.tickets.find(t => t.id === a.id);
    const B = snap.tickets.find(t => t.id === b.id);
    // SM-52: position.epicId is null; the containment lives on the epic's
    // contains-link list. Verify via the link instead.
    assert.strictEqual(A.position.epicId, null);
    assert.strictEqual(A.position.releaseId, rel.id);
    assert.strictEqual(A.position.processStepId, ps.id);
    assert.strictEqual(A.position.sortOrder, 0);
    assert.strictEqual(B.position.sortOrder, 1);
    const epic = snap.tickets.find(t => t.id === ep.id);
    const contained = (epic.links || []).filter(l => (l.linkTypeId || l.type) === "contains")
      .map(l => l.targetTicketId).sort();
    assert.deepStrictEqual(contained, [a.id, b.id].sort(),
      "both stories contained by epic via contains-link");
  } finally { await t.handle.shutdown(); }
});

// ---------------------------------------------------------------------------
// E13 — Revisions / History
// ---------------------------------------------------------------------------

test("GET /api/projects/:pid/revisions lists revisions in reverse-chrono", async () => {
  const t = await startTest();
  try {
    await setupProjectWithDoR(t);
    // Each create/update makes a revision.
    await req(t.base, "POST", "/api/projects/p1/tickets", { type: "user-story", title: "A" });
    await req(t.base, "POST", "/api/projects/p1/tickets", { type: "user-story", title: "B" });
    const list = (await req(t.base, "GET", "/api/projects/p1/revisions")).data;
    assert.ok(Array.isArray(list));
    assert.ok(list.length >= 3, "expected >=3 revisions, got " + list.length);
    // Each entry: { revision, savedAt, op, actor }
    for (const r of list) {
      assert.ok(typeof r.revision === "string");
      assert.ok(typeof r.savedAt === "number");
    }
    // Reverse-chrono: first entry's savedAt >= last entry's savedAt.
    assert.ok(list[0].savedAt >= list[list.length - 1].savedAt);
  } finally { await t.handle.shutdown(); }
});

test("GET /api/projects/:pid/revisions?limit=N caps the result", async () => {
  const t = await startTest();
  try {
    await setupProjectWithDoR(t);
    for (let i = 0; i < 5; i++) {
      await req(t.base, "POST", "/api/projects/p1/tickets", { type: "user-story", title: "T" + i });
    }
    const r = await req(t.base, "GET", "/api/projects/p1/revisions?limit=2");
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.length, 2);
    // SM-212: ?before= pages strictly older entries without overlap.
    const page2 = await req(t.base, "GET",
      "/api/projects/p1/revisions?limit=2&before=" + encodeURIComponent(r.data[1].revision));
    assert.strictEqual(page2.status, 200);
    assert.strictEqual(page2.data.length, 2);
    const seen = new Set(r.data.map(x => x.revision));
    for (const x of page2.data) assert.ok(!seen.has(x.revision), "pages must not overlap");
  } finally { await t.handle.shutdown(); }
});

test("GET /api/projects/:pid/revisions/:rev returns the full snapshot at that revision", async () => {
  const t = await startTest();
  try {
    await setupProjectWithDoR(t);
    await req(t.base, "POST", "/api/projects/p1/tickets", { type: "user-story", title: "X" });
    const list = (await req(t.base, "GET", "/api/projects/p1/revisions")).data;
    const rev = list[0].revision;
    const r = await req(t.base, "GET", "/api/projects/p1/revisions/" + encodeURIComponent(rev));
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.revision, rev);
    assert.ok(r.data.snapshot);
    assert.ok(Array.isArray(r.data.snapshot.tickets));
  } finally { await t.handle.shutdown(); }
});

test("GET /api/projects/:pid/revisions/:rev unknown → 404", async () => {
  const t = await startTest();
  try {
    await setupProjectWithDoR(t);
    const r = await req(t.base, "GET", "/api/projects/p1/revisions/99999999-999999-999");
    assert.strictEqual(r.status, 404);
  } finally { await t.handle.shutdown(); }
});

test("POST /api/projects/:pid/revisions/:rev/restore creates a NEW revision and reverts the snapshot", async () => {
  const t = await startTest();
  try {
    await setupProjectWithDoR(t);
    // Step 1: create ticket "Original"
    await req(t.base, "POST", "/api/projects/p1/tickets", { type: "user-story", title: "Original" });
    const beforeChange = (await req(t.base, "GET", "/api/projects/p1/revisions")).data;
    const targetRev = beforeChange[0].revision;
    // Step 2: create another ticket "Later" — this is what we want to undo via restore.
    await req(t.base, "POST", "/api/projects/p1/tickets", { type: "user-story", title: "Later" });
    let snap = (await req(t.base, "GET", "/api/projects/p1")).data;
    assert.ok(snap.tickets.some(t => t.title === "Later"), "Later should be present pre-restore");
    // Step 3: restore to before "Later" was added.
    const restored = await req(t.base, "POST",
      "/api/projects/p1/revisions/" + encodeURIComponent(targetRev) + "/restore");
    assert.strictEqual(restored.status, 200);
    // The restored snapshot must NOT contain "Later".
    const titles = restored.data.snapshot.tickets.filter(t => !t.isDeleted).map(t => t.title);
    assert.ok(!titles.includes("Later"), "restored snapshot should not contain Later");
    assert.ok(titles.includes("Original"), "restored snapshot should contain Original");
    // A NEW revision was created (the restore itself).
    const after = (await req(t.base, "GET", "/api/projects/p1/revisions")).data;
    assert.ok(after.length > beforeChange.length, "restore should create a new revision");
    assert.strictEqual(after[0].op, "project_restore", "newest revision op should be project_restore");
  } finally { await t.handle.shutdown(); }
});

// ---------------------------------------------------------------------------
// E8 — static file serving (frontend/storymap.html + /js/* + /css/*)
// ---------------------------------------------------------------------------

test("GET / serves frontend/storymap.html", async () => {
  const t = await startTest();
  try {
    const res = await fetch(t.base + "/");
    assert.strictEqual(res.status, 200);
    assert.ok((res.headers.get("content-type") || "").startsWith("text/html"));
    const text = await res.text();
    assert.ok(text.includes("<title>Story Mapper</title>"), "missing title");
    assert.ok(text.includes('src="./js/core.js"'), "should load core.js");
  } finally { await t.handle.shutdown(); }
});

test("SM-117: GET /editor serves frontend/ticket-editor.html (bookmarkable editor)", async () => {
  const t = await startTest();
  try {
    const res = await fetch(t.base + "/editor?projectId=p1&ticketId=t9");
    assert.strictEqual(res.status, 200);
    assert.ok((res.headers.get("content-type") || "").startsWith("text/html"));
    const text = await res.text();
    assert.ok(text.includes('id="editor-host"'), "editor host present");
    assert.ok(text.includes('src="./js/ticket-form.js"'), "loads the shared ticket-form module");
    assert.ok(text.includes('src="./js/renderer-ticket-editor.js"'), "loads the editor renderer");
  } finally { await t.handle.shutdown(); }
});

test("GET /js/core.js serves the UMD-wrapped module", async () => {
  const t = await startTest();
  try {
    const res = await fetch(t.base + "/js/core.js");
    assert.strictEqual(res.status, 200);
    assert.ok((res.headers.get("content-type") || "").startsWith("application/javascript"));
    const text = await res.text();
    // UMD wrapper exposes `(root.STORYMAP = root.STORYMAP || {}).core = factory();`
    assert.ok(text.includes("root.STORYMAP"), "should be UMD-wrapped");
    assert.ok(text.includes("SCHEMA_VERSION"), "should contain core exports");
  } finally { await t.handle.shutdown(); }
});

test("GET /css/storymap.css serves CSS", async () => {
  const t = await startTest();
  try {
    const res = await fetch(t.base + "/css/storymap.css");
    assert.strictEqual(res.status, 200);
    assert.ok((res.headers.get("content-type") || "").startsWith("text/css"));
  } finally { await t.handle.shutdown(); }
});

test("path-traversal attempt is refused (../package.json)", async () => {
  const t = await startTest();
  try {
    const res = await fetch(t.base + "/../package.json");
    // node normalizes the URL — depending on the fetch implementation we
    // may get 404 (handler doesn't match) but never a 200 with package.json content
    assert.notStrictEqual(res.status, 200);
  } finally { await t.handle.shutdown(); }
});

// ---------------------------------------------------------------------------
// SM-110 (A1) — typed links over REST
// ---------------------------------------------------------------------------

async function setupTwoTickets(t) {
  await req(t.base, "POST", "/api/projects", { id: "p1", name: "Acme", ticketPrefix: "P" });
  const a = await req(t.base, "POST", "/api/projects/p1/tickets", { type: "user-story", title: "A" });
  const b = await req(t.base, "POST", "/api/projects/p1/tickets", { type: "user-story", title: "B" });
  return { a: a.data.ticket.id, b: b.data.ticket.id };
}

test("SM-110: POST …/tickets/:tid/links creates a link (201) via core.ops.addLink", async () => {
  const t = await startTest();
  try {
    const { a, b } = await setupTwoTickets(t);
    const r = await req(t.base, "POST", `/api/projects/p1/tickets/${a}/links`,
      { linkTypeId: "relates-to", targetTicketId: b });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.data.link.linkTypeId, "relates-to");
    assert.strictEqual(r.data.link.targetTicketId, b);
    assert.ok(r.data.link.id, "new link carries an id");
    assert.ok(r.data.revision);
  } finally { await t.handle.shutdown(); }
});

test("SM-110: GET …/links returns forward + backward (direction param)", async () => {
  const t = await startTest();
  try {
    const { a, b } = await setupTwoTickets(t);
    await req(t.base, "POST", `/api/projects/p1/tickets/${a}/links`, { linkTypeId: "blocks", targetTicketId: b });
    const fwd = await req(t.base, "GET", `/api/projects/p1/tickets/${a}/links?direction=forward`);
    assert.strictEqual(fwd.status, 200);
    assert.strictEqual(fwd.data.links.length, 1);
    assert.strictEqual(fwd.data.links[0].direction, "forward");
    assert.strictEqual(fwd.data.links[0].target.id, b);
    // The target sees it as a backward link.
    const back = await req(t.base, "GET", `/api/projects/p1/tickets/${b}/links?direction=backward`);
    assert.strictEqual(back.data.links.length, 1);
    assert.strictEqual(back.data.links[0].direction, "backward");
    assert.strictEqual(back.data.links[0].source.id, a);
    // both = combined (b has 1 backward, 0 forward).
    const both = await req(t.base, "GET", `/api/projects/p1/tickets/${b}/links`);
    assert.strictEqual(both.data.direction, "both");
    assert.strictEqual(both.data.links.length, 1);
  } finally { await t.handle.shutdown(); }
});

test("SM-110: GET …/links with bad direction → 400", async () => {
  const t = await startTest();
  try {
    const { a } = await setupTwoTickets(t);
    const r = await req(t.base, "GET", `/api/projects/p1/tickets/${a}/links?direction=sideways`);
    assert.strictEqual(r.status, 400);
  } finally { await t.handle.shutdown(); }
});

test("SM-110: self-link → 400 kind LINK_SELF", async () => {
  const t = await startTest();
  try {
    const { a } = await setupTwoTickets(t);
    const r = await req(t.base, "POST", `/api/projects/p1/tickets/${a}/links`, { linkTypeId: "relates-to", targetTicketId: a });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.data.kind, "LINK_SELF");
  } finally { await t.handle.shutdown(); }
});

test("SM-110: missing target → 404 kind LINK_TARGET_MISSING", async () => {
  const t = await startTest();
  try {
    const { a } = await setupTwoTickets(t);
    const r = await req(t.base, "POST", `/api/projects/p1/tickets/${a}/links`, { linkTypeId: "relates-to", targetTicketId: "t-nope" });
    assert.strictEqual(r.status, 404);
    assert.strictEqual(r.data.kind, "LINK_TARGET_MISSING");
  } finally { await t.handle.shutdown(); }
});

test("SM-110: duplicate link → 409 kind LINK_DUPLICATE", async () => {
  const t = await startTest();
  try {
    const { a, b } = await setupTwoTickets(t);
    await req(t.base, "POST", `/api/projects/p1/tickets/${a}/links`, { linkTypeId: "relates-to", targetTicketId: b });
    const r = await req(t.base, "POST", `/api/projects/p1/tickets/${a}/links`, { linkTypeId: "relates-to", targetTicketId: b });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.data.kind, "LINK_DUPLICATE");
  } finally { await t.handle.shutdown(); }
});

test("SM-110: cycle in a cycle-checked semantic → 409 kind LINK_CYCLE", async () => {
  const t = await startTest();
  try {
    const { a, b } = await setupTwoTickets(t);
    // a predecessor-of b is fine; b predecessor-of a closes a cycle.
    const ok = await req(t.base, "POST", `/api/projects/p1/tickets/${a}/links`, { linkTypeId: "predecessor-of", targetTicketId: b });
    assert.strictEqual(ok.status, 201);
    const r = await req(t.base, "POST", `/api/projects/p1/tickets/${b}/links`, { linkTypeId: "predecessor-of", targetTicketId: a });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.data.kind, "LINK_CYCLE");
  } finally { await t.handle.shutdown(); }
});

test("SM-110: DELETE …/links/:linkId removes the link", async () => {
  const t = await startTest();
  try {
    const { a, b } = await setupTwoTickets(t);
    const c = await req(t.base, "POST", `/api/projects/p1/tickets/${a}/links`, { linkTypeId: "relates-to", targetTicketId: b });
    const linkId = c.data.link.id;
    const d = await req(t.base, "DELETE", `/api/projects/p1/tickets/${a}/links/${linkId}`);
    assert.strictEqual(d.status, 200);
    const after = await req(t.base, "GET", `/api/projects/p1/tickets/${a}/links?direction=forward`);
    assert.strictEqual(after.data.links.length, 0);
  } finally { await t.handle.shutdown(); }
});

test("SM-110: GET …/link-types returns the project link-type catalogue", async () => {
  const t = await startTest();
  try {
    await setupTwoTickets(t);
    const r = await req(t.base, "GET", "/api/projects/p1/link-types");
    assert.strictEqual(r.status, 200);
    assert.ok(Array.isArray(r.data.linkTypes), "linkTypes is an array");
  } finally { await t.handle.shutdown(); }
});

// ---------------------------------------------------------------------------
// SM-111 (A2) — test-definition spec (steps + prereqs) over REST
// ---------------------------------------------------------------------------

async function setupTestDef(t) {
  await req(t.base, "POST", "/api/projects", { id: "p1", name: "Acme", ticketPrefix: "P" });
  const d = await req(t.base, "POST", "/api/projects/p1/tickets", { type: "test-definition", title: "Login" });
  return d.data.ticket.id;
}

test("SM-111: REST step + prereq CRUD/reorder parity on a draft test-def", async () => {
  const t = await startTest();
  try {
    const did = await setupTestDef(t);
    // step add
    const s = await req(t.base, "POST", `/api/projects/p1/tickets/${did}/test-steps`,
      { step: "open", expectedResult: "form" });
    assert.strictEqual(s.status, 201);
    const stepId = s.data.step.id;
    // step update (subset)
    const su = await req(t.base, "PUT", `/api/projects/p1/tickets/${did}/test-steps/${stepId}`,
      { expectedResult: "login form" });
    assert.strictEqual(su.status, 200);
    assert.strictEqual(su.data.step.expectedResult, "login form");
    // second step + reorder
    const s2 = await req(t.base, "POST", `/api/projects/p1/tickets/${did}/test-steps`,
      { step: "submit", expectedResult: "ok" });
    const ro = await req(t.base, "POST", `/api/projects/p1/tickets/${did}/test-steps/reorder`,
      { orderedStepIds: [s2.data.step.id, stepId] });
    assert.strictEqual(ro.status, 200);
    assert.strictEqual(ro.data.steps[0].id, s2.data.step.id);
    // step delete
    assert.strictEqual((await req(t.base, "DELETE", `/api/projects/p1/tickets/${did}/test-steps/${stepId}`)).status, 200);
    // prereq add → update → check → uncheck → delete
    const p = await req(t.base, "POST", `/api/projects/p1/tickets/${did}/test-prereqs`, { label: "logged out" });
    assert.strictEqual(p.status, 201);
    const prId = p.data.prerequisite.id;
    const pu = await req(t.base, "PUT", `/api/projects/p1/tickets/${did}/test-prereqs/${prId}`, { label: "user logged out" });
    assert.strictEqual(pu.data.prerequisite.label, "user logged out");
    assert.strictEqual((await req(t.base, "POST", `/api/projects/p1/tickets/${did}/test-prereqs/${prId}/check`)).status, 200);
    assert.strictEqual((await req(t.base, "POST", `/api/projects/p1/tickets/${did}/test-prereqs/${prId}/uncheck`)).status, 200);
    assert.strictEqual((await req(t.base, "DELETE", `/api/projects/p1/tickets/${did}/test-prereqs/${prId}`)).status, 200);
  } finally { await t.handle.shutdown(); }
});

test("SM-111: step reorder with bad body → 400", async () => {
  const t = await startTest();
  try {
    const did = await setupTestDef(t);
    const r = await req(t.base, "POST", `/api/projects/p1/tickets/${did}/test-steps/reorder`, { nope: true });
    assert.strictEqual(r.status, 400);
  } finally { await t.handle.shutdown(); }
});

test("SM-111: published test-def — REST step add → 409 DEFINITION_FROZEN", async () => {
  const t = await startTest();
  try {
    const did = await setupTestDef(t);
    // Publish via PUT (lifecycle is in updateTicket's allow-list).
    await req(t.base, "PUT", `/api/projects/p1/tickets/${did}`, { lifecycle: "published" });
    const r = await req(t.base, "POST", `/api/projects/p1/tickets/${did}/test-steps`, { step: "x", expectedResult: "ok" });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.data.kind, "DEFINITION_FROZEN");
    // A prereq add is frozen too.
    const r2 = await req(t.base, "POST", `/api/projects/p1/tickets/${did}/test-prereqs`, { label: "x" });
    assert.strictEqual(r2.status, 409);
    assert.strictEqual(r2.data.kind, "DEFINITION_FROZEN");
  } finally { await t.handle.shutdown(); }
});

// ---------------------------------------------------------------------------
// SM-112 (A3) — test-execution over REST
// ---------------------------------------------------------------------------

async function setupPublishedDef(t) {
  await req(t.base, "POST", "/api/projects", { id: "p1", name: "Acme", ticketPrefix: "P" });
  const d = await req(t.base, "POST", "/api/projects/p1/tickets", { type: "test-definition", title: "Login" });
  const did = d.data.ticket.id;
  await req(t.base, "POST", `/api/projects/p1/tickets/${did}/test-steps`, { step: "open", expectedResult: "form" });
  await req(t.base, "PUT", `/api/projects/p1/tickets/${did}`, { lifecycle: "published" });
  return did;
}

test("SM-112: start → record → outcome auto-couples to status; history lists the run", async () => {
  const t = await startTest();
  try {
    const did = await setupPublishedDef(t);
    // start
    const s = await req(t.base, "POST", "/api/projects/p1/test-executions", { definitionId: did, env: "ci" });
    assert.strictEqual(s.status, 201);
    const exec = s.data.execution;
    assert.strictEqual(exec.type, "test-execution");
    assert.strictEqual(exec.referencedTestDefinitionId, did);
    assert.strictEqual(exec.status, "in-progress", "executions spawn in-progress");
    assert.ok(exec.executionSteps.length === 1, "steps cloned from the definition");
    const execStepId = exec.executionSteps[0].id;
    // record the only step as passed → effectiveOutcome passed + auto-couple → done
    const r = await req(t.base, "POST", `/api/projects/p1/tickets/${exec.id}/execution-steps/${execStepId}`,
      { status: "passed", actualResult: "form shown" });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.step.status, "passed");
    assert.strictEqual(r.data.effectiveOutcome, "passed");
    const reloaded = await req(t.base, "GET", `/api/projects/p1/tickets/${exec.id}`);
    assert.strictEqual(reloaded.data.status, "done", "outcome→status auto-coupling moved it to done");
    // history
    const h = await req(t.base, "GET", `/api/projects/p1/tickets/${did}/executions`);
    assert.strictEqual(h.status, 200);
    assert.strictEqual(h.data.executions.length, 1);
    assert.strictEqual(h.data.executions[0].id, exec.id);
    assert.strictEqual(h.data.executions[0].effectiveOutcome, "passed");
  } finally { await t.handle.shutdown(); }
});

test("SM-112: set_outcome override + 'auto' reset", async () => {
  const t = await startTest();
  try {
    const did = await setupPublishedDef(t);
    const exec = (await req(t.base, "POST", "/api/projects/p1/test-executions", { definitionId: did })).data.execution;
    const ov = await req(t.base, "POST", `/api/projects/p1/tickets/${exec.id}/execution-outcome`, { outcome: "failed" });
    assert.strictEqual(ov.status, 200);
    assert.strictEqual(ov.data.outcomeOverride, "failed");
    assert.strictEqual(ov.data.effectiveOutcome, "failed");
    const reset = await req(t.base, "POST", `/api/projects/p1/tickets/${exec.id}/execution-outcome`, { outcome: "auto" });
    assert.strictEqual(reset.status, 200);
    assert.ok(!reset.data.outcomeOverride, "'auto' clears the override");
  } finally { await t.handle.shutdown(); }
});

test("SM-112: start on a DRAFT definition → 422 DEFINITION_DRAFT", async () => {
  const t = await startTest();
  try {
    await req(t.base, "POST", "/api/projects", { id: "p1", name: "Acme", ticketPrefix: "P" });
    const d = await req(t.base, "POST", "/api/projects/p1/tickets", { type: "test-definition", title: "Draft" });
    const r = await req(t.base, "POST", "/api/projects/p1/test-executions", { definitionId: d.data.ticket.id });
    assert.strictEqual(r.status, 422);
    assert.strictEqual(r.data.kind, "DEFINITION_DRAFT");
  } finally { await t.handle.shutdown(); }
});

// ---------------------------------------------------------------------------
// SM-113 (A4) — project config over REST (workflow / kanban / links / governance)
// ---------------------------------------------------------------------------

test("SM-113: GET/PUT workflow round-trips; empty statuses → 400; ?type= effective", async () => {
  const t = await startTest();
  try {
    await req(t.base, "POST", "/api/projects", { id: "p1", name: "Acme", ticketPrefix: "P" });
    const g = await req(t.base, "GET", "/api/projects/p1/workflow");
    assert.strictEqual(g.status, 200);
    assert.ok(Array.isArray(g.data.statuses));
    // replace with a minimal custom workflow
    const wf = {
      statuses: [{ id: "todo", name: "Todo", category: "todo" }, { id: "shipped", name: "Shipped", category: "done" }],
      transitions: [{ id: "ship", name: "Ship", fromStatuses: ["todo"], toStatus: "shipped", allowFromAny: false }]
    };
    const p = await req(t.base, "PUT", "/api/projects/p1/workflow", wf);
    assert.strictEqual(p.status, 200);
    // SM-242: the additive migration appends a cancelled status on the way in.
    assert.deepStrictEqual(p.data.workflow.statuses.map(s => s.id), ["todo", "shipped", "cancelled"]);
    // effective workflow for a type still resolves
    const eff = await req(t.base, "GET", "/api/projects/p1/workflow?type=bug");
    assert.strictEqual(eff.status, 200);
    // empty statuses rejected
    const bad = await req(t.base, "PUT", "/api/projects/p1/workflow", { statuses: [] });
    assert.strictEqual(bad.status, 400);
  } finally { await t.handle.shutdown(); }
});

test("SM-113: GET/PUT kanban-columns round-trips (stale statusIds filtered)", async () => {
  const t = await startTest();
  try {
    await req(t.base, "POST", "/api/projects", { id: "p1", name: "Acme", ticketPrefix: "P" });
    const cols = [{ id: "c1", name: "Doing", statusIds: ["in-progress", "review", "ghost-status"] }];
    const p = await req(t.base, "PUT", "/api/projects/p1/kanban-columns", { columns: cols });
    assert.strictEqual(p.status, 200);
    const c1 = p.data.columns.find(c => c.id === "c1");
    assert.ok(c1, "column persisted");
    assert.ok(!c1.statusIds.includes("ghost-status"), "stale statusId filtered by normalize");
    const g = await req(t.base, "GET", "/api/projects/p1/kanban-columns");
    assert.ok(Array.isArray(g.data.columns));
  } finally { await t.handle.shutdown(); }
});

test("SM-113: PUT link-types replaces the catalogue", async () => {
  const t = await startTest();
  try {
    await req(t.base, "POST", "/api/projects", { id: "p1", name: "Acme", ticketPrefix: "P" });
    const lt = [{ id: "mirrors", label: "Mirrors", inverseLabel: "Mirrored by", semantic: "freeform" }];
    const p = await req(t.base, "PUT", "/api/projects/p1/link-types", { linkTypes: lt });
    assert.strictEqual(p.status, 200);
    assert.ok(p.data.linkTypes.some(x => x.id === "mirrors"));
    const g = await req(t.base, "GET", "/api/projects/p1/link-types");
    assert.ok(g.data.linkTypes.some(x => x.id === "mirrors"));
  } finally { await t.handle.shutdown(); }
});

test("SM-113: GET governance + PUT unknown predicate → 400 UNKNOWN_PREDICATE", async () => {
  const t = await startTest();
  try {
    await req(t.base, "POST", "/api/projects", { id: "p1", name: "Acme", ticketPrefix: "P" });
    const g = await req(t.base, "GET", "/api/projects/p1/governance");
    assert.strictEqual(g.status, 200);
    assert.ok(g.data.governance);
    const bad = await req(t.base, "PUT", "/api/projects/p1/governance",
      { governance: { gates: { SOME_KIND: { predicate: "not_a_real_predicate" } } } });
    assert.strictEqual(bad.status, 400);
    assert.strictEqual(bad.data.kind, "UNKNOWN_PREDICATE");
  } finally { await t.handle.shutdown(); }
});

// ---------------------------------------------------------------------------
// SM-129 — identity seam + authorization choke-point (end-to-end via REST)
// ---------------------------------------------------------------------------

const identity = require("../server/identity.js");

test("SM-129: X-Actor-* headers thread through REST into created_by", async () => {
  const t = await startTest();
  const actorHeaders = {
    "X-Actor-Type": "ai",
    "X-Actor-Id": "claude",
    "X-Actor-Name": "Claude Code",
    "X-Actor-Session": "sess-42"
  };
  try {
    await req(t.base, "POST", "/api/projects", { id: "p1", name: "Acme" }, actorHeaders);
    const c = await req(t.base, "POST", "/api/projects/p1/tickets",
      { type: "user-story", title: "Threaded" }, actorHeaders);
    assert.strictEqual(c.status, 201);
    assert.deepStrictEqual(c.data.ticket.createdBy,
      { type: "ai", id: "claude", name: "Claude Code", sessionId: "sess-42" },
      "the resolved header actor must be stamped on created_by");
  } finally { await t.handle.shutdown(); }
});

test("SM-129: anonymous REST caller (no X-Actor headers) stamps the HTTP default, not 'unknown'", async () => {
  const t = await startTest();
  try {
    await req(t.base, "POST", "/api/projects", { id: "p1", name: "Acme" });
    const c = await req(t.base, "POST", "/api/projects/p1/tickets", { type: "user-story", title: "Anon" });
    assert.strictEqual(c.status, 201);
    assert.strictEqual(c.data.ticket.createdBy.id, "http");
    assert.notStrictEqual(c.data.ticket.createdBy.id, "unknown");
  } finally { await t.handle.shutdown(); }
});

test("SM-129: a denying authorize policy makes a write fail with HTTP 403", async () => {
  const t = await startTest();
  try {
    // Project create succeeds under the default allow-all policy.
    await req(t.base, "POST", "/api/projects", { id: "p1", name: "Acme" });
    // Now deny every write and confirm the choke-point surfaces as HTTP 403.
    identity.setAuthorizePolicy(() => false);
    const r = await req(t.base, "POST", "/api/projects/p1/tickets", { type: "user-story", title: "Blocked" });
    assert.strictEqual(r.status, 403);
  } finally {
    identity.resetAuthorizePolicy();
    await t.handle.shutdown();
  }
});

// ---------------------------------------------------------------------------
// SM-183 — attachments REST (upload / list / download / delete)
// ---------------------------------------------------------------------------

test("SM-183: attachment upload → download round-trip (bytes preserved) + list + delete", async () => {
  const t = await startTest();
  try {
    await req(t.base, "POST", "/api/projects", { id: "p1", name: "P" });
    const bytes = Buffer.from("PRD-CONTENT-éç-", "utf8");
    const up = await fetch(t.base + "/api/projects/p1/attachments?ticketId=t9", {
      method: "POST",
      headers: { "Content-Type": "application/pdf", "X-Filename": encodeURIComponent("spec.pdf") },
      body: bytes
    });
    assert.strictEqual(up.status, 201);
    const aid = (await up.json()).attachment.id;
    assert.ok(aid.startsWith("att-"));

    const list = await req(t.base, "GET", "/api/projects/p1/attachments");
    assert.strictEqual(list.data.attachments.length, 1);
    assert.strictEqual(list.data.attachments[0].ticketId, "t9");
    const byTicket = await req(t.base, "GET", "/api/projects/p1/attachments?ticketId=t9");
    assert.strictEqual(byTicket.data.attachments.length, 1);

    const dl = await fetch(t.base + "/api/projects/p1/attachments/" + aid);
    assert.strictEqual(dl.status, 200);
    assert.strictEqual(dl.headers.get("content-type"), "application/pdf");
    const dlBuf = Buffer.from(await dl.arrayBuffer());
    assert.ok(dlBuf.equals(bytes), "downloaded bytes match uploaded");

    const del = await req(t.base, "DELETE", "/api/projects/p1/attachments/" + aid);
    assert.strictEqual(del.status, 204);
    const dl2 = await fetch(t.base + "/api/projects/p1/attachments/" + aid);
    assert.strictEqual(dl2.status, 404, "gone after delete");
  } finally { await t.handle.shutdown(); }
});

test("SM-194: REST ?ticketId=none lists project-level attachments only", async () => {
  const t = await startTest();
  try {
    await req(t.base, "POST", "/api/projects", { id: "p1", name: "P" });
    // one ticket-scoped, one project-level (no ?ticketId)
    await fetch(t.base + "/api/projects/p1/attachments?ticketId=t9", {
      method: "POST", headers: { "Content-Type": "text/plain", "X-Filename": "ticket.txt" }, body: Buffer.from("a")
    });
    await fetch(t.base + "/api/projects/p1/attachments", {
      method: "POST", headers: { "Content-Type": "text/plain", "X-Filename": "prd.txt" }, body: Buffer.from("b")
    });
    const all = await req(t.base, "GET", "/api/projects/p1/attachments");
    assert.strictEqual(all.data.attachments.length, 2, "unscoped lists both");
    const proj = await req(t.base, "GET", "/api/projects/p1/attachments?ticketId=none");
    assert.strictEqual(proj.data.attachments.length, 1, "none filter → project-level only");
    assert.strictEqual(proj.data.attachments[0].filename, "prd.txt");
    assert.strictEqual(proj.data.attachments[0].ticketId, null);
  } finally { await t.handle.shutdown(); }
});

test("SM-183: upload to a missing project → 404; download unknown id → 404", async () => {
  const t = await startTest();
  try {
    const up = await fetch(t.base + "/api/projects/nope/attachments", {
      method: "POST", headers: { "Content-Type": "text/plain", "X-Filename": "f.txt" }, body: Buffer.from("x")
    });
    assert.strictEqual(up.status, 404);
    const dl = await fetch(t.base + "/api/projects/nope/attachments/att-x");
    assert.strictEqual(dl.status, 404);
  } finally { await t.handle.shutdown(); }
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
// SM-154 — atomic persistChange (no lost updates on concurrent REST writes)
// ---------------------------------------------------------------------------

test("SM-154: concurrent REST ticket-creates both persist (end-to-end smoke)", async () => {
  const t = await startTest();
  try {
    await req(t.base, "POST", "/api/projects", { id: "p1", name: "Acme" });
    // End-to-end smoke: two concurrent creates both land. NOTE: this is an
    // integration smoke, not a biting regression guard — through the full HTTP
    // pipeline the two persistChange calls happen to serialize, so it passes
    // even against the pre-SM-154 non-atomic code. The *biting* guard for the
    // atomicity primitive is test-storage.js "SM-149: storage.mutate is
    // atomic", which drives concurrency directly at the storage layer; this
    // test just confirms persistChange wires through to it end-to-end.
    await Promise.all([
      req(t.base, "POST", "/api/projects/p1/tickets", { type: "user-story", title: "A" }),
      req(t.base, "POST", "/api/projects/p1/tickets", { type: "user-story", title: "B" })
    ]);
    const list = await req(t.base, "GET", "/api/projects/p1/tickets");
    const arr = Array.isArray(list.data) ? list.data : (list.data && list.data.tickets) || [];
    const titles = arr.map(x => x.title).sort();
    assert.deepStrictEqual(titles, ["A", "B"], "both concurrent creates must persist");
  } finally { await t.handle.shutdown(); }
});

// ---------------------------------------------------------------------------

module.exports.done = (test._chain || Promise.resolve()).then(() => {
  identity.resetAuthorizePolicy();
  console.log(`\n  ${passed} passed, ${failed} failed`);
});
