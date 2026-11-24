/* The Own fleet tab (owner 2026-11-24: our lorries priced like a 3PL), on the
   real handler over fake PostgREST, made-up figures throughout:
     • a lorry's day is one trip: the orders it ran for either company (Last
       Mile's crew record, a typed plate included) and its Delivery Planning
       jobs, priced once by the own fleet card;
     • another company's orders, an outsourced lorry, a cancelled trip and an
       order that ran outside the window stay out;
     • the 3PL bill on an order that ran the same month sits beside it;
     • no card, or two whole-fleet cards, prices nothing and says which. */
import { describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../src/scm/middleware/auth', () => ({
  supabaseAuth: async (_c: unknown, next: () => Promise<void>) => { await next(); },
}));

import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { deliveryRateCards } from '../src/scm/routes/delivery-rate-cards';

const HOUZS = 1;
const OTHER = 2;
const NOT_ALLOWED = 3;

const ownCard = { id: 'card-own', company_id: HOUZS, name: 'Own fleet', carrier_company_id: null, carrier_lorry_id: null, is_own_fleet: true, basis: 'SET', aggregation: 'UNIT', rounding: 'NONE', is_active: true, created_at: '2026-11-01T00:00:00Z' };
const carrierCard = { id: 'card-3pl', company_id: HOUZS, name: 'TEST CARRIER', carrier_company_id: 'car-1', carrier_lorry_id: null, is_own_fleet: false, basis: 'SET', aggregation: 'UNIT', rounding: 'NONE', is_active: true, created_at: '2026-11-01T00:00:00Z' };
const rule = (card_id: string, rule_type: string, amount_sen: number, extra: Row = {}) => ({ id: `${card_id}-${rule_type}-${amount_sen}`, card_id, company_id: HOUZS, rule_type, amount_sen, ...extra });
/* RM 30 / 20 / 15 a set on one trip's ladder, RM 50 once into Johor, RM 25 a supplier pickup; no setup price. */
const ownRules = [
  rule('card-own', 'POSITIONAL_TIER', 3000, { tier_position: 1 }),
  rule('card-own', 'POSITIONAL_TIER', 2000, { tier_position: 2 }),
  rule('card-own', 'POSITIONAL_TIER', 1500, { tier_position: 3 }),
  rule('card-own', 'OUTSTATION', 5000, { zone: 'JOHOR' }),
  rule('card-own', 'SUPPLIER_PICKUP', 2500),
];
const carrierRules = [rule('card-3pl', 'POSITIONAL_TIER', 8000, { tier_position: 1 })];

const so = (doc_no: string, company_id: number, due: string, postcode: string, debtor: string): Row => ({
  doc_no, company_id, amended_delivery_date: null, customer_delivery_date: due, debtor_code: debtor, debtor_name: debtor,
  address1: `NO 1 JALAN ${debtor}`, address2: null, address3: null, address4: null, city: 'TEST CITY', postcode, status: 'CONFIRMED',
});
const deliveryOrder = (id: string, company_id: number, so_doc_no: string, status = 'DELIVERED'): Row => ({
  id, company_id, do_number: `TEST-${id}`, so_doc_no, status, do_date: '2026-11-09', delivered_at: '2026-11-10T03:00:00Z',
  created_at: '2026-11-09T01:00:00Z', is_dropship: false,
});
const line = (doc_no: string, company_id: number, item_group: string, qty: number): Row => ({ doc_no, company_id, item_group, qty, cancelled: false });

