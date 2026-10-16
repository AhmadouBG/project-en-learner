import { describe, expect, it } from "vitest";
import {
  arpabetToIpa,
  isVowelSymbol,
  parsePhone,
  PRIMARY_STRESS,
  SECONDARY_STRESS,
  toSyllables,
} from "../src/ipa/arpabet";

/*
 * IPA literals are written as real characters, not \u escapes.
 *
 * Hand-written escape sequences in this file were wrong three separate times
 * (a transposed ɛ and ˈ, a schwa where a diphthong belonged), and every one
 * failed as an unreadable "expected 'stʃˈɛdjul' to be 'stʃɛˈdjul'". A readable
 * transcription is reviewable; a correct-looking escape sequence is not.
 */

describe("parsePhone", () => {
  it("splits the stress digit off the symbol", () => {
    // The digit is part of the symbol in ARPAbet: AH0 is a schwa, AH1 is ʌ.
    expect(parsePhone("AH0")).toEqual({ symbol: "AH", stress: 0, known: true });
    expect(parsePhone("AH1")).toEqual({ symbol: "AH", stress: 1, known: true });
    expect(parsePhone("EH2")).toEqual({ symbol: "EH", stress: 2, known: true });
  });

  it("defaults a missing digit to 0", () => {
    expect(parsePhone("B")).toEqual({ symbol: "B", stress: 0, known: true });
  });

  it("normalises case and surrounding space", () => {
    expect(parsePhone("  m ")?.symbol).toBe("M");
  });

  it("marks unknown symbols rather than throwing", () => {
    expect(parsePhone("QQ")).toEqual({ symbol: "QQ", stress: 0, known: false });
  });

  it("rejects a token with no letters", () => {
    expect(parsePhone("1")).toBeNull();
    expect(parsePhone("")).toBeNull();
  });

  it("rejects a nonsense stress digit", () => {
    // Only 0, 1 and 2 are valid ARPAbet stress markers, so "AH9" is malformed
    // input rather than an unstressed AH.
    expect(parsePhone("AH9")).toBeNull();
  });
});

describe("arpabetToIpa", () => {
  // The spec's own Phase 3 acceptance words.
  it("converts schedule with the stress on the first syllable", () => {
    // S CH EH1 D Y UW0 L -> ˈstʃɛdjul. The marker precedes the whole syllable,
    // so it sits before the onset consonants, not before the stressed vowel.
    expect(arpabetToIpa("S CH EH1 D Y UW0 L")).toBe(`${PRIMARY_STRESS}stʃɛdjul`);
  });

  it("converts photograph with the stress on the first syllable", () => {
    // F OW1 T AH0 G R AH0 F -> ˈfoʊtəɡɹəf
    expect(arpabetToIpa("F OW1 T AH0 G R AH0 F")).toBe(`${PRIMARY_STRESS}foʊtəɡɹəf`);
  });

  it("distinguishes the noun and verb readings of record", () => {
    // The spec calls this out by name. Same spelling, different stress:
    //   noun  R EH1 K ER0 D -> ˈɹɛkɚd
    //   verb  R IH0 K AO1 R D -> ɹɪˈkɔɹd
    expect(arpabetToIpa("R EH1 K ER0 D")).toBe(`${PRIMARY_STRESS}ɹɛkɚd`);
    expect(arpabetToIpa("R IH0 K AO1 R D")).toBe(`ɹɪ${PRIMARY_STRESS}kɔɹd`);
  });

  it("renders AH0 as a schwa and AH1 as ʌ", () => {
    // The digit is load-bearing: one symbol for both would put a schwa in "cup".
    expect(arpabetToIpa("K AH1 P")).toBe(`${PRIMARY_STRESS}kʌp`);
    // "about" = AH0 B AW1 T. UW is /u/ ("too"); UH is /ʊ/ ("book").
    expect(arpabetToIpa("AH0 B AW1 T")).toBe(`ə${PRIMARY_STRESS}baʊt`);
  });

  it("renders ER0 as ɚ and ER1 as ɜɹ", () => {
    // "butter" vs "bird" are the same ARPAbet symbol at different stress.
    expect(arpabetToIpa("B AH1 T ER0")).toBe(`${PRIMARY_STRESS}bʌtɚ`);
    expect(arpabetToIpa("B ER1 D")).toBe(`${PRIMARY_STRESS}bɜɹd`);
  });

  it("uses script g, not Latin g", () => {
    // U+0261 vs U+0067. Different characters, and the wrong one renders as a
    // hook rather than a letter in most fonts.
    expect(arpabetToIpa("G")).toBe("ɡ");
    expect(arpabetToIpa("G")).not.toBe("g");
  });

  it("marks secondary stress distinctly from primary", () => {
    const secondary = arpabetToIpa("EH2");
    expect(secondary).toBe(`${SECONDARY_STRESS}ɛ`);
    expect(secondary).not.toContain(PRIMARY_STRESS);
  });

  it("drops unknown phones instead of emitting a placeholder", () => {
    expect(arpabetToIpa("S CH EH1 QQ D Y UW0 L")).toBe(`${PRIMARY_STRESS}stʃɛdjul`);
    expect(arpabetToIpa("S QQ CH")).not.toContain("?");
  });

  it("returns an empty string for input with no known phones", () => {
    expect(arpabetToIpa("")).toBe("");
    expect(arpabetToIpa("   ")).toBe("");
    expect(arpabetToIpa("QQ ZZ")).toBe("");
  });

  it("tolerates ragged whitespace", () => {
    expect(arpabetToIpa("  S   CH\tEH1 ")).toBe(arpabetToIpa("S CH EH1"));
  });

  it("never emits the Latin letter g from a vowel or consonant", () => {
    // Guards against someone "fixing" ɡ back to g later. Checked on a whole
    // word, since consonants like l and f are legitimately ASCII.
    expect(arpabetToIpa("G OW1 L F")).not.toContain("g");
  });
});

