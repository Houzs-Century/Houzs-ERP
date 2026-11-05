// A bank month whose files print no balance — the closing typed off the bank,
// or carried from the month before (rule 5). Moved out of bankRoutes.test.ts
// when that file reached the 2000-line cap; the same harness shape: a bare Hono
// app whose middleware injects a fake PostgREST client, a company and a set of
// permissions, and the Maybank current account as it is configured for the real
// file.

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { bankUpload } from '../src/scm/routes/accounting-bank';
import { bankMonths, bankMonthDetail, bankMonthClosing } from '../src/scm/routes/accounting-bank-months';
import { bankMonthLock } from '../src/scm/routes/accounting-bank-locks';

const CO = 1;

const CHART: Row[] = ['320-0000', '330-0000', '930-0000'].map((code) => ({
  account_code: code, account_name: code, account_type: 'ASSET', parent_code: null, is_active: true, company_id: CO,
}));

const MBB_ACCOUNT: Row = {
  id: 1, company_id: CO, account_code: '330-0000', bank_code: 'MBB',
  account_no: '0000564418610346', statement_format: 'CSV', delimiter: '|',
  amount_format: 'integer-sen', credit_indicator: 'CR', is_active: true,
  column_map: {
    date: 'EFFECT DATE', description: 'TRX DESCRIPTION', reference: 'TRX REFERENCE',
    amount: 'AMOUNT', indicator: 'AMOUNT IND',
  },
};

const RULES: Row[] = [
  { id: 1, acquirer_code: 'MBB', pattern: 'CARD SALES', match_field: 'both', trading_date_pattern: 'DATED\\s*(\\d{8})', merchant_pattern: 'M/?N\\s*(\\d+)', sort_order: 10, is_active: true },
];

const ACQ: Row = {
  company_id: CO, code: 'MBB', display_name: 'MBB',
  transit_account_code: '320-0000', fee_account_code: '930-0000', bank_account_code: '330-0000',
  statement_format: 'CSV', has_unique_ref: true, fee_method: 'stated',
  date_tolerance_days: 3, is_active: true, column_map: {},
};

const HEAD = 'BATCH DATE|ACCOUNT NO.|PROD TYPE|EFFECT DATE|EFFECT TIME|BRANCH|TELLER|CODE|SOURCE CODE|AMOUNT|AMOUNT IND|TRX DESCRIPTION|TRX REFERENCE';
const row = (date: string, sen: string, ind: string, desc: string, ref: string) =>
  `${date}|0000564418610346|CA|${date}|103009|2988|CEB4PHON|7610|003|${sen}|${ind}|${desc}|${ref}`;

/* Two card credits and one customer transfer — the mix every real statement is. */
const STATEMENT = [
  HEAD,
  row('20260803', '000000000728448', 'CR', 'CR/CARD SALES MN 32410011 DATED 31072026', '00113107'),
  row('20260803', '000000000171000', 'CR', 'LAU LEE YEN        *', 'Jaslyn'),
  row('20260809', '000000000087500', 'CR', 'DR/CARD SALES M/N 2259020 DATED 08082026', 'D90200808'),
  row('20260809', '000000000000394', 'DR', 'DR/CARD SALES M/N 2259020 DATED 08082026', 'D90200808'),
  row('20260812', '000000000002500', 'DR', 'SERVICE CHARGE', 'BCHARGE1'),
].join('\n');

const LOCK = (month: string, over: Row = {}): Row => ({
  id: 1, company_id: CO, account_code: '330-0000', period_month: `${month}-01`,
  locked_by: 'Chew', locked_at: '2026-10-02T03:14:00Z', lock_note: null,
  closing_statement_sen: null, closing_ledger_sen: null, difference_sen: null,
  statement_count: 3, was_complete: true, released_at: null, ...over,
});

