#!/usr/bin/env node
// ----------------------------------------------------------------------------
// lint-ratchet.mjs — the gate behind `npm run lint`.
//
// WHY A RATCHET AND NOT A PLAIN `eslint --max-warnings 0`. This repo got its
// first linter today, on a tree with 2,618 `no-unnecessary-condition` findings
// in backend/src alone. A gate that goes red on 6,000 pre-existing sites is a
// gate somebody deletes within a day, and then there is no lint layer again. So
// every rule ships as a WARNING and this script holds a per-file CEILING that
// may only FALL:
//
//   * an ESLint ERROR (parse failure, unknown rule in a disable directive)
//     always fails — those are not opinions;
//   * a file whose count for a rule is ABOVE its ceiling fails, and the exact
//     file:line of every finding over the line is printed;
//   * a file with NO ceiling entry has a ceiling of ZERO. A new file, or a rule
//     that is clean across the tree today, therefore fails on its first
//     violation — an error in everything but the word;
//   * a file whose count is BELOW its ceiling is reported as slack to reclaim.
//     `npm run lint:update` rewrites the ceilings down.
//
// Nothing here mutates the ceiling on its own. Lowering it is a commit, so the
// number in git is always a number somebody chose. `--update` REFUSES to raise
// a ceiling that already exists — it writes them down, and gives a starting
// number only to a pair that has none. See the block at `if (update)`.
//
// NO DEPENDENCIES (node: builtins only). It runs under `working-directory:
// backend` in CI, where only backend/node_modules exists, and it resolves the
// ESLint binary out of the app it is linting.
//
// Usage, from inside backend/ or frontend/:
//   node ../scripts/lint-ratchet.mjs              # gate
//   node ../scripts/lint-ratchet.mjs --update     # rewrite the ceilings
// ----------------------------------------------------------------------------
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

const cwd = process.cwd();
const update = process.argv.includes('--update');
const appName = cwd.split(sep).pop();
const ratchetPath = resolve(cwd, 'eslint-ratchet.json');

// Read the committed ceilings BEFORE anything can rewrite them, so `--update`
// still prints the honest before/after instead of comparing the new file to
// itself.
const committed = existsSync(ratchetPath)
  ? JSON.parse(readFileSync(ratchetPath, 'utf8'))
  : { totals: {}, files: {} };

/* Run ESLint's OWN JS entry under this node, never the .bin shim.
   `.bin/eslint` is a POSIX shell script and is not executable on Windows;
   `.bin/eslint.cmd` exists there but Node refuses to spawn a .cmd without a
   shell (CVE-2024-27980), so the two obvious spellings fail with a bare ENOENT
   and then EINVAL. existsSync is happy with both, which is what made this look
   like a missing install rather than a spawn problem — the linter was simply
   unrunnable on Windows while CI (Linux) stayed green. Same shape as the
   shebang trap in CLAUDE.md: a failure only the developer's machine sees, on
   the OS this repo is actually developed on.

   Going through bin/eslint.js needs no shell, so nothing is quoted and nothing
   is interpreted. */
const eslintEntry = resolve(cwd, 'node_modules', 'eslint', 'bin', 'eslint.js');
if (!existsSync(eslintEntry)) {
  fail(
    `No ESLint in ${appName}/node_modules. Run \`npm ci\` in ${appName}/ first.\n` +
      `(Looked for ${eslintEntry})`,
  );
}

// The globs the config's own `files` entries cover. Passing them explicitly
// keeps the CLI from walking dist/ and node_modules before the ignore list
// prunes them, and makes the target of this run visible in the CI log.
const TARGETS = {
  backend: ['src/**/*.ts'],
  frontend: ['src/**/*.ts', 'src/**/*.tsx'],
};
const targets = TARGETS[appName];
if (!targets) {
  fail(
    `lint-ratchet does not know how to lint "${appName}". Add it to TARGETS in ` +
      `scripts/lint-ratchet.mjs (this script is run from inside the app directory).`,
  );
}