describe("toSyllables", () => {
  it("splits schedule into two syllables with the first stressed", () => {
    const syllables = toSyllables("S CH EH1 D Y UW0 L");
    expect(syllables).toHaveLength(2);
    expect(syllables[0]?.stress).toBe(1);
    expect(syllables[1]?.stress).toBe(0);
  });

  it("keeps the leading consonants inside the first syllable", () => {
    // Regression: the S CH onset became a consonant-only syllable of its own,
    // which made "schedule" 3 syllables and would have highlighted an empty one.
    const syllables = toSyllables("S CH EH1 D Y UW0 L");
    expect(syllables).toHaveLength(2);
    expect(syllables[0]?.ipa.startsWith("stʃ")).toBe(true);
  });

  it("puts a consonant after a vowel in that syllable's coda", () => {
    // S CH EH1 D Y UW0 L: the D closes the first syllable, the Y opens the
    // second. Neither consonant starts a syllable on its own.
    const syllables = toSyllables("S CH EH1 D Y UW0 L");
    expect(syllables[0]?.ipa).toBe("stʃɛd");
    expect(syllables[1]?.ipa).toBe("jul");
  });

  it("treats a single-syllable word as one syllable", () => {
    const syllables = toSyllables("K AH1 P");
    expect(syllables).toHaveLength(1);
    expect(syllables[0]?.ipa).toBe("kʌp");
  });

  it("finds exactly one primary-stressed syllable", () => {
    // Every CMUdict entry is required to carry exactly one stress-1 vowel.
    for (const word of ["B AH1 T ER0", "F OW1 T AH0 G R AH0 F", "R EH1 K ER0 D"]) {
      const primary = toSyllables(word).filter((s) => s.stress === 1);
      expect(primary).toHaveLength(1);
    }
  });

  it("puts the stress on the second syllable of photograph", () => {
    // ˈfoʊtəɡɹəf -> foʊ | tə | ɡɹəf? No: CMUdict's segmentation is
    // foʊ.tə.ɡɹəf with stress on the first, so the highlight goes on syllable 0.
    const syllables = toSyllables("F OW1 T AH0 G R AH0 F");
    expect(syllables.filter((s) => s.stress === 1)).toHaveLength(1);
    expect(syllables[0]?.stress).toBe(1);
  });

  it("returns nothing for unpronounceable input", () => {
    expect(toSyllables("")).toEqual([]);
    expect(toSyllables("QQ ZZ")).toEqual([]);
  });
});

describe("isVowelSymbol", () => {
  it("accepts a bare symbol", () => {
    expect(isVowelSymbol("EH")).toBe(true);
    expect(isVowelSymbol("S")).toBe(false);
  });

  it("accepts a phone with its stress digit", () => {
    // Regression: only the bare form matched, so "EH1" reported as a consonant.
    expect(isVowelSymbol("EH1")).toBe(true);
    expect(isVowelSymbol("S1")).toBe(false);
  });

  it("rejects nonsense", () => {
    expect(isVowelSymbol("nonsense")).toBe(false);
    expect(isVowelSymbol("")).toBe(false);
  });
});