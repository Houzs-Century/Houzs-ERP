#!/usr/bin/env node
// ---------------------------------------------------------------------------
// check-release-discipline.mjs — the two artefacts that cannot be rolled back.
//
// WHY THIS EXISTS. Reverting a commit un-ships a route. It does not un-ship a
// migration (pg-migrate applies a merged file to prod on the next push to main
// and tracks it by FULL FILENAME, so the file is immutable from that moment)
// and it does not un-ship a repair script that has already run against prod.
// For those two, the discipline IS the rollback plan.
//
// The house pattern for a repair script is good where it is followed —
// MODE=plan by default, MODE=apply behind a CONFIRM phrase, verification on a
// fresh connection — and until this file nothing enforced it. On 2026-08-13 a
// repair written to undo the jsonb double-encoding COE reproduced that exact
// bug and turned 7 production rows from one unreadable shape into another. Its
// SHAPE check caught it. Its row count said 7 of 7.
//
// WHAT IT CHECKS
//   backend/scripts/*.mjs that open a database AND write must have:
//     mode-gate       a MODE / APPLY gate whose default is plan
//     confirm-phrase  a CONFIRM phrase on the apply path
//     fresh-verify    a re-read on a FRESH connection asserting the SHAPE
//     rerun-note      `RE-RUN: …` in the header
//   backend/src/db/migrations-pg/*.sql at or above the recorded floor must have:
//     reversal-note   `-- REVERSAL: …`, and for a DROP VIEW, one that names the
//                     grants the recreate has to put back (0189 -> 0190 -> 0191)
//
// IT IS A RATCHET, NOT A BIG BANG. Today's tree is grandfathered by
// release-discipline-grandfathered.json, entry by entry and RULE BY RULE — so
// editing a grandfathered script can still fail on a rule it used to pass. The
// list may only SHRINK: fix a script and this check makes you delete its entry.
// The grandfathered count is printed on every single run, so it stays a debt
// somebody is paying down rather than the way things are done here.
//
//   node backend/scripts/check-release-discipline.mjs
//   node backend/scripts/check-release-discipline.mjs --ratchet-against origin/main
//   npm --prefix backend run audit:release-discipline
//
// READ-ONLY. Reads files (and `git show` with --ratchet-against). No database.
// ---------------------------------------------------------------------------

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  scanScript, scanMigration, indexLibExports, ratchetDiff,
  reconcileScriptLedger, floorShouldDropTo,
  SCRIPT_RULES, MIGRATION_RULES,
} from './lib/release-discipline.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BACKEND = resolve(HERE, '..');
const REPO = resolve(BACKEND, '..');
const SCRIPTS = join(BACKEND, 'scripts');
const LIB = join(SCRIPTS, 'lib');
const MIGRATIONS = join(BACKEND, 'src/db/migrations-pg');
const LEDGER = join(SCRIPTS, 'release-discipline-grandfathered.json');
const LEDGER_REL = 'backend/scripts/release-discipline-grandfathered.json';

const RULE_TEXT = new Map([...SCRIPT_RULES, ...MIGRATION_RULES].map((r) => [r.id, r]));

const args = process.argv.slice(2);
const ratchetAgainst = (() => {
  const i = args.indexOf('--ratchet-against');
  if (i === -1) return null;
  const ref = args[i + 1];
  if (!ref || ref.startsWith('--')) {
    // Silently doing nothing here is the one outcome that must not happen: the
    // step would go green while comparing against nothing at all.
    console.error('FATAL: --ratchet-against needs a git ref (e.g. origin/main).');
    process.exit(2);
  }
  return ref;
})();

const problems = [];
const fail = (msg) => problems.push(msg);

