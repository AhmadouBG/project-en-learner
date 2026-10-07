/**
 * Text normalisation for captured selections (spec 5.1, 4.1, 4.2).
 *
 * Everything here is deliberately DOM-free and side-effect free so it can be
 * unit tested exhaustively (spec 9). Nothing in this module logs the text.
 *
 * Spec 9: selected page text is untrusted input. These functions only ever
 * produce plain strings; rendering is the caller's job and must use textContent.
 */

import { classifyText, type Accent, type PracticeTarget } from "../shared/messages";

/**
 * Spec 4.1: "Ignores selections longer than ~300 characters (instead show the
 * button, and the pop-up offers to practise only the first sentence)."
 *
 * We still SHOW the button; the limit only decides what the pop-up offers to
 * practise. "~300" is pinned to 300 for a testable definition.
 */
export const MAX_SELECTION_CHARS = 300;

/**
 * Whitespace that shows up in real selections but is not a visible space.
 * NBSP comes from word processors and `&nbsp;`; the zero-width characters come
 * from CMS editors and some PDF-to-HTML converters.
 */
const INVISIBLE = /[\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/g;
const ZERO_WIDTH = /[\u200b-\u200d\u2060]/g;
/**
 * C0/C1 control characters, excluding the whitespace handled above (tab, LF and
 * CR are deliberately kept: they are real whitespace and get collapsed below).
 */
const CONTROL = new RegExp(
  "[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f]",
  "g",
);

/**
 * Clean a raw selection into a single-line string.
 *
 * Collapses every run of whitespace (including newlines from selecting across
 * paragraphs) to one space, strips invisible and control characters, and trims.
 * This is what we hand to speechSynthesis, which mispronounces newlines.
 */
export function normalizeText(raw: string): string {
  return raw
    .replace(INVISIBLE, " ")
    .replace(ZERO_WIDTH, "")
    .replace(CONTROL, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** True when the selection is longer than the pop-up's comfortable limit. */
export function isOversized(text: string, limit = MAX_SELECTION_CHARS): boolean {
  return text.length > limit;
}

/**
 * Is this selection worth offering to practise?
 *
 * A selection with no letters or digits at all is not speech: selecting a
 * divider, a row of pipes or a stray emoji should never produce a button.
 * NBSP-only and zero-width-only selections normalise away to nothing.
 */
export function isSpeakableText(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

// ---------------------------------------------------------------------------
// Sentence splitting
// ---------------------------------------------------------------------------

/**
 * Lowercase abbreviations that end in a period but do not end a sentence.
 * Deliberately short: a long list is worse than none, because a wrong entry
 * merges two real sentences.
 */
const ABBREVIATIONS = new Set([
  "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "mt", "ft", "rev",
  "vs", "etc", "al", "inc", "ltd", "co", "dept", "est", "fig", "no", "approx",
  "e.g", "i.e", "cf", "viz", "ibid", "a.m", "p.m", "u.s", "u.k",
]);

const CLOSERS = '"\'”’»)]}';

/**
 * The abbreviation-like token ending immediately before a period, used to
 * recognise abbreviations and initialisms ("Dr", "U.S.A", "e.g").
 *
 * This must capture the WHOLE dotted token, not just the last letter run:
 * for "e.g." the period being tested comes after "g", so a naive backwards scan
 * yields "g" and misses the abbreviation entirely.
 */
function tokenBefore(text: string, dotIndex: number): string {
  const prefix = text.slice(0, dotIndex);
  const match = /([A-Za-z]+(?:\.[A-Za-z]+)*)$/.exec(prefix);
  return match?.[1] ?? "";
}

/**
 * Advance past a run of terminators ("?!", "...") and any closing quotes or
 * brackets that belong to the sentence being closed.
 */
function endOfTerminatorRun(text: string, from: number): number {
  let j = from + 1;
  while (j < text.length && ".!?".includes(text[j] ?? "")) j += 1;
  while (j < text.length && CLOSERS.includes(text[j] ?? "")) j += 1;
  return j;
}

/**
 * Is the terminator at `index` a real sentence boundary?
 *
 * Two independent signals, which together handle the awkward cases:
 *
 *  1. **A real sentence boundary is followed by whitespace or nothing.** If the
 *     next character is a letter or digit, the period was part of the word:
 *     "U.S.A", "e.g", "Ph.D", "www.site.com". This is why the initialism cases
 *     cannot be solved by looking only at what comes before the period: at the
 *     period in "U.S." the preceding token is just "U".
 *  2. **Known abbreviations** ("Dr.", "e.g" at the end of a phrase, "vs.") are
 *     followed by a space, so they need their own list. The list is deliberately
 *     short: a wrong entry silently merges two real sentences, which is worse
 *     than splitting one sentence too early.
 */
function isSentenceBoundary(text: string, index: number, nextIndex: number): boolean {
  const terminator = text[index];
  if (terminator !== ".") return true;

  // A decimal point: "3.5", "0.75".
  const before = text[index - 1] ?? "";
  const after = text[index + 1] ?? "";
  if (/\d/.test(before) && /\d/.test(after)) return false;

  // Signal 1: no whitespace after the period means it is part of the word.
  const following = text[nextIndex];
  if (following !== undefined && !/\s/.test(following)) return false;

  // Signal 2: known abbreviation.
  const token = tokenBefore(text, index);
  if (token.includes(".")) return false;
  if (ABBREVIATIONS.has(token.toLowerCase())) return false;

  return true;
}

/**
 * Split normalised text into sentences.
 *
 * A terminator run ("?", "!", "...") optionally followed by closing quotes or
 * brackets ends a sentence, unless the period is part of a word (initialism,
 * decimal, dotted abbreviation). A period mid-string with nothing capitalised
 * after it is still treated as a boundary, because uncapitalised web copy is
 * common and splitting early is the safer error.
 */
export function splitSentences(text: string): string[] {
  const normalised = normalizeText(text);
  if (normalised === "") return [];

  const sentences: string[] = [];
  let start = 0;

  for (let i = 0; i < normalised.length; i += 1) {
    const ch = normalised[i];
    if (ch !== "." && ch !== "!" && ch !== "?") continue;

    const j = endOfTerminatorRun(normalised, i);
    if (!isSentenceBoundary(normalised, i, j)) continue;

    const candidate = normalised.slice(start, j).trim();
    if (candidate !== "") sentences.push(candidate);

    start = j;
    i = j - 1;
  }

  const tail = normalised.slice(start).trim();
  if (tail !== "") sentences.push(tail);

  return sentences;
}

/**
 * The first sentence of the selection, used when the selection is longer than
 * the pop-up's limit (spec 4.1). Falls back to the whole text when there is no
 * sentence boundary.
 */
export function firstSentence(text: string): string {
  const [first] = splitSentences(text);
  return first ?? normalizeText(text);
}

// ---------------------------------------------------------------------------
// Practice target
// ---------------------------------------------------------------------------

export interface ToTargetOptions {
  readonly accent: Accent;
  readonly speed: number;
  /**
   * Raise this instead of `truncated` when the first sentence on its own is
   * still too long to practise comfortably.
   */
  readonly tooLongForPanel?: boolean;
}

/**
 * Build the hand-off payload for the side panel (spec 2: "Selected text,
 * accent and speed must carry over from pop-up to side panel with no
 * re-typing").
 *
 * For an oversized selection we practise the FIRST SENTENCE and flag it, so the
 * pop-up can offer that choice explicitly rather than silently dropping the
 * rest of what the user selected.
 */
export function toPracticeTarget(raw: string, options: ToTargetOptions): PracticeTarget {
  const normalized = normalizeText(raw);

  if (!isOversized(normalized)) {
    return {
      text: normalized,
      kind: classifyText(normalized),
      accent: options.accent,
      speed: options.speed,
    };
  }

  const first = firstSentence(normalized);
  return {
    text: first,
    kind: classifyText(first),
    accent: options.accent,
    speed: options.speed,
    // We took only part of what was selected.
    truncated: true,
  };
}