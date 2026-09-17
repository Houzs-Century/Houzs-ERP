// @vitest-environment node
// (No DOM here — pure builders + a write-excel-file round-trip read back with
// SheetJS. The node env gives a Blob with .arrayBuffer(), which jsdom's lacks.)
// MRP Stock Status Report — v7 Excel export. Pins the layout the owner approved
// (MRP-Export-Layout-Mockup-v7.xlsx) and that each sheet mirrors what the tab
// shows on screen: sheet-per-category, sofa grouped by SO vs others by SKU, the
// coverage-chip string, the shortage-row flag, and following the page filters
// over the WHOLE set.
import { describe, expect, test } from 'vitest';
import { read, utils } from 'xlsx';
import type { MrpSku, MrpLine, MrpResponse, SofaSet } from '../../vendor/scm/lib/mrp-queries';
import { mrpViews } from './mrp-views';
import { computeTabModels } from './mrp-model-pipeline';
import {
  buildSheetRows, buildMrpWorkbookBlob, coverageText, poOutstandingText, statusText, supplierText, sofaSpec,
  MRP_EXPORT_HEADERS, type SheetSpec, type SheetRow,
} from './mrp-export-workbook';

type DemandRow = Extract<SheetRow, { kind: 'demand' }>;
const demandRows = (rows: SheetRow[]): DemandRow[] => rows.filter((r): r is DemandRow => r.kind === 'demand');

const line = (over: Partial<MrpLine>): MrpLine => ({
  soItemId: 'si', soDocNo: 'HC-SO-0001', lineNo: 1, createdAt: null,
  debtorName: 'Lim H.', customerState: 'Selangor',
  soDate: '2026-09-01', deliveryDate: '2026-10-01', processingDate: '2026-09-02', orderByDate: null,
  qty: 1, source: 'stock', poNumber: null, poEta: null, shortageQty: 0,
  poSupplierId: null, poSupplierName: null, ...over,
});

const sku = (over: Partial<MrpSku>): MrpSku => ({
  warehouseId: 'w-kl', warehouseCode: 'KL', warehouseName: 'KL Main',
  itemCode: 'AK-MATT (K)', variantKey: '', variantLabel: null,
  description: 'AKEMI MATTRESS', category: 'MATTRESS',
  qtyNeeded: 1, stock: 4, poOutstanding: 0, shortage: 0,
  mainSupplierCode: null, mainSupplierName: null, suppliers: [], lines: [line({})], ...over,
});

const sofaSet = (over: Partial<SofaSet>): SofaSet => ({
  warehouseId: 'w-kl', warehouseCode: 'KL', warehouseName: 'KL Main',
  soItemId: 'si', soDocNo: 'HC-SO-013230', lineNo: 1, createdAt: null,
  debtorName: 'Yumiko', customerState: 'Johor',
  soDate: '2026-08-01', deliveryDate: '2026-10-09', processingDate: '2026-08-12', orderByDate: null,
  itemCode: '5535-L(LHF)', description: null, variantLabel: 'BO315-21 PEARL / SEAT 32',
  modules: [], colour: null, qty: 1, orderedQty: 0, shortageQty: 0,
  poNumber: null, poEta: null, poSupplierId: null, poSupplierName: null, suppliers: [], ...over,
});

const emptyResp = (over: Partial<MrpResponse>): MrpResponse => ({
  asOf: '2026-09-16T00:00:00Z', categories: ['SOFA', 'BEDFRAME', 'MATTRESS', 'ACCESSORY'],
  warehouses: [], skus: [], sofaSets: [],
  totals: { skuCount: 0, shortageSkuCount: 0, shortageUnits: 0, sofaSetCount: 0, sofaSetShortageCount: 0 },
  ...over,
});

const NO_FILTERS = { dateFrom: '', dateTo: '', dateBasis: 'delivery' as const, onlyShort: false, search: '' };
const views = mrpViews(undefined);
const viewOf = (v: string) => views.find((x) => x.value === v)!;

