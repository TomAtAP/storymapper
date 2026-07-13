/**
 * SM-216 — smart-bar autocomplete dropdown (browser UI).
 *
 * Attaches a Jira-style suggestion dropdown to a text input. Pure suggestion
 * logic lives in shared/query-autocomplete.js; this module is just the DOM:
 * render the candidates, keyboard-navigate and insert the chosen completion
 * at the cursor. UMD-wrapped so the SAME file is require()d in jsdom tests
 * and <script src>'d in the browser.
 *
 * Key semantics (SM-293): nothing is auto-highlighted. ↑/↓ choose, Enter
 * accepts ONLY an explicitly chosen suggestion (otherwise it closes the menu
 * and falls through so the input's own handler runs the query), Tab eagerly
 * accepts the highlighted/first suggestion, Esc closes.
 *
 *   attachAutocomplete(inputEl, { getSnapshot, onAccept }) → { detach, _refresh }
 *
 * getSnapshot() → the current project snapshot (feeds field VALUE suggestions).
 * onAccept()    → called after a completion is inserted (the smart-bar re-runs
 *                 the query so the view + count update).
 */
(function (global, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else {
    const ns = (global.STORYMAP = global.STORYMAP || {});
    ns.smartbarAutocomplete = factory();
  }
}(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  function attachAutocomplete(input, opts) {
    opts = opts || {};
    const doc = input.ownerDocument;
    const ns = (input.ownerDocument.defaultView || global).STORYMAP || {};
    const ac = ns.queryAutocomplete;
    if (!ac) return { detach: function () {}, _refresh: function () {} };

    const menu = doc.createElement("div");
    menu.className = "smartbar-ac";
    menu.setAttribute("role", "listbox");
    menu.hidden = true;
    doc.body.appendChild(menu);

    let items = [];      // current suggestion objects
    let active = -1;     // highlighted index

    function snapshot() {
      try { return (typeof opts.getSnapshot === "function" && opts.getSnapshot()) || { tickets: [] }; }
      catch (_e) { return { tickets: [] }; }
    }
    function position() {
      const r = input.getBoundingClientRect();
      menu.style.left = r.left + "px";
      menu.style.top = (r.bottom + 2) + "px";
      menu.style.minWidth = r.width + "px";
    }
    function hide() { menu.hidden = true; menu.innerHTML = ""; items = []; active = -1; }

    function render() {
      const cursor = input.selectionStart == null ? input.value.length : input.selectionStart;
      items = ac.suggest(input.value, cursor, snapshot());
      if (!items.length) { hide(); return; }
      // SM-293: NO auto-highlight. Enter must run the query, not silently
      // accept a suggestion the user never chose — a suggestion becomes
      // active only via explicit arrow navigation (Tab still accepts the
      // first one without navigating).
      active = -1;
      menu.innerHTML = "";
      items.forEach(function (s, i) {
        const row = doc.createElement("div");
        row.className = "smartbar-ac-item";
        row.setAttribute("role", "option");
        row.dataset.index = String(i);
        const lab = doc.createElement("span");
        lab.className = "smartbar-ac-label";
        lab.textContent = s.label;
        const kind = doc.createElement("span");
        kind.className = "smartbar-ac-kind";
        kind.textContent = s.kind;
        row.appendChild(lab); row.appendChild(kind);
        row.addEventListener("mousedown", function (ev) {
          // mousedown (not click) so the input doesn't blur before we accept.
          ev.preventDefault();
          accept(i);
        });
        menu.appendChild(row);
      });
      position();
      menu.hidden = false;
    }

    function highlight(next) {
      if (!items.length) return;
      active = (next + items.length) % items.length;
      Array.prototype.forEach.call(menu.children, function (el, i) {
        el.classList.toggle("active", i === active);
      });
      const el = menu.children[active];
      if (el && el.scrollIntoView) el.scrollIntoView({ block: "nearest" });
    }

    function accept(i) {
      const s = items[i];
      if (!s) return;
      const before = input.value.slice(0, s.replaceStart);
      const afterText = input.value.slice(s.replaceEnd);
      input.value = before + s.insertText + afterText;
      const caret = (before + s.insertText).length;
      input.setSelectionRange(caret, caret);
      input.focus();
      hide();
      // chain: show the next set of suggestions (e.g. field → operator) and let
      // the smart-bar re-run the (possibly now-complete) query.
      if (typeof opts.onAccept === "function") opts.onAccept();
      render();
    }

    function onKeydown(ev) {
      if (menu.hidden) return;   // let Esc etc. fall through to the smart-bar
      if (ev.key === "ArrowDown") {
        ev.preventDefault();
        highlight(active === -1 ? 0 : active + 1);
      } else if (ev.key === "ArrowUp") {
        ev.preventDefault();
        highlight(active === -1 ? items.length - 1 : active - 1);
      } else if (ev.key === "Enter") {
        // SM-293: Enter accepts ONLY an explicitly chosen suggestion.
        // Without one it closes the dropdown and falls through, so the
        // input's own handler runs the query.
        if (active >= 0) { ev.preventDefault(); ev.stopPropagation(); accept(active); }
        else hide();
      } else if (ev.key === "Tab") {
        // Tab keeps the eager behavior: accept the highlighted or first one.
        ev.preventDefault(); ev.stopPropagation(); accept(active >= 0 ? active : 0);
      } else if (ev.key === "Escape") {
        ev.preventDefault(); ev.stopPropagation(); hide();
      }
    }
    function onInput() { render(); }
    function onBlur() { setTimeout(hide, 120); }   // allow mousedown-accept first
    function onFocus() { render(); }

    input.addEventListener("keydown", onKeydown, true);
    input.addEventListener("input", onInput);
    input.addEventListener("focus", onFocus);
    input.addEventListener("blur", onBlur);

    return {
      detach: function () {
        input.removeEventListener("keydown", onKeydown, true);
        input.removeEventListener("input", onInput);
        input.removeEventListener("focus", onFocus);
        input.removeEventListener("blur", onBlur);
        if (menu.parentNode) menu.parentNode.removeChild(menu);
      },
      _menu: menu,
      _refresh: render,
      _accept: accept
    };
  }

  return { attachAutocomplete: attachAutocomplete };
}));
