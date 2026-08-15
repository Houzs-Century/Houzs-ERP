#!/usr/bin/env node
// explain — answer a question about this repo by COMPUTING it from the source.
//
//   node scripts/explain.mjs                  list the questions
//   node scripts/explain.mjs <id>             answer one
//   node scripts/explain.mjs --all            answer all
//   node scripts/explain.mjs --check          CI gate: every question still computes
//   node scripts/explain.mjs --write          fill <!-- explain: id --> blocks in docs
//   node scripts/explain.mjs --check-docs     fail if a filled block has drifted
//
// WHY. Two problems, one mechanism.
//
// 1. THE SAME QUESTION GAVE DIFFERENT ANSWERS. Owner, 2026-08-14: *"现在有的问题
//    就是每次问的答案都不一样"*. It did, because the answer was re-derived by
//    reading code — two sweeps counted the same population as 632 and 1019, and
//    CLAUDE.md carried a required-check list that was simply wrong. An answer
//    that is computed is the same answer every time by construction, and
//    scripts/explain.test.mjs asserts exactly that: every question, three runs,
//    byte-identical.
//
// 2. DOCS DRIFTED FROM SOURCE. `codebase-map-facts.md` sat stale for three
//    weeks; this repo's own CLAUDE.md described the database as D1 SQLite for a
//    month after the Postgres cutover. `check-docs-drift` catches a claim whose
//    PATH is gone; it cannot catch a claim whose NUMBER is wrong. So a doc can
//    hold a block, `--write` fills it from source, and `--check-docs` fails when
//    the two disagree. A number inside such a block cannot go stale without a
//    red gate — which is the only reason to trust one.
//
// Every answer carries a DENOMINATOR and REFS. Not decoration: "76 modules have
// no guide" is unusable and unarguable; "76 of 141, here are the paths" can be
// checked by someone who does not believe it.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { QUESTIONS } from './lib/explain/questions.mjs';
import { ask, validateQuestion } from './lib/explain/registry.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);

/* Registration is itself checked. A question missing a denominator or a refs
   list is a question that could answer unfalsifiably, so it never loads. */
const bad = QUESTIONS.flatMap((q) => validateQuestion(q).map((p) => `  ${q?.id ?? '(no id)'}: ${p}`));
if (bad.length) {
  console.error('explain: these questions are not registerable:\n' + bad.join('\n'));
  process.exit(2);
}
const ids = QUESTIONS.map((q) => q.id);
const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
if (dupes.length) {
  console.error(`explain: duplicate question id(s): ${[...new Set(dupes)].join(', ')}`);
  process.exit(2);
}

/** The rendered answer, exactly as it goes into a doc block and onto stdout. */
export function render(q, a) {
  const lines = [a.value, ...(a.detail ?? []), `refs: ${a.refs.join(', ')}`];
  return lines.join('\n');
}

function printOne(q) {
  const a = ask(q, ROOT);
  console.log(`\n${q.question}`);
  console.log('-'.repeat(Math.min(q.question.length, 78)));
  console.log(render(q, a));
  console.log(`(computed from source by \`node scripts/explain.mjs ${q.id}\`)`);
}

// ---- doc blocks ------------------------------------------------------------

const BLOCK = (id) =>
  new RegExp(`(<!--\\s*explain:\\s*${id}\\s*-->)([\\s\\S]*?)(<!--\\s*/explain\\s*-->)`, 'g');

/**
 * Character ranges inside ``` fences. Filling a block that sits in one was the
 * first bug this tool shipped: docs/EXPLAIN.md shows an EMPTY block as the
 * example of how to write one, and `--write` promptly filled the example in,
 * so the instructions demonstrated the opposite of themselves. A doc that
 * teaches by example has to be allowed to show the empty form.
 */
