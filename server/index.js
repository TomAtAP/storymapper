#!/usr/bin/env node
"use strict";

/**
 * storymap CLI. Two subcommands:
 *   storymap server [--port=N] [--data-dir=PATH] [--host=HOST]
 *   storymap mcp    [--data-dir=PATH]
 *
 * Both honor SIGINT / SIGTERM / SIGHUP for graceful shutdown.
 * MCP mode also exits on stdin EOF (Ctrl-D), matching cmapper.
 */

const path = require("path");
const fs = require("fs");

// --- SM-215: same-data-dir server guard --------------------------------------
// Two `storymap server` processes on one data dir would split-brain the WS
// sync and collide revision ids (the minter is process-local). A PID lock
// file refuses the second server. SERVER-MODE ONLY — the concurrent
// server+mcp combo on one data dir is a documented workflow (E20.E).
const SERVER_LOCK = {
  FILENAME: "storymap-server.lock",
  EXIT_CODE: 3
};

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e && e.code === "EPERM"; }   // EPERM = alive, not ours
}

/**
 * Acquire the server lock for dataDir. Returns a release() function.
 * A live PID in an existing lock refuses (exit SERVER_LOCK.EXIT_CODE) unless
 * `force` is set; a stale lock (dead PID) is replaced silently.
 */
function acquireServerLock(dataDir, force) {
  fs.mkdirSync(dataDir, { recursive: true });
  const lockPath = path.join(dataDir, SERVER_LOCK.FILENAME);
  if (fs.existsSync(lockPath) && !force) {
    const pid = parseInt(fs.readFileSync(lockPath, "utf8"), 10);
    if (pid && pid !== process.pid && pidAlive(pid)) {
      process.stderr.write(
        `[storymap] another 'storymap server' (pid ${pid}) is already running on this data-dir ` +
        `(lock: ${lockPath}).\n[storymap] One server per data-dir — MCP may share. ` +
        `Use --force to take over a stale environment.\n`);
      process.exit(SERVER_LOCK.EXIT_CODE);
    }
  }
  fs.writeFileSync(lockPath, String(process.pid));
  return function release() {
    try {
      // Only remove our own lock — a --force takeover may have replaced it.
      const cur = parseInt(fs.readFileSync(lockPath, "utf8"), 10);
      if (cur === process.pid) fs.unlinkSync(lockPath);
    } catch (_) { /* already gone */ }
  };
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (const a of argv) {
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq < 0) flags[a.slice(2)] = true;
      else flags[a.slice(2, eq)] = a.slice(eq + 1);
    } else positional.push(a);
  }
  return { positional, flags };
}

function resolveDataDir(flag) {
  if (typeof flag === "string" && flag.length > 0) return path.resolve(flag);
  return path.resolve(process.cwd(), ".storymap-data");
}

// --- Non-loopback bind guard (security) --------------------------------------
// Storymapper has NO authentication layer: anyone who can reach the port has
// full read/write on every project. Binding to a non-loopback interface
// therefore exposes all data to the network. The server refuses such a bind
// unless the operator explicitly opts in with --allow-remote, and warns loudly
// when they do. Note `0.0.0.0` / `::` bind ALL interfaces (the most exposed)
// and are deliberately NOT treated as loopback.
const REMOTE_BIND = { EXIT_CODE: 4 };

