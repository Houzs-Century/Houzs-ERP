#!/usr/bin/env node
// ---------------------------------------------------------------------------
// check-jsonb-binds.mjs — no pre-serialized value may be bound as a query
// parameter. Exit 1 on any violation.
//
// WHY THIS EXISTS. docs/jsonb-double-encoding-coe.md, whose own Lesson 4 reads:
// "Documenting a trap is not fixing it. Two files were given careful comments
// explaining this exact double-encoding after its first occurrence. The
// comments taught readers to tolerate the bad data. The writers stayed broken,
// and the trap caught a third script the same afternoon."
//
// That is the whole argument for this file. The class was found on 2026-07-29,
// documented, and then recurred on 2026-08-08, three times on 2026-08-10, and
// again on 2026-08-13 — in the repair script written to UNDO the damage, which
// turned seven production rows from array-shaped to string-shaped. At the point
// this check was written there were 22 hand-written prose warnings about this
// one trap in backend/, one COE, zero automated checks, and two live
// violations on origin/main.
//
// WHY A SCRIPT AND NOT A TEST. The backend suite runs in workerd
// (vitest-pool-workers) and has no filesystem, so a vitest file cannot read
// backend/scripts/*.mjs — which is where four of the six occurrences were. The
// scanner's own logic IS unit-tested: tests/jsonbBindScan.node.mjs.
//
// READ-ONLY. Touches no database and no network — it reads files.
//
//   node backend/scripts/check-jsonb-binds.mjs      # exit 1 on a violation
//   npm --prefix backend run audit:jsonb-binds
// ---------------------------------------------------------------------------

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanSource } from './lib/jsonb-bind-scan.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BACKEND = resolve(HERE, '..');
const REPO = resolve(BACKEND, '..');

const ROOTS = [join(BACKEND, 'src'), join(BACKEND, 'scripts')];
const EXT = /\.(ts|mts|mjs|js)$/;
const SKIP_DIR = new Set(['node_modules', 'dist', '.wrangler', 'artifacts']);

// -- Reviewed exceptions ----------------------------------------------------
// A site may only be listed here WITH a reason that says why the parameter can
// never be typed json/jsonb by the server. "It looked fine" is not a reason;
// the 2026-08-13 recurrence was written by someone who had just read the COE
// and reasoned their way to the same bug. Prefer sql.json() or ::text::jsonb
// over an entry here — both are one edit and neither can go stale.
//
// Key is `<path>:<line>` is deliberately NOT used: line numbers move. Key is
// the path, and the entry must name every site in that file.
const ALLOWLIST = new Map([
  [
    'backend/scripts/seed-user-management.mjs',
    // `roles.permissions` is a TEXT column holding a JSON array AS TEXT, not a
    // jsonb column: 0000_baseline.sql:471 declares `permissions text DEFAULT
    // '[]' NOT NULL`, and migrations 0031, 0216 and 0225 all cast
    // `permissions::jsonb` on read, which would be a no-op if it were jsonb.
    // The server therefore types this parameter as text, the driver's json
    // serializer never runs, and JSON.stringify is the CORRECT bind here —
    // sql.json() would send a jsonb value into a text column instead.
    'roles.permissions is text, not jsonb (0000_baseline.sql:471); the string is the intended value',
  ],
]);

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIR.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) yield* walk(full);
    else if (EXT.test(name)) yield full;
  }
}

const findings = [];
for (const root of ROOTS) {
  for (const file of walk(root)) {
    // Forward slashes, always. relative() returns the platform separator, so on
    // Windows every ALLOWLIST key missed and the one allowed site was reported
    // as a finding — a red gate on a developer machine and green on Linux CI,
    // which is the hardest kind to believe.
    const rel = relative(REPO, file).split(sep).join('/');
    if (ALLOWLIST.has(rel)) continue;
    findings.push(...scanSource(rel, readFileSync(file, 'utf8')));
  }
}

if (findings.length === 0) {
  console.log('jsonb parameter binding: clean.');
  console.log('  No pre-serialized value is bound as a query parameter in');
  console.log('  backend/src or backend/scripts.');
  process.exit(0);
}

console.error(`\nA PRE-SERIALIZED VALUE IS BOUND AS A QUERY PARAMETER — ${findings.length} site(s).\n`);
console.error('postgres.js asks the server for parameter types before binding, and');
console.error('runs its OWN JSON.stringify over any parameter the server types as');
console.error('json/jsonb. A value that is already a string is therefore encoded');
console.error('TWICE and lands as a jsonb STRING. Nothing errors, the UPDATE still');
console.error('reports a rowcount, and every reader of that column silently sees');
console.error('nothing. See docs/jsonb-double-encoding-coe.md.\n');
for (const f of findings) {
  console.error(`  ${f.file}:${f.line}  [${f.kind}]`);
  console.error(`      ${f.snippet}`);
}
console.error('\nFIX, in order of preference:');
console.error('  1. Pass the OBJECT through the driver:  sql`... ${sql.json(obj)} ...`');
console.error('     (inside a transaction the tag is the transaction handle: tx.json(obj))');
console.error('  2. If the statement must stay .unsafe(text, params), funnel the');
console.error('     placeholder through text first:  $2::text::jsonb');
console.error('     ::text makes the SERVER type that parameter as text, so the');
console.error('     driver\'s json serializer never runs and the cast decodes once.');
console.error('\nDo not add an ALLOWLIST entry to make this pass. Both fixes are one edit.\n');
process.exit(1);
