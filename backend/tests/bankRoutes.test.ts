// The bank reconciliation endpoints, through the same harness shape as
// settlementRoutes.test.ts: a bare Hono app whose middleware injects a fake
// PostgREST client, a company and a set of permissions.
//
// What is pinned here is what a screen and a ledger depend on:
//   • the permission gate answers 403 at THIS end too (前后端各检查一次);
//   • a statement uploaded against the WRONG ACCOUNT is refused — the one
//     mistake in this module that produces a clean-looking wrong answer;
//   • the same file twice is refused, not doubled;
//   • an upload recognises the acquirer credits and leaves the rest alone;
//   • booking a credit goes through LAYER 3's postBatchReceipt, so there is one
//     notion of "the acquirer paid us" and one place that books it;
//   • undo REVERSES rather than deletes, and the money goes back where it was;
//   • one journal entry cannot be reconciled against two bank movements.

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import {
  bankSetup, bankUpload, bankStatements, bankStatementDetail,
  bankLineReceipt, bankLineMatch, bankLineIgnore, bankLineUndo,
  bankRulesList, bankRuleCreate, bankRuleUpdate,
  bankLinesMatchGroup, bankStatementPeriod, bankStatementAutoMatch,
} from '../src/scm/routes/accounting-bank';
import { bankConfigList, bankConfigSave } from '../src/scm/routes/accounting-bank-config';
import { bankMonths, bankMonthDetail } from '../src/scm/routes/accounting-bank-months';
import { bankMonthLock } from '../src/scm/routes/accounting-bank-locks';
/* Layer 3's own undo is registered on this rig too: it can reverse an entry a
   closed bank month has already reported, so it is a door into the same room
   and is guarded by the same lock. */
import { settlementReceiptUndo } from '../src/scm/routes/accounting-settlement';

const CO = 1;
const GL_PERM = 'scm.payment_voucher.post';

const CHART: Row[] = ['320-0000', '330-0000', '930-0000'].map((code) => ({
  account_code: code, account_name: code, account_type: 'ASSET', parent_code: null, is_active: true, company_id: CO,
}));

/* The Maybank current account exactly as it is configured for the real file:
   pipe delimited, integer sen, CR/DR in its own column. */
const MBB_ACCOUNT: Row = {
  id: 1, company_id: CO, account_code: '330-0000', bank_code: 'MBB',
  account_no: '0000564418610346', statement_format: 'CSV', delimiter: '|',
  amount_format: 'integer-sen', credit_indicator: 'CR', is_active: true,
  column_map: {
    date: 'EFFECT DATE', description: 'TRX DESCRIPTION', reference: 'TRX REFERENCE',
    amount: 'AMOUNT', indicator: 'AMOUNT IND',
  },
};

/* Hong Leong, the shape the owner's 2990 account actually sends (docs/bugs/0794). */
const HLB_ACCOUNT: Row = {
  id: 2, company_id: CO, account_code: '310-0020', bank_code: 'HLB',
  account_no: '23600600000', statement_format: 'CSV', delimiter: null,
  amount_format: 'decimal', credit_indicator: 'CR', is_active: true,
  column_map: {
    date: ['Date', 'Transaction Date'], description: ['Transaction Description', 'Remarks'],
    reference: ['Ref. No.'], debit: ['Withdrawal'], credit: ['Deposit'], balance: ['Balance'],
  },
};
/* March: the account opened in February at RM 3,000.00 and nothing moved. */
const HLB_EMPTY_MARCH = [
  'HLB PRIMEBIZ CURRENT ACCOUNT - 23600600000,',
  'Date,Transaction Description,Cheque No.,Ref. No.,Deposit,Withdrawal,Balance',
  '="",="Balance from previous statement",="",="",="",="",="3000.00"',
].join('\n');

const RULES: Row[] = [
  { id: 1, acquirer_code: 'MBB', pattern: 'CARD SALES', match_field: 'both', trading_date_pattern: 'DATED\\s*(\\d{8})', merchant_pattern: 'M/?N\\s*(\\d+)', sort_order: 10, is_active: true },
  { id: 2, acquirer_code: 'AEON', pattern: 'AEON CREDIT SERVICE', match_field: 'both', trading_date_pattern: null, merchant_pattern: null, sort_order: 30, is_active: true },
];

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

/* A reconciled merchant statement owed exactly what the first credit pays. */
const BATCH: Row = {
  id: 1, company_id: CO, acquirer_code: 'MBB', file_name: 'mbb-0731.csv',
  period_from: '2026-07-31', period_to: '2026-07-31',
  net_sen: 728448, stated_net_sen: null, adjustment_sen: 0, status: 'OPEN',
};
const CONFIRMED_ROW: Row = {
  id: 1, batch_id: 1, company_id: CO, acquirer_code: 'MBB', line_no: 1,
  txn_date: '2026-07-31', gross_sen: 740000, fee_sen: 11552, net_sen: 728448,
  bucket: 'MATCHED', confirmed_at: '2026-08-01T00:00:00Z',
};

const ACQ: Row = {
  company_id: CO, code: 'MBB', display_name: 'MBB',
  transit_account_code: '320-0000', fee_account_code: '930-0000', bank_account_code: '330-0000',
  statement_format: 'CSV', has_unique_ref: true, fee_method: 'stated',
  date_tolerance_days: 3, is_active: true, column_map: {},
};

function harness(tables: Record<string, Row[]> = {}, perms: readonly string[] = [GL_PERM]) {
  const sb = fakeSb(
    {
      accounts: CHART, acc_account_roles: [],
      acc_acquirers: [ACQ], acc_acquirer_config: [], acc_company_acquirers: [],
      acc_bank_statement_config: [MBB_ACCOUNT],
      acc_bank_recognition_rules: RULES,
      acc_bank_statements: [], acc_bank_statement_lines: [], acc_bank_statement_matches: [],
      acc_settlement_batches: [], acc_settlement_rows: [], acc_settlement_matches: [], acc_settlement_receipts: [],
      journal_entries: [], journal_entry_lines: [], v_gl_entries: [],
      ...tables,
    },
    {},
    [
      { table: 'acc_bank_statements', column: 'file_hash', name: 'acc_bank_stmt_once' },
      /* Since docs/bugs/0803 the index is (company, je_no, bank_line_id): an
         entry may be paid by several movements, and the ROUTE is what refuses
         a second claim on an entry another movement already accounts for. */
    ],
    /* Integer ids, or SETTLEBANK-<batch>-<receipt> keys off a 'row-1' string
       become NaN and the second credit silently collides with the first — the
       bug layer 3 hit on this same rig. */
    ['acc_bank_statements', 'acc_bank_statement_lines', 'acc_bank_statement_matches',
      'acc_settlement_batches', 'acc_settlement_rows', 'acc_settlement_matches', 'acc_settlement_receipts'],
  );
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, CO as never);
    c.set('houzsUser' as never, { name: 'Tester', permissions_set: perms } as never);
    c.set('allowedCompanyIds' as never, [1, 2] as never);
    await next();
  });
  app.get('/bank/setup', bankSetup as never);
  app.post('/bank/statements', bankUpload as never);
  app.get('/bank/statements', bankStatements as never);
  app.get('/bank/statements/:id', bankStatementDetail as never);
  app.post('/bank/lines/:id/receipt', bankLineReceipt as never);
  app.post('/bank/lines/:id/match', bankLineMatch as never);
  app.post('/bank/lines/:id/ignore', bankLineIgnore as never);
  app.post('/bank/lines/:id/undo', bankLineUndo as never);
  app.post('/bank/lines/match-group', bankLinesMatchGroup as never);
  app.post('/bank/statements/:id/period', bankStatementPeriod as never);
  app.post('/bank/statements/:id/auto-match', bankStatementAutoMatch as never);
  app.get('/bank/rules', bankRulesList as never);
  app.post('/bank/rules', bankRuleCreate as never);
  app.patch('/bank/rules/:id', bankRuleUpdate as never);
  app.post('/settlement/receipts/:id/undo', settlementReceiptUndo as never);
  app.get('/bank/months', bankMonths as never);
  app.get('/bank/months/:accountCode/:month', bankMonthDetail as never);
  app.post('/bank/months/:accountCode/:month/lock', bankMonthLock as never);
  return { app, sb };
}

const post = (app: Hono, path: string, body: Record<string, unknown> = {}) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const upload = (app: Hono, over: Record<string, unknown> = {}) =>
  post(app, '/bank/statements', { accountCode: '330-0000', fileName: 'aug.csv', content: STATEMENT, ...over });

describe('the permission gate answers at this end too', () => {
  test('every endpoint refuses without the GL key', async () => {
    const { app } = harness({}, []);
    for (const [method, path] of [
      ['GET', '/bank/setup'], ['GET', '/bank/statements'], ['GET', '/bank/statements/1'],
      ['POST', '/bank/statements'], ['POST', '/bank/lines/1/receipt'],
      ['POST', '/bank/lines/1/match'], ['POST', '/bank/lines/1/ignore'], ['POST', '/bank/lines/1/undo'],
    ] as const) {
      const res = method === 'GET' ? await app.request(path) : await post(app, path);
      expect(res.status, `${method} ${path}`).toBe(403);
    }
  });
});

describe('uploading a statement', () => {
  test('reads it, joins the split payout, and recognises only the card credits', async () => {
    const { app } = harness();
    const res = await upload(app);
    expect(res.status).toBe(200);
    const body = await res.json() as any;

    /* Five lines in, four movements out: the credit and its charge are one. */
    expect(body.lines).toBe(4);
    expect(body.joinedPairs).toBe(1);
    expect(body.periodFrom).toBe('2026-08-03');
    expect(body.periodTo).toBe('2026-08-12');
    /* Nothing is owed yet, so both card credits are payouts with no batch —
       and the customer transfer is not a payout at all. */
    expect(body.kinds.PAYOUT_NO_BATCH).toBe(2);
    expect(body.kinds.OTHER).toBe(2);
  });

  test('claims the reconciled statement that is owed exactly that credit', async () => {
    const { app } = harness({ acc_settlement_batches: [BATCH], acc_settlement_rows: [CONFIRMED_ROW] });
    const body = await (await upload(app)).json() as any;
    expect(body.kinds.PAYOUT).toBe(1);
  });

  /* THE MISTAKE THAT LOOKS CLEAN. Every number computes; the answer is about
     somebody else's money. */
  test('refuses a file that does not mention the account it was uploaded against', async () => {
    const { app } = harness();
    const res = await upload(app, { content: STATEMENT.replace(/0000564418610346/g, '0000999999999999') });
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toBe('wrong_account');
    expect(body.message).toMatch(/0000564418610346/);
  });

  test('refuses the same file twice rather than doubling the movements', async () => {
    const { app } = harness();
    expect((await upload(app)).status).toBe(200);
    const again = await upload(app);
    expect(again.status).toBe(409);
    expect((await again.json() as any).error).toBe('already_uploaded');
  });

  test('refuses a file it cannot read, naming the heading it wanted', async () => {
    const { app } = harness();
    /* Carries the right account number, so the account guard passes and it is
       the READER that has to refuse it. */
    const res = await upload(app, {
      content: 'ACCOUNT NO.|0000564418610346\nInvoice No|Customer|Total\nINV-1|Ali|100.00',
    });
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toBe('unreadable_statement');
    expect(body.message).toMatch(/EFFECT DATE/);
  });

  test('names the accounts that ARE configured when the chosen one is not', async () => {
    const { app } = harness();
    const res = await upload(app, { accountCode: '999-0000' });
    expect(res.status).toBe(400);
    expect((await res.json() as any).message).toMatch(/330-0000 \(MBB\)/);
  });
});

/* ── A month in which nothing moved ──────────────────────────────────────────
   Owner, 2026-09-10: 我应该每一个月都要做 bank reconciliation 不是？没有
   transaction 那么你就让我锁起来. March's Hong Leong export is one balance row
   and nothing under it; the screen refused the file and the month could never
   be closed, so the chain of closed months broke on March (docs/bugs/0794). */
