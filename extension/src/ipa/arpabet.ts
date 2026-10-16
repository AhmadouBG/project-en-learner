/**
 * ARPAbet to IPA (spec 5.2).
 *
 * CMUdict is the source of US pronunciations. It is written in ARPAbet, which is
 * a *pronunciation* alphabet rather than a phonetic one: its symbols are
 * deliberately coarser than IPA and the two do not map one-to-one. The mapping
 * below is the conventional ARPAbet-to-IPA correspondence, and the choices that
 * are genuinely debatable are commented where they occur.
 *
 * Spec 5.2 requires two things this module provides:
 *  - the stress digits (0/1/2) are kept, not discarded, so the UI can highlight
 *    the primary-stressed syllable;
 *  - nothing here invents a UK reading. CMUdict is US-only (spec 5.2), and every
 *    output produced here is tagged `en-US` by the caller.
 *
 * Pure and DOM-free so it can be unit tested exhaustively (spec 9). Nothing in
 * this module logs the user's text.
 */

/**
 * Stress marker before the syllable.
 *
 * `ˈ` (U+02C8) for primary stress (digit 1), `ˌ` (U+02CC) for secondary stress
 * (digit 2). An unstressed syllable gets no marker at all.
 */
export const PRIMARY_STRESS = "\u02c8";
export const SECONDARY_STRESS = "\u02cc";

/** ARPAbet phones to IPA. */
const PHONE_TO_IPA: Readonly<Record<string, string>> = {
  // Vowels. Length marks are omitted: CMUdict does not record vowel length, and
  // inventing one would claim a distinction the data does not contain.
  AA: "\u0251", // ɑ  father
  AE: "\u00e6", // æ  cat
  AH: "\u028c", // ʌ  cup (stressed); unstressed AH renders as schwa, below
  AO: "\u0254", // ɔ  thought
  AW: "a\u028a", // aʊ  how
  AY: "a\u026a", // aɪ  my
  EH: "\u025b", // ɛ  bed
  ER: "\u025c\u0279", // ɜɹ  bird (stressed); unstressed renders as ɚ, below
  EY: "e\u026a", // eɪ  day
  IH: "\u026a", // ɪ  sit
  IY: "i", // i  see
  OW: "o\u028a", // oʊ  go
  OY: "\u0254\u026a", // ɔɪ  boy
  UH: "\u028a", // ʊ  book
  UW: "u", // u  too

  // Consonants. ɡ is U+0261 (script g), not U+0067 (Latin g): they are
  // different characters and the wrong one renders as a hook rather than a
  // letter in most fonts.
  B: "b",
  CH: "t\u0283", // tʃ
  D: "d",
  DH: "\u00f0", // ð  this
  F: "f",
  G: "\u0261", // ɡ
  HH: "h",
  JH: "d\u0292", // dʒ
  K: "k",
  L: "l",
  M: "m",
  N: "n",
  NG: "\u014b", // ŋ  sing
  P: "p",
  R: "\u0279", // ɹ  red
  S: "s",
  SH: "\u0283", // ʃ
  T: "t",
  TH: "\u03b8", // θ  think
  V: "v",
  W: "w",
  Y: "j", // j  yes
  Z: "z",
  ZH: "\u0292", // ʒ  vision
};

/**
 * ARPAbet is case-sensitive and the stress digit is part of the symbol: AH0 is a
 * schwa, AH1 is the vowel in "cup". The digit must therefore be split off
 * before the lookup, not stripped.
 */
const SYMBOL_RE = /^([A-Z]+)([012])?$/;

/** A phone with its stress digit separated. */
export interface ParsedPhone {
  /** The bare ARPAbet symbol, e.g. `AH`. */
  readonly symbol: string;
  /** 0 = unstressed, 1 = primary, 2 = secondary. */
  readonly stress: 0 | 1 | 2;
  /** False for a phone we have no IPA mapping for. */
  readonly known: boolean;
}

