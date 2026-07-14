"use strict";

/**
 * SM-319 — one-step installation per surface.
 *
 *   npm run install-code     (node scripts/install.js claude-code)
 *     → installs the companion skill to ~/.claude/skills/storymap
 *     → registers the MCP server via `claude mcp add storymapper -s user …`
 *       (missing CLI → prints the ready-made command instead of failing)
 *
 *   npm run install-desktop  (node scripts/install.js claude-desktop)
 *     → merges the storymapper server into claude_desktop_config.json
 *       (platform path, backup, other servers survive, idempotent)
 *     → builds dist/storymap-skill.zip
 *     → one step remains: upload the zip in Settings → Capabilities → Skills
 *
 * Flags: --data-dir=DIR (default: <repo>/.storymap-data)
 *        --config=PATH  (claude-desktop: config file override)
 *        --zip=OUT      (claude-desktop: zip path override)
 * Env:   CLAUDE_CLI     (claude-code: claude binary override, for tests)
 *
 * Reuses scripts/install-skill.js as a subprocess for the skill copy/zip.
 */

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const REPO = path.resolve(__dirname, "..");
const SERVER_INDEX = path.join(REPO, "server", "index.js");
const SKILL_SCRIPT = path.join(__dirname, "install-skill.js");
const SERVER_NAME = "storymapper";

function parseArgs(argv) {
  const opts = { mode: argv[0], dataDir: undefined, config: undefined, zip: undefined, help: false };
  for (const a of argv.slice(1)) {
    if (a.startsWith("--data-dir=")) opts.dataDir = path.resolve(a.slice("--data-dir=".length));
    else if (a.startsWith("--config=")) opts.config = path.resolve(a.slice("--config=".length));
    else if (a.startsWith("--zip=")) opts.zip = path.resolve(a.slice("--zip=".length));
    else if (a === "--help" || a === "-h") opts.help = true;
  }
  if (!opts.dataDir) opts.dataDir = path.join(REPO, ".storymap-data");
  return opts;
}

function usage() {
  console.log("Usage: node scripts/install.js <claude-code|claude-desktop> [--data-dir=DIR] [--config=PATH] [--zip=OUT]");
}

/** Platform default for Claude Desktop's config file. */
function desktopConfigPath() {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, "Claude", "claude_desktop_config.json");
  }
  return path.join(os.homedir(), ".config", "Claude", "claude_desktop_config.json");
}

function runSkillScript(args) {
  const res = spawnSync(process.execPath, [SKILL_SCRIPT, ...args], { encoding: "utf8" });
  process.stdout.write(res.stdout || "");
  process.stderr.write(res.stderr || "");
  return res.status === 0;
}

function mcpServerEntry(dataDir) {
  // Absolute node path: Claude Desktop spawns servers without a login-shell
  // PATH, so a bare "node" breaks for nvm/homebrew installs.
  return { command: process.execPath, args: [SERVER_INDEX, "mcp", `--data-dir=${dataDir}`] };
}

function installDesktop(opts) {
  const cfgPath = opts.config || desktopConfigPath();
  let conf = {};
  if (fs.existsSync(cfgPath)) {
    try {
      conf = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    } catch (err) {
      console.error(`Cannot parse ${cfgPath}: ${err.message}`);
      console.error("Fix or remove the file, then re-run.");
      return 1;
    }
    fs.copyFileSync(cfgPath, cfgPath + ".bak");
  }
  if (!conf.mcpServers || typeof conf.mcpServers !== "object") conf.mcpServers = {};
  conf.mcpServers[SERVER_NAME] = mcpServerEntry(opts.dataDir);
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify(conf, null, 2) + "\n");
  console.log(`Registered the '${SERVER_NAME}' MCP server in ${cfgPath}`);
  console.log(`  data dir: ${opts.dataDir}`);
  if (fs.existsSync(cfgPath + ".bak")) console.log(`  backup:   ${cfgPath}.bak`);
  console.log("");

  if (!runSkillScript(opts.zip ? [`--zip=${opts.zip}`] : ["--zip"])) return 1;

  console.log("\nOne step remains:");
  console.log("  1. Upload the zip in Claude Desktop under Settings → Capabilities → Skills.");
  console.log("Then fully quit and restart Claude Desktop to load the MCP server.");
  return 0;
}

function installCode(opts) {
  if (!runSkillScript([])) return 1;
  console.log("");

  const entry = mcpServerEntry(opts.dataDir);
  const cli = process.env.CLAUDE_CLI || "claude";
  const addArgs = ["mcp", "add", SERVER_NAME, "-s", "user", "--", entry.command, ...entry.args];
  // Idempotent: drop a stale registration first (failure is fine).
  spawnSync(cli, ["mcp", "remove", SERVER_NAME, "-s", "user"], { encoding: "utf8" });
  const res = spawnSync(cli, addArgs, { encoding: "utf8" });
  if (res.error || res.status !== 0) {
    const cmd = ["claude", ...addArgs].map(a => (/\s/.test(a) ? `"${a}"` : a)).join(" ");
    console.log("The claude CLI was unavailable, so register the MCP server with this command:");
    console.log(`  ${cmd}`);
  } else {
    process.stdout.write(res.stdout || "");
    console.log(`Registered the '${SERVER_NAME}' MCP server (user scope, data dir: ${opts.dataDir}).`);
  }
  console.log("\nRestart your Claude Code session to pick both up.");
  return 0;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.mode) { usage(); return opts.mode ? 0 : 1; }
  if (opts.mode === "claude-desktop") return installDesktop(opts);
  if (opts.mode === "claude-code") return installCode(opts);
  usage();
  return 1;
}

process.exitCode = main();