describe('a month with no bank movement', () => {
  const quiet = () => harness({
    acc_bank_statement_config: [MBB_ACCOUNT, HLB_ACCOUNT],
    /* The books: RM 3,000.00 paid in during February, nothing since. */
    v_gl_entries: [{ company_id: CO, account_code: '310-0020', je_no: 'JE-2602-0001', entry_date: '2026-02-07', source_type: 'PV', source_doc_no: 'HPV-2602-028', debit_sen: 300000, credit_sen: 0, notes: null }],
  });
  const empty = (app: Hono, over: Record<string, unknown> = {}) =>
    post(app, '/bank/statements', { accountCode: '310-0020', fileName: 'acs_23600600000_31032026.csv', content: HLB_EMPTY_MARCH, ...over });

  test('an empty file with no month named is refused with what to do', async () => {
    const { app, sb } = quiet();
    const res = await empty(app);
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toBe('unreadable_statement');
    expect(body.message).toMatch(/year and month/i);
    expect(sb.tables.acc_bank_statements).toHaveLength(0);
  });

  test('filed under its month, it is a statement of zero movements at the balance it prints', async () => {
    const { app, sb } = quiet();
    const res = await empty(app, { statementMonth: '2026-03' });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.lines).toBe(0);
    expect(body.periodFrom).toBe('2026-03-01');
    expect(body.periodTo).toBe('2026-03-31');
    expect(body.openingBalanceSen).toBe(300000);
    expect(body.closingBalanceSen).toBe(300000);
    expect(sb.tables.acc_bank_statements).toHaveLength(1);
    expect(sb.tables.acc_bank_statements[0]).toMatchObject({ line_count: 0, period_from: '2026-03-01', period_to: '2026-03-31' });
    expect(sb.tables.acc_bank_statement_lines).toHaveLength(0);
  });

  test('the month list shows it, complete, with the bank and the books agreeing', async () => {
    const { app } = quiet();
    await empty(app, { statementMonth: '2026-03' });
    const months = (await (await app.request('/bank/months')).json() as any).months as any[];
    const march = months.find((m) => m.accountCode === '310-0020' && m.month === '2026-03');
    expect(march).toBeTruthy();
    expect(march).toMatchObject({ statementCount: 1, lineCount: 0, openCount: 0, complete: true, closingBalanceSen: 300000, gapCount: 0 });
  });

  test('and it closes like any other reconciled month', async () => {
    const { app, sb } = quiet();
    await empty(app, { statementMonth: '2026-03' });
    const res = await post(app, '/bank/months/310-0020/2026-03/lock', {});
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.lock).toMatchObject({ differenceSen: 0, statementCount: 1, wasComplete: true });
    expect(sb.tables.acc_bank_month_locks).toHaveLength(1);
  });

  /* Filed under a month whose books say otherwise, the quiet file does not
     tally — the balance it printed is the check — and the month cannot close
     (docs/bugs/0806: no reason buys a way past). */
  test('filed under the wrong month, the balance gives it away and the month cannot close', async () => {
    const { app } = quiet();
    await empty(app, { statementMonth: '2026-01' });
    const res = await post(app, '/bank/months/310-0020/2026-01/lock', {});
    expect(res.status).toBe(409);
    const body = await res.json() as any;
    expect(body.error).toBe('not_tallied');
    expect(body.message).toContain('RM 3,000.00');
  });

  test('a month nobody filed a statement for cannot be closed', async () => {
    const { app } = quiet();
    const res = await post(app, '/bank/months/310-0020/2026-03/lock', {});
    expect(res.status).toBe(409);
    const body = await res.json() as any;
    expect(body.error).toBe('empty_month');
    expect(body.message).toMatch(/no statement/);
  });
});

/* ── Books ± outstanding items = bank (docs/bugs/0806) ──────────────────────
   Owner, 2026-09-11: a month whose only difference is a payment the bank has
   not paid yet is reconciled and closes; a month whose bank closing the books
   and the listed items cannot reach cannot close. And an old file uploaded
   before the month box covered a month can be re-filed as the month's
   statement without re-uploading (这只是显示问题吧). */
describe('a month with an outstanding payment', () => {
  /* Hong Leong, April: the account holds RM 3,000; TNB RM 161 posted on the
     28th and paid on the 30th; HPV-007 RM 3,101.68 posted on the 30th and not
     paid by the bank until May. */
  const HLB_APRIL = [
    'HLB PRIMEBIZ CURRENT ACCOUNT - 23600600000,',
    'Date,Transaction Description,Cheque No.,Ref. No.,Deposit,Withdrawal,Balance',
    '="",="Balance from previous statement",="",="",="",="",="3000.00"',
    '="30-04-2026",="JomPAY Bill Payment at DIO",="",="TENAGA NASIONAL BERHAD",="",="161.00",="2839.00"',
  ].join('\n');
  const april = () => harness({
    acc_bank_statement_config: [MBB_ACCOUNT, HLB_ACCOUNT],
    v_gl_entries: [
      { company_id: CO, account_code: '310-0020', je_no: 'JE-2602-0001', entry_date: '2026-02-07', source_type: 'PV', source_doc_no: 'HPV-2602-028', debit_sen: 300000, credit_sen: 0, notes: null },
      { company_id: CO, account_code: '310-0020', je_no: 'JE-2604-0022', entry_date: '2026-04-28', source_type: 'PV', source_doc_no: 'HPV-2604-005', debit_sen: 0, credit_sen: 16100, party_name: 'TENAGA NASIONAL BERHAD', notes: null },
      { company_id: CO, account_code: '310-0020', je_no: 'JE-2604-0024', entry_date: '2026-04-30', source_type: 'PV', source_doc_no: 'HPV-2604-007', debit_sen: 0, credit_sen: 310168, party_name: 'HOUZS VENTURE HOLDING SDN BHD', notes: null },
    ],
  });
  const filed = async (app: Hono) => {
    const up = await (await post(app, '/bank/statements', { accountCode: '310-0020', fileName: 'acs_23600600000_30042026.csv', content: HLB_APRIL, statementMonth: '2026-04' })).json() as any;
    const detail = await (await app.request(`/bank/statements/${up.statementId}`)).json() as any;
    const tnb = detail.lines.find((l: any) => Number(l.amount_sen) === -16100);
    expect((await post(app, `/bank/lines/${tnb.id}/match`, { jeNo: 'JE-2604-0022' })).status).toBe(200);
    return up.statementId as number;
  };

  test('the statement lays the books, the outstanding item and the bank out, and tallies', async () => {
    const { app } = april();
    const id = await filed(app);
    const detail = await (await app.request(`/bank/statements/${id}`)).json() as any;
    const r = detail.reconciliation;
    expect(r.closingLedgerSen).toBe(300000 - 16100 - 310168);
    expect(r.outstandingPayments).toEqual({ count: 1, sen: -310168 });
    expect(r.computedClosingSen).toBe(283900);
    expect(r.closingStatementSen).toBe(283900);
    expect(r.tallies).toBe(true);
    expect(r.reconciled).toBe(true);
    expect((detail.unmatchedEntries as any[]).map((e) => e.jeNo)).toEqual(['JE-2604-0024']);
  });

  test('and the month closes without a word of excuse', async () => {
    const { app, sb } = april();
    await filed(app);
    const res = await post(app, '/bank/months/310-0020/2026-04/lock', {});
    expect(res.status).toBe(200);
    expect(sb.tables.acc_bank_month_locks[0]).toMatchObject({ difference_sen: 310168, was_complete: true, lock_note: null });
  });

  /* An entry the books name NOBODY for is not obvious, so the movement waits
     for a hand (docs/bugs/0814) — and the month stays open. */
  test('a movement still to decide keeps the month open', async () => {
    const { app } = harness({
      acc_bank_statement_config: [MBB_ACCOUNT, HLB_ACCOUNT],
      v_gl_entries: [
        { company_id: CO, account_code: '310-0020', je_no: 'JE-2602-0001', entry_date: '2026-02-07', source_type: 'PV', source_doc_no: 'HPV-2602-028', debit_sen: 300000, credit_sen: 0, notes: null },
        { company_id: CO, account_code: '310-0020', je_no: 'JE-2604-0022', entry_date: '2026-04-28', source_type: 'PV', source_doc_no: 'HPV-2604-005', debit_sen: 0, credit_sen: 16100, party_name: null, notes: null },
      ],
    });
    const up = await (await post(app, '/bank/statements', { accountCode: '310-0020', fileName: 'acs_23600600000_30042026.csv', content: HLB_APRIL, statementMonth: '2026-04' })).json() as any;
    expect(up.lines).toBe(1);
    expect(up.autoMatched).toBe(0);
    const res = await post(app, '/bank/months/310-0020/2026-04/lock', {});
    expect(res.status).toBe(409);
    expect((await res.json() as any).error).toBe('still_open');
  });
});

describe('re-filing an old statement as its month\'s', () => {
  test('sets the period to the whole month without touching the movements', async () => {
    const { app, sb } = harness();
    const up = await (await upload(app)).json() as any;
    expect(sb.tables.acc_bank_statements[0]).toMatchObject({ period_from: '2026-08-03', period_to: '2026-08-12' });
    const res = await post(app, `/bank/statements/${up.statementId}/period`, { month: '2026-08' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, periodFrom: '2026-08-01', periodTo: '2026-08-31' });
    expect(sb.tables.acc_bank_statements[0]).toMatchObject({ period_from: '2026-08-01', period_to: '2026-08-31' });
    expect(sb.tables.acc_bank_statement_lines).toHaveLength(4);
  });

  test('refuses a month the file\'s movements do not fall in, and names the date', async () => {
    const { app, sb } = harness();
    const up = await (await upload(app)).json() as any;
    const res = await post(app, `/bank/statements/${up.statementId}/period`, { month: '2026-07' });
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toBe('month_mismatch');
    expect(body.message).toContain('2026-08-03');
    expect(sb.tables.acc_bank_statements[0]).toMatchObject({ period_from: '2026-08-03' });
  });

  test('refuses when the month is closed', async () => {
    const { app, sb } = harness();
    const up = await (await upload(app)).json() as any;
    sb.tables.acc_bank_month_locks = [LOCK('2026-08')];
    const res = await post(app, `/bank/statements/${up.statementId}/period`, { month: '2026-08' });
    expect(res.status).toBe(409);
    expect((await res.json() as any).error).toBe('month_locked');
  });
});

describe('booking a credit against the merchant statement it pays', () => {
  const ready = () => harness({ acc_settlement_batches: [BATCH], acc_settlement_rows: [CONFIRMED_ROW] });

  const firstPayout = async (app: Hono, statementId: number) => {
    const detail = await (await app.request(`/bank/statements/${statementId}`)).json() as any;
    return detail.lines.find((l: any) => l.kind === 'PAYOUT');
  };

  test('posts through layer 3, on the BANK date, for the BANK amount', async () => {
    const { app, sb } = ready();
    const up = await (await upload(app)).json() as any;
    const line = await firstPayout(app, up.statementId);
    expect(line).toBeTruthy();

    const res = await post(app, `/bank/lines/${line.id}/receipt`, { batchId: 1 });
    expect(res.status).toBe(200);

    /* One receipt, carrying the date and the reference off the statement —
       nobody retyped either. */
    const receipts = sb.tables.acc_settlement_receipts as Row[];
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.received_on).toBe('2026-08-03');
    expect(receipts[0]!.amount_sen).toBe(728448);
    expect(receipts[0]!.bank_ref).toBe('00113107');
  });

  test('a second attempt on the same movement is refused, not doubled', async () => {
    const { app } = ready();
    const up = await (await upload(app)).json() as any;
    const line = await firstPayout(app, up.statementId);
    expect((await post(app, `/bank/lines/${line.id}/receipt`, { batchId: 1 })).status).toBe(200);
    const again = await post(app, `/bank/lines/${line.id}/receipt`, { batchId: 1 });
    expect(again.status).toBe(409);
    expect((await again.json() as any).error).toBe('not_open');
  });

  test('undo REVERSES the entry and puts the movement back', async () => {
    const { app, sb } = ready();
    const up = await (await upload(app)).json() as any;
    const line = await firstPayout(app, up.statementId);
    await post(app, `/bank/lines/${line.id}/receipt`, { batchId: 1 });

    const res = await post(app, `/bank/lines/${line.id}/undo`);
    expect(res.status).toBe(200);
    /* The receipt is gone and a CONTRA entry exists — the way out of the
       ledger is a journal, never a delete. */
    expect(sb.tables.acc_settlement_receipts).toHaveLength(0);
    const sources = (sb.tables.journal_entries as Row[]).map((j) => j.source_type);
    expect(sources).toContain('SETTLEBANK_REVERSAL');
  });

  test('will not book a movement that takes money OUT', async () => {
    const { app } = ready();
    const up = await (await upload(app)).json() as any;
    const detail = await (await app.request(`/bank/statements/${up.statementId}`)).json() as any;
    /* The standalone SERVICE CHARGE debit — money leaving the account. Nothing
       about it can be a merchant paying us, whatever batch is named. */
    const out = detail.lines.find((l: any) => Number(l.amount_sen) < 0);
    expect(out).toBeTruthy();
    const res = await post(app, `/bank/lines/${out.id}/receipt`, { batchId: 1 });
    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toBe('not_a_receipt');
  });
});

/* ── Undo must let go of the entry ────────────────────────────────────────────
   Owner, 2026-09-11, after undoing six matched payments on April's Hong Leong
   statement: the screen went red — "These numbers do not add up" — and the six
   could not be matched again. Undo had put the lines back to OPEN and left
   their rows in acc_bank_statement_matches, so the ledger side still counted
   the six entries as claimed while the bank side counted the six movements as
   open. */
