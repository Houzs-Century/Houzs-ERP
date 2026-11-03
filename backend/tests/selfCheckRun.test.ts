/* Books › Self-check run and summed (the owner's Claude Design, batch 6
   c2/c3). Pinned:
     • the summary counts the checks that name something to look at — a read
       that failed counts, never reads clean — and words the items To do
       lists ("<doc> journal RM x short", "N payments not in the books", …);
     • a drift document carries who it is with, its date, its active entry
       and the id its page opens by; an unbooked payment its customer and
       salesperson;
     • POST /accounting/self-check/run returns the reads and leaves one row in
       acc_selfcheck_runs, the newest of which To do reads; it needs the
       posting right.
   Real handler, fake PostgREST (fakeSb). */

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { selfCheckSummary, SELF_CHECK_COUNT } from '../src/acc/self-check';
import type { ControlCheckResult } from '../src/acc/control-check';
import { latestSelfCheck, selfCheckRunHandler } from '../src/scm/routes/accounting-self-check';

const CO = 2;

const clean: ControlCheckResult = {
  checks: [
    { role: 'AR', accountCode: '300-0000', glBalanceSen: 100, driftDocs: [], foreignLines: [], ok: true },
    { role: 'AR_OTHER', accountCode: '305-0000', glBalanceSen: 0, driftDocs: [], foreignLines: [], ok: true },
    { role: 'AP', accountCode: '400-0000', glBalanceSen: -100, driftDocs: [], foreignLines: [], ok: true },
    { role: 'AP_OTHER', accountCode: '405-0000', glBalanceSen: 0, driftDocs: [], foreignLines: [], ok: true },
  ],
  payments: { since: '2026-06-01', rows: [], totalSen: 0, ok: true },
  paymentDrift: { rows: [], scanned: 10, ok: true },
};

describe('selfCheckSummary', () => {
  test('a clean company: eight checks, nothing to look at', () => {
    expect(selfCheckSummary({ control: { ok: true, value: clean }, cancelled: { ok: true, count: 0 }, receipts: { ok: true, count: 0 } }))
      .toEqual({ checks: SELF_CHECK_COUNT, findings: 0, items: [] });
  });

  test('each check that names something counts once, with its items', () => {
    const control: ControlCheckResult = {
      ...clean,
      checks: [
        { ...clean.checks[0]!, ok: false, driftDocs: [
          { docNo: 'HC-SI-2610-0088', docTotalSen: 245_000, jeTotalSen: 233_000, diffSen: -12_000, note: 'journal total differs from document total', party: 'Lim Kah Hoe', date: '2026-10-24', jeNo: 'HC-JE-2610-0851', docKind: 'SI', docId: 'si-88' },
          { docNo: 'HC-SI-2610-0099', docTotalSen: 0, jeTotalSen: 5_000, diffSen: 5_000, note: 'journal active but document not found', party: null, date: null, jeNo: 'HC-JE-2610-0900', docKind: null, docId: null },
        ], foreignLines: [{ jeNo: 'HC-JE-2610-0100', sourceType: 'MANUAL', debitSen: 500, creditSen: 0 }] } as ControlCheckResult['checks'][number],
        clean.checks[1]!,
        clean.checks[2]!,
        { role: 'AP_OTHER', accountCode: '405-0000', error: 'timeout' },
      ],
      payments: { since: '2026-06-01', rows: [{ source: 'SOPAY', id: 'p1', docNo: 'SO-1', paidOn: '2026-10-01', amountSen: 100, method: 'cash', customer: null, salesperson: null }], totalSen: 100, ok: false },
    };
    const s = selfCheckSummary({ control: { ok: true, value: control }, cancelled: { ok: true, count: 1 }, receipts: { ok: false, reason: 'boom' } });
    expect(s.findings).toBe(5);
    expect(s.items).toEqual([
      'HC-SI-2610-0088 journal RM 120.00 short',
      'HC-SI-2610-0099 journal RM 50.00 over',
      '1 line from other sources on 300-0000',
      'Other creditors not checked',
      '1 payment not in the books',
      '1 cancelled order holding money',
      'Official receipts not checked',
    ]);
  });

  test('a control check that could not run at all is six checks to look at', () => {
    const s = selfCheckSummary({ control: { ok: false, reason: 'down' }, cancelled: { ok: true, count: 0 }, receipts: { ok: true, count: 2 } });
    expect(s.findings).toBe(7);
    expect(s.items).toEqual(['Control check not run (down)', '2 payments without an official receipt']);
  });
});

