"use strict";

// SM-199 R-3: server/ingest.js — document → Markdown conversion.
// Pure helpers (docxXmlToMarkdown, pdfDataToText) are tested directly; the
// docx binary path is exercised by building a real .docx zip with fflate so
// the unzip wrapper is covered without an external fixture. The pdf path's
// reconstruction is covered via a synthetic pdf2json payload (no real PDF —
// pdf2json itself is third-party; we test the part we wrote).

const assert = require("assert");
const { strToU8, zipSync } = require("fflate");
const ingest = require("../server/ingest.js");

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

// ---------------------------------------------------------------------------
// detectFormat
// ---------------------------------------------------------------------------

test("detectFormat: by extension", () => {
  assert.strictEqual(ingest.detectFormat({ filename: "prd.md" }), "md");
  assert.strictEqual(ingest.detectFormat({ filename: "notes.txt" }), "txt");
  assert.strictEqual(ingest.detectFormat({ filename: "Spec.DOCX" }), "docx");
  assert.strictEqual(ingest.detectFormat({ filename: "doc.pdf" }), "pdf");
  assert.strictEqual(ingest.detectFormat({ filename: "image.png" }), null);
});

test("detectFormat: by mime type when name is unhelpful", () => {
  assert.strictEqual(ingest.detectFormat({ filename: "blob", mimeType: "text/markdown" }), "md");
  assert.strictEqual(ingest.detectFormat({ filename: "blob", mimeType: "application/pdf" }), "pdf");
  assert.strictEqual(ingest.detectFormat({ filename: "blob",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }), "docx");
});

// ---------------------------------------------------------------------------
// decodeXmlEntities
// ---------------------------------------------------------------------------

test("decodeXmlEntities: decodes the five predefined + numeric, amp last", () => {
  assert.strictEqual(ingest.decodeXmlEntities("a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;"),
    'a & b <c> "d" \'e\'');
  assert.strictEqual(ingest.decodeXmlEntities("&#65;&#66;"), "AB");
  // amp decoded last → an encoded "&amp;lt;" stays literal "&lt;", not "<"
  assert.strictEqual(ingest.decodeXmlEntities("&amp;lt;"), "&lt;");
});

test("SM-199 review: decodeXmlEntities handles hex + astral code points", () => {
  assert.strictEqual(ingest.decodeXmlEntities("&#x41;&#x42;"), "AB");      // hex
  assert.strictEqual(ingest.decodeXmlEntities("&#128512;"), "\u{1F600}");  // astral (😀)
  assert.strictEqual(ingest.decodeXmlEntities("&#x1F600;"), "\u{1F600}");  // astral hex
});

// ---------------------------------------------------------------------------
// docxXmlToMarkdown (pure)
// ---------------------------------------------------------------------------

const SAMPLE_DOC_XML =
  '<?xml version="1.0"?><w:document xmlns:w="x"><w:body>' +
  '<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>Product Spec</w:t></w:r></w:p>' +
  '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>1 Overview</w:t></w:r></w:p>' +
  '<w:p><w:r><w:t xml:space="preserve">The system </w:t></w:r><w:r><w:t>shall log in.</w:t></w:r></w:p>' +
  '<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>1.1 Auth &amp; Roles</w:t></w:r></w:p>' +
  '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t>First requirement</w:t></w:r></w:p>' +
  '<w:p><w:r><w:t></w:t></w:r></w:p>' +   // empty paragraph → skipped
  '</w:body></w:document>';

test("docxXmlToMarkdown: maps Title/Headings/lists/paragraphs + decodes entities", () => {
  const md = ingest.docxXmlToMarkdown(SAMPLE_DOC_XML);
  assert.strictEqual(md,
    "# Product Spec\n\n" +
    "# 1 Overview\n\n" +
    "The system shall log in.\n\n" +
    "## 1.1 Auth & Roles\n\n" +
    "- First requirement");
});

test("docxXmlToMarkdown: German Überschrift styles map to heading levels", () => {
  const xml = '<w:body><w:p><w:pPr><w:pStyle w:val="berschrift3"/></w:pPr>' +
              '<w:r><w:t>Drei</w:t></w:r></w:p></w:body>';
  assert.strictEqual(ingest.docxXmlToMarkdown(xml), "### Drei");
});

test("docxXmlToMarkdown: empty / non-string input → empty string", () => {
  assert.strictEqual(ingest.docxXmlToMarkdown(""), "");
  assert.strictEqual(ingest.docxXmlToMarkdown(null), "");
});

test("SM-199 review: a style merely CONTAINING 'heading' is NOT promoted to a heading", () => {
  // "Heading1Char" is a real Word built-in linked style — must stay a paragraph.
  const xml = '<w:body>' +
    '<w:p><w:pPr><w:pStyle w:val="Heading1Char"/></w:pPr><w:r><w:t>looks like h1</w:t></w:r></w:p>' +
    '<w:p><w:pPr><w:pStyle w:val="NotAHeading4"/></w:pPr><w:r><w:t>nope</w:t></w:r></w:p>' +
    '<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>real h2</w:t></w:r></w:p>' +
    '</w:body>';
  assert.strictEqual(ingest.docxXmlToMarkdown(xml), "looks like h1\n\nnope\n\n## real h2");
});