describe('undoing a matched movement', () => {
  const booked = () => harness({
    v_gl_entries: [
      { company_id: CO, account_code: '330-0000', je_no: 'JE-2608-0001', entry_date: '2026-08-12', source_type: 'PV', source_doc_no: 'HPV-2608-001', debit_sen: 0, credit_sen: 2500, party_name: 'MAYBANK', notes: 'Payment to MAYBANK — HPV-2608-001' },
    ],
  });
  const chargeLine = async (app: Hono, statementId: number) => {
    const detail = await (await app.request(`/bank/statements/${statementId}`)).json() as any;
    return detail.lines.find((l: any) => Number(l.amount_sen) === -2500);
  };

  test('lets go of the entry, so the books no longer count it as claimed and it can be matched again', async () => {
    const { app, sb } = booked();
    const up = await (await upload(app)).json() as any;
    const line = await chargeLine(app, up.statementId);
    expect((await post(app, `/bank/lines/${line.id}/match`, { jeNo: 'JE-2608-0001' })).status).toBe(200);
    expect(sb.tables.acc_bank_statement_matches).toHaveLength(1);

    expect((await post(app, `/bank/lines/${line.id}/undo`)).status).toBe(200);
    expect(sb.tables.acc_bank_statement_matches).toHaveLength(0);

    const detail = await (await app.request(`/bank/statements/${up.statementId}`)).json() as any;
    expect(detail.reconciliation.consistent).toBe(true);
    expect(detail.reconciliation.unmatchedJeNos).toContain('JE-2608-0001');
    expect(detail.lines.find((l: any) => l.id === line.id).matches).toEqual([]);

    expect((await post(app, `/bank/lines/${line.id}/match`, { jeNo: 'JE-2608-0001' })).status).toBe(200);
    expect(sb.tables.acc_bank_statement_matches).toHaveLength(1);
  });

  /* The rows an older undo left behind (prod, 2026-09-11: six of them). A
     match on a line that is not POSTED is nobody's claim: the reads ignore it
     and the next match on that entry clears it. */
  test('a match row left on an OPEN line by an older undo is ignored, and cleared by the next match', async () => {
    const { app, sb } = booked();
    const up = await (await upload(app)).json() as any;
    const line = await chargeLine(app, up.statementId);
    sb.tables.acc_bank_statement_matches.push({ id: 99, bank_line_id: line.id, company_id: CO, je_no: 'JE-2608-0001', amount_sen: -2500, match_reason: 'manual' });

    const detail = await (await app.request(`/bank/statements/${up.statementId}`)).json() as any;
    expect(detail.reconciliation.consistent).toBe(true);
    expect(detail.reconciliation.booksNotOnBank.count).toBe(1);
    expect(detail.reconciliation.unmatchedJeNos).toContain('JE-2608-0001');
    expect(detail.lines.find((l: any) => l.id === line.id).matches).toEqual([]);

    expect((await post(app, `/bank/lines/${line.id}/match`, { jeNo: 'JE-2608-0001' })).status).toBe(200);
    expect(sb.tables.acc_bank_statement_matches).toHaveLength(1);
    expect(sb.tables.acc_bank_statement_matches[0]).toMatchObject({ bank_line_id: line.id, je_no: 'JE-2608-0001' });
  });
});

/* ── The month a statement is for, and what the books still hold ────────────
   Owner, 2026-09-11, on April: every line of Hong Leong's monthly statement
   was dated the 30th, so the screen took the period to be one day and the two
   payments posted on the 28th were not on the "in the books" list. Naming the
   month in the Year-and-month box now says this file covers the whole month.
   And: 之前 in book 还没有 recon 的也要带下来，因为可能下个月才过钱. */
describe('the month a dated statement covers', () => {
  test('naming the month makes the statement cover it from the 1st to the last day', async () => {
    const { app, sb } = harness();
    const res = await upload(app, { statementMonth: '2026-08' });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.periodFrom).toBe('2026-08-01');
    expect(body.periodTo).toBe('2026-08-31');
    expect(sb.tables.acc_bank_statements[0]).toMatchObject({ period_from: '2026-08-01', period_to: '2026-08-31' });
  });

  test('a movement dated outside the named month refuses the file, and names the date', async () => {
    const { app, sb } = harness();
    const res = await upload(app, { statementMonth: '2026-07' });
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toBe('month_mismatch');
    expect(body.message).toContain('2026-08-03');
    expect(body.message).toContain('2026-07');
    expect(sb.tables.acc_bank_statements).toHaveLength(0);
  });

  test('without a month named, the period is still the days the file carries', async () => {
    const { app } = harness();
    const body = await (await upload(app)).json() as any;
    expect(body.periodFrom).toBe('2026-08-03');
    expect(body.periodTo).toBe('2026-08-12');
  });
});

describe('what the books hold that no statement has shown', () => {
  /* Reconciliation here began with July's statement; an entry older than the
     first statement ever filed is the opening balance, not something waiting. */
  const JULY = [HEAD, row('20260720', '000000000002500', 'DR', 'SERVICE CHARGE', 'BCHARGE0')].join('\n');
  const ledgered = () => harness({
    v_gl_entries: [
      /* Paid in July, still not on any statement by August. */
      { company_id: CO, account_code: '330-0000', je_no: 'JE-2607-0031', entry_date: '2026-07-28', source_type: 'PV', source_doc_no: 'HPV-2607-031', debit_sen: 0, credit_sen: 45000, party_name: 'TENAGA NASIONAL BERHAD', notes: 'Payment to TENAGA NASIONAL BERHAD — HPV-2607-031' },
      /* Posted in the period. */
      { company_id: CO, account_code: '330-0000', je_no: 'JE-2608-0007', entry_date: '2026-08-10', source_type: 'PV', source_doc_no: 'HPV-2608-007', debit_sen: 0, credit_sen: 310168, party_name: 'HOUZS VENTURE HOLDING SDN BHD', notes: null },
      /* A reversed entry and the contra that undid it: not the bank's business. */
      { company_id: CO, account_code: '330-0000', je_no: 'JE-2608-0008', entry_date: '2026-08-11', source_type: 'PV', source_doc_no: 'HPV-2608-008', debit_sen: 0, credit_sen: 99900, party_name: 'WRONG', notes: null, reversed: true, reversed_by_je: 'uuid-contra' },
      { company_id: CO, account_code: '330-0000', je_no: 'JE-2608-0009', entry_date: '2026-08-11', source_type: 'PV_REVERSAL', source_doc_no: 'HPV-2608-008', debit_sen: 99900, credit_sen: 0, party_name: 'WRONG', notes: null, reversed: false, reversed_by_je: 'uuid-original' },
    ],
  });

  test('lists this period\'s entries and the earlier ones still waiting, each with who it was paid to', async () => {
    const { app } = ledgered();
    /* Reconciliation began with July: the July cheque is on or after that. */
    expect((await upload(app, { fileName: 'jul.csv', content: JULY })).status).toBe(200);
    const up = await (await upload(app)).json() as any;
    const detail = await (await app.request(`/bank/statements/${up.statementId}`)).json() as any;
    const byJe = Object.fromEntries((detail.unmatchedEntries as any[]).map((e) => [e.jeNo, e]));
    expect(byJe['JE-2608-0007']).toMatchObject({ carried: false, partyName: 'HOUZS VENTURE HOLDING SDN BHD' });
    expect(byJe['JE-2607-0031']).toMatchObject({ carried: true, partyName: 'TENAGA NASIONAL BERHAD' });
    expect(detail.reconciliation.carried).toEqual({ count: 1, sen: -45000 });
    expect(detail.reconciliation.booksNotOnBank).toEqual({ count: 1, sen: -310168 });
  });

  test('an entry older than the first statement ever filed is the opening balance, not something waiting', async () => {
    const { app } = ledgered();
    const up = await (await upload(app)).json() as any;   // August is the first statement here
    const detail = await (await app.request(`/bank/statements/${up.statementId}`)).json() as any;
    expect((detail.unmatchedEntries as any[]).map((e) => e.jeNo)).not.toContain('JE-2607-0031');
    expect(detail.reconciliation.carried).toEqual({ count: 0, sen: 0 });
  });

  test('a reversed entry and its contra are on neither list, and not offered', async () => {
    const { app } = ledgered();
    const up = await (await upload(app)).json() as any;
    const detail = await (await app.request(`/bank/statements/${up.statementId}`)).json() as any;
    const jes = (detail.unmatchedEntries as any[]).map((e) => e.jeNo);
    expect(jes).not.toContain('JE-2608-0008');
    expect(jes).not.toContain('JE-2608-0009');
    for (const l of detail.lines as any[]) {
      expect((l.entryCandidates as any[]).map((e) => e.jeNo)).not.toContain('JE-2608-0008');
    }
  });

  test('the candidates offered for a movement name who was paid', async () => {
    const { app } = harness({
      v_gl_entries: [{ company_id: CO, account_code: '330-0000', je_no: 'JE-2608-0012', entry_date: '2026-08-12', source_type: 'PV', source_doc_no: 'HPV-2608-012', debit_sen: 0, credit_sen: 2500, party_name: 'MAYBANK', notes: 'Payment to MAYBANK — HPV-2608-012' }],
    });
    const up = await (await upload(app)).json() as any;
    const detail = await (await app.request(`/bank/statements/${up.statementId}`)).json() as any;
    const charge = detail.lines.find((l: any) => Number(l.amount_sen) === -2500);
    expect(charge.entryCandidates).toEqual([expect.objectContaining({ jeNo: 'JE-2608-0012', partyName: 'MAYBANK', daysApart: 0 })]);
  });
});

/* ── Several movements to one entry, or one movement to several ──────────────
   Owner, 2026-09-11, on OR-2604-001 — RM 39,000 received from HOUZS VENTURE
   HOLDING, which the bank shows as two transfers of RM 29,000 and RM 10,000:
   他对应的是这两笔，你应该开发让我自由选. The two lines could only offer
   "Not ours to reconcile". And the other way round: one transfer paying two
   vouchers (docs/bugs/0803). */
