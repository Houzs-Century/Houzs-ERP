import { describe, expect, it } from 'vitest';
import { validatePricesByHeight } from './sofa-combos';

// BUG-46: the Maintenance Sizes pool holds inch-marked seat heights (`25"`),
// and the Combo Pricing composer sends every pool height, so a key with `"`
// must not refuse the whole grid.
describe('validatePricesByHeight height keys', () => {
  it('accepts the composer payload from the BUG-46 screenshot', () => {
    const out = validatePricesByHeight({
      '24': 205200, '25"': null, '26': 205200, '27"': null, '28': 205200,
      '29"': null, '30': 214000, '32': 258000, '35': 258000, Default: null,
    });
    expect(out).not.toBeNull();
    expect(out!['25"']).toBeNull();
    expect(out!['24']).toBe(205200);
  });

  it('keeps an inch-marked key verbatim with its price', () => {
    expect(validatePricesByHeight({ '27"': 199900 })).toEqual({ '27"': 199900 });
  });

  it('still rejects empty or symbol-led keys', () => {
    expect(validatePricesByHeight({ '': 1 })).toBeNull();
    expect(validatePricesByHeight({ '"25': 1 })).toBeNull();
    expect(validatePricesByHeight({ '24<script>': 1 })).toBeNull();
  });
});
