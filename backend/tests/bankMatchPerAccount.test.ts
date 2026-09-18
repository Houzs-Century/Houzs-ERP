// One entry, one claim per bank account (docs/bugs/0917) — the same rig shape
// as bankRoutes.test.ts (which is at its size cap): a bare Hono app, a fake
// PostgREST client, a company and the statements' permission.
//
// Owner, 2026-09-15, on the Maybank side of the July transfer Maybank → HLBB
// (2990-JE-2607-0088), already matched on the HLB statement and refused on
// Maybank's with "one entry cannot account for two": 这个要做. An internal
// transfer is ONE journal with a leg on each bank; each bank's statement shows
// its own movement, and each may claim the entry once. A second claim on the
// SAME bank is still refused, and a bank the entry never touches cannot claim
// it at all.

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { bankUpload, bankStatementDetail, bankLineMatch, bankLinesMatchGroup } from '../src/scm/routes/accounting-bank';

const CO = 1;
const GL_PERM = 'scm.payment_voucher.post';

const CHART: Row[] = ['310-0020', '330-0000'].map((code) => ({
  account_code: code, account_name: code, account_type: 'ASSET', parent_code: null, is_active: true, company_id: CO, acc_money: true,
}));

/* Maybank, pipe delimited, integer sen, CR/DR in its own column; Hong Leong, the 2990 shape. */
const MBB_ACCOUNT: Row = {
  id: 1, company_id: CO, account_code: '330-0000', bank_code: 'MBB',
  account_no: '0000564418610346', statement_format: 'CSV', delimiter: '|',
  amount_format: 'integer-sen', credit_indicator: 'CR', is_active: true,
  column_map: { date: 'EFFECT DATE', description: 'TRX DESCRIPTION', reference: 'TRX REFERENCE', amount: 'AMOUNT', indicator: 'AMOUNT IND' },
};
const HLB_ACCOUNT: Row = {
  id: 2, company_id: CO, account_code: '310-0020', bank_code: 'HLB',
  account_no: '23600600000', statement_format: 'CSV', delimiter: null,
  amount_format: 'decimal', credit_indicator: 'CR', is_active: true,
  column_map: {
    date: ['Date', 'Transaction Date'], description: ['Transaction Description', 'Remarks'],
    reference: ['Ref. No.'], debit: ['Withdrawal'], credit: ['Deposit'], balance: ['Balance'],
  },
};

const HEAD = 'BATCH DATE|ACCOUNT NO.|PROD TYPE|EFFECT DATE|EFFECT TIME|BRANCH|TELLER|CODE|SOURCE CODE|AMOUNT|AMOUNT IND|TRX DESCRIPTION|TRX REFERENCE';
const row = (date: string, sen: string, ind: string, desc: string, ref: string) =>
  `${date}|0000564418610346|CA|${date}|103009|2988|CEB4PHON|7610|003|${sen}|${ind}|${desc}|${ref}`;

/* The transfer: one journal, a leg on each bank — and a voucher that touches Maybank alone. */
const TRANSFER: Row[] = [
  { company_id: CO, account_code: '330-0000', je_no: 'JE-2607-0088', entry_date: '2026-07-08', source_type: 'PV', source_doc_no: 'MPV-2607-001', debit_sen: 0, credit_sen: 2000000, party_name: 'Internal transfer to 310-0020 CASH AT BANK - HLBB', notes: null },
  { company_id: CO, account_code: '310-0020', je_no: 'JE-2607-0088', entry_date: '2026-07-08', source_type: 'PV', source_doc_no: 'MPV-2607-001', debit_sen: 2000000, credit_sen: 0, party_name: 'Internal transfer to 310-0020 CASH AT BANK - HLBB', notes: null },
  { company_id: CO, account_code: '330-0000', je_no: 'JE-2607-0090', entry_date: '2026-07-09', source_type: 'PV', source_doc_no: 'MPV-2607-002', debit_sen: 0, credit_sen: 500000, party_name: 'TNB', notes: null },
];
const HLB_JULY = [
  'HLB PRIMEBIZ CURRENT ACCOUNT - 23600600000,',
  'Date,Transaction Description,Cheque No.,Ref. No.,Deposit,Withdrawal,Balance',
  '="",="Balance from previous statement",="",="",="",="",="1000.00"',
  '="08-07-2026",="Instant Transfer at KLM",="",="2990 HOME SDN BHD 20260708MBBEMYKL010ORB2001",="20000.00",="",="21000.00"',
].join('\n');
const MBB_JULY = [
  HEAD,
  row('20260708', '000000002000000', 'DR', 'MBB CT 2990 HOME SDN. BHD.*', '2990 HOME SDN'),
  /* Named unlike its voucher, so the upload's amount+name matcher (docs/bugs/0814) leaves it open. */
  row('20260709', '000000000500000', 'DR', 'ELECTRICITY BILL', 'ELECTRIC'),
].join('\n');

