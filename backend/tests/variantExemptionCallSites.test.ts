// ----------------------------------------------------------------------------
// The by-SKU variant exemptions — DIVAN ONLY, divanless frames, seatless pieces
// — must reach EVERY caller, including the ones the compiler cannot see.
//
// The TypeScript half is already safe by construction: `itemCode` is a REQUIRED
// parameter of missingVariantAxes / missingConfirmVariantAxes (owner rule, and
// BUG CLASS optional-param-noop at the top of BUG-HISTORY.md), so `tsc` names
// every call site that forgets it. That is exactly why the surviving holes were
// all in `.mjs`: a plain-node audit script re-typing the rule pays no compiler
// tax at all, and three of them had.
//
// So this file guards the seam the compiler does not: no script may carry its
// own copy of the axes table or of an exemption predicate. There is ONE mirror,
// scripts/lib/variant-axes.mjs, and variantAxesMirror.test.ts pins THAT against
// the TypeScript source.
// ----------------------------------------------------------------------------
import { describe, expect, test } from 'vitest';
import noncatalog from '../scripts/check-so-noncatalog-lines.mjs?raw';
import crossFill from '../scripts/cross-fill-so-po-variants.mjs?raw';
import cutover from '../scripts/check-cutover-metrics.mjs?raw';
import poSo from '../scripts/check-po-so-completeness.mjs?raw';
import sofaBedframe from '../scripts/check-sofa-bedframe-completeness.mjs?raw';

const SCRIPTS: Array<[string, string]> = [
  ['check-so-noncatalog-lines.mjs', noncatalog],
  ['cross-fill-so-po-variants.mjs', crossFill],
  ['check-cutover-metrics.mjs', cutover],
  ['check-po-so-completeness.mjs', poSo],
  ['check-sofa-bedframe-completeness.mjs', sofaBedframe],
];

describe('no audit script re-types an exemption predicate', () => {
  /* The regexes are the exemptions' actual shapes. A script that types one of
     these has forked the rule: the next by-SKU exemption the owner gives will
     reach the app and not this audit, which is the whole failure this guards
     — the DIVAN ONLY carve-out (2026-08-09) and the divanless one (2026-08-10)
     had each done precisely that. */
  const FORKED = [
    { what: 'the DIVAN ONLY pattern', re: /DIVAN\\s\*ONLY/ },
    { what: 'the divanless-frame pattern', re: /DOUBLE\\s\*D\[AE\]C\?KER/ },
    { what: 'the seatless-piece pattern', re: /\^\(CONSOLE\|CT\)/ },
  ];
  for (const [name, source] of SCRIPTS) {
    for (const f of FORKED) {
      test(`${name} does not re-type ${f.what}`, () => {
        expect(source).not.toMatch(f.re);
      });
    }
  }
});

describe('every script that judges variant completeness imports the mirror', () => {
  const CONSUMERS: Array<[string, string]> = [
    ['check-so-noncatalog-lines.mjs', noncatalog],
    ['cross-fill-so-po-variants.mjs', crossFill],
    ['check-cutover-metrics.mjs', cutover],
    ['check-po-so-completeness.mjs', poSo],
    ['check-sofa-bedframe-completeness.mjs', sofaBedframe],
  ];
  for (const [name, source] of CONSUMERS) {
    test(name, () => {
      expect(source).toMatch(/from ["'](\.\/)?lib\/variant-axes\.mjs["']/);
    });
  }
});

describe('the exemption-bearing calls pass a real item code', () => {
  /* `missingVariantAxes(g, v)` — two arguments — is the shape that cannot
     apply any exemption. The TS signature makes it a compile error; in .mjs it
     is silent, so it is asserted here. */
  for (const [name, source] of SCRIPTS) {
    test(name, () => {
      /* Exactly two arguments, i.e. no itemCode. `[^(),]` on BOTH sides is
         load-bearing: `[^()]` would let the first group swallow a comma and a
         correct three-argument call would match. */
      const twoArg = /missing(?:Confirm)?VariantAxes\([^(),]*,[^(),]*\)/g;
      expect(source.match(twoArg), `${name} calls the rule with no itemCode`).toBeNull();
    });
  }
});
