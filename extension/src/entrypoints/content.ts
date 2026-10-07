/**
 * Content script (Phase 2 Task 1: frame injection).
 *
 * Spec 3 asks for a content script on `<all_urls>` so the micro-button is
 * available anywhere, while keeping it switchable to `activeTab` + `scripting`.
 * To make that swap a one-line change, ALL of the real logic lives in
 * `src/content/` behind factories; this file only decides *how* it is loaded.
 *
 * Spec 9: "no work on pages until the user selects text". Until Task 5 wires up
 * selection, this script attaches no listeners, injects no DOM and loads no
 * stylesheet, so its cost is just its own bytes.
 */

import { defineContentScript } from "wxt/utils/define-content-script";

/**
 * Where the content script runs (spec 3: "implement it with `content_scripts`
 * matching `<all_urls>`", while staying switchable to `activeTab` + `scripting`).
 *
 * We enumerate the three real-world schemes instead of using `<all_urls>` so we
 * can pair them with explicit exclusions. `chrome://` and `chrome-extension://`
 * are deliberately absent: that covers the Web Store and Chrome's built-in PDF
 * viewer, both of which are extension pages Chrome refuses to inject into
 * anyway. Listing them by hand keeps the intent visible rather than relying on
 * Chrome's implicit blocking.
 */
const MATCHES = ["http://*/*", "https://*/*", "file:///*"];

/**
 * A bare `.pdf` URL is served by that same built-in viewer while keeping the
 * original URL, so it *would* match a broad https pattern. Excluding it means the
 * micro-button can never appear over a rendered PDF.
 *
 * Exclusions use `excludeMatches` rather than `!` prefixes inside `matches`,
 * because Chrome's match-pattern parser rejects a wildcard scheme in a negative
 * pattern (`Invalid scheme`) -- verified by loading the extension.
 */
const EXCLUDE_MATCHES = ["http://*/*.pdf", "https://*/*.pdf", "file://*/*.pdf"];

export default defineContentScript({
  matches: MATCHES,
  excludeMatches: EXCLUDE_MATCHES,

  /**
   * Spec 5.1: handle "selections inside iframes where possible".
   *
   * A DOM selection cannot span frames, so each frame that owns the selection
   * shows the micro-button for its own selection. With `allFrames: false` the
   * script only runs in the top document and iframe selections are simply
   * invisible to us -- so this flag is load-bearing, not an optimisation.
   */
  allFrames: true,

  /**
   * `about:blank` and `srcdoc` iframes inherit their parent's origin, so they
   * match no pattern of their own. This is how they get the script.
   */
  matchOriginAsFallback: true,

  // Page CSP does not affect us: our UI goes into a shadow root with an inline
  // <style>, which page CSP does not govern.
  runAt: "document_idle",

  main() {
    // Placeholder until the selection watcher lands (Task 5).
    void 0;
  },
});