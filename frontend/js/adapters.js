/**
 * Storage adapters. Same async interface, four backends:
 *
 *   HttpAdapter           – Talks to a storymap server (PUT/POST/DELETE on
 *                           the REST API + WS subscription on /ws). Picked
 *                           explicitly via `?api=<url>` OR automatically
 *                           when SM-99's `/api/health` probe succeeds on
 *                           the same origin.
 *   WindowStorageAdapter  – Claude artifact runtime (window.storage). Data
 *                           lives in the artifact's persistent storage.
 *   LocalStorageAdapter   – Standalone browser (localStorage). Per-browser.
 *   MemoryAdapter         – Last-resort in-memory only.
 *
 * Each adapter exposes:
 *   load(projectId)                    → snapshot | null
 *   save(projectId, snapshot, opts)    → { revision, savedAt, snapshot }
 *   list()                             → string[]                (project ids)
 *   delete(projectId)                  → void
 *   subscribe(projectId, fn)?          → unsubscribe-fn          (HTTP only)
 *   name                               → "Http" | "Local" | "Memory" | "Window"
 *   close()?                           → cleanup (HTTP only)
 *
 * `pickAdapter(env)` is async and runs the priority chain:
 *   1. ?api=<url>  → HttpAdapter (explicit override)
 *   2. http(s) origin + /api/health probe succeeds → HttpAdapter on origin
 *   3. window.storage → WindowStorageAdapter
 *   4. window.localStorage → LocalStorageAdapter
 *   5. fall back to MemoryAdapter
 *
 * The /api/health probe (SM-99) verifies `body.name === "storymap"` so a
 * different service on the same port doesn't get mistaken for the server.
 * Probe timeout defaults to 500 ms (override via `env.probeTimeoutMs`).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else (root.STORYMAP = root.STORYMAP || {}).adapters = factory();
}(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // SM-153: WebSocket auto-reconnect timing. Exponential backoff from BASE,
  // capped at MAX, so live-sync recovers after a server restart / laptop sleep
  // instead of silently dying on a dead socket.
  const WS_RECONNECT_BASE_MS = 500;
  const WS_RECONNECT_MAX_MS   = 10000;

  // ---- HttpAdapter ------------------------------------------------------

  function HttpAdapter(baseUrl, opts) {
    this.name = "Http";
    this.base = baseUrl.replace(/\/$/, "");
    this.originId = (opts && opts.originId) || ("client-" + Math.random().toString(36).slice(2, 10));
    this._ws = null;
    this._subscriptions = new Map();  // projectId → Set<fn>
    this._wsReady = null;
    // SM-153: reconnect state.
    this._wantWs = false;           // intent to stay connected (false after close())
    this._reconnectTimer = null;
    this._reconnectAttempts = 0;
    this._connState = null;         // last reported connection state
    this._onConnState = null;       // optional indicator callback
  }

  HttpAdapter.prototype._req = async function (method, path, body) {
    const init = {
      method,
      headers: { "Content-Type": "application/json", "X-Origin-Id": this.originId }
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await fetch(this.base + path, init);
    let data = null;
    const text = await res.text();
    if (text) { try { data = JSON.parse(text); } catch (_) { data = text; } }
    if (!res.ok) {
      const err = new Error((data && data.error) || ("HTTP " + res.status));
      err.statusCode = res.status;
      if (data && typeof data === "object") {
        if (data.kind) err.kind = data.kind;
        if (data.missing) err.missing = data.missing;
      }
      throw err;
    }
    return data;
  };

  HttpAdapter.prototype.list = async function () {
    return await this._req("GET", "/api/projects");
  };

  HttpAdapter.prototype.load = async function (projectId) {
    try { return await this._req("GET", "/api/projects/" + encodeURIComponent(projectId)); }
    catch (err) { if (err.statusCode === 404) return null; throw err; }
  };

  HttpAdapter.prototype.save = async function (projectId, snapshot, opts) {
    // E18.A: PUT /api/projects/:pid akzeptiert jetzt einen ganzen Snapshot
    // (Cmapper-Pattern). Body = vollständiger Snapshot. Origin-Id-Header
    // sorgt dafür, dass die eigene WS-Change-Notification beim Echo-Filter
    // wegfällt. Server schreibt 1 Revision mit op="project_put".
    return await this._req("PUT", "/api/projects/" + encodeURIComponent(projectId), snapshot);
  };

  HttpAdapter.prototype.delete = async function (projectId) {
    await this._req("DELETE", "/api/projects/" + encodeURIComponent(projectId));
  };

  // SM-214: browsers cap the in-flight keepalive body (~64 KiB) and reject
  // bigger ones with a TypeError — a snapshot above the cap must fall back to
  // a plain fire-and-forget PUT (the pipeline does that when we return false).
  const SAVE_BEACON_MAX_BODY_BYTES = 60 * 1024;

  /**
   * SM-214: fire-and-forget snapshot PUT for page teardown (pagehide /
   * beforeunload). `keepalive: true` lets the request outlive the page —
   * a normal fetch would be cancelled mid-flight. Returns true when the
   * request was handed to fetch; false when keepalive can't carry it
   * (no fetch, or body above the browser keepalive cap) — the caller then
   * falls back to a regular save.
   */
  HttpAdapter.prototype.saveBeacon = function (projectId, snapshot) {
    try {
      const f = (typeof fetch === "function") ? fetch : null;
      if (!f) return false;
      const body = JSON.stringify(snapshot);
      if (body.length > SAVE_BEACON_MAX_BODY_BYTES) return false;
      f(this.base + "/api/projects/" + encodeURIComponent(projectId), {
        method: "PUT",
        keepalive: true,
        headers: { "Content-Type": "application/json", "X-Origin-Id": this.originId },
        body: body
      }).catch(function () { /* teardown — nothing to report to */ });
      return true;
    } catch (_) { return false; }
  };

  HttpAdapter.prototype._ensureWs = function () {
    if (this._wsReady) return this._wsReady;
    const wsUrl = this.base.replace(/^http/, "ws") + "/ws";
    const self = this;
    self._wantWs = true;
    this._wsReady = new Promise((resolve, reject) => {
      const WS = (typeof WebSocket !== "undefined") ? WebSocket : null;
      if (!WS) return reject(new Error("WebSocket not available in this environment"));
      const ws = new WS(wsUrl);
      ws.onopen = () => {
        self._ws = ws;
        self._reconnectAttempts = 0;
        self._notifyConn(true);
        // SM-153: a reconnect must restore every active subscription, else
        // live-sync stays silently dead after the socket flapped.
        for (const projectId of self._subscriptions.keys()) {
          try { ws.send(JSON.stringify({ type: "subscribe", projectId, originId: self.originId })); }
          catch (_) { /* ignore */ }
        }
        resolve(ws);
      };
      ws.onerror = (e) => reject(e);
      ws.onmessage = (ev) => self._handleWsMessage(ev);
      ws.onclose = () => {
        self._ws = null;
        self._wsReady = null;
        self._notifyConn(false);
        if (self._wantWs && self._subscriptions.size > 0) self._scheduleReconnect();
      };
    });
    // Don't cache a rejected promise — let the next _ensureWs() retry cleanly.
    this._wsReady.catch(() => { if (self._ws == null) self._wsReady = null; });
    return this._wsReady;
  };

  HttpAdapter.prototype._scheduleReconnect = function () {
    const self = this;
    if (self._reconnectTimer) return;
    self._reconnectAttempts += 1;
    const delay = Math.min(WS_RECONNECT_MAX_MS,
      WS_RECONNECT_BASE_MS * Math.pow(2, self._reconnectAttempts - 1));
    self._reconnectTimer = setTimeout(function () {
      self._reconnectTimer = null;
      if (!self._wantWs) return;
      self._ensureWs().catch(function () {
        if (self._wantWs && self._subscriptions.size > 0) self._scheduleReconnect();
      });
    }, delay);
  };

  HttpAdapter.prototype._notifyConn = function (connected) {
    if (connected === this._connState) return;
    this._connState = connected;
    if (typeof this._onConnState === "function") {
      try { this._onConnState(connected); } catch (_) { /* ignore */ }
    }
  };

  /** SM-153 — register a connection-state indicator callback (true=connected). */
  HttpAdapter.prototype.onConnectionState = function (fn) { this._onConnState = fn; };

  HttpAdapter.prototype._handleWsMessage = function (ev) {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (_) { return; }
    // SM-214: shape guard — the socket is a trust boundary. Frames that don't
    // match the documented message shapes are dropped before any callback.
    if (!msg || typeof msg !== "object" || typeof msg.type !== "string") return;
    if (msg.type === "change") {
      if (typeof msg.projectId !== "string") return;
      const fns = this._subscriptions.get(msg.projectId);
      if (!fns) return;
      for (const fn of fns) {
        try { fn(msg); } catch (_) { /* ignore */ }
      }
      return;
    }
    if (msg.type === "switch_request") {
      // E20.C: MCP asks the user to switch projects. Route to the
      // registered callback (set by main.js via onSwitchRequest); the
      // callback decides Accept/Cancel and calls sendSwitchResponse.
      if (typeof msg.requestId !== "string" || typeof msg.workspace !== "string") return;
      if (typeof this._onSwitchRequest === "function") {
        try { this._onSwitchRequest({ workspace: msg.workspace, reason: msg.reason, requestId: msg.requestId }); }
        catch (_) { /* ignore */ }
      }
      return;
    }
  };

  /** E20.C — register a single handler for incoming switch_request frames. */
  HttpAdapter.prototype.onSwitchRequest = function (fn) {
    this._onSwitchRequest = fn;
  };

  /** E20.C — send the user's verdict back to the server. Silent no-op when
   *  the socket isn't open (older callers may not have a requestId). */
  HttpAdapter.prototype.sendSwitchResponse = function (requestId, accepted) {
    if (typeof requestId !== "string" || !requestId) return;
    if (!this._ws || this._ws.readyState !== 1 /* OPEN */) return;
    try {
      this._ws.send(JSON.stringify({ type: "switch_response", requestId, accepted: !!accepted }));
    } catch (_) { /* ignore */ }
  };

  HttpAdapter.prototype.subscribe = async function (projectId, fn) {
    const self = this;
    const ws = await this._ensureWs();
    ws.send(JSON.stringify({ type: "subscribe", projectId, originId: this.originId }));
    if (!this._subscriptions.has(projectId)) this._subscriptions.set(projectId, new Set());
    this._subscriptions.get(projectId).add(fn);
    return () => {
      const set = self._subscriptions.get(projectId);
      if (set) {
        set.delete(fn);
        if (set.size === 0) self._subscriptions.delete(projectId);
      }
      // Send on the CURRENT socket (a reconnect may have replaced `ws`).
      if (self._ws) {
        try { self._ws.send(JSON.stringify({ type: "unsubscribe", projectId })); } catch (_) { /* ignore */ }
      }
    };
  };

  HttpAdapter.prototype.close = function () {
    // SM-153: intentional close — stop auto-reconnect.
    this._wantWs = false;
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    if (this._ws) { try { this._ws.close(); } catch (_) {} }
    this._ws = null; this._wsReady = null;
  };

  // ---- LocalStorageAdapter ---------------------------------------------

  const LS_PREFIX = "storymap:project:";
  const LS_INDEX = "storymap:projects";

  function LocalStorageAdapter(store) {
    this.name = "Local";
    this.store = store || (typeof localStorage !== "undefined" ? localStorage : null);
    if (!this.store) throw new Error("LocalStorageAdapter: localStorage not available");
  }

  LocalStorageAdapter.prototype.list = async function () {
    const raw = this.store.getItem(LS_INDEX);
    return raw ? JSON.parse(raw) : [];
  };

  LocalStorageAdapter.prototype.load = async function (projectId) {
    const raw = this.store.getItem(LS_PREFIX + projectId);
    return raw ? JSON.parse(raw) : null;
  };

  LocalStorageAdapter.prototype.save = async function (projectId, snapshot) {
    this.store.setItem(LS_PREFIX + projectId, JSON.stringify(snapshot));
    const list = await this.list();
    if (list.indexOf(projectId) < 0) {
      list.push(projectId);
      this.store.setItem(LS_INDEX, JSON.stringify(list));
    }
    return { revision: String(Date.now()), savedAt: Date.now(), snapshot };
  };

  LocalStorageAdapter.prototype.delete = async function (projectId) {
    this.store.removeItem(LS_PREFIX + projectId);
    const list = (await this.list()).filter(x => x !== projectId);
    this.store.setItem(LS_INDEX, JSON.stringify(list));
  };

  // ---- WindowStorageAdapter (Claude artifact) ---------------------------

  function WindowStorageAdapter(ws) {
    this.name = "Window";
    this.ws = ws || (typeof window !== "undefined" && window.storage);
    if (!this.ws) throw new Error("WindowStorageAdapter: window.storage not available");
  }

  WindowStorageAdapter.prototype.list = async function () {
    const r = await this.ws.list("storymap:");
    return r.map(k => k.replace(/^storymap:/, ""));
  };

  WindowStorageAdapter.prototype.load = async function (projectId) {
    const r = await this.ws.get("storymap:" + projectId);
    return r ? (typeof r === "string" ? JSON.parse(r) : r) : null;
  };

  WindowStorageAdapter.prototype.save = async function (projectId, snapshot) {
    await this.ws.set("storymap:" + projectId, JSON.stringify(snapshot));
    return { revision: String(Date.now()), savedAt: Date.now(), snapshot };
  };

  WindowStorageAdapter.prototype.delete = async function (projectId) {
    await this.ws.delete("storymap:" + projectId);
  };

  // ---- MemoryAdapter ----------------------------------------------------

  function MemoryAdapter() {
    this.name = "Memory";
    this._byId = new Map();
  }

  MemoryAdapter.prototype.list = async function () {
    return Array.from(this._byId.keys()).sort();
  };
  MemoryAdapter.prototype.load = async function (projectId) {
    return this._byId.has(projectId) ? JSON.parse(JSON.stringify(this._byId.get(projectId))) : null;
  };
  MemoryAdapter.prototype.save = async function (projectId, snapshot) {
    this._byId.set(projectId, JSON.parse(JSON.stringify(snapshot)));
    return { revision: String(Date.now()), savedAt: Date.now(), snapshot };
  };
  MemoryAdapter.prototype.delete = async function (projectId) {
    this._byId.delete(projectId);
  };

  // ---- pickAdapter ------------------------------------------------------

  const PROBE_TIMEOUT_MS_DEFAULT = 500;

  /**
   * SM-99 — probe `<origin>/api/health` to detect whether the page is being
   * served by a storymap server. Resolves with the working `baseUrl` (the
   * stripped-trailing-slash origin) on success; resolves with `null` on
   * any failure (network, timeout, non-200, non-JSON, wrong identity).
   *
   * Identity check: `body.name === "storymap"` so we don't latch onto an
   * unrelated server that happens to live on the same port.
   */
  async function probeStorymapOrigin(origin, opts) {
    if (!origin) return null;
    const timeoutMs = (opts && typeof opts.probeTimeoutMs === "number")
      ? opts.probeTimeoutMs : PROBE_TIMEOUT_MS_DEFAULT;
    const fetchImpl = (opts && opts.fetch) || (typeof fetch === "function" ? fetch : null);
    if (!fetchImpl) return null;
    const base = origin.replace(/\/$/, "");
    const ctrl = (typeof AbortController === "function") ? new AbortController() : null;
    const timer = (ctrl && setTimeout(() => ctrl.abort(), timeoutMs)) || null;
    try {
      const res = await fetchImpl(base + "/api/health",
        ctrl ? { signal: ctrl.signal } : {});
      if (!res || !res.ok) return null;
      const body = await res.json().catch(() => null);
      if (!body || body.name !== "storymap") return null;
      return base;
    } catch (_) {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function pickAdapter(env) {
    env = env || {};
    // 1. Explicit ?api=<url> override.
    const url = env.url || (typeof window !== "undefined" ? window.location.href : "");
    const params = new URLSearchParams((url.split("?")[1] || "").split("#")[0]);
    const api = params.get("api");
    if (api) return new HttpAdapter(api, env);
    // 2. Default: probe the current http(s) origin for a storymap server.
    const protocol = env.protocol
      || (typeof window !== "undefined" && window.location && window.location.protocol)
      || "";
    if (protocol === "http:" || protocol === "https:") {
      const origin = env.origin
        || (typeof window !== "undefined" && window.location && window.location.origin)
        || "";
      const ok = await probeStorymapOrigin(origin, env);
      if (ok) return new HttpAdapter(ok, env);
    }
    // 3-5. Fallback chain (unchanged from pre-SM-99).
    const winStorage = env.windowStorage || (typeof window !== "undefined" && window.storage);
    if (winStorage) return new WindowStorageAdapter(winStorage);
    const ls = env.localStorage || (typeof localStorage !== "undefined" ? localStorage : null);
    if (ls) return new LocalStorageAdapter(ls);
    return new MemoryAdapter();
  }

  return {
    HttpAdapter,
    LocalStorageAdapter,
    WindowStorageAdapter,
    MemoryAdapter,
    pickAdapter,
    // SM-99 — exposed for tests
    probeStorymapOrigin,
    PROBE_TIMEOUT_MS_DEFAULT
  };
}));
