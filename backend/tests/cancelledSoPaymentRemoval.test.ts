/* Finance takes a payment off a CANCELLED order (owner 2026-09-29, "1 a, 2 a,
   做"). The case that asked for it: one PBB swipe (RM 1,433, approval 855755)
   keyed on the real order 2990-SO-2607-019 AND on its duplicate
   2990-SO-2608-028, which was later cancelled. The copy on the cancelled order
   books money that never arrived — RM 1,433 in the PBB clearing account and a
   credit on the customer — and until now nobody could remove it: the payments
   card is shut on a cancelled order, and its two exits (refund, convert) both
   treat the money as real. Pinned:
     • only Finance (the correction right) may remove it, with a reason — a
       payment keyed TODAY on a cancelled order is not a same-day fix for
       anyone else;
     • its entry is reversed on the ORIGINAL entry's own day (2a), not today,
       so July reads as if it had never been keyed; its DRAFT receipt goes with
       it; the audit row says so;
     • not while a refund or a conversion has already drawn on the order's
       money, and not when the payment is reconciled (the standing gate);
     • every other delete is unchanged: a live order's contra is dated today
       and its draft receipt stays.
   Real handlers, fake PostgREST (fakeSb). */

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { deleteSoPaymentHandler } from '../src/scm/routes/mfg-sales-orders';
import { cancelledWithMoneyHandler } from '../src/scm/routes/so-money-routes';
import { todayMyt } from '../src/scm/lib/my-time';

const CO = 2;
const DUP = '2990-SO-2608-028';
const REAL = '2990-SO-2607-019';
const LIVE = '2990-SO-2609-070';
const MOVED = '2990-SO-2608-040';
const NEWSO = '2990-SO-2609-071';
const REASON = 'Same PBB swipe 855755 as 2990-SO-2607-019, keyed twice';

/* permissions_set is a Set on the real caller (pmsAccess reads it with .has). */
const FINANCE = { id: 7, name: 'Carrie Ong', position_name: 'Finance Executive', department_name: 'Finance', permissions_set: new Set(['scm.so_payment.amend']) };
const STORE = { id: 11, name: 'Store Keeper', position_name: 'Storekeeper', department_name: 'Warehouse', permissions_set: new Set(['scm.sales.orders']) };

const CHART: Row[] = [
  { company_id: CO, account_code: '300-0000', account_name: 'ACCOUNT RECEIVEABLE', account_type: 'ASSET', parent_code: null, is_active: true, acc_money: false },
  { company_id: CO, account_code: '310-0020', account_name: 'CASH AT BANK - HLB', account_type: 'ASSET', parent_code: null, is_active: true, acc_money: true },
  { company_id: CO, account_code: '326-0010', account_name: 'CARD MACHINE CLEARING — PBB', account_type: 'ASSET', parent_code: null, is_active: true, acc_money: false },
];

const order = (doc_no: string, status: string, over: Row = {}): Row => ({
  doc_no, company_id: CO, status, debtor_name: 'Larding Chen', debtor_code: null, phone: '+60122893993', customer_id: 'cust-lc',
  salesperson_id: 'staff-1', access_staff_ids: null, open_to_all: true, local_total_sen: 286_500, updated_at: '2026-08-25T09:16:15Z', ...over,
});
const pay = (id: string, so: string, paid_at: string, amount_sen: number, created_at: string, over: Row = {}): Row => ({
  id, so_doc_no: so, paid_at, method: 'merchant', merchant_provider: 'PBB', installment_months: null, online_type: null, approval_code: '855755',
  amount_sen, account_sheet: 'PBB', slip_key: null, collected_by: 'staff-1', note: null, company_id: CO, version: 1,
  created_at, created_by: 'u-scarlett', is_deposit: false, converted_from_so_doc_no: null, ...over,
});
const je = (id: string, jeNo: string, sourceType: string, paymentId: string, date: string, amount: number): Row => ({
  id, je_no: jeNo, company_id: CO, source_type: sourceType, source_doc_no: paymentId, reversed: false, reversed_by_je: null,
  entry_date: date, posted: true, narration: `Payment merchant on ${paymentId}`, total_debit_sen: amount, total_credit_sen: amount,
});
const cardLines = (jeId: string, amount: number): Row[] => [
  { journal_entry_id: jeId, line_no: 1, account_code: '326-0010', debit_sen: amount, credit_sen: 0, party_type: null, party_code: null, party_name: null, notes: null, company_id: CO },
  { journal_entry_id: jeId, line_no: 2, account_code: '300-0000', debit_sen: 0, credit_sen: amount, party_type: 'customer', party_code: 'cust-lc', party_name: 'Larding Chen', notes: null, company_id: CO },
];
const receipt = (orNumber: string, status: string, paymentId: string, docNo: string): Row => ({
  company_id: CO, or_number: orNumber, status, payment_source: 'SOPAY', payment_id: paymentId, doc_no: docNo,
  customer_name: 'Larding Chen', method: 'merchant', amount_sen: 143_300, paid_at: '2026-07-22',
});

