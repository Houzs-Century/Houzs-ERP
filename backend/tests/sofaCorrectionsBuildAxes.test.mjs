import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/* Call-site pin for docs/bugs/0896. The RULE (blanks only, one fabric only, never
   specials) is behavioural and lives in scripts/lib/sofa-build-axes.test.mjs; this
   pins that the applier's plan actually builds every piece's variants through it.
   Before the fix an added piece's variants were `{ ...(p.row?.variants ?? {}) }`,
   and an added piece has no row — so HC-SO-013346's added 8030-1A(RHF) got
   `{"seatHeight":"35"}` and no colour (trace run 34844739166). */

const SRC = readFileSync(join(__dirname, '..', 'scripts', 'apply-sofa-compartment-corrections.mjs'), 'utf8');

describe('apply-sofa-compartment-corrections: every piece carries its build\'s fabric', () => {
  it('imports the shared-axes rule', () => {
    expect(SRC).toMatch(/import \{ sharedBuildAxes, fillFromBuild \} from "\.\/lib\/sofa-build-axes\.mjs"/);
  });
  it('computes the build\'s shared axes from the copy\'s own rows', () => {
    expect(SRC).toMatch(/const shared = sharedBuildAxes\(copyRows\)/);
  });
  it('builds each piece\'s variants through fillFromBuild, not from the row alone', () => {
    expect(SRC).toMatch(/pairs\.forEach\(\(p, idx\) => \{[\s\S]{0,200}?fillFromBuild\(p\.row\?\.variants, shared\)/);
    expect(SRC).not.toMatch(/pairs\.forEach\(\(p, idx\) => \{\s*const first = idx === 0;\s*const v = \{ \.\.\.\(p\.row\?\.variants \?\? \{\}\) \};/);
  });
});
