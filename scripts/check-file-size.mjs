#!/usr/bin/env node
// File-size ratchet gate.
//
// The rules, and why they are shaped this way, are written out in
// scripts/lib/file-size-ratchet.mjs — that file is the specification. This one
// is the I/O around it: find the files, count the lines, print a verdict.
//
// Short version: files already over 2,000 lines carry a recorded ceiling and may
// only SHRINK; every other file is capped at 2,000. Nothing here splits a big
// file — that is a refactor with real risk. This only stops it growing.
//
// Usage:
//   node scripts/check-file-size.mjs                  # the gate (CI + local)
//   node scripts/check-file-size.mjs --update         # lower ceilings after a shrink
//   node scripts/check-file-size.mjs --list           # ten largest + their ceilings
//   node scripts/check-file-size.mjs --require-base   # CI: enforce "may only fall"
//
// Run locally before pushing: `npm run check:file-size`
//
// ---------------------------------------------------------------------------
// WHY THE ZERO-FILE CHECK BELOW IS NOT PARANOIA
//
// This gate finds its inputs with `git ls-files` from the repo root. Move a
// source tree, run it from the wrong directory, or ship it in a job whose
// checkout is shallow-but-empty, and the scan matches nothing. A scanner that
// measures nothing reports no violations, and a gate that reports no violations
// is GREEN. It would sit there passing every PR forever while enforcing nothing,
// and the failure is completely silent — there is no error, just an empty set.
// So: fewer than MIN_EXPECTED_FILES scanned is a hard failure, on the grounds
// that this repo cannot legitimately drop to a handful of source files.

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';
import {
  NEW_FILE_LIMIT,
  SOURCE_EXTENSIONS,
  GENERATED_HEADER_LINES,
  isGeneratedHeader,
  ceilingFor,
  verdict,
  lowerCeilings,
  findRaisedCeilings,
} from './lib/file-size-ratchet.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');
const MANIFEST_REL = 'scripts/file-size-ceilings.json';
const MANIFEST_PATH = join(REPO_ROOT, MANIFEST_REL);

// A floor, not a target. The tree had ~2,000 source files on 2026-08-13; this
// trips only when the scan is broken, never when the repo has merely got smaller.
const MIN_EXPECTED_FILES = 200;

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const UPDATE = has('--update');
const LIST = has('--list');
const REQUIRE_BASE = has('--require-base');

function git(args, opts = {}) {
  return execFileSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', opts.quiet ? 'ignore' : 'inherit'],
  });
}

