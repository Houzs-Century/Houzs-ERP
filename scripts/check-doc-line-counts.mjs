#!/usr/bin/env node
/* A module guide that quotes a file's LINE COUNT must quote the real one.
 *
 * WHY THIS EXISTS. On 2026-08-22, of the 17 line counts quoted in
 * docs/modules/*.md next to the file they describe, **16 were wrong** — one was
 * right. Not by a little: `Projects.tsx` was documented as 12,404 lines and is
 * 15,017; `ServiceCases.tsx` as 8,032 and is 8,816.
 *
 * These numbers are not decoration. They are the reason a guide says
 * "do not open whole", and they are what a reader budgets against before
 * touching a file. A count that is 2,600 lines light is worse than no count:
 * it reads as a measurement and is a memory.
 *
 * Fixing the sixteen without this check would buy about a week. The counts rot
 * because nothing makes them rot LOUDLY — every other number in this repo that
 * matters is either generated or ratcheted.
 *
 * WHAT IT CHECKS. Every line of every doc under docs/modules/ that contains BOTH
 *   - a count, spelled `1,234 lines` or `1234 lines` (bold markers allowed), and
 *   - a backtick-quoted path under frontend/ or backend/
 * must have the count equal `wc -l` of that path.
 *
 * WHAT IT DELIBERATELY DOES NOT CHECK.
 *   - A count with no path on the same line. Guessing which file a prose
 *     sentence means is how a checker starts lying; those are left alone and
 *     REPORTED as a total, so the blind spot has a size.
 *   - Any other number. `wc -l` is the one a checker can settle.
 *   - Paths that do not exist. Reported separately: a guide pointing at a moved
 *     file is a different defect and must not be silently counted as a drift.
 *   - Anything outside docs/modules/. The module guides are the LIVING
 *     description of the system, and CLAUDE.md already requires updating the
 *     guide in the PR that changes the surface — so a stale count there is a
 *     rule already being broken. Everything else under docs/ is a DATED RECORD:
 *     a bug-ledger entry or a COE quotes the number as it stood that day, and
 *     "correcting" it would falsify the measurement it exists to preserve.
 *     docs/bugs/0139 quotes grns.ts at 3,591 lines; the file is 3,571 today,
 *     and 3,591 is what it was when that entry was written. Leave it.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd().endsWith('/backend') ? join(process.cwd(), '..') : process.cwd();
const DOCS = join(ROOT, 'docs', 'modules');

/* Bold markers are allowed around the count because the guides use them for
   emphasis on exactly the large files this is about. */
const COUNT_RE = /\*{0,2}(\d{1,3}(?:,\d{3})+|\d{3,7})\s+lines\*{0,2}/;
const PATH_RE = /`((?:frontend|backend)\/[\w./@-]+\.\w+)`/g;

const mdFiles = [];
(function walk(dir) {
  let entries;
  try { entries = readdirSync(dir); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) { walk(p); continue; }
    if (e.endsWith('.md')) mdFiles.push(p);
  }
})(DOCS);

const lineCountOf = (abs) => {
  const buf = readFileSync(abs, 'utf8');
  if (buf === '') return 0;
  /* wc -l semantics: count the newlines, then add a final unterminated line. */
  let n = 0;
  for (let i = 0; i < buf.length; i++) if (buf.charCodeAt(i) === 10) n++;
  return buf.endsWith('\n') ? n : n + 1;
};

const drifts = [];
const missing = [];
let checked = 0;
let unpathed = 0;

for (const md of mdFiles) {
  const lines = readFileSync(md, 'utf8').split('\n');
  lines.forEach((line, i) => {
    const m = COUNT_RE.exec(line);
    if (!m) return;
    const quoted = Number(m[1].replace(/,/g, ''));
    PATH_RE.lastIndex = 0;
    const first = PATH_RE.exec(line);
    if (!first) { unpathed++; return; }
    const rel = first[1];
    const abs = join(ROOT, rel);
    const where = `${relative(ROOT, md)}:${i + 1}`;
    if (!existsSync(abs)) { missing.push({ where, rel, quoted }); return; }
    checked++;
    const real = lineCountOf(abs);
    if (real !== quoted) drifts.push({ where, rel, quoted, real });
  });
}

const fmt = (n) => n.toLocaleString('en-US');

console.log(`[doc-line-counts] ${checked} count(s) in docs/modules checked against the file on the same line.`);
console.log('[doc-line-counts] docs/bugs and the COEs are DATED RECORDS — not checked, on purpose.');
if (unpathed) {
  console.log(`[doc-line-counts] ${unpathed} count(s) name no file on their line — NOT CHECKED, by design.`);
}

if (missing.length) {
  console.log('');
  console.log(`[doc-line-counts] ${missing.length} guide(s) quote a file that does not exist:`);
  for (const x of missing) console.log(`  ${x.where}  ${x.rel}`);
  console.log('  A moved file is a different defect from a stale count. Fix the path.');
}

if (drifts.length) {
  console.log('');
  console.log(`[doc-line-counts] ${drifts.length} count(s) have drifted:`);
  for (const d of drifts) {
    console.log(`  ${d.where}`);
    console.log(`     ${d.rel}  says ${fmt(d.quoted)}, is ${fmt(d.real)}  (${d.real > d.quoted ? '+' : ''}${fmt(d.real - d.quoted)})`);
  }
  console.log('');
  console.log('A line count is why a guide says "do not open whole" — it is what a');
  console.log('reader budgets against. Update it in the PR that changed the file.');
}

if (drifts.length || missing.length) process.exit(1);
console.log('[doc-line-counts] OK');
