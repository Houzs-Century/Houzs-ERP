import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { listProductModelsHandler } from '../src/scm/routes/product-models';

/* Modular "SKUs" column. With every model uuid in ONE IN-list (771 on Houzs
   Century) the count read overran the URL, failed unchecked, and every model
   showed the amber "0 SKUs" orphan badge (CROWN, 6 SKUs, among them). Pinned:
     · counts are right when the model list is far past one URL's worth of ids;
     · another company's SKU is never counted;
     · a failed count read is null (unknown), never 0. */

const IN_LIST_LIMIT = 100; // stands in for the URL length a real IN-list overruns
const MAX_ROWS = 1000;

class FakeQuery {
  private preds: Array<(r: Record<string, unknown>) => boolean> = [];
  private window: [number, number] | null = null;
  private error: { message: string } | null = null;
  constructor(private rows: Array<Record<string, unknown>>, private failCounts: boolean) {}
  select() { return this; }
  order() { return this; }
  eq(col: string, val: unknown) { this.preds.push((r) => String(r[col]) === String(val)); return this; }
  not(col: string, op: string, val: unknown) { if (op === 'is' && val === null) this.preds.push((r) => r[col] != null); return this; }
  in(col: string, vals: unknown[]) {
    if (vals.length > IN_LIST_LIMIT || this.failCounts) this.error = { message: 'Bad Request' };
    const s = new Set(vals.map(String));
    this.preds.push((r) => s.has(String(r[col])));
    return this;
  }
  range(from: number, to: number) { this.window = [from, to]; return this; }
  then(res: (v: { data: unknown[] | null; error: { message: string } | null }) => unknown, rej?: (e: unknown) => unknown) {
    if (this.error) return Promise.resolve({ data: null, error: this.error }).then(res, rej);
    let out = this.rows.filter((r) => this.preds.every((p) => p(r)));
    const [from, to] = this.window ?? [0, out.length - 1];
    out = out.slice(from, Math.min(to + 1, from + MAX_ROWS));
    return Promise.resolve({ data: out, error: null }).then(res, rej);
  }
}

const MODELS = 300;
const tables = () => {
  const product_models = Array.from({ length: MODELS }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, model_code: `M${i}`, category: 'BEDFRAME', company_id: 1,
  }));
  // Model i carries i % 7 SKUs, so the total runs past one 1000-row page.
  const mfg_products = product_models.flatMap((m, i) =>
    Array.from({ length: i % 7 }, (_, k) => ({ id: `${m.id}-${k}`, model_id: m.id, company_id: 1 })));
  // Another company's SKU pointing at model 0 must not count.
  mfg_products.push({ id: 'other-co', model_id: product_models[0].id, company_id: 2 });
  return { product_models, mfg_products } as Record<string, Array<Record<string, unknown>>>;
};

async function listModels(failCounts: boolean) {
  const data = tables();
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, { from: (t: string) => new FakeQuery(data[t] ?? [], failCounts && t === 'mfg_products') } as never);
    c.set('companyId' as never, 1 as never);
    c.set('allowedCompanyIds' as never, [1, 2] as never);
    await next();
  });
  app.get('/product-models', listProductModelsHandler as never);
  const res = await app.request('/product-models');
  return (await res.json()) as { models: Array<{ model_code: string; sku_count: number | null }> };
}

describe('GET /product-models — SKU count per model', () => {
  test('counts are right across many more models than one IN-list can carry', async () => {
    const { models } = await listModels(false);
    expect(models).toHaveLength(MODELS);
    for (const m of models) expect(m.sku_count).toBe(Number(m.model_code.slice(1)) % 7);
  });

  test('a count read that fails is unknown (null), not an orphan 0', async () => {
    const { models } = await listModels(true);
    expect(models).toHaveLength(MODELS);
    expect(models.every((m) => m.sku_count === null)).toBe(true);
  });
});
