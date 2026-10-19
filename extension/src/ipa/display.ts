/**
 * IPA presentation helpers (spec 4.2, 5.2).
 *
 * These are pure and DOM-free: the pop-up and the side panel both need the same
 * answers to "which transcription should I show for this accent, and where is
 * the stress?", and a second implementation would drift.
 *
 * Rules (spec 5.2):
 *  - CMUdict is US-only, so a UK reading may ONLY come from the dictionary API;
 *  - when no UK transcription exists we show the US one and say it is US;
 *  - an unknown word falls back to a clearly-marked approximation.
 */

import type { Accent, DictionaryEntry, IpaResult } from "../shared/messages";
import type { Syllable } from "./arpabet";
import { pickIpa } from "../services/dictionary";

export interface WordToken {
  /** The token as it appears in the sentence (punctuation stripped). */
  readonly word: string;
  /** Character offsets in the source string, for boundary-event mapping. */
  readonly start: number;
  readonly end: number;
}

/** Words, numbers and internal apostrophes/hyphens, with their offsets. */
export function tokenizeWords(text: string): WordToken[] {
  const tokens: WordToken[] = [];
  const pattern = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    tokens.push({ word: match[0], start: match.index, end: match.index + match[0].length });
  }
  return tokens;
}

/** The token containing a character offset, or the nearest preceding one. */
export function wordIndexAt(tokens: readonly WordToken[], charIndex: number): number {
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    const token = tokens[i];
    if (token && charIndex >= token.start) return i;
  }
  return 0;
}

export type IpaSource = "cmudict" | "dictionary" | "approximate";

export interface IpaReading {
  readonly ipa: string;
  readonly source: IpaSource;
  /** The variety the transcription actually describes. */
  readonly accent: Accent | null;
  /** Present for CMUdict readings, which carry stress digits. */
  readonly syllables?: readonly Syllable[];
}

/** Approximate letter-to-sound fallback, always labelled as approximate. */
export function approximateIpa(raw: string): string {
  const word = raw.toLowerCase().replace(/[^a-z]/g, "");
  if (word === "") return "";

  // Longest patterns first: a greedy digraph pass is wrong less often than a
  // letter-by-letter one, and this fallback is explicitly approximate anyway.
  const patterns: readonly (readonly [string, string])[] = [
    ["ough", "ɔː"],
    ["augh", "ɔː"],
    ["tion", "ʃən"],
    ["sion", "ʒən"],
    ["tch", "tʃ"],
    ["igh", "aɪ"],
    ["sch", "sk"],
    ["sh", "ʃ"],
    ["ch", "tʃ"],
    ["th", "θ"],
    ["ph", "f"],
    ["wh", "w"],
    ["ck", "k"],
    ["ng", "ŋ"],
    ["qu", "kw"],
    ["oo", "uː"],
    ["ee", "iː"],
    ["ea", "iː"],
    ["ai", "eɪ"],
    ["ay", "eɪ"],
    ["oi", "ɔɪ"],
    ["oy", "ɔɪ"],
    ["ou", "aʊ"],
    ["ow", "aʊ"],
    ["ar", "ɑː"],
    ["or", "ɔː"],
    ["er", "ɜː"],
    ["ir", "ɜː"],
    ["ur", "ɜː"],
  ];

  const letters: Readonly<Record<string, string>> = {
    a: "æ",
    b: "b",
    c: "k",
    d: "d",
    e: "ɛ",
    f: "f",
    g: "ɡ",
    h: "h",
    i: "ɪ",
    j: "dʒ",
    k: "k",
    l: "l",
    m: "m",
    n: "n",
    o: "ɒ",
    p: "p",
    q: "k",
    r: "ɹ",
    s: "s",
    t: "t",
    u: "ʌ",
    v: "v",
    w: "w",
    x: "ks",
    y: "j",
    z: "z",
  };

  let out = "";
  let index = 0;
  while (index < word.length) {
    const rest = word.slice(index);
    const matched = patterns.find(([pattern]) => rest.startsWith(pattern));
    if (matched) {
      out += matched[1];
      index += matched[0].length;
      continue;
    }
    const char = word[index] ?? "";
    out += letters[char] ?? char;
    index += 1;
  }
  return out;
}

/**
 * Choose the transcription to display.
 *
 * `dictionary` is the API entry for the word, if one loaded. `cmu` is our
 * bundled US pronunciation. Passing `null` for both yields an approximation.
 */
export function chooseReading(
  word: string,
  accent: Accent,
  dictionary: DictionaryEntry | null,
  cmu: IpaResult | null,
): IpaReading | null {
  const dictionaryReading = dictionary ? pickIpa(dictionary, accent) : null;

  if (accent === "en-GB") {
    // Spec 5.2: only a source-tagged UK reading may be shown as UK.
    if (dictionaryReading?.accent === "en-GB") {
      return {
        ipa: dictionaryReading.text,
        source: "dictionary",
        accent: "en-GB",
      };
    }
    // Otherwise show the US reading, clearly labelled as US by the caller.
    if (cmu?.ok && cmu.ipa) {
      return {
        ipa: cmu.ipa,
        source: "cmudict",
        accent: "en-US",
        ...(cmu.syllables ? { syllables: cmu.syllables } : {}),
      };
    }
    if (dictionaryReading) {
      return {
        ipa: dictionaryReading.text,
        source: "dictionary",
        accent: dictionaryReading.accent,
      };
    }
  } else {
    if (cmu?.ok && cmu.ipa) {
      return {
        ipa: cmu.ipa,
        source: "cmudict",
        accent: "en-US",
        ...(cmu.syllables ? { syllables: cmu.syllables } : {}),
      };
    }
    if (dictionaryReading) {
      return {
        ipa: dictionaryReading.text,
        source: "dictionary",
        accent: dictionaryReading.accent,
      };
    }
  }

  const approximate = approximateIpa(word);
  if (approximate === "") return null;
  return { ipa: approximate, source: "approximate", accent: null };
}

/**
 * Split a transcription into display segments where each stress marker starts a
 * new segment. The segment that begins with `ˈ` or `ˌ` is the stressed one.
 *
 * This is used for dictionary-provided transcriptions, which have stress marks
 * but no syllable boundaries. For CMUdict readings we have exact syllables and
 * use those instead.
 */
export function stressSegments(ipa: string): { text: string; stressed: boolean }[] {
  if (!ipa.includes("ˈ") && !ipa.includes("ˌ")) return [{ text: ipa, stressed: false }];

  const segments: { text: string; stressed: boolean }[] = [];
  let current = "";
  let stressed = false;

  for (const char of ipa) {
    if (char === "ˈ" || char === "ˌ") {
      if (current !== "") segments.push({ text: current, stressed });
      current = "";
      stressed = true;
    }
    current += char;
  }
  if (current !== "") segments.push({ text: current, stressed });
  return segments;
}

/** Combine per-word IPA for the saved-item schema's single `ipa` field. */
export function joinIpa(
  tokens: readonly WordToken[],
  readings: ReadonlyMap<number, IpaReading | null>,
): string {
  return tokens
    .map((token, index) => {
      const reading = readings.get(index);
      return reading ? `${token.word} /${reading.ipa}/` : token.word;
    })
    .join(" · ");
}
