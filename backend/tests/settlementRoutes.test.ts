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
  settlementBatchReceived, settlementInTransit,
} from '../src/scm/routes/accounting-settlement';

const CO = 1;
const GL_PERM = 'scm.payment_voucher.post';

const CHART: Row[] = ['320-0000', '330-0000', '930-0000'].map((code) => ({
  account_code: code, account_name: code, account_type: 'ASSET', parent_code: null, is_active: true, company_id: CO,
}));

const MBB: Row = {
  company_id: CO, code: 'MBB', display_name: 'MBB',
  transit_account_code: '320-0000', fee_account_code: '930-0000', bank_account_code: '330-0000',
  statement_format: 'CSV', has_unique_ref: true, fee_method: 'stated',
  date_tolerance_days: 3, is_active: true,
  column_map: { date: 'Txn Date', ref: 'Approval Code', gross: 'Gross', fee: 'MDR' },
};
/* GHL is the brief's cautionary tale: a real acquirer that sends no unique
   transaction reference, so nothing of its may auto-confirm. */
const GHL: Row = { ...MBB, code: 'GHL', display_name: 'GHL', has_unique_ref: false, column_map: { date: 'Txn Date', gross: 'Gross', fee: 'MDR' } };

const soPayment = (over: Row = {}): Row => ({
  id: 'p1', so_doc_no: 'SO-2608-001', paid_at: '2026-08-01T10:00:00', amount_centi: 100000,
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
    await next();
  });
  app.get('/settlement/setup', settlementSetup as never);
  app.post('/settlement/batches', settlementUpload as never);
  app.get('/settlement/batches', settlementBatches as never);
  app.get('/settlement/batches/:id', settlementBatchDetail as never);
  app.post('/settlement/batches/:id/confirm-matched', settlementConfirmMatched as never);
  app.post('/settlement/rows/:id/confirm', settlementConfirmRow as never);
  app.post('/settlement/rows/:id/ignore', settlementIgnoreRow as never);
  app.post('/settlement/batches/:id/received', settlementBatchReceived as never);
  app.get('/settlement/watchlist', settlementWatchlist as never);
  app.get('/settlement/in-transit', settlementInTransit as never);
  return { app, sb };
}

const upload = (app: Hono, body: Record<string, unknown>) =>
  app.request('/settlement/batches', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

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
    expect(lines.find((l) => l.account_code === '320-0000')).toMatchObject({ credit_sen: 1500 });
    expect(lines.some((l) => l.account_code === '330-0000')).toBe(false);
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
    expect(adjLines.find((l) => l.account_code === '320-0000')).toMatchObject({ credit_sen: 25416 });
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
    expect(lines.find((l) => l.account_code === '330-0000')).toMatchObject({ debit_sen: 175100 });
    expect(lines.find((l) => l.account_code === '320-0000')).toMatchObject({ credit_sen: 175100 });
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
      .filter((l) => l.account_code === '320-0000')
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
      .filter((l) => l.account_code === '320-0000')
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

describe('the batch detail and the watchlists', () => {
  test('the detail view shows the piles and recomputes candidates for the open lines', async () => {
    const { app } = harness({ mfg_sales_order_payments: [soPayment(), soPayment({ id: 'p2', so_doc_no: 'SO-2608-002', amount_centi: 77700, approval_code: null })] });
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
    const { app } = harness({ mfg_sales_order_payments: [soPayment(), soPayment({ id: 'p3', so_doc_no: 'SO-3', paid_at: '2026-07-15T09:00:00', amount_centi: 5000, approval_code: 'B2' })] });
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
