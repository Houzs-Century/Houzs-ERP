#!/usr/bin/env node
// ---------------------------------------------------------------------------
// check-generators-run.mjs — every generated document's generator must still
// RUN. Exit 1 if any of them throws.
//
// WHY THIS EXISTS, and why it does NOT check freshness.
//
// BUG-HISTORY 2026-08-12: "The codebase-map generator had been crashing for
// three weeks, so the map quietly rotted." Its lesson: "a generator that
// crashes is indistinguishable from a generator nobody runs ... its failure has
// to reach somebody." That half was never shipped — measured on origin/main
// 2026-08-13, `audit:map` and `audit:route-locator` appeared in ZERO of the 296
// workflow files, and both artifacts were stale again.
//
// The obvious fix — wire `--check` into CI — is the WRONG one here, and saying
// why matters more than the fix. Both artifacts embed per-route LINE NUMBERS
// and per-file LINE COUNTS, so any edit to any route file makes them stale.
// `docs/generated/route-locator.md` moved 637 lines for one added file. As a
// required check that fires on almost every backend PR for cosmetic drift, it
// would be routed around within a week — and a gate people learn to bypass is
// how this repo got a `--check` script that could not fail in the first place.
//
// So the gate is narrowed to the failure that actually happened and that
// nothing else can see: THE GENERATOR STILL RUNS. Freshness stays a
// regenerate-on-demand chore, and docs/bug-classes.md says so out loud rather
// than implying a coverage that is not there.
//
// READ-ONLY with respect to the database. It does rewrite the generated files
// in the working tree, which is why CI runs it on a disposable checkout.
//
//   node backend/scripts/check-generators-run.mjs
//   npm --prefix backend run audit:generators
// ---------------------------------------------------------------------------

import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Every generator whose output is committed under docs/generated/. Add a row
 *  here in the same PR that adds a generator, or its crash is invisible again. */
const GENERATORS = [
  { name: 'codebase map', script: 'gen-codebase-map.mjs' },
  { name: 'route locator', script: 'gen-route-locator.mjs' },
  { name: 'AutoCount item map', script: 'gen-autocount-item-map.mjs' },
  { name: 'AutoCount master maps', script: 'gen-autocount-master-maps.mjs' },
  { name: 'sofa Desc2 corpus', script: 'gen-sofa-desc2-corpus.mjs' },
];

const broken = [];
for (const g of GENERATORS) {
  const r = spawnSync(process.execPath, [join(HERE, g.script)], {
    encoding: 'utf8',
    cwd: resolve(HERE, '..'),
  });
  if (r.status === 0) {
    console.log(`  ok    ${g.name.padEnd(22)} (${g.script})`);
  } else {
    console.log(`  FAIL  ${g.name.padEnd(22)} (${g.script}) exit ${r.status}`);
    broken.push({ ...g, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() });
  }
}

if (broken.length === 0) {
  console.log(`\nAll ${GENERATORS.length} generators run.`);
  console.log('Note: this does NOT assert the committed output is up to date —');
  console.log('both docs embed line numbers and would churn on every PR. Run');
  console.log('`npm --prefix backend run audit:map` when you want that answer.');
  process.exit(0);
}

console.error(`\n${broken.length} GENERATOR(S) NO LONGER RUN.\n`);
console.error('Their committed output is now frozen at whatever it last held, and');
console.error('nothing else in CI can tell a frozen document from a current one.');
console.error('docs/generated/codebase-map-facts.md is what CODEBASE-MAP.md points');
console.error('new sessions at as the layer that is safe to trust; in August it spent');
console.error('three weeks claiming 122 route modules against a real 135.\n');
for (const b of broken) {
  console.error(`  ${b.script}`);
  for (const line of b.out.split('\n').slice(-12)) console.error(`      ${line}`);
  console.error('');
}
process.exit(1);
