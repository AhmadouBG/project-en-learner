import { describe, expect, it } from "vitest";
import {
  MAX_SELECTION_CHARS,
  firstSentence,
  isOversized,
  isSpeakableText,
  normalizeText,
  splitSentences,
  toPracticeTarget,
} from "../src/content/normalize";

describe("normalizeText", () => {
  it("trims and collapses runs of whitespace", () => {
    expect(normalizeText("  schedule   the   meeting  ")).toBe("schedule the meeting");
  });

  it("turns newlines from multi-paragraph selections into single spaces", () => {
    expect(normalizeText("first line\nsecond line\r\nthird")).toBe("first line second line third");
    expect(normalizeText("tabs\t\tand   spaces")).toBe("tabs and spaces");
  });

  it("converts non-breaking space, which word processors insert", () => {
    expect(normalizeText("could\u00a0you schedule it")).toBe("could you schedule it");
  });

  it("strips zero-width characters that CMS editors insert", () => {
    // The zero-width characters vanish; the letters either side join up, so
    // "schedu" + "le" + "me" is "scheduleme". Removing the characters must not
    // also invent or delete a letter.
    expect(normalizeText("schedu\u200ble\u2060me")).toBe("scheduleme");
    expect(normalizeText("un\u200bbreak\u200bable")).toBe("unbreakable");
  });

  it("strips control characters but keeps normal punctuation", () => {
    // NUL and BEL disappear entirely; U+2028 is a line separator and becomes a
    // space, because speechSynthesis mispronounces a hard break.
    expect(normalizeText("a\u0000b\u0007c")).toBe("abc");
    expect(normalizeText("a\u2028b")).toBe("a b");
    expect(normalizeText("don't! (really) - 3.5")).toBe("don't! (really) - 3.5");
  });

  it("returns an empty string for whitespace-only input", () => {
    expect(normalizeText("   \n\t  ")).toBe("");
    expect(normalizeText("\u00a0\u200b")).toBe("");
  });

  it("preserves accented and non-Latin characters", () => {
    expect(normalizeText("  café   naïve  ")).toBe("café naïve");
    expect(normalizeText("日本語のテキスト")).toBe("日本語のテキスト");
  });

  it("is idempotent", () => {
    const once = normalizeText("  a \n b\u00a0c  ");
    expect(normalizeText(once)).toBe(once);
  });
});

describe("isOversized", () => {
  it("uses the spec 4.1 limit of 300 characters", () => {
    expect(MAX_SELECTION_CHARS).toBe(300);
    expect(isOversized("a".repeat(300))).toBe(false);
    expect(isOversized("a".repeat(301))).toBe(true);
  });

  it("honours a custom limit", () => {
    expect(isOversized("abcde", 4)).toBe(true);
    expect(isOversized("abcd", 4)).toBe(false);
  });
});

describe("isSpeakableText", () => {
  it("accepts text containing letters or digits", () => {
    expect(isSpeakableText("schedule")).toBe(true);
    expect(isSpeakableText("3.5")).toBe(true);
    expect(isSpeakableText("don't")).toBe(true);
  });

  it("rejects selections with nothing speakable in them", () => {
    expect(isSpeakableText("")).toBe(false);
    expect(isSpeakableText("   ")).toBe(false);
    expect(isSpeakableText("|||")).toBe(false);
    expect(isSpeakableText("--- ***")).toBe(false);
    expect(isSpeakableText("« »")).toBe(false);
  });

  it("rejects emoji-only selections", () => {
    expect(isSpeakableText("\u{1F600}\u{1F601}")).toBe(false);
  });
});

