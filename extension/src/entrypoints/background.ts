import { defineBackground } from "wxt/utils/define-background";
import { lookupDictionary } from "../background/dictionary-cache";
import { loadBundledTable, lookup, lookupVariants } from "../ipa/lookup";
import { sendToTab } from "../shared/bus";
import { tNow, loadMessages } from "../shared/i18n";
import {
  classifyText,
  type FromBackground,
  type IpaResult,
  type PracticeTarget,
} from "../shared/messages";
import {
  DEFAULT_SETTINGS,
  readStore,
  setSessionNotice,
  setSessionTarget,
} from "../shared/storage";

/**
 * Background service worker (spec 5.10).
 *
 * Responsibilities in v1.0:
 *  - own the dictionary cache and the only outbound network call (spec 5.3)
 *  - answer CMUdict pronunciations without shipping the 2 MB table to tabs
 *  - open the side panel from the toolbar / shortcut / context menu (spec 5.9)
 *  - hold the practice hand-off target so a panel opened later still has the text
 *
 * It stays small: a service worker has no DOM, so no TTS and no rendering.
 */
export default defineBackground(() => {
  // Chrome 114+ side panel. `setPanelBehavior` is how the toolbar action opens
  // the panel: the browser handles the click itself, so no user-gesture check is
  // needed and there is no `action.onClicked` event to listen for. This is the
  // reliable fallback the spec requires in 5.10.
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err: unknown) => {
      console.warn("[background] setPanelBehavior failed", err);
    });

  // Spec 5.9: Alt+Shift+S. A `commands` dispatch counts as a user gesture for
  // `sidePanel.open()` in Chrome 114+. Chrome reserves some key combos; if the
  // user has not accepted the default we simply do nothing rather than throw.
  chrome.commands.onCommand.addListener((command, tab) => {
    if (command !== "open-panel") return;
    void requestSelection(tab);
  });

  // Spec 5.9: context menu on selected text. Created once per install/profile.
  chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason !== "install" && details.reason !== "update") return;
    void createContextMenu();
  });

  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== "es-practise") return;
    const selectionText = typeof info.selectionText === "string" ? info.selectionText : "";
    void practiseText(tab, selectionText);
  });

  // Spec 5.10: one typed protocol. Returning true keeps the channel open for an
  // async reply.
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

    if (type === "dictionary:lookup") {
      const word = (message as { word?: unknown }).word;
      const requestId = (message as { requestId?: unknown }).requestId;
      if (typeof word !== "string" || typeof requestId !== "string") return false;

      void answerDictionary(word, requestId, sendResponse);
      return true;
    }

    if (type === "ipa:lookup") {
      const word = (message as { word?: unknown }).word;
      const requestId = (message as { requestId?: unknown }).requestId;
      if (typeof word !== "string" || typeof requestId !== "string") return false;

      void answerIpa(word, requestId, sendResponse);
      return true;
    }

    if (type === "i18n:messages") {
      const language = (message as { language?: unknown }).language;
      const requestId = (message as { requestId?: unknown }).requestId;
      if ((language !== "en" && language !== "fr") || typeof requestId !== "string") {
        return false;
      }

      void answerMessages(language, requestId, sendResponse);
      return true;
    }

    if (type !== "open-panel") return false;

    const target = parseTarget((message as { target?: unknown }).target);
    void handleOpenPanel(target, sender).then(sendResponse);
    return true;
  });
});

/**
 * Ask the page to open the quick-read pop-up for its selection (spec 5.9).
 *
 * A content script is the only context that can see the selection geometry. If
 * the page has no content script (a restricted surface) or nothing is selected,
 * the side panel is opened instead with a friendly, localised notice. That is
 * the spec 5.10 fallback and the spec 3 "friendly message" requirement.
 */
async function requestSelection(tab: chrome.tabs.Tab | undefined): Promise<void> {
  const tabId = tab?.id;
  if (typeof tabId === "number") {
    const reply = await sendToTab<{ ok: boolean }>(tabId, {
      type: "selection:request",
      intent: "popup",
    });
    if (reply?.ok === true) return;
  }

  await setSessionNotice("errNothingSelected").catch(() => undefined);
  const windowId = await windowIdFor(tab);
  if (typeof windowId === "number") await openPanel(windowId);
}

/**
 * Context-menu hand-off: the browser already gave us the selected text, so we
 * can skip the round-trip to the page and keep the click's user gesture intact
 * for `sidePanel.open()`.
 */
