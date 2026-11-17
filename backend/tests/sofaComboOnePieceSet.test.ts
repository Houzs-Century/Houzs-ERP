// A combo that is ONE slot listing several codes can only ever cover one piece,
// yet every one in production carried a whole set's price, and costing charged
// it to that piece while the other pieces added their own cost (17 of 235
// 2990 multi-piece sofa orders, 2026-11-17). Every write that prices a combo
// refuses that shape; retiring one, or recomposing it into a proper set, is
// how it gets fixed and stays allowed.
//
// Same fake-PostgREST harness as crossTenantUncoveredLeaks.test.ts: a bare Hono
// app injects a fake scm supabase client and mounts the exported handlers.
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import {
  sofaComboApplyHandler, sofaComboCreateHandler, sofaComboPutHandler,
  sofaComboRecomposeHandler, sofaComboRetireHandler,
} from '../src/scm/routes/sofa-combos';

type Row = Record<string, any>;

class FakeQuery {
  private preds: Array<(r: Row) => boolean> = [];
  private op: 'select' | 'update' | 'delete' | 'insert' = 'select';
  private patch: Row = {};
  private inserted: Row[] = [];
  constructor(private rows: Row[]) {}
  select() { return this; }
  order() { return this; }
  limit() { return this; }
  range() { return this; }
  filter() { return this; }
  update(p: Row) { this.op = 'update'; this.patch = p; return this; }
  delete() { this.op = 'delete'; return this; }
  insert(p: Row | Row[]) { this.op = 'insert'; this.inserted = (Array.isArray(p) ? p : [p]).map((r, i) => ({ id: `new-${this.rows.length + i}`, deleted_at: null, ...r })); return this; }
  eq(col: string, val: unknown) { this.preds.push((r) => String(r[col]) === String(val)); return this; }
  in(col: string, vals: unknown[]) { const s = new Set((vals ?? []).map(String)); this.preds.push((r) => s.has(String(r[col]))); return this; }
  is(col: string, val: unknown) { this.preds.push((r) => (r[col] ?? null) === val); return this; }
  neq() { return this; }
  gte() { return this; }
  lte() { return this; }
  not() { return this; }
  or() { return this; }
  private run(): Row[] {
    if (this.op === 'insert') { this.rows.push(...this.inserted); return this.inserted; }
    const hit = this.rows.filter((r) => this.preds.every((p) => p(r)));
    if (this.op === 'update') for (const r of hit) Object.assign(r, this.patch);
    return hit;
  }
  maybeSingle() { const h = this.run(); return Promise.resolve({ data: h[0] ?? null, error: null }); }
  single() { const h = this.run(); return Promise.resolve({ data: h[0] ?? null, error: h.length ? null : { message: 'no rows' } }); }
  then(res: (v: any) => any, rej?: (e: any) => any) { return Promise.resolve({ data: this.run(), error: null }).then(res, rej); }
}

