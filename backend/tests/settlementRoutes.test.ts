// The settlement reconciliation endpoints, driven through a bare Hono app whose
// middleware injects a fake PostgREST client, a company context and a set of
// permissions — the same harness shape as companyWriteScope.test.ts (mounting
// the EXPORTED handlers skips the supabaseAuth bridge, which cannot run here).
//
// What is pinned here is the behaviour a screen depends on:
//   • the permission gate answers 403 at THIS end too (brief: 前后端各检查一次);
//   • the wrong file is a 400 with a sentence, never a batch with zero rows;
//   • the same file twice is refused, not doubled;
//   • an upload sorts its lines into the four piles and auto-confirms nothing
//     for an acquirer with no unique reference;
//   • confirming a line posts its FEE, and the payout is a second entry that
//     empties the in-transit account on the day the BANK says the money came.

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import {
  settlementSetup, settlementUpload, settlementBatches, settlementBatchDetail,
  settlementConfirmRow, settlementConfirmMatched, settlementIgnoreRow, settlementWatchlist, settlementFindPayments,
  settlementBatchReceived, settlementInTransit, settlementRowUnconfirm,
  settlementMaintenance, settlementMaintenanceMerchant, settlementMaintenanceBank,
} from '../src/scm/routes/accounting-settlement';

const CO = 1;
const GL_PERM = 'scm.payment_voucher.post';

const CHART: Row[] = ['326-0000', '310-0010', '930-0000'].map((code) => ({
  account_code: code, account_name: code, account_type: 'ASSET', parent_code: null, is_active: true, company_id: CO,
}));

const MBB: Row = {
  company_id: CO, code: 'MBB', display_name: 'MBB',
  transit_account_code: '326-0000', fee_account_code: '930-0000', bank_account_code: '310-0010',
  statement_format: 'CSV', has_unique_ref: true, fee_method: 'stated',
  date_tolerance_days: 3, is_active: true,
  column_map: { date: 'Txn Date', ref: 'Approval Code', gross: 'Gross', fee: 'MDR' },
};
/* GHL is the brief's cautionary tale: a real acquirer that sends no unique
   transaction reference, so nothing of its may auto-confirm. */
const GHL: Row = { ...MBB, code: 'GHL', display_name: 'GHL', has_unique_ref: false, column_map: { date: 'Txn Date', gross: 'Gross', fee: 'MDR' } };

const soPayment = (over: Row = {}): Row => ({
  id: 'p1', so_doc_no: 'SO-2608-001', paid_at: '2026-08-01T10:00:00', amount_sen: 100000,
  approval_code: 'A1', method: 'merchant', merchant_provider: 'MBB', company_id: CO, ...over,
});

const STATEMENT = [
  'Txn Date,Approval Code,Gross,MDR',
  '01/08/2026,A1,1000.00,15.00',
  '01/08/2026,ZZ9,777.00,11.00',
].join('\n');

function harness(tables: Record<string, Row[]>, perms: readonly string[] = [GL_PERM]) {
  const sb = fakeSb(
    {
      accounts: CHART, acc_account_roles: [],
      acc_acquirers: [MBB], acc_acquirer_config: [], acc_company_acquirers: [],
      acc_settlement_batches: [], acc_settlement_rows: [], acc_settlement_matches: [], acc_settlement_receipts: [],
      mfg_sales_order_payments: [], sales_invoice_payments: [],
      journal_entries: [], journal_entry_lines: [],
      ...tables,
    },
    {},
    [
      { table: 'acc_settlement_matches', column: 'payment_id', name: 'acc_settlement_payment_once' },
      { table: 'acc_settlement_batches', column: 'file_hash', name: 'acc_settlement_batch_once' },
    ],
    ['acc_settlement_batches', 'acc_settlement_rows', 'acc_settlement_matches', 'acc_settlement_receipts'],
  );
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, CO as never);
    c.set('houzsUser' as never, { name: 'Tester', permissions_set: perms } as never);
    c.set('allowedCompanyIds' as never, [1, 2] as never);
    c.set('companies' as never, [
      { id: 1, code: 'HOUZS', name: 'Houzs Century' },
      { id: 2, code: '2990', name: "2990's Home" },
    ] as never);
    await next();
  });
  app.get('/settlement/setup', settlementSetup as never);
  app.post('/settlement/batches', settlementUpload as never);
  app.get('/settlement/batches', settlementBatches as never);
  app.get('/settlement/batches/:id', settlementBatchDetail as never);
  app.post('/settlement/batches/:id/confirm-matched', settlementConfirmMatched as never);
  app.post('/settlement/rows/:id/confirm', settlementConfirmRow as never);
  app.post('/settlement/rows/:id/unconfirm', settlementRowUnconfirm as never);
  app.post('/settlement/rows/:id/ignore', settlementIgnoreRow as never);
  app.post('/settlement/batches/:id/received', settlementBatchReceived as never);
  app.get('/settlement/watchlist', settlementWatchlist as never);
  app.get('/settlement/rows/:id/find', settlementFindPayments as never);
  app.get('/settlement/in-transit', settlementInTransit as never);
  app.get('/settlement/maintenance', settlementMaintenance as never);
  app.patch('/settlement/maintenance/merchant', settlementMaintenanceMerchant as never);
  app.patch('/settlement/maintenance/bank', settlementMaintenanceBank as never);
  return { app, sb };
}

