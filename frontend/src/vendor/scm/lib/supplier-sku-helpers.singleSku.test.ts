import { describe, expect, test } from 'vitest';
import { composeSupplierSku, suffixForSku } from './supplier-sku-helpers';

describe('supplier SKU for a single-SKU Model (BUG-85)', () => {
  test('a Sofa Accessory code with a dash is a whole model code, not a compartment', () => {
    const sku = { code: 'BC06-MF', category: 'FABRIC_ACCESSORY' as const, size_code: null };
    expect(suffixForSku(sku)).toBe('');
    expect(composeSupplierSku('B06', sku)).toBe('B06');
  });

  test('a sofa SKU still takes its compartment', () => {
    expect(suffixForSku({ code: 'BOOQIT-1A(LHF)', category: 'SOFA', size_code: null })).toBe('1A(LHF)');
  });
});
