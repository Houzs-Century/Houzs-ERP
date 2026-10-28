/* The General Ledger the AutoCount way (owner 2026-09-14; docs/bugs/0924).
   Pinned:
     • one block per account with a BALANCE B/F before the period, the lines
       of the period in date order with a running balance on the account's
       natural side, the block's totals and the grand totals;
     • the other side of an entry: the one other account, or the largest
       opposite account and how many more;
     • the journal type (the five journals), Ref. 1 / Ref. 2 off the journal's
       own references, the description off the narration;
     • a reversal pair is neither listed nor counted; asked for, its lines are
       listed and marked but move no balance and no total;
     • picked accounts, a code range, the whole chart; bad dates; the
       statements' permission.
   Real handler, fake PostgREST (fakeSb). */

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { ledgerReport, type LedgerReport } from '../src/scm/routes/accounting-ledger';

const CO = 2;
let lineId = 0;
const gl = (jeNo: string, date: string, source: string, doc: string | null, code: string, name: string, type: string, dr: number, cr: number, extra: Row = {}): Row => ({
  line_id: `l${++lineId}`, company_id: CO, je_no: jeNo, entry_date: date, source_type: source, source_doc_no: doc,
  line_no: lineId, account_code: code, account_name: name, account_type: type, debit_sen: dr, credit_sen: cr,
  party_type: null, party_code: null, party_name: null, notes: null, posted: true, reversed: false, reversed_by_je: null, ...extra,
});

const BANK = ['310-0010', 'CASH AT BANK - MAYBANK', 'ASSET'] as const;
const CASH = ['320-0000', 'CASH IN HAND', 'ASSET'] as const;
const AR = ['300-0000', 'ACCOUNT RECEIVEABLE', 'ASSET'] as const;
const SALES = ['501-0000', 'SALES - BEDDING', 'INCOME'] as const;
const ACC = ['502-0000', 'SALES - ACCESSORIES', 'INCOME'] as const;
const ADVERT = ['900-A001', 'ADVERTISEMENT', 'EXPENSE'] as const;

