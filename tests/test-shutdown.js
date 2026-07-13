"use strict";

/**
 * Shutdown-Regression-Net (portiert von cmapper/tests/test-shutdown.js).
 *
 * Spawnt einen echten Server-Subprocess, baut einen WebSocket-Client auf
 * und sendet dann SIGINT. Erwartet:
 *  - Prozess beendet sich in < 2 s (Force-Timer-Fallback).
 *  - Exit-Code 0 bei erfolgreichem Shutdown.
 *  - Zweites SIGINT während Shutdown → sofortiger Exit (Code 130).
 *
 * Diese Klasse von Bugs ("Ctrl-C hängt") lässt sich nicht aus Modul-Tests
 * herausholen — sie braucht den echten Prozess + echten Signal-Pfad +
 * echte aktive Sockets.
 */

const { spawn } = require("child_process");
const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const WebSocket = require("ws");
const assert = require("assert");

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
  return await fs.mkdtemp(path.join(os.tmpdir(), "storymap-shutdown-"));
}

async function spawnServer(port, dataDir) {
  const indexPath = path.resolve(__dirname, "..", "server", "index.js");
  const child = spawn(process.execPath, [indexPath, "server", `--port=${port}`, `--data-dir=${dataDir}`], {
    stdio: ["pipe", "pipe", "pipe"]
  });
  // Wait for "listening" line on stderr.
  await new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => {
      child.stderr.off("data", onData);
      reject(new Error("server did not say 'listening' within 3s"));
    }, 3000);
    const onData = (chunk) => {
      buf += chunk.toString();
      if (buf.includes("listening")) {
        clearTimeout(timer);
        child.stderr.off("data", onData);
        resolve();
      }
    };
    child.stderr.on("data", onData);
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error("server exited prematurely with code " + code));
    });
  });
  return child;
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const net = require("net");
    const s = net.createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

