/* The Purchase Order line export's column CONTRACT, and the one rule for
 * "Estimate Delivery Date 1/2/3".
 *
 * WHY A MIRROR. The server builds the rows (backend/src/scm/lib/po-line-export.ts)
 * and the browser writes the sheet and reads the names (po-list-export.ts,
 * Outstanding.tsx). The frontend cannot import from backend/src, so the module
 * is copied byte for byte — the warehouse-label.ts pattern — and this test is
 * the referee. backend/scripts/check-shared-mirrors.mjs sees the pair by
 * basename, so the file must stay at the top level of this directory.
 *
 * WHY THE NAMES ARE PINNED AS LITERALS. An import reads an exported file back
 * by these header names and matches rows by Line ID. A rename that updated both
 * copies at once would still pass byte-identity, and would still break every
 * file already exported — so the names get assertions of their own.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  PO_ESTIMATE_DELIVERY_DATE_FIELDS,
  PO_LINE_EXPORT_COLUMNS,
  PO_STATUS_WORDS,
  poEstimateDeliveryDates,
  poLineExportCells,
  poStatusWord,
} from './po-line-export-columns';

describe('the two copies of this module are the same file', () => {
  test('backend/src/scm/lib/po-line-export-columns.ts is byte-identical to this one', () => {
    const here = resolve(process.cwd(), 'src/vendor/scm/lib/po-line-export-columns.ts');
    const there = resolve(process.cwd(), '../backend/src/scm/lib/po-line-export-columns.ts');
    const norm = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
    expect(norm(there)).toBe(norm(here));
  });
});

describe('the column contract', () => {
  test('the header names and their order', () => {
    expect([...PO_LINE_EXPORT_COLUMNS]).toEqual([
      'Doc No',
      'AutoCount Doc No',
      'Doc Date',
      'Status',
      'Supplier Code',
      'Supplier Name',
      'SO Doc No.',
      'Item Code',
      'Supplier SKU',
      'Item Description',
      'Item Description 2',
      'Remarks',
      'Category',
      'Location',
      'Qty',
      'Received Qty',
      'Remaining Qty',
      'Unit Price',
      'Line Total',
      'Delivery Date',
      'Estimate Delivery Date 1',
      'Estimate Delivery Date 2',
      'Estimate Delivery Date 3',
      'Line ID',
    ]);
  });

  test('Remarks sits right after Item Description 2', () => {
    const i = PO_LINE_EXPORT_COLUMNS.indexOf('Item Description 2');
    expect(PO_LINE_EXPORT_COLUMNS[i + 1]).toBe('Remarks');
  });
});

describe('Estimate Delivery Date 1/2/3', () => {
  test('are supplier_delivery_date_2, _3 and _4', () => {
    expect([...PO_ESTIMATE_DELIVERY_DATE_FIELDS]).toEqual([
      'supplier_delivery_date_2',
      'supplier_delivery_date_3',
      'supplier_delivery_date_4',
    ]);
  });

  test('the line wins; the PO header fills a blank line', () => {
    expect(poEstimateDeliveryDates(
      { supplier_delivery_date_2: null, supplier_delivery_date_3: '2026-09-25', supplier_delivery_date_4: null },
      { supplier_delivery_date_2: '2026-09-12', supplier_delivery_date_3: '2026-09-18', supplier_delivery_date_4: null },
    )).toEqual(['2026-09-12', '2026-09-25', null]);
  });

  test('a timestamp keeps its date; blank is null', () => {
    expect(poEstimateDeliveryDates({ supplier_delivery_date_2: '2026-09-12T00:00:00+08:00', supplier_delivery_date_3: '  ' }, null))
      .toEqual(['2026-09-12', null, null]);
  });
});

describe('the Status word', () => {
  test('is the word the list shows, never the stored enum', () => {
    expect(poStatusWord('SUBMITTED', false)).toBe('Submitted');
    expect(poStatusWord('PARTIALLY_RECEIVED', null)).toBe('Partially received');
    expect(poStatusWord('CANCELLED', false)).toBe('Cancelled');
  });

  test('a held order keeps its status and says it is held — once', () => {
    expect(poStatusWord('SUBMITTED', true)).toBe('Submitted (On Hold)');
    expect(poStatusWord('ON_HOLD', true)).toBe('On Hold');
  });

  test('says exactly what the Purchase Orders list says, status by status', () => {
    /* The list keeps its own STATUS_TONE map (localStatusMapsAgree.test.ts
       watches it against status-pill.ts). The export must print the words that
       map puts on screen, so read them out of the page itself. */
    const page = readFileSync(resolve(process.cwd(), 'src/pages/scm-v2/PurchaseOrdersListV2.tsx'), 'utf8');
    const block = /const STATUS_TONE[\s\S]*?\n};/.exec(page)?.[0] ?? '';
    const onScreen = Object.fromEntries(
      [...block.matchAll(/^\s*([A-Z_]+):\s*\{[^}]*label:\s*"([^"]+)"/gm)].map((m) => [m[1], m[2]]),
    );
    expect(Object.keys(onScreen).length, 'the scan read no labels from the page').toBeGreaterThanOrEqual(6);
    expect(onScreen).toEqual({ ...PO_STATUS_WORDS });
  });

  test('an unknown status prints as stored; none is null', () => {
    expect(poStatusWord('SOMETHING_NEW', false)).toBe('SOMETHING_NEW');
    expect(poStatusWord(null, false)).toBeNull();
  });
});

describe('one line as cells', () => {
  test('money leaves sen as ringgit, a unit price keeps four decimals', () => {
    const cells = poLineExportCells(
      { po_number: 'HC-PO-009951', po_date: '2026-09-04', status: 'SUBMITTED' },
      { id: 'line-1', item_code: 'CODY-(K)', material_name: 'CODY KING', qty: '600', received_qty: null, unit_price_sen: 5.5, line_total_sen: 3300 },
      { soDocNo: null, location: null },
    );
    const row = Object.fromEntries(PO_LINE_EXPORT_COLUMNS.map((c, i) => [c, cells[i]]));
    expect(row['Unit Price']).toBe(0.055);
    expect(row['Line Total']).toBe(33);
    expect(row['Qty']).toBe(600);
    expect(row['Remaining Qty']).toBe(600);
    expect(row['Line ID']).toBe('line-1');
    expect(cells).toHaveLength(PO_LINE_EXPORT_COLUMNS.length);
  });
});
