/* A rate card's charge on each delivery order (DO_CHARGE; owner 2026-11-24 on
   the Singapore carriers: shares of the goods value, a permit per order), on
   the real handlers over fake PostgREST, made-up rates and figures:
     • a charge is named and has an amount per DO, a % of the goods, or both;
       a name or a % on any other rule is refused;
     • the Price check prices one DO's goods;
     • the 3PL invoices tab holds a carrier's bill per DO against the card's
       share of that DO's goods (its own lines without the service ones). */
import { describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../src/scm/middleware/auth', () => ({
  supabaseAuth: async (_c: unknown, next: () => Promise<void>) => { await next(); },
}));

import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { deliveryRateCards } from '../src/scm/routes/delivery-rate-cards';
import { threeplDoCharges } from '../src/scm/routes/threepl-do-charges';

const CO = 1;
const card = { id: 'card-sg', company_id: CO, name: 'TEST SG CARRIER', carrier_company_id: 'car-sg', carrier_lorry_id: null, is_own_fleet: false, basis: 'SET', aggregation: 'UNIT', rounding: 'NONE', is_active: true };
const rule = (id: string, extra: Row) => ({ id, card_id: 'card-sg', company_id: CO, rule_type: 'DO_CHARGE', amount_sen: 0, sort_order: 0, ...extra });
/* Fresh rows per test: the fake database keeps the objects it is given, and a PATCH changes them. */
const tax = () => rule('r-tax', { params: { label: 'Tax', bps: 700 } });
const fee = () => rule('r-fee', { params: { label: 'Fee', bps: 500 } });
const permit = () => rule('r-permit', { amount_sen: 2_500, params: { label: 'Permit', bps: 0 } });