function harness(who: Row, tables: Record<string, Row[]> = {}) {
  const now = new Date().toISOString();
  const sb = fakeSb({
    accounts: CHART.map((r) => ({ ...r })),
    acc_account_roles: [],
    acc_bank_month_locks: [],
    acc_bank_statement_matches: [],
    acc_company_settings: [],
    acc_credit_notes: [],
    acc_credit_note_lines: [],
    acc_deposit_invoices: [],
    acc_numbering: [],
    acc_official_receipts: [
      receipt('2990-DraftOR-2607-025', 'DRAFT', 'dup', DUP),
      receipt('2990-HOR-2607-015', 'FORMAL', 'real', REAL),
      receipt('2990-DraftOR-2609-090', 'DRAFT', 'live1', LIVE),
    ],
    acc_settlement_matches: [],
    acc_settlement_rows: [],
    companies: [{ id: CO, code: '2990' }],
    customer_credits: [],
    entity_audit_log: [],
    journal_entries: [
      je('je-dup', '2990-JE-2607-0063', 'SOPAY', 'dup', '2026-07-22', 143_300),
      je('je-real', '2990-JE-2607-0066', 'SOPAY', 'real', '2026-07-24', 143_300),
      je('je-live1', '2990-JE-2608-0010', 'SOPAY', 'live1', '2026-08-05', 50_000),
      je('je-mv', '2990-JE-2608-0020', 'SOPAY', 'mv', '2026-08-10', 50_000),
      je('je-conv', '2990-JE-2609-0030', 'SOCONV', 'conv', '2026-09-15', 30_000),
    ],
    journal_entry_lines: [...cardLines('je-dup', 143_300), ...cardLines('je-real', 143_300), ...cardLines('je-live1', 50_000), ...cardLines('je-mv', 50_000)],
    mfg_sales_orders: [
      order(DUP, 'CANCELLED'),
      order(REAL, 'DELIVERED', { updated_at: '2026-09-05T02:58:01Z' }),
      order(LIVE, 'CONFIRMED', { debtor_name: 'Tan Mei Ling', customer_id: 'cust-tml', phone: '0177' }),
      order(MOVED, 'CANCELLED', { debtor_name: 'Yap Kah Heng', customer_id: 'cust-ykh', phone: '0166' }),
      order(NEWSO, 'CONFIRMED', { debtor_name: 'Yap Kah Heng', customer_id: 'cust-ykh', phone: '0166' }),
    ],
    mfg_sales_order_payments: [
      /* The copy: the true swipe day, keyed a month later on the duplicate order. */
      pay('dup', DUP, '2026-07-22', 143_300, '2026-08-22T03:01:05Z'),
      pay('real', REAL, '2026-07-24', 143_300, '2026-07-24T05:53:09Z', { is_deposit: true }),
      /* Keyed today on the cancelled order — the same-day window would open it for anyone. */
      pay('dup-today', DUP, '2026-07-22', 10_000, now, { approval_code: '855756' }),
      pay('live1', LIVE, '2026-08-05', 50_000, now, { approval_code: '111222' }),
      pay('mv', MOVED, '2026-08-10', 50_000, '2026-08-10T03:00:00Z', { approval_code: '333444' }),
      pay('conv', NEWSO, '2026-08-10', 30_000, '2026-09-15T03:00:00Z', { method: 'converted', merchant_provider: null, approval_code: null, converted_from_so_doc_no: MOVED }),
    ],
    mfg_so_audit_log: [],
    payment_voucher_lines: [],
    payment_vouchers: [],
    sales_invoices: [],
    sales_invoice_payments: [],
    staff: [],
    ...tables,
  });
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, CO as never);
    c.set('user' as never, { id: 'u-actor', user_metadata: { name: who.name } } as never);
    c.set('houzsUser' as never, who as never);
    c.set('allowedCompanyIds' as never, [CO] as never);
    c.set('companies' as never, [{ id: CO, code: '2990' }] as never);
    c.set('companyCode' as never, '2990' as never);
    c.set('env' as never, {} as never);
    await next();
  });
  app.get('/mfg-sales-orders/cancelled-with-money', cancelledWithMoneyHandler as never);
  app.delete('/mfg-sales-orders/:docNo/payments/:id', deleteSoPaymentHandler as never);
  return { app, sb };
}

