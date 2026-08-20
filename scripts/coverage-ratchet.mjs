#!/usr/bin/env node
// ----------------------------------------------------------------------------
// coverage-ratchet — measure test coverage PER AREA and refuse to let any area
// go backwards.
//
// WHY THIS EXISTS. This repo grew 570k lines of non-test code in four months.
// Every rule it has lives in prose (CLAUDE.md), and prose is what gets skipped
// by whoever is in a hurry. Coverage is the one property that can be measured
// mechanically, so it is the one worth wiring to a gate.
//
// WHY PER AREA. One global percentage lets a well-tested area subsidise an
// untested one — which is how backend/src/scm/routes stayed thin while
// scm/shared looked healthy. Each area carries its own floor.
//
// TWO FLOORS, both one-directional:
//   · line coverage %      may only go UP
//   · files with NO test   may only go DOWN
// The second exists because the first cannot see the shape that hurts: adding a
// 400-line untested money module to a 291k-line area moves the percentage by
// 0.1 and sails through, but moves the no-test count by exactly 1.
//
// USAGE
//   node scripts/coverage-ratchet.mjs --check  --report <coverage-final.json>...
//   node scripts/coverage-ratchet.mjs --update --report <coverage-final.json>...
//   node scripts/coverage-ratchet.mjs --update --allow-drop ...   (lowering a floor
//                                                                  is deliberate + loud)
//
// Produce the inputs with:
//   npm --prefix backend  run test:coverage      -> backend/coverage/coverage-final.json
//   npm --prefix frontend run test:coverage      -> frontend/coverage/coverage-final.json
// In CI the backend suite is sharded, so pass every shard's report — they are
// merged by summing hits, and reports from different trees are REFUSED.
//
// NO DEPENDENCIES: `npm install` in a worktree destroys the main checkout's
// node_modules, so a checker that needs one is a checker nobody runs.
// ----------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { AREAS, REPO_ROOT, areaOf, listAreaFiles } from './coverage-areas.mjs';
import {
  FATAL,
  VERDICT,
  evaluate,
  formatTable,
  mergeCoverage,
  nextBaseline,
  renderDocTable,
  spliceDocTable,
  summarise,
} from './lib/coverage-verdict.mjs';

const BASELINE_PATH = path.join(REPO_ROOT, 'coverage-baseline.json');
const DOC_PATH = path.join(REPO_ROOT, 'docs/TESTING-RATCHET.md');
const PROJECT_DIRS = ['backend/', 'frontend/'];

function parseArgs(argv) {
  const out = { reports: [], only: [], mode: null, allowDrop: false, baseline: BASELINE_PATH };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--check') out.mode = 'check';
    else if (a === '--update') out.mode = 'update';
    else if (a === '--sync-docs') out.mode = 'sync-docs';
    else if (a === '--check-docs') out.mode = 'check-docs';
    else if (a === '--allow-drop') out.allowDrop = true;
    else if (a === '--report') out.reports.push(argv[++i]);
    else if (a === '--only') out.only.push(argv[++i]);
    else if (a === '--baseline') out.baseline = argv[++i];
    else if (a.startsWith('--report=')) out.reports.push(a.slice('--report='.length));
    else if (a.startsWith('--only=')) out.only.push(a.slice('--only='.length));
    else {
      console.error(`coverage-ratchet: unknown argument ${a}`);
      process.exit(2);
    }
  }
  return out;
}

/**
 * Absolute coverage-report key -> repo-relative path.
 *
 * Reports are produced wherever the run happened (/home/runner/work/... in CI,
 * a worktree locally), so the absolute prefix is never the same twice. Anchor on
 * the LAST occurrence of a project directory so a checkout path that itself
 * contains "frontend" cannot capture a backend file.
 */
