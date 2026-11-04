import { describe, expect, test } from 'vitest';
import { kivSourceCode } from '../scripts/lib/kiv-bedframe-cost.mjs';

describe('kivSourceCode', () => {
  test('each level takes its model, size for size', () => {
    expect(kivSourceCode('BEDFRAME KIV LV1-(K)')).toBe('JAGER-(K)');
    expect(kivSourceCode('BEDFRAME KIV LV2-(Q)')).toBe('CODY-(Q)');
    expect(kivSourceCode('BEDFRAME KIV LV3-(SS)')).toBe('REGAL (A)-(SS)');
    expect(kivSourceCode('BEDFRAME KIV LV4-(SK)')).toBe('TRION (A)-(SK)');
  });
  test('the bare level and other products have no source', () => {
    expect(kivSourceCode('BEDFRAME KIV LV2')).toBeNull();
    expect(kivSourceCode('CODY-(Q)')).toBeNull();
  });
});
