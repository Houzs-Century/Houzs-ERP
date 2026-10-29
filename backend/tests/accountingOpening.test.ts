/* Finance › Setup › Opening Balance (owner 2026-10-28: 「然后确定一下我是会有一个
   opening balance maintainence 表是吗？」). Pinned:
     • GET reads the opening as AutoCount's own screen shows it: the OPENING
       journal's account lines (without the stock, its own tab, and without the
       clearing), the opening stock per bucket, the creditors and other debtors
       by their opening papers with what has come off each, and the clearing —
       nil when the opening balances;
     • a save re-posts through the one gate: the old OPENING journal reversed on
       its own date and the new one posted, both flagged `opening`, the stock on
       its buckets' accounts and the clearing balancing the rest;
     • an account the opening may not carry (a control, a stock account, the
       clearing) is refused by name;
     • a paper is added, changed and cancelled as an opening one — never below
       what has been settled against it, never dated after the opening day;
     • the opening locks only when the clearing is nil, and a locked opening
       refuses every write. */

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import {
  openingAccountsPut, openingGet, openingLock, openingPaperCancel, openingPaperCreate, openingPaperUpdate, openingStockPut, openingUnlock,
} from '../src/scm/routes/accounting-opening';

const CO = 1;
const acct = (code: string, name: string, type: string, parent: string | null = null): Row => ({ company_id: CO, account_code: code, account_name: name, account_type: type, parent_code: parent, is_active: true, section: null });
const CHART: Row[] = [
  acct('100-0000', 'CAPITAL', 'EQUITY'), acct('150-0000', 'RETAINED EARNING', 'EQUITY'), acct('190-0000', 'OPENING BALANCE CLEARING', 'EQUITY'),
  acct('310-0010', 'CASH AT BANK - MAYBANK', 'ASSET'), acct('305-0000', 'OTHER DEBTOR', 'ASSET'), acct('400-0000', 'ACCOUNT PAYABLE', 'LIABILITY'), acct('405-0000', 'OTHER CREDITORS', 'LIABILITY'),
  acct('600-0000', 'STOCKS AT THE BEGINNING OF YEAR', 'EXPENSE'),
  ...['0001', '0002', '0003', '0004', '0005'].flatMap((n) => [acct(`600-${n}`, `STOCKS AT THE BEGINNING ${n}`, 'EXPENSE', '600-0000'), acct(`330-${n}`, `STOCK ${n}`, 'ASSET'), acct(`620-${n}`, `STOCKS AT THE END ${n}`, 'EXPENSE')]),
];
const line = (je: string, no: number, code: string, dr: number, cr: number, over: Row = {}): Row => ({ id: `${je}-l${no}`, company_id: CO, journal_entry_id: je, line_no: no, account_code: code, debit_sen: dr, credit_sen: cr, ...over });
const je = (id: string, jeNo: string, date: string, source: string, doc: string, totalSen: number): Row => ({ id, company_id: CO, je_no: jeNo, entry_date: date, source_type: source, source_doc_no: doc, posted: true, reversed: false, reversed_by_je: null, opening: true, total_debit_sen: totalSen, total_credit_sen: totalSen });
/* The clearing as v_gl_entries hands it over (the view is SQL; tests-pg pins it). */
const gl = (n: number, dr: number, cr: number): Row => ({ line_id: `g${n}`, company_id: CO, account_code: '190-0000', debit_sen: dr, credit_sen: cr, posted: true, reversed: false, reversed_by_je: null });

