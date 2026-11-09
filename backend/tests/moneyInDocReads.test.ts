/* The reads behind Money in's document pages (the owner's Claude Design, batch 5
   §8.3 — c7, c4, c8). Reads only, every one company-scoped. Pinned:
     • c7 GET /accounting/receipts/:id — an official receipt with the receipt
       that replaced it (and the one it replaced), the PAYMENT's journal (a
       receipt posts nothing), what the payment says now (null when it was
       deleted), the order and its salesperson; a sales-invoice payment's receipt
       names its invoice and, through it, the order; another company's receipt is
       not found; no key, no answer;
     • c4 GET /other-debtors/receipts/:id — a debtor receipt with its four-layer
       marks, its debtor and each bill it knocks off (number, date, description,
       the amount taken off); GET /other-debtors/:id — each receipt names its
       bills;
     • c8 GET /ar-invoices/bills/:id — a bill with the receipts on it (stage
       marks, the amount on this bill) and the other-debtor credit notes
       allocated to it; another company's allocations never ride along.
   Same fake-PostgREST harness as tests/apInvoiceEdit.test.ts (no embeds: each
   read is a plain table read, seeded here). */

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { SCM_SYSTEM_STAFF_ID } from '../src/scm/middleware/auth';
import { receiptDetail, receiptsList } from '../src/scm/routes/accounting-receipts';
import { otherDebtors } from '../src/scm/routes/other-debtors';
import { arInvoices } from '../src/scm/routes/ar-invoices';

const CO = 2;
const OTHER = 3;