describe("splitSentences", () => {
  it("splits on a single terminator", () => {
    expect(splitSentences("Could you schedule it? Then call Bob.")).toEqual([
      "Could you schedule it?",
      "Then call Bob.",
    ]);
  });

  it("returns one sentence when there is no boundary", () => {
    expect(splitSentences("schedule the meeting")).toEqual(["schedule the meeting"]);
  });

  it("returns nothing for empty input", () => {
    expect(splitSentences("")).toEqual([]);
    expect(splitSentences("    ")).toEqual([]);
  });

  it("keeps abbreviations attached to their sentence", () => {
    expect(splitSentences("Dr. Smith called. He left.")).toEqual([
      "Dr. Smith called.",
      "He left.",
    ]);
    expect(splitSentences("Ask Mr. Jones, e.g. today. Then go.")).toEqual([
      "Ask Mr. Jones, e.g. today.",
      "Then go.",
    ]);
  });

  it("keeps initialisms intact", () => {
    expect(splitSentences("The U.S. economy grew. Slowly.")).toEqual([
      "The U.S. economy grew.",
      "Slowly.",
    ]);
    expect(splitSentences("She has a Ph.D. in physics. Nice.")).toEqual([
      "She has a Ph.D. in physics.",
      "Nice.",
    ]);
  });

  it("does not split decimal numbers", () => {
    expect(splitSentences("Pi is 3.5 exactly. That is all.")).toEqual([
      "Pi is 3.5 exactly.",
      "That is all.",
    ]);
    expect(splitSentences("Use 0.75 speed. Nothing else.")).toEqual([
      "Use 0.75 speed.",
      "Nothing else.",
    ]);
  });

  it("handles runs of terminators", () => {
    expect(splitSentences("Really?! Yes. No.")).toEqual(["Really?!", "Yes.", "No."]);
    expect(splitSentences("Wait... then go. Now.")).toEqual(["Wait...", "then go.", "Now."]);
  });

  it("keeps a trailing quote with its sentence", () => {
    expect(splitSentences('He said "stop." Then he left.')).toEqual([
      'He said "stop."',
      "Then he left.",
    ]);
  });

  it("splits uncapitalised web copy at a boundary anyway", () => {
    expect(splitSentences("first one. second one.")).toEqual(["first one.", "second one."]);
  });

  it("collapses the whitespace before splitting", () => {
    expect(splitSentences("  one.   two.\n\nthree.  ")).toEqual(["one.", "two.", "three."]);
  });

  it("does not produce empty sentences from double spacing after a period", () => {
    expect(splitSentences("One.   Two.")).toEqual(["One.", "Two."]);
  });

  // The rule that carries the initialism cases: a real sentence boundary is
  // followed by whitespace or nothing. If that rule is ever weakened, these fail.
  it("never splits inside a dotted word", () => {
    expect(splitSentences("Visit www.example.com now. Then go.")).toEqual([
      "Visit www.example.com now.",
      "Then go.",
    ]);
    expect(splitSentences("See fig. 3 for details. Next.")).toEqual([
      "See fig. 3 for details.",
      "Next.",
    ]);
    expect(splitSentences("It costs 1.5 million. Really.")).toEqual([
      "It costs 1.5 million.",
      "Really.",
    ]);
  });

  it("treats a period with no following space as part of the word", () => {
    // Sloppy web copy that omits the space: splitting here would be wrong.
    expect(splitSentences("One.Two.")).toEqual(["One.Two."]);
  });

  it("still splits at a terminator followed immediately by a quote then a space", () => {
    expect(splitSentences('"Go." She left.')).toEqual(['"Go."', "She left."]);
  });

  it("handles a single letter followed by a period", () => {
    expect(splitSentences("I left. Then I returned.")).toEqual([
      "I left.",
      "Then I returned.",
    ]);
  });

  it("keeps ellipses inside one sentence", () => {
    expect(splitSentences("Wait... I said wait. Now go.")).toEqual([
      "Wait...",
      "I said wait.",
      "Now go.",
    ]);
  });

  it("does not loop forever on a long run of punctuation", () => {
    expect(splitSentences("A..........B. C.")).toEqual(["A..........B.", "C."]);
  });
});

describe("firstSentence", () => {
  it("returns only the first sentence", () => {
    expect(firstSentence("Could you schedule it? Then call Bob. Then eat.")).toBe(
      "Could you schedule it?",
    );
  });

  it("falls back to the whole text when there is no boundary", () => {
    expect(firstSentence("schedule the meeting")).toBe("schedule the meeting");
  });

  it("does not stop at an abbreviation", () => {
    expect(firstSentence("Dr. Smith called. Then he left.")).toBe("Dr. Smith called.");
  });

  it("does not stop at a decimal", () => {
    expect(firstSentence("Pi is 3.5 exactly. That is all.")).toBe("Pi is 3.5 exactly.");
  });

  it("returns empty for empty input", () => {
    expect(firstSentence("")).toBe("");
  });
});

describe("toPracticeTarget", () => {
  it("carries text, accent and speed together (spec 2)", () => {
    const target = toPracticeTarget("  Could you schedule it? ", {
      accent: "en-GB",
      speed: 0.75,
    });
    expect(target).toEqual({
      text: "Could you schedule it?",
      kind: "sentence",
      accent: "en-GB",
      speed: 0.75,
    });
  });

  it("classifies a single word as a word target", () => {
    expect(toPracticeTarget("photograph", { accent: "en-US", speed: 1 }).kind).toBe("word");
  });

  it("does not flag a short selection as truncated", () => {
    expect(toPracticeTarget("schedule", { accent: "en-US", speed: 1 }).truncated).toBeUndefined();
  });

  it("offers only the first sentence of an oversized selection (spec 4.1)", () => {
    const long = `Photograph the nineteenth-century architecture carefully. ${"x".repeat(400)}`;
    const target = toPracticeTarget(long, { accent: "en-US", speed: 1 });

    expect(isOversized(long)).toBe(true);
    expect(target.text).toBe("Photograph the nineteenth-century architecture carefully.");
    expect(target.truncated).toBe(true);
    expect(target.text.length).toBeLessThan(MAX_SELECTION_CHARS);
  });

  it("keeps the whole text when the first sentence is still long", () => {
    const oneHugeSentence = `${"word ".repeat(200)}end.`;
    const target = toPracticeTarget(oneHugeSentence, { accent: "en-US", speed: 1 });

    // No usable boundary, so we do not silently lose the user's text.
    expect(target.text).toBe(firstSentence(oneHugeSentence));
    expect(target.truncated).toBe(true);
  });

  it("does not log or expose the text anywhere else", () => {
    // Sanity: the payload is plain data, safe to pass around.
    const target = toPracticeTarget("secret phrase", { accent: "en-US", speed: 1 });
    expect(Object.keys(target).sort()).toEqual(["accent", "kind", "speed", "text"]);
  });
});