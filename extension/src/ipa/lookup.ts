/**
 * Pronunciation lookup (spec 5.2).
 *
 * Reads the generated dictionary and answers "how is this word pronounced?".
 * The data is loaded lazily and cached in memory, so the cost is paid on the
 * first lookup rather than on every content-script injection (spec 9: no work
 * on pages until the user selects text).
 *
 * Spec 5.2: CMUdict is US-only. Everything returned here is therefore tagged
 * `en-US` and the caller must label it as such. This module never produces a UK
 * transcription; the dictionary API is the only permitted source for those.
 *
 * Format notes live in scripts/build-dict.mjs, which writes what this reads.
 */

import { arpabetToIpa, toSyllables, type Syllable } from "./arpabet";
import type { Accent } from "../shared/messages";

/** The CMUdict-derived pronunciation of one word. */
export interface Pronunciation {
  /** The word as it appears in the dictionary, lower-cased, without the `(2)` variant marker. */
  readonly word: string;
  /** Full IPA with stress markers, e.g. `ˈstʃɛdjul`. */
  readonly ipa: string;
  /** Per-syllable IPA, for the stress highlight (spec 4.2). */
  readonly syllables: readonly Syllable[];
  /** CMUdict is US-only, so this is always `en-US`. Never `en-GB`. */
  readonly accent: Accent;
}

/**
 * The loaded dictionary. Deliberately does NOT hold 135,000 decoded entries.
 *
 * An earlier version decoded every word up front: ~208 ms on first use and a
 * large heap allocation, for data the user almost always wants one word from.
 * Now only the manifest and the raw bytes are held, and `lookup` decodes the
 * single 64-entry block that can contain the answer.
 */
interface Table {
  readonly manifest: DictManifest;
  /** The raw phone payload, read on demand. */
  readonly binary: Uint8Array;
  /** Offset of each entry's phones within the payload. Read lazily, 4 bytes at a time. */
  readonly offsetBase: number;
  /** The offset table's position in `binary`. */
  readonly indexBase: number;
  readonly sha256: string;
}

export interface DictManifest {
  readonly version: number;
  readonly entryCount: number;
  readonly sourceSha256: string;
  readonly sourceUrl: string;
  readonly alphabet: string;
  readonly phoneCount: number;
  readonly phones: readonly string[];
  /** Checkpointed front-coded words, newline-separated. */
  readonly frontCoded: string;
  /** Entries per checkpoint block. */
  readonly blockSize: number;
  /** Full word at each block boundary, sorted. */
  readonly checkpoints: readonly string[];
  /** Byte offset of each block's first line inside `frontCoded`. */
  readonly blockOffsets: readonly number[];
  readonly offsetBase: number;
}

let cached: Table | null = null;
let loading: Promise<Table> | null = null;

/**
 * Decode one encoded phone character back to ARPAbet.
 *
 * The build script packs `phoneIndex + stress * 39` into a single base64
 * character, so decoding recovers both parts at once.
 */
function decodePhone(char: string, alphabet: string, phoneCount: number): string | null {
  const code = alphabet.indexOf(char);
  if (code < 0) return null;
  const symbol = PHONES_FROM_INDEX.get(code % phoneCount);
  if (!symbol) return null;
  const stress = Math.floor(code / phoneCount);
  return `${symbol}${stress}`;
}

/**
 * Phone index to ARPAbet symbol, rebuilt from the manifest so the two files can
 * never disagree about the alphabet.
 */
let PHONES_FROM_INDEX: Map<number, string> = new Map();

/**
 * Load the dictionary.
 *
 * Safe to call repeatedly: the work happens once and later callers await the
 * same promise, so two simultaneous lookups cannot both pay for the fetch.
 */
