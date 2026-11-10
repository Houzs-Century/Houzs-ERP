// SKU import Status cell (sister-ERP gap review G20): "Active", "inactive" and
// any other case are accepted as the enum value; anything else is a readable
// row failure and is never sent to the database (where it failed the row with
// Postgres's "invalid input value for enum mfg_product_status").
//
// Harness: the exported handler on a bare Hono app with a fake scm client,
// copied from newSkuStartsOffPosTablet.test.ts.
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { batchImportMfgProductsHandler, createMfgProductHandler } from '../src/scm/routes/mfg-products';

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
  const post = (path: string, body: unknown) => app.request(path, {
    method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
  });
  const sku = (code: string) => tables.mfg_products.find((r) => r.code === code && r.company_id === companyId);
  const modelOf = (code: string) => tables.product_models.find((m) => m.id === sku(code)?.model_id);
  return { post, sku, modelOf };
}

describe('POST /mfg-products/batch-import Status cell', () => {
  test('"Active" and "inactive" are stored as ACTIVE / INACTIVE', async () => {
    const { post, sku } = harness(1, {
      mfg_products: [
        { id: 'p-1', company_id: 1, code: 'PILLOW-A', name: 'PILLOW A', category: 'ACCESSORY', model_id: null, status: 'INACTIVE' },
        { id: 'p-2', company_id: 1, code: 'PILLOW-B', name: 'PILLOW B', category: 'ACCESSORY', model_id: null, status: 'ACTIVE' },
      ],
    });
    const res = await post('/mfg-products/batch-import', {
      rows: [{ code: 'PILLOW-A', status: 'Active' }, { code: 'PILLOW-B', status: ' inactive ' }],
    });
    expect(((await res.json()) as { failures: unknown[] }).failures).toEqual([]);
    expect(sku('PILLOW-A')?.status).toBe('ACTIVE');
    expect(sku('PILLOW-B')?.status).toBe('INACTIVE');
  });

  test('an unknown status is a readable failure and the row is not written', async () => {
    const { post, sku } = harness(1, {
      mfg_products: [{ id: 'p-1', company_id: 1, code: 'PILLOW-A', name: 'PILLOW A', category: 'ACCESSORY', model_id: null, status: 'ACTIVE' }],
    });
    const res = await post('/mfg-products/batch-import', { rows: [{ code: 'PILLOW-A', name: 'RENAMED', status: 'Retired' }] });
    const body = (await res.json()) as { failures: Array<{ code: string; reason: string }> };
    expect(body.failures).toEqual([{ code: 'PILLOW-A', reason: 'status "Retired" is not a status — use Active or Inactive.' }]);
    expect(sku('PILLOW-A')).toMatchObject({ name: 'PILLOW A', status: 'ACTIVE' });
  });
});
