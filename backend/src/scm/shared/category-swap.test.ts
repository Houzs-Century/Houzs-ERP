import { describe, expect, test } from 'vitest';
import { categorySwapAllowed } from './category-swap';

describe('categorySwapAllowed — only Accessory <-> Sofa Accessory', () => {
  test('both directions between the two accessory categories', () => {
    expect(categorySwapAllowed('ACCESSORY', 'FABRIC_ACCESSORY')).toBe(true);
    expect(categorySwapAllowed('FABRIC_ACCESSORY', 'ACCESSORY')).toBe(true);
  });
  test('a no-op is not a swap', () => {
    expect(categorySwapAllowed('ACCESSORY', 'ACCESSORY')).toBe(false);
  });
  test('anything touching a main category is refused', () => {
    expect(categorySwapAllowed('MATTRESS', 'SOFA')).toBe(false);
    expect(categorySwapAllowed('ACCESSORY', 'SOFA')).toBe(false);
    expect(categorySwapAllowed('SOFA', 'FABRIC_ACCESSORY')).toBe(false);
  });
  test('case and blanks', () => {
    expect(categorySwapAllowed('accessory', 'fabric_accessory')).toBe(true);
    expect(categorySwapAllowed(null, 'ACCESSORY')).toBe(false);
  });
});
