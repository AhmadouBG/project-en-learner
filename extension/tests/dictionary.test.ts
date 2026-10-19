/**
 * Dictionary API parsing and fetching (spec 5.3).
 *
 * The API is the one network dependency in the product, so its quirks are
 * pinned here: unknown words are HTTP 200 with `entries: []`, transcriptions
 * carry source tags, and every failure has a localisable reason instead of an
 * exception.
 */

import { describe, expect, it, vi } from "vitest";
import {
  DICTIONARY_ENDPOINT,
  accentFromTag,
  cleanIpa,
  failureForStatus,
  fetchDefinition,
  fetchDefinitionWithRaw,
  parseDictionaryResponse,
  parseEntry,
  pickIpa,
} from "../src/services/dictionary";

const payload = {
  word: "record",
  entries: [
    {
      partOfSpeech: "noun",
      pronunciations: [
        { type: "ipa", text: "/ˈɹɛk.ɚd/", tags: ["General American"] },
        { type: "ipa", text: "/ˈɹɛk.ɔːd/", tags: ["Received Pronunciation"] },
        // Duplicate reading, which the upstream data commonly repeats.
        { type: "ipa", text: "/ˈɹɛk.ɚd/", tags: ["General American"] },
        // Wrong notation is ignored rather than rendered as IPA.
        { type: "other", text: "REK-erd" },
      ],
      senses: [
        { definition: "A written account.", examples: ["Keep a record."] },
        { definition: "The best achievement." },
      ],
    },
  ],
};

function response(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  } as Response;
}

describe("accentFromTag", () => {
  it("maps the source tags the API actually returns", () => {
    expect(accentFromTag("General American")).toBe("en-US");
    expect(accentFromTag("Received Pronunciation")).toBe("en-GB");
    expect(accentFromTag(" british english ")).toBe("en-GB");
    expect(accentFromTag("US")).toBe("en-US");
  });

  it("does not guess an accent from an unknown tag", () => {
    expect(accentFromTag("Australian")).toBeNull();
    expect(accentFromTag("")).toBeNull();
  });
});

describe("cleanIpa", () => {
  it("removes enclosing slashes and surrounding space", () => {
    expect(cleanIpa(" /wɜːd/ ")).toBe("wɜːd");
    expect(cleanIpa("//wɜːd//")).toBe("wɜːd");
    expect(cleanIpa("wɜːd")).toBe("wɜːd");
  });
});

describe("parseEntry / parseDictionaryResponse", () => {
  it("parses senses and source-tagged IPA, de-duplicating readings", () => {
    const entries = parseDictionaryResponse("record", payload);
    expect(entries).toHaveLength(1);

    const entry = entries[0];
    expect(entry?.partOfSpeech).toBe("noun");
    expect(entry?.definitions).toEqual([
      "A written account.",
      "The best achievement.",
    ]);
    expect(entry?.example).toBe("Keep a record.");
    expect(entry?.ipa).toEqual([
      { accent: "en-US", text: "ˈɹɛk.ɚd" },
      { accent: "en-GB", text: "ˈɹɛk.ɔːd" },
    ]);
    expect(entry?.sourceUrl).toBe(`${DICTIONARY_ENDPOINT}/record`);
  });

  it("keeps an untagged transcription as null rather than inventing an accent", () => {
    const entry = parseEntry(
      { partOfSpeech: "noun", pronunciations: [{ type: "ipa", text: "/wɜːd/" }] },
      "word",
    );
    expect(entry?.ipa).toEqual([{ accent: null, text: "wɜːd" }]);
  });

  it("returns no entries for the API's not-found shape", () => {
    expect(parseDictionaryResponse("zzzz", { entries: [] })).toEqual([]);
    expect(parseDictionaryResponse("zzzz", null)).toEqual([]);
    expect(parseDictionaryResponse("zzzz", { entries: "nope" })).toEqual([]);
  });

  it("drops malformed entries instead of throwing", () => {
    const entries = parseDictionaryResponse("x", {
      entries: [null, 3, {}, { partOfSpeech: "noun" }, { senses: [] }],
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.partOfSpeech).toBe("noun");
    expect(entries[0]?.definitions).toEqual([]);
  });

  it("uses an em dash when the API omits the part of speech", () => {
    const entry = parseEntry({ senses: [{ definition: "A thing." }] }, "thing");
    expect(entry?.partOfSpeech).toBe("—");
  });

  it("escapes the word in the source URL", () => {
    const entry = parseEntry({ partOfSpeech: "noun" }, "a b");
    expect(entry?.sourceUrl).toBe(`${DICTIONARY_ENDPOINT}/a%20b`);
  });
});

describe("pickIpa", () => {
  const entry = {
    partOfSpeech: "noun",
    ipa: [
      { accent: "en-US" as const, text: "us" },
      { accent: null, text: "untagged" },
    ],
    definitions: [],
    example: null,
    sourceUrl: "",
  };

  it("prefers an exact accent match", () => {
    expect(pickIpa(entry, "en-US")).toEqual({ accent: "en-US", text: "us" });
  });

  it("falls back to an untagged reading, never to the other accent", () => {
    expect(pickIpa(entry, "en-GB")).toEqual({ accent: null, text: "untagged" });
  });

  it("returns null when nothing is available", () => {
    expect(pickIpa({ ...entry, ipa: [] }, "en-US")).toBeNull();
  });
});

describe("failureForStatus", () => {
  it("distinguishes rate limiting and not-found from server errors", () => {
    expect(failureForStatus(404)).toBe("not-found");
    expect(failureForStatus(429)).toBe("rate-limited");
    expect(failureForStatus(500)).toBe("server");
  });
});

describe("fetchDefinitionWithRaw", () => {
  it("returns parsed entries and the raw payload for the cache", async () => {
    const fetch = vi.fn(async () => response(payload));
    const { result, rawEntries } = await fetchDefinitionWithRaw("record", { fetch });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.entries).toHaveLength(1);
    expect(rawEntries).toEqual(payload.entries);
    expect(fetch).toHaveBeenCalledWith(
      `${DICTIONARY_ENDPOINT}/record`,
      expect.objectContaining({ headers: { Accept: "application/json" } }),
    );
  });

  it("turns an empty entries array into not-found", async () => {
    const { result, rawEntries } = await fetchDefinitionWithRaw("zzzz", {
      fetch: async () => response({ entries: [] }),
    });
    expect(result).toEqual({ ok: false, word: "zzzz", reason: "not-found" });
    expect(rawEntries).toEqual([]);
  });

  it("classifies HTTP failures and does not cache them", async () => {
    const { result, rawEntries } = await fetchDefinitionWithRaw("word", {
      fetch: async () => response(null, { ok: false, status: 429 }),
    });
    expect(result).toEqual({ ok: false, word: "word", reason: "rate-limited" });
    expect(rawEntries).toBeNull();
  });

  it("reports offline/network failures instead of throwing", async () => {
    const result = await fetchDefinition("word", {
      fetch: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    expect(result).toEqual({ ok: false, word: "word", reason: "offline" });
  });

  it("rejects implausible words without making a request", async () => {
    const fetch = vi.fn(async () => response(payload));
    const result = await fetchDefinition("not a word", { fetch });
    expect(result).toEqual({ ok: false, word: "not a word", reason: "bad-word" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
