// Owner 2026-11-17: 2990's AEON instalment sales are swiped on Houzs's AEON
// terminal, so they land on Houzs's AEON reports with no Houzs sale behind
// them, and Houzs pays 2990 back by voucher — 「houzs 那边的报表要确定这些和
// refund给2990 contra 掉」, then 「可以开始做先」.
//
// Pinned with AEON's report of 30/10 (R21077 RM 3,990.00 and 080405 RM 1,640.00,
// RM 150.88 statement charge, RM 5,411.56 paid): the share of the charge, the
// SETTLEFOR journal, the two doors, Undo, and the report then paying out.

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { chargeSharesOf, owedOf, soldByLines } from '../src/acc/settlement-sold-by';
import { settlementOtherCompanies, settlementRowSoldBy } from '../src/scm/routes/accounting-settlement-sold-by';
import { settlementRowUnconfirm } from '../src/scm/routes/accounting-settlement';
import { loadPayableBatches } from '../src/acc/bank';

const HOUZS = 1;
const T2990 = 2;

describe('the share of a statement charge', () => {
  test("AEON's RM 150.88 of 30/10 over R21077 and 080405 is RM 106.93 and RM 43.95, as Houzs worked it", () => {
    expect([...chargeSharesOf(15088, [{ id: 1, grossSen: 399000 }, { id: 2, grossSen: 164000 }])]).toEqual([[1, 10693], [2, 4395]]);
  });

  test('the 7/11 report: RM 370.65 over three swipes adds up to the sen', () => {
    const shares = chargeSharesOf(37065, [{ id: 1, grossSen: 324000 }, { id: 2, grossSen: 164000 }, { id: 3, grossSen: 434000 }]);
    expect([...shares.values()]).toEqual([13025, 6593, 17447]);
    expect([...shares.values()].reduce((a, b) => a + b, 0)).toBe(37065);
  });

  test('a rebate is shared the same way, negative; a refund line takes none; no charge, no share', () => {
    expect([...chargeSharesOf(-100, [{ id: 1, grossSen: 100 }, { id: 2, grossSen: 200 }, { id: 3, grossSen: -50 }])])
      .toEqual([[1, -33], [2, -67], [3, 0]]);
    expect([...chargeSharesOf(0, [{ id: 1, grossSen: 100 }])]).toEqual([[1, 0]]);
  });
});

describe('the SETTLEFOR journal', () => {
  const accounts = { transitAccountCode: '326-0000', linkAccountCode: '350-0070', feeAccountCode: '900-T009' };

  test("R21077: the gross onto 350-0070, AEON's fee and its RM 106.93 share back out of it — RM 3,835.19 owed, what Houzs paid back", () => {
    const lines = soldByLines(accounts, { acquirerCode: 'AEON', txnDate: '2026-10-30', ref: 'R21077', grossSen: 399000, feeSen: 4788, chargeShareSen: 10693, soldBy: '2990' });
    expect(lines.map((l) => [l.accountCode, l.debitSen, l.creditSen])).toEqual([
      ['326-0000', 399000, 0], ['350-0070', 0, 399000],
      ['350-0070', 4788, 0], ['326-0000', 0, 4788],
      ['350-0070', 10693, 0], ['900-T009', 0, 10693],
    ]);
    expect(owedOf({ grossSen: 399000, feeSen: 4788, chargeShareSen: 10693 })).toBe(383519);
  });

  test('no fee and no share books the gross alone; a rebate share books back the other way', () => {
    const plain = soldByLines(accounts, { acquirerCode: 'AEON', txnDate: '2026-10-30', ref: null, grossSen: 1000, feeSen: 0, chargeShareSen: 0, soldBy: '2990' });
    expect(plain.map((l) => [l.accountCode, l.debitSen, l.creditSen])).toEqual([['326-0000', 1000, 0], ['350-0070', 0, 1000]]);
    const rebate = soldByLines(accounts, { acquirerCode: 'AEON', txnDate: '2026-10-30', ref: null, grossSen: 1000, feeSen: 0, chargeShareSen: -5, soldBy: '2990' });
    expect(rebate.slice(2).map((l) => [l.accountCode, l.debitSen, l.creditSen])).toEqual([['350-0070', 0, 5], ['900-T009', 5, 0]]);
  });
});

