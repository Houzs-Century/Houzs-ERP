// Owner 2026-11-17, on 2990's Hong Leong credit of RM 26,308.81 on 13/11
// (Houzs's HC-HPV-2611-052): eight customer transfers already on 310-0020, plus
// three of 2990's instalment sales swiped on Houzs's AEON terminal and paid back
// less AEON's MDR and subvention fee — 「我在bank recon时可以选刷卡的transaction，
// 然后差额就直接去terminal charges」, then 「照这样做」.
//
// Pinned: the plan (acc/bank-card-match), the two doors (accounting-bank-cards),
// Undo, and the payment leaving every list that offers card money to a report.

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { planCardMatch, type CardForMatch } from '../src/acc/bank-card-match';
import { bankCardPayments, bankLineMatchWithCards } from '../src/scm/routes/accounting-bank-cards';
import { bankLineUndo } from '../src/scm/routes/accounting-bank';
import { settlementConfirmRow, settlementWatchlist } from '../src/scm/routes/accounting-settlement';
import { paymentReconciliation } from '../src/acc/payment-reconciled';

const CO = 2;

/* The eight transfers already on the bank, as the PV's remark lists them. */
const TRANSFERS: Array<[string, string, number]> = [
  ['2990-JE-2610-0093', '2990-SO-2609-016', 210000], ['2990-JE-2610-0150', '2990-SO-2609-019', 217700],
  ['2990-JE-2610-0237', '2990-SO-2608-070', 114700], ['2990-JE-2610-0350', '2990-SO-2608-010', 100000],
  ['2990-JE-2610-0406', '2990-SO-2608-019', 149000], ['2990-JE-2610-0404', '2990-SO-2608-020', 231000],
  ['2990-JE-2611-0052', '2990-SO-2608-064', 165700], ['2990-JE-2611-0040', '2990-SO-2611-022', 349000],
];

/* The three swipes on Houzs's AEON terminal, each receipt where 2990 keyed it. */
const SWIPES: Array<{ id: string; so: string; sen: number; je: string; clearing: string; code: string | null; provider: string | null }> = [
  { id: 'p028', so: '2990-SO-2611-028', sen: 399000, je: '2990-JE-2611-0062', clearing: '326-0010', code: null, provider: 'PBB' },
  { id: 'p017', so: '2990-SO-2611-017', sen: 399000, je: '2990-JE-2611-0033', clearing: '326-0000', code: 'R21077', provider: null },
  { id: 'p081', so: '2990-SO-2611-081', sen: 350000, je: '2990-JE-2611-0246', clearing: '326-0000', code: '007909', provider: null },
];

const LINE_1633: Row = {
  id: 1633, statement_id: 28, company_id: CO, line_no: 32, booked_on: '2026-11-13', amount_sen: 2630881,
  state: 'OPEN', kind: 'OTHER', reference: 'HOUZS CENTURY SDN. BHD. REFUND TO 2990 HC-HPV-2611-052', description: 'Fund Transfer',
  posted_je_no: null, note: null,
};

const chart = (codes: string[]): Row[] => codes.map((account_code) => ({ company_id: CO, account_code, account_name: account_code === '900-T009' ? 'TERMINAL INTEREST CHARGES' : account_code, parent_code: null, is_active: true }));

