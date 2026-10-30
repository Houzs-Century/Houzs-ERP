/* The Logistics P&L through its handlers, over the fake-PostgREST harness (owner
   2026-10-29, 做 — his Logistic Cost Report from the books, nothing typed).
   The arithmetic is scm/lib/logistics-pnl.test.ts; pinned here:
     • the reads: this company's DOs by region; the ledger on the P&L's accounts,
       a reversed pair and the opening left out, upkeep from months back when
       Finance spread it; Other Debtor bills a recharge billed the month after;
       the fairs and what was outsourced on them;
     • without the fairs' connection the report says so, and prices no trip;
     • Finance's four settings: the money right only, checked, saved, undone. */

import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import {
  logisticsPnlHandler, saveAreaRateHandler, saveIncomeRateHandler, saveSpreadHandler, saveTripMarkHandler,
} from '../src/scm/routes/acc-logistics-pnl';

const CO = 1;
type Res = { body: Record<string, any>; status: number };
const fakeDb = (rows: Row[]) => ({ prepare: () => ({ bind: () => ({ all: async () => ({ results: rows }) }) }) });
const ctx = (sb: unknown, { query = {}, body, perms = ['scm.payment_voucher.post'], db }: { query?: Record<string, string>; body?: unknown; perms?: string[]; db?: unknown } = {}) => ({
  env: db ? { DB: db } : {},
  req: { query: (k: string) => query[k], json: async () => body, path: '/api/scm/acc-events/logistics/pnl' },
  get: (k: string) => (k === 'companyId' ? CO : k === 'supabase' ? sb : k === 'houzsUser' ? { id: 7, name: 'Finance Chew', permissions_set: perms } : undefined),
  json: (b: Record<string, any>, status = 200): Res => ({ body: b, status }),
});
const run = async (h: (c: any) => Promise<unknown>, c: unknown) => (await h(c)) as unknown as Res;

const chart = (account_code: string, account_name: string, account_type = 'EXPENSE', extra: Row = {}): Row =>
  ({ company_id: CO, account_code, account_name, account_type, is_active: true, ...extra });
const leg = (o: Partial<Row>): Row => ({
  company_id: CO, account_name: null, entry_date: '2026-09-15', debit_sen: 0, credit_sen: 0, posted: true, reversed: false,
  reversed_by_je: null, opening: false, notes: null, je_no: 'JE-1', ...o,
});

