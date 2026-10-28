/* /accounting/receipts/backfill — the receipts history is owed. Pinned:
     · the plan names, per payment month, how many receipts the run would
       mint and on which series, from the live maxima; converted and zero
       rows are not counted; a payment with a receipt is not counted;
     · the run creates each missing receipt through the live call (cash
       FORMAL at once on COR, the rest DRAFT), then turns the card payments
       merchant reconciliation has confirmed formal on the payout bank's
       letter, in payment-date order; a second run does nothing;
     · a caller without the key is refused. */

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { receiptsBackfillPlan, receiptsBackfillRun } from '../src/scm/routes/accounting-receipts-backfill';

const CO = 2;

const payments = (): Row[] => [
  { id: 'p-cash', so_doc_no: '2990-SO-2606-001', company_id: CO, paid_at: '2026-06-03', method: 'cash', amount_sen: 50_000, created_by: 'u1', created_at: '2026-06-03T02:00:00Z' },
  { id: 'p-card-1', so_doc_no: '2990-SO-2606-002', company_id: CO, paid_at: '2026-06-05', method: 'merchant', merchant_provider: 'MBB', amount_sen: 100_000, created_by: 'u1', created_at: '2026-06-05T02:00:00Z' },
  { id: 'p-card-2', so_doc_no: '2990-SO-2606-003', company_id: CO, paid_at: '2026-06-09', method: 'installment', merchant_provider: 'PBB', amount_sen: 300_000, created_by: 'u1', created_at: '2026-06-09T02:00:00Z' },
  { id: 'p-transfer', so_doc_no: '2990-SO-2607-001', company_id: CO, paid_at: '2026-07-02', method: 'transfer', amount_sen: 20_000, created_by: 'u1', created_at: '2026-07-02T02:00:00Z' },
  { id: 'p-has', so_doc_no: '2990-SO-2607-002', company_id: CO, paid_at: '2026-07-04', method: 'merchant', merchant_provider: 'MBB', amount_sen: 10_000, created_by: 'u1', created_at: '2026-07-04T02:00:00Z' },
  { id: 'p-conv', so_doc_no: '2990-SO-2607-003', company_id: CO, paid_at: '2026-07-05', method: 'converted', amount_sen: 10_000, created_by: 'u1', created_at: '2026-07-05T02:00:00Z' },
  { id: 'p-zero', so_doc_no: '2990-SO-2607-004', company_id: CO, paid_at: '2026-07-06', method: 'cash', amount_sen: 0, created_by: 'u1', created_at: '2026-07-06T02:00:00Z' },
];

const world = (over: Record<string, Row[]> = {}) => fakeSb(
  {
    mfg_sales_order_payments: payments(),
    acc_official_receipts: [
      { id: 7, company_id: CO, or_number: '2990-DraftOR-2607-001', status: 'DRAFT', payment_source: 'SOPAY', payment_id: 'p-has', amount_sen: 10_000, paid_at: '2026-07-04' },
    ],
    acc_settlement_matches: [
      { id: 1, company_id: CO, settlement_row_id: 11, payment_source: 'SOPAY', payment_id: 'p-card-1', doc_no: '2990-SO-2606-002', amount_sen: 100_000 },
      { id: 2, company_id: CO, settlement_row_id: 12, payment_source: 'SOPAY', payment_id: 'p-card-2', doc_no: '2990-SO-2606-003', amount_sen: 300_000 },
    ],
    acc_settlement_rows: [
      { id: 11, company_id: CO, acquirer_code: 'MBB', confirmed_at: '2026-06-08T00:00:00Z' },
      { id: 12, company_id: CO, acquirer_code: 'PBB', confirmed_at: null },
    ],
    acc_acquirers: [
      { company_id: CO, code: 'MBB', bank_account_code: '310-0010' },
      { company_id: CO, code: 'PBB', bank_account_code: '310-0020' },
    ],
    acc_bank_letters: [{ company_id: CO, account_code: '310-0010', letter: 'M' }, { company_id: CO, account_code: '310-0020', letter: 'H' }],
    acc_numbering: [],
    acc_account_roles: [{ company_id: CO, role: 'CASH', account_code: '320-0000' }],
    accounts: [],
    companies: [{ id: CO, code: '2990' }],
    sales_invoice_payments: [],
    ...over,
  },
  {},
  [
    { table: 'acc_official_receipts', column: 'or_number', name: 'acc_official_receipts_or_number_key' },
    { table: 'acc_official_receipts', column: 'payment_id', name: 'acc_official_receipts_payment_once' },
  ],
  ['acc_official_receipts', 'acc_settlement_matches', 'acc_settlement_rows'],
);

const harness = (sb: ReturnType<typeof world>, perms: string[] = ['scm.payment_voucher.post']) => {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, CO as never);
    c.set('houzsUser' as never, { name: 'Chew', permissions_set: perms } as never);
    await next();
  });
  app.get('/accounting/receipts/backfill', receiptsBackfillPlan as never);
  app.post('/accounting/receipts/backfill', receiptsBackfillRun as never);
  return app;
};

