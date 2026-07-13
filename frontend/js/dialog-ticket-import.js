// SM-289 — Ticket-Import dialog (browser glue over shared/ticket-import.js).
//
// Two steps inside ONE showModal: (1) file upload or pasted text, (2) the
// preview — every row classified as create / update / error (line + reason),
// a mode toggle (create-only / upsert) that re-plans instantly, and Apply.
//
// Apply runs ALL creates/updates through core.ops on a draft snapshot and
// commits ONCE via store.applySnapshot — one undo step, one save, one WS
// push. Error rows are never written. Entry points: Project ▸ Import… and
// the button in the Table view (both call openImportDialog, SM-295).
//
// UMD-wrapped: same source runs in the browser AND require()s in Node tests.
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./core.js"), require("./ticket-import.js"), require("./project-io.js"));
  } else {
    (root.STORYMAP = root.STORYMAP || {}).dialogTicketImport = factory(
      root.STORYMAP && root.STORYMAP.core,
      root.STORYMAP && root.STORYMAP.ticketImport,
      root.STORYMAP && root.STORYMAP.projectIO
    );
  }
}(typeof self !== "undefined" ? self : this, function (core, ticketImport, projectIO) {
  "use strict";

  if (!core) throw new Error("dialog-ticket-import: core module missing");
  if (!ticketImport) throw new Error("dialog-ticket-import: ticket-import module missing");

  /**
   * SM-295: what does the pasted/loaded text contain?
   *  - "project": a storymap-project export envelope OR a bare snapshot
   *    object ({project, tickets[]}) → whole-project import (SM-15 engine).
   *  - "tickets": CSV or a JSON ARRAY of ticket rows → row import (SM-288).
   * A non-array JSON object that is neither is treated as "project" so
   * projectIO.parseImport reports the precise error. Pure.
   */
  function detectImportKind(text) {
    const t = String(text == null ? "" : text).trim();
    if (t.charAt(0) !== "{") return "tickets";
    try {
      const data = JSON.parse(t);
      if (data && (data.format === "storymap-project"
        || (data.snapshot && data.snapshot.project)
        || (data.project && Array.isArray(data.tickets)))) return "project";
    } catch (_e) { /* unparseable object → project branch reports it */ }
    return "project";
  }

  const IMPORT_DIALOG = {
    DEFAULT_MODE: "upsert",
    // Preview table hard-caps its rendered rows; the summary always counts ALL.
    PREVIEW_MAX_ROWS: 200,
    // SM-296: user-adjusted header mappings persist per project.
    MAPPING_STORAGE_PREFIX: "storymap-import-mapping-",
  };

  function storage() {
    try {
      if (typeof localStorage !== "undefined") return localStorage;
      if (typeof window !== "undefined" && window.localStorage) return window.localStorage;
    } catch (_e) { /* opaque origin / privacy mode */ }
    return null;
  }

  /**
   * Read the per-project mapping config: { headers: {}, values: {} }.
   * SM-297 extended the stored shape from a flat header map to
   * { headers, values } — the legacy flat shape is migrated on read.
   */
  function readMappingFromStorage(projectId) {
    const ls = storage();
    if (!ls || !projectId) return { headers: {}, values: {} };
    try {
      const raw = ls.getItem(IMPORT_DIALOG.MAPPING_STORAGE_PREFIX + projectId);
      const data = raw ? JSON.parse(raw) : null;
      if (!data || typeof data !== "object" || Array.isArray(data)) return { headers: {}, values: {} };
      if (data.headers || data.values) {
        return {
          headers: (data.headers && typeof data.headers === "object") ? data.headers : {},
          values: (data.values && typeof data.values === "object") ? data.values : {}
        };
      }
      return { headers: data, values: {} };   // legacy flat header map
    } catch (_e) { return { headers: {}, values: {} }; }
  }

  function writeMappingToStorage(projectId, headers, values) {
    const ls = storage();
    if (!ls || !projectId) return;
    try {
      ls.setItem(IMPORT_DIALOG.MAPPING_STORAGE_PREFIX + projectId,
        JSON.stringify({ headers: headers || {}, values: values || {} }));
    }
    catch (_e) { /* quota — mapping just won't persist */ }
  }

  // SM-290: the apply logic moved into the shared engine — the MCP tool and
  // this dialog run the IDENTICAL code (one revision / one undo step each).
  const applyImportPlan = ticketImport.applyImportPlan;

  function el(tag, attrs, text) {
    const d = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      if (k === "class") d.className = attrs[k];
      else d.setAttribute(k, attrs[k]);
    }
    if (text != null) d.textContent = text;
    return d;
  }

  function renderPreview(host, plan, state) {
    host.innerHTML = "";
    const sum = el("div", { class: "ti-summary" },
      plan.creates.length + " neu · " + plan.updates.length + " aktualisiert · " + plan.errors.length + " Fehler");
    host.appendChild(sum);
    const table = el("table", { class: "ti-preview" });
    const thead = el("thead");
    const hr = el("tr");
    ["Zeile", "Aktion", "Ticket", "Detail"].forEach((h) => hr.appendChild(el("th", null, h)));
    thead.appendChild(hr);
    table.appendChild(thead);
    const tbody = el("tbody");
    const rows = [];
    // SM-297 (user finding): errors are LINE-oriented — one preview row per
    // CSV line, labelled with the line's own content (title/key), all
    // problems joined as "field: message" (the message carries the value).
    const errByLine = new Map();
    plan.errors.forEach((e) => {
      const arr = errByLine.get(e.line) || [];
      arr.push(e);
      errByLine.set(e.line, arr);
    });
    errByLine.forEach((list, line) => {
      const data = (state && state.rowsByLine && state.rowsByLine.get(line)) || {};
      const label = (data.title && String(data.title).trim())
        || (data.key && String(data.key).trim()) || "(ohne Titel)";
      rows.push({
        line: line, kind: "error", label: label,
        detail: list.map((e) => (e.field ? e.field + ": " : "") + e.message).join(" · ")
      });
    });
    plan.creates.forEach((c) => rows.push({ line: c.line, kind: "create", label: c.ticket.title, detail: c.ticket.type }));
    plan.updates.forEach((u) => rows.push({
      line: u.line, kind: "update", label: u.ticketKey,
      detail: Object.keys(u.patch).length ? Object.keys(u.patch).join(", ") : "keine Änderungen"
    }));
    rows.sort((a, b) => (a.line || 0) - (b.line || 0));
    rows.slice(0, IMPORT_DIALOG.PREVIEW_MAX_ROWS).forEach((r) => {
      const tr = el("tr", { class: "ti-row-" + r.kind });
      tr.appendChild(el("td", null, String(r.line == null ? "" : r.line)));
      tr.appendChild(el("td", null, r.kind));
      tr.appendChild(el("td", null, r.label || ""));
      tr.appendChild(el("td", null, r.detail || ""));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    host.appendChild(table);
    if (rows.length > IMPORT_DIALOG.PREVIEW_MAX_ROWS) {
      host.appendChild(el("div", { class: "ti-truncated" },
        "… " + (rows.length - IMPORT_DIALOG.PREVIEW_MAX_ROWS) + " weitere Zeilen (Zusammenfassung oben zählt alle)"));
    }
    state.applyBtn.disabled = (plan.creates.length + plan.updates.filter((u) => Object.keys(u.patch).length).length) === 0;
  }

  /** SM-295: project-branch preview — name, id, counts, conflict choice. */
  function renderProjectPreview(host, snap, state) {
    host.innerHTML = "";
    const p = snap.project;
    const box = el("div", { class: "ti-project-preview" });
    box.appendChild(el("div", { class: "ti-summary" },
      "Projekt-Import: „" + (p.name || p.id) + "“ (" + p.id + ")"));
    box.appendChild(el("div", { class: "ti-project-counts" },
      (snap.tickets || []).length + " Tickets · " + (snap.releases || []).length + " Releases · "
      + (snap.processSteps || []).length + " Process Steps"));
    // Review finding: Apply must WAIT for the project list — with a pending
    // list a conflicting id would classify as "new" and the POST/PUT upsert
    // would silently overwrite the existing project.
    if (!state.listResolved) {
      box.appendChild(el("div", { class: "ti-project-counts" }, "Prüfe bestehende Projekte…"));
      host.appendChild(box);
      state.applyBtn.disabled = true;
      return;
    }
    if (state.listFailed) {
      box.appendChild(el("div", { class: "ti-project-conflict" },
        "Konfliktprüfung nicht möglich (Projektliste nicht ladbar) — eine existierende Id würde ÜBERSCHRIEBEN."));
    }
    const conflict = (state.existingIds || []).indexOf(p.id) >= 0;
    state.projectMode = conflict ? "copy" : "new";
    state.copyTargetId = null;
    if (conflict) {
      state.copyTargetId = projectIO.planImport(snap, state.existingIds, "copy").targetId;
      box.appendChild(el("div", { class: "ti-project-conflict" },
        "Ein Projekt mit dieser Id existiert bereits."));
      [["copy", "Als Kopie importieren („" + state.copyTargetId + "“)"],
       ["overwrite", "Bestehendes Projekt ÜBERSCHREIBEN (destruktiv)"]].forEach(([val, label]) => {
        const lab = el("label", { class: "ti-mode-opt" + (val === "overwrite" ? " ti-destructive" : "") });
        const rb = el("input", { type: "radio", name: "ti-project-mode", value: val });
        rb.checked = (val === state.projectMode);
        rb.addEventListener("change", () => { if (rb.checked) state.projectMode = val; });
        lab.appendChild(rb);
        lab.appendChild(el("span", null, " " + label));
        box.appendChild(lab);
      });
    } else {
      box.appendChild(el("div", { class: "ti-project-new" }, "Wird als neues Projekt angelegt und geladen."));
    }
    host.appendChild(box);
    state.applyBtn.disabled = false;
  }

  /**
   * SM-295: THE unified import dialog. Auto-detects the content kind:
   * project envelope/snapshot → whole-project import (preview + copy/
   * overwrite choice; works WITHOUT a loaded project), CSV/JSON array →
   * row import (preview + mode + one-commit apply; needs ctx.store).
   * ctx: { store?, showModal, flashStatus, actor,
   *        listProjects(): Promise<string[]>,
   *        onImportProject(snap, targetId, overwrite): Promise }
   */
  function openImportDialog(ctx) {
    const projectId = (ctx.store && ctx.store.get() && ctx.store.get().project && ctx.store.get().project.id) || null;
    const state = {
      text: "", mode: IMPORT_DIALOG.DEFAULT_MODE, plan: null, applyBtn: null,
      kind: null, projectSnap: null, projectMode: "new", copyTargetId: null,
      existingIds: [], listResolved: false, listFailed: false,
      // SM-296/297: per-project persisted mappings + last parse's headers/rows
      headerMapping: readMappingFromStorage(projectId).headers,
      valueMapping: readMappingFromStorage(projectId).values,
      headers: [],
      rowsByLine: new Map()
    };

    ctx.showModal({
      title: "Import (Projekt-JSON · Tickets-CSV/JSON)",
      actions: [
        { label: "Cancel", onClick: () => {} },
        { label: "Apply import", onClick: async () => {
            // ---- project branch -------------------------------------------
            if (state.kind === "project" && state.projectSnap) {
              const p = state.projectSnap.project;
              const overwrite = state.projectMode === "overwrite";
              const targetId = state.projectMode === "copy" ? state.copyTargetId : p.id;
              try {
                await ctx.onImportProject(state.projectSnap, targetId, overwrite);
              } catch (err) {
                ctx.flashStatus("import failed: " + (err && err.message || err), { kind: "error" });
                return false;
              }
              return;   // close (onImportProject flashes its own success)
            }
            // ---- ticket branch --------------------------------------------
            if (!state.plan || !ctx.store) return false;      // still on step 1 → keep open
            let r;
            try {
              r = applyImportPlan(ctx.store.get(), state.plan, ctx.actor);
            } catch (err) {
              // e.g. a stale plan (board changed while the dialog was open):
              // surface it — the silent console.error of the modal wrapper
              // would leave the user with a dead Apply button.
              ctx.flashStatus("import failed: " + (err && err.message || err), { kind: "error" });
              return false;
            }
            if (r.created + r.updated === 0) return false;    // nothing to write → keep open
            ctx.store.applySnapshot(r.snapshot);              // ONE commit → one undo step
            ctx.flashStatus("import: " + r.created + " neu, " + r.updated + " aktualisiert", { kind: "ok" });
          } }
      ],
      onMount: (modal) => {
        const root = el("div", { class: "ti-root" });
        // Apply is the second modal action (data-act="1") — manage disabled.
        state.applyBtn = modal.querySelector('[data-act="1"]') || el("button");
        state.applyBtn.disabled = true;

        // Step 1: source
        const src = el("div", { class: "ti-source" });
        const file = el("input", { type: "file", accept: ".csv,.json,text/csv,application/json", class: "ti-file" });
        const ta = el("textarea", {
          class: "ti-text", rows: "6",
          placeholder: "CSV (Header-Zeile mit Feld-Keys, wie der Export) oder JSON-Array hier einfügen — oder oben eine Datei wählen."
        });
        src.appendChild(file);
        src.appendChild(ta);
        // Mode toggle
        const modeRow = el("div", { class: "ti-mode" });
        [["create-only", "Nur Neuanlage"], ["upsert", "Upsert (per Ticket-Key aktualisieren)"]].forEach(([val, label]) => {
          const lab = el("label", { class: "ti-mode-opt" });
          const rb = el("input", { type: "radio", name: "ti-mode", value: val });
          rb.checked = (val === state.mode);
          rb.addEventListener("change", () => { if (rb.checked) { state.mode = val; replan(); } });
          lab.appendChild(rb);
          lab.appendChild(el("span", null, " " + label));
          modeRow.appendChild(lab);
        });
        const mappingHost = el("div", { class: "ti-mapping-host" });   // SM-296
        const errHost = el("div", { class: "ti-parse-error" });
        const previewHost = el("div", { class: "ti-preview-host" });

        // SM-296/298: ONE unified mapping table — a row per CSV column with
        // its field select, and every unknown VALUE of that field nested
        // directly beneath it (indented ↳). Changes re-plan live + persist.
        function renderMappingTable(plan) {
          mappingHost.innerHTML = "";
          // JSON-array imports have NO header row but can still carry unknown
          // VALUES — the value rows must render regardless (review finding on
          // da00399: the early headers-return silently killed the SM-297
          // panel for the JSON branch).
          const hasUnknown = plan && plan.unknownValues && Object.keys(plan.unknownValues).length > 0;
          if (!state.headers.length && !hasUnknown) return;
          const panel = el("div", { class: "ti-mapping" });
          panel.appendChild(el("div", { class: "ti-mapping-title" }, "Spalten- & Werte-Zuordnung"));
          const renderedFields = new Set();

          function appendValueRows(field) {
            if (!plan || !plan.unknownValues || !plan.unknownValues[field]) return;
            if (renderedFields.has(field)) return;
            renderedFields.add(field);
            const targets = validTargetsFor(field);
            plan.unknownValues[field].forEach((rawVal) => {
              const row = el("label", { class: "ti-mapping-row ti-mapping-value-row" });
              row.appendChild(el("span", { class: "ti-mapping-raw" }, "↳ " + rawVal));
              const sel = el("select", { class: "ti-mapping-select" });
              sel.appendChild(el("option", { value: "" }, "— ignorieren —"));
              targets.forEach((t) => sel.appendChild(el("option", { value: t.value }, t.label)));
              sel.addEventListener("change", () => {
                const next = Object.assign({}, state.valueMapping);
                next[field] = Object.assign({}, next[field]);
                next[field][String(rawVal).trim().toLowerCase()] = sel.value || null;
                state.valueMapping = next;
                writeMappingToStorage(projectId, state.headerMapping, state.valueMapping);
                replan();
              });
              row.appendChild(sel);
              panel.appendChild(row);
            });
          }

          state.headers.forEach((h) => {
            const row = el("label", { class: "ti-mapping-row ti-mapping-header-row" });
            row.appendChild(el("span", { class: "ti-mapping-raw" }, h.raw || "(leer)"));
            const sel = el("select", { class: "ti-mapping-select" });
            const optIgnore = el("option", { value: "" }, "— ignorieren —");
            sel.appendChild(optIgnore);
            ticketImport.TICKET_IMPORT.FIELDS.forEach((f) => {
              const o = el("option", { value: f }, f);
              sel.appendChild(o);
            });
            sel.value = h.field || "";
            sel.addEventListener("change", () => {
              state.headerMapping = Object.assign({}, state.headerMapping);
              state.headerMapping[String(h.raw).trim().toLowerCase()] = sel.value || null;
              writeMappingToStorage(projectId, state.headerMapping, state.valueMapping);
              replan();
            });
            row.appendChild(sel);
            panel.appendChild(row);
            // unknown VALUES of this column's field sit right below it
            if (h.field) appendValueRows(h.field);
          });
          // safety net: unknown values whose field has no visible column
          Object.keys((plan && plan.unknownValues) || {}).forEach(appendValueRows);
          mappingHost.appendChild(panel);
        }

        // SM-297: valid mapping targets per field, from the CURRENT project.
        function validTargetsFor(field) {
          const snap = ctx.store ? ctx.store.get() : {};
          if (field === "status") {
            return (((snap.project || {}).workflow || {}).statuses || [])
              .map((s) => ({ value: s.id || s, label: s.name || s.id || s }));
          }
          if (field === "type") return ((snap.project || {}).ticketTypes || []).map((t) => ({ value: t, label: t }));
          // ids as VALUES (rename-stable — a persisted name mapping would go
          // stale on the first release rename; review finding on 2a40a63),
          // names as labels.
          if (field === "release") return (snap.releases || []).filter((r) => !r.isDeleted).map((r) => ({ value: r.id, label: r.name }));
          if (field === "processStep") return (snap.processSteps || []).filter((p) => !p.isDeleted).map((p) => ({ value: p.id, label: p.name }));
          return [];
        }

        function replan() {
          errHost.textContent = "";
          previewHost.innerHTML = "";
          mappingHost.innerHTML = "";
          state.plan = null;
          state.projectSnap = null;
          state.kind = null;
          state.headers = [];
          state.applyBtn.disabled = true;
          modeRow.style.display = "";
          if (!state.text.trim()) return;
          state.kind = detectImportKind(state.text);
          // ---- project branch: SM-15 engine + NEW preview -----------------
          if (state.kind === "project") {
            modeRow.style.display = "none";   // ticket modes don't apply
            if (!projectIO) { errHost.textContent = "project import unavailable (projectIO missing)"; return; }
            let snap;
            try { snap = projectIO.parseImport(state.text); }
            catch (e) { errHost.textContent = e.message; return; }
            state.projectSnap = snap;
            renderProjectPreview(previewHost, snap, state);
            return;
          }
          // ---- ticket branch ----------------------------------------------
          if (!ctx.store) {
            errHost.textContent = "Ticket-Import braucht ein geladenes Projekt — Projekt-JSON kann jederzeit importiert werden.";
            return;
          }
          const parsed = ticketImport.parseTicketImport(state.text, undefined, { headerMapping: state.headerMapping });
          if (parsed.error) { errHost.textContent = parsed.error; return; }
          state.headers = parsed.headers || [];
          state.rowsByLine = new Map(parsed.rows.map((r) => [r.line, r.data]));
          state.plan = ticketImport.planTicketImport(ctx.store.get(), parsed.rows, state.mode,
            { valueMapping: state.valueMapping });
          renderMappingTable(state.plan);
          renderPreview(previewHost, state.plan, state);
          // SM-296: unused columns are ANNOUNCED, never silently swallowed.
          const unused = state.headers.filter((h) => !h.field).map((h) => h.raw || "(leer)");
          if (unused.length) {
            previewHost.appendChild(el("div", { class: "ti-unused" },
              "Ignorierte Spalten: " + unused.join(", ")));
          }
        }

        // SM-295: fetch the existing project ids once (conflict detection in
        // the project branch); re-plan when they arrive after a fast paste.
        if (typeof ctx.listProjects === "function") {
          try {
            ctx.listProjects().then((ids) => {
              state.existingIds = ids || [];
              state.listResolved = true;
              if (state.kind === "project") replan();
            }).catch(() => {
              state.listResolved = true;
              state.listFailed = true;   // conflict unknown → explicit warning
              if (state.kind === "project") replan();
            });
          } catch (_e) { state.listResolved = true; state.listFailed = true; }
        } else {
          state.listResolved = true;
          state.listFailed = true;
        }

        ta.addEventListener("input", () => { state.text = ta.value; replan(); });
        file.addEventListener("change", () => {
          const f = file.files && file.files[0];
          if (!f) return;
          f.text().then((t) => { state.text = t; ta.value = t; replan(); })
            .catch((e) => { errHost.textContent = "Datei nicht lesbar: " + e.message; });
        });

        root.appendChild(src);
        root.appendChild(modeRow);
        // SM-298: ONE scroll container over mapping + errors + preview — it
        // takes the maximum dialog space (the modal is resizable).
        const scroll = el("div", { class: "ti-scroll" });
        scroll.appendChild(mappingHost);
        scroll.appendChild(errHost);
        scroll.appendChild(previewHost);
        root.appendChild(scroll);
        // Insert the body BEFORE the modal action row.
        const actionRow = modal.querySelector(".modal-actions");
        if (actionRow) modal.insertBefore(root, actionRow);
        else modal.appendChild(root);
        // expose for tests
        root._replan = replan;
        root._state = state;
      }
    });
  }

  /**
   * SM-295: THE unified export chooser — one menu entry, two targets.
   * ctx: { showModal, onExportProject(), onExportTickets() }
   */
  function openExportDialog(ctx) {
    ctx.showModal({
      title: "Export",
      actions: [
        { label: "Cancel", onClick: () => {} },
        { label: "Projekt (JSON)", onClick: () => ctx.onExportProject() },
        { label: "Tickets (CSV)", onClick: () => ctx.onExportTickets() },
      ],
      onMount: (modal) => {
        const root = el("div", { class: "ti-export-info" });
        root.appendChild(el("p", null,
          "Projekt (JSON): vollständiges, re-importierbares Backup — inklusive Workflow, Definitions, Board-Config, Checklisten, Links und Kommentaren."));
        root.appendChild(el("p", null,
          "Tickets (CSV): das aktuelle Tabellen-Ergebnis (Query, Spalten, Sortierung) — für Tabellenkalkulation und Re-Import per Upsert."));
        const actionRow = modal.querySelector(".modal-actions");
        if (actionRow) modal.insertBefore(root, actionRow);
        else modal.appendChild(root);
      }
    });
  }

  return {
    IMPORT_DIALOG: IMPORT_DIALOG,
    detectImportKind: detectImportKind,
    applyImportPlan: applyImportPlan,
    openImportDialog: openImportDialog,
    openExportDialog: openExportDialog,
    // Back-compat alias (pre-SM-295 name).
    openTicketImportDialog: openImportDialog,
  };
}));
