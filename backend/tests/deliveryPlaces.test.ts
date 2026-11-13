/* Places under the delivery zones (mig 20261111T1100; owner 2026-11-11: the
   carriers' rate cards use the same areas as Delivery Zones, 做), on the real
   handlers over fake PostgREST:
     • a pasted list of towns is filed under a zone, upper case, once each; a
       town already filed elsewhere moves; a zone's own name is not a town;
     • the list read names the rate cards that price each place, and the towns
       cards price that no zone holds yet;
     • a place a card prices cannot be removed;
     • a rate card can only price a zone or a town that has a zone. */
import { describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../src/scm/middleware/auth', () => ({
  supabaseAuth: async (_c: unknown, next: () => Promise<void>) => { await next(); },
}));

import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { deliveryPlaces } from '../src/scm/routes/delivery-places';
import { deliveryRateCards } from '../src/scm/routes/delivery-rate-cards';

const CO = 1;
const CARD = 'card-carrier';
const AREA = '11111111-1111-4111-8111-111111111111';

function harness(places: Row[] = []) {
  const sb = fakeSb({
    delivery_rate_cards: [
      { id: CARD, company_id: CO, name: 'CARRIER A', carrier_company_id: null, is_own_fleet: true, basis: 'SET', aggregation: 'UNIT', rounding: 'NONE', is_active: true },
    ],
    delivery_rate_rules: [
      { id: 'r-1', company_id: CO, card_id: CARD, rule_type: 'POSITIONAL_TIER', tier_position: 1, amount_sen: 10_000, area_id: null },
      { id: 'r-2', company_id: CO, card_id: CARD, rule_type: 'OUTSTATION', zone: 'TAIPING', amount_sen: 60_000, area_id: null },
      { id: 'r-3', company_id: CO, card_id: CARD, rule_type: 'OUTSTATION', zone: 'JOHOR', amount_sen: 70_000, area_id: null },
    ],
    delivery_rate_areas: [
      { id: AREA, company_id: CO, card_id: CARD, name: 'Far', towns: ['IPOH', 'KAPAR', 'JOHOR'], sort_order: 0 },
    ],
    delivery_places: places,
  });
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, CO as never);
    c.set('allowedCompanyIds' as never, [CO] as never);
    c.set('houzsUser' as never, { id: 7, permissions_set: new Set<string>() } as never);
    await next();
  });
  app.route('/delivery-places', deliveryPlaces as unknown as Hono);
  app.route('/delivery-rate-cards', deliveryRateCards as unknown as Hono);
  const req = (path: string, method: string, body?: unknown) =>
    app.request(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }, {});
  return { req, tables: (sb as unknown as { tables: Record<string, Row[]> }).tables };
}

type Place = { id: string; name: string; zone: string | null; cards: string[] };

