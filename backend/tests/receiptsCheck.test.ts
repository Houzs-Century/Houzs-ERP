/* One month of customer payments against one month of Official Receipts
   (owner 2026-09-16: or 我如何查看 amount 是对的). Pinned:
     · the verdict is pure: the two totals, the difference, the payments with
       no receipt, the receipts whose amount is not their payment's, the
       receipts whose payment is gone;
     · the route reads the month's SO and SI payments (money that arrived —
       no converted rows, no mirrors, no zero rows) and the month's receipts
       by their payment day; a bad month is refused; no key, no answer;
     · the list takes ?month= and then returns every receipt of the month,
       oldest first, past the newest-100 cap. */

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { monthRange, receiptsCheck, receiptsCheckOf, type CheckPayment, type CheckReceipt } from '../src/scm/routes/accounting-receipts-check';
import { receiptsList } from '../src/scm/routes/accounting-receipts';

const CO = 2;

const pay = (source: 'SOPAY' | 'SIPAY', id: string, docNo: string, paidAt: string, amountSen: number): CheckPayment =>
  ({ source, paymentId: id, docNo, paidAt, method: 'cash', amountSen });
const rc = (orNumber: string, source: string, paymentId: string, docNo: string, paidAt: string, amountSen: number): CheckReceipt =>
  ({ id: 1, orNumber, status: 'DRAFT', source, paymentId, docNo, paidAt, amountSen });

describe('receiptsCheckOf', () => {
  test('the totals, the difference, and every row behind it', () => {
    const out = receiptsCheckOf('2026-06', [
      pay('SOPAY', 'a', '2990-SO-2606-001', '2026-06-03', 10_000),
      pay('SIPAY', 'b', '2990-SI-2606-001', '2026-06-05', 20_000),
      pay('SOPAY', 'c', '2990-SO-2606-002', '2026-06-09', 30_000),
    ], [
      rc('2990-COR-2606-001', 'SOPAY', 'a', '2990-SO-2606-001', '2026-06-03', 10_000),
      rc('2990-DraftOR-2606-001', 'SIPAY', 'b', '2990-SI-2606-001', '2026-06-05', 25_000),
      rc('2990-DraftOR-2606-002', 'SOPAY', 'gone', '2990-SO-2606-009', '2026-06-20', 5_000),
    ]);
    expect(out.payments).toEqual({ count: 3, totalSen: 60_000 });
    expect(out.receipts).toEqual({ count: 3, totalSen: 40_000 });
    expect(out.diffSen).toBe(20_000);
    expect(out.missing.map((p) => p.paymentId)).toEqual(['c']);
    expect(out.mismatched).toEqual([{ orNumber: '2990-DraftOR-2606-001', source: 'SIPAY', paymentId: 'b', docNo: '2990-SI-2606-001', paidAt: '2026-06-05', receiptSen: 25_000, paymentSen: 20_000 }]);
    expect(out.orphans).toEqual([{ orNumber: '2990-DraftOR-2606-002', docNo: '2990-SO-2606-009', paidAt: '2026-06-20', amountSen: 5_000 }]);
  });

  test('a clean month is all zeros and empty lists', () => {
    const out = receiptsCheckOf('2026-06', [pay('SOPAY', 'a', 'X', '2026-06-03', 100)], [rc('R1', 'SOPAY', 'a', 'X', '2026-06-03', 100)]);
    expect(out).toMatchObject({ diffSen: 0, missing: [], mismatched: [], orphans: [] });
  });

  test('monthRange spans the month and refuses what is not one', () => {
    expect(monthRange('2026-02')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(monthRange('2028-02')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
    expect(monthRange('2026-12')).toEqual({ from: '2026-12-01', to: '2026-12-31' });
    expect(monthRange('2026-13')).toBeNull();
    expect(monthRange('June')).toBeNull();
    expect(monthRange('')).toBeNull();
  });
});

const world = () => fakeSb({
  mfg_sales_order_payments: [
    { id: 'p1', company_id: CO, so_doc_no: '2990-SO-2606-001', paid_at: '2026-06-03', method: 'cash', amount_sen: 50_000 },
    { id: 'p2', company_id: CO, so_doc_no: '2990-SO-2606-002', paid_at: '2026-06-09', method: 'merchant', amount_sen: 100_000 },
    /* Not money in: a converted row, a mirror (negative), a zero row, and May. */
    { id: 'p3', company_id: CO, so_doc_no: '2990-SO-2606-003', paid_at: '2026-06-10', method: 'converted', amount_sen: 30_000 },
    { id: 'p4', company_id: CO, so_doc_no: '2990-SO-2606-001', paid_at: '2026-06-12', method: 'converted', amount_sen: -20_000 },
    { id: 'p5', company_id: CO, so_doc_no: '2990-SO-2606-004', paid_at: '2026-06-13', method: 'cash', amount_sen: 0 },
    { id: 'p6', company_id: CO, so_doc_no: '2990-SO-2605-001', paid_at: '2026-05-30', method: 'cash', amount_sen: 70_000 },
  ],
  sales_invoice_payments: [
    { id: 's1', company_id: CO, sales_invoice_id: 'si-1', paid_at: '2026-06-15', method: 'transfer', amount_sen: 40_000 },
  ],
  sales_invoices: [{ id: 'si-1', company_id: CO, invoice_number: '2990-SI-2606-007' }],
  acc_official_receipts: [
    { id: 1, company_id: CO, or_number: '2990-COR-2606-001', status: 'FORMAL', payment_source: 'SOPAY', payment_id: 'p1', doc_no: '2990-SO-2606-001', customer_name: 'A', method: 'cash', amount_sen: 50_000, paid_at: '2026-06-03', created_at: '2026-06-03T01:00:00Z' },
    { id: 2, company_id: CO, or_number: '2990-DraftOR-2606-001', status: 'DRAFT', payment_source: 'SOPAY', payment_id: 'p2', doc_no: '2990-SO-2606-002', customer_name: 'B', method: 'merchant', amount_sen: 99_000, paid_at: '2026-06-09', created_at: '2026-06-09T01:00:00Z' },
    { id: 3, company_id: CO, or_number: '2990-DraftOR-2606-002', status: 'DRAFT', payment_source: 'SOPAY', payment_id: 'p-deleted', doc_no: '2990-SO-2606-005', customer_name: 'C', method: 'cash', amount_sen: 1_000, paid_at: '2026-06-20', created_at: '2026-06-20T01:00:00Z' },
    { id: 4, company_id: CO, or_number: '2990-COR-2605-001', status: 'FORMAL', payment_source: 'SOPAY', payment_id: 'p6', doc_no: '2990-SO-2605-001', customer_name: 'D', method: 'cash', amount_sen: 70_000, paid_at: '2026-05-30', created_at: '2026-05-30T01:00:00Z' },
  ],
} as never);

const harness = (sb: ReturnType<typeof world>, perms: string[] = ['scm.payment_voucher.post']) => {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, CO as never);
    c.set('houzsUser' as never, { name: 'Chew', permissions_set: perms } as never);
    await next();
  });
  app.get('/accounting/receipts', receiptsList as never);
  app.get('/accounting/receipts/check', receiptsCheck as never);
  return app;
};

