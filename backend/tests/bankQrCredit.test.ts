// The bank's DuitNow QR credit (owner 2026-11-09: 「这个hlbb merchant 的0000PP 是
// qr direct 去bank 的，不算卡机的」 → 「A 照传，做」).
//
// 2990, Hong Leong 310-0020: on 02/11 the bank credits RM 5,500 as
// "00005992284 MERCHAN T 20261031" — the QR report of 31/10, RM 3,500 + RM 2,000.
// Both sales were keyed Online and booked straight to 310-0020, so the credit is
// that money, already in the books. Pinned through the bank routes:
//   • the month and the statement show the credit as QR money with the two
//     sales' entries, ready, and offer no report to book a payout against;
//   • one match-group press matches it to those entries;
//   • while a QR line has no sale linked, it says so and is not ready.

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { bankUpload, bankStatementDetail, bankLinesMatchGroup } from '../src/scm/routes/accounting-bank';
import { bankMonthDetail } from '../src/scm/routes/accounting-bank-months';

const CO = 2;

const HLB_ACCOUNT: Row = {
  id: 2, company_id: CO, account_code: '310-0020', bank_code: 'HLB',
  account_no: '23600602788', statement_format: 'CSV', delimiter: null,
  amount_format: 'decimal', credit_indicator: 'CR', is_active: true,
  column_map: {
    date: ['Date', 'Transaction Date'], description: ['Transaction Description', 'Remarks'],
    reference: ['Ref. No.'], debit: ['Withdrawal'], credit: ['Deposit'], balance: ['Balance'],
  },
};

const HLB_RULE: Row = {
  acquirer_code: 'HLB', pattern: 'CA Credit Advice', match_field: 'both',
  trading_date_pattern: 'MERCHAN\\s*T\\s+(\\d{8})', merchant_pattern: '(\\d{9,})\\s+MERCHAN', sort_order: 1, is_active: true,
};

const qrRow = (id: number, lineNo: number, grossSen: number, confirmed: boolean): Row => ({
  id, batch_id: 384, company_id: CO, acquirer_code: 'HLB', line_no: lineNo, txn_date: '2026-10-31', ref: null,
  gross_sen: grossSen, fee_sen: 0, net_sen: grossSen, bucket: confirmed ? 'MATCHED' : 'UNMATCHED',
  match_reason: confirmed ? 'manual' : null, confirmed_at: confirmed ? '2026-11-09T08:00:00Z' : null,
  posted_je_no: null, notes: null, channel: 'QR', matched_with_row_id: null, not_this: [],
});

