import { describe, expect, test } from 'vitest';
import { buildScanLineVariants, type ScanLineVariantInput, type ScanVariantPools } from './scan-line-variants';

const pools: ScanVariantPools = {
  sofaSizes: ['28'],
  sofaLegHeights: ['Default', 'No Leg'],
  legHeights: ['No Leg', '4"', '6"'],
  divanHeights: ['8"', '10"', '12"'],
  gaps: ['12"', '14"'],
};

const line = (over: Partial<ScanLineVariantInput>): ScanLineVariantInput => ({
  divanHeightInches: null,
  legHeightInches: null,
  gapInches: null,
  noLeg: false,
  seatHeightInches: null,
  ...over,
});

describe('buildScanLineVariants totalHeight', () => {
  test('divan 12 + no leg + gap 14 gives 26"', () => {
    const v = buildScanLineVariants(line({ divanHeightInches: 12, noLeg: true, gapInches: 14 }), 'bedframe', true, pools);
    expect(v.totalHeight).toBe('26"');
  });

  test('divan 8 + leg 4 + gap 12 gives 24"', () => {
    const v = buildScanLineVariants(line({ divanHeightInches: 8, legHeightInches: 4, gapInches: 12 }), 'bedframe', true, pools);
    expect(v.totalHeight).toBe('24"');
  });

  test('divan only gives 12"', () => {
    const v = buildScanLineVariants(line({ divanHeightInches: 12 }), 'bedframe', true, pools);
    expect(v.totalHeight).toBe('12"');
  });

  test('no axes set gives no totalHeight key', () => {
    const v = buildScanLineVariants(line({}), 'bedframe', true, pools);
    expect('totalHeight' in v).toBe(false);
  });

  test('a sofa line never gets totalHeight', () => {
    const v = buildScanLineVariants(line({ seatHeightInches: 28, legHeightInches: 4 }), 'sofa', true, pools);
    expect(v.seatHeight).toBe('28');
    expect('totalHeight' in v).toBe(false);
  });
});
