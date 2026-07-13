// SM-203 R-7: Requirements view — a DOORS-style module view.
//
// A scrollable document rendered as a multi-column table:
//   SOURCE (the PRD, in document order — heading + the original prose) |
//   ID (requirement key) | REQUIREMENT (the extracted statement) | COVERAGE.
// The SOURCE and REQUIREMENT text columns stay PURE so you can read the
// document and compare each slice against its source; all derived metadata
// (id, coverage, counts) lives in separate attribute columns. A source section
// that produced NO requirement is flagged `gap` (slicing-completeness).
//
// Per requirement you can expand the incoming traceability (clickable tickets
// that realise / test it) and act: an `orphan` offers "create implementing
// ticket"; a `gap` source section offers "create requirement".
//
// The pure `buildDocumentModel(snapshot, moduleId, sections)` is unit-tested;
// the DOM render + the async source fetch (injected via ctx.fetchIngest) are
// thin. ctx callbacks: fetchIngest, onOpenTicket, onCreateImplementer,
// onCreateRequirement.
//
// UMD-wrapped: same source runs in the browser AND require()s in Node tests.
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./core.js"), require("./core/graph.js"));
  } else {
    (root.STORYMAP = root.STORYMAP || {}).viewRequirements = factory(
      root.STORYMAP && root.STORYMAP.core,
      root.STORYMAP && root.STORYMAP.coreGraph
    );
  }
}(typeof self !== "undefined" ? self : this, function (core, coreGraph) {
  "use strict";

  const STATUSES = ["covered", "over-covered", "orphan", "suspect"];

  // SM-206: persisted Source/Requirement split (fraction of the flexible width
  // the SOURCE column takes; the rest goes to Requirement). ID + Coverage are
  // fixed attribute columns. Default favours the Source so the document reads
  // wide. Resizable via a divider on the Source header.
  const VR_ID_W = 52, VR_COV_W = 112;          // fixed attribute columns (px)
  const VR_FRAC_KEY = "storymap-vr-source-frac";
  function readSourceFrac() {
    try { const v = parseFloat(localStorage.getItem(VR_FRAC_KEY)); if (v >= 0.2 && v <= 0.85) return v; } catch (_e) {}
    return 0.6;
  }
  function writeSourceFrac(f) { try { localStorage.setItem(VR_FRAC_KEY, String(f)); } catch (_e) {} }
  function clampFrac(f) { return Math.max(0.2, Math.min(0.85, f)); }
  function docGridCols(frac) {
    const f = clampFrac(frac);
    return f.toFixed(3) + "fr " + VR_ID_W + "px " + (1 - f).toFixed(3) + "fr " + VR_COV_W + "px";
  }

  function el(tag, attrs, text) {
    const d = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      if (k === "class") d.className = attrs[k];
      else if (k === "dataset") for (const dk in attrs[k]) d.dataset[dk] = attrs[k][dk];
      else d.setAttribute(k, attrs[k]);
    }
    if (text != null) d.textContent = text;
    return d;
  }

  // ---- PURE: assemble the document model -----------------------------------
  // With source sections → mode "doc": an ordered list of sections, each with
  // its prose + the requirement(s) sliced from it (gap when none). Without
  // source → mode "list": the requirement chain alone (sectionPath order).
  // Incoming trace links are resolved to ticket summaries so they're clickable.
  function buildDocumentModel(snapshot, moduleId, sections) {
    const reqs = (moduleId && core.tickets) ? core.tickets.requirementsInModule(snapshot, moduleId) : [];
    const cov = coreGraph.traceCoverage(snapshot, moduleId ? { moduleId } : {});
    const statusById = new Map(cov.requirements.map(r => [r.id, r]));
    const byId = new Map((snapshot.tickets || []).map(t => [t.id, t]));
    const resolve = (ids) => (ids || []).map(id => {
      const t = byId.get(id);
      return t ? { id: t.id, ticketKey: t.ticketKey, title: t.title, type: t.type, status: t.status }
               : { id: id, ticketKey: id, title: "", type: "", status: "" };
    });
    const requirements = reqs.map(r => {
      const c = statusById.get(r.id) || { status: "orphan", realisedBy: [], testedBy: [] };
      return {
        id: r.id, ticketKey: r.ticketKey, sectionPath: r.sectionPath, title: r.title,
        status: c.status, realisedBy: resolve(c.realisedBy), testedBy: resolve(c.testedBy),
        anchorSectionId: (r.sourceAnchor && r.sourceAnchor.sectionId) || ""
      };
    });
    // Group requirements under their document section by `sectionPath` — that is
    // the field the section rows are matched on below. This is what makes the
    // two-stage flow work (SM-207): one coarse slice → n atomic requirements, all
    // sharing the slice's sectionPath but each carrying its own source char-span
    // (sourceAnchor). Grouping on the anchor's sectionId instead would scatter
    // those n requirements off their section whenever sectionId ≠ sectionPath,
    // making them vanish from the doc view. Fall back to anchorSectionId only
    // when a requirement has no sectionPath at all.
    const bySection = new Map();
    for (const r of requirements) {
      const key = r.sectionPath || r.anchorSectionId;
      if (!bySection.has(key)) bySection.set(key, []);
      bySection.get(key).push(r);
    }

    if (sections && sections.length) {
      let sliced = 0, gaps = 0;
      const secRows = sections.map(s => {
        const rs = bySection.get(s.sectionPath) || [];
        if (rs.length) sliced++; else gaps++;
        return { sectionPath: s.sectionPath, level: s.level || 1, heading: s.heading || "(preamble)",
          body: s.body || "", gap: rs.length === 0, requirements: rs };
      });
      return { mode: "doc", sections: secRows, summary: cov.summary,
        slicing: { sections: sections.length, sliced: sliced, gaps: gaps } };
    }
    return { mode: "list", requirements: requirements, summary: cov.summary, slicing: null };
  }

  function summaryChips(summary) {
    const wrap = el("div", { class: "vr-summary" });
    wrap.appendChild(el("span", { class: "vr-chip vr-chip-total" }, "Σ " + summary.total));
    const map = { covered: summary.covered, "over-covered": summary.overCovered,
                  orphan: summary.orphan, suspect: summary.suspect };
    for (const st of STATUSES) {
      if (!map[st]) continue;
      wrap.appendChild(el("span", { class: "vr-chip vr-badge-" + st }, st + " " + map[st]));
    }
    return wrap;
  }

  // The expandable detail under a requirement: its traceability + actions.
  function requirementDetail(req, handlers) {
    const detail = el("div", { class: "vr-detail" });
    const chipLine = (links, rel) => {
      const line = el("div", { class: "vr-trace-line" });
      line.appendChild(el("span", { class: "vr-trace-rel" }, rel));
      for (const t of links) {
        const chip = el("button", { class: "vr-trace-chip", type: "button", title: "Open " + t.ticketKey });
        chip.appendChild(el("span", { class: "vr-trace-key" }, t.ticketKey));
        if (t.title) chip.appendChild(el("span", { class: "vr-trace-title" }, t.title));
        chip.addEventListener("click", (ev) => { ev.stopPropagation(); if (handlers.onOpenTicket) handlers.onOpenTicket(t.id); });
        line.appendChild(chip);
      }
      return line;
    };
    if (req.realisedBy.length) detail.appendChild(chipLine(req.realisedBy, "realised by"));
    if (req.testedBy.length) detail.appendChild(chipLine(req.testedBy, "tested by"));
    if (req.status === "orphan" && handlers.onCreateImplementer) {
      const act = el("button", { class: "vr-action", type: "button" }, "+ implementing ticket");
      act.addEventListener("click", (ev) => { ev.stopPropagation(); handlers.onCreateImplementer(req); });
      detail.appendChild(act);
    }
    if (req.status === "suspect" && handlers.onCreateImplementer) {
      const act = el("button", { class: "vr-action", type: "button" }, "+ implementing ticket");
      act.addEventListener("click", (ev) => { ev.stopPropagation(); handlers.onCreateImplementer(req); });
      detail.appendChild(act);
    }
    return detail;
  }

  // ---- DOM: the multi-column document --------------------------------------
  function renderDoc(container, model, handlers) {
    container.innerHTML = "";
    container.appendChild(summaryChips(model.summary));

    const grid = el("div", { class: "vr-grid vr-grid-" + model.mode });
    container.appendChild(grid);

    const th = (txt) => el("div", { class: "vr-cell vr-th" }, txt);
    if (model.mode === "doc") {
      // Source header carries a draggable divider that re-splits Source vs
      // Requirement (the two flexible columns). The chosen ratio persists.
      const srcTh = th("Source"); srcTh.classList.add("vr-th-resizable");
      const resizer = el("div", { class: "vr-resizer", title: "Drag to resize" });
      srcTh.appendChild(resizer);
      grid.appendChild(srcTh);
      grid.appendChild(th("ID")); grid.appendChild(th("Requirement")); grid.appendChild(th("Coverage"));
      grid.style.gridTemplateColumns = docGridCols(readSourceFrac());
      let dragging = false;
      const onMove = (ev) => {
        if (!dragging) return;
        const rect = grid.getBoundingClientRect();
        const flexible = rect.width - VR_ID_W - VR_COV_W;
        if (flexible <= 0) return;
        const frac = clampFrac((ev.clientX - rect.left) / flexible);
        grid.style.gridTemplateColumns = docGridCols(frac);
        grid._vrFrac = frac;
      };
      const onUp = () => {
        if (!dragging) return; dragging = false;
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        if (typeof grid._vrFrac === "number") writeSourceFrac(grid._vrFrac);
      };
      resizer.addEventListener("pointerdown", (ev) => {
        ev.preventDefault(); ev.stopPropagation(); dragging = true;
        document.addEventListener("pointermove", onMove);
        document.addEventListener("pointerup", onUp);
      });
    } else {
      grid.appendChild(th("ID")); grid.appendChild(th("Requirement")); grid.appendChild(th("Coverage"));
    }

    const reqCells = (r, startCls) => {
      grid.appendChild(el("div", { class: "vr-cell vr-cell-id " + startCls }, r.ticketKey));
      const reqCell = el("div", { class: "vr-cell vr-cell-req " + startCls });
      // The requirement statement is editable in place; on commit it mirrors
      // straight into its requirement TICKET (the requirement IS a ticket).
      const textEl = el("div", { class: "vr-req-text", contenteditable: "true", spellcheck: "false" }, r.title);
      textEl.addEventListener("mousedown", (ev) => ev.stopPropagation());   // don't toggle detail; place caret
      textEl.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") { ev.preventDefault(); textEl.blur(); }
        if (ev.key === "Escape") { textEl.textContent = r.title; textEl.blur(); }
      });
      textEl.addEventListener("blur", () => {
        const v = textEl.textContent.replace(/\s+/g, " ").trim();
        if (v && v !== r.title && handlers.onEditRequirement) handlers.onEditRequirement(r.id, v);
        else if (!v) textEl.textContent = r.title;   // don't allow empty
      });
      reqCell.appendChild(textEl);
      const detail = requirementDetail(r, handlers);
      detail.style.display = "none";
      reqCell.appendChild(detail);
      grid.appendChild(reqCell);
      // Coverage badge cell doubles as the expand/collapse control for the
      // traceability detail (clicking the editable text must NOT toggle).
      const cov = el("div", { class: "vr-cell vr-cell-cov vr-clickable " + startCls });
      cov.appendChild(el("span", { class: "vr-badge vr-badge-" + r.status }, r.status));
      cov.addEventListener("click", () => {
        const open = detail.style.display === "none";
        detail.style.display = open ? "" : "none";
        reqCell.classList.toggle("vr-open", open);
      });
      grid.appendChild(cov);
    };

    if (model.mode === "doc") {
      if (!model.sections.length) {
        grid.appendChild(el("div", { class: "vr-reqs-empty", style: "grid-column:1/-1" }, "Empty document."));
        return;
      }
      for (const sec of model.sections) {
        const lines = sec.requirements.length ? sec.requirements : [null];
        lines.forEach((r, idx) => {
          const startCls = idx === 0 ? "vr-section-start" : "";
          // SOURCE cell — only on the first line of a section (heading + prose).
          const src = el("div", { class: "vr-cell vr-cell-source " + startCls, dataset: { sectionPath: sec.sectionPath } });
          if (idx === 0) {
            const h = el("div", { class: "vr-h vr-h" + Math.min(6, sec.level) });
            h.appendChild(el("span", { class: "vr-h-path" }, sec.sectionPath));
            h.appendChild(el("span", { class: "vr-h-text" }, sec.heading));
            src.appendChild(h);
            if (sec.body) src.appendChild(el("div", { class: "vr-src-prose selectable" }, sec.body));
          }
          grid.appendChild(src);
          if (r) {
            reqCells(r, startCls);
          } else {
            // gap: no requirement extracted from this source section
            grid.appendChild(el("div", { class: "vr-cell vr-cell-id " + startCls }, ""));
            const gapCell = el("div", { class: "vr-cell vr-cell-req vr-gap-cell " + startCls });
            gapCell.appendChild(el("span", { class: "vr-gap-text" }, "— no requirement —"));
            if (handlers.onCreateRequirement) {
              const act = el("button", { class: "vr-action", type: "button" }, "+ requirement");
              act.addEventListener("click", () => handlers.onCreateRequirement(sec));
              gapCell.appendChild(act);
            }
            grid.appendChild(gapCell);
            const cov = el("div", { class: "vr-cell vr-cell-cov " + startCls });
            cov.appendChild(el("span", { class: "vr-badge vr-badge-orphan" }, "gap"));
            grid.appendChild(cov);
          }
        });
      }
    } else {
      if (!model.requirements.length) {
        grid.appendChild(el("div", { class: "vr-reqs-empty", style: "grid-column:1/-1" },
          handlers.emptyNote || "No requirements in this module yet."));
        return;
      }
      for (const r of model.requirements) reqCells(r, "vr-section-start");
    }
  }

  // ---- mount ---------------------------------------------------------------
  function mount(host, store, ctx) {
    ctx = ctx || {};
    const rootEl = el("div", { class: "vr-root" });
    host.appendChild(rootEl);

    const state = { moduleId: null, sectionsByModule: {}, sourceErr: null, fetching: {} };

    function render() {
      // Focus-guard: never stomp an in-progress inline edit (a contentEditable
      // requirement statement). Defer the re-render until the field blurs.
      const ae = typeof document !== "undefined" && document.activeElement;
      if (ae && rootEl.contains(ae) && ae.isContentEditable) return;
      const snap = store.get();
      const modules = (core.tickets ? core.tickets.specModules(snap) : []);
      rootEl.innerHTML = "";

      const bar = el("div", { class: "vr-bar" });
      bar.appendChild(el("span", { class: "vr-title" }, "Requirements"));
      rootEl.appendChild(bar);

      if (!modules.length) {
        rootEl.appendChild(el("div", { class: "vr-empty" },
          "No spec modules yet. Upload a PRD attachment and decompose it into requirements (via the agent / MCP)."));
        return;
      }
      if (!state.moduleId || !modules.some(m => m.id === state.moduleId)) state.moduleId = modules[0].id;
      const mod = modules.find(m => m.id === state.moduleId);

      const picker = el("select", { class: "vr-module-picker" });
      for (const m of modules) {
        const o = el("option", { value: m.id }, m.title || m.ticketKey);
        if (m.id === state.moduleId) o.selected = true;
        picker.appendChild(o);
      }
      picker.addEventListener("change", () => { state.moduleId = picker.value; render(); });
      bar.appendChild(picker);
      if (!mod.sourceAttachmentId) bar.appendChild(el("span", { class: "vr-note" }, "no source bound"));
      else if (state.sourceErr) bar.appendChild(el("span", { class: "vr-note vr-note-warn" }, "source error: " + state.sourceErr));
      else if (!state.sectionsByModule[mod.id]) bar.appendChild(el("span", { class: "vr-note" }, ctx.fetchIngest ? "loading source…" : "source needs server"));

      const body = el("div", { class: "vr-body" });
      rootEl.appendChild(body);

      const sections = state.sectionsByModule[mod.id] || [];
      const model = buildDocumentModel(snap, mod.id, sections);
      if (model.slicing) {
        const sl = model.slicing;
        bar.appendChild(el("span", { class: "vr-note " + (sl.gaps ? "vr-note-warn" : "vr-note-ok") },
          sl.gaps ? (sl.gaps + " of " + sl.sections + " sections un-sliced") : ("all " + sl.sections + " sections sliced")));
      }
      renderDoc(body, model, {
        onOpenTicket: ctx.onOpenTicket,
        onEditRequirement: ctx.onEditRequirement,
        onCreateImplementer: ctx.onCreateImplementer ? (req) => ctx.onCreateImplementer(req) : null,
        onCreateRequirement: ctx.onCreateRequirement ? (sec) => ctx.onCreateRequirement(mod.id, sec) : null
      });

      if (mod.sourceAttachmentId && ctx.fetchIngest
          && !state.sectionsByModule[mod.id] && !state.fetching[mod.id]) {
        state.fetching[mod.id] = true;
        state.sourceErr = null;
        ctx.fetchIngest(mod.sourceAttachmentId).then(res => {
          state.sectionsByModule[mod.id] = (res && res.sections) || [];
          state.fetching[mod.id] = false;
          if (state.moduleId === mod.id) render();
        }).catch(e => {
          state.fetching[mod.id] = false;
          state.sourceErr = (e && e.message) || "ingest failed";
          if (state.moduleId === mod.id) render();
        });
      }
    }

    const unsub = store.subscribe ? store.subscribe(() => render()) : null;
    render();
    return { unmount() { if (typeof unsub === "function") unsub(); host.innerHTML = ""; } };
  }

  return { mount: mount, buildDocumentModel: buildDocumentModel, docGridCols: docGridCols, clampFrac: clampFrac };
}));
