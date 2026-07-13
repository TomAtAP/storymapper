/**
 * save-pipeline.js — shared debounced whole-snapshot persistence (SM-214).
 *
 * Extracted from main.js#installSaveSubscriber and the SM-157 duplicate in
 * renderer-ticket-editor.js so BOTH surfaces share one tested behaviour:
 *
 *   - every store commit (except skipReasons: applyRemote/hydrate) schedules
 *     a debounced `adapter.save(projectId, snapshot)`;
 *   - SM-153 race guard: the project id is captured at SCHEDULE time, so a
 *     project switch inside the debounce window can never PUT snapshot A
 *     under project B;
 *   - a failed save is retried once after RETRY_MS; only the terminal
 *     failure surfaces via onError. A newer commit supersedes a pending
 *     RETRY (generation counter) — a stale retry never fires after a newer
 *     flush. (Two in-flight first-attempt PUTs can still land out of order;
 *     that is the accepted E18 last-write-wins envelope, unchanged here.);
 *   - flushPendingSave(): synchronous flush for pagehide/beforeunload.
 *     Prefers `adapter.saveBeacon` (fetch keepalive — survives the page
 *     teardown) and falls back to fire-and-forget `adapter.save`. Without
 *     it, closing the tab inside the debounce window silently loses the
 *     last commit.
 *
 * UMD-wrapped, dependency-free; pure timer logic — fully unit-testable.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else (root.STORYMAP = root.STORYMAP || {}).savePipeline = factory();
}(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const SAVE_PIPELINE = {
    DEBOUNCE_MS_DEFAULT: 300,   // matches BOOTSTRAP.SAVE_DEBOUNCE_MS history
    RETRY_MS_DEFAULT: 1200,     // delay before retrying a failed PUT
    MAX_RETRIES_DEFAULT: 3      // retry transient (network/5xx) failures a few times
  };

  /**
   * createSavePipeline(opts) → { flushPendingSave, dispose }
   *
   * opts:
   *   store        ProjectStore-like: subscribe((snap, reason) => …)
   *   adapter      adapter object OR () => adapter (resolved per save)
   *   projectId    fixed string OR () => current id (resolved at SCHEDULE time)
   *   skipReasons  Set<string> of commit reasons that must not persist
   *   debounceMs / retryMs / maxRetries   overrides for SAVE_PIPELINE values
   *   onError(err) terminal-failure callback (after the retry)
   *   win          window-like; when it has addEventListener, pagehide +
   *                beforeunload are wired to flushPendingSave
   */
  function createSavePipeline(opts) {
    opts = opts || {};
    if (!opts.store || typeof opts.store.subscribe !== "function") {
      throw new Error("createSavePipeline: opts.store with subscribe() is required");
    }
    const getAdapter = (typeof opts.adapter === "function") ? opts.adapter : function () { return opts.adapter; };
    const getProjectId = (typeof opts.projectId === "function") ? opts.projectId : function () { return opts.projectId; };
    const skip = (opts.skipReasons && typeof opts.skipReasons.has === "function") ? opts.skipReasons : null;
    const debounceMs = Number.isFinite(opts.debounceMs) ? opts.debounceMs : SAVE_PIPELINE.DEBOUNCE_MS_DEFAULT;
    const retryMs = Number.isFinite(opts.retryMs) ? opts.retryMs : SAVE_PIPELINE.RETRY_MS_DEFAULT;
    const maxRetries = Number.isFinite(opts.maxRetries) ? opts.maxRetries : SAVE_PIPELINE.MAX_RETRIES_DEFAULT;
    const onError = (typeof opts.onError === "function") ? opts.onError : function () {};
    const win = opts.win || null;
    const setTimeoutFn = (win && win.setTimeout) ? win.setTimeout.bind(win) : setTimeout;
    const clearTimeoutFn = (win && win.clearTimeout) ? win.clearTimeout.bind(win) : clearTimeout;

    let timer = null;
    let pendingSnap = null;
    let pendingProjectId = null;
    // Each flush bumps the generation; a scheduled retry only fires while its
    // generation is still current — a newer flush supersedes the stale retry.
    let generation = 0;

    function takePending() {
      const snap = pendingSnap, pid = pendingProjectId;
      pendingSnap = null; pendingProjectId = null;
      if (timer) { clearTimeoutFn(timer); timer = null; }
      return (snap && pid) ? { snap, pid } : null;
    }

    // SM-244: a genuine HTTP client rejection (4xx — bad request, payload too
    // large, validation) is DETERMINISTIC — retrying can't help, so surface it
    // immediately. Everything else (a network/connection error with no
    // statusCode — e.g. a stale keep-alive socket reset — or a 5xx) is
    // TRANSIENT: the retry runs on a fresh connection and usually succeeds.
    // The whole-snapshot PUT is idempotent (replace), so re-sending is safe.
    function isRetriable(err) {
      const sc = err && err.statusCode;
      if (typeof sc === "number" && sc >= 400 && sc < 500) return false;
      return true;
    }

    function attemptSave(pid, snap, retriesLeft, gen) {
      Promise.resolve()
        .then(function () { return getAdapter().save(pid, snap); })
        .catch(function (err) {
          if (gen !== generation) return;          // superseded by a newer flush
          if (retriesLeft > 0 && isRetriable(err)) {
            setTimeoutFn(function () {
              if (gen !== generation) return;      // superseded while waiting
              attemptSave(pid, snap, retriesLeft - 1, gen);
            }, retryMs);
            return;
          }
          onError(err);
        });
    }

    function flush() {
      timer = null;
      const p = takePending();
      if (!p) return;
      generation++;
      attemptSave(p.pid, p.snap, maxRetries, generation);
    }

    /**
     * Synchronous flush for page teardown. Returns true when a pending save
     * was sent. NOTE: browser keepalive bodies are capped (~64 KiB in-flight);
     * a very large snapshot may still be dropped by the browser — best-effort,
     * strictly better than losing the commit unconditionally.
     */
    function flushPendingSave() {
      const p = takePending();
      if (!p) return false;
      generation++;                                // cancel any in-flight retry
      const adapter = getAdapter();
      let sent = false;
      if (adapter && typeof adapter.saveBeacon === "function") {
        // saveBeacon returns false when keepalive can't carry the snapshot
        // (e.g. body above the browser cap) — fall through to a plain save.
        try { sent = adapter.saveBeacon(p.pid, p.snap) !== false; }
        catch (_) { sent = false; }
      }
      if (!sent && adapter) {
        try { Promise.resolve(adapter.save(p.pid, p.snap)).catch(function () {}); }
        catch (_) { /* ignore */ }
      }
      return true;
    }

    const unsubscribe = opts.store.subscribe(function (snap, reason) {
      if (skip && skip.has(reason)) return;
      pendingSnap = snap;
      // SM-153: capture at SCHEDULE time, not flush time.
      pendingProjectId = getProjectId();
      if (timer) clearTimeoutFn(timer);
      timer = setTimeoutFn(flush, debounceMs);
    });

    const onPageHide = function () { flushPendingSave(); };
    if (win && typeof win.addEventListener === "function") {
      win.addEventListener("pagehide", onPageHide);
      win.addEventListener("beforeunload", onPageHide);
    }

    function dispose() {
      if (timer) { clearTimeoutFn(timer); timer = null; }
      generation++;
      if (typeof unsubscribe === "function") { try { unsubscribe(); } catch (_) {} }
      if (win && typeof win.removeEventListener === "function") {
        win.removeEventListener("pagehide", onPageHide);
        win.removeEventListener("beforeunload", onPageHide);
      }
    }

    return { flushPendingSave, dispose };
  }

  return { SAVE_PIPELINE, createSavePipeline };
}));
