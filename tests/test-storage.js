"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const core = require("../server/core.js");
const Storage = require("../server/storage.js");
const bus = require("../server/bus.js");

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
  // Serialize tests so async setup/teardown doesn't interleave.
  return (test._chain = (test._chain || Promise.resolve()).then(exec));
}

async function tmpDir() {
  return await fs.promises.mkdtemp(path.join(os.tmpdir(), "storymap-test-"));
}

function sampleSnapshot(projectId) {
  return core.normalizeSnapshot({
    project: {
      id: projectId,
      name: "Sample",
      ticketPrefix: "S"
    },
    tickets: [],
    releases: [],
    processSteps: []
  });
}

const ACTOR = { type: "human", id: "u1", name: "Test" };

// ---------------------------------------------------------------------------
// Init + basic round-trip
// ---------------------------------------------------------------------------

test("storage.init creates DB file in fresh dir", async () => {
  const dir = await tmpDir();
  const s = new Storage(dir);
  await s.init();
  assert.ok(fs.existsSync(path.join(dir, "storymap.sqlite")));
  s.close();
});

test("listProjects empty after init", async () => {
  const dir = await tmpDir();
  const s = new Storage(dir); await s.init();
  const list = await s.listProjects();
  assert.deepStrictEqual(list, []);
  s.close();
});

test("loadProject returns null for missing id", async () => {
  const dir = await tmpDir();
  const s = new Storage(dir); await s.init();
  const r = await s.loadProject("p-missing");
  assert.strictEqual(r, null);
  s.close();
});

test("saveProject + loadProject round-trip", async () => {
  const dir = await tmpDir();
  const s = new Storage(dir); await s.init();
  const snap = sampleSnapshot("p1");
  const result = await s.saveProject("p1", snap, { actor: ACTOR, op: "project_create" });
  assert.ok(result.revision);
  assert.ok(typeof result.savedAt === "number");
  const loaded = await s.loadProject("p1");
  assert.strictEqual(loaded.project.id, "p1");
  assert.strictEqual(loaded.project.name, "Sample");
  s.close();
});

test("listProjects shows saved project", async () => {
  const dir = await tmpDir();
  const s = new Storage(dir); await s.init();
  await s.saveProject("p1", sampleSnapshot("p1"), { actor: ACTOR, op: "project_create" });
  await s.saveProject("p2", sampleSnapshot("p2"), { actor: ACTOR, op: "project_create" });
  const list = await s.listProjects();
  assert.deepStrictEqual(list.sort(), ["p1", "p2"]);
  s.close();
});

// ---------------------------------------------------------------------------
// Revision format + collision suffix + monotonicity
// ---------------------------------------------------------------------------

test("Revision-ID format: YYYYMMDD-HHmmss-mmm", async () => {
  const dir = await tmpDir();
  const s = new Storage(dir); await s.init();
  const r = await s.saveProject("p1", sampleSnapshot("p1"), { actor: ACTOR, op: "x" });
  assert.match(r.revision, /^\d{8}-\d{6}-\d{3}(?:-\d{4})?$/);
  s.close();
});

test("10 concurrent saves produce 10 unique revisions", async () => {
  const dir = await tmpDir();
  const s = new Storage(dir); await s.init();
  await s.saveProject("p1", sampleSnapshot("p1"), { actor: ACTOR, op: "init" });
  const promises = [];
  for (let i = 0; i < 10; i++) {
    promises.push(s.saveProject("p1", sampleSnapshot("p1"), { actor: ACTOR, op: "concurrent" }));
  }
  const results = await Promise.all(promises);
  const ids = results.map(r => r.revision);
  const unique = new Set(ids);
  assert.strictEqual(unique.size, 10, "expected 10 unique revision ids, got " + unique.size);
  s.close();
});

test("listRevisions returns reverse-chronological", async () => {
  const dir = await tmpDir();
  const s = new Storage(dir); await s.init();
  await s.saveProject("p1", sampleSnapshot("p1"), { actor: ACTOR, op: "1" });
  await new Promise(r => setTimeout(r, 5));
  await s.saveProject("p1", sampleSnapshot("p1"), { actor: ACTOR, op: "2" });
  await new Promise(r => setTimeout(r, 5));
  await s.saveProject("p1", sampleSnapshot("p1"), { actor: ACTOR, op: "3" });
  const revs = await s.listRevisions("p1");
  assert.strictEqual(revs.length, 3);
  // newest first
  for (let i = 0; i < revs.length - 1; i++) {
    assert.ok(revs[i].revision >= revs[i + 1].revision, "expected reverse chronological");
  }
  s.close();
});

