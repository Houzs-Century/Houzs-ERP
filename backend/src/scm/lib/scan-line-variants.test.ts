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

const build = (
  over: Partial<ScanLineVariantInput>,
  category = 'bedframe',
  totalHeights: string[] | null = null,
  skuCode = 'HILTON-K',
): Record<string, unknown> =>
  buildScanLineVariants(line(over), { category, skuCode, pools, totalHeights });

describe('buildScanLineVariants totalHeight', () => {
  test('divan 12 + no leg + gap 14 gives 26"', () => {
    expect(build({ divanHeightInches: 12, noLeg: true, gapInches: 14 }).totalHeight).toBe('26"');
  });

  test('divan 8 + leg 4 + gap 12 gives 24"', () => {
    expect(build({ divanHeightInches: 8, legHeightInches: 4, gapInches: 12 }).totalHeight).toBe('24"');
  });

  test('divan only gives 12"', () => {
    expect(build({ divanHeightInches: 12 }).totalHeight).toBe('12"');
  });

  test('no axes set gives no totalHeight key', () => {
    expect('totalHeight' in build({})).toBe(false);
  });

  test('a sofa line never gets totalHeight', () => {
    const v = build({ seatHeightInches: 28, legHeightInches: 4 }, 'sofa');
    expect(v.seatHeight).toBe('28');
    expect('totalHeight' in v).toBe(false);
  });
});

describe('buildScanLineVariants total height pool gate', () => {
  const spec = { divanHeightInches: 12, noLeg: true, gapInches: 14 };

  test('a restricted pool without the sum leaves the key off', () => {
    expect('totalHeight' in build(spec, 'bedframe', ['20"', '24"'])).toBe(false);
  });

  test('a pool listing the sum with a curly inch mark keeps it', () => {
    expect(build(spec, 'bedframe', ['26“']).totalHeight).toBe('26"');
  });

  test('an unrestricted pool (null or empty) keeps it', () => {
    expect(build(spec, 'bedframe', null).totalHeight).toBe('26"');
    expect(build(spec, 'bedframe', []).totalHeight).toBe('26"');
  });

  test('a DIVAN ONLY code keeps it even when the pool lacks the sum', () => {
    expect(build(spec, 'bedframe', ['20"'], 'HILTON DIVAN ONLY-K').totalHeight).toBe('26"');
  });
});
