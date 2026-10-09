// BUG-97: Sim ticked 2B(LHF) / 2B(RHF) on Model 9028 (VERANO). The SKUs were
// made, but none of the five suppliers that map 9028 got a binding, so their
// SKU Pricing tabs had no row to price. Shapes below are the real prod ones.
import { describe, expect, test } from 'vitest';
import type { BindingRow } from './suppliers-queries';
import type { MfgProductRow } from './mfg-products-queries';
import { findModelSkuGaps, gapToNewBinding, supplierSkuFromSibling } from './supplier-model-gaps';

const M9028 = 'model-9028';
const sku = (code: string, extra: Partial<MfgProductRow> = {}): MfgProductRow => ({
  id: `id-${code}`, code, name: `SOFA VERANO ${code.slice(5)}`, category: 'SOFA',
  base_price_sen: null, price1_sen: null, status: 'ACTIVE', model_id: M9028,
  base_model: '9028', unit_m3_milli: 0, ...extra,
});
const bind = (item: string, supplierSku: string, extra: Partial<BindingRow> = {}): BindingRow => ({
  id: `b-${item}`, supplier_id: 's1', material_kind: 'mfg_product', item_code: item,
  ac_item_code: null, material_name: item, supplier_sku: supplierSku, unit_price_sen: 0,
  currency: 'MYR', lead_time_days: 21, payment_terms_override: null, moq: 1,
  price_valid_from: null, price_valid_to: null, is_main_supplier: false, notes: null,
  price_matrix: { '24': { P1: 100000 } } as unknown as BindingRow['price_matrix'],
  is_cost_anchor: false,
  ...extra,
} as BindingRow);

const catalogue = [
  sku('9028-1A(LHF)'), sku('9028-1A(RHF)'), sku('9028-3S'), sku('9028-STOOL'),
  sku('9028-2B(LHF)'), sku('9028-2B(RHF)'),
  sku('9028-OLD', { status: 'INACTIVE' }),
  sku('9028-1A(LHF)-X1', { one_shot: true }),
  sku('5539-1A(LHF)', { model_id: 'model-5539', base_model: '5539' }),
];

describe('supplierSkuFromSibling', () => {
  test("copies the supplier's own shape, swapping the compartment", () => {
    const sib = sku('9028-1A(LHF)');
    expect(supplierSkuFromSibling({ supplier_sku: 'AMN-SF9028 SOFA 1A(LHF)' }, sib, sku('9028-2B(LHF)')))
      .toBe('AMN-SF9028 SOFA 2B(LHF)');
    expect(supplierSkuFromSibling({ supplier_sku: '5530-1A(LHF)' }, sib, sku('9028-2B(RHF)')))
      .toBe('5530-2B(RHF)');
  });

  test('falls back to the internal code when the sibling code does not end in its compartment', () => {
    expect(supplierSkuFromSibling({ supplier_sku: 'VERANO' }, sku('9028-1A(LHF)'), sku('9028-2B(LHF)')))
      .toBe('9028-2B(LHF)');
  });
});

describe('findModelSkuGaps', () => {
  test("lists active codes of a mapped Model that this supplier has not mapped", () => {
    const bindings = [
      bind('9028-1A(LHF)', 'AMN-SF9028 SOFA 1A(LHF)'),
      bind('9028-1A(RHF)', 'AMN-SF9028 SOFA 1A(RHF)'),
      bind('9028-3S', 'AMN-SF9028 SOFA 3S'),
    ];
    const gaps = findModelSkuGaps(bindings, catalogue);
    expect(gaps.map((g) => [g.product.code, g.supplierSku])).toEqual([
      ['9028-2B(LHF)', 'AMN-SF9028 SOFA 2B(LHF)'],
      ['9028-2B(RHF)', 'AMN-SF9028 SOFA 2B(RHF)'],
      ['9028-STOOL', 'AMN-SF9028 SOFA STOOL'],
    ]);
  });

  test('a Model the supplier does not map at all is not listed', () => {
    const gaps = findModelSkuGaps([bind('9028-1A(LHF)', '5530-1A(LHF)')], catalogue);
    expect(gaps.some((g) => g.product.code.startsWith('5539'))).toBe(false);
  });

  test('nothing to list once every active code is mapped', () => {
    const all = ['9028-1A(LHF)', '9028-1A(RHF)', '9028-3S', '9028-STOOL', '9028-2B(LHF)', '9028-2B(RHF)'];
    expect(findModelSkuGaps(all.map((c) => bind(c, `5530-${c.slice(5)}`)), catalogue)).toEqual([]);
  });

  test('prefers a sibling whose code carries its compartment', () => {
    const gaps = findModelSkuGaps([
      bind('9028-3S', 'VERANO'),
      bind('9028-1A(LHF)', 'DSL-9028 SOFA 1A(LHF)'),
    ], [sku('9028-3S'), sku('9028-1A(LHF)'), sku('9028-2B(LHF)')]);
    expect(gaps.map((g) => g.supplierSku)).toEqual(['DSL-9028 SOFA 2B(LHF)']);
  });
});

describe('gapToNewBinding', () => {
  test('no price; lead time, MOQ, currency and Main follow the sibling', () => {
    const [gap] = findModelSkuGaps(
      [bind('9028-1A(LHF)', '5530-1A(LHF)', { lead_time_days: 30, moq: 2, is_main_supplier: true })],
      [sku('9028-1A(LHF)'), sku('9028-2B(LHF)')],
    );
    const nb = gapToNewBinding(gap!);
    expect(nb).toMatchObject({
      materialKind: 'mfg_product', itemCode: '9028-2B(LHF)', supplierSku: '5530-2B(LHF)',
      currency: 'MYR', leadTimeDays: 30, moq: 2, isMainSupplier: true,
    });
    expect(nb.unitPriceSen).toBeUndefined();
    expect(nb.priceMatrix).toBeUndefined();
  });
});