function waitExit(child) {
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

// ---------------------------------------------------------------------------

test("SIGINT shuts down a server with no active connections in < 2s", async () => {
  const port = await findFreePort();
  const dir = await tmpDir();
  const child = await spawnServer(port, dir);
  const start = Date.now();
  child.kill("SIGINT");
  const exit = await Promise.race([
    waitExit(child),
    new Promise(r => setTimeout(() => r({ code: "TIMEOUT" }), 2500))
  ]);
  const elapsed = Date.now() - start;
  if (exit.code === "TIMEOUT") { try { child.kill("SIGKILL"); } catch {} }
  assert.notStrictEqual(exit.code, "TIMEOUT", "server did not exit within 2.5s of SIGINT");
  assert.strictEqual(exit.code, 0, "expected clean exit, got code " + exit.code);
  assert.ok(elapsed < 2000, "shutdown took too long: " + elapsed + "ms");
});

test("SIGINT shuts down a server with an active WebSocket client in < 2s", async () => {
  const port = await findFreePort();
  const dir = await tmpDir();
  const child = await spawnServer(port, dir);
  // Open a WS client + subscribe.
  const ws = new WebSocket(`ws://localhost:${port}/ws`);
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  ws.send(JSON.stringify({ type: "subscribe", projectId: "p1" }));
  await new Promise(r => setTimeout(r, 50));
  const start = Date.now();
  child.kill("SIGINT");
  const exit = await Promise.race([
    waitExit(child),
    new Promise(r => setTimeout(() => r({ code: "TIMEOUT" }), 2500))
  ]);
  const elapsed = Date.now() - start;
  try { ws.close(); } catch (_) {}
  if (exit.code === "TIMEOUT") { try { child.kill("SIGKILL"); } catch {} }
  assert.notStrictEqual(exit.code, "TIMEOUT", "server hung with active WS client");
  assert.strictEqual(exit.code, 0);
  assert.ok(elapsed < 2000, "shutdown with WS took too long: " + elapsed + "ms");
});

test("SIGTERM cleanly stops the server", async () => {
  const port = await findFreePort();
  const dir = await tmpDir();
  const child = await spawnServer(port, dir);
  // Give the SIGTERM handler one event-loop turn to attach inside the child.
  // (Without this, fast spawn + kill can race and the default handler fires.)
  await new Promise(r => setTimeout(r, 50));
  child.kill("SIGTERM");
  const exit = await Promise.race([
    waitExit(child),
    new Promise(r => setTimeout(() => r({ code: "TIMEOUT" }), 2500))
  ]);
  if (exit.code === "TIMEOUT") { try { child.kill("SIGKILL"); } catch {} }
  assert.notStrictEqual(exit.code, "TIMEOUT", "server did not stop after SIGTERM");
  // Accept either process.exit(0) (code=0,signal=null) or signal-termination
  // (code=null, signal='SIGTERM'). Both are graceful exits — what we don't
  // want is a hang.
  const okClean   = exit.code === 0;
  const okSignal  = exit.signal === "SIGTERM" || exit.signal === "SIGINT";
  assert.ok(okClean || okSignal, "expected clean exit, got code=" + exit.code + " signal=" + exit.signal);
});

test("Shutdown is logged to stderr (label + signal)", async () => {
  // We spawn the child WITHOUT spawnServer so we can attach the stderr
  // listener BEFORE the 'listening' marker arrives — otherwise the
  // shutdown log might race past the buffer.
  const port = await findFreePort();
  const dir = await tmpDir();
  const indexPath = path.resolve(__dirname, "..", "server", "index.js");
  const child = require("child_process").spawn(process.execPath,
    [indexPath, "server", `--port=${port}`, `--data-dir=${dir}`],
    { stdio: ["pipe", "pipe", "pipe"] });
  let stderrAll = "";
  child.stderr.on("data", (c) => { stderrAll += c.toString(); });
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("no listening within 3s")), 3000);
    const checker = setInterval(() => {
      if (stderrAll.includes("listening")) { clearTimeout(t); clearInterval(checker); res(); }
    }, 20);
  });
  child.kill("SIGINT");
  await Promise.race([waitExit(child), new Promise(r => setTimeout(r, 2500))]);
  assert.ok(stderrAll.includes("SIGINT received"), "missing 'SIGINT received' log; got: " + stderrAll);
  assert.ok(/\[storymap\]/.test(stderrAll), "missing label '[storymap]' in log");
});

// ---------------------------------------------------------------------------
// SM-213 — process-level error handlers: a stray unhandledRejection /
// uncaughtException must log to stderr and run the graceful-shutdown path
// (exit code 1), not vanish or hang. installShutdown is exported for this;
// requiring index.js must NOT auto-start the CLI (require.main guard).
// ---------------------------------------------------------------------------

test("SM-213: unhandledRejection logs the cause and exits 1 via the shutdown path", async () => {
  const indexPath = path.resolve(__dirname, "..", "server", "index.js");
  const script = [
    `const { installShutdown } = require(${JSON.stringify(indexPath)});`,
    `installShutdown("crash-test", async () => { process.stderr.write("[crash-test] cleanup ran\\n"); });`,
    `Promise.reject(new Error("boom-SM213"));`,
    `setTimeout(() => {}, 5000);`   // keep the loop alive; the handler must exit first
  ].join("\n");
  const child = spawn(process.execPath, ["-e", script], { stdio: ["pipe", "pipe", "pipe"] });
  let err = "";
  child.stderr.on("data", (c) => { err += c.toString(); });
  const code = await Promise.race([
    new Promise((res) => child.on("exit", res)),
    new Promise((res) => setTimeout(() => { child.kill("SIGKILL"); res("timeout"); }, 4000))
  ]);
  assert.strictEqual(code, 1, "unhandledRejection must exit 1, got " + code + "; stderr: " + err);
  assert.ok(err.includes("unhandledRejection"), "stderr names the cause; got: " + err);
  assert.ok(err.includes("boom-SM213"), "stderr carries the error message");
  assert.ok(err.includes("cleanup ran"), "graceful shutdown callback ran");
});

