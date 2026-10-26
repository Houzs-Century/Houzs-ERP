// /special-addons — "Detect by compartment" (2990 owner 2026-10-26): a sofa
// add-on carries a price per compartment, edited from the 2990 POS.
//
// What is asserted: the codes are stored canonical (the pricing compares them
// exactly), a compartment cannot carry two prices, and the ERP Specials panel —
// which versions the WHOLE set through /save and has no compartment editor —
// cannot wipe them by saving.
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { Env, Variables } from '../env';
import { fakeSb } from '../lib/fake-postgrest';

// The router runs supabaseAuth first; the bridge cannot run here.
vi.mock('../middleware/auth', () => ({ supabaseAuth: async (_c: unknown, next: () => Promise<void>) => next() }));
import { specialAddons } from './special-addons';

type Row = Record<string, unknown>;

const liveRow = (over: Row = {}): Row => ({
  id: 'sa-1', company_id: 2, code: 'Latex Seat', label: 'Latex Seat', so_description: '',
  categories: ['SOFA'], selling_price_sen: 50000, cost_price_sen: 30000, option_groups: [],
  compartment_prices: [{ compartment: 'CNR', sellingPriceSen: 80000 }],
  active: true, sort_order: 0, created_at: '2026-10-26T00:00:00Z', updated_at: '2026-10-26T00:00:00Z',
  ...over,
});

function harness(rows: Row[]) {
  const tables: Record<string, Row[]> = { special_addons: rows, special_addons_history: [] };
  const sb = fakeSb(tables);
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('supabase', sb as unknown as Variables['supabase']);
    c.set('companyId', 2 as Variables['companyId']);
    c.set('user', { id: 'u1' } as unknown as Variables['user']);
    c.set('houzsUser', { id: 9, name: 'Tester', permissions_set: new Set(['scm.config.write']) } as unknown as Variables['houzsUser']);
    await next();
  });
  app.route('/special-addons', specialAddons);
  return { app, tables };
}

const send = (app: Hono<{ Bindings: Env; Variables: Variables }>, method: string, path: string, body: unknown) =>
  app.request(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const snapshotEntry = (over: Row = {}): Row => ({
  code: 'Latex Seat', label: 'Latex Seat', soDescription: '', categories: ['SOFA'],
  sellingPriceSen: 50000, costPriceSen: 32000, optionGroups: [], active: true, sortOrder: 0, ...over,
});

describe('compartment prices on /special-addons', () => {
  it('stores and returns canonical compartment codes', async () => {
    const { app, tables } = harness([]);
    const res = await send(app, 'POST', '/special-addons', {
      code: 'Latex Seat', label: 'Latex Seat', categories: ['SOFA'], sellingPriceSen: 50000,
      compartmentPrices: [{ compartment: ' L-LHF ', sellingPriceSen: 70000 }],
    });
    expect(res.status).toBe(201);
    expect(tables.special_addons![0]!.compartment_prices).toEqual([{ compartment: 'L(LHF)', sellingPriceSen: 70000 }]);
    const list = (await (await app.request('/special-addons')).json()) as { addons: Array<{ compartmentPrices: unknown }> };
    expect(list.addons[0]!.compartmentPrices).toEqual([{ compartment: 'L(LHF)', sellingPriceSen: 70000 }]);
  });

  it('refuses one compartment priced twice', async () => {
    const { app } = harness([liveRow()]);
    const res = await send(app, 'PATCH', '/special-addons/sa-1', {
      compartmentPrices: [{ compartment: 'CNR', sellingPriceSen: 80000 }, { compartment: 'CNR', sellingPriceSen: 90000 }],
    });
    expect(res.status).toBe(400);
  });

  it('a PATCH that does not mention them leaves them alone', async () => {
    const { app, tables } = harness([liveRow()]);
    expect((await send(app, 'PATCH', '/special-addons/sa-1', { label: 'Latex seat' })).status).toBe(200);
    expect(tables.special_addons![0]!.compartment_prices).toEqual([{ compartment: 'CNR', sellingPriceSen: 80000 }]);
  });

  it('a /save from the ERP Specials panel (no compartmentPrices) keeps the live ones — in the table and the history', async () => {
    const { app, tables } = harness([liveRow()]);
    const res = await send(app, 'POST', '/special-addons/save', { effectiveFrom: '2026-10-26', addons: [snapshotEntry()] });
    expect(res.status).toBe(201);
    expect(tables.special_addons![0]!.cost_price_sen).toBe(32000);
    expect(tables.special_addons![0]!.compartment_prices).toEqual([{ compartment: 'CNR', sellingPriceSen: 80000 }]);
    const snap = (tables.special_addons_history![0]!.addons as Row[])[0]!;
    expect(snap.compartmentPrices).toEqual([{ compartment: 'CNR', sellingPriceSen: 80000 }]);
  });

  it('a /save entry that carries them replaces them', async () => {
    const { app, tables } = harness([liveRow()]);
    const res = await send(app, 'POST', '/special-addons/save', { effectiveFrom: '2026-10-26', addons: [snapshotEntry({ compartmentPrices: [] })] });
    expect(res.status).toBe(201);
    expect(tables.special_addons![0]!.compartment_prices).toEqual([]);
  });
});
