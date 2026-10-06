/**
 * Tests for the chrome.storage-backed helpers.
 *
 * The interesting behaviour is all in the failure paths: spec 5.8 requires quota
 * errors to be handled gracefully rather than surfacing a raw chrome error, and
 * a retry must not silently discard the user's practice history.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SETTINGS,
  DICT_CACHE_MAX_ENTRIES,
  QuotaExceededError,
  readStore,
  updateStore,
  writeStore,
  type StoreV1,
} from "../src/shared/storage";
import type { PracticeTarget } from "../src/shared/messages";

/** Minimal in-memory stand-in for chrome.storage.local. */
function installFakeStorage() {
  const data = new Map<string, unknown>();
  const api = {
    get: vi.fn(async (key: string) => ({ [key]: data.get(key) })),
    set: vi.fn(async (bag: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(bag)) data.set(k, v);
    }),
  };
  vi.stubGlobal("chrome", { storage: { local: api } });
  return { data, api };
}

const target: PracticeTarget = {
  text: "Could you schedule the meeting?",
  kind: "sentence",
  accent: "en-US",
  speed: 1,
};

/** The shape Chrome throws when `chrome.storage.local` is full. */
const quotaError = (): Error =>
  Object.assign(new Error("QUOTA_BYTES quota exceeded"), {
    name: "QuotaExceededError",
  });

