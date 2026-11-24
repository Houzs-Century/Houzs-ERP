/* A rate card's charge on each delivery order (DO_CHARGE; owner 2026-11-24 on
   the Singapore carriers: 9% + 6% of the goods value, a RM 30 permit per
   order), on the real handlers over fake PostgREST, made-up figures:
     • a charge is named and has an amount per DO, a % of the goods, or both;
       a name or a % on any other rule is refused;
     • the Price check prices one DO's goods;
     • the 3PL invoices tab holds a carrier's bill per DO against the card's
       share of that DO's goods (its order's goods, no service lines). */
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

function harness(extra: Partial<Record<string, Row[]>> = {}) {
  const sb = fakeSb({
    threepl_companies: [{ id: 'car-sg', company_id: CO, name: 'TEST SG CARRIER', is_active: true }],
    delivery_rate_cards: [card],
    delivery_rate_rules: [],
    delivery_rate_areas: [],
    delivery_zone_postcodes: [],
    delivery_places: [],
    delivery_orders: [{ id: 'do-1', company_id: CO, do_number: 'TEST-DO-1', do_date: '2026-11-02', so_doc_no: 'TEST-SO-1', debtor_name: 'TEST', status: 'DELIVERED', local_total_sen: 555_000 }],
    mfg_sales_orders: [{
      doc_no: 'TEST-SO-1', company_id: CO, local_total_sen: 555_000, postcode: null, address1: 'TEST ROAD', address2: null, address3: null, address4: null, city: 'SINGAPORE',
      mattress_sofa_sen: 300_000, bedframe_sen: 150_000, accessories_sen: 20_000, others_sen: 5_000, service_sen: 80_000,
    }],
    mfg_sales_order_items: [{ doc_no: 'TEST-SO-1', company_id: CO, item_group: 'BEDFRAME', qty: 1, cancelled: false }],
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
    const sst = await req('/delivery-rate-cards/card-sg/rules', 'POST', { ruleType: 'DO_CHARGE', label: 'SST', bps: 900, amountSen: 0 });
    expect(sst.status).toBe(201);
    expect((await sst.json() as { rule: Row }).rule).toMatchObject({ ruleType: 'DO_CHARGE', label: 'SST', bps: 900, amountSen: 0 });
    const permit = await req('/delivery-rate-cards/card-sg/rules', 'POST', { ruleType: 'DO_CHARGE', label: 'Permit', amountSen: 3_000 });
    expect((await permit.json() as { rule: Row }).rule).toMatchObject({ label: 'Permit', bps: 0, amountSen: 3_000 });
  });

  test('refused with no name, with nothing to charge, and a name or a % on another rule', async () => {
    const { req, tables } = harness();
    const noName = await req('/delivery-rate-cards/card-sg/rules', 'POST', { ruleType: 'DO_CHARGE', bps: 900, amountSen: 0 });
    expect(noName.status).toBe(400);
    expect((await noName.json() as { error: string }).error).toBe('do_charge_incomplete');
    expect((await req('/delivery-rate-cards/card-sg/rules', 'POST', { ruleType: 'DO_CHARGE', label: 'SST', bps: 0, amountSen: 0 })).status).toBe(400);
    const onTier = await req('/delivery-rate-cards/card-sg/rules', 'POST', { ruleType: 'POSITIONAL_TIER', tierPosition: 1, amountSen: 5_000, bps: 900 });
    expect((await onTier.json() as { error: string }).error).toBe('not_a_do_charge');
    expect(tables.delivery_rate_rules).toEqual([]);
  });

  test('a change keeps the rest of the charge, and cannot leave it charging nothing', async () => {
    const { req, tables } = harness({ delivery_rate_rules: [rule('r-sst', { params: { label: 'SST', bps: 900 } })] });
    const to8 = await req('/delivery-rate-cards/card-sg/rules/r-sst', 'PATCH', { bps: 800 });
    expect(to8.status).toBe(200);
    expect(tables.delivery_rate_rules[0]!.params).toEqual({ label: 'SST', bps: 800 });
    expect((await req('/delivery-rate-cards/card-sg/rules/r-sst', 'PATCH', { bps: 0 })).status).toBe(400);
  });

  test("the Price check prices one DO's goods", async () => {
    const { req } = harness({ delivery_rate_rules: [rule('r-sst', { params: { label: 'SST', bps: 900 } }), rule('r-permit', { amount_sen: 3_000, params: { label: 'Permit', bps: 0 } })] });
    const res = await req('/delivery-rate-cards/card-sg/compute', 'POST', { goodsValueSen: 475_000, dropCount: 1 });
    const body = await res.json() as { breakdown: { totalSen: number; lines: Array<{ label: string; amountSen: number }> } };
    expect(body.breakdown.lines.map((l) => [l.label, l.amountSen])).toEqual([['SST 9% of goods', 42_750], ['Permit', 3_000]]);
  });
});

describe("a carrier's bill per DO against the card", () => {
  test("its share is of the DO's goods, its order's goods without the service lines", async () => {
    const { req } = harness({
      delivery_rate_rules: [
        rule('r-sst', { params: { label: 'SST', bps: 900 } }),
        rule('r-cost', { params: { label: 'Cost', bps: 600 } }),
        rule('r-permit', { amount_sen: 3_000, params: { label: 'Permit', bps: 0 } }),
      ],
      /* Billed 9% + 4% of RM 4,750 and the permit. */
      threepl_do_charges: [{ id: 'ch-1', company_id: CO, do_id: 'do-1', threepl_company_id: 'car-sg', invoice_no: 'TEST-INV-1', invoice_date: '2026-11-03', billed_sen: 64_750, note: null, ap_invoice_id: null, created_at: '2026-11-03T00:00:00Z' }],
    });
    const res = await req('/threepl-do-charges', 'GET');
    expect(res.status).toBe(200);
    const [row] = (await res.json() as { rows: Array<{ billedSen: number; expectedSen: number; varianceSen: number }> }).rows;
    // The card: 9% + 6% of RM 4,750 and RM 30 = RM 742.50; the bill is 2% of the goods under it.
    expect(row).toMatchObject({ billedSen: 64_750, expectedSen: 42_750 + 28_500 + 3_000, varianceSen: -9_500 });
  });
});
