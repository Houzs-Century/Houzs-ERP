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

  it('still rejects empty or symbol-led heights', () => {
    expect(() => validatePriceMatrix({ '': { P2: 1 } }, 'SOFA')).toThrow('invalid_price_matrix:sofa_height:');
    expect(() => validatePriceMatrix({ '"25': { P2: 1 } }, 'SOFA')).toThrow('invalid_price_matrix:sofa_height:"25');
    expect(() => validatePriceMatrix({ '24<script>': { P2: 1 } }, 'SOFA')).toThrow('invalid_price_matrix:sofa_height');
  });
});
