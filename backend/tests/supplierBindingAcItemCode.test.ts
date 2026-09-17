// B4 (2026-09-17) — the AutoCount item code (ac_item_code) threads through the
// supplier-binding create + PATCH handlers, and stays company-scoped.
//
// Same bare-Hono harness as mfgProductPriceChanges.test.ts: middleware injects a
// fake scm supabase client + company/user context and mounts the EXPORTED
// handlers directly. The auto-derive flag row is absent, so afterBindingWrite
// takes the flag-OFF fallback (a no-op for a non-anchor binding).
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import {
  createSupplierBindingHandler,
  patchSupplierBindingHandler,
} from '../src/scm/routes/suppliers';

const CO_A = 1; // HOUZS
const CO_B = 2; // 2990

type Row = Record<string, any>;

/* Fake PostgREST builder. Chains like supabase-js; unknown tables read empty.
   Unlike the read-only fakes, update() APPLIES the patch to matched rows so a
   round-trip through PATCH can be asserted. */
class FakeQuery {
  private preds: Array<(r: Row) => boolean> = [];
  private op: 'select' | 'update' | 'delete' | 'insert' = 'select';
  private patch: Row = {};
  private inserted: Row[] = [];
  constructor(private rows: Row[], private seq: { n: number }) {}
  select() { return this; }
  order() { return this; }
  limit() { return this; }
  update(p: Row) { this.op = 'update'; this.patch = p; return this; }
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
  in(col: string, vals: unknown[]) {
    const s = new Set((vals ?? []).map(String));
    this.preds.push((r) => s.has(String(r[col])));
    return this;
  }
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
    const hit = this.rows.filter((r) => this.preds.every((p) => p(r)));
    if (this.op === 'update') { for (const r of hit) Object.assign(r, this.patch); }
    return hit;
  }
  maybeSingle() { const h = this.run(); return Promise.resolve({ data: h[0] ?? null, error: null }); }
  single() {
    const h = this.run();
    return Promise.resolve({ data: h[0] ?? null, error: h.length ? null : { message: 'no rows' } });
  }
  then(res: (v: any) => any, rej?: (e: any) => any) {
    return Promise.resolve({ data: this.run(), error: null }).then(res, rej);
  }
}

function harness(tables: Record<string, Row[]>, companyId: number | undefined) {
  const seq = { n: 0 };
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, {
      from: (t: string) => new FakeQuery((tables[t] ||= []), seq),
      rpc: async () => ({ data: true, error: null }),
    } as never);
    c.set('companyId' as never, companyId as never);
    c.set('user' as never, { id: 'SYSTEM-STAFF-UUID' } as never);
    c.set('houzsUser' as never, { id: 9, name: 'Tester', email: 't@houzs.my', permissions_set: new Set(['*']) } as never);
    await next();
  });
  app.post('/suppliers/:id/bindings', createSupplierBindingHandler as never);
  app.patch('/suppliers/:id/bindings/:bindingId', patchSupplierBindingHandler as never);
  return { app };
}

const post = (app: Hono, supplierId: string, body: Row) =>
  app.request(`/suppliers/${supplierId}/bindings`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
const patch = (app: Hono, supplierId: string, bindingId: string, body: Row) =>
  app.request(`/suppliers/${supplierId}/bindings/${bindingId}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

const CREATE_BODY = {
  materialKind: 'mfg_product', itemCode: '1003-(K)', acItemCode: 'AC-1003',
  materialName: 'HILTON BEDFRAME (6FT)', supplierSku: 'H-1003', unitPriceSen: 5000,
};

describe('supplier binding ac_item_code — create', () => {
  test('persists ac_item_code on the created binding', async () => {
    const t: Record<string, Row[]> = {
      suppliers: [{ id: 'sup-a', company_id: CO_A }],
      supplier_material_bindings: [],
    };
    const res = await post(harness(t, CO_A).app, 'sup-a', CREATE_BODY);
    expect(res.status).toBe(201);
    const j = await res.json() as Row;
    expect(j.binding.ac_item_code).toBe('AC-1003');
    expect(t.supplier_material_bindings[0].ac_item_code).toBe('AC-1003');
  });

  test('null ac_item_code when omitted', async () => {
    const t: Record<string, Row[]> = {
      suppliers: [{ id: 'sup-a', company_id: CO_A }],
      supplier_material_bindings: [],
    };
    const { acItemCode, ...noAc } = CREATE_BODY;
    const res = await post(harness(t, CO_A).app, 'sup-a', noAc);
    expect(res.status).toBe(201);
    expect((await res.json() as Row).binding.ac_item_code).toBeNull();
  });

  test('cannot create a binding against another company\'s supplier', async () => {
    const t: Record<string, Row[]> = {
      suppliers: [{ id: 'sup-a', company_id: CO_A }],
      supplier_material_bindings: [],
    };
    const res = await post(harness(t, CO_B).app, 'sup-a', CREATE_BODY);
    expect(res.status).toBe(404);
    expect(t.supplier_material_bindings.length).toBe(0);
  });
});

describe('supplier binding ac_item_code — PATCH', () => {
  const seedBinding = (): Row => ({
    id: 'b-1', supplier_id: 'sup-a', company_id: CO_A, material_kind: 'mfg_product',
    item_code: '1003-(K)', ac_item_code: null, material_name: 'HILTON', supplier_sku: 'H-1003',
    unit_price_sen: 5000, currency: 'MYR', is_cost_anchor: false, is_main_supplier: false,
  });

  test('updates ac_item_code for the active company', async () => {
    const t: Record<string, Row[]> = {
      suppliers: [{ id: 'sup-a', company_id: CO_A }],
      supplier_material_bindings: [seedBinding()],
    };
    const res = await patch(harness(t, CO_A).app, 'sup-a', 'b-1', { acItemCode: 'AC-9999' });
    expect(res.status).toBe(200);
    expect((await res.json() as Row).binding.ac_item_code).toBe('AC-9999');
    expect(t.supplier_material_bindings[0].ac_item_code).toBe('AC-9999');
  });

  test('cannot PATCH another company\'s binding', async () => {
    const t: Record<string, Row[]> = {
      suppliers: [{ id: 'sup-a', company_id: CO_A }],
      supplier_material_bindings: [seedBinding()],
    };
    const res = await patch(harness(t, CO_B).app, 'sup-a', 'b-1', { acItemCode: 'AC-9999' });
    expect(res.status).toBe(404);
    expect(t.supplier_material_bindings[0].ac_item_code).toBeNull();
  });
});
