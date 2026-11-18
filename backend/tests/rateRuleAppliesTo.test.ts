/* Outstation Applies to, and every job on a trip (owner 2026-11-18: "the rate
   card is bound to all my jobs"), on the real handlers over fake PostgREST:
     • an outstation price keeps the jobs it applies to in params.appliesTo, in
       DP order, and reads back its default (Delivery order) when it names none;
     • only an outstation price takes the setting;
     • the Price check prices the job it names, the surcharge only where it applies;
     • the trip reconciliation counts a trip's setup and ASSR stops. */
import { describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../src/scm/middleware/auth', () => ({
  supabaseAuth: async (_c: unknown, next: () => Promise<void>) => { await next(); },
}));

import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { deliveryRateCards } from '../src/scm/routes/delivery-rate-cards';

const CO = 1;
const CARD = 'card-carrier';

function harness() {
  const sb = fakeSb({
    delivery_rate_cards: [
      { id: CARD, company_id: CO, name: 'CARRIER A', carrier_company_id: 'tp-1', is_own_fleet: false, basis: 'SET', aggregation: 'UNIT', rounding: 'NONE', is_active: true },
    ],
    delivery_rate_rules: [
      { id: 'r-tier', company_id: CO, card_id: CARD, rule_type: 'POSITIONAL_TIER', tier_position: 1, amount_sen: 10_000, area_id: null, params: null },
      { id: 'r-setup', company_id: CO, card_id: CARD, rule_type: 'SETUP', amount_sen: 20_000, area_id: null, params: null },
      { id: 'r-pickup', company_id: CO, card_id: CARD, rule_type: 'PICKUP', amount_sen: 6_000, area_id: null, params: null },
      { id: 'r-johor', company_id: CO, card_id: CARD, rule_type: 'OUTSTATION', zone: 'JOHOR', amount_sen: 25_000, area_id: null, params: { note: 'keep' } },
    ],
    delivery_rate_areas: [],
    delivery_places: [],
    delivery_zone_postcodes: [],
    trips: [
      { id: 'trip-1', company_id: CO, trip_no: 'T1', trip_date: '2026-11-17', lorry_id: 'lorry-1', is_outsourced: true, three_pl_cost_sen: 50_000, status: 'COMPLETED' },
    ],
    lorries: [{ id: 'lorry-1', company_id: CO, threepl_company_id: 'tp-1' }],
    trip_stops: [
      { id: 's-1', company_id: CO, trip_id: 'trip-1', stop_type: 'SETUP', do_id: null, so_id: null, assr_case_id: null, address: 'Hall A 81100 Johor Bahru' },
      { id: 's-2', company_id: CO, trip_id: 'trip-1', stop_type: 'PICKUP', do_id: null, so_id: null, assr_case_id: 42, address: 'Taman X 50450 Kuala Lumpur' },
      { id: 's-3', company_id: CO, trip_id: 'trip-1', stop_type: 'LORRY_SERVICE', do_id: null, so_id: null, assr_case_id: null, address: 'Workshop' },
    ],
    delivery_orders: [],
    mfg_sales_order_items: [],
    mfg_sales_orders: [],
  });
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, CO as never);
    c.set('allowedCompanyIds' as never, [CO] as never);
    c.set('houzsUser' as never, { id: 7, permissions_set: new Set<string>() } as never);
    await next();
  });
  app.route('/delivery-rate-cards', deliveryRateCards as unknown as Hono);
  const req = (path: string, method: string, body?: unknown) =>
    app.request(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }, {});
  return { req, tables: (sb as unknown as { tables: Record<string, Row[]> }).tables };
}

type Breakdown = { totalSen: number; lines: Array<{ ruleType: string; amountSen: number }> };

