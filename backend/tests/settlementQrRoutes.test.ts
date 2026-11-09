// Merchant Recon, owner 2026-11-09 (「这个hlbb merchant 的0000PP 是qr direct 去bank
// 的，不算卡机的」 → 「A 照传，做」). A Hong Leong report carries DuitNow QR lines
// (TENURE/CASHOUT* = DN, 0000PP where a card's approval code sits):
//   • the upload stores them as QR lines with no reference, matched to the sale
//     keyed ONLINE — never to card money — and leaves them out of what the
//     report owes through the clearing account;
//   • the report list says how much QR money a report carries;
//   • the report's detail offers each QR line its Online sale;
//   • a rematch decides QR lines against Online money too.
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import {
  settlementUpload, settlementBatches, settlementBatchDetail, settlementRematch,
} from '../src/scm/routes/accounting-settlement';

const CO = 2;
const GL_PERM = 'scm.payment_voucher.post';

const HLB_MAP = { date: 'DATE', ref: 'INVOICE/AUTHO', gross: 'TRXN AMOUNT', fee: 'MDR', net: 'TRXN NET', qr: 'TENURE/CASHOUT*', qr_values: 'DN,WC,WL' };
const config: Row = {
  code: 'HLB', display_name: 'HLB', so_names: [], statement_format: 'CSV', has_unique_ref: true,
  fee_method: 'stated', date_tolerance_days: 7, column_map: HLB_MAP, total_net_label: null, summary_totals: null, is_active: true,
};
const acquirer: Row = { ...config, company_id: CO, transit_account_code: '326-0040', fee_account_code: '900-T009', bank_account_code: '310-0020' };

const QR_HEADING = 'DATE,BATCH,INVOICE/AUTHO,CARD NUMBER,TENURE/CASHOUT*,TRXN AMOUNT,MDR,LATE FEE,MDR FLAT(RM),INTERCHANGE FEE,TRXN NET';
const CARD_HEADING = 'DATE,BATCH,INVOICE/AUTHO,CARD NUMBER,TENURE/CASHOUT*,TRXN AMOUNT,MDR,LATE FEE,MDR(%),INTERCHANGE FEE,TRXN NET';
/* 2990's 00005992284_20261101.CSV, cut to what the reader reads. */
const QR_FILE = [
  'MERCHANT NO:,00005992284,,,TRADING NAME:,2990',
  'TERMINAL ID:,00033052346',
  QR_HEADING,
  '01-Nov,29023,0000PP,2611-01xx-xxxx-2017-26,DN,100.00,0.000000,0.000000,0.00,0,100.000000',
  'TERMINAL ID:,00033052347',
  QR_HEADING,
  '31-Oct,29023,0000PP,2610-31xx-xxxx-2026-41,DN,3240.00,0.000000,0.000000,0.00,0,3240.000000',
].join('\r\n');

const PAYMENTS: Row[] = [
  { id: 'jenny', company_id: CO, so_doc_no: '2990-SO-2611-041', paid_at: '2026-11-07', amount_sen: 324000, approval_code: '20261031HLBBMYKLA30OQR77370349', method: 'transfer', merchant_provider: null, account_sheet: 'Bank transfer' },
  { id: 'how', company_id: CO, so_doc_no: '2990-SO-2611-042', paid_at: '2026-11-07', amount_sen: 324000, approval_code: '078120', method: 'installment', merchant_provider: null, account_sheet: 'Card terminal' },
  { id: 'woon', company_id: CO, so_doc_no: '2990-SO-2611-002', paid_at: '2026-11-01', amount_sen: 162000, approval_code: '843041', method: 'merchant', merchant_provider: 'HLB', account_sheet: 'HLB' },
];

