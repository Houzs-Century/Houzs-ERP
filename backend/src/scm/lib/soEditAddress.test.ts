// The delivery address an EDIT carries.
//
// Split out of autocount-outbox.test.ts, which hit its 2,000-line cap when this
// arrived. Its own file rather than three fewer assertions: the defect these
// pin is the THIRD instance of one shape — the CREATE path fills a field and
// the EDIT path does not — and that shape has earned its own place to grow.
//
// WHAT THE BOOK ACTUALLY SAID, 2026-08-16, read through LINQPad on the host:
//   HC-SO-2608-002  address typed in by an EDIT    InvAddr1 dsdsd   DeliverAddr1 EMPTY
//   HC-SO-2608-003  address present at CREATE      InvAddr1 gjhghj  DeliverAddr1 gjhghj
//   SO-013264/5/6   Inistate's own documents       filled           identical to Inv
//
// Inistate is the connector this ERP replaces, so its documents are the
// specification, not a reference point: whatever it writes, we write.
import { beforeEach, describe, expect, test } from 'vitest';

import { fakeSb, type Row } from './fake-postgrest';
import { resetWritebackFlagCache } from './autocount-writeback-flag';
import { enqueueEdit } from './autocount-outbox';

beforeEach(() => resetWritebackFlagCache());

/* A real cutover code — since D10 an invented SKU tests the refusal, not the
   flow. Same fixture shape as the outbox suite this came from. */
const ERP_ITEM = 'AKEMI APEX MATT (SP)';
const SALESPERSON = { id: 'staff-1', name: 'Nurul Hidayah' };

const seed = (over: Row = {}) => fakeSb({
  app_config: [{ key: 'scm.autocount_writeback', value: '1' }],
  autocount_outbox: [],
  staff: [{ ...SALESPERSON }],
  mfg_sales_orders: [{
    doc_no: 'HC-SO-A', so_date: '2026-08-16', debtor_name: 'ACME', company_id: 1,
    agent: null, salesperson_id: 'staff-1',
    sales_location: 'KL WAREHOUSE', branding: null, venue: null,
    address1: 'gjhghj', address2: 'hjghj', address3: null, address4: null,
    city: 'Kangar', postcode: '01560', customer_state: 'Perlis',
    phone: '012-1111111', emergency_contact_phone: null,
    ref: null, po_doc_no: null, customer_po: null, customer_so_no: null,
    processing_date: null,
    total_revenue_sen: 500_00, balance_sen: 500_00, deposit_sen: 0,
    linked_ac_docno: 'SO-000021',
    ...over,
  }],
  mfg_sales_order_items: [{
    doc_no: 'HC-SO-A', item_code: ERP_ITEM, description: 'Mattress',
    qty: 1, unit_price_sen: 500_00, line_delivery_date: null, linked_ac_dtlkey: 991,
  }],
  mfg_sales_order_payments: [],
});

const header = (sb: { tables: Record<string, Row[]> }) =>
  (sb.tables.autocount_outbox ?? [])[0].payload.body.Header as Record<string, unknown>;

const BLANK_ADDRESS = {
  address1: null, address2: null, address3: null, address4: null,
  city: null, postcode: null, customer_state: null,
};

describe('an EDIT carries the delivery address, not only the invoice one', () => {
  const addressed = (over: Row = {}) => seed({
      address1: 'gjhghj', address2: 'hjghj', city: 'Kangar', postcode: '01560',
      ...over,
    });
  
  test('both copies go, and they carry the same four values', async () => {
    const sb = addressed();
    expect(await enqueueEdit(sb as never, { companyId: 1, docType: 'SO', docNo: 'HC-SO-A' })).toBe(true);
    const h = header(sb);
    for (const n of [1, 2, 3, 4]) {
      expect(h[`DeliverAddr${n}`], `DeliverAddr${n}`).toBe(h[`InvAddr${n}`]);
    }
    /* The packing itself, so a change to soInvoiceAddress cannot quietly
       reshape what the delivery copy says: postcode and city share one line,
       the state gets its own. */
    expect(h.InvAddr3).toBe('01560 Kangar');
    expect(h.InvAddr4).toBe('Perlis');
    expect(h.DeliverAddr3).toBe('01560 Kangar');
    expect(h.DeliverAddr4).toBe('Perlis');
  });

  /* Omit-when-absent still holds for BOTH copies: an order with no address
     must not blank the book's own on either side. */
  test('an order with no address sends neither copy', async () => {
    const sb = addressed({
      address1: null, address2: null, address3: null, address4: null,
      city: null, postcode: null, customer_state: null,
    });
    await enqueueEdit(sb as never, { companyId: 1, docType: 'SO', docNo: 'HC-SO-A' });
    const h = header(sb);
    for (const n of [1, 2, 3, 4]) {
      expect(h, `InvAddr${n}`).not.toHaveProperty(`InvAddr${n}`);
      expect(h, `DeliverAddr${n}`).not.toHaveProperty(`DeliverAddr${n}`);
    }
  });

  /* And a CLEARED address clears both, or the book keeps a street on the
     delivery side that the order no longer has. */
  test('clearing the address nulls both copies', async () => {
    const sb = addressed({
      address1: null, address2: null, address3: null, address4: null,
      city: null, postcode: null, customer_state: null,
    });
    await enqueueEdit(sb as never, {
      companyId: 1, docType: 'SO', docNo: 'HC-SO-A', touchedFields: ['address1'],
    });
    const h = header(sb);
    for (const n of [1, 2, 3, 4]) {
      expect(h, `InvAddr${n}`).toHaveProperty(`InvAddr${n}`, null);
      expect(h, `DeliverAddr${n}`).toHaveProperty(`DeliverAddr${n}`, null);
    }
  });
});

