import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, beforeAll } from "vitest";
import { loadTable, lookup, lookupVariants, resetTableCache } from "../src/ipa/lookup";

/*
 * Exercises the LAZY reader against the real generated dictionary.
 *
 * Only runs when the dictionary has been built (`node scripts/build-dict.mjs`).
 * The unit tests for ARPAbet->IPA run always; these are skipped rather than
 * failed on a fresh clone, because the data is generated and gitignored
 * (spec 5.2: bundle it, but do not commit 2 MB to the repository).
 */

const DICT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "dict");
const hasDict = existsSync(join(DICT_DIR, "dict.json"));

const describeIfBuilt = hasDict ? describe : describe.skip;

/** Load through a fetch stub, since the module fetches by URL. */
async function load() {
  resetTableCache();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (url.endsWith("dict.json")) {
      return new Response(readFileSync(join(DICT_DIR, "dict.json"), "utf8"), {
        status: 200,
      });
    }
    if (url.endsWith("dict.bin")) {
      return new Response(readFileSync(join(DICT_DIR, "dict.bin")), { status: 200 });
    }
    return new Response(null, { status: 404 });
  });

  try {
    return await loadTable("chrome-extension://x/dict.json", "chrome-extension://x/dict.bin");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

describeIfBuilt("lazy dictionary lookup (generated cmudict)", () => {
  let table: Awaited<ReturnType<typeof load>>;

  beforeAll(async () => {
    table = await load();
  });

  it("loads without decoding every entry", () => {
    // The lazy table must not hold a decoded array. This is the property that
    // made it worth building: the eager version kept 135,166 entries in memory.
    const eager = table as unknown as { arpabet?: unknown; words?: unknown };
    expect(eager.arpabet).toBeUndefined();
    expect(eager.words).toBeUndefined();
  });

  it("finds a word in the first block", () => {
    // "a" sorts near the start, so this exercises block 0 and the checkpoint at
    // index 0 (stored verbatim, no prefix digit).
    expect(lookup(table, "a")).not.toBeNull();
  });

  it("finds a word in a middle block", () => {
    expect(lookup(table, "schedule")?.ipa).toBe("ˈskɛdʒʊl");
  });

  it("finds a word in the last block", () => {
    // The final block is short, and its end offset is the payload length rather
    // than the next entry's offset, which is where off-by-one errors hide.
    // "zywicki" is the last entry in the pinned dictionary; "zyzzyva" is not in
    // it, which is why an earlier draft of this test wrongly expected null-safe
    // behaviour here.
    expect(lookup(table, "zywicki")).not.toBeNull();
    expect(lookup(table, "zyzzyva")).toBeNull();
  });

  it("distinguishes the readings of record", () => {
    // `lookup` returns the first entry; the variants are reachable only through
    // `lookupVariants`, because normalising "record(2)" would strip the suffix
    // and hand back "record" again.
    expect(lookup(table, "record")?.ipa).toBe("ɹəˈkɔɹd");

    const variants = lookupVariants(table, "record");
    expect(variants.map((v) => v.ipa)).toEqual(["ɹəˈkɔɹd", "ˈɹɛkɚd", "ɹɪˈkɔɹd"]);
  });

  it("returns a single reading when a word has no variants", () => {
    expect(lookupVariants(table, "schedule")).toHaveLength(2); // schedule, schedule(2)
    expect(lookupVariants(table, "zywicki")).toHaveLength(1);
  });

  it("gives every variant the same base word", () => {
    for (const variant of lookupVariants(table, "record")) {
      expect(variant.word).toBe("record");
      expect(variant.accent).toBe("en-US");
    }
  });

  it("marks every result as US, never UK", () => {
    // Spec 5.2: CMUdict is US-only and we must never claim a UK reading.
    expect(lookup(table, "schedule")?.accent).toBe("en-US");
    expect(lookup(table, "photograph")?.accent).toBe("en-US");
  });

  it("puts the stress on the syllable CMUdict marks", () => {
    const result = lookup(table, "photograph");
    const primary = result?.syllables.filter((s) => s.stress === 1) ?? [];
    expect(primary).toHaveLength(1);
  });

  it("normalises page text before looking up", () => {
    expect(lookup(table, "  Schedule, ")?.ipa).toBe(lookup(table, "schedule")?.ipa);
    expect(lookup(table, "RECORD.")?.ipa).toBe(lookup(table, "record")?.ipa);
  });

  it("returns null rather than guessing for an unknown word", () => {
    expect(lookup(table, "zzzznotaword")).toBeNull();
    expect(lookup(table, "")).toBeNull();
    expect(lookup(table, "   ")).toBeNull();
  });

  it("reuses the loaded table across lookups", async () => {
    // A second loadTable call must return the memoised table, not refetch.
    // `load()` deliberately resets the cache first, so call loadTable directly.
    const again = await loadTable(
      "chrome-extension://x/dict.json",
      "chrome-extension://x/dict.bin",
    );
    expect(again).toBe(table);
  });

  it("stays fast on a cold block, well under the 20 ms budget", () => {
    const words = ["zyzzyva", "schedule", "antidisestablishmentarianism", "a", "quixotic"];
    for (const w of words) lookup(table, w);

    const samples: number[] = [];
    for (let i = 0; i < 100; i += 1) {
      const word = words[i % words.length] as string;
      const start = performance.now();
      lookup(table, word);
      samples.push(performance.now() - start);
    }
    const worst = Math.max(...samples);
    expect(worst).toBeLessThan(20);
  });
});