function fencedRanges(text) {
  const out = [];
  let open = null;
  const re = /^```/gm;
  for (const m of text.matchAll(re)) {
    if (open === null) open = m.index;
    else { out.push([open, m.index + 3]); open = null; }
  }
  return out;
}
const inFence = (ranges, i) => ranges.some(([a, b]) => i >= a && i < b);

/**
 * Docs this change touched, against the merge base. `null` when the base cannot
 * be resolved — the caller then charges EVERY stale doc, because a gate that
 * cannot tell whose drift it is must not let anything through.
 */
function changedDocsAgainstBase() {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', 'origin/main'], { cwd: ROOT, stdio: 'pipe' });
    const base = execFileSync('git', ['merge-base', 'HEAD', 'origin/main'], { cwd: ROOT, encoding: 'utf8' }).trim();
    if (!base) return null;
    const out = execFileSync('git', ['diff', '--name-only', '-z', `${base}...HEAD`], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26,
    });
    return new Set(out.split('\0').filter(Boolean));
  } catch {
    return null;
  }
}

function docsWithBlocks() {
  const out = [];
  const stack = ['docs', '.'];
  const seen = new Set();
  while (stack.length) {
    const cur = stack.pop();
    const abs = path.join(ROOT, cur);
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const rel = cur === '.' ? e.name : `${cur}/${e.name}`;
      if (e.isDirectory()) { if (cur === 'docs') stack.push(rel); continue; }
      if (!e.name.endsWith('.md') || seen.has(rel)) continue;
      seen.add(rel);
      const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      if (/<!--\s*explain:/.test(text)) out.push(rel);
    }
  }
  return out.sort();
}

function fillDocs({ write }) {
  const docs = docsWithBlocks();
  const stale = [];
  let filled = 0;
  for (const rel of docs) {
    const abs = path.join(ROOT, rel);
    const before = fs.readFileSync(abs, 'utf8');
    let after = before;
    for (const q of QUESTIONS) {
      /* Ranges are recomputed per question because a replacement shifts every
         offset after it. Cheap, and the alternative is an off-by-N nobody sees
         until a fence swallows a real block. */
      after = after.replace(BLOCK(q.id), (m, open, _body, close, offset) => {
        if (inFence(fencedRanges(after), offset)) return m;
        const answer = render(q, ask(q, ROOT));
        filled += 1;
        return `${open}\n${answer}\n${close}`;
      });
    }
    if (after !== before) {
      if (write) fs.writeFileSync(abs, after);
      else stale.push(rel);
    }
  }
  /* An id nobody embeds is fine. An EMBEDDED id that matches no question is
     not: the block would sit there forever holding whatever was typed into it,
     looking generated. */
  const unknown = [];
  for (const rel of docs) {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    for (const m of text.matchAll(/<!--\s*explain:\s*([a-z0-9-]+)\s*-->/g)) {
      if (!ids.includes(m[1])) unknown.push(`${rel}: <!-- explain: ${m[1]} --> is not a question`);
    }
  }
  return { docs, filled, stale, unknown };
}

// ---- entry points ----------------------------------------------------------

if (has('--check')) {
  let failed = 0;
  for (const q of QUESTIONS) {
    try {
      const a = ask(q, ROOT);
      console.log(`  ok    ${q.id.padEnd(18)} corpus=${String(a.corpus).padStart(5)}  ${a.value.slice(0, 70)}`);
    } catch (err) {
      failed += 1;
      console.error(`  FAIL  ${q.id}\n${String(err.message).split('\n').map((l) => `        ${l}`).join('\n')}`);
    }
  }
  console.log(`\n${QUESTIONS.length - failed}/${QUESTIONS.length} questions answered.`);
  if (failed) {
    console.error(
      '\nA question that no longer computes is not a missing feature — it means the thing it reads\n' +
        'has moved, and every answer given from it since is suspect. Fix the question, do not delete it.',
    );
    process.exit(1);
  }
  const { unknown } = fillDocs({ write: false });
  if (unknown.length) { console.error('\n' + unknown.join('\n')); process.exit(1); }
  process.exit(0);
}

if (has('--write') || has('--check-docs')) {
  const { docs, filled, stale, unknown } = fillDocs({ write: has('--write') });
  if (unknown.length) { console.error(unknown.join('\n')); process.exit(1); }
  if (has('--write')) {
    console.log(`explain: filled ${filled} block(s) across ${docs.length} doc(s).`);
    process.exit(0);
  }
  /* BLAME THE PR THAT MOVED THE ANSWER, NOT WHICHEVER RUNS NEXT.
     An embedded answer goes stale when the SOURCE moves — a migration lands, a
     route module appears — so on a busy day every open PR inherits that drift
     the moment it merges `main`, through no act of its own. This repo has
     already watched that exact shape deadlock two gates: `audit:bug-index` (five
     PRs red at once over the previous author's entry) and `check-file-size` (a
     production fix blocked by a file it never opened). Shipping it a third time
     would be careless.

     So: a doc THIS change touched must be current, and fails. A doc it did not
     touch is REPORTED in full with the fix, and does not fail the run — it is
     caught the moment anyone edits it. Inherited drift is never silent; it is
     just not charged to a stranger. */
  const touched = changedDocsAgainstBase();
  const mine = touched === null ? stale : stale.filter((d) => touched.has(d));
  const inherited = stale.filter((d) => !mine.includes(d));

  if (inherited.length) {
    console.log(
      `explain: ${inherited.length} doc(s) hold an answer the source has moved past, ` +
        'not touched by this change — reported, not charged:\n' +
        inherited.map((d) => `  ${d}`).join('\n') +
        '\n  Whoever edits one of these next owns bringing it current: node scripts/explain.mjs --write',
    );
  }
  if (mine.length) {
    console.error(
      `explain: ${mine.length} doc(s) THIS change touched hold an answer that no longer matches the source:\n` +
        mine.map((d) => `  ${d}`).join('\n') +
        '\n\nRun: node scripts/explain.mjs --write\n' +
        'This is the drift a path-checker cannot see — the file exists, the number is wrong.',
    );
    process.exit(1);
  }
  console.log(`explain: ${docs.length} doc(s) with embedded answers, all current.`);
  process.exit(0);
}

const asked = argv.find((a) => !a.startsWith('-'));
if (has('--all')) { for (const q of QUESTIONS) printOne(q); process.exit(0); }
if (asked) {
  const q = QUESTIONS.find((x) => x.id === asked);
  if (!q) {
    console.error(`explain: no question "${asked}". Known: ${ids.join(', ')}`);
    process.exit(2);
  }
  printOne(q);
  process.exit(0);
}

console.log('Questions this repo can answer from its own source:\n');
for (const q of QUESTIONS) {
  console.log(`  ${q.id.padEnd(18)} ${q.question}`);
  console.log(`  ${' '.repeat(18)} why: ${q.why.split('. ')[0]}.`);
  console.log();
}
console.log('  node scripts/explain.mjs <id>     answer one');
console.log('  node scripts/explain.mjs --all    answer all');
console.log('\nAdd one whenever a question costs someone a re-read of the codebase:');
console.log('  scripts/lib/explain/questions.mjs — it must compute, carry a denominator, and cite refs.');
