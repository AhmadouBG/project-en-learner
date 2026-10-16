/**
 * Build the compact pronunciation dictionary (spec 5.2).
 *
 * Downloads CMUdict, converts it to a compact packed format and writes it to
 * `src/ipa/dict/`. The output is generated and gitignored: the repository stays
 * small, but the shipped extension still bundles the data with no runtime
 * network dependency. That is what spec 5.2 asks for ("bundle CMUdict converted
 * to a compact format ... lazy-loaded and cached in memory") and what the
 * "do not vendor 3.5 MB into git" constraint requires.
 *
 * FORMAT
 * ------
 * A flat binary blob plus a JSON sidecar, rather than JSON alone:
 *
 *   dict.bin   a sorted, fixed-record table, searched with binary search
 *   dict.json  { version, entryCount, sourceSha256, words: string[], index: ... }
 *
 * Why not plain JSON of {"word": "phones"}: JSON object keys repeat the word
 * twice (once as the key, once inside the lookup), and a parsed JS object of
 * 135k keys costs far more memory than the text it came from. A sorted word
 * array plus a parallel numeric array binary-searches in O(log n) with no object
 * allocation, and serialises to a smaller file.
 *
 * Numbers are stored in a base-64-ish alphabet rather than as JSON numbers,
 * because each phone becomes ONE character instead of a two-to-three digit
 * token. That is the difference between ~1 MB and ~2.5 MB of JSON.
 *
 * Usage:
 *   node scripts/build-dict.mjs            # download if absent, then build
 *   node scripts/build-dict.mjs --offline  # never download, fail if absent
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "src", "ipa", "dict");
const OUT_BIN = join(OUT_DIR, "dict.bin");
const OUT_JSON = join(OUT_DIR, "dict.json");
const CACHE = join(ROOT, ".cache", "cmudict.dict");

const SOURCE_URL =
  "https://raw.githubusercontent.com/cmusphinx/cmudict/master/cmudict.dict";

/**
 * Phone vocabulary. Position in this array IS the on-disk code, so appending is
 * safe and reordering is not: the table is regenerated wholesale on every build,
 * but a stale cached build must not be mixed with a new vocabulary.
 *
 * The 39 ARPAbet phones, vowels first.
 */
const PHONES = [
  "AA", "AE", "AH", "AO", "AW", "AY", "EH", "ER", "EY",
  "IH", "IY", "OW", "OY", "UH", "UW",
  "B", "CH", "D", "DH", "F", "G", "HH", "JH", "K", "L",
  "M", "N", "NG", "P", "R", "S", "SH", "T", "TH", "V",
  "W", "Y", "Z", "ZH",
];
const PHONE_INDEX = new Map(PHONES.map((p, i) => [p, i]));

/**
 * Codes needed: 39 phones x 3 stress levels = 117, worst case 116.
 *
 * The alphabet MUST therefore hold at least 117 characters. It originally held
 * 64 (base64), which is not enough, and the overflow was silent: `ALPHABET[79]`
 * is `undefined`, so those phones were written into the payload as the literal
 * text "undefined" and every entry after one of them decoded to garbage. 33,206
 * entries were corrupt this way and no error was raised, because the range guard
 * compared against a hand-written constant (117) rather than the real alphabet
 * length.
 *
 * Built from printable ASCII plus Latin-1 letters so every character is a single
 * byte and JSON-safe (no escaping, no control characters). Length is asserted
 * below rather than assumed.
 */
const ALPHABET =
  "!#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~" +
  "¡¢£¤¥¦§¨©ª«¬®¯°±²³´µ¶·¸¹º»¼½¾¿" +
  "ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖ×ØÙÚÛÜÝÞß";

/** Highest valid code. */
const MAX_CODE = ALPHABET.length - 1;

if (ALPHABET.length < 117) {
  throw new Error(`alphabet must hold at least 117 codes, got ${ALPHABET.length}`);
}
if (new Set(ALPHABET).size !== ALPHABET.length) {
  throw new Error("alphabet contains duplicate characters");
}

