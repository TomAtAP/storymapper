// SM-282 — Table view (Jira Issue Navigator style).
//
// A query-driven table over ALL tickets of the project — including epics and
// unassigned tickets that Map/Kanban hide. Own query line on top (same SM-187
// language as the smart-bar and MCP query_tickets; shared/query-engine.js is
// the single source), result table below. Columns are resolved through
// QUERY_FIELDS (label + resolve per field) — NO parallel field logic.
//
// SM-282 scope: fixed DEFAULT_COLUMNS, row click → ticket modal, live-sync
// with focus guard. Column config (SM-283), header sort (SM-284), CSV export
// (SM-285) and saved queries (SM-286) build on top of this skeleton.
//
// UMD-wrapped: same source runs in the browser AND require()s in Node tests.
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(
      require("./query-engine.js"),
      require("./smartbar-autocomplete.js"),
      require("./dnd.js")
    );
  } else {
    (root.STORYMAP = root.STORYMAP || {}).viewTable = factory(
      root.STORYMAP && root.STORYMAP.queryEngine,
      root.STORYMAP && root.STORYMAP.smartbarAutocomplete,
      root.STORYMAP && root.STORYMAP.dnd
    );
  }
}(typeof self !== "undefined" ? self : this, function (queryEngine, smartbarAutocomplete, dnd) {
  "use strict";

  if (!queryEngine) throw new Error("view-table: query-engine module missing");

  const TABLE_VIEW = {
    // Column keys reference QUERY_FIELDS[].key — the single field source.
    DEFAULT_COLUMNS: ["key", "type", "title", "status", "release", "processStep", "epic", "updated"],
    // Query re-runs debounced while typing (same cadence as the smart-bar).
    QUERY_DEBOUNCE_MS: 200,
    // SM-283: column config persistence, one entry per project.
    COLUMNS_STORAGE_PREFIX: "storymap-table-columns-",
    // SM-283: dnd drag type for column picker rows.
    DRAG_TYPE_COLUMN: "tv-column",
    // SM-292: default column widths (px) for table-layout:fixed. `title` is
    // deliberately absent — the one width-less column takes the remaining
    // space, so the table always fills the full view width. epic + updated
    // are wide enough that keys/timestamps never wrap (user finding).
    DEFAULT_COL_WIDTHS: {
      key: 90, type: 140, status: 100, release: 170,
      processStep: 150, epic: 90, updated: 140,
      created: 140, label: 140, acCount: 90, linkedTo: 120, linkedFrom: 120,
    },
    // SM-292: per-drag lower bound for column resizing.
    COL_MIN_WIDTH_PX: 56,
  };

  function storage() {
    try {
      if (typeof localStorage !== "undefined") return localStorage;
      if (typeof window !== "undefined" && window.localStorage) return window.localStorage;
    } catch (_e) { /* opaque origin / privacy mode — no persistence */ }
    return null;
  }

  function el(tag, attrs, text) {
    const d = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      if (k === "class") d.className = attrs[k];
      else d.setAttribute(k, attrs[k]);
    }
    if (text != null) d.textContent = text;
    return d;
  }

  /** Display formatting per QUERY_FIELDS type. Pure. */
  function formatCell(field, raw) {
    if (raw == null) return "";
    if (field.type === "date") {
      const n = Number(raw);
      if (!n) return "";
      const d = new Date(n);
      const pad = (x) => String(x).padStart(2, "0");
      return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate())
        + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
    }
    if (Array.isArray(raw)) return raw.join(", ");
    return String(raw);
  }

  /**
   * Pure view model: run the query (empty string = all live tickets, default
   * ticketKey order) and resolve the column cells via QUERY_FIELDS.
   * → { columns: [{key, label}], rows: [{id, cells: [{key, value}]}], error }
   * On a query error, rows is [] and error carries {message, position} — the
   * DOM layer keeps the last good rows visible instead.
   */
  function computeTableModel(snapshot, queryString, columnKeys, orderBy) {
    const fields = queryEngine.fieldsByKey();
    const keys = (columnKeys && columnKeys.length ? columnKeys : TABLE_VIEW.DEFAULT_COLUMNS)
      .filter((k) => fields[String(k).toLowerCase()]);
    const columns = keys.map((k) => {
      const f = fields[String(k).toLowerCase()];
      return { key: k, label: f.label };
    });
    const q = (queryString == null ? "" : String(queryString)).trim();
    // null AST = match all (engine contract) — the empty query shows the
    // whole project, which is the visibility point of this view.
    // SM-284: an explicit orderBy (header click) OVERRIDES the query's own
    // ORDER BY (engine contract of opts.orderBy); without one, the query's
    // ORDER BY applies and is reported back for the header indicator.
    const result = queryEngine.queryTickets(snapshot, q === "" ? null : q, orderBy ? { orderBy: orderBy } : undefined);
    if (result.error) return { columns: columns, rows: [], error: result.error, orderBy: null };
    const ctx = queryEngine.buildQueryCtx(snapshot);
    const rows = result.tickets.map((t) => ({
      id: t.id,
      cells: keys.map((k) => {
        const f = fields[String(k).toLowerCase()];
        return { key: k, value: formatCell(f, f.resolve(t, ctx)) };
      })
    }));
    return { columns: columns, rows: rows, error: null, orderBy: result.orderBy || null };
  }

  // ---- SM-283: column configuration -----------------------------------------

  /** Filter to known QUERY_FIELDS keys, dedupe; empty/invalid → default set. Pure. */
  function normalizeColumnKeys(keys) {
    const fields = queryEngine.fieldsByKey();
    const seen = new Set();
    const known = (Array.isArray(keys) ? keys : []).filter((k) => {
      const lk = String(k).toLowerCase();
      if (!fields[lk] || seen.has(lk)) return false;
      seen.add(lk);
      return true;
    });
    return known.length ? known : TABLE_VIEW.DEFAULT_COLUMNS.slice();
  }

  /** Pure reorder (mirrors view-settings.reorderStatuses on plain keys). */
  function reorderColumnKeys(keys, sourceKey, targetKey, before) {
    if (sourceKey === targetKey) return keys.slice();
    const fromIdx = keys.indexOf(sourceKey);
    if (fromIdx < 0) return keys.slice();
    const next = keys.slice();
    next.splice(fromIdx, 1);
    let insertAt = next.indexOf(targetKey);
    if (insertAt < 0) insertAt = next.length;
    if (!before) insertAt += 1;
    next.splice(insertAt, 0, sourceKey);
    return next;
  }

  /**
   * Read the per-project table config: { keys: string[]|null, widths: {} }.
   * SM-292 extended the stored shape from a bare key array to
   * { keys, widths } — the old array format is migrated on read.
   */
  function readColumnsFromStorage(projectId) {
    const ls = storage();
    if (!ls || !projectId) return { keys: null, widths: {} };
    try {
      const raw = ls.getItem(TABLE_VIEW.COLUMNS_STORAGE_PREFIX + projectId);
      if (!raw) return { keys: null, widths: {} };
      const data = JSON.parse(raw);
      if (Array.isArray(data)) return { keys: data, widths: {} };   // legacy shape
      if (data && typeof data === "object") {
        return {
          keys: Array.isArray(data.keys) ? data.keys : null,
          widths: (data.widths && typeof data.widths === "object") ? data.widths : {}
        };
      }
      return { keys: null, widths: {} };
    } catch (_e) { return { keys: null, widths: {} }; }
  }

  function writeColumnsToStorage(projectId, keys, widths) {
    const ls = storage();
    if (!ls || !projectId) return;
    try {
      ls.setItem(TABLE_VIEW.COLUMNS_STORAGE_PREFIX + projectId,
        JSON.stringify({ keys: keys, widths: widths || {} }));
    }
    catch (_e) { /* quota etc. — config just won't persist */ }
  }

  // ---- SM-285: CSV export ----------------------------------------------------

  /** RFC-4180 field escaping: quote when the value contains , " CR or LF. Pure. */
  function csvEscape(value) {
    const s = value == null ? "" : String(value);
    if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  /** Serialize a table model to CSV. Header row = field keys. CRLF lines. Pure. */
  function toCsv(columns, rows) {
    const lines = [columns.map((c) => csvEscape(c.key)).join(",")];
    rows.forEach((r) => {
      lines.push(r.cells.map((c) => csvEscape(c.value)).join(","));
    });
    return lines.join("\r\n");
  }

  /** Download filename, sanitized like project-io.exportFilename. Pure. */
  function csvFilename(projectId) {
    const id = projectId ? String(projectId).replace(/[^a-zA-Z0-9_-]/g, "_") : "project";
    return id + "-tickets.csv";
  }

  /** Browser glue: trigger a client-side download via a transient anchor.
   *  Uses a Blob URL when available, else a data: URI (also covers jsdom). */
  function triggerDownload(filename, text) {
    const a = document.createElement("a");
    if (typeof URL !== "undefined" && typeof URL.createObjectURL === "function" && typeof Blob !== "undefined") {
      const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
      a.href = url;
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } else {
      a.href = "data:text/csv;charset=utf-8," + encodeURIComponent(text);
      a.download = filename;
      a.click();
    }
  }

  // ---- DOM layer ------------------------------------------------------------

  /** Effective width for a column: user-resized > default > null (flexible). */
  function widthForColumn(key, widths) {
    if (widths && typeof widths[key] === "number" && widths[key] > 0) return widths[key];
    if (typeof TABLE_VIEW.DEFAULT_COL_WIDTHS[key] === "number") return TABLE_VIEW.DEFAULT_COL_WIDTHS[key];
    return null;
  }

  /**
   * SM-294: clamp a resize delta so BOTH the dragged column and the
   * compensating column stay >= minW. This is what makes the separator stop
   * (clip) at the ends instead of drifting. Pure.
   */
  function clampResizeDelta(dx, draggedW, compW, minW) {
    // Bounds are pinned to never cross zero: when one side ALREADY sits
    // below minW (overconstrained narrow viewport), the drag must not invert
    // — dx=0 stays admissible and only the widening direction of the
    // sub-min column is allowed (review finding on d25fd11).
    return Math.max(Math.min(0, minW - draggedW), Math.min(Math.max(0, compW - minW), dx));
  }

  /**
   * SM-294: pick the column that compensates a resize 1:1 (keeps the column
   * sum == container, so fixed-layout has NO slack to redistribute and the
   * separator tracks the mouse exactly). Preference: the flexible column
   * (no width — normally `title`); when the flexible column itself is
   * dragged, the next column to the right (or left, for the last one). Pure.
   */
  function pickCompensator(columnKeys, draggedKey, widths) {
    // Dragging a width-carrying column: the flexible partner absorbs.
    if (widthForColumn(draggedKey, widths) != null) {
      const flex = columnKeys.find((k) => k !== draggedKey && widthForColumn(k, widths) == null);
      if (flex) return flex;
    }
    const idx = columnKeys.indexOf(draggedKey);
    if (idx < 0) return null;
    // Dragging the flexible column (or no flexible partner exists): prefer a
    // WIDTH-CARRYING neighbor — a flexible partner would make the resulting
    // patch empty and the whole gesture a silent no-op (review finding).
    const after = columnKeys.slice(idx + 1).find((k) => widthForColumn(k, widths) != null);
    if (after) return after;
    const before = columnKeys.slice(0, idx).reverse().find((k) => widthForColumn(k, widths) != null);
    if (before) return before;
    // All partners flexible: plain neighbor (live preview only).
    if (idx < columnKeys.length - 1) return columnKeys[idx + 1];
    return idx > 0 ? columnKeys[idx - 1] : null;
  }

  function renderTable(tableHost, model, opts, refs) {
    tableHost.innerHTML = "";
    const table = el("table", { class: "tv-table" });
    // SM-292: table-layout:fixed + colgroup. Columns with a width keep it;
    // the width-less ones (title by default) share the remaining space, so
    // the table always fills the full view width.
    const widths = (refs && refs.widths) || {};
    const colgroup = el("colgroup");
    const colEls = {};
    const thEls = {};
    model.columns.forEach((c) => {
      const col = el("col", { "data-col": c.key });
      const w = widthForColumn(c.key, widths);
      if (w != null) col.style.width = w + "px";
      colEls[c.key] = col;
      colgroup.appendChild(col);
    });
    table.appendChild(colgroup);
    const thead = el("thead");
    const headRow = el("tr");
    const sortField = model.orderBy ? String(model.orderBy.field).toLowerCase() : null;
    model.columns.forEach((c) => {
      const th = el("th", { "data-col": c.key });
      th.appendChild(el("span", { class: "tv-th-label" }, c.label));
      // SM-284: clickable headers; the active sort column carries the
      // indicator (data-sort-dir styles the ▲/▼ via CSS).
      if (sortField && String(c.key).toLowerCase() === sortField) {
        th.setAttribute("data-sort-dir", model.orderBy.dir === "desc" ? "desc" : "asc");
      }
      if (opts.onHeaderSort) {
        th.addEventListener("click", () => opts.onHeaderSort(c.key));
      }
      // SM-292: per-column resize handle at the right edge of the header.
      // Pointer-drag adjusts the col width live; the handle never triggers
      // the sort click (stopPropagation on down + click).
      if (opts.onColumnResize) {
        const handle = el("span", { class: "tv-resize-handle" });
        handle.addEventListener("click", (ev) => ev.stopPropagation());
        handle.addEventListener("pointerdown", (ev) => {
          ev.stopPropagation();
          ev.preventDefault();
          // Capture so pointerup outside the window still reaches us (mouse
          // input gets no implicit capture) — review finding on 8218ee3.
          try { if (handle.setPointerCapture && ev.pointerId != null) handle.setPointerCapture(ev.pointerId); } catch (_e) {}
          const keys = model.columns.map((x) => x.key);
          const compKey = pickCompensator(keys, c.key, widths);
          if (!compKey) return;
          const startX = ev.clientX;
          // SM-294: freeze EVERY column at its measured width (sum ==
          // container) and compensate the drag 1:1 on compKey. With zero
          // slack, fixed-layout redistributes nothing and the separator
          // tracks the mouse exactly. Measure the live THs (cols have no
          // principal box → zero rect); fall back to configured widths.
          const start = {};
          keys.forEach((k) => {
            const r = thEls[k] && thEls[k].getBoundingClientRect ? thEls[k].getBoundingClientRect() : null;
            start[k] = (r && r.width) || widthForColumn(k, widths) || 150;
          });
          keys.forEach((k) => { colEls[k].style.width = Math.round(start[k]) + "px"; });
          let moved = false;
          function onMove(mv) {
            moved = true;
            const dx = clampResizeDelta(mv.clientX - startX, start[c.key], start[compKey], TABLE_VIEW.COL_MIN_WIDTH_PX);
            colEls[c.key].style.width = Math.round(start[c.key] + dx) + "px";
            colEls[compKey].style.width = Math.round(start[compKey] - dx) + "px";
          }
          function cleanup() {
            document.removeEventListener("pointermove", onMove);
            document.removeEventListener("pointerup", onUp);
            document.removeEventListener("pointercancel", onCancel);
          }
          function suppressTrailingClick() {
            // A clamped drag can end with the cursor over the TH label — the
            // synthesized click would toggle the sort. Swallow exactly the
            // click that belongs to this gesture.
            if (!moved) return;
            const swallow = (ce) => ce.stopPropagation();
            th.addEventListener("click", swallow, true);
            setTimeout(() => th.removeEventListener("click", swallow, true), 0);
          }
          function onUp(uv) {
            cleanup();
            suppressTrailingClick();
            const dx = clampResizeDelta(uv.clientX - startX, start[c.key], start[compKey], TABLE_VIEW.COL_MIN_WIDTH_PX);
            // Persist only width-carrying columns. The flexible column (no
            // configured width — normally `title`) NEVER gets one: it stays
            // the slack absorber, so sum == container holds after re-render
            // and its new size follows implicitly from the others.
            const patch = {};
            if (widthForColumn(c.key, widths) != null) patch[c.key] = Math.round(start[c.key] + dx);
            if (widthForColumn(compKey, widths) != null) patch[compKey] = Math.round(start[compKey] - dx);
            opts.onColumnResize(patch);
          }
          function onCancel() {
            // Gesture taken over (touch scroll, OS gesture): persist nothing;
            // the empty patch just re-renders the canonical widths.
            cleanup();
            suppressTrailingClick();
            opts.onColumnResize({});
          }
          document.addEventListener("pointermove", onMove);
          document.addEventListener("pointerup", onUp);
          document.addEventListener("pointercancel", onCancel);
        });
        th.appendChild(handle);
      }
      thEls[c.key] = th;
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);
    const tbody = el("tbody");
    model.rows.forEach((r) => {
      const tr = el("tr", { "data-ticket-id": r.id });
      r.cells.forEach((c) => tr.appendChild(el("td", { "data-col": c.key }, c.value)));
      tr.addEventListener("click", () => { if (opts.onTicketClick) opts.onTicketClick(r.id); });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    tableHost.appendChild(table);
    const count = el("div", { class: "tv-count" },
      model.rows.length + (model.rows.length === 1 ? " ticket" : " tickets"));
    tableHost.appendChild(count);
  }

  function applyQuery(refs, store, opts, queryString) {
    // SM-284 (review finding): a NEW query resets the header sort — otherwise
    // a single header click would permanently shadow any ORDER BY the user
    // types later (engine opts.orderBy always wins over the query's own).
    if (refs.sort && queryString !== refs.lastGoodQuery) refs.sort = null;
    const model = computeTableModel(store.get(), queryString, refs.columns || opts.columns, refs.sort || null);
    refs.errorHost.innerHTML = "";
    if (model.error) {
      // Non-destructive (same contract as the smart-bar): report the error,
      // keep the last good result on screen.
      const msg = model.error.message
        + (model.error.position != null ? " (at " + model.error.position + ")" : "");
      refs.errorHost.appendChild(el("div", { class: "tv-query-error" }, msg));
      return;
    }
    refs.lastGoodQuery = queryString;
    refs.lastOrderBy = model.orderBy;   // SM-284: effective sort (header OR query ORDER BY)
    renderTable(refs.tableHost, model, opts, refs);
  }

  /**
   * Mount the table view. Returns { unmount }.
   * opts: onTicketClick(id), columns? (SM-283 hook), getSnapshotForAutocomplete?
   */
  function mount(host, store, opts) {
    opts = opts || {};
    host.innerHTML = "";
    const root = el("div", { class: "tv-root" });

    const queryRow = el("div", { class: "tv-query-row" });
    const input = el("input", {
      class: "tv-query-input",
      type: "text",
      placeholder: "Query… e.g. type = user-story AND status IN (ready, in-progress)  — empty shows all",
      spellcheck: "false"
    });
    queryRow.appendChild(input);
    const columnsBtn = el("button", { class: "btn tv-columns-btn", type: "button" }, "Columns");
    queryRow.appendChild(columnsBtn);
    // SM-289: second entry point to the (general) ticket-import dialog.
    if (opts.onImport) {
      const importBtn = el("button", { class: "btn tv-import-btn", type: "button" }, "Import…");
      importBtn.addEventListener("click", () => opts.onImport());
      queryRow.appendChild(importBtn);
    }
    const columnsPanelHost = el("div", { class: "tv-columns-panel-host" });
    const errorHost = el("div", { class: "tv-query-error-host" });
    const tableHost = el("div", { class: "tv-table-host" });
    root.appendChild(queryRow);
    root.appendChild(columnsPanelHost);
    root.appendChild(errorHost);
    root.appendChild(tableHost);
    host.appendChild(root);

    // SM-283/292: column config — per-project persisted selection, order + widths.
    const projectId = (store.get() && store.get().project && store.get().project.id) || null;
    const storedConfig = readColumnsFromStorage(projectId);
    const refs = {
      errorHost: errorHost,
      tableHost: tableHost,
      lastGoodQuery: "",
      columns: normalizeColumnKeys(storedConfig.keys),
      widths: storedConfig.widths || {},   // SM-292: per-column pixel widths (user-resized)
      sort: null,          // SM-284: header-click sort {field, dir} — overrides query ORDER BY
      lastOrderBy: null    // SM-284: effective sort of the last render (for toggle direction)
    };

    // SM-284: clickable column headers. Same column again toggles direction;
    // a different column starts ascending. The header sort overrides a query
    // ORDER BY (engine opts.orderBy contract).
    // SM-292: onColumnResize persists the dragged width with the config.
    opts = Object.assign({}, opts, {
      onHeaderSort: (key) => {
        const cur = refs.lastOrderBy;
        const dir = (cur && String(cur.field).toLowerCase() === String(key).toLowerCase() && cur.dir !== "desc")
          ? "desc" : "asc";
        refs.sort = { field: key, dir: dir };
        applyQuery(refs, store, opts, refs.lastGoodQuery);
      },
      // SM-294: the resize hands over a width PATCH (dragged + possibly the
      // compensating neighbor; the flexible column is never included). An
      // empty patch (cancelled drag) just re-renders the canonical widths.
      onColumnResize: (patch) => {
        const changed = patch && Object.keys(patch).length > 0;
        if (changed) {
          refs.widths = Object.assign({}, refs.widths, patch);
          writeColumnsToStorage(projectId, refs.columns, refs.widths);
        }
        applyQuery(refs, store, opts, refs.lastGoodQuery);
      }
    });

    function setColumns(nextKeys) {
      refs.columns = normalizeColumnKeys(nextKeys);
      writeColumnsToStorage(projectId, refs.columns, refs.widths);
      applyQuery(refs, store, opts, refs.lastGoodQuery);
      if (columnsPanelHost.childNodes.length) renderColumnsPanel();
    }

    function renderColumnsPanel() {
      columnsPanelHost.innerHTML = "";
      const panel = el("div", { class: "tv-columns-panel" });
      // Active columns first (in display order), then the remaining fields in
      // QUERY_FIELDS order. Only active rows carry a grip (order = table order).
      const activeSet = new Set(refs.columns.map((k) => String(k).toLowerCase()));
      const rest = queryEngine.QUERY_FIELDS
        .map((f) => f.key)
        .filter((k) => !activeSet.has(String(k).toLowerCase()));
      const fields = queryEngine.fieldsByKey();
      refs.columns.concat(rest).forEach((key) => {
        const f = fields[String(key).toLowerCase()];
        const active = activeSet.has(String(key).toLowerCase());
        const row = el("div", { class: "tv-columns-row" + (active ? " tv-columns-row-active" : "") });
        row.setAttribute("data-col-key", key);
        if (active) row.appendChild(el("span", { class: "tv-columns-grip" }, "⋮⋮"));
        const cb = el("input", { type: "checkbox" });
        cb.checked = active;
        cb.addEventListener("change", () => {
          if (cb.checked) {
            setColumns(refs.columns.concat([key]));
          } else {
            const next = refs.columns.filter((k) => k !== key);
            // Min 1 column: refuse to empty the table entirely.
            if (next.length === 0) { cb.checked = true; return; }
            setColumns(next);
          }
        });
        row.appendChild(cb);
        row.appendChild(el("span", { class: "tv-columns-label" }, f.label));
        if (active && dnd && typeof dnd.enableDraggable === "function") {
          dnd.enableDraggable(row, { dragType: TABLE_VIEW.DRAG_TYPE_COLUMN, dragId: key });
          dnd.enableDropTarget(row, {
            accepts: [TABLE_VIEW.DRAG_TYPE_COLUMN],
            onEnter: (e) => e.classList.add("tv-columns-drop-target"),
            onLeave: (e) => e.classList.remove("tv-columns-drop-target"),
            onDrop: ({ id, event }) => {
              row.classList.remove("tv-columns-drop-target");
              if (id === key) return;
              const rect = row.getBoundingClientRect();
              const before = (event && typeof event.clientY === "number")
                ? event.clientY < rect.top + rect.height / 2 : true;
              setColumns(reorderColumnKeys(refs.columns, id, key, before));
            }
          });
        }
        panel.appendChild(row);
      });
      const footer = el("div", { class: "tv-columns-footer" });
      const resetBtn = el("button", { class: "btn tv-columns-reset", type: "button" }, "Reset to defaults");
      resetBtn.addEventListener("click", () => setColumns(TABLE_VIEW.DEFAULT_COLUMNS.slice()));
      footer.appendChild(resetBtn);
      panel.appendChild(footer);
      columnsPanelHost.appendChild(panel);
    }

    columnsBtn.addEventListener("click", () => {
      if (columnsPanelHost.childNodes.length) { columnsPanelHost.innerHTML = ""; return; }
      renderColumnsPanel();
    });

    // SM-285/292: CSV export lives in the Project menu now (user finding) —
    // the mounted view exposes it on the controller so the menu exports the
    // CURRENT state (query + columns + sort). One source: computeTableModel.
    function exportCsv() {
      const model = computeTableModel(store.get(), refs.lastGoodQuery, refs.columns, refs.sort || null);
      if (model.error) return;   // defensive: lastGoodQuery cannot really error
      triggerDownload(csvFilename(projectId), toCsv(model.columns, model.rows));
    }

    let debounceTimer = null;
    function onInput() {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        applyQuery(refs, store, opts, input.value || "");
      }, TABLE_VIEW.QUERY_DEBOUNCE_MS);
    }
    input.addEventListener("input", onInput);
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        if (debounceTimer) clearTimeout(debounceTimer);
        applyQuery(refs, store, opts, input.value || "");
      } else if (ev.key === "Escape") {
        input.value = "";
        applyQuery(refs, store, opts, "");
      }
    });

    // Jira-style autocomplete on the view's own query line (same module as
    // the smart-bar; capture-phase keydown intercepts Enter/Tab/Esc while
    // the dropdown is open).
    let acHandle = null;
    if (smartbarAutocomplete && smartbarAutocomplete.attachAutocomplete) {
      acHandle = smartbarAutocomplete.attachAutocomplete(input, {
        getSnapshot: () => store.get(),
        onAccept: () => applyQuery(refs, store, opts, input.value || "")
      });
    }

    // Live-sync: any store commit re-renders the table. The query input lives
    // outside tableHost and is never rebuilt, so typing is never stomped.
    // Focus guard: while the user is mid-edit (input focused), the rerun uses
    // the LAST APPLIED query, not the half-typed one — otherwise an external
    // commit would surface a parse error for an incomplete expression.
    const unsub = store.subscribe
      ? store.subscribe(() => applyQuery(refs, store, opts,
          document.activeElement === input ? refs.lastGoodQuery : (input.value || "")))
      : null;

    applyQuery(refs, store, opts, input.value || "");

    return {
      exportCsv: exportCsv,   // SM-292: called from the Project menu
      unmount() {
        if (typeof unsub === "function") unsub();
        if (acHandle && acHandle.detach) acHandle.detach();
        if (debounceTimer) clearTimeout(debounceTimer);
        host.innerHTML = "";
      }
    };
  }

  /**
   * SM-292: Project-menu export path when the Table view is NOT mounted —
   * all tickets (empty query) with the project's persisted column config.
   */
  function exportTicketsCsv(store, projectId) {
    const stored = readColumnsFromStorage(projectId);
    const model = computeTableModel(store.get(), "", normalizeColumnKeys(stored.keys), null);
    if (model.error) return;
    triggerDownload(csvFilename(projectId), toCsv(model.columns, model.rows));
  }

  /** Test hook: run a query against a mounted host synchronously. */
  function _applyQueryForTest(host, store, queryString) {
    const refs = {
      errorHost: host.querySelector(".tv-query-error-host"),
      tableHost: host.querySelector(".tv-table-host"),
      lastGoodQuery: ""
    };
    applyQuery(refs, store, {}, queryString);
  }

  return {
    TABLE_VIEW: TABLE_VIEW,
    computeTableModel: computeTableModel,
    formatCell: formatCell,
    normalizeColumnKeys: normalizeColumnKeys,
    reorderColumnKeys: reorderColumnKeys,
    toCsv: toCsv,
    csvEscape: csvEscape,
    csvFilename: csvFilename,
    widthForColumn: widthForColumn,
    clampResizeDelta: clampResizeDelta,
    pickCompensator: pickCompensator,
    exportTicketsCsv: exportTicketsCsv,
    readColumnsFromStorage: readColumnsFromStorage,
    writeColumnsToStorage: writeColumnsToStorage,
    mount: mount,
    _applyQueryForTest: _applyQueryForTest
  };
}));
