// A sofa set is one batch or nothing (owner 2026-10-05: 1 PO = 1 batch, never
// split). The backend plans the set and reports, per module line, the stock
// slice it consumed (stockQty) and the batch it is planned from (batchNo). The
// Sofa tab's SO header row must roll those up the same way the module chips
// read them: Stock = units on hand in the covering batch, PO Outstanding = the
// rest of what the batch covers. Before this the header put the whole covered
// quantity under PO Outstanding and always showed Stock 0 — on
// 2990-SO-2610-005 the header read "Stock 0 / PO Outstanding 1" while the 2A
// module chip said "stock".
import { describe, expect, test } from 'vitest';
import { sofaSetsToSkus } from './mrp-model-pipeline';
import type { SofaSet } from '../../vendor/scm/lib/mrp-queries';

const SUPPLIER = { supplierId: 's1', code: 'HK', name: 'HOOKKA', isMain: true };
const set = (over: Partial<SofaSet>): SofaSet => ({
  warehouseId: 'W1', warehouseCode: 'KL', warehouseName: 'KL WAREHOUSE',
  soItemId: 'si', soDocNo: '2990-SO-2610-005', lineNo: 1, createdAt: '2026-10-03T00:00:00Z',
  debtorName: 'LEE HONG SENG', customerState: 'Selangor', soDate: '2026-10-03',
  deliveryDate: '2026-10-30', processingDate: '2026-10-03', orderByDate: '2026-10-10',
  itemCode: 'XAMMAR-1A(LHF)', description: 'XAMMAR', variantLabel: 'EZ-001 Pearl / SEAT 24',
  modules: [], colour: 'EZ-001', qty: 1, orderedQty: 0, shortageQty: 1,
  poNumber: null, poEta: null, poSupplierId: null, poSupplierName: null,
  suppliers: [SUPPLIER],
  ...over,
});

describe('sofaSetsToSkus — the SO header reads the same Stock / PO Outstanding as the module chips', () => {
  test('a set covered from one received batch: Stock carries it, PO Outstanding stays 0', () => {
    const rows = sofaSetsToSkus([
      set({ soItemId: 'a', itemCode: 'XAMMAR-1A(LHF)', orderedQty: 1, shortageQty: 0, stockQty: 1, batchNo: 'PO-X' }),
      set({ soItemId: 'b', itemCode: 'XAMMAR-2A(RHF)', orderedQty: 1, shortageQty: 0, stockQty: 1, batchNo: 'PO-X' }),
    ]);
    expect(rows.reduce((a, r) => a + r.stock, 0)).toBe(2);
    expect(rows.reduce((a, r) => a + r.poOutstanding, 0)).toBe(0);
    expect(rows.every((r) => r.lines[0]?.source === 'stock')).toBe(true);
    expect(rows.every((r) => r.lines[0]?.batchNo === 'PO-X')).toBe(true);
  });

  test('a partly received PO: the landed module is Stock, the rest is PO Outstanding, one batch on both', () => {
    const rows = sofaSetsToSkus([
      set({ soItemId: 'a', itemCode: 'XAMMAR-1A(LHF)', orderedQty: 1, shortageQty: 0, stockQty: 1, poNumber: 'PO-Y', poEta: '2026-10-25', batchNo: 'PO-Y' }),
      set({ soItemId: 'b', itemCode: 'XAMMAR-2A(RHF)', orderedQty: 1, shortageQty: 0, stockQty: 0, poNumber: 'PO-Y', poEta: '2026-10-25', batchNo: 'PO-Y' }),
    ]);
    expect(rows.reduce((a, r) => a + r.stock, 0)).toBe(1);
    expect(rows.reduce((a, r) => a + r.poOutstanding, 0)).toBe(1);
    expect(rows.every((r) => r.lines[0]?.source === 'po' && r.lines[0]?.poNumber === 'PO-Y')).toBe(true);
  });

  test('the production shape: nothing covers the set — every module short, no batch, no stock', () => {
    const rows = sofaSetsToSkus([
      set({ soItemId: 'a', itemCode: 'XAMMAR-1A(LHF)' }),
      set({ soItemId: 'b', itemCode: 'XAMMAR-2A(RHF)' }),
    ]);
    expect(rows.reduce((a, r) => a + r.shortage, 0)).toBe(2);
    expect(rows.reduce((a, r) => a + r.stock, 0)).toBe(0);
    expect(rows.every((r) => r.lines[0]?.source === 'shortage' && r.lines[0]?.batchNo === null)).toBe(true);
  });

  test('a response from before the field (no stockQty) still parses: covered quantity counts as PO Outstanding', () => {
    const rows = sofaSetsToSkus([set({ orderedQty: 1, shortageQty: 0, poNumber: 'PO-Z' })]);
    expect(rows[0]!.stock).toBe(0);
    expect(rows[0]!.poOutstanding).toBe(1);
  });
});
