/* A bank credit short by a charge the acquirer kept (owner 2026-09-30: 这个RM54
   是charges 来的，和之前的public bank一样 → 做). GHL paid RM 3,128.40 against a
   report owed RM 3,182.40 and sends no advice to book the RM 54.00 on, so the
   credit is booked from its bank line WITH the charge. Pinned at the route:
     • the credit and the charge book together; the movement posts, and the
       report is no longer owed anything, so it is offered to no other line;
     • undo takes back both entries;
     • a charge named against a report this credit does not pay is refused.
   The ledger side (entry dates, lines, the refusals) is pinned in
   src/acc/settlement-receipt-charge.test.ts. Real handlers, fake PostgREST. */

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { bankUpload, bankStatementDetail, bankLineReceipt, bankLineUndo } from '../src/scm/routes/accounting-bank';

const CO = 1;
const GL_PERM = 'scm.payment_voucher.post';

const CHART: Row[] = [
  ...['320-0000', '330-0000', '930-0000'].map((code) => ({
    account_code: code, account_name: code, account_type: 'ASSET', parent_code: null, is_active: true, company_id: CO,
  })),
  { account_code: '930-0001', account_name: 'TERMINAL RENTAL', account_type: 'EXPENSE', parent_code: null, is_active: true, company_id: CO },
];

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
const HEAD = 'BATCH DATE|ACCOUNT NO.|PROD TYPE|EFFECT DATE|EFFECT TIME|BRANCH|TELLER|CODE|SOURCE CODE|AMOUNT|AMOUNT IND|TRX DESCRIPTION|TRX REFERENCE';
const STATEMENT = [
  HEAD,
  '20260803|0000564418610346|CA|20260803|103009|2988|CEB4PHON|7610|003|000000000728448|CR|CR/CARD SALES MN 32410011 DATED 31072026|00113107',
].join('\n');

/* The report is owed RM 54.00 more than the bank credited. */
const OWED_SEN = 728448 + 5400;
const BATCH: Row = {
  id: 1, company_id: CO, acquirer_code: 'MBB', file_name: 'mbb-0731.csv',
  period_from: '2026-07-31', period_to: '2026-07-31',
  net_sen: OWED_SEN, stated_net_sen: null, adjustment_sen: 0, status: 'OPEN',
};
const CONFIRMED_ROW: Row = {
  id: 1, batch_id: 1, company_id: CO, acquirer_code: 'MBB', line_no: 1,
  txn_date: '2026-07-31', gross_sen: 745400, fee_sen: 11552, net_sen: OWED_SEN,
  bucket: 'MATCHED', confirmed_at: '2026-08-01T00:00:00Z',
};
const ACQ: Row = {
  company_id: CO, code: 'MBB', display_name: 'MBB',
  transit_account_code: '320-0000', fee_account_code: '930-0000', bank_account_code: '330-0000',
  statement_format: 'CSV', has_unique_ref: true, fee_method: 'stated',
  date_tolerance_days: 3, is_active: true, column_map: {},
};

function harness() {
  const sb = fakeSb(
    {
      accounts: CHART, acc_account_roles: [],
      acc_acquirers: [ACQ], acc_acquirer_config: [], acc_company_acquirers: [],
      acc_bank_statement_config: [MBB_ACCOUNT],
      acc_bank_recognition_rules: RULES,
      acc_bank_statements: [], acc_bank_statement_lines: [], acc_bank_statement_matches: [],
      acc_bank_month_balances: [],
      acc_settlement_batches: [BATCH], acc_settlement_rows: [CONFIRMED_ROW], acc_settlement_matches: [], acc_settlement_receipts: [],
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
    c.set('houzsUser' as never, { name: 'Tester', permissions_set: [GL_PERM] } as never);
    c.set('allowedCompanyIds' as never, [1, 2] as never);
    await next();
  });
  app.post('/bank/statements', bankUpload as never);
  app.get('/bank/statements/:id', bankStatementDetail as never);
  app.post('/bank/lines/:id/receipt', bankLineReceipt as never);
  app.post('/bank/lines/:id/undo', bankLineUndo as never);
  return { app, sb };
}

const post = (app: Hono, path: string, body: Record<string, unknown> = {}) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/* Upload the statement and return its one card credit. */
async function theCredit(app: Hono) {
  const up = await (await post(app, '/bank/statements', { accountCode: '330-0000', fileName: 'aug.csv', content: STATEMENT })).json() as any;
  const detail = await (await app.request(`/bank/statements/${up.statementId}`)).json() as any;
  return { statementId: up.statementId as number, line: detail.lines.find((l: any) => Number(l.amount_sen) === 728448) };
}

const kept = { amountSen: 5400, accountCode: '930-0001', note: 'Terminal rental' };

describe('a credit short by a charge the acquirer kept', () => {
  test('books the credit and the charge; the movement posts and the report is no longer owed', async () => {
    const { app, sb } = harness();
    const { statementId, line } = await theCredit(app);
    expect(line.candidates.map((b: any) => b.outstandingSen)).toEqual([OWED_SEN]);

    const res = await post(app, `/bank/lines/${line.id}/receipt`, { allocations: [{ batchId: 1, amountSen: 728448 }], charge: { batchId: 1, ...kept } });
    expect(res.status).toBe(200);
    expect((await res.json() as any).results).toEqual([expect.objectContaining({ batchId: 1, outstandingSen: 0, chargeSen: 5400 })]);
    expect(sb.tables.acc_settlement_receipts[0]).toMatchObject({ amount_sen: 728448, charge_sen: 5400, charge_account_code: '930-0001', bank_line_id: line.id });
    expect((sb.tables.acc_bank_statement_lines as Row[]).find((l) => l.id === line.id)!.state).toBe('POSTED');
    const after = await (await app.request(`/bank/statements/${statementId}`)).json() as any;
    for (const l of after.lines as any[]) expect((l.candidates as any[]).map((b) => b.id)).not.toContain(1);

    /* And back out again — both entries. */
    expect((await post(app, `/bank/lines/${line.id}/undo`)).status).toBe(200);
    const sources = (sb.tables.journal_entries as Row[]).map((j) => j.source_type);
    expect(sources).toEqual(expect.arrayContaining(['SETTLEBANK', 'SETTLECHARGE', 'SETTLEBANK_REVERSAL', 'SETTLECHARGE_REVERSAL']));
  });

  test('a charge named against a report this credit does not pay is refused, and nothing is written', async () => {
    const { app, sb } = harness();
    const { line } = await theCredit(app);
    const res = await post(app, `/bank/lines/${line.id}/receipt`, { allocations: [{ batchId: 1, amountSen: 728448 }], charge: { batchId: 99, ...kept } });
    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toBe('charge_batch');
    expect(sb.tables.acc_settlement_receipts).toHaveLength(0);
    expect(sb.tables.journal_entries).toHaveLength(0);
  });
});
