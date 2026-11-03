import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { patchProductModelHandler } from '../src/scm/routes/product-models';

/* 2990-0022 "two way model name & code management". A model's code is copied
   onto its SKUs as mfg_products.base_model, the key sofa combo pricing and the
   quick picks match on. Changing the code must move that copy in the same
   database call (scm.rename_model_code), in this company only; a refusal from
   the function must reach the screen as a 409 and write nothing. */

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

function setup(refuse: string | null) {
  const data: Record<string, Row[]> = {
    product_models: [
      { id: 'm1', company_id: 1, model_code: '8210', name: 'TANNAH', category: 'SOFA', allowed_options: {} },
      { id: 'm9', company_id: 2, model_code: '8210', name: 'other company', category: 'SOFA', allowed_options: {} },
    ],
    mfg_products: [
      { id: 's1', company_id: 1, model_id: 'm1', code: '8210-3S', base_model: '8210' },
      { id: 's9', company_id: 2, model_id: 'm9', code: '8210-3S', base_model: '8210' },
    ],
  };
  const calls: Array<{ fn: string; args: Row }> = [];
  const sb = {
    from: (t: string) => new Q(data[t] ?? []),
    // stands in for scm.rename_model_code: the real one is one transaction
    rpc: (fn: string, args: Row) => {
      calls.push({ fn, args });
      if (refuse) return Promise.resolve({ data: { renamed: false, refused: refuse }, error: null });
      for (const m of data.product_models) {
        if (m.id === args.p_model_id && m.company_id === args.p_company_id) m.model_code = args.p_new_code;
      }
      for (const s of data.mfg_products) {
        if (s.model_id === args.p_model_id && s.company_id === args.p_company_id) s.base_model = args.p_new_code;
      }
      return Promise.resolve({ data: { renamed: true }, error: null });
    },
  };
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, 1 as never);
    await next();
  });
  app.patch('/product-models/:id', patchProductModelHandler as never);
  const patch = (body: Row) => app.request('/product-models/m1', {
    method: 'PATCH', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
  });
  return { data, calls, patch };
}

describe('PATCH /product-models/:id — model code change', () => {
  test('the SKUs of this model follow the new code, the other company is untouched', async () => {
    const { data, calls, patch } = setup(null);
    const res = await patch({ modelCode: '8210X' });
    expect(res.status).toBe(200);
    expect(calls).toEqual([{ fn: 'rename_model_code', args: { p_company_id: 1, p_model_id: 'm1', p_new_code: '8210X' } }]);
    expect(((await res.json()) as { model: Row }).model.model_code).toBe('8210X');
    expect(data.mfg_products[0].base_model).toBe('8210X');
    expect(data.mfg_products[1].base_model).toBe('8210');
    expect(data.product_models[1].model_code).toBe('8210');
  });

  test('a code saved together with a name lands both', async () => {
    const { data, patch } = setup(null);
    const res = await patch({ modelCode: '8210X', name: 'TANNAH II' });
    expect(res.status).toBe(200);
    expect(data.product_models[0]).toMatchObject({ model_code: '8210X', name: 'TANNAH II' });
    expect(data.mfg_products[0].base_model).toBe('8210X');
  });

  test('an unchanged code does not call the function', async () => {
    const { calls, patch } = setup(null);
    const res = await patch({ modelCode: '8210', name: 'TANNAH II' });
    expect(res.status).toBe(200);
    expect(calls).toEqual([]);
  });

  test('a refusal is a 409 with its reason and nothing else is written', async () => {
    const { data, patch } = setup('code_taken');
    const res = await patch({ modelCode: '8210X', name: 'TANNAH II' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('code_taken');
    expect(data.product_models[0]).toMatchObject({ model_code: '8210', name: 'TANNAH' });
    expect(data.mfg_products[0].base_model).toBe('8210');
  });
});