const world = (over: Record<string, Row[]> = {}) => fakeSb({
  accounts: [
    chart('900-T005', 'TRANSPORT (PNG, PERLIS, KEDAH, KELATAN, TERENGGANU, PAHANG)', 'EXPENSE', { logistics_row: 'outsource_pg' }),
    chart('900-T027', 'TRANSPORT SGD - SST 9%', 'EXPENSE', { logistics_row: 'outsource_sg' }),
    chart('900-T031', 'TRANSPORT FAIR (KL, SLG, MLK, JHR, OTHERS)', 'EXPENSE', { pms_row: 'transport_setup_dismantle' }),
    chart('900-P015', 'PETROL, TOL AND PARKING - LORI VRH 9058', 'EXPENSE', { logistics_row: 'petrol' }),
    chart('900-U010', 'UPKEEP OF LORI - VPC 9058', 'EXPENSE', { logistics_row: 'upkeep' }),
    chart('900-I002', 'INSURANCE & ROAD TAX', 'EXPENSE', { logistics_row: 'roadtax' }),
    chart('900-S100', 'STAFF SALARIES & OVERTIME'),
    chart('450-H003', 'HP CREDITOR- VPC 9058', 'LIABILITY', { logistics_row: 'instalment' }),
    chart('590-0004', 'TRANSPORT INCOME (SGD)', 'INCOME', { logistics_row: 'income_sg' }),
    chart('599-0000', 'ADDITIONAL INCOME', 'INCOME'),
  ],
  lorries: [{ id: 'L1', company_id: CO, plate: 'VRH9058', is_internal: true }, { id: 'L2', company_id: CO, plate: 'VPC9058', is_internal: true }],
  acc_logistics_settings: [],
  acc_logistics_area_rates: [{ company_id: CO, area: 'johor', rate_sen: 120_000 }],
  acc_logistics_spreads: [{ company_id: CO, line_id: 'g-u1', months: 3 }],
  acc_logistics_trip_marks: [{ company_id: CO, trip_key: 'setup|PWCC|2026-09-25', in_house: false }],
  delivery_orders: [
    { id: 'd1', company_id: CO, do_number: 'HC-DO-1', so_doc_no: null, status: 'LOADED', state: 'Selangor', do_date: '2026-09-10', customer_delivery_date: null },
    { id: 'd2', company_id: CO, do_number: 'HC-DO-2', so_doc_no: null, status: 'LOADED', state: 'Penang', do_date: '2026-09-12', customer_delivery_date: null },
    { id: 'd3', company_id: CO, do_number: 'HC-DO-3', so_doc_no: null, status: 'CANCELLED', state: 'Selangor', do_date: '2026-09-12', customer_delivery_date: null },
  ],
  delivery_order_crew: [{ do_id: 'd1', company_id: CO, lorry_id: 'L1', lorry_plate: 'VRH9058' }],
  delivery_order_items: [
    { id: 'i1', delivery_order_id: 'd1', company_id: CO, line_total_sen: 1_000_000 },
    { id: 'i2', delivery_order_id: 'd2', company_id: CO, line_total_sen: 500_000 },
  ],
  threepl_do_charges: [],
  mfg_sales_orders: [],
  v_gl_entries: [
    leg({ line_id: 'g1', account_code: '900-T005', debit_sen: 1_597_000 }),
    leg({ line_id: 'g2', account_code: '900-T027', debit_sen: 507_233 }),
    leg({ line_id: 'g3', account_code: '900-P015', debit_sen: 814_726 }),
    leg({ line_id: 'g4', account_code: '900-P015', debit_sen: 5_000, reversed: true }),           // undone by its contra —
    leg({ line_id: 'g5', account_code: '900-P015', credit_sen: 5_000, reversed_by_je: 'JE-9' }),  // the pair counts nowhere
    leg({ line_id: 'g-u1', account_code: '900-U010', debit_sen: 300_000, entry_date: '2026-08-20' }), // spread over 3: Sep gets 1,000
    leg({ line_id: 'g-u2', account_code: '900-U010', debit_sen: 116_200, entry_date: '2026-09-10' }),
    leg({ line_id: 'g-i1', account_code: '900-I002', debit_sen: 444_275, entry_date: '2026-09-30' }),  // 12 months: Sep gets 370.23
    leg({ line_id: 'g6', account_code: '450-H003', debit_sen: 318_000 }),
    leg({ line_id: 'g7', account_code: '900-S100', debit_sen: 2_230_969, notes: "OPERATION DELIVERY SALARY - SEPT'26" }),
    leg({ line_id: 'g8', account_code: '900-S100', debit_sen: 965_408, notes: "FINANCE - SALARY - SEP'26" }),
    leg({ line_id: 'g9', account_code: '900-P015', debit_sen: 777, opening: true, entry_date: '2026-09-01' }),
  ],
  acc_debtors: [{ id: 'dt1', name: '2990 Home Sdn Bhd' }, { id: 'dt2', name: 'SG PARTNER PTE LTD' }],
  acc_debtor_bills: [
    { id: 'b1', company_id: CO, bill_number: 'HC-ODB-2610-001', bill_date: '2026-10-23', status: 'POSTED', debtor_id: 'dt1' },
    { id: 'b2', company_id: CO, bill_number: 'HC-ODB-2609-009', bill_date: '2026-09-29', status: 'POSTED', debtor_id: 'dt2' },
    { id: 'b3', company_id: CO, bill_number: 'HC-ODB-2609-010', bill_date: '2026-09-30', status: 'CANCELLED', debtor_id: 'dt2' },
  ],
  acc_debtor_bill_lines: [
    { id: 'bl1', company_id: CO, bill_id: 'b1', line_no: 1, description: "OPERATION CHARGES - SEP'26", credit_account_code: '599-0000', amount_sen: 740_350 },
    { id: 'bl2', company_id: CO, bill_id: 'b1', line_no: 2, description: "LOGISTICS CHARGES - SEP'26", credit_account_code: '599-0000', amount_sen: 444_210 },
    { id: 'bl3', company_id: CO, bill_id: 'b2', line_no: 1, description: 'DELIVERY TO PUNGGOL', credit_account_code: '590-0004', amount_sen: 91_180 },
    { id: 'bl4', company_id: CO, bill_id: 'b3', line_no: 1, description: 'DELIVERY TO PUNGGOL', credit_account_code: '590-0004', amount_sen: 50_000 },
  ],
  threepl_bill_lines: [
    { id: 't1', company_id: CO, project_id: 12, assign: 'event', kind: 'dismantle', text: 'Dismantle Mid Valley' },
  ],
  ap_invoice_lines: [
    { id: 'a1', company_id: CO, invoice_id: 'inv1', project_id: 13, debit_account_code: '900-T031', description: 'TRANSPORT FEE FOR EVENT SETUP - SETUP EVENT MVEC' },
  ],
  ap_invoices: [{ id: 'inv1', company_id: CO, status: 'POSTED' }],
  payment_voucher_lines: [],
  payment_vouchers: [],
  ...over,
});
const fairs: Row[] = [
  { id: 12, code: 'MV', name: '[AKEMI] REX @ MID VALLEY', state: 'Kuala Lumpur', venue: 'Mid Valley', startdate: '2026-09-11', enddate: '2026-09-14' },
  { id: 13, code: 'MVEC', name: '[AKEMI] MLE @ MVEC', state: 'JOHOR', venue: 'MVEC', startdate: '2026-09-18', enddate: '2026-09-21' },
  { id: 14, code: 'PWCC', name: '[AKEMI] MLE @ PWCC', state: 'PULAU PINANG', venue: 'PWCC', startdate: '2026-09-25', enddate: '2026-09-28' },
];
const SEP = { from: '2026-09-01', to: '2026-09-30' };