function harness(tables: Record<string, Row[]> = {}) {
  const sb = fakeSb(
    {
      accounts: [], acc_account_roles: [],
      acc_acquirer_config: [config],
      acc_acquirers: [acquirer],
      acc_company_acquirers: [],
      acc_settlement_batches: [], acc_settlement_rows: [], acc_settlement_matches: [], acc_settlement_receipts: [],
      acc_settlement_payout_batches: [],
      mfg_sales_order_payments: PAYMENTS.map((p) => ({ ...p })),
      sales_invoice_payments: [],
      mfg_sales_orders: [
        { doc_no: '2990-SO-2611-041', company_id: CO, debtor_name: 'Jenny', status: 'IN_PRODUCTION', salesperson_id: null },
        { doc_no: '2990-SO-2611-042', company_id: CO, debtor_name: 'HOW YEE WEN', status: 'IN_PRODUCTION', salesperson_id: null },
        { doc_no: '2990-SO-2611-002', company_id: CO, debtor_name: 'Woon Zhen Lim', status: 'IN_PRODUCTION', salesperson_id: null },
      ],
      sales_invoices: [], staff: [],
      ...tables,
    },
    {},
    [{ table: 'acc_settlement_matches', column: 'payment_id', name: 'acc_settlement_payment_once' }],
    ['acc_settlement_batches', 'acc_settlement_rows', 'acc_settlement_matches', 'acc_settlement_receipts'],
  );
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, CO as never);
    c.set('houzsUser' as never, { name: 'Chew', permissions_set: [GL_PERM] } as never);
    c.set('allowedCompanyIds' as never, [CO] as never);
    c.set('companies' as never, [{ id: CO, code: '2990', name: '2990 HOME' }] as never);
    await next();
  });
  app.post('/settlement/batches', settlementUpload as never);
  app.get('/settlement/batches', settlementBatches as never);
  app.get('/settlement/batches/:id', settlementBatchDetail as never);
  app.post('/settlement/rematch', settlementRematch as never);
  return { app, sb };
}

const upload = (app: Hono, content: string, fileName = '00005992284_20261101.CSV') => app.request('/settlement/batches', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ acquirerCode: 'HLB', fileName, content, statementMonth: '2026-11' }),
});

describe('uploading a report that carries DuitNow QR lines', () => {
  test('the QR lines are stored as QR, with no reference, and owe nothing through the clearing account', async () => {
    const { app, sb } = harness();
    const res = await upload(app, QR_FILE);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toMatchObject({ rows: 2, grossSen: 0, feeSen: 0, netSen: 0, qrLines: 2, qrSen: 334000 });
    expect(sb.tables.acc_settlement_batches[0]).toMatchObject({ gross_sen: 0, fee_sen: 0, net_sen: 0, row_count: 2 });
    const rows = sb.tables.acc_settlement_rows.map((r) => ({ line: r.line_no, ref: r.ref, channel: r.channel, gross: r.gross_sen, bucket: r.bucket }));
    expect(rows).toEqual([
      { line: 4, ref: null, channel: 'QR', gross: 10000, bucket: 'UNMATCHED' },
      { line: 7, ref: null, channel: 'QR', gross: 324000, bucket: 'NEEDS_CONFIRM' },
    ]);
    /* Its clue names the Online sale, never the card instalment of the same amount. */
    const qr3240 = sb.tables.acc_settlement_rows.find((r) => r.gross_sen === 324000)!;
    expect(String(qr3240.notes)).toMatch(/2990-SO-2611-041/);
    expect(String(qr3240.notes)).not.toMatch(/2990-SO-2611-042/);
    expect(sb.tables.acc_settlement_matches).toEqual([]);
  });

  test('a card line beside a QR line keeps its code and alone makes the head', async () => {
    const { app, sb } = harness();
    const res = await upload(app, [
      'MERCHANT NO:,00005992235,,,TRADING NAME:,2990',
      CARD_HEADING,
      '01-Nov,29011,843041,4893-55xx-xxxx-1234,  ,1620.00,16.200000,0.000000,1.00,="0.6%",1603.800000',
      'MERCHANT NO:,00005992284,,,TRADING NAME:,2990',
      QR_HEADING,
      '01-Nov,29023,0000PP,2611-01xx-xxxx-2017-26,DN,100.00,0.000000,0.000000,0.00,0,100.000000',
    ].join('\n'), '00005992235_20261101.CSV');
    expect(res.status).toBe(200);
    expect(sb.tables.acc_settlement_batches[0]).toMatchObject({ gross_sen: 162000, fee_sen: 1620, net_sen: 160380 });
    expect(sb.tables.acc_settlement_rows.map((r) => [r.ref, r.channel ?? null, r.bucket])).toEqual([
      ['843041', null, 'MATCHED'],
      [null, 'QR', 'UNMATCHED'],
    ]);
  });
});

