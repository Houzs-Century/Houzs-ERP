/* The Delivery Order line export's column CONTRACT, and the words it prints.
 *
 * WHY A MIRROR, WHY LITERALS: see so-line-export-columns.canonical.test.ts — the
 * same reasons, for the delivery order copy.
 *
 * AND NO MONEY. The owner, 2026-09-15: a Delivery Order file goes to drivers,
 * 3PLs and customers, so it carries no price or amount. That is asserted on the
 * names AND on the cells a priced line produces.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { DO_LINE_EXPORT_COLUMNS, DO_STATUS_WORDS, doLineExportCells, doStatusWord } from './do-line-export-columns';
import { statusFor } from '../../../pages/scm-v2/do-list-status';

describe('the two copies of this module are the same file', () => {
  test('backend/src/scm/lib/do-line-export-columns.ts is byte-identical to this one', () => {
    const here = resolve(process.cwd(), 'src/vendor/scm/lib/do-line-export-columns.ts');
    const there = resolve(process.cwd(), '../backend/src/scm/lib/do-line-export-columns.ts');
    const norm = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
    expect(norm(there)).toBe(norm(here));
  });
});

describe('the column contract', () => {
  test('the header names and their order', () => {
    expect([...DO_LINE_EXPORT_COLUMNS]).toEqual([
      'Doc No', 'AutoCount Doc No', 'Doc Date', 'Status', 'Customer Code', 'Customer Name', 'Customer Ref',
      'Item Code', 'Item Description', 'Item Description 2', 'Remarks', 'Category', 'Location', 'UOM',
      'Qty', 'Invoiced Qty', 'Returned Qty', 'Uninvoiced Qty', 'm³', 'Delivery Date', 'Expected Delivery',
      'Delivered On', 'Salesperson', 'Branding', 'Venue', 'Driver', 'Vehicle', 'Phone', 'Delivery Address',
      'State', 'SO Doc No.', 'Invoice No.', 'Line ID',
    ]);
  });

  test('the names the import will read are present, Line ID is last, Driver and Vehicle stay', () => {
    for (const name of ['Doc No', 'Line ID', 'Delivery Date', 'Item Description 2', 'Remarks', 'Driver', 'Vehicle']) {
      expect(DO_LINE_EXPORT_COLUMNS).toContain(name);
    }
    expect(DO_LINE_EXPORT_COLUMNS[DO_LINE_EXPORT_COLUMNS.length - 1]).toBe('Line ID');
  });

  test('no price, amount or estimate date', () => {
    expect(DO_LINE_EXPORT_COLUMNS.filter((c) => /price|amount|total|discount|balance|paid|cost|margin|estimate/i.test(c))).toEqual([]);
  });

  test('a priced line puts no price anywhere in its row', () => {
    const line = { id: 'l-1', item_code: 'X', description: 'X', qty: 2, unit_price_sen: 123457, line_total_sen: 246914 } as Parameters<typeof doLineExportCells>[1];
    const cells = doLineExportCells(
      { do_number: 'HC-DO-1', do_date: '2026-09-01', status: 'DELIVERED', debtor_code: null, debtor_name: null },
      line,
      { location: 'KL', salesperson: null, invoiced: 0, returned: 0, uninvoiced: 2, deliveredOn: null, soDocNo: null, invoiceNos: [] },
    );
    for (const v of [123457, 1234.57, 246914, 2469.14]) expect(cells).not.toContain(v);
    expect(cells).toHaveLength(DO_LINE_EXPORT_COLUMNS.length);
  });
});

describe('the Status word is the list pill', () => {
  test('every stored word is the word the list map shows', () => {
    for (const s of Object.keys(DO_STATUS_WORDS)) expect(DO_STATUS_WORDS[s], s).toBe(statusFor(s).label);
    expect(doStatusWord('LOADED', false)).toBe('Confirmed');
    expect(doStatusWord('DISPATCHED', false)).toBe('Loaded');
  });

  test('a held delivery order says so after the word; an unknown status prints as stored', () => {
    expect(doStatusWord('DELIVERED', true)).toBe('Delivered (On Hold)');
    expect(doStatusWord('SOMETHING_NEW', false)).toBe(statusFor('SOMETHING_NEW').label);
    expect(doStatusWord(null, false)).toBeNull();
  });

  test('every stored delivery order status has a word', () => {
    for (const s of ['DRAFT', 'LOADED', 'DISPATCHED', 'IN_TRANSIT', 'SIGNED', 'DELIVERED', 'INVOICED', 'CANCELLED']) {
      expect(DO_STATUS_WORDS[s], s).toBeTruthy();
    }
  });
});

describe('one line as cells', () => {
  test('m³ leaves milli as cubic metres; the delivery date falls back to the header', () => {
    const cells = doLineExportCells(
      { do_number: 'HC-DO-1', do_date: '2026-09-01', status: 'LOADED', debtor_code: null, debtor_name: null, customer_delivery_date: '2026-09-05', ref: null, customer_so_no: 'CSO-1', so_doc_no: 'HC-SO-9', address1: 'A', city: 'B' },
      { id: 'l-1', item_code: 'X', description: 'X', qty: '3', m3_milli: 1234 },
      { location: 'KL', salesperson: null, invoiced: null, returned: null, uninvoiced: null, deliveredOn: null, soDocNo: null, invoiceNos: ['HC-IV-2', 'HC-IV-1'] },
    );
    const row = Object.fromEntries(DO_LINE_EXPORT_COLUMNS.map((c, i) => [c, cells[i]]));
    expect(row['m³']).toBe(1.234);
    expect(row['Qty']).toBe(3);
    expect(row['Delivery Date']).toBe('2026-09-05');
    expect(row['Customer Ref']).toBe('CSO-1');
    expect(row['SO Doc No.']).toBe('HC-SO-9');
    expect(row['Delivery Address']).toBe('A, B');
    expect(row['Invoice No.']).toBe('HC-IV-2, HC-IV-1');
    expect(row['Status']).toBe('Confirmed');
  });
});
