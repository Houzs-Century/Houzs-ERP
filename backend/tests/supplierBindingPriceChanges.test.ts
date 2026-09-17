// B1 (2026-09-17) — effective-dated supplier price timeline. Covers the two
// binding price-change handlers:
//   • append one immutable history row,
//   • AUTO-BASELINE — the first FUTURE price for a binding with no history also
//     snapshots the current flat cost at today,
//   • append-only — a second scheduled price never rewrites the first,
//   • company scoping — a caller cannot read/append another company's binding,
//   • validation — bad date / negative price refuse.
//
// Bare-Hono harness (same shape as supplierBindingAcItemCode.test.ts): a fake
// scm supabase client + company/user context, mounting the EXPORTED handlers.
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import {
  listBindingPriceChangesHandler,
  createBindingPriceChangeHandler,
} from '../src/scm/routes/suppliers';
import { todayMyt } from '../src/scm/lib/my-time';

const CO_A = 1;
const CO_B = 2;
const TODAY = todayMyt();
const FUTURE = '2099-01-01';

type Row = Record<string, any>;

class FakeQuery {
  private preds: Array<(r: Row) => boolean> = [];
  private op: 'select' | 'update' | 'delete' | 'insert' = 'select';
  private inserted: Row[] = [];
  constructor(private rows: Row[], private seq: { n: number }) {}
  select() { return this; }
  order() { return this; }
  limit() { return this; }
  update() { this.op = 'update'; return this; }
  delete() { this.op = 'delete'; return this; }
  insert(p: Row | Row[]) {
    this.op = 'insert';
    const arr = Array.isArray(p) ? p : [p];
    this.inserted = arr.map((r) => ({
      id: r.id ?? `row-${++this.seq.n}`,
      created_at: r.created_at ?? new Date(2020, 0, 1, 0, 0, this.seq.n).toISOString(),
      ...r,
    }));
    return this;
  }
  eq(col: string, val: unknown) { this.preds.push((r) => String(r[col]) === String(val)); return this; }
  neq(col: string, val: unknown) { this.preds.push((r) => String(r[col]) !== String(val)); return this; }
  in(col: string, vals: unknown[]) { const s = new Set((vals ?? []).map(String)); this.preds.push((r) => s.has(String(r[col]))); return this; }
  lte() { return this; }
  gte() { return this; }
  gt() { return this; }
  lt() { return this; }
  not() { return this; }
  like() { return this; }
  ilike() { return this; }
  is() { return this; }
  or() { return this; }
  private run(): Row[] {
    if (this.op === 'insert') { this.rows.push(...this.inserted); return this.inserted; }
    return this.rows.filter((r) => this.preds.every((p) => p(r)));
  }
  maybeSingle() { const h = this.run(); return Promise.resolve({ data: h[0] ?? null, error: null }); }
  single() { const h = this.run(); return Promise.resolve({ data: h[0] ?? null, error: h.length ? null : { message: 'no rows' } }); }
  then(res: (v: any) => any, rej?: (e: any) => any) { return Promise.resolve({ data: this.run(), error: null }).then(res, rej); }
}

function harness(tables: Record<string, Row[]>, companyId: number | undefined) {
  const seq = { n: 0 };
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, { from: (t: string) => new FakeQuery((tables[t] ||= []), seq), rpc: async () => ({ data: true, error: null }) } as never);
    c.set('companyId' as never, companyId as never);
    c.set('user' as never, { id: 'SYSTEM-STAFF-UUID' } as never);
    c.set('houzsUser' as never, { id: 9, name: 'Tester', email: 't@houzs.my', permissions_set: new Set(['*']) } as never);
    await next();
  });
  app.get('/suppliers/:id/bindings/:bindingId/price-changes', listBindingPriceChangesHandler as never);
  app.post('/suppliers/:id/bindings/:bindingId/price-changes', createBindingPriceChangeHandler as never);
  return { app };
}

