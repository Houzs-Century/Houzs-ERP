#!/usr/bin/env node
/* check-multi-owner-jsonb.mjs — closes the "two owners in one blob" class.
 *
 * Every site that WRITES a jsonb column carrying more than one system's money is
 * enumerated in scripts/lib/multi-owner-jsonb-scan.mjs. A new site fails this
 * script, so it has to be read by a human who is told what the column actually
 * contains. The class, the damage it did twice, and what this scanner cannot
 * see are all documented in that file; its detection logic is unit-tested in
 * tests/multiOwnerJsonbScan.test.mjs.
 *
 * Read-only; exits 1 on an unregistered write site.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COLUMNS, REGISTERED, scanSource } from './lib/multi-owner-jsonb-scan.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(ROOT, 'src');

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      yield* walk(p);
      continue;
    }
    if (/\.(ts|mts|js|mjs)$/.test(name) && !/\.test\.[a-z]+$/.test(name)) yield p;
  }
}

const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);

const offenders = [];
let scanned = 0;
let registeredSeen = 0;
for (const file of walk(SRC)) {
  scanned++;
  const rel = relative(ROOT, file).split(sep).join('/');
  const text = readFileSync(file, 'utf8');
  for (const { col, line } of scanSource(text)) {
    if (REGISTERED.has(rel)) {
      registeredSeen++;
      continue;
    }
    offenders.push({ rel, col, line });
  }
}

/* A check that cannot fail is not a check. If none of the known writers matched,
   the detector has drifted and a silent pass would be a lie. */
if (registeredSeen === 0) {
  bad(
    `positive control failed: none of the ${REGISTERED.size} registered writers matched across ${scanned} files — the write detector has drifted.`,
  );
  process.exit(1);
}

if (offenders.length === 0) {
  note(
    `multi-owner jsonb: ${registeredSeen} registered write sites matched, no new ones (${scanned} files, columns: ${COLUMNS.join(', ')}).`,
  );
  process.exit(0);
}
for (const o of offenders) {
  bad(`${o.rel}:${o.line} writes ${o.col}, which carries BOTH cost and retail money.`);
}
bad(
  "Assigning the whole value deletes the other owner's fields — that is how 193 of 2990's " +
    'retail prices were erased on 2026-09-16. Merge per (height, tier) the way ' +
    'mergeRetailOntoDerivedSeatGrid does, then register the file in REGISTERED (scripts/lib/multi-owner-jsonb-scan.mjs) with the reason.',
);
process.exit(1);
