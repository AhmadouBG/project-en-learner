import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SETTINGS,
  DICT_CACHE_MAX_ENTRIES,
  DICT_CACHE_TTL_MS,
  SAVED_ITEMS_MAX,
  STORAGE_VERSION,
  migrate,
  pruneCache,
  sanitiseSettings,
  type CachedDefinition,
  type SavedItem,
  type StoreV1,
} from "../src/shared/storage";

const item = (n: number): SavedItem => ({
  id: `id-${n}`,
  text: `word ${n}`,
  kind: "word",
  ipa: "/wɜːd/",
  accent: "en-US",
  createdAt: 1_700_000_000_000 + n,
  attempts: 0,
  lastResult: null,
  box: 1,
});

describe("migrate", () => {
  it("produces a valid store from nothing (first run)", () => {
    const store = migrate(undefined);
    expect(store.version).toBe(STORAGE_VERSION);
    expect(store.settings).toEqual(DEFAULT_SETTINGS);
    expect(store.saved).toEqual([]);
    expect(store.dictCache).toEqual([]);
    expect(store.session.target).toBeNull();
  });

  it("produces a valid store from garbage rather than throwing", () => {
    for (const junk of [null, 0, "nope", [], true, () => {}]) {
      const store = migrate(junk);
      expect(store.version).toBe(STORAGE_VERSION);
      expect(store.settings).toEqual(DEFAULT_SETTINGS);
    }
  });

  it("discards unversioned legacy payloads instead of adopting them", () => {
    // The pre-versioning prototype kept a flat token blob; nothing in it is
    // worth migrating and adopting it could leak a stale API token forward.
    const store = migrate({
      apiToken: "secret-from-the-old-backend",
      saved: [item(1)],
    });
    expect(store.version).toBe(STORAGE_VERSION);
    expect(store.saved).toEqual([]);
    expect(JSON.stringify(store)).not.toContain("secret-from-the-old-backend");
  });

  it("keeps data across a version-preserving round trip", () => {
    const first = migrate({ version: 1, saved: [item(1), item(2)] });
    const second = migrate(first);
    expect(second.saved).toHaveLength(2);
    expect(second.saved[0]?.id).toBe("id-1");
  });

  it("enforces the saved-item cap (spec 5.8)", () => {
    const many = Array.from({ length: SAVED_ITEMS_MAX + 50 }, (_, i) => item(i));
    const store = migrate({ version: 1, saved: many });
    expect(store.saved).toHaveLength(SAVED_ITEMS_MAX);
  });

  it("drops a non-array `saved` field", () => {
    expect(migrate({ version: 1, saved: "nope" }).saved).toEqual([]);
  });
});

describe("sanitiseSettings", () => {
  it("keeps valid values", () => {
    const settings = sanitiseSettings({
      defaultAccent: "en-GB",
      defaultSpeed: 0.75,
      uiLanguage: "fr",
      theme: "dark",
      showButtonOnSelection: false,
    });
    expect(settings.defaultAccent).toBe("en-GB");
    expect(settings.defaultSpeed).toBe(0.75);
    expect(settings.uiLanguage).toBe("fr");
    expect(settings.theme).toBe("dark");
    expect(settings.showButtonOnSelection).toBe(false);
  });

  it("falls back to defaults for invalid scalars", () => {
    const settings = sanitiseSettings({
      defaultAccent: "en-AU" as never,
      uiLanguage: "de" as never,
      theme: "neon" as never,
      defaultSpeed: Number.NaN,
      showButtonOnSelection: "yes" as never,
    });
    expect(settings.defaultAccent).toBe(DEFAULT_SETTINGS.defaultAccent);
    expect(settings.uiLanguage).toBe(DEFAULT_SETTINGS.uiLanguage);
    expect(settings.theme).toBe(DEFAULT_SETTINGS.theme);
    expect(settings.showButtonOnSelection).toBe(DEFAULT_SETTINGS.showButtonOnSelection);
  });

  it("clamps the speed into the allowed range", () => {
    expect(sanitiseSettings({ defaultSpeed: 0.1 }).defaultSpeed).toBe(0.5);
    expect(sanitiseSettings({ defaultSpeed: 9 }).defaultSpeed).toBe(1.5);
  });

  it("never lets an unexpected key leak into the result", () => {
    const settings = sanitiseSettings({
      apiToken: "leak",
      nested: { a: 1 },
    } as never);
    expect(Object.keys(settings).sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort());
    expect(JSON.stringify(settings)).not.toContain("leak");
  });

  it("treats null as absent", () => {
    const settings = sanitiseSettings({ voiceUs: null, defaultAccent: null as never });
    expect(settings.voiceUs).toBeNull();
    expect(settings.defaultAccent).toBe(DEFAULT_SETTINGS.defaultAccent);
  });
});

describe("pruneCache", () => {
  const now = 1_800_000_000_000;

  const entry = (word: string, ageMs: number): CachedDefinition => ({
    word,
    fetchedAt: now - ageMs,
    entries: [],
  });

  beforeEach(() => {
    vi.useRealTimers();
  });

  it("drops expired entries (spec 5.3 TTL)", () => {
    const cache = [entry("fresh", 1000), entry("stale", DICT_CACHE_TTL_MS + 1)];
    expect(pruneCache(cache, now).map((e) => e.word)).toEqual(["fresh"]);
  });

  it("keeps an entry exactly at the TTL boundary", () => {
    const cache = [entry("edge", DICT_CACHE_TTL_MS - 1)];
    expect(pruneCache(cache, now)).toHaveLength(1);
  });

  it("enforces the cap, keeping the most recent", () => {
    // `entry` takes an AGE, so index 0 is the newest and highest index the oldest.
    const count = DICT_CACHE_MAX_ENTRIES + 20;
    const cache = Array.from({ length: count }, (_, i) => entry(`w${i}`, i * 1000));
    const pruned = pruneCache(cache, now);

    expect(pruned).toHaveLength(DICT_CACHE_MAX_ENTRIES);
    // Sorted newest first, so the 20 oldest are the ones dropped.
    expect(pruned[0]?.word).toBe("w0");
    expect(pruned[1]?.word).toBe("w1");
    expect(pruned[DICT_CACHE_MAX_ENTRIES - 1]?.word).toBe(`w${DICT_CACHE_MAX_ENTRIES - 1}`);
    expect(pruned.map((e) => e.word)).not.toContain(`w${count - 1}`);
  });

  it("respects a custom max", () => {
    expect(pruneCache([entry("a", 0), entry("b", 1), entry("c", 2)], now, 2)).toHaveLength(2);
  });

  it("ignores malformed cache rows", () => {
    const cache = [entry("good", 0), { word: 42 } as never, null as never];
    expect(pruneCache(cache, now).map((e) => e.word)).toEqual(["good"]);
  });
});

describe("StoreV1 shape", () => {
  it("matches the spec 5.8 saved-item schema", () => {
    // Guards the field names the spec pins down, so a rename cannot slip past.
    const saved: SavedItem = {
      id: "abc",
      text: "record",
      kind: "word",
      ipa: "/ɹɪˈkɔːd/",
      accent: "en-US",
      createdAt: 1,
      attempts: 2,
      lastResult: { recognised: 1, total: 1, ts: 1 },
      box: 3,
    };
    const store: StoreV1 = {
      version: STORAGE_VERSION,
      settings: DEFAULT_SETTINGS,
      saved: [saved],
      dictCache: [],
      session: { target: null },
    };
    expect(Object.keys(store).sort()).toEqual([
      "dictCache",
      "saved",
      "session",
      "settings",
      "version",
    ]);
  });
});