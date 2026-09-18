#!/usr/bin/env node
// Reports a fix PR that changed product code and left no test behind.
// Advisory while `--advisory` is passed: it prints the finding and exits 0.
//
// Inputs come from the workflow, not from guessing: PR_TITLE, PR_BRANCH,
// PR_LABELS (comma separated), BASE_SHA and HEAD_SHA.
import { execFileSync } from 'node:child_process';
import { verdict, WAIVER_LABEL } from './lib/fix-has-test.mjs';

const advisory = process.argv.includes('--advisory');
const title = process.env.PR_TITLE ?? '';
const branch = process.env.PR_BRANCH ?? '';
const labels = (process.env.PR_LABELS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const base = process.env.BASE_SHA ?? '';
const head = process.env.HEAD_SHA ?? 'HEAD';

if (!base) {
  console.error('BASE_SHA is empty — the diff would be the whole repo. Refusing to report from nothing.');
  process.exit(2);
}

let files = [];
try {
  files = execFileSync('git', ['diff', '--name-only', `${base}...${head}`], { encoding: 'utf8' })
    .split('\n').map((s) => s.trim()).filter(Boolean);
} catch (err) {
  console.error(`Could not read the diff ${base}...${head}: ${err.message}`);
  process.exit(2);
}

const v = verdict({ title, branch, files, labels });
console.log(`${files.length} changed file(s); product code: ${v.product.length}; tests: ${v.tests.length}`);

if (v.ok) {
  console.log(`OK — ${v.reason}.`);
  if (v.waived) console.log(`The ${WAIVER_LABEL} label waived this check on: ${v.product.join(', ')}`);
  process.exit(0);
}

const lines = [
  'This PR reads as a fix and changes product code, but no test moved with it.',
  '',
  'Product code changed:',
  ...v.product.map((f) => `  ${f}`),
  '',
  'A fix is remembered by a test that fails when the bug comes back — write the',
  'test that is RED before your fix and green after, and put Symptom / Cause / Fix',
  `in three lines in the PR body. If a test genuinely cannot express it, add the`,
  `\`${WAIVER_LABEL}\` label and say why in the body.`,
];
const message = lines.join('\n');
if (advisory) {
  console.log(`::warning title=A fix with no test::${lines[0]}`);
  console.log(message);
  console.log('\nAdvisory for now: this check does not block the merge yet.');
  process.exit(0);
}
console.log(`::error title=A fix with no test::${lines[0]}`);
console.error(message);
process.exit(1);
