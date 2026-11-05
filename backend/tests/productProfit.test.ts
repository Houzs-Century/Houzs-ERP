/* GET /accounting/product-profit (owner 2026-10-05) on the real handler over
   fake PostgREST. Pinned: the financial statements' key answers at this end;
   a bad month is refused by name; the month's orders are read by SO date, in
   the active company only, with their lines, products and models; the answer
   is one row per model with its share of the order's gifts. */
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { productProfitHandler } from '../src/scm/routes/accounting-product-profit';

const CO = 2;
const PERM = 'scm.payment_voucher.post';
let seq = 0;
const so = (doc: string, date: string, status = 'CONFIRMED', co = CO): Row => ({ company_id: co, doc_no: doc, so_date: date, status });
const line = (doc: string, group: string, code: string, qty: number, sales: number, cost: number, co = CO): Row => ({
  id: `l-${String(++seq).padStart(3, '0')}`, company_id: co, doc_no: doc, item_group: group, item_code: code, description: null,
  qty, total_sen: sales, unit_cost_sen: null, line_cost_sen: cost, cancelled: false,
});

function harness(perms: readonly string[] = [PERM]) {
  seq = 0;
  const sb = fakeSb({
    mfg_sales_orders: [
      so('SO-1', '2026-09-03'), so('SO-2', '2026-09-20'), so('SO-8', '2026-08-31'),
      so('SO-D', '2026-09-05', 'DRAFT'), so('SO-O', '2026-09-10', 'CONFIRMED', 1),
    ],
    mfg_sales_order_items: [
      line('SO-1', 'mattress', 'ULT-Q', 1, 600_000, 150_000),
      line('SO-1', 'bedframe', 'JAG-Q', 1, 0, 90_000),
      line('SO-2', 'sofa', 'SOF-1A', 1, 500_000, 120_000),
      line('SO-2', 'sofa', 'SOF-CNR', 1, 0, 80_000),
      /* A code with a double quote in it — PostgREST's in-list cannot carry one. */
      line('SO-2', 'mattress', 'DUNLOPILLO GENERASI 5" MATT (S)', 1, 138_800, 31_500),
      line('SO-8', 'mattress', 'ULT-Q', 1, 600_000, 150_000),
      line('SO-D', 'mattress', 'ULT-Q', 1, 600_000, 150_000),
      line('SO-O', 'mattress', 'ULT-Q', 1, 600_000, 150_000, 1),
    ],
    mfg_products: [
      { company_id: CO, code: 'ULT-Q', model_id: 'a1b2c3d4-0000-4000-8000-000000000001', base_model: null, size_label: 'Queen' },
      { company_id: CO, code: 'JAG-Q', model_id: 'a1b2c3d4-0000-4000-8000-000000000004', base_model: null, size_label: 'Queen' },
      { company_id: CO, code: 'SOF-1A', model_id: 'a1b2c3d4-0000-4000-8000-000000000003', base_model: null, size_label: null },
      { company_id: CO, code: 'SOF-CNR', model_id: 'a1b2c3d4-0000-4000-8000-000000000003', base_model: null, size_label: null },
      { company_id: CO, code: 'DUNLOPILLO GENERASI 5" MATT (S)', model_id: 'a1b2c3d4-0000-4000-8000-000000000005', base_model: null, size_label: 'Single' },
      { company_id: CO, code: 'NOT-SOLD', model_id: 'a1b2c3d4-0000-4000-8000-000000000001', base_model: null, size_label: 'King' },
      { company_id: 1, code: 'ULT-Q', model_id: 'a1b2c3d4-0000-4000-8000-000000000009', base_model: null, size_label: 'Queen' },
    ],
    product_models: [
      { company_id: CO, id: 'a1b2c3d4-0000-4000-8000-000000000001', name: 'ULTIMATE', branding: 'AKEMI' },
      { company_id: CO, id: 'a1b2c3d4-0000-4000-8000-000000000003', name: 'SOFFIO', branding: 'ZANOTTI' },
      { company_id: CO, id: 'a1b2c3d4-0000-4000-8000-000000000004', name: 'JAGER', branding: null },
      { company_id: CO, id: 'a1b2c3d4-0000-4000-8000-000000000005', name: 'GENERASI 5"', branding: 'DUNLOPILLO' },
      { company_id: 1, id: 'a1b2c3d4-0000-4000-8000-000000000009', name: 'OTHER COMPANY', branding: null },
    ],
  });
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, CO as never);
    c.set('houzsUser' as never, { name: 'Chew', permissions_set: perms } as never);
    c.set('allowedCompanyIds' as never, [1, 2] as never);
    await next();
  });
  app.get('/accounting/product-profit', productProfitHandler as never);
  return app;
}
const read = async (app: Hono, qs: string) => {
  const res = await app.request(`/accounting/product-profit?${qs}`);
  return { status: res.status, body: await res.json() as any };
};

