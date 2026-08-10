import { describe, expect, test } from 'vitest';
import {
  REQUIRED_VARIANT_AXES_BY_CATEGORY as tsAxes,
  isDivanOnly as tsDivanOnly,
  isDivanlessFrame as tsDivanless,
  missingVariantAxes as tsMissing,
} from '../src/scm/shared/so-variant-rule';
// @ts-expect-error - plain .mjs mirror for audit scripts
import {
  REQUIRED_VARIANT_AXES_BY_CATEGORY as jsAxes,
  isDivanOnly as jsDivanOnly,
  isDivanlessFrame as jsDivanless,
  missingVariantAxes as jsMissing,
} from '../scripts/lib/variant-axes.mjs';

/* scripts/lib/variant-axes.mjs is a hand copy of the axes table and the two
   exemptions from src/scm/shared/so-variant-rule.ts, because a .mjs audit
   script cannot import TypeScript. That rule was hand-copied into four places
   before so-variant-rule.ts centralised it, and the copies drifted. This test
   is the thing that stops the fifth copy drifting: an audit that judges lines
   by a different rule than the app enforces is worse than no audit. */

describe('variant-axes.mjs mirrors so-variant-rule.ts', () => {
  test('the axes table is identical', () => {
    expect(JSON.parse(JSON.stringify(jsAxes))).toEqual(JSON.parse(JSON.stringify(tsAxes)));
  });

  const CODES = [
    'HOK-DIVAN ONLY (K)', 'NB-DIVAN ONLY', 'AERO-DIVAN ONLY (K)',
    'HIPSTER (A)-(K)', 'TRION (A)-(Q)', 'NB-NBG06(SS+S)', 'CODY 2.0 ADJUSTABLE (K)',
    'DOUBLE DECKER (S)', 'DOUBLE DACKER-(S)', 'DDB-01', '8030-1A(LHF)', null,
  ];

  test('the exemptions agree on every shape we have seen', () => {
    for (const c of CODES) {
      expect(jsDivanOnly(c)).toBe(tsDivanOnly(c));
      expect(jsDivanless(c)).toBe(tsDivanless(c));
    }
  });

  test('missingVariantAxes agrees across categories and variant shapes', () => {
    const VARIANTS: Array<Record<string, unknown> | null> = [
      null,
      {},
      { fabricCode: 'PC151-01' },
      { divanHeight: '8"', legHeight: '2"', gap: '14"', fabricCode: 'PC151-01' },
      { divanHeight: '8"', gap: '14"' },
      { seatHeight: '28' },
      { depth: '28', fabricColor: 'BO315-3' },
      { seatHeight: '', fabricCode: '   ' },
    ];
    for (const group of ['bedframe', 'sofa', 'mattress', 'accessory', '', null]) {
      for (const v of VARIANTS) {
        for (const c of CODES) {
          expect(jsMissing(group, v, c).map((a: { key: string }) => a.key))
            .toEqual(tsMissing(group, v, c).map((a) => a.key));
        }
      }
    }
  });
});