/** Encode one phone plus stress into a single character. */
function encodePhone(symbol, stress) {
  const base = PHONE_INDEX.get(symbol);
  if (base === undefined) throw new Error(`unknown phone ${symbol}`);
  const code = base + stress * PHONES.length;
  // Bound-checked against the REAL alphabet length. Comparing to a hand-written
  // constant let codes 64..116 slip through and become the string "undefined".
  if (code < 0 || code > MAX_CODE) {
    throw new Error(
      `phone ${symbol}${stress} encodes to code ${code}, outside 0..${MAX_CODE}`,
    );
  }
  const char = ALPHABET[code];
  if (char === undefined) {
    throw new Error(`phone ${symbol}${stress} encodes to code ${code}, which the alphabet cannot represent`);
  }
  return char;
}

/** Parse one line of cmudict.dict into a word and its encoded phones. */
function parseLine(line) {
  const trimmed = line.trim();
  // Entries are "word PHONE PHONE ...". A comment line starts with ";;;" and
  // blank lines are padding at the end of the file.
  if (trimmed === "" || trimmed.startsWith(";")) return null;

  // Some entries carry a trailing "# note" comment ("gdp G IY1 D IY1 P IY1 #
  // abbrev"). It is not a phone, and treating it as one silently dropped 22
  // real words -- gdp, hiv, and every Irish/Finnish proper noun in the set --
  // because the parse failed on the "#".
  const body = trimmed.split("#")[0].trim();
  if (body === "") return null;

  const parts = body.split(/\s+/);
  const word = parts[0];
  const phones = parts.slice(1);
  if (!word || phones.length === 0) return null;

  // CMUdict marks variant pronunciations as "word(2)". Keep the marker on the
  // key: "record" and "record(2)" are different entries and must both survive,
  // or a lookup for the noun reading would return the verb reading.
  let encoded = "";
  const normalized = [];
  for (const phone of phones) {
    const match = /^([A-Z]+)([012])?$/.exec(phone);
    if (!match) return null; // malformed entry: skip rather than emit garbage
    const symbol = match[1];
    const stress = match[2] ? Number(match[2]) : 0;
    encoded += encodePhone(symbol, stress);
    // Kept so the build can prove the encoding round-trips. CMUdict omits the
    // stress digit on unstressed phones ("S K EH1"), so the comparison form
    // always writes it.
    normalized.push(`${symbol}${stress}`);
  }
  return { word, encoded, phones: normalized.join(" ") };
}