test("SM-213: uncaughtException logs the cause and exits 1 via the shutdown path", async () => {
  const indexPath = path.resolve(__dirname, "..", "server", "index.js");
  const script = [
    `const { installShutdown } = require(${JSON.stringify(indexPath)});`,
    `installShutdown("crash-test", async () => { process.stderr.write("[crash-test] cleanup ran\\n"); });`,
    `setTimeout(() => { throw new Error("kaboom-SM213"); }, 10);`,
    `setTimeout(() => {}, 5000);`
  ].join("\n");
  const child = spawn(process.execPath, ["-e", script], { stdio: ["pipe", "pipe", "pipe"] });
  let err = "";
  child.stderr.on("data", (c) => { err += c.toString(); });
  const code = await Promise.race([
    new Promise((res) => child.on("exit", res)),
    new Promise((res) => setTimeout(() => { child.kill("SIGKILL"); res("timeout"); }, 4000))
  ]);
  assert.strictEqual(code, 1, "uncaughtException must exit 1, got " + code + "; stderr: " + err);
  assert.ok(err.includes("uncaughtException"), "stderr names the cause; got: " + err);
  assert.ok(err.includes("kaboom-SM213"), "stderr carries the error message");
  assert.ok(err.includes("cleanup ran"), "graceful shutdown callback ran");
});

// ---------------------------------------------------------------------------
// SM-215 — same-data-dir server guard. A second `storymap server` on the same
// --data-dir would split-brain the WS sync and collide revision ids (the
// minter is process-local). Lock file with PID, SERVER-MODE ONLY — the
// concurrent server+mcp combo on one data dir is a documented workflow
// (E20.E / mcp-walkthrough) and must stay possible.
// ---------------------------------------------------------------------------

const LOCK_FILENAME = "storymap-server.lock";

async function findFreePort2() {
  const net = require("net");
  return await new Promise((res) => {
    const srv = net.createServer();
    srv.listen(0, () => { const p = srv.address().port; srv.close(() => res(p)); });
  });
}

test("SM-215: a second server on the same data-dir refuses loudly; --force overrides", async () => {
  const dir = await tmpDir();
  const portA = await findFreePort2();
  const a = await spawnServer(portA, dir);
  try {
    assert.ok(require("fs").existsSync(path.join(dir, LOCK_FILENAME)), "first server writes the lock");
    // Second server, same dir → must exit non-zero with a clear message.
    const indexPath = path.resolve(__dirname, "..", "server", "index.js");
    const portB = await findFreePort2();
    const b = spawn(process.execPath, [indexPath, "server", `--port=${portB}`, `--data-dir=${dir}`],
      { stdio: ["pipe", "pipe", "pipe"] });
    let bErr = "";
    b.stderr.on("data", (c) => { bErr += c.toString(); });
    const bCode = await Promise.race([
      new Promise((res) => b.on("exit", res)),
      new Promise((res) => setTimeout(() => { b.kill("SIGKILL"); res("timeout"); }, 4000))
    ]);
    assert.notStrictEqual(bCode, 0, "second server must refuse (non-zero exit), got " + bCode);
    assert.ok(/already running|lock/i.test(bErr), "refusal message names the lock; got: " + bErr);
    // --force overrides (the user knows better, e.g. after a crashed container).
    const portC = await findFreePort2();
    const c = spawn(process.execPath, [indexPath, "server", `--port=${portC}`, `--data-dir=${dir}`, "--force"],
      { stdio: ["pipe", "pipe", "pipe"] });
    let cErr = "";
    c.stderr.on("data", (chunk) => { cErr += chunk.toString(); });
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("--force server did not start: " + cErr)), 4000);
      const iv = setInterval(() => {
        if (cErr.includes("listening")) { clearTimeout(t); clearInterval(iv); res(); }
      }, 20);
    });
    c.kill("SIGTERM");
    await new Promise((res) => c.on("exit", res));
  } finally {
    a.kill("SIGKILL");
    await new Promise((res) => a.on("exit", res));
  }
});

