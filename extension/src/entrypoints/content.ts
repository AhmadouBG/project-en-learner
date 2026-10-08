/**
 * Content script entrypoint (Phase 2 Task 5: selection capture + micro-button).
 *
 * This file is intentionally thin. Everything testable lives in `src/content/`:
 *   normalize.ts  clean the text, split sentences (pure)
 *   guards.ts     refuse passwords and browser surfaces (pure)
 *   gate.ts       dedupe, debounce, dismissal policy (pure)
 *   selection.ts  read the selection and run the guards
 *   micro-button.ts the 28 px button
 *
 * Spec 3 requires this to be switchable to `activeTab` + `scripting`. All logic
 * is behind factories and only imported from here, so that swap is a manifest
 * change plus injecting these modules from the background.
 */

import { defineContentScript } from "wxt/utils/define-content-script";
import { createMicroButton } from "../content/micro-button";
import {
  createSelectionWatcher,
  targetFromSelection,
  type ResolvedSelection,
} from "../content/selection";
import { DEFAULT_SETTINGS, ROOT_KEY, readStore, updateStore } from "../shared/storage";
import { sendToBackground } from "../shared/bus";
import type { FromBackground } from "../shared/messages";

/** Where the content script runs; see DECISIONS.md 8b for why not `<all_urls>`. */
const MATCHES = ["http://*/*", "https://*/*", "file:///*"];

/** `.pdf` URLs are served by Chrome's built-in PDF viewer. See DECISIONS.md 8b. */
const EXCLUDE_MATCHES = ["http://*/*.pdf", "https://*/*.pdf", "file://*/*.pdf"];

export default defineContentScript({
  matches: MATCHES,
  excludeMatches: EXCLUDE_MATCHES,

  /**
   * Spec 5.1: handle "selections inside iframes where possible". A DOM selection
   * cannot span frames, so with `allFrames: false` iframe selections would be
   * silently invisible. Load-bearing, not an optimisation.
   */
  allFrames: true,

  /** `about:blank` / `srcdoc` frames inherit the parent origin and match no pattern. */
  matchOriginAsFallback: true,

  runAt: "document_idle",

  async main(ctx) {
    /**
     * The running UI, or null when the feature is switched off.
     *
     * Everything is created and torn down together, so switching the setting off
     * removes our listeners and our DOM rather than merely hiding the button.
     * That matters: leaving a `mouseup` listener attached would keep costing work
     * on every page even after the user said no.
     */
    let running: { stop: () => void } | null = null;

    const start = async (): Promise<void> => {
      if (running) return;
      const store = await readStore().catch(() => null);
      const settings = store?.settings ?? DEFAULT_SETTINGS;

      const button = createMicroButton(ctx, {
        label: t("microButtonLabel"),
        // Spec 4.1: the first-run tooltip is shown exactly once.
        tooltip: settings.firstRunTooltipShown ? null : t("microButtonFirstRun"),
        onActivate: (selection) => {
          void onButtonActivated(selection);
        },
        onDismiss: () => undefined,
      });

      const watcher = createSelectionWatcher({
        enabled: true,
        onSelection: (selection: ResolvedSelection) => {
          void button.show(selection);
        },
        onDismiss: () => {
          button.hide();
        },
        // Clicking our own button is not a new selection, so its events must be
        // ignored by the watcher (spec 5.1).
        ownHost: () => button.host,
      });

      running = {
        stop: () => {
          watcher.destroy();
          button.destroy();
          running = null;
        },
      };
    };

    const stop = (): void => {
      running?.stop();
    };

    const applySetting = async (enabled: boolean): Promise<void> => {
      if (enabled) await start();
      else stop();
    };

    // Initial state.
    await applySetting(settingsOrDefault(await readStore()).showButtonOnSelection);

    /**
     * React to the setting changing while the page stays open.
     *
     * Reading the setting once at `document_idle` is not enough: the user would
     * have to refresh every open tab before "Show button on selection" took
     * effect, which reads as the setting being broken.
     */
    const onStorageChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ): void => {
      if (area !== "local" || !(ROOT_KEY in changes)) return;
      void readStore()
        .then((store) => applySetting(store.settings.showButtonOnSelection))
        .catch(() => undefined);
    };
    chrome.storage.onChanged.addListener(onStorageChanged);

    ctx.onInvalidated(() => {
      chrome.storage.onChanged.removeListener(onStorageChanged);
      stop();
    });
  },
});

/** Read settings from a store, falling back to defaults. */
function settingsOrDefault(store: Awaited<ReturnType<typeof readStore>> | null) {
  return store?.settings ?? DEFAULT_SETTINGS;
}

/**
 * Mark the first-run tooltip as shown, then ask the background to open the side
 * panel for this selection.
 *
 * The panel cannot display the text until its own phase; opening it is the
 * visible end-to-end result today and is where the text hand-off lands next.
 */
async function onButtonActivated(
  selection: Parameters<typeof targetFromSelection>[0],
): Promise<void> {
  const store = await readStore().catch(() => null);
  const settings = settingsOrDefault(store);
  const target = targetFromSelection(selection, settings.defaultAccent, settings.defaultSpeed);

  // One write: stash the target and mark the tooltip as seen.
  await updateStore((current) => ({
    store: {
      ...current,
      session: { target },
      settings: { ...current.settings, firstRunTooltipShown: true },
    },
    result: null,
  })).catch(() => null);

  await sendToBackground<FromBackground>({ type: "open-panel", target }, (reply) => reply).catch(
    () => null,
  );
}

/** `chrome.i18n` lookup with a visible fallback. */
function t(key: string): string {
  const message = chrome.i18n.getMessage(key);
  return message === "" ? key : message;
}