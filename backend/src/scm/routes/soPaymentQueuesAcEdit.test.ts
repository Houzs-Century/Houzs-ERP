// Recording a payment has to reach AutoCount.
//
// WHY THIS FILE EXISTS, AND WHAT IT IS NOT A DUPLICATE OF.
// autocount-outbox.test.ts already proves the COMPOSER puts the outstanding
// balance in an edit's `UDF.BALANCE` — one of its cases is even named "an EDIT
// carries it too, so a payment taken after the create reaches the book". That
// test passed from the day it was written while the sentence in its own name
// was false: nothing on the payment path ever CALLED enqueueEdit, so the book's
// BALANCE stayed at whatever the last line-or-header save had left there. A
// composer test cannot see a missing call site. This one is about the wiring.
//
// It exercises `recordSoPaymentRow` — the factored insert core, in scm/lib so
// both writers reach it without importing a 12,000-line router — rather than
// the HTTP route, because that is the seam BOTH writers share: the interactive
// POST /:docNo/payments and scan-so.ts's background receipt booking, which has
// no request context. A rule proven only through the route would leave the scan
// job silently uncovered, which is this module's recurring shape.
//
// PATCH and DELETE queue through queueAcSoEdit in the route closures and are
// NOT covered here — those handlers are not exported and mounting the whole
// 12,000-line router to reach them costs more than it proves. Stated rather
// than left for a reader to discover.
import { beforeEach, describe, expect, test } from 'vitest';

import { fakeSb, type Row } from '../lib/fake-postgrest';
import { resetWritebackFlagCache } from '../lib/autocount-writeback-flag';
import { recordSoPaymentRow } from '../lib/so-payment-row';

/* Cached for 30 seconds by design, and the cache is module-level — without this
   the second test in the file inherits the first one's switch. Same seam
   autocount-outbox.test.ts and autocountOutboxRoute.test.ts use. */
beforeEach(() => resetWritebackFlagCache());

/* A real cutover code. Since D10 the composer resolves every ERP item against
   autocount-erp-mapping-1561.csv and REFUSES what it cannot find, so an
   invented SKU would test the refusal instead of the flow. */
const ERP_ITEM = 'AKEMI APEX MATT (SP)';

const SO = {
  doc_no: 'HC-SO-P1', so_date: '2026-08-15', debtor_name: 'ACME', company_id: 1,
  agent: null, salesperson_id: 'staff-1',
  sales_location: 'KL WAREHOUSE', branding: null, venue: null,
  address1: 'A1', address2: null, address3: null, address4: null,
  city: null, postcode: null, customer_state: null,
  phone: '012-1111111', emergency_contact_phone: null,
  ref: null, po_doc_no: null, customer_po: null, customer_so_no: null,
  processing_date: null,
  total_revenue_centi: 500_00, balance_centi: 500_00, deposit_centi: 0,
  /* Already in the account book — an order with no counterpart has nothing to
     edit, and enqueueEdit correctly says nothing about it. */
  linked_ac_docno: 'SO-000021',
};

const ITEM = {
  doc_no: 'HC-SO-P1', item_code: ERP_ITEM, description: 'Mattress',
  qty: 1, unit_price_centi: 500_00, line_delivery_date: null,
  /* An edit addresses a line by AutoCount's own key and refuses a line without
     one, so the fixture carries it. */
  linked_ac_dtlkey: 991,
};

const seed = (flag: string | null, soOver: Row = {}, extra: Record<string, Row[]> = {}) =>
  fakeSb({
    app_config: flag == null ? [] : [{ key: 'scm.autocount_writeback', value: flag }],
    autocount_outbox: [],
    staff: [{ id: 'staff-1', name: 'Nurul Hidayah' }],
    mfg_sales_orders: [{ ...SO, ...soOver }],
    mfg_sales_order_items: [{ ...ITEM }],
    mfg_sales_order_payments: [],
    so_audit_log: [],
    ...extra,
  });