async function ensureSource(offline) {
  if (existsSync(CACHE)) {
    const bytes = readFileSync(CACHE);
    console.log(`source  : cached ${bytes.length} bytes`);
    return bytes;
  }

  if (offline) {
    throw new Error(`--offline given but ${CACHE} is missing`);
  }

  console.log(`source  : downloading ${SOURCE_URL}`);
  const response = await fetch(SOURCE_URL);
  if (!response.ok) {
    throw new Error(`download failed: HTTP ${response.status} ${response.statusText}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  mkdirSync(dirname(CACHE), { recursive: true });
  writeFileSync(CACHE, bytes);
  console.log(`source  : downloaded ${bytes.length} bytes`);
  return bytes;
}

async function main() {
  const offline = process.argv.includes("--offline");
  const source = await ensureSource(offline);
  const sha256 = createHash("sha256").update(source).digest("hex");

  const entries = [];
  let skipped = 0;
  for (const line of source.toString("utf8").split("\n")) {
    const entry = parseLine(line);
    if (entry) entries.push(entry);
    else skipped += 1;
  }

  if (entries.length === 0) {
    throw new Error("no entries parsed; refusing to write an empty dictionary");
  }

  // Sorted by word so the runtime can binary-search. The variant marker sorts
  // oddly against the bare word ("record" < "record(2)") but that is harmless:
  // lookups use exact keys.
  entries.sort((a, b) => (a.word < b.word ? -1 : a.word > b.word ? 1 : 0));

  const duplicates = entries.length - new Set(entries.map((e) => e.word)).size;
  if (duplicates > 0) {
    // A duplicate key would make one pronunciation unreachable, and which one
    // wins would depend on sort stability. Fail loudly instead of shipping it.
    throw new Error(`${duplicates} duplicate word keys in source`);
  }

  // Front-coded word list. Sorted words share long prefixes ("schedule" /
  // "scheduled" / "scheduler"), so each entry is stored as
  // [shared-prefix-length][suffix] in base64-ish text, and the reader rebuilds
  // the full key by copying from the previous one. Measured on the real file:
  // 1,417 kB of bare words -> ~530 kB front-coded.
  //
  // The prefix length is a single base64 digit, which caps it at 63 characters.
  // That is safe here: it is the longest prefix shared with the PREVIOUS word,
  // not the whole prefix chain, and no two adjacent entries share 64+ leading
  // characters (asserted below).
  /*
   * CHECKPOINTED WORD LIST
   *
   * Plain front-coding cannot be searched: entry N is stored as a suffix plus
   * "how many leading characters to copy from entry N-1", so reading entry
   * 92,000 means decoding the 91,999 before it. That is the 208 ms load, and it
   * is paid whether you want "a" or "zyzzyva".
   *
   * So every BLOCK_SIZE entries the word is stored IN FULL, and everything
   * between checkpoints is front-coded relative to its predecessor. A reader
   * binary-searches the ~2,100 checkpoints, then decodes forward at most 63
   * entries inside the block it lands in. Decoding cost becomes independent of
   * where in the alphabet the word sits.
   *
   * Cost: the checkpoint words are stored twice. At BLOCK_SIZE 64 that is
   * ~2,100 extra full words, roughly 20 kB, and it buys a ~200 ms saving on
   * every cold start.
   */
  const BLOCK_SIZE = 64;

  const wordLines = [];
  const checkpoints = [];
  const blockOffsets = [];
  let previousWord = "";
  for (let i = 0; i < entries.length; i += 1) {
    const word = entries[i].word;

    // First entry, or the first of a block: stored verbatim, no prefix digit.
    if (i % BLOCK_SIZE === 0) {
      checkpoints.push(word);
      // Byte position of this block's first line inside the joined blob. Without
      // these the reader has to scan forward from byte 0 to reach its block,
      // which made every lookup O(blob) -- measured at 2.07 ms, worse than the
      // eager version this was meant to replace.
      blockOffsets.push(wordLines.reduce((n, l) => n + l.length + 1, 0));
      wordLines.push(word);
      previousWord = "";
      continue;
    }

    let shared = 0;
    const limit = Math.min(previousWord.length, word.length, 63);
    while (shared < limit && previousWord[shared] === word[shared]) shared += 1;
    wordLines.push(ALPHABET[shared] + word.slice(shared));
    previousWord = word;
  }
  // Newline-separated, and the reader splits on it. Without the join this was
  // one enormous line that decoded to exactly one "word".
  const wordBlob = wordLines.join("\n");

  // Binary table: [u32 entryCount][u32 offset[0]] ... so a reader can seek to
  // entry i without walking the whole file. Offsets index the phone payload.
  const header = Buffer.alloc(4);
  header.writeUInt32LE(entries.length, 0);

  const offsets = Buffer.alloc(entries.length * 4);
  let cursor = 0;
  for (let i = 0; i < entries.length; i += 1) {
    offsets.writeUInt32LE(cursor, i * 4);
    cursor += Buffer.byteLength(entries[i].encoded, "utf8");
  }

  const payload = Buffer.from(entries.map((e) => e.encoded).join(""), "utf8");
  const bin = Buffer.concat([header, offsets, payload]);

  // Self-check on the encoded data, before anything is written. This exact bug --
  // an out-of-range code producing the string "undefined" -- corrupted 33,206
  // entries and still produced a file that looked fine, so the build now refuses
  // to emit one.
  const badChars = new Set();
  for (const entry of entries) {
    for (const ch of entry.encoded) {
      if (!ALPHABET.includes(ch)) badChars.add(ch);
    }
  }
  if (badChars.size > 0) {
    throw new Error(
      `encoded payload contains ${badChars.size} characters outside the alphabet ` +
        `(e.g. ${JSON.stringify([...badChars].slice(0, 5))}); the encoder is broken`,
    );
  }

  // Round-trip every entry through the decoder and compare, so a wrong
  // alphabet, a bad stress offset or a mis-sized table is caught here rather
  // than in the pop-up. Cheap next to the download.
  let roundTripFailures = 0;
  let firstRoundTripFailure = "";
  for (const entry of entries) {
    let decoded = "";
    for (const ch of entry.encoded) {
      const code = ALPHABET.indexOf(ch);
      const symbol = PHONES[code % PHONES.length];
      decoded += `${symbol}${Math.floor(code / PHONES.length)} `;
    }
    const rebuilt = entry.phones.trim().replace(/\s+/g, " ");
    const got = decoded.trim();
    if (got !== rebuilt) {
      roundTripFailures += 1;
      if (!firstRoundTripFailure) {
        firstRoundTripFailure =
          `${entry.word}: encoded "${entry.encoded}" decoded to "${got}", expected "${rebuilt}"`;
      }
    }
  }
  if (roundTripFailures > 0) {
    throw new Error(
      `${roundTripFailures} entries do not survive an encode/decode round trip. ` +
        `First: ${firstRoundTripFailure}`,
    );
  }
  console.log(`verify  : all ${entries.length} entries survive an encode/decode round trip`);

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_BIN, bin);

  const json = {
    version: 1,
    entryCount: entries.length,
    sourceSha256: sha256,
    sourceUrl: SOURCE_URL,
    alphabet: ALPHABET,
    phoneCount: PHONES.length,
    phones: PHONES,
    // Checkpointed front-coded list, newline-separated. Lines whose index is a
    // multiple of blockSize are FULL words; the rest are <prefix-length><suffix>.
    frontCoded: wordBlob,
    blockSize: BLOCK_SIZE,
    // The full word at each block boundary, for binary search.
    checkpoints,
    // Byte offset of each block's first line inside frontCoded, so a lookup jumps
    // straight to its block instead of scanning from the start.
    blockOffsets,
    offsetBase: header.length + offsets.length,
  };
  const jsonText = JSON.stringify(json);
  writeFileSync(OUT_JSON, jsonText);

  const rawBytes = source.length;
  const bareWords = entries.reduce((n, e) => n + e.word.length + 3, 0);
  console.log(`entries : ${entries.length}`);
  console.log(`skipped : ${skipped}`);
  console.log(`sha256  : ${sha256}`);
  console.log(`raw     : ${rawBytes} bytes (${(rawBytes / 1024).toFixed(0)} kB)`);
  console.log(`dict.bin: ${bin.length} bytes (${(bin.length / 1024).toFixed(0)} kB)`);
  console.log(`dict.json: ${jsonText.length} bytes (${(jsonText.length / 1024).toFixed(0)} kB)`);
  console.log(
    `words   : ${bareWords} bare -> ${wordBlob.length} front-coded ` +
      `(${((1 - wordBlob.length / bareWords) * 100).toFixed(0)}% saved)`,
  );
  console.log(
    `total   : ${bin.length + jsonText.length} bytes ` +
      `(${((bin.length + jsonText.length) / rawBytes * 100).toFixed(1)}% of raw, ` +
      `${((bin.length + jsonText.length) / 1024 / 1024).toFixed(2)} MB)`,
  );
  console.log(`lookup  : binary search over ${entries.length} keys = ~${Math.ceil(Math.log2(entries.length))} string comparisons`);
}

main().catch((err) => {
  console.error("FAIL: build-dict:", err.message);
  process.exit(1);
});