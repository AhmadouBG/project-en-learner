/**
 * Localisation (spec 3: "UI languages: English and French via `_locales`
 * (`chrome.i18n`). All visible strings must come from message files.").
 *
 * `chrome.i18n.getMessage` always follows the BROWSER's UI language, so it
 * cannot implement a user-facing "UI language" setting on its own. The message
 * files are therefore also loaded directly, which keeps every string in
 * `_locales/<lang>/messages.json` (the spec's requirement) while letting the
 * Settings tab switch languages at runtime.
 *
 * Nothing here touches user text. Keys are our own constants.
 */

import type { UiLanguage } from "./storage";

/** A flat key -> display-string bag, derived from a Chrome messages.json. */
export type Messages = Readonly<Record<string, string>>;

/** Chrome's message-file shape. Only `message` is used by this extension. */
interface ChromeMessageFile {
  readonly [key: string]: { readonly message?: unknown } | undefined;
}

const cache = new Map<UiLanguage, Promise<Messages>>();

/** Convert a Chrome message file into a flat bag, dropping malformed rows. */
export function flattenMessages(input: unknown): Messages {
  if (typeof input !== "object" || input === null) return {};
  const file = input as ChromeMessageFile;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(file)) {
    if (typeof value === "object" && value !== null && typeof value.message === "string") {
      out[key] = value.message;
    }
  }
  return out;
}

/**
 * Load one locale's messages.
 *
 * Memoised because the side panel resolves translations on every render, and
 * the files never change while an extension version is installed. A failed
 * fetch resolves to `{}` rather than rejecting: missing translations must
 * degrade to keys, not break the UI.
 */
export async function loadMessages(language: UiLanguage): Promise<Messages> {
  const cached = cache.get(language);
  if (cached) return cached;

  const loading = (async (): Promise<Messages> => {
    try {
      const url = chrome.runtime.getURL(`_locales/${language}/messages.json`);
      const response = await fetch(url);
      if (!response.ok) return {};
      return flattenMessages(await response.json());
    } catch {
      return {};
    }
  })();

  cache.set(language, loading);
  return loading;
}

/** Test seam: forget loaded message bags. */
export function resetMessagesCache(): void {
  cache.clear();
}

/**
 * Replace Chrome's `$1`, `$2` placeholders.
 *
 * Substitutions are inserted literally; they are never parsed as HTML. Values
 * are stringified because callers pass round numbers and counts.
 */
export function formatMessage(
  messages: Messages,
  key: string,
  substitutions: readonly (string | number)[] = [],
): string {
  const template = messages[key];
  if (template === undefined) return key;
  return template.replace(/\$(\d+)/g, (whole, index: string) => {
    const value = substitutions[Number(index) - 1];
    return value === undefined ? whole : String(value);
  });
}

/** A bound translation function; one per mounted UI. */
export type Translate = (
  key: string,
  ...substitutions: readonly (string | number)[]
) => string;

export function makeTranslator(messages: Messages): Translate {
  return (key, ...substitutions) => formatMessage(messages, key, substitutions);
}

/**
 * Synchronous `chrome.i18n` lookup, for contexts that only need the current
 * browser language (background menus, manifest strings).
 */
export function tNow(key: string, substitutions: readonly (string | number)[] = []): string {
  try {
    const message = chrome.i18n.getMessage(key, substitutions.map(String));
    return message === "" ? key : message;
  } catch {
    return key;
  }
}

// ---------------------------------------------------------------------------
// Static DOM translation
// ---------------------------------------------------------------------------

/**
 * Fill every `data-i18n*` node under `root`.
 *
 * Supported attributes:
 *  - `data-i18n` -> textContent
 *  - `data-i18n-aria` -> aria-label
 *  - `data-i18n-title` -> title
 *  - `data-i18n-placeholder` -> placeholder
 *
 * textContent is used deliberately: translations are trusted files we ship, but
 * the rule that this codebase never assigns innerHTML is absolute (spec 9).
 */
export function applyTranslations(root: ParentNode, t: Translate): void {
  for (const node of root.querySelectorAll<HTMLElement>("[data-i18n]")) {
    const key = node.dataset["i18n"];
    if (key) node.textContent = t(key);
  }
  for (const node of root.querySelectorAll<HTMLElement>("[data-i18n-aria]")) {
    const key = node.dataset["i18nAria"];
    if (key) node.setAttribute("aria-label", t(key));
  }
  for (const node of root.querySelectorAll<HTMLElement>("[data-i18n-title]")) {
    const key = node.dataset["i18nTitle"];
    if (key) node.title = t(key);
  }
  for (const node of root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
    "[data-i18n-placeholder]",
  )) {
    const key = node.dataset["i18nPlaceholder"];
    if (key) node.placeholder = t(key);
  }
}

/**
 * The language to request for the UI: the explicit setting, otherwise the
 * browser's UI language when it is French.
 */
export function preferredLanguage(setting: UiLanguage): UiLanguage {
  return setting;
}