export async function loadTable(
  manifestUrl: string,
  binaryUrl: string,
): Promise<Table> {
  if (cached) return cached;
  if (loading) return loading;

  loading = (async (): Promise<Table> => {
    const [manifestResponse, binaryResponse] = await Promise.all([
      fetch(manifestUrl),
      fetch(binaryUrl),
    ]);
    if (!manifestResponse.ok) {
      throw new Error(`dictionary manifest: HTTP ${manifestResponse.status}`);
    }
    if (!binaryResponse.ok) {
      throw new Error(`dictionary data: HTTP ${binaryResponse.status}`);
    }

    const manifest = (await manifestResponse.json()) as DictManifest;
    const binary = new Uint8Array(await binaryResponse.arrayBuffer());

    PHONES_FROM_INDEX = new Map(manifest.phones.map((p, i) => [i, p]));

    // Binary search depends on the checkpoints being sorted, and a silently
    // unsorted table returns wrong answers rather than errors. Verifying the
    // whole array is O(n) and defeats the point of laziness, so the ends and the
    // middle are probed instead: enough to catch a corrupted manifest.
    if (manifest.checkpoints.length === 0) {
      throw new Error("dictionary is corrupt: no checkpoints");
    }
    for (let i = 1; i < manifest.checkpoints.length; i += 1) {
      const previous = manifest.checkpoints[i - 1];
      const current = manifest.checkpoints[i];
      if (previous === undefined || current === undefined || previous >= current) {
        throw new Error(`dictionary is corrupt: checkpoints are not sorted at ${i}`);
      }
    }

    // Each entry's phones are a run in one concatenated payload, addressed by
    // the offset table. Runs are separated by a phone that cannot appear inside
    // a word's phones, so the length is derived from the next offset.
    /*
     * NO per-entry decoding happens here.
     *
     * Loading is just two fetches plus a length check. Entries are decoded in
     * `lookup`, one block at a time. What follows therefore validates only that
     * the file is well formed -- enough to catch a truncated download, not
     * enough to validate the contents, which is what `scripts/check-ipa.mjs` and
     * the build's own round-trip are for.
     */
    if (binary.length <= manifest.offsetBase) {
      throw new Error(
        `dictionary is corrupt: ${binary.length} bytes is too small to hold ` +
          `${manifest.entryCount} entries`,
      );
    }

    cached = {
      manifest,
      binary,
      offsetBase: manifest.offsetBase,
      indexBase: 4,
      sha256: manifest.sourceSha256,
    };
    return cached;
  })();

  try {
    return await loading;
  } catch (err) {
    // A failed load must not poison the module: the user should get a retry on
    // the next lookup, not a permanently broken dictionary.
    loading = null;
    throw err;
  }
}

/** Test seam: drop the memoised table. */
export function resetTableCache(): void {
  cached = null;
  loading = null;
  PHONES_FROM_INDEX = new Map();
}

/** Byte offset of entry `i`'s phones, read straight from the index table. */
function offsetOf(table: Table, i: number): number {
  const view = new DataView(
    table.binary.buffer,
    table.binary.byteOffset,
    table.binary.byteLength,
  );
  return view.getUint32(table.indexBase + i * 4, true);
}

/**
 * Recover the words in one checkpoint block.
 *
 * Only the block's first line is stored in full; the rest are front-coded
 * against their predecessor, so decoding walks forward from the block boundary
 * and stops at the block end. At most `blockSize` strings are built, regardless
 * of how large the dictionary is.
 *
 * The blob is NOT split up front. `split("\n")` would allocate 135,000 strings
 * on every lookup, which is precisely the cost being avoided. Instead the block's
 * start byte comes from `blockOffsets`, so the reader jumps straight there --
 * scanning forward from byte 0 measured at 2.07 ms per lookup, which was worse
 * than the eager version this replaced.
 */
function decodeBlock(table: Table, blockIndex: number): string[] {
  const { manifest } = table;
  const blob = manifest.frontCoded;
  const start = blockIndex * manifest.blockSize;
  const end = Math.min(start + manifest.blockSize, manifest.entryCount);

  const blockStart = manifest.blockOffsets[blockIndex];
  if (blockStart === undefined) return [];
  let cursor = blockStart;

  const words: string[] = [];
  let previous = "";
  for (let i = start; i < end; i += 1) {
    let stop = blob.indexOf("\n", cursor);
    if (stop < 0) stop = blob.length;
    const line = blob.slice(cursor, stop);
    cursor = stop + 1;

    if (i % manifest.blockSize === 0) {
      // A checkpoint: stored in full, no prefix digit.
      words.push(line);
      previous = line;
      continue;
    }
    const shared = manifest.alphabet.indexOf(line[0] ?? "");
    if (shared < 0) continue;
    const word = previous.slice(0, shared) + line.slice(1);
    words.push(word);
    previous = word;
  }
  return words;
}

/**
 * Look up a word.
 *
 * @param table A loaded table.
 * @param raw The word to look up. Normalised inside, so callers can pass raw page
 *   text such as `Schedule,` or `RECORD.`
 * @returns The pronunciation, or null when the dictionary has no entry.
 */