function harness(opts: { linkBoth?: boolean } = {}) {
  const linkBoth = opts.linkBoth ?? true;
  const sb = fakeSb(
    {
      accounts: [], acc_account_roles: [],
      acc_acquirers: [], acc_acquirer_config: [], acc_company_acquirers: [],
      acc_bank_statement_config: [HLB_ACCOUNT],
      acc_bank_recognition_rules: [HLB_RULE],
      acc_bank_statements: [], acc_bank_statement_lines: [], acc_bank_statement_matches: [],
      acc_bank_month_balances: [], acc_bank_month_locks: [],
      acc_settlement_batches: [{
        id: 384, company_id: CO, acquirer_code: 'HLB', file_name: '00005992284_20261031.CSV', period_from: '2026-10-31', period_to: '2026-10-31',
        row_count: 2, gross_sen: 0, fee_sen: 0, net_sen: 0, stated_net_sen: null,
      }],
      acc_settlement_rows: [qrRow(847, 17, 350000, linkBoth), qrRow(848, 18, 200000, true)],
      acc_settlement_matches: [
        ...(linkBoth ? [{ id: 1, settlement_row_id: 847, company_id: CO, payment_source: 'SOPAY', payment_id: 'p35', doc_no: '2990-SO-2611-077', amount_sen: 350000 }] : []),
        { id: 2, settlement_row_id: 848, company_id: CO, payment_source: 'SOPAY', payment_id: 'mia', doc_no: '2990-SO-2611-019', amount_sen: 200000 },
      ],
      acc_settlement_receipts: [], acc_settlement_payout_batches: [], acc_settlement_payouts: [],
      mfg_sales_order_payments: [], mfg_sales_orders: [], acc_official_receipts: [],
      journal_entries: [
        { id: 'je35', company_id: CO, je_no: '2990-JE-2611-0500', source_type: 'SOPAY', source_doc_no: 'p35', posted: true, reversed: false },
        { id: 'jemia', company_id: CO, je_no: '2990-JE-2610-0448', source_type: 'SOPAY', source_doc_no: 'mia', posted: true, reversed: false },
      ],
      journal_entry_lines: [
        { journal_entry_id: 'je35', line_no: 1, account_code: '310-0020', debit_sen: 350000, credit_sen: 0 },
        { journal_entry_id: 'je35', line_no: 2, account_code: '300-0000', debit_sen: 0, credit_sen: 350000 },
        { journal_entry_id: 'jemia', line_no: 1, account_code: '310-0020', debit_sen: 200000, credit_sen: 0 },
        { journal_entry_id: 'jemia', line_no: 2, account_code: '300-0000', debit_sen: 0, credit_sen: 200000 },
      ],
      v_gl_entries: [
        { company_id: CO, account_code: '310-0020', je_no: '2990-JE-2610-0448', entry_date: '2026-10-31', source_type: 'SOPAY', source_doc_no: 'mia', debit_sen: 200000, credit_sen: 0, party_name: 'Mia Onn', notes: null },
        { company_id: CO, account_code: '310-0020', je_no: '2990-JE-2611-0500', entry_date: '2026-11-01', source_type: 'SOPAY', source_doc_no: 'p35', debit_sen: 350000, credit_sen: 0, party_name: 'A QR CUSTOMER', notes: null },
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
    c.set('houzsUser' as never, { name: 'Chew', permissions_set: ['scm.payment_voucher.post'] } as never);
    c.set('allowedCompanyIds' as never, [CO] as never);
    await next();
  });
  app.post('/bank/statements', bankUpload as never);
  app.get('/bank/statements/:id', bankStatementDetail as never);
  app.post('/bank/lines/match-group', bankLinesMatchGroup as never);
  app.get('/bank/months/:accountCode/:month', bankMonthDetail as never);
  return { app, sb };
}

const post = (app: Hono, path: string, body: Record<string, unknown>) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const NOVEMBER = [
  'HLB PRIMEBIZ CURRENT ACCOUNT - 23600602788,',
  'Date,Transaction Description,Cheque No.,Ref. No.,Deposit,Withdrawal,Balance',
  '="",="Balance from previous statement",="",="",="",="",="0.00"',
  '="02-11-2026",="CA Credit Advice",="",="00005992284 MERCHAN T 20261031",="5500.00",="",="5500.00"',
].join('\n');

const uploadNovember = async (app: Hono) => {
  const res = await post(app, '/bank/statements', { accountCode: '310-0020', fileName: 'acs_23600602788_2026-11.csv', content: NOVEMBER, statementMonth: '2026-11' });
  expect(res.status).toBe(200);
  return (await res.json()) as { statementId: number };
};

type Line = { id: number; amount_sen: number; kind: string; candidates: unknown[]; note: string; qr_sales?: { ready: boolean; jeNos: string[]; waiting: unknown[]; clue: string } };
const qrLineOf = (lines: Line[]) => lines.find((l) => Number(l.amount_sen) === 550000)!;

describe("the bank's QR credit is matched to the QR sales", () => {
  test('the month shows it as QR money, ready, with the two entries — and no report to book a payout against', async () => {
    const { app } = harness();
    await uploadNovember(app);
    const month = (await (await app.request('/bank/months/310-0020/2026-11')).json()) as { lines: Line[] };
    const line = qrLineOf(month.lines);
    expect(line.kind).toBe('QR');
    expect(line.candidates).toEqual([]);
    expect(line.qr_sales).toMatchObject({ ready: true, jeNos: ['2990-JE-2611-0500', '2990-JE-2610-0448'] });
    expect(line.note).toMatch(/QR/);
  });

  test('the statement says the same, and one match-group press matches it to those entries', async () => {
    const { app, sb } = harness();
    const { statementId } = await uploadNovember(app);
    const detail = (await (await app.request(`/bank/statements/${statementId}`)).json()) as { lines: Line[] };
    const line = qrLineOf(detail.lines);
    expect(line.qr_sales?.ready).toBe(true);
    const res = await post(app, '/bank/lines/match-group', { lineIds: [line.id], jeNos: line.qr_sales!.jeNos });
    expect(res.status).toBe(200);
    expect(sb.tables.acc_bank_statement_lines.find((l) => l.id === line.id)).toMatchObject({ state: 'POSTED' });
    expect(sb.tables.acc_bank_statement_matches.map((m) => m.je_no).sort()).toEqual(['2990-JE-2610-0448', '2990-JE-2611-0500']);
    expect(sb.tables.journal_entries).toHaveLength(2);
  });

  test('while a QR line has no sale linked it says so, and is not ready', async () => {
    const { app } = harness({ linkBoth: false });
    await uploadNovember(app);
    const month = (await (await app.request('/bank/months/310-0020/2026-11')).json()) as { lines: Line[] };
    const line = qrLineOf(month.lines);
    expect(line.kind).toBe('QR');
    expect(line.qr_sales).toMatchObject({ ready: false, jeNos: [], waiting: [{ lineNo: 17, grossSen: 350000 }] });
    expect(line.qr_sales!.clue).toMatch(/Merchant Recon/);
  });
});