const world = () => fakeSb({
  accounts: [
    { company_id: CO, account_code: BANK[0], account_name: BANK[1], account_type: BANK[2], is_active: true },
    { company_id: CO, account_code: CASH[0], account_name: CASH[1], account_type: CASH[2], is_active: true },
    { company_id: CO, account_code: AR[0], account_name: AR[1], account_type: AR[2], is_active: true },
    { company_id: CO, account_code: SALES[0], account_name: SALES[1], account_type: SALES[2], is_active: true },
    { company_id: CO, account_code: ACC[0], account_name: ACC[1], account_type: ACC[2], is_active: true },
    { company_id: CO, account_code: ADVERT[0], account_name: ADVERT[1], account_type: ADVERT[2], is_active: true },
    { company_id: CO, account_code: '999-0000', account_name: 'NEVER USED', account_type: 'EXPENSE', is_active: true },
  ],
  acc_account_roles: [],
  v_gl_entries: [
    /* July — before the period: a customer paid RM 1,000 into the bank. */
    gl('2990-JE-2607-0001', '2026-07-20', 'SOPAY', 'pay-1', ...BANK, 100_000, 0),
    gl('2990-JE-2607-0001', '2026-07-20', 'SOPAY', 'pay-1', ...AR, 0, 100_000, { party_type: 'CUSTOMER', party_name: 'Ah Meng' }),
    /* August — the period. A cash deposit (the cash journal). */
    gl('2990-JE-2608-0001', '2026-08-05', 'SOPAY', 'pay-2', ...CASH, 50_000, 0),
    gl('2990-JE-2608-0001', '2026-08-05', 'SOPAY', 'pay-2', ...AR, 0, 50_000, { party_type: 'CUSTOMER', party_name: 'NG KAH YEE' }),
    /* An advertising voucher paid from the bank. */
    gl('2990-JE-2608-0002', '2026-08-10', 'PV', '2990-HPV-2608-017', ...ADVERT, 30_000, 0),
    gl('2990-JE-2608-0002', '2026-08-10', 'PV', '2990-HPV-2608-017', ...BANK, 0, 30_000, { party_name: 'LOO WEN WEI' }),
    /* A three-line sales invoice: AR against two sales accounts. */
    gl('2990-JE-2608-0003', '2026-08-12', 'SI', '2990-SI-2608-001', ...AR, 200_000, 0, { party_type: 'CUSTOMER', party_name: 'NG KAH YEE' }),
    gl('2990-JE-2608-0003', '2026-08-12', 'SI', '2990-SI-2608-001', ...SALES, 0, 150_000),
    gl('2990-JE-2608-0003', '2026-08-12', 'SI', '2990-SI-2608-001', ...ACC, 0, 50_000),
    /* A payment keyed twice on the 20th, reversed on 15 September. */
    gl('2990-JE-2608-0004', '2026-08-20', 'SOPAY', 'pay-3', ...BANK, 161_000, 0, { reversed: true, reversed_by_je: 'je-c' }),
    gl('2990-JE-2608-0004', '2026-08-20', 'SOPAY', 'pay-3', ...AR, 0, 161_000, { reversed: true, reversed_by_je: 'je-c' }),
    gl('2990-JE-2609-0001', '2026-09-15', 'SOPAY_REVERSAL', 'pay-3', ...AR, 161_000, 0, { reversed_by_je: 'je-o' }),
    gl('2990-JE-2609-0001', '2026-09-15', 'SOPAY_REVERSAL', 'pay-3', ...BANK, 0, 161_000, { reversed_by_je: 'je-o' }),
    /* September, after the period: must not leak backwards. */
    gl('2990-JE-2609-0002', '2026-09-02', 'PV', '2990-HPV-2609-001', ...ADVERT, 10_000, 0),
    gl('2990-JE-2609-0002', '2026-09-02', 'PV', '2990-HPV-2609-001', ...BANK, 0, 10_000),
  ],
  journal_entries: [
    { company_id: CO, je_no: '2990-JE-2607-0001', narration: 'Payment transfer on 2990-SO-2607-003 — Ah Meng' },
    { company_id: CO, je_no: '2990-JE-2608-0001', narration: 'Payment cash on 2990-SO-2608-067 — NG KAH YEE' },
    { company_id: CO, je_no: '2990-JE-2608-0002', narration: 'Facebook ads August — LOO WEN WEI' },
    { company_id: CO, je_no: '2990-JE-2608-0003', narration: 'Sales invoice 2990-SI-2608-001 — NG KAH YEE' },
    { company_id: CO, je_no: '2990-JE-2608-0004', narration: 'Payment transfer on 2990-SO-2608-004 — keyed twice' },
    { company_id: CO, je_no: '2990-JE-2609-0001', narration: 'Reversal of 2990-JE-2608-0004 — payment on 2990-SO-2608-004 deleted' },
    { company_id: CO, je_no: '2990-JE-2609-0002', narration: 'Facebook ads September' },
  ],
  mfg_sales_order_payments: [
    { id: 'pay-1', company_id: CO, so_doc_no: '2990-SO-2607-003' },
    { id: 'pay-2', company_id: CO, so_doc_no: '2990-SO-2608-067' },
    { id: 'pay-3', company_id: CO, so_doc_no: '2990-SO-2608-004' },
  ],
  mfg_sales_orders: [
    { company_id: CO, doc_no: '2990-SO-2607-003', debtor_name: 'Ah Meng' },
    { company_id: CO, doc_no: '2990-SO-2608-067', debtor_name: 'NG KAH YEE' },
    { company_id: CO, doc_no: '2990-SO-2608-004', debtor_name: 'Keyed Twice' },
  ],
  acc_official_receipts: [{ company_id: CO, payment_source: 'SOPAY', payment_id: 'pay-2', or_number: '2990COR-2608-003', status: 'ISSUED' }],
  payment_vouchers: [{ company_id: CO, pv_number: '2990-HPV-2608-017', payee_name: 'LOO WEN WEI', refund_source_doc_no: null }],
  sales_invoices: [{ company_id: CO, invoice_number: '2990-SI-2608-001', so_doc_no: '2990-SO-2608-067', debtor_name: 'NG KAH YEE' }],
});

