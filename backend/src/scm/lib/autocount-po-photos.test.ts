/* A purchase order's line photographs reach the account book.
 *
 * Its own file because `autocount-outbox.test.ts` already sits over the
 * 2,000-line cap and a ceiling only moves down (docs/repo-hygiene.md).
 *
 * WHY IT EXISTS. Asked on 2026-08-31 whether purchase orders should send their
 * line photographs the way sales orders do, the owner answered 「要」. What had
 * held the purchase side back was never code — `photosOf` reads the raw row and
 * is document-type agnostic, the drain keys off the OP not the type, and the
 * service's line loop is `dynamic` — it was EVIDENCE: the `\wmetafile8` shape
 * had only been proven on the live book for sales orders. docs/bugs/0582-*.
 */
import { describe, expect, test } from 'vitest';
import { enqueueEdit } from './autocount-outbox';
import { fakeSb, type Row } from './fake-postgrest';

const ERP_A = 'AKEMI APEX MATT (SP)';

const withFlag = (extra: Record<string, Row[]>) => fakeSb({
  app_config: [{ key: 'scm.autocount_writeback', value: '1' }],
  autocount_outbox: [],
  staff: [{ id: 'staff-1', name: 'Nurul Hidayah' }],
  ...extra,
}, { purchase_orders: ['creditor_code', 'creditor_name', 'agent', 'ref'] });

describe('purchase order line photographs', () => {
  test('a purchase line photograph travels, keyed by the AutoCount line', async () => {
    const sb = withFlag({
      purchase_orders: [{
        id: 'po-1', po_number: 'HC-PO-9', po_date: '2026-08-10', supplier_id: 'sup-1',
        notes: 'a note', linked_ac_docno: 'PO-000042', purchase_location_id: 'wh-1',
      }],
      suppliers: [{ id: 'sup-1', code: '400-H004', name: 'Supplier' }],
      purchase_order_items: [{
        id: 'po-row-old', purchase_order_id: 'po-1', item_code: ERP_A, description: 'D',
        qty: 3, unit_price_sen: 5000, linked_ac_dtlkey: 7001, warehouse_id: 'wh-1',
        photo_urls: ['po-items/HC-PO-9/po-row-old/ac-7001-1.jpg'],
      }],
      warehouses: [{ id: 'wh-1', code: 'KL', name: 'KL WAREHOUSE' }],
    });

    expect(await enqueueEdit(sb as never, { companyId: 1, docType: 'PO', docId: 'po-1' })).toBe(true);
    expect((sb.tables.autocount_outbox ?? [])[0].payload.photos).toEqual([
      { dtlKey: 7001, keys: ['po-items/HC-PO-9/po-row-old/ac-7001-1.jpg'] },
    ]);
  });
});
