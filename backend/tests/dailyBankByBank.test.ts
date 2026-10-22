/* GET /accounting/daily-bank, by bank (owner 2026-09-29, his "BANK BALANCE
   AVAILABLE" sample: 1 By bank · 2 pending = checked, not yet approved ·
   3 show what was paid · 4 keep the totals; then settlement in transit 放在
   相对应的银行 and 1 要 the line with it added). Pinned on the real handler
   over fake PostgREST:
     • the day's money lines carry WHO — the entry's party, read off its own
       lines — and WHICH document: a customer payment prints its official
       receipt, else its order, never its internal id; a voucher its number;
     • the pending vouchers are the checked, not yet approved ones as of the
       board day, each on the account it pays from, with payee, number and note;
     • each transit account sits under the bank its acquirer pays into
       (Settlement Setup), 未标银行 in the bottom list;
     • another company's receipt, order or party never reaches this board.
   The arithmetic itself is pinned in backend/src/acc/daily-bank.test.ts. */

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { dailyBankHandler } from '../src/scm/routes/accounting';

const CO = 2;
const DAY = '2026-09-29';
let lineId = 0;
const gl = (jeNo: string, date: string, source: string, doc: string | null, code: string, dr: number, cr: number, extra: Row = {}): Row => ({
  line_id: ++lineId, company_id: CO, je_no: jeNo, entry_date: date, source_type: source, source_doc_no: doc,
  line_no: lineId, account_code: code, account_name: code, account_type: code.startsWith('3') ? 'ASSET' : 'EXPENSE',
  debit_sen: dr, credit_sen: cr, party_type: null, party_code: null, party_name: null, notes: null,
  posted: true, posted_at: `${date}T10:00:00Z`, reversed: false, reversed_by_je: null, ...extra,
});

const LEDGER: Row[] = [
  /* HLBB brought forward: an earlier customer payment. */
  gl('JE-1', '2026-09-28', 'SOPAY', 'pay-old', '310-0020', 100_000, 0),
  gl('JE-1', '2026-09-28', 'SOPAY', 'pay-old', '300-0000', 0, 100_000, { party_name: 'OLD CUSTOMER' }),
  /* Today: a customer payment with its official receipt … */
  gl('JE-2', DAY, 'SOPAY', 'pay-1', '310-0020', 285_000, 0, { notes: 'Payment received (transfer) — SO-1' }),
  gl('JE-2', DAY, 'SOPAY', 'pay-1', '300-0000', 0, 285_000, { party_name: 'Hookka' }),
  /* … one whose receipt row is not there yet, which prints its order … */
  gl('JE-3', DAY, 'SOPAY', 'pay-2', '310-0020', 50_000, 0),
  gl('JE-3', DAY, 'SOPAY', 'pay-2', '300-0000', 0, 50_000, { party_name: 'LIM' }),
  /* … and a voucher paid out. */
  gl('JE-4', DAY, 'PV', 'PV-0432', '310-0020', 0, 44_264, { notes: 'Payment to Tan Yong Hong — PV-0432' }),
  gl('JE-4', DAY, 'PV', 'PV-0432', '900-X001', 44_264, 0, { party_name: 'Tan Yong Hong' }),
  /* Maybank brought forward. */
  gl('JE-5', '2026-09-01', 'RCT', 'OR-1', '310-0010', 50_000, 0),
  /* Card money swiped, not yet remitted. */
  gl('JE-6', '2026-09-20', 'SOPAY', 'pay-3', '326-0010', 375_035, 0),
  gl('JE-7', '2026-09-25', 'SOPAY', 'pay-4', '326-0000', 3_365, 0),
  /* Another company's lines under the same journal number never lend a party. */
  { ...gl('JE-2', DAY, 'SOPAY', 'pay-1', '300-0000', 0, 1, { party_name: 'SOMEONE ELSE' }), company_id: 9 },
];

const voucher = (over: Row): Row => ({
  company_id: CO, status: 'DRAFT', currency: 'MYR', exchange_rate: 1, purpose: 'OTHER', notes: null,
  submitted_at: '2026-09-18T01:00:00Z', checked_at: '2026-09-18T02:00:00Z', approved_at: null, ...over,
});