const line = (over: Partial<Row> & { id: number }): Row => ({
  batch_id: 435, company_id: HOUZS, acquirer_code: 'AEON', line_no: over.id - 10, txn_date: '2026-10-30', ref: null,
  gross_sen: 0, fee_sen: 0, net_sen: 0, bucket: 'NEEDS_CONFIRM', match_reason: null, confirmed_at: null, confirmed_by: null,
  posted_je_no: null, posted_je_id: null, notes: 'No payment matches this amount', matched_with_row_id: null, not_this: null,
  channel: null, sold_by_company_id: null, ...over,
});

function harness(over: Record<string, Row[]> = {}) {
  const db: Record<string, Row[]> = {
    companies: [{ id: HOUZS, code: 'HOUZS', name: 'Houzs Century' }, { id: T2990, code: '2990', name: "2990's Home" }, { id: 3, code: 'CONTS', name: 'The Conts' }],
    accounts: ['310-0010', '326-0000', '900-T009', '350-0070'].map((account_code) => ({
      company_id: HOUZS, account_code, account_name: account_code === '350-0070' ? 'LOAN TO RELATED PARTY - 2990 HOME SDN BHD' : account_code,
      parent_code: null, is_active: true,
    })),
    acc_account_roles: [],
    acc_acquirers: [{
      company_id: HOUZS, code: 'AEON', display_name: 'AEON', transit_account_code: '326-0000', fee_account_code: '900-T009',
      bank_account_code: '310-0010', date_tolerance_days: 3, is_active: true, so_names: [],
    }],
    acc_company_links: [{ company_id: HOUZS, other_company_id: T2990, account_code: '350-0070' }],
    acc_settlement_batches: [{
      id: 435, company_id: HOUZS, acquirer_code: 'AEON', file_name: '20261030_000458030232406.csv', period_from: '2026-10-30', period_to: '2026-10-30',
      gross_sen: 563000, fee_sen: 6756, net_sen: 556244, stated_net_sen: 541156, adjustment_sen: 15088, adjustment_je_no: null, status: 'OPEN',
    }],
    acc_settlement_rows: [
      line({ id: 11, ref: 'R21077', gross_sen: 399000, fee_sen: 4788, net_sen: 394212 }),
      line({ id: 12, ref: '080405', gross_sen: 164000, fee_sen: 1968, net_sen: 162032, bucket: 'UNMATCHED' }),
    ],
    acc_settlement_matches: [], acc_settlement_receipts: [], acc_settlement_payout_batches: [],
    journal_entries: [], journal_entry_lines: [],
    acc_bank_statements: [], acc_bank_statement_lines: [], acc_bank_statement_matches: [], acc_bank_month_locks: [],
    ...over,
  };
  const sb = fakeSb(db, {}, [], ['acc_settlement_rows', 'acc_settlement_batches']);
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, HOUZS as never);
    c.set('houzsUser' as never, { name: 'Chew', permissions_set: ['scm.payment_voucher.post'] } as never);
    c.set('allowedCompanyIds' as never, [HOUZS] as never);
    await next();
  });
  app.get('/settlement/other-companies', settlementOtherCompanies as never);
  app.post('/settlement/rows/:id/sold-by', settlementRowSoldBy as never);
  app.post('/settlement/rows/:id/unconfirm', settlementRowUnconfirm as never);
  return { app, sb, db };
}

const post = (app: Hono, path: string, body: Record<string, unknown>) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const soldBy = (app: Hono, rowId: number, body: Record<string, unknown> = { companyId: T2990 }) => post(app, `/settlement/rows/${rowId}/sold-by`, body);