function harness(extra: Record<string, Row[]> = {}) {
  const sb = fakeSb(
    {
      companies: [{ id: CO, code: '2990' }],
      accounts: chart(['310-0020', '900-T009', '326-0000', '326-0010', '326-0040', '300-0000']),
      acc_account_roles: [],
      acc_acquirers: [
        { company_id: CO, code: 'PBB', display_name: 'PBB', transit_account_code: '326-0010', fee_account_code: '900-T009', bank_account_code: '310-0020', date_tolerance_days: 3, is_active: true, so_names: [] },
        { company_id: CO, code: 'HLB', display_name: 'HLB', transit_account_code: '326-0040', fee_account_code: '900-T009', bank_account_code: '310-0020', date_tolerance_days: 3, is_active: true, so_names: [] },
        { company_id: CO, code: 'AEON', display_name: 'AEON', transit_account_code: '326-0000', fee_account_code: '900-T009', bank_account_code: null, date_tolerance_days: 3, is_active: false, so_names: [] },
      ],
      acc_bank_statements: [{ id: 28, company_id: CO, account_code: '310-0020', period_from: '2026-11-01', period_to: '2026-11-15' }],
      acc_bank_statement_lines: [
        { ...LINE_1633 },
        { id: 1700, statement_id: 28, company_id: CO, line_no: 40, booked_on: '2026-11-10', amount_sen: 2071087, state: 'OPEN', kind: 'PAYOUT_SPLIT', reference: 'PBB payout', description: 'CA Credit Advice' },
      ],
      acc_bank_statement_matches: [], acc_bank_month_locks: [], acc_bank_card_settlements: [],
      acc_settlement_batches: [], acc_settlement_rows: [], acc_settlement_matches: [], acc_settlement_receipts: [],
      acc_previous_payment_records: [], acc_official_receipts: [], mfg_sales_orders: [], sales_invoice_payments: [],
      mfg_sales_order_payments: SWIPES.map((s) => ({
        id: s.id, company_id: CO, so_doc_no: s.so, paid_at: '2026-11-05', amount_sen: s.sen, method: 'installment',
        merchant_provider: s.provider, approval_code: s.code, account_sheet: 'Card terminal', collected_by: null, created_by: null,
      })),
      journal_entries: SWIPES.map((s) => ({ id: `je-${s.id}`, company_id: CO, je_no: s.je, entry_date: '2026-11-05', source_type: 'SOPAY', source_doc_no: s.id, posted: true, reversed: false })),
      journal_entry_lines: SWIPES.flatMap((s) => [
        { journal_entry_id: `je-${s.id}`, company_id: CO, line_no: 1, account_code: s.clearing, debit_sen: s.sen, credit_sen: 0 },
        { journal_entry_id: `je-${s.id}`, company_id: CO, line_no: 2, account_code: '300-0000', debit_sen: 0, credit_sen: s.sen },
      ]),
      v_gl_entries: TRANSFERS.map(([je, so, sen], i) => ({
        line_id: i + 1, company_id: CO, account_code: '310-0020', je_no: je, entry_date: '2026-10-20', source_type: 'SOPAY', source_doc_no: `t${i}`,
        debit_sen: sen, credit_sen: 0, party_name: so, notes: null, reversed: false, reversed_by_je: null, posted: true,
      })),
      ...extra,
    },
    {},
    [
      { table: 'acc_bank_card_settlements', column: 'payment_id', name: 'acc_bank_card_payment_once' },
      { table: 'acc_settlement_matches', column: 'payment_id', name: 'acc_settlement_payment_once' },
    ],
    ['acc_bank_statements', 'acc_bank_statement_lines', 'acc_bank_statement_matches', 'acc_bank_card_settlements', 'acc_settlement_matches', 'acc_settlement_rows'],
  );
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, CO as never);
    c.set('houzsUser' as never, { name: 'Chew', permissions_set: ['scm.payment_voucher.post', 'scm.settlement.reconcile', 'scm.accounting.view'] } as never);
    c.set('allowedCompanyIds' as never, [CO] as never);
    await next();
  });
  app.get('/bank/card-payments', bankCardPayments as never);
  app.post('/bank/lines/:id/match-with-cards', bankLineMatchWithCards as never);
  app.post('/bank/lines/:id/undo', bankLineUndo as never);
  app.get('/settlement/watchlist', settlementWatchlist as never);
  app.post('/settlement/rows/:id/confirm', settlementConfirmRow as never);
  return { app, sb };
}

const post = (app: Hono, path: string, body: Record<string, unknown>) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const ALL_TRANSFERS = TRANSFERS.map(([je]) => je);
const ALL_SWIPES = SWIPES.map((s) => ({ source: 'SOPAY', id: s.id }));
const match = (app: Hono, over: Record<string, unknown> = {}, lineId = 1633) =>
  post(app, `/bank/lines/${lineId}/match-with-cards`, { jeNos: ALL_TRANSFERS, cardPayments: ALL_SWIPES, ...over });