function harness(extra: Partial<Record<string, Row[]>> = {}) {
  const sb = fakeSb({
    threepl_companies: [{ id: 'car-sg', company_id: CO, name: 'TEST SG CARRIER', is_active: true }],
    delivery_rate_cards: [card],
    delivery_rate_rules: [],
    delivery_rate_areas: [],
    delivery_zone_postcodes: [],
    delivery_places: [],
    delivery_orders: [{ id: 'do-1', company_id: CO, do_number: 'TEST-DO-1', do_date: '2026-11-02', so_doc_no: 'TEST-SO-1', debtor_name: 'TEST', status: 'DELIVERED' }],
    mfg_sales_orders: [{ doc_no: 'TEST-SO-1', company_id: CO, postcode: null, address1: 'TEST ROAD', address2: null, address3: null, address4: null, city: 'SINGAPORE' }],
    mfg_sales_order_items: [{ doc_no: 'TEST-SO-1', company_id: CO, item_group: 'BEDFRAME', qty: 1, cancelled: false }],
    /* RM 4,750 of goods and RM 800 of service on the DO. */
    delivery_order_items: [
      { delivery_order_id: 'do-1', company_id: CO, item_code: 'TEST-SOFA', item_group: 'SOFA', line_total_sen: 300_000 },
      { delivery_order_id: 'do-1', company_id: CO, item_code: 'TEST-BF', item_group: 'BEDFRAME', line_total_sen: 175_000 },
      { delivery_order_id: 'do-1', company_id: CO, item_code: 'TEST-LIFT', item_group: 'SERVICE', line_total_sen: 80_000 },
    ],
    threepl_do_charges: [],
    ...extra,
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
  app.route('/threepl-do-charges', threeplDoCharges as unknown as Hono);
  const req = (path: string, method: string, body?: unknown) =>
    app.request(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }, {});
  return { req, tables: (sb as unknown as { tables: Record<string, Row[]> }).tables };
}

describe('a charge on each delivery order, on a card', () => {
  test('named, with a % of the goods or an amount per DO; read back with both', async () => {
    const { req } = harness();
    const share = await req('/delivery-rate-cards/card-sg/rules', 'POST', { ruleType: 'DO_CHARGE', label: 'Tax', bps: 700, amountSen: 0 });
    expect(share.status).toBe(201);
    expect((await share.json() as { rule: Row }).rule).toMatchObject({ ruleType: 'DO_CHARGE', label: 'Tax', bps: 700, amountSen: 0 });
    const fixed = await req('/delivery-rate-cards/card-sg/rules', 'POST', { ruleType: 'DO_CHARGE', label: 'Permit', amountSen: 2_500 });
    expect((await fixed.json() as { rule: Row }).rule).toMatchObject({ label: 'Permit', bps: 0, amountSen: 2_500 });
  });

  test('refused with no name, with nothing to charge, and a name or a % on another rule', async () => {
    const { req, tables } = harness();
    const noName = await req('/delivery-rate-cards/card-sg/rules', 'POST', { ruleType: 'DO_CHARGE', bps: 700, amountSen: 0 });
    expect(noName.status).toBe(400);
    expect((await noName.json() as { error: string }).error).toBe('do_charge_incomplete');
    expect((await req('/delivery-rate-cards/card-sg/rules', 'POST', { ruleType: 'DO_CHARGE', label: 'Tax', bps: 0, amountSen: 0 })).status).toBe(400);
    const onTier = await req('/delivery-rate-cards/card-sg/rules', 'POST', { ruleType: 'POSITIONAL_TIER', tierPosition: 1, amountSen: 5_000, bps: 700 });
    expect((await onTier.json() as { error: string }).error).toBe('not_a_do_charge');
    expect(tables.delivery_rate_rules).toEqual([]);
  });

  test('a change keeps the rest of the charge, and cannot leave it charging nothing', async () => {
    const { req, tables } = harness({ delivery_rate_rules: [tax()] });
    const to6 = await req('/delivery-rate-cards/card-sg/rules/r-tax', 'PATCH', { bps: 600 });
    expect(to6.status).toBe(200);
    expect(tables.delivery_rate_rules[0]!.params).toEqual({ label: 'Tax', bps: 600 });
    expect((await req('/delivery-rate-cards/card-sg/rules/r-tax', 'PATCH', { bps: 0 })).status).toBe(400);
  });

  test("the Price check prices one DO's goods", async () => {
    const { req } = harness({ delivery_rate_rules: [tax(), permit()] });
    const res = await req('/delivery-rate-cards/card-sg/compute', 'POST', { goodsValueSen: 475_000, dropCount: 1 });
    const body = await res.json() as { breakdown: { totalSen: number; lines: Array<{ label: string; amountSen: number }> } };
    expect(body.breakdown.lines.map((l) => [l.label, l.amountSen])).toEqual([['Tax 7% of goods', 33_250], ['Permit', 2_500]]);
  });
});

describe("a carrier's bill per DO against the card", () => {
  test("its share is of the DO's own goods, the service lines left out", async () => {
    const { req } = harness({
      delivery_rate_rules: [tax(), fee(), permit()],
      /* Billed 7% + 3% of RM 4,750 and the permit. */
      threepl_do_charges: [{ id: 'ch-1', company_id: CO, do_id: 'do-1', threepl_company_id: 'car-sg', invoice_no: 'TEST-INV-1', invoice_date: '2026-11-03', billed_sen: 50_000, note: null, ap_invoice_id: null, created_at: '2026-11-03T00:00:00Z' }],
    });
    const res = await req('/threepl-do-charges', 'GET');
    expect(res.status).toBe(200);
    const [row] = (await res.json() as { rows: Array<{ billedSen: number; expectedSen: number; varianceSen: number }> }).rows;
    // The card: 7% + 5% of RM 4,750 and RM 25 = RM 595.00; the bill is 2% of the goods under it.
    expect(row).toMatchObject({ billedSen: 50_000, expectedSen: 33_250 + 23_750 + 2_500, varianceSen: -9_500 });
  });
});