test("SM-215: a stale lock (dead PID) is replaced; shutdown removes the lock", async () => {
  const fsSync = require("fs");
  const dir = await tmpDir();
  // Plant a stale lock with a guaranteed-dead PID: spawn a child, let it
  // exit, use ITS pid (a literal like 999999 could be live on Linux pid_max).
  const dead = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((res) => dead.on("exit", res));
  fsSync.writeFileSync(path.join(dir, LOCK_FILENAME), String(dead.pid));
  const port = await findFreePort2();
  const child = await spawnServer(port, dir);   // must start despite the stale lock
  const lockPid = fsSync.readFileSync(path.join(dir, LOCK_FILENAME), "utf8").trim();
  assert.strictEqual(lockPid, String(child.pid), "stale lock replaced with the live PID");
  child.kill("SIGINT");
  await new Promise((res) => child.on("exit", res));
  assert.ok(!fsSync.existsSync(path.join(dir, LOCK_FILENAME)), "graceful shutdown removes the lock");
});

test("SM-215: MCP mode takes NO lock — server+mcp on one data-dir stays possible", async () => {
  const fsSync = require("fs");
  const dir = await tmpDir();
  const indexPath = path.resolve(__dirname, "..", "server", "index.js");
  const child = spawn(process.execPath, [indexPath, "mcp", `--data-dir=${dir}`],
    { stdio: ["pipe", "pipe", "pipe"] });
  let err = "";
  child.stderr.on("data", (c) => { err += c.toString(); });
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("mcp did not start: " + err)), 4000);
    const iv = setInterval(() => {
      if (err.includes("listening")) { clearTimeout(t); clearInterval(iv); res(); }
    }, 20);
  });
  assert.ok(!fsSync.existsSync(path.join(dir, LOCK_FILENAME)), "mcp-mode must not write the server lock");
  child.stdin.end();   // stdin EOF = mcp shutdown
  await Promise.race([
    new Promise((res) => child.on("exit", res)),
    new Promise((res) => setTimeout(() => { child.kill("SIGKILL"); res(); }, 3000))
  ]);
});

// --- Non-loopback bind guard (security) -------------------------------------

test("isLoopbackHost: loopback hosts are recognized", () => {
  const { isLoopbackHost } = require("../server/index.js");
  for (const h of [undefined, "", "localhost", "LOCALHOST", "127.0.0.1", "127.1.2.3", "::1", "[::1]"]) {
    assert.ok(isLoopbackHost(h), `expected loopback: ${JSON.stringify(h)}`);
  }
});

test("isLoopbackHost: exposed / all-interface hosts are NOT loopback", () => {
  const { isLoopbackHost } = require("../server/index.js");
  for (const h of ["0.0.0.0", "::", "192.0.2.1", "10.0.0.5", "example.com"]) {
    assert.ok(!isLoopbackHost(h), `expected non-loopback: ${JSON.stringify(h)}`);
  }
});

test("server refuses a non-loopback bind without --allow-remote (exit 4)", async () => {
  const dir = await tmpDir();
  const port = await findFreePort();
  const indexPath = path.resolve(__dirname, "..", "server", "index.js");
  // 192.0.2.1 is TEST-NET-1 (RFC 5737) — non-loopback; the guard refuses
  // BEFORE any bind is attempted, so no real socket is opened.
  const child = spawn(process.execPath,
    [indexPath, "server", `--port=${port}`, `--data-dir=${dir}`, "--host=192.0.2.1"],
    { stdio: ["pipe", "pipe", "pipe"] });
  let err = "";
  child.stderr.on("data", (c) => { err += c.toString(); });
  const { REMOTE_BIND } = require("../server/index.js");
  const code = await new Promise((res) => child.on("exit", res));
  assert.strictEqual(code, REMOTE_BIND.EXIT_CODE, "exits with the remote-bind refusal code");
  assert.ok(/refusing to bind to non-loopback/.test(err), "prints the refusal reason");
  assert.ok(!require("fs").existsSync(path.join(dir, LOCK_FILENAME)),
    "must NOT acquire the server lock when refusing to bind");
});

module.exports.done = (test._chain || Promise.resolve()).then(() => {
  console.log(`\n  ${passed} passed, ${failed} failed`);
});
