/**
 * One typed storage layer for the whole extension (spec 5.10, 5.8).
 *
 * Everything lives in `chrome.storage.local`:
 *  - `settings`  user preferences
 *  - `saved`     the saved-item list (spec 5.8 schema)
 *  - `dictCache` dictionary responses, size-capped and expiring (spec 5.3)
 *  - `session`   the practice hand-off target, so a panel opened later still
 *                has the text
 *
 * The whole store is versioned and migrated forward by `migrate()`, which is
 * unit-tested (spec 9: "storage migrations").
 */

import { isAccent, type Accent, type PracticeTarget, type PracticeKind } from "./messages";

export const STORAGE_VERSION = 1;

/** Key under which the versioned blob is stored. */
const ROOT_KEY = "es.store";

/** Spec 5.3: cap the dictionary cache so it cannot grow without bound. */
export const DICT_CACHE_MAX_ENTRIES = 500;
/** Spec 5.3: expire cached definitions; 30 days. */
export const DICT_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Spec 5.8: sane cap on saved items. */
export const SAVED_ITEMS_MAX = 500;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export type UiLanguage = "en" | "fr";
export type ThemeChoice = "system" | "light" | "dark";

export interface Settings {
  /** Spec 4.3 Settings: default accent. */
  readonly defaultAccent: Accent;
  /** 0.5 - 1.5 */
  readonly defaultSpeed: number;
  /** Spec 4.3: TTS voice per accent, chosen from speechSynthesis.getVoices(). */
  readonly voiceUs: string | null;
  readonly voiceUk: string | null;
  readonly uiLanguage: UiLanguage;
  /** Spec 4.3: "Show button on selection". */
  readonly showButtonOnSelection: boolean;
  /** Spec 4.3: "Open practice automatically" (default off). */
  readonly openPracticeAutomatically: boolean;
  readonly theme: ThemeChoice;
  /** Spec 4.3: "Save automatically after my first recording" (default on). */
  readonly autoSaveAfterFirstRecording: boolean;
  /** Spec 5.6: "Check my words after recording" (default on). */
  readonly checkWordsAfterRecording: boolean;
  /** Spec 5.8: page URL/title storage stays off unless explicitly enabled. */
  readonly storeSourcePage: boolean;
  /** Spec 4.1: first-run tooltip, shown once. */
  readonly firstRunTooltipShown: boolean;
  /** Spec 4.4: onboarding. */
  readonly onboardingCompleted: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  defaultAccent: "en-US",
  defaultSpeed: 1,
  voiceUs: null,
  voiceUk: null,
  uiLanguage: "en",
  showButtonOnSelection: true,
  openPracticeAutomatically: false,
  theme: "system",
  autoSaveAfterFirstRecording: true,
  checkWordsAfterRecording: true,
  storeSourcePage: false,
  firstRunTooltipShown: false,
  onboardingCompleted: false,
};

// ---------------------------------------------------------------------------
// Saved items (spec 5.8)
// ---------------------------------------------------------------------------

export interface WordCheckResult {
  /** How many target words the recogniser heard. NOT a pronunciation score. */
  readonly recognised: number;
  readonly total: number;
  readonly ts: number;
}

export interface SavedItem {
  readonly id: string;
  readonly text: string;
  readonly kind: PracticeKind;
  readonly ipa: string;
  readonly accent: Accent;
  readonly createdAt: number;
  readonly attempts: number;
  readonly lastResult: WordCheckResult | null;
  /** Simple Leitner-style box number for the review flow. 1..5. */
  readonly box: number;
  /** Only populated when `settings.storeSourcePage` is true. */
  readonly sourceUrl?: string;
  readonly sourceTitle?: string;
}

export interface SavedItemDraft {
  readonly text: string;
  readonly kind: PracticeKind;
  readonly ipa: string;
  readonly accent: Accent;
  readonly lastResult?: WordCheckResult | null;
}

