"use strict";

// Tiny sequential test loader for the native-mcp package. Mirrors the parent
// project's runner: each test-*.js file may export a `done` promise that is
// awaited before moving on; otherwise a small fixed yield covers async tests.

const path = require("path");
const fs = require("fs");

const dir = __dirname;
const files = fs.readdirSync(dir)
  .filter(f => f.startsWith("test-") && f.endsWith(".js"))
  .sort();

(async () => {
  for (const f of files) {
    process.exitCode = process.exitCode || 0;
    const mod = require(path.join(dir, f));
    if (mod && typeof mod === "object" && mod.done && typeof mod.done.then === "function") {
      try { await mod.done; } catch (_) { /* failure already reported + exitCode set */ }
    } else {
      await new Promise(r => setTimeout(r, 250));
    }
  }
})();
