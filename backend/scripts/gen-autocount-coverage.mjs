#!/usr/bin/env node
// ---------------------------------------------------------------------------
// gen-autocount-coverage — ONE AutoCount coverage table, DERIVED from source.
//
// WHY THIS EXISTS. On 2026-08-15 four documents each carried their own
// hand-written version of "which AutoCount operations work", and they
// contradicted each other outright:
//
//   docs/autocount-migration-record.md   "Five cells are PROVEN as of 2026-08-12"
//   docs/autocount-sync-coverage.md      "No cell anywhere is PROVEN."
//   docs/autocount-service-deploy.md     "/so-to-do ... never run end to end"
//   tasks/AUTOCOUNT-GOLIVE-HANDOFF.md    "PROVEN | ... so-to-do (DO-011260)"
//
// The migration record had already noticed ("Both cannot be true") and left it.
// A reader -- human or agent -- believes whichever one they open first, and on
// that day one did, twice, in opposite directions.
//
// Three of the four columns below are facts about SOURCE, so nobody should ever
// type them again:
//
//   op / route      AC_ROUTE in src/services/autocount-writeback.ts
//   service         the `case "/x":` labels in AcSyncService.cs
//   ERP triggers    the enqueue call sites in src/scm/routes/
//
// The fourth -- was it ever run against the licensed book -- is not in any
// source tree and never will be. It lives in ONE file,
// scripts/data/ac-live-proof.json, and it must carry a document number.
//
// RE-RUN: pure. Reads the tree, writes docs/generated/autocount-coverage.md.
//   node backend/scripts/gen-autocount-coverage.mjs            # write
//   node backend/scripts/gen-autocount-coverage.mjs --check    # CI gate
// ---------------------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sameIgnoringEol } from './lib/eol.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.resolve(HERE, '..');
const REPO = path.resolve(BACKEND, '..');
const OUT = path.join(REPO, 'docs/generated/autocount-coverage.md');

const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

/* Every checker here self-tests: a regex that stops matching must REFUSE, never
   report an empty result as a clean one. CLAUDE.md's rule, bought three times. */
function must(list, what, atLeast) {
  if (list.length < atLeast) {
    console.error(`gen-autocount-coverage: found ${list.length} ${what}, expected at least ${atLeast}.`);
    console.error('The pattern stopped matching. A verdict computed over nothing must not read as a pass.');
    process.exit(2);
  }
  return list;
}

// ── 1. the operations the ERP knows, and the route each maps to ─────────────
const writeback = read('backend/src/services/autocount-writeback.ts');
const routeBlock = writeback.match(/export const AC_ROUTE = \{([\s\S]*?)\} as const;/);
if (!routeBlock) {
  console.error('gen-autocount-coverage: AC_ROUTE not found in autocount-writeback.ts.');
  process.exit(2);
}
const ops = must(
  [...routeBlock[1].matchAll(/^\s*(\w+):\s*'([^']+)'/gm)].map((m) => ({ op: m[1], route: m[2] })),
  'AC_ROUTE entries', 8,
);

// ── 2. the routes AcSyncService actually implements ─────────────────────────
const cs = read('backend/scripts/autocount-service/AcSyncService.cs');
const implemented = new Set(
  must([...cs.matchAll(/case\s+"(\/[a-z-]+)":/g)].map((m) => m[1]), 'AcSyncService case labels', 8),
);
/* THE ROUTES THAT RETURN BEFORE THE SWITCH. `Handle` answers /health from an
   `if (path == "/health")` above the POST-only check and above the switch, so
   the case-label scan cannot see it, and the table said the service does NOT
   implement a route it has always served. A generated artifact that is
   confidently wrong is worse than a hand-written one, so the scan reads the
   early branches too rather than being told the answer. */
for (const m of cs.matchAll(/path\s*==\s*"(\/[a-z-]+)"/g)) implemented.add(m[1]);

// ── 3. which ERP routes enqueue which operation ─────────────────────────────
/* Read from the route tree rather than from a list, so a new call site appears
   here the day it is written and a deleted one disappears the day it is not. */
const ROUTES_DIR = path.join(BACKEND, 'src/scm/routes');
const routeFiles = fs.readdirSync(ROUTES_DIR)
  .filter((f) => f.endsWith('.ts') && !f.includes('.test.'));
must(routeFiles, 'route files', 20);

const sources = new Map(routeFiles.map((f) => [f, fs.readFileSync(path.join(ROUTES_DIR, f), 'utf8')]));
/* The payment insert hooks BELOW the route layer on purpose -- scan-so.ts books
   scanned receipts through the same core with no request context -- so the lib
   is read too or the SO edit row under-counts by one. */
