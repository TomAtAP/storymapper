"use strict";

/**
 * SM-316 — install or package the companion skill.
 *
 *   npm run install-skill                    → ~/.claude/skills/storymap  (Claude Code, personal)
 *   npm run install-skill -- --target=DIR   → DIR/storymap               (project dir / any harness)
 *   npm run package-skill                    → dist/storymap-skill.zip    (Claude Desktop upload,
 *                                              portable Markdown package for other harnesses)
 *   node scripts/install-skill.js --zip=OUT → custom zip path
 *
 * Copies skill/ (SKILL.md + reference/) recursively; an existing
 * installation is updated in place (overwrite). The zip is built with
 * fflate (already a runtime dependency) — entries live under a single
 * `storymap/` root folder, the layout Claude Desktop expects.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

const SKILL_NAME = "storymap";
const SRC = path.resolve(__dirname, "..", "skill");
const DEFAULT_ZIP = path.resolve(__dirname, "..", "dist", `${SKILL_NAME}-skill.zip`);

function parseArgs(argv) {
  const opts = { target: undefined, zip: undefined, help: false };
  for (const a of argv) {
    if (a.startsWith("--target=")) opts.target = a.slice("--target=".length);
    else if (a === "--zip") opts.zip = DEFAULT_ZIP;
    else if (a.startsWith("--zip=")) opts.zip = path.resolve(a.slice("--zip=".length));
    else if (a === "--help" || a === "-h") opts.help = true;
  }
  return opts;
}

function listFiles(dir, rel) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? path.join(rel, e.name) : e.name;
    if (e.isDirectory()) out.push(...listFiles(path.join(dir, e.name), r));
    else out.push(r);
  }
  return out.sort();
}

function buildZip(outPath) {
  const { zipSync } = require("fflate");
  const entries = {};
  for (const f of listFiles(SRC, "")) {
    const entry = `${SKILL_NAME}/` + f.split(path.sep).join("/");
    entries[entry] = new Uint8Array(fs.readFileSync(path.join(SRC, f)));
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, Buffer.from(zipSync(entries)));
  console.log(`Packaged the '${SKILL_NAME}' skill as ${outPath}`);
  for (const e of Object.keys(entries).sort()) console.log(`  ${e}`);
  console.log(`\n${Object.keys(entries).length} files. Upload the zip in Claude Desktop`
    + " (Settings → Capabilities → Skills), or unpack it for any other harness.");
  return 0;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log("Usage: node scripts/install-skill.js [--target=SKILLS_DIR | --zip[=OUT]]");
    console.log(`Default target: ${path.join(os.homedir(), ".claude", "skills")}`);
    console.log(`Default zip:    ${DEFAULT_ZIP}`);
    return 0;
  }
  if (!fs.existsSync(path.join(SRC, "SKILL.md"))) {
    console.error(`skill source not found at ${SRC}`);
    return 1;
  }
  if (opts.zip) return buildZip(opts.zip);

  const skillsDir = opts.target
    ? path.resolve(opts.target)
    : path.join(os.homedir(), ".claude", "skills");
  const dest = path.join(skillsDir, SKILL_NAME);

  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(SRC, dest, { recursive: true, force: true });

  const files = listFiles(dest, "");
  console.log(`Installed the '${SKILL_NAME}' skill to ${dest}`);
  for (const f of files) console.log(`  ${f}`);
  console.log(`\n${files.length} files. Restart your Claude session to pick it up.`);
  return 0;
}

process.exitCode = main();
