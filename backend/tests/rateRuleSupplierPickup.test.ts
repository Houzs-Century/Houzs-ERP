/* A Supplier pickup rate rule could not be saved: the Carriers & Rates editor
   offers every rule type in rate-rule-taxonomy.ts, but POST /:id/rules checked
   a local list that predated mig 0243 and answered 400 for SUPPLIER_PICKUP.
   Pinned: every rule type the editor offers is accepted on create and on edit,
   and a saved Supplier pickup rule actually prices in the calculator. */
import { describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../src/scm/middleware/auth', () => ({
  supabaseAuth: async (_c: unknown, next: () => Promise<void>) => { await next(); },
}));

import { deliveryRateCards } from '../src/scm/routes/delivery-rate-cards';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { RATE_RULE_TYPES } from '../src/scm/lib/rate-rule-taxonomy';
import { computeDeliveryCost } from '../src/scm/lib/delivery-rate-card';

const CO = 1;
const CARD: Row = {
  id: 'card-1', company_id: CO, name: 'MSJ TRANSPORT', carrier_lorry_id: null, carrier_company_id: 'msj',
  carrier_label: null, is_own_fleet: false, basis: 'SET', aggregation: 'UNIT', min_charge_sen: null,
  cap_sen: null, rounding: 'NONE', is_active: true, notes: null, created_at: '2026-11-01', updated_at: '2026-11-01',
};

function app(rules: Row[] = []) {
  const sb = fakeSb({ delivery_rate_cards: [CARD], delivery_rate_rules: rules });
  const a = new Hono();
  a.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, CO as never);
    await next();
  });
  a.route('/delivery-rate-cards', deliveryRateCards as unknown as Hono);
  return a;
}

const send = (a: Hono, method: string, path: string, body: unknown) =>
  a.request(`/delivery-rate-cards${path}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, {});

describe('rate rules: every type the editor offers can be saved', () => {
  test('POST accepts a Supplier pickup rule', async () => {
    const res = await send(app(), 'POST', '/card-1/rules', { ruleType: 'SUPPLIER_PICKUP', amountSen: 4500 });
    expect(res.status).toBe(201);
    const body = await res.json() as { rule: { ruleType: string; amountSen: number } };
    expect(body.rule.ruleType).toBe('SUPPLIER_PICKUP');
    expect(body.rule.amountSen).toBe(4500);
  });

  test.each(RATE_RULE_TYPES.map((t) => [t]))('POST does not refuse %s as an unknown type', async (ruleType) => {
    const res = await send(app(), 'POST', '/card-1/rules', { ruleType, amountSen: 100, tierPosition: 1, zone: 'MELAKA', bracketMin: 0 });
    expect(res.status).not.toBe(400);
  });

  test('PATCH can change a rule to Supplier pickup', async () => {
    const rule: Row = { id: 'r1', company_id: CO, card_id: 'card-1', rule_type: 'PICKUP', tier_position: null, bracket_min: null, bracket_max: null, zone: null, amount_sen: 3000, params: null, sort_order: 0 };
    const res = await send(app([rule]), 'PATCH', '/card-1/rules/r1', { ruleType: 'SUPPLIER_PICKUP' });
    expect(res.status).toBe(200);
  });

  test('a Supplier pickup rule prices the calculator', () => {
    const out = computeDeliveryCost(
      { basis: 'SET', aggregation: 'UNIT', rules: [{ ruleType: 'SUPPLIER_PICKUP', amountSen: 4500 }] } as never,
      { setCount: 0, supplierPickupCount: 2 },
    );
    expect(out.lines.find((l) => l.ruleType === 'SUPPLIER_PICKUP')?.amountSen).toBe(9000);
    expect(out.totalSen).toBe(9000);
  });

  test('the compute endpoint takes a supplier pickup count', async () => {
    const rule: Row = { id: 'r1', company_id: CO, card_id: 'card-1', rule_type: 'SUPPLIER_PICKUP', tier_position: null, bracket_min: null, bracket_max: null, zone: null, amount_sen: 4500, params: null, sort_order: 0 };
    const res = await send(app([rule]), 'POST', '/card-1/compute', { supplierPickupCount: 1 });
    expect(res.status).toBe(200);
    const body = await res.json() as { breakdown: { totalSen: number } };
    expect(body.breakdown.totalSen).toBe(4500);
  });
});
