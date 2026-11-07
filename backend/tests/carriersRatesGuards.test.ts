/* Carriers & Rates audit (2026-11-07), on the real handlers over fake PostgREST:
     • keying in a DO a 3PL already has a row for no longer overwrites it in
       silence — 409 already_keyed with what is there; replace: true replaces;
     • a 3PL company that has a rate card cannot be deleted (the FK would null
       the card's carrier and show it as own fleet); one without a card can;
     • a card moved to a carrier takes that carrier's name, and a carrier from
       another company is refused. */
import { describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../src/scm/middleware/auth', () => ({
  supabaseAuth: async (_c: unknown, next: () => Promise<void>) => { await next(); },
}));

import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { threeplDoCharges } from '../src/scm/routes/threepl-do-charges';
import { threeplCompanies } from '../src/scm/routes/threepl-companies';
import { deliveryRateCards } from '../src/scm/routes/delivery-rate-cards';

const CO = 1;
function harness(extra: Partial<Record<string, Row[]>> = {}) {
  const sb = fakeSb({
    threepl_companies: [
      { id: 'car-msj', company_id: CO, name: 'MSJ TRANSPORT', is_active: true },
      { id: '22222222-2222-4222-8222-222222222222', company_id: CO, name: 'EU LOGISTICS', is_active: true },
      { id: '33333333-3333-4333-8333-333333333333', company_id: 2, name: 'OTHER CO CARRIER', is_active: true },
    ],
    delivery_orders: [{ id: 'do-1', company_id: CO, do_number: 'HC-DO-1', status: 'DELIVERED' }],
    threepl_do_charges: [],
    delivery_rate_cards: [],
    delivery_rate_rules: [],
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
  app.route('/threepl-do-charges', threeplDoCharges as unknown as Hono);
  app.route('/threepl-companies', threeplCompanies as unknown as Hono);
  app.route('/delivery-rate-cards', deliveryRateCards as unknown as Hono);
  const req = (path: string, method: string, body?: unknown) =>
    app.request(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }, {});
  return { req, tables: (sb as unknown as { tables: Record<string, Row[]> }).tables };
}

const KEY = { doNumber: 'HC-DO-1', threeplCompanyId: 'car-msj', invoiceNo: 'INV-1', invoiceDate: '2026-11-01', billedSen: 12000, note: '' };

describe('keying in a 3PL bill for a DO that already has one', () => {
  test('warns with what is there instead of overwriting, and replaces when told to', async () => {
    const { req, tables } = harness();
    expect((await req('/threepl-do-charges', 'PUT', KEY)).status).toBe(201);
    const again = await req('/threepl-do-charges', 'PUT', { ...KEY, invoiceNo: 'INV-2', billedSen: 9000 });
    expect(again.status).toBe(409);
    const body = await again.json() as { error: string; existing: { billedSen: number; invoiceNo: string } };
    expect(body.error).toBe('already_keyed');
    expect(body.existing).toEqual({ billedSen: 12000, invoiceNo: 'INV-1' });
    expect(tables.threepl_do_charges.map((r) => r.billed_sen)).toEqual([12000]);

    expect((await req('/threepl-do-charges', 'PUT', { ...KEY, invoiceNo: 'INV-2', billedSen: 9000, replace: true })).status).toBe(201);
    expect(tables.threepl_do_charges.map((r) => [r.invoice_no, r.billed_sen])).toEqual([['INV-2', 9000]]);
  });

  test('another 3PL on the same DO is its own row, no warning', async () => {
    const { req } = harness();
    expect((await req('/threepl-do-charges', 'PUT', KEY)).status).toBe(201);
    expect((await req('/threepl-do-charges', 'PUT', { ...KEY, threeplCompanyId: '22222222-2222-4222-8222-222222222222' })).status).toBe(201);
  });
});

describe('deleting a 3PL company', () => {
  test('refused while it has a rate card, so the card never loses its carrier', async () => {
    const { req, tables } = harness({ delivery_rate_cards: [{ id: 'card-1', company_id: CO, name: 'MSJ TRANSPORT', carrier_company_id: 'car-msj', is_own_fleet: false }] });
    const res = await req('/threepl-companies/car-msj', 'DELETE');
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('has_rate_card');
    expect(tables.threepl_companies.some((r) => r.id === 'car-msj')).toBe(true);
  });

  test('allowed when it has none', async () => {
    const { req, tables } = harness();
    expect((await req('/threepl-companies/22222222-2222-4222-8222-222222222222', 'DELETE')).status).toBe(200);
    expect(tables.threepl_companies.some((r) => r.id === '22222222-2222-4222-8222-222222222222')).toBe(false);
  });
});

describe('moving a card to a carrier', () => {
  const ORPHAN: Row = {
    id: 'card-9', company_id: CO, name: 'GONE TRANSPORT', carrier_lorry_id: null, carrier_company_id: null, carrier_label: null,
    is_own_fleet: false, basis: 'SET', aggregation: 'UNIT', min_charge_sen: null, cap_sen: null, rounding: 'NONE', is_active: true,
    notes: null, created_at: '2026-11-01', updated_at: '2026-11-01',
  };
  test('takes the carrier name and leaves own fleet', async () => {
    const { req } = harness({ delivery_rate_cards: [ORPHAN] });
    const res = await req('/delivery-rate-cards/card-9', 'PATCH', { carrierCompanyId: '22222222-2222-4222-8222-222222222222' });
    expect(res.status).toBe(200);
    const { card } = await res.json() as { card: { name: string; carrierCompanyId: string; isOwnFleet: boolean } };
    expect([card.name, card.carrierCompanyId, card.isOwnFleet]).toEqual(['EU LOGISTICS', '22222222-2222-4222-8222-222222222222', false]);
  });

  test('a carrier of another company is refused', async () => {
    const { req } = harness({ delivery_rate_cards: [ORPHAN] });
    expect((await req('/delivery-rate-cards/card-9', 'PATCH', { carrierCompanyId: '33333333-3333-4333-8333-333333333333' })).status).toBe(404);
  });
});
