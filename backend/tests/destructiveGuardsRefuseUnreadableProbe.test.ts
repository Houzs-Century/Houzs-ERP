// A guard that could not look does not say "all clear".
//
// Three destructive routes were gated by a read whose PostgREST `error` was
// discarded, so the ONE state that authorises the destruction — "nothing found"
// — was also what a five-second database blip produced:
//
//   DELETE /mfg-products/:id   findSkuUsage's probes said "never sold" and the
//                              SKU was dropped; with ?force=true the same
//                              request also deletes its inventory_movements and
//                              supplier bindings, which is the stock history the
//                              guard's own header says must never be destroyed.
//   DELETE /categories/:id     `count ?? 0` folded a failed count to zero, the
//                              category_in_use check passed, and the category
//                              (plus its R2 hero blob) went.
//   PATCH  /mfg-products/:id   the duplicate-code probe read as "no duplicate",
//                              so a rename cascaded a second SKU's code across
//                              stock lots, movements, bindings and every
//                              document-line snapshot — referencing tables
//                              FIRST, so UNIQUE(company_id, code) on
//                              mfg_products only fires after they are merged.
//
// Each test below makes the guard's read REJECT and asserts the handler REFUSES
// **and the row is still there**. A status-only assertion would pass on a 409
// that had already deleted, so every one checks the table too.
//
// Harness: a bare Hono app mounting the EXPORTED handlers with a fake scm
// supabase client — the same shape and the same reason as
// companyScopeMastersConfig.test.ts (the supabaseAuth bridge cannot run here).
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { deleteMfgProductHandler, patchMfgProductHandler } from '../src/scm/routes/mfg-products';
import { deleteCategoryHandler } from '../src/scm/routes/categories';

const CO = 1;
type Row = Record<string, any>;

/** Tables named in `broken` answer every read with a PostgREST error — resolved,
 *  not thrown, exactly as supabase-js reports a failure.
 *
 *  `'<table>#neq'` breaks ONLY the queries on that table that used `.neq(...)`.
 *  The SKU rename needs it: PATCH /mfg-products/:id reads mfg_products twice —
 *  the current row (`.eq('id')`, which already binds its error and 500s) and
 *  then the duplicate probe (`.eq('code').neq('id')`, the one this file is
 *  about). Breaking the table wholesale would never reach the second read, and
 *  the test would pass on the wrong refusal. */
class FakeQuery {
  private preds: Array<(r: Row) => boolean> = [];
  private op: 'select' | 'update' | 'delete' | 'insert' = 'select';
  private patch: Row = {};
  private inserted: Row[] = [];
  private usedNeq = false;
  constructor(private rows: Row[], private table: string, private broken: Set<string>) {}
  select() { return this; }
  order() { return this; }
  limit() { return this; }
  range() { return this; }
  ilike() { return this; }
  update(p: Row) { this.op = 'update'; this.patch = p; return this; }
  delete() { this.op = 'delete'; return this; }
  insert(p: Row | Row[]) { this.op = 'insert'; this.inserted = Array.isArray(p) ? p : [p]; return this; }
  eq(col: string, val: unknown) { this.preds.push((r) => String(r[col]) === String(val)); return this; }
  neq(col: string, val: unknown) { this.usedNeq = true; this.preds.push((r) => String(r[col]) !== String(val)); return this; }
  in(col: string, vals: unknown[]) {
    const s = new Set((vals ?? []).map(String));
    this.preds.push((r) => s.has(String(r[col])));
    return this;
  }
  gte() { return this; } lte() { return this; } not() { return this; }
  like() { return this; } is() { return this; } or() { return this; }
  private failure() {
    const hit = this.broken.has(this.table)
      || (this.usedNeq && this.broken.has(`${this.table}#neq`));
    return hit ? { message: `connection reset (${this.table})` } : null;
  }
  private run(): Row[] {
    if (this.op === 'insert') { this.rows.push(...this.inserted); return this.inserted; }
    const hit = this.rows.filter((r) => this.preds.every((p) => p(r)));
    if (this.op === 'update') for (const r of hit) Object.assign(r, this.patch);
    if (this.op === 'delete') for (const r of hit) this.rows.splice(this.rows.indexOf(r), 1);
    return hit;
  }
  maybeSingle() {
    const err = this.failure();
    if (err) return Promise.resolve({ data: null, error: err });
    return Promise.resolve({ data: this.run()[0] ?? null, error: null });
  }
  single() {
    const err = this.failure();
    if (err) return Promise.resolve({ data: null, error: err });
    const h = this.run();
    return Promise.resolve({ data: h[0] ?? null, error: h.length ? null : { message: 'no rows' } });
  }
  then(res: (v: any) => any, rej?: (e: any) => any) {
    const err = this.failure();
    if (err) return Promise.resolve({ data: null, count: null, error: err }).then(res, rej);
    const hit = this.run();
    return Promise.resolve({ data: hit, count: hit.length, error: null }).then(res, rej);
  }
}

