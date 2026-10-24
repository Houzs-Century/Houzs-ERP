// A new single-SKU product starts off 2990's POS tablet (owner 2026-10-24).
//
// 「当有新的 SKU 加进去的时候…by default 是 turn off，只有我们的人去 Modular turn
//  on POS 才会出现」 — a new company-2 SKU in a single-SKU category lands
// pos_active=false on every create path: the bare create, Import SKUs and a
// Model's Generate SKUs. A sofa / bedframe / mattress variant, and every other
// company, keep the column default. The Model is still created active, so the
// SKU Master, the SO picker and POs keep the SKU.
//
// Harness: the EXPORTED handlers on a bare Hono app with a fake scm client, like
// skuCategoryChangeAndImport.test.ts.
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { newSkuPosActive } from '../src/scm/lib/new-sku-pos-active';
import { batchImportMfgProductsHandler, createMfgProductHandler } from '../src/scm/routes/mfg-products';
import { generateModelSkusHandler } from '../src/scm/routes/product-models';

type Row = Record<string, unknown>;

class FakeQuery {
  private preds: Array<(r: Row) => boolean> = [];
  private op: 'select' | 'update' | 'insert' = 'select';
  private patch: Row = {};
  private inserted: Row[] = [];
  constructor(private rows: Row[]) {}
  select() { return this; }
  limit() { return this; }
  update(p: Row) { this.op = 'update'; this.patch = p; return this; }
  insert(p: Row | Row[]) { this.op = 'insert'; this.inserted = Array.isArray(p) ? p : [p]; return this; }
  eq(col: string, val: unknown) { this.preds.push((r) => String(r[col]) === String(val)); return this; }
  in(col: string, vals: unknown[]) { const s = new Set(vals.map(String)); this.preds.push((r) => s.has(String(r[col]))); return this; }
  neq(col: string, val: unknown) { this.preds.push((r) => String(r[col]) !== String(val)); return this; }
  private run(): Row[] {
    if (this.op === 'insert') { this.rows.push(...this.inserted); return this.inserted; }
    const hit = this.rows.filter((r) => this.preds.every((p) => p(r)));
    if (this.op === 'update') for (const r of hit) Object.assign(r, this.patch);
    return hit;
  }
  single() { return Promise.resolve({ data: this.run()[0] ?? null, error: null }); }
  maybeSingle() { return Promise.resolve({ data: this.run()[0] ?? null, error: null }); }
  then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) {
    const hit = this.run();
    return Promise.resolve({ data: hit, count: hit.length, error: null }).then(res, rej);
  }
}

function harness(companyId: number, seed: { mfg_products?: Row[]; product_models?: Row[] } = {}) {
  const tables: Record<string, Row[]> = {
    mfg_products: seed.mfg_products ?? [],
    product_models: seed.product_models ?? [],
  };
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, { from: (t: string) => new FakeQuery((tables[t] ||= [])) } as never);
    c.set('companyId' as never, companyId as never);
    c.set('user' as never, { id: 'u1' } as never);
    c.set('houzsUser' as never, { id: 9, name: 'Tester', permissions_set: new Set(['*']) } as never);
    await next();
  });
  app.post('/mfg-products', createMfgProductHandler as never);
  app.post('/mfg-products/batch-import', batchImportMfgProductsHandler as never);
  app.post('/product-models/:id/generate-skus', generateModelSkusHandler as never);
  const post = (path: string, body: unknown) => app.request(path, {
    method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
  });
  const sku = (code: string) => tables.mfg_products.find((r) => r.code === code && r.company_id === companyId);
  const modelOf = (code: string) => tables.product_models.find((m) => m.id === sku(code)?.model_id);
  return { post, sku, modelOf };
}

