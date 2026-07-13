"use strict";

/**
 * SM-181 R-9 — reproducible PRD → requirements-layer walkthrough (direction A).
 *
 * Drives the full round over the MCP stdio surface: a project-level PRD
 * attachment → ingest_slice_candidates (server converts to Markdown + pre-slices
 * at headings) → spec_module_create → a `requirement` SpecObject per section
 * (with a sourceAnchor back into the PRD) → implementing stories + `realises`
 * links + one test-definition + a `tests` link → get_trace_coverage. The
 * structural slicing is the server's; the natural-language extraction is the
 * agent's (here, a deterministic distillation so the demo is reproducible).
 *
 * NOT part of the unit suite — invoked manually as a smoke / demo.
 *
 * Usage:
 *   node tests/mcp-prd-slicing-demo.js
 *       → ephemeral /tmp data-dir, cleaned up; offline.
 *
 *   node tests/mcp-prd-slicing-demo.js --data-dir=./.storymap-data --http-url=http://localhost:8770
 *       → writes into your running server's data-dir; calls
 *         request_switch_project so your browser loads the project and you can
 *         open View ▸ Requirements to watch the coverage live.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const C = { reset: "\x1b[0m", bold: "\x1b[1m", green: "\x1b[32m", red: "\x1b[31m",
  cyan: "\x1b[36m", gray: "\x1b[90m", yellow: "\x1b[33m", plum: "\x1b[35m" };
let stepN = 0;
function step(name, payload) {
  stepN++;
  console.log(`\n${C.bold}${C.cyan}[${stepN}] ${name}${C.reset}` +
    (payload != null ? `  ${C.gray}${typeof payload === "string" ? payload : JSON.stringify(payload)}${C.reset}` : ""));
}
function ok(m)   { console.log(`    ${C.green}✓${C.reset} ${m}`); }
function info(m) { console.log(`    ${C.gray}·${C.reset} ${m}`); }
function warn(m) { console.log(`    ${C.yellow}!${C.reset} ${m}`); }

class McpClient {
  constructor(child) {
    this.child = child; this.nextId = 1; this.pending = new Map(); this.buf = "";
    child.stdout.on("data", (chunk) => {
      this.buf += chunk.toString("utf8");
      let nl;
      while ((nl = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, nl); this.buf = this.buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id != null && this.pending.has(msg.id)) {
          const { resolve } = this.pending.get(msg.id); this.pending.delete(msg.id); resolve(msg);
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
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error("timeout: " + method)); } }, 15000);
    });
  }
  async call(name, args) {
    const msg = await this.send("tools/call", { name, arguments: args || {} });
    if (msg.error) { const e = new Error(msg.error.message); e.code = msg.error.code; throw e; }
    const r = msg.result || {};
    const text = r.content && r.content[0] && r.content[0].text;
    let parsed = null; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    if (r.isError) { const e = new Error((parsed && parsed.error) || "tool error"); e.kind = parsed && parsed.kind; throw e; }
    return parsed;
  }
  close() { try { this.child.stdin.end(); } catch {} try { this.child.kill(); } catch {} }
}

async function spawnMcp(dataDir, httpUrl) {
  const indexPath = path.resolve(__dirname, "..", "server", "index.js");
  const env = Object.assign({}, process.env);
  if (httpUrl) env.STORYMAP_HTTP_URL = httpUrl;
  const child = spawn(process.execPath, [indexPath, "mcp", "--data-dir=" + dataDir], { stdio: ["pipe", "pipe", "pipe"], env });
  const client = new McpClient(child);
  await client.send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "prd-slicing-demo", version: "0.1" } });
  client.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  return client;
}

function parseCli(argv) {
  const out = { dataDir: null, httpUrl: null };
  for (const a of argv.slice(2)) {
    if (a.startsWith("--data-dir=")) out.dataDir = a.slice("--data-dir=".length);
    else if (a.startsWith("--http-url=")) out.httpUrl = a.slice("--http-url=".length);
    else if (a === "--help" || a === "-h") {
      console.log("usage: node tests/mcp-prd-slicing-demo.js [--data-dir=PATH] [--http-url=URL]");
      process.exit(0);
    }
  }
  return out;
}

// An example PRD (Markdown). Two top-level features, each with two sub-sections.
const PRD = [
  "# Profile Editing",
  "Users manage their own account profile from a settings page.",
  "",
  "## Edit display name",
  "The user can change their display name. It must be 2 to 50 characters.",
  "",
  "## Change avatar",
  "The user can upload a new avatar image (PNG or JPG, max 2 MB).",
  "",
  "# Notifications",
  "Users control how and when the product notifies them.",
  "",
  "## Email notifications",
  "The user can enable or disable email notifications per category.",
  "",
  "## Quiet hours",
  "The user can define quiet hours during which no push notifications are sent."
].join("\n");

// Deterministic "extraction": turn a section into one atomic requirement
// statement. A real agent would do this with judgement; we keep it fixed so the
// demo is reproducible.
function distil(section) {
  const h = section.heading || "(preamble)";
  const body = (section.body || "").replace(/\s+/g, " ").trim();
  return "The system shall support: " + h + (body ? " — " + body : "");
}

async function main() {
  const cli = parseCli(process.argv);
  const dataDir = cli.dataDir ? path.resolve(cli.dataDir)
    : await fs.promises.mkdtemp(path.join(os.tmpdir(), "sm-prd-slicing-"));
  const httpUrl = cli.httpUrl;
  const cleanup = !cli.dataDir;
  console.log(`${C.bold}PRD → requirements-layer walkthrough (direction A)${C.reset}`);
  console.log(`${C.gray}data dir: ${dataDir}${C.reset}`);
  if (httpUrl) console.log(`${C.gray}http url: ${httpUrl}  ${C.yellow}(browser switch-confirm will appear)${C.reset}`);

  const c = await spawnMcp(dataDir, httpUrl);
  const PID = "prd-slicing-" + Date.now().toString(36);
  try {
    step("project_create", { id: PID, prefix: "PS" });
    await c.call("project_create", { id: PID, name: "PRD Slicing Demo", ticketPrefix: "PS" });
    ok("project created");

    step("attachment_put", "the PRD as a PROJECT-level attachment (no ticketId)");
    const att = await c.call("attachment_put", {
      projectId: PID, filename: "product.prd.md", mimeType: "text/markdown",
      contentBase64: Buffer.from(PRD, "utf8").toString("base64")
    });
    ok("attachment " + att.attachment.id + " (" + att.attachment.size + " bytes)");

    if (httpUrl) {
      step("request_switch_project", "ask the browser to load this project");
      const sw = await c.call("request_switch_project", { workspace: PID,
        reason: "PRD slicing demo — open View ▸ Requirements to watch the coverage.", wait_seconds: 60 });
      if (sw.timedOut) warn("no browser response in 60s — continuing");
      else if (sw.response && sw.response.accepted) ok("browser switched");
    }

    step("ingest_slice_candidates", "server converts to Markdown + pre-slices at headings");
    const sliced = await c.call("ingest_slice_candidates", { attachmentId: att.attachment.id });
    ok(sliced.format + " → " + sliced.sectionCount + " candidate sections");
    for (const s of sliced.sections) info(`${s.sectionPath}  ${s.heading}  [${s.charStart}-${s.charEnd}]`);

    step("spec_module_create", "the per-document container (DOORS module)");
    const mod = await c.call("spec_module_create", { projectId: PID, title: "Product PRD", sourceAttachmentId: att.attachment.id });
    ok("module " + mod.ticket.ticketKey);

    step("requirement_create × " + sliced.sections.length, "one atomic requirement per section, anchored to its source span");
    const reqByPath = {};
    for (const s of sliced.sections) {
      const r = await c.call("requirement_create", {
        projectId: PID, moduleId: mod.ticket.id, title: distil(s), sectionPath: s.sectionPath,
        sourceAnchor: { attachmentId: att.attachment.id, sectionId: s.sectionPath, charStart: s.charStart, charEnd: s.charEnd }
      });
      reqByPath[s.sectionPath] = r.ticket;
      info(`${r.ticket.ticketKey}  §${s.sectionPath}  ${r.ticket.title}`);
    }

    step("build + anchor", "implementing stories realises requirements; a test-definition tests one");
    // Cover 1.1 and 1.2; over-cover 2.1 (two implementers); leave 2.2 orphan;
    // make 2 (Notifications) suspect (tested, not implemented).
    const impl = async (title, targetPath) => {
      const story = await c.call("ticket_create", { projectId: PID, type: "user-story", title });
      await c.call("link_create", { projectId: PID, sourceTicketId: story.ticket.id, linkTypeId: "realises", targetTicketId: reqByPath[targetPath].id });
      ok(story.ticket.ticketKey + " realises §" + targetPath);
    };
    await impl("Build display-name editor", "1.1");
    await impl("Build avatar upload", "1.2");
    await impl("Email prefs UI", "2.1");
    await impl("Email prefs API", "2.1");   // → over-covered
    const td = await c.call("ticket_create", { projectId: PID, type: "test-definition", title: "Test: notification controls" });
    await c.call("link_create", { projectId: PID, sourceTicketId: td.ticket.id, linkTypeId: "tests", targetTicketId: reqByPath["2"].id });
    ok(td.ticket.ticketKey + " tests §2 (→ suspect: tested, not implemented)");

    step("get_trace_coverage", "the direction-A completeness report");
    const cov = await c.call("get_trace_coverage", { projectId: PID, moduleId: mod.ticket.id });
    for (const r of cov.requirements) {
      const tag = r.status === "covered" ? C.green : r.status === "orphan" ? C.red
        : r.status === "suspect" ? C.plum : C.yellow;
      console.log(`    ${tag}${r.status.padEnd(12)}${C.reset} §${r.sectionPath}  ${r.title}`);
    }
    const s = cov.summary;
    console.log(`\n    ${C.bold}Σ ${s.total}${C.reset}  covered ${s.covered} · over-covered ${s.overCovered} · orphan ${s.orphan} · suspect ${s.suspect}`);

    console.log(`\n${C.bold}${C.green}PRD slicing walkthrough OK${C.reset}  (${stepN} steps)`);
    if (httpUrl) console.log(`${C.gray}Open View ▸ Requirements in the browser to compare source ↔ slices.${C.reset}`);
  } finally {
    c.close();
    if (cleanup) { try { await fs.promises.rm(dataDir, { recursive: true, force: true }); } catch {} }
  }
}

main().catch((err) => {
  console.error(`\n${C.bold}${C.red}WALKTHROUGH FAILED${C.reset}`);
  console.error(err);
  process.exit(1);
});
