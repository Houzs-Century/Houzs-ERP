import { describe, expect, test } from 'vitest';
import {
  REQUIRED_VARIANT_AXES_BY_CATEGORY as tsAxes,
  isDivanOnly as tsDivanOnly,
  isDivanlessFrame as tsDivanless,
  isSeatlessPiece as tsSeatless,
  missingVariantAxes as tsMissing,
  missingConfirmVariantAxes as tsMissingConfirm,
} from '../src/scm/shared/so-variant-rule';
// @ts-expect-error - plain .mjs mirror for audit scripts
import {
  REQUIRED_VARIANT_AXES_BY_CATEGORY as jsAxes,
  isDivanOnly as jsDivanOnly,
  isDivanlessFrame as jsDivanless,
  isSeatlessPiece as jsSeatless,
  missingVariantAxes as jsMissing,
  missingConfirmVariantAxes as jsMissingConfirm,
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
    /* SEATLESS PIECES. These were the hole: the .mjs mirror grew an
       isSeatlessPiece exemption that the TS rule never got, and this list had no
       CONSOLE or CT case — so the two implementations were only ever compared on
       inputs where they already agreed, and the file's own header claimed "the
       copy cannot drift" the whole time. A mirror test is only as wide as its
       corpus. Both spellings, plus near-misses that must NOT be exempt. */
    '8030-CONSOLE', '9028-CT', 'HOK-CONSOLE (L)', '8030-CT01',
    'CONSOLE-1A', 'CT-2A', '8030-CTRL', '8030-CONSOLIDATED',
  ];

  test('the exemptions agree on every shape we have seen', () => {
    for (const c of CODES) {
      expect(jsDivanOnly(c), `isDivanOnly disagrees on ${c}`).toBe(tsDivanOnly(c));
      expect(jsDivanless(c), `isDivanlessFrame disagrees on ${c}`).toBe(tsDivanless(c));
      expect(jsSeatless(c), `isSeatlessPiece disagrees on ${c}`).toBe(tsSeatless(c));
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
      /* Colour-KIV: fabric SERIES committed, colour still to come. Only
         missingConfirmVariantAxes treats it as satisfying the fabric axis. */
      { fabricId: 'f-1', fabricLabel: 'EZ' },
      { seatHeight: '28', fabricId: 'f-1', fabricLabel: 'EZ' },
    ];
    for (const group of ['bedframe', 'sofa', 'mattress', 'accessory', '', null]) {
      for (const v of VARIANTS) {
        for (const c of CODES) {
          expect(jsMissing(group, v, c).map((a: { key: string }) => a.key), `missingVariantAxes disagrees on ${group}/${c}`)
            .toEqual(tsMissing(group, v, c).map((a) => a.key));
          /* The confirm variant too — an audit that judges "confirmable" by a
             different rule than the app enforces is worse than no audit, and a
             hand-ported copy in check-so-noncatalog-lines.mjs was doing exactly
             that until this helper existed to import instead. */
          expect(jsMissingConfirm(group, v, c).map((a: { key: string }) => a.key), `missingConfirmVariantAxes disagrees on ${group}/${c}`)
            .toEqual(tsMissingConfirm(group, v, c).map((a) => a.key));
        }
      }
    }
  });
});
