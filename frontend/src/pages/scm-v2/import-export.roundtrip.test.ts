/* HC-0003 T6: every exporter that has an importer reads its own file back.
 *
 * One test per pair. Each goes through the REAL export code and the REAL import
 * parser, and compares what comes out with what went in. It goes red when an
 * export header or unit (sen vs ringgit, date vs text) drifts from what the
 * importer reads.
 *
 *   Fabric Converter   toCsv -> parseCsv
 *   Supplier bindings  exportBindingsCsv -> buildCreates (long format)
 *   PO lines           DataTable line export (.xlsx) -> readPoLineImportFile
 *   Chart of Accounts  the ERP has no chart export; the file it imports is
 *                      AutoCount's chart report, so the pair is that layout ->
 *                      parseChartXlsx. */
import { afterEach, describe, expect, test, vi } from 'vitest';
import * as XLSX from 'xlsx';

const written = vi.hoisted(() => ({ wb: null as unknown }));
vi.mock('../../lib/xlsx-runtime', async (orig) => {
  const actual = await orig<typeof import('../../lib/xlsx-runtime')>();
  /* Catch the workbook the export would download. */
  return { ...actual, writeFileXLSX: (wb: unknown) => { written.wb = wb; } };
});

import { toCsv, parseCsv, CSV_COLUMNS } from '../../vendor/scm/lib/fabric-csv';
import type { FabricTrackingRow } from '../../vendor/scm/lib/fabric-queries';
import { exportBindingsCsv, buildCreates } from './SupplierBindingsCsv';
import type { BindingRow } from '../../vendor/scm/lib/suppliers-queries';
import type { MfgProductRow } from '../../vendor/scm/lib/mfg-products-queries';
import { parseCSV } from '../../lib/csv';
import { buildLineExportMatrix, writeLineExportFile, type LineExportColumn } from '../../components/dataTableLineExport';
import { poLineColumns, type PoGridRow } from './po-list-line-columns';
import { PO_LINE_LABELS, type PoListLine } from '../../vendor/scm/lib/po-line-export-columns';
import { readPoLineImportFile } from '../../vendor/scm/lib/po-line-import-queries';
import { parseChartXlsx } from './ChartOfAccounts';
import type { ChartImportRow } from '../../vendor/scm/lib/accounting-queries';

afterEach(() => { vi.restoreAllMocks(); written.wb = null; });

describe('Fabric Converter: Export CSV imports back', () => {
  const fabric: FabricTrackingRow = {
    id: 'f1', fabric_code: 'AVANI-09', fabric_description: 'Ivory, "soft" weave', fabric_category: null,
    price_tier: null, sofa_price_tier: 'PRICE_1', bedframe_price_tier: 'PRICE_3',
    price_sen: 1550, soh_sen: 120000, po_outstanding_sen: 5000, last_month_usage_sen: 3000,
    one_week_usage_sen: 700, two_weeks_usage_sen: 1400, one_month_usage_sen: 3100, shortage_sen: 0,
    reorder_point_sen: 2500, supplier: 'Dah Chong', supplier_code: 'DC-151-03', lead_time_days: 30,
    series: 'AVANI',
  };

  test('every exported column comes back as the same value under its API key', () => {
    const { rows, errors, warnings } = parseCsv(toCsv([fabric]));
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
    const expected = Object.fromEntries(CSV_COLUMNS.map((c) => [c.apiKey, fabric[c.field]]));
    expect(rows).toEqual([expected]);
  });
});

