// ---------------------------------------------------------------------------
// check-perf-lab-gate.test.mjs — the perf-lab checks must BLOCK a merge, not
// merely report one.
//
// THE TRAP, paid for in full on 2026-08-20. `frontend-perf` lived in
// `.github/workflows/postsubmit.yml`, which triggers only on push to `main`, so
// it could only ever run AFTER the merge that broke it. `typecheck:perf-local`
// failed 18 consecutive runs (first 32390289786, head 80f4f9756 = the merge
// commit of #2568; last 32405172079) and blocked nothing. Nobody was careless:
// the required contexts are `backend-typecheck`, `frontend`,
// `company-scope-ratchet` and `completeness-claim`, and none of them covered it.
//
// WHY NOTHING ELSE COVERS IT. `frontend/perf-lab/tsconfig.json` is a SECOND tsc
// project — it extends `../tsconfig.app.json` and narrows `types` — and
// `frontend/tsconfig.json` references only `tsconfig.app.json` and
// `tsconfig.node.json`. So `tsc -b`, which is the whole of `npm run typecheck`,
// structurally cannot reach `perf-lab/`. Test 1 below pins that premise: if the
// root config ever DOES reference perf-lab, this file's reasoning changes and it
// should be revisited rather than deleted.
//
// THE TWO WAYS THIS SILENTLY UN-FIXES ITSELF, which is why they are asserted
// here instead of remembered:
//
//   1. The job runs but is missing from the `frontend` roll-up's `needs`. The
//      roll-up is the REQUIRED context; a job absent from it is advisory, goes
//      red, and gates nothing — the exact bug above, wearing a presubmit badge.
//      Note it is not enough to be in `needs`: `if: always()` means the roll-up
//      still passes unless its script also ASSERTS the result. Both are checked.
//   2. `merge_group` disappears from ci.yml's triggers. The merge queue builds
//      its own ref, and a queue gate weaker than the PR gate lets a change
//      through on evidence gathered against a different tree.
//
// This is the SECOND job to need this assertion — `frontend-typecheck` was split
// out on 2026-08-14 and its roll-up line carries the same warning. Treat the
// pair as the rule, not as two coincidences.
//
// Run by the `frontend-typecheck` CI job, which is deliberately NOT the job
// under test: a checker that lives inside the job it guards dies with it.
//   node --test frontend/scripts/check-perf-lab-gate.test.mjs
//
// Dependency-free on purpose. The repo has no `yaml` package at any of the
// three top levels (checked 2026-08-21); the only resolvable parser is a
// TRANSITIVE `js-yaml` under frontend/, which any lockfile change may remove.
// A gate that vanishes with a transitive dependency is the "check that is not
// running" trap in CLAUDE.md. The scanner below is tiny, and every anchor it
// depends on is asserted to exist first — per the repo rule that a verdict
// computed over nothing must never read as a pass.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const FRONTEND = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(FRONTEND, '..');

const read = (p) => readFileSync(join(REPO, p), 'utf8');
const CI = read('.github/workflows/ci.yml');
const POSTSUBMIT = read('.github/workflows/postsubmit.yml');

/**
 * Split a workflow's top-level `jobs:` mapping into { name -> body }.
 *
 * Deliberately narrow: it only understands the shape these two files are
 * written in (job keys at exactly two spaces). It THROWS rather than returning
 * an empty map when it cannot find what it expects, so a reformat that defeats
 * it fails the test loudly instead of passing over nothing.
 */
function jobsOf(source, label) {
  const lines = source.split('\n');
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  assert.notEqual(start, -1, `${label}: no top-level \`jobs:\` key — the scanner cannot report on this file`);

  const jobs = new Map();
  let current = null;
  for (const line of lines.slice(start + 1)) {
    const header = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (header) {
      current = header[1];
      jobs.set(current, []);
      continue;
    }
    // A new top-level key (column 0, not a comment) ends the jobs block.
    if (/^[A-Za-z]/.test(line)) break;
    if (current) jobs.get(current).push(line);
  }

  assert.ok(jobs.size > 0, `${label}: parsed zero jobs — refusing to report a pass over nothing`);
  return new Map([...jobs].map(([k, v]) => [k, v.join('\n')]));
}

