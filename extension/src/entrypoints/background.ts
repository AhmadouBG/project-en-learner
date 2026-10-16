import { defineBackground } from "wxt/utils/define-background";
import { loadBundledTable, lookup, lookupVariants } from "../ipa/lookup";
import type { IpaResult } from "../shared/messages";

/**
 * Background service worker (Phase 1).
 *
 * Responsibilities in v1.0:
 *  - own the dictionary cache and the only outbound network call (spec 5.3)
 *  - open the side panel from the toolbar / shortcut / context menu (spec 5.9)
 *  - hold the practice hand-off target so a panel opened later still has the text
 *
 * It must stay small: a service worker cannot use DOM APIs, so no TTS, no DOM.
 */
export default defineBackground(() => {
  // Chrome 114+ side panel. `setPanelBehavior` is how the toolbar action opens
  // the panel: the browser handles the click itself, so no user-gesture check is
  // needed and there is no `action.onClicked` event to listen for. This is the
  // reliable fallback the spec requires in 5.10.
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err: unknown) => {
      console.error("[background] setPanelBehavior failed", err);
    });

  // Spec 5.9: Alt+Shift+S. A `commands` dispatch counts as a user gesture for
  // `sidePanel.open()` in Chrome 114+. Chrome reserves some key combos; if the
  // user has not accepted the default we simply do nothing rather than throw.
  chrome.commands.onCommand.addListener((command, tab) => {
    if (command !== "open-panel") return;
    if (typeof tab?.windowId !== "number") return;
    void openPanel(tab.windowId);
  });

  // Spec 5.9: context menu on selected text. Created once per install/profile.
  chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason !== "install" && details.reason !== "update") return;
    void createContextMenu();
  });

  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== "es-practise") return;
    if (typeof tab?.windowId !== "number") return;
    const selected = info.selectionText?.trim();
    console.info("[background] context menu practise", { hasSelection: Boolean(selected) });
    void openPanel(tab.windowId);
  });

  // Spec 5.10: one typed protocol. The content script asks us to open the panel
  // for the selection it just captured. Returning true keeps the channel open
  // for the async reply.
  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    if (typeof message !== "object" || message === null) return false;
    const type = (message as { type?: unknown }).type;
    // Liveness ping. Chrome leaves content scripts injected when an extension is
    // disabled or reloaded, so they need a way to notice we are gone. The content
    // script pings before showing any UI; if we do not answer, it tears itself
    // down. A null reply means "no extension", so this must answer synchronously.
    if (type === "content:ready") {
      sendResponse({ type: "settings:changed" });
      return false;
    }

    if (type === "ipa:lookup") {
      const word = (message as { word?: unknown }).word;
      const requestId = (message as { requestId?: unknown }).requestId;
      if (typeof word !== "string" || typeof requestId !== "string") return false;

      void answerIpa(word, requestId, sendResponse);
      return true;
    }

    if (type !== "open-panel") return false;

    const windowId = sender.tab?.windowId;
    if (typeof windowId !== "number") {
      sendResponse(null);
      return false;
    }

    void openPanel(windowId).then(() => sendResponse({ type: "settings:changed" }));
    return true;
  });

/**
 * Answer a pronunciation request from the bundled CMUdict (spec 5.2).
 *
 * Answers "not found" rather than an error when the word is absent: a missing
 * entry is a normal outcome, not a failure, and the pop-up still has the
 * dictionary API's transcription to fall back on.
 *
 * A failed load is also answered rather than thrown, so one broken build cannot
 * wedge the message channel.
 */
async function answerIpa(
  word: string,
  requestId: string,
  sendResponse: (response: unknown) => void,
): Promise<void> {
  let result: IpaResult;
  try {
    const table = await loadBundledTable();
    const primary = lookup(table, word);
    if (!primary) {
      result = { ok: false, word };
    } else {
      const variants = lookupVariants(table, word)
        .map((v) => ({ ipa: v.ipa }))
        // The primary reading is first in `variants`, so drop it from the list.
        .filter((v, i) => i > 0 || v.ipa !== primary.ipa);
      result = {
        ok: true,
        word: primary.word,
        ipa: primary.ipa,
        syllables: primary.syllables.map((s) => ({ ipa: s.ipa, stress: s.stress })),
        variants,
      };
    }
  } catch {
    result = { ok: false, word };
  }
  sendResponse({ type: "ipa:result", requestId, result });
}
});

async function createContextMenu(): Promise<void> {
  try {
    await chrome.contextMenus.removeAll();
    chrome.contextMenus.create({
      id: "es-practise",
      title: chrome.i18n.getMessage("btnPractise"),
      contexts: ["selection"],
    });
  } catch (err) {
    console.error("[background] context menu creation failed", err);
  }
}

async function openPanel(windowId: number): Promise<void> {
  try {
    await chrome.sidePanel.open({ windowId });
  } catch (err) {
    // Spec 5.10: a user gesture is required. If it is missing, the user can
    // always click the toolbar icon, which setPanelBehavior handles.
    console.error("[background] sidePanel.open rejected", err);
  }
}
