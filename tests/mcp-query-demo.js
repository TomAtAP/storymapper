#!/usr/bin/env node
"use strict";

/**
 * MCP query_tickets walkthrough (SM-187 / SM-190). NOT part of the unit suite.
 *
 * Seeds a small but varied project, then runs a series of `query_tickets` calls
 * to exercise the JQL-angelehnte language end-to-end over the real MCP stdio
 * bridge — including the structured error path.
 *
 *   node tests/mcp-query-demo.js                       # ephemeral tmpdir (cleaned up)
 *   node tests/mcp-query-demo.js --data-dir=./.storymap-data --http-url=http://localhost:8770
 *       └─ seeds into the LIVE server's data-dir and nudges the browser to switch
 *          (so you can then type the same queries into the smart-bar yourself).
 *
 * Never deletes a user-supplied --data-dir; only ephemeral tmpdirs it created.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const COLOR = { reset: "\x1b[0m", bold: "\x1b[1m", gray: "\x1b[90m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", cyan: "\x1b[36m" };
const info = (m) => console.log(`    ${COLOR.gray}·${COLOR.reset} ${m}`);
const okk  = (m) => console.log(`    ${COLOR.green}✓${COLOR.reset} ${m}`);

class McpClient {
  constructor(child) {
    this.child = child; this.nextId = 1; this.pending = new Map(); this.buf = "";
    child.stdout.on("data", (d) => {
      this.buf += d.toString();
      let nl;
      while ((nl = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, nl); this.buf = this.buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id && this.pending.has(msg.id)) { this.pending.get(msg.id).resolve(msg); this.pending.delete(msg.id); }
      }
    });
    child.stderr.on("data", () => {});
  }
  send(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params: params || {} }) + "\n");
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error("timeout: " + method)); } }, 8000);
    });
  }
  async call(name, args) {
    const msg = await this.send("tools/call", { name, arguments: args || {} });
    if (msg.error) throw new Error(msg.error.message);
    const r = msg.result || {};
    const text = r.content && r.content[0] && r.content[0].text;
    let parsed = null; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    return { isError: !!r.isError, body: parsed };
  }
  close() { try { this.child.stdin.end(); } catch {} try { this.child.kill(); } catch {} }
}

async function spawnMcp(dataDir, httpUrl) {
  const indexPath = path.resolve(__dirname, "..", "server", "index.js");
  const env = Object.assign({}, process.env);
  if (httpUrl) env.STORYMAP_HTTP_URL = httpUrl;
  const child = spawn(process.execPath, [indexPath, "mcp", "--data-dir=" + dataDir], { stdio: ["pipe", "pipe", "pipe"], env });
  const client = new McpClient(child);
  await client.send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "query-demo", version: "0.1" } });
  client.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  return client;
}

function parseCli(argv) {
  const out = { dataDir: null, httpUrl: null };
  for (const a of argv.slice(2)) {
    if (a.startsWith("--data-dir=")) out.dataDir = a.slice(11);
    else if (a.startsWith("--http-url=")) out.httpUrl = a.slice(11);
    else if (a === "-h" || a === "--help") {
      console.log("usage: node tests/mcp-query-demo.js [--data-dir=PATH] [--http-url=URL]");
      process.exit(0);
    }
  }
  return out;
}

async function runQuery(c, projectId, query, note) {
  const { isError, body } = await c.call("query_tickets", { projectId, query });
  console.log("");
  console.log(`  ${COLOR.cyan}${query}${COLOR.reset}` + (note ? `   ${COLOR.gray}# ${note}${COLOR.reset}` : ""));
  if (isError) {
    console.log(`    ${COLOR.red}✗ ${body.kind}: ${body.error}${COLOR.reset}` + (typeof body.position === "number" ? `  (pos ${body.position})` : ""));
    return;
  }
  okk(`${body.count} result(s): ` + body.tickets.map((t) => `${t.ticketKey} ${t.title} [${t.status}]`).join("  |  "));
}

async function main() {
  const cli = parseCli(process.argv);
  const dataDir = cli.dataDir ? path.resolve(cli.dataDir) : await fs.promises.mkdtemp(path.join(os.tmpdir(), "sm-query-demo-"));
  const cleanup = !cli.dataDir;
  const httpUrl = cli.httpUrl;
  console.log(`${COLOR.bold}MCP query_tickets walkthrough${COLOR.reset}`);
  console.log(`${COLOR.gray}data dir: ${dataDir}${COLOR.reset}`);
  if (httpUrl) console.log(`${COLOR.gray}http url: ${httpUrl}  ${COLOR.yellow}(a browser switch-confirm will appear)${COLOR.reset}`);

  const c = await spawnMcp(dataDir, httpUrl);
  const PID = "query-demo-" + Date.now().toString(36);
  try {
    info("seeding a varied project…");
    await c.call("project_create", { id: PID, name: "Query Demo", ticketPrefix: "QD" });
    const relA = (await c.call("release_create", { projectId: PID, name: "v1.0" })).body.release;
    const relB = (await c.call("release_create", { projectId: PID, name: "Durchgängige Traceability" })).body.release;
    const step = (await c.call("process_step_create", { projectId: PID, name: "Build" })).body.processStep;
    const epic = (await c.call("ticket_create", { projectId: PID, type: "epic", title: "Authentication", position: { releaseId: relA.id, processStepId: step.id } })).body.ticket;

    // NB: a `contains` link (epic→story) makes the story INHERIT the epic's
    // release (SM-67). So only contain stories that belong in the epic's release
    // (relA here); the relB stories stay uncontained so they keep relB.
    const mk = async (type, title, status, labels, releaseId, contain) => {
      const t = (await c.call("ticket_create", { projectId: PID, type, title, position: { releaseId: releaseId || relA.id } })).body.ticket;
      if (status && status !== "backlog") await c.call("ticket_update", { projectId: PID, ticketId: t.id, patch: { status: status } });
      if (labels && labels.length) await c.call("ticket_update", { projectId: PID, ticketId: t.id, patch: { labels: labels } });
      if (contain) await c.call("link_create", { projectId: PID, sourceTicketId: epic.id, linkTypeId: "contains", targetTicketId: t.id });
      return t;
    };
    await mk("user-story", "Login form",      "ready",       ["frontend"],           relA.id, true);
    await mk("user-story", "Password reset",  "in-progress", ["frontend", "backend"], relA.id, true);
    await mk("user-story", "Session expiry",  "done",        ["backend"],            relB.id, false);
    await mk("bug",        "Crash on submit", "ready",       ["urgent"],             relA.id, true);
    await mk("user-story", "Remember me",     "backlog",     [],                     relB.id, false);
    okk("seeded: 1 epic, 4 stories, 1 bug across 2 releases (relB stories uncontained — see SM-67)");

    if (httpUrl) {
      info("asking the browser to switch to the demo project…");
      try { await c.call("request_switch_project", { projectId: PID, reason: "Query-demo project — switch over to try the queries in the smart-bar.", wait_seconds: 30 }); } catch (e) { info("switch skipped: " + e.message); }
    }

    console.log(`\n${COLOR.bold}  Queries${COLOR.reset}`);
    await runQuery(c, PID, "type = user-story", "all stories");
    await runQuery(c, PID, "status IN (ready, in-progress)", "open work");
    await runQuery(c, PID, "type = user-story AND status = done", "finished stories");
    await runQuery(c, PID, "text ~ login", "full-text");
    await runQuery(c, PID, "label = frontend", "by label");
    await runQuery(c, PID, "epic = " + epic.ticketKey, "contained by the epic");
    await runQuery(c, PID, "release = v1.0", "by release (v1.0)");
    await runQuery(c, PID, 'release = "Durchgängige Traceability"', "by release name (quoted)");
    await runQuery(c, PID, "type != bug ORDER BY status", "ordered, bugs excluded");
    await runQuery(c, PID, "type = user-story AND NOT label = frontend", "boolean NOT");
    console.log(`\n${COLOR.bold}  Structured errors${COLOR.reset}`);
    await runQuery(c, PID, "status ~ ready", "operator not allowed on an enum field");
    await runQuery(c, PID, "assignee = me", "unknown field");
    await runQuery(c, PID, "type =", "syntax error (missing value)");

    console.log("");
    okk("done.");
    if (!httpUrl) info("tip: re-run with --data-dir=./.storymap-data --http-url=http://localhost:8770 to try it live in the browser.");
  } finally {
    c.close();
    if (cleanup) { try { await fs.promises.rm(dataDir, { recursive: true, force: true }); } catch {} }
  }
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
