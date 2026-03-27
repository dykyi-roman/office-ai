#!/usr/bin/env node
/**
 * Generates placeholder PNG icons for the Chrome extension.
 * Uses raw PNG binary encoding — no external dependencies required.
 *
 * Output:
 *   icons/icon-48.png  — 48x48 px
 *   icons/icon-128.png — 128x128 px
 *
 * Design: Dark background (#0a0a14) with an isometric building silhouette
 * and accent color (#4fc3f7) to match the app theme.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const OUT_DIR = path.dirname(__filename);

// ============================================================================
// Minimal PNG encoder (no external deps)
// ============================================================================

/**
 * Computes CRC-32 for a Buffer.
 * @param {Buffer} data
 * @returns {number}
 */
function crc32(data) {
  const table = crc32.table || (crc32.table = buildCrcTable());
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = (crc >>> 8) ^ table[(crc ^ byte) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildCrcTable() {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    t[n] = c;
  }
  return t;
}

/**
 * Builds a PNG chunk.
 * @param {string} type  4-char chunk type
 * @param {Buffer} data  chunk data
 * @returns {Buffer}
 */
function buildChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const lengthBuffer = Buffer.alloc(4);
  lengthBuffer.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuffer, data]);
  const crcBuffer = Buffer.alloc(4);
  crcBuffer.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lengthBuffer, typeBuffer, data, crcBuffer]);
}

/**
 * Encodes an RGBA pixel array as a valid PNG file.
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array} pixels  RGBA, row-major, width*height*4 bytes
 * @returns {Buffer}
 */
function encodePNG(width, height, pixels) {
  // PNG signature
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR chunk
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // color type: RGB (no alpha to keep it simple, but we use RGBA = 6)
  ihdr[9] = 6;  // RGBA
  ihdr[10] = 0; // compression method
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // interlace method
  const ihdrChunk = buildChunk("IHDR", ihdr);

  // IDAT: apply filter (None = 0) to each scanline, then zlib-deflate
  const scanlineLen = 1 + width * 4; // 1 filter byte + RGBA per pixel
  const rawData = Buffer.alloc(height * scanlineLen);
  for (let y = 0; y < height; y++) {
    rawData[y * scanlineLen] = 0; // filter type: None
    for (let x = 0; x < width; x++) {
      const px = (y * width + x) * 4;
      const out = y * scanlineLen + 1 + x * 4;
      rawData[out]     = pixels[px];     // R
      rawData[out + 1] = pixels[px + 1]; // G
      rawData[out + 2] = pixels[px + 2]; // B
      rawData[out + 3] = pixels[px + 3]; // A
    }
  }
  const compressed = zlib.deflateSync(rawData, { level: 9 });
  const idatChunk = buildChunk("IDAT", compressed);

  // IEND chunk
  const iendChunk = buildChunk("IEND", Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

// ============================================================================
// Icon drawing
// ============================================================================

/**
 * Draws a placeholder icon with the OfficeAI branding.
 * Design: dark background, centered "AO" text in accent color.
 *
 * @param {number} size
 * @returns {Uint8Array} RGBA pixel data
 */
function drawIcon(size) {
  const pixels = new Uint8Array(size * size * 4);

  // Background color #0a0a14 = RGB(10, 10, 20)
  const bgR = 10, bgG = 10, bgB = 20, bgA = 255;
  // Accent color #4fc3f7 = RGB(79, 195, 247)
  const acR = 79, acG = 195, acB = 247, acA = 255;
  // Secondary #1a1a2e = RGB(26, 26, 46)
  const secR = 26, secG = 26, secB = 46, secA = 255;

  // Fill background
  for (let i = 0; i < size * size; i++) {
    pixels[i * 4]     = bgR;
    pixels[i * 4 + 1] = bgG;
    pixels[i * 4 + 2] = bgB;
    pixels[i * 4 + 3] = bgA;
  }

  /**
   * Sets a pixel (clamps to bounds).
   * @param {number} x
   * @param {number} y
   * @param {number} r
   * @param {number} g
   * @param {number} b
   * @param {number} a
   */
  function setPixel(x, y, r, g, b, a) {
    const xi = Math.round(x), yi = Math.round(y);
    if (xi < 0 || xi >= size || yi < 0 || yi >= size) return;
    const i = (yi * size + xi) * 4;
    pixels[i]     = r;
    pixels[i + 1] = g;
    pixels[i + 2] = b;
    pixels[i + 3] = a;
  }

  /**
   * Fills a rectangle.
   */
  function fillRect(x0, y0, w, h, r, g, b, a) {
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        setPixel(x0 + dx, y0 + dy, r, g, b, a);
      }
    }
  }

  /**
   * Draws a circle outline.
   */
  function fillCircle(cx, cy, radius, r, g, b, a) {
    const r2 = radius * radius;
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (dx * dx + dy * dy <= r2) {
          setPixel(cx + dx, cy + dy, r, g, b, a);
        }
      }
    }
  }

  const s = size;
  const p = Math.round(s * 0.1); // padding
  const mid = Math.round(s / 2);

  // Draw rounded background panel
  const panelInset = Math.round(s * 0.08);
  fillRect(panelInset, panelInset, s - panelInset * 2, s - panelInset * 2, secR, secG, secB, secA);

  // Isometric building silhouette (simplified pixel art)
  // Draw 3 rectangles representing building floors
  const bw = Math.round(s * 0.50); // building width
  const bh = Math.round(s * 0.55); // building height
  const bx = Math.round((s - bw) / 2);
  const by = Math.round(s * 0.25);

  // Main building body
  fillRect(bx, by, bw, bh, acR, acG, acB, acA);

  // Darker inner area to give depth
  const innerP = Math.round(s * 0.04);
  fillRect(bx + innerP, by + innerP, bw - innerP * 2, bh - innerP * 2, bgR, bgG, bgB, 200);

  // Draw 3x3 grid of window dots inside the building
  const windowCount = 3;
  const windowSpacingX = Math.round(bw / (windowCount + 1));
  const windowSpacingY = Math.round(bh / (windowCount + 1));
  const windowSize = Math.max(1, Math.round(s * 0.04));

  for (let wy = 1; wy <= windowCount; wy++) {
    for (let wx = 1; wx <= windowCount; wx++) {
      const winX = bx + wx * windowSpacingX;
      const winY = by + wy * windowSpacingY;
      fillCircle(winX, winY, windowSize, acR, acG, acB, acA);
    }
  }

  // Accent dot in top-right corner (status indicator design element)
  const dotRadius = Math.max(2, Math.round(s * 0.07));
  const dotX = s - p - dotRadius;
  const dotY = p + dotRadius;
  fillCircle(dotX, dotY, dotRadius, 129, 199, 132, 255); // green dot

  return pixels;
}

// ============================================================================
// Generate icons
// ============================================================================

for (const size of [48, 128]) {
  const pixels = drawIcon(size);
  const png = encodePNG(size, size, pixels);
  const outPath = path.join(OUT_DIR, `icon-${size}.png`);
  fs.writeFileSync(outPath, png);
  console.log(`Generated: ${outPath} (${png.length} bytes)`);
}

console.log("Icons generated successfully.");