function harness() {
  const sb = fakeSb(
    {
      accounts: CHART, acc_account_roles: [],
      acc_acquirers: [], acc_acquirer_config: [], acc_company_acquirers: [],
      acc_bank_statement_config: [MBB_ACCOUNT, HLB_ACCOUNT],
      acc_bank_recognition_rules: [],
      acc_bank_statements: [], acc_bank_statement_lines: [], acc_bank_statement_matches: [],
      acc_bank_month_balances: [], acc_bank_month_locks: [],
      acc_settlement_batches: [], acc_settlement_rows: [], acc_settlement_matches: [], acc_settlement_receipts: [],
      journal_entries: [], journal_entry_lines: [], v_gl_entries: TRANSFER.map((e) => ({ ...e })),
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
    c.set('houzsUser' as never, { name: 'Tester', permissions_set: [GL_PERM] } as never);
    c.set('allowedCompanyIds' as never, [1, 2] as never);
    await next();
  });
  app.post('/bank/statements', bankUpload as never);
  app.get('/bank/statements/:id', bankStatementDetail as never);
  app.post('/bank/lines/:id/match', bankLineMatch as never);
  app.post('/bank/lines/match-group', bankLinesMatchGroup as never);
  return { app, sb };
}

const post = (app: Hono, path: string, body: Record<string, unknown> = {}) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const bothUploaded = async (app: Hono) => {
  const hlb = await (await post(app, '/bank/statements', { accountCode: '310-0020', fileName: 'acs_23600600000_31072026.csv', content: HLB_JULY, statementMonth: '2026-07' })).json() as any;
  const mbb = await (await post(app, '/bank/statements', { accountCode: '330-0000', fileName: 'mbb-july.csv', content: MBB_JULY })).json() as any;
  const hlbDetail = await (await app.request(`/bank/statements/${hlb.statementId}`)).json() as any;
  const mbbDetail = await (await app.request(`/bank/statements/${mbb.statementId}`)).json() as any;
  return {
    hlbIn: hlbDetail.lines.find((l: any) => Number(l.amount_sen) === 2000000),
    mbbOut: mbbDetail.lines.find((l: any) => Number(l.amount_sen) === -2000000),
    mbbTnb: mbbDetail.lines.find((l: any) => Number(l.amount_sen) === -500000),
    hlb, mbb,
  };
};

describe('an internal transfer is one entry on two statements', () => {
  test('the HLB deposit and the Maybank withdrawal both claim the transfer — each by its own leg', async () => {
    const { app, sb } = harness();
    const { hlbIn, mbbOut, hlb, mbb } = await bothUploaded(app);
    expect((await post(app, `/bank/lines/${hlbIn.id}/match`, { jeNo: 'JE-2607-0088' })).status).toBe(200);
    const second = await post(app, `/bank/lines/${mbbOut.id}/match`, { jeNo: 'JE-2607-0088' });
    expect(second.status, await second.clone().text()).toBe(200);
    const rows = (sb.tables.acc_bank_statement_matches as Row[]).filter((r) => r.je_no === 'JE-2607-0088');
    expect(rows.map((r) => r.bank_line_id).sort()).toEqual([hlbIn.id, mbbOut.id].sort());
    /* Both statements reconcile with the entry claimed on each, and the HLB side kept its match. */
    for (const id of [hlb.statementId, mbb.statementId]) {
      const detail = await (await app.request(`/bank/statements/${id}`)).json() as any;
      expect(detail.reconciliation.unmatchedJeNos).not.toContain('JE-2607-0088');
    }
    expect((sb.tables.acc_bank_statement_lines as Row[]).find((l) => l.id === hlbIn.id)).toMatchObject({ state: 'POSTED', posted_je_no: 'JE-2607-0088' });
  });

  test("a second movement of the SAME bank is still refused, by the bank's name", async () => {
    const { app } = harness();
    const { mbbOut, mbbTnb } = await bothUploaded(app);
    expect((await post(app, `/bank/lines/${mbbOut.id}/match`, { jeNo: 'JE-2607-0088' })).status).toBe(200);
    const twice = await post(app, `/bank/lines/${mbbTnb.id}/match`, { jeNo: 'JE-2607-0088' });
    expect(twice.status).toBe(409);
    expect((await twice.json() as any).message).toMatch(/already reconciled against another movement on 330-0000's statements/);
  });

  test('a bank the entry never touches cannot claim it once its own bank has', async () => {
    const { app } = harness();
    const { hlbIn, mbbTnb } = await bothUploaded(app);
    /* TNB's voucher lives on Maybank alone; claim it there first, then HLB tries. */
    expect((await post(app, `/bank/lines/${mbbTnb.id}/match`, { jeNo: 'JE-2607-0090' })).status).toBe(200);
    const stranger = await post(app, `/bank/lines/${hlbIn.id}/match`, { jeNo: 'JE-2607-0090' });
    expect(stranger.status).toBe(409);
    const body = await stranger.json() as any;
    expect(body).toMatchObject({ error: 'not_this_account' });
    expect(body.message).toMatch(/has no line on 310-0020/);
  });

  test("the group match follows the same rule — the other bank's claim stands, this bank's refuses", async () => {
    const { app } = harness();
    const { hlbIn, mbbOut, mbbTnb } = await bothUploaded(app);
    expect((await post(app, `/bank/lines/${hlbIn.id}/match`, { jeNo: 'JE-2607-0088' })).status).toBe(200);
    const res = await post(app, '/bank/lines/match-group', { lineIds: [mbbOut.id], jeNos: ['JE-2607-0088'] });
    expect(res.status, await res.clone().text()).toBe(200);
    const again = await post(app, '/bank/lines/match-group', { lineIds: [mbbTnb.id], jeNos: ['JE-2607-0088'] });
    expect(again.status).toBe(409);
    expect((await again.json() as any).message).toMatch(/330-0000's statements/);
  });
});