const seed = (): Record<string, Row[]> => ({
  suppliers: [{ id: 'sup-a', company_id: CO_A }],
  supplier_material_bindings: [{
    id: 'b-1', supplier_id: 'sup-a', company_id: CO_A, material_kind: 'mfg_product',
    item_code: 'ACC-1', unit_price_sen: 5000, price_matrix: null, is_main_supplier: true,
  }],
  supplier_binding_price_history: [],
});

const post = (app: Hono, body: Row) =>
  app.request('/suppliers/sup-a/bindings/b-1/price-changes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const get = (app: Hono) => app.request('/suppliers/sup-a/bindings/b-1/price-changes');

describe('B1 supplier binding price-changes — write', () => {
  test('scheduling the first FUTURE price auto-baselines the current cost', async () => {
    const t = seed();
    const res = await post(harness(t, CO_A).app, { effectiveFrom: FUTURE, unitPriceSen: 7000 });
    expect(res.status).toBe(201);
    const j = await res.json() as Row;
    expect(j.baselined).toBe(true);
    const hist = t.supplier_binding_price_history;
    expect(hist.length).toBe(2); // baseline @ today + scheduled @ future
    const baseline = hist.find((r) => r.effective_from === TODAY);
    const future = hist.find((r) => r.effective_from === FUTURE);
    expect(baseline!.unit_price_sen).toBe(5000); // snapshot of current flat
    expect(future!.unit_price_sen).toBe(7000);
  });

  test('a second scheduled price does NOT baseline and leaves prior rows intact', async () => {
    const t = seed();
    await post(harness(t, CO_A).app, { effectiveFrom: FUTURE, unitPriceSen: 7000 });
    const before = t.supplier_binding_price_history.length;
    const res = await post(harness(t, CO_A).app, { effectiveFrom: '2099-06-01', unitPriceSen: 9000 });
    const j = await res.json() as Row;
    expect(j.baselined).toBe(false);
    expect(t.supplier_binding_price_history.length).toBe(before + 1);
    // the 7000 row is untouched (append-only)
    expect(t.supplier_binding_price_history.find((r) => r.effective_from === FUTURE)!.unit_price_sen).toBe(7000);
  });

  test('a today-dated price does not baseline', async () => {
    const t = seed();
    const res = await post(harness(t, CO_A).app, { effectiveFrom: TODAY, unitPriceSen: 6000 });
    expect((await res.json() as Row).baselined).toBe(false);
    expect(t.supplier_binding_price_history.length).toBe(1);
  });

  test('bad date and negative price refuse', async () => {
    const t = seed();
    expect((await post(harness(t, CO_A).app, { effectiveFrom: 'nope', unitPriceSen: 100 })).status).toBe(400);
    expect((await post(harness(t, CO_A).app, { effectiveFrom: FUTURE, unitPriceSen: -1 })).status).toBe(400);
    expect(t.supplier_binding_price_history.length).toBe(0);
  });

  test('cannot append to another company\'s binding', async () => {
    const t = seed();
    const res = await post(harness(t, CO_B).app, { effectiveFrom: FUTURE, unitPriceSen: 7000 });
    expect(res.status).toBe(404);
    expect(t.supplier_binding_price_history.length).toBe(0);
  });
});

describe('B1 supplier binding price-changes — read', () => {
  test('lists history + the current flat cost', async () => {
    const t = seed();
    await post(harness(t, CO_A).app, { effectiveFrom: FUTURE, unitPriceSen: 7000 });
    const res = await get(harness(t, CO_A).app);
    expect(res.status).toBe(200);
    const j = await res.json() as Row;
    expect(j.currentUnitPriceSen).toBe(5000);
    expect(j.history.length).toBe(2);
  });

  test('cannot read another company\'s binding', async () => {
    const t = seed();
    expect((await get(harness(t, CO_B).app)).status).toBe(404);
  });
});
