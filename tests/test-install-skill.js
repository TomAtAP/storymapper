"use strict";

/**
 * SM-316 — Skill-Installation via `npm run install-skill`.
 *
 * Spawnt scripts/install-skill.js als Subprocess (wie ein User es täte)
 * und prüft:
 *  - Default-Ziel ist $HOME/.claude/skills/storymap (HOME via env gefaked).
 *  - --target=DIR installiert nach DIR/storymap.
 *  - Re-Run aktualisiert eine bestehende Installation (Overwrite).
 *  - Ausgabe nennt das Ziel und die kopierten Dateien.
 *
 * Tests berühren ausschliesslich mkdtemp-Verzeichnisse.
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

const SCRIPT = path.resolve(__dirname, "..", "scripts", "install-skill.js");
const SKILL_SRC = path.resolve(__dirname, "..", "skill");

function runInstall(args, env) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    env: Object.assign({}, process.env, env || {})
  });
}

/** Every file under skill/ (relative paths) — the copy contract. */
function skillFiles() {
  const out = [];
  (function walk(dir, rel) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else out.push(r);
    }
  })(SKILL_SRC, "");
  return out.sort();
}

test("default target is $HOME/.claude/skills/storymap", async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "storymap-skill-home-"));
  const res = runInstall([], { HOME: home, USERPROFILE: home });
  assert.strictEqual(res.status, 0, `exit 0 expected, got ${res.status}\n${res.stderr}`);
  const dest = path.join(home, ".claude", "skills", "storymap");
  for (const f of skillFiles()) {
    assert.ok(fs.existsSync(path.join(dest, f)), `missing ${f} in default install`);
  }
});

test("--target=DIR installs into DIR/storymap", async () => {
  const target = await fsp.mkdtemp(path.join(os.tmpdir(), "storymap-skill-target-"));
  const res = runInstall([`--target=${target}`]);
  assert.strictEqual(res.status, 0, `exit 0 expected, got ${res.status}\n${res.stderr}`);
  const dest = path.join(target, "storymap");
  for (const f of skillFiles()) {
    assert.ok(fs.existsSync(path.join(dest, f)), `missing ${f} in --target install`);
  }
  // Copies are byte-identical to the source.
  const src = fs.readFileSync(path.join(SKILL_SRC, "SKILL.md"), "utf8");
  assert.strictEqual(fs.readFileSync(path.join(dest, "SKILL.md"), "utf8"), src);
});

test("re-run updates an existing installation (overwrite)", async () => {
  const target = await fsp.mkdtemp(path.join(os.tmpdir(), "storymap-skill-update-"));
  assert.strictEqual(runInstall([`--target=${target}`]).status, 0);
  const installed = path.join(target, "storymap", "SKILL.md");
  await fsp.writeFile(installed, "stale local copy\n");
  assert.strictEqual(runInstall([`--target=${target}`]).status, 0);
  const src = fs.readFileSync(path.join(SKILL_SRC, "SKILL.md"), "utf8");
  assert.strictEqual(fs.readFileSync(installed, "utf8"), src, "re-run must overwrite stale files");
});

test("output names the destination and the copied files", async () => {
  const target = await fsp.mkdtemp(path.join(os.tmpdir(), "storymap-skill-out-"));
  const res = runInstall([`--target=${target}`]);
  assert.ok(res.stdout.includes(path.join(target, "storymap")), "stdout names the destination");
  assert.ok(res.stdout.includes("SKILL.md"), "stdout lists SKILL.md");
  assert.ok(/reference[\/\\]anatomy\.md/.test(res.stdout), "stdout lists reference files");
});

test("--zip=OUT builds a portable skill package (storymap/ root, byte-identical files)", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "storymap-skill-zip-"));
  const out = path.join(dir, "storymap-skill.zip");
  const res = runInstall([`--zip=${out}`]);
  assert.strictEqual(res.status, 0, `exit 0 expected, got ${res.status}\n${res.stderr}`);
  assert.ok(fs.existsSync(out), "zip file exists");
  const { unzipSync } = require("fflate");
  const entries = unzipSync(new Uint8Array(fs.readFileSync(out)));
  const names = Object.keys(entries).sort();
  for (const f of skillFiles()) {
    const entry = "storymap/" + f.split(path.sep).join("/");
    assert.ok(names.includes(entry), `zip misses ${entry}`);
    const src = fs.readFileSync(path.join(SKILL_SRC, f));
    assert.ok(Buffer.from(entries[entry]).equals(src), `zip entry ${entry} differs from source`);
  }
  assert.ok(res.stdout.includes(out), "stdout names the zip path");
});

test("--zip without value defaults to dist/storymap-skill.zip (repo-relative)", async () => {
  const distZip = path.resolve(__dirname, "..", "dist", "storymap-skill.zip");
  await fsp.rm(distZip, { force: true });
  const res = runInstall(["--zip"]);
  assert.strictEqual(res.status, 0, `exit 0 expected, got ${res.status}\n${res.stderr}`);
  assert.ok(fs.existsSync(distZip), "dist/storymap-skill.zip exists");
  const { unzipSync } = require("fflate");
  const entries = unzipSync(new Uint8Array(fs.readFileSync(distZip)));
  assert.ok(Object.keys(entries).includes("storymap/SKILL.md"), "contains storymap/SKILL.md");
});

module.exports.done = (test._chain || Promise.resolve()).then(() => {
  console.log(`\n  ${passed} passed, ${failed} failed`);
});