const outDir = mkdtempSync(join(tmpdir(), 'houzs-lint-'));
const outFile = join(outDir, 'eslint.json');
let report;
try {
  console.log(`[lint] ${appName}: eslint ${targets.join(' ')}`);
  const started = Date.now();
  const run = spawnSync(
    process.execPath,
    [eslintEntry, ...targets, '-f', 'json', '-o', outFile],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  // 0 = clean, 1 = lint errors present, 2 = ESLint itself failed (bad config,
  // unreadable tsconfig, no matching files). Only 2 is unrecoverable here —
  // severity-2 messages are handled below, from the report.
  if (run.status === 2 || run.error) {
    fail(
      `ESLint could not run.\n${run.stderr || ''}${run.stdout || ''}${run.error ? run.error.message : ''}`,
    );
  }
  if (!existsSync(outFile)) fail(`ESLint produced no report.\n${run.stderr || ''}`);
  report = JSON.parse(readFileSync(outFile, 'utf8'));
  console.log(
    `[lint] ${appName}: ${report.length} files linted in ${((Date.now() - started) / 1000).toFixed(1)}s`,
  );
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

// ── Fold the report into { file -> { rule -> count } } ──────────────────────
const counts = Object.create(null);
const linesByFileRule = Object.create(null);
const hardErrors = [];
let totalWarnings = 0;

for (const file of report) {
  const rel = relFromApp(file.filePath);
  for (const m of file.messages) {
    const rule = m.ruleId ?? '(fatal)';
    if (m.severity === 2) {
      hardErrors.push(`${rel}:${m.line ?? 0}:${m.column ?? 0}  ${rule}  ${m.message}`);
      continue;
    }
    totalWarnings += 1;
    (counts[rel] ??= Object.create(null))[rule] = (counts[rel]?.[rule] ?? 0) + 1;
    (linesByFileRule[`${rel}\0${rule}`] ??= []).push(
      `${rel}:${m.line}:${m.column}  ${m.message.split('\n')[0]}`,
    );
  }
}

const perRule = Object.create(null);
for (const rules of Object.values(counts)) {
  for (const [rule, n] of Object.entries(rules)) perRule[rule] = (perRule[rule] ?? 0) + n;
}

// ── --update: rewrite the ceilings from this run and stop ───────────────────
//
// It may write a ceiling DOWN, and it may give a STARTING number to a pair that
// has none — a file the manifest has never seen, or a rule just added to the
// config, which appears nowhere in `totals`. It may NOT write an existing
// ceiling UP. CLAUDE.md states the rule in prose: "`npm run lint:update` exists
// to write the ceilings DOWN after you fix things; using it to write them up is
// forging the evidence the gate exists to check."
//
// Until 2026-08-14 this block wrote `counts` wholesale, so it was prose only.
// Re-baselining against a moved main silently raised every ceiling main had
// grown past — measured: three of them (categories.ts 5->6,
// mfg-products.ts no-explicit-any 3->4, sku-usage.ts 1->2) on the merge that
// brought #2127 in, in a run that printed nothing but "wrote 319 file ceilings"
// and exited 0. The gate's own tool undoing the gate is the whole failure mode
// this file exists to prevent, so the refusal is now mechanical.
if (update) {
  const knownRule = (rule) => rule in (committed.totals ?? {});
  const knownFile = (file) => file in (committed.files ?? {});
  const raises = [];
  const adopted = [];
  for (const [file, rules] of Object.entries(counts)) {
    for (const [rule, n] of Object.entries(rules)) {
      // No committed ceiling to raise: a new file, or a rule new to the whole
      // manifest. This is how either gets its first number — the gate still
      // reads a missing entry as zero until it is written.
      if (!knownRule(rule) || !knownFile(file)) {
        adopted.push({ file, rule, n });
        continue;
      }
      const ceiling = committed.files[file][rule] ?? 0;
      if (n > ceiling) raises.push({ file, rule, n, ceiling });
    }
  }

  if (raises.length) {
    printRuleTable();
    console.error(`\n[lint] ${appName}: REFUSING to write — ${raises.length} ceiling(s) would go UP.\n`);
    for (const r of raises) {
      console.error(`  ${r.file}\n    ${r.rule}: ceiling ${r.ceiling}, now ${r.n}`);
      for (const line of (linesByFileRule[`${r.file}\0${r.rule}`] ?? []).slice(0, 10)) {
        console.error(`      ${line}`);
      }
    }
    console.error(
      '\n  A ceiling that goes up is not a ceiling. Fix the finding, or write\n' +
        '  `eslint-disable-next-line <rule> -- <reason>` at the site so the reason\n' +
        `  lives next to the code, then run this again. ${appName}/eslint-ratchet.json\n` +
        '  was NOT written.\n',
    );
    process.exit(1);
  }

  const files = Object.create(null);
  for (const f of Object.keys(counts).sort()) {
    files[f] = Object.fromEntries(Object.entries(counts[f]).sort(([a], [b]) => a.localeCompare(b)));
  }
  writeFileSync(
    ratchetPath,
    `${JSON.stringify(
      {
        _readme:
          'CEILINGS, NOT TARGETS. Generated by `npm run lint:update`; enforced by ' +
          'scripts/lint-ratchet.mjs. A count may only FALL. A file absent from ' +
          '`files` has a ceiling of ZERO for every rule, so a new file — or a rule ' +
          'that is clean across the tree — fails on its first violation. Never raise ' +
          'a number here to make a build pass: fix the finding, or add an ' +
          '`eslint-disable-next-line <rule> -- <reason>` at the site so the reason is ' +
          'next to the code.',
        totals: Object.fromEntries(Object.entries(perRule).sort(([a], [b]) => a.localeCompare(b))),
        files,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`[lint] ${appName}: wrote ${Object.keys(files).length} file ceilings to eslint-ratchet.json`);
  // A re-baseline that prints only a file count is unreviewable. Name every
  // pair that had no ceiling and now has one — that is the only direction a
  // number is allowed to move up, so it is the one that has to be visible.
  if (adopted.length) {
    console.log(
      `[lint] ${appName}: ${adopted.length} file/rule pair(s) had no ceiling and got a starting number:`,
    );
    for (const a of adopted.slice(0, 20)) console.log(`         ${a.file}  ${a.rule}: 0 -> ${a.n}`);
    if (adopted.length > 20) console.log(`         … and ${adopted.length - 20} more`);
  }
  printRuleTable();
  process.exit(0);
}

// ── Gate ────────────────────────────────────────────────────────────────────
const baseline = committed.files ?? {};

const over = [];
const under = [];
for (const [file, rules] of Object.entries(counts)) {
  for (const [rule, n] of Object.entries(rules)) {
    const ceiling = baseline[file]?.[rule] ?? 0;
    if (n > ceiling) over.push({ file, rule, n, ceiling });
    else if (n < ceiling) under.push({ file, rule, n, ceiling });
  }
}
for (const [file, rules] of Object.entries(baseline)) {
  for (const [rule, ceiling] of Object.entries(rules)) {
    const n = counts[file]?.[rule] ?? 0;
    if (n < ceiling && !under.some((u) => u.file === file && u.rule === rule)) {
      under.push({ file, rule, n, ceiling });
    }
  }
}

printRuleTable();

if (under.length) {
  const slack = under.reduce((a, u) => a + (u.ceiling - u.n), 0);
  console.log(
    `\n[lint] ${appName}: ${under.length} ceiling(s) are now too high by ${slack} finding(s) — ` +
      'run `npm run lint:update` and commit to lock the improvement in.',
  );
  for (const u of under.slice(0, 15)) {
    console.log(`         ${u.file}  ${u.rule}: ${u.ceiling} -> ${u.n}`);
  }
  if (under.length > 15) console.log(`         … and ${under.length - 15} more`);
}

if (hardErrors.length) {
  console.error(`\n[lint] ${appName}: ${hardErrors.length} ESLint ERROR(s) — these never ratchet:`);
  for (const e of hardErrors.slice(0, 40)) console.error(`         ${e}`);
  if (hardErrors.length > 40) console.error(`         … and ${hardErrors.length - 40} more`);
}

if (over.length) {
  console.error(`\n[lint] ${appName}: RATCHET BROKEN — ${over.length} file/rule pair(s) above ceiling.\n`);
  for (const o of over) {
    console.error(
      `  ${o.file}\n    ${o.rule}: ${o.n} (ceiling ${o.ceiling})` +
        (o.ceiling === 0 ? '  <- no ceiling: this rule is clean here, keep it that way' : ''),
    );
    for (const line of (linesByFileRule[`${o.file}\0${o.rule}`] ?? []).slice(0, 10)) {
      console.error(`      ${line}`);
    }
  }
  console.error(
    '\n  Fix the finding, or put an `eslint-disable-next-line <rule> -- <reason>` at the\n' +
      '  site so the reason lives next to the code. Do NOT raise the number in\n' +
      `  ${appName}/eslint-ratchet.json — a ceiling that goes up is not a ceiling.\n`,
  );
}

/* --advisory: REPORT the findings above, then exit 0.

   Why this and not the job-level `continue-on-error` it replaces: measured
   2026-08-14, `continue-on-error` stops the workflow failing but GitHub still
   publishes the job's check run as FAILURE, so the red X stays. A permanently
   red check is one everyone learns to ignore — the exact outcome a ratchet is
   built to prevent — so the suppression has to happen where the verdict is
   made, not around it.

   HARD ERRORS ARE NEVER ADVISORY. If ESLint could not run, or the config is
   broken, that is not "debt we are carrying", it is a gate that did not
   execute, and a gate that cannot run must never report a pass.

   Passed ONLY by ci.yml, only for the backend leg. A developer running
   `npm --prefix backend run lint` locally still gets exit 1 and the truth. */
const advisory = process.argv.includes('--advisory');
if (hardErrors.length) process.exit(1);
if (over.length) {
  if (!advisory) process.exit(1);
  console.error(
    `[lint] ${appName}: ADVISORY — ${over.length} pair(s) above ceiling, reported and NOT failed.\n` +
      '  This leg is advisory because its debt is inherited, not introduced here.\n' +
      '  See the `lint:` job comment in ci.yml for the condition that removes it.\n',
  );
  process.exit(0);
}
console.log(`\n[lint] ${appName}: OK — ${totalWarnings} warning(s), all at or under ceiling.`);

// ── helpers ─────────────────────────────────────────────────────────────────
function printRuleTable() {
  const baselineTotals = committed.totals ?? {};
  const rules = [...new Set([...Object.keys(perRule), ...Object.keys(baselineTotals)])].sort();
  const w = Math.max(4, ...rules.map((r) => r.length));
  console.log(`\n[lint] ${appName}: per-rule totals (ceiling -> now)`);
  for (const r of rules) {
    const now = perRule[r] ?? 0;
    const was = baselineTotals[r] ?? 0;
    const flag = now > was ? ' UP' : now < was ? ' down' : '';
    console.log(`         ${r.padEnd(w)}  ${String(was).padStart(5)} -> ${String(now).padStart(5)}${flag}`);
  }
  if (!rules.length) console.log('         (no findings)');
}

function relFromApp(abs) {
  // Report paths relative to the app directory, POSIX-separated, so the ratchet
  // file is identical on macOS, Linux and Windows.
  return resolve(abs).slice(cwd.length + 1).split(sep).join('/');
}

function fail(msg) {
  console.error(`[lint] ${msg}`);
  process.exit(1);
}
