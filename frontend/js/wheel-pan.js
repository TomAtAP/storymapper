/**
 * Shift+wheel → horizontal pan (SM-281).
 *
 * A mouse with only a vertical scroll wheel produces no deltaX, ever. On
 * macOS the overlay scrollbars only flash for the axis being scrolled, so
 * such users never see (let alone grab) the horizontal bar — the map's
 * off-screen process steps become unreachable. Chrome translates
 * shift+wheel into horizontal scrolling natively; Safari does not.
 *
 * This module installs that translation on the view scroller: while shift
 * is held, a vertical wheel delta pans horizontally instead. Events that
 * already carry a horizontal delta (Chrome's native translation, trackpad
 * swipes) pass through untouched — no double-scroll.
 *
 * UMD-wrapped — usable in browser and Node tests.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    (root.STORYMAP = root.STORYMAP || {}).wheelPan = factory();
  }
}(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const WHEEL_PAN = {
    // Pixels per line for deltaMode DOM_DELTA_LINE (Firefox wheel events).
    LINE_HEIGHT_PX: 16,
  };

  const DOM_DELTA_LINE = 1;

  /**
   * Horizontal delta (px) a wheel event should pan, or 0 when the event
   * must not be translated (no shift, or the engine already produced a
   * horizontal delta itself).
   */
  function translateShiftWheel(ev) {
    if (!ev.shiftKey) return 0;
    if (ev.deltaX) return 0;   // engine translated already (Chrome) or trackpad swipe
    const dy = ev.deltaY || 0;
    return ev.deltaMode === DOM_DELTA_LINE ? dy * WHEEL_PAN.LINE_HEIGHT_PX : dy;
  }

  /**
   * Install the shift+wheel pan on a scroll container. Returns an
   * uninstall function. The listener is non-passive on purpose — the
   * translated event must be consumed or the page would ALSO scroll
   * vertically.
   */
  function installShiftWheelPan(el) {
    function onWheel(ev) {
      const dx = translateShiftWheel(ev);
      if (!dx) return;
      el.scrollLeft += dx;
      ev.preventDefault();
    }
    el.addEventListener("wheel", onWheel, { passive: false });
    return function uninstall() {
      el.removeEventListener("wheel", onWheel);
    };
  }

  return { WHEEL_PAN, translateShiftWheel, installShiftWheelPan };
}));
