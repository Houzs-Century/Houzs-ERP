/* Rate card areas (mig 20261111T1000; owner 2026-11-11 on the 3PL quotations: 做),
   on the real handlers over fake PostgREST:
     • an area is added to a card with its towns, kept upper case without repeats,
       renamed or re-towned, and removed with the prices it carried;
     • a rule may name an area of its own card — never another card's, and never
       for a town surcharge, which stays the whole card's;
     • the card read carries its areas, and the Price check prices in the area it
       names, with the area's own ladder. */
import { describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../src/scm/middleware/auth', () => ({
  supabaseAuth: async (_c: unknown, next: () => Promise<void>) => { await next(); },
}));

import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { deliveryRateCards } from '../src/scm/routes/delivery-rate-cards';

const CO = 1;
const CARD = 'card-carrier';
const OTHER_CARD = 'card-other';
const OTHER_AREA = '99999999-9999-4999-8999-999999999999';

function harness() {
  const sb = fakeSb({
    delivery_rate_cards: [
      { id: CARD, company_id: CO, name: 'CARRIER A', carrier_company_id: null, is_own_fleet: true, basis: 'SET', aggregation: 'UNIT', rounding: 'NONE', is_active: true },
      { id: OTHER_CARD, company_id: CO, name: 'OTHER', carrier_company_id: null, is_own_fleet: true, basis: 'SET', aggregation: 'UNIT', rounding: 'NONE', is_active: true },
    ],
    delivery_rate_rules: [
      { id: 'r-1', company_id: CO, card_id: CARD, rule_type: 'POSITIONAL_TIER', tier_position: 1, amount_sen: 10_000, area_id: null },
      { id: 'r-3', company_id: CO, card_id: CARD, rule_type: 'POSITIONAL_TIER', tier_position: 3, amount_sen: 3_000, area_id: null },
    ],
    delivery_rate_areas: [
      { id: OTHER_AREA, company_id: CO, card_id: OTHER_CARD, name: 'Elsewhere', towns: ['ELSEWHERE'], sort_order: 0 },
    ],
    /* A card prices a zone or a town with a zone (Delivery Zones places, mig 20261111T1100). */
    delivery_places: [
      { id: 'p-bintulu', company_id: CO, name: 'BINTULU', zone: 'SARAWAK' },
      { id: 'p-tatau', company_id: CO, name: 'TATAU', zone: 'SARAWAK' },
    ],
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

async function addBintulu(req: ReturnType<typeof harness>['req']): Promise<string> {
  const res = await req(`/delivery-rate-cards/${CARD}/areas`, 'POST', { name: 'Bintulu / Tatau', towns: ['Bintulu', ' tatau ', 'BINTULU', ''] });
  expect(res.status).toBe(201);
  const { area } = await res.json() as { area: { id: string; towns: string[]; cardId: string } };
  expect(area.towns).toEqual(['BINTULU', 'TATAU']);
  expect(area.cardId).toBe(CARD);
  return area.id;
}

describe('rate card areas', () => {
  test('an area carries its own ladder; the card read and the Price check use it', async () => {
    const { req } = harness();
    const areaId = await addBintulu(req);
    for (const [pos, sen] of [[1, 30_000], [3, 6_000]] as const) {
      const res = await req(`/delivery-rate-cards/${CARD}/rules`, 'POST', { ruleType: 'POSITIONAL_TIER', tierPosition: pos, amountSen: sen, areaId });
      expect(res.status).toBe(201);
      expect((await res.json() as { rule: { areaId: string } }).rule.areaId).toBe(areaId);
    }
    const read = await (await req(`/delivery-rate-cards/${CARD}`, 'GET')).json() as { areas: Array<{ id: string; name: string }>; rules: Array<{ areaId: string | null }> };
    expect(read.areas.map((a) => a.name)).toEqual(['Bintulu / Tatau']);
    expect(read.rules.filter((r) => r.areaId === areaId)).toHaveLength(2);

    const inArea = await (await req(`/delivery-rate-cards/${CARD}/compute`, 'POST', { setCount: 3, areaId })).json() as { breakdown: { totalSen: number; area: { name: string } | null } };
    expect(inArea.breakdown.totalSen).toBe(30_000 + 30_000 + 6_000);
    expect(inArea.breakdown.area?.name).toBe('Bintulu / Tatau');
    const city = await (await req(`/delivery-rate-cards/${CARD}/compute`, 'POST', { setCount: 3 })).json() as { breakdown: { totalSen: number; area: unknown } };
    expect(city.breakdown.totalSen).toBe(10_000 + 10_000 + 3_000);
    expect(city.breakdown.area).toBeNull();
  });

  test('a rule cannot name another card\'s area, and a town surcharge cannot name any', async () => {
    const { req } = harness();
    const areaId = await addBintulu(req);
    const foreign = await req(`/delivery-rate-cards/${CARD}/rules`, 'POST', { ruleType: 'POSITIONAL_TIER', tierPosition: 1, amountSen: 1, areaId: OTHER_AREA });
    expect(foreign.status).toBe(404);
    expect((await foreign.json() as { error: string }).error).toBe('area_not_found');
    const surcharge = await req(`/delivery-rate-cards/${CARD}/rules`, 'POST', { ruleType: 'OUTSTATION', zone: 'Bintulu', amountSen: 1, areaId });
    expect(surcharge.status).toBe(400);
    expect((await surcharge.json() as { error: string }).error).toBe('area_not_for_surcharge');
    /* Moving an existing card rule into the area, and back out. */
    const into = await req(`/delivery-rate-cards/${CARD}/rules/r-3`, 'PATCH', { areaId });
    expect(into.status).toBe(200);
    const out = await req(`/delivery-rate-cards/${CARD}/rules/r-3`, 'PATCH', { areaId: null });
    expect((await out.json() as { rule: { areaId: string | null } }).rule.areaId).toBeNull();
  });

  test('an area is renamed and re-towned, and removed with its prices', async () => {
    const { req, tables } = harness();
    const areaId = await addBintulu(req);
    await req(`/delivery-rate-cards/${CARD}/rules`, 'POST', { ruleType: 'POSITIONAL_TIER', tierPosition: 1, amountSen: 30_000, areaId });
    const patched = await req(`/delivery-rate-cards/areas/${areaId}`, 'PATCH', { name: 'Bintulu', towns: ['bintulu'] });
    expect(patched.status).toBe(200);
    expect((await patched.json() as { area: { name: string; towns: string[] } }).area).toMatchObject({ name: 'Bintulu', towns: ['BINTULU'] });
    expect((await req(`/delivery-rate-cards/areas/${areaId}`, 'DELETE')).status).toBe(200);
    expect(tables.delivery_rate_areas!.filter((a) => a.id === areaId)).toHaveLength(0);
    expect(tables.delivery_rate_rules!.filter((r) => r.area_id === areaId)).toHaveLength(0);
    expect(tables.delivery_rate_rules!.filter((r) => r.card_id === CARD)).toHaveLength(2);
  });
});