const world = () => fakeSb({
  accounts: [
    { company_id: CO, account_code: '300-0000', account_name: 'Trade debtors', account_type: 'ASSET', is_active: true },
    { company_id: CO, account_code: '400-0000', account_name: 'Trade creditors', account_type: 'LIABILITY', is_active: true },
  ],
  acc_account_roles: [],
  journal_entries: [
    { id: 'je-1', company_id: CO, je_no: '2990-JE-2610-0851', source_type: 'SI', source_doc_no: '2990-SI-2610-0088', entry_date: '2026-10-24', posted: true, reversed: false, total_debit_sen: 233_000, total_credit_sen: 233_000 },
    { id: 'je-2', company_id: CO, je_no: '2990-JE-2606-0001', source_type: 'SOPAY', source_doc_no: 'old-pay', entry_date: '2026-06-01', posted: true, reversed: false, total_debit_sen: 100, total_credit_sen: 100 },
  ],
  journal_entry_lines: [],
  v_gl_entries: [],
  sales_invoices: [{ id: 'si-88', company_id: CO, invoice_number: '2990-SI-2610-0088', total_sen: 245_000, status: 'SENT', migrated_no_stock: false, debtor_name: 'Lim Kah Hoe', invoice_date: '2026-10-24' }],
  purchase_invoices: [],
  ap_invoices: [],
  suppliers: [],
  mfg_sales_order_payments: [
    { id: 'old-pay', company_id: CO, so_doc_no: '2990-SO-2606-001', paid_at: '2026-06-01', amount_sen: 100, method: 'cash' },
    { id: 'p-new', company_id: CO, so_doc_no: '2990-SO-2610-0441', paid_at: '2026-10-27', amount_sen: 68_000, method: 'online' },
  ],
  sales_invoice_payments: [],
  mfg_sales_orders: [{ company_id: CO, doc_no: '2990-SO-2610-0441', debtor_name: 'Wong Kar Mun', salesperson_id: 'staff-9', agent: null, status: 'CONFIRMED' }],
  staff: [{ id: 'staff-9', name: 'Jason' }],
  acc_official_receipts: [{ company_id: CO, payment_source: 'SOPAY', payment_id: 'old-pay', status: 'FORMAL', or_number: '2990COR-2606-001' }, { company_id: CO, payment_source: 'SOPAY', payment_id: 'p-new', status: 'DRAFT', or_number: '2990DraftOR-2610-001' }],
  acc_settlement_matches: [],
  acc_settlement_rows: [],
  acc_acquirers: [],
  acc_bank_letters: [],
  acc_numbering: [],
  companies: [{ id: CO, code: '2990' }],
  acc_selfcheck_runs: [],
});

function harness(perms: string[] = ['scm.payment_voucher.post']) {
  const sb = world();
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, CO as never);
    c.set('houzsUser' as never, { name: 'Mei Ling', permissions_set: perms } as never);
    c.set('allowedCompanyIds' as never, [CO] as never);
    await next();
  });
  app.post('/accounting/self-check/run', selfCheckRunHandler as never);
  return { app, sb };
}

describe('POST /accounting/self-check/run', () => {
  test('returns the reads with who and when, and leaves one row To do reads', async () => {
    const { app, sb } = harness();
    const res = await app.request('/accounting/self-check/run', { method: 'POST' });
    expect(res.status, await res.clone().text()).toBe(200);
    const body = await res.json() as {
      control: ControlCheckResult; summary: { findings: number; items: string[] }; ranAt: string;
      cancelled: { orders: unknown[] }; receipts: { total: number };
    };
    const ar = body.control.checks.find((c) => c.role === 'AR')!;
    if ('error' in ar) throw new Error(ar.error);
    expect(ar.driftDocs).toEqual([{
      docNo: '2990-SI-2610-0088', docTotalSen: 245_000, jeTotalSen: 233_000, diffSen: -12_000, note: 'journal total differs from document total',
      party: 'Lim Kah Hoe', date: '2026-10-24', jeNo: '2990-JE-2610-0851', docKind: 'SI', docId: 'si-88',
    }]);
    expect(body.control.payments.rows).toEqual([expect.objectContaining({ id: 'p-new', customer: 'Wong Kar Mun', salesperson: 'Jason' })]);
    expect(body.cancelled.orders).toEqual([]);
    expect(body.receipts.total).toBe(0);
    expect(body.summary.items).toEqual(['2990-SI-2610-0088 journal RM 120.00 short', '1 payment not in the books']);
    expect(sb.tables.acc_selfcheck_runs).toHaveLength(1);
    expect(sb.tables.acc_selfcheck_runs[0]).toMatchObject({ company_id: CO, trigger: 'manual', ran_by: 'Mei Ling', checks: 8, findings: 2 });
    const latest = await latestSelfCheck(sb, CO);
    expect(latest).toEqual({ ok: true, run: { ranAt: body.ranAt, findings: 2, checks: 8, items: body.summary.items } });
  });

  test('needs the posting right, and writes nothing without it', async () => {
    const { app, sb } = harness([]);
    const res = await app.request('/accounting/self-check/run', { method: 'POST' });
    expect(res.status).toBe(403);
    expect(sb.tables.acc_selfcheck_runs).toHaveLength(0);
  });

  test('a company that never ran has no newest run', async () => {
    expect(await latestSelfCheck(world(), CO)).toEqual({ ok: true, run: null });
  });
});
