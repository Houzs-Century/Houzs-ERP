/* The Cash Flow rules the owner agreed on 2026-11-05, read through the real
   handler on a fake PostgREST:
     • the opening journal is Balance b/f, never a receipt, a payment or a
       transfer, whatever day it is dated (the August column was all of it);
     • a supplier payment that settles an opening bill (its other side the
       opening clearing, 190-0000) reads as the creditor control, as does money
       paid ahead of a bill;
     • what a trade-finance account pays a supplier is its own line, TF-AP;
     • a transfer between two of the report's own columns is off the tree. */

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { receiptsPaymentsReport, TRADE_FINANCE_AP } from '../src/scm/routes/accounting-rp';

const CO = 2;
let lineId = 0;
const gl = (jeNo: string, date: string, source: string, doc: string | null, code: string, name: string, dr: number, cr: number, extra: Row = {}): Row => ({
  line_id: ++lineId, company_id: CO, je_no: jeNo, entry_date: date, source_type: source, source_doc_no: doc,
  account_code: code, account_name: name, debit_sen: dr, credit_sen: cr, party_type: null, party_name: null, notes: null,
  posted: true, reversed: false, ...extra,
});
const acct = (code: string, name: string, money: boolean, type: string, section: string): Row =>
  ({ company_id: CO, account_code: code, account_name: name, acc_money: money, is_active: true, account_type: type, section });

