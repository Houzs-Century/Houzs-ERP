/* Card money on the Cash Flow (owner 2026-11-05, the third row 2026-11-06), read
   through the real handler on a fake PostgREST:
     • a swipe is Cash In on the SWIPE date, split into "Card - in the bank" (its
       statement paid into a bank by the period's end) — a statement half paid
       splits its swipes half and half — and, for the rest, "Card - merchant
       matched" (the merchant's report has a CONFIRMED line for this payment) or
       "Card - not matched yet" (no report claims it, or only a line still waiting);
     • the acquirer's payout is a transfer from the Card column to the bank, off
       the tree, so a payout of an earlier month's swipe never counts again;
     • the fee it keeps is a payment out of the Card column; a move between two
       clearing accounts is nothing;
     • Balance b/f and c/f carry the Card column, so the bank columns still
       agree with the bank statements and b/f + in − out = c/f. */

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { CARD_COLUMN, receiptsPaymentsReport } from '../src/scm/routes/accounting-rp';
import { inBankShares, loadCardPayoutFacts, merchantMatched } from '../src/acc/card-in-bank';

const CO = 2;
let lineId = 0;
const gl = (jeNo: string, date: string, source: string, doc: string | null, code: string, name: string, dr: number, cr: number): Row => ({
  line_id: ++lineId, company_id: CO, je_no: jeNo, entry_date: date, source_type: source, source_doc_no: doc,
  account_code: code, account_name: name, debit_sen: dr, credit_sen: cr, party_type: null, party_name: null, notes: null,
  posted: true, reversed: false,
});
const acct = (code: string, name: string, money: boolean, type: string, section: string): Row =>
  ({ company_id: CO, account_code: code, account_name: name, acc_money: money, is_active: true, account_type: type, section });
const BANK = '310-0010';
const EDC = '326-0000';
const PBB = '326-0010';
const AR = '300-0000';
const swipe = (je: string, date: string, pay: string, clearing: string, sen: number): Row[] => [
  gl(je, date, 'SOPAY', pay, clearing, 'CARD MACHINE CLEARING', sen, 0),
  gl(je, date, 'SOPAY', pay, AR, 'ACCOUNT RECEIVEABLE', 0, sen),
];