describe('Supplier bindings: Export CSV imports back', () => {
  const binding = (over: Partial<BindingRow>): BindingRow => ({
    id: over.item_code ?? 'b', supplier_id: 's1', material_kind: 'mfg_product', item_code: 'X', ac_item_code: null,
    material_name: '', supplier_sku: '', unit_price_sen: 0, currency: 'MYR', lead_time_days: 0,
    payment_terms_override: null, moq: 0, price_valid_from: null, price_valid_to: null, is_main_supplier: false,
    notes: null, price_matrix: null, is_cost_anchor: false, created_at: '', updated_at: '', ...over,
  });
  const products = [
    { code: 'SOFA-1', name: 'Sofa One', category: 'SOFA' },
    { code: 'BED-1', name: 'Bed One', category: 'BEDFRAME' },
    { code: 'ACC-1', name: 'Leg kit', category: 'ACCESSORY' },
  ] as MfgProductRow[];
  const source = [
    binding({ item_code: 'SOFA-1', supplier_sku: 'S-SOFA-1', lead_time_days: 14, moq: 2, is_main_supplier: true,
      price_matrix: { '24': { P1: 100000, P2: 120050 }, '28': { P3: 99999 } } }),
    binding({ item_code: 'BED-1', supplier_sku: 'S-BED-1', price_matrix: { P1: 45000, P2: 47525 } }),
    binding({ item_code: 'ACC-1', supplier_sku: 'S-ACC-1', unit_price_sen: 5125, lead_time_days: 7 }),
  ];

  test('codes, skus, scalars and every price (to the sen) come back', async () => {
    let blob: Blob | null = null;
    vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => { blob = b as Blob; return 'blob:x'; });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    exportBindingsCsv(source, 'SUP', ['24', '28'], products);
    expect(blob).not.toBeNull();

    const text = await new Promise<string>((ok) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.readAsText(blob!); });
    const grid = parseCSV(text);
    const [header, ...data] = grid as [string[], ...string[][]];
    const productByCode = new Map(products.map((p) => [p.code, p]));
    const creates = buildCreates(data, header, 'long', new Map(), productByCode, ['24', '28']);

    expect(creates.map((c) => ({
      code: c.itemCode, sku: c.supplierSku, unit: c.unitPriceSen, lead: c.leadTimeDays ?? 0, moq: c.moq ?? 0,
      main: c.isMainSupplier ?? false, matrix: c.priceMatrix ?? null,
    }))).toEqual(source.map((b) => ({
      code: b.item_code, sku: b.supplier_sku, unit: b.unit_price_sen, lead: b.lead_time_days, moq: b.moq,
      main: b.is_main_supplier, matrix: b.price_matrix,
    })));
  });

  test('the file starts with a UTF-8 BOM so Excel keeps KŌRI-style codes (HC-0165)', async () => {
    let blob: Blob | null = null;
    vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => { blob = b as Blob; return 'blob:x'; });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const code = 'AKEMI KŌRI EIKO MATT (S)';
    exportBindingsCsv([binding({ item_code: code, unit_price_sen: 100 })], 'SUP', [],
      [{ code, name: 'AKEMI KŌRI EIKO MATTRESS', category: 'MATTRESS' }] as MfgProductRow[]);

    const bytes = await new Promise<Uint8Array>((ok) => { const r = new FileReader(); r.onload = () => ok(new Uint8Array(r.result as ArrayBuffer)); r.readAsArrayBuffer(blob!); });
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    /* Keep the BOM in the text: the importer's parser is what must drop it. */
    const grid = parseCSV(new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes));
    expect(grid[0]![0]).toBe('internal_code');
    expect(grid[1]![0]).toBe(code);
  });
});