function harness(tables: Record<string, Row[]>, broken: string[] = []) {
  const app = new Hono();
  const brokenSet = new Set(broken);
  app.use('*', async (c, next) => {
    c.set('supabase' as never, {
      from: (t: string) => new FakeQuery((tables[t] ||= []), t, brokenSet),
      rpc: async () => ({ data: true, error: null }),
    } as never);
    c.set('companyId' as never, CO as never);
    c.set('user' as never, { id: 'u1' } as never);
    c.set('houzsUser' as never, { id: 9, name: 'Tester', permissions_set: new Set(['*']) } as never);
    await next();
  });
  app.delete('/mfg-products/:id', deleteMfgProductHandler as never);
  app.patch('/mfg-products/:id', patchMfgProductHandler as never);
  app.delete('/categories/:id', deleteCategoryHandler as never);
  return app;
}

const body = (res: Response) => res.json() as Promise<Row>;

// ── DELETE /mfg-products/:id — "has this SKU ever been used?" ────────────────
describe('SKU delete refuses when the usage probe could not run', () => {
  const tables = () => ({
    mfg_products: [{ id: 'p-1', code: 'SKU-1', company_id: CO, status: 'ACTIVE' }],
    mfg_sales_order_items: [] as Row[],
    purchase_order_items: [] as Row[],
    inventory_movements: [] as Row[],
    inventory_stock_lots: [] as Row[],
    supplier_material_bindings: [] as Row[],
  });

  test('a provably-unused SKU still deletes — the guard did not become a wall', async () => {
    const t = tables();
    const res = await harness(t).request('/mfg-products/p-1', { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(t.mfg_products).toHaveLength(0);
  });

  test('a used SKU is refused, as before', async () => {
    const t = tables();
    t.mfg_sales_order_items.push({ item_code: 'SKU-1', doc_no: 'HC-SO-1' });
    const res = await harness(t).request('/mfg-products/p-1', { method: 'DELETE' });
    expect(res.status).toBe(409);
    expect((await body(res)).error).toBe('sku_in_use');
    expect(t.mfg_products).toHaveLength(1);
  });

  /* THE REGRESSION. Before the fix this returned 204 and the row was gone. */
  test('an unreadable probe refuses and the SKU is STILL THERE', async () => {
    const t = tables();
    t.mfg_sales_order_items.push({ item_code: 'SKU-1', doc_no: 'HC-SO-1' });
    const res = await harness(t, ['mfg_sales_order_items']).request('/mfg-products/p-1', { method: 'DELETE' });
    expect(res.status).toBe(409);
    expect((await body(res)).error).toBe('usage_check_failed');
    expect(t.mfg_products).toHaveLength(1);
  });

  /* force=true is the dangerous one: it deletes the movements and bindings
     BEFORE dropping the SKU, so an unread probe costs stock history. */
  test('?force=true refuses too, and touches no side table', async () => {
    const t = tables();
    t.inventory_movements.push({ item_code: 'SKU-1', company_id: CO });
    t.supplier_material_bindings.push({ item_code: 'SKU-1', company_id: CO });
    const res = await harness(t, ['inventory_movements'])
      .request('/mfg-products/p-1?force=true', { method: 'DELETE' });
    expect(res.status).toBe(409);
    expect((await body(res)).error).toBe('usage_check_failed');
    expect(t.mfg_products).toHaveLength(1);
    expect(t.inventory_movements).toHaveLength(1);
    expect(t.supplier_material_bindings).toHaveLength(1);
  });
});

// ── DELETE /categories/:id — "does any model still use this category?" ───────
describe('category delete refuses when the in-use count could not be taken', () => {
  const tables = () => ({
    categories: [{ id: 'sofa', company_id: CO, hero_image_key: null }],
    product_models: [] as Row[],
  });

  test('an unreferenced category still deletes', async () => {
    const t = tables();
    const res = await harness(t).request('/categories/sofa', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(t.categories).toHaveLength(0);
  });

  test('a referenced category is refused, as before', async () => {
    const t = tables();
    t.product_models.push({ model_code: 'M-1', category: 'SOFA', company_id: CO });
    const res = await harness(t).request('/categories/sofa', { method: 'DELETE' });
    expect(res.status).toBe(409);
    expect((await body(res)).error).toBe('category_in_use');
    expect(t.categories).toHaveLength(1);
  });

  /* THE REGRESSION. `count ?? 0` used to make this a 200 with the row gone. */
  test('an unreadable count refuses and the category is STILL THERE', async () => {
    const t = tables();
    t.product_models.push({ model_code: 'M-1', category: 'SOFA', company_id: CO });
    const res = await harness(t, ['product_models']).request('/categories/sofa', { method: 'DELETE' });
    expect(res.status).toBe(409);
    expect((await body(res)).error).toBe('category_in_use_check_failed');
    expect(t.categories).toHaveLength(1);
  });
});

// ── PATCH /mfg-products/:id — "does another SKU already use that code?" ──────
describe('SKU rename refuses when the duplicate probe could not run', () => {
  const tables = () => ({
    mfg_products: [
      { id: 'p-1', code: 'OLD-1', company_id: CO, status: 'ACTIVE' },
      { id: 'p-2', code: 'TAKEN-1', company_id: CO, status: 'ACTIVE' },
    ],
    supplier_material_bindings: [{ item_code: 'OLD-1', material_kind: 'mfg_product', company_id: CO }],
    inventory_movements: [{ item_code: 'OLD-1', company_id: CO }],
    master_price_history: [] as Row[],
  });

  const rename = (t: Record<string, Row[]>, to: string, broken: string[] = []) =>
    harness(t, broken).request('/mfg-products/p-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: to }),
    });

  test('a free code renames, and the cascade runs', async () => {
    const t = tables();
    const res = await rename(t, 'NEW-1');
    expect(res.status).toBe(200);
    expect(t.mfg_products.find((p) => p.id === 'p-1')!.code).toBe('NEW-1');
    expect(t.supplier_material_bindings[0]!.item_code).toBe('NEW-1');
  });

  test('a taken code is refused, as before, and nothing cascades', async () => {
    const t = tables();
    const res = await rename(t, 'TAKEN-1');
    expect(res.status).toBe(409);
    expect((await body(res)).error).toBe('duplicate_code');
    expect(t.mfg_products.find((p) => p.id === 'p-1')!.code).toBe('OLD-1');
    expect(t.supplier_material_bindings[0]!.item_code).toBe('OLD-1');
  });

  /* THE REGRESSION. An unreadable probe used to read as "no duplicate", and the
     cascade renamed the referencing tables BEFORE mfg_products — so the stock
     and bindings below would already be merged under TAKEN-1. */
  test('an unreadable duplicate probe refuses and nothing is re-pointed', async () => {
    const t = tables();
    const res = await rename(t, 'TAKEN-1', ['mfg_products#neq']);
    expect(res.status).toBe(409);
    expect((await body(res)).error).toBe('duplicate_check_failed');
    expect(t.supplier_material_bindings[0]!.item_code).toBe('OLD-1');
    expect(t.inventory_movements[0]!.item_code).toBe('OLD-1');
  });
});