describe('several movements to one entry, or one to several', () => {
  /* The first two credits of the file — RM 7,284.48 and RM 1,710.00 — are one
     receipt of RM 8,994.48 in the books; the RM 25.00 charge is two vouchers. */
  const RECEIPT = { company_id: CO, account_code: '330-0000', je_no: 'JE-2608-0020', entry_date: '2026-08-03', source_type: 'RCT', source_doc_no: 'OR-2608-001', debit_sen: 899448, credit_sen: 0, party_name: 'HOUZS VENTURE HOLDING SDN BHD', notes: null };
  const FEE_A = { company_id: CO, account_code: '330-0000', je_no: 'JE-2608-0031', entry_date: '2026-08-12', source_type: 'PV', source_doc_no: 'HPV-2608-031', debit_sen: 0, credit_sen: 1500, party_name: 'MAYBANK', notes: null };
  const FEE_B = { company_id: CO, account_code: '330-0000', je_no: 'JE-2608-0032', entry_date: '2026-08-12', source_type: 'PV', source_doc_no: 'HPV-2608-032', debit_sen: 0, credit_sen: 1000, party_name: 'MAYBANK', notes: null };
  const world = () => harness({ v_gl_entries: [RECEIPT, FEE_A, FEE_B] });
  const opened = async (app: Hono) => {
    const up = await (await upload(app)).json() as any;
    const detail = await (await app.request(`/bank/statements/${up.statementId}`)).json() as any;
    const lines = detail.lines as any[];
    return {
      statementId: up.statementId as number,
      credits: lines.filter((l) => Number(l.amount_sen) > 0 && l.kind !== 'OTHER' ? true : Number(l.amount_sen) === 171000).sort((a, b) => b.amount_sen - a.amount_sen),
      charge: lines.find((l) => Number(l.amount_sen) === -2500),
    };
  };
  const group = (app: Hono, lineIds: number[], jeNos: string[]) => post(app, '/bank/lines/match-group', { lineIds, jeNos });

  test('two movements that add up to one entry are matched to it together', async () => {
    const { app, sb } = world();
    const { statementId, credits } = await opened(app);
    const [big, small] = credits.filter((l) => [728448, 171000].includes(Number(l.amount_sen)));
    const res = await group(app, [big.id, small.id], ['JE-2608-0020']);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, lines: 2, entries: 1 });

    const rows = sb.tables.acc_bank_statement_matches as Row[];
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.je_no)).toEqual(['JE-2608-0020', 'JE-2608-0020']);
    expect(rows.map((r) => Number(r.amount_sen)).sort((a, b) => a - b)).toEqual([171000, 728448]);
    for (const id of [big.id, small.id]) {
      expect(sb.tables.acc_bank_statement_lines.find((l) => l.id === id)).toMatchObject({ state: 'POSTED', posted_je_no: 'JE-2608-0020' });
    }
    /* The entry is claimed once, by the pair, and the identity still holds. */
    const detail = await (await app.request(`/bank/statements/${statementId}`)).json() as any;
    expect(detail.reconciliation.unmatchedJeNos).not.toContain('JE-2608-0020');
    expect(detail.reconciliation.consistent).toBe(true);
  });

  test('one movement that is two vouchers is matched to both', async () => {
    const { app, sb } = world();
    const { charge } = await opened(app);
    const res = await group(app, [charge.id], ['JE-2608-0031', 'JE-2608-0032']);
    expect(res.status).toBe(200);
    const rows = sb.tables.acc_bank_statement_matches as Row[];
    expect(rows.map((r) => [r.je_no, Number(r.amount_sen)])).toEqual([['JE-2608-0031', -1500], ['JE-2608-0032', -1000]]);
    expect(sb.tables.acc_bank_statement_lines.find((l) => l.id === charge.id)).toMatchObject({ state: 'POSTED', posted_je_no: 'JE-2608-0031' });
  });

  /* THE RULE THE OWNER SET: 勾的总额必须等于那个 entry 的金额. */
  test('refuses when the movements and the entries do not add up, and names the difference', async () => {
    const { app, sb } = world();
    const { credits } = await opened(app);
    const big = credits.find((l) => Number(l.amount_sen) === 728448)!;
    const res = await group(app, [big.id], ['JE-2608-0020']);
    expect(res.status).toBe(409);
    const body = await res.json() as any;
    expect(body.error).toBe('amount_mismatch');
    expect(body.message).toMatch(/1,710\.00/);
    expect(sb.tables.acc_bank_statement_matches).toHaveLength(0);
  });

  test('refuses several movements to several entries — one side at a time', async () => {
    const { app } = world();
    const { credits, charge } = await opened(app);
    const big = credits.find((l) => Number(l.amount_sen) === 728448)!;
    const res = await group(app, [big.id, charge.id], ['JE-2608-0020', 'JE-2608-0031']);
    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toBe('one_side_only');
  });

  test('refuses an entry another movement already accounts for, and one the books do not hold', async () => {
    const { app } = world();
    const { credits, charge } = await opened(app);
    const [big, small] = credits.filter((l) => [728448, 171000].includes(Number(l.amount_sen)));
    expect((await group(app, [big.id, small.id], ['JE-2608-0020'])).status).toBe(200);
    const again = await group(app, [charge.id], ['JE-2608-0020']);
    expect(again.status).toBe(409);
    expect((await again.json() as any).error).toBe('already_matched');

    const ghost = await group(app, [charge.id], ['JE-2608-9999']);
    expect(ghost.status).toBe(404);
    expect((await ghost.json() as any).error).toBe('entry_not_found');
  });

  /* Undoing one movement of a pair undoes the pair: half a claim on an entry
     is not a state the identity can hold. */
  test('undoing one movement of the pair lets go of the whole pair', async () => {
    const { app, sb } = world();
    const { credits } = await opened(app);
    const [big, small] = credits.filter((l) => [728448, 171000].includes(Number(l.amount_sen)));
    expect((await group(app, [big.id, small.id], ['JE-2608-0020'])).status).toBe(200);
    const res = await post(app, `/bank/lines/${small.id}/undo`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, status: 'undone', linesReopened: 2 });
    expect(sb.tables.acc_bank_statement_matches).toHaveLength(0);
    for (const id of [big.id, small.id]) {
      expect(sb.tables.acc_bank_statement_lines.find((l) => l.id === id)).toMatchObject({ state: 'OPEN', posted_je_no: null });
    }
  });

  test('a closed month refuses it', async () => {
    const { app, sb } = world();
    const { credits } = await opened(app);
    const [big, small] = credits.filter((l) => [728448, 171000].includes(Number(l.amount_sen)));
    sb.tables.acc_bank_month_locks = [LOCK('2026-08')];
    const res = await group(app, [big.id, small.id], ['JE-2608-0020']);
    expect(res.status).toBe(409);
    expect((await res.json() as any).error).toBe('month_locked');
    expect(sb.tables.acc_bank_statement_matches).toHaveLength(0);
  });
});

describe('the rest of banking life', () => {
  test('a movement can be matched to a journal entry, but only once', async () => {
    const { app } = harness();
    const up = await (await upload(app)).json() as any;
    const detail = await (await app.request(`/bank/statements/${up.statementId}`)).json() as any;
    const [a, b] = detail.lines;

    expect((await post(app, `/bank/lines/${a.id}/match`, { jeNo: 'JE-2608-0001' })).status).toBe(200);
    const twice = await post(app, `/bank/lines/${b.id}/match`, { jeNo: 'JE-2608-0001' });
    expect(twice.status).toBe(409);
    expect((await twice.json() as any).message).toMatch(/cannot account for two/);
  });

  test('ignoring demands a reason, because it leaves the difference for ever', async () => {
    const { app } = harness();
    const up = await (await upload(app)).json() as any;
    const detail = await (await app.request(`/bank/statements/${up.statementId}`)).json() as any;
    const line = detail.lines[0];

    const bare = await post(app, `/bank/lines/${line.id}/ignore`, {});
    expect(bare.status).toBe(400);
    expect((await bare.json() as any).error).toBe('no_reason');

    const given = await post(app, `/bank/lines/${line.id}/ignore`, { note: 'own transfer, booked from the other side' });
    expect(given.status).toBe(200);
  });
});

describe('the reconciliation the detail returns', () => {
  test('shows the bank ahead of the books by exactly what is unposted', async () => {
    const { app } = harness();
    const up = await (await upload(app)).json() as any;
    const detail = await (await app.request(`/bank/statements/${up.statementId}`)).json() as any;
    const r = detail.reconciliation;

    /* Nothing is posted, so everything on the statement is "bank has, books
       do not" — and the ledger side is empty. */
    expect(r.bankNotInBooks.count).toBe(4);
    expect(r.bankNotInBooks.sen).toBe(728448 + 171000 + 87106 - 2500);
    expect(r.booksNotOnBank.count).toBe(0);
    expect(r.reconciled).toBe(false);
    /* This file prints no balances, so there is no difference to report —
       and a null must not read as a reconciled zero. */
    expect(r.differenceSen).toBeNull();
    expect(r.consistent).toBe(true);
  });

  test('the list says how much of each statement is still undecided', async () => {
    const { app } = harness();
    await upload(app);
    const list = await (await app.request('/bank/statements')).json() as any;
    expect(list.statements).toHaveLength(1);
    expect(list.statements[0].open_count).toBe(4);
    expect(list.statements[0].open_payout_count).toBe(2);
  });
});

describe('the setup the screen reads before an upload', () => {
  test('names the accounts, and which acquirers can be recognised at all', async () => {
    const { app } = harness();
    const body = await (await app.request('/bank/setup')).json() as any;
    expect(body.accounts).toHaveLength(1);
    expect(body.accounts[0].ready).toBe(true);
    expect(body.recognises).toEqual(['MBB', 'AEON']);
  });

  /* Since 2026-09-08 the reader carries built-in headings for every role
     (bank-parse.ts DEFAULT_HEADINGS — owner: 别卡死读 column), so a config
     that names only one heading, or none, still reads a file captioned the
     way banks caption them; a file it cannot read is refused at upload by
     name instead. */
  test('a config naming only one heading is still ready — the reader carries the rest', async () => {
    const { app } = harness({
      acc_bank_statement_config: [{ ...MBB_ACCOUNT, column_map: { date: 'EFFECT DATE' } }],
    });
    const body = await (await app.request('/bank/setup')).json() as any;
    expect(body.accounts[0].ready).toBe(true);
  });
});

/* The defect the local rig caught before any screen existed: the matcher works
   out WHICH statement a credit settles, and the route threw that away. The
   screen then had only a candidate list, picked the first of the acquirer, and
   booked the second credit against a statement that was already paid in full —
   confidently, and wrongly. The decision is stored now. */
describe('the matcher decision survives the round trip', () => {
  const TWO_BATCHES = {
    acc_settlement_batches: [
      BATCH,
      { ...BATCH, id: 2, file_name: 'mbb-0808.csv', period_from: '2026-08-08', period_to: '2026-08-08', net_sen: 87106 },
    ],
    acc_settlement_rows: [
      CONFIRMED_ROW,
      { ...CONFIRMED_ROW, id: 2, batch_id: 2, txn_date: '2026-08-08', net_sen: 87106 },
    ],
  };

  test('each credit carries the statement whose day and amount agreed, not the first of the acquirer', async () => {
    const { app } = harness(TWO_BATCHES);
    const up = await (await upload(app)).json() as any;
    const detail = await (await app.request(`/bank/statements/${up.statementId}`)).json() as any;

    const byRef = (ref: string) => detail.lines.find((l: any) => l.reference === ref);
    /* Two candidates for both, and they must NOT get the same answer. */
    expect(byRef('00113107').candidates.length).toBe(2);
    expect(byRef('00113107').matched_batch_id).toBe(1);
    expect(byRef('D90200808').matched_batch_id).toBe(2);
  });

  test('booking each against its own statement pays both off', async () => {
    const { app } = harness(TWO_BATCHES);
    const up = await (await upload(app)).json() as any;
    const detail = await (await app.request(`/bank/statements/${up.statementId}`)).json() as any;

    for (const l of detail.lines.filter((x: any) => x.kind === 'PAYOUT')) {
      const res = await post(app, `/bank/lines/${l.id}/receipt`, { batchId: l.matched_batch_id });
      expect(res.status, `line ${l.line_no}`).toBe(200);
      expect((await res.json() as any).results[0].outstandingSen).toBe(0);
    }
  });
});

/* One credit, several statements. Public Bank's ordinary payout — one advice
   for three trading days — and the shape the owner named on the merchant side:
   顾客可能刷一次卡，但是还两个单. Before this the operator was told his credit was
   too big for the statement he picked, and given no way to do the right thing. */
/* ── The obvious ones are matched without a hand (docs/bugs/0814) ─────────────
   Owner, 2026-09-11: 只要名字金额一样就自动都对，名字不一样不确定我可以 manual 对.
   A movement with exactly one same-amount entry in the books whose payee the
   bank's text names is matched on upload — reason "amount+name", under
   "already dealt with" with Undo. Anything less certain stays for a hand. */
describe('the obvious ones', () => {
  /* The customer transfer "LAU LEE YEN" has one RM 1,710.00 receipt in the
     books from LAU LEE YEN; the RM 25.00 SERVICE CHARGE has one RM 25.00
     voucher — to MAYBANK, a name the bank's line does not carry. */
  const LEDGER = [
    { company_id: CO, account_code: '330-0000', je_no: 'JE-2608-0002', entry_date: '2026-08-04', source_type: 'RCT', source_doc_no: 'OR-2608-002', debit_sen: 171000, credit_sen: 0, party_name: 'LAU LEE YEN', notes: null },
    { company_id: CO, account_code: '330-0000', je_no: 'JE-2608-0003', entry_date: '2026-08-12', source_type: 'PV', source_doc_no: 'HPV-2608-003', debit_sen: 0, credit_sen: 2500, party_name: 'MAYBANK', notes: null },
  ];

  test('on upload, the named one is matched and the unnamed one waits', async () => {
    const { app, sb } = harness({ v_gl_entries: LEDGER });
    const up = await (await upload(app)).json() as any;
    expect(up.autoMatched).toBe(1);
    const lines = sb.tables.acc_bank_statement_lines as Row[];
    const lau = lines.find((l) => String(l.description).includes('LAU LEE YEN'))!;
    expect(lau).toMatchObject({ state: 'POSTED', posted_je_no: 'JE-2608-0002' });
    expect(sb.tables.acc_bank_statement_matches).toEqual([expect.objectContaining({ bank_line_id: lau.id, je_no: 'JE-2608-0002', amount_sen: 171000, match_reason: 'amount+name' })]);
    const charge = lines.find((l) => Number(l.amount_sen) === -2500)!;
    expect(charge.state).toBe('OPEN');
    /* And the detail shows it dealt with, saying how. */
    const detail = await (await app.request(`/bank/statements/${up.statementId}`)).json() as any;
    const shown = detail.lines.find((l: any) => l.id === lau.id);
    expect(shown.state).toBe('POSTED');
    expect(shown.matches[0].match_reason).toBe('amount+name');
    expect(detail.reconciliation.unmatchedJeNos).not.toContain('JE-2608-0002');
  });

  test('a statement uploaded earlier can have the same rule run over it', async () => {
    const { app, sb } = harness();
    const up = await (await upload(app)).json() as any;
    expect(up.autoMatched).toBe(0);
    for (const e of LEDGER) sb.tables.v_gl_entries.push({ ...e });
    const res = await post(app, `/bank/statements/${up.statementId}/auto-match`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body).toMatchObject({ ok: true, matched: 1, jeNos: ['JE-2608-0002'] });
    expect(sb.tables.acc_bank_statement_matches).toHaveLength(1);
    /* Running it again finds nothing new. */
    expect(await (await post(app, `/bank/statements/${up.statementId}/auto-match`)).json()).toMatchObject({ matched: 0 });
  });

  test('a closed month refuses it', async () => {
    const { app, sb } = harness();
    const up = await (await upload(app)).json() as any;
    for (const e of LEDGER) sb.tables.v_gl_entries.push({ ...e });
    sb.tables.acc_bank_month_locks = [LOCK('2026-08')];
    const res = await post(app, `/bank/statements/${up.statementId}/auto-match`);
    expect(res.status).toBe(409);
    expect((await res.json() as any).error).toBe('month_locked');
    expect(sb.tables.acc_bank_statement_matches).toHaveLength(0);
  });
});