function isLoopbackHost(host) {
  if (!host) return true;   // the default bind is localhost
  const h = String(host).trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (h === "localhost" || h === "::1") return true;
  // the whole 127.0.0.0/8 loopback block
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  return false;
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const cmd = positional[0] || "help";

  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(`Usage:
  storymap server [--port=N] [--data-dir=PATH] [--host=HOST] [--allow-remote] [--force]
  storymap mcp    [--data-dir=PATH]
  storymap tool   <name> ['<json-args>'] [--data-dir=PATH]

'storymap tool' is a pass-through: it runs ONE MCP tool over the same tool core
the MCP server uses and prints the result JSON to stdout. Arguments come from a
positional JSON string, --json=<json>, or piped stdin. Exit: 0 ok, 1 tool
isError, 2 unknown tool / bad args.

The server binds to loopback (localhost) only. Binding to a non-loopback host
exposes all projects with NO authentication and is refused unless you pass
--allow-remote (put your own auth proxy in front).

One 'storymap server' per data-dir (PID lock; --force takes over a stale
lock). 'storymap mcp' may always share the data-dir with a running server.
`);
    return;
  }

  if (cmd === "server") {
    const { startServer } = require("./server.js");
    const port = flags.port ? Number(flags.port) : 8770;
    const host = flags.host || "localhost";
    const allowRemote = flags["allow-remote"] === true || flags["allow-remote"] === "true";
    // Security: refuse a network-exposed bind unless explicitly opted in.
    if (!isLoopbackHost(host) && !allowRemote) {
      process.stderr.write(
        `[storymap] refusing to bind to non-loopback host '${host}'.\n` +
        `[storymap] Storymapper has NO authentication — a non-loopback bind exposes\n` +
        `[storymap] every project to anyone who can reach the port. If you really intend\n` +
        `[storymap] this (e.g. behind your own auth proxy), re-run with --allow-remote.\n`);
      process.exit(REMOTE_BIND.EXIT_CODE);
    }
    const dataDir = resolveDataDir(flags["data-dir"]);
    // SM-215: refuse a second server on the same data-dir (MCP may share).
    // Accept bare `--force` and `--force=true` (parseArgs yields true|"true").
    const releaseLock = acquireServerLock(dataDir, flags.force === true || flags.force === "true");
    const handle = await startServer({ port, host, dataDir });
    const addr = handle.httpServer.address();
    // Attach signal/shutdown handlers BEFORE announcing "listening". A Ctrl-C
    // (or a test's SIGINT) in the window between "listening" and handler-install
    // would otherwise hit Node's default SIGINT handler, terminating the process
    // without running releaseLock() — leaving a stale lock behind.
    installShutdown("storymap", async () => {
      await handle.shutdown();
      releaseLock();
    }, { allowStdin: true });
    // "listening" is the magic substring tests grep for.
    process.stderr.write(`[storymap] listening on http://${host}:${addr.port}/  (data: ${dataDir})\n`);
    if (!isLoopbackHost(host)) {
      process.stderr.write(
        `\n[storymap] ============================================================\n` +
        `[storymap]  WARNING: bound to non-loopback host '${host}' with --allow-remote.\n` +
        `[storymap]  There is NO authentication — every project is readable and\n` +
        `[storymap]  writable by anyone who can reach this port. Put your own\n` +
        `[storymap]  authentication in front of it.\n` +
        `[storymap] ============================================================\n\n`);
    }
    return;
  }

  if (cmd === "mcp") {
    const Storage = require("./storage.js");
    const { runStdio } = require("./mcp.js");
    const dataDir = resolveDataDir(flags["data-dir"]);
    const storage = new Storage(dataDir);
    await storage.init();
    const { transport } = await runStdio(storage);
    process.stderr.write(`[storymap-mcp] listening on stdio  (data: ${dataDir})\n`);
    // stdin EOF (no TTY in mcp-mode — Claude Desktop closes stdin to signal exit).
    process.stdin.on("end", () => {
      try { transport.close(); } catch (_) { /* ignore */ }
      try { storage.close(); } catch (_) { /* ignore */ }
      process.exit(0);
    });
    installShutdown("storymap-mcp", async () => {
      try { await transport.close(); } catch (_) { /* ignore */ }
      try { storage.close(); } catch (_) { /* ignore */ }
    }, { allowStdin: false });   // mcp-mode has its own stdin lifecycle
    return;
  }

  if (cmd === "tool") {
    // Pass-through CLI: run ONE MCP tool over the same native tool core the MCP
    // server uses (SM-311). `storymap tool <name> ['<json>']` or pipe JSON stdin.
    const Storage = require("./storage.js");
    const { buildServer } = require("./mcp.js");
    const { runCli } = require("../packages/native-mcp");
    const dataDir = resolveDataDir(flags["data-dir"]);
    const storage = new Storage(dataDir);
    await storage.init();
    const httpUrl = (typeof flags["http-url"] === "string")
      ? flags["http-url"] : (process.env.STORYMAP_HTTP_URL || "http://localhost:8770");
    // buildServer registers all ~70 tools on the native registry (same as MCP).
    const registry = buildServer(storage, { httpUrl });
    // JSON args come from `tool <name> '<json>'` (positional) or --json=<json>;
    // if neither is given and stdin is piped, read the JSON from stdin.
    const jsonArg = (typeof flags.json === "string") ? flags.json : positional[2];
    let stdinData;
    if (jsonArg === undefined && !process.stdin.isTTY) stdinData = await readAllStdin();
    const code = await runCli(registry, { name: positional[1], json: jsonArg }, { stdinData });
    try { storage.close(); } catch (_) { /* ignore */ }
    process.exit(code);
  }

  console.error("unknown command: " + cmd);
  process.exit(2);
}

