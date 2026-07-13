"use strict";

/**
 * Reproducible MCP-Walkthrough (E13.D).
 *
 * Spawns the storymap MCP server as a subprocess and drives it through a
 * complete project lifecycle: create project → configure workflow + DoR/DoD
 * → releases → process steps → tickets → DoR-check → status transitions →
 * reorder → revisions → restore. Each step prints what it sends and what
 * comes back so the user can follow along (and re-run to verify changes
 * still work end-to-end).
 *
 * Not a unit test — runs once per invocation, exits 0 on success.
 *
 * Usage:
 *   node tests/mcp-walkthrough.js                # ephemeral /tmp dir, cleaned up
 *   node tests/mcp-walkthrough.js --keep         # leave the data dir intact
 *   node tests/mcp-walkthrough.js --data-dir=X   # use a specific dir (the user
 *                                                # can open http://localhost:8770
 *                                                # with --data-dir=X to watch live)
 *
 * To watch the walkthrough live in a browser:
 *   Terminal A:  npm start -- --data-dir=/tmp/sm-demo
 *   Browser:     http://localhost:8770/?api=http://localhost:8770
 *   Terminal B:  node tests/mcp-walkthrough.js --data-dir=/tmp/sm-demo --keep
 *
 * SQLite WAL allows the HTTP server and the MCP subprocess to share the
 * same data-dir concurrently; the HTTP server's WebSocket bus fires
 * `change` events on every save so the browser sees MCP writes within
 * ~100 ms (E5 live-sync).
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

// ---- CLI args ----------------------------------------------------------
function parseArgs(argv) {
  const out = { keep: false, dataDir: null };
  for (const arg of argv.slice(2)) {
    if (arg === "--keep") out.keep = true;
    else if (arg.startsWith("--data-dir=")) out.dataDir = arg.slice("--data-dir=".length);
    else if (arg === "--help" || arg === "-h") {
      console.log("usage: node tests/mcp-walkthrough.js [--keep] [--data-dir=PATH]");
      process.exit(0);
    }
  }
  return out;
}

// ---- Pretty printers ---------------------------------------------------
const COLOR = process.stdout.isTTY ? {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
  green: "\x1b[32m", red: "\x1b[31m", cyan: "\x1b[36m", yellow: "\x1b[33m"
} : { reset:"", dim:"", bold:"", green:"", red:"", cyan:"", yellow:"" };

let stepNum = 0;
function step(label, args) {
  stepNum++;
  const head = String(stepNum).padStart(2, "0");
  console.log("");
  console.log(`${COLOR.bold}${COLOR.cyan}[${head}] → ${label}${COLOR.reset}`);
  if (args !== undefined) {
    const dump = typeof args === "string" ? args : JSON.stringify(args);
    if (dump && dump !== "{}") console.log(`     ${COLOR.dim}${truncate(dump, 200)}${COLOR.reset}`);
  }
}
function ok(message) {
  console.log(`     ${COLOR.green}✓${COLOR.reset} ${message}`);
}
function info(message) {
  console.log(`     ${COLOR.dim}${message}${COLOR.reset}`);
}
function bad(message) {
  console.log(`     ${COLOR.red}✗${COLOR.reset} ${message}`);
}
function truncate(s, n) {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

// ---- Tiny stdio JSON-RPC client (taken from test-mcp-stdio.js) --------
class McpClient {
  constructor(child) {
    this.child = child;
    this.buf = "";
    this.pending = new Map();
    this.nextId = 1;
    child.stdout.on("data", (chunk) => {
      this.buf += chunk.toString();
      let idx;
      while ((idx = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, idx);
        this.buf = this.buf.slice(idx + 1);
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch (_) { continue; }
        if (msg.id != null && this.pending.has(msg.id)) {
          const { resolve } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          resolve(msg);
        }
      }
    });
    child.stderr.on("data", () => {});
  }
  send(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params: params || {} });
      this.child.stdin.write(payload + "\n");
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error("timeout waiting for response to " + method));
        }
      }, 8000);
    });
  }
  async call(toolName, args) {
    const msg = await this.send("tools/call", { name: toolName, arguments: args || {} });
    if (msg.error) {
      const e = new Error(msg.error.message || "RPC error");
      e.code = msg.error.code; e.data = msg.error.data;
      throw e;
    }
    const result = msg.result || {};
    const text = result.content && result.content[0] && result.content[0].text;
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch (_) { parsed = text; }
    if (result.isError) {
      const err = new Error((parsed && parsed.error) || "tool error");
      err.kind = parsed && parsed.kind;
      err.missing = parsed && parsed.missing;
      err.statusCode = parsed && parsed.statusCode;
      throw err;
    }
    return parsed;
  }
  close() {
    try { this.child.stdin.end(); } catch (_) {}
    try { this.child.kill(); } catch (_) {}
  }
}

async function spawnMcp(dataDir) {
  const indexPath = path.resolve(__dirname, "..", "server", "index.js");
  const child = spawn(process.execPath, [indexPath, "mcp", "--data-dir=" + dataDir], {
    stdio: ["pipe", "pipe", "pipe"]
  });
  const client = new McpClient(child);
  const init = await client.send("initialize", {
    protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "walkthrough", version: "0.1.0" }
  });
  if (init.error) throw new Error("initialize failed: " + JSON.stringify(init.error));
  client.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  return client;
}

// ---- The walkthrough ---------------------------------------------------

async function walkthrough(dataDir) {
  const client = await spawnMcp(dataDir);
  const PID = "demo";
  try {
    // 1) Project
    step("project_create", { id: PID, name: "Demo App", ticketPrefix: "DEMO" });
    const created = await client.call("project_create", { id: PID, name: "Demo App", ticketPrefix: "DEMO" });
    ok("project created — revision " + created.revision);
    info("entityTypeConfig: " + JSON.stringify(created.snapshot.project.entityTypeConfig));
    info("workflow.statuses: " + JSON.stringify(created.snapshot.project.workflow.statuses));
    info("DoR seeded: " + created.snapshot.project.definitions.ready.global.map(i => i.label).join(", "));
    info("DoD seeded: " + created.snapshot.project.definitions.done.global.map(i => i.label).join(", "));

    // 2) Custom workflow with per-type override
    step("set_config (workflow)", "5-step default + bugs skip DoR-gate");
    await client.call("set_config", {
      projectId: PID,
      section: "workflow",
      value: {
        statuses: ["backlog", "ready", "in-progress", "review", "done"],
        transitions: { "ready": { requireGate: "DoR" }, "done": { requireGate: "DoD" } },
        byType: { "bug": { transitions: { "ready": { requireGate: null } } } }
      }
    });
    ok("workflow set — bugs may skip the DoR gate");

    // 3) Releases
    step("release_create", { name: "v1.0" });
    const r1 = await client.call("release_create", { projectId: PID, name: "v1.0", status: "planning" });
    ok("v1.0 created (" + r1.release.id + ")");
    step("release_create", { name: "v1.1" });
    const r2 = await client.call("release_create", { projectId: PID, name: "v1.1", status: "planning" });
    ok("v1.1 created (" + r2.release.id + ")");

    // 4) Process steps
    step("process_step_create", { name: "Onboarding" });
    const ps1 = await client.call("process_step_create", { projectId: PID, name: "Onboarding" });
    ok("Onboarding (" + ps1.processStep.id + ")");
    step("process_step_create", { name: "Daily Use" });
    const ps2 = await client.call("process_step_create", { projectId: PID, name: "Daily Use" });
    ok("Daily Use (" + ps2.processStep.id + ")");

    // 5) Tickets
    step("ticket_create (epic)", { type: "epic", title: "User Onboarding", position: "{r1, ps1}" });
    const epic = await client.call("ticket_create", {
      projectId: PID, type: "epic", title: "User Onboarding",
      position: { releaseId: r1.release.id, processStepId: ps1.processStep.id }
    });
    ok("epic " + epic.ticket.ticketKey + " created");

    const stories = [];
    for (const title of ["Sign-up form", "Email verification", "Welcome tour"]) {
      step("ticket_create (story)", { title, epicId: epic.ticket.id });
      const t = await client.call("ticket_create", {
        projectId: PID, type: "user-story", title,
        position: { releaseId: r1.release.id, epicId: epic.ticket.id }
      });
      ok(t.ticket.ticketKey + " created, sortOrder=" + t.ticket.position.sortOrder);
      stories.push(t.ticket);
    }

    step("ticket_create (bug, orphan)", { title: "Login crashes" });
    const bug = await client.call("ticket_create", {
      projectId: PID, type: "bug", title: "Login crashes on stale token"
    });
    ok("bug " + bug.ticket.ticketKey + " created in backlog (sortOrder=" + bug.ticket.position.sortOrder + ")");

    // 6) DoR check → mark_ready
    step("set_checklist_item", { gate: "dor", checked: true, ticket: stories[0].ticketKey, itemId: "dor-acceptance" });
    await client.call("set_checklist_item", { gate: "dor", checked: true, projectId: PID, ticketId: stories[0].id, itemId: "dor-acceptance" });
    ok("DoR item 'dor-acceptance' checked");

    step("mark_ready", { ticket: stories[0].ticketKey });
    let res;
    try {
      res = await client.call("mark_ready", { projectId: PID, ticketId: stories[0].id });
      ok("ticket → ready");
    } catch (err) {
      bad("mark_ready blocked: " + err.message);
      if (err.missing) info("missing: " + err.missing.map(m => m.label).join(", "));
      // Check the remaining required item to unblock.
      step("set_checklist_item", { gate: "dor", checked: true, itemId: "dor-clarity" });
      await client.call("set_checklist_item", { gate: "dor", checked: true, projectId: PID, ticketId: stories[0].id, itemId: "dor-clarity" });
      ok("DoR clarity checked too");
      res = await client.call("mark_ready", { projectId: PID, ticketId: stories[0].id });
      ok("ticket → ready (retry)");
    }

    step("change_ticket_status", { ticket: stories[0].ticketKey, status: "in-progress" });
    await client.call("change_ticket_status", { projectId: PID, ticketId: stories[0].id, status: "in-progress" });
    ok("ticket → in-progress");

    // 7) Bug bypasses DoR gate (per-type override)
    step("change_ticket_status (bug → ready, DoR-gate-bypass)", { ticket: bug.ticket.ticketKey });
    await client.call("change_ticket_status", { projectId: PID, ticketId: bug.ticket.id, status: "ready" });
    ok("bug → ready without DoR (per-type workflow override worked)");

    // 8) Reorder
    step("reorder(tickets) (under epic)", { newOrder: stories.map(s => s.title).reverse() });
    await client.call("reorder", { entity: "tickets",
      projectId: PID,
      orderedIds: stories.slice().reverse().map(s => s.id),
      scope: { releaseId: r1.release.id, epicId: epic.ticket.id }
    });
    ok("stories reversed under epic");

    // 9) Revisions
    step("list_revisions", { limit: 5 });
    const revs = await client.call("list_revisions", { projectId: PID, limit: 5 });
    ok("got " + revs.length + " of N revisions:");
    revs.forEach((r) => info("  " + r.revision + "  op=" + r.op + "  actor=" + (r.actor && r.actor.type)));

    // 10) Restore to a much earlier point — back to right after release_create (revision ~3 in the list).
    const targetRev = revs[Math.min(revs.length - 1, 6)];
    step("restore_revision", { rev: targetRev.revision, op: targetRev.op });
    const restored = await client.call("restore_revision", { projectId: PID, revision: targetRev.revision });
    ok("restored. New revision " + restored.revision + " (op=project_restore)");
    info("tickets after restore: " + restored.snapshot.tickets.filter(t => !t.isDeleted).map(t => t.title).join(", "));

    step("list_revisions (post-restore)", { limit: 3 });
    const after = await client.call("list_revisions", { projectId: PID, limit: 3 });
    info("newest 3: " + after.map(r => r.op).join(" / "));

    console.log("");
    console.log(`${COLOR.bold}${COLOR.green}walkthrough OK${COLOR.reset}  (${stepNum} steps)`);
  } finally {
    client.close();
  }
}

// ---- Entry point -------------------------------------------------------

(async () => {
  const args = parseArgs(process.argv);
  let dataDir = args.dataDir;
  let cleanup = false;
  if (!dataDir) {
    dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "storymap-mcp-walkthrough-"));
    cleanup = !args.keep;
  } else {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  console.log(`${COLOR.dim}data-dir: ${dataDir}${COLOR.reset}`);
  let exit = 0;
  try {
    await walkthrough(dataDir);
  } catch (err) {
    console.log("");
    console.log(`${COLOR.red}walkthrough FAILED${COLOR.reset}: ${err.stack || err.message}`);
    exit = 1;
  } finally {
    if (cleanup) {
      try { await fs.promises.rm(dataDir, { recursive: true, force: true }); } catch (_) {}
    } else {
      console.log(`${COLOR.dim}kept data-dir: ${dataDir}${COLOR.reset}`);
      console.log(`${COLOR.dim}open in browser: npm start -- --data-dir=${dataDir}${COLOR.reset}`);
    }
  }
  process.exit(exit);
})();
