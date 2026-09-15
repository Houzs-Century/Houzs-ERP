/* The Goods Received line export's column CONTRACT.
 *
 * WHY A MIRROR. The server builds the rows (backend/src/scm/lib/grn-line-export.ts)
 * and the browser writes the sheet (grn-list-export.ts). The frontend cannot
 * import from backend/src, so the module is copied byte for byte — the
 * po-line-export-columns.ts pattern — and this test is the referee.
 * backend/scripts/check-shared-mirrors.mjs sees the pair by basename, so the
 * file must stay at the top level of this directory.
 *
 * WHY THE NAMES ARE PINNED AS LITERALS. An import reads an exported file back by
 * these header names and matches rows by Line ID. A rename made in both copies
 * at once would still pass byte-identity and still break every file already
 * exported.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  GRN_LINE_EXPORT_COLUMNS,
  GRN_STATUS_WORDS,
  grnAutoCountDocNo,
  grnLineExportCells,
  grnStatusWord,
} from './grn-line-export-columns';

describe('the two copies of this module are the same file', () => {
  test('backend/src/scm/lib/grn-line-export-columns.ts is byte-identical to this one', () => {
    const here = resolve(process.cwd(), 'src/vendor/scm/lib/grn-line-export-columns.ts');
    const there = resolve(process.cwd(), '../backend/src/scm/lib/grn-line-export-columns.ts');
    const norm = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
    expect(norm(there)).toBe(norm(here));
  });
});

describe('the column contract', () => {
  test('the header names and their order', () => {
    expect([...GRN_LINE_EXPORT_COLUMNS]).toEqual([
      'Doc No', 'AutoCount Doc No', 'Doc Date', 'Status', 'Supplier Code', 'Supplier Name', 'Supplier DO No.',
      'Item Code', 'Supplier SKU', 'Item Description', 'Item Description 2', 'Remarks', 'Category', 'Location', 'UOM',
      'Received Qty', 'Invoiced Qty', 'Returned Qty', 'Uninvoiced Qty',
      'Currency', 'Unit Price', 'Discount', 'Line Total',
      'Delivery Date', 'PO No.', 'SO Doc No.', 'Invoice No.',
      'Line ID',
    ]);
  });

  test('the names the import reads are present, Remarks right after Item Description 2, Line ID last', () => {
    for (const name of ['Doc No', 'Line ID', 'Delivery Date', 'Item Description 2', 'Remarks'] as const) {
      expect(GRN_LINE_EXPORT_COLUMNS).toContain(name);
    }
    expect(GRN_LINE_EXPORT_COLUMNS[GRN_LINE_EXPORT_COLUMNS.indexOf('Item Description 2') + 1]).toBe('Remarks');
    expect(GRN_LINE_EXPORT_COLUMNS[GRN_LINE_EXPORT_COLUMNS.length - 1]).toBe('Line ID');
  });
});

describe('the Status word', () => {
  test('says exactly what the Goods Received list says, status by status', () => {
    /* The list takes its labels from status-pill.ts's GRN map
       (withStatusLabels("grn", ...)), so read them out of that map. */
    const src = readFileSync(resolve(process.cwd(), 'src/vendor/scm/lib/status-pill.ts'), 'utf8');
    const block = /const GRN: Record<string, Entry> = \{[\s\S]*?\n\};/.exec(src)?.[0] ?? '';
    const onScreen = Object.fromEntries(
      [...block.matchAll(/^\s*([A-Z_]+):\s*\{\s*label:\s*'([^']+)'/gm)].map((m) => [m[1], m[2]]),
    );
    expect(Object.keys(onScreen).length, 'the scan read no labels from status-pill.ts').toBeGreaterThanOrEqual(5);
    expect(onScreen).toEqual({ ...GRN_STATUS_WORDS });
    const page = readFileSync(resolve(process.cwd(), 'src/pages/scm-v2/GoodsReceivedListV2.tsx'), 'utf8');
    expect(page).toContain('withStatusLabels("grn"');
  });

  test('a held receipt keeps its status and says it is held — once', () => {
    expect(grnStatusWord('POSTED', true)).toBe('Submitted (On Hold)');
    expect(grnStatusWord('ON_HOLD', true)).toBe('On Hold');
    expect(grnStatusWord('SOMETHING_NEW', false)).toBe('SOMETHING_NEW');
    expect(grnStatusWord(null, false)).toBeNull();
  });
});

describe('the AutoCount GR number', () => {
  test('a migrated receipt reads linked_ac_gr_docno, never its PO number', () => {
    const base = { grn_number: 'X', received_at: null, status: 'POSTED' };
    expect(grnAutoCountDocNo({ ...base, migrated_no_stock: true, linked_ac_docno: 'PO-1', linked_ac_gr_docno: 'GR-9' })).toBe('GR-9');
    expect(grnAutoCountDocNo({ ...base, migrated_no_stock: true, linked_ac_docno: 'PO-1', linked_ac_gr_docno: null })).toBeNull();
    expect(grnAutoCountDocNo({ ...base, migrated_no_stock: false, linked_ac_docno: 'HC-GRN-1' })).toBe('HC-GRN-1');
  });
});

describe('one line as cells', () => {
  test('Uninvoiced = received − invoiced − returned; money leaves sen as ringgit', () => {
    const cells = grnLineExportCells(
      { grn_number: 'HC-GRN-1', received_at: '2026-09-01', status: 'POSTED' },
      { id: 'l-1', item_code: 'A', qty_accepted: '6', returned_qty: 1, unit_price_sen: 5.5, line_total_sen: 3300 },
      { location: 'KL', poNo: null, soDocNo: null, invoicedQty: 2, invoiceNos: 'HC-PI-1' },
    );
    const row = Object.fromEntries(GRN_LINE_EXPORT_COLUMNS.map((c, i) => [c, cells[i]]));
    expect(row['Uninvoiced Qty']).toBe(3);
    expect(row['Unit Price']).toBe(0.055);
    expect(row['Line Total']).toBe(33);
    expect(row['Line ID']).toBe('l-1');
    expect(cells).toHaveLength(GRN_LINE_EXPORT_COLUMNS.length);
  });
});
