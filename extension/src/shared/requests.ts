/**
 * Request helpers shared by the content script and the side panel.
 *
 * Each one wraps the typed message protocol in `messages.ts`; call sites never
 * build a raw `chrome.runtime.sendMessage` payload. Request IDs guard against a
 * late reply for an earlier selection being applied to the current one.
 */

import { sendToBackground } from "./bus";
import type {
  DictionaryResult,
  FromBackground,
  IpaResult,
  PracticeTarget,
} from "./messages";

let sequence = 0;

function nextRequestId(): string {
  sequence += 1;
  return `r${sequence}`;
}

/** Look a word up in the dictionary API (via the background cache). */
export async function requestDictionary(word: string): Promise<DictionaryResult | null> {
  const requestId = nextRequestId();
  const reply = await sendToBackground<FromBackground>(
    { type: "dictionary:lookup", word, requestId },
    (r) => r,
  ).catch(() => null);
  if (reply?.type === "dict:result" && reply.requestId === requestId) return reply.result;
  return null;
}

/** Ask the background for the bundled CMUdict pronunciation. */
export async function requestIpa(word: string): Promise<IpaResult | null> {
  const requestId = nextRequestId();
  const reply = await sendToBackground<FromBackground>(
    { type: "ipa:lookup", word, requestId },
    (r) => r,
  ).catch(() => null);
  if (reply?.type === "ipa:result" && reply.requestId === requestId) return reply.result;
  return null;
}

/** Open the side panel and hand over the text/accent/speed (spec 2). */
export async function requestPanel(target: PracticeTarget | null): Promise<boolean> {
  const reply = await sendToBackground<FromBackground>(
    { type: "open-panel", target },
    (r) => r,
  ).catch(() => null);
  return reply?.type === "panel:opened" && reply.ok;
}