type Plan = { total: number; months: Array<{ ym: string; payments: number; cash: number; confirmedCards: number; unlettered: number; series: Array<{ series: string; count: number; from: string; to: string }> }> };

describe('the plan', () => {
  test('names the receipts owed per month and the numbers the run would take', async () => {
    const app = harness(world());
    const res = await app.request('/accounting/receipts/backfill');
    expect(res.status).toBe(200);
    const plan = await res.json() as Plan;
    expect(plan.total).toBe(4);
    expect(plan.months.map((m) => [m.ym, m.payments, m.cash, m.confirmedCards, m.unlettered])).toEqual([['2606', 3, 1, 1, 0], ['2607', 1, 0, 0, 0]]);
    const june = plan.months[0]!.series;
    expect(june.find((s) => s.series === '2990-DraftOR-2606')).toEqual({ series: '2990-DraftOR-2606', count: 3, from: '2990-DraftOR-2606-001', to: '2990-DraftOR-2606-003' });
    expect(june.find((s) => s.series === '2990-COR-2606')).toEqual({ series: '2990-COR-2606', count: 1, from: '2990-COR-2606-001', to: '2990-COR-2606-001' });
    expect(june.find((s) => s.series === '2990-MOR-2606')).toEqual({ series: '2990-MOR-2606', count: 1, from: '2990-MOR-2606-001', to: '2990-MOR-2606-001' });
    /* July's draft series already holds 001 — the run continues from 002. */
    expect(plan.months[1]!.series).toEqual([{ series: '2990-DraftOR-2607', count: 1, from: '2990-DraftOR-2607-002', to: '2990-DraftOR-2607-002' }]);
  });

  test('a caller without the key is refused', async () => {
    const app = harness(world(), []);
    expect((await app.request('/accounting/receipts/backfill')).status).toBe(403);
    expect((await app.request('/accounting/receipts/backfill', { method: 'POST' })).status).toBe(403);
  });
});

describe('the run', () => {
  /* One call for 179 outran the client (owner 2026-09-16): the run is batched,
     oldest paid first, and each call says what is left. */
  test('?limit= takes a batch of the oldest and reports the rest; the next call continues in series order', async () => {
    const sb = world();
    const app = harness(sb);
    const first = await (await app.request('/accounting/receipts/backfill?limit=2', { method: 'POST' })).json() as { created: number; formalised: number; remaining: number };
    expect(first).toMatchObject({ created: 2, formalised: 1, remaining: 2 });
    const rows = () => sb.tables.acc_official_receipts as Row[];
    expect(rows().map((r) => String(r.payment_id)).filter((id) => id !== 'p-has').sort()).toEqual(['p-card-1', 'p-cash']);
    const second = await (await app.request('/accounting/receipts/backfill?limit=2', { method: 'POST' })).json() as { created: number; remaining: number };
    expect(second).toMatchObject({ created: 2, remaining: 0 });
    expect(rows().find((r) => r.payment_id === 'p-transfer')).toMatchObject({ or_number: '2990-DraftOR-2607-002' });
  });

  test('creates each missing receipt through the live path, formalises the confirmed card payment, and a second run does nothing', async () => {
    const sb = world();
    const app = harness(sb);
    const res = await app.request('/accounting/receipts/backfill', { method: 'POST' });
    expect(res.status).toBe(200);
    const out = await res.json() as { created: number; formalised: number; failed: unknown[]; remaining: number };
    expect(out).toMatchObject({ created: 4, formalised: 1, failed: [], remaining: 0 });
    const rows = sb.tables.acc_official_receipts as Row[];
    const byPayment = new Map(rows.map((r) => [String(r.payment_id), r]));
    expect(byPayment.get('p-cash')).toMatchObject({ status: 'FORMAL', or_number: '2990-COR-2606-001', doc_no: '2990-SO-2606-001', amount_sen: 50_000, paid_at: '2026-06-03' });
    expect(byPayment.get('p-card-1')).toMatchObject({ status: 'FORMAL', or_number: '2990-MOR-2606-001', channel_account_code: '310-0010' });
    expect(byPayment.get('p-card-2')).toMatchObject({ status: 'DRAFT' });
    expect(String(byPayment.get('p-card-2')!.or_number)).toMatch(/^2990-DraftOR-2606-00[1-3]$/);
    expect(byPayment.get('p-transfer')).toMatchObject({ status: 'DRAFT', or_number: '2990-DraftOR-2607-002' });
    expect(byPayment.has('p-conv')).toBe(false);
    expect(byPayment.has('p-zero')).toBe(false);
    expect(byPayment.get('p-has')).toMatchObject({ or_number: '2990-DraftOR-2607-001' });

    const again = await (await app.request('/accounting/receipts/backfill', { method: 'POST' })).json() as { created: number; formalised: number; remaining: number };
    expect(again).toMatchObject({ created: 0, formalised: 0, remaining: 0 });
    expect((sb.tables.acc_official_receipts as Row[]).length).toBe(5);
    const plan = await (await app.request('/accounting/receipts/backfill')).json() as Plan;
    expect(plan.total).toBe(0);
  });
});
