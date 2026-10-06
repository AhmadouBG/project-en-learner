/**
 * Thin, typed wrappers around `chrome.runtime.sendMessage` (spec 5.10).
 *
 * Every call site uses one of these, so the discriminated unions in
 * `messages.ts` are checked end to end instead of by `any` casts.
 *
 * Note: MV3 service workers get torn down aggressively, so the background
 * listener must `return true` from `onMessage` to keep the channel open for the
 * async dictionary fetch. That is handled in the background entrypoint.
 */

import type { FromBackground, ToBackground } from "./messages";

/** Raised when the extension context is gone (reload / update while open). */
export class ContextGoneError extends Error {
  constructor() {
    super("extension-context-invalidated");
    this.name = "ContextGoneError";
  }
}

const GONE_MESSAGES = [
  "Extension context invalidated",
  "Receiving end does not exist",
  "message port closed",
];

/**
 * Send a message to the background and await a typed reply.
 * Resolves to `null` when no one is listening.
 */
export async function sendToBackground<R extends FromBackground>(
  message: ToBackground,
  onReply: (reply: R) => R,
): Promise<R | null> {
  let reply: unknown;
  try {
    reply = await chrome.runtime.sendMessage(message);
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    if (GONE_MESSAGES.some((m) => text.includes(m))) throw new ContextGoneError();
    return null;
  }
  if (reply === undefined || reply === null) return null;
  return onReply(reply as R);
}

/** Send a message from the background and await a typed reply. */
export async function sendToTab<T>(
  tabId: number,
  message: FromBackground,
): Promise<T | null> {
  try {
    return (await chrome.tabs.sendMessage(tabId, message)) as T | undefined ?? null;
  } catch {
    // No receiver on that tab (restricted page, not yet injected, closed).
    return null;
  }
}