/** Split one ARPAbet token into symbol and stress. */
export function parsePhone(token: string): ParsedPhone | null {
  const match = SYMBOL_RE.exec(token.trim().toUpperCase());
  // No match means the token is not a phone at all, including a token with an
  // invalid stress digit: ARPAbet only has 0, 1 and 2, so "AH9" is malformed
  // input rather than an unstressed AH.
  if (!match) return null;

  const symbol = match[1] ?? "";
  if (symbol.length === 0) return null;

  const digit = match[2] ?? "0";
  return {
    symbol,
    stress: (digit === "1" || digit === "2" ? Number(digit) : 0) as 0 | 1 | 2,
    known: symbol in PHONE_TO_IPA,
  };
}

/**
 * IPA for a single ARPAbet phone.
 *
 * Two unstressed vowels differ from their stressed forms, and CMUdict marks this
 * with a `0`:
 *  - `AH0` is a schwa (ə, "about"), `AH1/2` is ʌ ("cup");
 *  - `ER0` is the syllabic r-coloured schwa (ɚ, "butter"), `ER1/2` is ɜɹ ("bird").
 *
 * Collapsing these to one symbol each would put a schwa in "cup" and a ɜɹ in
 * "butter", so the digit is load-bearing here, not just for display.
 */
function ipaFor(phone: ParsedPhone): string | null {
  if (phone.stress === 0) {
    if (phone.symbol === "AH") return "\u0259"; // ə
    if (phone.symbol === "ER") return "\u025a"; // ɚ
  }
  return PHONE_TO_IPA[phone.symbol] ?? null;
}

/**
 * Convert a CMUdict pronunciation to IPA, keeping stress markers.
 *
 * Unknown phones are dropped rather than rendered as a placeholder: a partly
 * correct transcription is still useful, an "?" in the middle of a word is not.
 * A caller that needs to know whether anything was lost should compare
 * `parsePhone` results, since this function does not report it.
 *
 * @param arpabet Space-separated phones, e.g. `S CH EH1 D Y UW0 L`.
 */
export function arpabetToIpa(arpabet: string): string {
  // The stress marker belongs BEFORE THE SYLLABLE, not before the stressed
  // vowel. In ARPAbet the digit sits on the vowel, so the obvious translation
  // ("stick ˈ where the 1 was") yields fˈoʊtəɡɹəf for "photograph" -- but the
  // correct transcription is ˈfoʊtəɡɹəf, because the marker stands for the whole
  // syllable and that syllable includes its onset consonants.
  //
  // So the marker is inserted at the syllable's opening index, tracked while the
  // phones are appended in order. Consonants seen since the last vowel are the
  // next syllable's onset, so the syllable's opening index is remembered from
  // the FIRST of them, not from the vowel.
  let out = "";
  /**
   * Index in `out` where the pending syllable began, or null when no consonant
   * is waiting to open one.
   */
  let pendingOnsetStart: number | null = null;

  for (const token of arpabet.trim().split(/\s+/)) {
    if (token === "") continue;

    const phone = parsePhone(token);
    if (!phone) continue;

    const ipa = ipaFor(phone);
    if (ipa === null) continue;

    if (!isVowelSymbol(phone.symbol)) {
      // A consonant. If no syllable has been opened yet it belongs to the onset
      // of the next one, so remember where it started.
      if (pendingOnsetStart === null) pendingOnsetStart = out.length;
      out += ipa;
      continue;
    }

    // A vowel closes the pending onset and opens a syllable, which therefore
    // starts at the first onset consonant, or here if there was no onset.
    const syllableStart = pendingOnsetStart ?? out.length;
    pendingOnsetStart = null;

    const marker =
      phone.stress === 1 ? PRIMARY_STRESS : phone.stress === 2 ? SECONDARY_STRESS : "";
    if (marker !== "") {
      out = out.slice(0, syllableStart) + marker + out.slice(syllableStart);
    }
    out += ipa;
  }

  return out;
}

/** One syllable of a pronunciation, for the stress highlight (spec 4.2). */
export interface Syllable {
  /** The syllable's IPA, including any stress marker that starts it. */
  readonly ipa: string;
  /** 0 = unstressed, 1 = primary, 2 = secondary. */
  readonly stress: 0 | 1 | 2;
}