const world = (): Record<string, Row[]> => ({
  acc_official_receipts: [
    /* Cancelled when its payment was edited, re-issued as 8. */
    { id: 7, company_id: CO, or_number: '2990-HOR-2610-004', status: 'CANCELLED', payment_source: 'SOPAY', payment_id: 'p-1', doc_no: '2990-SO-2610-011', customer_name: 'Larding Chen', method: 'transfer', amount_sen: 111_500, paid_at: '2026-10-13', channel_account_code: '310-0001', issued_at: '2026-10-13T08:00:00Z', issued_by: 'Chew', created_at: '2026-10-13T03:00:00Z', created_by: 'Ivy', cancelled_at: '2026-10-14T02:00:00Z', cancelled_by: 'Ivy', cancel_reason: 'Payment on 2990-SO-2610-011 edited: amount RM 1,115.00 → RM 558.00', replaced_by_id: 8 },
    { id: 8, company_id: CO, or_number: '2990-DraftOR-2610-031', status: 'DRAFT', payment_source: 'SOPAY', payment_id: 'p-1', doc_no: '2990-SO-2610-011', customer_name: 'Larding Chen', method: 'transfer', amount_sen: 55_800, paid_at: '2026-10-13', channel_account_code: null, issued_at: null, issued_by: null, created_at: '2026-10-14T02:00:00Z', created_by: 'Ivy', cancelled_at: null, cancelled_by: null, cancel_reason: null, replaced_by_id: null },
    /* A sales-invoice payment's: doc_no holds the invoice id (acc/receipts.ts ensure). */
    { id: 9, company_id: CO, or_number: '2990-COR-2610-002', status: 'FORMAL', payment_source: 'SIPAY', payment_id: 'sp-1', doc_no: 'si-1', customer_name: 'Tan', method: 'cash', amount_sen: 20_000, paid_at: '2026-10-02', channel_account_code: '300-1000', issued_at: '2026-10-02T03:00:00Z', issued_by: 'Ivy', created_at: '2026-10-02T03:00:00Z', created_by: 'Ivy', cancelled_at: null, cancelled_by: null, cancel_reason: null, replaced_by_id: null },
    /* Its payment was deleted. */
    { id: 10, company_id: CO, or_number: '2990-DraftOR-2610-040', status: 'DRAFT', payment_source: 'SOPAY', payment_id: 'p-gone', doc_no: '2990-SO-2610-020', customer_name: 'Ong', method: 'transfer', amount_sen: 9_000, paid_at: '2026-10-20', channel_account_code: null, issued_at: null, issued_by: null, created_at: '2026-10-20T03:00:00Z', created_by: 'Ivy', cancelled_at: null, cancelled_by: null, cancel_reason: null, replaced_by_id: null },
    /* Born before the receipt kept its customer's name (owner 2026-11-09: 为甚没有name 这些). */
    { id: 11, company_id: CO, or_number: '2990-HOR-2610-009', status: 'FORMAL', payment_source: 'SOPAY', payment_id: 'p-1', doc_no: '2990-SO-2610-011', customer_name: null, method: 'transfer', amount_sen: 55_800, paid_at: '2026-10-13', channel_account_code: '310-0020', issued_at: '2026-11-09T09:00:00Z', issued_by: 'Chew', created_at: '2026-10-13T03:00:00Z', created_by: 'Ivy', cancelled_at: null, cancelled_by: null, cancel_reason: null, replaced_by_id: null },
    { id: 70, company_id: OTHER, or_number: 'HC-COR-2610-001', status: 'FORMAL', payment_source: 'SOPAY', payment_id: 'x-1', doc_no: 'HC-SO-2610-001', customer_name: 'Elsewhere', method: 'cash', amount_sen: 1_000, paid_at: '2026-10-01', replaced_by_id: null },
  ],
  journal_entries: [
    /* The payment's first entry, reversed when it was edited; the live one after. */
    { id: 'je-a', company_id: CO, je_no: '2990-JE-2610-0101', entry_date: '2026-10-13', source_type: 'SOPAY', source_doc_no: 'p-1', reversed: true, created_at: '2026-10-13T03:00:00Z' },
    { id: 'je-b', company_id: CO, je_no: '2990-JE-2610-0140', entry_date: '2026-10-13', source_type: 'SOPAY', source_doc_no: 'p-1', reversed: false, created_at: '2026-10-14T02:00:00Z' },
    { id: 'je-c', company_id: CO, je_no: '2990-JE-2610-0007', entry_date: '2026-10-02', source_type: 'SIPAY', source_doc_no: 'sp-1', reversed: false, created_at: '2026-10-02T03:00:00Z' },
    /* Same payment id in another company — never this receipt's books. */
    { id: 'je-x', company_id: OTHER, je_no: 'HC-JE-2610-0001', entry_date: '2026-10-13', source_type: 'SOPAY', source_doc_no: 'p-1', reversed: false, created_at: '2026-10-15T02:00:00Z' },
  ],
  mfg_sales_order_payments: [
    { id: 'p-1', company_id: CO, so_doc_no: '2990-SO-2610-011', paid_at: '2026-10-13', method: 'transfer', amount_sen: 55_800 },
  ],
  sales_invoice_payments: [
    { id: 'sp-1', company_id: CO, sales_invoice_id: 'si-1', paid_at: '2026-10-02', method: 'cash', amount_sen: 20_000 },
  ],
  sales_invoices: [{ id: 'si-1', company_id: CO, invoice_number: '2990-SI-2610-005', so_doc_no: '2990-SO-2609-090' }],
  mfg_sales_orders: [
    {
      doc_no: '2990-SO-2610-011', company_id: CO, salesperson_id: 'staff-mei', debtor_name: 'Larding Chen', phone: '012-3456789',
      address1: 'No. 5, Jalan Puchong', address2: 'Taman Puchong', city: 'Puchong', postcode: '47100', customer_state: 'Selangor',
    },
    { doc_no: '2990-SO-2609-090', company_id: CO, salesperson_id: 'staff-ah', debtor_name: 'Tan Ah Kow', phone: '019-8765432', address1: 'Lot 9', address2: null, city: null, postcode: null, customer_state: 'Johor' },
  ],
  staff: [{ id: 'staff-mei', name: 'Mei Ling' }, { id: 'staff-ah', name: 'Ah Seng' }],
  acc_debtors: [
    { id: 'd1', company_id: CO, name: 'AHMAD BIN ALI', phone: '012-345', notes: null, is_active: true, address1: '12 Jalan Satu' },
  ],
  acc_debtor_bills: [
    { id: 'b1', company_id: CO, bill_number: '2990-ODB-2609-001', debtor_id: 'd1', bill_date: '2026-09-05', total_sen: 50_000, received_sen: 50_000, status: 'PAID', notes: '转租九月', created_at: '2026-09-05T02:00:00Z', doc_kind: 'INV' },
    { id: 'b2', company_id: CO, bill_number: '2990-ODB-2609-002', debtor_id: 'd1', bill_date: '2026-09-20', total_sen: 30_000, received_sen: 10_000, status: 'POSTED', notes: 'Booth rental', created_at: '2026-09-20T02:00:00Z', doc_kind: 'INV' },
  ],
  acc_debtor_bill_lines: [],
  acc_debtor_receipts: [
    { id: 'r1', company_id: CO, receipt_number: '2990-ODR-2610-001', debtor_id: 'd1', receipt_date: '2026-10-03', bank_account_code: '310-0001', total_sen: 60_000, status: 'POSTED', submitted_at: '2026-10-03T01:00:00Z', submitted_by: 'u', checked_at: '2026-10-03T02:00:00Z', checked_by: 'u', approved_at: '2026-10-03T03:00:00Z', approved_by: 'u', posted_at: '2026-10-03T03:00:00Z', notes: null, created_at: '2026-10-03T00:00:00Z' },
    { id: 'r2', company_id: CO, receipt_number: '2990-ODR-2610-002', debtor_id: 'd1', receipt_date: '2026-10-25', bank_account_code: '310-0001', total_sen: 5_000, status: 'DRAFT', submitted_at: '2026-10-25T01:00:00Z', submitted_by: 'u', checked_at: null, checked_by: null, approved_at: null, approved_by: null, posted_at: null, notes: null, created_at: '2026-10-25T00:00:00Z' },
    { id: 'r9', company_id: OTHER, receipt_number: 'HC-ODR-2610-001', debtor_id: 'd9', receipt_date: '2026-10-01', bank_account_code: '310-0001', total_sen: 1_000, status: 'POSTED' },
  ],
  acc_debtor_receipt_allocations: [
    { id: 'a1', company_id: CO, receipt_id: 'r1', bill_id: 'b1', amount_sen: 50_000 },
    { id: 'a2', company_id: CO, receipt_id: 'r1', bill_id: 'b2', amount_sen: 10_000 },
    { id: 'a3', company_id: CO, receipt_id: 'r2', bill_id: 'b2', amount_sen: 5_000 },
    /* Another company's row naming the same bill id never rides along. */
    { id: 'a9', company_id: OTHER, receipt_id: 'r9', bill_id: 'b2', amount_sen: 1_000 },
  ],
  acc_credit_notes: [
    { id: 'n1', company_id: CO, note_number: '2990-OCN-2610-001', note_date: '2026-10-10', status: 'POSTED', kind: 'OCN', reason: 'Rental discount' },
  ],
  acc_credit_note_allocations: [
    { id: 'ca1', company_id: CO, note_id: 'n1', debtor_bill_id: 'b2', amount_sen: 3_000, applied_sen: 3_000 },
  ],
});