/* openLink: a September swipe of 150 the machine linked to a report line nobody has confirmed. */
const world = (opts: { openLink?: boolean } = {}) => fakeSb({
  accounts: [
    acct(BANK, 'CASH AT BANK - MAYBANK', true, 'ASSET', 'CURRENT ASSETS'),
    acct(EDC, 'CARD MACHINE CLEARING (EDC)', false, 'ASSET', 'CURRENT ASSETS'),
    acct(PBB, 'CARD MACHINE CLEARING - PBB', false, 'ASSET', 'CURRENT ASSETS'),
    acct(AR, 'ACCOUNT RECEIVEABLE', false, 'ASSET', 'CURRENT ASSETS'),
    acct('900-T009', 'MERCHANT CHARGES', false, 'EXPENSE', 'EXPENSES'),
  ],
  acc_account_roles: [],
  v_gl_entries: [
    /* August: a swipe of 1,000 (paid out in September). */
    ...swipe('JE-A', '2026-08-20', 'pay-a', PBB, 100000),
    /* September: three swipes — 600 paid out on 25/09, 400 whose statement pays half on
       29/09 and the rest in October, 200 no statement has claimed yet. */
    ...swipe('JE-B', '2026-09-10', 'pay-b', PBB, 60000),
    ...swipe('JE-C', '2026-09-12', 'pay-c', PBB, 40000),
    ...swipe('JE-D', '2026-09-15', 'pay-d', EDC, 20000),
    /* The untagged EDC swipe moved to the merchant's own clearing: nothing. */
    gl('JE-M', '2026-09-16', 'SETTLEMOVE', 'SETTLEMOVE-1', PBB, 'CARD MACHINE CLEARING - PBB', 20000, 0),
    gl('JE-M', '2026-09-16', 'SETTLEMOVE', 'SETTLEMOVE-1', EDC, 'CARD MACHINE CLEARING (EDC)', 0, 20000),
    /* The acquirer's fee on statement 1 (August's and B's swipes). */
    gl('JE-F', '2026-09-24', 'SETTLE', 'SETTLE-1', '900-T009', 'MERCHANT CHARGES', 3200, 0),
    gl('JE-F', '2026-09-24', 'SETTLE', 'SETTLE-1', PBB, 'CARD MACHINE CLEARING - PBB', 0, 3200),
    /* Statement 1 paid out: 1,568 into the bank. */
    gl('JE-P1', '2026-09-25', 'SETTLEBANK', 'SETTLEBANK-1-1', BANK, 'CASH AT BANK - MAYBANK', 156800, 0),
    gl('JE-P1', '2026-09-25', 'SETTLEBANK', 'SETTLEBANK-1-1', PBB, 'CARD MACHINE CLEARING - PBB', 0, 156800),
    /* Statement 2 (C's swipe, net 400) half paid on 29/09, the rest on 03/10. */
    gl('JE-P2', '2026-09-29', 'SETTLEBANK', 'SETTLEBANK-2-2', BANK, 'CASH AT BANK - MAYBANK', 20000, 0),
    gl('JE-P2', '2026-09-29', 'SETTLEBANK', 'SETTLEBANK-2-2', PBB, 'CARD MACHINE CLEARING - PBB', 0, 20000),
    gl('JE-P3', '2026-10-03', 'SETTLEBANK', 'SETTLEBANK-2-3', BANK, 'CASH AT BANK - MAYBANK', 20000, 0),
    gl('JE-P3', '2026-10-03', 'SETTLEBANK', 'SETTLEBANK-2-3', PBB, 'CARD MACHINE CLEARING - PBB', 0, 20000),
    ...(opts.openLink ? swipe('JE-E', '2026-09-18', 'pay-e', PBB, 15000) : []),
  ],
  acc_settlement_matches: [
    { id: 1, company_id: CO, payment_source: 'SOPAY', payment_id: 'pay-a', settlement_row_id: 11 },
    { id: 2, company_id: CO, payment_source: 'SOPAY', payment_id: 'pay-b', settlement_row_id: 12 },
    { id: 3, company_id: CO, payment_source: 'SOPAY', payment_id: 'pay-c', settlement_row_id: 13 },
    ...(opts.openLink ? [{ id: 4, company_id: CO, payment_source: 'SOPAY', payment_id: 'pay-e', settlement_row_id: 14 }] : []),
  ],
  acc_settlement_rows: [
    { id: 11, company_id: CO, batch_id: 1, confirmed_at: '2026-09-24T02:00:00Z' },
    { id: 12, company_id: CO, batch_id: 1, confirmed_at: '2026-09-24T02:00:00Z' },
    { id: 13, company_id: CO, batch_id: 2, confirmed_at: '2026-09-28T02:00:00Z' },
    ...(opts.openLink ? [{ id: 14, company_id: CO, batch_id: 3, confirmed_at: null }] : []),
  ],
  acc_settlement_batches: [
    { id: 1, company_id: CO, stated_net_sen: 156800, net_sen: 156800 },
    { id: 2, company_id: CO, stated_net_sen: null, net_sen: 40000 },
    ...(opts.openLink ? [{ id: 3, company_id: CO, stated_net_sen: 15000, net_sen: 15000 }] : []),
  ],
  acc_settlement_receipts: [
    { id: 1, company_id: CO, batch_id: 1, received_on: '2026-09-25', amount_sen: 156800, charge_sen: 0, je_no: 'JE-P1' },
    { id: 2, company_id: CO, batch_id: 2, received_on: '2026-09-29', amount_sen: 20000, charge_sen: 0, je_no: 'JE-P2' },
    { id: 3, company_id: CO, batch_id: 2, received_on: '2026-10-03', amount_sen: 20000, charge_sen: 0, je_no: 'JE-P3' },
  ],
  acc_report_layouts: [],
  acc_acquirers: [{ company_id: CO, code: 'PBB', display_name: 'PBB', transit_account_code: PBB, is_active: true }],
  /* B pays its order in full in one go — a deposit (owner 2026-11-09: 一次性收完的当 deposit);
     C is the first 400 of a 1,000 order (a deposit); D pays the 200 balance of an order whose
     100 deposit came in August, so D is the settlement. */
  mfg_sales_orders: [
    { company_id: CO, doc_no: 'SO-A', local_total_sen: 100000 },
    { company_id: CO, doc_no: 'SO-B', local_total_sen: 60000 },
    { company_id: CO, doc_no: 'SO-C', local_total_sen: 100000 },
    { company_id: CO, doc_no: 'SO-D', local_total_sen: 30000 },
    /* E is the first 150 of a 1,000 order (a deposit). */
    { company_id: CO, doc_no: 'SO-E', local_total_sen: 100000 },
  ],
  mfg_sales_order_payments: [
    { company_id: CO, id: 'pay-a', so_doc_no: 'SO-A', amount_sen: 100000, paid_at: '2026-08-20', created_at: null },
    { company_id: CO, id: 'pay-b', so_doc_no: 'SO-B', amount_sen: 60000, paid_at: '2026-09-10', created_at: null },
    { company_id: CO, id: 'pay-c', so_doc_no: 'SO-C', amount_sen: 40000, paid_at: '2026-09-12', created_at: null },
    { company_id: CO, id: 'pay-d0', so_doc_no: 'SO-D', amount_sen: 10000, paid_at: '2026-08-01', created_at: null },
    { company_id: CO, id: 'pay-d', so_doc_no: 'SO-D', amount_sen: 20000, paid_at: '2026-09-15', created_at: null },
    { company_id: CO, id: 'pay-e', so_doc_no: 'SO-E', amount_sen: 15000, paid_at: '2026-09-18', created_at: null },
  ],
});