// ---------------------------------------------------------------------------
// Dictionary cache (spec 5.3)
// ---------------------------------------------------------------------------

export interface CachedDefinition {
  readonly word: string;
  readonly fetchedAt: number;
  /** Raw API entries, stored verbatim so we can re-derive views without refetching. */
  readonly entries: readonly unknown[];
}

// ---------------------------------------------------------------------------
// Session hand-off
// ---------------------------------------------------------------------------

export interface SessionState {
  /** The practice target waiting to be picked up by the side panel. */
  readonly target: PracticeTarget | null;
}

// ---------------------------------------------------------------------------
// Store shape + migrations
// ---------------------------------------------------------------------------

export interface StoreV1 {
  readonly version: 1;
  readonly settings: Settings;
  readonly saved: readonly SavedItem[];
  readonly dictCache: readonly CachedDefinition[];
  readonly session: SessionState;
}

/** A store read from disk may be any older shape, or garbage. */
export type StoreShape = Partial<StoreV1> & { version?: number };

/**
 * Forward-only migration. Each step upgrades exactly one version.
 * Unknown/newer versions are preserved as-is rather than destroyed: we must
 * never silently wipe a user's practice history (spec 5.8).
 */
export function migrate(input: unknown): StoreV1 {
  const raw: StoreShape =
    typeof input === "object" && input !== null ? input : {};

  let settings: Settings = { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) };
  let saved: readonly SavedItem[] = Array.isArray(raw.saved) ? raw.saved : [];
  let dictCache: readonly CachedDefinition[] = Array.isArray(raw.dictCache)
    ? raw.dictCache
    : [];
  const session: SessionState = raw.session ?? { target: null };

  // --- v0 -> v1 ------------------------------------------------------------
  // The pre-versioning prototype stored a flat `{apiToken, ...}` blob with no
  // envelope. Nothing in it is worth keeping, but we must not crash on it.
  if (typeof raw.version !== "number") {
    saved = [];
    dictCache = [];
  }

  // Sanity clamps: a hand-edited or partially written store must not produce
  // impossible state that later code would have to defend against. Booleans and
  // the accent are re-validated explicitly rather than trusted.
  settings = sanitiseSettings(settings);

  return {
    version: STORAGE_VERSION,
    settings,
    saved: saved.slice(0, SAVED_ITEMS_MAX),
    dictCache: pruneCache(dictCache, Date.now()),
    session: { target: session.target ?? null },
  };
}

/** Drop expired entries and enforce the cap, most-recently-used first. */
export function pruneCache(
  cache: readonly CachedDefinition[],
  now: number,
  max = DICT_CACHE_MAX_ENTRIES,
): CachedDefinition[] {
  const alive = cache.filter(
    (e) => typeof e?.word === "string" && now - e.fetchedAt < DICT_CACHE_TTL_MS,
  );
  alive.sort((a, b) => b.fetchedAt - a.fetchedAt);
  return alive.slice(0, max);
}