const upload = (app: Hono, body: Record<string, unknown>) =>
  app.request('/settlement/batches', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

const patch = (app: Hono, path: string, body: Record<string, unknown>) =>
  app.request(path, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const post = (app: Hono, path: string, body: Record<string, unknown> = {}) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('the permission gate answers at this end too', () => {
  test('without the key, every settlement endpoint is 403 — read as well as write', async () => {
    const { app } = harness({}, []);
    expect((await app.request('/settlement/setup')).status).toBe(403);
    expect((await app.request('/settlement/watchlist')).status).toBe(403);
    expect((await upload(app, { acquirerCode: 'MBB', content: STATEMENT })).status).toBe(403);
  });
});

/* The owner's case, 2026-08-18: "例如pbb，在houzs 可能是maybank 收钱，但是在2990
   是hong leong bank 收钱". The statement shape is taught once and shared; the
   receiving bank is the company's own. */
describe('one merchant, two companies, two banks', () => {
  test('the receiving bank is per company, and the screen is offered this company accounts', async () => {
    const OTHER = 2;
    const { app, sb } = harness({
      accounts: [
        ...CHART,
        { account_code: '310-0020', account_name: 'Bank — Hong Leong', account_type: 'ASSET', parent_code: null, is_active: true, company_id: CO, acc_money: true },
        { account_code: '310-0010', account_name: 'Bank — Maybank', account_type: 'ASSET', parent_code: null, is_active: true, company_id: CO, acc_money: true },
      ],
      acc_acquirers: [
        { ...MBB, code: 'PBB', display_name: 'PBB', bank_account_code: '310-0010' },
        { ...MBB, code: 'PBB', display_name: 'PBB', company_id: OTHER, bank_account_code: '310-0020' },
      ],
    });
    const body = await (await app.request('/settlement/setup')).json() as {
      acquirers: Array<Record<string, unknown>>;
      bankAccounts: Array<{ account_code: string; account_name: string }>;
    };
    /* This company sees ITS row, and only its own money accounts to choose from. */
    expect(body.acquirers).toHaveLength(1);
    expect(body.acquirers[0]).toMatchObject({ code: 'PBB', bank_account_code: '310-0010', bankReady: true });
    expect(body.bankAccounts.map((b) => b.account_code)).toEqual(['310-0010', '310-0020']);
    /* And the other company's link is untouched by any of it. */
    expect(sb.tables.acc_acquirers.find((r) => r.company_id === OTHER)).toMatchObject({ bank_account_code: '310-0020' });
  });

  test('a merchant with no receiving bank is READY to read but not ready to bank', async () => {
    const { app } = harness({ acc_acquirers: [{ ...MBB, bank_account_code: null }] });
    const body = await (await app.request('/settlement/setup')).json() as { acquirers: Array<Record<string, unknown>> };
    expect(body.acquirers[0]).toMatchObject({ ready: true, bankReady: false });
  });
});

/* Maintenance, the owner's own shape (2026-08-18): 我会 overall 维护，然后在维护
   那边选这个公司是使用哪里几个 merchant，然后他有什么 bank。可能是以勾选的方式选
   择？ — so the company is a parameter, checked against his grants. */
describe('maintenance — one screen, every company', () => {
  const CHART_MONEY: Row[] = [
    { account_code: '310-0010', account_name: 'Bank — Maybank', account_type: 'ASSET', parent_code: null, is_active: true, acc_money: true, company_id: CO },
    { account_code: '310-0020', account_name: 'Bank — Hong Leong', account_type: 'ASSET', parent_code: null, is_active: true, acc_money: true, company_id: CO },
    { account_code: '310-0010', account_name: 'Bank — Maybank', account_type: 'ASSET', parent_code: null, is_active: true, acc_money: true, company_id: 2 },
  ];
  const CONFIG: Row[] = [
    { code: 'MBB', display_name: 'MBB', statement_format: 'CSV', has_unique_ref: true, fee_method: 'stated', date_tolerance_days: 3, column_map: { date: 'Txn Date', gross: 'Gross', fee: 'MDR' }, is_active: true },
    { code: 'CIMB', display_name: 'CIMB', statement_format: null, has_unique_ref: null, fee_method: null, date_tolerance_days: 3, column_map: null, is_active: true },
  ];

  test('answers for EVERY company at once — the rows are merchants, the columns are companies', async () => {
    const { app } = harness({
      accounts: CHART_MONEY, acc_acquirer_config: CONFIG,
      acc_company_acquirers: [{ company_id: CO, acquirer_code: 'MBB', bank_account_code: '310-0020', is_active: true }],
    });
    const body = await (await app.request('/settlement/maintenance')).json() as {
      companies: Array<{ id: number }>;
      merchants: Array<Record<string, any>>;
      banks: Array<Record<string, any>>;
    };
    expect(body.companies.map((co) => co.id)).toEqual([1, 2]);

    /* One row per merchant, with what EACH company does with it. CIMB has no
       link row anywhere — a row all the same, unticked, because that is how a
       company starts using it. */
    const mbb = body.merchants.find((m) => m.code === 'MBB')!;
    expect(mbb.byCompany['1']).toMatchObject({ enabled: true, linked: true, bankAccountCode: '310-0020' });
    expect(mbb.byCompany['2']).toMatchObject({ enabled: false, linked: false, bankAccountCode: null });
    const cimb = body.merchants.find((m) => m.code === 'CIMB')!;
    expect(cimb.byCompany['1']).toMatchObject({ enabled: false, linked: false });

    /* One row per account CODE, with what each company does with it — and an
       account a company does not carry reads as 'not in its chart', never as
       an unticked box it could tick. */
    expect(body.banks.map((b) => b.account_code)).toEqual(['310-0010', '310-0020']);
    const hlb = body.banks.find((b) => b.account_code === '310-0020')!;
    expect(hlb.byCompany['1']).toMatchObject({ inChart: true, enabled: true, usedBy: ['MBB'] });
    expect(hlb.byCompany['2']).toMatchObject({ inChart: false, enabled: false, usedBy: [] });
  });

  /* A company id in a request is an instruction, not an authorisation. */
  test('a write against a company the caller is not granted is refused', async () => {
    const { app } = harness({ accounts: CHART_MONEY, acc_acquirer_config: CONFIG, acc_company_acquirers: [] });
    const write = await patch(app, '/settlement/maintenance/merchant', { companyId: 99, code: 'MBB', enabled: true });
    expect(write.status).toBe(409);
    expect(await write.json()).toMatchObject({ error: 'company_not_granted' });

    const bank = await patch(app, '/settlement/maintenance/bank', { companyId: 99, accountCode: '310-0010', enabled: false });
    expect(bank.status).toBe(409);
  });

  test('ticking a merchant on creates the link row for that company', async () => {
    const { app, sb } = harness({ accounts: CHART_MONEY, acc_acquirer_config: CONFIG, acc_company_acquirers: [] });
    const res = await patch(app, '/settlement/maintenance/merchant', { companyId: 2, code: 'MBB', enabled: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ created: true });
    expect(sb.tables.acc_company_acquirers).toHaveLength(1);
    expect(sb.tables.acc_company_acquirers[0]).toMatchObject({ company_id: 2, acquirer_code: 'MBB', is_active: true });

    /* And pointing it at a bank updates the same row rather than making another. */
    const again = await patch(app, '/settlement/maintenance/merchant', { companyId: 2, code: 'MBB', bankAccountCode: '310-0010' });
    expect(await again.json()).toMatchObject({ created: false });
    expect(sb.tables.acc_company_acquirers).toHaveLength(1);
    expect(sb.tables.acc_company_acquirers[0]).toMatchObject({ bank_account_code: '310-0010' });
  });

  test('a bank a merchant still pays into cannot be unticked, and the refusal names it', async () => {
    const { app, sb } = harness({
      accounts: CHART_MONEY, acc_acquirer_config: CONFIG,
      acc_company_acquirers: [{ company_id: CO, acquirer_code: 'MBB', bank_account_code: '310-0020', is_active: true }],
    });
    const res = await patch(app, '/settlement/maintenance/bank', { companyId: 1, accountCode: '310-0020', enabled: false });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'bank_in_use', message: expect.stringContaining('MBB') });
    expect(sb.tables.accounts.find((a) => a.account_code === '310-0020' && a.company_id === 1)).toMatchObject({ is_active: true });

    /* Free it first, then it goes. */
    await patch(app, '/settlement/maintenance/merchant', { companyId: 1, code: 'MBB', bankAccountCode: null });
    const ok = await patch(app, '/settlement/maintenance/bank', { companyId: 1, accountCode: '310-0020', enabled: false });
    expect(ok.status).toBe(200);
    expect(sb.tables.accounts.find((a) => a.account_code === '310-0020' && a.company_id === 1)).toMatchObject({ is_active: false });
  });
});

describe('GET /settlement/setup', () => {
  test('says which acquirers are ready to reconcile and which can auto-match', async () => {
    const { app } = harness({ acc_acquirers: [MBB, GHL, { ...MBB, code: 'PBB', display_name: 'PBB', statement_format: null, column_map: null, fee_method: null, has_unique_ref: null }] });
    const body = await (await app.request('/settlement/setup')).json() as { acquirers: Array<Record<string, unknown>> };
    const by = new Map(body.acquirers.map((a) => [a.code, a]));
    expect(by.get('MBB')).toMatchObject({ ready: true, autoMatchable: true });
    expect(by.get('GHL')).toMatchObject({ ready: true, autoMatchable: false });
    expect(by.get('PBB')).toMatchObject({ ready: false, autoMatchable: false });
  });
});

describe('POST /settlement/batches — a bad upload is loud', () => {
  test('the wrong file is refused with a sentence, and nothing is stored', async () => {
    const { app, sb } = harness({});
    const res = await upload(app, { acquirerCode: 'MBB', fileName: 'wrong.csv', content: 'Date,Amount\n01/08/2026,10.00' });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string; message: string };
    expect(body.error).toBe('unreadable_statement');
    expect(body.message).toMatch(/Txn Date/);
    expect(sb.tables.acc_settlement_batches).toHaveLength(0);
  });

  test('an acquirer this company does not use cannot be uploaded against', async () => {
    const { app } = harness({});
    const res = await upload(app, { acquirerCode: 'GHL', content: STATEMENT });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'acquirer_unavailable' });
  });

  test('the same file twice is refused, not doubled', async () => {
    const { app, sb } = harness({ mfg_sales_order_payments: [soPayment()] });
    expect((await upload(app, { acquirerCode: 'MBB', fileName: 'aug.csv', content: STATEMENT })).status).toBe(200);
    const again = await upload(app, { acquirerCode: 'MBB', fileName: 'aug-copy.csv', content: STATEMENT });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: 'already_uploaded' });
    expect(sb.tables.acc_settlement_batches).toHaveLength(1);
  });

  /* An upload that wrote its batch head and then died left a batch with NO
     lines still holding the file hash — and told the operator "already
     uploaded" about an upload that never finished (the owner's PBB statement
     of 2026-08-01 sat exactly like this). The retry must be let in. */
  test('a half-failed upload does not hold its file hostage — the retry replaces the wreck', async () => {
    const { app, sb } = harness({ mfg_sales_order_payments: [soPayment()] });
    expect((await upload(app, { acquirerCode: 'MBB', fileName: 'aug.csv', content: STATEMENT })).status).toBe(200);
    // Simulate the half-failure: the lines vanish, the batch head remains.
    sb.tables.acc_settlement_rows = [];
    sb.tables.acc_settlement_matches = [];

    const retry = await upload(app, { acquirerCode: 'MBB', fileName: 'aug.csv', content: STATEMENT });
    expect(retry.status).toBe(200);
    // One batch — the retry's, whole this time — never the wreck plus a twin.
    expect(sb.tables.acc_settlement_batches).toHaveLength(1);
    expect(sb.tables.acc_settlement_rows).toHaveLength(2);
  });
});

