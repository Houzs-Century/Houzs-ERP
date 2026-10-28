#!/usr/bin/env node
// ---------------------------------------------------------------------------
// further-description-rtf — build the RTF AutoCount would be sent, and read the
// RTF AutoCount already holds.
//
// The experiment behind docs/autocount-further-description-photos.md. It is
// READ-ONLY with respect to every database: it opens no connection, holds no
// credential, and knows nothing about the ERP. Its whole input is a file on
// disk.
//
// RE-RUN: idempotent and side-effect free except for the files `--extract`
// writes into a directory you name, which it overwrites.
//
//   BUILD — one or more JPEGs in, one RTF out (stdout, or --out FILE):
//     node backend/scripts/further-description-rtf.mjs build \
//       --dpi 96 --text "RDS-5526 SOFA" photo.jpg
//
//   INSPECT — an RTF in, a description of every picture in it out. THIS is the
//   half that answers the open question; point it at a FurtherDescription
//   dumped from the live book:
//     node backend/scripts/further-description-rtf.mjs inspect ac-sample.rtf
//     node backend/scripts/further-description-rtf.mjs inspect ac-sample.rtf --extract ./out
//
// Exit 0 for every legitimate answer, including "this RTF holds no picture" —
// a red run must mean the tool broke, not that the evidence was unwelcome.
// ---------------------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';
import {
  AC_SYNC_MAX_BODY_BYTES,
  furtherDescriptionRtf,
  jpegDimensions,
  parseRtfPictures,
  rtfPicture,
} from './lib/rtf-picture.mjs';

const BYTES_PER_LINE = 40;

function usage(msg) {
  if (msg) console.error(`error: ${msg}\n`);
  console.error(`usage:
  further-description-rtf.mjs build   [--dpi N] [--text S] [--out FILE] <image.jpg> [more.jpg ...]
  further-description-rtf.mjs inspect [--extract DIR] <file.rtf>

  --dpi N       pixels per inch the photograph was authored at; decides the
                printed size (\\picwgoal = px * 1440 / dpi). Default 96, which is
                what Windows reports for a screen-authored image — override it
                the moment the host read says otherwise.`);
  process.exit(msg ? 2 : 0);
}

function takeFlag(argv, name) {
  const i = argv.indexOf(name);
  if (i < 0) return null;
  const v = argv[i + 1];
  if (v == null) usage(`${name} needs a value`);
  argv.splice(i, 2);
  return v;
}

function cmdBuild(argv) {
  const dpi = Number(takeFlag(argv, '--dpi') ?? 96);
  const text = takeFlag(argv, '--text') ?? '';
  const out = takeFlag(argv, '--out');
  if (!Number.isFinite(dpi) || dpi <= 0) usage(`--dpi must be a positive number (got ${dpi})`);
  const files = argv.filter((a) => !a.startsWith('--'));
  if (!files.length) usage('build needs at least one image file');

  const pictures = [];
  const lengths = [];
  for (const file of files) {
    const bytes = new Uint8Array(fs.readFileSync(file));
    const { width, height } = jpegDimensions(bytes);
    pictures.push(rtfPicture(bytes, {
      blip: 'jpegblip', widthPx: width, heightPx: height, dpi, bytesPerLine: BYTES_PER_LINE,
    }));
    lengths.push(bytes.length);
    console.error(`  ${path.basename(file)}: ${width}x${height}px, ${bytes.length} bytes -> ${bytes.length * 2} hex chars`);
  }
  const rtf = furtherDescriptionRtf({ text, pictures });
  const wire = Buffer.byteLength(rtf, 'utf8');
  console.error(`  RTF: ${wire} bytes (${((wire / AC_SYNC_MAX_BODY_BYTES) * 100).toFixed(1)}% of AcSyncService's ${AC_SYNC_MAX_BODY_BYTES}-byte body ceiling, for this ONE line)`);
  if (out) { fs.writeFileSync(out, rtf, 'utf8'); console.error(`  written to ${out}`); }
  else process.stdout.write(rtf);
}

function cmdInspect(argv) {
  const extract = takeFlag(argv, '--extract');
  const files = argv.filter((a) => !a.startsWith('--'));
  if (files.length !== 1) usage('inspect takes exactly one .rtf file');
  const rtf = fs.readFileSync(files[0], 'utf8');
  const pics = parseRtfPictures(rtf);
  console.log(`${files[0]}: ${rtf.length} chars, ${pics.length} picture group(s)`);
  if (!pics.length) {
    console.log('  no {\\pict} group. Either this value holds no photograph, or the');
    console.log('  picture is carried some other way and THAT is the finding.');
    return;
  }
  if (extract) fs.mkdirSync(extract, { recursive: true });
  pics.forEach((p, i) => {
    const form = p.blip == null ? 'UNRECOGNISED (no known blip keyword in the group)' : p.blip + (p.blipArg ?? '');
    console.log(`  [${i}] form=${form}`);
    console.log(`      picw=${p.picw} pich=${p.pich} picwgoal=${p.picwgoal} pichgoal=${p.pichgoal}`);
    console.log(`      ${p.bytes.length} bytes from ${p.hexChars} hex chars${p.oddHexDigit ? '  ** ODD HEX DIGIT COUNT — the last nibble was dropped **' : ''}`);
    console.log(`      leading bytes: ${[...p.bytes.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join(' ')}`);
    if (extract) {
      const ext = p.blip === 'jpegblip' ? 'jpg' : p.blip === 'pngblip' ? 'png' : p.blip === 'wmetafile' ? 'wmf' : p.blip === 'emfblip' ? 'emf' : 'bin';
      const dst = path.join(extract, `pict-${i}.${ext}`);
      fs.writeFileSync(dst, p.bytes);
      console.log(`      -> ${dst}`);
    }
  });
}

const argv = process.argv.slice(2);
const cmd = argv.shift();
if (cmd === 'build') cmdBuild(argv);
else if (cmd === 'inspect') cmdInspect(argv);
else if (cmd === '--help' || cmd === '-h' || cmd == null) usage(null);
else usage(`unknown command ${JSON.stringify(cmd)}`);
