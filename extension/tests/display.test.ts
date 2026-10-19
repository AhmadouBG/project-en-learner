/**
 * IPA presentation rules (spec 4.2, 5.2).
 *
 * The important invariant is that a UK label can only ever come from a
 * source-tagged UK transcription. CMUdict is US-only, so selecting UK with no
 * API reading must show the US one, clearly marked, rather than relabelling it.
 */

import { describe, expect, it } from "vitest";
import {
  approximateIpa,
  chooseReading,
  joinIpa,
  stressSegments,
  tokenizeWords,
  wordIndexAt,
} from "../src/ipa/display";
import type { DictionaryEntry, IpaResult } from "../src/shared/messages";

const cmu: IpaResult = {
  ok: true,
  word: "schedule",
  ipa: "ˈskedʒ.uːl",
  syllables: [
    { ipa: "ˈskedʒ", stress: 1 },
    { ipa: "uːl", stress: 0 },
  ],
};

const usEntry: DictionaryEntry = {
  partOfSpeech: "noun",
  ipa: [{ accent: "en-US", text: "ˈskedʒ.uːl" }],
  definitions: ["A plan."],
  example: null,
  sourceUrl: "",
};

const gbEntry: DictionaryEntry = {
  ...usEntry,
  ipa: [{ accent: "en-GB", text: "ˈʃed.juːl" }],
};

describe("tokenizeWords", () => {
  it("keeps internal apostrophes and hyphens but drops punctuation", () => {
    const tokens = tokenizeWords("Don't re-read the 2nd draft.");
    expect(tokens.map((token) => token.word)).toEqual([
      "Don't",
      "re-read",
      "the",
      "2nd",
      "draft",
    ]);
  });

  it("records offsets into the original string", () => {
    const tokens = tokenizeWords("Hi, there!");
    expect(tokens).toEqual([
      { word: "Hi", start: 0, end: 2 },
      { word: "there", start: 4, end: 9 },
    ]);
  });

  it("returns nothing for punctuation-only text", () => {
    expect(tokenizeWords("...!?")).toEqual([]);
  });
});

describe("wordIndexAt", () => {
  const tokens = tokenizeWords("one two three");

  it("finds the token containing an offset", () => {
    expect(wordIndexAt(tokens, 0)).toBe(0);
    expect(wordIndexAt(tokens, 5)).toBe(1);
    expect(wordIndexAt(tokens, 9)).toBe(2);
  });

  it("uses the nearest preceding token for whitespace and clamps to the first", () => {
    expect(wordIndexAt(tokens, 3)).toBe(0);
    expect(wordIndexAt(tokens, -1)).toBe(0);
    expect(wordIndexAt(tokens, 999)).toBe(2);
  });
});

describe("approximateIpa", () => {
  it("uses digraphs where it can and marks nothing as exact", () => {
    expect(approximateIpa("ship")).toBe("ʃɪp");
    expect(approximateIpa("thought")).toBe("θɔːt");
  });

  it("returns an empty string when there is nothing pronounceable", () => {
    expect(approximateIpa("123")).toBe("");
  });
});

describe("chooseReading", () => {
  it("uses CMUdict for US, including its exact syllables", () => {
    const reading = chooseReading("schedule", "en-US", gbEntry, cmu);
    expect(reading).toMatchObject({ source: "cmudict", accent: "en-US" });
    expect(reading?.syllables).toHaveLength(2);
  });

  it("uses a source-tagged UK reading for UK", () => {
    expect(chooseReading("schedule", "en-GB", gbEntry, cmu)).toEqual({
      ipa: "ˈʃed.juːl",
      source: "dictionary",
      accent: "en-GB",
    });
  });

  it("falls back to the US reading for UK, labelled as US", () => {
    expect(chooseReading("schedule", "en-GB", usEntry, cmu)).toMatchObject({
      source: "cmudict",
      accent: "en-US",
    });
  });

  it("falls back to CMUdict when the API has no reading", () => {
    expect(chooseReading("schedule", "en-US", null, cmu)).toMatchObject({
      source: "cmudict",
    });
  });

  it("uses the API reading when CMUdict does not know the word", () => {
    expect(chooseReading("schedule", "en-US", usEntry, { ok: false, word: "schedule" }))
      .toEqual({ ipa: "ˈskedʒ.uːl", source: "dictionary", accent: "en-US" });
  });

  it("approximates an unknown word and never claims an accent", () => {
    expect(chooseReading("blorple", "en-US", null, null)).toEqual({
      ipa: "blɔːplɛ",
      source: "approximate",
      accent: null,
    });
  });

  it("returns null when there is nothing to display", () => {
    expect(chooseReading("123", "en-US", null, null)).toBeNull();
  });
});

describe("stressSegments", () => {
  it("starts a new segment at each stress marker", () => {
    expect(stressSegments("ˌɪn.təˈnæʃ.ən.əl")).toEqual([
      { text: "ˌɪn.tə", stressed: true },
      { text: "ˈnæʃ.ən.əl", stressed: true },
    ]);
  });

  it("returns one unstressed segment when there are no marks", () => {
    expect(stressSegments("wɜːd")).toEqual([{ text: "wɜːd", stressed: false }]);
  });
});

describe("joinIpa", () => {
  it("joins per-word readings and leaves unknown words bare", () => {
    const tokens = tokenizeWords("hello world");
    const readings = new Map([
      [0, { ipa: "həˈləʊ", source: "dictionary" as const, accent: "en-GB" as const }],
    ]);
    expect(joinIpa(tokens, readings)).toBe("hello /həˈləʊ/ · world");
  });
});