describe('POST /settlement/batches — the four piles', () => {
  test('a reference match lands in MATCHED; a line with no payment lands in UNMATCHED', async () => {
    const { app, sb } = harness({ mfg_sales_order_payments: [soPayment()] });
    const res = await upload(app, { acquirerCode: 'MBB', fileName: 'aug.csv', content: STATEMENT });
    expect(res.status).toBe(200);
    const body = await res.json() as { batchId: unknown; rows: number; buckets: Record<string, number> };
    expect(body.rows).toBe(2);
    expect(body.buckets.MATCHED).toBe(1);
    expect(body.buckets.UNMATCHED).toBe(1);

    // The auto-match claimed its payment, and nothing has posted yet.
    expect(sb.tables.acc_settlement_matches).toHaveLength(1);
    expect(sb.tables.journal_entries).toHaveLength(0);
    expect(sb.tables.acc_settlement_batches[0]).toMatchObject({ gross_sen: 177700, fee_sen: 2600, period_from: '2026-08-01' });
  });

  test('an acquirer with no unique reference auto-confirms NOTHING — the GHL rule', async () => {
    const { app, sb } = harness({
      acc_acquirers: [GHL],
      mfg_sales_order_payments: [soPayment({ merchant_provider: 'GHL' })],
    });
    const res = await upload(app, { acquirerCode: 'GHL', fileName: 'ghl.csv', content: 'Txn Date,Gross,MDR\n01/08/2026,1000.00,15.00' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ buckets: { MATCHED: 0, NEEDS_CONFIRM: 1 } });
    expect(sb.tables.acc_settlement_matches).toHaveLength(0);
  });
});

/* ── A transaction already on another report (docs/bugs/0823) ─────────────────
   Maybank prints an Amex card sold on an EzyPay instalment on BOTH the EP41
   and the T41AX report of the day — one swipe, two files, the bank pays
   once. The same FILE twice was already refused by its hash; the same LINE on
   a second file was not, and would have made a batch waiting for a payout
   that never comes. */
describe('a transaction already on another report', () => {
  const FIRST = { acquirerCode: 'MBB', fileName: '027012896718_EP41_713_20260801.CSV', content: STATEMENT };
  const second = (content: string) => ({ acquirerCode: 'MBB', fileName: '027012896718_T41AX_467_20260801.CSV', content });
  const HEAD = 'Txn Date,Approval Code,Gross,MDR';

  test('the second report keeps only its new line, and names the first report for the rest', async () => {
    const { app, sb } = harness({ mfg_sales_order_payments: [soPayment()] });
    expect((await upload(app, FIRST)).status).toBe(200);
    const res = await upload(app, second(`${HEAD}\n01/08/2026,A1,1000.00,15.00\n01/08/2026,B7,500.00,7.50`));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.rows).toBe(1);
    expect(body.alreadyOnReport).toBe(1);
    expect(body.alreadyOnReportDetail).toEqual([expect.objectContaining({
      /* File line numbers: the heading is line 1, the first transaction line 2. */
      lineNo: 2, txnDate: '2026-08-01', ref: 'A1', grossSen: 100000,
      fileName: '027012896718_EP41_713_20260801.CSV', lineNoThere: 2,
    })]);
    /* The left-out line takes its share of the fee with it. */
    expect(body).toMatchObject({ grossSen: 50000, feeSen: 750, netSen: 49250 });
    const batches = sb.tables.acc_settlement_batches as Row[];
    expect(batches).toHaveLength(2);
    expect(batches[1]).toMatchObject({ row_count: 1, gross_sen: 50000, fee_sen: 750, net_sen: 49250 });
    const rows = (sb.tables.acc_settlement_rows as Row[]).filter((r) => r.batch_id === batches[1]!.id);
    expect(rows.map((r) => r.ref)).toEqual(['B7']);
  });

  test('a report with nothing new is refused, and stores nothing', async () => {
    const { app, sb } = harness({ mfg_sales_order_payments: [soPayment()] });
    expect((await upload(app, FIRST)).status).toBe(200);
    const res = await upload(app, second(`${HEAD}\n01/08/2026,A1,1000.00,15.00`));
    expect(res.status).toBe(409);
    const body = await res.json() as any;
    expect(body.error).toBe('already_on_report');
    expect(body.alreadyOnReport).toBe(1);
    expect(body.message).toMatch(/027012896718_EP41_713_20260801\.CSV/);
    expect(body.message.length).toBeLessThan(200);
    expect(sb.tables.acc_settlement_batches).toHaveLength(1);
    expect(sb.tables.acc_settlement_rows).toHaveLength(2);
  });

  test('a different amount under the same day and reference is another transaction', async () => {
    const { app, sb } = harness({ mfg_sales_order_payments: [soPayment()] });
    expect((await upload(app, FIRST)).status).toBe(200);
    const res = await upload(app, second(`${HEAD}\n01/08/2026,A1,1200.00,18.00`));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ rows: 1, alreadyOnReport: 0 });
    expect(sb.tables.acc_settlement_batches).toHaveLength(2);
  });

  test('an acquirer without unique references is never deduplicated this way', async () => {
    const { app, sb } = harness({ acc_acquirers: [GHL], mfg_sales_order_payments: [soPayment({ merchant_provider: 'GHL' })] });
    const ghl = (name: string, extra: string) => ({ acquirerCode: 'GHL', fileName: name, content: `Txn Date,Gross,MDR\n01/08/2026,1000.00,15.00${extra}` });
    expect((await upload(app, ghl('ghl-a.csv', ''))).status).toBe(200);
    const res = await upload(app, ghl('ghl-b.csv', '\n02/08/2026,50.00,1.00'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ rows: 2, alreadyOnReport: 0 });
    expect(sb.tables.acc_settlement_batches).toHaveLength(2);
  });
});

describe('an unconfirmed link follows its payment (docs/bugs/0833)', () => {
  test('opening the report reads the corrected amount back into the link and names it; a confirmed line is left alone', async () => {
    const { app, sb } = harness({ mfg_sales_order_payments: [soPayment()] });
    const up = await (await upload(app, { acquirerCode: 'MBB', fileName: 'aug.csv', content: STATEMENT })).json() as { batchId: string };
    expect(sb.tables.acc_settlement_matches[0]).toMatchObject({ payment_id: 'p1', amount_sen: 100000 });
    /* Finance corrects the payment after the upload (3,053 → 3,052 in the
       owner's case; here 1,000.00 → 999.00). */
    sb.tables.mfg_sales_order_payments[0]!.amount_sen = 99900;
    const opened = await app.request(`/settlement/batches/${up.batchId}`);
    expect(opened.status).toBe(200);
    const body = await opened.json() as { refreshedLinks: unknown[]; rows: Array<{ line_no: number; linked: Array<{ amount_sen: number }> }> };
    expect(body.refreshedLinks).toEqual([expect.objectContaining({ paymentId: 'p1', docNo: 'SO-2608-001', fromSen: 100000, toSen: 99900 })]);
    expect(sb.tables.acc_settlement_matches[0]).toMatchObject({ amount_sen: 99900 });
    expect(body.rows.find((r) => r.linked.length > 0)?.linked[0]).toMatchObject({ amount_sen: 99900 });
    /* Opened again with nothing moved: nothing to name. */
    const again = await (await app.request(`/settlement/batches/${up.batchId}`)).json() as { refreshedLinks: unknown[] };
    expect(again.refreshedLinks).toEqual([]);
    /* Confirmed: the ledger's now. A later correction is not read back. */
    sb.tables.acc_settlement_rows[0]!.confirmed_at = '2026-08-05T00:00:00Z';
    sb.tables.mfg_sales_order_payments[0]!.amount_sen = 50000;
    const after = await (await app.request(`/settlement/batches/${up.batchId}`)).json() as { refreshedLinks: unknown[] };
    expect(after.refreshedLinks).toEqual([]);
    expect(sb.tables.acc_settlement_matches[0]).toMatchObject({ amount_sen: 99900 });
  });
});

