/**
 * Geteilte Card-Komponente (E11.1 — DRY-Refactor).
 *
 * Story-Map UND Kanban rendern dasselbe Ticket-Card-Element via diese
 * Funktion. Konsistentes Aussehen + Verhalten, keine Verdopplung von
 * DOM-Struktur, CSS-Klassen oder DnD-Verkabelung. CSS-Klassen-Namespace
 * bleibt `.sm-story-card` (das war zuerst da, hat schon `user-select:none`
 * und ist überall durchgestylt).
 *
 * API:
 *   renderTicketCard(ticket, opts) → HTMLElement
 *
 *   opts.onTicketClick(id)        — Doppelklick öffnet Detail-Modal
 *   opts.dragType?: string        — wenn gesetzt, registriert dnd.enableDraggable
 *   opts.dragId?: string          — überschreibt ticket.id (selten nötig)
 *   opts.dragOnEnd?: () => void   — z.B. um Drag-Projection des Aufrufers zu clearen
 *   opts.isShadow?: boolean       — Shadow-Variante (gestrichelte Border, kein DnD)
 *   opts.width?: number           — explizite Breite (Story-Map setzt das,
 *                                    Kanban lässt's auf flexibel)
 *
 * Click stoppt propagation, damit ein Click auf einer Karte nicht an
 * darüberliegende Drop-Targets durchschlägt.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./dnd.js"));
  else (root.STORYMAP = root.STORYMAP || {}).rendererCard = factory(root.STORYMAP && root.STORYMAP.dnd);
}(typeof self !== "undefined" ? self : this, function (dnd) {
  "use strict";
  if (!dnd) throw new Error("renderer-card: dnd module missing");

  // Type → Cluster mapping (cmapper-Palette, von Story-Map übernommen).
  const TYPE_TO_CLUSTER = {
    "epic":                    "plum",
    "user-story":              "green",
    "technical-task":          "blue",
    "technical-task-backend":  "blue",
    "technical-task-ui":       "teal",
    "bug":                     "rust",
    "spike":                   "amber",
    "_default":                "slate"
  };
  function clusterForType(t) { return TYPE_TO_CLUSTER[t] || TYPE_TO_CLUSTER._default; }

  // ---- SM-170: Card-Aging ---------------------------------------------
  // How long a card has sat in its current status. The badge only appears
  // once a card crosses WARN (it's a flag for liegenbleiber, not a clock on
  // every card), and the caller decides WHICH cards age (the Kanban only
  // flags `doing`/`blocked` columns — see renderer-kanban). Thresholds in ms.
  const CARD_AGE = {
    WARN_MS:  3 * 24 * 60 * 60 * 1000,   // 3 days  → amber
    STALE_MS: 7 * 24 * 60 * 60 * 1000    // 7 days  → red
  };
  function humanizeAge(ms) {
    const hours = ms / (60 * 60 * 1000);
    if (hours < 24) return Math.max(1, Math.round(hours)) + "h";
    const days = hours / 24;
    if (days < 7) return Math.round(days) + "d";
    return Math.round(days / 7) + "w";
  }
  // Returns the age-badge element, or null when the card is still fresh.
  function buildAgeBadge(ticket, ageRef) {
    const entered = typeof ticket.statusEnteredAt === "number"
      ? ticket.statusEnteredAt
      : (typeof ticket.createdAt === "number" ? ticket.createdAt : null);
    if (entered == null) return null;
    const age = Math.max(0, ageRef - entered);
    if (age < CARD_AGE.WARN_MS) return null;
    const tier = age >= CARD_AGE.STALE_MS ? "stale" : "warn";
    return el("span", {
      class: "sm-badge sm-card-age sm-card-age-" + tier,
      title: "In this status for " + humanizeAge(age),
      text: humanizeAge(age)
    });
  }

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

  function checklistBadge(items) {
    if (!items || items.length === 0) return "";
    const done = items.filter(i => i.checked).length;
    return done + "/" + items.length;
  }

  // ---- SM-49: link-badges (per-card dependency indicators) -----------
  //
  // computeLinkIndex(snapshot) → Map<ticketId, {
  //   forward, backward,
  //   forwardSemantics:Set, backwardSemantics:Set,
  //   forwardTargetIds:[], backwardSourceIds:[],
  //   forwardTargetKeys:[], backwardSourceKeys:[] }>
  //
  // O(N + sum(links)). Renderers call this once per mount-cycle, then pass
  // the per-ticket entry via opts.linkInfo into renderTicketCard — keeps
  // the card-level lookup O(1) and avoids quadratic re-scan-per-card.
  function _ensureLinkEntry(idx, id) {
    let v = idx.get(id);
    if (!v) {
      v = {
        forward: 0, backward: 0,
        forwardSemantics: new Set(), backwardSemantics: new Set(),
        forwardTargetIds: [], backwardSourceIds: [],
        forwardTargetKeys: [], backwardSourceKeys: []
      };
      idx.set(id, v);
    }
    return v;
  }
  function computeLinkIndex(snapshot) {
    const idx = new Map();
    const tickets = (snapshot && snapshot.tickets) || [];
    const project = (snapshot && snapshot.project) || {};
    const linkTypeById = new Map();
    for (const lt of (project.linkTypes || [])) linkTypeById.set(lt.id, lt);
    const ticketById = new Map();
    for (const t of tickets) ticketById.set(t.id, t);
    for (const t of tickets) {
      if (!t.links || !t.links.length) continue;
      for (const l of t.links) {
        const lt = linkTypeById.get(l.linkTypeId);
        const sem = (lt && lt.semantic) || "freeform";
        const src = _ensureLinkEntry(idx, t.id);
        src.forward++;
        src.forwardSemantics.add(sem);
        src.forwardTargetIds.push(l.targetTicketId);
        const tgtTicket = ticketById.get(l.targetTicketId);
        src.forwardTargetKeys.push(tgtTicket ? (tgtTicket.ticketKey || tgtTicket.id) : l.targetTicketId);
        const tgt = _ensureLinkEntry(idx, l.targetTicketId);
        tgt.backward++;
        tgt.backwardSemantics.add(sem);
        tgt.backwardSourceIds.push(t.id);
        tgt.backwardSourceKeys.push(t.ticketKey || t.id);
      }
    }
    return idx;
  }

  // Pick a single semantic for the badge color. If multiple semantics are
  // mixed under the same direction, fall back to "mixed".
  function dominantSemantic(semSet) {
    if (!semSet || semSet.size === 0) return "freeform";
    if (semSet.size === 1) return semSet.values().next().value;
    return "mixed";
  }

  function buildLinkBadge(direction, count, semantic, keysList, hostRef) {
    const arrow = direction === "backward" ? "←" : "→";
    const badge = el("span", {
      class: "sm-badge sm-link-badge sm-link-badge-" + direction + " sm-link-badge-sem-" + semantic,
      dataset: { linkDirection: direction },
      title: (direction === "backward" ? "Referenced by: " : "Links to: ") + keysList.join(", ")
    });
    badge.textContent = arrow + " " + count;
    // Click pulses every card in the same host whose ticket-id is in the
    // related-set. Host lookup walks up: card → host (sm-grid or km-board).
    badge.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const card = badge.closest(".sm-story-card");
      const host = card && (card.closest(".sm-grid") || card.closest(".km-board") || card.parentNode);
      if (!host) return;
      const ids = direction === "backward" ? hostRef.backwardSourceIds : hostRef.forwardTargetIds;
      for (const tid of ids) {
        const targets = host.querySelectorAll('.sm-story-card[data-ticket-id="' + tid + '"]');
        for (const t of targets) {
          t.classList.remove("sm-card-flash");
          // eslint-disable-next-line no-unused-expressions
          void t.offsetWidth;
          t.classList.add("sm-card-flash");
          setTimeout(((node) => () => node.classList.remove("sm-card-flash"))(t), 900);
        }
      }
    });
    return badge;
  }

  // ---- SM-60: last-execution-outcome badge -----------------------------
  //
  // For type='test-definition' cards we surface the latest execution-run's
  // outcome as a colour-coded pill in the card-meta row. Computation is
  // index-based so renderers can build it once per mount and pass the
  // per-card entry, the same way linkInfo flows in SM-49.
  //
  // computeLastExecutionIndex(snapshot) → Map<defId, {
  //   executionTicket, outcome, runAt, runByName, env
  // }> | null
  //
  // Pure: doesn't touch the DOM. The renderers call this once per
  // mount-cycle, then pipe the per-definition entry via opts.lastExecution
  // into renderTicketCard.

  /**
   * SM-60: pick the most recent test-execution per test-definition.
   * "Most recent" = highest `runAt`; ties broken by lexicographic ticketKey
   * (deterministic). Soft-deleted executions are ignored.
   */
  function computeLastExecutionIndex(snapshot) {
    const map = new Map();
    if (!snapshot || !Array.isArray(snapshot.tickets)) return map;
    const TICKETS = snapshot.tickets;
    // First, group all 'executes' links source-by-target.
    const byDef = new Map();   // defId → [executionTicket, ...]
    for (const t of TICKETS) {
      if (t.isDeleted || t.type !== "test-execution") continue;
      if (!Array.isArray(t.links)) continue;
      for (const l of t.links) {
        const lt = l.linkTypeId || l.type;
        if (lt !== "executes") continue;
        const defId = l.targetTicketId;
        if (!defId) continue;
        const arr = byDef.get(defId) || [];
        arr.push(t);
        byDef.set(defId, arr);
      }
    }
    for (const [defId, executions] of byDef) {
      executions.sort((a, b) => {
        const ra = typeof a.runAt === "number" ? a.runAt : 0;
        const rb = typeof b.runAt === "number" ? b.runAt : 0;
        if (rb !== ra) return rb - ra;
        return String(b.ticketKey || "").localeCompare(String(a.ticketKey || ""));
      });
      const top = executions[0];
      const outcome = _outcomeOf(top);
      map.set(defId, {
        executionTicket: top,
        outcome:         outcome,
        runAt:           top.runAt || null,
        runByName:       top.runBy && top.runBy.name ? top.runBy.name : null,
        env:             top.env || null
      });
    }
    return map;
  }

  // Inline version of getEffectiveOutcome — kept local so the card module
  // doesn't pull in core just for this. Mirrors core.getEffectiveOutcome:
  // manual override wins; otherwise derive from execution steps.
  const _OUTCOMES = ["pending", "passed", "failed", "blocked", "skipped"];
  function _outcomeOf(execTicket) {
    if (!execTicket) return "pending";
    if (typeof execTicket.outcomeOverride === "string"
        && _OUTCOMES.indexOf(execTicket.outcomeOverride) >= 0) {
      return execTicket.outcomeOverride;
    }
    const steps = Array.isArray(execTicket.executionSteps) ? execTicket.executionSteps : [];
    if (steps.length === 0) return "pending";
    let allPassed = true;
    let anyBlocked = false;
    for (const s of steps) {
      if (!s || typeof s.status !== "string") { allPassed = false; continue; }
      if (s.status === "failed")  return "failed";
      if (s.status === "blocked") anyBlocked = true;
      if (s.status !== "passed")  allPassed = false;
    }
    if (anyBlocked) return "blocked";
    return allPassed ? "passed" : "pending";
  }

  function _fmtRunAt(ms) {
    if (typeof ms !== "number") return null;
    try {
      const d = new Date(ms);
      const pad = (n) => String(n).padStart(2, "0");
      return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate())
           + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
    } catch (_) { return null; }
  }

  /**
   * Build the outcome pill for a test-execution card. The execution carries
   * its own outcome (derived from steps or via manual override) — no
   * external lookup needed. Tooltip surfaces run metadata (when, by whom,
   * env) so the user gets context without opening the modal.
   */
  function buildExecutionOutcomeBadge(execTicket) {
    const outcome = _outcomeOf(execTicket);
    const tooltipParts = ["outcome: " + outcome];
    const at = _fmtRunAt(execTicket && execTicket.runAt);
    if (at) tooltipParts.push("ran " + at);
    const runBy = execTicket && execTicket.runBy && execTicket.runBy.name;
    if (runBy) tooltipParts.push("by " + runBy);
    if (execTicket && execTicket.env) tooltipParts.push("env: " + execTicket.env);
    return el("span", {
      class: "sm-badge sm-exec-badge sm-exec-badge-" + outcome,
      title: tooltipParts.join(" · "),
      text: outcome
    });
  }

  // SM-158: the ticket-KEY is a link to the full-page editor when a projectId
  // is supplied (board → editor for every item, incl. epics). The editor
  // resolves the key → internal id. Clicking it must not start a card drag (dnd
  // ignores <a>) nor open the modal (stopPropagation on click). Without a
  // projectId it falls back to a plain span (e.g. isolated unit tests).
  function buildTicketKeyEl(ticketKey, projectId) {
    if (!projectId) return el("span", { class: "sm-story-key", text: ticketKey });
    return el("a", {
      class: "sm-story-key sm-key-link",
      href: "/editor?projectId=" + encodeURIComponent(projectId) + "&ticketId=" + encodeURIComponent(ticketKey),
      title: "Open " + ticketKey + " in the full-page editor",
      text: ticketKey,
      onclick: function (e) { if (e && e.stopPropagation) e.stopPropagation(); }
    });
  }

  /**
   * Generic card shell (DRY core — SM-256/SM-248). Builds the shared
   * `.sm-story-card` element used by BOTH the ticket renderer AND the
   * process-step editor: same DOM, same dnd drag wiring, same dblclick
   * contract — only the leading element (key/ordinal), the title, the
   * optional meta row and the cluster colour differ. There is deliberately
   * NO second card component.
   *
   * spec:
   *   cluster       cluster colour key ("plum"/"teal"/…)
   *   statusClass?  extra class on the card (tickets pass "sm-status-<status>")
   *   dataset?      dataset object set on the card element
   *   width?        explicit px width
   *   isShadow?     preview-only variant (dashed border, NO listeners)
   *   keyEl?        optional leading element (ticket-key link OR step ordinal)
   *   title         the prominent title text
   *   meta?         array of meta-row children; omitted/empty → no meta row
   *   onDblClick?   dblclick handler (open detail modal / edit dialog)
   *   dragType?, dragId?, dragOnEnd?   dnd.enableDraggable wiring
   */
  function renderCard(spec) {
    spec = spec || {};
    const isShadow = !!spec.isShadow;
    const card = el("div", {
      class: "sm-story-card sm-cluster-" + spec.cluster
           + (spec.statusClass ? " " + spec.statusClass : "")
           + (isShadow ? " sm-card-shadow" : ""),
      dataset: spec.dataset || {}
    });
    if (typeof spec.width === "number") card.style.width = spec.width + "px";

    const info = el("div", { class: "sm-card-info" });
    if (spec.keyEl) info.appendChild(spec.keyEl);
    info.appendChild(el("span", { class: "sm-story-title", text: spec.title || "" }));
    card.appendChild(info);

    if (spec.meta && spec.meta.length) {
      const meta = el("div", { class: "sm-card-meta" });
      for (const m of spec.meta) if (m) meta.appendChild(m);
      card.appendChild(meta);
    }

    if (isShadow) return card;   // preview-only — no listeners

    if (typeof spec.onDblClick === "function") {
      card.addEventListener("dblclick", (ev) => { ev.stopPropagation(); spec.onDblClick(); });
    }
    if (spec.dragType) {
      dnd.enableDraggable(card, { dragType: spec.dragType, dragId: spec.dragId, onEnd: spec.dragOnEnd });
    }
    return card;
  }

  function renderTicketCard(t, opts) {
    opts = opts || {};
    // Meta row, in stable order: status pill, DoR/DoD, link badges, outcome, age.
    const meta = [el("span", { class: "sm-card-status sm-status-pill-" + t.status, text: t.status })];
    const dorBadge = checklistBadge(t.definitionOfReady && t.definitionOfReady.items);
    const dodBadge = checklistBadge(t.definitionOfDone && t.definitionOfDone.items);
    if (dorBadge) meta.push(el("span", { class: "sm-badge sm-badge-dor", title: "Definition of Ready", text: "DoR " + dorBadge }));
    if (dodBadge) meta.push(el("span", { class: "sm-badge sm-badge-dod", title: "Definition of Done",  text: "DoD " + dodBadge }));
    // SM-49: dependency badges (forward + backward) if a linkIndex entry is supplied.
    const linkInfo = opts.linkInfo;
    if (linkInfo) {
      if (linkInfo.forward > 0) {
        const sem = dominantSemantic(linkInfo.forwardSemantics);
        meta.push(buildLinkBadge("forward", linkInfo.forward, sem, linkInfo.forwardTargetKeys, linkInfo));
      }
      if (linkInfo.backward > 0) {
        const sem = dominantSemantic(linkInfo.backwardSemantics);
        meta.push(buildLinkBadge("backward", linkInfo.backward, sem, linkInfo.backwardSourceKeys, linkInfo));
      }
    }
    // SM-60: outcome badge belongs on the test-execution card.
    if (t.type === "test-execution") meta.push(buildExecutionOutcomeBadge(t));
    // SM-170: aging badge (only when the caller opts in for this card).
    if (opts.showAge) {
      const ageRef = typeof opts.ageRef === "number" ? opts.ageRef : Date.now();
      const ageBadge = buildAgeBadge(t, ageRef);
      if (ageBadge) meta.push(ageBadge);
    }
    return renderCard({
      cluster:     clusterForType(t.type),
      statusClass: "sm-status-" + t.status,
      dataset:     { ticketId: t.id, ticketType: t.type, ticketStatus: t.status },
      width:       typeof opts.width === "number" ? opts.width : undefined,
      isShadow:    !!opts.isShadow,
      keyEl:       t.ticketKey ? buildTicketKeyEl(t.ticketKey, opts.projectId) : null,
      title:       t.title || "",
      meta:        meta,
      onDblClick:  typeof opts.onTicketClick === "function" ? function () { opts.onTicketClick(t.id); } : null,
      dragType:    opts.dragType,
      dragId:      opts.dragId || t.id,
      dragOnEnd:   opts.dragOnEnd
    });
  }

  /**
   * SM-20 Phase B — patch an EXISTING `.sm-story-card` DOM node in place to
   * reflect the latest ticket data, without destroying the node. Used by
   * the renderers' content-only fast-path so applyRemote-driven field edits
   * don't trigger a full host.innerHTML rebuild.
   *
   * Visible card surfaces that may change between renders:
   *   - cluster class (.sm-cluster-X)  ← `t.type`
   *   - status class  (.sm-status-Y)   ← `t.status`
   *   - dataset: ticketType, ticketStatus
   *   - title text                      ← `t.title`
   *   - status pill text + class        ← `t.status`
   *   - DoR badge text / presence       ← `t.definitionOfReady.items`
   *   - DoD badge text / presence       ← `t.definitionOfDone.items`
   *
   * ticketKey, drag-handlers, dblclick-handler, contextmenu-handler — all
   * stable across edits (they were registered when the card was first
   * created). We never touch them here.
   */
  function patchTicketCardInPlace(card, t, linkInfo, lastExecution, opts) {
    if (!card || !t) return;
    opts = opts || {};
    const cluster = clusterForType(t.type);
    const newClass = "sm-story-card sm-cluster-" + cluster + " sm-status-" + t.status
                   + (card.classList.contains("sm-card-shadow") ? " sm-card-shadow" : "")
                   + (card.classList.contains("sm-dragging")    ? " sm-dragging"    : "")
                   + (card.classList.contains("sm-card-flash")  ? " sm-card-flash"  : "");
    if (card.className !== newClass) card.className = newClass;
    if (card.dataset.ticketType   !== t.type)   card.dataset.ticketType   = t.type;
    if (card.dataset.ticketStatus !== t.status) card.dataset.ticketStatus = t.status;

    const titleEl = card.querySelector(".sm-story-title");
    if (titleEl && titleEl.textContent !== (t.title || "")) titleEl.textContent = t.title || "";

    const statusEl = card.querySelector(".sm-card-status");
    if (statusEl) {
      const wantClass = "sm-card-status sm-status-pill-" + t.status;
      if (statusEl.className !== wantClass) statusEl.className = wantClass;
      if (statusEl.textContent !== t.status) statusEl.textContent = t.status;
    }

    const meta = card.querySelector(".sm-card-meta");
    if (meta) {
      patchBadge(meta, "sm-badge-dor", "DoR", t.definitionOfReady && t.definitionOfReady.items, "Definition of Ready");
      patchBadge(meta, "sm-badge-dod", "DoD", t.definitionOfDone  && t.definitionOfDone.items,  "Definition of Done");
      patchLinkBadges(meta, linkInfo);
      // SM-60: keep the last-execution pill in sync. test-definition cards
      // get/keep the badge; other types must NOT show it (e.g. type-change).
      patchLastExecutionBadge(meta, t, lastExecution, opts);
    }
  }

  function patchLastExecutionBadge(meta, t /* , lastExecution, opts */) {
    // Remove any existing badge — cheaper than diffing colour/text.
    const existing = meta.querySelector(".sm-exec-badge");
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
    // Badge lives only on test-execution cards now (SM-60 revision).
    if (t.type !== "test-execution") return;
    meta.appendChild(buildExecutionOutcomeBadge(t));
  }

  function patchLinkBadges(meta, linkInfo) {
    // Pure remove-and-rebuild: link badges have click handlers that capture
    // a hostRef, so we can't simply patch text. Drop both, then re-append.
    meta.querySelectorAll(".sm-link-badge").forEach(b => b.parentNode && b.parentNode.removeChild(b));
    if (!linkInfo) return;
    if (linkInfo.forward > 0) {
      const sem = dominantSemantic(linkInfo.forwardSemantics);
      meta.appendChild(buildLinkBadge("forward", linkInfo.forward, sem, linkInfo.forwardTargetKeys, linkInfo));
    }
    if (linkInfo.backward > 0) {
      const sem = dominantSemantic(linkInfo.backwardSemantics);
      meta.appendChild(buildLinkBadge("backward", linkInfo.backward, sem, linkInfo.backwardSourceKeys, linkInfo));
    }
  }

  function patchBadge(meta, badgeClass, label, items, tooltip) {
    const text = checklistBadge(items);
    let badge = meta.querySelector("." + badgeClass);
    if (text) {
      const want = label + " " + text;
      if (!badge) {
        // Append after any existing badges (preserve order: DoR then DoD).
        const span = document.createElement("span");
        span.className = "sm-badge " + badgeClass;
        span.title = tooltip;
        span.textContent = want;
        meta.appendChild(span);
      } else if (badge.textContent !== want) {
        badge.textContent = want;
      }
    } else if (badge && badge.parentNode) {
      badge.parentNode.removeChild(badge);
    }
  }

  // ---- Shared release-label header (SM-169) --------------------------
  //
  // The Story-Map's stacked release rows AND the Kanban's release swimlanes
  // render the release header identically through this one component, so the
  // chevron, the clickable name, the completed/cancelled strikethrough + pill
  // all look and behave the same in both views. The caller owns the outer
  // container's dataset / lifecycle hooks (Map needs tagBirth + sync keys);
  // this builds the `.sm-release-label-row` and appends the standard parts.
  //
  // spec:
  //   id            release id (passed back to the callbacks)
  //   name          display name
  //   status        release.status ("completed"/"cancelled"/… or null)
  //   collapsed     boolean — chevron glyph + collapsed row styling
  //   onToggleCollapsed(id)   chevron click (collapse/expand)
  //   onLabelClick(id)        label click (e.g. open edit dialog). Omit → the
  //                           label is non-interactive (used for "No release").
  //   trailing      optional array of extra elements appended after the pill
  //                 (e.g. the Kanban count badge, or the Map "+ Add Release").
  function renderReleaseLabelRow(spec) {
    const row = el("div", {
      class: "sm-release-label-row" + (spec.collapsed ? " sm-release-collapsed" : ""),
      dataset: { releaseId: spec.id || "", status: spec.status || "" }
    });
    // SM-178: chevron + name + pill live in a `.sm-release-label-main` cluster
    // so the Story-Map can make JUST that cluster sticky to the left edge
    // (orientation while scrolling horizontally through wide process steps).
    // The Kanban swimlane header uses the same DOM; only the Map pins it (CSS).
    const main = el("div", { class: "sm-release-label-main" });
    const chevron = el("button", {
      class: "sm-release-chevron",
      type: "button",
      title: spec.collapsed ? "Expand release" : "Collapse release",
      text: spec.collapsed ? "▶" : "▼"
    });
    chevron.setAttribute("aria-expanded", spec.collapsed ? "false" : "true");
    chevron.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (typeof spec.onToggleCollapsed === "function") spec.onToggleCollapsed(spec.id);
    });
    main.appendChild(chevron);

    const labelProps = { class: "sm-release-label", dataset: { status: spec.status || "" }, text: spec.name };
    if (typeof spec.onLabelClick === "function") labelProps.title = "Click to edit release";
    const label = el("div", labelProps);
    if (typeof spec.onLabelClick === "function") {
      label.addEventListener("click", (ev) => { ev.stopPropagation(); spec.onLabelClick(spec.id); });
    } else {
      label.style.cursor = "default";
    }
    main.appendChild(label);

    // SM-277: fixed column order — title (fixed width) → progress count →
    // status pill → trailing (Add release). Keeps the badges from fluttering as
    // titles / counts / the completed pill change width across rows + re-renders.
    // SM-239: X/Y progress badge over non-epic work items. Hidden for an empty
    // release (total 0 → neutral, never green). Green (.complete) at done===total.
    if (spec.progress && spec.progress.total > 0) {
      main.appendChild(el("span", {
        class: "sm-release-progress" + (spec.progress.complete ? " complete" : ""),
        text: spec.progress.done + "/" + spec.progress.total,
        title: spec.progress.done + " of " + spec.progress.total + " work items done"
      }));
    }
    if (spec.status === "completed") {
      main.appendChild(el("span", { class: "sm-release-pill sm-release-pill-completed", text: "Completed" }));
    } else if (spec.status === "cancelled") {
      main.appendChild(el("span", { class: "sm-release-pill sm-release-pill-cancelled", text: "Cancelled" }));
    }
    row.appendChild(main);
    if (Array.isArray(spec.trailing)) for (const t of spec.trailing) if (t) row.appendChild(t);
    return row;
  }

  // SM-239: patch an existing release-label-row's progress badge in place —
  // used by the renderers' Phase-A/B fast-paths (which don't rebuild the row)
  // so a child status change that shifts X/Y never leaves the badge stale.
  function updateReleaseProgressBadge(rowEl, progress) {
    if (!rowEl) return;
    const main = rowEl.querySelector(".sm-release-label-main") || rowEl;
    let badge = main.querySelector(".sm-release-progress");
    if (!progress || progress.total <= 0) {
      if (badge && badge.parentNode) badge.parentNode.removeChild(badge);
      return;
    }
    const text = progress.done + "/" + progress.total;
    if (!badge) {
      badge = el("span", { class: "sm-release-progress", text: text });
      main.appendChild(badge);
    } else if (badge.textContent !== text) {
      badge.textContent = text;
    }
    badge.classList.toggle("complete", !!progress.complete);
    badge.title = progress.done + " of " + progress.total + " work items done";
  }

  return {
    TYPE_TO_CLUSTER,
    clusterForType,
    checklistBadge,
    CARD_AGE,
    buildAgeBadge,
    renderCard,
    renderTicketCard,
    renderReleaseLabelRow,
    updateReleaseProgressBadge,
    buildTicketKeyEl,
    patchTicketCardInPlace,
    // SM-49
    computeLinkIndex,
    dominantSemantic,
    buildLinkBadge,
    // SM-60 — outcome badge lives on test-execution cards
    buildExecutionOutcomeBadge,
    // Kept for compat / tests — still computes "latest exec per definition"
    // even though the card renderer no longer surfaces it.
    computeLastExecutionIndex
  };
}));
