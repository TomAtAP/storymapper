"use strict";

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
    // Async-aware: test files that export `done` (a Promise) are awaited
    // until completion; otherwise fall back to a small fixed yield like
    // cmapper's loader.
    if (mod && typeof mod === "object" && mod.done && typeof mod.done.then === "function") {
      try { await mod.done; } catch (_) { /* test failure already reported */ }
    } else {
      await new Promise(r => setTimeout(r, 250));
    }
  }
})();
