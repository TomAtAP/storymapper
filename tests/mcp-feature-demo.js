"use strict";

/**
 * Ad-hoc MCP feature walkthrough — drives the storymap MCP server through
 * a realistic feature scenario: "User Profile Edit" with one epic, four
 * stories, a bug, and explicit DoR/DoD gate enforcement. Not part of the
 * unit suite — invoked manually for a smoke check that the MCP integration
 * still works end-to-end.
 *
 * Usage:
 *   node tests/mcp-feature-demo.js
 *       → ephemeral /tmp data-dir, cleaned up; offline mode.
 *
 *   node tests/mcp-feature-demo.js --data-dir=./.storymap-data --http-url=http://localhost:8770
 *       → writes into the same data-dir your `npm start` server uses;
 *         calls request_switch_project so your browser shows a confirm
 *         dialog and auto-loads the demo project (E20).
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const COLOR = {
  reset: "\x1b[0m", bold: "\x1b[1m",
  green: "\x1b[32m", red: "\x1b[31m", cyan: "\x1b[36m", gray: "\x1b[90m", yellow: "\x1b[33m"
};
let stepN = 0;
function step(name, payload) {
  stepN++;
  console.log(`\n${COLOR.bold}${COLOR.cyan}[${stepN}] ${name}${COLOR.reset}` + (payload != null ? `  ${COLOR.gray}${typeof payload === "string" ? payload : JSON.stringify(payload)}${COLOR.reset}` : ""));
}
function ok(msg)    { console.log(`    ${COLOR.green}✓${COLOR.reset} ${msg}`); }
function info(msg)  { console.log(`    ${COLOR.gray}·${COLOR.reset} ${msg}`); }
function warn(msg)  { console.log(`    ${COLOR.yellow}!${COLOR.reset} ${msg}`); }
function fail(msg)  { console.log(`    ${COLOR.red}✗${COLOR.reset} ${msg}`); }

class McpClient {
  constructor(child) {
    this.child = child;
    this.nextId = 1;
    this.pending = new Map();
    this.buf = "";
    child.stdout.on("data", (chunk) => {
      this.buf += chunk.toString("utf8");
      let nl;
      while ((nl = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, nl); this.buf = this.buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
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
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params: params || {} }) + "\n");
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error("timeout: " + method)); }
      }, 8000);
    });
  }
  async call(name, args) {
    const msg = await this.send("tools/call", { name, arguments: args || {} });
    if (msg.error) { const e = new Error(msg.error.message); e.code = msg.error.code; throw e; }
    const r = msg.result || {};
    const text = r.content && r.content[0] && r.content[0].text;
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    if (r.isError) {
      const e = new Error((parsed && parsed.error) || "tool error");
      e.kind = parsed && parsed.kind;
      e.missing = parsed && parsed.missing;
      throw e;
    }
    return parsed;
  }
  close() {
    try { this.child.stdin.end(); } catch {}
    try { this.child.kill(); } catch {}
  }
}

async function spawnMcp(dataDir, httpUrl) {
  const indexPath = path.resolve(__dirname, "..", "server", "index.js");
  const env = Object.assign({}, process.env);
  if (httpUrl) env.STORYMAP_HTTP_URL = httpUrl;
  const child = spawn(process.execPath, [indexPath, "mcp", "--data-dir=" + dataDir], {
    stdio: ["pipe", "pipe", "pipe"], env
  });
  const client = new McpClient(child);
  await client.send("initialize", {
    protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "feature-demo", version: "0.1" }
  });
  client.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  return client;
}

function parseCli(argv) {
  const out = { dataDir: null, httpUrl: null, stepDelay: null };
  for (const a of argv.slice(2)) {
    if (a.startsWith("--data-dir=")) out.dataDir = a.slice("--data-dir=".length);
    else if (a.startsWith("--http-url=")) out.httpUrl = a.slice("--http-url=".length);
    else if (a.startsWith("--step-delay=")) out.stepDelay = parseInt(a.slice("--step-delay=".length), 10);
    else if (a === "--help" || a === "-h") {
      console.log("usage: node tests/mcp-feature-demo.js [--data-dir=PATH] [--http-url=URL] [--step-delay=MS]");
      console.log("  --step-delay: pause between MCP calls so a watching browser can follow along.");
      console.log("                Default: 0 (offline) / 1200 ms (when --http-url is set).");
      process.exit(0);
    }
  }
  return out;
}

const sleep = (ms) => ms > 0 ? new Promise(r => setTimeout(r, ms)) : Promise.resolve();

async function main() {
  const cli = parseCli(process.argv);
  // Default: ephemeral tmpdir (cleaned up on exit). Pass --data-dir to point
  // at the server's data-dir for a live demo.
  const dataDir = cli.dataDir
    ? path.resolve(cli.dataDir)
    : await fs.promises.mkdtemp(path.join(os.tmpdir(), "sm-feature-demo-"));
  const httpUrl = cli.httpUrl;   // null → request_switch_project will use in-process bus (no browser nudge)
  const cleanup = !cli.dataDir;  // only delete temp dirs we created ourselves
  console.log(`${COLOR.bold}MCP feature walkthrough${COLOR.reset}`);
  console.log(`${COLOR.gray}data dir: ${dataDir}${COLOR.reset}`);
  if (httpUrl) console.log(`${COLOR.gray}http url: ${httpUrl}  ${COLOR.yellow}(browser switch-confirms will appear)${COLOR.reset}`);
  console.log("");
  const c = await spawnMcp(dataDir, httpUrl);
  const PID = "profile-edit-" + Date.now().toString(36);   // unique per run, no collisions
  try {
    // -------------------------------------------------------------------
    // SETUP: project + workflow + release + process steps
    // -------------------------------------------------------------------
    step("project_create", { id: PID, name: "User Profile Edit", ticketPrefix: "UPE" });
    const created = await c.call("project_create", { id: PID, name: "User Profile Edit", ticketPrefix: "UPE" });
    ok("project created — revision " + created.revision);
    info("workflow statuses: " + created.snapshot.project.workflow.statuses.join(" → "));
    info("DoR items seeded: " + created.snapshot.project.definitions.ready.global.map(i => i.id + " (" + i.label + ")").join(", "));
    info("DoD items seeded: " + created.snapshot.project.definitions.done.global.map(i => i.id + " (" + i.label + ")").join(", "));

    if (httpUrl) {
      step("request_switch_project", "ask the browser to load the just-created project");
      const sw = await c.call("request_switch_project", {
        workspace: PID,
        reason: "I just created this project — switch over so you can follow along.",
        wait_seconds: 60
      });
      if (sw.timedOut) warn("user didn't respond within 60s — continuing anyway");
      else if (sw.response && sw.response.accepted) ok("browser accepted — should now show " + PID);
      else warn("browser declined — continuing without their attention");
    }

    step("set_config (workflow)", "bugs skip DoR — hotfix workflow");
    await c.call("set_config", {
      projectId: PID,
      section: "workflow",
      value: {
        statuses: ["backlog", "ready", "in-progress", "review", "done"],
        transitions: { ready: { requireGate: "DoR" }, done: { requireGate: "DoD" } },
        byType: { bug: { transitions: { ready: { requireGate: null } } } }
      }
    });
    ok("per-type override applied: bugs go straight to ready without DoR");

    step("release_create", { name: "v1.0 — MVP" });
    const rel = await c.call("release_create", { projectId: PID, name: "v1.0 — MVP", status: "planning" });
    ok("release " + rel.release.id + " created");

    step("process_step_create × 4", "Discover → Design → Build → Verify");
    const psDiscover = (await c.call("process_step_create", { projectId: PID, name: "Discover" })).processStep;
    const psDesign   = (await c.call("process_step_create", { projectId: PID, name: "Design"   })).processStep;
    const psBuild    = (await c.call("process_step_create", { projectId: PID, name: "Build"    })).processStep;
    const psVerify   = (await c.call("process_step_create", { projectId: PID, name: "Verify"   })).processStep;
    ok("4 process steps in place");

    // -------------------------------------------------------------------
    // EPIC + STORIES
    // -------------------------------------------------------------------
    step("ticket_create (epic)", "Profile Settings");
    const epic = (await c.call("ticket_create", {
      projectId: PID, type: "epic", title: "Profile Settings",
      description: "Allow users to edit name, email, and avatar.",
      position: { releaseId: rel.release.id, processStepId: psBuild.id }
    })).ticket;
    ok("epic " + epic.ticketKey + " — " + epic.title);

    const storyTitles = [
      ["View current profile",  "User can see their current name, email, avatar."],
      ["Edit display name",     "Name field is editable, validated 2–80 chars."],
      ["Change email",          "Email change triggers re-verification."],
      ["Upload avatar",         "PNG/JPEG, max 2 MB, cropped to 256×256."]
    ];
    const stories = [];
    for (const [title, desc] of storyTitles) {
      step("ticket_create (story)", { title, autoEpic: "in same (release,ps) cell" });
      const t = (await c.call("ticket_create", {
        projectId: PID, type: "user-story", title, description: desc,
        position: { releaseId: rel.release.id, processStepId: psBuild.id }
      })).ticket;
      ok(t.ticketKey + " — auto-assigned to epic " + (t.position.epicId === epic.id ? "✓" : "(none?)"));
      stories.push(t);
    }

    step("ticket_create (bug)", "Avatar upload accepts wrong MIME");
    const bug = (await c.call("ticket_create", {
      projectId: PID, type: "bug", title: "Avatar upload accepts non-image MIME",
      description: "Backend should reject anything not in image/* on upload."
    })).ticket;
    ok("bug " + bug.ticketKey + " in backlog");

    // -------------------------------------------------------------------
    // DOR GATE — first try the wall, then pass it
    // -------------------------------------------------------------------
    const story1 = stories[1];   // "Edit display name"
    step("mark_ready (DoR not met — expect gate block)", { ticket: story1.ticketKey });
    try {
      await c.call("mark_ready", { projectId: PID, ticketId: story1.id });
      fail("expected DoR gate to block — it didn't");
    } catch (err) {
      if (err.kind === "DoR" && err.missing) {
        ok("gate blocked as expected — missing items: " + err.missing.map(m => m.label).join(", "));
      } else throw err;
    }

    step("set_checklist_item (dor) × all required", { ticket: story1.ticketKey });
    const dorItems = story1.definitionOfReady.items;
    for (const item of dorItems) {
      await c.call("set_checklist_item", { gate: "dor", checked: true, projectId: PID, ticketId: story1.id, itemId: item.id });
      info("checked " + item.id + " — " + item.label);
    }
    ok("DoR items satisfied");

    step("mark_ready (retry)", { ticket: story1.ticketKey });
    const ready = await c.call("mark_ready", { projectId: PID, ticketId: story1.id });
    ok("status: " + ready.ticket.status);

    // -------------------------------------------------------------------
    // PROGRESS through workflow
    // -------------------------------------------------------------------
    step("change_ticket_status → in-progress", { ticket: story1.ticketKey });
    await c.call("change_ticket_status", { projectId: PID, ticketId: story1.id, status: "in-progress" });
    ok("ticket → in-progress");

    step("change_ticket_status → review", { ticket: story1.ticketKey });
    await c.call("change_ticket_status", { projectId: PID, ticketId: story1.id, status: "review" });
    ok("ticket → review");

    // -------------------------------------------------------------------
    // DOD GATE — try too early, then satisfy
    // -------------------------------------------------------------------
    step("complete_ticket (DoD not met — expect gate block)", { ticket: story1.ticketKey });
    try {
      await c.call("complete_ticket", { projectId: PID, ticketId: story1.id });
      fail("expected DoD gate to block — it didn't");
    } catch (err) {
      if (err.kind === "DoD" && err.missing) {
        ok("DoD gate blocked as expected — missing: " + err.missing.map(m => m.label).join(", "));
      } else throw err;
    }

    step("set_checklist_item (dod) × all required", { ticket: story1.ticketKey });
    const ticketNow = (await c.call("ticket_get", { projectId: PID, ticketId: story1.id })).ticket;
    for (const item of ticketNow.definitionOfDone.items) {
      await c.call("set_checklist_item", { gate: "dod", checked: true, projectId: PID, ticketId: story1.id, itemId: item.id });
      info("checked " + item.id + " — " + item.label);
    }

    step("complete_ticket", { ticket: story1.ticketKey });
    const done = await c.call("complete_ticket", { projectId: PID, ticketId: story1.id });
    ok("ticket → " + done.ticket.status);

    // -------------------------------------------------------------------
    // BUG: per-type DoR-bypass
    // -------------------------------------------------------------------
    step("change_ticket_status (bug → ready, per-type bypass)", { ticket: bug.ticketKey });
    await c.call("change_ticket_status", { projectId: PID, ticketId: bug.id, status: "ready" });
    ok("bug → ready WITHOUT DoR (per-type workflow override worked)");

    // -------------------------------------------------------------------
    // REORDER inside the epic
    // -------------------------------------------------------------------
    step("reorder(tickets) (under epic, reversed)", { newOrder: stories.map(s => s.title).reverse() });
    await c.call("reorder", { entity: "tickets",
      projectId: PID,
      orderedIds: stories.slice().reverse().map(s => s.id),
      scope: { releaseId: rel.release.id, processStepId: psBuild.id, epicId: epic.id }
    });
    ok("stories reversed under epic");

    // -------------------------------------------------------------------
    // FINAL STATE
    // -------------------------------------------------------------------
    step("list_tickets", "summarise where everything landed");
    const all = (await c.call("list_tickets", { projectId: PID })).tickets;
    info("Total tickets: " + all.length);
    const byStatus = {};
    for (const t of all) {
      byStatus[t.status] = (byStatus[t.status] || 0) + 1;
    }
    info("By status: " + Object.entries(byStatus).map(([s, n]) => `${s}=${n}`).join(", "));
    info("Done items: " + all.filter(t => t.status === "done").map(t => t.ticketKey + " " + t.title).join(", "));

    step("list_revisions", "show full audit trail");
    const revs = await c.call("list_revisions", { projectId: PID, limit: 100 });
    info("Total revisions: " + revs.length);
    const opCounts = {};
    for (const r of revs) opCounts[r.op] = (opCounts[r.op] || 0) + 1;
    info("Ops: " + Object.entries(opCounts).map(([op, n]) => `${op}=${n}`).join(", "));

    console.log("");
    console.log(`${COLOR.bold}${COLOR.green}feature walkthrough OK${COLOR.reset}  (${stepN} steps)`);
  } finally {
    c.close();
    // ONLY delete the data-dir if we created the tempdir ourselves. Never
    // touch a user-supplied --data-dir (per CLAUDE.md "Things to avoid").
    if (cleanup) {
      try { await fs.promises.rm(dataDir, { recursive: true, force: true }); } catch {}
    }
  }
}

main().catch((err) => {
  console.error(`\n${COLOR.bold}${COLOR.red}WALKTHROUGH FAILED${COLOR.reset}`);
  console.error(err);
  process.exit(1);
});