const harness = (tables = world(), perms: string[] = ['*']) => {
  const sb = fakeSb(tables, {}, [], ['acc_official_receipts']);
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, CO as never);
    /* The pinned system-staff id: the routers' supabaseAuth bridge steps aside
       and the hand-set client + houzsUser stay (docs/bugs/0648). */
    c.set('user' as never, { id: SCM_SYSTEM_STAFF_ID } as never);
    c.set('houzsUser' as never, { name: 'Chew', permissions_set: new Set(perms) } as never);
    c.set('allowedCompanyIds' as never, [CO] as never);
    await next();
  });
  app.get('/accounting/receipts', receiptsList as never);
  app.get('/accounting/receipts/:id', receiptDetail as never);
  app.route('/other-debtors', otherDebtors);
  app.route('/ar-invoices', arInvoices);
  return app;
};
const get = async (app: Hono, path: string) => {
  const res = await app.request(path);
  return { status: res.status, body: await res.json() as any };
};

describe('c7 — GET /accounting/receipts/:id', () => {
  test('a cancelled receipt names its re-issue; the payment\'s live journal, what the payment says now, the order and its salesperson ride along', async () => {
    const { status, body } = await get(harness(), '/accounting/receipts/7');
    expect(status).toBe(200);
    expect(body.receipt).toMatchObject({ or_number: '2990-HOR-2610-004', status: 'CANCELLED', cancel_reason: 'Payment on 2990-SO-2610-011 edited: amount RM 1,115.00 → RM 558.00' });
    expect(body.replacedBy).toEqual({ id: 8, orNumber: '2990-DraftOR-2610-031', status: 'DRAFT' });
    expect(body.replaces).toBeNull();
    /* The edit reversed the first entry; the live one is the books — never another company's. */
    expect(body.paymentJournal).toEqual({ id: 'je-b', jeNo: '2990-JE-2610-0140', reversed: false });
    expect(body.payment).toEqual({ amountSen: 55_800, paidAt: '2026-10-13', method: 'transfer', soDocNo: '2990-SO-2610-011', salesInvoiceId: null });
    expect(body.salesOrder).toBe('2990-SO-2610-011');
    expect(body.salesperson).toBe('Mei Ling');
    expect(body.salesInvoice).toBeNull();
  });

  test('the re-issue names the receipt it replaced', async () => {
    const { body } = await get(harness(), '/accounting/receipts/8');
    expect(body.replaces).toEqual({ id: 7, orNumber: '2990-HOR-2610-004', status: 'CANCELLED' });
    expect(body.replacedBy).toBeNull();
  });

  test("a sales-invoice payment's receipt names the invoice and, through it, the order", async () => {
    const { body } = await get(harness(), '/accounting/receipts/9');
    expect(body.salesInvoice).toEqual({ id: 'si-1', number: '2990-SI-2610-005' });
    expect(body.salesOrder).toBe('2990-SO-2609-090');
    expect(body.salesperson).toBe('Ah Seng');
    expect(body.paymentJournal).toMatchObject({ jeNo: '2990-JE-2610-0007' });
  });

  /* Owner 2026-11-09 (为甚没有name 这些): RECEIVED FROM prints the customer's name, phone
     and address — the order's, read when the receipt is handed out to print. */
  test('the receipt carries its order\'s phone and address to print, and the order\'s name when it has none', async () => {
    const { body } = await get(harness(), '/accounting/receipts/11');
    expect(body.receipt).toMatchObject({
      customer_name: 'Larding Chen', phone: '012-3456789',
      address_lines: ['No. 5, Jalan Puchong', 'Taman Puchong', '47100 Puchong', 'Selangor'],
    });
    /* A name the receipt keeps is its own; an invoice's receipt reads the invoice's order. */
    expect((await get(harness(), '/accounting/receipts/8')).body.receipt).toMatchObject({ customer_name: 'Larding Chen', phone: '012-3456789' });
    expect((await get(harness(), '/accounting/receipts/9')).body.receipt).toMatchObject({ customer_name: 'Tan', phone: '019-8765432', address_lines: ['Lot 9', 'Johor'] });
    /* No order to read: nothing invented. */
    expect((await get(harness(), '/accounting/receipts/10')).body.receipt).toMatchObject({ customer_name: 'Ong', phone: null, address_lines: [] });
  });

  test('the list carries them too, for the batch print', async () => {
    const { status, body } = await get(harness(), '/accounting/receipts?all=1');
    expect(status).toBe(200);
    const byId = Object.fromEntries((body.receipts as any[]).map((r) => [r.id, r]));
    expect(byId[11]).toMatchObject({ customer_name: 'Larding Chen', phone: '012-3456789', address_lines: ['No. 5, Jalan Puchong', 'Taman Puchong', '47100 Puchong', 'Selangor'] });
    expect(byId[9]).toMatchObject({ customer_name: 'Tan', phone: '019-8765432' });
  });

  test('a deleted payment reads as gone, never as a zero', async () => {
    const { status, body } = await get(harness(), '/accounting/receipts/10');
    expect(status).toBe(200);
    expect(body.payment).toBeNull();
    expect(body.paymentJournal).toBeNull();
  });

  test("another company's receipt is not found; a bad id is refused; no key, no answer", async () => {
    expect((await get(harness(), '/accounting/receipts/70')).status).toBe(404);
    expect((await get(harness(), '/accounting/receipts/abc')).status).toBe(400);
    expect((await get(harness(world(), ['scm.access']), '/accounting/receipts/7')).status).toBe(403);
    expect((await get(harness(world(), ['scm.sales_order.write']), '/accounting/receipts/7')).status).toBe(200);
  });

  test('a read that fails says so — never an empty answer', async () => {
    const t = world();
    const sb = fakeSb(t, { journal_entries: ['je_no'] }, [], ['acc_official_receipts']);
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('supabase' as never, sb as never);
      c.set('companyId' as never, CO as never);
      c.set('houzsUser' as never, { name: 'Chew', permissions_set: new Set(['*']) } as never);
      await next();
    });
    app.get('/accounting/receipts/:id', receiptDetail as never);
    const { status, body } = await get(app, '/accounting/receipts/7');
    expect(status).toBe(500);
    expect(body.reason).toMatch(/^payment journal: /);
  });
});

