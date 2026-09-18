#!/usr/bin/env node
// ---------------------------------------------------------------------------
// census-line-photo-report.mjs — the verdict half of the photo census.
//
// `census-ac-line-photos.py` walks the whole book and writes census-<side>.json
// (DocNo, DtlKey, picture count). This reads that, reads the manifests AND the
// JPEGs actually on disk, and prints the three numbers that matter:
//
//     how many book lines carry a drawing
//     how many of those we hold
//     how many we are MISSING
//
// The judgement is not made here — it is `compareCensus()` in
// lib/line-photo-census.mjs, which is pure and pinned by
// lib/line-photo-census.test.mjs. This file only does I/O and printing.
//
// It also writes the DTLKEY_FILE the export's BOUNDED targeted mode reads, so
// the follow-up extraction never has to run FORCE=1 against a live book.
//
// Env:  OUT_DIR   default C:/Users/User/Desktop/.ac-photos
//       KEYS_OUT  where to write the missing-DtlKey file
//                 (default <OUT_DIR>/missing-dtlkeys.txt)
// ---------------------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

import { compareCensus, missingDtlKeyFile } from './lib/line-photo-census.mjs';

const OUT = process.env.OUT_DIR || 'C:/Users/User/Desktop/.ac-photos';
const KEYS_OUT = process.env.KEYS_OUT || path.join(OUT, 'missing-dtlkeys.txt');

const MANIFEST = { so: 'ac-photo-manifest.json.gz', po: 'ac-po-photo-manifest.json.gz' };

function readManifest(side) {
  const p = path.join(OUT, MANIFEST[side]);
  if (!fs.existsSync(p)) return [];
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(p)).toString('utf8'));
}

function filesOnDisk(side) {
  const dir = path.join(OUT, side);
  if (!fs.existsSync(dir)) return new Set();
  return new Set(fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.jpg')));
}

function readCensus(side) {
  const p = path.join(OUT, `census-${side}.json`);
  if (!fs.existsSync(p)) {
    console.error(`missing ${p} — run census-ac-line-photos.py first`);
    process.exit(2);
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

const results = {};
for (const side of ['so', 'po']) {
  const bookLines = readCensus(side);
  const manifestRows = readManifest(side);
  const disk = filesOnDisk(side);
  const r = compareCensus({ bookLines, manifestRows, filesOnDisk: disk });
  results[side] = r;

  console.log(`\n== ${side.toUpperCase()} ==`);
  console.log(`  book lines carrying a drawing : ${r.bookLines}   (${r.bookPictures} picture(s))`);
  console.log(`  JPEGs on disk                 : ${disk.size}`);
  console.log(`  manifest rows                 : ${manifestRows.length}`);
  console.log(`  lines we hold IN FULL         : ${r.heldLines}`);
  console.log(`  lines MISSING entirely        : ${r.missing.length}`);
  console.log(`  lines held only in PART       : ${r.partial.length}`);
  console.log(`  manifest rows with no JPEG    : ${r.manifestWithoutFile.length}   (the 0668 class)`);
  console.log(`  manifest lines not in the book: ${r.manifestNotInBook.length}`);
  if (r.missing.length) {
    console.log('  missing (up to 40):');
    for (const m of r.missing.slice(0, 40)) console.log(`    ${m.DocNo} DtlKey=${m.DtlKey} pics=${m.pics}`);
  }
  if (r.partial.length) {
    console.log('  partial (up to 20):');
    for (const m of r.partial.slice(0, 20)) console.log(`    ${m.DocNo} DtlKey=${m.DtlKey} have ${m.have} of ${m.pics}`);
  }
}

// The export's targeted mode wants every key it must fetch: entirely missing
// lines AND partially held ones (it skips pictures already on disk by name).
const need = {
  so: [...results.so.missing, ...results.so.partial],
  po: [...results.po.missing, ...results.po.partial],
};
fs.writeFileSync(KEYS_OUT, missingDtlKeyFile(need), 'utf8');

console.log('\n---------------------------------------------------------------');
console.log(`BOOK LINES WITH A DRAWING : SO ${results.so.bookLines}   PO ${results.po.bookLines}`);
console.log(`WE HOLD IN FULL           : SO ${results.so.heldLines}   PO ${results.po.heldLines}`);
console.log(`MISSING (whole lines)     : SO ${results.so.missing.length}   PO ${results.po.missing.length}`);
console.log(`MISSING (partial lines)   : SO ${results.so.partial.length}   PO ${results.po.partial.length}`);
console.log(`keys to fetch written to  : ${KEYS_OUT}  (${need.so.length + need.po.length} key(s))`);
