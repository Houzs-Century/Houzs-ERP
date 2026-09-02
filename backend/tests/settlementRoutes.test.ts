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
  settlementConfirmRow, settlementConfirmMatched, settlementIgnoreRow, settlementWatchlist,
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

  test('confirming a line whose selection does not add up is refused with the difference', async () => {
    const { app, sb } = harness({ mfg_sales_order_payments: [soPayment()] });
    await upload(app, { acquirerCode: 'MBB', fileName: 'aug.csv', content: STATEMENT });
    const unmatched = sb.tables.acc_settlement_rows.find((r) => r.bucket === 'UNMATCHED')!;

    const res = await post(app, `/settlement/rows/${unmatched.id}/confirm`, {
      payments: [{ source: 'SOPAY', id: 'px', docNo: 'SO-9', amountSen: 1000 }],
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'amount_mismatch' });
    expect(sb.tables.journal_entries).toHaveLength(0);
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
      payments: [{ source: 'SOPAY', id: 'm1', docNo: 'SO-2608-001', amountSen: 100000 }],
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