// ── Read the trees. An empty scan is a FAILURE, never a pass ───────────────
// A checker pointed at a moved directory otherwise reports "0 violations" and
// reads as green forever. Both of these directories have been renamed before.
function listFiles(dir, ext, label) {
  if (!existsSync(dir)) {
    console.error(`FATAL: ${label} does not exist at ${dir}. This check cannot run; it must not pass.`);
    process.exit(2);
  }
  const files = readdirSync(dir).filter((f) => f.endsWith(ext)).sort();
  if (files.length === 0) {
    console.error(`FATAL: found ZERO ${ext} files in ${dir} (${label}). A scan that finds nothing is broken, not clean.`);
    process.exit(2);
  }
  return files;
}

const scriptFiles = listFiles(SCRIPTS, '.mjs', 'backend/scripts');
const libFiles = listFiles(LIB, '.mjs', 'backend/scripts/lib');
const migrationFiles = listFiles(MIGRATIONS, '.sql', 'backend/src/db/migrations-pg');

if (!existsSync(LEDGER)) {
  console.error(`FATAL: the grandfather ledger is missing at ${LEDGER}. Without it every finding below would read as new.`);
  process.exit(2);
}
const ledger = JSON.parse(readFileSync(LEDGER, 'utf8'));
const exempt = ledger.scripts ?? {};
const floor = ledger.migrationReversalNoteRequiredFrom;
if (!Number.isInteger(floor)) {
  console.error(`FATAL: ${LEDGER_REL} has no integer migrationReversalNoteRequiredFrom.`);
  process.exit(2);
}

const libExports = indexLibExports(libFiles.map((f) => [f, readFileSync(join(LIB, f), 'utf8')]));

// ── Scripts ────────────────────────────────────────────────────────────────
const scanned = scriptFiles.map((name) =>
  scanScript({ name, source: readFileSync(join(SCRIPTS, name), 'utf8'), libExports }));

const writers = scanned.filter((s) => s.writes);
if (writers.length === 0) {
  console.error(`FATAL: ${scriptFiles.length} scripts scanned and NOT ONE was detected as writing. The write detector is broken.`);
  process.exit(2);
}

let grandfatheredRules = 0;
const stillOwed = new Map();

for (const s of writers) {
  const allowed = exempt[s.name] ?? [];
  for (const rule of s.failed) {
    if (allowed.includes(rule)) {
      grandfatheredRules++;
      stillOwed.set(s.name, [...(stillOwed.get(s.name) ?? []), rule]);
      continue;
    }
    const r = RULE_TEXT.get(rule);
    fail(`backend/scripts/${s.name} writes (${s.evidence.join(', ')}) and is missing ${r.what} [${rule}].\n      ${s.detail[rule]}\n      FIX: ${r.fix}`);
  }
}

// The list may only shrink, and this is the half that makes it shrink: a rule
// a script now passes is a rule that must come off its entry in the same PR.
const LEDGER_PROBLEM = {
  gone: ({ name }) => `${LEDGER_REL} grandfathers backend/scripts/${name}, which does not exist. Delete the entry.`,
  'not-writer': ({ name }) => `${LEDGER_REL} grandfathers backend/scripts/${name}, which no longer writes. Delete the entry.`,
  empty: ({ name }) => `${LEDGER_REL} grandfathers backend/scripts/${name} from nothing. Delete the entry; an empty exemption makes the debt look bigger than it is.`,
  unknown: ({ name, rules }) => `${LEDGER_REL} names unknown rule(s) for ${name}: ${rules.join(', ')}. Known ids: ${[...RULE_TEXT.keys()].join(', ')}`,
  fixed: ({ name, rules }) => `backend/scripts/${name} now satisfies ${rules.join(', ')} — remove ${rules.length === 1 ? 'it' : 'them'} from ${LEDGER_REL}. The list may only shrink.`,
};
for (const p of reconcileScriptLedger(scanned, exempt)) fail(LEDGER_PROBLEM[p.kind](p));

// ── Migrations ─────────────────────────────────────────────────────────────
const migrations = migrationFiles.map((name) =>
  scanMigration({ name, source: readFileSync(join(MIGRATIONS, name), 'utf8') }));

const below = migrations.filter((m) => m.number === null || m.number < floor);
const required = migrations.filter((m) => m.number !== null && m.number >= floor);