describe('PO lines: the line export imports back', () => {
  const line = (over: Partial<PoListLine>): PoListLine => ({
    id: 'L', line_no: 1, item_code: 'BED-K', material_name: 'Bed', item_description: 'Bed', description2: null,
    notes: null, item_group: null, ac_item_group: null, supplier_sku: 'SUP-BED-K', qty: 2, received_qty: 0,
    remaining_qty: 2, unit_price_sen: 45000, line_total_sen: 90000, delivery_date: null,
    estimate_delivery_date_1: null, estimate_delivery_date_2: null, estimate_delivery_date_3: null,
    location: 'KL', so_doc_no: null, ...over,
  });
  const lines = [
    line({ id: 'line-1', delivery_date: '2026-10-15', estimate_delivery_date_1: '2026-10-20',
      estimate_delivery_date_2: '2026-11-01', description2: 'Walnut, 6"', notes: 'chase supplier' }),
    line({ id: 'line-2', line_no: 2, delivery_date: '2026-12-31' }),
  ];
  const po = { po_number: 'PO-000100', lines } as unknown as PoGridRow;

  test('Line ID, Doc No and every editable field come back with the same value', async () => {
    /* The grid's Doc No column is a doc-level getValue under PO_LINE_LABELS.docNo
       (PurchaseOrdersListV2.tsx); the line columns are the grid's own. */
    const docNo: LineExportColumn<PoGridRow, PoListLine> = {
      key: 'po_number', label: PO_LINE_LABELS.docNo, getValue: (r) => (r as unknown as { po_number: string }).po_number,
    };
    const cols = [docNo, ...Object.values(poLineColumns())] as LineExportColumn<PoGridRow, PoListLine>[];
    const matrix = buildLineExportMatrix([po], (r) => r.lines ?? [], cols);
    await writeLineExportFile(matrix, 'Purchase Orders', 'po.xlsx');
    const bytes = XLSX.write(written.wb as XLSX.WorkBook, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
    const file = new Blob([bytes]);
    Object.defineProperty(file, 'arrayBuffer', { value: async () => bytes });

    const sheet = await readPoLineImportFile(file);
    if (!sheet.ok) throw new Error(sheet.error);
    expect(sheet.missingHeaders).toEqual([]);
    const { parseImportValue, isPoLineImportField } = await import('../../vendor/scm/lib/po-line-import');
    const back = sheet.rows.map((r) => ({
      docNo: r.docNo, lineId: r.lineId,
      ...Object.fromEntries(Object.entries(r.values).map(([f, v]) => {
        if (!isPoLineImportField(f)) throw new Error(f);
        const p = parseImportValue(f, v);
        return [f, p.ok ? p.value : `REFUSED: ${p.reason}`];
      })),
    }));
    expect(back).toEqual(lines.map((l) => ({
      docNo: 'PO-000100', lineId: l.id,
      deliveryDate: l.delivery_date, estimateDeliveryDate1: l.estimate_delivery_date_1,
      estimateDeliveryDate2: l.estimate_delivery_date_2, estimateDeliveryDate3: l.estimate_delivery_date_3,
      description2: l.description2, remarks: l.notes,
    })));
  });
});

describe('Chart of Accounts: the AutoCount chart report imports', () => {
  const SECTIONS = [
    { section: 'CURRENT ASSETS', type: 'ASSET' },
    { section: 'EXPENSES', type: 'EXPENSE' },
  ] as const;
  const source: ChartImportRow[] = [
    { code: '310-0000', name: 'CASH AT BANK', accountType: 'ASSET', section: 'CURRENT ASSETS', parentCode: null, accMoney: false, specialType: null, shared: true },
    { code: '310-0010', name: 'CASH AT BANK - MAYBANK', accountType: 'ASSET', section: 'CURRENT ASSETS', parentCode: '310-0000', accMoney: true, specialType: 'SBK', shared: false },
    { code: '900-A002', name: 'ADVERTISEMENT', accountType: 'EXPENSE', section: 'EXPENSES', parentCode: null, accMoney: false, specialType: null, shared: true },
    { code: '900-A003', name: 'ADVERTISEMENT - ONLINE', accountType: 'EXPENSE', section: 'EXPENSES', parentCode: '900-A002', accMoney: false, specialType: null, shared: true },
  ];

  /* AutoCount's layout: letterhead, column captions, a one-cell section line,
     then a row per account with 4 spaces of indent per level and the special
     type in column I. */
  const autoCountReport = (rows: ChartImportRow[]): unknown[][] => {
    const depth = (r: ChartImportRow): number => (r.parentCode ? 1 + depth(rows.find((p) => p.code === r.parentCode)!) : 0);
    const out: unknown[][] = [['HOUZS CENTURY SDN BHD (1476832-W)'], ['Acc. No.', 'Description', null, 'Currency']];
    let section = '';
    for (const r of rows) {
      if (r.section !== section) { section = r.section ?? ''; out.push([section]); }
      const row: unknown[] = [`${' '.repeat(4 * depth(r))}${r.code}`, r.name, null, 'MYR'];
      if (r.specialType) row[8] = r.specialType;
      out.push(row);
    }
    return out;
  };

  test('every account comes back with its name, parent, type, section and special type', () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(autoCountReport(source)), 'Sheet');
    const back = XLSX.read(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }), { type: 'array' });
    const parsed = parseChartXlsx(back, SECTIONS);
    expect(parsed.unknownSections).toEqual([]);
    expect(parsed.rows).toEqual(source);
  });
});