describe('the plan', () => {
  const cards: CardForMatch[] = SWIPES.map((s) => ({ source: 'SOPAY', id: s.id, docNo: s.so, approvalCode: s.code, grossSen: s.sen, clearingAccountCode: s.clearing }));
  const plan = (lineSen: number, entriesSen = 1537100, cs = cards) => planCardMatch({
    lineSen, entries: [{ jeNo: 'E', sen: entriesSen }], cards: cs, bankAccountCode: '310-0020', feeAccountCode: '900-T009', bankRef: 'HC-HPV-2611-052',
  });

  test('RM 26,308.81 = transfers RM 15,371.00 + swipes RM 11,480.00 less RM 542.19 of charges', () => {
    const p = plan(2630881);
    if (!p.ok) throw new Error(p.message);
    expect(p).toMatchObject({ entriesSen: 1537100, cardsSen: 1148000, chargeSen: 54219, bankSen: 1093781, chargePct: 4.72 });
    expect(p.lines.map((l) => [l.accountCode, l.debitSen, l.creditSen])).toEqual([
      ['310-0020', 1093781, 0], ['900-T009', 54219, 0],
      ['326-0010', 0, 399000], ['326-0000', 0, 399000], ['326-0000', 0, 350000],
    ]);
    expect(p.lines[3]!.notes).toBe('2990-SO-2611-017 · approval R21077');
  });

  test('no charge, no charges line', () => {
    const p = plan(1537100 + 1148000);
    expect(p.ok && p.lines.map((l) => l.accountCode)).toEqual(['310-0020', '326-0010', '326-0000', '326-0000']);
  });

  test('the bank paying more than was ticked is never a charge', () => {
    expect(plan(1537100 + 1148000 + 1)).toMatchObject({ ok: false, status: 'bank_got_more' });
  });

  test('a charge past 10% of the card payments is a wrong tick', () => {
    expect(plan(1537100 + 1148000 - 114800)).toMatchObject({ ok: true, chargeSen: 114800 });
    expect(plan(1537100 + 1148000 - 114801)).toMatchObject({ ok: false, status: 'charge_too_big' });
    /* RM 1,544 taken against a RM 3,990 swipe: 61% — refused. */
    expect(plan(154400, 0, [cards[0]!])).toMatchObject({ ok: false, status: 'charge_too_big' });
  });
});