test("getRevision round-trip", async () => {
  const dir = await tmpDir();
  const s = new Storage(dir); await s.init();
  const snap = sampleSnapshot("p1");
  const saved = await s.saveProject("p1", snap, { actor: ACTOR, op: "create" });
  const r = await s.getRevision("p1", saved.revision);
  assert.strictEqual(r.revision, saved.revision);
  assert.strictEqual(r.snapshot.project.name, "Sample");
});

test("restoreRevision creates a new revision (not in-place replace)", async () => {
  const dir = await tmpDir();
  const s = new Storage(dir); await s.init();
  const snap1 = sampleSnapshot("p1");
  snap1.project.name = "First";
  const r1 = await s.saveProject("p1", snap1, { actor: ACTOR, op: "create" });
  const snap2 = sampleSnapshot("p1");
  snap2.project.name = "Second";
  await s.saveProject("p1", snap2, { actor: ACTOR, op: "update" });
  // Restore old revision r1.
  const restored = await s.restoreRevision("p1", r1.revision, { actor: ACTOR });
  assert.notStrictEqual(restored.revision, r1.revision, "restore should create a NEW revision");
  const current = await s.loadProject("p1");
  assert.strictEqual(current.project.name, "First");
  const revs = await s.listRevisions("p1");
  assert.strictEqual(revs.length, 3, "expected 3 revisions: create, update, restore");
});

// ---------------------------------------------------------------------------
// Soft-Delete + remove
// ---------------------------------------------------------------------------

test("deleteProject marks deleted; listProjects skips it", async () => {
  const dir = await tmpDir();
  const s = new Storage(dir); await s.init();
  await s.saveProject("p1", sampleSnapshot("p1"), { actor: ACTOR, op: "create" });
  await s.saveProject("p2", sampleSnapshot("p2"), { actor: ACTOR, op: "create" });
  await s.deleteProject("p1", { actor: ACTOR });
  const list = await s.listProjects();
  assert.deepStrictEqual(list, ["p2"]);
  s.close();
});

test("remove deletes project + all revisions", async () => {
  const dir = await tmpDir();
  const s = new Storage(dir); await s.init();
  await s.saveProject("p1", sampleSnapshot("p1"), { actor: ACTOR, op: "create" });
  await s.saveProject("p1", sampleSnapshot("p1"), { actor: ACTOR, op: "update" });
  await s.remove("p1");
  const list = await s.listProjects();
  assert.deepStrictEqual(list, []);
  const revs = await s.listRevisions("p1");
  assert.deepStrictEqual(revs, []);
  s.close();
});

// ---------------------------------------------------------------------------
// Validation: invalid project id
// ---------------------------------------------------------------------------

test("invalid project id rejected (path traversal)", async () => {
  const dir = await tmpDir();
  const s = new Storage(dir); await s.init();
  await assert.rejects(
    () => s.saveProject("../etc/passwd", sampleSnapshot("x"), { actor: ACTOR, op: "x" })
  );
  s.close();
});

test("invalid project id rejected (empty)", async () => {
  const dir = await tmpDir();
  const s = new Storage(dir); await s.init();
  await assert.rejects(() => s.saveProject("", sampleSnapshot("x"), { actor: ACTOR, op: "x" }));
  s.close();
});

test("invalid project id rejected (too long)", async () => {
  const dir = await tmpDir();
  const s = new Storage(dir); await s.init();
  const longId = "a".repeat(200);
  await assert.rejects(() => s.saveProject(longId, sampleSnapshot("x"), { actor: ACTOR, op: "x" }));
  s.close();
});

// ---------------------------------------------------------------------------
// Bus integration
// ---------------------------------------------------------------------------

test("bus emits 'change' event on save", async () => {
  const dir = await tmpDir();
  const s = new Storage(dir); await s.init();
  let captured = null;
  const handler = (ev) => { captured = ev; };
  bus.on("change", handler);
  try {
    await s.saveProject("p1", sampleSnapshot("p1"), { actor: ACTOR, op: "project_create" });
    assert.ok(captured, "no event captured");
    assert.strictEqual(captured.projectId, "p1");
    assert.strictEqual(captured.op, "project_create");
    assert.ok(captured.revision);
    assert.ok(typeof captured.savedAt === "number");
  } finally {
    bus.off("change", handler);
    s.close();
  }
});