/* ── The lock reads the match table too (docs/bugs/0818) ──────────────────────
   May 2026, Hong Leong: the RM 55,000 deposit of 7 May is two entries — the
   RM 100,000 receipt OR-2605-001 and the RM 45,000 rental HPV-2605-003 paid
   out of it — matched together (docs/bugs/0803). The line names the first;
   the second lives only in the match table. The month screen read both and
   said June tallied; the lock read the line alone, carried the rental into
   June as still outstanding, and refused: RM 45,000.00 apart. */
describe('a month whose earlier entry is claimed only by the match table', () => {
  const HLB_MAY = [
    'HLB PRIMEBIZ CURRENT ACCOUNT - 23600600000,',
    'Date,Transaction Description,Cheque No.,Ref. No.,Deposit,Withdrawal,Balance',
    '="",="Balance from previous statement",="",="",="",="",="3000.00"',
    '="07-05-2026",="Fund Transfer at DIO",="",="HOUZS VENTURE HOLDING SDN. BHD.",="55000.00",="",="58000.00"',
  ].join('\n');
  const HLB_EMPTY_JUNE = [
    'HLB PRIMEBIZ CURRENT ACCOUNT - 23600600000,',
    'Date,Transaction Description,Cheque No.,Ref. No.,Deposit,Withdrawal,Balance',
    '="",="Balance from previous statement",="",="",="",="",="58000.00"',
  ].join('\n');
  const world = () => harness({
    acc_bank_statement_config: [MBB_ACCOUNT, HLB_ACCOUNT],
    v_gl_entries: [
      { company_id: CO, account_code: '310-0020', je_no: 'JE-2602-0001', entry_date: '2026-02-07', source_type: 'PV', source_doc_no: 'HPV-2602-028', debit_sen: 300000, credit_sen: 0, party_name: null, notes: null },
      { company_id: CO, account_code: '310-0020', je_no: 'JE-2605-0030', entry_date: '2026-05-05', source_type: 'PV', source_doc_no: 'HPV-2605-003', debit_sen: 0, credit_sen: 4500000, party_name: 'NAVINDER SINGH GILL', notes: null },
      { company_id: CO, account_code: '310-0020', je_no: 'JE-2605-0013', entry_date: '2026-05-07', source_type: 'RCT', source_doc_no: 'OR-2605-001', debit_sen: 10000000, credit_sen: 0, party_name: 'HOUZS VENTURE HOLDING SDN BHD', notes: null },
    ],
  });
  /* May's deposit matched to both entries, then an empty June filed. The
     line names the first entry only — the shape production's May
     line 5 holds — so the second is the match table's word alone. */
  const mayMatchedThenJune = async (app: Hono, sb: ReturnType<typeof harness>['sb']) => {
    const may = await (await post(app, '/bank/statements', { accountCode: '310-0020', fileName: 'acs_23600600000_31052026.csv', content: HLB_MAY, statementMonth: '2026-05' })).json() as any;
    const detail = await (await app.request(`/bank/statements/${may.statementId}`)).json() as any;
    const deposit = detail.lines.find((l: any) => Number(l.amount_sen) === 5500000);
    expect((await post(app, '/bank/lines/match-group', { lineIds: [deposit.id], jeNos: ['JE-2605-0013', 'JE-2605-0030'] })).status).toBe(200);
    const row = (sb.tables.acc_bank_statement_lines as Row[]).find((l) => l.id === deposit.id)!;
    expect(row.state).toBe('POSTED');
    expect(row.posted_je_no).toBe('JE-2605-0013');
    expect((sb.tables.acc_bank_statement_matches as Row[]).map((m) => m.je_no).sort()).toEqual(['JE-2605-0013', 'JE-2605-0030']);
    const june = await (await post(app, '/bank/statements', { accountCode: '310-0020', fileName: 'acs_23600600000_30062026.csv', content: HLB_EMPTY_JUNE, statementMonth: '2026-06' })).json() as any;
    expect(june.ok).toBe(true);
  };

  test('the lock agrees with the screen: the rental is not carried, June tallies and closes', async () => {
    const { app, sb } = world();
    await mayMatchedThenJune(app, sb);
    const shown = await (await app.request('/bank/months/310-0020/2026-06')).json() as any;
    expect(shown.reconciliation.carried).toEqual({ count: 0, sen: 0 });
    expect(shown.reconciliation.computedClosingSen).toBe(5800000);
    expect(shown.reconciliation.tallies).toBe(true);

    const res = await post(app, '/bank/months/310-0020/2026-06/lock', {});
    expect(res.status).toBe(200);
    expect(sb.tables.acc_bank_month_locks[0]).toMatchObject({ closing_statement_sen: 5800000, closing_ledger_sen: 5800000, difference_sen: 0 });
  });
});

/* ── A transfer the bank itself reversed (docs/bugs/0817) ─────────────────────
   Hong Leong, 04/06/2026: 2990's RM 2,872.75 transfer to its own Alliance
   account failed and the bank put it back the same day — "CIB Instant
   Transfer Reversal", the SAME transaction reference — while a second transfer
   under a fresh reference went through. The books hold one transfer voucher
   whose name (ALLIANCE) the failed line's text carried, so the rule of
   docs/bugs/0814 matched the voucher to a transfer that never happened and
   left the reversal and the real transfer for a hand (owner: 这两笔是 contra
   的，bank transaction fail). */
describe('a transfer the bank itself reversed', () => {
  const FAILED_REF = 'Alliance PV-000035 2990 HOME SDN. BHD. 20260604HLBBMYKL010OCB02763120';
  const RETRY_REF = '2990 Fund Tranfer 2990 HOME SDN. BHD. 20260604HLBBMYKL010OCB03546681';
  const HLB_JUNE = [
    'HLB PRIMEBIZ CURRENT ACCOUNT - 23600600000,',
    'Date,Transaction Description,Cheque No.,Ref. No.,Deposit,Withdrawal,Balance',
    '="",="Balance from previous statement",="",="",="",="",="10000.00"',
    `="04-06-2026",="CIB Instant Transfer at DIO",="",="${FAILED_REF}",="",="2872.75",="7127.25"`,
    `="04-06-2026",="CIB Instant Transfer at DIO",="",="${RETRY_REF}",="",="2872.75",="4254.50"`,
    `="04-06-2026",="CIB Instant Transfer Reversal at DIO",="",="${FAILED_REF}",="2872.75",="",="7127.25"`,
  ].join('\n');
  const LEDGER = [
    { company_id: CO, account_code: '310-0020', je_no: 'JE-2602-0001', entry_date: '2026-02-07', source_type: 'PV', source_doc_no: 'HPV-2602-028', debit_sen: 1000000, credit_sen: 0, party_name: null, notes: null },
    { company_id: CO, account_code: '310-0020', je_no: 'JE-2606-0058', entry_date: '2026-06-03', source_type: 'PV', source_doc_no: 'HPV-2606-003', debit_sen: 0, credit_sen: 287275, party_name: 'Internal transfer to 310-0030 CASH AT BANK - ALLIANCE', notes: null },
  ];
  const june = () => harness({ acc_bank_statement_config: [MBB_ACCOUNT, HLB_ACCOUNT], v_gl_entries: LEDGER.map((e) => ({ ...e })) });
  const uploadJune = async (app: Hono) =>
    (await post(app, '/bank/statements', { accountCode: '310-0020', fileName: 'acs_23600600000_30062026.csv', content: HLB_JUNE, statementMonth: '2026-06' })).json() as Promise<any>;
  const lineByRef = (sb: ReturnType<typeof harness>['sb'], id: string, reversal = false) =>
    (sb.tables.acc_bank_statement_lines as Row[]).find((l) => String(l.reference).endsWith(id) && String(l.description).includes('Reversal') === reversal)!;
  const candidatesOf = async (app: Hono, statementId: number, lineId: number) => {
    const detail = await (await app.request(`/bank/statements/${statementId}`)).json() as any;
    return { detail, jeNos: detail.lines.find((l: any) => l.id === lineId).entryCandidates.map((e: any) => e.jeNo) as string[] };
  };

  test("on upload the pair leaves as the bank's own contra, and the voucher waits for the transfer that went through", async () => {
    const { app, sb } = june();
    const up = await uploadJune(app);
    expect(up.lines).toBe(3);
    expect(up).toMatchObject({ contraPairs: 1, autoMatched: 0 });
    const failed = lineByRef(sb, '02763120');
    const reversal = lineByRef(sb, '02763120', true);
    const retry = lineByRef(sb, '03546681');
    expect(failed).toMatchObject({ state: 'IGNORED', contra_line_id: reversal.id, note: `Reversed by the bank on line ${reversal.line_no}` });
    expect(reversal).toMatchObject({ state: 'IGNORED', contra_line_id: failed.id, note: `Bank reversal of line ${failed.line_no}` });
    expect(retry.state).toBe('OPEN');
    expect(sb.tables.acc_bank_statement_matches).toEqual([]);

    const { detail, jeNos } = await candidatesOf(app, up.statementId, retry.id as number);
    expect(jeNos).toEqual(['JE-2606-0058']);
    /* The pair is no part of the difference: the retry is what the bank shows
       and the books have not yet been told is that voucher. */
    expect(detail.reconciliation.consistent).toBe(true);
    expect(detail.reconciliation.bankNotInBooks).toEqual({ count: 1, sen: -287275 });
    expect(detail.reconciliation.tallies).toBe(true);
    expect(detail.reconciliation.reconciled).toBe(false);

    expect((await post(app, `/bank/lines/${retry.id}/match`, { jeNo: 'JE-2606-0058' })).status).toBe(200);
    const after = await (await app.request(`/bank/statements/${up.statementId}`)).json() as any;
    expect(after.reconciliation.reconciled).toBe(true);
    expect((await post(app, '/bank/months/310-0020/2026-06/lock', {})).status).toBe(200);
  });

  test('a statement up before the rule: undo the wrong match, then the rule takes the pair out and leaves the retry its voucher', async () => {
    const { app, sb } = june();
    const up = await uploadJune(app);
    /* As June stood in production on 2026-09-11: the pair still open, the
       failed transfer matched to the voucher by amount and name. */
    for (const l of sb.tables.acc_bank_statement_lines as Row[]) Object.assign(l, { state: 'OPEN', note: null, contra_line_id: null });
    const failed = lineByRef(sb, '02763120');
    expect((await post(app, `/bank/lines/${failed.id}/match`, { jeNo: 'JE-2606-0058' })).status).toBe(200);

    /* A POSTED half is not the rule's to take: the pair waits until the match is undone. */
    expect(await (await post(app, `/bank/statements/${up.statementId}/auto-match`)).json()).toMatchObject({ ok: true, matched: 0, contraPairs: 0 });
    expect(lineByRef(sb, '02763120', true).state).toBe('OPEN');

    expect((await post(app, `/bank/lines/${failed.id}/undo`)).status).toBe(200);
    expect(await (await post(app, `/bank/statements/${up.statementId}/auto-match`)).json()).toMatchObject({ ok: true, matched: 0, contraPairs: 1 });
    expect(lineByRef(sb, '02763120').state).toBe('IGNORED');
    expect(lineByRef(sb, '02763120', true).state).toBe('IGNORED');
    const retry = lineByRef(sb, '03546681');
    expect(retry.state).toBe('OPEN');
    expect((await candidatesOf(app, up.statementId, retry.id as number)).jeNos).toEqual(['JE-2606-0058']);
    /* Run again: the pair is already out. */
    expect(await (await post(app, `/bank/statements/${up.statementId}/auto-match`)).json()).toMatchObject({ contraPairs: 0 });
  });

  test('undoing either half reopens both, and the rule can take them again', async () => {
    const { app, sb } = june();
    const up = await uploadJune(app);
    const reversal = lineByRef(sb, '02763120', true);
    const res = await post(app, `/bank/lines/${reversal.id}/undo`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, status: 'undone', linesReopened: 2 });
    expect(lineByRef(sb, '02763120')).toMatchObject({ state: 'OPEN', note: null, contra_line_id: null });
    expect(lineByRef(sb, '02763120', true)).toMatchObject({ state: 'OPEN', note: null, contra_line_id: null });
    expect(await (await post(app, `/bank/statements/${up.statementId}/auto-match`)).json()).toMatchObject({ contraPairs: 1 });
  });
});