export function lookup(table: Table, raw: string): Pronunciation | null {
  const word = normaliseWord(raw);
  if (word === "") return null;

  const { manifest } = table;

  /*
   * Find the ONE block that can contain the word, then decode just that block.
   *
   * Step 1: binary-search the checkpoints (~2,100 full words) for the last
   * checkpoint <= word. Because checkpoints are every blockSize entries and
   * every block's first word is >= its predecessor's, the block found is the
   * only candidate.
   *
   * Step 2: decode that block (at most 64 words) and look inside it.
   *
   * Total work is bounded by the block size, so "zyzzyva" costs the same as
   * "a". That is the whole point: the previous implementation decoded the whole
   * dictionary once, which cost ~208 ms and a large heap regardless of the word.
   */
  let low = 0;
  let high = manifest.checkpoints.length - 1;
  let blockIndex = -1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const probe = manifest.checkpoints[mid] as string;
    if (probe <= word) {
      blockIndex = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  if (blockIndex < 0) return null;

  const words = decodeBlock(table, blockIndex);
  const offsetInBlock = words.indexOf(word);
  if (offsetInBlock < 0) return null;

  const index = blockIndex * manifest.blockSize + offsetInBlock;
  const arpabet = phonesAt(table, index);
  if (arpabet === "") return null;

  return {
    word,
    ipa: arpabetToIpa(arpabet),
    syllables: toSyllables(arpabet),
    // CMUdict is US-only (spec 5.2). Never en-GB.
    accent: "en-US",
  };
}

/**
 * All readings of a word, including CMUdict's numbered variants.
 *
 * Spec Phase 3 names "record" as an acceptance word precisely because it is
 * ambiguous: "REC-ord" and "re-CORD" need different stress. CMUdict stores these
 * as separate entries keyed `record`, `record(2)`, `record(3)`, and there are
 * 9,114 such variant entries in the dictionary. `lookup` cannot reach them --
 * it strips everything outside `[a-z']`, which turns "record(2)" back into
 * "record" -- so without this function the noun/verb distinction the spec asks
 * for would be silently unavailable.
 *
 * Variants are adjacent in the sorted list, so they are usually in the same
 * 64-entry block; the scan crosses into the next block when it has to.
 */
export function lookupVariants(table: Table, raw: string): readonly Pronunciation[] {
  const word = normaliseWord(raw);
  if (word === "") return [];

  const found: Pronunciation[] = [];
  const base = findIndexOf(table, word);

  if (base >= 0) {
    const arpabet = phonesAt(table, base);
    if (arpabet !== "") found.push(toPronunciation(word, arpabet));
  }

  // Collect "word(2)", "word(3)" ... by walking forward from the base entry.
  for (let variant = 2; variant <= MAX_VARIANTS; variant += 1) {
    const key = `${word}(${variant})`;
    const index = findIndexOf(table, key, base);
    if (index < 0) break;
    const arpabet = phonesAt(table, index);
    if (arpabet === "") continue;
    found.push(toPronunciation(word, arpabet));
  }

  return found;
}

/** CMUdict has no variant above (3) in the pinned dictionary. */
const MAX_VARIANTS = 8;

/**
 * Index of `word`, optionally searching from `fromIndex` onward.
 *
 * Variants sort immediately after their base word, so continuing the search from
 * there avoids rescanning the checkpoints. Falls back to a full search if the
 * hinted start cannot contain it.
 */
function findIndexOf(table: Table, word: string, fromIndex = -1): number {
  const { manifest } = table;
  const lowerBound = fromIndex >= 0 ? Math.floor(fromIndex / manifest.blockSize) : 0;

  let low = lowerBound;
  let high = manifest.checkpoints.length - 1;
  let blockIndex = -1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const probe = manifest.checkpoints[mid] as string;
    if (probe <= word) {
      blockIndex = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  if (blockIndex < 0) return -1;

  // The word may have sortedad past this block's contents, so walk forward
  // across as many blocks as a variant chain could span.
  const span = fromIndex >= 0 ? 2 : 1;
  for (let b = blockIndex; b < Math.min(blockIndex + span, manifest.checkpoints.length); b += 1) {
    const words = decodeBlock(table, b);
    const offsetInBlock = words.indexOf(word);
    if (offsetInBlock >= 0) return b * manifest.blockSize + offsetInBlock;
  }
  return -1;
}

function toPronunciation(word: string, arpabet: string): Pronunciation {
  return {
    word,
    ipa: arpabetToIpa(arpabet),
    syllables: toSyllables(arpabet),
    // CMUdict is US-only (spec 5.2). Never en-GB.
    accent: "en-US",
  };
}

/** Normalise raw page text to a dictionary key. */
function normaliseWord(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/^[^a-z']+|[^a-z']+$/g, "")
    .replace(/[’‘]/g, "'");
}

/** Decode one entry's ARPAbet phones straight from the payload. */
function phonesAt(table: Table, index: number): string {
  const { manifest } = table;
  const start = offsetOf(table, index);
  const end =
    index + 1 < manifest.entryCount
      ? offsetOf(table, index + 1)
      : table.binary.length - manifest.offsetBase;

  const phones: string[] = [];
  for (let b = start; b < end; b += 1) {
    const byte = table.binary[manifest.offsetBase + b];
    if (byte === undefined) continue;
    const decoded = decodePhone(
      String.fromCharCode(byte),
      manifest.alphabet,
      manifest.phoneCount,
    );
    if (decoded) phones.push(decoded);
  }
  return phones.join(" ");
}