const LIB_DIR = path.join(BACKEND, 'src/scm/lib');
for (const f of fs.readdirSync(LIB_DIR)) {
  if (f.endsWith('.ts') && !f.includes('.test.') && !f.startsWith('autocount-')) {
    sources.set(`lib/${f}`, fs.readFileSync(path.join(LIB_DIR, f), 'utf8'));
  }
}

/* An op is triggered by whatever calls its enqueue helper. The convert helper
   takes the op as a field, so that one is matched on the field. */
const TRIGGER = {
  create_so: /\benqueueSoCreate\s*\(/g,
  create_po: /\benqueuePoCreate\s*\(/g,
  so_to_do: /op:\s*'so_to_do'/g,
  po_to_gr: /op:\s*'po_to_gr'/g,
  do_to_iv: /op:\s*'do_to_iv'/g,
  gr_to_pi: /op:\s*'gr_to_pi'/g,
  cancel: /\benqueueCancel\s*\(/g,
  edit: /\benqueueEdit\s*\(|\bqueueAc\w*Edit\w*\s*\(/g,
  /* Never enqueued: the drain calls it inline before a create or an edit. */
  ensure_masters: null,
};

const callers = {};
for (const { op } of ops) {
  const re = TRIGGER[op];
  if (!re) { callers[op] = null; continue; }
  const hits = [];
  for (const [file, src] of sources) {
    /* A helper's own definition is not a call site. */
    const n = [...src.matchAll(re)].filter((m) => {
      const before = src.slice(Math.max(0, m.index - 40), m.index);
      return !/\b(async\s+)?function\s+$|\bexport\s+(async\s+)?function\s+$/.test(before);
    }).length;
    if (n > 0) hits.push(`${file} x${n}`);
  }
  callers[op] = hits;
}

// ── 4. the one thing source cannot answer ───────────────────────────────────
const proofFile = JSON.parse(read('backend/scripts/data/ac-live-proof.json'));
const proof = proofFile.proof ?? {};
const notDemo = proofFile.notDemonstrated ?? {};

// ── render ──────────────────────────────────────────────────────────────────
const cell = (s) => String(s ?? '').replace(/\|/g, '\\|');
const lines = [];
lines.push('# AutoCount coverage — GENERATED, do not hand-edit');
lines.push('');
lines.push('`npm --prefix backend run gen:ac-coverage` writes this file and');
lines.push('`audit:ac-coverage` fails CI when it drifts.');
lines.push('');
lines.push('**Do not write a coverage table anywhere else.** Four documents each held');
lines.push('their own and they contradicted each other; that is what this file replaces.');
lines.push('Three of the four columns are read out of source on every run. The fourth');
lines.push('cannot be, and lives in `backend/scripts/data/ac-live-proof.json` — one place,');
lines.push('and an entry needs a document number.');
lines.push('');
lines.push('| operation | route | service implements it | ERP triggers it from | run against the live book |');
lines.push('|---|---|---|---|---|');
for (const { op, route } of ops) {
  const impl = implemented.has(route) ? 'yes' : '**NO**';
  const trig = callers[op] === null
    ? '_not queued — the drain calls it inline_'
    : (callers[op].length ? callers[op].join(', ') : '**nothing**');
  const p = proof[op];
  const ran = p
    ? `**yes** — ${p.documents.join(', ')} (${p.date})`
    : 'no';
  lines.push(`| \`${op}\` | \`${route}\` | ${impl} | ${cell(trig)} | ${ran} |`);
}
lines.push('');
lines.push('## What "run against the live book" means here');
lines.push('');
lines.push('A document number in `AED_HOUZS`, or a query that can be re-run. Nothing else');
lines.push('counts. Note that the queue is NOT the whole record: `so_to_do` was driven');
lines.push('directly on the host and `scm.autocount_outbox` has no row for it, so a reader');
lines.push('who checks only the queue concludes it never happened. It did.');
lines.push('');
for (const [op, why] of Object.entries(notDemo)) {
  lines.push(`- **\`${op}\`** — ${why}`);
}
lines.push('');
lines.push('## The payload contract is checked separately, and by source');
lines.push('');
lines.push('`src/services/autocount-writeback.contract.test.ts` reads `AcSyncService.cs`');
lines.push('itself and asserts the bytes the ERP would POST against the keys that file');
lines.push('actually parses, for every route. So "the service implements it" above and');
lines.push('"the two sides agree on the fields" are two different checks, and both run.');
lines.push('');

const next = lines.join('\n');
const prev = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : null;

if (process.argv.includes('--check')) {
  // Content, not line endings — see scripts/lib/eol.mjs.
  if (sameIgnoringEol(prev, next)) {
    console.log(`AutoCount coverage is current (${ops.length} operations).`);
    process.exit(0);
  }
  console.error('AutoCount coverage is STALE. Run: npm --prefix backend run gen:ac-coverage');
  process.exit(1);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, next);
console.log(`Wrote docs/generated/autocount-coverage.md (${ops.length} operations).`);
