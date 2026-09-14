// Staff request #28 (Sim): the MRP export must also come out ONE ROW PER SO LINE,
// so a short order can be traced to the orders consuming the stock ahead of it.
// flattenMrpExportLines is the whole rule; the page only hands it the rows the
// DataTable is showing (mrpExportLines.test.tsx pins that wiring).
import { describe, expect, test } from 'vitest';
import { toCSV } from '../../lib/csv';
import type { MrpLine, MrpSku } from '../../vendor/scm/lib/mrp-queries';
import { MRP_EXPORT_LINE_COLUMNS, flattenMrpExportLines } from './mrp-export-lines';

const line = (over: Partial<MrpLine>): MrpLine => ({
  soItemId: 'si', soDocNo: 'SO-1', lineNo: 1, createdAt: null,
  debtorName: 'CUST', customerState: 'Selangor', soDate: '2026-09-01',
  deliveryDate: '2026-10-01', processingDate: '2026-09-05', orderByDate: null,
  qty: 1, source: 'stock', poNumber: null, poEta: null, shortageQty: 0,
  poSupplierId: null, poSupplierName: null,
  ...over,
});

const sku = (over: Partial<MrpSku>): MrpSku => ({
  warehouseId: 'W1', warehouseCode: 'KL', warehouseName: 'KL WAREHOUSE',
  itemCode: 'BF-1', variantKey: 'v', variantLabel: 'Oak', description: 'Bedframe',
  category: 'BEDFRAME', qtyNeeded: 0, stock: 0, poOutstanding: 0, shortage: 0,
  mainSupplierCode: null, mainSupplierName: null, suppliers: [], lines: [],
  ...over,
});

/* One model, two colour variants: Oak has 2 on hand serving SO-A, a PO covering
   SO-B, and SO-C short; Walnut has one line of its own. */
const oak = sku({
  variantLabel: 'Oak', qtyNeeded: 6, stock: 2, poOutstanding: 3, shortage: 1,
  lines: [
    line({ soItemId: 'a', soDocNo: 'SO-A', debtorName: 'ALPHA', qty: 2, source: 'stock' }),
    line({ soItemId: 'b', soDocNo: 'SO-B', debtorName: 'BETA', qty: 3, source: 'po', poNumber: 'PO-9', poEta: '2026-09-20', poSupplierName: 'HOOKKA' }),
    line({ soItemId: 'c', soDocNo: 'SO-C', debtorName: 'GAMMA', qty: 1, source: 'shortage', shortageQty: 1, deliveryDate: null, processingDate: null }),
  ],
});
const walnut = sku({
  variantKey: 'w', variantLabel: 'Walnut', qtyNeeded: 1, stock: 5,
  lines: [line({ soItemId: 'd', soDocNo: 'SO-D', debtorName: 'DELTA', qty: 1 })],
});

