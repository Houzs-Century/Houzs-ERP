// ---------------------------------------------------------------------------
// check-typecheck-gate.test.mjs — the frontend typecheck script must actually
// typecheck.
//
// THE TRAP. frontend/tsconfig.json is a SOLUTION file: `"files": []` plus
// `references`. `tsc --noEmit` disables build mode, so against this shape it
// resolves zero input files, prints nothing, and exits 0 — on a tree with real
// type errors in it. Only `tsc -b` walks the references.
//
// It was not hypothetical. `frontend/package.json`'s `typecheck` script — the
// thing CI's required `frontend` job runs — was literally `tsc --noEmit` until
// 2026-08-01, when it was changed to `tsc -b` incidentally, inside an unrelated
// feature PR. For the window before that the named gate was decorative and
// coverage came only from the `npm run build` step later in the same job. A
// dozen BUG-HISTORY entries cite frontend `tsc --noEmit` as their verification
// evidence with no caveat.
//
// Nothing stopped it being written that way, and nothing stops a future tidy-up
// from putting it back — `--noEmit` is the more familiar incantation and it
// looks correct. So the shape is asserted here instead of remembered.
//
// Run by the `frontend` CI job alongside check-bundle-verdict.mjs:
//   node --test frontend/scripts/check-typecheck-gate.test.mjs
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const FRONTEND = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(FRONTEND, 'package.json'), 'utf8'));
const tsconfig = JSON.parse(
  // tsconfig.json permits comments; strip line comments before parsing.
  readFileSync(join(FRONTEND, 'tsconfig.json'), 'utf8').replace(/^\s*\/\/.*$/gm, ''),
);

test('tsconfig.json is still a solution file, which is what makes --noEmit a no-op', () => {
  // If this ever stops being true the reasoning below changes and this file
  // should be revisited rather than deleted.
  assert.deepEqual(tsconfig.files, [], 'expected "files": [] (a solution/reference root)');
  assert.ok(Array.isArray(tsconfig.references) && tsconfig.references.length > 0);
});

test('the typecheck script uses build mode, not --noEmit', () => {
  const script = pkg.scripts?.typecheck ?? '';
  assert.ok(
    /(^|\s)(-b|--build)(\s|$)/.test(script),
    `frontend "typecheck" must run tsc in build mode; got: ${script}`,
  );
  assert.ok(
    !script.includes('--noEmit'),
    `--noEmit against "files": [] checks NOTHING and exits 0; got: ${script}`,
  );
});

test('the build script also typechecks, so the two cannot drift apart silently', () => {
  const build = pkg.scripts?.build ?? '';
  assert.ok(/(^|\s)tsc\s+(-b|--build)/.test(build), `expected build to run tsc -b; got: ${build}`);
});
