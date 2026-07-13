"use strict";

// SM-200 R-4: algorithmic pre-slicing. Split a Markdown document at ATX
// headings (`#`..`######`) into an ordered list of candidate sections, each
// tagged with a DOORS-style `sectionPath` derived from the heading hierarchy
// (the ReqIF Specification tree). Pure, zero-dependency, deterministic.
//
// This runs BEFORE the LLM: it guarantees that every section of the source is
// presented for requirement extraction (less omission), and the per-section
// char ranges (charStart/charEnd) anchor the reconciliation UI (R-7) back to
// the source text. The agent (R-5/R-9) turns each section's body into atomic
// requirement slices; this module does NO natural-language work — only
// structural splitting.

// ATX heading: 1–6 leading '#', a space, the text, optional trailing '#'s.
const HEADING_RE = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;

// A fenced-code-block opener/closer: ``` or ~~~ (optionally indented ≤3).
const FENCE_RE = /^ {0,3}(```|~~~)/;

// Find heading lines with level, text, and character offset into `md`. Skips
// ATX-looking lines INSIDE fenced code blocks (a real concern for raw .md
// PRDs). Assumes `md` already has LF-only line endings.
function _findHeadings(md) {
  const heads = [];
  let offset = 0;
  let inFence = false;
  const lines = md.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE_RE.test(line)) { inFence = !inFence; offset += line.length + 1; continue; }
    if (!inFence) {
      const m = line.match(HEADING_RE);
      if (m) heads.push({ level: m[1].length, text: m[2].trim(), start: offset, lineLen: line.length });
    }
    offset += line.length + 1; // +1 for the consumed "\n"
  }
  return heads;
}

/**
 * Slice Markdown into ordered candidate sections.
 *
 * @param {string} md
 * @returns {Array<{sectionPath, level, heading, body, charStart, charEnd}>}
 *   - sectionPath: DOORS-style dotted id ("1", "1.1", "2"), numbered by NESTING
 *     DEPTH (level-stack) so a doc that starts at `##` still yields "1" and
 *     skipped levels (# → ###) still get a UNIQUE path; never collides.
 *   - level: the actual ATX heading level (1..6); 0 for a pre-heading preamble
 *     or a heading-less document.
 *   - heading: the heading text (without '#'); "" for preamble / no headings.
 *   - body: the section's text AFTER its heading line, up to the next heading,
 *     trimmed.
 *   - charStart/charEnd: offsets into `md` covering the whole section
 *     (heading line included), for source highlighting.
 */
function sliceMarkdown(md) {
  if (typeof md !== "string" || md.trim() === "") return [];
  // Normalize line endings up front so heading detection + char offsets are
  // consistent: a CRLF (Windows/Word-exported) PRD would otherwise leave a
  // stray "\r" that defeats HEADING_RE and collapses the whole doc.
  md = md.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const heads = _findHeadings(md);

  // No headings → the whole document is one addressable section.
  if (heads.length === 0) {
    return [{ sectionPath: "1", level: 0, heading: "", body: md.trim(), charStart: 0, charEnd: md.length }];
  }

  const sections = [];

  // Preamble: non-whitespace content before the first heading.
  const firstStart = heads[0].start;
  if (md.slice(0, firstStart).trim() !== "") {
    sections.push({ sectionPath: "0", level: 0, heading: "",
      body: md.slice(0, firstStart).trim(), charStart: 0, charEnd: firstStart });
  }

  // Number sections by NESTING DEPTH using a level-stack, not by absolute
  // heading level. This guarantees a UNIQUE monotonic sectionPath even when
  // intermediate levels are skipped (# directly to ###, then back to ##):
  // each heading is the next child of its nearest shallower ancestor. `level`
  // still carries the true ATX depth for callers that need it.
  const stack = [];      // ancestry: entries { level }
  const counters = [];   // counters[depth] = current sibling number at that depth
  for (let i = 0; i < heads.length; i++) {
    const h = heads[i];
    while (stack.length && stack[stack.length - 1].level >= h.level) stack.pop();
    const depth = stack.length;
    counters[depth] = (counters[depth] || 0) + 1;
    counters.length = depth + 1; // reset any deeper counters
    stack.push({ level: h.level });
    const sectionPath = counters.slice(0, depth + 1).join(".");
    const charStart = h.start;
    const charEnd = (i + 1 < heads.length) ? heads[i + 1].start : md.length;
    const bodyStart = h.start + h.lineLen + 1; // skip the heading line + its "\n"
    const body = (bodyStart <= charEnd ? md.slice(bodyStart, charEnd) : "").trim();
    sections.push({ sectionPath, level: h.level, heading: h.text, body, charStart, charEnd });
  }
  return sections;
}

module.exports = { sliceMarkdown, HEADING_RE };