const outbox = (sb: { tables: Record<string, Row[]> }) => sb.tables.autocount_outbox ?? [];

const payment = (over: Row = {}) => ({
  docNo: 'HC-SO-P1',
  paidAt: '2026-08-15',
  method: 'cash' as const,
  amountCenti: 300_00,
  slipKey: null,
  createdBy: '00000000-0000-4000-8000-000000000001',
  ...over,
});

describe('a recorded payment queues the AutoCount edit that carries the new balance', () => {
  test('the ledger row and an edit operation both land', async () => {
    const sb = seed('1');
    const { payment: row, errorMessage } = await recordSoPaymentRow(sb, payment());

    expect(errorMessage).toBeNull();
    expect(row).not.toBeNull();

    const queued = outbox(sb);
    expect(queued).toHaveLength(1);
    expect(queued[0].op).toBe('edit');
    expect(queued[0].doc_type).toBe('SO');
    expect(queued[0].doc_no).toBe('HC-SO-P1');
  });

  /* THE POINT OF THE WHOLE CHANGE. 500.00 ordered, 300.00 taken — the account
     book has to be told 200.00, and the payment that was just inserted has to
     be one of the rows the balance is computed from. A queue row carrying
     500.00 would mean the edit was composed before the insert. */
  test('the queued edit carries the balance AFTER this payment, not before it', async () => {
    const sb = seed('1');
    await recordSoPaymentRow(sb, payment());

    const header = outbox(sb)[0].payload.body.Header as Record<string, Record<string, string>>;
    expect(header.UDF.BALANCE).toBe('200.00');
  });

  /* Zero is a value, not an absence: a settled order must arrive as "0.00" or
     the book goes on showing a debt that has been paid. */
  test('a payment that settles the order sends 0.00', async () => {
    const sb = seed('1');
    await recordSoPaymentRow(sb, payment({ amountCenti: 500_00 }));

    const header = outbox(sb)[0].payload.body.Header as Record<string, Record<string, string>>;
    expect(header.UDF.BALANCE).toBe('0.00');
  });

  /* The toggle ships OFF and OFF means nothing is queued — the property the
     outbox suite pins first, re-asserted at this new call site because a new
     enqueue that ignored the flag would write into a licensed account book. */
  test('the write-back toggle OFF queues nothing, and the payment still records', async () => {
    const sb = seed('off');
    const { errorMessage } = await recordSoPaymentRow(sb, payment());

    expect(errorMessage).toBeNull();
    expect(sb.tables.mfg_sales_order_payments).toHaveLength(1);
    expect(outbox(sb)).toHaveLength(0);
  });

  /* An order the write-back never sent has no counterpart to edit. Silently
     correct, and asserted so a future change cannot start inventing documents
     in the book from a payment. */
  test('an order with no AutoCount counterpart queues nothing', async () => {
    const sb = seed('1', { linked_ac_docno: null });
    await recordSoPaymentRow(sb, payment());

    expect(sb.tables.mfg_sales_order_payments).toHaveLength(1);
    expect(outbox(sb)).toHaveLength(0);
  });

  /* A failure to queue may never fail a user's save — the outbox's second
     founding property. `missing` makes fakeSb answer 42703 for the outbox
     table, which is the closest stand-in for a dead queue. */
  test('a queue that cannot be written does not fail the payment', async () => {
    const sb = fakeSb({
      app_config: [{ key: 'scm.autocount_writeback', value: '1' }],
      staff: [{ id: 'staff-1', name: 'Nurul Hidayah' }],
      mfg_sales_orders: [{ ...SO }],
      mfg_sales_order_items: [{ ...ITEM }],
      mfg_sales_order_payments: [],
      so_audit_log: [],
      autocount_outbox: [],
    }, { autocount_outbox: ['payload'] });

    const { payment: row, errorMessage } = await recordSoPaymentRow(sb, payment());
    expect(errorMessage).toBeNull();
    expect(row).not.toBeNull();
  });
});
