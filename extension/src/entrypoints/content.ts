/**
 * Content script (Phase 1: deliberately inert).
 *
 * Spec 3 asks for a content script on `<all_urls>` so the micro-button is
 * available anywhere, while keeping it switchable to `activeTab` + `scripting`.
 * To make that swap a one-line change, ALL of the real logic lives in
 * `src/content/selection.ts` behind `createSelectionWatcher`; this file only
 * decides *how* it gets loaded.
 *
 * Spec 9: "no work on pages until the user selects text". Phase 1 attaches no
 * listeners, inserts no DOM and loads no stylesheet, so the cost of the content
 * script right now is just this module's bytes.
 */

import { defineContentScript } from "wxt/utils/define-content-script";

export default defineContentScript({
  matches: ["<all_urls>"],
  // Spec 3: pages with strict CSP should not break us. Phase 2 injects our UI
  // into a shadow root with an inline <style>, which is unaffected by page CSP.
  runAt: "document_idle",

  main() {
    // Guard against our own UI and pages that cannot host an extension page.
    if (window.top !== window.self && isFramed()) return;

    // Phase 2 wires this up:
    //   createSelectionWatcher(ctx, { onSelection, onDismiss })
    // Phase 1 keeps the import out of the bundle entirely.
    void 0;
  },
});

/**
 * We do run inside iframes (spec 5.1 wants iframe selections "where possible"),
 * but not inside other extensions' frames or sandboxed frames we cannot style.
 */
function isFramed(): boolean {
  try {
    return window.self !== window.top;
  } catch {
    // Cross-origin frame: reachable but we cannot rely on top.
    return true;
  }
}