// One binding per supplier per item (B28, sister Houzs-IT/Conts-ERP#689). MRP
// lists every binding row, so a supplier bound to the same SKU twice showed
// twice for that item. The route pre-check is the readable refusal; the unique
// index from 20261110T0400 backs it. Same bare-Hono harness as
// supplierBindingAcItemCode.test.ts.
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import {
  createSupplierBindingHandler,
  createSupplierBindingsBatchHandler,
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
  constructor(private rows: Row[], private seq: { n: number }, private writeErr: Row | null = null) {}
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
  private failed() { return this.writeErr && this.op !== 'select' ? { data: null, error: this.writeErr } : null; }
  maybeSingle() { const f = this.failed(); if (f) return Promise.resolve(f); const h = this.run(); return Promise.resolve({ data: h[0] ?? null, error: null }); }
  single() {
    const f = this.failed(); if (f) return Promise.resolve(f);
    const h = this.run();
    return Promise.resolve({ data: h[0] ?? null, error: h.length ? null : { message: 'no rows' } });
  }
  then(res: (v: any) => any, rej?: (e: any) => any) {
    const f = this.failed(); if (f) return Promise.resolve(f).then(res, rej);
    return Promise.resolve({ data: this.run(), error: null }).then(res, rej);
  }
}

function harness(tables: Record<string, Row[]>, companyId: number | undefined, bindingWriteErr: Row | null = null) {
  const seq = { n: 0 };
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, {
      from: (t: string) => new FakeQuery((tables[t] ||= []), seq, t === 'supplier_material_bindings' ? bindingWriteErr : null),
      rpc: async () => ({ data: true, error: null }),
    } as never);
    c.set('companyId' as never, companyId as never);
    c.set('user' as never, { id: 'SYSTEM-STAFF-UUID' } as never);
    c.set('houzsUser' as never, { id: 9, name: 'Tester', email: 't@houzs.my', permissions_set: new Set(['*']) } as never);
    await next();
  });
  app.post('/suppliers/:id/bindings', createSupplierBindingHandler as never);
  app.patch('/suppliers/:id/bindings/:bindingId', patchSupplierBindingHandler as never);
  app.post('/suppliers/:id/bindings/batch', createSupplierBindingsBatchHandler as never);
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

const BODY = {
  materialKind: 'mfg_product', itemCode: '1003-(K)',
  materialName: 'HILTON BEDFRAME (6FT)', supplierSku: 'H-1003', unitPriceSen: 5000,
};

const bound = (over: Row = {}): Row => ({
  id: 'b-1', supplier_id: 'sup-a', company_id: CO_A, material_kind: 'mfg_product',
  item_code: '1003-(K)', material_name: 'HILTON', supplier_sku: 'H-1003',
  unit_price_sen: 5000, currency: 'MYR', is_cost_anchor: false, is_main_supplier: false, ...over,
});

const tables = (rows: Row[]): Record<string, Row[]> => ({
  suppliers: [{ id: 'sup-a', company_id: CO_A }, { id: 'sup-b', company_id: CO_A }, { id: 'sup-x', company_id: CO_B }],
  supplier_material_bindings: rows,
});

describe('supplier binding duplicates — create', () => {
  test('refuses a second binding of the same supplier to the same item', async () => {
    const t = tables([bound()]);
    const res = await post(harness(t, CO_A).app, 'sup-a', BODY);
    expect(res.status).toBe(409);
    const j = await res.json() as Row;
    expect(j.error).toBe('duplicate_binding');
    expect(j.bindingId).toBe('b-1');
    expect(j.message).toMatch(/already bound/);
    expect(t.supplier_material_bindings).toHaveLength(1);
  });

  test('another supplier may bind the same item', async () => {
    const t = tables([bound()]);
    const res = await post(harness(t, CO_A).app, 'sup-b', BODY);
    expect(res.status).toBe(201);
    expect(t.supplier_material_bindings).toHaveLength(2);
  });

  test('the same supplier may bind a different item', async () => {
    const t = tables([bound()]);
    const res = await post(harness(t, CO_A).app, 'sup-a', { ...BODY, itemCode: '1004-(Q)' });
    expect(res.status).toBe(201);
  });

  test('another company\'s row with the same supplier id and item does not block (company-scoped)', async () => {
    const t = tables([bound({ id: 'b-other', company_id: CO_B })]);
    const res = await post(harness(t, CO_A).app, 'sup-a', BODY);
    expect(res.status).toBe(201);
  });
});

describe('supplier binding duplicates — PATCH', () => {
  test('refuses re-pointing a binding onto an item the supplier already has', async () => {
    const t = tables([bound(), bound({ id: 'b-2', item_code: '1004-(Q)' })]);
    const res = await patch(harness(t, CO_A).app, 'sup-a', 'b-2', { itemCode: '1003-(K)' });
    expect(res.status).toBe(409);
    expect((await res.json() as Row).error).toBe('duplicate_binding');
    expect(t.supplier_material_bindings[1]!.item_code).toBe('1004-(Q)');
  });

  test('saving a binding with its own item code is not a duplicate of itself', async () => {
    const t = tables([bound()]);
    const res = await patch(harness(t, CO_A).app, 'sup-a', 'b-1', { itemCode: '1003-(K)', unitPriceSen: 6000 });
    expect(res.status).toBe(200);
  });
});

describe('supplier binding duplicates — batch', () => {
  test('skips an item already bound and a repeat inside the batch', async () => {
    const t = tables([bound()]);
    const res = await harness(t, CO_A).app.request('/suppliers/sup-a/bindings/batch', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bindings: [BODY, { ...BODY, itemCode: '1004-(Q)' }, { ...BODY, itemCode: '1004-(Q)' }] }),
    });
    expect(res.status).toBe(201);
    const j = await res.json() as Row;
    expect(j.inserted).toBe(1);
    expect(j.skipped).toBe(2);
    expect(t.supplier_material_bindings.filter((r) => r.supplier_id === 'sup-a' && r.item_code === '1004-(Q)')).toHaveLength(1);
  });
});

/* The unique index (20261110T0400) catches a duplicate the pre-check could not
   see, e.g. two creates racing. Postgres answers 23505; the operator must get the
   same 409 as the pre-check gives, not a 500. */
describe('supplier binding duplicates — the database refuses', () => {
  const UNIQUE = { code: '23505', message: 'duplicate key value violates unique constraint "supplier_material_bindings_one_per_item_uq"' };
  test('create: 23505 answers 409 duplicate_binding', async () => {
    const res = await post(harness(tables([]), CO_A, UNIQUE).app, 'sup-a', BODY);
    expect(res.status).toBe(409);
    expect(((await res.json()) as Row).error).toBe('duplicate_binding');
  });
  test('patch: 23505 answers 409 duplicate_binding', async () => {
    const t = tables([bound()]);
    const res = await patch(harness(t, CO_A, UNIQUE).app, 'sup-a', 'b-1', { unitPriceSen: 6000 });
    expect(res.status).toBe(409);
    expect(((await res.json()) as Row).error).toBe('duplicate_binding');
  });
  test('batch: 23505 answers 409 duplicate_binding', async () => {
    const res = await harness(tables([]), CO_A, UNIQUE).app.request('/suppliers/sup-a/bindings/batch', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bindings: [BODY] }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as Row).error).toBe('duplicate_binding');
  });
});