// ---------------------------------------------------------------------------
// SM-149 — storage integrity hardening
// ---------------------------------------------------------------------------

test("SM-149: storage.mutate is atomic — concurrent writers don't lose updates", async () => {
  const dir = await tmpDir();
  const s = new Storage(dir);
  await s.init();
  try {
    await s.saveProject("p1", sampleSnapshot("p1"), { actor: ACTOR, op: "seed" });
    const addTicket = (title) => (snap) =>
      core.ops.createTicket(snap, { type: "user-story", title }, ACTOR);
    // Fire two read-modify-write cycles concurrently. A naive
    // loadProject()+saveProject() pair would lose one (both read 0 tickets);
    // mutate() loads inside the mutex so the second sees the first's write.
    await Promise.all([
      s.mutate("p1", { actor: ACTOR, op: "a" }, addTicket("A")),
      s.mutate("p1", { actor: ACTOR, op: "b" }, addTicket("B"))
    ]);
    const snap = await s.loadProject("p1");
    const titles = snap.tickets.map(t => t.title).sort();
    assert.deepStrictEqual(titles, ["A", "B"], "both concurrent mutations must persist");
  } finally { s.close(); }
});

test("SM-149: remove() emits change only when a row was actually deleted", async () => {
  const dir = await tmpDir();
  const s = new Storage(dir);
  await s.init();
  const events = [];
  const handler = (ev) => { if (ev && ev.op === "project_remove") events.push(ev); };
  bus.on("change", handler);
  try {
    await s.remove("ghostxyz");
    assert.strictEqual(events.length, 0, "removing a non-existent project must not emit");
    await s.saveProject("p1", sampleSnapshot("p1"), { actor: ACTOR });
    await s.remove("p1");
    assert.strictEqual(events.length, 1, "removing an existing project emits exactly once");
  } finally { bus.off("change", handler); s.close(); }
});

test("SM-149: restoreRevision without an actor uses a known default, never 'unknown'", async () => {
  const dir = await tmpDir();
  const s = new Storage(dir);
  await s.init();
  try {
    const r1 = await s.saveProject("p1", sampleSnapshot("p1"), { actor: ACTOR, op: "seed" });
    await s.saveProject("p1", sampleSnapshot("p1"), { actor: ACTOR, op: "edit" });
    await s.restoreRevision("p1", r1.revision); // deliberately no opts.actor
    const revs = await s.listRevisions("p1");
    const restoreRev = revs.find(rv => rv.op === "project_restore");
    assert.ok(restoreRev, "a project_restore revision was written");
    assert.notStrictEqual(restoreRev.actor.id, "unknown", "must not freshly mint 'unknown'");
    assert.strictEqual(restoreRev.actor.id, "http", "falls back to identity DEFAULT_HTTP_ACTOR");
  } finally { s.close(); }
});

test("SM-149: revision ids stay strictly increasing across rapid same-ms saves", async () => {
  const dir = await tmpDir();
  const s = new Storage(dir);
  await s.init();
  try {
    const revs = [];
    for (let i = 0; i < 25; i++) {
      const r = await s.saveProject("p1", sampleSnapshot("p1"), { actor: ACTOR, op: "x" });
      revs.push(r.revision);
    }
    assert.strictEqual(new Set(revs).size, revs.length, "all revisions are unique");
    assert.deepStrictEqual(revs.slice().sort(), revs, "and already in strictly ascending order");
  } finally { s.close(); }
});

// ---------------------------------------------------------------------------
// SM-183 — attachments (files on disk next to the DB)
// ---------------------------------------------------------------------------

test("SM-183: addAttachment writes a file + row and returns metadata", async () => {
  const dir = await tmpDir();
  const s = new Storage(dir); await s.init();
  await s.saveProject("p1", sampleSnapshot("p1"), { actor: ACTOR, op: "create" });
  const body = Buffer.from("hello-prd");
  const meta = await s.addAttachment("p1", { ticketId: "t9", filename: "spec.pdf", mimeType: "application/pdf", buffer: body }, ACTOR);
  assert.ok(meta.id.startsWith("att-"));
  assert.strictEqual(meta.projectId, "p1");
  assert.strictEqual(meta.ticketId, "t9");
  assert.strictEqual(meta.filename, "spec.pdf");
  assert.strictEqual(meta.mimeType, "application/pdf");
  assert.strictEqual(meta.size, body.length);
  const got = await s.getAttachment(meta.id);
  assert.ok(got.absPath.includes(path.join("attachments", "p1")), "stored under attachments/<pid>");
  assert.strictEqual(fs.readFileSync(got.absPath, "utf8"), "hello-prd");
  s.close();
});

