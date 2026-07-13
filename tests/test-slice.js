"use strict";

// SM-200 R-4: server/slice.js — pure Markdown pre-slicing.

const assert = require("assert");
const { sliceMarkdown } = require("../server/slice.js");

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  - ${name}`); passed++; }
  catch (err) { console.log(`  FAIL - ${name}\n         ${err.stack || err.message}`); failed++; process.exitCode = 1; }
}

test("sliceMarkdown: empty / whitespace → []", () => {
  assert.deepStrictEqual(sliceMarkdown(""), []);
  assert.deepStrictEqual(sliceMarkdown("   \n  \n"), []);
  assert.deepStrictEqual(sliceMarkdown(null), []);
});

test("sliceMarkdown: no headings → one whole-document section", () => {
  const s = sliceMarkdown("just some prose\nover two lines");
  assert.strictEqual(s.length, 1);
  assert.deepStrictEqual(
    { p: s[0].sectionPath, level: s[0].level, heading: s[0].heading, body: s[0].body },
    { p: "1", level: 0, heading: "", body: "just some prose\nover two lines" }
  );
  assert.strictEqual(s[0].charStart, 0);
});

test("sliceMarkdown: nested headings get hierarchical DOORS section paths", () => {
  const md = [
    "# Overview",
    "intro text",
    "## Auth",
    "auth body",
    "## Roles",
    "roles body",
    "# Data",
    "data body"
  ].join("\n");
  const s = sliceMarkdown(md);
  assert.deepStrictEqual(s.map(x => [x.sectionPath, x.heading]), [
    ["1", "Overview"],
    ["1.1", "Auth"],
    ["1.2", "Roles"],
    ["2", "Data"]
  ]);
  // body excludes the heading line, trimmed
  assert.strictEqual(s[0].body, "intro text");
  assert.strictEqual(s[1].body, "auth body");
});

test("sliceMarkdown: a document that starts at ## still numbers from 1", () => {
  const md = "## First\na\n### Deep\nb\n## Second\nc";
  const s = sliceMarkdown(md);
  assert.deepStrictEqual(s.map(x => x.sectionPath), ["1", "1.1", "2"]);
  assert.deepStrictEqual(s.map(x => x.level), [2, 3, 2]);
});

test("sliceMarkdown: content before the first heading becomes a preamble (path '0')", () => {
  const md = "Document title line\n\n# Section One\nbody";
  const s = sliceMarkdown(md);
  assert.strictEqual(s[0].sectionPath, "0");
  assert.strictEqual(s[0].level, 0);
  assert.strictEqual(s[0].body, "Document title line");
  assert.strictEqual(s[1].sectionPath, "1");
  assert.strictEqual(s[1].heading, "Section One");
});

test("sliceMarkdown: charStart/charEnd cover each section incl. its heading line", () => {
  const md = "# A\nbody a\n# B\nbody b";
  const s = sliceMarkdown(md);
  // slicing the original by the offsets reproduces the section, heading first
  assert.strictEqual(md.slice(s[0].charStart, s[0].charEnd), "# A\nbody a\n");
  assert.strictEqual(md.slice(s[1].charStart, s[1].charEnd), "# B\nbody b");
  // ranges are contiguous and cover the whole doc
  assert.strictEqual(s[0].charStart, 0);
  assert.strictEqual(s[s.length - 1].charEnd, md.length);
});

test("sliceMarkdown: closing-hash ATX headings (## Foo ##) parse cleanly", () => {
  const s = sliceMarkdown("## Foo ##\nbody");
  assert.strictEqual(s[0].heading, "Foo");
  assert.strictEqual(s[0].sectionPath, "1");
});

test("sliceMarkdown: deterministic / idempotent on the same input", () => {
  const md = "# A\nx\n## B\ny";
  assert.deepStrictEqual(sliceMarkdown(md), sliceMarkdown(md));
});

test("SM-200 review: CRLF (Windows/Word) line endings still detect headings", () => {
  const md = "# A\r\nbody a\r\n## B\r\nbody b\r\n";
  const s = sliceMarkdown(md);
  assert.deepStrictEqual(s.map(x => [x.sectionPath, x.heading]), [["1", "A"], ["1.1", "B"]]);
  assert.ok(!s.some(x => /\r/.test(x.body) || /\r/.test(x.heading)), "no stray CR survives");
});

test("SM-200 review: skipped heading levels never collide on sectionPath", () => {
  // # A, then ### Deep (skips ##), then ## Mid → Deep and Mid must differ.
  const s = sliceMarkdown("# A\n### Deep\n## Mid\n#### X\n# B");
  const paths = s.map(x => x.sectionPath);
  assert.deepStrictEqual(paths, ["1", "1.1", "1.2", "1.2.1", "2"]);
  assert.strictEqual(new Set(paths).size, paths.length, "all sectionPaths unique");
});

test("SM-200 review: ATX-looking lines inside a fenced code block aren't headings", () => {
  const md = "# Real\nintro\n```\n# not a heading\n## also not\n```\n## After\nbody";
  const s = sliceMarkdown(md);
  assert.deepStrictEqual(s.map(x => x.heading), ["Real", "After"]);
});

console.log(`\n  ${passed} passed, ${failed} failed`);