export function toRepoRelative(abs) {
  const p = abs.split(path.sep).join('/');
  let best = -1;
  let bestDir = null;
  for (const dir of PROJECT_DIRS) {
    const i = p.lastIndexOf(`/${dir}`);
    if (i > best) {
      best = i;
      bestDir = dir;
    }
  }
  if (best < 0) return null;
  return p.slice(best + 1);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`coverage-ratchet: cannot read ${file}: ${err.message}`);
    process.exit(2);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.mode) {
    console.error('coverage-ratchet: pass --check, --update, --sync-docs or --check-docs');
    process.exit(2);
  }

  /* The doc modes read the COMMITTED baseline only — no coverage report, no
     suite run — so ci.yml can keep docs/TESTING-RATCHET.md honest on every PR
     for the price of reading two files. */
  if (args.mode === 'sync-docs' || args.mode === 'check-docs') {
    if (!fs.existsSync(args.baseline)) {
      console.error(`coverage-ratchet: FATAL — ${args.baseline} does not exist; there is no number to publish.`);
      process.exit(1);
    }
    const doc = fs.readFileSync(DOC_PATH, 'utf8');
    let next;
    try {
      next = spliceDocTable(doc, renderDocTable(readJson(args.baseline)));
    } catch (err) {
      console.error(`coverage-ratchet: FATAL — ${err.message}`);
      process.exit(1);
    }
    if (args.mode === 'sync-docs') {
      fs.writeFileSync(DOC_PATH, next);
      console.log(`synced docs/TESTING-RATCHET.md from ${path.relative(REPO_ROOT, args.baseline)}`);
      return;
    }
    if (next !== doc) {
      console.error(
        'coverage-ratchet: FATAL — docs/TESTING-RATCHET.md does not match coverage-baseline.json.\n' +
          '  A typed number in a doc goes stale and every session believes it. Regenerate:\n' +
          '    node scripts/coverage-ratchet.mjs --sync-docs',
      );
      process.exit(1);
    }
    console.log('coverage-ratchet: docs/TESTING-RATCHET.md matches the committed baseline.');
    return;
  }

  // A gate whose own scan found nothing must SAY SO. Pointed at a moved or
  // misspelled artifact directory, silence is the failure mode that makes a
  // gate useless, and it is the one nobody notices.
  const existing = args.reports.filter((f) => fs.existsSync(f));
  if (existing.length === 0) {
    console.error(
      `coverage-ratchet: FATAL (${FATAL.NO_REPORTS}) — no coverage report was found.\n` +
        `  looked for: ${args.reports.length ? args.reports.join(', ') : '(none passed)'}\n` +
        `  A gate with no input is not a passing gate. Run the suites with coverage first.`,
    );
    process.exit(1);
  }
  if (existing.length !== args.reports.length) {
    const gone = args.reports.filter((f) => !fs.existsSync(f));
    console.error(`coverage-ratchet: FATAL — ${gone.length} named report(s) do not exist: ${gone.join(', ')}`);
    process.exit(1);
  }

  const maps = [];
  for (const file of existing) {
    const raw = readJson(file);
    const rel = {};
    let unmapped = 0;
    for (const [abs, cov] of Object.entries(raw)) {
      const r = toRepoRelative(abs);
      if (!r) {
        unmapped += 1;
        continue;
      }
      rel[r] = cov;
    }
    if (unmapped) {
      console.error(
        `coverage-ratchet: FATAL — ${unmapped} entries in ${file} sit under neither backend/ nor frontend/. ` +
          `The report was produced somewhere this gate does not understand.`,
      );
      process.exit(1);
    }
    console.log(`read ${file}: ${Object.keys(rel).length} files`);
    maps.push(rel);
  }

  let merged;
  try {
    merged = mergeCoverage(maps);
  } catch (err) {
    console.error(`coverage-ratchet: FATAL (${err.code ?? 'merge'}) — ${err.message}`);
    process.exit(1);
  }

  /* --only narrows the run to the areas whose reports are actually in hand. The
     backend suite is expensive to instrument (workerd + istanbul), so the PR job
     measures the frontend and the full sweep runs on its own schedule; without
     this the PR job would report every backend area as an EMPTY SCAN and fail
     for a reason that is not a regression. An unknown id is a typo, and a typo
     that silently checks nothing is the failure this whole file exists to
     prevent — so it is fatal. */
  const unknown = args.only.filter((id) => !AREAS.some((a) => a.id === id));
  if (unknown.length) {
    console.error(
      `coverage-ratchet: FATAL (${FATAL.UNKNOWN_AREA}) — --only names no such area: ${unknown.join(', ')}\n` +
        `  known areas: ${AREAS.map((a) => a.id).join(', ')}`,
    );
    process.exit(1);
  }
  const areas = args.only.length ? AREAS.filter((a) => args.only.includes(a.id)) : AREAS;
  console.log(`checking ${areas.length} of ${AREAS.length} areas: ${areas.map((a) => a.id).join(', ')}`);
  const inScope = (rel) => {
    const a = areaOf(rel);
    return a && areas.includes(a) ? a : null;
  };

  const onDisk = {};
  for (const area of areas) onDisk[area.id] = listAreaFiles(area);

  /* A MISSING BASELINE IS FATAL IN --check, never an empty one.
     This used to fall back to `{ areas: {}, knownAbsent: [] }`, which is a gate
     with no floors: every area is compared against nothing. It was not a
     hypothetical fallback either — REPO_ROOT was built from a file URL's
     `pathname` and came out as `C:\C:\Users\...` on Windows, so the committed
     baseline sat two directories the process could not see and this branch was
     the ONE that ran, on every local run, for as long as the path bug lived.
     See coverage-areas.mjs.

     `--update` is allowed to bootstrap one, because writing it is that mode's
     whole job — but it says so on stdout rather than doing it quietly. */
  if (!fs.existsSync(args.baseline)) {
    if (args.mode === 'check') {
      console.error(
        `coverage-ratchet: FATAL (${FATAL.NO_BASELINE}) — no baseline at ${args.baseline}\n` +
          `  REPO_ROOT resolved to: ${REPO_ROOT}\n` +
          `  Every area would be measured against no floor at all, and this gate would\n` +
          `  report a pass having enforced nothing. A check that did not execute is not\n` +
          `  a check. Create one with: node scripts/coverage-ratchet.mjs --update ...`,
      );
      process.exit(1);
    }
    console.log(`no baseline at ${args.baseline} — --update will CREATE one; every floor below is new.`);
  }
  const baseline = fs.existsSync(args.baseline)
    ? readJson(args.baseline)
    : { areas: {}, knownAbsent: [] };

  /* knownAbsent entries carry a `why` so the escape hatch cannot be used
     silently — an unexplained absence is still fatal, and the explanation is in
     the diff where a reviewer sees it. */
  const knownAbsent = (baseline.knownAbsent ?? []).map((e) => (typeof e === 'string' ? e : e.file));
  const summary = summarise(merged, areas, inScope, onDisk, knownAbsent);

  console.log('');
  console.log(formatTable(summary, baseline));
  console.log('');
  console.log(
    `(unratcheted: ${summary.unratcheted.files} files, ${summary.unratcheted.lines.total} lines, ` +
      `${summary.unratcheted.pct.toFixed(2)}% — measured, not gated)`,
  );
  console.log('');

  if (args.mode === 'update') {
    if (summary.fatal.length) {
      for (const f of summary.fatal) console.error(`FATAL (${f.code}) ${f.area}: ${f.message}`);
      console.error('coverage-ratchet: refusing to write a baseline from a scan that failed its own sanity checks.');
      process.exit(1);
    }
    const { baseline: next, drops } = nextBaseline(summary, baseline, { allowDrop: args.allowDrop });
    for (const d of drops) {
      console.error(args.allowDrop ? `LOWERING FLOOR (--allow-drop): ${d}` : `floor held (would have dropped): ${d}`);
    }
    next.measuredAt = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(args.baseline, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`wrote ${path.relative(REPO_ROOT, args.baseline)}`);
    // Publish the number in the same command that measured it, or the doc is
    // stale from the moment the baseline moves.
    fs.writeFileSync(DOC_PATH, spliceDocTable(fs.readFileSync(DOC_PATH, 'utf8'), renderDocTable(next)));
    console.log('synced docs/TESTING-RATCHET.md');
    return;
  }

  const verdict = evaluate(summary, baseline);
  for (const f of verdict.fatal) console.error(`FATAL (${f.code}) ${f.area}: ${f.message}`);
  for (const r of verdict.results) {
    if (r.verdict === VERDICT.PASS) continue;
    console.error(`FAIL ${r.area}:`);
    for (const m of r.failures ?? [r.message]) console.error(`  - ${m}`);
  }
  if (!verdict.ok) {
    console.error('');
    console.error('coverage-ratchet: an area went backwards. Add a test for what you changed, or');
    console.error('re-baseline deliberately with: node scripts/coverage-ratchet.mjs --update --allow-drop ...');
    process.exit(1);
  }
  console.log('coverage-ratchet: every area held its floor.');
}

/* pathToFileURL, not string concatenation. `file://${process.argv[1]}` builds
   `file://C:\Users\...` on Windows while import.meta.url is
   `file:///C:/Users/...` — different slash count, different separators, never
   equal. So main() was NEVER CALLED on Windows and the script exited 0 having
   done nothing: `coverage:check` reported success without reading a single
   report. Linux CI matched by luck (a POSIX path starts with `/`, so the
   concatenation happens to produce three slashes), which is why it survived.

   Same shape as the ESLint spawn bug in BUG-HISTORY 2026-08-14: a gate that is
   silently a no-op on the OS this repo is developed on, green on CI throughout.
   A check that cannot run must not be able to report a pass. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
