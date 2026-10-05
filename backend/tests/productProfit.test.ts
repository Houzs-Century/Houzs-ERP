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
      line('SO-8', 'mattress', 'ULT-Q', 1, 600_000, 150_000),
      line('SO-D', 'mattress', 'ULT-Q', 1, 600_000, 150_000),
      line('SO-O', 'mattress', 'ULT-Q', 1, 600_000, 150_000, 1),
    ],
    mfg_products: [
      { company_id: CO, code: 'ULT-Q', model_id: 1, base_model: null, size_label: 'Queen' },
      { company_id: CO, code: 'JAG-Q', model_id: 4, base_model: null, size_label: 'Queen' },
      { company_id: CO, code: 'SOF-1A', model_id: 3, base_model: null, size_label: null },
      { company_id: CO, code: 'SOF-CNR', model_id: 3, base_model: null, size_label: null },
    ],
    product_models: [
      { company_id: CO, id: 1, name: 'ULTIMATE', branding: 'AKEMI' },
      { company_id: CO, id: 3, name: 'SOFFIO', branding: 'ZANOTTI' },
      { company_id: CO, id: 4, name: 'JAGER', branding: null },
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
    ]);
    expect(r.body.rows[0]).toMatchObject({ brand: 'AKEMI', freeBedframes: 1, freeBedframeSen: 90_000 });
    expect(r.body.freeBedframes).toEqual({ pieces: 1, sen: 90_000, orders: 1 });
  });
});