describe('c4 — a debtor receipt for its page', () => {
  test('GET /other-debtors/receipts/:id: the receipt with its marks, its debtor and each bill it knocks off', async () => {
    const { status, body } = await get(harness(), '/other-debtors/receipts/r1');
    expect(status).toBe(200);
    expect(body.receipt).toMatchObject({ receipt_number: '2990-ODR-2610-001', status: 'POSTED', checked_at: '2026-10-03T02:00:00Z' });
    expect(body.debtor).toMatchObject({ id: 'd1', name: 'AHMAD BIN ALI', address1: '12 Jalan Satu' });
    expect(body.allocations).toEqual([
      { billId: 'b1', amountSen: 50_000, billNumber: '2990-ODB-2609-001', billDate: '2026-09-05', description: '转租九月', totalSen: 50_000, receivedSen: 50_000, status: 'PAID', docKind: 'INV' },
      { billId: 'b2', amountSen: 10_000, billNumber: '2990-ODB-2609-002', billDate: '2026-09-20', description: 'Booth rental', totalSen: 30_000, receivedSen: 10_000, status: 'POSTED', docKind: 'INV' },
    ]);
  });

  test("another company's receipt is not found", async () => {
    expect((await get(harness(), '/other-debtors/receipts/r9')).status).toBe(404);
  });

  test('GET /other-debtors/:id: each receipt names the bills it knocks off', async () => {
    const { body } = await get(harness(), '/other-debtors/d1');
    const byNo = Object.fromEntries((body.receipts as Array<{ receipt_number: string; bills: unknown[] }>).map((r) => [r.receipt_number, r.bills]));
    expect(byNo['2990-ODR-2610-001']).toEqual([
      { billId: 'b1', no: '2990-ODB-2609-001', amountSen: 50_000 },
      { billId: 'b2', no: '2990-ODB-2609-002', amountSen: 10_000 },
    ]);
    expect(byNo['2990-ODR-2610-002']).toEqual([{ billId: 'b2', no: '2990-ODB-2609-002', amountSen: 5_000 }]);
  });
});