function harness(sb = world()) {
  const app = new Hono();
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
type Laid = { key?: string; label: string; amountSen: number; children: Laid[] };
type Report = {
  columns: Array<{ code: string; name: string }>; opening: Record<string, number>;
  receipts: Row2[]; payments: Row2[];
  totals: { closing: Record<string, number>; openingTotalSen: number; closingTotalSen: number };
  layout: { tree: Laid[]; inSen: number; outSen: number };
};
const get = async (from: string, to: string, opts: { sb?: ReturnType<typeof world>; party?: boolean } = {}): Promise<Report> => {
  const res = await harness(opts.sb).request(`/accounting/reports/receipts-payments?from=${from}&to=${to}${opts.party ? '&party=1' : ''}`);
  expect(res.status, await res.clone().text()).toBe(200);
  return await res.json() as Report;
};
const leaves = (nodes: Laid[]): Laid[] => nodes.flatMap((n) => (n.children.length === 0 ? [n] : leaves(n.children)));
const onTree = (r: Report, key: string): number => leaves(r.layout.tree).filter((n) => n.key === key).reduce((s, n) => s + n.amountSen, 0);

describe('Cash Flow: card money on the swipe date (owner 2026-11-05)', () => {
  test('September: the month\'s swipes are Cash In, split by whether their payout reached the bank by 30/09', async () => {
    const r = await get('2026-09-01', '2026-09-30');
    expect(r.columns.map((c) => c.code)).toEqual([BANK, CARD_COLUMN]);
    /* B 600 (a deposit) paid out. C 400 half paid: 200 in the bank, the other 200 matched by
       its report. D 200 (the settlement) no report claims. */
    expect(onTree(r, `${AR}:DEP:CARD-BANK`)).toBe(60000 + 20000);
    expect(onTree(r, `${AR}:DEP:CARD-MATCHED`)).toBe(20000);
    expect(onTree(r, `${AR}:BAL:CARD-UNMATCHED`)).toBe(20000);
    expect(onTree(r, `${AR}:BAL:CARD-BANK`)).toBe(0);
    expect(onTree(r, `${AR}:BAL:CARD-MATCHED`)).toBe(0);
    expect(onTree(r, `${AR}:DEP:CARD-UNMATCHED`)).toBe(0);
    expect(leaves(r.layout.tree).find((n) => n.key === `${AR}:DEP:CARD-BANK`)?.label).toBe('Card - in the bank');
    expect(leaves(r.layout.tree).find((n) => n.key === `${AR}:DEP:CARD-MATCHED`)?.label).toBe('Card - merchant matched');
    expect(leaves(r.layout.tree).find((n) => n.key === `${AR}:BAL:CARD-UNMATCHED`)?.label).toBe('Card - not matched yet');
    /* The payouts (August's 1,000 among them) never reach the tree… */
    expect(leaves(r.layout.tree).some((n) => String(n.key).startsWith('XFER:'))).toBe(false);
    expect(r.layout.inSen).toBe(120000);
    /* …the fee is the one payment, out of the Card column. */
    expect(r.payments.find((p) => p.key === '900-T009')?.cells).toEqual({ [CARD_COLUMN]: 3200 });
    expect(r.layout.outSen).toBe(3200);
  });

  test('a machine\'s link on a line still waiting is not a match; the three rows print in order', async () => {
    const r = await get('2026-09-01', '2026-09-30', { sb: world({ openLink: true }) });
    const deposit = r.layout.tree.flatMap(function walk(n: Laid): Laid[] { return n.label === 'Deposit' ? [n] : n.children.flatMap(walk); })[0]!;
    expect(deposit.children.map((n) => [n.label, n.amountSen])).toEqual([
      ['Card - in the bank', 60000 + 20000],
      ['Card - merchant matched', 20000],
      ['Card - not matched yet', 15000],
    ]);
    /* The split moves no money: Cash In is every swipe, and the Card column's c/f is untouched by which row a swipe reads. */
    expect(r.layout.inSen).toBe(135000);
    expect(r.totals.closing).toEqual({ [BANK]: 176800, [CARD_COLUMN]: 55000 });
    expect(r.totals.openingTotalSen + r.layout.inSen - r.layout.outSen).toBe(r.totals.closingTotalSen);
  });

  test('by debtor, the card money splits the same three ways', async () => {
    const r = await get('2026-09-01', '2026-09-30', { party: true });
    const part = (suffix: string) => r.receipts.find((x) => x.key.endsWith(suffix));
    expect(part(':CARD-BANK')?.totalSen).toBe(80000);
    expect(part(':CARD-MATCHED')?.totalSen).toBe(20000);
    expect(part(':CARD-MATCHED')?.name).toContain('Card - merchant matched');
    expect(part(':CARD-UNMATCHED')?.totalSen).toBe(20000);
    expect(part(':CARD-UNMATCHED')?.name).toContain('Card - not matched yet');
    expect(r.layout.inSen).toBe(120000);
  });

  test('the balances: the bank column agrees with the bank, the Card column holds what is not in it, b/f + in - out = c/f', async () => {
    const r = await get('2026-09-01', '2026-09-30');
    /* b/f: August's 1,000 still on the clearing account. */
    expect(r.opening).toEqual({ [BANK]: 0, [CARD_COLUMN]: 100000 });
    /* c/f: the bank got 1,568 + 200; the clearing keeps C's other 200 and D's 200. */
    expect(r.totals.closing).toEqual({ [BANK]: 176800, [CARD_COLUMN]: 40000 });
    expect(r.totals.openingTotalSen + r.layout.inSen - r.layout.outSen).toBe(r.totals.closingTotalSen);
  });

  test('October: the rest of C\'s payout is a transfer, not Cash In again', async () => {
    const r = await get('2026-10-01', '2026-10-31');
    expect(r.layout.inSen).toBe(0);
    expect(r.layout.outSen).toBe(0);
    expect(r.totals.closing).toEqual({ [BANK]: 196800, [CARD_COLUMN]: 20000 });
  });

  test('September and October together: C\'s second half has reached the bank, so it no longer reads as merely matched', async () => {
    const r = await get('2026-09-01', '2026-10-31');
    expect(onTree(r, `${AR}:DEP:CARD-BANK`)).toBe(60000 + 40000);
    expect(onTree(r, `${AR}:DEP:CARD-MATCHED`)).toBe(0);
    expect(onTree(r, `${AR}:BAL:CARD-UNMATCHED`)).toBe(20000);
  });

  test('merchantMatched: a payment counts only by a confirmed line, whichever journal source names it', () => {
    const facts = {
      matches: [
        { payment_source: 'SOPAY', payment_id: 'confirmed', settlement_row_id: 1 },
        { payment_source: 'SOPAY', payment_id: 'waiting', settlement_row_id: 2 },
        { payment_source: 'SIPAY', payment_id: 'invoice', settlement_row_id: 3 },
        { payment_source: 'SOPAY', payment_id: 'line-gone', settlement_row_id: 99 },
      ],
      rows: [
        { id: 1, batch_id: 1, confirmed_at: '2026-09-24T02:00:00Z' },
        { id: 2, batch_id: 1, confirmed_at: null },
        { id: 3, batch_id: 1, confirmed_at: '2026-09-24T02:00:00Z' },
      ],
      batches: [],
      receipts: [],
    };
    expect([...merchantMatched(facts)].sort()).toEqual(['SIPAY:invoice', 'SOPAY:confirmed']);
  });

  test('a later look at September moves C\'s second half into the bank (its statement is now fully paid)', () => {
    const facts = {
      matches: [{ payment_source: 'SOPAY', payment_id: 'pay-c', settlement_row_id: 13 }],
      rows: [{ id: 13, batch_id: 2, confirmed_at: '2026-09-28T02:00:00Z' }],
      batches: [{ id: 2, stated_net_sen: null, net_sen: 40000 }],
      receipts: [
        { batch_id: 2, received_on: '2026-09-29', amount_sen: 20000, charge_sen: 0, je_no: 'JE-P2' },
        { batch_id: 2, received_on: '2026-10-03', amount_sen: 20000, charge_sen: 0, je_no: 'JE-P3' },
      ],
    };
    expect(inBankShares(facts, '2026-09-30').get('SOPAY:pay-c')).toBe(0.5);
    expect(inBankShares(facts, '2026-10-31').get('SOPAY:pay-c')).toBe(1);
    /* A credit not yet in the ledger is not money in the bank. */
    expect(inBankShares({ ...facts, receipts: facts.receipts.map((x) => ({ ...x, je_no: null })) }, '2026-10-31').get('SOPAY:pay-c')).toBe(0);
  });

  /* Owner 2026-11-10 (2990-SO-2606-005, PBB's 06/06 report read "the bank has paid 90%"):
     「应该是324，那时说了是手续费不是？」 — PBB kept RM 324 off the 08/06 payout, and on
     2026-09-10 he booked it on the advice day (acc/payout-charge). Kept off the payout, it
     settles with the payout, as a receipt's own charge does. */
  test('a charge kept off the payout and booked on its advice day counts with the credit', () => {
    const facts = {
      matches: [{ payment_source: 'SOPAY', payment_id: 'sarah', settlement_row_id: 7 }],
      rows: [{ id: 7, batch_id: 9, confirmed_at: '2026-06-09T02:00:00Z' }],
      batches: [{ id: 9, stated_net_sen: null, net_sen: 334818 }],
      receipts: [{ batch_id: 9, received_on: '2026-06-08', amount_sen: 302418, charge_sen: 0, je_no: 'JE-R11' }],
      dayCharges: [{ batch_id: 9, charge_sen: 32400, charge_je_no: 'JE-C4' }],
    };
    expect(inBankShares(facts, '2026-06-30').get('SOPAY:sarah')).toBe(1);
    /* Without it the report read 90.3% paid — the false "not in the bank yet". */
    expect(inBankShares({ ...facts, dayCharges: [] }, '2026-06-30').get('SOPAY:sarah')).toBeCloseTo(302418 / 334818, 6);
    /* A charge not posted is not settled money. */
    expect(inBankShares({ ...facts, dayCharges: [{ batch_id: 9, charge_sen: 32400, charge_je_no: null }] }, '2026-06-30').get('SOPAY:sarah')).toBeLessThan(1);
    /* Before the payout reached the bank, nothing of the report is settled — the charge waits for it. */
    expect(inBankShares(facts, '2026-06-07').get('SOPAY:sarah')).toBe(0);
  });

  test('the advice days\' charges are read with the rest of the settlement history, this company\'s only', async () => {
    const sb = fakeSb({
      acc_settlement_payout_batches: [
        { id: 4, company_id: CO, payout_id: 3, batch_id: 9, settled_on: '2026-06-06', net_sen: 302418, charge_sen: 32400, charge_je_no: 'JE-C4' },
        { id: 5, company_id: 1, payout_id: 8, batch_id: 40, settled_on: '2026-06-06', net_sen: 1000, charge_sen: 100, charge_je_no: 'HC-JE-1' },
      ],
    });
    const loaded = await loadCardPayoutFacts(sb as never, CO);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.facts.dayCharges).toEqual([{ batch_id: 9, charge_sen: 32400, charge_je_no: 'JE-C4' }]);
  });
});