test("SM-183: listAttachments — all + filtered by ticketId", async () => {
  const dir = await tmpDir();
  const s = new Storage(dir); await s.init();
  await s.saveProject("p1", sampleSnapshot("p1"), { actor: ACTOR, op: "create" });
  await s.addAttachment("p1", { ticketId: "t1", filename: "a.txt", mimeType: "text/plain", buffer: Buffer.from("a") }, ACTOR);
  await s.addAttachment("p1", { ticketId: "t2", filename: "b.txt", mimeType: "text/plain", buffer: Buffer.from("b") }, ACTOR);
  await s.addAttachment("p1", { filename: "proj.txt", mimeType: "text/plain", buffer: Buffer.from("p") }, ACTOR);
  assert.strictEqual((await s.listAttachments("p1")).length, 3);
  const t1 = await s.listAttachments("p1", { ticketId: "t1" });
  assert.strictEqual(t1.length, 1);
  assert.strictEqual(t1[0].filename, "a.txt");
  s.close();
});

test("SM-194: listAttachments ticketId='none' returns project-level only (ticket_id IS NULL)", async () => {
  const dir = await tmpDir();
  const s = new Storage(dir); await s.init();
  await s.saveProject("p1", sampleSnapshot("p1"), { actor: ACTOR, op: "create" });
  await s.addAttachment("p1", { ticketId: "t1", filename: "a.txt", mimeType: "text/plain", buffer: Buffer.from("a") }, ACTOR);
  await s.addAttachment("p1", { filename: "prd-1.txt", mimeType: "text/plain", buffer: Buffer.from("p1") }, ACTOR);
  await s.addAttachment("p1", { ticketId: "", filename: "prd-2.txt", mimeType: "text/plain", buffer: Buffer.from("p2") }, ACTOR);
  const proj = await s.listAttachments("p1", { ticketId: "none" });
  assert.strictEqual(proj.length, 2, "only the two project-level attachments");
  assert.ok(proj.every(a => a.ticketId === null), "all project-level have null ticketId");
  const names = proj.map(a => a.filename).sort();
  assert.deepStrictEqual(names, ["prd-1.txt", "prd-2.txt"]);
  // The unscoped list still returns everything (3).
  assert.strictEqual((await s.listAttachments("p1")).length, 3);
  s.close();
});

test("SM-194: addAttachment never persists the 'none' sentinel as a literal ticket_id", async () => {
  const dir = await tmpDir();
  const s = new Storage(dir); await s.init();
  await s.saveProject("p1", sampleSnapshot("p1"), { actor: ACTOR, op: "create" });
  // Any write path (MCP/REST) that passes the LIST sentinel must be normalized
  // to null at the choke-point — otherwise the row would be orphaned.
  const meta = await s.addAttachment("p1", { ticketId: "none", filename: "prd.txt", mimeType: "text/plain", buffer: Buffer.from("p") }, ACTOR);
  assert.strictEqual(meta.ticketId, null, "'none' normalized to null on write");
  const proj = await s.listAttachments("p1", { ticketId: "none" });
  assert.strictEqual(proj.length, 1, "shows up in the project-level list (not orphaned)");
  s.close();
});

test("SM-183: removeAttachment deletes the file + row", async () => {
  const dir = await tmpDir();
  const s = new Storage(dir); await s.init();
  await s.saveProject("p1", sampleSnapshot("p1"), { actor: ACTOR, op: "create" });
  const meta = await s.addAttachment("p1", { filename: "x.txt", mimeType: "text/plain", buffer: Buffer.from("x") }, ACTOR);
  const abs = (await s.getAttachment(meta.id)).absPath;
  assert.ok(fs.existsSync(abs));
  assert.strictEqual(await s.removeAttachment(meta.id, ACTOR), true);
  assert.ok(!fs.existsSync(abs), "file deleted");
  assert.strictEqual(await s.getAttachment(meta.id), null, "row gone");
  s.close();
});

test("SM-183: addAttachment rejects over-size (413) and missing project (404)", async () => {
  const dir = await tmpDir();
  const s = new Storage(dir); await s.init();
  await s.saveProject("p1", sampleSnapshot("p1"), { actor: ACTOR, op: "create" });
  let e1 = null;
  try { await s.addAttachment("p1", { filename: "big", mimeType: "x", buffer: Buffer.alloc(26 * 1024 * 1024) }, ACTOR); }
  catch (e) { e1 = e; }
  assert.ok(e1 && e1.statusCode === 413, "over-size → 413");
  let e2 = null;
  try { await s.addAttachment("nope", { filename: "f", mimeType: "x", buffer: Buffer.from("y") }, ACTOR); }
  catch (e) { e2 = e; }
  assert.ok(e2 && e2.statusCode === 404, "missing project → 404");
  s.close();
});

