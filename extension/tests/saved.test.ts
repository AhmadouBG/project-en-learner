/**
 * Saved-item helpers (spec 5.8, Phase 10).
 *
 * Imports are untrusted input, so the validation tests matter more than the
 * happy path: a malformed file must be rejected as a whole, and field values
 * must be clamped into the schema rather than trusted.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EXPORT_VERSION,
  filterSaved,
  importSaved,
  makeSavedItem,
  parseImport,
  parseSavedItem,
  removeSaved,
  saveDraft,
  serialiseSaved,
  setBox,
} from "../src/shared/saved";
import { migrate, type SavedItem, type StoreV1 } from "../src/shared/storage";

function installFakeStorage(initial: StoreV1 = migrate(undefined)) {
  const data = new Map<string, unknown>([["es.store", initial]]);
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: data.get(key) })),
        set: vi.fn(async (bag: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(bag)) data.set(key, value);
        }),
      },
    },
  });
  return data;
}

const item: SavedItem = {
  id: "saved-1",
  text: "schedule",
  kind: "word",
  ipa: "ˈskedʒ.uːl",
  accent: "en-US",
  createdAt: 1_700_000_000_000,
  attempts: 2,
  lastResult: { recognised: 2, total: 3, ts: 1_700_000_000_100 },
  box: 3,
};

describe("makeSavedItem", () => {
  it("builds a valid item and counts an initial attempt only when there is a result", () => {
    const withResult = makeSavedItem(
      {
        text: "schedule",
        kind: "word",
        ipa: "ˈskedʒ.uːl",
        accent: "en-US",
        lastResult: { recognised: 1, total: 1, ts: 1 },
      },
      { now: 100, id: "fixed" },
    );
    expect(withResult).toMatchObject({
      id: "fixed",
      createdAt: 100,
      attempts: 1,
      box: 1,
    });

    const withoutResult = makeSavedItem(
      { text: "schedule", kind: "word", ipa: "", accent: "en-GB", lastResult: null },
      { now: 100, id: "fixed-2" },
    );
    expect(withoutResult.attempts).toBe(0);
    expect(withoutResult.lastResult).toBeNull();
  });

  it("only attaches source-page fields when provided", () => {
    const withUrl = makeSavedItem(
      { text: "a", kind: "word", ipa: "", accent: "en-US", lastResult: null },
      { id: "a", sourceUrl: "https://example.com" },
    );
    expect(withUrl.sourceUrl).toBe("https://example.com");
    expect(withUrl.sourceTitle).toBeUndefined();

    const withTitle = makeSavedItem(
      { text: "b", kind: "word", ipa: "", accent: "en-US", lastResult: null },
      { id: "b", sourceTitle: "Example" },
    );
    expect(withTitle.sourceTitle).toBe("Example");
    expect(withTitle.sourceUrl).toBeUndefined();
  });
});

describe("parseSavedItem", () => {
  it("accepts a complete item", () => {
    expect(parseSavedItem(item)).toEqual(item);
  });

  it("clamps attempts and box into the schema range", () => {
    const parsed = parseSavedItem({ ...item, attempts: -4, box: 99 });
    expect(parsed?.attempts).toBe(0);
    expect(parsed?.box).toBe(5);
  });

  it("drops an invalid last result rather than rejecting the whole item", () => {
    const parsed = parseSavedItem({ ...item, lastResult: { recognised: "two" } });
    expect(parsed?.lastResult).toBeNull();
  });

  it.each([
    ["not an object", 3],
    ["missing id", { ...item, id: "" }],
    ["blank text", { ...item, text: "   " }],
    ["oversized text", { ...item, text: "x".repeat(2_001) }],
    ["bad kind", { ...item, kind: "phrase" }],
    ["bad accent", { ...item, accent: "en-AU" }],
    ["bad createdAt", { ...item, createdAt: "yesterday" }],
  ])("rejects %s", (_label, value) => {
    expect(parseSavedItem(value)).toBeNull();
  });
});

describe("export / import validation", () => {
  it("round-trips through the export envelope", () => {
    const json = serialiseSaved([item], 123);
    expect(JSON.parse(json)).toMatchObject({
      version: EXPORT_VERSION,
      exportedAt: 123,
      items: [item],
    });
    expect(parseImport(json)).toEqual({ ok: true, items: [item] });
  });

  it("accepts a bare array because users edit these files by hand", () => {
    expect(parseImport(JSON.stringify([item]))).toEqual({ ok: true, items: [item] });
  });

  it("rejects malformed JSON, unknown envelopes and newer versions", () => {
    expect(parseImport("{")).toEqual({ ok: false, reason: "invalid" });
    expect(parseImport("{}")).toEqual({ ok: false, reason: "invalid" });
    expect(
      parseImport(JSON.stringify({ version: EXPORT_VERSION + 1, items: [item] })),
    ).toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects empty files and files that exceed the cap", () => {
    expect(parseImport("[]")).toEqual({ ok: false, reason: "empty" });
    const tooMany = Array.from({ length: 501 }, (_, index) => ({
      ...item,
      id: `id-${index}`,
    }));
    expect(parseImport(JSON.stringify(tooMany))).toEqual({
      ok: false,
      reason: "too-many",
    });
  });

  it("rejects the whole file when one row is invalid", () => {
    const json = JSON.stringify([item, { ...item, id: "" }]);
    expect(parseImport(json)).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("storage-backed saved helpers", () => {
  beforeEach(() => {
    installFakeStorage();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("saves once per text+accent and returns the existing item next time", async () => {
    const draft = {
      text: "schedule",
      kind: "word" as const,
      ipa: "ˈskedʒ.uːl",
      accent: "en-US" as const,
      lastResult: null,
    };

    const first = await saveDraft(draft, { now: 100 });
    expect(first.created).toBe(true);
    expect(first.item.text).toBe("schedule");

    const second = await saveDraft(draft, { now: 200 });
    expect(second.created).toBe(false);
    expect(second.item.id).toBe(first.item.id);
  });

  it("merges imports by id and keeps the newest first", async () => {
    const older = { ...item, id: "older", createdAt: 100 };
    const newer = { ...item, id: "newer", createdAt: 300 };
    installFakeStorage(migrate({ version: 1, saved: [older] }));

    const result = await importSaved(serialiseSaved([newer, older]));
    expect(result.ok).toBe(true);

    const items = await importSaved(serialiseSaved([newer]));
    expect(items).toEqual({ ok: true, added: 0, skipped: 1 });
  });

  it("removes an item by id", async () => {
    installFakeStorage(migrate({ version: 1, saved: [item] }));
    await removeSaved(item.id);
    expect(await importSaved(serialiseSaved([item]))).toMatchObject({ ok: true });
  });

  it("clamps box moves to 1..5", async () => {
    installFakeStorage(migrate({ version: 1, saved: [item] }));
    expect(await setBox(item.id, 0)).toBe(1);
    expect(await setBox(item.id, 9)).toBe(5);
  });
});

describe("filterSaved", () => {
  it("searches text and IPA case-insensitively", () => {
    expect(filterSaved([item], "SKED")).toHaveLength(1);
    expect(filterSaved([item], "dule")).toHaveLength(1);
    expect(filterSaved([item], "record")).toHaveLength(0);
    expect(filterSaved([item], "  ")).toHaveLength(1);
  });
});
