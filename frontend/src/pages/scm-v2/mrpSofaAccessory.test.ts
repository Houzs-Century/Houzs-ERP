import { describe, expect, it } from 'vitest';
import type { MrpLine, MrpSku } from '../../vendor/scm/lib/mrp-queries';
import { isSofaAccessory, sofaAccessoryRowsPerSo } from './mrp-sofa-accessory';
import { mrpViews, rowBelongsToView } from './mrp-views';

const line = (so: string, qty: number, source: MrpLine['source'], id: string): MrpLine => ({
  soItemId: id, soDocNo: so, debtorName: null, customerState: null, soDate: null, deliveryDate: null,
  processingDate: null, orderByDate: null, qty, source, poNumber: null, poEta: null,
  shortageQty: source === 'shortage' ? qty : 0, poSupplierId: null, poSupplierName: null,
});
const sku = (over: Partial<MrpSku>): MrpSku => ({
  warehouseId: 'wh', warehouseCode: 'KL', warehouseName: 'KL', itemCode: 'SQUARE PILLOW',
  variantKey: 'fabriccode=cove-03', variantLabel: 'COVE-03', description: null, category: 'FABRIC_ACCESSORY',
  qtyNeeded: 5, stock: 0, poOutstanding: 0, shortage: 5, mainSupplierCode: null, mainSupplierName: null,
  suppliers: [], lines: [], ...over,
});

describe('Sofa Accessory rows on the MRP Sofa tab', () => {
  it('cuts a pooled SKU into one row per SO, with that SO’s own totals', () => {
    const rows = sofaAccessoryRowsPerSo([sku({
      lines: [line('SO-A', 2, 'shortage', 'a1'), line('SO-B', 3, 'po', 'b1'), line('SO-A', 1, 'stock', 'a2')],
    })]);
    expect(rows.map((r) => r.lines[0].soDocNo)).toEqual(['SO-A', 'SO-B']);
    expect(rows[0]).toMatchObject({ qtyNeeded: 3, shortage: 2, stock: 1, poOutstanding: 0, variantLabel: 'SQUARE PILLOW · COVE-03' });
    expect(rows[1]).toMatchObject({ qtyNeeded: 3, shortage: 0, poOutstanding: 3 });
    expect(new Set(rows.map((r) => r.variantKey)).size).toBe(2);
  });

  it('leaves plain accessories alone', () => {
    expect(sofaAccessoryRowsPerSo([sku({ category: 'ACCESSORY', lines: [line('SO-A', 1, 'shortage', 'x')] })])).toEqual([]);
    expect(isSofaAccessory('ACCESSORY')).toBe(false);
    expect(isSofaAccessory('fabric_accessory')).toBe(true);
  });

  it('is not also shown on the Others tab', () => {
    const others = mrpViews().find((v) => v.value === 'others')!;
    expect(rowBelongsToView(others, 'FABRIC_ACCESSORY')).toBe(false);
    expect(rowBelongsToView(others, 'DINING')).toBe(true);
  });
});

describe('the Sofa tab owns Sofa Accessory', () => {
  it('rowBelongsToView says so, so the category is reachable', () => {
    const sofa = mrpViews().find((v) => v.value === 'sofa')!;
    expect(rowBelongsToView(sofa, 'FABRIC_ACCESSORY')).toBe(true);
    expect(rowBelongsToView(sofa, 'ACCESSORY')).toBe(false);
  });
});