for (const m of required) {
  for (const rule of m.failed) {
    const r = RULE_TEXT.get(rule);
    fail(`backend/src/db/migrations-pg/${m.name} is missing ${r.what} [${rule}].\n      ${m.detail[rule]}\n      FIX: ${r.fix}`);
  }
}

// The floor is the migration half of the ratchet. It may only come DOWN, and it
// comes down when somebody backfills reversal notes onto the files below it.
const highest = Math.max(...migrations.map((m) => m.number ?? 0));
if (floor > highest + 1) {
  fail(`${LEDGER_REL} sets migrationReversalNoteRequiredFrom=${floor}, above the next free number (${highest + 1}). That exempts migrations nobody has written yet.`);
}
// Backfilling notes onto the tail forces the floor down with them.
const dropTo = floorShouldDropTo(migrations, floor);
if (dropTo !== null) {
  fail(`migrations ${dropTo}..${floor - 1} all carry a reversal note — lower migrationReversalNoteRequiredFrom to ${dropTo} in ${LEDGER_REL}. The floor may only come down.`);
}

// ── The no-growth half of the ratchet ──────────────────────────────────────
if (ratchetAgainst) {
  let baseSha;
  try {
    baseSha = execFileSync('git', ['merge-base', 'HEAD', ratchetAgainst], { cwd: REPO, encoding: 'utf8' }).trim();
  } catch {
    console.error(`FATAL: --ratchet-against ${ratchetAgainst} could not be resolved to a merge base. Fetch it before running; a ratchet that cannot see its baseline must not pass in silence.`);
    process.exit(2);
  }
  let baseText = null;
  try {
    // stderr ignored: "exists on disk, but not in <sha>" is the EXPECTED answer
    // on the commit that introduces the ledger, and it is reported below in
    // words rather than as a stray git fatal.
    baseText = execFileSync('git', ['show', `${baseSha}:${LEDGER_REL}`], { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    // The introducing PR: there is no baseline because the ledger is new here.
    console.log(`ratchet: ${LEDGER_REL} does not exist at ${baseSha.slice(0, 8)} — this is the commit that introduces it, so there is nothing to compare.`);
  }
  // Parsed OUTSIDE the catch on purpose: a malformed baseline is a broken
  // ratchet and must throw, not be mistaken for "there is no baseline".
  const baseLedger = baseText === null ? null : JSON.parse(baseText);
  if (baseLedger) {
    const grew = ratchetDiff(baseLedger, ledger);
    for (const g of grew) fail(`the grandfather list GREW against ${ratchetAgainst}: ${g}`);
    console.log(`ratchet: compared against ${baseSha.slice(0, 8)} (${ratchetAgainst})${grew.length ? '' : ' — no growth'}`);
  }
}

// ── Verdict ────────────────────────────────────────────────────────────────
// Printed on every run, pass or fail. The debt is the point.
//
// ONE console.log for the whole block, deliberately: GitHub interleaves a
// step's stdout and stderr freely, and the first cut of this printed its last
// summary line INSIDE the problem list.
const worst = [...stillOwed.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 5);
console.log([
  '',
  `Release discipline — scanned ${scriptFiles.length} scripts (${scanned.filter((s) => s.inScope).length} open a database, ${writers.length} write) and ${migrationFiles.length} migrations.`,
  `  GRANDFATHERED: ${grandfatheredRules} rule(s) across ${stillOwed.size} script(s), and ${below.length} migration(s) below reversal-note floor ${String(floor).padStart(4, '0')}.`,
  ...(worst.length ? [`  Owed the most: ${worst.map(([n, r]) => `${n} (${r.length})`).join(', ')}`] : []),
  '  These are DEBT, not the standard. A new script must comply; the list may only shrink.',
  ...(problems.length ? [] : ['  No new violations.']),
].join('\n'));

if (problems.length) {
  console.error(`\nRelease discipline: ${problems.length} problem(s).\n\n${problems.map((p) => `  - ${p}\n`).join('\n')}`);
  process.exit(1);
}