describe('places under the delivery zones', () => {
  test('a pasted list is filed under a zone, upper case, once each', async () => {
    const { req } = harness();
    const res = await req('/delivery-places', 'POST', { zone: 'perak', names: ['Ipoh', ' taiping ', 'IPOH', ''] });
    expect(res.status).toBe(201);
    const { places } = await res.json() as { places: Place[] };
    expect(places.map((p) => [p.name, p.zone])).toEqual([['IPOH', 'PERAK'], ['TAIPING', 'PERAK']]);
  });

  test('a town filed again under another zone moves there', async () => {
    const { req } = harness([{ id: 'p-1', company_id: CO, name: 'IPOH', zone: 'KEDAH' }]);
    await req('/delivery-places', 'POST', { zone: 'PERAK', names: ['Ipoh'] });
    const { places } = await (await req('/delivery-places', 'GET')).json() as { places: Place[] };
    expect(places.map((p) => [p.name, p.zone])).toEqual([['IPOH', 'PERAK']]);
  });

  test('a zone is not a town, and an unknown zone is refused', async () => {
    const { req } = harness();
    const zoneName = await req('/delivery-places', 'POST', { zone: 'JOHOR', names: ['Johor', 'Muar'] });
    expect(zoneName.status).toBe(400);
    expect(await zoneName.json()).toMatchObject({ error: 'zone_not_place', names: ['JOHOR'] });
    const unknown = await req('/delivery-places', 'POST', { zone: 'ATLANTIS', names: ['Muar'] });
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({ error: 'unknown_zone' });
  });

  test('a town abroad has no zone', async () => {
    const { req } = harness();
    const res = await req('/delivery-places', 'POST', { zone: null, names: ['Brunei'] });
    expect(res.status).toBe(201);
    expect((await res.json() as { places: Place[] }).places.map((p) => [p.name, p.zone])).toEqual([['BRUNEI', null]]);
  });

  test('the list names the cards that price each place, and the towns no zone holds yet', async () => {
    const { req } = harness([
      { id: 'p-1', company_id: CO, name: 'IPOH', zone: 'PERAK' },
      { id: 'p-2', company_id: CO, name: 'TAIPING', zone: 'PERAK' },
      { id: 'p-3', company_id: CO, name: 'MUAR', zone: 'JOHOR' },
    ]);
    const body = await (await req('/delivery-places', 'GET')).json() as { places: Place[]; unplaced: Array<{ name: string; cards: string[] }> };
    expect(body.places.map((p) => [p.name, p.cards])).toEqual([['IPOH', ['CARRIER A']], ['MUAR', []], ['TAIPING', ['CARRIER A']]]);
    expect(body.unplaced).toEqual([{ name: 'KAPAR', cards: ['CARRIER A'] }]);
  });

  test('a place a card prices stays; one no card prices goes; a place can change zone', async () => {
    const { req, tables } = harness([
      { id: 'p-1', company_id: CO, name: 'IPOH', zone: 'PERAK' },
      { id: 'p-3', company_id: CO, name: 'MUAR', zone: 'JOHOR' },
    ]);
    const used = await req('/delivery-places/p-1', 'DELETE');
    expect(used.status).toBe(409);
    expect(await used.json()).toMatchObject({ error: 'place_in_use', cards: ['CARRIER A'] });
    expect((await req('/delivery-places/p-3', 'DELETE')).status).toBe(200);
    expect(tables.delivery_places.map((p) => p.name)).toEqual(['IPOH']);
    const moved = await req('/delivery-places/p-1', 'PATCH', { zone: 'KEDAH' });
    expect(moved.status).toBe(200);
    expect(tables.delivery_places[0].zone).toBe('KEDAH');
    expect((await req('/delivery-places/p-1', 'PATCH', { zone: 'ATLANTIS' })).status).toBe(400);
  });
});

describe('a rate card prices only a zone or a town with a zone', () => {
  test('an area or a town price naming a town no zone holds is refused, with the towns named', async () => {
    const { req } = harness([{ id: 'p-1', company_id: CO, name: 'IPOH', zone: 'PERAK' }]);
    const area = await req(`/delivery-rate-cards/${CARD}/areas`, 'POST', { name: 'North', towns: ['Ipoh', 'Gerik', 'Johor'] });
    expect(area.status).toBe(400);
    expect(await area.json()).toMatchObject({ error: 'unknown_place', names: ['GERIK'] });
    const rule = await req(`/delivery-rate-cards/${CARD}/rules`, 'POST', { ruleType: 'OUTSTATION', zone: 'Gerik', amountSen: 1_000 });
    expect(rule.status).toBe(400);
    expect(await rule.json()).toMatchObject({ error: 'unknown_place', names: ['GERIK'] });
    expect((await req(`/delivery-rate-cards/${CARD}/areas`, 'POST', { name: 'North', towns: ['Ipoh', 'Johor'] })).status).toBe(201);
    expect((await req(`/delivery-rate-cards/${CARD}/rules`, 'POST', { ruleType: 'OUTSTATION', zone: 'Perak', amountSen: 1_000 })).status).toBe(201);
  });

  test('the Price check reads a town inside its own zone', async () => {
    const { req } = harness([
      { id: 'p-1', company_id: CO, name: 'IPOH', zone: 'PERAK' },
      { id: 'p-2', company_id: CO, name: 'TAIPING', zone: 'PERAK' },
    ]);
    const at = async (destinationZone: string) => (await (await req(`/delivery-rate-cards/${CARD}/compute`, 'POST', { setCount: 1, destinationZone })).json() as { breakdown: { totalSen: number } }).breakdown.totalSen;
    expect(await at('TAIPING')).toBe(10_000 + 60_000);
    /* Johor is a zone the area lists; the area carries no ladder of its own, so
       the card's own set price applies, plus the Johor price. */
    expect(await at('JOHOR')).toBe(10_000 + 70_000);
  });
});