/**
 * Split a pronunciation into syllables.
 *
 * Syllables are opened by vowels and closed by the consonants that follow, with
 * one rule borrowed from English phonotactics: a syllable-final consonant is at
 * most one, so in "D Y UW" the D is a coda and the Y opens the next syllable
 * (/dj.u/). That single rule is what keeps "schedule" at two syllables rather
 * than three.
 *
 * This is NOT a phonological syllabifier and does not try to be. CMUdict does
 * not mark syllable boundaries, and inventing maximal-onset clusters would be a
 * claim the data cannot support. For a stress highlight this is sufficient,
 * because the only thing that matters is which syllable carries stress 1.
 *
 * @param arpabet Space-separated ARPAbet phones.
 */
export function toSyllables(arpabet: string): Syllable[] {
  const syllables: Syllable[] = [];
  // Consonants seen since the last vowel. A word can start with consonants
  // ("schedule" = S CH ...), and those open the first syllable rather than
  // forming a consonant-only syllable of their own.
  let onset = "";
  /**
   * A consonant held back while we find out whether it belongs to the syllable
   * that just ended or opens the next one. See the coda branch below.
   */
  let pendingCoda = "";

  for (const token of arpabet.trim().split(/\s+/)) {
    if (token === "") continue;

    const phone = parsePhone(token);
    if (!phone) continue;

    const ipa = ipaFor(phone);
    if (ipa === null) continue;

    if (isVowelSymbol(phone.symbol)) {
      // A vowel closes the pending onset and opens a syllable. The stress digit
      // rides on the vowel but describes the whole syllable, so it is recorded on
      // the syllable and the marker is rendered by the caller -- see
      // `arpabetToIpa` for why the marker cannot simply be emitted here.

      // A held consonant that no following vowel claimed is a coda of the
      // syllable that just ended. A word may also begin with a vowel, in which
      // case there is no previous syllable to attach a coda to.
      const previous = syllables[syllables.length - 1];
      if (previous && pendingCoda !== "") {
        syllables[syllables.length - 1] = { ...previous, ipa: previous.ipa + pendingCoda };
      }
      pendingCoda = "";
      syllables.push({ ipa: onset + ipa, stress: phone.stress });
      onset = "";
    } else if (syllables.length > 0 && pendingCoda === "") {
      // A consonant right after a vowel is provisionally the coda of that
      // syllable. English allows at most one, and which one depends on what
      // follows, so it is held until the next phone settles it.
      pendingCoda = ipa;
    } else if (syllables.length > 0) {
      // A second consonant in a row: the held one can no longer be a coda
      // (English codas are at most one consonant), so it belongs to the syllable
      // that ended and this one opens the next syllable's onset.
      const last = syllables[syllables.length - 1] as Syllable;
      syllables[syllables.length - 1] = { ...last, ipa: last.ipa + pendingCoda };
      pendingCoda = "";
      onset = ipa;
    } else {
      onset += ipa;
    }
  }

  // The word ended on a consonant with no following vowel to settle it, so the
  // held consonant is the final coda. Without this, "cup" would come back as
  // "kʌ" and silently lose its p.
  const last = syllables[syllables.length - 1];
  if (last && pendingCoda !== "") {
    syllables[syllables.length - 1] = { ...last, ipa: last.ipa + pendingCoda };
  }

  return syllables;
}

const VOWELS: ReadonlySet<string> = new Set([
  "AA", "AE", "AH", "AO", "AW", "AY", "EH", "ER", "EY",
  "IH", "IY", "OW", "OY", "UH", "UW",
]);

/**
 * True when the ARPAbet symbol is a vowel.
 *
 * Accepts a bare symbol (`EH`) or a full phone with its stress digit (`EH1`),
 * because callers naturally have the latter and stripping the digit before the
 * lookup is an easy step to forget -- and forgetting it silently reports every
 * vowel as a consonant.
 */
export function isVowelSymbol(phone: string): boolean {
  const parsed = parsePhone(phone);
  return parsed !== null && VOWELS.has(parsed.symbol);
}