#!/usr/bin/env node
"use strict";

// pack-dereference.js — makes the package npm-publishable despite symlinks.
//
// npm pack/publish silently DROPS symlinks from the tarball. This repo keeps
// shared pure-logic modules as symlinks (frontend/js/core.js -> shared/core.js
// etc., see CLAUDE.md "SM-139 shared-core"), so a naive `npm publish` ships a
// package with a broken frontend.
//
// Usage (wired as npm lifecycle scripts in package.json):
//   node scripts/pack-dereference.js apply     # prepack: symlink -> real copy
//   node scripts/pack-dereference.js restore   # postpack: copy -> symlink
//
// `apply` records every replaced symlink in .pack-symlinks.json so `restore`
// can recreate them exactly. If npm aborts between the two hooks, run
// `restore` manually (the manifest survives on disk).

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const MANIFEST = path.join(ROOT, ".pack-symlinks.json");
// Only the directories that end up in the npm tarball (package.json "files").
const SCAN_DIRS = ["server", "shared", "frontend", "skill"];

function findSymlinks(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      out.push(full);
    } else if (entry.isDirectory() && entry.name !== "node_modules") {
      findSymlinks(full, out);
    }
  }
  return out;
}

function apply() {
  if (fs.existsSync(MANIFEST)) {
    console.error(
      "pack-dereference: " + MANIFEST + " already exists — a previous restore " +
      "did not run. Run `node scripts/pack-dereference.js restore` first."
    );
    process.exit(1);
  }
  const symlinks = [];
  for (const dir of SCAN_DIRS) {
    const full = path.join(ROOT, dir);
    if (fs.existsSync(full)) findSymlinks(full, symlinks);
  }
  const records = [];
  for (const link of symlinks) {
    const target = fs.readlinkSync(link); // relative target, e.g. ../../shared/core.js
    const resolved = path.resolve(path.dirname(link), target);
    if (!fs.existsSync(resolved)) {
      console.error("pack-dereference: dangling symlink " + link + " -> " + target);
      process.exit(1);
    }
    fs.unlinkSync(link);
    fs.copyFileSync(resolved, link);
    records.push({ path: path.relative(ROOT, link), target });
  }
  fs.writeFileSync(MANIFEST, JSON.stringify(records, null, 2) + "\n");
  console.log("pack-dereference: replaced " + records.length + " symlinks with real copies");
}

function restore() {
  if (!fs.existsSync(MANIFEST)) {
    console.log("pack-dereference: no manifest, nothing to restore");
    return;
  }
  const records = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  for (const rec of records) {
    const full = path.join(ROOT, rec.path);
    if (fs.existsSync(full)) fs.rmSync(full);
    fs.symlinkSync(rec.target, full);
  }
  fs.rmSync(MANIFEST);
  console.log("pack-dereference: restored " + records.length + " symlinks");
}

const mode = process.argv[2];
if (mode === "apply") apply();
else if (mode === "restore") restore();
else {
  console.error("usage: node scripts/pack-dereference.js apply|restore");
  process.exit(1);
}