function harness() {
  const sb = fakeSb(
    {
      accounts: CHART, acc_account_roles: [],
      acc_acquirers: [ACQ], acc_acquirer_config: [], acc_company_acquirers: [],
      acc_bank_statement_config: [MBB_ACCOUNT],
      acc_bank_recognition_rules: RULES,
      acc_bank_statements: [], acc_bank_statement_lines: [], acc_bank_statement_matches: [],
      acc_bank_month_balances: [],
      acc_settlement_batches: [], acc_settlement_rows: [], acc_settlement_matches: [], acc_settlement_receipts: [],
      journal_entries: [], journal_entry_lines: [], v_gl_entries: [],
    },
    {},
    [{ table: 'acc_bank_statements', column: 'file_hash', name: 'acc_bank_stmt_once' }],
    ['acc_bank_statements', 'acc_bank_statement_lines', 'acc_bank_statement_matches', 'acc_bank_month_balances',
      'acc_settlement_batches', 'acc_settlement_rows', 'acc_settlement_matches', 'acc_settlement_receipts'],
  );
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, CO as never);
    c.set('houzsUser' as never, { name: 'Tester', permissions_set: ['scm.payment_voucher.post'] } as never);
    c.set('allowedCompanyIds' as never, [1, 2] as never);
    await next();
  });
  app.post('/bank/statements', bankUpload as never);
  app.get('/bank/months', bankMonths as never);
  app.get('/bank/months/:accountCode/:month', bankMonthDetail as never);
  app.post('/bank/months/:accountCode/:month/lock', bankMonthLock as never);
  app.post('/bank/months/:accountCode/:month/closing', bankMonthClosing as never);
  return { app, sb };
}

const post = (app: Hono, path: string, body: Record<string, unknown> = {}) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const upload = (app: Hono, over: Record<string, unknown> = {}) =>
  post(app, '/bank/statements', { accountCode: '330-0000', fileName: 'aug.csv', content: STATEMENT, ...over });

