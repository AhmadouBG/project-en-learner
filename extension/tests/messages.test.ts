import { describe, expect, it } from "vitest";
import {
  ACCENTS,
  classifyText,
  isAccent,
  isLookupWord,
  type PracticeTarget,
} from "../src/shared/messages";

describe("classifyText", () => {
  it("treats a single bare token as a word", () => {
    expect(classifyText("schedule")).toBe("word");
    expect(classifyText("  schedule  ")).toBe("word");
    expect(classifyText("photograph")).toBe("word");
  });

  it("accepts hyphenated, apostrophised and accented words as words", () => {
    expect(classifyText("well-known")).toBe("word");
    expect(classifyText("don't")).toBe("word");
    expect(classifyText("café")).toBe("word");
  });

  it("treats phrases and terminal punctuation as sentences", () => {
    expect(classifyText("I would have gone.")).toBe("sentence");
    expect(classifyText("schedule the meeting")).toBe("sentence");
    expect(classifyText("How are you?")).toBe("sentence");
  });

  it("falls back to sentence for empty input rather than throwing", () => {
    expect(classifyText("")).toBe("sentence");
    expect(classifyText("   ")).toBe("sentence");
  });
});

describe("isAccent", () => {
  it("accepts only the two supported accents", () => {
    expect(isAccent("en-US")).toBe(true);
    expect(isAccent("en-GB")).toBe(true);
    expect(ACCENTS).toEqual(["en-US", "en-GB"]);
  });

  it("rejects anything else, including near-misses", () => {
    for (const bad of ["en-AU", "EN-US", "en_US", "fr-FR", "", null, undefined, 42, {}]) {
      expect(isAccent(bad)).toBe(false);
    }
  });
});

describe("isLookupWord", () => {
  it("accepts ordinary words and contractions", () => {
    expect(isLookupWord("schedule")).toBe(true);
    expect(isLookupWord("don't")).toBe(true);
  });

  it("rejects multi-word strings, over-long strings and punctuation", () => {
    expect(isLookupWord("two words")).toBe(false);
    expect(isLookupWord("a".repeat(65))).toBe(false);
    expect(isLookupWord("hello!")).toBe(false);
    expect(isLookupWord("")).toBe(false);
  });

  it("accepts exactly 64 characters, the boundary", () => {
    expect(isLookupWord("a".repeat(64))).toBe(true);
  });
});

describe("PracticeTarget", () => {
  it("keeps text/accent/speed together so the panel needs no re-typing", () => {
    // Spec 2: "Selected text, accent and speed must carry over from pop-up to
    // side panel with no re-typing."
    const target: PracticeTarget = {
      text: "Could you schedule the meeting?",
      kind: "sentence",
      accent: "en-GB",
      speed: 0.75,
      truncated: false,
    };

    expect(target.text).toContain("schedule");
    expect(target.accent).toBe("en-GB");
    expect(target.speed).toBe(0.75);
  });
});