describe('confirming is the moment of posting', () => {
  test('bulk-confirming the auto-matched pile books the FEE, and leaves the bank alone', async () => {
    const { app, sb } = harness({ mfg_sales_order_payments: [soPayment()] });
    const up = await (await upload(app, { acquirerCode: 'MBB', fileName: 'aug.csv', content: STATEMENT })).json() as { batchId: string };

    const res = await post(app, `/settlement/batches/${up.batchId}/confirm-matched`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ attempted: 1, confirmed: 1, failed: [] });

    const lines = sb.tables.journal_entry_lines;
    expect(lines).toHaveLength(2);
    expect(lines.find((l) => l.account_code === '930-0000')).toMatchObject({ debit_sen: 1500 });
    expect(lines.find((l) => l.account_code === '326-0000')).toMatchObject({ credit_sen: 1500 });
    expect(lines.some((l) => l.account_code === '310-0010')).toBe(false);
    expect(sb.tables.journal_entries[0]).toMatchObject({ source_type: 'SETTLE', entry_date: '2026-08-01' });
  });

  /* AEON's subvention fee. Confirming a batch must book the statement's own
     charge too, or in-transit is left holding money that is never coming. */
  test('confirming a batch also books the charge the statement made against no transaction', async () => {
    const { app, sb } = harness({ mfg_sales_order_payments: [soPayment()] });
    const up = await (await upload(app, { acquirerCode: 'MBB', fileName: 'aug.csv', content: STATEMENT })).json() as { batchId: number };
    // The parser fills this in from the file; set it directly to pin the route.
    sb.tables.acc_settlement_batches[0].adjustment_sen = 25416;

    const res = await post(app, `/settlement/batches/${up.batchId}/confirm-matched`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ statementCharge: { status: 'posted' } });

    const adj = sb.tables.journal_entries.find((e) => e.source_type === 'SETTLEADJ');
    expect(adj).toBeTruthy();
    const adjLines = sb.tables.journal_entry_lines.filter((l) => l.journal_entry_id === adj!.id);
    expect(adjLines.find((l) => l.account_code === '930-0000')).toMatchObject({ debit_sen: 25416 });
    expect(adjLines.find((l) => l.account_code === '326-0000')).toMatchObject({ credit_sen: 25416 });
  });

  /* The RM 1,000.00 payment against the RM 777.00 line — and the screen's own
     figure is not what is compared: the payment's amount in the books is
     (docs/bugs/0792), so a browser claiming 777.00 changes nothing. */
  test('confirming a line whose selection does not add up is refused with the difference', async () => {
    const { app, sb } = harness({ mfg_sales_order_payments: [soPayment()] });
    await upload(app, { acquirerCode: 'MBB', fileName: 'aug.csv', content: STATEMENT });
    const unmatched = sb.tables.acc_settlement_rows.find((r) => r.bucket === 'UNMATCHED')!;

    const res = await post(app, `/settlement/rows/${unmatched.id}/confirm`, {
      payments: [{ source: 'SOPAY', id: 'p1', docNo: 'SO-2608-001', amountSen: 77700 }],
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'amount_mismatch' });
    expect(sb.tables.journal_entries).toHaveLength(0);
  });

  /* docs/bugs/0792 — "Find the sale" lets a person pick ANY card payment, so
     the confirm reads each one back: not in this company's books, or not a
     card payment, is a refusal the operator can read, not a 500. */
  test('a payment the books do not hold, or a cash one, is refused by name', async () => {
    const { app, sb } = harness({ mfg_sales_order_payments: [soPayment(), soPayment({ id: 'cash1', so_doc_no: 'SO-2608-002', method: 'cash', merchant_provider: null, amount_sen: 77700 })] });
    await upload(app, { acquirerCode: 'MBB', fileName: 'aug.csv', content: STATEMENT });
    const unmatched = sb.tables.acc_settlement_rows.find((r) => r.bucket === 'UNMATCHED')!;

    const ghost = await post(app, `/settlement/rows/${unmatched.id}/confirm`, {
      payments: [{ source: 'SOPAY', id: 'px', docNo: 'SO-9', amountSen: 77700 }],
    });
    expect(ghost.status).toBe(409);
    expect(await ghost.json()).toMatchObject({ error: 'payment_not_found' });

    const cash = await post(app, `/settlement/rows/${unmatched.id}/confirm`, {
      payments: [{ source: 'SOPAY', id: 'cash1', docNo: 'SO-2608-002', amountSen: 77700 }],
    });
    expect(cash.status).toBe(409);
    expect(await cash.json()).toMatchObject({ error: 'not_card_payment' });
    expect(sb.tables.journal_entries).toHaveLength(0);
  });

  test('GET rows/:id/find lists the company card payments by document, the exact gross marked possible', async () => {
    const { app, sb } = harness({
      mfg_sales_order_payments: [
        soPayment({ id: 'late', so_doc_no: 'SO-2608-077', paid_at: '2026-08-20T10:00:00', amount_sen: 77700, approval_code: null, merchant_provider: null }),
        soPayment(),
      ],
      mfg_sales_orders: [{ doc_no: 'SO-2608-077', company_id: CO, debtor_name: 'Chou Mun Yee' }, { doc_no: 'SO-2608-001', company_id: CO, debtor_name: 'Someone Else' }],
      sales_invoices: [],
    });
    await upload(app, { acquirerCode: 'MBB', fileName: 'aug.csv', content: STATEMENT });
    const unmatched = sb.tables.acc_settlement_rows.find((r) => r.bucket === 'UNMATCHED')!;

    const res = await app.request(`/settlement/rows/${unmatched.id}/find?q=chou`);
    expect(res.status).toBe(200);
    const body = await res.json() as { payments: Array<{ id: string; possible: boolean; customerName: string | null }> };
    expect(body.payments).toEqual([expect.objectContaining({ id: 'late', possible: true, customerName: 'Chou Mun Yee' })]);
    expect((await app.request('/settlement/rows/999999/find')).status).toBe(404);
  });

  test('a line with no payment behind it cannot be cleared out of in-transit', async () => {
    const { app, sb } = harness({ mfg_sales_order_payments: [soPayment()] });
    await upload(app, { acquirerCode: 'MBB', fileName: 'aug.csv', content: STATEMENT });
    const unmatched = sb.tables.acc_settlement_rows.find((r) => r.bucket === 'UNMATCHED')!;
    const res = await post(app, `/settlement/rows/${unmatched.id}/confirm`, { payments: [] });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'no_payments' });
  });
});

/* The owner's two-step, end to end through the endpoints. Reconciling the card
   machine and receiving the payout are days apart and are two separate calls;
   only the second one touches the bank. */
describe('POST /settlement/batches/:id/received — the money arrives', () => {
  test('books Dr bank / Cr in-transit on the bank date, and only then is the acquirer square', async () => {
    const { app, sb } = harness({ mfg_sales_order_payments: [soPayment()] });
    const up = await (await upload(app, { acquirerCode: 'MBB', fileName: 'aug.csv', content: STATEMENT })).json() as { batchId: number };
    await post(app, `/settlement/batches/${up.batchId}/confirm-matched`);

    const res = await post(app, `/settlement/batches/${up.batchId}/received`, { receivedOn: '2026-08-05' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, status: 'posted' });

    const receipt = sb.tables.journal_entries.find((e) => e.source_type === 'SETTLEBANK')!;
    expect(receipt).toMatchObject({ entry_date: '2026-08-05' });
    const lines = sb.tables.journal_entry_lines.filter((l) => l.journal_entry_id === receipt.id);
    /* The statement's net: 1,777.00 gross less 26.00 of fees. */
    expect(lines.find((l) => l.account_code === '310-0010')).toMatchObject({ debit_sen: 175100 });
    expect(lines.find((l) => l.account_code === '326-0000')).toMatchObject({ credit_sen: 175100 });
    expect(sb.tables.acc_settlement_receipts[0]).toMatchObject({ batch_id: up.batchId, received_on: '2026-08-05', amount_sen: 175100 });
  });

  /* "我实际收到的钱可能是多笔的哦" — Hong Leong pays a multi-day statement one
     credit per trading day. Half-paid is not paid, and the list says so. */
  test('a statement paid in two credits only leaves the list when they add up', async () => {
    const { app, sb } = harness({ mfg_sales_order_payments: [soPayment()] });
    const up = await (await upload(app, { acquirerCode: 'MBB', fileName: 'aug.csv', content: STATEMENT })).json() as { batchId: number };
    await post(app, `/settlement/batches/${up.batchId}/confirm-matched`);

    const first = await post(app, `/settlement/batches/${up.batchId}/received`, { receivedOn: '2026-08-05', amountSen: 100000 });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ receivedSen: 100000, outstandingSen: 75100 });

    const listed = await (await app.request('/settlement/batches')).json() as { batches: Array<Record<string, unknown>> };
    /* Partly in the bank must not read as in the bank. */
    expect(listed.batches[0]).toMatchObject({ received_sen: 100000, outstanding_sen: 75100, received_on: null, receipt_count: 1 });

    const tooMuch = await post(app, `/settlement/batches/${up.batchId}/received`, { receivedOn: '2026-08-06', amountSen: 90000 });
    expect(tooMuch.status).toBe(409);
    expect(await tooMuch.json()).toMatchObject({ error: 'over_receipt' });

    await post(app, `/settlement/batches/${up.batchId}/received`, { receivedOn: '2026-08-06', amountSen: 75100 });
    const done = await (await app.request('/settlement/batches')).json() as { batches: Array<Record<string, unknown>> };
    expect(done.batches[0]).toMatchObject({ outstanding_sen: 0, received_on: '2026-08-06', receipt_count: 2 });

    const detail = await (await app.request(`/settlement/batches/${up.batchId}`)).json() as { batch: { receipts: unknown[]; outstanding_sen: number } };
    expect(detail.batch.receipts).toHaveLength(2);
    expect(detail.batch.outstanding_sen).toBe(0);
  });

  test('a date it was not given is refused rather than assumed', async () => {
    const { app, sb } = harness({ mfg_sales_order_payments: [soPayment()] });
    const up = await (await upload(app, { acquirerCode: 'MBB', fileName: 'aug.csv', content: STATEMENT })).json() as { batchId: number };
    const res = await post(app, `/settlement/batches/${up.batchId}/received`, {});
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'bad_date' });
    expect(sb.tables.journal_entries).toHaveLength(0);
  });
});

