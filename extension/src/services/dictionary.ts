/**
 * Dictionary lookup (spec 5.3).
 *
 * The background service worker is the only caller of the network. This module
 * keeps the response parsing pure and testable, so a shape change at the API can
 * be caught by unit tests instead of by a blank pop-up.
 *
 * Verified 2026-10-05 (DECISIONS.md 5):
 *  - `https://freedictionaryapi.com/api/v1/entries/en/{word}`
 *  - keyless; documented limit 1000 requests/hour/IP
 *  - an unknown word returns HTTP 200 with `entries: []`, NOT 404
 *  - transcriptions are source-tagged ("General American",
 *    "Received Pronunciation"), which is what lets us show real UK IPA
 *
 * Nothing here logs the looked-up word (spec 9).
 */

import type {
  Accent,
  DictionaryEntry,
  DictionaryFailure,
  DictionaryResult,
} from "../shared/messages";
import { isLookupWord } from "../shared/messages";

export const DICTIONARY_ENDPOINT = "https://freedictionaryapi.com/api/v1/entries/en";

/** How long a lookup may take before it is reported as offline/server. */
export const DICTIONARY_TIMEOUT_MS = 8_000;

/** Network dependency, injected in tests. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

interface RawPronunciation {
  readonly type?: unknown;
  readonly text?: unknown;
  readonly tags?: unknown;
}

interface RawSense {
  readonly definition?: unknown;
  readonly examples?: unknown;
}

interface RawEntry {
  readonly partOfSpeech?: unknown;
  readonly pronunciations?: unknown;
  readonly senses?: unknown;
}

interface RawResponse {
  readonly entries?: unknown;
}

/** Map a source tag onto one of our two accents, or null when unknown. */
export function accentFromTag(tag: string): Accent | null {
  const normalised = tag.trim().toLowerCase();
  if (normalised === "general american" || normalised === "us" || normalised === "american") {
    return "en-US";
  }
  if (
    normalised === "received pronunciation" ||
    normalised === "uk" ||
    normalised === "british" ||
    normalised === "british english"
  ) {
    return "en-GB";
  }
  return null;
}

/**
 * Strip the enclosing slashes from an API transcription.
 *
 * CMUdict IPA (which we render beside it) has no delimiters, so keeping the
 * slashes would make the two look like different notational systems.
 */
export function cleanIpa(text: string): string {
  return text.trim().replace(/^\/+|\/+$/g, "").trim();
}

/** First non-empty string from an unknown array. */
function firstString(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  for (const item of value) {
    if (typeof item === "string" && item.trim() !== "") return item.trim();
  }
  return null;
}

