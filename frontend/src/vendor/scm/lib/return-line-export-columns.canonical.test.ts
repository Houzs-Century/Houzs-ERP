/* The Purchase Return / Delivery Return line column CONTRACT.
 *
 * WHY A MIRROR. The server shapes the lines (backend/src/scm/lib/*-return-list-read.ts)
 * and the grid writes the sheet. The frontend cannot import from backend/src, so
 * the module is copied byte for byte and this test is the referee.
 * backend/scripts/check-shared-mirrors.mjs sees the pair by basename, so the file
 * must stay at the top level of this directory.
 *
 * WHY THE LABELS ARE PINNED AS LITERALS. They are AutoCount Accounting 2.2's own
 * captions and order for "Print Delivery Return Detail Listing" and "Print
 * Purchase Return Detail Listing" (the program's embedded form resources, read
 * 2026-09-15; the live book holds no saved layout for either form). A rename in
 * both copies would still pass byte-identity and stop matching AutoCount.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  DR_LINE_COLUMNS,
  PR_LINE_COLUMNS,
  returnCancelledWord,
  returnCurrencyRate,
  senToRinggit,
  toDrListLine,
  toPrListLine,
} from './return-line-export-columns';

describe('the two copies of this module are the same file', () => {
  test('backend/src/scm/lib/return-line-export-columns.ts is byte-identical to this one', () => {
    const here = resolve(process.cwd(), 'src/vendor/scm/lib/return-line-export-columns.ts');
    const there = resolve(process.cwd(), '../backend/src/scm/lib/return-line-export-columns.ts');
    const norm = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
    expect(norm(there)).toBe(norm(here));
  });
});

const autoCount = (cols: typeof DR_LINE_COLUMNS) => cols.filter((c) => c.autoCount).map((c) => c.label);

describe('AutoCount default columns, in AutoCount order', () => {
  test('Delivery Return Detail Listing (VisibleIndex 1..29)', () => {
    expect(autoCount(DR_LINE_COLUMNS)).toEqual([
      'Doc No', 'Doc Date', 'Debtor Code', 'Debtor Name', 'Agent', 'Curr. Code', 'Curr. Rate', 'Inclusive?',
      'SubTotal (Ex)', 'Tax', 'Total', 'Local Total', 'Cancelled', 'Item Code', 'Detail Description', 'UOM',
      'Location', 'Proj No', 'Dept No', 'Batch No.', 'Qty', 'Unit Price', 'Discount', 'Total', 'Tax Code', 'Tax',
      'Total (Ex)', 'Total (Inc)', 'Serial No. List',
    ]);
  });

  test('Purchase Return Detail Listing (VisibleIndex 1..33)', () => {
    expect(autoCount(PR_LINE_COLUMNS)).toEqual([
      'Doc No', 'Doc Date', 'Creditor Code', 'Creditor Name', 'Agent', 'Curr. Code', 'Curr. Rate', 'Inclusive?',
      'SubTotal (Ex)', 'Tax', 'Total', 'Local Total', 'Rounding Adj.', 'Final Total', 'Cancelled', 'Item Code',
      'Detail Description', 'UOM', 'Location', 'Proj No', 'Dept No', 'Batch No.', 'Qty', 'Unit Price', 'Discount',
      'Total', 'Local Total', 'Tax Code', 'Tax', 'Total (Ex)', 'Total (Inc)', 'Serial No. List', 'Is Rounding Adj.',
    ]);
  });

  test('keys are unique, AutoCount columns come first, Line ID is last', () => {
    for (const cols of [DR_LINE_COLUMNS, PR_LINE_COLUMNS]) {
      expect(new Set(cols.map((c) => c.key)).size).toBe(cols.length);
      const firstExtra = cols.findIndex((c) => !c.autoCount);
      expect(cols.slice(firstExtra).every((c) => !c.autoCount)).toBe(true);
      expect(cols[cols.length - 1]!.label).toBe('Line ID');
    }
  });

  test('every amount is money, every unit price a rate', () => {
    for (const cols of [DR_LINE_COLUMNS, PR_LINE_COLUMNS]) {
      for (const c of cols) {
        if (c.label === 'Unit Price' || c.label === 'Curr. Rate') expect(c.format).toBe('rate');
        if (/Total|^Tax$|Discount|Rounding Adj\.$/.test(c.label) && c.label !== 'Is Rounding Adj.') expect(c.format).toBe('money');
      }
    }
  });
});

describe('values', () => {
  test('sen to ringgit; MYR rate 1; Cancelled in words', () => {
    expect(senToRinggit(136800, 2)).toBe(1368);
    expect(senToRinggit(5.5, 4)).toBe(0.055);
    expect(senToRinggit(null, 2)).toBeNull();
    expect(returnCurrencyRate('MYR')).toBe(1);
    expect(returnCurrencyRate('USD')).toBeNull();
    expect(returnCancelledWord('CANCELLED')).toBe('Yes');
    expect(returnCancelledWord('RECEIVED')).toBe('No');
  });

  test('a line takes the book facts the server worked out, and keeps money in sen', () => {
    const facts = { itemCode: 'AERO-Y04 (K)', description: 'BOOK DESC', itemGroup: 'BEDFRAME', uom: 'SET', description2: 'BF-01 Sand' };
    const dr = toDrListLine(
      { id: 'l1', item_code: 'Y04-(K)', description: 'ERP', uom: 'unit', qty_returned: '2', unit_price_sen: 1000, line_total_sen: 2000 },
      { ...facts, location: 'KL', soDocNo: ' HC-SO-1 ' },
    );
    expect(dr).toMatchObject({ item_code: 'AERO-Y04 (K)', description: 'BOOK DESC', item_group: 'BEDFRAME', uom: 'SET', qty_returned: 2, unit_price_sen: 1000, so_doc_no: 'HC-SO-1' });
    const pr = toPrListLine(
      { id: 'l2', item_code: 'Y04-(K)', material_name: 'RAW', line_refund_sen: 50 },
      { ...facts, location: null, grnNo: 'HC-GRN-1', poNo: null },
    );
    expect(pr).toMatchObject({ item_code: 'AERO-Y04 (K)', material_name: 'RAW', description: 'BOOK DESC', line_refund_sen: 50, grn_no: 'HC-GRN-1', po_no: null });
  });
});
