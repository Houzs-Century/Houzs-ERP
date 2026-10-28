import { describe, expect, it } from 'vitest';
import { findColourKivLines } from './so-variant-check';
import { isColourKiv } from '../shared';

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

  it('[] when every line is confirmed or fabric-less', () => {
    expect(findColourKivLines([
      { itemCode: 'BF-FENRIR-5FT', group: 'bedframe', variants: { fabricCode: 'BF-01', divanHeight: '10"' } },
    ])).toEqual([]);
  });
});