describe('Bank Recon takes the card payments in', () => {
  test('lists them with the charges account, and matches the movement', async () => {
    const { app, sb } = harness();
    const listed = await app.request('/bank/card-payments?to=2026-11-17');
    expect(listed.status).toBe(200);
    const list = (await listed.json()) as { feeAccount: { code: string; name: string }; maxChargePct: number; payments: Array<{ docNo: string }> };
    expect(list.feeAccount).toEqual({ code: '900-T009', name: 'TERMINAL INTEREST CHARGES' });
    expect(list.maxChargePct).toBe(10);
    expect(list.payments.map((p) => p.docNo).sort()).toEqual(['2990-SO-2611-017', '2990-SO-2611-028', '2990-SO-2611-081']);

    const res = await match(app);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { jeNo: string; chargeSen: number; bankSen: number };
    expect(body).toMatchObject({ chargeSen: 54219, bankSen: 1093781 });

    const je = (sb.tables.journal_entries as Row[]).find((e) => e.je_no === body.jeNo)!;
    expect(je).toMatchObject({ source_type: 'SETTLECARD', entry_date: '2026-11-13', posted: true });
    const legs = (sb.tables.journal_entry_lines as Row[]).filter((l) => l.journal_entry_id === je.id);
    const by = (code: string, side: 'debit_sen' | 'credit_sen') => legs.filter((l) => l.account_code === code).reduce((s, l) => s + Number(l[side]), 0);
    expect([by('310-0020', 'debit_sen'), by('900-T009', 'debit_sen'), by('326-0010', 'credit_sen'), by('326-0000', 'credit_sen')]).toEqual([1093781, 54219, 399000, 749000]);

    const matches = (sb.tables.acc_bank_statement_matches as Row[]).filter((m) => m.bank_line_id === 1633);
    expect(matches.reduce((s, m) => s + Number(m.amount_sen), 0)).toBe(2630881);
    expect(matches.map((m) => m.je_no).sort()).toEqual([...ALL_TRANSFERS, body.jeNo].sort());
    expect((sb.tables.acc_bank_statement_lines as Row[]).find((l) => l.id === 1633)).toMatchObject({ state: 'POSTED', posted_je_no: body.jeNo });
    expect((sb.tables.acc_bank_card_settlements as Row[]).map((r) => [r.payment_id, r.gross_sen, r.clearing_account_code, r.je_no]))
      .toEqual(SWIPES.map((s) => [s.id, s.sen, s.clearing, body.jeNo]));

    /* Taken: off Merchant Recon's waiting list, off this one, and locked against edits. */
    const watch = (await (await app.request('/settlement/watchlist?to=2026-11-17')).json()) as { recordedNotArrived: unknown[] };
    expect(watch.recordedNotArrived).toEqual([]);
    const again = (await (await app.request('/bank/card-payments?to=2026-11-17')).json()) as { payments: unknown[] };
    expect(again.payments).toEqual([]);
    expect(await paymentReconciliation(sb as never, CO, 'p017', 'SOPAY')).toEqual({ ok: true, by: { kind: 'bank', jeNo: body.jeNo } });
  });

  test('Undo reverses the journal and puts the card payments back on the list', async () => {
    const { app, sb } = harness();
    const done = (await (await match(app)).json()) as { jeNo: string };
    const res = await post(app, '/bank/lines/1633/undo', {});
    expect(res.status).toBe(200);
    expect((sb.tables.acc_bank_statement_lines as Row[]).find((l) => l.id === 1633)).toMatchObject({ state: 'OPEN', posted_je_no: null });
    expect(sb.tables.acc_bank_card_settlements).toEqual([]);
    expect((sb.tables.acc_bank_statement_matches as Row[]).filter((m) => m.bank_line_id === 1633)).toEqual([]);
    expect((sb.tables.journal_entries as Row[]).find((e) => e.je_no === done.jeNo)).toMatchObject({ reversed: true });
    expect((sb.tables.journal_entries as Row[]).some((e) => e.source_type === 'SETTLECARD_REVERSAL')).toBe(true);
    const list = (await (await app.request('/bank/card-payments?to=2026-11-17')).json()) as { payments: unknown[] };
    expect(list.payments).toHaveLength(3);
    /* And it can be matched again. */
    expect((await match(app)).status).toBe(200);
  });

  test('a merchant report cannot claim a payment the bank took in', async () => {
    const { app, sb } = harness({
      acc_settlement_batches: [{ id: 9, company_id: CO, acquirer_code: 'PBB', file_name: 'pbb.csv', period_from: '2026-11-05', period_to: '2026-11-05', row_count: 1, gross_sen: 399000, fee_sen: 2800, net_sen: 396200, stated_net_sen: null }],
      acc_settlement_rows: [{ id: 91, batch_id: 9, company_id: CO, acquirer_code: 'PBB', line_no: 1, txn_date: '2026-11-05', ref: 'X1', gross_sen: 399000, fee_sen: 2800, net_sen: 396200, bucket: 'NEEDS_CONFIRM', confirmed_at: null, posted_je_no: null, notes: null, not_this: [] }],
    });
    expect((await match(app)).status).toBe(200);
    const res = await post(app, '/settlement/rows/91/confirm', { payments: [{ source: 'SOPAY', id: 'p028', docNo: '2990-SO-2611-028', amountSen: 399000 }] });
    expect(res.status).toBe(409);
    expect(JSON.stringify(await res.json())).toMatch(/taken in by a bank movement/);
    expect(sb.tables.acc_settlement_matches).toEqual([]);
    expect((sb.tables.mfg_sales_order_payments as Row[]).find((p) => p.id === 'p028')!.merchant_provider).toBe('PBB');
  });
});

