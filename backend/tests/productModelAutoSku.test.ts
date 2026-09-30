import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { patchProductModelHandler } from '../src/scm/routes/product-models';

/* BUG-41: ticking a sofa compartment on a Model and saving must create its item
   code through the REQUEST's client (service-role, `scm` schema). It used to
   build a raw createClient(), which defaults to `public`, so the insert failed
   and was swallowed: the save said OK and the SO picker never found the code. */

type Row = Record<string, unknown>;
class Q {
  private preds: Array<(r: Row) => boolean> = [];
  private patch: Row | null = null;
  constructor(private rows: Row[], private failInsert: boolean) {}
  select() { return this; }
  in() { return this; }
  filter() { return this; }
  eq(col: string, val: unknown) { this.preds.push((r) => String(r[col]) === String(val)); return this; }
  update(p: Row) { this.patch = p; return this; }
  insert(added: Row[]) {
    if (this.failInsert) return Promise.resolve({ error: { code: '42P01', message: 'relation does not exist' } });
    this.rows.push(...added);
    return Promise.resolve({ error: null });
  }
  private run() {
    const hit = this.rows.filter((r) => this.preds.every((p) => p(r)));
    if (this.patch) for (const r of hit) Object.assign(r, this.patch);
    // Copies, like a real read: the handler's "before" snapshot must not see the update.
    return hit.map((r) => ({ ...r }));
  }
  maybeSingle() { const h = this.run(); return Promise.resolve({ data: h[0] ?? null, error: null }); }
  then(res: (v: { data: Row[]; error: null }) => unknown, rej?: (e: unknown) => unknown) {
    return Promise.resolve({ data: this.run(), error: null as null }).then(res, rej);
  }
}

function setup(failInsert = false) {
  const data: Record<string, Row[]> = {
    product_models: [
      { id: 'm1', company_id: 1, model_code: '8030', name: '8030', category: 'SOFA', allowed_options: { compartments: ['1S'] } },
    ],
    mfg_products: [
      { id: 's1', company_id: 1, model_id: 'm1', code: '8030-1S', category: 'SOFA' },
    ],
  };
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, { from: (t: string) => new Q(data[t] ?? [], failInsert && t === 'mfg_products') } as never);
    c.set('companyId' as never, 1 as never);
    await next();
  });
  app.patch('/product-models/:id', patchProductModelHandler as never);
  const save = (compartments: string[]) => app.request('/product-models/m1', {
    method: 'PATCH',
    body: JSON.stringify({ allowedOptions: { compartments } }),
    headers: { 'content-type': 'application/json' },
  });
  return { data, save };
}

describe('PATCH /product-models/:id — sofa compartment auto-creates its item code', () => {
  test('newly ticked compartments get an item code in this company, existing ones are left alone', async () => {
    const { data, save } = setup();
    const res = await save(['1S', '2B(LHF)', '2B(RHF)']);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { autoCreatedSkus: string[]; autoCreateFailed: string[] };
    expect(body.autoCreatedSkus).toEqual(['8030-2B(LHF)', '8030-2B(RHF)']);
    expect(body.autoCreateFailed).toEqual([]);
    expect(data.mfg_products.map((r) => r.code)).toEqual(['8030-1S', '8030-2B(LHF)', '8030-2B(RHF)']);
    expect(data.mfg_products[1]).toMatchObject({ company_id: 1, model_id: 'm1', category: 'SOFA', status: 'ACTIVE' });
  });

  test('a refused insert is reported, not hidden: the options still save', async () => {
    const { data, save } = setup(true);
    const res = await save(['1S', '2B(LHF)']);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { autoCreatedSkus: string[]; autoCreateFailed: string[] };
    expect(body.autoCreatedSkus).toEqual([]);
    expect(body.autoCreateFailed).toEqual(['8030-2B(LHF)']);
    expect((data.product_models[0].allowed_options as { compartments: string[] }).compartments).toEqual(['1S', '2B(LHF)']);
  });
});