describe('coverage / status / supplier / spec cells', () => {
  test('coverage: stock / needs PO, blank for a PO-covered line', () => {
    expect(coverageText({ source: 'stock', poNumber: null, poEta: null })).toBe('stock');
    expect(coverageText({ source: 'shortage', poNumber: null, poEta: null })).toBe('needs PO');
    expect(coverageText({ source: 'po', poNumber: 'HC-PO-2609-018', poEta: '2026-09-25' })).toBe('');
  });

  test('PO Outstanding: the covering PO string, blank off a PO-covered line', () => {
    expect(poOutstandingText({ source: 'stock', poNumber: null, poEta: null })).toBe('');
    expect(poOutstandingText({ source: 'shortage', poNumber: null, poEta: null })).toBe('');
    // PO number, two spaces, U+00B7, two spaces, ETA dd/mm/yyyy.
    expect(poOutstandingText({ source: 'po', poNumber: 'HC-PO-2609-018', poEta: '2026-09-25' }))
      .toBe('HC-PO-2609-018  ·  ETA 25/09/2026');
    // A covering PO with no ETA is just the number.
    expect(poOutstandingText({ source: 'po', poNumber: 'HC-PO-009942', poEta: null })).toBe('HC-PO-009942');
  });

  test('status word is derived from the coverage source', () => {
    expect(statusText('stock')).toBe('READY');
    expect(statusText('po')).toBe('IN PRODUCTION');
    expect(statusText('shortage')).toBe('CONFIRMED');
  });

  test('supplier: PO line shows the PO supplier, shortage shows the main, stock blank', () => {
    const s = sku({ mainSupplierName: 'DIGLANT MANUFACTURING SDN BHD' });
    expect(supplierText(s, { source: 'po', poSupplierName: 'OHANA STUDIO SDN BHD' })).toBe('OHANA STUDIO SDN BHD');
    expect(supplierText(s, { source: 'shortage', poSupplierName: null })).toBe('DIGLANT MANUFACTURING SDN BHD');
    expect(supplierText(s, { source: 'stock', poSupplierName: null })).toBe('');
  });

  test('sofa spec strips the "<code> · " prefix, leaving only the fabric/spec', () => {
    expect(sofaSpec('5535-L(LHF)', '5535-L(LHF) · BO315-21 PEARL / SEAT 32')).toBe('BO315-21 PEARL / SEAT 32');
    expect(sofaSpec('5535-L(LHF)', '5535-L(LHF)')).toBe(''); // itemCode only → no spec
    expect(sofaSpec('X', null)).toBe('');
  });
});

describe('buildSheetRows — SKU-grouped (non-sofa)', () => {
  const idx = (label: string) => MRP_EXPORT_HEADERS.indexOf(label as (typeof MRP_EXPORT_HEADERS)[number]);
  const data = emptyResp({
    skus: [sku({
      itemCode: 'AK-MATT (Q)', description: 'AKEMI MATTRESS (Q)', qtyNeeded: 2, stock: 2, shortage: 1,
      mainSupplierName: 'DIGLANT MANUFACTURING SDN BHD',
      suppliers: [{ supplierId: 's1', code: 'DIG', name: 'DIGLANT MANUFACTURING SDN BHD', isMain: true }],
      lines: [
        line({ soItemId: 'a', soDocNo: 'HC-SO-013411', source: 'po', poNumber: 'HC-PO-2609-018', poEta: '2026-09-25', poSupplierName: 'DIGLANT MANUFACTURING SDN BHD' }),
        line({ soItemId: 'b', soDocNo: 'HC-SO-013475', source: 'shortage', shortageQty: 1, deliveryDate: '2026-10-04' }),
      ],
    })],
  });
  const { displayModels, accessoryBySoDoc } = computeTabModels(data, viewOf('mattress'), NO_FILTERS);
  const rows = buildSheetRows(false, displayModels, accessoryBySoDoc);

  test('a green group header carries code + description + rolled-up numbers', () => {
    const g = rows.find((r) => r.kind === 'group')!;
    expect(g.kind).toBe('group');
    expect(g.cells[idx('Item Code')]).toBe('AK-MATT (Q)');
    expect(g.cells[idx('Description')]).toBe('AKEMI MATTRESS (Q)');
    expect(g.cells[idx('Qty Needed')]).toBe(2);
    expect(g.cells[idx('Stock')]).toBe(2);
    expect(g.cells[idx('Shortage')]).toBe(1);
    expect(g.cells[idx('Warehouse')]).toBeNull(); // A blank on a non-sofa group header
    expect(g.cells[idx('SO No')]).toBeNull();
  });

  test('demand rows carry warehouse/SO/dates/coverage/status; the code column is blank', () => {
    const demand = demandRows(rows);
    expect(demand).toHaveLength(2);
    const po = demand[0]!;
    expect(po.cells[idx('Item Code')]).toBeNull(); // code lives on the header
    expect(po.cells[idx('Warehouse')]).toBe('KL');
    expect(po.cells[idx('SO No')]).toBe('HC-SO-013411');
    expect(po.cells[idx('Processing Date')]).toBe('2026-09-02'); // ISO (sorts as text)
    expect(po.cells[idx('Delivery Date')]).toBe('2026-10-01');
    expect(po.cells[idx('Coverage')]).toBe(''); // a PO-covered line leaves Coverage blank
    expect(po.cells[idx('PO Outstanding')]).toBe('HC-PO-2609-018  ·  ETA 25/09/2026');
    expect(po.cells[idx('Status')]).toBe('IN PRODUCTION');
    expect(po.cells[idx('Supplier')]).toBe('DIGLANT MANUFACTURING SDN BHD');
    expect(po.cells[idx('Shortage')]).toBe(0);
  });

  test('a shortage demand row is flagged (whole row goes red) and shows needs PO', () => {
    const short = demandRows(rows).find((r) => r.shortage)!;
    expect(short.shortage).toBe(true);
    expect(short.cells[idx('Coverage')]).toBe('needs PO');
    expect(short.cells[idx('PO Outstanding')]).toBe('');
    expect(short.cells[idx('Shortage')]).toBe(1);
    expect(short.cells[idx('Status')]).toBe('CONFIRMED');
  });
});

