/* The Sales Order line export's column CONTRACT, and the words it prints.
 *
 * WHY A MIRROR. The server builds the rows (backend/src/scm/lib/so-line-export.ts)
 * and the browser will write the sheet. The frontend cannot
 * import from backend/src, so the module is copied byte for byte and this test
 * is the referee. backend/scripts/check-shared-mirrors.mjs sees the pair by
 * basename, so the file must stay at the top level of this directory.
 *
 * WHY THE NAMES ARE PINNED AS LITERALS. A future import reads an exported file
 * back by these header names and matches rows by Line ID. A rename that updated
 * both copies at once would still pass byte-identity, and would still break
 * every file already exported.
 *
 * WHY THE STATUS WORD IS RUN AGAINST THE LIST'S OWN FUNCTIONS. The owner's
 * ruling is "the word on screen". The list pill is soRowStatus over
 * soStatusDisplay; this module carries a copy the server can run, so every
 * combination of stored status, delivery state and lifecycle is compared.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  SO_LINE_EXPORT_COLUMNS,
  SO_STATUS_WORDS,
  soCustomerRef,
  soLineExportCells,
  soListStatusWord,
  soSalespersonName,
  type SoDeliveryState,
  type SoLifecycleState,
} from './so-line-export-columns';
import { soRowStatus, statusFor } from '../../../pages/scm-v2/so-list-status';
import { soStatusDisplay } from './so-status';
import { customerRefOf } from '../../../lib/customer-ref';

describe('the two copies of this module are the same file', () => {
  test('backend/src/scm/lib/so-line-export-columns.ts is byte-identical to this one', () => {
    const here = resolve(process.cwd(), 'src/vendor/scm/lib/so-line-export-columns.ts');
    const there = resolve(process.cwd(), '../backend/src/scm/lib/so-line-export-columns.ts');
    const norm = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
    expect(norm(there)).toBe(norm(here));
  });
});

describe('the column contract', () => {
  test('the header names and their order', () => {
    expect([...SO_LINE_EXPORT_COLUMNS]).toEqual([
      'Doc No', 'AutoCount Doc No', 'Doc Date', 'Status', 'Customer Code', 'Customer Name', 'Customer Ref',
      'Item Code', 'Item Description', 'Item Description 2', 'Remarks', 'Category', 'Location', 'UOM',
      'Qty', 'Delivered Qty', 'Returned Qty', 'Remaining Qty', 'On Delivery Order Qty', 'Stock Status',
      'Unit Price', 'Discount', 'Line Total', 'Doc Balance', 'Delivery Date', 'Processing Date',
      'Salesperson', 'Branding', 'Venue', 'Sales Location', 'Phone', 'Delivery Address', 'State',
      'DO No.', 'PO No.', 'PO Delivery Date', 'Line ID',
    ]);
  });

  test('the names the import will read are present, and Line ID is last', () => {
    for (const name of ['Doc No', 'Line ID', 'Delivery Date', 'Item Description 2', 'Remarks']) {
      expect(SO_LINE_EXPORT_COLUMNS).toContain(name);
    }
    expect(SO_LINE_EXPORT_COLUMNS[SO_LINE_EXPORT_COLUMNS.length - 1]).toBe('Line ID');
  });

  test('no estimate delivery dates on a sales document (owner 2026-09-15)', () => {
    expect(SO_LINE_EXPORT_COLUMNS.filter((c) => /estimate/i.test(c))).toEqual([]);
  });
});

describe('the Status word is the list pill', () => {
  const stored = Object.keys(SO_STATUS_WORDS);
  const deliveries: Array<SoDeliveryState | null> = [null, 'none', 'partial', 'full'];
  const lifecycles: Array<SoLifecycleState | null> = [null, 'none', 'delivered', 'invoiced', 'returned'];

  test('every stored word is the word the list map shows', () => {
    for (const s of stored) expect(SO_STATUS_WORDS[s], s).toBe(statusFor(s).label);
  });

  test('for every status × delivery state × lifecycle, it says what soRowStatus says', () => {
    for (const status of [...stored, 'SOMETHING_NEW']) {
      for (const d of deliveries) {
        for (const l of lifecycles) {
          const onScreen = soRowStatus({ status, delivery_state: d, lifecycle_state: l }, soStatusDisplay).label;
          expect(soListStatusWord(status, d, l, false), `${status}/${d}/${l}`).toBe(onScreen);
        }
      }
    }
  });

  test('a held order keeps its word and says it is held — once', () => {
    expect(soListStatusWord('CONFIRMED', 'partial', 'delivered', true)).toBe('Partially Delivered (On Hold)');
    expect(soListStatusWord('ON_HOLD', null, null, true)).toBe('On Hold');
    expect(soListStatusWord(null, null, null, false)).toBeNull();
  });
});

describe('the list rules the cells follow', () => {
  test('Customer Ref follows customerRefOf', () => {
    for (const h of [{ ref: 'A', customer_so_no: 'B' }, { ref: null, customer_so_no: 'B' }, { ref: ' ', customer_so_no: null }]) {
      expect(soCustomerRef(h) ?? '').toBe(customerRefOf(h));
    }
  });

  test('Salesperson: a name in agent, else the staff row, else a uuid agent resolved', () => {
    const staff = (id: string) => ({ 's-1': 'WEI SIANG', '0a1b2c3d-0000-4000-8000-000000000001': 'LOO' } as Record<string, string>)[id] ?? null;
    expect(soSalespersonName('NICO', 's-1', staff)).toBe('NICO');
    expect(soSalespersonName(null, 's-1', staff)).toBe('WEI SIANG');
    expect(soSalespersonName('0a1b2c3d-0000-4000-8000-000000000001', null, staff)).toBe('LOO');
    expect(soSalespersonName(null, null, staff)).toBeNull();
  });

  test('money leaves sen as ringgit; the delivery date and address fall back to the header', () => {
    const cells = soLineExportCells(
      { doc_no: 'HC-SO-1', so_date: '2026-09-01T00:00:00+08:00', status: 'CONFIRMED', debtor_code: null, debtor_name: null, customer_delivery_date: '2026-09-30', address1: '1 JALAN A', address2: ' ', balance_sen: 5000, balance_sen_live: null },
      { id: 'line-1', item_code: 'X', description: 'X', qty: '2', unit_price_sen: 5.5, discount_sen: 150, total_sen: 3300 },
      { acDocNo: null, deliveryAddress: [null, null, null, null], statusWord: 'Submitted', location: 'KL', salesperson: null, delivered: 0, returned: 0, remaining: 2, onDeliveryOrder: 0, doNos: [], poNos: [], poDeliveryDate: null },
    );
    const row = Object.fromEntries(SO_LINE_EXPORT_COLUMNS.map((c, i) => [c, cells[i]]));
    expect(row['Doc Date']).toBe('2026-09-01');
    expect(row['Unit Price']).toBe(0.055);
    expect(row['Discount']).toBe(1.5);
    expect(row['Line Total']).toBe(33);
    expect(row['Doc Balance']).toBe(50);
    expect(row['Qty']).toBe(2);
    expect(row['Delivery Date']).toBe('2026-09-30');
    expect(row['Delivery Address']).toBe('1 JALAN A');
    expect(row['DO No.']).toBeNull();
    expect(cells).toHaveLength(SO_LINE_EXPORT_COLUMNS.length);
  });
});