function parsePronunciations(value: unknown): DictionaryEntry["ipa"] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: { accent: Accent | null; text: string }[] = [];

  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) continue;
    const pronunciation = raw as RawPronunciation;
    if (pronunciation.type !== "ipa" || typeof pronunciation.text !== "string") continue;

    const text = cleanIpa(pronunciation.text);
    if (text === "") continue;

    // Tag arrays can contain several labels; the first one we recognise wins.
    const tags = Array.isArray(pronunciation.tags)
      ? pronunciation.tags.filter((tag): tag is string => typeof tag === "string")
      : [];
    let accent: Accent | null = null;
    for (const tag of tags) {
      accent = accentFromTag(tag);
      if (accent !== null) break;
    }

    // Duplicates are common (the upstream data repeats identical readings).
    const key = `${accent ?? "?"}|${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ accent, text });
  }

  return out;
}

/** Extract readable senses from one API entry. */
export function parseEntry(raw: unknown, word: string): DictionaryEntry | null {
  if (typeof raw !== "object" || raw === null) return null;
  const entry = raw as RawEntry;

  const partOfSpeech =
    typeof entry.partOfSpeech === "string" ? entry.partOfSpeech.trim() : "";

  const definitions: string[] = [];
  let example: string | null = null;

  if (Array.isArray(entry.senses)) {
    for (const sense of entry.senses) {
      if (typeof sense !== "object" || sense === null) continue;
      const parsed = sense as RawSense;
      if (typeof parsed.definition !== "string" || parsed.definition.trim() === "") continue;
      definitions.push(parsed.definition.trim());
      if (example === null) example = firstString(parsed.examples);
    }
  }

  if (definitions.length === 0 && typeof entry.partOfSpeech !== "string") return null;

  const ipa = parsePronunciations(entry.pronunciations);
  if (partOfSpeech === "" && definitions.length === 0) return null;

  return {
    partOfSpeech: partOfSpeech === "" ? "—" : partOfSpeech,
    ipa,
    definitions,
    example,
    sourceUrl: `${DICTIONARY_ENDPOINT}/${encodeURIComponent(word)}`,
  };
}

/**
 * Turn an API payload into entries.
 *
 * An empty `entries` array is a normal not-found response (verified: the API
 * answers HTTP 200 for unknown words), so the caller decides what that means.
 */
export function parseDictionaryResponse(word: string, payload: unknown): DictionaryEntry[] {
  if (typeof payload !== "object" || payload === null) return [];
  const raw = payload as RawResponse;
  if (!Array.isArray(raw.entries)) return [];

  const entries: DictionaryEntry[] = [];
  for (const item of raw.entries) {
    const parsed = parseEntry(item, word);
    if (parsed) entries.push(parsed);
  }
  return entries;
}

/** Pick the transcription for an accent, falling back to an untagged one. */
export function pickIpa(
  entry: DictionaryEntry,
  accent: Accent,
): { text: string; accent: Accent | null } | null {
  const exact = entry.ipa.find((reading) => reading.accent === accent);
  if (exact) return exact;
  const untagged = entry.ipa.find((reading) => reading.accent === null);
  return untagged ?? null;
}

/** Human-readable failure reason for a status code. */
export function failureForStatus(status: number): DictionaryFailure {
  if (status === 404) return "not-found";
  if (status === 429) return "rate-limited";
  return "server";
}

export interface FetchDefinitionOptions {
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
}

export interface DefinitionFetch {
  readonly result: DictionaryResult;
  /** Raw API entries, kept so the cache can store them verbatim. */
  readonly rawEntries: readonly unknown[] | null;
}

/**
 * Fetch and parse a definition, keeping the raw entries for the cache.
 *
 * Network failures are classified, never thrown: the pop-up must show an
 * offline state rather than an unhandled rejection. `AbortSignal.timeout` is not
 * used because this also runs in older Chromium builds.
 */
export async function fetchDefinitionWithRaw(
  word: string,
  options: FetchDefinitionOptions = {},
): Promise<DefinitionFetch> {
  if (!isLookupWord(word)) {
    return { result: { ok: false, word, reason: "bad-word" }, rawEntries: null };
  }

  const doFetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DICTIONARY_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await doFetch(`${DICTIONARY_ENDPOINT}/${encodeURIComponent(word)}`, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      return {
        result: { ok: false, word, reason: failureForStatus(response.status) },
        rawEntries: null,
      };
    }

    const payload: unknown = await response.json();
    const entries = parseDictionaryResponse(word, payload);
    const rawEntries =
      typeof payload === "object" &&
      payload !== null &&
      Array.isArray((payload as RawResponse).entries)
        ? ((payload as RawResponse).entries as readonly unknown[])
        : [];

    if (entries.length === 0) {
      // A negative result is worth caching: it avoids hammering the API for a
      // word the user keeps selecting.
      return { result: { ok: false, word, reason: "not-found" }, rawEntries: [] };
    }
    return { result: { ok: true, word, entries }, rawEntries };
  } catch {
    // AbortError is a timeout; TypeError is how fetch reports being offline or
    // blocked by CORS. Both are "offline" to the user, who can retry.
    return { result: { ok: false, word, reason: "offline" }, rawEntries: null };
  } finally {
    clearTimeout(timer);
  }
}

/** Convenience wrapper for callers that do not need the raw entries. */
export async function fetchDefinition(
  word: string,
  options: FetchDefinitionOptions = {},
): Promise<DictionaryResult> {
  return (await fetchDefinitionWithRaw(word, options)).result;
}
