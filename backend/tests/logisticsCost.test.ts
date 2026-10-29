/* The Logistics cost report through its handlers, over the fake-PostgREST
   harness (owner 2026-10-29: 物流报告 —「都需要」; our lorries OVERALL —「trip
   除成本」). The arithmetic is scm/lib/logistics-cost.test.ts; pinned here:
     • the reads: this company's DOs (not cancelled, not another company's) of
       the whole months, by the scheduled customer delivery date, else the DO's
       own; their crews, lines and 3PL charges, in the four regions of the
       books (a Singapore address by its words); the carriers' bill lines; what the ticked accounts booked — a reversed pair and the opening
       left out;
     • the cost accounts: the chart's default until Finance ticks a list; only
       an active expense account may be ticked, only with the money right; an
       empty list goes back to the default;
     • the fairs' books need the event connection — without it the report says
       so instead of showing nothing as if nothing was spent. */

import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { logisticsCostHandler, logisticsSettingsHandler, saveLogisticsSettingsHandler } from '../src/scm/routes/acc-logistics';

const CO = 1;
type Res = { body: Record<string, any>; status: number };
const ctx = (sb: unknown, { query = {}, body = {}, perms = ['scm.payment_voucher.post'] }: { query?: Record<string, string>; body?: unknown; perms?: string[] } = {}) => ({
  env: {},
  req: { query: (k: string) => query[k], json: async () => body, path: '/api/scm/acc-events/logistics' },
  get: (k: string) => (k === 'companyId' ? CO : k === 'supabase' ? sb : k === 'houzsUser' ? { id: 7, name: 'Finance Chew', permissions_set: perms } : undefined),
  json: (b: Record<string, any>, status = 200): Res => ({ body: b, status }),
});
const run = async (h: (c: any) => Promise<unknown>, c: unknown) => (await h(c)) as unknown as Res;

const leg = (o: Partial<Row>): Row => ({
  company_id: CO, account_name: 'PETROL, TOL AND PARKING - LORI VRH 9058', account_code: '900-P015', entry_date: '2026-10-10',
  debit_sen: 0, credit_sen: 0, posted: true, reversed: false, reversed_by_je: null, opening: false, ...o,
});

