"use strict";

/**
 * E24 — Reproducible MCP animation walkthrough.
 *
 * Drives the storymap MCP server through an animation-heavy scenario so a
 * human watcher can verify the E24 highlight + FLIP behavior across BOTH
 * views (Story Map + Kanban). Every step pauses long enough for the
 * eye to follow.
 *
 * Coverage:
 *   - Process steps appear + get reordered  → highlight on the backbone.
 *   - Releases appear + get reordered       → highlight on release rows.
 *   - Epic appears in a cell                → highlight on the epic card.
 *   - Stories created in backlog            → pulse when they arrive.
 *   - Stories move from backlog into the    → FLIP-animated drop into
 *     epic's cell                              the epic body.
 *   - Epic moves between process-step cells → FLIP across the backbone.
 *   - Status walk through the workflow      → FLIP between Kanban lanes.
 *   - Reorder within a lane                 → FLIP inside the lane.
 *
 * Usage (live mode — recommended for visual verification):
 *   Terminal A:  npm start -- --data-dir=./.storymap-data
 *   Browser:     http://localhost:8770/?api=http://localhost:8770
 *   Terminal B:  node tests/mcp-animation-walkthrough.js \
 *                   --data-dir=./.storymap-data \
 *                   --http-url=http://localhost:8770
 *
 * Usage (offline smoke — no browser involvement):
 *   node tests/mcp-animation-walkthrough.js
 *
 * The browser switches automatically (request_switch_project, E20) so
 * you just need to have a window open before launching the script.
 * **Open the Story Map view first**, the script will walk through Map-
 * relevant changes (epic, process-steps, releases) before the Kanban-
 * specific status walk. The user can switch to Kanban mid-run; the
 * pauses are long enough.
 *
 * Not part of the unit suite — invoke manually.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const COLOR = {
  reset: "\x1b[0m", bold: "\x1b[1m",
  green: "\x1b[32m", red: "\x1b[31m", cyan: "\x1b[36m",
  gray: "\x1b[90m", yellow: "\x1b[33m", magenta: "\x1b[35m"
};
let stepN = 0;
function step(name, payload) {
  stepN++;
  console.log(`\n${COLOR.bold}${COLOR.cyan}[${stepN}] ${name}${COLOR.reset}` +
    (payload != null ? `  ${COLOR.gray}${typeof payload === "string" ? payload : JSON.stringify(payload)}${COLOR.reset}` : ""));
}
function ok(msg)   { console.log(`    ${COLOR.green}✓${COLOR.reset} ${msg}`); }
function info(msg) { console.log(`    ${COLOR.gray}·${COLOR.reset} ${msg}`); }
function hint(msg) { console.log(`    ${COLOR.magenta}👀 ${msg}${COLOR.reset}`); }

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
  async send(method, params, timeoutMs) {
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params: params || {} });
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error("MCP timeout: " + method)); }, timeoutMs || 30000);
      this.pending.set(id, { resolve: (m) => { clearTimeout(t); resolve(m); }, reject });
      this.child.stdin.write(payload + "\n");
    });
  }
  async call(name, args, timeoutMs) {
    const r = await this.send("tools/call", { name, arguments: args || {} }, timeoutMs);
    if (r.error) throw new Error(name + ": " + JSON.stringify(r.error));
    if (r.result && r.result.isError) throw new Error(name + " error: " + r.result.content[0].text);
    return r.result && r.result.content && r.result.content[0]
      ? JSON.parse(r.result.content[0].text)
      : null;
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
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "anim-walkthrough", version: "1.0" }
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
      console.log("usage: node tests/mcp-animation-walkthrough.js [--data-dir=PATH] [--http-url=URL] [--step-delay=MS]");
      console.log("  --step-delay  pause between MCP calls (default 1800ms with --http-url, else 0)");
      process.exit(0);
    }
  }
  return out;
}

const sleep = (ms) => ms > 0 ? new Promise(r => setTimeout(r, ms)) : Promise.resolve();

async function main() {
  const cli = parseCli(process.argv);
  const dataDir = cli.dataDir
    ? path.resolve(cli.dataDir)
    : await fs.promises.mkdtemp(path.join(os.tmpdir(), "sm-anim-demo-"));
  const httpUrl = cli.httpUrl || null;
  const stepDelay = cli.stepDelay != null ? cli.stepDelay : (httpUrl ? 1800 : 0);
  const cleanup = !cli.dataDir;
  const PID = "anim-demo-" + Date.now().toString(36);

  console.log(`${COLOR.bold}E24 MCP animation walkthrough${COLOR.reset}`);
  console.log(`${COLOR.gray}data dir : ${dataDir}${COLOR.reset}`);
  console.log(`${COLOR.gray}step gap : ${stepDelay} ms${COLOR.reset}`);
  if (httpUrl) console.log(`${COLOR.gray}http url : ${httpUrl}  ${COLOR.yellow}(browser switch-confirms will appear)${COLOR.reset}`);
  console.log("");

  const c = await spawnMcp(dataDir, httpUrl);
  try {
    // -------------------------------------------------------------------
    // SETUP: project + ask the browser to switch
    // -------------------------------------------------------------------
    step("project_create", { id: PID, name: "Animation Demo" });
    await c.call("project_create", {
      id: PID, name: "Animation Demo", ticketPrefix: "ANI",
      description: "E24 walkthrough: every MCP change pulses, every move FLIP-animates."
    });
    ok("project ready");

    if (httpUrl) {
      step("request_switch_project");
      hint("Browser will ask to switch — accept it. Open the Story Map view first.");
      await c.call("request_switch_project", {
        workspace: PID,
        reason: "Animation walkthrough — please open the Story Map view first; we'll move to Kanban later.",
        wait_seconds: 60
      }, 90000);   // give the user 90s to accept the confirm
      ok("browser landed on the demo project");
      await sleep(800);
    }

    // -------------------------------------------------------------------
    // Story-Map setup: 2 releases + 3 process steps (all pulse on arrival)
    // -------------------------------------------------------------------
    step("release_create v1.0");
    hint("Release row appears — should pulse green when it arrives.");
    const rel1 = (await c.call("release_create", { projectId: PID, name: "v1.0" })).release;
    await sleep(stepDelay);

    step("release_create v1.1");
    hint("Second release row pulses below v1.0.");
    const rel2 = (await c.call("release_create", { projectId: PID, name: "v1.1" })).release;
    await sleep(stepDelay);

    step("process_step_create Discover");
    hint("Backbone column appears + pulses.");
    const ps1 = (await c.call("process_step_create", { projectId: PID, name: "Discover" })).processStep;
    await sleep(stepDelay);

    step("process_step_create Build");
    const ps2 = (await c.call("process_step_create", { projectId: PID, name: "Build" })).processStep;
    await sleep(stepDelay);

    step("process_step_create Validate");
    const ps3 = (await c.call("process_step_create", { projectId: PID, name: "Validate" })).processStep;
    await sleep(stepDelay);

    // -------------------------------------------------------------------
    // Process-step reorder (FLIP across the backbone)
    // -------------------------------------------------------------------
    step("reorder(process_steps)  →  Validate, Discover, Build");
    hint("Backbone columns reshuffle — watch them slide horizontally.");
    await c.call("reorder", { entity: "process_steps",
      projectId: PID, orderedIds: [ps3.id, ps1.id, ps2.id]
    });
    await sleep(stepDelay);

    step("reorder(process_steps)  →  back to Discover, Build, Validate");
    hint("And slide back.");
    await c.call("reorder", { entity: "process_steps",
      projectId: PID, orderedIds: [ps1.id, ps2.id, ps3.id]
    });
    await sleep(stepDelay);

    // -------------------------------------------------------------------
    // Epic creation + placement in a cell
    // -------------------------------------------------------------------
    step("ticket_create epic 'Onboarding Revamp'");
    hint("Epic card pulses in the Backlog section.");
    const epicA = (await c.call("ticket_create", {
      projectId: PID, type: "epic", title: "Onboarding Revamp",
      description: "Make the first 30s feel friendly."
    })).ticket;
    await sleep(stepDelay);

    step("reorder(tickets)  →  move epic into v1.0 × Build");
    hint("Epic card flies from Backlog into the Build column of v1.0 — FLIP animation.");
    await c.call("reorder", { entity: "tickets",
      projectId: PID, orderedIds: [epicA.id],
      scope: { releaseId: rel1.id, processStepId: ps2.id, epicId: null }
    });
    await sleep(stepDelay + 600);

    // -------------------------------------------------------------------
    // Stories appear in Backlog + then move into the epic
    // -------------------------------------------------------------------
    step("ticket_create  ×  3 stories in Backlog");
    hint("Three story cards appear in Backlog — each pulses individually.");
    const story1 = (await c.call("ticket_create", { projectId: PID, type: "user-story", title: "Welcome wizard" })).ticket;
    await sleep(stepDelay / 2);
    const story2 = (await c.call("ticket_create", { projectId: PID, type: "user-story", title: "Template chooser" })).ticket;
    await sleep(stepDelay / 2);
    const story3 = (await c.call("ticket_create", { projectId: PID, type: "user-story", title: "Skip-and-explore" })).ticket;
    await sleep(stepDelay);

    step("reorder(tickets)  →  move all 3 stories into the epic");
    hint("Three story cards slide from Backlog into the epic body — three FLIP animations + pulses.");
    await c.call("reorder", { entity: "tickets",
      projectId: PID, orderedIds: [story1.id, story2.id, story3.id],
      scope: { releaseId: rel1.id, processStepId: ps2.id, epicId: epicA.id }
    });
    await sleep(stepDelay + 600);

    // -------------------------------------------------------------------
    // Second epic + cross-epic move
    // -------------------------------------------------------------------
    step("ticket_create epic 'Authentication hardening'");
    hint("Second epic card appears (still in Backlog) + pulses.");
    const epicB = (await c.call("ticket_create", {
      projectId: PID, type: "epic", title: "Authentication hardening"
    })).ticket;
    await sleep(stepDelay);

    step("reorder(tickets)  →  move 2nd epic into v1.0 × Validate");
    hint("Second epic slides from Backlog into v1.0 × Validate.");
    await c.call("reorder", { entity: "tickets",
      projectId: PID, orderedIds: [epicB.id],
      scope: { releaseId: rel1.id, processStepId: ps3.id, epicId: null }
    });
    await sleep(stepDelay + 600);

    step("reorder(tickets)  →  move story3 from epicA to epicB");
    hint("Story 'Skip-and-explore' flies from Build/epicA across to Validate/epicB.");
    await c.call("reorder", { entity: "tickets",
      projectId: PID, orderedIds: [story3.id],
      scope: { releaseId: rel1.id, processStepId: ps3.id, epicId: epicB.id }
    });
    await sleep(stepDelay + 600);

    step("reorder(tickets)  →  move epicB to v1.1 × Build");
    hint("Entire epicB (with its story) slides into a different release row.");
    await c.call("reorder", { entity: "tickets",
      projectId: PID, orderedIds: [epicB.id],
      scope: { releaseId: rel2.id, processStepId: ps2.id, epicId: null }
    });
    await sleep(stepDelay + 600);

    // -------------------------------------------------------------------
    // Switch focus to Kanban + walk a ticket through statuses
    // -------------------------------------------------------------------
    if (httpUrl) {
      step("→ now please switch to the Kanban view in the browser");
      hint("The next steps move tickets between Kanban LANES — that's where FLIP shines.");
      await sleep(3500);
    }

    step("DoR + mark_ready  →  story1 to 'ready' lane");
    await c.call("set_checklist_item", { gate: "dor", checked: true, projectId: PID, ticketId: story1.id, itemId: "dor-acceptance" });
    await c.call("set_checklist_item", { gate: "dor", checked: true, projectId: PID, ticketId: story1.id, itemId: "dor-clarity" });
    await c.call("mark_ready", { projectId: PID, ticketId: story1.id });
    hint("story1 slides from Backlog to Ready (lane-to-lane FLIP).");
    await sleep(stepDelay);

    step("change_ticket_status  →  story1 to 'in-progress'");
    await c.call("change_ticket_status", { projectId: PID, ticketId: story1.id, status: "in-progress" });
    hint("Same card slides one lane further right.");
    await sleep(stepDelay);

    step("DoR + status walk for story2");
    await c.call("set_checklist_item", { gate: "dor", checked: true, projectId: PID, ticketId: story2.id, itemId: "dor-acceptance" });
    await c.call("set_checklist_item", { gate: "dor", checked: true, projectId: PID, ticketId: story2.id, itemId: "dor-clarity" });
    await c.call("mark_ready", { projectId: PID, ticketId: story2.id });
    await sleep(stepDelay);
    await c.call("change_ticket_status", { projectId: PID, ticketId: story2.id, status: "in-progress" });
    hint("story2 follows story1 into the in-progress lane.");
    await sleep(stepDelay);

    step("reorder(tickets)  →  swap order of story1 and story2 within in-progress");
    hint("Pure intra-lane reorder — both cards swap positions with a smooth FLIP.");
    await c.call("reorder", { entity: "tickets",
      projectId: PID, orderedIds: [story2.id, story1.id]
    });
    await sleep(stepDelay + 600);

    step("DoR + status walk through review + done for story1");
    await c.call("change_ticket_status", { projectId: PID, ticketId: story1.id, status: "review" });
    await sleep(stepDelay);
    await c.call("set_checklist_item", { gate: "dod", checked: true, projectId: PID, ticketId: story1.id, itemId: "dod-tests" });
    await c.call("set_checklist_item", { gate: "dod", checked: true, projectId: PID, ticketId: story1.id, itemId: "dod-review" });
    await c.call("complete_ticket", { projectId: PID, ticketId: story1.id });
    hint("story1 lands in Done — final FLIP.");
    await sleep(stepDelay);

    // -------------------------------------------------------------------
    // Done — leave the data behind so the user can inspect it
    // -------------------------------------------------------------------
    console.log(`\n${COLOR.bold}${COLOR.green}✓ Walkthrough complete${COLOR.reset}`);
    console.log(`${COLOR.gray}Project:  ${PID}${COLOR.reset}`);
    if (cleanup) console.log(`${COLOR.gray}(ephemeral data dir will be cleaned up)${COLOR.reset}`);
    else         console.log(`${COLOR.gray}Data remains in ${dataDir}${COLOR.reset}`);
  } finally {
    c.close();
    if (cleanup) {
      try { await fs.promises.rm(dataDir, { recursive: true, force: true }); } catch {}
    }
  }
}

main().catch((e) => { console.error(`\n${COLOR.red}✗ ${e.message}${COLOR.reset}\n${e.stack}`); process.exit(1); });
