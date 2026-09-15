/* The Purchase Invoice line export's column CONTRACT.
 *
 * WHY A MIRROR. The server builds the rows (backend/src/scm/lib/pi-line-export.ts)
 * and the browser writes the sheet (pi-list-export.ts). The frontend cannot
 * import from backend/src, so the module is copied byte for byte — the
 * po-line-export-columns.ts pattern — and this test is the referee.
 *
 * WHY THE NAMES ARE PINNED AS LITERALS. An import reads an exported file back by
 * these header names and matches rows by Line ID.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  PI_LINE_EXPORT_COLUMNS,
  PI_STATUS_WORDS,
  overdueDays,
  piBalanceSen,
  piLineExportCells,
  piStatusWord,
} from './pi-line-export-columns';

describe('the two copies of this module are the same file', () => {
  test('backend/src/scm/lib/pi-line-export-columns.ts is byte-identical to this one', () => {
    const here = resolve(process.cwd(), 'src/vendor/scm/lib/pi-line-export-columns.ts');
    const there = resolve(process.cwd(), '../backend/src/scm/lib/pi-line-export-columns.ts');
    const norm = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
    expect(norm(there)).toBe(norm(here));
  });
});

describe('the column contract', () => {
  test('the header names and their order', () => {
    expect([...PI_LINE_EXPORT_COLUMNS]).toEqual([
      'Doc No', 'AutoCount Doc No', 'Doc Date', 'Status', 'Supplier Code', 'Supplier Name', 'Supplier Invoice No.',
      'Item Code', 'Supplier SKU', 'Item Description', 'Item Description 2', 'Remarks', 'Category', 'Location', 'UOM',
      'Qty', 'Currency', 'PO Unit Price', 'Unit Price', 'Discount', 'Line Total', 'Invoice Total', 'Balance',
      'Due Date', 'Overdue Days', 'GRN No.', 'PO No.', 'SO Doc No.',
      'Line ID',
    ]);
  });

  test('the names the import reads are present (no Delivery Date on an invoice line), Line ID last', () => {
    for (const name of ['Doc No', 'Line ID', 'Item Description 2', 'Remarks'] as const) {
      expect(PI_LINE_EXPORT_COLUMNS).toContain(name);
    }
    expect(PI_LINE_EXPORT_COLUMNS as readonly string[]).not.toContain('Delivery Date');
    expect(PI_LINE_EXPORT_COLUMNS[PI_LINE_EXPORT_COLUMNS.indexOf('Item Description 2') + 1]).toBe('Remarks');
    expect(PI_LINE_EXPORT_COLUMNS[PI_LINE_EXPORT_COLUMNS.length - 1]).toBe('Line ID');
  });
});

describe('the Status word', () => {
  test('says exactly what the Purchase Invoices list says, status by status', () => {
    const page = readFileSync(resolve(process.cwd(), 'src/pages/scm-v2/PurchaseInvoicesListV2.tsx'), 'utf8');
    const block = /const STATUS_TONE[\s\S]*?\n};/.exec(page)?.[0] ?? '';
    const onScreen = Object.fromEntries(
      [...block.matchAll(/^\s*([A-Z_]+):\s*\{[^}]*label:\s*"([^"]+)"/gm)].map((m) => [m[1], m[2]]),
    );
    expect(Object.keys(onScreen).length, 'the scan read no labels from the page').toBeGreaterThanOrEqual(6);
    expect(onScreen).toEqual({ ...PI_STATUS_WORDS });
  });

  test('a held invoice keeps its status and says it is held — once', () => {
    expect(piStatusWord('POSTED', true)).toBe('Submitted (On Hold)');
    expect(piStatusWord('ON_HOLD', true)).toBe('On Hold');
    expect(piStatusWord(null, false)).toBeNull();
  });
});

describe('Balance and Overdue Days', () => {
  test('Balance is the list\'s Owed: total − paid, never below zero', () => {
    expect(piBalanceSen({ total_sen: 1000, paid_sen: 400 })).toBe(600);
    expect(piBalanceSen({ total_sen: 1000, paid_sen: 1200 })).toBe(0);
  });

  test('Overdue Days counts from the STORED due date only', () => {
    expect(overdueDays('2026-09-01', '2026-09-15', 1)).toBe(14);
    expect(overdueDays(null, '2026-09-15', 1)).toBeNull();
  });

  test('cells carry both, in ringgit', () => {
    const cells = piLineExportCells(
      { invoice_number: 'HC-PI-1', invoice_date: '2026-09-01', status: 'POSTED', total_sen: 150000, paid_sen: 50000, due_date: '2026-09-10' },
      { id: 'l-1', item_code: 'A', qty: 1, unit_price_sen: 150000, line_total_sen: 150000 },
      { supplierSku: null, location: null, grnNo: null, poNo: null, soDocNo: null, today: '2026-09-15' },
    );
    const row = Object.fromEntries(PI_LINE_EXPORT_COLUMNS.map((c, i) => [c, cells[i]]));
    expect(row['Balance']).toBe(1000);
    expect(row['Overdue Days']).toBe(5);
    expect(cells).toHaveLength(PI_LINE_EXPORT_COLUMNS.length);
  });
});