function harness(extra: Partial<Record<string, Row[]>> = {}) {
  const sb = fakeSb({
    lorries: [
      { id: 'lorry-own', company_id: HOUZS, plate: 'TST1234', is_internal: true },
      { id: 'lorry-out', company_id: HOUZS, plate: 'OUT5678', is_internal: false },
    ],
    trips: [
      { id: 'trip-1', company_id: HOUZS, trip_no: 'TRIP-T-001', trip_date: '2026-11-10', lorry_id: 'lorry-own', is_outsourced: false, status: 'IN_PROGRESS' },
      { id: 'trip-cx', company_id: HOUZS, trip_no: 'TRIP-T-002', trip_date: '2026-11-10', lorry_id: 'lorry-own', is_outsourced: false, status: 'CANCELLED' },
      { id: 'trip-out', company_id: HOUZS, trip_no: 'TRIP-T-003', trip_date: '2026-11-10', lorry_id: 'lorry-out', is_outsourced: true, status: 'PLANNED' },
    ],
    trip_stops: [
      { trip_id: 'trip-1', company_id: HOUZS, stop_type: 'SUPPLIER_PICKUP', do_id: null, assr_case_id: null, address: 'TEST SUPPLIER KLANG', stop_no: 1 },
      { trip_id: 'trip-1', company_id: HOUZS, stop_type: 'SETUP', do_id: null, assr_case_id: null, address: 'TEST HALL', stop_no: 2 },
      { trip_id: 'trip-cx', company_id: HOUZS, stop_type: 'TRANSFER', do_id: null, assr_case_id: null, address: 'TEST WAREHOUSE', stop_no: 1 },
      { trip_id: 'trip-out', company_id: HOUZS, stop_type: 'PICKUP', do_id: null, assr_case_id: null, address: 'TEST HOME', stop_no: 1 },
    ],
    mfg_sales_orders: [
      so('SO-A', HOUZS, '2026-11-10', '50000', 'CUST-A'),
      so('SO-B', OTHER, '2026-11-10', '81100', 'CUST-B'),
      so('SO-C', HOUZS, '2026-11-12', '50000', 'CUST-C'),
      so('SO-D', NOT_ALLOWED, '2026-11-10', '50000', 'CUST-D'),
      so('SO-E', HOUZS, '2026-12-05', '50000', 'CUST-E'),
    ],
    delivery_orders: [
      deliveryOrder('do-a', HOUZS, 'SO-A'),
      deliveryOrder('do-b', OTHER, 'SO-B'),
      deliveryOrder('do-c', HOUZS, 'SO-C'),
      deliveryOrder('do-d', NOT_ALLOWED, 'SO-D'),
      { ...deliveryOrder('do-e', HOUZS, 'SO-E', 'IN_TRANSIT'), do_date: '2026-11-20', delivered_at: null },
    ],
    delivery_order_crew: [
      { do_id: 'do-a', company_id: HOUZS, lorry_id: 'lorry-own', lorry_plate: 'TST1234' },
      { do_id: 'do-b', company_id: OTHER, lorry_id: null, lorry_plate: 'tst 1234' },
      { do_id: 'do-c', company_id: HOUZS, lorry_id: 'lorry-out', lorry_plate: 'OUT5678' },
      { do_id: 'do-d', company_id: NOT_ALLOWED, lorry_id: 'lorry-own', lorry_plate: 'TST1234' },
      { do_id: 'do-e', company_id: HOUZS, lorry_id: 'lorry-own', lorry_plate: 'TST1234' },
    ],
    threepl_do_charges: [{ id: 'ch-1', do_id: 'do-c', company_id: HOUZS, threepl_company_id: 'car-1', billed_sen: 9000 }],
    mfg_sales_order_items: [
      line('SO-A', HOUZS, 'BEDFRAME', 2), line('SO-A', HOUZS, 'MATTRESS', 2),
      line('SO-B', OTHER, 'BEDFRAME', 1), line('SO-B', OTHER, 'MATTRESS', 1),
      line('SO-C', HOUZS, 'BEDFRAME', 1), line('SO-C', HOUZS, 'MATTRESS', 1),
      line('SO-D', NOT_ALLOWED, 'BEDFRAME', 5),
    ],
    delivery_rate_cards: [ownCard, carrierCard],
    delivery_rate_rules: [...ownRules, ...carrierRules],
    delivery_rate_areas: [],
    delivery_zone_postcodes: [],
    delivery_places: [],
    delivery_order_items: [],
    ...extra,
  });
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, HOUZS as never);
    c.set('allowedCompanyIds' as never, [HOUZS, OTHER] as never);
    c.set('companies' as never, [{ id: HOUZS, code: 'HOUZS' }, { id: OTHER, code: '2990' }] as never);
    await next();
  });
  app.route('/delivery-rate-cards', deliveryRateCards as unknown as Hono);
  return (path: string) => app.request(path, { method: 'GET' }, {});
}

type Body = {
  card: { id: string; name: string } | null;
  severalCards: Array<{ id: string; name: string }>;
  runs: Array<{
    runDate: string; plate: string; tripNos: string[]; dos: Array<{ doId: string; companyCode: string | null }>;
    setCount: number; zones: string[]; jobs: Record<string, number>; cardName: string | null; costSen: number | null; otherJobsSen: number | null;
    lines: Array<{ label: string; amountSen: number }>;
  }>;
  months: Array<Record<string, number | string>>;
};
const read = async (get: ReturnType<typeof harness>, q = '?from=2026-11-01&to=2026-11-30') => {
  const res = await get(`/delivery-rate-cards/own-fleet${q}`);
  return { status: res.status, body: (await res.json()) as Body };
};

