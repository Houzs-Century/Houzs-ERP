/* The predicate itself: which lines are custom accessories bound to their own
   sales-order line (owner 2026-09-14). Matched on the SKU — the CUSTOM SKU is by
   definition the one that carries a chosen colour (owner 2026-09-10: a pillow
   with a colour belongs on SQUARE PILLOW, one without on SQUARE PILLOW RDM). */
import { describe, expect, test } from 'vitest';
import { isHardBoundLine, CUSTOM_ACCESSORY_CODES } from './so-stock-allocation';

describe('isHardBoundLine — custom pillows', () => {
  test('SQUARE PILLOW and LONG PILLOW are bound, whatever the case or padding', () => {
    expect(isHardBoundLine('accessory', 'SQUARE PILLOW')).toBe(true);
    expect(isHardBoundLine('accessory', 'LONG PILLOW')).toBe(true);
    expect(isHardBoundLine('Accessory', '  long pillow ')).toBe(true);
  });

  test('the item group does not decide it — a mis-grouped purchase line is still the same pillow', () => {
    expect(isHardBoundLine(null, 'SQUARE PILLOW')).toBe(true);
    expect(isHardBoundLine('others', 'LONG PILLOW')).toBe(true);
  });

  test('the RANDOM twin and other pillow SKUs keep pooling', () => {
    expect(isHardBoundLine('accessory', 'SQUARE PILLOW RDM')).toBe(false);
    expect(isHardBoundLine('accessory', '822 SQUARE PILLOW')).toBe(false);
    expect(isHardBoundLine('accessory', 'AMN-SOFA PILLOW')).toBe(false);
    expect(isHardBoundLine('accessory', 'AK- ESSENTIAL BOLSTER')).toBe(false);
  });

  test('the list is exactly the two SKUs the owner named', () => {
    expect([...CUSTOM_ACCESSORY_CODES].sort()).toEqual(['LONG PILLOW', 'SQUARE PILLOW']);
  });

  test('the existing bound groups are unchanged', () => {
    expect(isHardBoundLine('sofa', '8030-1NA')).toBe(true);
    expect(isHardBoundLine('bedframe', 'JAGER-(Q)')).toBe(true);
    expect(isHardBoundLine('mattress', 'AKEMI BULWARK MATT (SP)')).toBe(true);
    expect(isHardBoundLine('mattress', 'AKEMI BULWARK MATT (K)')).toBe(false);
  });
});
