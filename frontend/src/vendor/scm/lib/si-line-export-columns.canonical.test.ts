/* The Sales Invoice line export's column CONTRACT.
 *
 * WHY A MIRROR. The server builds the rows (backend/src/scm/lib/si-line-export.ts)
 * and the browser writes the sheet (si-list-export.ts). The frontend cannot
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
  SI_LINE_EXPORT_COLUMNS,
  SI_STATUS_WORDS,
  siBalanceSen,
  siLineExportCells,
  siStatusWord,
} from './si-line-export-columns';
import { siOutstandingSen } from './si-outstanding';

describe('the two copies of this module are the same file', () => {
  test('backend/src/scm/lib/si-line-export-columns.ts is byte-identical to this one', () => {
    const here = resolve(process.cwd(), 'src/vendor/scm/lib/si-line-export-columns.ts');
    const there = resolve(process.cwd(), '../backend/src/scm/lib/si-line-export-columns.ts');
    const norm = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
    expect(norm(there)).toBe(norm(here));
  });
});

describe('the column contract', () => {
  test('the header names and their order', () => {
    expect([...SI_LINE_EXPORT_COLUMNS]).toEqual([
      'Doc No', 'AutoCount Doc No', 'Doc Date', 'Status', 'Customer Code', 'Customer Name', 'Customer Ref',
      'Item Code', 'Item Description', 'Item Description 2', 'Remarks', 'Category', 'Location', 'UOM',
      'Qty', 'Unit Price', 'Discount', 'Line Total', 'Invoice Total', 'Paid', 'Balance',
      'Delivery Date', 'Due Date', 'Overdue Days',
      'Salesperson', 'Branding', 'Venue', 'Phone',
      'SO Doc No.', 'DO No.',
      'Line ID',
    ]);
  });

  test('the names the import reads are present, Remarks right after Item Description 2, Line ID last', () => {
    for (const name of ['Doc No', 'Line ID', 'Delivery Date', 'Item Description 2', 'Remarks'] as const) {
      expect(SI_LINE_EXPORT_COLUMNS).toContain(name);
    }
    expect(SI_LINE_EXPORT_COLUMNS[SI_LINE_EXPORT_COLUMNS.indexOf('Item Description 2') + 1]).toBe('Remarks');
    expect(SI_LINE_EXPORT_COLUMNS[SI_LINE_EXPORT_COLUMNS.length - 1]).toBe('Line ID');
  });
});

describe('the Status word', () => {
  test('says exactly what the Sales Invoices list says, status by status', () => {
    const page = readFileSync(resolve(process.cwd(), 'src/pages/scm-v2/SalesInvoicesListV2.tsx'), 'utf8');
    const block = /const STATUS_TONE[\s\S]*?\n};/.exec(page)?.[0] ?? '';
    const onScreen = Object.fromEntries(
      [...block.matchAll(/^\s*([a-z_]+):\s*\{[^}]*label:\s*"([^"]+)"/gm)].map((m) => [m[1], m[2]]),
    );
    expect(Object.keys(onScreen).length, 'the scan read no labels from the page').toBeGreaterThanOrEqual(8);
    expect(onScreen).toEqual({ ...SI_STATUS_WORDS });
  });

  test('matches whatever case the database stores', () => {
    expect(siStatusWord('SENT')).toBe('Submitted');
    expect(siStatusWord('PARTIALLY_PAID')).toBe('Partially paid');
    expect(siStatusWord('SOMETHING_NEW')).toBe('SOMETHING_NEW');
    expect(siStatusWord(null)).toBeNull();
  });
});

describe('Balance', () => {
  test('is the list\'s Outstanding: the same number siOutstandingSen answers', () => {
    const cases: Array<[number, number, number]> = [[300_000, 50_000, 200_000], [100_000, 0, 0], [100_000, 90_000, 50_000]];
    for (const [total, paid, deposit] of cases) {
      expect(siBalanceSen({ total_sen: total, local_total_sen: total, paid_sen: paid }, deposit)).toBe(siOutstandingSen(total, paid, deposit));
    }
  });

  test('cells carry it in ringgit, net of the deposit', () => {
    const cells = siLineExportCells(
      { invoice_number: 'HC-SI-1', invoice_date: '2026-08-23', status: 'SENT', total_sen: 300_000, paid_sen: 50_000 },
      { id: 'l-1', item_code: 'A', qty: 1 },
      { location: null, doNo: null, salespersonName: null, depositAppliedSen: 200_000, today: '2026-09-15' },
    );
    const row = Object.fromEntries(SI_LINE_EXPORT_COLUMNS.map((c, i) => [c, cells[i]]));
    expect(row['Balance']).toBe(500);
    expect(row['Paid']).toBe(500);
    expect(cells).toHaveLength(SI_LINE_EXPORT_COLUMNS.length);
  });
});
