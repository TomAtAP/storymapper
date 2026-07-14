"use strict";

/**
 * SM-319 — One-Step-Installation pro Oberfläche.
 *
 *   node scripts/install.js claude-desktop  → claude_desktop_config.json-Merge + Skill-Zip
 *   node scripts/install.js claude-code     → Skill-Copy + `claude mcp add` (CLI, Fallback: Befehl drucken)
 *
 * Tests berühren ausschliesslich mkdtemp-Verzeichnisse; die claude-CLI wird
 * durch einen Stub (CLAUDE_CLI env) ersetzt.
 */

const { spawnSync } = require("child_process");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");
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

const SCRIPT = path.resolve(__dirname, "..", "scripts", "install.js");
const SERVER_INDEX = path.resolve(__dirname, "..", "server", "index.js");

function run(args, env) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    env: Object.assign({}, process.env, env || {})
  });
}

test("claude-desktop: fresh config gets the storymapper server + zip is built", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "storymap-setup-d1-"));
  const cfg = path.join(dir, "claude_desktop_config.json");
  const zip = path.join(dir, "skill.zip");
  const dataDir = path.join(dir, "data");
  const res = run(["claude-desktop", `--config=${cfg}`, `--zip=${zip}`, `--data-dir=${dataDir}`]);
  assert.strictEqual(res.status, 0, `exit 0 expected\n${res.stderr}`);
  const conf = JSON.parse(fs.readFileSync(cfg, "utf8"));
  const entry = conf.mcpServers && conf.mcpServers.storymapper;
  assert.ok(entry, "mcpServers.storymapper exists");
  assert.ok(path.isAbsolute(entry.command), "command is an absolute path (Desktop has no shell PATH)");
  assert.ok(entry.args.includes(SERVER_INDEX), "args contain the absolute server/index.js");
  assert.ok(entry.args.includes("mcp"), "args contain the mcp subcommand");
  assert.ok(entry.args.includes(`--data-dir=${dataDir}`), "args carry the absolute data dir");
  assert.ok(fs.existsSync(zip), "skill zip was built");
});

test("claude-desktop: existing config is merged (other servers survive), .bak written, re-run idempotent", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "storymap-setup-d2-"));
  const cfg = path.join(dir, "claude_desktop_config.json");
  fs.writeFileSync(cfg, JSON.stringify({
    mcpServers: { other: { command: "other-cmd", args: [] }, storymapper: { command: "stale", args: [] } },
    globalShortcut: "Cmd+Space"
  }, null, 2));
  const res = run(["claude-desktop", `--config=${cfg}`, `--zip=${path.join(dir, "s.zip")}`]);
  assert.strictEqual(res.status, 0, `exit 0 expected\n${res.stderr}`);
  assert.ok(fs.existsSync(cfg + ".bak"), "backup of the previous config exists");
  const conf = JSON.parse(fs.readFileSync(cfg, "utf8"));
  assert.strictEqual(conf.mcpServers.other.command, "other-cmd", "other servers survive the merge");
  assert.strictEqual(conf.globalShortcut, "Cmd+Space", "unrelated top-level keys survive");
  assert.notStrictEqual(conf.mcpServers.storymapper.command, "stale", "stale entry was updated");
  // Idempotent re-run: same result, no duplicate keys, still exit 0.
  const res2 = run(["claude-desktop", `--config=${cfg}`, `--zip=${path.join(dir, "s.zip")}`]);
  assert.strictEqual(res2.status, 0);
  const conf2 = JSON.parse(fs.readFileSync(cfg, "utf8"));
  assert.deepStrictEqual(Object.keys(conf2.mcpServers).sort(), ["other", "storymapper"]);
});

test("claude-desktop: output names config path, the one remaining upload step and the restart", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "storymap-setup-d3-"));
  const cfg = path.join(dir, "claude_desktop_config.json");
  const res = run(["claude-desktop", `--config=${cfg}`, `--zip=${path.join(dir, "s.zip")}`]);
  assert.ok(res.stdout.includes(cfg), "stdout names the config path");
  assert.ok(/Settings\s*→\s*Capabilities\s*→\s*Skills/i.test(res.stdout), "stdout names the upload location");
  assert.ok(/restart/i.test(res.stdout), "stdout mentions the restart");
});

async function writeClaudeStub(dir) {
  const log = path.join(dir, "claude-args.log");
  const stub = path.join(dir, "claude-stub");
  fs.writeFileSync(stub,
    `#!/usr/bin/env node\nrequire("fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");\n`);
  fs.chmodSync(stub, 0o755);
  return { stub, log };
}

test("claude-code: installs the skill AND registers the MCP server via the claude CLI", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "storymap-setup-c1-"));
  const home = path.join(dir, "home");
  const { stub, log } = await writeClaudeStub(dir);
  const res = run(["claude-code", `--data-dir=${path.join(dir, "data")}`],
    { HOME: home, USERPROFILE: home, CLAUDE_CLI: stub });
  assert.strictEqual(res.status, 0, `exit 0 expected\n${res.stderr}`);
  assert.ok(fs.existsSync(path.join(home, ".claude", "skills", "storymap", "SKILL.md")),
    "skill installed under $HOME/.claude/skills/storymap");
  const calls = fs.readFileSync(log, "utf8").trim().split("\n").map(l => JSON.parse(l));
  const add = calls.find(c => c[0] === "mcp" && c[1] === "add");
  assert.ok(add, "claude mcp add was invoked");
  assert.ok(add.includes("storymapper"), "server name is storymapper");
  assert.ok(add.includes("-s") && add.includes("user"), "registered in user scope");
  assert.ok(add.includes(SERVER_INDEX), "args carry the absolute server/index.js");
  assert.ok(add.includes("mcp"), "args carry the mcp subcommand");
});

test("claude-code: missing claude CLI → skill still installed, ready-made command printed, exit 0", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "storymap-setup-c2-"));
  const home = path.join(dir, "home");
  const res = run(["claude-code"], { HOME: home, USERPROFILE: home, CLAUDE_CLI: path.join(dir, "nope") });
  assert.strictEqual(res.status, 0, `exit 0 expected\n${res.stderr}`);
  assert.ok(fs.existsSync(path.join(home, ".claude", "skills", "storymap", "SKILL.md")),
    "skill installed despite missing CLI");
  assert.ok(/claude mcp add storymapper/.test(res.stdout), "fallback prints the ready-made command");
});

module.exports.done = (test._chain || Promise.resolve()).then(() => {
  console.log(`\n  ${passed} passed, ${failed} failed`);
});