test("SM-199 review: w:tab and w:br keep their separators (no word-mashing)", () => {
  const xml = '<w:body><w:p>' +
    '<w:r><w:t>Col1</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>Col2</w:t></w:r>' +
    '<w:r><w:br/></w:r><w:r><w:t>Line2</w:t></w:r>' +
    '</w:p></w:body>';
  assert.strictEqual(ingest.docxXmlToMarkdown(xml), "Col1\tCol2\nLine2");
});

// ---------------------------------------------------------------------------
// pdfDataToText (pure, synthetic pdf2json payload)
// ---------------------------------------------------------------------------

test("pdfDataToText: groups runs into lines by y, orders by x, separates pages", () => {
  const data = {
    Pages: [
      { Texts: [
        { x: 5, y: 2, R: [{ T: "world" }] },
        { x: 1, y: 2, R: [{ T: "hello%20" }] },   // same line, left of "world"
        { x: 1, y: 1, R: [{ T: "Title" }] }        // higher line (smaller y) first
      ] },
      { Texts: [ { x: 1, y: 1, R: [{ T: "page%20two" }] } ] }
    ]
  };
  assert.strictEqual(ingest.pdfDataToText(data), "Title\nhello world\n\npage two");
});

test("pdfDataToText: empty / malformed → empty string", () => {
  assert.strictEqual(ingest.pdfDataToText(null), "");
  assert.strictEqual(ingest.pdfDataToText({}), "");
  assert.strictEqual(ingest.pdfDataToText({ Pages: [] }), "");
});

test("SM-199 review: pdf runs with an x-gap but no explicit space get separated", () => {
  const data = { Pages: [{ Texts: [
    { x: 1, y: 1, w: 2, R: [{ T: "Hello" }] },
    { x: 5, y: 1, w: 2, R: [{ T: "World" }] }   // gap 5-(1+2)=2 > 0.3 → space
  ] }] };
  assert.strictEqual(ingest.pdfDataToText(data), "Hello World");
});

test("SM-199 review: pdf mid-word run split (tiny gap) stays glued", () => {
  const data = { Pages: [{ Texts: [
    { x: 1, y: 1, w: 1.5, R: [{ T: "Hel" }] },
    { x: 2.6, y: 1, w: 1, R: [{ T: "lo" }] }     // gap 2.6-2.5=0.1 < 0.3 → no space
  ] }] };
  assert.strictEqual(ingest.pdfDataToText(data), "Hello");
});

// ---------------------------------------------------------------------------
// ingestToMarkdown (orchestration; async)
// ---------------------------------------------------------------------------

test("ingestToMarkdown: md/txt are read natively as utf8", async () => {
  const r = await ingest.ingestToMarkdown(Buffer.from("# Title\n\nbody", "utf8"), { filename: "x.md" });
  assert.deepStrictEqual(r, { format: "md", markdown: "# Title\n\nbody" });
  const t = await ingest.ingestToMarkdown(Buffer.from("plain", "utf8"), { mimeType: "text/plain" });
  assert.strictEqual(t.format, "txt");
  assert.strictEqual(t.markdown, "plain");
});

test("ingestToMarkdown: a real .docx (zip built with fflate) round-trips to Markdown", async () => {
  // Build a genuine .docx in-memory: a zip whose word/document.xml is our XML.
  const docx = zipSync({ "word/document.xml": strToU8(SAMPLE_DOC_XML) });
  const r = await ingest.ingestToMarkdown(Buffer.from(docx), { filename: "spec.docx" });
  assert.strictEqual(r.format, "docx");
  assert.ok(r.markdown.startsWith("# Product Spec"));
  assert.ok(r.markdown.includes("## 1.1 Auth & Roles"));
  assert.ok(r.markdown.includes("- First requirement"));
});

test("ingestToMarkdown: docx with no word/document.xml → empty markdown (no throw)", async () => {
  const zip = zipSync({ "junk.txt": strToU8("nope") });
  const r = await ingest.ingestToMarkdown(Buffer.from(zip), { filename: "broken.docx" });
  assert.strictEqual(r.markdown, "");
});

test("ingestToMarkdown: unsupported format throws structured 415", async () => {
  await assert.rejects(
    () => ingest.ingestToMarkdown(Buffer.from([1, 2, 3]), { filename: "photo.png" }),
    (e) => e.statusCode === 415 && e.kind === "INGEST_FORMAT"
  );
});

test("SM-199 review: a corrupt .docx (not a zip) throws structured 422, not a 500", async () => {
  await assert.rejects(
    () => ingest.ingestToMarkdown(Buffer.from("this is not a zip archive at all"), { filename: "broken.docx" }),
    (e) => e.statusCode === 422 && e.kind === "INGEST_CORRUPT"
  );
});

test("SM-199 review: md/txt with CRLF endings are normalized to LF", async () => {
  const r = await ingest.ingestToMarkdown(Buffer.from("# A\r\nbody\r\n", "utf8"), { filename: "x.md" });
  assert.strictEqual(r.markdown, "# A\nbody\n");
});

module.exports.done = (test._chain || Promise.resolve()).then(() => {
  console.log(`\n  ${passed} passed, ${failed} failed`);
});
