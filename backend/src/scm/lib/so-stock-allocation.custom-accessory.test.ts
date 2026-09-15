/* Which accessory lines are bound to their own sales-order line: the SOFA ACCESSORY
   category, and nothing typed per SKU (owner 2026-09-14, on the Products page
   filtered to Sofa Accessory — SB02, BC05-MF, BC05, BC04-MF, BC04, AR02, AR01,
   SQUARE PILLOW, LONG PILLOW: 「这些sku全部都要处理」).

   A line's `item_group` is stamped from the SKU's product-master category when it
   is written ("SKU wins", docs/bugs/0514), so the group IS the category. The
   two-code list that bound the pillows by name before they were re-categorised is
   gone: it kept binding a pillow the owner moved back to Accessory, and it bound
   company 2's pillows too. */
import { describe, expect, test } from 'vitest';
import * as allocation from './so-stock-allocation';

const { isHardBoundLine } = allocation;
const SOFA_ACCESSORY_SKUS = ['SB02', 'BC05-MF', 'BC05', 'BC04-MF', 'BC04', 'AR02', 'AR01', 'SQUARE PILLOW', 'LONG PILLOW'];

describe('isHardBoundLine — the Sofa Accessory category', () => {
  test.each(SOFA_ACCESSORY_SKUS)('%s in fabric_accessory is bound', (code) => {
    expect(isHardBoundLine('fabric_accessory', code)).toBe(true);
  });

  test('the category decides, not the code: a SKU moved back to Accessory pools again', () => {
    expect(isHardBoundLine('accessory', 'SQUARE PILLOW')).toBe(false);
    expect(isHardBoundLine('accessory', 'LONG PILLOW')).toBe(false);
  });

  test('a new SKU in the category needs no code change', () => {
    expect(isHardBoundLine('fabric_accessory', 'SOME NEW CUSHION 09')).toBe(true);
  });

  test('the random / free-gift pillows are Accessory and keep pooling', () => {
    expect(isHardBoundLine('accessory', 'AMN-SOFA PILLOW')).toBe(false);
    expect(isHardBoundLine('accessory', 'SOFA PILLOW (FOC)')).toBe(false);
    expect(isHardBoundLine('accessory', 'SQUARE PILLOW RDM')).toBe(false);
  });

  test('no per-SKU binding list is exported any more', () => {
    expect('CUSTOM_ACCESSORY_CODES' in allocation).toBe(false);
  });

  test('the existing bound groups are unchanged', () => {
    expect(isHardBoundLine('sofa', '8030-1NA')).toBe(true);
    expect(isHardBoundLine('bedframe', 'JAGER-(Q)')).toBe(true);
    expect(isHardBoundLine('mattress', 'AKEMI BULWARK MATT (SP)')).toBe(true);
    expect(isHardBoundLine('mattress', 'AKEMI BULWARK MATT (K)')).toBe(false);
  });
});
