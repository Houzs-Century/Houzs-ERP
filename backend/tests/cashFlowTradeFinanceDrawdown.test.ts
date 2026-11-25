/* Owner 2026-11-25 (不是应该和下面 drawdown 一样吗): a trade-finance drawdown is the bank paying a
   supplier, so the same money is Drawdown in and TF-AP out, whichever bank Finance books it
   through. Read through the real handler on a fake PostgREST:
     • a drawdown booked into another bank pairs with the voucher out of that bank for the same
       amount, the nearest within 7 days, and that voucher reads as TF-AP;
     • each drawdown line pays one voucher; one too far away, or with no drawdown, stays a
       creditor payment;
     • a drawdown journal that also takes a bank charge from another bank reads pair by pair,
       so the drawdown keeps its full amount. */

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { receiptsPaymentsReport, TRADE_FINANCE_AP } from '../src/scm/routes/accounting-rp';

const CO = 2;
const MBB = '310-0100';
const HLB = '310-0020';
const TFB = '310-0060';
const FACILITY = '460-0009';
const AP = '400-0000';
const CHARGES = '900-B001';
const NAME: Record<string, string> = {
  [MBB]: 'CASH AT BANK - MBB',
  [HLB]: 'CASH AT BANK - HLBB',
  [TFB]: 'CASH AT BANK - MAYBANK (TRADE FINANCE)',
  [FACILITY]: 'TRADE FINANCE - MAYBANK',
  [AP]: 'ACCOUNT PAYABLE',
  [CHARGES]: 'BANK CHARGES',
};

let lineId = 0;
const gl = (jeNo: string, date: string, source: string, doc: string | null, code: string, dr: number, cr: number): Row => ({
  line_id: ++lineId, company_id: CO, je_no: jeNo, entry_date: date, source_type: source, source_doc_no: doc,
  account_code: code, account_name: NAME[code], debit_sen: dr, credit_sen: cr,
  party_type: code === AP ? 'SUPPLIER' : null, party_name: code === AP ? 'SUPPLIER A' : null, notes: null,
  posted: true, reversed: false,
});
const acct = (code: string, money: boolean, type: string, section: string): Row =>
  ({ company_id: CO, account_code: code, account_name: NAME[code], acc_money: money, is_active: true, account_type: type, section });
/* A supplier paid out of a bank, with its bank charge when there is one. */
const voucher = (jeNo: string, date: string, pv: string, bank: string, amount: number, charge = 0): Row[] => [
  gl(jeNo, date, 'PV', pv, AP, amount, 0),
  gl(jeNo, date, 'PV', pv, bank, 0, amount),
  ...(charge > 0 ? [gl(jeNo, date, 'PV', pv, CHARGES, charge, 0), gl(jeNo, date, 'PV', pv, bank, 0, charge)] : []),
];