describe('our own lorries priced like a 3PL', () => {
  test("a lorry's day is one trip: both companies' orders and its Delivery Planning jobs, priced once", async () => {
    const { status, body } = await read(harness());
    expect(status).toBe(200);
    expect(body.card).toEqual({ id: 'card-own', name: 'Own fleet' });
    expect(body.runs).toHaveLength(1);
    const [run] = body.runs;
    expect(run).toMatchObject({ runDate: '2026-11-10', plate: 'TST1234', tripNos: ['TRIP-T-001'], setCount: 3, zones: ['KL', 'JOHOR'], jobs: { SUPPLIER_PICKUP: 1, SETUP: 1 }, cardName: 'Own fleet' });
    expect(run!.dos.map((d) => [d.doId, d.companyCode])).toEqual([['do-a', 'HOUZS'], ['do-b', '2990']]);
    // 3 sets: 30 + 20 + 15; Johor once: 50; a supplier pickup: 25; the setup has no price on this card.
    expect(run!.costSen).toBe(3000 + 2000 + 1500 + 5000 + 2500);
    expect(run!.otherJobsSen).toBe(2500);
    expect(run!.lines.map((l) => l.amountSen)).toEqual([3000, 2000, 1500, 5000, 2500]);
  });

  test("another company's orders, an outsourced lorry, a cancelled trip and a later run stay out", async () => {
    const { body } = await read(harness());
    const doIds = body.runs.flatMap((r) => r.dos.map((d) => d.doId));
    expect(doIds).not.toContain('do-d');
    expect(doIds).not.toContain('do-c');
    expect(doIds).not.toContain('do-e');
    expect(body.runs.flatMap((r) => r.tripNos)).toEqual(['TRIP-T-001']);
  });

  test('the 3PL bill on an order that ran the same month sits beside it', async () => {
    const { body } = await read(harness());
    expect(body.months).toEqual([expect.objectContaining({
      month: '2026-11', trips: 1, dos: 2, sets: 3, pricedTrips: 1, pricedDos: 2, costSen: 14000, deliveryCostSen: 11500,
      threePlDos: 1, threePlSets: 1, threePlBilledSen: 9000, threePlPricedDos: 1, threePlBilledPricedSen: 9000, threePlCardSen: 8000,
    })]);
  });

  test("a lorry's own card prices that lorry ahead of the fleet card", async () => {
    const lorryCard = { ...ownCard, id: 'card-lorry', name: 'TST1234 card', carrier_lorry_id: 'lorry-own' };
    const { body } = await read(harness({
      delivery_rate_cards: [ownCard, lorryCard, carrierCard],
      delivery_rate_rules: [...ownRules, ...carrierRules, rule('card-lorry', 'POSITIONAL_TIER', 1000, { tier_position: 1 })],
    }));
    expect(body.runs[0]).toMatchObject({ cardName: 'TST1234 card', costSen: 3000 });
  });
});

describe('when nothing can price the trips', () => {
  test('no own fleet card: the trips are listed, with no cost', async () => {
    const { body } = await read(harness({ delivery_rate_cards: [carrierCard], delivery_rate_rules: carrierRules }));
    expect(body.card).toBeNull();
    expect(body.runs[0]).toMatchObject({ dos: [expect.anything(), expect.anything()], costSen: null, cardName: null, lines: [] });
    expect(body.months[0]).toMatchObject({ trips: 1, pricedTrips: 0, costSen: 0, threePlBilledSen: 9000 });
  });

  test('an inactive own fleet card prices nothing', async () => {
    const { body } = await read(harness({ delivery_rate_cards: [{ ...ownCard, is_active: false }, carrierCard] }));
    expect(body.card).toBeNull();
    expect(body.runs[0]!.costSen).toBeNull();
  });

  test('two whole-fleet cards active: neither prices, and both are named', async () => {
    const second = { ...ownCard, id: 'card-own-2', name: 'Own fleet copy' };
    const { body } = await read(harness({ delivery_rate_cards: [ownCard, second, carrierCard] }));
    expect(body.card).toBeNull();
    expect(body.severalCards.map((x) => x.name)).toEqual(['Own fleet', 'Own fleet copy']);
    expect(body.runs[0]!.costSen).toBeNull();
  });

  test('a window it cannot read is refused with the reason', async () => {
    const get = harness();
    expect((await read(get, '?from=2026-11-30&to=2026-11-01')).status).toBe(400);
    const { status, body } = await read(get, '?from=2026-01-01&to=2026-12-31');
    expect(status).toBe(400);
    expect((body as unknown as { reason: string }).reason).toMatch(/at most 186 days/);
  });
});