function harness() {
  const sb = fakeSb({
    v_gl_entries: LEDGER.map((r) => ({ ...r })),
    accounts: [
      { company_id: CO, account_code: '310-0010', account_name: 'CASH AT BANK - MAYBANK', account_type: 'ASSET', acc_money: true, is_active: true },
      { company_id: CO, account_code: '310-0020', account_name: 'CASH AT BANK - HLBB', account_type: 'ASSET', acc_money: true, is_active: true },
      { company_id: CO, account_code: '326-0000', account_name: 'CARD MACHINE CLEARING (EDC)', account_type: 'ASSET', acc_money: false, is_active: true },
      { company_id: CO, account_code: '326-0010', account_name: 'CARD MACHINE CLEARING — PBB', account_type: 'ASSET', acc_money: false, is_active: true },
      { company_id: CO, account_code: '326-0020', account_name: 'CARD MACHINE CLEARING — MBB', account_type: 'ASSET', acc_money: false, is_active: true },
    ],
    acc_acquirers: [
      { company_id: CO, code: 'MBB', transit_account_code: '326-0020', bank_account_code: '310-0010', is_active: true },
      { company_id: CO, code: 'PBB', transit_account_code: '326-0010', bank_account_code: '310-0020', is_active: true },
      { company_id: CO, code: 'AEON', transit_account_code: '326-0000', bank_account_code: null, is_active: false },
    ],
    acc_account_roles: [],
    payment_vouchers: [
      voucher({ id: 'pv-1', pv_number: 'HPV-023', payee_name: 'UNICOM', notes: 'BILL IV2026-09-007', credit_account_code: '310-0020', voucher_date: '2026-09-18', total_sen: 1_083_600 }),
      voucher({ id: 'pv-2', pv_number: 'HPV-050', payee_name: 'PREPARED ONLY', credit_account_code: '310-0020', voucher_date: DAY, total_sen: 9_999, checked_at: null }),
      voucher({ id: 'pv-3', pv_number: 'HPV-051', payee_name: 'CHECKED TOMORROW', credit_account_code: '310-0020', voucher_date: DAY, total_sen: 8_888, checked_at: '2026-09-30T02:00:00Z' }),
      voucher({ id: 'pv-4', pv_number: 'PV-0432', payee_name: 'Tan Yong Hong', credit_account_code: '310-0020', voucher_date: DAY, total_sen: 44_264, status: 'POSTED', approved_at: `${DAY}T03:00:00Z` }),
    ],
    acc_official_receipts: [
      { company_id: CO, payment_source: 'SOPAY', payment_id: 'pay-1', or_number: '2990-MOR-2609-009', doc_no: 'SO-1', status: 'FORMAL' },
      { company_id: 9, payment_source: 'SOPAY', payment_id: 'pay-2', or_number: 'ZZ-OR-1', doc_no: 'ZZ-SO-1', status: 'FORMAL' },
    ],
    mfg_sales_order_payments: [
      { company_id: CO, id: 'pay-2', so_doc_no: '2990-SO-2609-050' },
    ],
  });
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, CO as never);
    c.set('houzsUser' as never, { name: 'T', permissions_set: ['scm.payment_voucher.post'] } as never);
    c.set('allowedCompanyIds' as never, [CO] as never);
    await next();
  });
  app.get('/accounting/daily-bank', dailyBankHandler as never);
  return app;
}

type Board = {
  blocks: Array<{
    accountCode: string; openingSen: number; closingSen: number; pendingSen: number; availableSen: number; transitSen: number; availableWithTransitSen: number;
    receipts: Array<{ party: string | null; docNo: string; amountSen: number }>;
    payouts: Array<{ party: string | null; docNo: string; amountSen: number }>;
    pending: Array<{ pvNumber: string | null; payee: string | null; description: string; amountSen: number }>;
    transit: Array<{ acquirerCode: string; balanceSen: number }>;
  }>;
  unassignedTransit: Array<{ acquirerCode: string; balanceSen: number }>;
  pendingApprovalSen: number;
};

describe('GET /accounting/daily-bank — by bank', () => {
  test("the day's lines name who and which document; pending sits on its Paid From; transit on its acquirer's bank", async () => {
    const res = await harness().request(`/accounting/daily-bank?date=${DAY}`);
    expect(res.status, await res.clone().text()).toBe(200);
    const b = await res.json() as Board;
    const hlbb = b.blocks.find((x) => x.accountCode === '310-0020')!;
    expect(hlbb.openingSen).toBe(100_000);
    expect(hlbb.receipts.map((m) => [m.party, m.docNo, m.amountSen])).toEqual([
      ['Hookka', '2990-MOR-2609-009', 285_000],     // its official receipt
      ['LIM', '2990-SO-2609-050', 50_000],          // no receipt row yet: its order — never the payment's id
    ]);
    expect(hlbb.payouts.map((m) => [m.party, m.docNo, m.amountSen])).toEqual([['Tan Yong Hong', 'PV-0432', 44_264]]);
    expect(hlbb.closingSen).toBe(100_000 + 285_000 + 50_000 - 44_264);
    /* Checked and not yet approved as of the day: the prepared one, the one checked tomorrow and the posted one are not pending. */
    expect(hlbb.pending.map((p) => [p.pvNumber, p.payee, p.description, p.amountSen])).toEqual([['HPV-023', 'UNICOM', 'BILL IV2026-09-007', 1_083_600]]);
    expect(hlbb.availableSen).toBe(hlbb.closingSen - 1_083_600);
    expect(hlbb.transit.map((t) => [t.acquirerCode, t.balanceSen])).toEqual([['PBB', 375_035]]);
    expect(hlbb.availableWithTransitSen).toBe(hlbb.availableSen + 375_035);
    const may = b.blocks.find((x) => x.accountCode === '310-0010')!;
    expect(may.transit.map((t) => [t.acquirerCode, t.balanceSen])).toEqual([['MBB', 0]]);
    expect(may.pending).toEqual([]);
    /* The generic clearing account names no bank. */
    expect(b.unassignedTransit.map((t) => [t.acquirerCode, t.balanceSen])).toEqual([['未标银行', 3_365]]);
    expect(b.pendingApprovalSen).toBe(1_083_600);
  });
});
