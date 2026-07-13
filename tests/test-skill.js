"use strict";

/**
 * SM-108 — skill accuracy guard.
 *
 * skill/SKILL.md is agent-facing documentation. Its single biggest failure
 * mode is drift: referencing an MCP tool that no longer exists (or never
 * did). This test extracts every snake_case, backtick-wrapped token from the
 * skill that LOOKS like an MCP tool name and asserts it is actually
 * registered in server/mcp.js. If the skill names a tool, that tool must be
 * real.
 *
 * Non-tool snake_case tokens that legitimately appear in backticks (tool
 * PARAMETERS, governance keys, …) are allow-listed below.
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  - ${name}`); passed++; }
  catch (err) { console.log(`  FAIL - ${name}\n         ${err.stack || err.message}`); failed++; process.exitCode = 1; }
}

// SM-175: the skill is now SKILL.md (always-loaded core) + reference/*.md
// (loaded on demand). The accuracy guard scans the WHOLE corpus so a stale
// tool name can't hide in a reference file.
const SKILL_DIR = path.join(__dirname, "..", "skill");
function readSkillCorpus() {
  let corpus = fs.readFileSync(path.join(SKILL_DIR, "SKILL.md"), "utf8");
  const refDir = path.join(SKILL_DIR, "reference");
  if (fs.existsSync(refDir)) {
    for (const f of fs.readdirSync(refDir).sort()) {
      if (f.endsWith(".md")) corpus += "\n" + fs.readFileSync(path.join(refDir, f), "utf8");
    }
  }
  return corpus;
}
const SKILL = readSkillCorpus();
const MCP   = fs.readFileSync(path.join(__dirname, "..", "server", "mcp.js"), "utf8");

// Registered tools: server.registerTool("name", …), plus the makeItemTool(name,…)
// helper that registers the DoR/DoD item tools under a literal first arg.
function registeredTools() {
  const set = new Set();
  const re = /(?:registerTool|makeItemTool)\(\s*["']([a-z][a-z0-9_]*)["']/g;
  let m;
  while ((m = re.exec(MCP)) !== null) set.add(m[1]);
  return set;
}

// snake_case tokens (lowercase, ≥1 underscore) that appear inside `backticks`
// in the skill. Tool-family shorthands like `_update` start with `_` and are
// excluded by the leading [a-z] anchor.
function backtickSnakeTokens(md) {
  const tokens = new Set();
  const spanRe = /`([^`]+)`/g;
  const tokRe  = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;
  let span;
  while ((span = spanRe.exec(md)) !== null) {
    let t;
    while ((t = tokRe.exec(span[1])) !== null) tokens.add(t[0]);
  }
  return tokens;
}

// snake_case tokens that are NOT tools (params, config keys, …).
const NON_TOOL_ALLOWLIST = new Set([
  "wait_seconds",    // request_switch_project param
  "tool_action",     // governance config key
  "kanban_columns",  // SM-164 get_config/set_config section identifier
  "link_types",      // SM-164 get_config/set_config section identifier
  "process_steps",   // SM-165 reorder entity identifier
]);

test("SM-108: every registerTool name is captured by the parser (sanity)", () => {
  const tools = registeredTools();
  assert.ok(tools.size >= 40, `expected the MCP surface to be large, got ${tools.size}`);
  // Spot-check a few that must exist.
  for (const t of ["list_tickets", "ticket_create", "link_create", "complete_ticket", "bulk_change_status"]) {
    assert.ok(tools.has(t), `parser missed registered tool ${t}`);
  }
});

test("SM-108: every tool-shaped token referenced in SKILL.md is a real registered tool", () => {
  const tools = registeredTools();
  const referenced = backtickSnakeTokens(SKILL);
  const unknown = [];
  for (const tok of referenced) {
    if (NON_TOOL_ALLOWLIST.has(tok)) continue;
    if (!tools.has(tok)) unknown.push(tok);
  }
  assert.deepStrictEqual(unknown, [],
    "SKILL.md references tokens that look like tools but aren't registered (or add to NON_TOOL_ALLOWLIST): "
      + unknown.join(", "));
});

test("SM-108: SKILL.md does NOT reference the removed tolerateJsonString restart footgun", () => {
  assert.ok(!/tolerateJsonString/.test(SKILL),
    "stale tolerateJsonString note should be gone (the bug is fixed)");
});

test("SM-108: SKILL.md documents the link system + bulk tools + agent-first framing", () => {
  for (const needle of [
    "link_create", "list_links_for_ticket", "get_config",
    "bulk_change_status", "bulk_ticket_update", "bulk_link_create",
    "agent-first", "Dependency view", "contains` link", "compact"
  ]) {
    assert.ok(SKILL.includes(needle), `SKILL.md should mention "${needle}"`);
  }
});

setImmediate(() => { console.log(`\n  ${passed} passed, ${failed} failed`); });