/* "我需要看到说顾客还钱了，但是还没收款或还没对账。我要明细的" — and each state
   is a different person's job. */
describe('GET /settlement/in-transit — whose money is still out there', () => {
  test('walks a payment through all three states and off the list when the money lands', async () => {
    const { app, sb } = harness({ mfg_sales_order_payments: [soPayment()] });
    const read = async () => (await (await app.request('/settlement/in-transit')).json() as {
      totalSen: number; lines: Array<{ docNo: string; state: string; amountSen: number }>;
    });

    const before = await read();
    expect(before.lines).toMatchObject([{ docNo: 'SO-2608-001', state: 'NOT_ON_A_STATEMENT', amountSen: 100000 }]);

    const up = await (await upload(app, { acquirerCode: 'MBB', fileName: 'aug.csv', content: STATEMENT })).json() as { batchId: number };
    expect((await read()).lines[0]).toMatchObject({ state: 'MATCHED_NOT_POSTED', amountSen: 100000 });

    await post(app, `/settlement/batches/${up.batchId}/confirm-matched`);
    /* Reconciled: its fee is out of in-transit already, so what is still owed
       on this payment is the NET — the list and 320-0000 stay one story. */
    const reconciled = await read();
    expect(reconciled.lines[0]).toMatchObject({ state: 'RECONCILED_NOT_PAID', amountSen: 98500 });
    expect(reconciled.totalSen).toBe(98500);

    await post(app, `/settlement/batches/${up.batchId}/received`, { receivedOn: '2026-08-05' });
    const after = await read();
    expect(after.lines).toHaveLength(0);
    expect(after.totalSen).toBe(0);
    expect(sb.tables.acc_settlement_receipts[0].je_no).toBeTruthy();
  });

  /* AEON's subvention fee has left in-transit too once it is booked, so it must
     come off this list as well — otherwise the list reads higher than the
     account it is the readable form of, which is the one thing it may not do. */
  test("a booked statement charge comes off the money still owed", async () => {
    const { app, sb } = harness({ mfg_sales_order_payments: [soPayment()] });
    const up = await (await upload(app, { acquirerCode: 'MBB', fileName: 'aug.csv', content: STATEMENT })).json() as { batchId: number };
    sb.tables.acc_settlement_batches[0].adjustment_sen = 25416;
    await post(app, `/settlement/batches/${up.batchId}/confirm-matched`);

    const body = await (await app.request('/settlement/in-transit')).json() as { totalSen: number; lines: Array<{ amountSen: number }> };
    /* 1,000.00 swiped, less its 15.00 fee, less the 254.16 the statement kept. */
    expect(body.lines[0].amountSen).toBe(100000 - 1500 - 25416);

    const transit = sb.tables.journal_entry_lines
      .filter((l) => l.account_code === '326-0000')
      .reduce((s, l) => s + Number(l.debit_sen ?? 0) - Number(l.credit_sen ?? 0), 0);
    /* The swipe itself is booked by phase 2A, not here, so what this suite can
       compare is the movement: everything taken out of in-transit so far is
       exactly what the list says is no longer owed. */
    expect(body.totalSen).toBe(100000 + transit);
  });

  /* A statement paid in instalments takes its payments down as it goes — the
     list and the account move together, never in steps of a whole statement. */
  test('a part-paid statement shows what is still owed on it', async () => {
    const { app, sb } = harness({ mfg_sales_order_payments: [soPayment()] });
    const up = await (await upload(app, { acquirerCode: 'MBB', fileName: 'aug.csv', content: STATEMENT })).json() as { batchId: number };
    await post(app, `/settlement/batches/${up.batchId}/confirm-matched`);
    await post(app, `/settlement/batches/${up.batchId}/received`, { receivedOn: '2026-08-05', amountSen: 50000 });

    const body = await (await app.request('/settlement/in-transit')).json() as { totalSen: number; lines: Array<{ amountSen: number; state: string }> };
    /* 1,000.00 swiped, 15.00 fee booked, 500.00 of the payout landed. */
    expect(body.lines[0]).toMatchObject({ state: 'RECONCILED_NOT_PAID', amountSen: 100000 - 1500 - 50000 });

    const transit = sb.tables.journal_entry_lines
      .filter((l) => l.account_code === '326-0000')
      .reduce((s, l) => s + Number(l.debit_sen ?? 0) - Number(l.credit_sen ?? 0), 0);
    expect(body.totalSen).toBe(100000 + transit);
  });
});

describe('setting a line aside', () => {
  test('an unconfirmed line can be ignored and put back', async () => {
    const { app, sb } = harness({ mfg_sales_order_payments: [soPayment()] });
    await upload(app, { acquirerCode: 'MBB', fileName: 'aug.csv', content: STATEMENT });
    const row = sb.tables.acc_settlement_rows.find((r) => r.bucket === 'UNMATCHED')!;

    expect((await post(app, `/settlement/rows/${row.id}/ignore`, { notes: 'duplicate line' })).status).toBe(200);
    expect(sb.tables.acc_settlement_rows.find((r) => r.id === row.id)).toMatchObject({ bucket: 'IGNORED', notes: 'duplicate line' });

    expect((await post(app, `/settlement/rows/${row.id}/ignore`, { restore: true })).status).toBe(200);
    expect(sb.tables.acc_settlement_rows.find((r) => r.id === row.id)).toMatchObject({ bucket: 'NEEDS_CONFIRM' });
  });

  test('a line already in the ledger cannot be ignored — it is reversed, not hidden', async () => {
    const { app, sb } = harness({ mfg_sales_order_payments: [soPayment()] });
    const up = await (await upload(app, { acquirerCode: 'MBB', fileName: 'aug.csv', content: STATEMENT })).json() as { batchId: string };
    await post(app, `/settlement/batches/${up.batchId}/confirm-matched`);
    const confirmed = sb.tables.acc_settlement_rows.find((r) => r.confirmed_at)!;

    const res = await post(app, `/settlement/rows/${confirmed.id}/ignore`, {});
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'already_confirmed' });
  });
});