describe('GET /accounting/product-profit', () => {
  test('the financial statements key answers at this end', async () => {
    const r = await read(harness([]), 'month=2026-09');
    expect(r.status).toBe(403);
  });

  test('a bad month is refused by name', async () => {
    const r = await read(harness(), 'month=2026-13');
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('bad_month');
  });

  test("the month's orders, one row per model, gifts shared to the paid product", async () => {
    const r = await read(harness(), 'month=2026-09');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ month: '2026-09', from: '2026-09-01', to: '2026-09-30', orders: 2 });
    expect(r.body.rows.map((x: any) => [x.model, x.category, x.units, x.salesSen, x.costSen, x.giftSen])).toEqual([
      ['ULTIMATE', 'mattress', 1, 600_000, 150_000, 90_000],
      ['SOFFIO', 'sofa', 1, 500_000, 200_000, 0],
      ['GENERASI 5"', 'mattress', 1, 138_800, 31_500, 0],
    ]);
    expect(r.body.rows[0]).toMatchObject({ brand: 'AKEMI', freeBedframes: 1, freeBedframeSen: 90_000 });
    expect(r.body.freeBedframes).toEqual({ pieces: 1, sen: 90_000, orders: 1 });
  });
});

/* Several months (the redesign's c8; owner 2026-11-03 「要」, question g2): ?from / ?to
   beside ?month, whole months, each order in its SO month, the months added up. */
describe('GET /accounting/product-profit over several months', () => {
  const byModel = (rows: any[]) => Object.fromEntries(rows.map((x) => [x.model, [x.units, x.orders, x.salesSen, x.costSen, x.giftSen, x.freeBedframeSen]]));

  test('one month through from / to is the same report as ?month=', async () => {
    const app = harness();
    const month = await read(app, 'month=2026-09');
    expect((await read(app, 'from=2026-09&to=2026-09')).body).toEqual(month.body);
    /* A part month widens to the whole month. */
    expect((await read(app, 'from=2026-09-14&to=2026-09-15')).body).toEqual(month.body);
  });

  test('August and September together are the two months added up, each order in its SO month', async () => {
    const app = harness();
    const aug = await read(app, 'month=2026-08');
    const sep = await read(app, 'month=2026-09');
    const both = await read(app, 'from=2026-08-01&to=2026-09-30');
    expect(both.status).toBe(200);
    expect(both.body).toMatchObject({ month: '2026-08', from: '2026-08-01', to: '2026-09-30', orders: aug.body.orders + sep.body.orders });
    const a = byModel(aug.body.rows);
    const s = byModel(sep.body.rows);
    const summed: Record<string, number[]> = {};
    for (const [model, v] of [...Object.entries(a), ...Object.entries(s)]) {
      summed[model] = (summed[model] ?? v.map(() => 0)).map((n, i) => n + (v as number[])[i]!);
    }
    expect(byModel(both.body.rows)).toEqual(summed);
    expect(both.body.rows.find((x: any) => x.model === 'ULTIMATE')).toMatchObject({ units: 2, salesSen: 1_200_000, costSen: 300_000 });
    expect(both.body.freeBedframes).toEqual({ pieces: 1, sen: 90_000, orders: 1 });
  });

  test('a range that runs backwards, runs too long, or names no month is refused by name', async () => {
    const app = harness();
    expect((await read(app, 'from=2026-09&to=2026-08')).body.error).toBe('bad_range');
    const long = await read(app, 'from=2024-09&to=2026-09');
    expect(long.status).toBe(400);
    expect(long.body).toMatchObject({ error: 'too_long', message: 'At most 24 months at a time.' });
    expect((await read(app, 'from=2024-10&to=2026-09')).status).toBe(200);
    expect((await read(app, 'from=2026-13&to=2026-14')).body.error).toBe('bad_month');
  });
});