/* ── A report the bank charged (docs/bugs/0812) ───────────────────────────────
   Public Bank kept RM 324.00 off 2990's 2026-06-06 payout as a terminal fee;
   Finance booked it on the advice day (docs/bugs/0787). The bank side still
   said that report was owed its full net, so the 8 June credit — three days
   less the fee, RM 8,143.29 — matched nothing: the advice was distrusted (its
   day figure did not equal the report's "owed") and the operator was shown
   "check which" over a credit the advice had already explained. Owner: 我不是
   给你 payment advice 了吗? bank recon 这边只需要对 payment advice 罢了啊. */
describe('a report the bank charged', () => {
  const CHARGED = [
    HEAD,
    /* The credit is the report's net less the RM 324.00 the bank kept. */
    row('20260803', '000000000696048', 'CR', 'CR/CARD SALES MN 32410011 DATED 31072026', '00113107'),
  ].join('\n');
  const charged = () => harness({
    acc_settlement_batches: [BATCH], acc_settlement_rows: [CONFIRMED_ROW],
    acc_settlement_payouts: [{ id: 9, company_id: CO, acquirer_code: 'MBB', file_name: 'adv-0803.pdf', advice_date: '2026-08-03', net_sen: 696048 }],
    acc_settlement_payout_batches: [{ id: 1, company_id: CO, payout_id: 9, batch_id: 1, settled_on: '2026-07-31', net_sen: 696048, charge_sen: 32400, charge_account_code: '900-T003', charge_note: 'terminal fee' }],
  });

  test('is owed its net less the charge, and the advice for that figure is trusted', async () => {
    const { app } = charged();
    const up = await (await upload(app, { fileName: 'aug-charged.csv', content: CHARGED })).json() as any;
    expect(up.kinds.PAYOUT).toBe(1);
    const detail = await (await app.request(`/bank/statements/${up.statementId}`)).json() as any;
    const line = detail.lines[0];
    expect(line.kind).toBe('PAYOUT');
    expect(line.matched_batch_id).toBe(1);
    expect(line.candidates[0]).toMatchObject({ id: 1, outstandingSen: 696048 });
    expect(String(line.note)).toMatch(/payment advice/);
  });

  test('books the credit, and the report is then fully received — credit plus charge', async () => {
    const { app, sb } = charged();
    const up = await (await upload(app, { fileName: 'aug-charged.csv', content: CHARGED })).json() as any;
    const detail = await (await app.request(`/bank/statements/${up.statementId}`)).json() as any;
    const res = await post(app, `/bank/lines/${detail.lines[0].id}/receipt`, { batchId: 1 });
    expect(res.status).toBe(200);
    expect((sb.tables.acc_settlement_receipts as Row[])[0]).toMatchObject({ batch_id: 1, amount_sen: 696048 });
    /* Nothing is owed any more: it is off the payable list. */
    const after = await (await app.request(`/bank/statements/${up.statementId}`)).json() as any;
    expect(after.lines[0].state).toBe('POSTED');
  });
});

/* ── A decision is re-made on every read (docs/bugs/0815) ─────────────────────
   June's statement was uploaded before the charge fix (docs/bugs/0812), so
   its 8 June credit was stored as "check which" — and stayed that way after
   the fix, because what a card movement LOOKS LIKE was decided once, at
   upload, and written on the line. The owner, after the fix: 这个还是没有修吗?
   The candidates under it were already recomputed live; the decision above
   them now is too, against today's reports and advices. Nothing is written. */
describe('what a card movement looks like is re-decided on every read', () => {
  const CHARGED = [
    HEAD,
    row('20260803', '000000000696048', 'CR', 'CR/CARD SALES MN 32410011 DATED 31072026', '00113107'),
  ].join('\n');
  const ADVICE = { id: 9, company_id: CO, acquirer_code: 'MBB', file_name: 'adv-0803.pdf', advice_date: '2026-08-03', net_sen: 696048 };
  const DAY = { id: 1, company_id: CO, payout_id: 9, batch_id: 1, settled_on: '2026-07-31', net_sen: 696048, charge_sen: 32400, charge_account_code: '900-T003', charge_note: 'terminal fee' };

  test('a credit stored as "check which" reads as the advice\'s answer once the advice and the charge are in', async () => {
    const { app, sb } = harness({ acc_settlement_batches: [BATCH], acc_settlement_rows: [CONFIRMED_ROW] });
    /* Uploaded when the report still read as owed its full net: unsure. */
    const up = await (await upload(app, { fileName: 'aug-charged.csv', content: CHARGED })).json() as any;
    expect(up.kinds.PAYOUT_UNSURE).toBe(1);
    const stored = (sb.tables.acc_bank_statement_lines as Row[])[0]!;
    expect(stored.kind).toBe('PAYOUT_UNSURE');

    /* Then Finance books the charge and files the advice. */
    sb.tables.acc_settlement_payouts = [ADVICE];
    sb.tables.acc_settlement_payout_batches = [DAY];

    const detail = await (await app.request(`/bank/statements/${up.statementId}`)).json() as any;
    const line = detail.lines[0];
    expect(line.kind).toBe('PAYOUT');
    expect(line.matched_batch_id).toBe(1);
    expect(String(line.note)).toMatch(/payment advice/);
    expect(line.candidates[0]).toMatchObject({ id: 1, outstandingSen: 696048 });
    /* Read, not written: the row on disk still says what the upload said. */
    expect((sb.tables.acc_bank_statement_lines as Row[])[0]!.kind).toBe('PAYOUT_UNSURE');

    /* The month view reads the same fresh decision. */
    const month = await (await app.request('/bank/months/330-0000/2026-08')).json() as any;
    expect(month.lines.find((l: any) => l.id === line.id)).toMatchObject({ kind: 'PAYOUT', matched_batch_id: 1 });
  });

  test('a movement already dealt with keeps what it was booked as', async () => {
    const { app, sb } = harness({ acc_settlement_batches: [BATCH], acc_settlement_rows: [CONFIRMED_ROW] });
    const up = await (await upload(app)).json() as any;
    const detail = await (await app.request(`/bank/statements/${up.statementId}`)).json() as any;
    const payout = detail.lines.find((l: any) => l.kind === 'PAYOUT');
    expect((await post(app, `/bank/lines/${payout.id}/receipt`, { batchId: 1 })).status).toBe(200);
    /* The report is paid now; a fresh decision would find no report waiting.
       A POSTED line is not re-decided. */
    const after = await (await app.request(`/bank/statements/${up.statementId}`)).json() as any;
    expect(after.lines.find((l: any) => l.id === payout.id)).toMatchObject({ state: 'POSTED', kind: 'PAYOUT', matched_batch_id: 1 });
    expect(sb.tables.acc_settlement_receipts).toHaveLength(1);
  });
});

/* ── Overlapping uploads (owner 2026-09-08: 可能隔几天我就做一次) ─────────────── */
describe('uploading overlapping exports of the same account', () => {
  /* The first file again, plus one movement the bank posted since, plus a
     SECOND customer transfer identical to the first one's on the same day. */
  const LONGER = [
    HEAD,
    row('20260803', '000000000728448', 'CR', 'CR/CARD SALES MN 32410011 DATED 31072026', '00113107'),
    row('20260803', '000000000171000', 'CR', 'LAU LEE YEN        *', 'Jaslyn'),
    row('20260803', '000000000171000', 'CR', 'LAU LEE YEN        *', 'Jaslyn'),
    row('20260809', '000000000087500', 'CR', 'DR/CARD SALES M/N 2259020 DATED 08082026', 'D90200808'),
    row('20260809', '000000000000394', 'DR', 'DR/CARD SALES M/N 2259020 DATED 08082026', 'D90200808'),
    row('20260812', '000000000002500', 'DR', 'SERVICE CHARGE', 'BCHARGE1'),
    row('20260815', '000000000050000', 'CR', 'TAN AH KOW *', 'Deposit sofa'),
  ].join('\n');

  test('what an earlier upload already carries is marked recorded and set aside; the twin and the new movement stay open', async () => {
    const { app, sb } = harness();
    expect((await upload(app)).status).toBe(200);
    const res = await upload(app, { fileName: 'aug-longer.csv', content: LONGER });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    /* 6 movements in the longer file (the charge is joined); 4 were on the
       first upload — one of the two identical transfers is new. */
    expect(body.lines).toBe(6);
    expect(body.alreadyRecorded).toBe(4);
    expect(body.kinds.DUPLICATE).toBe(4);

    const lines = sb.tables.acc_bank_statement_lines.filter((l: Row) => l.statement_id === body.statementId);
    const byState = lines.reduce<Record<string, number>>((acc, l: Row) => { acc[String(l.state)] = (acc[String(l.state)] ?? 0) + 1; return acc; }, {});
    expect(byState).toEqual({ IGNORED: 4, OPEN: 2 });
    const open = lines.filter((l: Row) => l.state === 'OPEN').map((l: Row) => [String(l.booked_on), Number(l.amount_sen)]);
    expect(open).toEqual([['2026-08-03', 171000], ['2026-08-15', 50000]]);
    const dup = lines.find((l: Row) => l.state === 'IGNORED') as Row;
    expect(String(dup.note)).toMatch(/already recorded — statement \d+ \(still open there\)/);
  });
});