describe('the report list and the report', () => {
  const stored = (): Record<string, Row[]> => ({
    acc_settlement_batches: [{
      id: 389, company_id: CO, acquirer_code: 'HLB', file_name: '00005992284_20261101.CSV', period_from: '2026-10-31', period_to: '2026-11-01',
      row_count: 2, gross_sen: 0, fee_sen: 0, net_sen: 0, stated_net_sen: null, adjustment_sen: 0, adjustment_je_no: null,
      status: 'OPEN', created_at: '2026-11-09T07:08:00Z', uploaded_by: 'Chew',
    }],
    acc_settlement_rows: [
      { id: 856, batch_id: 389, company_id: CO, acquirer_code: 'HLB', line_no: 18, txn_date: '2026-11-01', ref: null, gross_sen: 10000, fee_sen: 0, net_sen: 10000, bucket: 'UNMATCHED', match_reason: null, confirmed_at: null, posted_je_no: null, notes: null, channel: 'QR', matched_with_row_id: null, not_this: [] },
      { id: 857, batch_id: 389, company_id: CO, acquirer_code: 'HLB', line_no: 23, txn_date: '2026-10-31', ref: null, gross_sen: 324000, fee_sen: 0, net_sen: 324000, bucket: 'NEEDS_CONFIRM', match_reason: 'amount+date', confirmed_at: null, posted_je_no: null, notes: 'old guess 2990-SO-2611-042', channel: 'QR', matched_with_row_id: null, not_this: [] },
    ],
  });

  test('the list says the report carries RM 3,340 of QR money and owes nothing', async () => {
    const { app } = harness(stored());
    const body = await (await app.request('/settlement/batches')).json() as { batches: Array<Record<string, unknown>> };
    expect(body.batches[0]).toMatchObject({ id: 389, qr_count: 2, qr_gross_sen: 334000, outstanding_sen: 0 });
  });

  test("the report offers the QR line its Online sale, pre-ticked, and not the card instalment", async () => {
    const { app } = harness(stored());
    const res = await app.request('/settlement/batches/389');
    expect(res.status).toBe(200);
    const body = await res.json() as { rows: Array<{ id: number; channel: string | null; candidates: Array<{ id: string }>; suggested: Array<{ id: string }>; clue: string }> };
    const line = body.rows.find((r) => r.id === 857)!;
    expect(line.channel).toBe('QR');
    expect(line.candidates.map((p) => p.id)).toEqual(['jenny']);
    expect(line.suggested.map((p) => p.id)).toEqual(['jenny']);
    expect(line.clue).toMatch(/QR/);
    expect(line.clue).not.toMatch(/2990-SO-2611-042/);
  });

  test('a linked QR line shows its Online sale with the sale\'s own details', async () => {
    const tables = stored();
    tables.acc_settlement_rows![1] = { ...tables.acc_settlement_rows![1]!, bucket: 'MATCHED', match_reason: 'manual', confirmed_at: '2026-11-09T08:00:00Z' };
    const { app } = harness({ ...tables, acc_settlement_matches: [{ id: 1, settlement_row_id: 857, company_id: CO, payment_source: 'SOPAY', payment_id: 'jenny', doc_no: '2990-SO-2611-041', amount_sen: 324000 }] });
    const body = await (await app.request('/settlement/batches/389')).json() as { rows: Array<{ id: number; linked: Array<Record<string, unknown>> }> };
    expect(body.rows.find((r) => r.id === 857)!.linked).toEqual([
      expect.objectContaining({ doc_no: '2990-SO-2611-041', customer_name: 'Jenny', paid_on: '2026-11-07', account_sheet: 'Bank transfer' }),
    ]);
  });

  test('a rematch decides a QR line against Online money', async () => {
    const { app, sb } = harness(stored());
    const res = await app.request('/settlement/rematch', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ companyId: CO, acquirerCode: 'HLB' }),
    });
    expect(res.status).toBe(200);
    const line = sb.tables.acc_settlement_rows.find((r) => r.id === 857)!;
    expect(line).toMatchObject({ bucket: 'NEEDS_CONFIRM' });
    expect(String(line.notes)).toMatch(/2990-SO-2611-041/);
    expect(sb.tables.acc_settlement_matches).toEqual([]);
  });
});