describe('newSkuPosActive', () => {
  test('company 2: a single-SKU category starts hidden, a variant category does not', () => {
    for (const cat of ['ACCESSORY', 'FABRIC_ACCESSORY', 'SERVICE', 'BEDLINES', 'carpet']) {
      expect(newSkuPosActive(2, cat)).toBe(false);
    }
    for (const cat of ['SOFA', 'BEDFRAME', 'MATTRESS']) expect(newSkuPosActive(2, cat)).toBe(true);
  });

  test('every other company keeps the default, and an unknown category is left alone', () => {
    expect(newSkuPosActive(1, 'ACCESSORY')).toBe(true);
    expect(newSkuPosActive(2, null)).toBe(true);
    expect(newSkuPosActive(2, 'CHAIR')).toBe(true);
  });
});

describe('POST /mfg-products', () => {
  test('a company-2 accessory lands hidden from the POS, its new Model active', async () => {
    const { post, sku, modelOf } = harness(2);
    expect((await post('/mfg-products', { code: 'PILLOW-SQ', name: 'SQUARE PILLOW', category: 'ACCESSORY' })).status).toBe(201);
    expect(sku('PILLOW-SQ')).toMatchObject({ status: 'ACTIVE', pos_active: false });
    expect(modelOf('PILLOW-SQ')).toMatchObject({ active: true, category: 'ACCESSORY' });
  });

  test('a company-2 mattress size and a company-1 accessory keep pos_active', async () => {
    const two = harness(2);
    await two.post('/mfg-products', { code: 'AKKA MATT (K)', name: 'AKKA MATTRESS', category: 'MATTRESS', baseModel: 'AKKA' });
    expect(two.sku('AKKA MATT (K)')?.pos_active).toBe(true);
    const one = harness(1);
    await one.post('/mfg-products', { code: 'PILLOW-SQ', name: 'SQUARE PILLOW', category: 'ACCESSORY' });
    expect(one.sku('PILLOW-SQ')?.pos_active).toBe(true);
  });
});

describe('POST /mfg-products/batch-import', () => {
  test('a new company-2 accessory row lands hidden; an edited row keeps what it had', async () => {
    const { post, sku } = harness(2, {
      mfg_products: [{ id: 'p-1', company_id: 2, code: '810 BOLSTER', name: 'BOLSTER', category: 'ACCESSORY', model_id: null, pos_active: true }],
    });
    const res = await post('/mfg-products/batch-import', {
      rows: [
        { code: 'DIFF-01', name: 'DIFFUSER 01', category: 'Diffuser' },
        { code: '810 BOLSTER', name: 'BOLSTER 810' },
      ],
    });
    expect(((await res.json()) as { upserted: number }).upserted).toBe(2);
    expect(sku('DIFF-01')).toMatchObject({ category: 'DIFFUSER', pos_active: false });
    expect(sku('810 BOLSTER')).toMatchObject({ name: 'BOLSTER 810', pos_active: true });
  });

  test('a new company-2 sofa module keeps pos_active', async () => {
    const { post, sku } = harness(2);
    await post('/mfg-products/batch-import', { rows: [{ code: 'ADDA-1A(LHF)', name: 'SOFA ADDA 1A(LHF)', category: 'SOFA', base_model: 'ADDA' }] });
    expect(sku('ADDA-1A(LHF)')?.pos_active).toBe(true);
  });
});

describe('POST /product-models/:id/generate-skus', () => {
  test("a company-2 accessory Model's one SKU lands hidden", async () => {
    const { post, sku } = harness(2, {
      product_models: [{ id: 'm-1', company_id: 2, model_code: 'RUG-01', name: 'RUG 01', category: 'CARPET', allowed_options: {}, branding: null }],
    });
    expect(((await (await post('/product-models/m-1/generate-skus', {})).json()) as { generated: number }).generated).toBe(1);
    expect(sku('RUG-01')).toMatchObject({ model_id: 'm-1', pos_active: false });
  });

  test("a company-2 bedframe Model's sizes keep pos_active", async () => {
    const { post, sku } = harness(2, {
      product_models: [{ id: 'm-2', company_id: 2, model_code: 'HILTON', name: 'HILTON', category: 'BEDFRAME', allowed_options: { sizes: ['K', 'Q'] }, branding: null }],
    });
    await post('/product-models/m-2/generate-skus', {});
    expect([sku('HILTON-(K)')?.pos_active, sku('HILTON-(Q)')?.pos_active]).toEqual([true, true]);
  });
});