/* ── Which accounts take a statement, and how each file reads (2026-09-08) ─── */
describe('setting up a statement account', () => {
  const MONEY_CHART: Row[] = [
    { account_code: '310-0020', account_name: 'CASH AT BANK - HLBB', account_type: 'ASSET', parent_code: null, is_active: true, acc_money: true, company_id: CO },
    { account_code: '930-0000', account_name: 'BANK CHARGES', account_type: 'EXPENSE', parent_code: null, is_active: true, acc_money: false, company_id: CO },
  ];
  const configApp = (tables: Record<string, Row[]> = {}, perms: readonly string[] = [GL_PERM]) => {
    const { app, sb } = harness({ accounts: MONEY_CHART, ...tables }, perms);
    app.get('/bank/config', bankConfigList as never);
    app.post('/bank/config', bankConfigSave as never);
    return { app, sb };
  };

  test("lists the accounts and the reader's built-in headings; saves one with several headings per role; the upload screen then offers it", async () => {
    const { app, sb } = configApp();
    const res = await post(app, '/bank/config', {
      accountCode: '310-0020', bankCode: 'hlb', accountNo: '23600602788', statementFormat: 'csv',
      delimiter: '', amountFormat: 'decimal', creditIndicator: 'CR',
      columnMap: { date: 'Date, Transaction Date', description: ['Transaction Description', 'Remarks'], reference: 'Ref. No., Sender / Receiver Name, Receipient Reference', debit: 'Withdrawal, Payment Amount', credit: 'Deposit, Credit Amount', balance: 'Balance' },
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const saved = sb.tables.acc_bank_statement_config.find((r: Row) => r.account_code === '310-0020') as Row;
    expect(saved.bank_code).toBe('HLB');
    expect(saved.delimiter).toBeNull();
    expect(saved.column_map).toEqual({
      date: ['Date', 'Transaction Date'], description: ['Transaction Description', 'Remarks'],
      reference: ['Ref. No.', 'Sender / Receiver Name', 'Receipient Reference'],
      debit: ['Withdrawal', 'Payment Amount'], credit: ['Deposit', 'Credit Amount'], balance: ['Balance'],
    });

    const list = await (await app.request('/bank/config')).json() as any;
    expect(list.configs.map((c: Row) => c.account_code)).toContain('310-0020');
    expect(list.defaultHeadings.date).toContain('Transaction Date');

    const setup = await (await app.request('/bank/setup')).json() as any;
    expect(setup.accounts.find((a: Row) => a.account_code === '310-0020')).toMatchObject({ bank_code: 'HLB', account_no: '23600602788', ready: true });

    /* Saving again changes the row rather than adding a second one. */
    const again = await post(app, '/bank/config', { accountCode: '310-0020', bankCode: 'HLB', accountNo: '23600602788', statementFormat: 'CSV', columnMap: {} });
    expect(again.status).toBe(200);
    expect(sb.tables.acc_bank_statement_config.filter((r: Row) => r.account_code === '310-0020')).toHaveLength(1);
  });

  test('refuses an account that is not money, a format the reader cannot take, an amount named both ways, and a code outside the chart', async () => {
    const { app } = configApp();
    const notMoney = await post(app, '/bank/config', { accountCode: '930-0000', bankCode: 'HLB' });
    expect(notMoney.status).toBe(400);
    expect((await notMoney.json() as any).error).toBe('not_a_money_account');
    const pdf = await post(app, '/bank/config', { accountCode: '310-0020', bankCode: 'HLB', statementFormat: 'PDF' });
    expect(pdf.status).toBe(400);
    expect((await pdf.json() as any).error).toBe('bad_format');
    const both = await post(app, '/bank/config', { accountCode: '310-0020', bankCode: 'HLB', columnMap: { amount: 'Amount', debit: 'Withdrawal' } });
    expect(both.status).toBe(400);
    expect((await both.json() as any).error).toBe('amount_both_ways');
    const stranger = await post(app, '/bank/config', { accountCode: '999-0000', bankCode: 'HLB' });
    expect(stranger.status).toBe(400);
    expect((await stranger.json() as any).error).toBe('not_in_chart');
  });

  test('without the GL key both doors refuse', async () => {
    const { app } = configApp({}, []);
    expect((await app.request('/bank/config')).status).toBe(403);
    expect((await post(app, '/bank/config', { accountCode: '310-0020', bankCode: 'HLB' })).status).toBe(403);
  });
});

describe('splitting one credit across several statements', () => {
  /* Two reconciled reports owed RM 7,284.48 and RM 871.06; one credit of
     RM 8,155.54 pays both. */
  const SPLIT_WORLD = {
    acc_settlement_batches: [
      BATCH,
      { ...BATCH, id: 2, file_name: 'mbb-0808.csv', period_from: '2026-08-08', period_to: '2026-08-08', net_sen: 87106 },
    ],
    acc_settlement_rows: [
      CONFIRMED_ROW,
      { ...CONFIRMED_ROW, id: 2, batch_id: 2, txn_date: '2026-08-08', net_sen: 87106 },
    ],
  };
  const ONE_CREDIT = [
    HEAD,
    row('20260815', '000000000815554', 'CR', 'CR/CARD SALES MN 32409997 DATED 15082026', 'ADVICE1'),
  ].join('\n');

  const openSplit = async () => {
    const { app, sb } = harness(SPLIT_WORLD);
    const up = await (await upload(app, { content: ONE_CREDIT })).json() as any;
    const detail = await (await app.request(`/bank/statements/${up.statementId}`)).json() as any;
    return { app, sb, line: detail.lines[0] };
  };

  test('the upload works out which statements add up, and says so', async () => {
    const { line } = await openSplit();
    expect(line.kind).toBe('PAYOUT_SPLIT');
    expect(line.split).toEqual([{ batchId: 1, amountSen: 728448 }, { batchId: 2, amountSen: 87106 }]);
    expect(line.note).toMatch(/2 of MBB's reports add up to RM 8,155\.54 exactly/);
  });

  test('booking it writes one receipt per statement, each with its own entry', async () => {
    const { app, sb, line } = await openSplit();
    const res = await post(app, `/bank/lines/${line.id}/receipt`, { allocations: line.split });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.results).toHaveLength(2);
    expect(body.results.every((r: any) => r.outstandingSen === 0)).toBe(true);

    const receipts = sb.tables.acc_settlement_receipts as Row[];
    expect(receipts).toHaveLength(2);
    /* Both carry the BANK's date and reference, and both point back at the one
       movement they were read from. */
    expect(receipts.every((r) => r.received_on === '2026-08-15')).toBe(true);
    expect(receipts.every((r) => r.bank_ref === 'ADVICE1')).toBe(true);
    expect(receipts.every((r) => Number(r.bank_line_id) === line.id)).toBe(true);
  });

  /* docs/bugs/0809 — June on 2990's Hong Leong: two split payouts (RM 3,590.38
     and RM 3,716.14, each paying two reports) left the screen red — "These
     numbers do not add up" by exactly RM 7,306.52. A split line stores its
     two entries as "A, B" in posted_je_no, and every reader compared that
     string as ONE entry number, so the four receipts sat in "in the books, not
     on the bank" while the bank side counted the movements as posted. */
  test('the two entries a split wrote are both claimed by the movement, so the books and the bank agree', async () => {
    const { app, sb, line } = await openSplit();
    expect((await post(app, `/bank/lines/${line.id}/receipt`, { allocations: line.split })).status).toBe(200);
    const jes = (sb.tables.acc_settlement_receipts as Row[]).map((r) => String(r.je_no));
    expect(jes).toHaveLength(2);
    /* The ledger view the reconciliation reads, with the two receipts on it. */
    for (const [i, je] of jes.entries()) {
      sb.tables.v_gl_entries.push({ company_id: CO, account_code: '330-0000', je_no: je, entry_date: '2026-08-15', source_type: 'SETTLEBANK', source_doc_no: `SETTLEBANK-${i}`, debit_sen: Number((sb.tables.acc_settlement_receipts as Row[])[i]!.amount_sen), credit_sen: 0, notes: null });
    }
    const detail = await (await app.request(`/bank/statements/${line.statement_id}`)).json() as any;
    const posted = detail.lines.find((l: any) => l.id === line.id);
    expect(posted.state).toBe('POSTED');
    for (const je of jes) expect(detail.reconciliation.unmatchedJeNos).not.toContain(je);
    expect(detail.reconciliation.booksNotOnBank.count).toBe(0);
    expect(detail.reconciliation.consistent).toBe(true);
  });

  /* The same discipline the merchant side applies to a swipe covering two
     orders: a leftover is a difference, and a difference is what this module
     exists to surface. */
  test('refuses a split that does not add up to the credit, naming both numbers', async () => {
    const { app, sb, line } = await openSplit();
    const res = await post(app, `/bank/lines/${line.id}/receipt`, {
      allocations: [{ batchId: 1, amountSen: 728448 }],
    });
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toBe('amount_mismatch');
    expect(body.message).toMatch(/7284\.48/);
    expect(body.message).toMatch(/8155\.54/);
    /* And nothing was booked on the way to refusing. */
    expect(sb.tables.acc_settlement_receipts).toHaveLength(0);
  });

  test('refuses the same statement listed twice', async () => {
    const { app, line } = await openSplit();
    const res = await post(app, `/bank/lines/${line.id}/receipt`, {
      allocations: [{ batchId: 1, amountSen: 407777 }, { batchId: 1, amountSen: 407777 }],
    });
    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toBe('duplicate_batch');
  });

  /* Half a payout booked is worse than none: the second share failing must
     take the first one back, through the engine, not by deleting it. */
  test('a share that fails partway takes the earlier ones back', async () => {
    const { app, sb, line } = await openSplit();
    const res = await post(app, `/bank/lines/${line.id}/receipt`, {
      /* Statement 1 can take 7,284.48; statement 2 is owed only 871.06 and is
         handed 871.06 + 0.01 too much... so overshoot the second deliberately
         while keeping the total right. */
      allocations: [{ batchId: 1, amountSen: 728447 }, { batchId: 2, amountSen: 87107 }],
    });
    expect(res.status).toBe(409);
    expect((await res.json() as any).message).toMatch(/taken back/);
    /* Reversed through the ledger, so the contra exists and the row is gone. */
    expect(sb.tables.acc_settlement_receipts).toHaveLength(0);
    expect((sb.tables.journal_entries as Row[]).map((j) => j.source_type)).toContain('SETTLEBANK_REVERSAL');
  });

  test('undo takes back every receipt the split wrote', async () => {
    const { app, sb, line } = await openSplit();
    await post(app, `/bank/lines/${line.id}/receipt`, { allocations: line.split });
    expect(sb.tables.acc_settlement_receipts).toHaveLength(2);

    const res = await post(app, `/bank/lines/${line.id}/undo`);
    expect(res.status).toBe(200);
    expect(sb.tables.acc_settlement_receipts).toHaveLength(0);
  });
});

/* 这个 statement 如果我同一个月 submit 多次，他会想要重新 check 过？还是已经
   settle 了就不见了 (owner, 2026-08-20).

   The exact same FILE is refused by its hash. But a LONGER export of the same
   month is a different file carrying the same days, and its credits cannot be
   booked twice — the reports they paid are fully received, so the matcher finds
   nothing waiting and would call them PAYOUT_NO_BATCH, whose clue sends him off
   to reconcile a merchant report that is already done. Correct about the money,
   useless as an instruction. */
describe('uploading an overlapping period again', () => {
  const ready = () => harness({ acc_settlement_batches: [BATCH], acc_settlement_rows: [CONFIRMED_ROW] });

  test('names what was already recorded instead of calling it unexplained', async () => {
    const { app } = ready();
    const first = await (await upload(app)).json() as any;
    const detail = await (await app.request(`/bank/statements/${first.statementId}`)).json() as any;
    const payout = detail.lines.find((l: any) => l.kind === 'PAYOUT');
    await post(app, `/bank/lines/${payout.id}/receipt`, {
      allocations: [{ batchId: payout.matched_batch_id, amountSen: payout.amount_sen }],
    });

    /* The same month again, one line longer — a different file, same days.
       Since 2026-09-08 EVERY movement the earlier upload carries is recorded
       (the owner reconciles every few days: 可能隔几天我就做一次) — the posted
       credit AND the three still open on the first statement — and only the
       new deposit is work. */
    const longer = `${STATEMENT}\n${row('20260813', '000000000050000', 'CR', 'CDM CASH DEPOSIT', 'DEP1')}`;
    const again = await (await upload(app, { fileName: 'aug-v2.csv', content: longer })).json() as any;
    expect(again.ok).toBe(true);
    expect(again.kinds.DUPLICATE).toBe(4);

    /* And they arrive SETTLED — the owner: 当我重新上传他应该是 ignore 已经 recon
       了的 transaction. Nothing is left to press on a movement whose entry
       already exists, and the note says where each one already sits. */
    expect(again.alreadyRecorded).toBe(4);

    const d2 = await (await app.request(`/bank/statements/${again.statementId}`)).json() as any;
    const dup = d2.lines.find((l: any) => l.kind === 'DUPLICATE');
    expect(dup.reference).toBe('00113107');
    expect(dup.state).toBe('IGNORED');
    expect(dup.note).toMatch(/already recorded — /);
    expect(dup.note).not.toMatch(/still open there/);   // the posted one names its entry
    const stillOpenElsewhere = d2.lines.find((l: any) => l.kind === 'DUPLICATE' && l.reference === 'Jaslyn');
    expect(stillOpenElsewhere.note).toMatch(/already recorded — statement \d+ \(still open there\)/);

    /* So they are not in the work, and not in the difference either. */
    expect(d2.lines.filter((l: any) => l.state === 'OPEN').map((l: any) => l.reference)).toEqual(['DEP1']);
    const list = await (await app.request('/bank/statements')).json() as any;
    const listed = list.statements.find((x: any) => x.id === again.statementId);
    expect(listed.open_count).toBe(1);
  });

  test('the exact same file is refused outright, so nothing is re-checked', async () => {
    const { app } = ready();
    await upload(app);
    const again = await upload(app, { fileName: 'a-different-name.csv' });
    expect(again.status).toBe(409);
    expect((await again.json() as any).error).toBe('already_uploaded');
  });

  /* Keyed on all three, not the reference alone: three AEON payouts share a
     reference on one day and only the amount tells them apart. */
  test('a different amount on the same reference and day is NOT a duplicate', async () => {
    const { app } = ready();
    const first = await (await upload(app)).json() as any;
    const detail = await (await app.request(`/bank/statements/${first.statementId}`)).json() as any;
    const payout = detail.lines.find((l: any) => l.kind === 'PAYOUT');
    await post(app, `/bank/lines/${payout.id}/receipt`, {
      allocations: [{ batchId: payout.matched_batch_id, amountSen: payout.amount_sen }],
    });

    const other = [HEAD, row('20260803', '000000000999999', 'CR', 'CR/CARD SALES MN 32410011 DATED 31072026', '00113107')].join('\n');
    const again = await (await upload(app, { fileName: 'other.csv', content: other })).json() as any;
    expect(again.kinds.DUPLICATE).toBeUndefined();
  });
});

/* 不确定 maybank 对其他的卡机 (owner, 2026-08-20) — and he was right to doubt it.
   A payout was booked to the acquirer's CONFIGURED bank, whatever statement it
   actually appeared on. PBB set up to pay into Hong Leong, its credit turning
   up on the Maybank statement, booked to Hong Leong: Maybank's reconciliation
   permanently short by that amount and Hong Leong permanently over.

   The statement is evidence. The configuration is a guess made before the
   money moved, and it loses. */
describe('which bank a payout is booked to', () => {
  const elsewhere = () => harness({
    /* Configured to pay into Hong Leong… */
    acc_acquirers: [{ ...ACQ, bank_account_code: '331-0000' }],
    acc_settlement_batches: [BATCH],
    acc_settlement_rows: [CONFIRMED_ROW],
  });

  test('follows the statement the credit is on, not the acquirer setup', async () => {
    const { app, sb } = elsewhere();
    /* …but the credit arrives on the 330-0000 statement. */
    const up = await (await upload(app)).json() as any;
    const detail = await (await app.request(`/bank/statements/${up.statementId}`)).json() as any;
    const payout = detail.lines.find((l: any) => l.kind === 'PAYOUT');
    const res = await post(app, `/bank/lines/${payout.id}/receipt`, {
      allocations: [{ batchId: payout.matched_batch_id, amountSen: payout.amount_sen }],
    });
    expect(res.status).toBe(200);

    const lines = (sb.tables.journal_entry_lines as Row[]).filter((l) => Number(l.debit_sen ?? 0) > 0);
    expect(lines.map((l) => l.account_code)).toContain('330-0000');
    expect(lines.map((l) => l.account_code)).not.toContain('331-0000');
  });

  /* The fallback — a credit typed in by hand, with no statement to read —
     is pinned where postBatchReceipt itself is tested: src/acc/settlement.test.ts. */
});

/* ── The recognition-rules maintenance window (2026-09-02) ───────────────────
   Seed-only since 0336; now the owner's own screwdriver. The one hazard is a
   BROKEN regex silently un-recognising an acquirer's money, so a bad one is
   refused AT WRITE TIME with the engine's sentence. */
describe('bank recognition rules — maintenance', () => {
  test('lists every rule, off rows included', async () => {
    const { app } = harness();
    const res = await app.request('/bank/rules');
    expect(res.status).toBe(200);
    const body = await res.json() as { rules: Row[] };
    expect(body.rules.length).toBeGreaterThan(0);
  });

  test('a new rule for a known acquirer lands; an unknown acquirer is refused by name', async () => {
    const { app, sb } = harness();
    sb.tables.acc_acquirer_config.push({ code: 'MBB', display_name: 'MBB' });
    const ok = await post(app, '/bank/rules', { acquirerCode: 'MBB', pattern: 'CARD\s+SALES', matchField: 'both', sortOrder: 10 });
    expect(ok.status).toBe(200);
    expect(sb.tables.acc_bank_recognition_rules.some((r) => r.pattern === 'CARD\s+SALES')).toBe(true);

    const ghost = await post(app, '/bank/rules', { acquirerCode: 'NOPE', pattern: 'X' });
    expect(ghost.status).toBe(404);
    expect(((await ghost.json()) as Row).error).toBe('no_such_acquirer');
  });

  test('a regex that does not compile is refused with the engine sentence — nothing written', async () => {
    const { app, sb } = harness();
    sb.tables.acc_acquirer_config.push({ code: 'MBB', display_name: 'MBB' });
    const before = sb.tables.acc_bank_recognition_rules.length;
    const res = await post(app, '/bank/rules', { acquirerCode: 'MBB', pattern: '([unclosed' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as Row).error).toBe('invalid_rule');
    expect(sb.tables.acc_bank_recognition_rules.length).toBe(before);
  });

  test('a date pattern without a capture group is refused — the group IS the value', async () => {
    const { app, sb } = harness();
    sb.tables.acc_acquirer_config.push({ code: 'MBB', display_name: 'MBB' });
    const res = await post(app, '/bank/rules', { acquirerCode: 'MBB', pattern: 'X', tradingDatePattern: 'DATED \d{8}' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as Row).message).toMatch(/capture group/);
  });

  test('the off switch: PATCH is_active=false keeps the row, and a blanked pattern is refused', async () => {
    const { app, sb } = harness();
    const rule = sb.tables.acc_bank_recognition_rules[0]!;
    const off = await app.request(`/bank/rules/${rule.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ isActive: false }),
    });
    expect(off.status).toBe(200);
    expect(sb.tables.acc_bank_recognition_rules.find((r) => r.id === rule.id)!.is_active).toBe(false);

    const blank = await app.request(`/bank/rules/${rule.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pattern: '' }),
    });
    expect(blank.status).toBe(400);
    expect(((await blank.json()) as Row).error).toBe('pattern_required');
  });
});

