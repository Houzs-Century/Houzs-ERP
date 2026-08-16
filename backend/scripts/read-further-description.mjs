#!/usr/bin/env node
/* Read ONE Further Description out of the live AutoCount book, through
 * AcSyncService's /further-description route.
 *
 * WHY THIS EXISTS. `docs/autocount-handling-listing.md` is an instruction sheet
 * someone has to carry to the AutoCount machine and run three SELECTs on by
 * hand, then send a file back. It exists only because that service exposed no
 * read route at all — `CLAUDE.md`'s standing rule (never ask a human to run a
 * query; build the check) could not be honoured for the one database no
 * workflow can reach. The listing's own section 8 named the fix: a read-only
 * route on the service. That route now exists, and this is its caller.
 *
 * READ-ONLY. It POSTs to one route that runs two SELECTs. It opens no database
 * itself and holds no credential — the key comes from the environment, is never
 * printed, and never reaches a log line.
 *
 * RE-RUN: idempotent. Nothing is written anywhere except the file you ask for
 * with --extract, which is overwritten.
 *
 *   AC_SYNC_URL=https://autocount.houzscentury.com \
 *   AC_SYNC_KEY=... \
 *   node backend/scripts/read-further-description.mjs --dtlkey 34553
 *
 *   ... --table PODTL --dtlkey 12 --extract ./ac-12.rtf
 *
 * Then, on the extracted file:
 *   node backend/scripts/further-description-rtf.mjs inspect ./ac-12.rtf --extract ./ac
 *
 * The `form=` line that prints is the answer the whole listing was for.
 */
import fs from 'node:fs';

const argv = process.argv.slice(2);
const flag = (name, dflt = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};

const url = (process.env.AC_SYNC_URL ?? '').replace(/\/+$/, '');
const key = process.env.AC_SYNC_KEY ?? '';
const table = (flag('table', 'SODTL') ?? 'SODTL').toUpperCase();
const dtlKey = flag('dtlkey');
const extract = flag('extract');

/* Refuse rather than half-run. A missing key against a fail-closed service
   answers 503 and reads like the service is down, which is the wrong thing to
   go and investigate. */
if (!url) { console.error('AC_SYNC_URL is not set. It is config, not a secret — see backend/wrangler.toml [vars].'); process.exit(2); }
if (!key) { console.error('AC_SYNC_KEY is not set. It is a wrangler secret; export it into this shell, never into a file.'); process.exit(2); }
if (!dtlKey || !/^\d+$/.test(dtlKey)) { console.error('--dtlkey <positive integer> is required.'); process.exit(2); }

const res = await fetch(`${url}/further-description`, {
  method: 'POST',
  headers: { 'X-API-KEY': key, 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': 'true' },
  body: JSON.stringify({ Table: table, DtlKey: Number(dtlKey) }),
});

const text = await res.text();
let body;
try { body = JSON.parse(text); } catch {
  /* Print the STATUS and the first line only. A stray HTML error page from a
     tunnel can be long, and it is never the interesting part. */
  console.error(`HTTP ${res.status} — response was not JSON: ${text.slice(0, 200)}`);
  process.exit(1);
}

if (!res.ok || body.ok !== true) {
  console.error(`HTTP ${res.status} — ${body.error ?? 'no error message'}`);
  process.exit(1);
}

console.log(`table       ${body.table}`);
console.log(`column      ${body.column ?? '(none)'}`);
if (Array.isArray(body.columns) && body.columns.length > 0) {
  for (const c of body.columns) {
    console.log(`  candidate ${c.name} (system_type_id=${c.system_type_id}, max_length=${c.max_length})`);
  }
}
if (body.note) console.log(`note        ${body.note}`);

/* "No such column" and "no such row" are ANSWERS, and the listing asks for them
   to be sent back as-is. Exit 0: a red job reads as "the check broke", and the
   check did not break. */
if (body.column == null || body.found !== true) process.exit(0);

console.log(`dtlKey      ${body.dtlKey}`);
console.log(`isNull      ${body.isNull}`);
console.log(`length      ${body.length}`);
if (body.truncated) {
  console.log(`truncated   YES — the service capped this at 4 MB; the row holds ${body.length} characters.`);
  console.log(`            The extracted file is INCOMPLETE. This is printed rather than left silent`);
  console.log(`            because a truncation nobody sees is exactly what the manual sqlcmd path did.`);
}

if (extract && typeof body.value === 'string') {
  fs.writeFileSync(extract, body.value, 'utf8');
  console.log(`wrote       ${extract} (${Buffer.byteLength(body.value, 'utf8')} bytes)`);
  console.log('');
  console.log('Next:');
  console.log(`  node backend/scripts/further-description-rtf.mjs inspect ${extract} --extract ./ac`);
} else if (!extract) {
  console.log('');
  console.log('Pass --extract <file> to save the value; the RTF inspector reads a file, not stdin.');
}