const world = () => fakeSb({
  accounts: [
    acct(MBB, true, 'ASSET', 'CURRENT ASSETS'),
    acct(HLB, true, 'ASSET', 'CURRENT ASSETS'),
    acct(TFB, true, 'ASSET', 'CURRENT ASSETS'),
    acct(FACILITY, false, 'LIABILITY', 'CURRENT LIABILITIES'),
    acct(AP, false, 'LIABILITY', 'CURRENT LIABILITIES'),
    acct(CHARGES, false, 'EXPENSE', 'EXPENSES'),
  ],
  acc_account_roles: [],
  v_gl_entries: [
    /* Two drawdowns booked into MBB in one journal; the supplier paid out of MBB the same day, twice. */
    gl('JE-D1', '2026-11-17', 'MANUAL', null, MBB, 100000, 0),
    gl('JE-D1', '2026-11-17', 'MANUAL', null, MBB, 50000, 0),
    gl('JE-D1', '2026-11-17', 'MANUAL', null, FACILITY, 0, 100000),
    gl('JE-D1', '2026-11-17', 'MANUAL', null, FACILITY, 0, 50000),
    ...voucher('JE-P1', '2026-11-17', 'PV-1', MBB, 100000, 200),
    ...voucher('JE-P2', '2026-11-17', 'PV-2', MBB, 50000, 200),
    /* The same day, a supplier paid out of MBB with no drawdown behind it. */
    ...voucher('JE-P3', '2026-11-17', 'PV-3', MBB, 30000),
    /* A day later, the same amount as the second drawdown, which has already paid PV-2. */
    ...voucher('JE-P7', '2026-11-18', 'PV-7', MBB, 50000),
    /* A drawdown into HLBB whose bank charge came out of MBB, in one journal; HLBB paid the supplier three days later. */
    gl('JE-D2', '2026-11-03', 'MANUAL', null, HLB, 80000, 0),
    gl('JE-D2', '2026-11-03', 'MANUAL', null, FACILITY, 0, 80000),
    gl('JE-D2', '2026-11-03', 'MANUAL', null, CHARGES, 200, 0),
    gl('JE-D2', '2026-11-03', 'MANUAL', null, MBB, 0, 200),
    ...voucher('JE-P4', '2026-11-06', 'PV-4', HLB, 80000),
    /* A drawdown and a payment of the same amount nineteen days apart. */
    gl('JE-D3', '2026-11-01', 'MANUAL', null, MBB, 40000, 0),
    gl('JE-D3', '2026-11-01', 'MANUAL', null, FACILITY, 0, 40000),
    ...voucher('JE-P5', '2026-11-20', 'PV-5', MBB, 40000),
    /* The books' opening journal, dated inside the period, owes the facility; a payment of the
       same amount out of the same bank the next day is no drawdown's. */
    gl('JE-OB', '2026-11-01', 'OPENING', 'OB-1', MBB, 12345, 0),
    gl('JE-OB', '2026-11-01', 'OPENING', 'OB-1', FACILITY, 0, 12345),
    ...voucher('JE-P8', '2026-11-02', 'PV-8', MBB, 12345),
    /* The trade-finance account's own drawdown and payment, as before. */
    gl('JE-D4', '2026-11-06', 'MANUAL', null, TFB, 25000, 0),
    gl('JE-D4', '2026-11-06', 'MANUAL', null, FACILITY, 0, 25000),
    ...voucher('JE-P6', '2026-11-06', 'PV-6', TFB, 25000),
  ],
  payment_vouchers: ['PV-1', 'PV-2', 'PV-3', 'PV-4', 'PV-5', 'PV-6', 'PV-7', 'PV-8'].map((n) => ({ id: n.toLowerCase(), company_id: CO, pv_number: n, status: 'POSTED' })),
  pv_allocations: [],
  purchase_invoices: [],
  ap_invoices: [],
  ap_invoice_lines: [],
  acc_report_layouts: [],
  acc_acquirers: [],
});

function harness() {
  const app = new Hono();
  const sb = world();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, CO as never);
    c.set('allowedCompanyIds' as never, [CO] as never);
    c.set('houzsUser' as never, { name: 'Chew', permissions_set: ['scm.payment_voucher.post'] } as never);
    await next();
  });
  app.get('/accounting/reports/receipts-payments', receiptsPaymentsReport as never);
  return app;
}
type Row2 = { key: string; cells: Record<string, number>; totalSen: number };
type Report = {
  receipts: Row2[]; payments: Row2[];
  totals: { closing: Record<string, number> };
  entries: Array<{ jeNo: string; rowKey: string; side: string; sen: number }>;
};
const november = async (): Promise<Report> => {
  const res = await harness().request('/accounting/reports/receipts-payments?from=2026-11-01&to=2026-11-30');
  expect(res.status, await res.clone().text()).toBe(200);
  return await res.json() as Report;
};
const row = (rows: Row2[], key: string) => rows.find((r) => r.key === key);

describe('Cash Flow: a trade-finance drawdown is TF-AP too (owner 2026-11-25)', () => {
  test('the vouchers a drawdown paid through another bank read as TF-AP, beside the trade-finance account\'s own', async () => {
    const r = await november();
    expect(row(r.payments, TRADE_FINANCE_AP)?.cells).toEqual({ [MBB]: 150000, [HLB]: 80000, [TFB]: 25000 });
    const paidBy = r.entries.filter((e) => e.rowKey === TRADE_FINANCE_AP).map((e) => e.jeNo);
    expect([...new Set(paidBy)].sort()).toEqual(['JE-P1', 'JE-P2', 'JE-P4', 'JE-P6']);
  });

  test('a voucher with no drawdown, one already paid, one too far away, and one beside the opening stay creditor payments', async () => {
    const r = await november();
    expect(row(r.payments, AP)?.cells).toEqual({ [MBB]: 30000 + 50000 + 40000 + 12345 });
  });

  test('the drawdown keeps its full amount when its journal takes a bank charge from another bank', async () => {
    const r = await november();
    expect(row(r.receipts, FACILITY)?.cells).toEqual({ [MBB]: 150000 + 40000, [HLB]: 80000, [TFB]: 25000 });
    expect(row(r.payments, FACILITY)).toBeUndefined();
    expect(row(r.payments, CHARGES)?.cells).toEqual({ [MBB]: 200 + 200 + 200 });
  });

  test('every bank still moves by exactly its own lines', async () => {
    const r = await november();
    expect(r.totals.closing).toEqual({
      [MBB]: 12345 + 150000 - 100200 - 50200 - 30000 - 50000 - 200 + 40000 - 40000 - 12345,
      [HLB]: 80000 - 80000,
      [TFB]: 25000 - 25000,
    });
  });
});