describe('c8 — GET /ar-invoices/bills/:id with what came in on it', () => {
  test('the receipts on the bill (stage marks, the amount on this bill) and the credit notes allocated to it', async () => {
    const { status, body } = await get(harness(), '/ar-invoices/bills/b2');
    expect(status).toBe(200);
    expect(body.bill.bill_number).toBe('2990-ODB-2609-002');
    expect(body.receipts).toEqual([
      { id: 'r1', number: '2990-ODR-2610-001', date: '2026-10-03', status: 'POSTED', submittedAt: '2026-10-03T01:00:00Z', checkedAt: '2026-10-03T02:00:00Z', approvedAt: '2026-10-03T03:00:00Z', amountSen: 10_000 },
      { id: 'r2', number: '2990-ODR-2610-002', date: '2026-10-25', status: 'DRAFT', submittedAt: '2026-10-25T01:00:00Z', checkedAt: null, approvedAt: null, amountSen: 5_000 },
    ]);
    expect(body.creditNotes).toEqual([
      { id: 'n1', number: '2990-OCN-2610-001', date: '2026-10-10', status: 'POSTED', reason: 'Rental discount', amountSen: 3_000, appliedSen: 3_000 },
    ]);
  });

  test('a bill nothing came in on lists none', async () => {
    const t = world();
    t.acc_debtor_receipt_allocations = [];
    t.acc_credit_note_allocations = [];
    const { body } = await get(harness(t), '/ar-invoices/bills/b1');
    expect(body.receipts).toEqual([]);
    expect(body.creditNotes).toEqual([]);
  });
});
