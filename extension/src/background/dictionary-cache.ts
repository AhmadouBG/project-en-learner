/**
 * Dictionary cache in the background service worker (spec 5.3).
 *
 * The service worker is the only context that calls the dictionary API. Results
 * are cached in `chrome.storage.local`, capped and expiring, so a repeat lookup
 * is instant and the extension keeps working offline for words it has seen.
 *
 * Negative results ("not found") are cached too: a learner who keeps selecting
 * the same proper noun should not cause a request every time. They expire on the
 * same 30-day TTL as definitions.
 */

import { parseDictionaryResponse, fetchDefinitionWithRaw } from "../services/dictionary";
import type { DictionaryResult } from "../shared/messages";
import {
  DICT_CACHE_MAX_ENTRIES,
  DICT_CACHE_TTL_MS,
  pruneCache,
  readStore,
  updateStore,
  type CachedDefinition,
} from "../shared/storage";

function normalise(word: string): string {
  return word.trim().toLowerCase();
}

/** Answer from the cache when a fresh entry exists. */
export async function lookupDictionary(word: string): Promise<DictionaryResult> {
  const key = normalise(word);
  const now = Date.now();
  const store = await readStore();
  const hit = store.dictCache.find((entry) => entry.word === key);

  if (hit && now - hit.fetchedAt < DICT_CACHE_TTL_MS) {
    const entries = parseDictionaryResponse(word, { entries: hit.entries });
    if (entries.length === 0) return { ok: false, word, reason: "not-found" };
    return { ok: true, word, entries };
  }

  const { result, rawEntries } = await fetchDefinitionWithRaw(word);

  // Only outcomes that are stable are cached. Offline and rate-limit failures
  // must be retried on the next selection.
  if (rawEntries !== null && (result.ok || result.reason === "not-found")) {
    await cacheDefinition(key, rawEntries, now).catch(() => undefined);
  }

  return result;
}

async function cacheDefinition(
  word: string,
  entries: readonly unknown[],
  now: number,
): Promise<void> {
  await updateStore((store) => {
    const entry: CachedDefinition = { word, fetchedAt: now, entries };
    // Newest first, and drop an older copy of the same word.
    const rest = store.dictCache.filter((item) => item.word !== word);
    const dictCache = pruneCache([entry, ...rest], now, DICT_CACHE_MAX_ENTRIES);
    return { store: { ...store, dictCache }, result: null };
  });
}