/** The standing (not reversed) entry of a source document, as [account, debit, credit] lines; null when none stands. */
function standing(db: Record<string, Row[]>, sourceType: string, docNo: string) {
  const e = (db.journal_entries ?? []).find((x) => x.source_type === sourceType && x.source_doc_no === docNo && !x.reversed);
  return e ? (db.journal_entry_lines ?? []).filter((l) => l.journal_entry_id === e.id).map((l) => [l.account_code, Number(l.debit_sen), Number(l.credit_sen)]) : null;
}
/** What every entry leaves on one account, debit positive — a reversed entry and its contra net to nothing. */
const balance = (db: Record<string, Row[]>, account: string): number => (db.journal_entry_lines ?? [])
  .filter((l) => l.account_code === account).reduce((s, l) => s + Number(l.debit_sen) - Number(l.credit_sen), 0);

describe('Merchant Recon: a line is another company\'s sale', () => {
  test('offers 2990 with the account it is booked to', async () => {
    const { app } = harness();
    const res = await app.request('/settlement/other-companies');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      companies: [{ companyId: T2990, code: '2990', name: "2990's Home", accountCode: '350-0070', accountName: 'LOAN TO RELATED PARTY - 2990 HOME SDN BHD', usable: true }],
    });
  });

  test('R21077 booked as 2990\'s: RM 3,835.19 owed on 350-0070, the statement charge booked once, the line confirmed', async () => {
    const { app, db } = harness();
    const res = await soldBy(app, 11, { companyId: T2990, note: '2990-SO-2611-017' });
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string; jeNo: string; owedSen: number; chargeShareSen: number; accountCode: string; soldBy: string };
    expect(body).toMatchObject({ status: 'confirmed', owedSen: 383519, chargeShareSen: 10693, accountCode: '350-0070', soldBy: '2990' });

    expect(standing(db, 'SETTLEFOR', 'SETTLEFOR-11')).toEqual([
      ['326-0000', 399000, 0], ['350-0070', 0, 399000],
      ['350-0070', 4788, 0], ['326-0000', 0, 4788],
      ['350-0070', 10693, 0], ['900-T009', 0, 10693],
    ]);
    expect(standing(db, 'SETTLEADJ', 'SETTLEADJ-435')).toEqual([['900-T009', 15088, 0], ['326-0000', 0, 15088]]);

    const row = db.acc_settlement_rows!.find((r) => r.id === 11)!;
    expect(row).toMatchObject({ bucket: 'MATCHED', sold_by_company_id: T2990, posted_je_no: body.jeNo, notes: 'Sold by 2990: 2990-SO-2611-017' });
    expect(row.confirmed_at).toBeTruthy();
    expect(balance(db, '350-0070')).toBe(-383519);
  });

  test('both lines 2990\'s: the report pays out its RM 5,411.56, which is what Houzs owes 2990 and what clears card clearing', async () => {
    const { app, sb, db } = harness();
    expect((await soldBy(app, 11)).status).toBe(200);
    const second = await soldBy(app, 12);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ owedSen: 157637, chargeShareSen: 4395 });

    const payable = await loadPayableBatches(sb, HOUZS);
    expect(payable.ok && payable.batches.map((b) => [b.id, b.outstandingSen])).toEqual([[435, 541156]]);
    expect(balance(db, '326-0000')).toBe(541156);
    expect(balance(db, '350-0070')).toBe(-541156);
    expect(balance(db, '900-T009')).toBe(0);
    /* The statement charge was booked once, by the first press. */
    expect((db.journal_entries ?? []).filter((e) => e.source_type === 'SETTLEADJ')).toHaveLength(1);
  });

  test('refused: a company with no account here, this company itself, a set-aside line, a line matched to a sale here, a QR line, a confirmed line', async () => {
    const { app, db } = harness({
      acc_settlement_matches: [{ id: 1, settlement_row_id: 12, company_id: HOUZS, payment_source: 'SOPAY', payment_id: 'p1', doc_no: 'HC-SO-2610-340', amount_sen: 164000 }],
    });
    expect(await (await soldBy(app, 11, { companyId: 3 })).json()).toMatchObject({ error: 'no_link' });
    expect((await soldBy(app, 11, { companyId: HOUZS })).status).toBe(400);
    expect(await (await soldBy(app, 12)).json()).toMatchObject({ error: 'linked' });

    db.acc_settlement_rows!.find((r) => r.id === 11)!.bucket = 'IGNORED';
    expect(await (await soldBy(app, 11)).json()).toMatchObject({ error: 'ignored' });
    db.acc_settlement_rows!.find((r) => r.id === 11)!.bucket = 'NEEDS_CONFIRM';
    db.acc_settlement_rows!.find((r) => r.id === 11)!.channel = 'QR';
    expect(await (await soldBy(app, 11)).json()).toMatchObject({ error: 'qr_line' });
    db.acc_settlement_rows!.find((r) => r.id === 11)!.channel = null;

    expect((await soldBy(app, 11)).status).toBe(200);
    const again = await soldBy(app, 11);
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: 'already_confirmed' });
    expect((db.journal_entries ?? []).filter((e) => e.source_type === 'SETTLEFOR')).toHaveLength(1);
  });

  test('Undo reverses the SETTLEFOR journal and puts the line back to decide; it can then be booked again', async () => {
    const { app, db } = harness();
    expect((await soldBy(app, 11, { companyId: T2990, note: '2990-SO-2611-017' })).status).toBe(200);
    const undone = await post(app, '/settlement/rows/11/unconfirm', {});
    expect(undone.status).toBe(200);
    expect(await undone.json()).toMatchObject({ ok: true });

    expect(standing(db, 'SETTLEFOR', 'SETTLEFOR-11')).toBeNull();
    expect((db.journal_entries ?? []).some((e) => e.source_type === 'SETTLEFOR_REVERSAL')).toBe(true);
    expect(balance(db, '350-0070')).toBe(0);
    const row = db.acc_settlement_rows!.find((r) => r.id === 11)!;
    expect(row).toMatchObject({ bucket: 'NEEDS_CONFIRM', sold_by_company_id: null, confirmed_at: null, posted_je_no: null, notes: null });

    expect((await soldBy(app, 11)).status).toBe(200);
    expect(standing(db, 'SETTLEFOR', 'SETTLEFOR-11')).toHaveLength(6);
  });

  test('Undo is refused while money is recorded received against the report', async () => {
    const { app, db } = harness();
    expect((await soldBy(app, 11)).status).toBe(200);
    db.acc_settlement_receipts!.push({ id: 1, batch_id: 435, company_id: HOUZS, amount_sen: 541156, charge_sen: 0, bank_line_id: 966 });
    const undone = await post(app, '/settlement/rows/11/unconfirm', {});
    expect(undone.status).toBe(409);
    expect(await undone.json()).toMatchObject({ error: 'has_receipts' });
    expect(standing(db, 'SETTLEFOR', 'SETTLEFOR-11')).not.toBeNull();
  });
});