describe('flattenMrpExportLines', () => {
  test('one row per SKU x SO line, in the order the drilldown lists them', () => {
    const rows = flattenMrpExportLines([{ itemCode: 'BF-1', variants: [oak, walnut] }], null);
    expect(rows.map((r) => r.soDocNo)).toEqual(['SO-A', 'SO-B', 'SO-C', 'SO-D']);
    expect(rows.map((r) => r.variant)).toEqual(['Oak', 'Oak', 'Oak', 'Walnut']);
    expect(rows.every((r) => r.itemCode === 'BF-1' && r.warehouse === 'KL')).toBe(true);
    expect(rows.map((r) => r.customer)).toEqual(['ALPHA', 'BETA', 'GAMMA', 'DELTA']);
    expect(rows.map((r) => r.qty)).toEqual([2, 3, 1, 1]);
  });

  test('coverage names the source; the PO number appears only on a PO-covered line', () => {
    const [a, b, c] = flattenMrpExportLines([{ itemCode: 'BF-1', variants: [oak] }], null);
    expect([a!.coverage, b!.coverage, c!.coverage]).toEqual(['Stock', 'PO', 'Shortage']);
    expect([a!.poNumber, b!.poNumber, c!.poNumber]).toEqual(['', 'PO-9', '']);
    expect(b!.poEta).toBe('2026-09-20');
    expect(b!.poSupplier).toBe('HOOKKA');
    expect([a!.shortageQty, b!.shortageQty, c!.shortageQty]).toEqual([0, 0, 1]);
  });

  test('a PO number left on a non-PO line is not exported as covering it', () => {
    const stray = sku({ lines: [line({ source: 'shortage', shortageQty: 2, qty: 2, poNumber: 'PO-PARTIAL', poSupplierName: 'X' })] });
    const [r] = flattenMrpExportLines([{ itemCode: 'BF-1', variants: [stray] }], null);
    expect(r!.coverage).toBe('Shortage');
    expect(r!.poNumber).toBe('');
    expect(r!.poSupplier).toBe('');
  });

  test('every row carries its SKU figures as the page shows them', () => {
    const rows = flattenMrpExportLines([{ itemCode: 'BF-1', variants: [oak, walnut] }], null);
    expect(rows.map((r) => r.skuStock)).toEqual([2, 2, 2, 5]);
    expect(rows[0]).toMatchObject({ skuQtyNeeded: 6, skuPoOutstanding: 3, skuShortage: 1 });
  });

  test('dates: an undated delivery says "No date" as the page does; a missing processing date is blank', () => {
    const [a, , c] = flattenMrpExportLines([{ itemCode: 'BF-1', variants: [oak] }], null);
    expect(a!.deliveryDate).toBe('2026-10-01');
    expect(a!.processingDate).toBe('2026-09-05');
    expect(c!.deliveryDate).toBe('No date');
    expect(c!.processingDate).toBe('');
  });

  test('a timestamp date exports as its calendar day', () => {
    const ts = sku({ lines: [line({ deliveryDate: '2026-10-01T00:00:00.000Z' })] });
    expect(flattenMrpExportLines([{ itemCode: 'BF-1', variants: [ts] }], null)[0]!.deliveryDate).toBe('2026-10-01');
  });

  test('sofa: the accessory riders shown under an SO follow its module lines, tagged', () => {
    const module = sku({
      itemCode: '9028-1A(LHF)', variantLabel: '9028-1A(LHF) · PC151', category: 'SOFA',
      lines: [line({ soItemId: 's1', soDocNo: 'SO-S', source: 'shortage', shortageQty: 1 })],
    });
    const cover = sku({ itemCode: 'PILLOW-1', variantLabel: null, description: 'Leather cover', category: 'ACCESSORY', stock: 4 });
    const coverLine = line({ soItemId: 'p1', soDocNo: 'SO-S', qty: 2, source: 'shortage', shortageQty: 2 });
    const rows = flattenMrpExportLines(
      [{ itemCode: 'SO-S', variants: [module] }, { itemCode: 'SO-OTHER', variants: [] }],
      new Map([['SO-S', [{ sku: cover, line: coverLine }]]]),
    );
    expect(rows.map((r) => [r.itemCode, r.rowType])).toEqual([
      ['9028-1A(LHF)', 'SO line'],
      ['PILLOW-1', 'Accessory on sofa order'],
    ]);
    expect(rows[1]).toMatchObject({ soDocNo: 'SO-S', qty: 2, shortageQty: 2, skuStock: 4, description: 'Leather cover', variant: '' });
  });

  test('nothing in view exports nothing', () => {
    expect(flattenMrpExportLines([], null)).toEqual([]);
  });

  test('the CSV header row', () => {
    const csv = toCSV(flattenMrpExportLines([{ itemCode: 'BF-1', variants: [oak] }], null), MRP_EXPORT_LINE_COLUMNS);
    expect(csv.split('\r\n')[0]).toBe(
      'Warehouse,Item Code,Description,Variant / Spec,Sales Order,Customer,State,SO Line Qty,Processing Date,Delivery Date,Coverage,Shortage Qty,PO No,PO ETA,PO Supplier,SKU Qty Needed,SKU Stock,SKU PO Outstanding,SKU Shortage,Row Type',
    );
  });
});