describe('buildSheetRows — SO-grouped (sofa)', () => {
  const idx = (label: string) => MRP_EXPORT_HEADERS.indexOf(label as (typeof MRP_EXPORT_HEADERS)[number]);
  const data = emptyResp({
    sofaSets: [
      sofaSet({ itemCode: '5535-L(LHF)', variantLabel: 'BO315-21 PEARL / SEAT 32', qty: 1, lineNo: 1,
        poNumber: 'HC-PO-009942', poEta: '2026-09-25', poSupplierName: 'OHANA STUDIO SDN BHD' }),
      sofaSet({ itemCode: '5535-2A(RHF)', variantLabel: 'BO315-21 PEARL / SEAT 32', qty: 1, soItemId: 'si2', lineNo: 2,
        poNumber: 'HC-PO-009942', poEta: '2026-09-25', poSupplierName: 'OHANA STUDIO SDN BHD' }),
    ],
    // An ACCESSORY shortage line on the same SO → a cover rider under the sofa.
    skus: [sku({
      itemCode: 'PILLOW', description: 'SQUARE PILLOW', category: 'ACCESSORY', variantLabel: null,
      shortage: 3, stock: 0, mainSupplierName: 'OHANA STUDIO SDN BHD',
      suppliers: [{ supplierId: 's', code: 'OH', name: 'OHANA STUDIO SDN BHD', isMain: true }],
      lines: [line({ soItemId: 'p1', soDocNo: 'HC-SO-013230', source: 'shortage', shortageQty: 3, qty: 3 })],
    })],
  });
  const { displayModels, accessoryBySoDoc } = computeTabModels(data, viewOf('sofa'), NO_FILTERS);
  const rows = buildSheetRows(true, displayModels, accessoryBySoDoc);

  test('the group header is the SALES ORDER: SO no + set composition + customer/dates', () => {
    const g = rows.find((r) => r.kind === 'group')!;
    expect(g.cells[idx('Warehouse')]).toBe('KL');
    expect(g.cells[idx('Item Code')]).toBe('HC-SO-013230');      // the SO doc no
    expect(g.cells[idx('Description')]).toBe('5535: L(LHF) + 2A(RHF)'); // composition
    expect(g.cells[idx('Customer')]).toBe('Yumiko');
    expect(g.cells[idx('State')]).toBe('Johor');
    expect(g.cells[idx('Delivery Date')]).toBe('2026-10-09');
  });

  test('module pieces sit under the SO: code in B, fabric/spec in Item Description 2', () => {
    const pieces = demandRows(rows).slice(0, 2);
    expect(pieces.map((p) => p.cells[idx('Item Code')])).toEqual(['5535-L(LHF)', '5535-2A(RHF)']);
    expect(pieces[0]!.cells[idx('Item Description 2')]).toBe('BO315-21 PEARL / SEAT 32');
    expect(pieces[0]!.cells[idx('Coverage')]).toBe('');
    expect(pieces[0]!.cells[idx('PO Outstanding')]).toBe('HC-PO-009942  ·  ETA 25/09/2026');
    expect(pieces[0]!.cells[idx('Supplier')]).toBe('OHANA STUDIO SDN BHD');
  });

  test('a cover / pillow rider rides under its SO as a shortage row', () => {
    const rider = demandRows(rows).at(-1)!;
    expect(rider.cells[idx('Item Code')]).toBe('PILLOW');
    expect(rider.cells[idx('Coverage')]).toBe('needs PO');
    expect(rider.cells[idx('PO Outstanding')]).toBe('');
    expect(rider.shortage).toBe(true);
  });
});

