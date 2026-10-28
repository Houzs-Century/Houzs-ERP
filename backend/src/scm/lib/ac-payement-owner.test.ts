// A carried-over order's AutoCount payment text is the office's, and the ERP no
// longer rewrites it (docs/bugs/0934). Between 2026-09-07 and 09-15, ERP sales
// order edits dropped a real payment reference from 69 such orders' text, and 415
// more would have lost one on their next edit.
import { beforeEach, describe, expect, test } from 'vitest';
import { erpOwnsPaymentText } from './ac-payement-owner';
import { enqueueSoPaymentEdit } from './ac-so-payment-edit';
import { enqueueEdit } from './autocount-outbox';
import { resetWritebackFlagCache } from './autocount-writeback-flag';
import { fakeSb, type Row } from './fake-postgrest';

beforeEach(() => resetWritebackFlagCache());

/* A real cutover code: the composer refuses an item it cannot map. */
const ERP_ITEM = 'AKEMI APEX MATT (SP)';

const order = (linkedAcDocNo: string): Row => ({
  doc_no: 'HC-SO-012411', so_date: '2026-06-10', debtor_name: 'ACME', company_id: 1,
  agent: null, salesperson_id: 'staff-1', sales_location: 'KL WAREHOUSE', branding: null, venue: null,
  address1: 'A1', address2: null, address3: null, address4: null, city: null, postcode: null, customer_state: null,
  phone: '012-1111111', emergency_contact_phone: null, ref: null, customer_so_no: null, processing_date: null,
  total_revenue_sen: 3_000_00, local_total_sen: 3_000_00, deposit_sen: 0,
  linked_ac_docno: linkedAcDocNo,
});

/* Two ERP payment rows with references: on a carried-over order the book's text
   holds more than these, which is exactly what a rewrite would lose. */
const seed = (linkedAcDocNo: string) => fakeSb({
  app_config: [{ key: 'scm.autocount_writeback', value: '1' }],
  autocount_outbox: [],
  staff: [{ id: 'staff-1', name: 'Nurul Hidayah' }],
  mfg_sales_orders: [order(linkedAcDocNo)],
  mfg_sales_order_items: [{ id: 'row-1', doc_no: 'HC-SO-012411', item_code: ERP_ITEM, description: 'M', qty: 1, unit_price_sen: 3_000_00, cancelled: false, warehouse_id: null, linked_ac_dtlkey: 991, company_id: 1 }],
  mfg_sales_order_payments: [
    { id: 'p-1', so_doc_no: 'HC-SO-012411', company_id: 1, amount_sen: 1_000_00, is_deposit: false, paid_at: '2026-06-10', account_sheet: 'MAYBANK', approval_code: '111111' },
    { id: 'p-2', so_doc_no: 'HC-SO-012411', company_id: 1, amount_sen: 500_00, is_deposit: false, paid_at: '2026-09-15', account_sheet: 'Bank Transfer', approval_code: '222222' },
  ],
});

const asSb = (sb: unknown) => sb as Parameters<typeof enqueueSoPaymentEdit>[0];
const queuedUdf = (sb: { tables: Record<string, Row[]> }) =>
  ((sb.tables.autocount_outbox[0].payload as { body: { Header: { UDF?: Record<string, string> } } }).body.Header.UDF ?? {});

describe('erpOwnsPaymentText', () => {
  test('an ERP-numbered order and a create are the ERP\'s; a book-numbered order is the office\'s', () => {
    expect(erpOwnsPaymentText('HC-SO-2609-011')).toBe(true);
    expect(erpOwnsPaymentText(null)).toBe(true);
    expect(erpOwnsPaymentText('SO-012411')).toBe(false);
    expect(erpOwnsPaymentText(' so-000102 ')).toBe(false);
  });
});

describe('the payment-only edit', () => {
  test('a carried-over order gets its balance and no payment text', async () => {
    const sb = seed('SO-012411');
    expect(await enqueueSoPaymentEdit(asSb(sb), { companyId: 1, docNo: 'HC-SO-012411', createdBy: null })).toBe(true);
    expect(queuedUdf(sb)).toEqual({ BALANCE: '1500.00' });
  });

  test('CONTROL: an order the ERP made still gets both', async () => {
    const sb = seed('HC-SO-2609-011');
    expect(await enqueueSoPaymentEdit(asSb(sb), { companyId: 1, docNo: 'HC-SO-012411', createdBy: null })).toBe(true);
    expect(queuedUdf(sb)).toMatchObject({ BALANCE: '1500.00', PAYEMENT: expect.stringContaining('222222') });
  });
});

describe('the full sales order edit', () => {
  test('a carried-over order\'s edit carries no payment text', async () => {
    const sb = seed('SO-012411');
    expect(await enqueueEdit(asSb(sb), { companyId: 1, docType: 'SO', docNo: 'HC-SO-012411' })).toBe(true);
    expect(queuedUdf(sb)).not.toHaveProperty('PAYEMENT');
    expect(queuedUdf(sb)).toHaveProperty('BALANCE', '1500.00');
  });

  test('CONTROL: an order the ERP made keeps sending it', async () => {
    const sb = seed('HC-SO-2609-011');
    expect(await enqueueEdit(asSb(sb), { companyId: 1, docType: 'SO', docNo: 'HC-SO-012411' })).toBe(true);
    expect(queuedUdf(sb)).toHaveProperty('PAYEMENT');
  });
});
