"use strict";

const path = require("path");
const fs = require("fs");

const dir = __dirname;
function testFilesIn(d) {
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d)
    .filter(f => f.startsWith("test-") && f.endsWith(".js"))
    .sort()
    .map(f => path.join(d, f));
}
// Storymapper's own tests + the in-repo native-mcp package's own tests (SM-312),
// so a single `npm test` covers both. (When native-mcp is later split into its
// own repo, this second directory simply won't exist and is skipped.)
const files = [
  ...testFilesIn(dir),
  ...testFilesIn(path.resolve(dir, "..", "packages", "native-mcp", "test"))
];

(async () => {
  for (const f of files) {
    process.exitCode = process.exitCode || 0;
    const mod = require(f);
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