describe('what is refused, nothing written', () => {
  const nothingWritten = (sb: { tables: Record<string, Row[]> }) => {
    expect(sb.tables.acc_bank_card_settlements).toEqual([]);
    expect(sb.tables.acc_bank_statement_matches).toEqual([]);
    expect((sb.tables.journal_entries as Row[]).some((e) => e.source_type === 'SETTLECARD')).toBe(false);
    expect((sb.tables.acc_bank_statement_lines as Row[]).find((l) => l.id === 1633)!.state).toBe('OPEN');
  };

  test('the bank received more than was ticked', async () => {
    const { app, sb } = harness();
    const res = await match(app, { jeNos: ALL_TRANSFERS.slice(1) });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'bank_got_more' });
    nothingWritten(sb);
  });

  test('a card payment not in the books', async () => {
    const { app, sb } = harness();
    const res = await match(app, { cardPayments: [...ALL_SWIPES, { source: 'SOPAY', id: 'p999' }] });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'payment_not_found' });
    nothingWritten(sb);
  });

  test('a difference past 10% of the swipes', async () => {
    /* A fourth swipe of RM 5,000 ticked by mistake: RM 5,542.19 would be "charges", 33%. */
    const extra = { id: 'p999', so: '2990-SO-2611-200', sen: 500000, je: '2990-JE-2611-0900', clearing: '326-0000', code: null, provider: null };
    const all = [...SWIPES, extra];
    const { app, sb } = harness({
      mfg_sales_order_payments: all.map((s) => ({
        id: s.id, company_id: CO, so_doc_no: s.so, paid_at: '2026-11-05', amount_sen: s.sen, method: 'installment', merchant_provider: s.provider, approval_code: s.code, account_sheet: 'Card terminal',
      })),
      journal_entries: all.map((s) => ({ id: `je-${s.id}`, company_id: CO, je_no: s.je, entry_date: '2026-11-05', source_type: 'SOPAY', source_doc_no: s.id, posted: true, reversed: false })),
      journal_entry_lines: all.flatMap((s) => [
        { journal_entry_id: `je-${s.id}`, company_id: CO, line_no: 1, account_code: s.clearing, debit_sen: s.sen, credit_sen: 0 },
        { journal_entry_id: `je-${s.id}`, company_id: CO, line_no: 2, account_code: '300-0000', debit_sen: 0, credit_sen: s.sen },
      ]),
    });
    const res = await match(app, { cardPayments: [...ALL_SWIPES, { source: 'SOPAY', id: 'p999' }] });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'charge_too_big' });
    nothingWritten(sb);
  });

  test("a merchant's own payout stays with its report", async () => {
    const { app } = harness();
    const res = await match(app, { jeNos: [] }, 1700);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'merchant_money' });
  });

  test('a closed month', async () => {
    const { app, sb } = harness({
      acc_bank_month_locks: [{
        id: 1, company_id: CO, account_code: '310-0020', period_month: '2026-11-01', locked_by: 'Chew', locked_at: '2026-12-01T09:00:00Z',
        lock_note: null, closing_statement_sen: null, closing_ledger_sen: null, difference_sen: null, statement_count: 1, was_complete: true, released_at: null,
      }],
    });
    expect((await match(app)).status).toBe(409);
    nothingWritten(sb);
  });

  test('a payment already on a merchant report', async () => {
    const { app, sb } = harness({
      acc_settlement_matches: [{ id: 5, settlement_row_id: 91, company_id: CO, payment_source: 'SOPAY', payment_id: 'p081', doc_no: '2990-SO-2611-081', amount_sen: 350000 }],
    });
    const res = await match(app);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'payment_on_report' });
    expect(sb.tables.acc_bank_card_settlements).toEqual([]);
  });

  test('an entry another movement of this bank already accounts for', async () => {
    const { app, sb } = harness({
      acc_bank_statement_lines: [{ ...LINE_1633 }, { id: 1500, statement_id: 28, company_id: CO, line_no: 5, booked_on: '2026-10-20', amount_sen: 210000, state: 'POSTED', kind: 'OTHER', reference: 'x', description: 'x' }],
      acc_bank_statement_matches: [{ id: 1, bank_line_id: 1500, company_id: CO, je_no: '2990-JE-2610-0093', amount_sen: 210000, match_reason: 'manual' }],
    });
    const res = await match(app);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'already_matched' });
    expect(sb.tables.acc_bank_card_settlements).toEqual([]);
  });
});
