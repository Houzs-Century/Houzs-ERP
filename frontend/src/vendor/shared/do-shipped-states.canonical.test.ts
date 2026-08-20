import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { DO_SHIPPED_STATES, SI_TRANSFERABLE_DO_STATES } from './do-shipped-states';

/* THE PAIR THIS MODULE'S WHOLE POINT DEPENDS ON, AND NOTHING WAS COMPARING IT.
 *
 * The DO -> Sales Invoice bug was one rule typed out in four places. The fix
 * was to give it ONE home and vendor a copy for the browser, on the stated
 * grounds that `check-shared-mirrors.mjs --strict` holds the two byte-identical.
 * It does not. That script only FAILS a diverging pair it considers unrefereed,
 * and `refereed()` (check-shared-mirrors.mjs:94) is a text heuristic: any test
 * whose source mentions `shared/do-shipped-states.ts`, contains a cross-tree
 * path, and contains `toBe(` marks the pair as TESTED — after which divergence
 * is reported and never failed.
 *
 * The test that happened to satisfy all three was
 * `frontend/src/vendor/scm/lib/do-next-step.test.ts`, which is about
 * do-next-step and compares nothing. Measured, not reasoned: adding a bogus
 * state to the frontend copy left `check-shared-mirrors --strict` at 0 DIVERGED
 * and exit 0, and left doShippedStatesMirror, doStatusCaseNormalisation and
 * oneSystemTwoOrganisations all green.
 *
 * doShippedStatesMirror.test.ts does referee a pair — the backend .ts against
 * `backend/scripts/lib/do-shipped-states.mjs`, the copy the audit scripts read.
 * A DIFFERENT pair. The frontend twin had no referee at all.
 *
 * This is that referee, in the shape the repo already uses for the same problem
 * (`total-height.canonical.test.ts`, `phone.canonical.test.ts`). */
describe('the two copies of this module are the same file', () => {
  test('backend/src/scm/shared/do-shipped-states.ts is byte-identical to this one', () => {
    const here = resolve(process.cwd(), 'src/vendor/shared/do-shipped-states.ts');
    const there = resolve(process.cwd(), '../backend/src/scm/shared/do-shipped-states.ts');
    const norm = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
    expect(norm(there)).toBe(norm(here));
  });

  /* A byte-comparison passes for the wrong reason if either read came back
     empty, so prove both files are real and carry the two sets this module is
     imported for. */
  test('this pin is not vacuous — both files are real and carry both sets', () => {
    const norm = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
    for (const p of ['src/vendor/shared/do-shipped-states.ts', '../backend/src/scm/shared/do-shipped-states.ts']) {
      const t = norm(p);
      expect(t.length).toBeGreaterThan(500);
      expect(t).toContain('DO_SHIPPED_STATES');
      expect(t).toContain('SI_TRANSFERABLE_DO_STATES');
    }
    expect(DO_SHIPPED_STATES.length).toBeGreaterThan(0);
    expect(SI_TRANSFERABLE_DO_STATES.length).toBeGreaterThan(0);
  });
});