describe('taking a confirmed line back — the door the ignore refusal points at', () => {
  test('unconfirm reverses the fee entry, releases the payment, and asks the human again', async () => {
    const { app, sb } = harness({ mfg_sales_order_payments: [soPayment()] });
    const up = await (await upload(app, { acquirerCode: 'MBB', fileName: 'aug.csv', content: STATEMENT })).json() as { batchId: string };
    await post(app, `/settlement/batches/${up.batchId}/confirm-matched`);
    const confirmed = sb.tables.acc_settlement_rows.find((r) => r.confirmed_at)!;
    const feeJe = confirmed.posted_je_no as string;
    expect(feeJe).toBeTruthy();

    const res = await post(app, `/settlement/rows/${confirmed.id}/unconfirm`, {});
    expect(res.status).toBe(200);

    /* The row is a fresh question again, not silently re-matched. */
    const row = sb.tables.acc_settlement_rows.find((r) => r.id === confirmed.id)!;
    expect(row).toMatchObject({ bucket: 'NEEDS_CONFIRM', confirmed_at: null, posted_je_no: null });

    /* The fee entry is REVERSED (flagged + a contra written), never deleted. */
    const original = sb.tables.journal_entries.find((j) => j.je_no === feeJe)!;
    expect(original.reversed).toBe(true);

    /* The payment link is gone, so the money is claimable again... */
    expect(sb.tables.acc_settlement_matches.filter((m) => m.settlement_row_id === confirmed.id)).toHaveLength(0);

    /* ...proven by confirming the SAME line against the SAME payment a second
       time — the once-only unique would refuse this if the link survived. */
    const again = await post(app, `/settlement/rows/${confirmed.id}/confirm`, {
      matchReason: 'manual',
      payments: [{ source: 'SOPAY', id: 'p1', docNo: 'SO-2608-001', amountSen: 100000 }],
    });
    expect(again.status).toBe(200);
    expect(sb.tables.acc_settlement_rows.find((r) => r.id === confirmed.id)!.confirmed_at).toBeTruthy();
  });

  test('a line never confirmed has nothing to take back', async () => {
    const { app, sb } = harness({ mfg_sales_order_payments: [soPayment()] });
    await upload(app, { acquirerCode: 'MBB', fileName: 'aug.csv', content: STATEMENT });
    const open = sb.tables.acc_settlement_rows.find((r) => !r.confirmed_at)!;
    const res = await post(app, `/settlement/rows/${open.id}/unconfirm`, {});
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'not_confirmed' });
  });

  test('REFUSED while money is recorded received — undo the credits first', async () => {
    const { app, sb } = harness({ mfg_sales_order_payments: [soPayment()] });
    const up = await (await upload(app, { acquirerCode: 'MBB', fileName: 'aug.csv', content: STATEMENT })).json() as { batchId: string };
    await post(app, `/settlement/batches/${up.batchId}/confirm-matched`);
    const confirmed = sb.tables.acc_settlement_rows.find((r) => r.confirmed_at)!;

    const rec = await post(app, `/settlement/batches/${up.batchId}/received`, { receivedOn: '2026-08-05', amountSen: 500 });
    expect(rec.status).toBe(200);

    const res = await post(app, `/settlement/rows/${confirmed.id}/unconfirm`, {});
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string; message: string };
    expect(body.error).toBe('has_receipts');
    expect(body.message).toMatch(/Undo those credits/);
    /* And nothing moved: still confirmed, entry still standing. */
    expect(sb.tables.acc_settlement_rows.find((r) => r.id === confirmed.id)!.confirmed_at).toBeTruthy();
    expect(sb.tables.journal_entries.find((j) => j.je_no === confirmed.posted_je_no)!.reversed).not.toBe(true);
  });
});

describe('the batch detail and the watchlists', () => {
  test('the detail names the bank this merchant pays THIS company into', async () => {
    const { app } = harness({
      accounts: CHART.map((r) => (r.account_code === '310-0010' ? { ...r, account_name: 'Bank — Maybank' } : r)),
      mfg_sales_order_payments: [soPayment()],
    });
    const up = await (await upload(app, { acquirerCode: 'MBB', fileName: 'aug.csv', content: STATEMENT })).json() as { batchId: number };
    const body = await (await app.request(`/settlement/batches/${up.batchId}`)).json() as { batch: { receiving_bank: Record<string, unknown> } };
    expect(body.batch.receiving_bank).toMatchObject({ code: '310-0010', name: 'Bank — Maybank', configured: true });
  });

  /* Unset does not stop the books — it falls back to the company default — but
     it is REPORTED, so a wrong bank cannot hide until the statement disagrees. */
  test('an unset receiving bank is reported as a fallback, not hidden', async () => {
    const { app } = harness({ acc_acquirers: [{ ...MBB, bank_account_code: null }], mfg_sales_order_payments: [soPayment()] });
    const up = await (await upload(app, { acquirerCode: 'MBB', fileName: 'aug.csv', content: STATEMENT })).json() as { batchId: number };
    const body = await (await app.request(`/settlement/batches/${up.batchId}`)).json() as { batch: { receiving_bank: Record<string, unknown> } };
    expect(body.batch.receiving_bank).toMatchObject({ code: '310-0010', configured: false });
  });

  /* The owner, looking at an auto-matched line: 出现的这个是什么？ The screen
     said "Matched to SO-2608-043" and "No payment recorded near 2026-08-15" at
     the same time. The clue was recomputed for a line whose OWN payment had
     already been taken out of the candidate pool by its own link. */
  test('a line that already claimed its payment keeps the reason it matched', async () => {
    const { app } = harness({ mfg_sales_order_payments: [soPayment()] });
    const up = await (await upload(app, { acquirerCode: 'MBB', fileName: 'aug.csv', content: STATEMENT })).json() as { batchId: number };
    const body = await (await app.request(`/settlement/batches/${up.batchId}`)).json() as {
      rows: Array<{ bucket: string; clue: string | null; linked: unknown[] }>;
    };
    const matched = body.rows.find((r) => r.bucket === 'MATCHED')!;
    expect(matched.linked).toHaveLength(1);
    expect(matched.clue).toMatch(/Reference A1 matches SO-2608-001/);
    expect(matched.clue).not.toMatch(/No payment recorded/);

    /* And the line that genuinely has nobody still says so. */
    const orphan = body.rows.find((r) => r.bucket === 'UNMATCHED')!;
    expect(orphan.clue).toMatch(/No payment recorded/);
  });

  test('the detail view shows the piles and recomputes candidates for the open lines', async () => {
    const { app } = harness({ mfg_sales_order_payments: [soPayment(), soPayment({ id: 'p2', so_doc_no: 'SO-2608-002', amount_sen: 77700, approval_code: null })] });
    const up = await (await upload(app, { acquirerCode: 'MBB', fileName: 'aug.csv', content: STATEMENT })).json() as { batchId: string };

    const body = await (await app.request(`/settlement/batches/${up.batchId}`)).json() as {
      buckets: Record<string, number>;
      rows: Array<{ bucket: string; candidates: Array<{ id: string }>; linked: unknown[] }>;
    };
    expect(body.buckets.MATCHED).toBe(1);
    const open = body.rows.find((r) => r.bucket !== 'MATCHED')!;
    expect(open.candidates.map((p) => p.id)).toContain('p2');
    expect(body.rows.find((r) => r.bucket === 'MATCHED')!.linked).toHaveLength(1);
  });

  test('watchlist 1 lists card money the acquirer has not sent; watchlist 2 lists money with no sale', async () => {
    /* p3 is a fortnight before the statement period: too old to be a candidate
       for any of its lines, so it stays on watchlist 1 while the statement's
       second line — money with no sale behind it — stays on watchlist 2. */
    const { app } = harness({ mfg_sales_order_payments: [soPayment(), soPayment({ id: 'p3', so_doc_no: 'SO-3', paid_at: '2026-07-15T09:00:00', amount_sen: 5000, approval_code: 'B2' })] });
    await upload(app, { acquirerCode: 'MBB', fileName: 'aug.csv', content: STATEMENT });

    const body = await (await app.request('/settlement/watchlist?from=2026-07-01&to=2026-08-16')).json() as {
      recordedNotArrived: Array<{ id: string; ageDays: number }>;
      arrivedNotRecorded: Array<{ ref: string }>;
      clean: boolean;
    };
    expect(body.recordedNotArrived.map((p) => p.id)).toEqual(['p3']);
    expect(body.arrivedNotRecorded.map((r) => r.ref)).toEqual(['ZZ9']);
    expect(body.clean).toBe(false);
  });

  /* docs/bugs/0688 — the owner, the morning per-bank clearing went live: the
     same instalment under GHL, HLB, MBB and PBB, and the header counting it
     four times. An untagged payment is every acquirer's CANDIDATE (that is how
     a statement finds it) but ONE payment on a watch list. */
  test('an untagged payment sits on each watch list once, under no acquirer', async () => {
    const { app } = harness({
      acc_acquirers: [MBB, GHL],
      mfg_sales_order_payments: [
        soPayment(),
        soPayment({ id: 'u1', so_doc_no: 'SO-2608-013', method: 'installment', merchant_provider: null, amount_sen: 336500, approval_code: '009577' }),
      ],
    });
    const byId = (rows: Array<{ id: string; acquirerCode: string | null }>) =>
      Object.fromEntries(rows.map((r) => [r.id, r.acquirerCode]));

    const w = await (await app.request('/settlement/watchlist?from=2026-07-20&to=2026-08-16')).json() as {
      recordedNotArrived: Array<{ id: string; acquirerCode: string | null }>;
    };
    expect(byId(w.recordedNotArrived)).toEqual({ p1: 'MBB', u1: null });
    /* Asked about the merchant that never tagged it, it is still his candidate — once. */
    const g = await (await app.request('/settlement/watchlist?acquirer=GHL&from=2026-07-20&to=2026-08-16')).json() as {
      recordedNotArrived: Array<{ id: string; acquirerCode: string | null }>;
    };
    expect(byId(g.recordedNotArrived)).toEqual({ u1: null });

    const t = await (await app.request('/settlement/in-transit?from=2026-07-20&to=2026-08-16')).json() as {
      totalSen: number; ageing: Record<string, unknown>; lines: Array<{ paymentId: string; acquirerCode: string | null }>;
    };
    expect(Object.fromEntries(t.lines.map((l) => [l.paymentId, l.acquirerCode]))).toEqual({ p1: 'MBB', u1: null });
    expect(t.lines).toHaveLength(2);
    expect(t.totalSen).toBe(436500);
    expect(Object.keys(t.ageing).sort()).toEqual(['MBB', '未标']);
  });
});

