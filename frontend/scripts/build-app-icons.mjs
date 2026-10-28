#!/usr/bin/env node
// Build PWA app icons from public/logo-hc-mark.png — the mark-only HC source
// (no wordmark, owner-provided 2026-06-29). Tinted brass and composited onto
// a dark ink-green tile that matches the new theme-color + sidebar.

import sharp from 'sharp';
import { mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = resolve(ROOT, 'public/logo-hc-mark.png');
const OUT_DIR = resolve(ROOT, 'public');
mkdirSync(OUT_DIR, { recursive: true });

const BG = { r: 0x13, g: 0x20, b: 0x1c };    // sidebar / theme ink-green
const BRASS = { r: 0xd8, g: 0xa8, b: 0x5a }; // accent-bright

// 1. Trim the white canvas around the mark so the bounding box is just the HC silhouette.
const trimmed = await sharp(SRC).trim({ threshold: 10 }).toBuffer();

// 2. Threshold to a clean B&W silhouette; negate so the mark = white (alpha source).
const alphaMask = await sharp(trimmed)
  .greyscale()
  .threshold(128)
  .negate({ alpha: false })
  .toBuffer();

const { width: mw, height: mh } = await sharp(alphaMask).metadata();
console.log(`mark bbox: ${mw}x${mh}`);

// 3. Brass-color the mark on a transparent background. Use alphaMask's
//    luminance as the alpha channel of a solid brass fill: white pixels in
//    the mask → opaque brass, black pixels → transparent.
const alphaChannel = await sharp(alphaMask).extractChannel('red').raw().toBuffer();
const brassMark = await sharp({
  create: { width: mw, height: mh, channels: 3, background: BRASS },
})
  .joinChannel(alphaChannel, { raw: { width: mw, height: mh, channels: 1 } })
  .png()
  .toBuffer();

// Render the icon at a given output size and safe-area ratio.
//   safe = 0.65 → mark fills ~65% of the tile (default — standard icon)
//   safe = 0.50 → leaves more padding for maskable (OS rounds/crops to ~80%)
async function renderTile(size, safe, outPath) {
  const targetW = Math.round(size * safe);
  const targetH = Math.round((mh / mw) * targetW);
  const scaledMark = await sharp(brassMark).resize(targetW, targetH, { fit: 'contain' }).toBuffer();
  await sharp({
    create: { width: size, height: size, channels: 4, background: { ...BG, alpha: 1 } },
  })
    .composite([{ input: scaledMark, gravity: 'center' }])
    .png()
    .toFile(outPath);
  console.log(`✓ ${outPath} (${size}² · mark ${Math.round(safe * 100)}%)`);
}

await renderTile(192, 0.62, resolve(OUT_DIR, 'icon-192.png'));
await renderTile(512, 0.62, resolve(OUT_DIR, 'icon-512.png'));
await renderTile(512, 0.50, resolve(OUT_DIR, 'icon-512-maskable.png'));
await renderTile(180, 0.62, resolve(OUT_DIR, 'apple-touch-icon.png'));

console.log('done');