/** wc -l semantics exactly: count newline characters. */
function countLines(text) {
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

function scan() {
  const patterns = SOURCE_EXTENSIONS.map((e) => `*${e}`);
  const listed = git(['ls-files', '-z', '--', ...patterns])
    .split('\0')
    .filter(Boolean)
    // git ls-files always emits forward slashes; normalise for Windows callers
    // so manifest keys are identical on every platform.
    .map((p) => p.split(sep).join('/'));

  const measured = [];
  const generated = [];
  const unreadable = [];

  for (const path of listed) {
    let text;
    try {
      text = readFileSync(join(REPO_ROOT, path), 'utf8');
    } catch (err) {
      // A tracked-but-absent file means the working tree does not match the
      // index. Collected and reported rather than skipped in silence.
      unreadable.push({ path, err: err.code || String(err) });
      continue;
    }
    const lines = countLines(text);
    const head = text.split('\n', GENERATED_HEADER_LINES);
    if (isGeneratedHeader(head)) {
      generated.push({ path, lines });
      continue;
    }
    measured.push({ path, lines });
  }
  return { measured, generated, unreadable, listedCount: listed.length };
}

function readManifest() {
  try {
    const raw = readFileSync(MANIFEST_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.ceilings) return parsed.ceilings;
    return parsed || {};
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw new Error(`${MANIFEST_REL} is present but unreadable: ${err.message}`);
  }
}

/**
 * The manifest as of the merge base, for the "may only fall" check.
 *
 * Three outcomes, kept DISTINCT on purpose:
 *   { resolved: false }                — the merge base itself is unreachable
 *                                        (shallow clone, no origin/main). The
 *                                        check cannot run and CI should say so.
 *   { resolved: true, ceilings: null } — base reached, no manifest there. That
 *                                        is the commit that INTRODUCES the
 *                                        manifest; there is nothing to compare
 *                                        and that is not a failure.
 *   { resolved: true, ceilings: {...} } — compare.
 *
 * Collapsing the middle case into the first is how a brand-new gate fails its
 * own introducing PR, which is the fastest way to get a gate deleted.
 */
/** The files THIS change touches, against the merge base, or null when the base
 *  cannot be resolved — in which case every violation is charged, because a
 *  gate that cannot tell whose fault it is must not let anything through. */
function changedFilesAgainstBase() {
  try {
    git(['rev-parse', '--verify', '--quiet', 'origin/main'], { quiet: true });
    const base = git(['merge-base', 'HEAD', 'origin/main'], { quiet: true }).trim();
    if (!base) return null;
    const out = git(['diff', '--name-only', '-z', `${base}...HEAD`], { quiet: true });
    return new Set(out.split('\0').filter(Boolean));
  } catch {
    return null;
  }
}

function readBaseManifest() {
  let base;
  try {
    git(['rev-parse', '--verify', '--quiet', 'origin/main'], { quiet: true });
    base = git(['merge-base', 'HEAD', 'origin/main'], { quiet: true }).trim();
  } catch {
    return { resolved: false };
  }
  if (!base) return { resolved: false };
  let raw;
  try {
    raw = git(['show', `${base}:${MANIFEST_REL}`], { quiet: true });
  } catch {
    // Base is reachable; it simply predates the manifest.
    return { resolved: true, ceilings: null };
  }
  try {
    const parsed = JSON.parse(raw);
    return { resolved: true, ceilings: parsed && parsed.ceilings ? parsed.ceilings : parsed || {} };
  } catch (err) {
    // Present but corrupt at the base — that must not silently disable the check.
    console.error(`file-size ratchet: merge-base ${MANIFEST_REL} is unparseable: ${err.message}`);
    return { resolved: false };
  }
}

function writeManifest(ceilings) {
  const body = {
    $comment: [
      'GENERATED by scripts/check-file-size.mjs --update. Ceilings may only FALL.',
      `Files at or under ${NEW_FILE_LIMIT} lines are not listed; that is the cap for everything else.`,
      'Raising a number here fails CI (findRaisedCeilings). Shrink the file instead.',
    ],
    newFileLimit: NEW_FILE_LIMIT,
    ceilings,
  };
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(body, null, 2)}\n`);
}

function fmt(n) {
  return String(n).padStart(6);
}

function main() {
  const { measured, generated, unreadable, listedCount } = scan();

  // ---- the loud zero-scan failure ------------------------------------------
  if (listedCount < MIN_EXPECTED_FILES) {
    console.error('FILE-SIZE GATE: SCAN FOUND (almost) NOTHING — this is a broken gate, not a pass.');
    console.error(`  git ls-files matched ${listedCount} file(s); expected at least ${MIN_EXPECTED_FILES}.`);
    console.error(`  cwd=${process.cwd()} repoRoot=${REPO_ROOT}`);
    console.error('  Causes: run outside the repo, a moved source tree, or a checkout without a work tree.');
    console.error('  Refusing to report success on an empty scan.');
    process.exit(2);
  }
  if (measured.length === 0) {
    console.error('FILE-SIZE GATE: every scanned file was skipped as generated. Refusing to pass.');
    process.exit(2);
  }
  if (unreadable.length) {
    console.error('FILE-SIZE GATE: tracked files could not be read:');
    for (const u of unreadable) console.error(`  ${u.path} (${u.err})`);
    process.exit(2);
  }

  const ceilings = readManifest();

  if (UPDATE) {
    const next = lowerCeilings(measured, ceilings, NEW_FILE_LIMIT);
    const before = Object.keys(ceilings).length;
    const changes = [];
    for (const [p, v] of Object.entries(next)) {
      if (!(p in ceilings)) changes.push(`  + ${p} -> ${v} (newly recorded)`);
      else if (v < ceilings[p]) changes.push(`  v ${p} ${ceilings[p]} -> ${v}`);
    }
    for (const p of Object.keys(ceilings)) {
      if (!(p in next)) changes.push(`  - ${p} (at or under ${NEW_FILE_LIMIT}; now capped with everything else)`);
    }
    writeManifest(next);
    console.log(`file-size ceilings: ${before} -> ${Object.keys(next).length} entries`);
    console.log(changes.length ? changes.join('\n') : '  (no change)');
    return;
  }

  const v = verdict(measured, ceilings, NEW_FILE_LIMIT);
  const sorted = [...measured].sort((a, b) => b.lines - a.lines);

  if (LIST) {
    console.log(`Ten largest source files (of ${measured.length} scanned, ${generated.length} generated-skipped):\n`);
    console.log('  lines  ceiling  file');
    for (const f of sorted.slice(0, 10)) {
      console.log(`${fmt(f.lines)}  ${fmt(ceilingFor(f.path, ceilings, NEW_FILE_LIMIT))}  ${f.path}`);
    }
    return;
  }

  console.log(
    `file-size ratchet: ${measured.length} source files scanned, ` +
      `${generated.length} skipped as generated, ` +
      `${Object.keys(ceilings).length} carrying a ceiling, cap ${NEW_FILE_LIMIT}.`,
  );

  // ---- may-only-fall -------------------------------------------------------
  const base = readBaseManifest();
  if (!base.resolved) {
    const msg =
      'file-size ratchet: merge base unreachable — the "ceilings may only fall" check DID NOT RUN.';
    if (REQUIRE_BASE) {
      console.error(msg);
      console.error('  --require-base was passed, so this is fatal. CI needs fetch-depth: 0 and origin/main.');
      process.exit(2);
    }
    console.warn(`${msg} (shallow clone, or no origin/main locally.)`);
  } else if (base.ceilings === null) {
    console.log(
      `file-size ratchet: the merge base has no ${MANIFEST_REL} — this commit introduces it, ` +
        'so there is no previous ceiling to compare against.',
    );
  } else {
    const raised = findRaisedCeilings(base.ceilings, ceilings, NEW_FILE_LIMIT);
    if (raised.length) {
      console.error('\nFILE-SIZE GATE FAILED: a ceiling may only fall.\n');
      for (const r of raised) {
        console.error(
          r.from === null
            ? `  ${r.path}: newly grandfathered at ${r.to} lines`
            : `  ${r.path}: ${r.from} -> ${r.to} (raised by ${r.to - r.from})`,
        );
      }
      console.error('\nThe manifest records what a file ALREADY was. Editing the number up defeats');
      console.error('the ratchet — shrink the file, or move the new code into its own module.');
      process.exit(1);
    }
  }

  // ---- the ceilings themselves ---------------------------------------------
  /* BLAME THE PR THAT GREW THE FILE, not whichever PR runs next.
     This gate is not one of the ruleset's required checks, so a PR can and does
     merge with it red — and then EVERY open branch inherits the violation and
     cannot merge until someone else's file shrinks. That happened on
     2026-08-14: `grns.ts` went 109 lines over on main and blocked a production
     fix that never opened the file.
     A violation in a file this change does not touch is still REPORTED, in
     full, with its numbers — silence would let the tree drift — but only the
     files in this diff can fail the run. */
  const touched = changedFilesAgainstBase();
  const mine = touched === null ? v.violations : v.violations.filter((x) => touched.has(x.path));
  const inherited = v.violations.filter((x) => !mine.includes(x));

  if (inherited.length) {
    console.log(`\nOVER CEILING, but not touched by this change (${inherited.length}) — reported, not charged to this PR:`);
    for (const x of inherited.sort((a, b) => b.over - a.over)) {
      console.log(`  ${x.path}: ${x.lines} lines, ceiling ${x.ceiling} (over by ${x.over})`);
    }
    console.log('  Whoever grows a file owns its ceiling. Fix these where they were grown, or re-baseline.');
  }

  if (mine.length) {
    console.error('\nFILE-SIZE GATE FAILED\n');
    for (const x of mine.sort((a, b) => b.over - a.over)) {
      console.error(
        x.grandfathered
          ? `  ${x.path}\n      ${x.lines} lines, ceiling ${x.ceiling} (over by ${x.over}). This file may only SHRINK.`
          : `  ${x.path}\n      ${x.lines} lines, cap ${x.ceiling} (over by ${x.over}). New files must come in under ${NEW_FILE_LIMIT}.`,
      );
    }
    console.error('\nSplit the new code into its own module. Do NOT raise the ceiling: it is the');
    console.error('record of what the file already was, and it only moves down.');
    process.exit(1);
  }

  if (v.stale.length) {
    console.log(`\n${v.stale.length} manifest entr(y/ies) no longer exist — run --update to drop them:`);
    for (const p of v.stale) console.log(`  ${p}`);
  }
  if (v.belowLimit.length) {
    console.log(`\n${v.belowLimit.length} file(s) have fallen to/below ${NEW_FILE_LIMIT} — run --update to retire their ceilings:`);
    for (const x of v.belowLimit) console.log(`  ${x.path} (${x.lines}, ceiling ${x.ceiling})`);
  }
  if (v.shrunk.length) {
    const total = v.shrunk.reduce((s, x) => s + (x.ceiling - x.lines), 0);
    console.log(`\n${v.shrunk.length} file(s) are under their ceiling by ${total} lines total (slack the ratchet can take back with --update).`);
  }

  console.log('\nTen largest:');
  console.log('  lines  ceiling  file');
  for (const f of sorted.slice(0, 10)) {
    console.log(`${fmt(f.lines)}  ${fmt(ceilingFor(f.path, ceilings, NEW_FILE_LIMIT))}  ${f.path}`);
  }
  console.log('\nfile-size ratchet OK');
}

main();