describe('GET /acc-events/logistics/pnl', () => {
  test("September from the books: income, outsource by region, in-house in KL, the trips and spreads it counted", async () => {
    const res = await run(logisticsPnlHandler, ctx(world(), { query: SEP, db: fakeDb(fairs) }));
    expect(res.status).toBe(200);
    const b = res.body;
    const row = (k: string) => b.rows.find((r: any) => r.key === k);
    expect(b.dos).toEqual({ PG: 1, KL: 1, EM: 0, SG: 0, total: 2 });
    expect(row('do_income').sen).toEqual({ PG: 15_000, KL: 30_000, EM: 0, SG: 0 });
    expect(row('ti_2990').sen.KL).toBe(444_210);
    expect(row('ti_houzs').sen.SG).toBe(91_180);
    expect(b.income.map((l: any) => [l.billNo, l.month, l.row, l.region])).toEqual([
      ['HC-ODB-2609-009', '2026-09', 'houzs', 'SG'],
      ['HC-ODB-2610-001', '2026-09', '2990', 'KL'],
    ]);
    // Mid Valley set up (KL rate 400) — its dismantle outsourced; MVEC dismantle at Johor's own 1,200 — its setup outsourced;
    // PWCC setup unticked by Finance, its dismantle at Penang's 600.
    expect(b.trips.map((t: any) => [t.kind, t.areaLabel, t.inHouse, t.amountSen])).toEqual([
      ['setup', 'Kuala Lumpur', true, 40_000],
      ['dismantle', 'Kuala Lumpur', false, 0],
      ['setup', 'Johor', false, 0],
      ['dismantle', 'Johor', true, 120_000],
      ['setup', 'Penang', false, 0],
      ['dismantle', 'Penang', true, 60_000],
    ]);
    expect(row('sd_income').sen).toEqual({ PG: 60_000, KL: 160_000, EM: 0, SG: 0 });
    expect(row('outsource').sen).toEqual({ PG: 1_597_000, KL: 0, EM: 0, SG: 507_233 });
    expect(row('petrol').sen.KL).toBe(814_726);
    expect(row('upkeep').sen.KL).toBe(100_000 + 116_200);
    expect(row('roadtax').sen.KL).toBe(37_023);
    expect(row('instalment').sen.KL).toBe(318_000);
    expect(row('manpower').sen.KL).toBe(2_230_969);
    expect(b.spreads.map((s: any) => [s.lineId, s.months, s.isDefault])).toEqual([['g-u1', 3, false], ['g-u2', 1, true], ['g-i1', 12, true]]);
    expect(b.ownTrips).toBe(1);
    expect(b.tripsProblem).toBeNull();
    expect(b.areaRates.find((a: any) => a.key === 'johor')).toMatchObject({ rateSen: 120_000, isDefault: false });
    expect(b.areaRates.find((a: any) => a.key === 'sarawak')).toMatchObject({ rateSen: null, isDefault: true });
  });

  test('without the fairs, it says so and prices no trip', async () => {
    const res = await run(logisticsPnlHandler, ctx(world(), { query: SEP }));
    expect(res.status).toBe(200);
    expect(res.body.tripsProblem).toBe('the fairs are not reachable from here');
    expect(res.body.trips).toEqual([]);
    expect(res.body.rows.find((r: any) => r.key === 'sd_income').totalSen).toBe(0);
  });

  test('a From after the To is refused', async () => {
    const res = await run(logisticsPnlHandler, ctx(world(), { query: { from: '2026-09-30', to: '2026-09-01' } }));
    expect(res.status).toBe(400);
  });
});