const world = (over: Record<string, Row[]> = {}) => fakeSb({
  accounts: [
    { company_id: CO, account_code: '900-P015', account_name: 'PETROL, TOL AND PARKING - LORI VRH 9058', account_type: 'EXPENSE', is_active: true },
    { company_id: CO, account_code: '900-U010', account_name: 'UPKEEP OF LORI - VPC 9058', account_type: 'EXPENSE', is_active: true },
    { company_id: CO, account_code: '900-P008', account_name: 'PETROL, TOL AND PARKING - DIRECTOR & OTHERS', account_type: 'EXPENSE', is_active: true },
    { company_id: CO, account_code: '900-S100', account_name: 'STAFF SALARIES & OVERTIME', account_type: 'EXPENSE', is_active: true },
    { company_id: CO, account_code: '207-1000', account_name: 'MOTOR VEHICLE', account_type: 'ASSET', is_active: true },
  ],
  lorries: [
    { id: 'L1', company_id: CO, plate: 'VRH9058', is_internal: true },
    { id: 'L3', company_id: CO, plate: 'W1591T', is_internal: false },
  ],
  acc_logistics_settings: [],
  delivery_orders: [
    { id: 'd1', company_id: CO, do_number: 'HC-DO-2610-001', so_doc_no: 'HC-SO-1', status: 'LOADED', state: 'Selangor', do_date: '2026-09-28', customer_delivery_date: '2026-10-05' },
    { id: 'd2', company_id: CO, do_number: 'HC-DO-2610-002', so_doc_no: 'HC-SO-2', status: 'LOADED', state: 'Penang', do_date: '2026-10-06', customer_delivery_date: null },
    { id: 'd3', company_id: CO, do_number: 'HC-DO-2610-003', so_doc_no: 'HC-SO-3', status: 'CANCELLED', state: 'Selangor', do_date: '2026-10-07', customer_delivery_date: '2026-10-07' },
    { id: 'd4', company_id: 2, do_number: '2990-DO-2610-001', so_doc_no: '2990-SO-1', status: 'LOADED', state: 'Selangor', do_date: '2026-10-07', customer_delivery_date: '2026-10-07' },
  ],
  delivery_order_crew: [
    { do_id: 'd1', company_id: CO, lorry_id: 'L1', lorry_plate: 'VRH9058' },
    { do_id: 'd2', company_id: CO, lorry_id: null, lorry_plate: 'W 1591 T' },
  ],
  delivery_order_items: [
    { id: 'i1', delivery_order_id: 'd1', company_id: CO, line_total_sen: 70_000 },
    { id: 'i2', delivery_order_id: 'd1', company_id: CO, line_total_sen: 30_000 },
    { id: 'i3', delivery_order_id: 'd2', company_id: CO, line_total_sen: 20_000 },
  ],
  threepl_do_charges: [{ id: 'c1', company_id: CO, do_id: 'd2', billed_sen: 30_000 }],
  threepl_bill_lines: [
    { id: 'b1', company_id: CO, ap_invoice_id: 'a1', threepl_company_id: 't1', line_date: null, amount_sen: 30_000, do_ids: ['d2'], text: 'TRANSPORT TO PENANG', assign: 'do', project_id: null },
    { id: 'b2', company_id: CO, ap_invoice_id: 'a1', threepl_company_id: 't1', line_date: null, amount_sen: 5_000, do_ids: [], text: 'HANDLING', assign: null, project_id: null },
    { id: 'b3', company_id: CO, ap_invoice_id: 'a1', threepl_company_id: 't1', line_date: null, amount_sen: 2_000, do_ids: [], text: 'SETUP KLCC', assign: 'event', project_id: null },
  ],
  ap_invoices: [{ id: 'a1', company_id: CO, invoice_number: 'HC-API-2610-009', invoice_date: '2026-10-20' }],
  threepl_companies: [{ id: 't1', company_id: CO, name: 'MSJ TRANSPORT SERVICE' }],
  v_gl_entries: [
    leg({ line_id: 1, debit_sen: 60_000 }),
    leg({ line_id: 2, debit_sen: 5_000, reversed: true }),                          // undone by its contra —
    leg({ line_id: 3, credit_sen: 5_000, reversed_by_je: 'JE-1' }),                 // the pair counts nowhere
    leg({ line_id: 4, debit_sen: 777, opening: true, entry_date: '2026-10-01' }),   // never the opening
    leg({ line_id: 5, account_code: '900-P008', account_name: 'PETROL, TOL AND PARKING - DIRECTOR & OTHERS', debit_sen: 9_999 }),
    leg({ line_id: 6, account_code: '900-S100', account_name: 'STAFF SALARIES & OVERTIME', debit_sen: 400_000 }),
  ],
  ...over,
});