/**
 * Graceful-shutdown wiring — portiert von cmapper/server/index.js.
 *
 *   - Schreibt jeden Schritt nach stderr (SIGINT empfangen / Force-Timeout).
 *   - Force-Timer mit unref() — sonst hält der Timer den Event-Loop offen
 *     auch nach erfolgreichem Shutdown.
 *   - Zweites Signal während Shutdown = sofortiger Exit (Code 130).
 *   - allowStdin=true: Ctrl-D auf TTY = graceful shutdown (für server-mode).
 *     allowStdin=false: stdin-Lebenszyklus gehört dem Caller (mcp-mode).
 */
// Read all of stdin as a UTF-8 string — used by `tool` mode when the JSON args
// are piped rather than passed as an argument.
function readAllStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => { data += c; });
    process.stdin.on("end", () => resolve(data));
    process.stdin.resume();
  });
}

function installShutdown(label, shutdownFn, opts) {
  opts = opts || {};
  let shuttingDown = false;

  async function stop(signal, exitCode) {
    if (shuttingDown) {
      process.stderr.write(`[${label}] second ${signal} — forcing exit\n`);
      process.exit(130);
    }
    shuttingDown = true;
    process.stderr.write(`[${label}] ${signal} received — shutting down\n`);
    const forceTimer = setTimeout(() => {
      process.stderr.write(`[${label}] shutdown timed out after 2s — forcing exit\n`);
      process.exit(1);
    }, 2000);
    forceTimer.unref();
    try { await shutdownFn(); }
    catch (e) { process.stderr.write(`[${label}] shutdown error: ${e.message}\n`); }
    process.exit(exitCode || 0);
  }

  process.on("SIGINT",  () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGHUP",  () => stop("SIGHUP"));

  // SM-213: a stray rejection/exception must not vanish or kill the process
  // without cleanup — log the cause, run the SAME graceful path, exit 1.
  process.on("uncaughtException", (err) => {
    process.stderr.write(`[${label}] uncaughtException: ${(err && err.stack) || err}\n`);
    stop("uncaughtException", 1);
  });
  process.on("unhandledRejection", (reason) => {
    process.stderr.write(`[${label}] unhandledRejection: ${(reason && reason.stack) || reason}\n`);
    stop("unhandledRejection", 1);
  });

  if (opts.allowStdin && process.stdin.isTTY) {
    process.stdin.on("end", () => stop("stdin EOF"));
    process.stdin.resume();
  }
}

// SM-213: requiring this file must NOT auto-start the CLI — tests import
// installShutdown to drive the process-level error handlers in a subprocess.
if (require.main === module) {
  main().catch((err) => {
    console.error(err && err.stack || err);
    process.exit(1);
  });
}

module.exports = { installShutdown, parseArgs, resolveDataDir, acquireServerLock, SERVER_LOCK, isLoopbackHost, REMOTE_BIND };
