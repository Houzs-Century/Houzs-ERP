import { describe, expect, it } from 'vitest';
import { findColourKivLines } from './so-variant-check';
import { isColourKiv, isKivColourCode } from '../shared';

/* Colour-KIV detection (owner rule 2026-07-24, after SO-2607-016): a line that
   committed to a fabric SERIES (fabricId/fabricLabel) without a confirmed
   colour (no fabricCode or any colour-carrying alias) must block the
   Processing Date. The predicate is variants-only on purpose — it must catch
   the line whatever its item_group spelling is. */

describe('isColourKiv', () => {
  it('true for the incident shape: fabricId + fabricLabel, no fabricCode', () => {
    expect(isColourKiv({ fabricId: 'lib-uuid-1', fabricLabel: 'EZ' })).toBe(true);
  });

  it('true for a series committed by label alone (POS payload without the id)', () => {
    expect(isColourKiv({ fabricLabel: 'EZ' })).toBe(true);
  });

  it('false once the colour is confirmed via fabricCode', () => {
    expect(isColourKiv({ fabricId: 'lib-uuid-1', fabricLabel: 'EZ', fabricCode: 'EZ-04' })).toBe(false);
  });

  it('false when any colour-carrying alias is filled (GRN-family fabricColor)', () => {
    expect(isColourKiv({ fabricLabel: 'EZ', fabricColor: 'EZ-04' })).toBe(false);
    expect(isColourKiv({ fabricLabel: 'EZ', colorCode: 'EZ-04' })).toBe(false);
    expect(isColourKiv({ fabricLabel: 'EZ', colourLabel: 'Pearl' })).toBe(false);
  });

  it('false when no fabric series was committed at all (blank fabric is variants_incomplete, not KIV)', () => {
    expect(isColourKiv({})).toBe(false);
    expect(isColourKiv(null)).toBe(false);
    expect(isColourKiv({ seatHeight: '24' })).toBe(false);
  });

  /* Owner 2026-10-30: a KIV placeholder colour ("MAGIC Q KIV") is picked like
     any colour, so it fills fabricCode, colourId and colourLabel. It is still KIV. */
  it('true for a KIV placeholder colour picked like any colour', () => {
    expect(isColourKiv({
      fabricCode: 'MAGIC Q KIV', colourId: 'MAGIC Q KIV', fabricId: 'lib-uuid-2',
      fabricLabel: 'MAGIC-Q', colourLabel: 'COLOUR KIV',
    })).toBe(true);
    expect(isColourKiv({ fabricCode: 'PC151-KIV' })).toBe(true);
    expect(isColourKiv({ fabricCode: 'pc151 tbc', fabricLabel: 'PC151' })).toBe(true);
    expect(isColourKiv({ fabricColor: 'MAGIC_Q_KIV' })).toBe(true);
  });

  it('false once the placeholder is swapped for the real colour', () => {
    expect(isColourKiv({
      fabricCode: 'MAGIC Q 05', colourId: 'MAGIC Q 05', fabricId: 'lib-uuid-2',
      fabricLabel: 'MAGIC-Q', colourLabel: 'CUBE 05 OCEAN',
    })).toBe(false);
  });
});

describe('isKivColourCode', () => {
  it('true when the code ends in the word KIV or TBC', () => {
    for (const code of ['MAGIC Q KIV', 'PC151-KIV', 'PC151_KIV', 'magic q kiv', ' BO315 TBC ', 'KIV', 'tbc']) {
      expect(isKivColourCode(code)).toBe(true);
    }
  });

  it('false for a real colour, even one with KIV or TBC inside it', () => {
    for (const code of ['MAGIC Q 05', 'PC151-01', 'KIVA-01', 'TBC-01', 'SKIV', 'MAGIC Q KIVA', '', null, undefined]) {
      expect(isKivColourCode(code)).toBe(false);
    }
  });
});

describe('findColourKivLines', () => {
  it('returns the KIV lines with their series label, whatever the group spelling', () => {
    const out = findColourKivLines([
      { id: 'a', itemCode: 'SOFA-XAMMAR-L', group: 'SOFA - L SHAPE', variants: { fabricId: 'x', fabricLabel: 'EZ' } },
      { itemCode: 'SOFA-KATRIN-3S', group: 'sofa', variants: { fabricCode: 'EZ-04', fabricId: 'x', fabricLabel: 'EZ' } },
      { itemCode: 'SVC-DELIVERY', group: 'service', variants: null },
    ]);
    expect(out).toEqual([{ id: 'a', itemCode: 'SOFA-XAMMAR-L', fabricLabel: 'EZ' }]);
  });

  it('a line on a KIV placeholder colour blocks, with its series; its real colour does not', () => {
    expect(findColourKivLines([
      { id: 'b', itemCode: 'CELENE (A)-(Q)', group: 'bedframe', variants: { fabricCode: 'MAGIC Q KIV', fabricId: 'x', fabricLabel: 'MAGIC-Q', divanHeight: '8"' } },
      { itemCode: 'CELENE (A)-(K)', group: 'bedframe', variants: { fabricCode: 'MAGIC Q 05', fabricId: 'x', fabricLabel: 'MAGIC-Q', divanHeight: '8"' } },
    ])).toEqual([{ id: 'b', itemCode: 'CELENE (A)-(Q)', fabricLabel: 'MAGIC-Q' }]);
  });

  it('[] when every line is confirmed or fabric-less', () => {
    expect(findColourKivLines([
      { itemCode: 'BF-FENRIR-5FT', group: 'bedframe', variants: { fabricCode: 'BF-01', divanHeight: '10"' } },
    ])).toEqual([]);
  });
});