describe('GET /acc-events/logistics', () => {
  test('this company\'s DOs of the month, our trip\'s cost from the default accounts, the 3PL run and charge', async () => {
    const res = await run(logisticsCostHandler, ctx(world(), { query: { from: '2026-10-01', to: '2026-10-31' } }));
    expect(res.status).toBe(200);
    const b = res.body;
    expect(b.ownCostDefault).toBe(true);
    expect(b.ownCostAccounts).toEqual(['900-P015', '900-U010']);
    expect(b.months).toEqual([{ month: '2026-10', ownCostSen: 60_000, trips: 1, perTripSen: 60_000, accounts: [{ code: '900-P015', name: 'PETROL, TOL AND PARKING - LORI VRH 9058', sen: 60_000 }] }]);
    expect(b.regions.map(({ covers: _c, ...x }: any) => x)).toEqual([
      { code: 'PG', name: 'Penang', dos: 1, valueSen: 20_000, ownSen: 0, threeplSen: 30_000, totalSen: 30_000 },
      { code: 'KL', name: 'KL', dos: 1, valueSen: 100_000, ownSen: 60_000, threeplSen: 0, totalSen: 60_000 },
      { code: 'EM', name: 'SBH & SWK', dos: 0, valueSen: 0, ownSen: 0, threeplSen: 0, totalSen: 0 },
      { code: 'SG', name: 'SGD', dos: 0, valueSen: 0, ownSen: 0, threeplSen: 0, totalSen: 0 },
    ]);
    expect(b.trips.map((t: any) => [t.kind, t.day, t.who, t.ref, t.amountSen])).toEqual([
      ['own', '2026-10-05', 'VRH9058', null, 60_000],
      ['3pl', '2026-10-06', 'MSJ TRANSPORT SERVICE', 'HC-API-2610-009', 30_000],
    ]);
    expect(b.gaps).toMatchObject({ dosNoDeliverer: 0, dosOutsideNoBill: 0, openLines: { count: 1, sen: 5_000 }, eventLinesNoFair: { count: 1, sen: 2_000 } });
    expect(b.eventsProblem).toBe('the event books are not reachable from here');
  });

  test("a Singapore order keyed with no state is SGD by its order's address lines; one saying nothing is KL's others", async () => {
    const sb = world({
      delivery_orders: [
        { id: 'd5', company_id: CO, do_number: 'HC-DO-2609-152', so_doc_no: 'HC-SO-5', status: 'LOADED', state: null, address1: 'BLK 511 woodlands Dr14', address2: '#08-51', do_date: '2026-10-08', customer_delivery_date: null },
        { id: 'd6', company_id: CO, do_number: 'HC-DO-2609-017', so_doc_no: 'HC-SO-6', status: 'LOADED', state: null, address1: 'self pick up', address2: '00000 Tbc', do_date: '2026-10-09', customer_delivery_date: null },
      ],
      mfg_sales_orders: [
        { company_id: CO, doc_no: 'HC-SO-5', address1: 'BLK 511 woodlands Dr14', address2: '#08-51', address3: '730511 SINGAPORE', address4: null },
        { company_id: CO, doc_no: 'HC-SO-6', address1: 'self pick up', address2: '00000 Tbc', address3: null, address4: null },
      ],
    });
    const res = await run(logisticsCostHandler, ctx(sb, { query: { from: '2026-10-01', to: '2026-10-31' } }));
    expect(res.status).toBe(200);
    expect(res.body.regions.map((g: any) => [g.code, g.dos])).toEqual([['PG', 0], ['KL', 1], ['EM', 0], ['SG', 1]]);
    expect(res.body.gaps.dosNoState).toBe(1);
  });

  test('a From after the To is refused', async () => {
    const res = await run(logisticsCostHandler, ctx(world(), { query: { from: '2026-10-31', to: '2026-10-01' } }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('bad_range');
  });

  test("the company's own tick list replaces the default — a driver salary account counts once ticked", async () => {
    const res = await run(logisticsCostHandler, ctx(world({ acc_logistics_settings: [{ company_id: CO, own_cost_accounts: ['900-P015', '900-S100'] }] }), { query: { from: '2026-10-01', to: '2026-10-31' } }));
    expect(res.body.ownCostDefault).toBe(false);
    expect(res.body.months[0]).toMatchObject({ ownCostSen: 460_000, trips: 1, perTripSen: 460_000 });
  });
});

describe('the cost accounts', () => {
  test('GET: the default, the tick list (none yet) and every active expense account to choose from', async () => {
    const res = await run(logisticsSettingsHandler, ctx(world()));
    expect(res.status).toBe(200);
    expect(res.body.picked).toBeNull();
    expect(res.body.defaults).toEqual(['900-P015', '900-U010']);
    expect(res.body.candidates.map((x: any) => x.code)).toEqual(['900-P008', '900-P015', '900-S100', '900-U010']);
  });

  test('PUT: active expense accounts only, the money right only; an empty list is the default again', async () => {
    const sb = world();
    const noRight = await run(saveLogisticsSettingsHandler, ctx(sb, { body: { accounts: ['900-P015'] }, perms: [] }));
    expect(noRight.status).toBe(403);
    const asset = await run(saveLogisticsSettingsHandler, ctx(sb, { body: { accounts: ['900-P015', '207-1000'] } }));
    expect(asset.status).toBe(400);
    expect(asset.body.message).toContain('207-1000');
    const ok = await run(saveLogisticsSettingsHandler, ctx(sb, { body: { accounts: ['900-S100', '900-P015', '900-P015'] } }));
    expect(ok.body).toEqual({ ok: true, picked: ['900-P015', '900-S100'] });
    expect(sb.tables.acc_logistics_settings).toEqual([expect.objectContaining({ company_id: CO, own_cost_accounts: ['900-P015', '900-S100'], updated_by: 'Finance Chew' })]);
    expect((await run(logisticsSettingsHandler, ctx(sb))).body.picked).toEqual(['900-P015', '900-S100']);
    const back = await run(saveLogisticsSettingsHandler, ctx(sb, { body: { accounts: null } }));
    expect(back.body).toEqual({ ok: true, picked: null });
    expect((await run(logisticsSettingsHandler, ctx(sb))).body.picked).toBeNull();
  });
});
