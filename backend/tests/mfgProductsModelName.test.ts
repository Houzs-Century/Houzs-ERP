import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { listMfgProductsHandler } from '../src/scm/routes/mfg-products';

/* 2990-0022 — the SKU Master Model column and filter must follow a model
   rename. mfg_products.base_model is a text copy of the model CODE and never
   changes on rename; the list now also returns the model's live name (read
   through the model_id join) as `model_name`. */

class FakeQuery {
  private preds: Array<(r: Record<string, unknown>) => boolean> = [];
  private _range: [number, number] | null = null;
  constructor(private rows: Array<Record<string, unknown>>) {}
  select() { return this; }
  order() { return this; }
  or() { return this; }
  eq(col: string, val: unknown) { this.preds.push((r) => String(r[col]) === String(val)); return this; }
  range(from: number, to: number) { this._range = [from, to]; return this; }
  then(res: (v: { data: unknown[]; error: null }) => unknown, rej?: (e: unknown) => unknown) {
    let out = this.rows.filter((r) => this.preds.every((p) => p(r)));
    if (this._range) out = out.slice(this._range[0], this._range[1] + 1);
    return Promise.resolve({ data: out, error: null as null }).then(res, rej);
  }
}

const rows = [
  { id: 'a', code: '8210-3S', name: 'SOFA 8210 3S', category: 'SOFA', status: 'ACTIVE', company_id: 1, base_model: '8210', model_id: 'm8210', model: { name: 'TANNAH', allowed_options: null, default_variants: null, active: true } },
  { id: 'b', code: 'ORPHAN-1', name: 'No model', category: 'SOFA', status: 'ACTIVE', company_id: 1, base_model: '9999', model_id: null },
];

async function list() {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, { from: () => new FakeQuery(rows) } as never);
    c.set('companyId' as never, 1 as never);
    c.set('allowedCompanyIds' as never, [1] as never);
    await next();
  });
  app.get('/mfg-products', listMfgProductsHandler as never);
  const res = await app.request('/mfg-products');
  return ((await res.json()) as { products: Array<Record<string, unknown>> }).products;
}

describe('GET /mfg-products returns the live model name', () => {
  test('a SKU on a renamed model carries the new name and keeps base_model as the code key', async () => {
    const p = (await list()).find((x) => x.code === '8210-3S')!;
    expect(p.model_name).toBe('TANNAH');
    expect(p.base_model).toBe('8210');
    expect(p).not.toHaveProperty('model');
  });

  test('a SKU with no model gets model_name null, not undefined', async () => {
    const p = (await list()).find((x) => x.code === 'ORPHAN-1')!;
    expect(p.model_name).toBeNull();
  });
});