describe('a month whose files print no balance, with the closing typed', () => {
  const typed = (app: Hono, month: string, body: Record<string, unknown>) =>
    post(app, `/bank/months/330-0000/${month}/closing`, body);
  const august = async (app: Hono) => (await (await app.request('/bank/months/330-0000/2026-08')).json()) as any;

  test('until something is typed the month has no figure to tally against, and says what to type', async () => {
    const { app } = harness();
    await upload(app);
    const body = await august(app);
    expect(body.assembly.statementOpeningSen).toBeNull();
    expect(body.assembly.statementClosingSen).toBeNull();
    expect(body.assembly.complete).toBe(false);
    expect(body.assembly.gaps.join(' ')).toContain('Type it off the bank');
    expect(body.assembly.gaps.join(' ')).toContain('Type the closing balance of 2026-07');
    expect(body.balances).toEqual({ closing: null, previousClosing: null, previousPrinted: null });
  });

  test('the previous month\'s closing opens the month, its own closes it, and the month is whole when they meet', async () => {
    const { app, sb } = harness();
    await upload(app);
    /* What the upload made of the five lines: the credit and its charge are one. */
    const moved = (await august(app)).reconciliation.movementsStatementSen as number;
    expect(moved).toBe(728448 + 171000 + (87500 - 394) - 2500);

    expect((await typed(app, '2026-07', { closingSen: 1000000 })).status).toBe(200);
    const res = await typed(app, '2026-08', { closingSen: 1000000 + moved, note: 'per the August e-statement' });
    expect(res.status).toBe(200);
    expect((await res.json() as any).balance).toMatchObject({
      month: '2026-08', closingSen: 1000000 + moved, typedBy: 'Tester', note: 'per the August e-statement',
    });
    expect(sb.tables.acc_bank_month_balances).toHaveLength(2);

    const body = await august(app);
    expect(body.assembly.statementOpeningSen).toBe(1000000);
    expect(body.assembly.openingFrom).toMatchObject({ statementId: null, fileName: null, on: '2026-07-31', typed: { month: '2026-07', by: 'Tester' } });
    expect(body.assembly.statementClosingSen).toBe(1000000 + moved);
    expect(body.assembly.closingFrom).toMatchObject({ on: '2026-08-31', typed: { month: '2026-08', note: 'per the August e-statement' } });
    expect(body.assembly.gaps).toEqual([]);
    expect(body.assembly.complete).toBe(true);
    /* The reconciliation tallies against the typed figure, and the screen
       gets the stored rows too. */
    expect(body.reconciliation.closingStatementSen).toBe(1000000 + moved);
    expect(body.balances.closing).toMatchObject({ closingSen: 1000000 + moved });
    expect(body.balances.previousClosing).toMatchObject({ month: '2026-07', closingSen: 1000000 });

    /* And the list says so without opening the month. */
    const months = (await (await app.request('/bank/months')).json() as any).months as any[];
    expect(months.find((m) => m.accountCode === '330-0000' && m.month === '2026-08'))
      .toMatchObject({ complete: true, openingBalanceSen: 1000000, closingBalanceSen: 1000000 + moved, gapCount: 0 });
  });

  /* Rule 5 (owner 2026-11-03: 「不能9月close了就直接带bank balance过来吗」): the
     previous month's closing as its own file PRINTED it opens the month — no
     typing, on the month's page and on the list alike. */
  test("the previous month's printed closing opens a month whose files print none", async () => {
    const { app, sb } = harness();
    await upload(app);
    const moved = (await august(app)).reconciliation.movementsStatementSen as number;
    (sb.tables.acc_bank_statements as Row[]).push({
      id: 9001, company_id: CO, account_code: '330-0000', file_name: 'MBB-july.pdf', period_from: '2026-07-01', period_to: '2026-07-31',
      line_count: 0, in_sen: 0, out_sen: 0, opening_balance_sen: 990000, closing_balance_sen: 1000000, status: 'OPEN',
      uploaded_by: 'Tester', created_at: '2026-08-01T00:00:00Z',
    });
    expect((await typed(app, '2026-08', { closingSen: 1000000 + moved })).status).toBe(200);

    const body = await august(app);
    expect(body.assembly.statementOpeningSen).toBe(1000000);
    expect(body.assembly.openingFrom).toMatchObject({ statementId: 9001, fileName: 'MBB-july.pdf', on: '2026-07-31', carried: { month: '2026-07' } });
    expect(body.assembly.gaps).toEqual([]);
    expect(body.assembly.complete).toBe(true);
    expect(body.balances.previousPrinted).toMatchObject({ month: '2026-07', closingSen: 1000000, statementId: 9001 });

    const months = (await (await app.request('/bank/months')).json() as any).months as any[];
    expect(months.find((m) => m.accountCode === '330-0000' && m.month === '2026-08'))
      .toMatchObject({ complete: true, openingBalanceSen: 1000000, gapCount: 0 });
  });

  test('a typed closing the movements do not reach leaves the month not whole, naming the shortfall', async () => {
    const { app } = harness();
    await upload(app);
    const moved = (await august(app)).reconciliation.movementsStatementSen as number;
    await typed(app, '2026-07', { closingSen: 1000000 });
    await typed(app, '2026-08', { closingSen: 1000000 + moved - 12345 });
    const body = await august(app);
    expect(body.assembly.complete).toBe(false);
    expect(body.assembly.gaps.join(' ')).toContain('RM 123.45 is unaccounted for');
    /* The lock reads the same assembly, so it refuses too — on the same ground. */
    const lock = await post(app, '/bank/months/330-0000/2026-08/lock', {});
    expect(lock.status).toBe(409);
  });

  test('typing again replaces the figure; clearing removes it', async () => {
    const { app, sb } = harness();
    await typed(app, '2026-08', { closingSen: 100 });
    await typed(app, '2026-08', { closingSen: 200, note: 'corrected' });
    expect(sb.tables.acc_bank_month_balances).toHaveLength(1);
    expect(sb.tables.acc_bank_month_balances[0]).toMatchObject({ closing_sen: 200, note: 'corrected', period_month: '2026-08-01' });
    const res = await typed(app, '2026-08', { closingSen: null });
    expect(res.status).toBe(200);
    expect((await res.json() as any).balance).toBeNull();
    expect(sb.tables.acc_bank_month_balances).toHaveLength(0);
  });

  test('refuses a figure that is not whole sen, an account nobody reconciles, and a month that is closed', async () => {
    const { app, sb } = harness();
    expect((await typed(app, '2026-08', { closingSen: 12.5 })).status).toBe(400);
    expect((await typed(app, 'August', { closingSen: 100 })).status).toBe(400);
    const stray = await post(app, '/bank/months/999-0000/2026-08/closing', { closingSen: 100 });
    expect(stray.status).toBe(400);
    expect((await stray.json() as any).message).toMatch(/330-0000 \(MBB\)/);

    sb.tables.acc_bank_month_locks = [LOCK('2026-08')];
    const closed = await typed(app, '2026-08', { closingSen: 100 });
    expect(closed.status).toBe(409);
    expect((await closed.json() as any).error).toBe('month_locked');
    /* July's closing is what August opens at: while August is closed, July's
       figure cannot move either. */
    const before = await typed(app, '2026-07', { closingSen: 100 });
    expect(before.status).toBe(409);
    expect((await before.json() as any).message).toContain('2026-08');
    expect(sb.tables.acc_bank_month_balances).toHaveLength(0);
  });
});