const remove = (app: Hono, docNo: string, id: string, reason?: string) =>
  app.request(`/mfg-sales-orders/${docNo}/payments/${id}?version=1${reason ? `&reason=${encodeURIComponent(reason)}` : ''}`, { method: 'DELETE' });

const errorOf = async (res: Response) => ((await res.json()) as { error: string; message?: string });

describe('Finance removes a payment from a cancelled order', () => {
  test('the row goes, its entry is reversed on its OWN day, its draft receipt goes, and the audit row says why', async () => {
    const { app, sb } = harness(FINANCE);
    const res = await remove(app, DUP, 'dup', REASON);
    expect(res.status, await res.clone().text()).toBe(200);

    expect(sb.tables.mfg_sales_order_payments.some((p) => p.id === 'dup')).toBe(false);
    expect(sb.tables.journal_entries.find((j) => j.je_no === '2990-JE-2607-0063')!.reversed).toBe(true);
    const contra = sb.tables.journal_entries.find((j) => j.source_type === 'SOPAY_REVERSAL' && j.source_doc_no === 'dup')!;
    expect(contra).toBeTruthy();
    /* 2a: dated where the mistake sits, and numbered in that month's series. */
    expect(contra.entry_date).toBe('2026-07-22');
    expect(String(contra.je_no)).toMatch(/^2990-JE-2607-/);
    const lines = sb.tables.journal_entry_lines.filter((l) => l.journal_entry_id === contra.id);
    expect(lines.map((l) => [l.account_code, l.debit_sen, l.credit_sen])).toEqual([['326-0010', 0, 143_300], ['300-0000', 143_300, 0]]);

    /* The draft goes; the real order's FORMAL receipt, and another order's draft, stay. */
    expect(sb.tables.acc_official_receipts.map((r) => r.or_number).sort()).toEqual(['2990-DraftOR-2609-090', '2990-HOR-2607-015']);

    const audit = sb.tables.mfg_so_audit_log.find((a) => a.action === 'DELETE_PAYMENT')!;
    expect(audit).toMatchObject({ so_doc_no: DUP, source: 'amend', note: REASON });
    expect(audit.field_changes).toEqual(expect.arrayContaining([
      { field: 'ledger', from: '2990-JE-2607-0063', to: null },
      { field: 'draftReceipt', from: '2990-DraftOR-2607-025', to: null },
    ]));

    /* The real order is untouched. */
    expect(sb.tables.mfg_sales_order_payments.some((p) => p.id === 'real')).toBe(true);
    expect(sb.tables.journal_entries.find((j) => j.je_no === '2990-JE-2607-0066')!.reversed).toBe(false);
  });

  test('Finance\'s list of cancelled orders holding money lets the order go once its money is gone', async () => {
    const { app } = harness(FINANCE);
    const before = await (await app.request('/mfg-sales-orders/cancelled-with-money')).json() as { orders: Array<{ docNo: string; remainingSen: number }> };
    expect(before.orders.find((o) => o.docNo === DUP)?.remainingSen).toBe(143_300);
    expect((await remove(app, DUP, 'dup', REASON)).status).toBe(200);
    const after = await (await app.request('/mfg-sales-orders/cancelled-with-money')).json() as { orders: Array<{ docNo: string }> };
    expect(after.orders.map((o) => o.docNo)).not.toContain(DUP);
  });

  test('nobody else may — not even a payment keyed today, which the same-day window would have opened', async () => {
    const { app, sb } = harness(STORE);
    for (const id of ['dup', 'dup-today']) {
      const res = await remove(app, DUP, id);
      expect(res.status).toBe(403);
      const body = await errorOf(res);
      expect(body.error).toBe('cancelled_payment_finance_only');
      expect(String(body.message).length).toBeLessThan(200);
    }
    expect(sb.tables.mfg_sales_order_payments.filter((p) => p.so_doc_no === DUP).map((p) => p.id).sort()).toEqual(['dup', 'dup-today']);
    expect(sb.tables.journal_entries.find((j) => j.je_no === '2990-JE-2607-0063')!.reversed).toBe(false);
    expect(sb.tables.acc_official_receipts).toHaveLength(3);
  });

  test('Finance must say why', async () => {
    const { app, sb } = harness(FINANCE);
    const res = await remove(app, DUP, 'dup');
    expect(res.status).toBe(400);
    expect((await errorOf(res)).error).toBe('reason_required');
    expect(sb.tables.mfg_sales_order_payments.some((p) => p.id === 'dup')).toBe(true);
  });

  test('not while a conversion has drawn on the order\'s money — undo that first', async () => {
    const { app, sb } = harness(FINANCE);
    const res = await remove(app, MOVED, 'mv', 'test');
    expect(res.status).toBe(409);
    const body = await errorOf(res);
    expect(body.error).toBe('cancelled_money_taken');
    expect(body.message).toContain('RM 300.00');
    expect(String(body.message).length).toBeLessThan(200);
    expect(sb.tables.mfg_sales_order_payments.some((p) => p.id === 'mv')).toBe(true);
    expect(sb.tables.journal_entries.find((j) => j.je_no === '2990-JE-2608-0020')!.reversed).toBe(false);
  });

  test('not when the payment is already reconciled — the standing gate still answers', async () => {
    const { app, sb } = harness(FINANCE, {
      acc_settlement_matches: [{ company_id: CO, payment_source: 'SOPAY', payment_id: 'dup', settlement_row_id: 900, amount_sen: 143_300, created_at: '2026-09-11T12:00:00Z' }],
      acc_settlement_rows: [{ id: 900, company_id: CO, acquirer_code: 'PBB', confirmed_at: '2026-09-11T12:09:21Z', posted_je_no: '2990-JE-2607-0125' }],
    });
    const res = await remove(app, DUP, 'dup', REASON);
    expect(res.status).toBe(409);
    expect(sb.tables.mfg_sales_order_payments.some((p) => p.id === 'dup')).toBe(true);
    expect(sb.tables.acc_official_receipts).toHaveLength(3);
  });
});

describe('every other delete is unchanged', () => {
  test('a live order: the contra is dated today and the draft receipt stays', async () => {
    const { app, sb } = harness(FINANCE);
    const res = await remove(app, LIVE, 'live1', 'Keyed on the wrong order');
    expect(res.status, await res.clone().text()).toBe(200);
    const contra = sb.tables.journal_entries.find((j) => j.source_type === 'SOPAY_REVERSAL' && j.source_doc_no === 'live1')!;
    expect(contra.entry_date).toBe(todayMyt());
    expect(sb.tables.acc_official_receipts.some((r) => r.or_number === '2990-DraftOR-2609-090')).toBe(true);
    const audit = sb.tables.mfg_so_audit_log.find((a) => a.action === 'DELETE_PAYMENT')!;
    expect((audit.field_changes as Array<{ field: string }>).some((f) => f.field === 'draftReceipt')).toBe(false);
  });
});