const ciJobs = jobsOf(CI, 'ci.yml');
const postsubmitJobs = jobsOf(POSTSUBMIT, 'postsubmit.yml');

test('perf-lab is still a separate tsc project, which is what makes `tsc -b` blind to it', () => {
  // The premise the whole job rests on. If this fails, perf-lab has been wired
  // into the solution root and `frontend-typecheck` may now cover it — revisit
  // this file rather than deleting the assertions below.
  const root = JSON.parse(read('frontend/tsconfig.json').replace(/^\s*\/\/.*$/gm, ''));
  const referenced = (root.references ?? []).map((r) => r.path);
  assert.ok(referenced.length > 0, 'expected frontend/tsconfig.json to be a solution file with references');
  assert.ok(
    !referenced.some((p) => p.includes('perf-lab')),
    `frontend/tsconfig.json now references perf-lab (${referenced.join(', ')}); the reasoning in this file needs revisiting`,
  );

  const perfLab = JSON.parse(read('frontend/perf-lab/tsconfig.json').replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''));
  assert.equal(perfLab.extends, '../tsconfig.app.json');
});

test('the perf-lab checks run on the PULL REQUEST, not after the merge', () => {
  assert.ok(
    ciJobs.has('frontend-perf'),
    'ci.yml declares no `frontend-perf` job. Moving it back to postsubmit.yml means it can only ever run AFTER the merge that breaks it — see the header.',
  );
  assert.ok(
    !postsubmitJobs.has('frontend-perf'),
    'postsubmit.yml declares `frontend-perf` again. It belongs on the PR path; two copies also pay for it twice.',
  );
});

test('ci.yml still triggers on merge_group, so the queue gate is not weaker than the PR gate', () => {
  const header = CI.slice(0, CI.indexOf('\njobs:'));
  assert.ok(
    /^on:\s*$/m.test(header),
    'ci.yml: no top-level `on:` block found — refusing to report a pass over nothing',
  );
  assert.ok(
    /^ {2}merge_group:\s*$/m.test(header),
    'ci.yml no longer triggers on `merge_group`. The merge queue would skip every check here, silently — a job that does not run reports nothing.',
  );
  assert.ok(
    /^ {2}pull_request:\s*$/m.test(header),
    'ci.yml no longer triggers on `pull_request`.',
  );
});

test('frontend-perf runs BOTH the typecheck and the browser suite', () => {
  const body = ciJobs.get('frontend-perf') ?? '';
  // The browser suite had been dark since 2026-08-20 15:43Z behind the failing
  // typecheck — a failing step hides every step after it. It moves WITH the
  // typecheck, never instead of it.
  assert.match(body, /npm run typecheck:perf-local/, 'frontend-perf must run `typecheck:perf-local`');
  assert.match(body, /npm run test:perf-local/, 'frontend-perf must run `test:perf-local`');
});

test('the required `frontend` roll-up both NEEDS frontend-perf and ASSERTS its result', () => {
  const rollup = ciJobs.get('frontend');
  assert.ok(rollup, 'ci.yml has no `frontend` roll-up — that IS the required context');

  const needs = /^\s*needs:\s*\[([^\]]*)\]/m.exec(rollup);
  assert.ok(needs, '`frontend` roll-up: could not read its `needs:` list');
  const list = needs[1].split(',').map((s) => s.trim());
  assert.ok(
    list.includes('frontend-perf'),
    `\`frontend\` roll-up needs [${list.join(', ')}] — without frontend-perf the job runs and gates NOTHING, which is the bug this exists to stop.`,
  );

  // `if: always()` means membership in `needs` alone proves nothing: the
  // roll-up would still report success while frontend-perf failed. The script
  // has to check the result too.
  assert.match(
    rollup,
    /^\s*ok frontend-perf ["']?\$\{\{\s*needs\.frontend-perf\.result\s*\}\}/m,
    '`frontend` roll-up does not assert `needs.frontend-perf.result`. With `if: always()` the roll-up passes regardless — being in `needs` is necessary and not sufficient.',
  );
});
