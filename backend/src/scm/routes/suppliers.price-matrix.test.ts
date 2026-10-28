import { describe, expect, it } from 'vitest';
import { validatePriceMatrix } from './suppliers';

// BUG-109: the SKU Pricing grid shows every Maintenance Sizes pool height, so a
// named height ("Flat") or an inch-marked one (`25"`) must save like "24".
describe('validatePriceMatrix sofa height keys', () => {
  it('accepts the Flat cell from the BUG-109 screenshot', () => {
    expect(validatePriceMatrix({ Flat: { P2: 73600 } }, 'SOFA')).toEqual({ Flat: { P2: 73600 } });
  });

  it('accepts numeric, inch-marked and DEFAULT heights side by side', () => {
    expect(validatePriceMatrix(
      { '28': { P2: 105600 }, '25"': { P1: 99000 }, DEFAULT: { P3: 1 } },
      'SOFA',
    )).toEqual({ '28': { P2: 105600 }, '25"': { P1: 99000 }, DEFAULT: { P3: 1 } });
  });

  // 2990-0024: supplier sofa lists price Full Leather as its own grade.
  it('accepts a sofa P4 cell; a bedframe P4 is still refused', () => {
    expect(validatePriceMatrix({ '24': { P3: 346000, P4: 454000 } }, 'SOFA')).toEqual({ '24': { P3: 346000, P4: 454000 } });
    expect(() => validatePriceMatrix({ P4: 1 }, 'BEDFRAME')).toThrow('invalid_price_matrix:bedframe_key:P4');
  });

  it('still rejects empty or symbol-led heights', () => {
    expect(() => validatePriceMatrix({ '': { P2: 1 } }, 'SOFA')).toThrow('invalid_price_matrix:sofa_height:');
    expect(() => validatePriceMatrix({ '"25': { P2: 1 } }, 'SOFA')).toThrow('invalid_price_matrix:sofa_height:"25');
    expect(() => validatePriceMatrix({ '24<script>': { P2: 1 } }, 'SOFA')).toThrow('invalid_price_matrix:sofa_height');
  });
});
