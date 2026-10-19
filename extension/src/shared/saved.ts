/**
 * Saved items, review boxes, export and import (spec 5.8, Phase 10).
 *
 * All writes go through `updateStore`, so quota recovery and versioning stay in
 * one place. The validation functions are pure and unit-tested: an imported file
 * is untrusted input and must never be allowed to produce an invalid store.
 */

import { isAccent, type PracticeKind } from "./messages";
import {
  QuotaExceededError,
  SAVED_ITEMS_MAX,
  readStore,
  updateStore,
  type SavedItem,
  type SavedItemDraft,
  type StoreV1,
  type WordCheckResult,
} from "./storage";

export const EXPORT_VERSION = 1;

export interface SavedExport {
  readonly version: number;
  readonly exportedAt: number;
  readonly items: readonly SavedItem[];
}

export type ImportResult =
  | { readonly ok: true; readonly added: number; readonly skipped: number }
  | { readonly ok: false; readonly reason: "invalid" | "empty" | "too-many" | "quota" };

function newId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    // Older engines, and tests with a minimal crypto stub.
    return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

/** Build a schema-valid saved item from what the practise tab knows. */
export function makeSavedItem(
  draft: SavedItemDraft,
  options: {
    readonly now?: number;
    readonly id?: string;
    readonly sourceUrl?: string | null;
    readonly sourceTitle?: string | null;
  } = {},
): SavedItem {
  const base: SavedItem = {
    id: options.id ?? newId(),
    text: draft.text,
    kind: draft.kind,
    ipa: draft.ipa,
    accent: draft.accent,
    createdAt: options.now ?? Date.now(),
    attempts: draft.lastResult ? 1 : 0,
    lastResult: draft.lastResult ?? null,
    box: 1,
  };

  if (options.sourceUrl) return { ...base, sourceUrl: options.sourceUrl };
  if (options.sourceTitle) return { ...base, sourceTitle: options.sourceTitle };
  return base;
}

/**
 * Save a draft.
 *
 * Re-saving the same text in the same accent returns the existing item instead
 * of creating a duplicate. That matters because "Save" is also shown after a
 * recording, and a user who presses it twice should not get two cards to review.
 */
export async function saveDraft(
  draft: SavedItemDraft,
  options: {
    readonly now?: number;
    readonly sourceUrl?: string | null;
    readonly sourceTitle?: string | null;
  } = {},
): Promise<{ readonly item: SavedItem; readonly created: boolean }> {
  return updateStore<{ readonly item: SavedItem; readonly created: boolean }>((store) => {
    const existing = store.saved.find(
      (item) => item.text === draft.text && item.accent === draft.accent,
    );
    if (existing) return { store, result: { item: existing, created: false } };

    const item = makeSavedItem(draft, {
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(options.sourceUrl ? { sourceUrl: options.sourceUrl } : {}),
      ...(options.sourceTitle ? { sourceTitle: options.sourceTitle } : {}),
    });

    // Newest first: the Saved tab is a "what did I just practise" list.
    const saved = [item, ...store.saved].slice(0, SAVED_ITEMS_MAX);
    return { store: { ...store, saved }, result: { item, created: true } };
  });
}

/** Record an attempt and the latest recognised-word result on a saved item. */
export async function recordAttempt(
  id: string,
  result: WordCheckResult | null,
): Promise<void> {
  await updateStore((store) => ({
    store: {
      ...store,
      saved: store.saved.map((item) =>
        item.id === id ? { ...item, attempts: item.attempts + 1, lastResult: result } : item,
      ),
    },
    result: null,
  }));
}

/** Move a review card up or down one box. Box 1..5, like a simple Leitner deck. */
export async function setBox(id: string, box: number): Promise<number> {
  const clamped = Math.min(5, Math.max(1, Math.round(box)));
  await updateStore((store) => ({
    store: {
      ...store,
      saved: store.saved.map((item) => (item.id === id ? { ...item, box: clamped } : item)),
    },
    result: null,
  }));
  return clamped;
}

export async function removeSaved(id: string): Promise<void> {
  await updateStore((store) => ({
    store: { ...store, saved: store.saved.filter((item) => item.id !== id) },
    result: null,
  }));
}

export async function clearSaved(): Promise<void> {
  await updateStore((store) => ({ store: { ...store, saved: [] }, result: null }));
}

/** Case-insensitive search over the visible text and IPA. */
export function filterSaved(items: readonly SavedItem[], query: string): SavedItem[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [...items];
  return items.filter(
    (item) =>
      item.text.toLowerCase().includes(needle) || item.ipa.toLowerCase().includes(needle),
  );
}

// ---------------------------------------------------------------------------
// Export / import
// ---------------------------------------------------------------------------

export function serialiseSaved(items: readonly SavedItem[], now = Date.now()): string {
  const payload: SavedExport = { version: EXPORT_VERSION, exportedAt: now, items };
  return JSON.stringify(payload, null, 2);
}

