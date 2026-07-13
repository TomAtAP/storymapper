"use strict";

// SM-199 R-3: convert a source document (a PRD attachment) to Markdown,
// server-side, with a deliberately tiny dependency surface:
//   - pdf2json (zero transitive deps, pure JS, NO OCR, NO runtime CDN) for PDF
//   - fflate   (zero transitive deps) to unzip .docx, then a minimal hand-
//     rolled OOXML→Markdown walk
//   - .md / .txt are read natively (zero deps)
//
// This replaces the originally-scoped `officeparser`, which pulled tesseract.js
// (OCR, runtime-CDN traineddata fetch) + a pdf.js worker as HARD deps — 40
// packages for a feature that never needs OCR. The two libs here are loaded
// lazily (require inside the binary paths) so md/txt ingestion has zero cost.
//
// The hard parsing logic lives in PURE helpers (`docxXmlToMarkdown`,
// `pdfDataToText`) that are unit-tested directly; the binary unzip/parse
// wrappers around the third-party libs are thin.

const FORMAT = { MD: "md", TXT: "txt", DOCX: "docx", PDF: "pdf" };

// Map a {filename, mimeType} to a supported format, or null if unsupported.
function detectFormat(meta) {
  meta = meta || {};
  const name = String(meta.filename || "").toLowerCase();
  const mime = String(meta.mimeType || "").toLowerCase();
  if (name.endsWith(".md") || name.endsWith(".markdown") || mime === "text/markdown") return FORMAT.MD;
  if (name.endsWith(".txt") || mime === "text/plain") return FORMAT.TXT;
  if (name.endsWith(".docx") || mime.indexOf("officedocument.wordprocessingml") >= 0) return FORMAT.DOCX;
  if (name.endsWith(".pdf") || mime === "application/pdf") return FORMAT.PDF;
  return null;
}

// Decode the five predefined XML entities + numeric refs. `&amp;` is decoded
// LAST so an encoded "&amp;lt;" doesn't become "<".
function decodeXmlEntities(s) {
  return String(s)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    // numeric refs: decimal + hex, full Unicode (astral-safe via fromCodePoint)
    .replace(/&#(\d+);/g, (_, d) => _fromCp(parseInt(d, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => _fromCp(parseInt(h, 16)))
    .replace(/&amp;/g, "&");
}
function _fromCp(cp) {
  return (Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff) ? String.fromCodePoint(cp) : "";
}

// docx (Office Open XML) word/document.xml → Markdown. Each <w:p> paragraph
// becomes: a heading (#-level) when its <w:pStyle> is a Heading/Title style, a
// "- " list item when it carries <w:numPr>, else a plain paragraph. Inline text
// is the concatenation of the paragraph's <w:t> runs. Deliberately minimal —
// it covers the PRD subset (headings + paragraphs + lists), not full OOXML.
function docxXmlToMarkdown(xml) {
  if (typeof xml !== "string" || !xml) return "";
  const bodyMatch = xml.match(/<w:body[^>]*>([\s\S]*?)<\/w:body>/);
  const body = bodyMatch ? bodyMatch[1] : xml;
  const out = [];
  const paraRe = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g;
  let m;
  while ((m = paraRe.exec(body)) !== null) {
    const p = m[1];
    // Walk inline content IN ORDER so tabs/line-breaks between runs keep their
    // separators — concatenating only <w:t> would mash "Col1<tab>Col2" into
    // "Col1Col2". <w:tab/> → tab, <w:br/> → newline.
    let text = "";
    const inlineRe = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/?>|<w:br\b[^>]*\/?>/g;
    let tm;
    while ((tm = inlineRe.exec(p)) !== null) {
      if (tm[1] !== undefined) text += decodeXmlEntities(tm[1]);
      else if (tm[0].indexOf("<w:tab") === 0) text += "\t";
      else text += "\n";
    }
    text = text.replace(/[ \t]+\n/g, "\n").trim();
    if (!text) continue;

    const styleMatch = p.match(/<w:pStyle\b[^>]*w:val="([^"]*)"/i);
    const style = styleMatch ? styleMatch[1] : "";
    if (/^title$/i.test(style)) { out.push("# " + text); continue; }
    // Heading style: must START with the heading token + a level digit, with a
    // word boundary after — so a custom style merely CONTAINING the word (e.g.
    // "Heading1Char", "Heading2Caption", "NotAHeading4") is NOT promoted.
    const hMatch = style.match(/^(?:heading|überschrift|berschrift)\s*([1-6])\b/i);
    if (hMatch) {
      const lvl = Math.min(6, Math.max(1, parseInt(hMatch[1], 10)));
      out.push("#".repeat(lvl) + " " + text);
      continue;
    }
    if (/<w:numPr\b/.test(p)) { out.push("- " + text); continue; }
    out.push(text);
  }
  return out.join("\n\n");
}