describe("readStore / writeStore", () => {
  beforeEach(() => {
    installFakeStorage();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("round-trips a store through chrome.storage.local", async () => {
    const store: StoreV1 = {
      version: 1,
      settings: { ...DEFAULT_SETTINGS, defaultAccent: "en-GB" },
      saved: [],
      dictCache: [],
      session: { target },
    };
    await writeStore(store);
    const read = await readStore();

    expect(read.settings.defaultAccent).toBe("en-GB");
    expect(read.session.target?.text).toBe(target.text);
  });

  it("returns defaults when storage is empty", async () => {
    expect((await readStore()).settings).toEqual(DEFAULT_SETTINGS);
  });

  it("translates a quota failure into QuotaExceededError", async () => {
    const chromeStub = globalThis.chrome as unknown as {
      storage: { local: { set: ReturnType<typeof vi.fn> } };
    };
    chromeStub.storage.local.set.mockRejectedValueOnce(
      Object.assign(new Error("QUOTA_BYTES quota exceeded"), { name: "QuotaExceededError" }),
    );

    await expect(
      writeStore({
        version: 1,
        settings: DEFAULT_SETTINGS,
        saved: [],
        dictCache: [],
        session: { target: null },
      }),
    ).rejects.toBeInstanceOf(QuotaExceededError);
  });

  it("rethrows a non-quota failure unchanged", async () => {
    const chromeStub = globalThis.chrome as unknown as {
      storage: { local: { set: ReturnType<typeof vi.fn> } };
    };
    const boom = new Error("serialisation failed");
    chromeStub.storage.local.set.mockRejectedValueOnce(boom);

    await expect(
      writeStore({
        version: 1,
        settings: DEFAULT_SETTINGS,
        saved: [],
        dictCache: [],
        session: { target: null },
      }),
    ).rejects.toBe(boom);
  });
});

describe("updateStore", () => {
  beforeEach(() => {
    installFakeStorage();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("applies a mutation and returns its result", async () => {
    const text = await updateStore((store) => ({
      store: { ...store, session: { target } },
      result: store.session.target,
    }));
    expect(text).toBeNull();
    expect((await readStore()).session.target?.text).toBe(target.text);
  });

  it("recovers from a quota error by trimming only the OLDEST cache entries", async () => {
    const chromeStub = globalThis.chrome as unknown as {
      storage: { local: { set: ReturnType<typeof vi.fn> } };
    };
    const now = Date.now();
    // 8 entries, newest first (pruneCache order).
    const cache = Array.from({ length: 8 }, (_, i) => ({
      word: `w${i}`,
      fetchedAt: now - i * 1000,
      entries: [],
    }));
    await updateStore((store) => ({ store: { ...store, dictCache: cache }, result: null }));

    // Fail the first two writes, accept the third.
    chromeStub.storage.local.set
      .mockRejectedValueOnce(quotaError())
      .mockRejectedValueOnce(quotaError());

    const saved = await updateStore((store) => ({
      store: { ...store, session: { target } },
      result: null,
    }));
    expect(saved).toBeNull();

    const after = await readStore();
    // 8 -> 6 -> 4 entries: the two oldest chunks were dropped, NOT the whole cache.
    expect(after.dictCache).toHaveLength(4);
    expect(after.dictCache.map((e) => e.word)).toEqual(["w0", "w1", "w2", "w3"]);
    expect(after.session.target?.text).toBe(target.text);
  });

  it("never discards saved practice history when recovering from a quota error", async () => {
    const chromeStub = globalThis.chrome as unknown as {
      storage: { local: { set: ReturnType<typeof vi.fn> } };
    };
    await updateStore((store) => ({
      store: {
        ...store,
        saved: [
          {
            id: "keep-me",
            text: "record",
            kind: "word",
            ipa: "/ɹɪˈkɔːd/",
            accent: "en-US",
            createdAt: 1,
            attempts: 3,
            lastResult: null,
            box: 2,
          },
        ],
      },
      result: null,
    }));

    chromeStub.storage.local.set.mockRejectedValueOnce(quotaError());
    await updateStore((store) => ({ store, result: null })).catch(() => null);

    const after = await readStore();
    expect(after.saved.map((s) => s.id)).toEqual(["keep-me"]);
  });

  it("surfaces the quota error once the cache is empty, instead of dropping saved items", async () => {
    const chromeStub = globalThis.chrome as unknown as {
      storage: { local: { set: ReturnType<typeof vi.fn> } };
    };
    await updateStore((store) => ({
      store: {
        ...store,
        saved: [
          {
            id: "precious",
            text: "photograph",
            kind: "word",
            ipa: "/ˈfoʊtəɡræf/",
            accent: "en-US",
            createdAt: 1,
            attempts: 1,
            lastResult: null,
            box: 1,
          },
        ],
        dictCache: [{ word: "x", fetchedAt: Date.now(), entries: [] }],
      },
      result: null,
    }));

    chromeStub.storage.local.set.mockRejectedValue(quotaError());

    await expect(
      updateStore((store) => ({ store, result: null })),
    ).rejects.toBeInstanceOf(QuotaExceededError);

    // The practice history is still intact after the failure.
    expect((await readStore()).saved.map((s) => s.id)).toEqual(["precious"]);
  });

  it("rethrows a non-quota error without retrying", async () => {
    const chromeStub = globalThis.chrome as unknown as {
      storage: { local: { set: ReturnType<typeof vi.fn> } };
    };
    await updateStore((store) => ({ store, result: null }));
    const boom = new Error("serialisation failed");
    chromeStub.storage.local.set.mockReset();
    chromeStub.storage.local.set.mockRejectedValue(boom);

    await expect(updateStore((store) => ({ store, result: null }))).rejects.toBe(boom);
    expect(chromeStub.storage.local.set).toHaveBeenCalledTimes(1);
  });
});

describe("cache cap interaction", () => {
  beforeEach(() => {
    installFakeStorage();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("never stores more than the cap, even after a migration", async () => {
    const { data } = installFakeStorage();
    const now = Date.now();
    // A well-formed v1 envelope with an over-full cache.
    data.set("es.store", {
      version: 1,
      settings: DEFAULT_SETTINGS,
      saved: [],
      dictCache: Array.from({ length: DICT_CACHE_MAX_ENTRIES + 25 }, (_, i) => ({
        word: `w${i}`,
        fetchedAt: now,
        entries: [],
      })),
      session: { target: null },
    });

    expect((await readStore()).dictCache).toHaveLength(DICT_CACHE_MAX_ENTRIES);
  });
});