async function practiseText(tab: chrome.tabs.Tab | undefined, raw: string): Promise<void> {
  const text = raw.trim();
  if (text === "") {
    await setSessionNotice("errNothingSelected").catch(() => undefined);
  } else {
    const settings = (await readStore().catch(() => null))?.settings ?? DEFAULT_SETTINGS;
    const target: PracticeTarget = {
      text,
      kind: classifyText(text),
      accent: settings.defaultAccent,
      speed: settings.defaultSpeed,
    };
    await setSessionTarget(target).catch(() => undefined);
    await setSessionNotice(null).catch(() => undefined);
  }

  const windowId = await windowIdFor(tab);
  if (typeof windowId === "number") await openPanel(windowId);
}

async function windowIdFor(tab: chrome.tabs.Tab | undefined): Promise<number | undefined> {
  if (typeof tab?.windowId === "number") return tab.windowId;
  return chrome.windows
    .getLastFocused()
    .then((window) => window.id)
    .catch(() => undefined);
}

async function handleOpenPanel(
  target: PracticeTarget | null,
  sender: chrome.runtime.MessageSender,
): Promise<FromBackground> {
  if (target) await setSessionTarget(target).catch(() => undefined);

  const windowId =
    sender.tab?.windowId ??
    (await chrome.windows
      .getLastFocused()
      .then((window) => window.id)
      .catch(() => undefined));

  if (typeof windowId !== "number") return { type: "panel:opened", ok: false };
  const ok = await openPanel(windowId);
  return { type: "panel:opened", ok };
}

/** Validate a hand-off target coming from a content script or the panel. */
function parseTarget(value: unknown): PracticeTarget | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Partial<PracticeTarget>;
  if (typeof raw.text !== "string" || raw.text.trim() === "") return null;
  if (raw.accent !== "en-US" && raw.accent !== "en-GB") return null;
  if (typeof raw.speed !== "number" || !Number.isFinite(raw.speed)) return null;
  if (raw.kind !== "word" && raw.kind !== "sentence") return null;

  return {
    text: raw.text,
    kind: raw.kind,
    accent: raw.accent,
    speed: Math.min(1.5, Math.max(0.5, raw.speed)),
    ...(raw.truncated === true ? { truncated: true } : {}),
  };
}

/**
 * Answer a dictionary request from the cache, or fetch it (spec 5.3).
 *
 * Every outcome is answered, including bad input, so a content script never
 * waits forever for a reply.
 */
async function answerDictionary(
  word: string,
  requestId: string,
  sendResponse: (response: unknown) => void,
): Promise<void> {
  try {
    const result = await lookupDictionary(word);
    sendResponse({ type: "dict:result", requestId, result });
  } catch {
    sendResponse({
      type: "dict:result",
      requestId,
      result: { ok: false, word, reason: "server" },
    });
  }
}

/**
 * Answer a pronunciation request from the bundled CMUdict (spec 5.2).
 *
 * Answers "not found" rather than an error when the word is absent: a missing
 * entry is a normal outcome, not a failure, and the pop-up still has the
 * dictionary API's transcription to fall back on.
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
        .map((variant) => ({ ipa: variant.ipa }))
        // The primary reading is first in `variants`, so drop it from the list.
        .filter((variant, index) => index > 0 || variant.ipa !== primary.ipa);
      result = {
        ok: true,
        word: primary.word,
        ipa: primary.ipa,
        syllables: primary.syllables.map((syllable) => ({
          ipa: syllable.ipa,
          stress: syllable.stress,
        })),
        variants,
      };
    }
  } catch {
    result = { ok: false, word };
  }
  sendResponse({ type: "ipa:result", requestId, result });
}

/**
 * Answer a message-bag request from a content script (spec 3).
 *
 * The background is an extension context, so it is the only place (besides an
 * extension page) that can read `_locales`. A failed read still answers with an
 * empty bag: the caller then falls back to `chrome.i18n`.
 */
async function answerMessages(
  language: "en" | "fr",
  requestId: string,
  sendResponse: (response: unknown) => void,
): Promise<void> {
  const messages = await loadMessages(language).catch(() => ({}));
  sendResponse({ type: "i18n:result", requestId, messages });
}

async function createContextMenu(): Promise<void> {
  try {
    await chrome.contextMenus.removeAll();
    chrome.contextMenus.create({
      id: "es-practise",
      title: tNow("btnPractise"),
      contexts: ["selection"],
    });
  } catch (err) {
    console.warn("[background] context menu creation failed", err);
  }
}

async function openPanel(windowId: number): Promise<boolean> {
  try {
    await chrome.sidePanel.open({ windowId });
    return true;
  } catch (err) {
    // Spec 5.10: a user gesture is required. If it is missing, the user can
    // always click the toolbar icon, which setPanelBehavior handles.
    console.warn("[background] sidePanel.open rejected", err);
    return false;
  }
}
