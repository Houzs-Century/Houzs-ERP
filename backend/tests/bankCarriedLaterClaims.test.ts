// A payment the bank paid two months later.
//
// 2990's Hong Leong, 2026: a RM 6,024.06 voucher dated 29 May the bank paid on
// 8 July. At 30 June it is outstanding, and June closed on that (11/09). Then
// July was matched (14/09), the July line claimed the voucher, and June — read
// again to close it once more — no longer carried it: a claim from a LATER month
// counted as "claimed elsewhere", and June was RM 6,024.06 out (2 Nov 2026).
//
// Pinned through the bank routes, on the same harness shape as bankRoutes.test.ts:
//   • June carries the May payment before July is matched AND after it, tallies,
//     and closes;
//   • the June statement's own view carries it too;
//   • July shows it paid, not waiting.

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { bankUpload, bankStatementDetail, bankLineMatch } from '../src/scm/routes/accounting-bank';
import { bankMonthDetail } from '../src/scm/routes/accounting-bank-months';
import { bankMonthLock } from '../src/scm/routes/accounting-bank-locks';

const CO = 1;

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

function harness() {
  const sb = fakeSb(
    {
      accounts: [], acc_account_roles: [],
      acc_acquirers: [], acc_acquirer_config: [], acc_company_acquirers: [],
      acc_bank_statement_config: [HLB_ACCOUNT],
      acc_bank_recognition_rules: [],
      acc_bank_statements: [], acc_bank_statement_lines: [], acc_bank_statement_matches: [],
      acc_bank_month_balances: [], acc_bank_month_locks: [],
      acc_settlement_batches: [], acc_settlement_rows: [], acc_settlement_matches: [], acc_settlement_receipts: [],
      journal_entries: [], journal_entry_lines: [],
      v_gl_entries: [
        { company_id: CO, account_code: '310-0020', je_no: 'JE-2605-0001', entry_date: '2026-05-02', source_type: 'RCT', source_doc_no: 'OR-2605-001', debit_sen: 100000, credit_sen: 0, party_name: 'A CUSTOMER', notes: null },
        { company_id: CO, account_code: '310-0020', je_no: 'JE-2605-0029', entry_date: '2026-05-29', source_type: 'PV', source_doc_no: 'HPV-2605-029', debit_sen: 0, credit_sen: 20000, party_name: 'A SUPPLIER SDN BHD', notes: null },
      ],
    },
    {},
    [{ table: 'acc_bank_statements', column: 'file_hash', name: 'acc_bank_stmt_once' }],
    ['acc_bank_statements', 'acc_bank_statement_lines', 'acc_bank_statement_matches', 'acc_bank_month_balances', 'acc_bank_month_locks'],
  );
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, CO as never);
    c.set('houzsUser' as never, { name: 'Tester', permissions_set: ['scm.payment_voucher.post'] } as never);
    c.set('allowedCompanyIds' as never, [CO] as never);
    await next();
  });
  app.post('/bank/statements', bankUpload as never);
  app.get('/bank/statements/:id', bankStatementDetail as never);
  app.post('/bank/lines/:id/match', bankLineMatch as never);
  app.get('/bank/months/:accountCode/:month', bankMonthDetail as never);
  app.post('/bank/months/:accountCode/:month/lock', bankMonthLock as never);
  return { app, sb };
}

const post = (app: Hono, path: string, body: Record<string, unknown> = {}) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const HLB = (balanceFrom: string, ...rows: string[]) => [
  'HLB PRIMEBIZ CURRENT ACCOUNT - 23600600000,',
  'Date,Transaction Description,Cheque No.,Ref. No.,Deposit,Withdrawal,Balance',
  `="",="Balance from previous statement",="",="",="",="",="${balanceFrom}"`,
  ...rows,
].join('\n');
const file = (app: Hono, month: string, content: string) =>
  post(app, '/bank/statements', { accountCode: '310-0020', fileName: `acs_23600600000_${month}.csv`, content, statementMonth: month });
const lineOf = async (app: Hono, statementId: number, amountSen: number) =>
  ((await (await app.request(`/bank/statements/${statementId}`)).json()) as any).lines.find((l: any) => Number(l.amount_sen) === amountSen);

describe('an earlier entry the bank paid in a later month', () => {
  test('June carries it and closes, before July is matched and after', async () => {
    const { app, sb } = harness();
    const may = await (await file(app, '2026-05', HLB('0.00', '="02-05-2026",="Fund Transfer at DIO",="",="A CUSTOMER",="1000.00",="",="1000.00"'))).json() as any;
    expect((await post(app, `/bank/lines/${(await lineOf(app, may.statementId, 100000)).id}/match`, { jeNo: 'JE-2605-0001' })).status).toBe(200);
    const june = await (await file(app, '2026-06', HLB('1000.00'))).json() as any;
    expect(june.ok).toBe(true);
    const juneNow = async () => (await (await app.request('/bank/months/310-0020/2026-06')).json()) as any;
    expect((await juneNow()).reconciliation).toMatchObject({ carried: { count: 1, sen: -20000 }, computedClosingSen: 100000, tallies: true });

    const july = await (await file(app, '2026-07', HLB('1000.00', '="08-07-2026",="CIB Instant Transfer at DIO",="",="PAYEE 7781",="",="200.00",="800.00"'))).json() as any;
    expect((await post(app, `/bank/lines/${(await lineOf(app, july.statementId, -20000)).id}/match`, { jeNo: 'JE-2605-0029' })).status).toBe(200);

    /* July paid it — June, at its own end, still waited for it. */
    const after = await juneNow();
    expect(after.reconciliation).toMatchObject({ carried: { count: 1, sen: -20000 }, computedClosingSen: 100000, unexplainedSen: 0, tallies: true });
    expect(after.reconciliation.carriedJeNos).toEqual(['JE-2605-0029']);
    const juneFile = (await (await app.request(`/bank/statements/${june.statementId}`)).json()) as any;
    expect(juneFile.reconciliation).toMatchObject({ carried: { count: 1, sen: -20000 }, tallies: true });
    expect((await post(app, '/bank/months/310-0020/2026-06/lock', {})).status).toBe(200);
    expect(sb.tables.acc_bank_month_locks[0]).toMatchObject({ closing_statement_sen: 100000, closing_ledger_sen: 80000 });

    /* And July shows it paid, not waiting. */
    const julyNow = (await (await app.request('/bank/months/310-0020/2026-07')).json()) as any;
    expect(julyNow.reconciliation).toMatchObject({ carried: { count: 0, sen: 0 }, tallies: true });
  });
});
