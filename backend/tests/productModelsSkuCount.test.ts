import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { listProductModelsHandler } from '../src/scm/routes/product-models';

/* 2990-0022 — Modular showed "0 SKUs" on a model that has 3. The per-model count
   read mfg_products in ONE request, and PostgREST answers at most 1000 rows to
   a request without a range: on a company with more than 1000 model-linked
   SKUs, every model whose SKUs fall past the first 1000 showed 0. */

type Row = Record<string, unknown>;
class Q {
  private preds: Array<(r: Row) => boolean> = [];
  private r: [number, number] | null = null;
  constructor(private rows: Row[]) {}
  select() { return this; }
  order() { return this; }
  not() { return this; }
  eq(col: string, val: unknown) { this.preds.push((x) => String(x[col]) === String(val)); return this; }
  in(col: string, vals: unknown[]) { this.preds.push((x) => vals.map(String).includes(String(x[col]))); return this; }
  range(a: number, b: number) { this.r = [a, b]; return this; }
  then(res: (v: { data: Row[]; error: null }) => unknown, rej?: (e: unknown) => unknown) {
    const hit = this.rows.filter((x) => this.preds.every((p) => p(x)));
    // the server's row cap: 1000 when no range was asked for
    const out = this.r ? hit.slice(this.r[0], this.r[1] + 1) : hit.slice(0, 1000);
    return Promise.resolve({ data: out, error: null as null }).then(res, rej);
  }
}

describe('GET /product-models — sku_count', () => {
  test('a model whose SKUs sit past the first 1000 rows still counts them', async () => {
    const models: Row[] = [
      { id: 'big', company_id: 1, model_code: 'AAA', name: 'BIG', category: 'SOFA' },
      { id: 'tannah', company_id: 1, model_code: '8210', name: 'TANNAH', category: 'SOFA' },
    ];
    const skus: Row[] = [];
    for (let i = 0; i < 1500; i++) skus.push({ model_id: 'big', company_id: 1 });
    for (const code of ['4FT', '6FT', '7FT']) skus.push({ model_id: 'tannah', company_id: 1, code });
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('supabase' as never, { from: (t: string) => new Q(t === 'product_models' ? models : skus) } as never);
      c.set('companyId' as never, 1 as never);
      c.set('allowedCompanyIds' as never, [1] as never);
      await next();
    });
    app.get('/product-models', listProductModelsHandler as never);
    const res = await app.request('/product-models');
    const out = ((await res.json()) as { models: Array<{ id: string; sku_count: number }> }).models;
    expect(out.find((m) => m.id === 'big')!.sku_count).toBe(1500);
    expect(out.find((m) => m.id === 'tannah')!.sku_count).toBe(3);
  });
});
