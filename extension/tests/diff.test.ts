/**
 * Word-level alignment (spec 5.6, Phase 8 check).
 *
 * Cases required by the spec: exact match, one substitution, one missing word,
 * an extra word, punctuation/case differences, contractions.
 */

import { describe, expect, it } from "vitest";
import { diffWords, normaliseWords } from "../src/services/diff";

const statuses = (target: string, heard: string): string[] =>
  diffWords(target, heard).words.map((word) => `${word.word}:${word.status}`);

describe("normaliseWords", () => {
  it("lowercases and strips punctuation", () => {
    expect(normaliseWords("Hello, WORLD! It's fine.")).toEqual([
      "hello",
      "world",
      "it",
      "is",
      "fine",
    ]);
  });

  it("expands contractions on both sides", () => {
    expect(normaliseWords("don't")).toEqual(["do", "not"]);
    expect(normaliseWords("DO NOT")).toEqual(["do", "not"]);
    expect(normaliseWords("they're")).toEqual(["they", "are"]);
  });

  it("keeps hyphenated and numeric tokens", () => {
    expect(normaliseWords("re-read 2nd")).toEqual(["re-read", "2nd"]);
  });
});

describe("diffWords", () => {
  it("matches identical text regardless of case and punctuation", () => {
    const result = diffWords("Could you schedule the meeting?", "could you schedule the meeting");
    expect(result.matched).toBe(5);
    expect(result.total).toBe(5);
    expect(result.words.every((word) => word.status === "matched")).toBe(true);
  });

  it("reports one substitution with the heard word", () => {
    expect(statuses("schedule the meeting", "schedule a meeting")).toEqual([
      "schedule:matched",
      "the:substituted",
      "meeting:matched",
    ]);
    expect(diffWords("the meeting", "a meeting").words[0]).toEqual({
      word: "the",
      status: "substituted",
      heard: "a",
    });
  });

  it("reports a missing word", () => {
    expect(statuses("please schedule the meeting", "please the meeting")).toEqual([
      "please:matched",
      "schedule:missing",
      "the:matched",
      "meeting:matched",
    ]);
    expect(diffWords("please schedule the meeting", "please the meeting").matched).toBe(3);
  });

  it("reports an extra word in reading order", () => {
    expect(statuses("schedule the meeting", "schedule the quick meeting")).toEqual([
      "schedule:matched",
      "the:matched",
      "quick:extra",
      "meeting:matched",
    ]);
    expect(diffWords("schedule the meeting", "schedule the quick meeting").matched).toBe(3);
  });

  it("treats an expanded contraction as a match", () => {
    expect(diffWords("I don't know", "I do not know")).toMatchObject({
      matched: 4,
      total: 4,
    });
  });

  it("handles empty input without throwing", () => {
    expect(diffWords("", "hello")).toMatchObject({ matched: 0, total: 0 });
    expect(diffWords("hello", "")).toMatchObject({ matched: 0, total: 1 });
    expect(diffWords("", "")).toMatchObject({ matched: 0, total: 0 });
  });

  it("keeps the transcript readable", () => {
    expect(diffWords("hello", "Well, hello there!").transcript).toBe("Well hello there");
  });
});