/* ── A CLOSED MONTH REFUSES EVERY WRITE ───────────────────────────────────────
   Owner, 2026-09-08: 还有lock 起来不可以随便碰. The rule table is pinned pure in
   src/acc/bank-lock.test.ts; what is pinned HERE is that the guard is actually
   wired to each door — a rule nothing calls is a rule that does not exist, and
   this is the file where "every handler asks first" can be checked one handler
   at a time.

   The other thing pinned here: a lock is matched by the MOVEMENT'S OWN DATE.
   August's lock must not stop an August-dated file's September movements, and
   September's must stop them — that is bank-month rule 1 reaching the guard. */

/* SNAPSHOTTED AT MODULE LOAD, not inside the helper. The fixtures at the top of
   this file are shared objects and the fake client mutates rows IN PLACE — by
   the time a test body runs, the rules tests have switched rule 1 off and added
   a third, and the booking tests have received the batch. Cloning inside the
   helper would faithfully clone that damage; cloning here happens before any
   test body has run, which is the only moment the fixtures are still what they
   say they are. Without this every credit reads OTHER and the lock under test
   is proved against nothing. */
const PRISTINE = {
  rules: structuredClone(RULES),
  batch: structuredClone(BATCH),
  row: structuredClone(CONFIRMED_ROW),
};

const LOCK = (month: string, over: Row = {}): Row => ({
  id: 1, company_id: CO, account_code: '330-0000', period_month: `${month}-01`,
  locked_by: 'Chew', locked_at: '2026-10-02T03:14:00Z', lock_note: null,
  closing_statement_sen: null, closing_ledger_sen: null, difference_sen: null,
  statement_count: 3, was_complete: true, released_at: null, ...over,
});

describe('a month somebody has closed', () => {
  const openedThen = async (locks: Row[]) => {
    /* Upload FIRST, with no lock in place, so the movements exist; then close
       the month and try to work them. That is the real order — a lock always
       arrives after the month has been reconciled. */
    /* Every fixture from the module-load snapshot — see PRISTINE. */
    const rig = harness({
      acc_bank_recognition_rules: structuredClone(PRISTINE.rules),
      acc_settlement_batches: [structuredClone(PRISTINE.batch)],
      acc_settlement_rows: [structuredClone(PRISTINE.row)],
    });
    const up = await (await upload(rig.app)).json() as any;
    const detail = await (await rig.app.request(`/bank/statements/${up.statementId}`)).json() as any;
    rig.sb.tables.acc_bank_month_locks = locks;
    return { ...rig, statementId: up.statementId, lines: detail.lines as any[] };
  };

  test('refuses to book a credit, and says who closed it and when', async () => {
    const { app, lines } = await openedThen([LOCK('2026-08')]);
    const payout = lines.find((l) => l.kind === 'PAYOUT');
    const res = await post(app, `/bank/lines/${payout.id}/receipt`, { batchId: 1 });
    expect(res.status).toBe(409);
    const body = (await res.json()) as Row;
    expect(body.error).toBe('month_locked');
    expect(String(body.message)).toContain('330-0000 2026-08');
    expect(String(body.message)).toContain('Chew');
    expect(String(body.message)).toContain('2026-10-02');
  });

  test('refuses to leave a movement out', async () => {
    const { app, lines } = await openedThen([LOCK('2026-08')]);
    const res = await post(app, `/bank/lines/${lines[0].id}/ignore`, { note: 'own transfer' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as Row).error).toBe('month_locked');
  });

  test('refuses to undo a movement', async () => {
    const { app, lines } = await openedThen([LOCK('2026-08')]);
    const res = await post(app, `/bank/lines/${lines[0].id}/undo`);
    expect(res.status).toBe(409);
    expect(((await res.json()) as Row).error).toBe('month_locked');
  });

  test('refuses to match a movement to an entry', async () => {
    const { app, lines } = await openedThen([LOCK('2026-08')]);
    const res = await post(app, `/bank/lines/${lines[0].id}/match`, { jeNo: 'JE-2608-0001' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as Row).error).toBe('month_locked');
  });

  test('refuses a statement carrying that month, and names the date', async () => {
    const { app, sb } = harness({ acc_bank_recognition_rules: structuredClone(PRISTINE.rules) });
    sb.tables.acc_bank_month_locks = [LOCK('2026-08')];
    const res = await upload(app);
    expect(res.status).toBe(409);
    const body = (await res.json()) as Row;
    expect(body.error).toBe('month_locked');
    /* The date the refusal is about, so it is chaseable to a row in the file. */
    expect(String(body.message)).toContain('2026-08');
    /* And nothing was written — a refused upload must not leave half a
       statement behind. */
    expect(sb.tables.acc_bank_statements).toHaveLength(0);
  });

  /* THE DATE, NOT THE FILE. A lock on a month the file does not touch must not
     refuse it; the guard reads the movements' own dates. */
  test('a lock on another month does not refuse the work', async () => {
    const { app, lines } = await openedThen([LOCK('2026-03')]);
    const payout = lines.find((l) => l.kind === 'PAYOUT');
    const res = await post(app, `/bank/lines/${payout.id}/receipt`, { batchId: 1 });
    expect(res.status).toBe(200);
  });

  /* A RELEASED lock is not a lock. The row stays for ever as the record that
     the month was closed and reopened; only a live one stops a write. */
  test('a month that was reopened can be worked again', async () => {
    const { app, lines } = await openedThen([
      LOCK('2026-08', { released_at: '2026-10-05T01:00:00Z', released_by: 'Chew', release_note: 'bank re-issued' }),
    ]);
    const payout = lines.find((l) => l.kind === 'PAYOUT');
    const res = await post(app, `/bank/lines/${payout.id}/receipt`, { batchId: 1 });
    expect(res.status).toBe(200);
  });
});

/* ── THE OTHER DOOR INTO THE SAME ROOM ────────────────────────────────────────
   A credit booked from a bank statement writes a layer-3 receipt carrying
   `bank_line_id`. Layer 3 has its own undo button, and without a guard there the
   closed month could be changed simply by pressing the other one — the entry
   reversed, the reported figure no longer true, and the bank screen's refusal
   worth nothing. A credit TYPED BY HAND has no bank line and is none of the
   lock's business, which is why the guard is on the link. */

describe('layer 3 undo cannot reach into a closed bank month', () => {
  const booked = async () => {
    const rig = harness({
      acc_bank_recognition_rules: structuredClone(PRISTINE.rules),
      acc_settlement_batches: [structuredClone(PRISTINE.batch)],
      acc_settlement_rows: [structuredClone(PRISTINE.row)],
    });
    const up = await (await upload(rig.app)).json() as any;
    const detail = await (await rig.app.request(`/bank/statements/${up.statementId}`)).json() as any;
    const payout = (detail.lines as any[]).find((l) => l.kind === 'PAYOUT');
    const res = await post(rig.app, `/bank/lines/${payout.id}/receipt`, { batchId: 1 });
    expect(res.status).toBe(200);
    const receipts = rig.sb.tables.acc_settlement_receipts as Row[];
    expect(receipts).toHaveLength(1);
    return { ...rig, receiptId: receipts[0]!.id as number };
  };

  test('refuses to take back a credit that came off a closed month', async () => {
    const { app, sb, receiptId } = await booked();
    sb.tables.acc_bank_month_locks = [LOCK('2026-08')];
    const res = await post(app, `/settlement/receipts/${receiptId}/undo`);
    expect(res.status).toBe(409);
    const body = (await res.json()) as Row;
    expect(body.error).toBe('month_locked');
    expect(String(body.message)).toContain('taking this credit back');
    /* And nothing was reversed — a refusal that half-happened is worse than
       either answer. */
    expect((sb.tables.acc_settlement_receipts as Row[])).toHaveLength(1);
  });

  test('allows it while the month is open', async () => {
    const { app, receiptId } = await booked();
    const res = await post(app, `/settlement/receipts/${receiptId}/undo`);
    expect(res.status).toBe(200);
  });

  /* A credit nobody booked from a statement has no bank line, so no month owns
     it and the guard must not invent one. */
  test('a credit with no bank line behind it is not the lock business', async () => {
    const { app, sb } = harness({
      acc_settlement_batches: [structuredClone(PRISTINE.batch)],
      acc_settlement_rows: [structuredClone(PRISTINE.row)],
      acc_settlement_receipts: [{
        id: 1, company_id: CO, batch_id: 1, received_on: '2026-08-03',
        amount_sen: 728448, bank_line_id: null, je_no: 'JE-2608-0001',
      }],
    });
    sb.tables.acc_bank_month_locks = [LOCK('2026-08')];
    const res = await post(app, '/settlement/receipts/1/undo');
    expect(res.status).not.toBe(409);
  });
});