const world = () => fakeSb({
  accounts: [
    acct('310-0010', 'CASH AT BANK - MAYBANK', true, 'ASSET', 'CURRENT ASSETS'),
    acct('310-0060', 'CASH AT BANK - MAYBANK (TRADE FINANCE)', true, 'ASSET', 'CURRENT ASSETS'),
    acct('190-0000', 'OPENING BALANCE CLEARING', false, 'EQUITY', 'EQUITY'),
    acct('600-0001', 'STOCKS AT THE BEGINNING OF YEAR - CUSTOMER', false, 'EXPENSE', 'COST OF GOODS SOLD'),
    acct('400-0000', 'ACCOUNT PAYABLE', false, 'LIABILITY', 'CURRENT LIABILITIES'),
  ],
  acc_account_roles: [],
  v_gl_entries: [
    /* The books' opening journal, dated INSIDE the period: both banks' balances and the opening stock. */
    gl('JE-OB', '2026-08-31', 'OPENING', 'OB-1', '310-0010', 'CASH AT BANK - MAYBANK', 100000, 0),
    gl('JE-OB', '2026-08-31', 'OPENING', 'OB-1', '310-0060', 'CASH AT BANK - MAYBANK (TRADE FINANCE)', 50000, 0),
    gl('JE-OB', '2026-08-31', 'OPENING', 'OB-1', '600-0001', 'STOCKS AT THE BEGINNING OF YEAR - CUSTOMER', 20000, 0),
    gl('JE-OB', '2026-08-31', 'OPENING', 'OB-1', '190-0000', 'OPENING BALANCE CLEARING', 0, 170000),
    /* Paying an opening bill (API-OB, its line on the opening clearing) from the bank. */
    gl('JE-1', '2026-09-05', 'PV', 'PV-1', '400-0000', 'ACCOUNT PAYABLE', 40000, 0, { party_type: 'SUPPLIER', party_name: 'DREAM ART' }),
    gl('JE-1', '2026-09-05', 'PV', 'PV-1', '310-0010', 'CASH AT BANK - MAYBANK', 0, 40000),
    /* A supplier paid out of the trade-finance account. */
    gl('JE-2', '2026-09-14', 'PV', 'PV-2', '400-0000', 'ACCOUNT PAYABLE', 30000, 0, { party_type: 'SUPPLIER', party_name: 'DIGLANT' }),
    gl('JE-2', '2026-09-14', 'PV', 'PV-2', '310-0060', 'CASH AT BANK - MAYBANK (TRADE FINANCE)', 0, 30000),
    /* Topping the trade-finance account up from the bank: an own-account transfer. */
    gl('JE-3', '2026-09-20', 'PV', 'PV-3', '310-0060', 'CASH AT BANK - MAYBANK (TRADE FINANCE)', 25000, 0),
    gl('JE-3', '2026-09-20', 'PV', 'PV-3', '310-0010', 'CASH AT BANK - MAYBANK', 0, 25000),
    /* 1.00 out of the bank on three equal lines: each share rounds to 33 sen. */
    gl('JE-4', '2026-09-25', 'PV', 'PV-4', '600-0001', 'STOCKS AT THE BEGINNING OF YEAR - CUSTOMER', 1, 0),
    gl('JE-4', '2026-09-25', 'PV', 'PV-4', '900-A002', 'TOLL', 1, 0),
    gl('JE-4', '2026-09-25', 'PV', 'PV-4', '900-A003', 'PARKING', 1, 0),
    gl('JE-4', '2026-09-25', 'PV', 'PV-4', '310-0010', 'CASH AT BANK - MAYBANK', 0, 100),
  ],
  payment_vouchers: [
    { id: 'pv-1', company_id: CO, pv_number: 'PV-1', status: 'POSTED' },
    { id: 'pv-2', company_id: CO, pv_number: 'PV-2', status: 'POSTED' },
  ],
  pv_allocations: [
    { id: 'al-1', company_id: CO, pv_id: 'pv-1', pi_id: null, ap_invoice_id: 'api-ob', amount_sen: 40000, applied_sen: 40000, from_advance: false },
  ],
  purchase_invoices: [],
  ap_invoices: [{ id: 'api-ob', company_id: CO, invoice_number: 'API-OB' }],
  ap_invoice_lines: [{ id: 'l1', company_id: CO, invoice_id: 'api-ob', debit_account_code: '190-0000', amount_sen: 40000 }],
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
type Row2 = { key: string; code: string | null; name: string; cells: Record<string, number>; totalSen: number };
type Laid = { key?: string; label: string; children: Laid[] };
type Report = {
  opening: Record<string, number>; receipts: Row2[]; payments: Row2[];
  totals: { closing: Record<string, number> };
  layout: { tree: Laid[] };
};
const get = async (from: string, to: string): Promise<Report> => {
  const res = await harness().request(`/accounting/reports/receipts-payments?from=${from}&to=${to}`);
  expect(res.status, await res.clone().text()).toBe(200);
  return await res.json() as Report;
};
const keysOn = (nodes: Laid[]): string[] => nodes.flatMap((n) => [...(n.key ? [n.key] : []), ...keysOn(n.children)]);

describe('Cash Flow: the rules of 2026-11-05', () => {
  /* Owner 2026-11-05: 310-0060 read 5,708.18 against the ledger's 5,708.17. A leg's rows each round on
     their own; the sen they miss goes back onto the largest, so a column moves by exactly the leg. */
  test('a leg split three ways still moves its bank by exactly the leg', async () => {
    const r = await get('2026-09-01', '2026-09-30');
    const pv4 = (r as unknown as { entries: Array<{ jeNo: string; sen: number; side: string }> }).entries.filter((e) => e.jeNo === 'JE-4');
    expect(pv4.reduce((s, e) => s + (e.side === 'R' ? e.sen : -e.sen), 0)).toBe(-100);
    expect(pv4.map((e) => e.sen).sort()).toEqual([33, 33, 34]);
  });


  test('the opening journal dated inside the period is Balance b/f, not a receipt or a transfer', async () => {
    const r = await get('2026-08-01', '2026-08-31');
    expect(r.opening).toEqual({ '310-0010': 100000, '310-0060': 50000 });
    expect(r.receipts).toEqual([]);
    expect(r.payments).toEqual([]);
    expect(r.totals.closing).toEqual({ '310-0010': 100000, '310-0060': 50000 });
  });

  test('a payment of an opening bill reads as the creditor control, not the opening clearing', async () => {
    const r = await get('2026-09-01', '2026-09-30');
    expect(r.payments.find((x) => x.key === '190-0000')).toBeUndefined();
    expect(r.payments.find((x) => x.key === '400-0000')?.cells).toEqual({ '310-0010': 40000 });
  });

  test('what the trade-finance account pays a supplier is its own line', async () => {
    const r = await get('2026-09-01', '2026-09-30');
    const tf = r.payments.find((x) => x.key === TRADE_FINANCE_AP)!;
    expect(tf).toMatchObject({ code: TRADE_FINANCE_AP, name: 'Trade finance - Accounts payable & creditors', cells: { '310-0060': 30000 } });
    expect(r.payments.find((x) => x.key === '400-0000')?.cells['310-0060']).toBeUndefined();
  });

  test('the top-up between the two banks stays in the rows and the balances but is off the tree', async () => {
    const r = await get('2026-09-01', '2026-09-30');
    expect(r.payments.find((x) => x.key === 'XFER:310-0060')?.cells).toEqual({ '310-0010': 25000 });
    expect(r.totals.closing).toEqual({ '310-0010': 100000 - 40000 - 25000 - 100, '310-0060': 50000 - 30000 + 25000 });
    expect(keysOn(r.layout.tree).filter((k) => k.startsWith('XFER:'))).toEqual([]);
    expect(keysOn(r.layout.tree)).toContain(TRADE_FINANCE_AP);
  });
});
