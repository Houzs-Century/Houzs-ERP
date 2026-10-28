/* The Delivery Order grid's labels, its AutoCount default layout, and the words it prints.
 *
 * WHY A MIRROR, WHY LITERALS: see so-line-export-columns.canonical.test.ts, the
 * same reasons for the delivery order copy.
 *
 * AND NO MONEY. The owner, 2026-09-15: a Delivery Order file goes to drivers,
 * 3PLs and customers, so it carries no price or amount. The line shape has no
 * money field and the default layout holds no money column.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { DO_DEFAULT_COLUMNS, DO_LABELS, DO_STATUS_WORDS, doStatusWord, type DoListLine } from './do-line-export-columns';
import { statusFor } from '../../../pages/scm-v2/do-list-status';
import { DO_STATUSES } from '../../shared/do-shipped-states';

describe('the two copies of this module are the same file', () => {
  test('backend/src/scm/lib/do-line-export-columns.ts is byte-identical to this one', () => {
    const here = resolve(process.cwd(), 'src/vendor/scm/lib/do-line-export-columns.ts');
    const there = resolve(process.cwd(), '../backend/src/scm/lib/do-line-export-columns.ts');
    const norm = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
    expect(norm(there)).toBe(norm(here));
  });
});

describe('the labels are AutoCount captions', () => {
  test('AutoCount layout "LISTING ITEM DETAIL" without its prices, in its order', () => {
    expect([...DO_DEFAULT_COLUMNS]).toEqual([
      'Doc No', 'Doc Date', 'Debtor Code', 'Debtor Name', 'Agent', 'Curr. Code', 'Item Code',
      'Detail Description', 'Detail Description 2', 'UOM', 'Location', 'Qty', 'PO Doc No.', 'Item Group',
    ]);
  });

  test('Driver and Vehicle stay; every label is distinct', () => {
    const labels = Object.values(DO_LABELS);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels).toContain('Driver');
    expect(labels).toContain('Vehicle');
    expect(DO_LABELS.lineId).toBe('Line ID');
  });

  test('no price, amount or estimate date among the line labels or the default layout', () => {
    const money = /price|amount|total|discount|balance|paid|cost|margin|estimate/i;
    expect(Object.values(DO_LABELS).filter((c) => money.test(c))).toEqual([]);
    expect(DO_DEFAULT_COLUMNS.filter((c) => money.test(c))).toEqual([]);
  });

  test('the line shape carries no money field', () => {
    const line: DoListLine = {
      id: 'l', line_no: 1, item_code: null, erp_item_code: null, description: null, description2: null, item_group: null,
      uom: null, location: null, qty: 1, m3: null, delivery_date: null, remark: null, invoiced_qty: null, returned_qty: null,
      uninvoiced_qty: null, so_doc_no: null, invoice_nos: [], po_nos: [],
    };
    expect(Object.keys(line).filter((k) => /price|total|amount|discount|sen/i.test(k))).toEqual([]);
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
    for (const s of DO_STATUSES) {
      expect(DO_STATUS_WORDS[s], s).toBeTruthy();
    }
  });
});
