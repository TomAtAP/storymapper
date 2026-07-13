/**
 * ticket-editor-boot.js — page bootstrap for /editor (ticket-editor.html).
 *
 * SM-214: extracted from an inline <script> block — the SM-211 CSP pins
 * `script-src 'self'`, which forbids inline scripts. Classic script tag,
 * no UMD needed (browser-only entry point, like main.js).
 */
(function () {
  "use strict";
  function boot() {
    var SM = window.STORYMAP;
    if (!SM || !SM.rendererTicketEditor) {
      document.getElementById("editor-host").textContent = "editor bootstrap: missing modules";
      return;
    }
    SM.rendererTicketEditor.bootstrap().catch(function (e) {
      console.error("editor bootstrap failed:", e);
      var h = document.getElementById("editor-host");
      if (h) h.textContent = "editor failed to load: " + (e && e.message || e);
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
}());