describe('GET /settlement/batches', () => {
  test('lists what has been uploaded', async () => {
    const { app } = harness({ mfg_sales_order_payments: [soPayment()] });
    await upload(app, { acquirerCode: 'MBB', fileName: 'aug.csv', content: STATEMENT });
    const body = await (await app.request('/settlement/batches')).json() as { batches: Array<Record<string, unknown>> };
    expect(body.batches).toHaveLength(1);
    expect(body.batches[0]).toMatchObject({ acquirer_code: 'MBB', file_name: 'aug.csv', row_count: 2 });
  });
});

/* One clearing account per bank (owner 2026-09-07: 我想要拆账户，因为这样我比较然后
   检查回). The maintenance screen offers each company's 326-/327- accounts and
   points a merchant at one; the write refuses anything that is not a live
   clearing account of that company. */
describe('maintenance — the clearing account per merchant', () => {
  const CLEARING: Row[] = [
    { account_code: '326-0000', account_name: 'CARD MACHINE CLEARING (EDC)', account_type: 'ASSET', parent_code: null, is_active: true, acc_money: false, company_id: 2 },
    { account_code: '326-0010', account_name: 'CARD MACHINE CLEARING — PBB', account_type: 'ASSET', parent_code: null, is_active: true, acc_money: false, company_id: 2 },
    { account_code: '326-0090', account_name: 'RETIRED', account_type: 'ASSET', parent_code: null, is_active: false, acc_money: false, company_id: 2 },
    { account_code: '310-0010', account_name: 'Bank — Maybank', account_type: 'ASSET', parent_code: null, is_active: true, acc_money: true, company_id: 2 },
    { account_code: '900-0000', account_name: 'Rent', account_type: 'EXPENSE', parent_code: null, is_active: true, acc_money: false, company_id: 2 },
  ];
  const world = () => harness({
    accounts: CLEARING,
    acc_acquirer_config: [{ code: 'PBB', display_name: 'PBB', statement_format: 'CSV', has_unique_ref: true, fee_method: 'stated', date_tolerance_days: 3, column_map: { date: 'D', gross: 'G' }, is_active: true }],
    acc_company_acquirers: [{ company_id: 2, acquirer_code: 'PBB', transit_account_code: '326-0010', fee_account_code: '930-0000', bank_account_code: '310-0010', is_active: true }],
  });

  test('the screen reads each company\'s live clearing accounts and where the merchant sits today', async () => {
    const { app } = world();
    const body = await (await app.request('/settlement/maintenance')).json() as {
      merchants: Array<{ code: string; byCompany: Record<string, { transitAccountCode: string | null }> }>;
      clearings: Record<string, Array<{ account_code: string }>>;
    };
    expect(body.merchants.find((m) => m.code === 'PBB')!.byCompany['2']).toMatchObject({ transitAccountCode: '326-0010' });
    /* Live 326-/327- only — the retired one and the bank and the expense never appear. */
    expect(body.clearings['2']!.map((a) => a.account_code)).toEqual(['326-0000', '326-0010']);
    expect(body.clearings['1']).toEqual([]);
  });

  test('pointing the merchant at a clearing account writes the link; a bank, an expense, a retired or a foreign code is refused', async () => {
    const { app, sb } = world();
    const ok = await patch(app, '/settlement/maintenance/merchant', { companyId: 2, code: 'PBB', transitAccountCode: '326-0000' });
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect(sb.tables.acc_company_acquirers[0]).toMatchObject({ transit_account_code: '326-0000' });
    for (const bad of ['310-0010', '900-0000', '326-0090', '326-0777']) {
      const res = await patch(app, '/settlement/maintenance/merchant', { companyId: 2, code: 'PBB', transitAccountCode: bad });
      expect(res.status, bad).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('bad_clearing_account');
    }
    expect(sb.tables.acc_company_acquirers[0]).toMatchObject({ transit_account_code: '326-0000' });
    /* Blank = back to the generic account. */
    const blank = await patch(app, '/settlement/maintenance/merchant', { companyId: 2, code: 'PBB', transitAccountCode: '' });
    expect(blank.status).toBe(200);
    expect(sb.tables.acc_company_acquirers[0]).toMatchObject({ transit_account_code: '326-0000' });
  });
});

/* ── WHAT THE OWNER SAW ON 2026-09-09 ────────────────────────────────────────
   Nine PBB lines stood MATCHED, each carrying the clue "Reference 034766
   matches 2990-SO-2606-046", and every one of them ALSO said "No payment in the
   ERP explains this money". Pressing "Confirm all 9 matched" posted nothing.

   Three separate faults produced that one screen, and each gets a test here:
     • the detail read `candidates`/`suggested`, which matchStatement empties on
       purpose for a ref match — the payment lives in `matched`;
     • the link insert was skipped in silence when the rows insert returned no
       ids, leaving nine MATCHED lines and zero links;
     • a payment carrying the exact reference was never LOADED when it fell
       outside the date window, so four other lines read "No payment recorded
       near …" with the payment sitting in the ERP. */

describe('a reference-matched line always arrives carrying its payment', () => {
  test('the detail offers the matched payment, pre-ticked, even with no link stored', async () => {
    const { app, sb } = harness({ mfg_sales_order_payments: [soPayment()] });
    const up = await (await upload(app, { acquirerCode: 'MBB', fileName: 'aug.csv', content: STATEMENT })).json() as { batchId: number };

    /* Reproduce the prod state exactly: the line stands MATCHED and its link
       row is gone. Before the fix this rendered "No payment in the ERP explains
       this money" under a clue naming the sale. */
    sb.tables.acc_settlement_matches = [];

    const body = await (await app.request(`/settlement/batches/${up.batchId}`)).json() as {
      rows: Array<{ bucket: string; clue: string | null; candidates: Array<{ id: string }>; suggested: Array<{ id: string }>; linked: unknown[] }>;
    };
    const matched = body.rows.find((r) => r.bucket === 'MATCHED')!;
    expect(matched.linked).toHaveLength(0);
    expect(matched.candidates.map((p) => p.id)).toEqual(['p1']);
    expect(matched.suggested.map((p) => p.id)).toEqual(['p1']);
    /* The two sentences can no longer contradict each other. */
    expect(matched.clue).toMatch(/Reference A1 matches SO-2608-001/);
  });
});

describe('the link insert cannot fail in silence', () => {
  /* On prod the rows insert reported no error and returned no ids, so every
     link hit its `continue` and nine MATCHED lines kept zero links. A count
     that cannot be reconciled to the decisions is the only thing that says so. */
  test('an upload whose lines report no ids is refused, and keeps nothing', async () => {
    const { app, sb } = harness({ mfg_sales_order_payments: [soPayment()] });
    const realFrom = sb.from.bind(sb);
    sb.from = ((table: string) => {
      const q = realFrom(table);
      if (table !== 'acc_settlement_rows') return q;
      const realInsert = q.insert.bind(q);
      /* The shape of the failure: the write happens, the representation does
         not come back. */
      q.insert = (rows: unknown) => {
        const ins = realInsert(rows);
        ins.select = () => Promise.resolve({ data: [], error: null });
        return ins;
      };
      return q;
    }) as typeof sb.from;

    const res = await upload(app, { acquirerCode: 'MBB', fileName: 'aug.csv', content: STATEMENT });
    expect(res.status).toBe(500);
    const body = (await res.json()) as Row;
    expect(String(body.message)).toMatch(/could not be linked/);
    /* Nothing kept: the batch is cleaned up so the file can come in again. */
    expect(sb.tables.acc_settlement_batches).toHaveLength(0);
  });
});

describe('an exact reference is not hidden by the date window', () => {
  /* The owner's four PBB lines: same reference, same amount, keyed eleven days
     late because the sale was written up late. MBB's tolerance here is 3. */
  test('a payment keyed long after the swipe is found and offered', async () => {
    const { app } = harness({
      mfg_sales_order_payments: [soPayment({ paid_at: '2026-08-12T10:00:00' })],
    });
    const up = await (await upload(app, { acquirerCode: 'MBB', fileName: 'aug.csv', content: STATEMENT })).json() as { batchId: number };
    const body = await (await app.request(`/settlement/batches/${up.batchId}`)).json() as {
      rows: Array<{ ref: string | null; bucket: string; clue: string | null; suggested: Array<{ id: string }> }>;
    };
    const line = body.rows.find((r) => r.ref === 'A1')!;
    /* Offered, not taken — a reference across eleven days is also the shape of
       a mis-keyed code, and this is the path that books money. */
    expect(line.bucket).toBe('NEEDS_CONFIRM');
    expect(line.suggested.map((p) => p.id)).toEqual(['p1']);
    expect(line.clue).toMatch(/outside the 3-day window/);
    expect(line.clue).not.toMatch(/No payment recorded/);
  });
});

