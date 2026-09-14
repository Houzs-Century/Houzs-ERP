import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { patchProductModelHandler } from '../src/scm/routes/product-models';

/* A model's category can be swapped between Accessory and Sofa Accessory from
   the edit dialog (owner 2026-09-14: 「我不能自己更换category吗？」), its SKUs
   move with it, and every other move is refused — on the server, not only in
   the screen. */

type Row = Record<string, unknown>;
class Q {
  private preds: Array<(r: Row) => boolean> = [];
  private patch: Row | null = null;
  constructor(private rows: Row[]) {}
  select() { return this; }
  eq(col: string, val: unknown) { this.preds.push((r) => String(r[col]) === String(val)); return this; }
  update(p: Row) { this.patch = p; return this; }
  private run() {
    const hit = this.rows.filter((r) => this.preds.every((p) => p(r)));
    if (this.patch) for (const r of hit) Object.assign(r, this.patch);
    return hit;
  }
  maybeSingle() { const h = this.run(); return Promise.resolve({ data: h[0] ?? null, error: null }); }
  then(res: (v: { data: Row[]; error: null }) => unknown, rej?: (e: unknown) => unknown) {
    return Promise.resolve({ data: this.run(), error: null as null }).then(res, rej);
  }
}

function setup(category: string) {
  const data: Record<string, Row[]> = {
    product_models: [
      { id: 'm1', company_id: 1, model_code: 'BC04', name: 'BACK CUSHION 04', category, allowed_options: {} },
      { id: 'm9', company_id: 2, model_code: 'BC04', name: 'other company', category, allowed_options: {} },
    ],
    mfg_products: [
      { id: 's1', company_id: 1, model_id: 'm1', code: 'BC04', category },
      { id: 's9', company_id: 2, model_id: 'm1', code: 'BC04', category },
    ],
  };
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, { from: (t: string) => new Q(data[t] ?? []) } as never);
    c.set('companyId' as never, 1 as never);
    await next();
  });
  app.patch('/product-models/:id', patchProductModelHandler as never);
  const patch = (body: Row) => app.request('/product-models/m1', {
    method: 'PATCH', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
  });
  return { data, patch };
}

describe('PATCH /product-models/:id — category swap', () => {
  test('Accessory -> Sofa Accessory moves the model and its SKUs in this company only', async () => {
    const { data, patch } = setup('ACCESSORY');
    const res = await patch({ category: 'FABRIC_ACCESSORY' });
    expect(res.status).toBe(200);
    expect(data.product_models[0].category).toBe('FABRIC_ACCESSORY');
    expect(data.mfg_products[0].category).toBe('FABRIC_ACCESSORY');
    expect(data.product_models[1].category).toBe('ACCESSORY');
    expect(data.mfg_products[1].category).toBe('ACCESSORY');
  });

  test('a sofa cannot be moved, and nothing is written', async () => {
    const { data, patch } = setup('SOFA');
    const res = await patch({ category: 'FABRIC_ACCESSORY' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('category_change_not_allowed');
    expect(data.product_models[0].category).toBe('SOFA');
    expect(data.mfg_products[0].category).toBe('SOFA');
  });

  test('an accessory cannot be moved into a main category', async () => {
    const { data, patch } = setup('ACCESSORY');
    const res = await patch({ category: 'MATTRESS' });
    expect(res.status).toBe(409);
    expect(data.mfg_products[0].category).toBe('ACCESSORY');
  });
});
