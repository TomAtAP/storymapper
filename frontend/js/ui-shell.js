/**
 * storymap UI-Shell — Custom-Dialog-System.
 *
 * Portiert von cmapper (concept_map.html UIShell-Section). Stellt die
 * Standard-Bausteine bereit, mit denen alle anderen Renderer (Story-Map,
 * Kanban, Sidebar) interagieren — anstelle von Browser-prompt/confirm/alert.
 *
 * API (alle UMD-exportiert auf window.STORYMAP.uiShell):
 *   showModal({title, sub?, bodyHTML?, actions, onMount?})
 *   showSettingsPopover({anchorEl, title?, bodyHTML?, onMount?, onClose?})
 *   flashStatus(msg, {kind?, spinner?}) → { dismiss() }
 *   wireDebounced(input, fn, ms?)
 *   bindLongPress(btn, {onShort, onLong, ms?})
 *   mountMenuBar(barEl, MENUS) → { destroy() }
 *
 * Alle UI-Konstanten im CONSTANTS-Block am Anfang — keine Magic Numbers
 * im Code. Tests referenzieren CONSTANTS, nicht Literalwerte.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else (root.STORYMAP = root.STORYMAP || {}).uiShell = factory();
}(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const CONSTANTS = {
    LONGPRESS_MS_DEFAULT: 400,
    DEBOUNCE_MS_DEFAULT: 250,
    FLASH_TIMEOUT_MS: 1800,
    POPOVER_VIEWPORT_MARGIN_PX: 4,
    POPOVER_ANCHOR_GAP_PX: 4,
    POPOVER_Z_INDEX: 50,
    MODAL_Z_INDEX: 60,
    MENU_Z_INDEX: 70
  };

  // ---- DOM helpers ------------------------------------------------------

  function el(tag, props, children) {
    const e = document.createElement(tag);
    if (props) {
      for (const k of Object.keys(props)) {
        if (k === "class") e.className = props[k];
        else if (k === "dataset") for (const d of Object.keys(props[k])) e.dataset[d] = props[k][d];
        else if (k === "style") Object.assign(e.style, props[k]);
        else if (k === "text") e.textContent = props[k];
        else if (k === "html") e.innerHTML = props[k];
        else if (k.startsWith("on") && typeof props[k] === "function") e.addEventListener(k.slice(2).toLowerCase(), props[k]);
        else e.setAttribute(k, props[k]);
      }
    }
    if (children) for (const c of children) if (c != null) e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    return e;
  }

  // ---- showModal --------------------------------------------------------
  //
  // Strikt am cmapper-Vorbild orientiert (concept_map.html Z. 9178). Single
  // modal-host (#modal-host) — falls bereits ein Modal offen ist, wird es
  // ersetzt. innerHTML-Aufbau: h2 + .modal-sub + bodyHTML + .modal-actions
  // in dieser Reihenfolge. Action-onClick-Returnwert false hält Modal offen
  // (await für async-Aktionen).

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
  }

  function showModal(opts) {
    let host = document.getElementById("modal-host");
    if (!host) {
      // Fallback: kein dedizierter Host im HTML → temporären anlegen,
      // damit das Pattern auch in Tests / einfachen Pages funktioniert.
      host = document.createElement("div");
      host.id = "modal-host";
      document.body.appendChild(host);
    }
    host.innerHTML = "";

    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    const modal = document.createElement("div");
    modal.className = "modal";

    const acts = opts.actions || [];
    const actionsHtml = acts.length
      ? '<div class="modal-actions">' + acts.map((a, i) => {
          const cls = "btn" + (a.primary ? " primary" : "") + (a.destructive ? " destructive" : "")
            + (a.className ? " " + escapeHtml(a.className) : "");
          return '<button class="' + cls + '" data-act="' + i + '">' + escapeHtml(a.label) + '</button>';
        }).join("") + '</div>'
      : "";

    modal.innerHTML =
      '<h2>' + escapeHtml(opts.title || "") + '</h2>' +
      (opts.sub ? '<div class="modal-sub">' + escapeHtml(opts.sub) + '</div>' : "") +
      (opts.bodyHTML || "") +
      actionsHtml;

    overlay.appendChild(modal);
    host.appendChild(overlay);

    function close() {
      host.innerHTML = "";
      document.removeEventListener("keydown", escHandler, true);
    }
    function escHandler(ev) {
      if (ev.key === "Escape") { ev.stopPropagation(); close(); }
    }
    document.addEventListener("keydown", escHandler, true);
    overlay.addEventListener("click", (ev) => { if (ev.target === overlay) close(); });

    acts.forEach((a, i) => {
      const btn = modal.querySelector('[data-act="' + i + '"]');
      if (!btn) return;
      btn.addEventListener("click", async () => {
        let result;
        try {
          if (typeof a.onClick === "function") result = await a.onClick(modal, close);
        } catch (err) {
          console.error("modal action error:", err);
          return;
        }
        if (result !== false) close();
      });
    });

    if (typeof opts.onMount === "function") opts.onMount(modal, close);
    return { modal, close };
  }

  // ---- showSettingsPopover ---------------------------------------------

  let _currentPopover = null;

  function _closePopover(cause) {
    if (!_currentPopover) return;
    const c = _currentPopover;
    _currentPopover = null;
    document.removeEventListener("keydown", c._esc, true);
    document.removeEventListener("mousedown", c._outside, true);
    if (c.node.parentNode) c.node.parentNode.removeChild(c.node);
    if (typeof c.onClose === "function") c.onClose(cause);
  }

  function _positionPopover(node, anchorEl) {
    const m = CONSTANTS.POPOVER_VIEWPORT_MARGIN_PX;
    const gap = CONSTANTS.POPOVER_ANCHOR_GAP_PX;
    const rect = anchorEl.getBoundingClientRect();
    const ph = node.offsetHeight;
    const pw = node.offsetWidth;
    const vh = window.innerHeight || 800;
    const vw = window.innerWidth  || 1200;
    let top = rect.bottom + gap;
    if (top + ph + m > vh) top = Math.max(m, rect.top - ph - gap);
    let left = rect.right - pw;
    if (left < m) left = m;
    if (left + pw + m > vw) left = vw - pw - m;
    node.style.top = top + "px";
    node.style.left = left + "px";
  }

  // ---- showContextMenu (SM-30) -----------------------------------------
  //
  // Cursor-anchored popover with a vertical list of items. Reuses the same
  // singleton + outside/Esc cleanup as showSettingsPopover, but positions at
  // (clientX, clientY) — clamped to viewport — instead of relative to a DOM
  // anchor. Each item is `{label, onClick, disabled?}`; clicking an enabled
  // item fires the callback then closes the menu.
  //
  //   showContextMenu({
  //     clientX, clientY,
  //     items: [{label: "Top of Backlog", onClick: () => ...}, ...],
  //     onClose?: (cause) => ...
  //   })
  //
  // Returns `{close()}`. Callers should `event.preventDefault()` on the
  // triggering contextmenu event themselves to suppress the browser menu.
  function _positionContextMenu(node, clientX, clientY) {
    const m  = CONSTANTS.POPOVER_VIEWPORT_MARGIN_PX;
    const ph = node.offsetHeight;
    const pw = node.offsetWidth;
    const vh = window.innerHeight || 800;
    const vw = window.innerWidth  || 1200;
    let top  = clientY;
    let left = clientX;
    if (top  + ph + m > vh) top  = Math.max(m, vh - ph - m);
    if (left + pw + m > vw) left = Math.max(m, vw - pw - m);
    node.style.top  = top  + "px";
    node.style.left = left + "px";
  }

  function showContextMenu(opts) {
    if (_currentPopover) _closePopover("explicit");
    const node = el("div", {
      class: "context-menu",
      style: { zIndex: String(CONSTANTS.POPOVER_Z_INDEX) }
    });
    const list = el("div", { class: "context-menu-list" });
    const items = Array.isArray(opts.items) ? opts.items : [];
    for (const item of items) {
      const disabled = typeof item.disabled === "function" ? !!item.disabled() : !!item.disabled;
      const btn = el("button", {
        class: "context-menu-item" + (disabled ? " context-menu-item-disabled" : ""),
        type: "button",
        text: item.label
      });
      if (!disabled) {
        btn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          _closePopover("item");
          try { item.onClick(ev); } catch (e) { /* surface via flashStatus is caller's job */ throw e; }
        });
      } else {
        btn.setAttribute("disabled", "disabled");
      }
      list.appendChild(btn);
    }
    node.appendChild(list);
    document.body.appendChild(node);
    _positionContextMenu(node, opts.clientX || 0, opts.clientY || 0);
    const handle = {
      node,
      onClose: opts.onClose,
      _esc(ev) { if (ev.key === "Escape") { ev.stopPropagation(); _closePopover("escape"); } },
      _outside(ev) { if (!node.contains(ev.target)) _closePopover("outside"); }
    };
    document.addEventListener("keydown", handle._esc, true);
    document.addEventListener("mousedown", handle._outside, true);
    _currentPopover = handle;
    return { close: () => _closePopover("explicit") };
  }

  function showSettingsPopover(opts) {
    if (_currentPopover) _closePopover("explicit");

    const node = el("div", { class: "settings-popover", style: { zIndex: String(CONSTANTS.POPOVER_Z_INDEX) } });
    if (opts.title) node.appendChild(el("div", { class: "sp-title", text: opts.title }));
    const body = el("div", { class: "sp-body" });
    if (opts.bodyHTML) body.innerHTML = opts.bodyHTML;
    node.appendChild(body);

    document.body.appendChild(node);
    _positionPopover(node, opts.anchorEl);

    const handle = {
      node,
      onClose: opts.onClose,
      _esc(ev) { if (ev.key === "Escape") { ev.stopPropagation(); _closePopover("escape"); } },
      _outside(ev) {
        if (!node.contains(ev.target) && !opts.anchorEl.contains(ev.target)) _closePopover("outside");
      }
    };
    document.addEventListener("keydown", handle._esc, true);
    document.addEventListener("mousedown", handle._outside, true);
    _currentPopover = handle;

    if (typeof opts.onMount === "function") opts.onMount(node, () => _closePopover("explicit"));
    return { close: () => _closePopover("explicit") };
  }

  // ---- flashStatus ------------------------------------------------------

  let _flashTimer = null;

  function _removeFlash() {
    const cur = document.querySelector(".flash");
    if (cur) cur.parentNode.removeChild(cur);
    if (_flashTimer) { clearTimeout(_flashTimer); _flashTimer = null; }
  }

  function flashStatus(msg, opts) {
    opts = opts || {};
    _removeFlash();
    const flash = el("div", { class: "flash" + (opts.kind ? " flash-" + opts.kind : "") });
    if (opts.spinner) flash.appendChild(el("span", { class: "flash-spinner" }));
    flash.appendChild(document.createTextNode(msg || ""));
    document.body.appendChild(flash);

    let dismissed = false;
    function dismiss() {
      if (dismissed) return;
      dismissed = true;
      if (flash.parentNode) flash.parentNode.removeChild(flash);
      if (_flashTimer) { clearTimeout(_flashTimer); _flashTimer = null; }
    }
    if (!opts.spinner) {
      _flashTimer = setTimeout(dismiss, CONSTANTS.FLASH_TIMEOUT_MS);
    }
    return { dismiss };
  }

  // ---- wireDebounced ---------------------------------------------------

  function wireDebounced(input, fn, ms) {
    const delay = Number.isFinite(ms) ? ms : CONSTANTS.DEBOUNCE_MS_DEFAULT;
    let t = null;
    input.addEventListener("input", () => {
      if (t) clearTimeout(t);
      t = setTimeout(() => { t = null; fn(input.value); }, delay);
    });
  }

  // ---- bindLongPress ---------------------------------------------------

  function bindLongPress(btn, opts) {
    const ms = (opts && Number.isFinite(opts.ms)) ? opts.ms : CONSTANTS.LONGPRESS_MS_DEFAULT;
    let timer = null;
    let didLong = false;

    btn.addEventListener("pointerdown", () => {
      didLong = false;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        didLong = true;
        timer = null;
        if (opts && typeof opts.onLong === "function") opts.onLong();
      }, ms);
    });
    function cancel() {
      if (timer) { clearTimeout(timer); timer = null; }
    }
    btn.addEventListener("pointerup", () => {
      if (timer) {
        // Released before threshold → short click.
        cancel();
        if (!didLong && opts && typeof opts.onShort === "function") opts.onShort();
      }
    });
    btn.addEventListener("pointerleave", cancel);
    btn.addEventListener("pointercancel", cancel);
  }

  // ---- mountMenuBar ----------------------------------------------------

  function isMac() {
    return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || "");
  }

  function formatShortcut(s) {
    if (!s) return "";
    const mac = isMac();
    return s
      .replace(/Mod/g, mac ? "⌘" : "Ctrl")
      .replace(/Shift/g, mac ? "⇧" : "Shift")
      .replace(/Alt/g, mac ? "⌥" : "Alt")
      .replace(/\+/g, mac ? "" : "+");
  }

  function mountMenuBar(barEl, MENUS) {
    let openDropdown = null;
    let openBtn = null;  // currently-open top-level button (gets .open class)

    function closeDropdown() {
      if (openDropdown && openDropdown.parentNode) openDropdown.parentNode.removeChild(openDropdown);
      openDropdown = null;
      if (openBtn) openBtn.classList.remove("open");
      openBtn = null;
      document.removeEventListener("mousedown", outsideHandler, true);
      document.removeEventListener("keydown", keyHandler, true);
    }

    function outsideHandler(ev) {
      if (openDropdown && !openDropdown.contains(ev.target) && !barEl.contains(ev.target)) closeDropdown();
    }
    function keyHandler(ev) {
      if (!openDropdown) return;
      if (ev.key === "Escape") { ev.stopPropagation(); closeDropdown(); }
    }

    function openMenu(menu, anchorBtn) {
      closeDropdown();
      const dd = el("div", { class: "menu-dropdown", dataset: { menuId: menu.id } });
      for (const item of menu.items) {
        if (item.type === "separator") {
          dd.appendChild(el("div", { class: "menu-dropdown-separator" }));
          continue;
        }
        const disabled = typeof item.disabled === "function" ? !!item.disabled() : !!item.disabled;
        const row = el("button", { class: "menu-dropdown-item" + (disabled ? " disabled" : "") });
        // SM-205: a fixed-width check gutter on every item so all labels align
        // in one column; the active/checked item shows a ✓ in the gutter.
        const checked = typeof item.checked === "function" ? !!item.checked() : !!item.checked;
        row.appendChild(el("span", { class: "menu-check", text: checked ? "✓" : "" }));
        row.appendChild(el("span", { class: "menu-label", text: item.label }));
        if (item.shortcut) row.appendChild(el("span", { class: "menu-shortcut", text: formatShortcut(item.shortcut) }));
        if (!disabled) {
          row.addEventListener("click", () => {
            const fn = item.action;
            closeDropdown();
            if (typeof fn === "function") {
              try { fn(); } catch (e) { console.error(e); }
            }
          });
        }
        dd.appendChild(row);
      }
      document.body.appendChild(dd);
      const rect = anchorBtn.getBoundingClientRect();
      dd.style.top  = (rect.bottom) + "px";
      dd.style.left = rect.left + "px";
      openDropdown = dd;
      openBtn = anchorBtn;
      anchorBtn.classList.add("open");
      document.addEventListener("mousedown", outsideHandler, true);
      document.addEventListener("keydown", keyHandler, true);
    }

    function render() {
      barEl.innerHTML = "";
      barEl.classList.add("menu-bar");
      for (const m of MENUS) {
        const btn = el("button", { class: "menu-item", text: m.label, dataset: { menuId: m.id } });
        btn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          if (openDropdown && openDropdown.dataset.menuId === m.id) { closeDropdown(); return; }
          openMenu(m, btn);
        });
        barEl.appendChild(btn);
      }
    }
    render();

    return {
      destroy() { closeDropdown(); barEl.innerHTML = ""; }
    };
  }

  // ---- Exports ---------------------------------------------------------

  return {
    CONSTANTS,
    showModal,
    showSettingsPopover,
    showContextMenu,
    flashStatus,
    wireDebounced,
    bindLongPress,
    mountMenuBar
  };
}));
