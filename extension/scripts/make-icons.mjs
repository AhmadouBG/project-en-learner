/**
 * Generate the extension icons from a single SVG source, so the set is
 * consistent and reproducible. Uses only Node built-ins.
 *
 * The mark reuses the previous project's visual language: the green
 * #4caf50 rounded square with a white sound-wave / "listen" bar motif.
 *
 * Run: node scripts/make-icons.mjs
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "icon");
const SIZES = [16, 32, 48, 128];

const GREEN = [0x4c, 0xaf, 0x50];

/** 8x8-bit alpha mask for a circle, used to round the corners. */
/**
 * Alpha mask for a rounded square. A pixel is inside when its distance to the
 * nearest corner point is within the corner radius.
 */
function roundedMask(size, radius) {
  const mask = new Uint8Array(size * size);
  const last = size - 1;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const cx = x < radius ? radius - x : x > last - radius ? x - (last - radius) : 0;
      const cy = y < radius ? radius - y : y > last - radius ? y - (last - radius) : 0;
      mask[y * size + x] = cx === 0 && cy === 0 ? 1 : Math.hypot(cx, cy) <= radius ? 1 : 0;
    }
  }
  return mask;
}

/**
 * Four vertical bars, centred, like an audio level meter.
 * The group is bounded to 62% of the icon width and 50% of the height so the
 * green surround and the rounded corners always stay visible.
 */
function barAlpha(size) {
  const bars = 4;
  // A level-meter rhythm that reads clearly even at 16px: short, mid, tall, mid.
  const heights = [0.45, 0.72, 1, 0.6];
  const gap = Math.max(1, Math.round(size * 0.08));
  const barW = Math.max(1, Math.floor((size * 0.56 - gap * (bars - 1)) / bars));
  const groupH = Math.round(size * 0.46);
  const groupW = barW * bars + gap * (bars - 1);
  const startX = Math.round((size - groupW) / 2);
  const startY = Math.round((size - groupH) / 2);

  const alpha = new Uint8Array(size * size);
  for (let i = 0; i < bars; i += 1) {
    const h = Math.round(groupH * (heights[i] ?? 0.5));
    const x0 = startX + i * (barW + gap);
    const y0 = startY + Math.round((groupH - h) / 2);
    for (let y = y0; y < y0 + h; y += 1) {
      for (let x = x0; x < x0 + barW; x += 1) {
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        alpha[y * size + x] = 1;
      }
    }
  }
  return alpha;
}

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n += 1) {
    c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const byte of buf) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(size) {
  const mask = roundedMask(size, Math.max(2, Math.round(size * 0.22)));
  const bars = barAlpha(size);

  // Raw scanlines: filter byte 0 + RGBA per pixel.
  const raw = Buffer.alloc(size * (1 + size * 4));
  let p = 0;
  for (let y = 0; y < size; y += 1) {
    raw[p++] = 0;
    for (let x = 0; x < size; x += 1) {
      const i = y * size + x;
      const bg = mask[i] === 1 ? 1 : 0;
      const bar = bars[i] === 1 ? 1 : 0;
      // Bar colour white; background brand green; outside fully transparent.
      const [r, g, b] = bar === 1 ? [255, 255, 255] : GREEN;
      raw[p++] = r;
      raw[p++] = g;
      raw[p++] = b;
      raw[p++] = bar === 1 ? 255 : Math.round(255 * bg);
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const png = encodePng(size);
  writeFileSync(join(OUT_DIR, `${size}.png`), png);
  console.log(`icon/${size}.png  ${png.length} bytes`);
}