function harness(tables: Record<string, Row[]>) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, { from: (t: string) => new FakeQuery((tables[t] ||= [])), rpc: async () => ({ data: false, error: null }) } as never);
    c.set('companyId' as never, 2 as never);
    c.set('user' as never, { id: 'u1', user_metadata: { name: 'Tester' } } as never);
    c.set('houzsUser' as never, { id: 9, name: 'Tester', permissions_set: new Set(['*']) } as never);
    c.env = {} as never;
    await next();
  });
  app.post('/sofa-combos', sofaComboCreateHandler as never);
  app.put('/sofa-combos/:id', sofaComboPutHandler as never);
  app.post('/sofa-combos/apply', sofaComboApplyHandler as never);
  app.post('/sofa-combos/retire', sofaComboRetireHandler as never);
  app.post('/sofa-combos/recompose', sofaComboRecomposeHandler as never);
  return app;
}
const send = (app: Hono, method: string, url: string, body: Row) =>
  app.request(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

// 2990's LOTTI "2A + L" price as production stored it: one slot, four codes.
const ONE_SLOT = [['2A(LHF)', '2A(RHF)', 'L(LHF)', 'L(RHF)']];
const SET = [['2A(LHF)', '2A(RHF)'], ['L(LHF)', 'L(RHF)']];
const stored = (id: string, modules: string[][]): Row => ({
  id, company_id: 2, base_model: 'Lotti', modules, tier: 'PRICE_2', customer_id: null, supplier_id: null,
  prices_by_height: { 30: 175000 }, selling_prices_by_height: { 30: 175000 }, pwp_prices_by_height: {}, default_free_gifts: [],
  label: null, effective_from: '2026-09-26', created_at: '2026-09-26T07:36:05Z', deleted_at: null, notes: null,
});

describe('a combo priced as one piece carrying a whole set', () => {
  it('is refused on create, with a sentence the screen can show, and nothing is saved', async () => {
    const t: Record<string, Row[]> = { sofa_combo_pricing: [] };
    const res = await send(harness(t), 'POST', '/sofa-combos', {
      baseModel: 'Lotti', modules: ONE_SLOT, tier: 'PRICE_2', pricesByHeight: { 30: 175000 }, effectiveFrom: '2026-11-17',
    });
    expect(res.status).toBe(400);
    const body = await res.json() as Row;
    expect(body.error).toBe('combo_one_piece_set');
    expect(body.message).toMatch(/its own slot/);
    expect(body.message.length).toBeLessThan(200);
    expect(t.sofa_combo_pricing).toHaveLength(0);
  });

  it('is refused in a batch write (the Excel import), naming the item', async () => {
    const t: Record<string, Row[]> = { sofa_combo_pricing: [], suppliers: [] };
    const res = await send(harness(t), 'POST', '/sofa-combos/apply', {
      items: [{ baseModel: 'Lotti', modules: SET, tier: 'PRICE_2', supplierId: null, prices: { 30: 175000 }, effectiveFrom: '2026-11-17' },
        { baseModel: 'Lotti', modules: ONE_SLOT, tier: 'PRICE_2', supplierId: null, prices: { 30: 175000 }, effectiveFrom: '2026-11-17' }],
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'combo_one_piece_set', index: 1 });
    expect(t.sofa_combo_pricing).toHaveLength(0);
  });

  it('cannot be re-priced by an edit of an old row of that shape', async () => {
    const t: Record<string, Row[]> = { sofa_combo_pricing: [stored('old', ONE_SLOT)] };
    const res = await send(harness(t), 'PUT', '/sofa-combos/old', { pricesByHeight: { 30: 170000 }, effectiveFrom: '2026-11-17' });
    expect(res.status).toBe(400);
    expect(t.sofa_combo_pricing).toHaveLength(1);
  });

  it('cannot be the result of changing a combo\'s modules', async () => {
    const t: Record<string, Row[]> = { sofa_combo_pricing: [stored('set', SET)] };
    const res = await send(harness(t), 'POST', '/sofa-combos/recompose', { baseModel: 'Lotti', from: SET, to: ONE_SLOT, supplierId: null });
    expect(res.status).toBe(400);
    expect(t.sofa_combo_pricing.find((r) => r.id === 'set')!.deleted_at).toBeNull();
  });

  it('can still be fixed: recomposed into a proper set, keeping its price', async () => {
    const t: Record<string, Row[]> = { sofa_combo_pricing: [stored('old', ONE_SLOT)] };
    const res = await send(harness(t), 'POST', '/sofa-combos/recompose', { baseModel: 'Lotti', from: ONE_SLOT, to: SET, supplierId: null });
    expect(res.status).toBe(200);
    expect(t.sofa_combo_pricing.find((r) => r.id === 'old')!.deleted_at).toBeTruthy();
    const moved = t.sofa_combo_pricing.find((r) => r.id !== 'old')!;
    expect(moved.modules).toEqual(SET);
    expect(moved.prices_by_height).toEqual({ 30: 175000 });
  });

  it('can still be retired', async () => {
    const t: Record<string, Row[]> = { sofa_combo_pricing: [stored('old', ONE_SLOT)] };
    const res = await send(harness(t), 'POST', '/sofa-combos/retire', { items: [{ baseModel: 'Lotti', modules: ONE_SLOT }], supplierId: null });
    expect(res.status).toBe(200);
    expect(t.sofa_combo_pricing[0]!.deleted_at).toBeTruthy();
  });
});