function harness(over: { settings?: Row; clearing?: Row[] } = {}) {
  const sb = fakeSb({
    accounts: CHART.map((r) => ({ ...r })), acc_account_roles: [], companies: [{ id: CO, code: 'HOUZS' }],
    acc_company_settings: [{ company_id: CO, books_start_date: '2026-09-01', opening_stock: { customer: 8_000, showroom: 2_000 }, opening_locked_at: null, opening_locked_by: null, ...over.settings }],
    suppliers: [{ id: 'sup-d', company_id: CO, code: '400-D002', name: 'DIGLANT MANUFACTURING SDN BHD.' }],
    acc_debtors: [{ id: 'deb-t', company_id: CO, name: 'TANGUANYU ENTERPRISE' }],
    /* The opening as the import left it: bank 500, stock 80 + 20, retained earning 550, the clearing 50 (the papers' other side). */
    journal_entries: [
      je('je-open', 'JE-2608-0304', '2026-08-31', 'OPENING', 'HC-OPENING-2608', 60_000),
      je('je-api', 'JE-2608-0001', '2026-08-12', 'API', 'HC-API-2608-001', 7_000),
      je('je-odb', 'JE-2608-0002', '2026-08-31', 'ODB', 'HC-ODB-2608-001', 2_000),
    ],
    journal_entry_lines: [
      line('je-open', 1, '310-0010', 50_000, 0), line('je-open', 2, '600-0001', 8_000, 0), line('je-open', 3, '600-0004', 2_000, 0),
      line('je-open', 4, '150-0000', 0, 55_000), line('je-open', 5, '190-0000', 0, 5_000),
      line('je-api', 1, '190-0000', 7_000, 0), line('je-api', 2, '400-0000', 0, 7_000, { party_type: 'SUPPLIER', party_code: '400-D002' }),
      line('je-odb', 1, '305-0000', 2_000, 0, { party_type: 'ODEBTOR', party_name: 'TANGUANYU ENTERPRISE' }), line('je-odb', 2, '190-0000', 0, 2_000),
    ],
    ap_invoices: [{ id: 'api-1', company_id: CO, invoice_number: 'HC-API-2608-001', supplier_id: 'sup-d', supplier_invoice_ref: 'IV-2608-076', invoice_date: '2026-08-12', currency: 'MYR', exchange_rate: 1, total_sen: 7_000, paid_sen: 1_000, status: 'PARTIALLY_PAID', notes: 'AutoCount PI-008135', opening: true }],
    ap_invoice_lines: [{ id: 'apl-1', company_id: CO, invoice_id: 'api-1', line_no: 1, debit_account_code: '190-0000', amount_sen: 7_000 }],
    acc_credit_notes: [], acc_credit_note_lines: [], acc_credit_note_allocations: [],
    acc_debtor_bills: [{ id: 'odb-1', company_id: CO, bill_number: 'HC-ODB-2608-001', debtor_id: 'deb-t', bill_date: '2026-08-31', total_sen: 2_000, received_sen: 0, status: 'POSTED', notes: null, opening: true }],
    acc_debtor_bill_lines: [{ id: 'odbl-1', company_id: CO, bill_id: 'odb-1', line_no: 1, credit_account_code: '190-0000', amount_sen: 2_000 }],
    acc_debtor_receipts: [], acc_debtor_receipt_allocations: [],
    v_gl_entries: over.clearing ?? [gl(1, 0, 5_000), gl(2, 7_000, 0), gl(3, 0, 2_000)],
    entity_audit_log: [],
  });
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, CO as never);
    c.set('companyCode' as never, 'HOUZS' as never);
    c.set('houzsUser' as never, { name: 'Chew', permissions_set: ['scm.payment_voucher.post'] } as never);
    c.set('allowedCompanyIds' as never, [CO] as never);
    c.set('companies' as never, [{ id: CO, code: 'HOUZS', name: 'Houzs Century' }] as never);
    await next();
  });
  app.get('/opening', openingGet as never);
  app.put('/opening/accounts', openingAccountsPut as never);
  app.put('/opening/stock', openingStockPut as never);
  app.post('/opening/papers', openingPaperCreate as never);
  app.patch('/opening/papers/:kind/:id', openingPaperUpdate as never);
  app.post('/opening/papers/:kind/:id/cancel', openingPaperCancel as never);
  app.post('/opening/lock', openingLock as never);
  app.post('/opening/unlock', openingUnlock as never);
  return { app, sb };
}
const call = (app: Hono, path: string, method: string, body?: unknown) =>
  app.request(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
const linesOf = (sb: ReturnType<typeof harness>['sb'], jeId: string) =>
  sb.tables.journal_entry_lines.filter((l) => l.journal_entry_id === jeId).map((l) => [l.account_code, Number(l.debit_sen), Number(l.credit_sen)]);

describe('GET /opening — AutoCount\'s Opening Balance screen, in the ERP', () => {
  test('accounts without the stock and the clearing; the stock per bucket; the parties by their papers; the clearing nil', async () => {
    const { app } = harness();
    const b = await (await call(app, '/opening', 'GET')).json() as Row;
    expect(b).toMatchObject({ booksStart: '2026-09-01', openingDate: '2026-08-31', locked: null, journal: { jeNo: 'JE-2608-0304', date: '2026-08-31' } });
    expect(b.accounts.map((a: Row) => [a.code, a.drSen, a.crSen])).toEqual([['310-0010', 50_000, 0], ['150-0000', 0, 55_000]]);
    expect(b.stock).toMatchObject({ buckets: { customer: 8_000, showroom: 2_000 }, totalSen: 10_000 });
    expect(b.creditors).toEqual([expect.objectContaining({ code: '400-D002', control: '400-0000', owingSen: 7_000, creditSen: 0, netSen: 7_000 })]);
    expect(b.creditors[0].papers[0]).toMatchObject({ kind: 'API', no: 'HC-API-2608-001', ref: 'IV-2608-076', amountSen: 7_000, settledSen: 1_000 });
    expect(b.debtors).toEqual([expect.objectContaining({ name: 'TANGUANYU ENTERPRISE', owingSen: 2_000, netSen: 2_000 })]);
    expect(b.check).toEqual({ clearingCode: '190-0000', clearingSen: 0 });
  });
});

describe('PUT /opening/accounts — a save re-posts the OPENING journal', () => {
  test('the old one reversed on its own date, the new one posted — both opening — with the stock and the clearing balancing', async () => {
    const { app, sb } = harness();
    const res = await call(app, '/opening/accounts', 'PUT', { lines: [{ code: '310-0010', drSen: 50_000, crSen: 0 }, { code: '150-0000', drSen: 0, crSen: 54_000 }, { code: '100-0000', drSen: 0, crSen: 1_000 }] });
    expect(res.status).toBe(200);
    const opening = sb.tables.journal_entries.filter((j) => j.source_type === 'OPENING');
    expect(opening.find((j) => j.id === 'je-open')).toMatchObject({ reversed: true });
    const fresh = opening.find((j) => j.id !== 'je-open')!;
    expect(fresh).toMatchObject({ entry_date: '2026-08-31', source_doc_no: 'HC-OPENING-2608', posted: true, opening: true });
    expect(linesOf(sb, fresh.id)).toEqual([['310-0010', 50_000, 0], ['150-0000', 0, 54_000], ['100-0000', 0, 1_000], ['600-0001', 8_000, 0], ['600-0004', 2_000, 0], ['190-0000', 0, 5_000]]);
    expect(sb.tables.journal_entries.find((j) => j.source_type === 'OPENING_REVERSAL')).toMatchObject({ entry_date: '2026-08-31', opening: true, reversed_by_je: 'je-open' });
  });

  test('a control account, a stock account and the clearing are refused by name; nothing is posted', async () => {
    const { app, sb } = harness();
    for (const [code, words] of [['400-0000', 'control account'], ['600-0001', 'Stock tab'], ['190-0000', 'balances itself'], ['600-0000', 'header']] as const) {
      const res = await call(app, '/opening/accounts', 'PUT', { lines: [{ code, drSen: 100, crSen: 0 }] });
      expect(res.status).toBe(400);
      expect((await res.json() as { message: string }).message).toContain(words);
    }
    expect(sb.tables.journal_entries).toHaveLength(3);
  });

  test('a locked opening refuses every write', async () => {
    const { app, sb } = harness({ settings: { opening_locked_at: '2026-10-30T02:00:00Z', opening_locked_by: 'Chew' } });
    const res = await call(app, '/opening/accounts', 'PUT', { lines: [{ code: '310-0010', drSen: 1, crSen: 0 }] });
    expect(res.status).toBe(409);
    expect((await res.json() as { error: string }).error).toBe('opening_locked');
    expect((await call(app, '/opening/papers/API/api-1/cancel', 'POST')).status).toBe(409);
    expect(sb.tables.journal_entries).toHaveLength(3);
  });
});

describe('PUT /opening/stock', () => {
  test('the stock per bucket is stored and re-posted on its buckets\' accounts, the accounts unchanged', async () => {
    const { app, sb } = harness();
    expect((await call(app, '/opening/stock', 'PUT', { buckets: { customer: 9_000, display: 1_500 } })).status).toBe(200);
    expect(sb.tables.acc_company_settings[0]!.opening_stock).toEqual({ customer: 9_000, display: 1_500 });
    const fresh = sb.tables.journal_entries.find((j) => j.source_type === 'OPENING' && j.id !== 'je-open')!;
    expect(linesOf(sb, fresh.id)).toEqual([['310-0010', 50_000, 0], ['150-0000', 0, 55_000], ['600-0001', 9_000, 0], ['600-0002', 1_500, 0], ['190-0000', 0, 5_500]]);
  });
});

describe('the papers', () => {
  test('a new opening bill: numbered by its own month, flagged, its journal the import\'s own two lines', async () => {
    const { app, sb } = harness();
    const res = await call(app, '/opening/papers', 'POST', { kind: 'API', partyId: 'sup-d', date: '2026-08-20', ref: 'IV-2608-090', amountSen: 3_000 });
    expect(res.status).toBe(201);
    const b = await res.json() as { docNo: string };
    expect(b.docNo).toBe('HC-API-2608-002');
    expect(sb.tables.ap_invoices.find((a) => a.invoice_number === b.docNo)).toMatchObject({ opening: true, status: 'POSTED', total_sen: 3_000, supplier_invoice_ref: 'IV-2608-090' });
    const j = sb.tables.journal_entries.find((x) => x.source_doc_no === b.docNo)!;
    expect(j).toMatchObject({ source_type: 'API', entry_date: '2026-08-20', opening: true });
    expect(linesOf(sb, j.id)).toEqual([['190-0000', 3_000, 0], ['400-0000', 0, 3_000]]);
  });

  test('a paper is dated the opening day or before', async () => {
    const { app } = harness();
    const res = await call(app, '/opening/papers', 'POST', { kind: 'ODB', partyId: 'deb-t', date: '2026-09-01', amountSen: 100 });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe('bad_date');
  });

  test('a change re-posts the paper — never below what has been paid on it', async () => {
    const { app, sb } = harness();
    const low = await call(app, '/opening/papers/API/api-1', 'PATCH', { amountSen: 900 });
    expect(low.status).toBe(409);
    expect((await low.json() as { error: string }).error).toBe('below_settled');
    expect((await call(app, '/opening/papers/API/api-1', 'PATCH', { amountSen: 6_000 })).status).toBe(200);
    expect(sb.tables.ap_invoices[0]).toMatchObject({ total_sen: 6_000, status: 'PARTIALLY_PAID' });
    expect(sb.tables.journal_entries.find((j) => j.id === 'je-api')).toMatchObject({ reversed: true });
    const fresh = sb.tables.journal_entries.find((j) => j.source_type === 'API' && j.id !== 'je-api')!;
    expect(fresh).toMatchObject({ opening: true, entry_date: '2026-08-12' });
    expect(linesOf(sb, fresh.id)).toEqual([['190-0000', 6_000, 0], ['400-0000', 0, 6_000]]);
  });

  test('cancel: a paper with money on it refuses; one untouched is reversed and cancelled', async () => {
    const { app, sb } = harness();
    expect((await call(app, '/opening/papers/API/api-1/cancel', 'POST')).status).toBe(409);
    expect((await call(app, '/opening/papers/ODB/odb-1/cancel', 'POST')).status).toBe(200);
    expect(sb.tables.acc_debtor_bills[0]).toMatchObject({ status: 'CANCELLED' });
    expect(sb.tables.journal_entries.find((j) => j.source_type === 'ODB_REVERSAL')).toMatchObject({ opening: true, entry_date: '2026-08-31' });
  });
});

describe('lock', () => {
  test('locks only when the clearing is nil, and unlocks', async () => {
    const off = harness({ clearing: [gl(1, 0, 5_000), gl(2, 7_000, 0)] });
    const refused = await call(off.app, '/opening/lock', 'POST');
    expect(refused.status).toBe(409);
    expect((await refused.json() as { message: string }).message).toContain('RM 20.00');
    const { app, sb } = harness();
    expect((await call(app, '/opening/lock', 'POST')).status).toBe(200);
    expect(sb.tables.acc_company_settings[0]).toMatchObject({ opening_locked_by: 'Chew' });
    expect((await call(app, '/opening/unlock', 'POST')).status).toBe(200);
    expect(sb.tables.acc_company_settings[0]).toMatchObject({ opening_locked_at: null });
  });
});
