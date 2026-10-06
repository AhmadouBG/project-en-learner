import { defineBackground } from "wxt/utils/define-background";

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