test("SM-183: remove(project) deletes its attachments dir + rows cascade", async () => {
  const dir = await tmpDir();
  const s = new Storage(dir); await s.init();
  await s.saveProject("p1", sampleSnapshot("p1"), { actor: ACTOR, op: "create" });
  const meta = await s.addAttachment("p1", { filename: "x.txt", mimeType: "text/plain", buffer: Buffer.from("x") }, ACTOR);
  const projDir = path.join(dir, "attachments", "p1");
  assert.ok(fs.existsSync(projDir));
  await s.remove("p1");
  assert.ok(!fs.existsSync(projDir), "attachments dir removed");
  assert.strictEqual(await s.getAttachment(meta.id), null, "row cascaded away");
  s.close();
});

test("SM-183: many files with the SAME filename coexist (id-prefixed on-disk path; no clash)", async () => {
  const dir = await tmpDir();
  const s = new Storage(dir); await s.init();
  await s.saveProject("p1", sampleSnapshot("p1"), { actor: ACTOR, op: "create" });
  const a = await s.addAttachment("p1", { ticketId: "t1", filename: "spec.pdf", mimeType: "application/pdf", buffer: Buffer.from("first") }, ACTOR);
  const b = await s.addAttachment("p1", { ticketId: "t1", filename: "spec.pdf", mimeType: "application/pdf", buffer: Buffer.from("second") }, ACTOR);
  assert.notStrictEqual(a.id, b.id, "distinct attachment ids");
  assert.strictEqual(a.filename, "spec.pdf");
  assert.strictEqual(b.filename, "spec.pdf");   // original (display) name preserved on both
  const ga = await s.getAttachment(a.id), gb = await s.getAttachment(b.id);
  assert.notStrictEqual(ga.absPath, gb.absPath, "distinct on-disk paths despite identical filename");
  assert.strictEqual(fs.readFileSync(ga.absPath, "utf8"), "first");
  assert.strictEqual(fs.readFileSync(gb.absPath, "utf8"), "second");
  assert.strictEqual((await s.listAttachments("p1", { ticketId: "t1" })).length, 2, "both listed");
  s.close();
});

test("SM-183: a traversal filename can't escape the attachments root", async () => {
  const dir = await tmpDir();
  const s = new Storage(dir); await s.init();
  await s.saveProject("p1", sampleSnapshot("p1"), { actor: ACTOR, op: "create" });
  const meta = await s.addAttachment("p1", { filename: "../../etc/passwd", mimeType: "text/plain", buffer: Buffer.from("x") }, ACTOR);
  assert.ok(!meta.filename.includes("/") && !meta.filename.includes("\\"), "filename sanitised: no separators");
  const root = path.resolve(path.join(dir, "attachments"));
  const abs = path.resolve((await s.getAttachment(meta.id)).absPath);
  assert.ok(abs.startsWith(root + path.sep), "stored file stays under the attachments root");
  assert.ok(fs.existsSync(abs));
  s.close();
});

test("SM-183: _attachmentAbsPath rejects a tampered rel_path that escapes the root", async () => {
  const dir = await tmpDir();
  const s = new Storage(dir);   // no init needed — pure path guard
  assert.throws(() => s._attachmentAbsPath("attachments/../../../etc/passwd"), /escapes root/);
  assert.throws(() => s._attachmentAbsPath("/etc/passwd"), /escapes root/);
  s.close();
});

// ---------------------------------------------------------------------------
// SM-212 — revision retention + SQL-level listing limit
//
// One full snapshot per (debounced) save means the revisions table grows
// without bound. Retention: on every Nth save, inside the same write
// transaction, delete revisions that are BOTH older than the age threshold
// AND beyond the newest-N window. listRevisions gets a real SQL LIMIT plus
// a beforeRevision cursor instead of select-all + JS slicing.
// ---------------------------------------------------------------------------