describe("Finance's settings", () => {
  test('the share of the DOs counted as income: the money right only, 0–100, read back in the label', async () => {
    const sb = world();
    expect((await run(saveIncomeRateHandler, ctx(sb, { body: { pct: 2.5 }, perms: [] }))).status).toBe(403);
    expect((await run(saveIncomeRateHandler, ctx(sb, { body: { pct: 101 } }))).status).toBe(400);
    expect((await run(saveIncomeRateHandler, ctx(sb, { body: { pct: 2.555 } }))).status).toBe(400);
    const ok = await run(saveIncomeRateHandler, ctx(sb, { body: { pct: 2.5 } }));
    expect(ok.body).toEqual({ ok: true, doIncomeBp: 250 });
    expect(sb.tables.acc_logistics_settings).toEqual([expect.objectContaining({ company_id: CO, do_income_bp: 250, updated_by: 'Finance Chew' })]);
    const pnl = await run(logisticsPnlHandler, ctx(sb, { query: SEP }));
    expect(pnl.body.rows.find((r: any) => r.key === 'do_income').label).toBe('Transport Income (2.5% of DO)');
  });

  test('an area rate: a known area only; a rate, no rate, or the default again', async () => {
    const sb = world();
    expect((await run(saveAreaRateHandler, ctx(sb, { body: { area: 'atlantis', rateRm: 400 } }))).status).toBe(400);
    expect((await run(saveAreaRateHandler, ctx(sb, { body: { area: 'selangor', rateRm: -1 } }))).status).toBe(400);
    expect((await run(saveAreaRateHandler, ctx(sb, { body: { area: 'selangor', rateRm: 450 } }))).body).toEqual({ ok: true, area: 'selangor', rateSen: 45_000, isDefault: false });
    expect((await run(saveAreaRateHandler, ctx(sb, { body: { area: 'perak', rateRm: null } }))).body.rateSen).toBeNull();
    expect(sb.tables.acc_logistics_area_rates.map((r) => [r.area, r.rate_sen])).toEqual([['johor', 120_000], ['selangor', 45_000], ['perak', null]]);
    expect((await run(saveAreaRateHandler, ctx(sb, { body: { area: 'johor', reset: true } }))).body).toEqual({ ok: true, area: 'johor', rateSen: 60_000, isDefault: true });
    expect(sb.tables.acc_logistics_area_rates.map((r) => r.area)).toEqual(['selangor', 'perak']);
  });

  test("a bill's spread: a line of this company's books, 1–36 months, or its default again", async () => {
    const sb = world();
    expect((await run(saveSpreadHandler, ctx(sb, { body: { lineId: 'nope', months: 3 } }))).status).toBe(404);
    expect((await run(saveSpreadHandler, ctx(sb, { body: { lineId: 'g-u2', months: 0 } }))).status).toBe(400);
    expect((await run(saveSpreadHandler, ctx(sb, { body: { lineId: 'g-u2', months: 6 } }))).body).toEqual({ ok: true, lineId: 'g-u2', months: 6 });
    expect((await run(saveSpreadHandler, ctx(sb, { body: { lineId: 'g-u1', months: null } }))).body).toEqual({ ok: true, lineId: 'g-u1', months: null });
    expect(sb.tables.acc_logistics_spreads.map((r) => [r.line_id, r.months])).toEqual([['g-u2', 6]]);
  });

  test('a trip ticked, unticked, or back to the rule', async () => {
    const sb = world();
    expect((await run(saveTripMarkHandler, ctx(sb, { body: { tripKey: 'lunch|MV|2026-09-11', inHouse: true } }))).status).toBe(400);
    expect((await run(saveTripMarkHandler, ctx(sb, { body: { tripKey: 'dismantle|MIDVALLEY|2026-09-14', inHouse: 'yes' } }))).status).toBe(400);
    expect((await run(saveTripMarkHandler, ctx(sb, { body: { tripKey: 'dismantle|MIDVALLEY|2026-09-14', inHouse: true } }))).body.inHouse).toBe(true);
    expect((await run(saveTripMarkHandler, ctx(sb, { body: { tripKey: 'setup|PWCC|2026-09-25', inHouse: null } }))).body.inHouse).toBeNull();
    expect(sb.tables.acc_logistics_trip_marks.map((r) => [r.trip_key, r.in_house])).toEqual([['dismantle|MIDVALLEY|2026-09-14', true]]);
    const pnl = await run(logisticsPnlHandler, ctx(sb, { query: SEP, db: fakeDb(fairs) }));
    expect(pnl.body.trips.find((t: any) => t.key === 'dismantle|MIDVALLEY|2026-09-14')).toMatchObject({ outsourced: true, mark: true, inHouse: true, amountSen: 40_000 });
  });
});