describe('outstation Applies to', () => {
  test('an existing outstation price reads back its default, Delivery order', async () => {
    const { req } = harness();
    const res = await req(`/delivery-rate-cards/${CARD}`, 'GET');
    const { rules } = await res.json() as { rules: Array<{ id: string; appliesTo: string[] | null }> };
    expect(rules.find((r) => r.id === 'r-johor')?.appliesTo).toEqual(['DELIVERY']);
    expect(rules.find((r) => r.id === 'r-setup')?.appliesTo).toBeNull();
  });

  test('a new outstation price keeps the jobs it names, in DP order', async () => {
    const { req, tables } = harness();
    const res = await req(`/delivery-rate-cards/${CARD}/rules`, 'POST', { ruleType: 'OUTSTATION_TRIP', zone: 'JOHOR', amountSen: 40_000, appliesTo: ['SERVICE', 'DELIVERY'] });
    expect(res.status).toBe(201);
    const { rule } = await res.json() as { rule: { id: string; appliesTo: string[] } };
    expect(rule.appliesTo).toEqual(['DELIVERY', 'SERVICE']);
    expect(tables.delivery_rate_rules.find((r) => r.id === rule.id)?.params).toEqual({ appliesTo: ['DELIVERY', 'SERVICE'] });
  });

  test('only an outstation price takes it', async () => {
    const { req } = harness();
    const post = await req(`/delivery-rate-cards/${CARD}/rules`, 'POST', { ruleType: 'SETUP', amountSen: 1, appliesTo: ['SETUP'] });
    expect(post.status).toBe(400);
    expect((await post.json() as { error: string }).error).toBe('applies_to_not_for_rule');
    const patch = await req(`/delivery-rate-cards/${CARD}/rules/r-setup`, 'PATCH', { appliesTo: ['SETUP'] });
    expect(patch.status).toBe(400);
    const bad = await req(`/delivery-rate-cards/${CARD}/rules/r-johor`, 'PATCH', { appliesTo: ['LORRY_SERVICE'] });
    expect(bad.status).toBe(400);
  });

  test('a change merges into the stored params, and null goes back to the default', async () => {
    const { req, tables } = harness();
    const on = await req(`/delivery-rate-cards/${CARD}/rules/r-johor`, 'PATCH', { appliesTo: ['SETUP', 'DELIVERY'] });
    expect(on.status).toBe(200);
    expect(tables.delivery_rate_rules.find((r) => r.id === 'r-johor')?.params).toEqual({ note: 'keep', appliesTo: ['DELIVERY', 'SETUP'] });
    const off = await req(`/delivery-rate-cards/${CARD}/rules/r-johor`, 'PATCH', { appliesTo: null });
    expect(((await off.json()) as { rule: { appliesTo: string[] } }).rule.appliesTo).toEqual(['DELIVERY']);
    expect(tables.delivery_rate_rules.find((r) => r.id === 'r-johor')?.params).toEqual({ note: 'keep' });
  });

  test('the Price check prices the job it names', async () => {
    const { req } = harness();
    const check = async () => {
      const res = await req(`/delivery-rate-cards/${CARD}/compute`, 'POST', { setupCount: 1, destinationZone: 'JOHOR', jobType: 'SETUP' });
      expect(res.status).toBe(200);
      return ((await res.json()) as { breakdown: Breakdown }).breakdown;
    };
    expect((await check()).lines.map((l) => l.ruleType)).toEqual(['SETUP']);
    await req(`/delivery-rate-cards/${CARD}/rules/r-johor`, 'PATCH', { appliesTo: ['DELIVERY', 'SETUP'] });
    expect((await check()).totalSen).toBe(45_000);
    /* No job named is a delivery order, exactly as before. */
    const dflt = await req(`/delivery-rate-cards/${CARD}/compute`, 'POST', { setCount: 1, destinationZone: 'JOHOR' });
    expect(((await dflt.json()) as { breakdown: Breakdown }).breakdown.totalSen).toBe(35_000);
  });
});

describe('trip reconciliation prices every job on the trip', () => {
  test('a setup and an ASSR pickup are counted; the lorry service is not', async () => {
    const { req } = harness();
    const res = await req('/delivery-rate-cards/reconcile', 'GET');
    expect(res.status).toBe(200);
    const { rows } = await res.json() as { rows: Array<{ expectedSen: number; breakdown: Breakdown }> };
    expect(rows).toHaveLength(1);
    expect(rows[0].breakdown.lines.map((l) => [l.ruleType, l.amountSen])).toEqual([['SETUP', 20_000], ['PICKUP', 6_000]]);
    expect(rows[0].expectedSen).toBe(26_000);
  });
});