/* ── "CONFIRM ALL 9 MATCHED" MUST NOT POST 0 ──────────────────────────────────
   The detail screen was fixed to fall back to the matcher when a link is
   missing (docs/bugs/0760), and the owner then saw the payment on screen — but
   the bulk button reads the LINK TABLE, so it still sent an empty selection for
   every one of those nine lines and answered "Posted 0. 9 could not be".

   The same fallback belongs here, with one difference that is the whole point:
   only `matched` is rescued, never `suggested`. Nobody is reading each line on
   this path, and this button's promise is "post every line the unique reference
   already matched". */

describe('confirm-all posts a matched line whose link went missing', () => {
  test('the payment is recovered from the matcher, and the link is written back', async () => {
    const { app, sb } = harness({ mfg_sales_order_payments: [soPayment()] });
    const up = await (await upload(app, { acquirerCode: 'MBB', fileName: 'aug.csv', content: STATEMENT })).json() as { batchId: number };

    /* Exactly the prod state: MATCHED bucket, no link. */
    sb.tables.acc_settlement_matches = [];

    const res = await post(app, `/settlement/batches/${up.batchId}/confirm-matched`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { attempted: number; confirmed: number; failed: unknown[] };
    expect(body.attempted).toBe(1);
    expect(body.confirmed).toBe(1);
    expect(body.failed).toEqual([]);

    /* Confirming writes the link, so the data heals as he works. */
    expect((sb.tables.acc_settlement_matches as Row[]).length).toBe(1);
    const row = (sb.tables.acc_settlement_rows as Row[]).find((r) => r.bucket === 'MATCHED')!;
    expect(row.confirmed_at).toBeTruthy();
    expect(row.posted_je_no).toBeTruthy();
  });

  /* THE LINE THAT MUST NOT MOVE. A payment the matcher only SUGGESTS — here an
     out-of-window reference — is not something a bulk button may post: it is
     offered on the detail screen for a human to look at. */
  test('a merely suggested payment is not posted by the bulk button', async () => {
    const { app, sb } = harness({
      mfg_sales_order_payments: [soPayment({ paid_at: '2026-08-12T10:00:00' })],
    });
    const up = await (await upload(app, { acquirerCode: 'MBB', fileName: 'aug.csv', content: STATEMENT })).json() as { batchId: number };
    /* Eleven days out: NEEDS_CONFIRM with the payment pre-ticked, so the bulk
       button has nothing to do — and must not invent something. */
    const rows = sb.tables.acc_settlement_rows as Row[];
    expect(rows.find((r) => r.ref === 'A1')!.bucket).toBe('NEEDS_CONFIRM');

    const res = await post(app, `/settlement/batches/${up.batchId}/confirm-matched`);
    const body = (await res.json()) as { attempted: number; confirmed: number };
    expect(body.attempted).toBe(0);
    expect(body.confirmed).toBe(0);
    expect(sb.tables.acc_settlement_matches).toHaveLength(0);
  });

  test('a batch that does not exist is a 404, not an empty success', async () => {
    const { app } = harness({ mfg_sales_order_payments: [soPayment()] });
    const res = await post(app, '/settlement/batches/9999/confirm-matched');
    expect(res.status).toBe(404);
  });
});

/* ── WHERE THE MERCHANT FEE GOES, CHOOSABLE ──────────────────────────────────
   It had to be a migration once (docs/bugs/0762): the fee account was seeded at
   930-0000, the AutoCount chart deactivated that code, and every settlement
   confirm in both companies refused with nothing on any screen able to repoint
   it. The owner, told that: 这个需要.

   What is pinned here is that the screen can only be OFFERED, and can only
   SAVE, an account the posting gate would actually accept — because the whole
   failure was a fee account the gate refuses. */

describe('the merchant fee account is chosen, not assumed', () => {
  const EXPENSES: Row[] = [
    { account_code: '900-0000', account_name: 'EXPENSES', account_type: 'EXPENSE', parent_code: null, is_active: true, company_id: CO },
    { account_code: '900-B001', account_name: 'BANK CHARGES', account_type: 'EXPENSE', parent_code: '900-0000', is_active: true, company_id: CO },
    { account_code: '900-T009', account_name: 'TERMINAL INTEREST CHARGES', account_type: 'EXPENSE', parent_code: '900-0000', is_active: true, company_id: CO },
    /* The shape that started all this: present, but switched off. */
    { account_code: '930-0000', account_name: 'MISCELLANEOUS EXPENSES XXX', account_type: 'EXPENSE', parent_code: null, is_active: false, company_id: CO },
    { account_code: '310-0010', account_name: 'Bank', account_type: 'ASSET', parent_code: null, is_active: true, acc_money: true, company_id: CO },
  ];
  const CFG: Row[] = [
    { code: 'MBB', display_name: 'MBB', statement_format: 'CSV', has_unique_ref: true, fee_method: 'stated', date_tolerance_days: 3, column_map: { date: 'Txn Date', gross: 'Gross', fee: 'MDR' }, is_active: true },
  ];
  const rig = () => harness({
    accounts: EXPENSES, acc_acquirer_config: CFG,
    acc_company_acquirers: [{ company_id: CO, acquirer_code: 'MBB', bank_account_code: '310-0010', fee_account_code: '930-0000', is_active: true }],
  });

  test('offers the active expense LEAVES, and never a header or a dead code', async () => {
    const { app } = rig();
    const body = await (await app.request('/settlement/maintenance')).json() as {
      feeAccounts: Record<string, Array<{ account_code: string }>>;
    };
    const offered = (body.feeAccounts[String(CO)] ?? []).map((a) => a.account_code);
    expect(offered).toEqual(['900-B001', '900-T009']);
    /* 900-0000 has children — nothing posts to it. 930-0000 is switched off,
       which is the exact account that refused every confirm. */
    expect(offered).not.toContain('900-0000');
    expect(offered).not.toContain('930-0000');
  });

  test('says what each company currently books the fee to', async () => {
    const { app } = rig();
    const body = await (await app.request('/settlement/maintenance')).json() as { merchants: Array<Record<string, any>> };
    expect(body.merchants.find((m) => m.code === 'MBB')!.byCompany[String(CO)])
      .toMatchObject({ feeAccountCode: '930-0000' });
  });

  test('saves a pick', async () => {
    const { app, sb } = rig();
    const res = await patch(app, '/settlement/maintenance/merchant', { companyId: CO, code: 'MBB', feeAccountCode: '900-T009' });
    expect(res.status).toBe(200);
    expect((sb.tables.acc_company_acquirers as Row[])[0]!.fee_account_code).toBe('900-T009');
  });

  /* THE ONES THAT MATTER. Each refusal is the posting gate's own rule, applied
     where the choice is made rather than at the moment somebody confirms a
     statement — which is where it was applied before, six days too late. */
  test('refuses an account that is switched off', async () => {
    const { app, sb } = rig();
    const res = await patch(app, '/settlement/maintenance/merchant', { companyId: CO, code: 'MBB', feeAccountCode: '930-0000' });
    expect(res.status).toBe(400);
    expect(String(((await res.json()) as Row).message)).toMatch(/switched off/);
    expect((sb.tables.acc_company_acquirers as Row[])[0]!.fee_account_code).toBe('930-0000');
  });

  test('refuses an account that is not an expense', async () => {
    const { app } = rig();
    const res = await patch(app, '/settlement/maintenance/merchant', { companyId: CO, code: 'MBB', feeAccountCode: '310-0010' });
    expect(res.status).toBe(400);
    expect(String(((await res.json()) as Row).message)).toMatch(/expense/i);
  });

  test('refuses a header account, and says to pick one of its children', async () => {
    const { app } = rig();
    const res = await patch(app, '/settlement/maintenance/merchant', { companyId: CO, code: 'MBB', feeAccountCode: '900-0000' });
    expect(res.status).toBe(400);
    expect(String(((await res.json()) as Row).message)).toMatch(/sub-accounts/);
  });

  test('refuses a code this company does not carry', async () => {
    const { app } = rig();
    const res = await patch(app, '/settlement/maintenance/merchant', { companyId: CO, code: 'MBB', feeAccountCode: '999-9999' });
    expect(res.status).toBe(400);
    expect(String(((await res.json()) as Row).message)).toMatch(/not in this company/);
  });
});
