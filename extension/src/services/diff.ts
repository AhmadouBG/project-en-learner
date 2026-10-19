/**
 * Word-level comparison of what the learner said against the target text
 * (spec 5.6).
 *
 * This is deliberately NOT a pronunciation score. It answers one question:
 * which words did the recogniser hear? A substitution is shown as such, but it
 * may be an accent difference, a recognition mistake, or a genuinely different
 * word; the UI says so next to the result.
 *
 * Pure and DOM-free so the alignment is unit-tested (spec 9).
 */

export type WordStatus = "matched" | "substituted" | "missing" | "extra";

export interface DiffWord {
  /** The word to display: the target word, or the heard word for an extra. */
  readonly word: string;
  readonly status: WordStatus;
  /** What the recogniser heard, when it differs from the target. */
  readonly heard?: string;
}

export interface WordDiff {
  readonly words: readonly DiffWord[];
  /** Matching target words. */
  readonly matched: number;
  /** Number of words in the target. */
  readonly total: number;
  /** The normalised transcript, for the result block. */
  readonly transcript: string;
}

/** Words, numbers, and internal apostrophes/hyphens. */
const WORD_PATTERN = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;

/**
 * Common contractions, expanded identically on both sides.
 *
 * Recognition engines often return "do not" for "don't" (or vice versa), and a
 * learner may type either. Expanding the handful of forms below removes a whole
 * class of false mismatches without pretending to be a full tokeniser.
 */
const CONTRACTIONS: Readonly<Record<string, readonly string[]>> = {
  "can't": ["can", "not"],
  "cannot": ["can", "not"],
  "won't": ["will", "not"],
  "shan't": ["shall", "not"],
  "i'm": ["i", "am"],
  "i've": ["i", "have"],
  "i'll": ["i", "will"],
  "i'd": ["i", "would"],
  "you're": ["you", "are"],
  "you've": ["you", "have"],
  "you'll": ["you", "will"],
  "you'd": ["you", "would"],
  "he's": ["he", "is"],
  "she's": ["she", "is"],
  "it's": ["it", "is"],
  "we're": ["we", "are"],
  "we've": ["we", "have"],
  "we'll": ["we", "will"],
  "we'd": ["we", "would"],
  "they're": ["they", "are"],
  "they've": ["they", "have"],
  "they'll": ["they", "will"],
  "they'd": ["they", "would"],
  "isn't": ["is", "not"],
  "aren't": ["are", "not"],
  "wasn't": ["was", "not"],
  "weren't": ["were", "not"],
  "don't": ["do", "not"],
  "doesn't": ["does", "not"],
  "didn't": ["did", "not"],
  "haven't": ["have", "not"],
  "hasn't": ["has", "not"],
  "hadn't": ["had", "not"],
  "wouldn't": ["would", "not"],
  "shouldn't": ["should", "not"],
  "couldn't": ["could", "not"],
  "mustn't": ["must", "not"],
  "let's": ["let", "us"],
};

/** Lowercase, straighten apostrophes, and remove anything but word tokens. */
export function normaliseWords(text: string): string[] {
  const words: string[] = [];
  for (const match of text.toLowerCase().matchAll(WORD_PATTERN)) {
    const raw = match[0].replace(/’/g, "'");
    const expansion = CONTRACTIONS[raw];
    if (expansion) words.push(...expansion);
    else words.push(raw);
  }
  return words;
}

function displayWords(text: string): string[] {
  return Array.from(text.matchAll(WORD_PATTERN), (match) => match[0]);
}

/**
 * Align two token lists with Levenshtein distance.
 *
 * Backtracking prefers a diagonal match/substitution over delete+insert, then a
 * deletion (missing target word), which keeps the output in reading order. Ties
 * can differ from another implementation without changing the counts that
 * matter (matched / total).
 */
export function diffWords(target: string, heard: string): WordDiff {
  const expected = normaliseWords(target);
  const actual = normaliseWords(heard);

  const rows = expected.length + 1;
  const cols = actual.length + 1;
  // One flat array is smaller and faster than an array of arrays for the
  // sentence lengths we support.
  const cost = new Uint16Array(rows * cols);
  const at = (row: number, col: number): number => row * cols + col;

  for (let row = 0; row < rows; row += 1) cost[at(row, 0)] = row;
  for (let col = 0; col < cols; col += 1) cost[at(0, col)] = col;

  for (let row = 1; row < rows; row += 1) {
    for (let col = 1; col < cols; col += 1) {
      const same = expected[row - 1] === actual[col - 1];
      const diagonal = (cost[at(row - 1, col - 1)] ?? 0) + (same ? 0 : 1);
      const deletion = (cost[at(row - 1, col)] ?? 0) + 1;
      const insertion = (cost[at(row, col - 1)] ?? 0) + 1;
      cost[at(row, col)] = Math.min(diagonal, deletion, insertion);
    }
  }

  // Walk backwards, then reverse. Each step records the target word when there
  // is one, and an extra word when the recogniser inserted something.
  const backwards: DiffWord[] = [];
  let row = expected.length;
  let col = actual.length;

  while (row > 0 || col > 0) {
    const expectedWord = row > 0 ? (expected[row - 1] ?? "") : "";
    const actualWord = col > 0 ? (actual[col - 1] ?? "") : "";

    if (row > 0 && col > 0) {
      const same = expectedWord === actualWord;
      const diagonal = (cost[at(row - 1, col - 1)] ?? 0) + (same ? 0 : 1);
      if (cost[at(row, col)] === diagonal) {
        backwards.push(
          same
            ? { word: expectedWord, status: "matched" }
            : { word: expectedWord, status: "substituted", heard: actualWord },
        );
        row -= 1;
        col -= 1;
        continue;
      }
    }

    if (row > 0 && cost[at(row, col)] === (cost[at(row - 1, col)] ?? 0) + 1) {
      backwards.push({ word: expectedWord, status: "missing" });
      row -= 1;
      continue;
    }

    if (col > 0) {
      backwards.push({ word: actualWord, status: "extra", heard: actualWord });
      col -= 1;
      continue;
    }

    // Defensive: a malformed matrix should not hang the UI.
    break;
  }

  backwards.reverse();
  const matched = backwards.filter((word) => word.status === "matched").length;

  return {
    words: backwards,
    matched,
    total: expected.length,
    transcript: displayWords(heard).join(" "),
  };
}