test("SM-212: RETENTION constants block is exported", () => {
  const R = Storage.RETENTION;
  assert.ok(R, "Storage.RETENTION must be exported");
  for (const k of ["KEEP_MIN_REVISIONS_PER_PROJECT",
                   "PRUNE_EVERY_N_SAVES", "LIST_DEFAULT_LIMIT", "LIST_MAX_LIMIT"]) {
    assert.ok(typeof R[k] === "number" && R[k] > 0, "RETENTION." + k + " must be a positive number");
  }
});

test("SM-212: listRevisions honours {limit} with newest-first order", async () => {
  const dir = await tmpDir();
  const s = new Storage(dir); await s.init();
  for (let i = 0; i < 5; i++) {
    await s.saveProject("p1", sampleSnapshot("p1"), { actor: ACTOR, op: "save-" + i });
  }
  const all = await s.listRevisions("p1");
  assert.strictEqual(all.length, 5);
  const two = await s.listRevisions("p1", { limit: 2 });
  assert.strictEqual(two.length, 2);
  assert.deepStrictEqual(two.map(r => r.revision), all.slice(0, 2).map(r => r.revision),
    "limit must return the NEWEST entries");
  s.close();
});

test("SM-212: listRevisions {beforeRevision} pages without overlap", async () => {
  const dir = await tmpDir();
  const s = new Storage(dir); await s.init();
  for (let i = 0; i < 5; i++) {
    await s.saveProject("p1", sampleSnapshot("p1"), { actor: ACTOR, op: "save-" + i });
  }
  const page1 = await s.listRevisions("p1", { limit: 2 });
  const page2 = await s.listRevisions("p1", { limit: 2, beforeRevision: page1[1].revision });
  assert.strictEqual(page2.length, 2);
  const seen = new Set(page1.map(r => r.revision));
  for (const r of page2) {
    assert.ok(!seen.has(r.revision), "pages must not overlap");
    assert.ok(r.revision < page1[1].revision, "page2 entries are strictly older");
  }
  s.close();
});

test("SM-212: pruning keeps the newest N (incl. latest), restore of kept revision works", async () => {
  const dir = await tmpDir();
  const s = new Storage(dir, { retention: {
    KEEP_MIN_REVISIONS_PER_PROJECT: 3,
    PRUNE_EVERY_N_SAVES: 1          // prune on every save
  } });
  await s.init();
  for (let i = 0; i < 6; i++) {
    await s.saveProject("p1", sampleSnapshot("p1"), { actor: ACTOR, op: "save-" + i });
  }
  // Count IMMEDIATELY after the save — prune runs inside the write txn.
  const kept = await s.listRevisions("p1", { limit: 100 });
  assert.strictEqual(kept.length, 3, "only the newest 3 revisions survive");
  assert.strictEqual(kept[0].op, "save-5", "the latest revision is always kept");
  // Every kept revision is restorable.
  const restored = await s.restoreRevision("p1", kept[2].revision, { actor: ACTOR });
  assert.ok(restored.revision, "restore of a kept revision succeeds");
  const after = await s.listRevisions("p1", { limit: 100 });
  assert.strictEqual(after.length, 3, "restore-save prunes back down to the window");
  s.close();
});

test("SM-212: count cap is hard — recent revisions do NOT survive beyond the newest-N window", async () => {
  // Retention is purely count-based (no age component): only the newest N
  // survive regardless of how recent the older ones are.
  const dir = await tmpDir();
  const s = new Storage(dir, { retention: {
    KEEP_MIN_REVISIONS_PER_PROJECT: 2,
    PRUNE_EVERY_N_SAVES: 1
  } });
  await s.init();
  for (let i = 0; i < 5; i++) {
    await s.saveProject("p1", sampleSnapshot("p1"), { actor: ACTOR, op: "save-" + i });
  }
  const kept = await s.listRevisions("p1", { limit: 100 });
  assert.strictEqual(kept.length, 2, "only the newest 2 survive — recency does not protect older ones");
  assert.strictEqual(kept[0].op, "save-4", "the latest revision is always kept");
  s.close();
});

test("SM-212: default retention leaves small histories untouched", async () => {
  const dir = await tmpDir();
  const s = new Storage(dir); await s.init();
  for (let i = 0; i < 5; i++) {
    await s.saveProject("p1", sampleSnapshot("p1"), { actor: ACTOR, op: "save-" + i });
  }
  const kept = await s.listRevisions("p1", { limit: 100 });
  assert.strictEqual(kept.length, 5, "defaults are generous — nothing pruned for small histories");
  s.close();
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

module.exports.done = (test._chain || Promise.resolve()).then(() => {
  console.log(`\n  ${passed} passed, ${failed} failed`);
});