function harness(perms: string[] = ['scm.payment_voucher.post']) {
  const sb = world();
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, CO as never);
    c.set('houzsUser' as never, { name: 'T', permissions_set: perms } as never);
    c.set('allowedCompanyIds' as never, [CO] as never);
    await next();
  });
  app.get('/accounting/gl/ledger', ledgerReport as never);
  return app;
}

const fetchLedger = async (app: Hono, qs: string): Promise<LedgerReport> => {
  const res = await app.request(`/accounting/gl/ledger?${qs}`);
  expect(res.status, await res.clone().text()).toBe(200);
  return await res.json() as LedgerReport;
};
const block = (r: LedgerReport, code: string) => r.blocks.find((b) => b.code === code);

describe('GET /accounting/gl/ledger — the ledger the AutoCount way', () => {
  test('one block per account: balance b/f, the period\'s lines in date order, a running balance on the natural side, totals', async () => {
    const r = await fetchLedger(harness(), 'from=2026-08-01&to=2026-08-31');
    expect(r.scope.all).toBe(true);
    /* The unused account has no block; the ones with a balance or a line do, in code order. */
    expect(r.blocks.map((b) => b.code)).toEqual(['300-0000', '310-0010', '320-0000', '501-0000', '502-0000', '900-A001']);

    const bank = block(r, '310-0010')!;
    expect(bank.openingSen).toBe(100_000);
    expect(bank.lines.map((l) => [l.date, l.jeNo, l.debitSen, l.creditSen, l.balanceSen])).toEqual([
      ['2026-08-10', '2990-JE-2608-0002', 0, 30_000, 70_000],
    ]);
    expect([bank.debitSen, bank.creditSen, bank.closingSen]).toEqual([0, 30_000, 70_000]);

    /* Sales sit on the credit side: the invoice reads positive. */
    const sales = block(r, '501-0000')!;
    expect(sales.openingSen).toBe(0);
    expect(sales.lines.map((l) => [l.creditSen, l.balanceSen])).toEqual([[150_000, 150_000]]);

    /* The debtor: opening −1,000 (paid before it was invoiced), then the cash deposit and the invoice. */
    const ar = block(r, '300-0000')!;
    expect(ar.openingSen).toBe(-100_000);
    expect(ar.lines.map((l) => [l.date, l.debitSen, l.creditSen, l.balanceSen])).toEqual([
      ['2026-08-05', 0, 50_000, -150_000],
      ['2026-08-12', 200_000, 0, 50_000],
    ]);
    expect(ar.closingSen).toBe(50_000);

    expect(r.totals).toEqual({ debitSen: 280_000, creditSen: 280_000 });
  });

  test('the other side, the journal type, the two references and the description', async () => {
    const r = await fetchLedger(harness(), 'from=2026-08-01&to=2026-08-31');
    const bankLine = block(r, '310-0010')!.lines[0]!;
    expect(bankLine).toMatchObject({ journal: 'BANK', counter: { code: '900-A001', name: 'ADVERTISEMENT', more: 0 }, doc: '2990-HPV-2608-017', doc2: null, who: 'LOO WEN WEI', description: 'Facebook ads August — LOO WEN WEI', reversal: '' });
    /* The cash deposit: the receipt number in front, the order behind, the customer. */
    const cashLine = block(r, '320-0000')!.lines[0]!;
    expect(cashLine).toMatchObject({ journal: 'CASH', counter: { code: '300-0000', more: 0 }, doc: '2990COR-2608-003', doc2: '2990-SO-2608-067', who: 'NG KAH YEE' });
    /* The three-line invoice: from the debtor, the largest sales account and one more; from sales, the debtor alone. */
    const arInvoice = block(r, '300-0000')!.lines[1]!;
    expect(arInvoice).toMatchObject({ journal: 'SALES', counter: { code: '501-0000', name: 'SALES - BEDDING', more: 1 }, doc: '2990-SI-2608-001', doc2: '2990-SO-2608-067' });
    expect(block(r, '502-0000')!.lines[0]!.counter).toEqual({ code: '300-0000', name: 'ACCOUNT RECEIVEABLE', more: 0 });
  });

  test('a reversal pair is nothing; asked for, its lines are listed and marked but move no balance and no total', async () => {
    const plain = await fetchLedger(harness(), 'from=2026-08-01&to=2026-08-31');
    expect(block(plain, '310-0010')!.lines.map((l) => l.jeNo)).toEqual(['2990-JE-2608-0002']);
    const shown = await fetchLedger(harness(), 'from=2026-08-01&to=2026-08-31&showReversed=1');
    const bank = block(shown, '310-0010')!;
    expect(bank.lines.map((l) => [l.jeNo, l.reversal, l.balanceSen])).toEqual([
      ['2990-JE-2608-0002', '', 70_000],
      ['2990-JE-2608-0004', 'reversed', 70_000],
    ]);
    expect([bank.debitSen, bank.creditSen, bank.closingSen]).toEqual([0, 30_000, 70_000]);
    expect(shown.totals).toEqual(plain.totals);
    /* September: the contra is the month's only bank movement and it is nothing; the balance brought forward skips the pair too. */
    const sep = await fetchLedger(harness(), 'from=2026-09-01&to=2026-09-30');
    expect(block(sep, '310-0010')).toMatchObject({ openingSen: 70_000, closingSen: 60_000 });
    expect(block(sep, '310-0010')!.lines.map((l) => l.jeNo)).toEqual(['2990-JE-2609-0002']);
    const sepShown = await fetchLedger(harness(), 'from=2026-09-01&to=2026-09-30&showReversed=1');
    expect(block(sepShown, '310-0010')!.lines.map((l) => [l.jeNo, l.reversal])).toEqual([['2990-JE-2609-0002', ''], ['2990-JE-2609-0001', 'contra']]);
  });

  test('picked accounts and a code range narrow the blocks; the other side is still named', async () => {
    const one = await fetchLedger(harness(), 'from=2026-08-01&to=2026-08-31&accounts=310-0010');
    expect(one.blocks.map((b) => b.code)).toEqual(['310-0010']);
    expect(one.scope).toEqual({ codes: ['310-0010'], fromCode: null, toCode: null, all: false });
    expect(one.blocks[0]!.lines[0]!.counter).toEqual({ code: '900-A001', name: 'ADVERTISEMENT', more: 0 });
    const threes = await fetchLedger(harness(), 'from=2026-08-01&to=2026-08-31&fromAccount=300-0000&toAccount=399-9999');
    expect(threes.blocks.map((b) => b.code)).toEqual(['300-0000', '310-0010', '320-0000']);
    expect(threes.totals).toEqual({ debitSen: 250_000, creditSen: 80_000 });
  });

  test('a bad range is refused; the ledger is the statements\' reader\'s', async () => {
    expect((await harness().request('/accounting/gl/ledger?from=2026-08-31&to=2026-08-01')).status).toBe(400);
    expect((await harness().request('/accounting/gl/ledger?from=x&to=y')).status).toBe(400);
    expect((await harness([]).request('/accounting/gl/ledger?from=2026-08-01&to=2026-08-31')).status).toBe(403);
  });
});
