/**
 * Content script entrypoint (Phase 2 Task 5: selection capture + micro-button).
 *
 * This file is intentionally thin. Everything testable lives in `src/content/`:
 *   normalize.ts  clean the text, split sentences (pure)
 *   guards.ts     refuse passwords and browser surfaces (pure)
 *   gate.ts       dedupe, debounce, dismissal policy (pure)
 *   selection.ts  read the selection and run the guards
 *   micro-button.ts the 28 px button
 *   quick-popup.ts  the quick-read pop-up (spec 4.2)
 *
 * Spec 3 requires this to be switchable to `activeTab` + `scripting`. All logic
 * is behind factories and only imported from here, so that swap is a manifest
 * change plus injecting these modules from the background.
 */

import { defineContentScript } from "wxt/utils/define-content-script";
import { createMicroButton } from "../content/micro-button";
import { createQuickPopup, type QuickPopupController } from "../content/quick-popup";
import {
  createSelectionWatcher,
  isActionableSelection,
  readSelection,
  targetFromSelection,
  type ResolvedSelection,
} from "../content/selection";
import { DEFAULT_SETTINGS, ROOT_KEY, readStore, updateStore } from "../shared/storage";
import { sendToBackground } from "../shared/bus";
import { makeTranslator, tNow, type Translate } from "../shared/i18n";
import { requestMessages, requestPanel } from "../shared/requests";
import type { Accent, FromBackground, PracticeKind, PracticeTarget } from "../shared/messages";
import type { Settings } from "../shared/storage";

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
     * Liveness.
     *
     * Chrome does NOT un-inject a content script when the extension is disabled,
     * reloaded or uninstalled: an already-injected script keeps running in that
     * tab until the page is refreshed. Left alone, that means a working
     * micro-button on every page, from an extension the user has switched off.
     *
     * So before showing any UI we ping the service worker. If nobody answers, the
     * extension is gone and we tear ourselves down completely: listeners, DOM,
     * storage subscription. A page refresh brings it back if the user re-enables
     * the extension.
     */
    let alive = true;

    const isAlive = async (): Promise<boolean> => {
      if (!alive || chrome.runtime.id === undefined) return false;
      try {
        const reply = await sendToBackground<FromBackground>(
          { type: "content:ready" },
          (r) => r,
        );
        if (reply === null) {
          alive = false;
          return false;
        }
        return true;
      } catch {
        // ContextGoneError: the extension was disabled, reloaded or removed.
        alive = false;
        return false;
      }
    };

    /**
     * The running UI, or null when the feature is switched off.
     *
     * Everything is created and torn down together, so switching the setting off
     * removes our listeners and our DOM rather than merely hiding the button.
     * That matters: leaving a `mouseup` listener attached would keep costing work
     * on every page even after the user said no.
     */
    let running: { stop: () => void } | null = null;

    /** Latest settings; kept in sync with `chrome.storage` while the page is open. */
    let currentSettings: Settings = DEFAULT_SETTINGS;
    /** The localised message bag for `settings.uiLanguage`. */
    let translator: Translate = (key, ...substitutions) => tNow(key, substitutions);
    /** At most one quick-read pop-up per frame. */
    let activePopup: QuickPopupController | null = null;

    const loadTranslator = async (settings: Settings): Promise<void> => {
      // A content script cannot read `_locales` itself (cross-origin fetch), so
      // the background answers with the bag. If that fails, `tNow` still gives
      // the browser's language through `chrome.i18n` instead of raw keys.
      const messages = await requestMessages(settings.uiLanguage);
      translator = messages
        ? makeTranslator(messages)
        : (key, ...substitutions) => tNow(key, substitutions);
    };

    /**
     * Mark the first-run tooltip as seen and hand the target to the panel.
     *
     * One write does both: the panel must see the text/accent/speed together,
     * and the tooltip must never appear a second time (spec 4.1).
     */
    const beginPractice = async (
      selection: ResolvedSelection,
      accent: Accent,
      speed: number,
    ): Promise<boolean> => {
      const target: PracticeTarget = targetFromSelection(selection, accent, speed);
      await updateStore((current) => ({
        store: {
          ...current,
          session: { ...current.session, target },
          settings: { ...current.settings, firstRunTooltipShown: true },
        },
        result: null,
      })).catch(() => null);
      return requestPanel(target);
    };

    const openPopup = async (
      selection: ResolvedSelection,
      settings: Settings,
    ): Promise<void> => {
      activePopup?.destroy();
      let popup: QuickPopupController | null = null;
      popup = createQuickPopup(ctx, {
        t: translator,
        settings,
        selection,
        onClose: () => {
          if (activePopup === popup) activePopup = null;
        },
        onPractise: async (_kind: PracticeKind, accent: Accent, speed: number) =>
          beginPractice(selection, accent, speed),
      });
      activePopup = popup;
      await popup.show();
    };

    const handleActivation = async (
      selection: ResolvedSelection,
      settings: Settings,
    ): Promise<void> => {
      // Spec 4.3: "Open practice automatically" skips the quick read. It is off
      // by default, so the normal flow is select -> pop-up -> Practise.
      if (settings.openPracticeAutomatically) {
        const opened = await beginPractice(selection, settings.defaultAccent, settings.defaultSpeed);
        if (opened) return;
      }
      await openPopup(selection, settings);
    };

    const start = (): void => {
      if (running) return;
      const button = createMicroButton(ctx, {
        label: translator("microButtonLabel"),
        // Spec 4.1: the first-run tooltip is shown exactly once.
        tooltip: currentSettings.firstRunTooltipShown
          ? null
          : translator("microButtonFirstRun"),
        onActivate: (selection) => {
          void handleActivation(selection, currentSettings);
        },
        onDismiss: () => undefined,
      });

      const watcher = createSelectionWatcher({
        enabled: true,
        onSelection: (selection: ResolvedSelection) => {
          // Never show UI from a script whose extension has gone away.
          void (async () => {
            if (!(await isAlive())) {
              shutdown();
              return;
            }
            await button.show(selection);
          })();
        },
        onDismiss: () => {
          button.hide();
        },
        // Follow the selection while the page scrolls, so the button stays next
        // to the words instead of being left behind pointing at other text.
        onUpdate: (next) => {
          button.follow(next);
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
      activePopup?.destroy();
      activePopup = null;
      running?.stop();
    };

    const applySetting = (enabled: boolean): void => {
      if (enabled) start();
      else stop();
    };

    /** Full teardown: the extension is gone, so stop doing anything at all. */
    const shutdown = (): void => {
      alive = false;
      stop();
      removeListeners();
    };

    /**
     * Answer the background's "open the pop-up for the current selection"
     * request (spec 5.9: Alt+Shift+S).
     *
     * The background cannot read the page's selection, so it asks us. A `false`
     * reply tells it to show the friendly fallback instead.
     */
    const onRuntimeMessage = (
      message: unknown,
      _sender: chrome.runtime.MessageSender,
      sendResponse: (response: unknown) => void,
    ): boolean => {
      if (typeof message !== "object" || message === null) return false;
      const request = message as { type?: unknown; intent?: unknown };
      if (request.type !== "selection:request") return false;

      void (async () => {
        if (!(await isAlive())) {
          shutdown();
          sendResponse({ ok: false });
          return;
        }

        const selection = readSelection();
        if (!selection || !isActionableSelection(selection, window.location.href)) {
          sendResponse({ ok: false });
          return;
        }

        sendResponse({ ok: true });
        // The shortcut opens the quick read; the context menu asks to practise.
        if (request.intent === "practice") {
          const opened = await beginPractice(
            selection,
            currentSettings.defaultAccent,
            currentSettings.defaultSpeed,
          );
          if (!opened) await openPopup(selection, currentSettings);
          return;
        }
        await openPopup(selection, currentSettings);
      })().catch(() => {
        try {
          sendResponse({ ok: false });
        } catch {
          // The channel may already be closed; nothing useful to do.
        }
      });
      return true;
    };
    chrome.runtime.onMessage.addListener(onRuntimeMessage);

    /**
     * React to settings changing while the page stays open.
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
      void (async () => {
        const store = await readStore().catch(() => null);
        if (!store) return;

        const languageChanged = store.settings.uiLanguage !== currentSettings.uiLanguage;
        currentSettings = store.settings;

        if (languageChanged) {
          await loadTranslator(store.settings);
          // Labels are baked into the button and tooltip; rebuild both.
          activePopup?.destroy();
          running?.stop();
        }
        applySetting(store.settings.showButtonOnSelection);
      })().catch(() => undefined);
    };
    chrome.storage.onChanged.addListener(onStorageChanged);

    /** Detach every listener this script installed. */
    function removeListeners(): void {
      chrome.storage.onChanged.removeListener(onStorageChanged);
      chrome.runtime.onMessage.removeListener(onRuntimeMessage);
    }

    // Initial state.
    const initial = await readStore().catch(() => null);
    currentSettings = initial?.settings ?? DEFAULT_SETTINGS;
    await loadTranslator(currentSettings);
    applySetting(currentSettings.showButtonOnSelection);

    ctx.onInvalidated(() => {
      removeListeners();
      stop();
    });
  },
});