describe('GET /accounting/receipts/check', () => {
  test('one month: SO and SI money in against the receipts by payment day', async () => {
    const res = await harness(world()).request('/accounting/receipts/check?month=2026-06');
    expect(res.status).toBe(200);
    const b = await res.json() as ReturnType<typeof receiptsCheckOf>;
    expect(b.month).toBe('2026-06');
    expect(b.payments).toEqual({ count: 3, totalSen: 190_000 });
    expect(b.receipts).toEqual({ count: 3, totalSen: 150_000 });
    expect(b.diffSen).toBe(40_000);
    expect(b.missing.map((p) => [p.source, p.paymentId, p.docNo, p.amountSen])).toEqual([['SIPAY', 's1', '2990-SI-2606-007', 40_000]]);
    expect(b.mismatched.map((m) => [m.orNumber, m.receiptSen, m.paymentSen])).toEqual([['2990-DraftOR-2606-001', 99_000, 100_000]]);
    expect(b.orphans.map((o) => o.orNumber)).toEqual(['2990-DraftOR-2606-002']);
  });

  test('a month that is not one is refused; no key, no answer', async () => {
    expect((await harness(world()).request('/accounting/receipts/check?month=June')).status).toBe(400);
    expect((await harness(world()).request('/accounting/receipts/check')).status).toBe(400);
    expect((await harness(world(), []).request('/accounting/receipts/check?month=2026-06')).status).toBe(403);
  });
});

describe('GET /accounting/receipts?month=', () => {
  test('every receipt of the month, oldest first; the status filter still applies', async () => {
    const app = harness(world());
    const all = await (await app.request('/accounting/receipts?month=2026-06')).json() as { receipts: Row[] };
    expect(all.receipts.map((r) => r.or_number)).toEqual(['2990-COR-2606-001', '2990-DraftOR-2606-001', '2990-DraftOR-2606-002']);
    const drafts = await (await app.request('/accounting/receipts?month=2026-06&status=DRAFT')).json() as { receipts: Row[] };
    expect(drafts.receipts.map((r) => r.or_number)).toEqual(['2990-DraftOR-2606-001', '2990-DraftOR-2606-002']);
    expect((await app.request('/accounting/receipts?month=nope')).status).toBe(400);
    /* Without a month: the newest first, as before. */
    const newest = await (await app.request('/accounting/receipts')).json() as { receipts: Row[] };
    expect(newest.receipts[0]!.or_number).toBe('2990-DraftOR-2606-002');
  });
});
