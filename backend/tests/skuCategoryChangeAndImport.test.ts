// SKU Master category + import rules (owner 2026-09-15).
//
// 「by right 它应该是每一个 category 我都可以换去不一样的 category」 — a model-less
// SKU moves to any other category; a SKU on a model still moves only with its
// model. 「我 import 的话肯定可以把 SKU 改成分类啊…也可以去更改它的 description」 —
// Import SKUs updates an EXISTING SKU's name (the screen's Description),
// category and the other filled columns, and a category it cannot read is
// reported instead of silently skipped.
//
// Harness: a bare Hono app mounting the EXPORTED handlers with a fake scm
// client, like destructiveGuardsRefuseUnreadableProbe.test.ts.
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { batchImportMfgProductsHandler, patchMfgProductHandler } from '../src/scm/routes/mfg-products';

const CO = 1;
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
  neq(col: string, val: unknown) { this.preds.push((r) => String(r[col]) !== String(val)); return this; }
  private run(): Row[] {
    if (this.op === 'insert') { this.rows.push(...this.inserted); return this.inserted; }
    const hit = this.rows.filter((r) => this.preds.every((p) => p(r)));
    if (this.op === 'update') for (const r of hit) Object.assign(r, this.patch);
    return hit;
  }
  maybeSingle() { return Promise.resolve({ data: this.run()[0] ?? null, error: null }); }
  then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) {
    const hit = this.run();
    return Promise.resolve({ data: hit, count: hit.length, error: null }).then(res, rej);
  }
}

function harness() {
  const tables: Record<string, Row[]> = {
    mfg_products: [
      { id: 'p-1', company_id: CO, code: '810 BOLSTER', name: 'RDS BOLSTER 810', category: 'ACCESSORY', model_id: null, description: null },
      { id: 'p-2', company_id: CO, code: 'SOFA-1', name: 'SOFA ONE', category: 'SOFA', model_id: null },
      { id: 'p-3', company_id: CO, code: 'BC04', name: 'BACK CUSHION 04', category: 'ACCESSORY', model_id: 'm-1' },
      { id: 'p-9', company_id: 2, code: '810 BOLSTER', name: 'other company', category: 'ACCESSORY', model_id: null },
    ],
    master_price_history: [],
  };
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, { from: (t: string) => new FakeQuery((tables[t] ||= [])) } as never);
    c.set('companyId' as never, CO as never);
    c.set('user' as never, { id: 'u1' } as never);
    c.set('houzsUser' as never, { id: 9, name: 'Tester', permissions_set: new Set(['*']) } as never);
    await next();
  });
  app.patch('/mfg-products/:id', patchMfgProductHandler as never);
  app.post('/mfg-products/batch-import', batchImportMfgProductsHandler as never);
  const send = (method: string, path: string, body: unknown) => app.request(path, {
    method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
  });
  const sku = (id: string) => tables.mfg_products.find((r) => r.id === id)!;
  return { send, sku };
}

describe('PATCH /mfg-products/:id — category', () => {
  test('an accessory can become a sofa, and a sofa a mattress', async () => {
    const { send, sku } = harness();
    expect((await send('PATCH', '/mfg-products/p-1', { category: 'SOFA' })).status).toBe(200);
    expect(sku('p-1').category).toBe('SOFA');
    expect((await send('PATCH', '/mfg-products/p-2', { category: 'mattress' })).status).toBe(200);
    expect(sku('p-2').category).toBe('MATTRESS');
  });

  test('a SKU on a model still moves only with its model', async () => {
    const { send, sku } = harness();
    const res = await send('PATCH', '/mfg-products/p-3', { category: 'FABRIC_ACCESSORY' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('category_on_model');
    expect(sku('p-3').category).toBe('ACCESSORY');
  });

  test('a value that is not a category is refused and nothing is written', async () => {
    const { send, sku } = harness();
    const res = await send('PATCH', '/mfg-products/p-1', { category: 'CHAIR' });
    expect(res.status).toBe(409);
    expect(sku('p-1').category).toBe('ACCESSORY');
  });
});

describe('POST /mfg-products/batch-import — editing existing SKUs', () => {
  test('description (name), category and sub-description change on an existing code, this company only', async () => {
    const { send, sku } = harness();
    const res = await send('POST', '/mfg-products/batch-import', {
      rows: [{ code: '810 BOLSTER', name: 'BOLSTER 810', category: 'FABRIC_ACCESSORY', description: 'round' }],
    });
    expect(((await res.json()) as { upserted: number }).upserted).toBe(1);
    expect(sku('p-1')).toMatchObject({ name: 'BOLSTER 810', category: 'FABRIC_ACCESSORY', description: 'round' });
    expect(sku('p-9')).toMatchObject({ name: 'other company', category: 'ACCESSORY' });
  });

  test('a category typed as its label or in lower case is understood', async () => {
    const { send, sku } = harness();
    await send('POST', '/mfg-products/batch-import', {
      rows: [
        { code: '810 BOLSTER', category: 'Sofa Accessory' },
        { code: 'SOFA-1', category: 'mattress' },
      ],
    });
    expect(sku('p-1').category).toBe('FABRIC_ACCESSORY');
    expect(sku('p-2').category).toBe('MATTRESS');
  });

  test('a category it cannot read is REPORTED, not silently skipped', async () => {
    const { send, sku } = harness();
    const res = await send('POST', '/mfg-products/batch-import', {
      rows: [{ code: '810 BOLSTER', name: 'BOLSTER 810', category: 'Chair' }],
    });
    const out = (await res.json()) as { upserted: number; failed: number; failures: Array<{ reason: string }> };
    expect(out.upserted).toBe(0);
    expect(out.failed).toBe(1);
    expect(out.failures[0]!.reason).toMatch(/"Chair" is not a category/);
    expect(sku('p-1')).toMatchObject({ name: 'RDS BOLSTER 810', category: 'ACCESSORY' });
  });

  test('a blank category or name leaves the stored value alone', async () => {
    const { send, sku } = harness();
    await send('POST', '/mfg-products/batch-import', { rows: [{ code: '810 BOLSTER', name: '', category: '', base_price_sen: 12300 }] });
    expect(sku('p-1')).toMatchObject({ name: 'RDS BOLSTER 810', category: 'ACCESSORY', base_price_sen: 12300 });
  });
});