/** Validate one untrusted record and rebuild it field by field. */
export function parseSavedItem(value: unknown): SavedItem | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Partial<SavedItem>;

  if (typeof raw.id !== "string" || raw.id === "") return null;
  if (typeof raw.text !== "string" || raw.text.trim() === "" || raw.text.length > 2_000) {
    return null;
  }
  if (raw.kind !== "word" && raw.kind !== "sentence") return null;
  if (typeof raw.ipa !== "string") return null;
  if (!isAccent(raw.accent)) return null;
  if (typeof raw.createdAt !== "number" || !Number.isFinite(raw.createdAt)) return null;

  const kind: PracticeKind = raw.kind;
  const accent = raw.accent;
  const attempts =
    typeof raw.attempts === "number" && Number.isFinite(raw.attempts)
      ? Math.max(0, Math.round(raw.attempts))
      : 0;
  const box =
    typeof raw.box === "number" && Number.isFinite(raw.box)
      ? Math.min(5, Math.max(1, Math.round(raw.box)))
      : 1;

  let lastResult: WordCheckResult | null = null;
  const rawResult = raw.lastResult;
  if (
    typeof rawResult === "object" &&
    rawResult !== null &&
    typeof rawResult.recognised === "number" &&
    typeof rawResult.total === "number" &&
    typeof rawResult.ts === "number"
  ) {
    lastResult = {
      recognised: Math.max(0, Math.round(rawResult.recognised)),
      total: Math.max(0, Math.round(rawResult.total)),
      ts: rawResult.ts,
    };
  }

  const item: SavedItem = {
    id: raw.id,
    text: raw.text,
    kind,
    ipa: raw.ipa,
    accent,
    createdAt: raw.createdAt,
    attempts,
    lastResult,
    box,
  };

  // Source-page fields are only kept when the user explicitly enabled them at
  // export time. Importing them otherwise would silently opt the user back in.
  if (typeof raw.sourceUrl === "string") {
    return { ...item, sourceUrl: raw.sourceUrl };
  }
  if (typeof raw.sourceTitle === "string") {
    return { ...item, sourceTitle: raw.sourceTitle };
  }
  return item;
}

export type ParseImportResult =
  | { readonly ok: true; readonly items: SavedItem[] }
  | { readonly ok: false; readonly reason: "invalid" | "empty" | "too-many" };

/**
 * Parse an exported file.
 *
 * Accepts both our `{version, items}` envelope and a bare array, because users
 * edit these files by hand. Anything malformed is rejected as a whole rather
 * than partially imported: a half-import is worse than a clear error.
 */
export function parseImport(json: string): ParseImportResult {
  let payload: unknown;
  try {
    payload = JSON.parse(json);
  } catch {
    return { ok: false, reason: "invalid" };
  }

  let rawItems: unknown;
  if (Array.isArray(payload)) {
    rawItems = payload;
  } else if (typeof payload === "object" && payload !== null && "items" in payload) {
    const envelope = payload as { items?: unknown; version?: unknown };
    if (typeof envelope.version === "number" && envelope.version > EXPORT_VERSION) {
      return { ok: false, reason: "invalid" };
    }
    rawItems = envelope.items;
  } else {
    return { ok: false, reason: "invalid" };
  }

  if (!Array.isArray(rawItems)) return { ok: false, reason: "invalid" };
  if (rawItems.length === 0) return { ok: false, reason: "empty" };
  if (rawItems.length > SAVED_ITEMS_MAX) return { ok: false, reason: "too-many" };

  const items: SavedItem[] = [];
  for (const raw of rawItems) {
    const item = parseSavedItem(raw);
    if (!item) return { ok: false, reason: "invalid" };
    items.push(item);
  }
  return { ok: true, items };
}

/**
 * Merge an import into the store, newest first.
 *
 * IDs are preserved so a re-import updates rather than duplicates. The store is
 * capped at `SAVED_ITEMS_MAX`; excess incoming items are counted as skipped.
 */
export async function importSaved(json: string): Promise<ImportResult> {
  const parsed = parseImport(json);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };

  try {
    const result = await updateStore((store) => {
      const byId = new Map<string, SavedItem>();
      for (const item of parsed.items) byId.set(item.id, item);
      for (const item of store.saved) byId.set(item.id, item);
      const merged = [...byId.values()].sort((a, b) => b.createdAt - a.createdAt);
      const capped = merged.slice(0, SAVED_ITEMS_MAX);
      return {
        store: { ...store, saved: capped },
        result: {
          added: Math.max(0, capped.length - store.saved.length),
          skipped: parsed.items.length - Math.max(0, capped.length - store.saved.length),
        },
      };
    });
    return { ok: true, ...result };
  } catch (err) {
    if (err instanceof QuotaExceededError) return { ok: false, reason: "quota" };
    throw err;
  }
}

/** Read the saved list, for callers that do not need the rest of the store. */
export async function listSaved(): Promise<readonly SavedItem[]> {
  const store: StoreV1 = await readStore();
  return store.saved;
}
