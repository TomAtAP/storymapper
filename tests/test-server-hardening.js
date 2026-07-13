"use strict";

/**
 * SM-145 / SM-146 (S1) — server robustness regression tests.
 *
 * S1a: a static-file read stream that errors asynchronously must NOT crash
 *      the process (missing 'error' handler = unhandled → process exit).
 * S1b: 5xx responses must send a generic message, never the raw err.message
 *      (which can carry SQL fragments / dataDir paths). Explicit 4xx keep
 *      their curated message.
 *
 * (S2 server-security tests get appended here when SM-147 lands.)
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const WebSocket = require("ws");
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

async function startTest() {
  const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "storymap-harden-"));
  const handle = await startServer({ port: 0, dataDir });
  const port = handle.httpServer.address().port;
  return { handle, port, dataDir, base: `http://localhost:${port}`, wsBase: `ws://localhost:${port}` };
}

async function req(base, method, p, body, headers) {
  const init = { method, headers: Object.assign({ "Content-Type": "application/json" }, headers || {}) };
  if (body !== undefined) init.body = typeof body === "string" ? body : JSON.stringify(body);
  const res = await fetch(base + p, init);
  let data = null;
  const text = await res.text();
  if (text) { try { data = JSON.parse(text); } catch (_) { data = text; } }
  return { status: res.status, headers: res.headers, data };
}

// ---------------------------------------------------------------------------
// S1a — static-file stream error must not crash the process
// ---------------------------------------------------------------------------

test("S1a: static read-stream 'error' is handled — process survives, serves next request", async () => {
  const t = await startTest();
  const orig = fs.createReadStream;
  try {
    // Make the next createReadStream return a stream that errors async — the
    // exact shape of an EMFILE / file-vanished-after-stat failure.
    fs.createReadStream = function () {
      const { Readable } = require("stream");
      const s = new Readable({ read() {} });
      process.nextTick(() => s.emit("error", new Error("simulated EMFILE")));
      return s;
    };
    let status = null;
    try {
      const r = await req(t.base, "GET", "/storymap.html");
      status = r.status; // handled → 500 (headers not yet flushed)
    } catch (_) {
      status = "socket-error"; // also acceptable: socket torn down
    }
    assert.ok(status === 500 || status === "socket-error",
      "errored stream should yield 500 or a closed socket, got " + status);

    // The decisive assertion: the server process is still alive and serving.
    fs.createReadStream = orig;
    const ok = await req(t.base, "GET", "/api/health");
    assert.strictEqual(ok.status, 200, "server must still serve after a stream error");
  } finally {
    fs.createReadStream = orig;
    await t.handle.shutdown();
  }
});

// ---------------------------------------------------------------------------
// S1b — 5xx generic message; 4xx keeps curated message
// ---------------------------------------------------------------------------

test("S1b: statusless internal error → 500 with generic message (no leak)", async () => {
  const t = await startTest();
  const orig = t.handle.storage.loadProject;
  try {
    const SECRET = "SECRET-SQL-near-/private/var/dataDir/storymap.sqlite";
    t.handle.storage.loadProject = function () { throw new Error(SECRET); };
    const r = await req(t.base, "GET", "/api/projects/anything");
    assert.strictEqual(r.status, 500);
    assert.strictEqual(r.data.error, "internal error", "5xx must be generic");
    assert.ok(!String(r.data.error).includes("SECRET"), "must not leak err.message");
  } finally {
    t.handle.storage.loadProject = orig;
    await t.handle.shutdown();
  }
});

test("S1b: explicit 4xx still carries its curated message", async () => {
  const t = await startTest();
  try {
    const r = await req(t.base, "GET", "/api/projects/does-not-exist");
    assert.strictEqual(r.status, 404);
    assert.ok(/not found/i.test(r.data.error), "4xx message stays visible, got: " + r.data.error);
  } finally { await t.handle.shutdown(); }
});

// ---------------------------------------------------------------------------
// S2 (SM-147) — WS origin allowlist + internal-endpoint gating
// ---------------------------------------------------------------------------

// Resolves "opened" if the upgrade succeeds, "rejected" if it errors/closes
// before opening.
function wsOutcome(wsBase, opts) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); try { ws.close(); } catch (_) {} } };
    const ws = new WebSocket(wsBase + "/ws", opts);
    ws.on("open", () => done("opened"));
    ws.on("error", () => done("rejected"));
    ws.on("close", () => done("rejected"));
    setTimeout(() => done("timeout"), 2000);
  });
}

test("S2: WS upgrade rejects a cross-site Origin", async () => {
  const t = await startTest();
  try {
    const outcome = await wsOutcome(t.wsBase, { origin: "http://evil.example" });
    assert.strictEqual(outcome, "rejected", "foreign-origin WS must not connect");
  } finally { await t.handle.shutdown(); }
});

test("S2: WS upgrade accepts header-less (non-browser) client", async () => {
  const t = await startTest();
  try {
    const outcome = await wsOutcome(t.wsBase, {});
    assert.strictEqual(outcome, "opened", "no-Origin client (MCP/ws-lib) must connect");
  } finally { await t.handle.shutdown(); }
});

test("S2: WS upgrade accepts a loopback Origin", async () => {
  const t = await startTest();
  try {
    const outcome = await wsOutcome(t.wsBase, { origin: t.base }); // http://localhost:<port>
    assert.strictEqual(outcome, "opened", "the app's own loopback origin must connect");
  } finally { await t.handle.shutdown(); }
});

test("S2: /api/internal/* rejects a cross-site Origin (403)", async () => {
  const t = await startTest();
  try {
    const r = await req(t.base, "POST", "/api/internal/notify-change",
      { projectId: "p1" }, { Origin: "http://evil.example" });
    assert.strictEqual(r.status, 403);
  } finally { await t.handle.shutdown(); }
});

test("S2: /api/internal/* accepts header-less loopback caller (MCP)", async () => {
  const t = await startTest();
  try {
    const r = await req(t.base, "POST", "/api/internal/notify-change", { projectId: "p1" });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.ok, true);
  } finally { await t.handle.shutdown(); }
});

// ---------------------------------------------------------------------------
// S3 (SM-211) — CORS lockdown + security headers
//
// The server is a local single-user tool WITHOUT auth. With the old
// `Access-Control-Allow-Origin: *` any website the user visits could read and
// write every project via fetch. New contract:
//   - no Origin header (MCP / curl / tests)  → request works, no ACAO needed
//   - loopback Origin                        → reflected + `Vary: Origin`
//   - foreign Origin (incl. "null")          → no ACAO, mutating methods 403
//   - every response carries X-Content-Type-Options: nosniff
//   - served HTML carries a Content-Security-Policy
// ---------------------------------------------------------------------------

test("S3: no-Origin caller works and gets no ACAO header", async () => {
  const t = await startTest();
  try {
    const r = await req(t.base, "GET", "/api/health");
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers.get("access-control-allow-origin"), null,
      "no Origin → no ACAO header needed");
  } finally { await t.handle.shutdown(); }
});

test("S3: loopback Origin is reflected (not *) and Vary: Origin is set", async () => {
  const t = await startTest();
  try {
    const r = await req(t.base, "GET", "/api/health", undefined, { Origin: t.base });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers.get("access-control-allow-origin"), t.base,
      "loopback origin must be reflected verbatim");
    assert.ok(/origin/i.test(r.headers.get("vary") || ""), "Vary: Origin must be set");
  } finally { await t.handle.shutdown(); }
});

test("S3: foreign Origin gets NO ACAO on GET", async () => {
  const t = await startTest();
  try {
    const r = await req(t.base, "GET", "/api/health", undefined, { Origin: "http://evil.example" });
    assert.strictEqual(r.headers.get("access-control-allow-origin"), null,
      "foreign origin must never receive an ACAO header");
  } finally { await t.handle.shutdown(); }
});

test("S3: foreign Origin mutating request → 403, nothing persisted", async () => {
  const t = await startTest();
  try {
    const r = await req(t.base, "POST", "/api/projects",
      { id: "evil-proj", name: "Evil" }, { Origin: "http://evil.example" });
    assert.strictEqual(r.status, 403);
    const list = await req(t.base, "GET", "/api/projects");
    const ids = (list.data.projects || list.data || []);
    assert.ok(!JSON.stringify(ids).includes("evil-proj"), "foreign write must not persist");
  } finally { await t.handle.shutdown(); }
});

test("S3: Origin null (file:// / sandboxed iframe) is foreign — no ACAO, POST 403", async () => {
  const t = await startTest();
  try {
    const g = await req(t.base, "GET", "/api/health", undefined, { Origin: "null" });
    assert.strictEqual(g.headers.get("access-control-allow-origin"), null);
    const p = await req(t.base, "POST", "/api/projects",
      { id: "null-proj", name: "Null" }, { Origin: "null" });
    assert.strictEqual(p.status, 403);
  } finally { await t.handle.shutdown(); }
});

test("S3: loopback POST still works (the app's own flow)", async () => {
  const t = await startTest();
  try {
    const r = await req(t.base, "POST", "/api/projects",
      { id: "own-proj", name: "Own" }, { Origin: t.base });
    assert.strictEqual(r.status, 201);
  } finally { await t.handle.shutdown(); }
});

test("S3: preflight from loopback lists actor + auth headers", async () => {
  const t = await startTest();
  try {
    const r = await req(t.base, "OPTIONS", "/api/projects", undefined, { Origin: t.base });
    assert.strictEqual(r.status, 204);
    assert.strictEqual(r.headers.get("access-control-allow-origin"), t.base);
    const allowed = (r.headers.get("access-control-allow-headers") || "").toLowerCase();
    for (const h of ["content-type", "x-origin-id", "x-actor-id", "x-actor-type", "x-actor-name", "x-actor-session", "authorization"]) {
      assert.ok(allowed.includes(h), "preflight must allow header " + h + ", got: " + allowed);
    }
  } finally { await t.handle.shutdown(); }
});

test("S3: preflight from foreign origin carries no ACAO", async () => {
  const t = await startTest();
  try {
    const r = await req(t.base, "OPTIONS", "/api/projects", undefined, { Origin: "http://evil.example" });
    assert.strictEqual(r.headers.get("access-control-allow-origin"), null);
  } finally { await t.handle.shutdown(); }
});

test("S3: every response carries X-Content-Type-Options: nosniff", async () => {
  const t = await startTest();
  try {
    const api = await req(t.base, "GET", "/api/health");
    assert.strictEqual(api.headers.get("x-content-type-options"), "nosniff", "API response");
    const html = await req(t.base, "GET", "/");
    assert.strictEqual(html.headers.get("x-content-type-options"), "nosniff", "static response");
  } finally { await t.handle.shutdown(); }
});

test("S3: served HTML carries a CSP; JS/CSS do not need one", async () => {
  const t = await startTest();
  try {
    const html = await req(t.base, "GET", "/");
    const csp = html.headers.get("content-security-policy") || "";
    assert.ok(csp.includes("default-src 'self'"), "CSP must pin default-src, got: " + csp);
    assert.ok(csp.includes("fonts.googleapis.com"), "CSP must allow the Google-Fonts stylesheet");
    assert.ok(csp.includes("connect-src"), "CSP must carry connect-src for ?api= cross-port mode");
    // Review remediation: the auth-less UI must not be frameable by foreign
    // sites (clickjacking) — frame-ancestors + X-Frame-Options for old engines.
    assert.ok(csp.includes("frame-ancestors 'self'"), "CSP must pin frame-ancestors, got: " + csp);
    assert.strictEqual(html.headers.get("x-frame-options"), "SAMEORIGIN");
    const js = await req(t.base, "GET", "/js/main.js");
    assert.strictEqual(js.status, 200);
  } finally { await t.handle.shutdown(); }
});

// ---------------------------------------------------------------------------
// S4 (SM-213) — small server hardenings bundle
//   (a) switch-response cache: bounded + sweeps expired entries on insert
//   (b) static-file jail dereferences symlinks (but the legit SM-139
//       frontend/js/core.js → shared/core.js symlink keeps serving)
//   (c) readJsonBody drops __proto__/constructor/prototype keys
//   (d) oversized JSON body → 413 and the server stays alive
// ---------------------------------------------------------------------------

const serverMod = require("../server/server.js");

test("S4a: switch-response cache is bounded and sweeps expired entries", () => {
  const { SWITCH_CACHE, _switchCacheHooks: hooks } = serverMod;
  assert.ok(SWITCH_CACHE && SWITCH_CACHE.MAX_ENTRIES > 0, "SWITCH_CACHE constants exported");
  assert.ok(hooks && hooks.map, "test hooks exported");
  hooks.map.clear();
  // (1) bound: inserting more than MAX_ENTRIES never grows past the cap.
  for (let i = 0; i < SWITCH_CACHE.MAX_ENTRIES + 25; i++) {
    hooks.cacheSwitchResponse("req-" + i, true);
  }
  assert.ok(hooks.map.size <= SWITCH_CACHE.MAX_ENTRIES,
    "cache size " + hooks.map.size + " must stay <= " + SWITCH_CACHE.MAX_ENTRIES);
  // (2) sweep: an already-expired entry disappears on the next insert.
  hooks.map.clear();
  hooks.cacheSwitchResponse("req-expired", true, -1);   // ttl in the past
  hooks.cacheSwitchResponse("req-fresh", true);
  assert.ok(!hooks.map.has("req-expired"), "expired entry must be swept on insert");
  assert.strictEqual(hooks.consumeSwitchResponse("req-expired"), null);
  assert.deepStrictEqual(hooks.consumeSwitchResponse("req-fresh"), { accepted: true });
  hooks.map.clear();
});

test("S4b: a symlink under frontend/ cannot escape the jail; /js/core.js keeps serving", async () => {
  const t = await startTest();
  const frontendDir = path.resolve(__dirname, "..", "frontend");
  const secret = path.join(os.tmpdir(), "sm213-secret-" + process.pid + ".txt");
  const linkPath = path.join(frontendDir, ".sm213-escape.txt");
  try {
    await fs.promises.writeFile(secret, "TOP-SECRET");
    try { await fs.promises.unlink(linkPath); } catch (_) {}
    await fs.promises.symlink(secret, linkPath);
    const leak = await req(t.base, "GET", "/.sm213-escape.txt");
    assert.strictEqual(leak.status, 404, "symlink escaping the frontend jail must 404");
    assert.ok(!String(leak.data).includes("TOP-SECRET"), "secret content must not leak");
    // REGRESSION (SM-139): frontend/js/core.js is a LEGIT symlink → ../../shared/core.js.
    // The realpath check must whitelist the repo-internal shared/ target.
    const core = await req(t.base, "GET", "/js/core.js");
    assert.strictEqual(core.status, 200, "the legit shared-core symlink must keep serving");
    const graph = await req(t.base, "GET", "/js/core/graph.js");
    assert.strictEqual(graph.status, 200, "the legit shared graph symlink must keep serving");
  } finally {
    try { await fs.promises.unlink(linkPath); } catch (_) {}
    try { await fs.promises.unlink(secret); } catch (_) {}
    await t.handle.shutdown();
  }
});

test("S4c: __proto__ / constructor / prototype keys in a JSON body do not pollute", async () => {
  const t = await startTest();
  try {
    // The test server runs IN-PROCESS — real pollution would be visible here.
    const body = '{"id":"pp1","name":"P","__proto__":{"polluted":"yes"},' +
                 '"constructor":{"prototype":{"polluted2":"yes"}}}';
    const r = await req(t.base, "POST", "/api/projects", body);
    assert.strictEqual(r.status, 201, "request with stripped keys still succeeds");
    assert.strictEqual(({}).polluted, undefined, "Object.prototype must not be polluted");
    assert.strictEqual(({}).polluted2, undefined, "nested constructor.prototype must be stripped");
  } finally { await t.handle.shutdown(); }
});

test("S4d: oversized JSON body → 413 (or torn socket) and the server stays alive", async () => {
  const t = await startTest();
  try {
    const big = '{"id":"big","name":"' + "x".repeat(5 * 1024 * 1024 + 1024) + '"}';
    let outcome;
    try {
      const r = await req(t.base, "POST", "/api/projects", big);
      outcome = r.status;
    } catch (_) {
      outcome = "socket-error";   // server may destroy the socket mid-upload
    }
    assert.ok(outcome === 413 || outcome === "socket-error",
      "oversized body must yield 413 or a torn socket, got " + outcome);
    const ok = await req(t.base, "GET", "/api/health");
    assert.strictEqual(ok.status, 200, "server must still serve after the oversized body");
  } finally { await t.handle.shutdown(); }
});

module.exports.done = (test._chain || Promise.resolve()).then(() => {
  console.log(`\n  ${passed} passed, ${failed} failed`);
});