describe('computeTabModels — grouping, filters, whole set', () => {
  const data = emptyResp({
    skus: [
      sku({ itemCode: 'MATT-A', shortage: 0, lines: [line({ soDocNo: 'HC-SO-1', source: 'stock' })] }),
      sku({ itemCode: 'MATT-B', shortage: 1, stock: 0, lines: [line({ soDocNo: 'HC-SO-2', source: 'shortage', shortageQty: 1 })] }),
    ],
  });

  test('mattress groups by SKU: one group per item code, ALL rows (never a page)', () => {
    const { displayModels } = computeTabModels(data, viewOf('mattress'), NO_FILTERS);
    expect(displayModels.map((g) => g.itemCode).sort()).toEqual(['MATT-A', 'MATT-B']);
  });

  test('only-shortages keeps just the short group; search narrows by code', () => {
    const short = computeTabModels(data, viewOf('mattress'), { ...NO_FILTERS, onlyShort: true });
    expect(short.displayModels.map((g) => g.itemCode)).toEqual(['MATT-B']);
    const found = computeTabModels(data, viewOf('mattress'), { ...NO_FILTERS, search: 'matt-a' });
    expect(found.displayModels.map((g) => g.itemCode)).toEqual(['MATT-A']);
  });

  test('sofa groups by SALES ORDER, not by SKU', () => {
    const sofaData = emptyResp({
      sofaSets: [
        sofaSet({ soDocNo: 'HC-SO-100', itemCode: 'M-L', soItemId: 'x1' }),
        sofaSet({ soDocNo: 'HC-SO-100', itemCode: 'M-R', soItemId: 'x2', lineNo: 2 }),
        sofaSet({ soDocNo: 'HC-SO-200', itemCode: 'M-L', soItemId: 'y1' }),
      ],
    });
    const { displayModels } = computeTabModels(sofaData, viewOf('sofa'), NO_FILTERS);
    // Two SOs → two groups; the first has both modules under it.
    expect(displayModels.map((g) => g.itemCode).sort()).toEqual(['HC-SO-100', 'HC-SO-200']);
    const so100 = displayModels.find((g) => g.itemCode === 'HC-SO-100')!;
    expect(so100.variants.map((v) => v.itemCode)).toEqual(['M-L', 'M-R']);
  });
});

describe('buildMrpWorkbookBlob — the rendered workbook', () => {
  test('one sheet per category tab, values land in the v7 cells', async () => {
    const matData = emptyResp({
      skus: [sku({
        itemCode: 'AK-MATT (Q)', qtyNeeded: 1, stock: 0, shortage: 1,
        mainSupplierName: 'DIGLANT MANUFACTURING SDN BHD',
        suppliers: [{ supplierId: 's1', code: 'DIG', name: 'DIGLANT MANUFACTURING SDN BHD', isMain: true }],
        lines: [line({ soDocNo: 'HC-SO-013475', source: 'shortage', shortageQty: 1 })],
      })],
    });
    const sheets: SheetSpec[] = views.map((view) => {
      const src = view.value === 'mattress' ? matData : emptyResp({});
      const { displayModels, accessoryBySoDoc } = computeTabModels(src, view, NO_FILTERS);
      return { view, rows: buildSheetRows(view.value === 'sofa', displayModels, accessoryBySoDoc) };
    });

    const blob = await buildMrpWorkbookBlob(sheets, { asOf: '2026-09-16T00:00:00Z', warehouseLabel: 'All', filters: NO_FILTERS });
    const wb = read(new Uint8Array(await blob.arrayBuffer()), { type: 'array' });

    // Sheet per category, in tab order.
    expect(wb.SheetNames).toEqual(['Sofa', 'Bedframe', 'Mattress', 'Accessories', 'Others']);

    // Read the Mattress sheet's values (styles are asserted visually / by the
    // pure buildSheetRows tests above; SheetJS reads values, not fills).
    const cell = (addr: string) => wb.Sheets.Mattress![addr]?.v;
    expect(cell('A1')).toBe('MRP Stock Status  -  Mattress');   // merged title
    expect(cell('A3')).toBe('Warehouse');                       // header row 3
    expect(cell('P3')).toBe('Supplier');
    expect(cell('B4')).toBe('AK-MATT (Q)');                     // group header code
    expect(cell('L5')).toBe('needs PO');                        // shortage coverage
    expect(cell('M5')).toBeUndefined();                         // PO Outstanding blank off a shortage row
    expect(cell('O5')).toBe('CONFIRMED');                       // shortage status
    expect(cell('N5')).toBe(1);                                 // shortage figure
  });
});