/* Production, 2026-11-17: Merchant Recon showed no 「2990 的单」 — GET
   /settlement/other-companies answered 500 "Could not find the table
   'scm.companies' in the schema cache". The SCM client is pinned to `scm` and
   the companies master lives in `public` (docs/bugs/0522); the fake has one
   namespace, so here the scm side is made to answer as production does. */
describe('the companies master is read from public', () => {
  test('the button is offered when the scm client has no companies table', async () => {
    const { app, sb } = harness();
    const fake = sb as unknown as { from: (t: string) => unknown; schema: (s: string) => unknown };
    const realFrom = fake.from;
    const publicSide = { ...fake, from: realFrom };
    const missing = () => {
      const q: Record<string, unknown> = {};
      for (const m of ['select', 'in', 'eq', 'order']) q[m] = () => q;
      q.then = (ok: (v: unknown) => unknown) => ok({ data: null, error: { code: 'PGRST205', message: "Could not find the table 'scm.companies' in the schema cache" } });
      return q;
    };
    fake.from = (t: string) => (t === 'companies' ? missing() : realFrom(t));
    fake.schema = (s: string) => (s === 'public' ? publicSide : fake);

    const res = await app.request('/settlement/other-companies');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ companies: [{ companyId: T2990, code: '2990', accountCode: '350-0070', usable: true }] });
    expect((await soldBy(app, 11)).status).toBe(200);
  });
});
