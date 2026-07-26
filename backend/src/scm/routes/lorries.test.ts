import { describe, it, expect } from 'vitest';
import { boxCapacityM3 } from './lorries';

describe('boxCapacityM3 — WS3 box capacity (ft -> m3)', () => {
  it('matches the HookkaERP worked example: 17 x 7 x 6.7 ft = 22.58 m3', () => {
    expect(boxCapacityM3(17, 7, 6.7)).toBe(22.58);
  });

  it('is null unless all three dimensions are present', () => {
    expect(boxCapacityM3(17, 7, null)).toBeNull();
    expect(boxCapacityM3(null, 7, 6.7)).toBeNull();
    expect(boxCapacityM3(17, null, 6.7)).toBeNull();
    expect(boxCapacityM3(null, null, null)).toBeNull();
  });

  it('rounds to 2 decimal places', () => {
    // 10 x 10 x 10 ft3 = 1000 * 0.0283168 = 28.3168 -> 28.32
    expect(boxCapacityM3(10, 10, 10)).toBe(28.32);
  });

  it('a zero dimension yields 0 (a present-but-empty box), not null', () => {
    expect(boxCapacityM3(17, 7, 0)).toBe(0);
  });
});