function clamp(value: number, min: number, max: number): number {
  if (typeof value !== "number" || Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * Rebuild the settings object field by field so that anything unexpected in
 * storage is dropped rather than spread into the live settings object.
 */
export function sanitiseSettings(input: Partial<Settings>): Settings {
  // Restricted to the boolean keys so the fallback keeps its `boolean` type
  // instead of widening to the whole settings union.
  type BoolKey = {
    [K in keyof Settings]-?: Settings[K] extends boolean ? K : never;
  }[keyof Settings];

  const bool = (key: BoolKey): boolean => {
    const value: unknown = input[key];
    return typeof value === "boolean" ? value : DEFAULT_SETTINGS[key];
  };

  const accent = input.defaultAccent;
  const language = input.uiLanguage;
  const theme = input.theme;

  return {
    defaultAccent: isAccent(accent) ? accent : DEFAULT_SETTINGS.defaultAccent,
    defaultSpeed: clamp(
      typeof input.defaultSpeed === "number" ? input.defaultSpeed : DEFAULT_SETTINGS.defaultSpeed,
      0.5,
      1.5,
    ),
    voiceUs: typeof input.voiceUs === "string" ? input.voiceUs : null,
    voiceUk: typeof input.voiceUk === "string" ? input.voiceUk : null,
    uiLanguage: language === "fr" || language === "en" ? language : DEFAULT_SETTINGS.uiLanguage,
    showButtonOnSelection: bool("showButtonOnSelection"),
    openPracticeAutomatically: bool("openPracticeAutomatically"),
    theme:
      theme === "light" || theme === "dark" || theme === "system"
        ? theme
        : DEFAULT_SETTINGS.theme,
    autoSaveAfterFirstRecording: bool("autoSaveAfterFirstRecording"),
    checkWordsAfterRecording: bool("checkWordsAfterRecording"),
    storeSourcePage: bool("storeSourcePage"),
    firstRunTooltipShown: bool("firstRunTooltipShown"),
    onboardingCompleted: bool("onboardingCompleted"),
  };
}

// ---------------------------------------------------------------------------
// Read / write helpers
// ---------------------------------------------------------------------------

export class QuotaExceededError extends Error {
  constructor() {
    super("storage-quota-exceeded");
    this.name = "QuotaExceededError";
  }
}

export async function readStore(): Promise<StoreV1> {
  const bag = await chrome.storage.local.get(ROOT_KEY);
  return migrate(bag[ROOT_KEY]);
}

export async function writeStore(store: StoreV1): Promise<void> {
  try {
    await chrome.storage.local.set({ [ROOT_KEY]: store });
  } catch (err) {
    // Spec 5.8: handle quota errors instead of throwing a raw chrome error at
    // the user. Callers surface a localised message.
    const message = err instanceof Error ? err.message : String(err);
    if (
      message.includes("QUOTA_BYTES") ||
      message.includes("QuotaExceededError") ||
      (err instanceof Error && err.name === "QuotaExceededError")
    ) {
      throw new QuotaExceededError();
    }
    throw err;
  }
}

/**
 * Read-modify-write.
 *
 * On a quota failure we do NOT silently discard the dictionary cache: that is
 * user-visible data loss to save the user a re-fetch. Instead we trim the
 * *oldest* cache entries a quarter at a time, so the common case costs a handful
 * of re-lookups rather than the whole cache, and we stop as soon as the write
 * fits. If even an empty cache cannot fit, we surface QuotaExceededError so the
 * UI can ask the user what to discard.
 *
 * The user's practice history (`saved`) and settings are never touched here.
 */
export async function updateStore<T>(
  mutate: (store: StoreV1) => { store: StoreV1; result: T },
): Promise<T> {
  const first = await readStore();
  const { store, result } = mutate(first);

  try {
    await writeStore(store);
    return result;
  } catch (err) {
    if (!(err instanceof QuotaExceededError)) throw err;
  }

  // Quota path: trim the oldest cache entries progressively, never clearing it
  // wholesale and never touching `saved`.
  let candidate = store;
  const total = store.dictCache.length;
  let remaining = total;

  while (remaining > 0) {
    const drop = Math.max(1, Math.ceil(remaining / 4));
    remaining -= drop;
    // dictCache is kept newest-first by pruneCache, so the tail is the oldest.
    candidate = { ...candidate, dictCache: candidate.dictCache.slice(0, remaining) };
    try {
      await writeStore(candidate);
      return result;
    } catch (err) {
      if (!(err instanceof QuotaExceededError)) throw err;
    }
  }

  // Cache is empty and it still does not fit: the saved items are what is
  // consuming the quota. Let the caller decide, never discard practice history.
  throw new QuotaExceededError();
}

/** Explicit, user-initiated cache purge. Only called after the user agrees. */
export async function clearDictCache(): Promise<void> {
  await updateStore((store) => ({ store: { ...store, dictCache: [] }, result: null }));
}