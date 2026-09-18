import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { patchProductModelHandler } from '../src/scm/routes/product-models';

/* A model's category can be changed to any other category from the edit dialog
   (owner 2026-09-15: every category can move to a different one; it was only
   Accessory <-> Sofa Accessory on 2026-09-14), its SKUs move with it, in this
   company only — on the server, not only in the screen. */

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

describe('PATCH /product-models/:id — category change', () => {
  test('Accessory -> Sofa Accessory moves the model and its SKUs in this company only', async () => {
    const { data, patch } = setup('ACCESSORY');
    const res = await patch({ category: 'FABRIC_ACCESSORY' });
    expect(res.status).toBe(200);
    expect(data.product_models[0].category).toBe('FABRIC_ACCESSORY');
    expect(data.mfg_products[0].category).toBe('FABRIC_ACCESSORY');
    expect(data.product_models[1].category).toBe('ACCESSORY');
    expect(data.mfg_products[1].category).toBe('ACCESSORY');
  });

  test('a sofa can become a mattress, and its SKUs follow', async () => {
    const { data, patch } = setup('SOFA');
    const res = await patch({ category: 'MATTRESS' });
    expect(res.status).toBe(200);
    expect(data.product_models[0].category).toBe('MATTRESS');
    expect(data.mfg_products[0].category).toBe('MATTRESS');
    expect(data.mfg_products[1].category).toBe('SOFA');
  });

  test('a name and a category saved together both land, and the reply shows the new category', async () => {
    const { data, patch } = setup('ACCESSORY');
    const res = await patch({ name: 'BACK CUSHION 04 NEW', category: 'SOFA' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { model: Row }).model).toMatchObject({ name: 'BACK CUSHION 04 NEW', category: 'SOFA' });
    expect(data.product_models[0]).toMatchObject({ name: 'BACK CUSHION 04 NEW', category: 'SOFA' });
    expect(data.mfg_products[0].category).toBe('SOFA');
    expect(data.product_models[1]).toMatchObject({ name: 'other company', category: 'ACCESSORY' });
  });

  test('a value that is not a category is refused and nothing is written', async () => {
    const { data, patch } = setup('ACCESSORY');
    const res = await patch({ category: 'CHAIR' });
    expect(res.status).toBe(400);
    expect(data.product_models[0].category).toBe('ACCESSORY');
    expect(data.mfg_products[0].category).toBe('ACCESSORY');
  });

  /* Owner 2026-09-18: two "SERVICE X SL" models were created with the same code,
     one ACCESSORY and one SERVICE. Changing the ACCESSORY one to SERVICE hit the
     (company_id, model_code, category) unique index and surfaced as a raw 500
     "the system hit a problem". A code clash is actionable, not a server fault:
     it must answer 409 with a plain sentence the operator can read — no raw
     "duplicate key ... constraint" text (the client's isPlain filter drops it). */
  test('moving to a category a same-code model already holds → 409 with a plain reason', async () => {
    // A model update to the taken category returns a Postgres 23505; the
    // model_code re-read then succeeds so the message can name the code.
    const model = { id: 'm1', company_id: 1, model_code: 'BEDFRAME SL', name: 'BEDFRAME SL', category: 'ACCESSORY', allowed_options: {} };
    const supabase = {
      from(table: string) {
        return {
          _table: table,
          _isUpdate: false,
          select() { return this; },
          eq() { return this; },
          update() { this._isUpdate = true; return this; },
          maybeSingle() {
            if (table === 'product_models' && !this._isUpdate) return Promise.resolve({ data: { allowed_options: {}, category: 'ACCESSORY', model_code: 'BEDFRAME SL' }, error: null });
            return Promise.resolve({ data: model, error: null });
          },
          then(res: (v: { data: unknown; error: unknown }) => unknown) {
            if (table === 'product_models' && this._isUpdate) {
              return Promise.resolve({ data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "product_models_company_code_category_unique"' } }).then(res);
            }
            return Promise.resolve({ data: [], error: null }).then(res);
          },
        };
      },
    };
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('supabase' as never, supabase as never);
      c.set('companyId' as never, 1 as never);
      await next();
    });
    app.patch('/product-models/:id', patchProductModelHandler as never);
    const res = await app.request('/product-models/m1', {
      method: 'PATCH', body: JSON.stringify({ category: 'SERVICE' }), headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('target_category_taken');
    expect(body.message).toContain('BEDFRAME SL');
    expect(body.message).toMatch(/Service/);
    // The client's isPlain filter drops any string containing these — the whole
    // point of the fix is that the operator sees prose, not the driver's text.
    expect(body.message).not.toMatch(/violates|constraint|duplicate key/i);
  });
});
