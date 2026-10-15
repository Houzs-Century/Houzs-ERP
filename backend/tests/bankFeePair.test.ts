/* Maybank pays a card report's GROSS and takes the fee back the same day
   (owner 2026-08-19: 据我所知 mbb merchant 偶尔会在 bank statement 显示进全额然后扣;
   2026-10-15 on 2990's September: 这一笔RM4048.00是要扣RM18.22的 … 做).
   Its statement PDF prints no reference, so the pair used to come in as two
   rows that matched nothing. Pinned at the routes:
     • such a file comes in as ONE movement — the net, carrying the fee as its
       charge — decided for the report it pays;
     • Money received books that one movement, on the bank's date, for the net;
     • a credit and a debit no acquirer rule can vouch for stay two movements.
   The rule itself is pinned in src/acc/bank-match.test.ts, the repair for a
   statement already in, in src/acc/bank-regroup.test.ts. Real handlers, fake
   PostgREST. */

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { bankUpload, bankStatementDetail, bankLineReceipt } from '../src/scm/routes/accounting-bank';

const CO = 2;
const GL_PERM = 'scm.payment_voucher.post';
const BANK = '310-0010';

const CHART: Row[] = [BANK, '320-0000', '930-0000'].map((code) => ({
  account_code: code, account_name: code, account_type: 'ASSET', parent_code: null, is_active: true, company_id: CO,
}));
const MBB_ACCOUNT: Row = {
  id: 1, company_id: CO, account_code: BANK, bank_code: 'MBB',
  account_no: '0000564418759397', statement_format: 'CSV', delimiter: '|',
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
  transit_account_code: '320-0000', fee_account_code: '930-0000', bank_account_code: BANK,
  statement_format: 'CSV', has_unique_ref: true, fee_method: 'stated',
  date_tolerance_days: 3, is_active: true, column_map: {},
};
/* Report 96 exactly as production holds it: gross 4,048.00, fee 18.22, net 4,029.78. */
const REPORT: Row = {
  id: 96, company_id: CO, acquirer_code: 'MBB', file_name: '027032649949_DVS04E_1_20260906.CSV',
  period_from: '2026-09-06', period_to: '2026-09-06', gross_sen: 404800, fee_sen: 1822,
  net_sen: 402978, stated_net_sen: 402978, adjustment_sen: 0, status: 'OPEN',
};

const HEAD = 'BATCH DATE|ACCOUNT NO.|PROD TYPE|EFFECT DATE|EFFECT TIME|BRANCH|TELLER|CODE|SOURCE CODE|AMOUNT|AMOUNT IND|TRX DESCRIPTION|TRX REFERENCE';
const row = (date: string, sen: string, ind: string, desc: string, ref: string) =>
  `${date}|0000564418759397|CA|${date}|103009|2988|CEB4PHON|7610|003|${sen}|${ind}|${desc}|${ref}`;
/* The PDF's shape: the pair carries no reference at all. */
const SEPTEMBER = [
  HEAD,
  row('20260907', '000000000404800', 'CR', 'DR/CARD SALES M/N 2649949 D 9', ''),
  row('20260907', '000000000500000', 'DR', 'CIB Instant Transfer', ''),
  row('20260907', '000000000001822', 'DR', 'DR/CARD SALES M/N 2649949 D 9', ''),
  row('20260907', '000000000300000', 'CR', 'FUND TRANSFER', ''),
  row('20260907', '000000000020000', 'DR', 'FUND TRANSFER', ''),
].join('\n');

function harness() {
  const sb = fakeSb(
    {
      accounts: CHART, acc_account_roles: [],
      acc_acquirers: [ACQ], acc_acquirer_config: [], acc_company_acquirers: [],
      acc_bank_statement_config: [MBB_ACCOUNT], acc_bank_recognition_rules: RULES,
      acc_bank_statements: [], acc_bank_statement_lines: [], acc_bank_statement_matches: [],
      acc_bank_month_balances: [], acc_bank_month_locks: [],
      acc_settlement_batches: [REPORT], acc_settlement_rows: [], acc_settlement_matches: [], acc_settlement_receipts: [],
      acc_settlement_payouts: [], acc_settlement_payout_batches: [],
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
  return { app, sb };
}
const post = (app: Hono, path: string, body: Record<string, unknown> = {}) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('a Maybank gross-and-fee pair with no reference', () => {
  test('comes in as one movement — the net, the fee as its charge — decided for the report it pays', async () => {
    const { app, sb } = harness();
    const res = await post(app, '/bank/statements', { accountCode: BANK, fileName: 'MBBcurrent_564418759397_2026-09-30.csv', content: SEPTEMBER });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toMatchObject({ lines: 4, joinedPairs: 1 });
    const lines = (sb.tables.acc_bank_statement_lines as Row[]).sort((a, b) => Number(a.line_no) - Number(b.line_no));
    const card = lines.find((l) => Number(l.amount_sen) === 402978)!;
    expect(card).toMatchObject({ charge_sen: 1822, kind: 'PAYOUT', matched_batch_id: 96, merchant_no: '2649949', state: 'OPEN' });
    expect(lines.some((l) => Number(l.amount_sen) === -1822)).toBe(false);
    /* A transfer in and a transfer out that share only their words stay two. */
    expect(lines.filter((l) => l.description === 'FUND TRANSFER').map((l) => l.amount_sen)).toEqual([300000, -20000]);
  });

  test('Money received books it once, for the net, on the bank date', async () => {
    const { app, sb } = harness();
    const up = await (await post(app, '/bank/statements', { accountCode: BANK, fileName: 'MBBcurrent_564418759397_2026-09-30.csv', content: SEPTEMBER })).json() as any;
    const card = (sb.tables.acc_bank_statement_lines as Row[]).find((l) => Number(l.amount_sen) === 402978)!;
    const res = await post(app, `/bank/lines/${card.id}/receipt`, { batchId: 96 });
    expect(res.status, await res.clone().text()).toBe(200);
    const receipts = sb.tables.acc_settlement_receipts as Row[];
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ batch_id: 96, amount_sen: 402978, received_on: '2026-09-07', bank_line_id: card.id });
    const after = (sb.tables.acc_bank_statement_lines as Row[]).find((l) => l.id === card.id)!;
    expect(after.state).toBe('POSTED');
    expect(String(after.posted_je_no)).toBe(String(receipts[0]!.je_no));
    const je = (sb.tables.journal_entries as Row[]).find((j) => j.je_no === receipts[0]!.je_no)!;
    const legs = (sb.tables.journal_entry_lines as Row[]).filter((l) => String(l.je_id ?? l.journal_entry_id) === String(je.id));
    expect(legs.find((l) => l.account_code === BANK)).toMatchObject({ debit_sen: 402978 });
    expect(up.statementId).toBeTruthy();
  });
});