// pdf2json "pdfParser_dataReady" payload → plain text. Text runs (Page.Texts[])
// are grouped into lines by rounded y, ordered left→right by x, and pages are
// separated by a blank line. Each run's URL-encoded text (R[].T) is decoded.
// Pure — testable with a synthetic payload, no real PDF needed.
// Insert a space between two same-line runs whose x-gap (next.x − prev right
// edge) exceeds this (pdf2json page units). Keeps mid-word run splits glued
// (tiny gap) while separating genuinely-spaced tokens that carry no explicit
// whitespace.
const PDF_GAP_SPACE = 0.3;

function pdfDataToText(data) {
  if (!data || !Array.isArray(data.Pages)) return "";
  const pages = [];
  for (const page of data.Pages) {
    const texts = Array.isArray(page.Texts) ? page.Texts : [];
    const lines = new Map(); // yBucket -> [{x, w, t}]
    for (const t of texts) {
      const y = Math.round((t.y || 0) * 2) / 2; // 0.5-unit buckets
      const runs = Array.isArray(t.R) ? t.R : [];
      let s = "";
      for (const r of runs) {
        const raw = r && r.T != null ? r.T : "";
        try { s += decodeURIComponent(raw); } catch (_e) { s += raw; }
      }
      if (!lines.has(y)) lines.set(y, []);
      lines.get(y).push({ x: t.x || 0, w: t.w || 0, t: s });
    }
    const ys = Array.from(lines.keys()).sort((a, b) => a - b);
    const pageLines = ys.map(y => {
      const runs = lines.get(y).sort((a, b) => a.x - b.x);
      let s = "";
      for (let k = 0; k < runs.length; k++) {
        if (k > 0) {
          const prev = runs[k - 1];
          const gap = runs[k].x - (prev.x + prev.w);
          // Don't double-space when one side already carries whitespace.
          if (gap > PDF_GAP_SPACE && !/\s$/.test(s) && !/^\s/.test(runs[k].t)) s += " ";
        }
        s += runs[k].t;
      }
      return s.replace(/\s+$/, "");
    });
    pages.push(pageLines.join("\n").trim());
  }
  return pages.filter(Boolean).join("\n\n");
}

// Thin binary wrappers around the lazy-loaded libs.

function docxBufferToMarkdown(buffer) {
  const { unzipSync, strFromU8 } = require("fflate");
  const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let files;
  try {
    files = unzipSync(u8);
  } catch (e) {
    // A truncated/corrupt upload is a client problem, not a 500 — surface it
    // with the same structured shape as the unsupported-format path.
    throw Object.assign(new Error("corrupt or unreadable .docx archive"),
      { statusCode: 422, kind: "INGEST_CORRUPT" });
  }
  const doc = files["word/document.xml"];
  if (!doc) return "";
  return docxXmlToMarkdown(strFromU8(doc));
}

function pdfBufferToText(buffer) {
  const PDFParser = require("pdf2json");
  return new Promise((resolve, reject) => {
    const parser = new PDFParser(null, false);
    parser.on("pdfParser_dataError", err => reject((err && err.parserError) || err));
    parser.on("pdfParser_dataReady", data => {
      try { resolve(pdfDataToText(data)); } catch (e) { reject(e); }
    });
    parser.parseBuffer(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer));
  });
}

// Top-level: a buffer + {filename, mimeType} → { format, markdown }.
// Throws { statusCode: 415, kind: "INGEST_FORMAT" } for an unsupported format.
async function ingestToMarkdown(buffer, meta) {
  const fmt = detectFormat(meta);
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  let markdown;
  switch (fmt) {
    case FORMAT.MD:
    case FORMAT.TXT:
      markdown = buf.toString("utf8");
      break;
    case FORMAT.DOCX:
      markdown = docxBufferToMarkdown(buf);
      break;
    case FORMAT.PDF:
      markdown = await pdfBufferToText(buf);
      break;
    default:
      throw Object.assign(
        new Error("unsupported ingest format: " + ((meta && (meta.filename || meta.mimeType)) || "?")),
        { statusCode: 415, kind: "INGEST_FORMAT" }
      );
  }
  // Normalize to LF so downstream slicing + reconciliation see consistent
  // offsets regardless of the source's line endings.
  markdown = String(markdown).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return { format: fmt, markdown: markdown };
}

module.exports = {
  FORMAT,
  detectFormat,
  decodeXmlEntities,
  docxXmlToMarkdown,
  pdfDataToText,
  docxBufferToMarkdown,
  pdfBufferToText,
  ingestToMarkdown
};
