/* GET /accounting/product-changes (owner 2026-11-23: 「那个变动的报表我要可以选择
   月份去看哦」) on the real handler over fake PostgREST. Pinned: the financial
   statements' key answers at this end; a bad month is refused; the month is the
   change day's, the active company's only; a window that is not an event and a
   change to an order since cancelled are left out; each row says whether the
   selling change covered the cost change, who sold the order, and whether the
   order came over from AutoCount (the reports hide those by default, owner
   2026-11-23: 「默认只看新单」). Amounts are made up. */
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { productChangesHandler } from '../src/scm/routes/accounting-product-changes';

const CO = 2;
const PERM = 'scm.payment_voucher.post';
let seq = 0;
const ev = (doc: string, day: string, bucket: string | null, money: [number, number, number, number], extra: Row = {}, co = CO): Row => ({
  id: `e-${String(++seq).padStart(3, '0')}`, company_id: co, so_doc_no: doc, route: 'DIRECT', window_key: day, change_day: day,
  changed_at: `${day}T04:00:00Z`, changed_by: ['Ali'], approved_by: [], amendment_nos: [], change_types: ['sku'], bucket,
  selling_before_sen: money[0], selling_after_sen: money[1], cost_before_sen: money[2], cost_after_sen: money[3], lines: [], ...extra,
});
const so = (doc: string, status = 'CONFIRMED', salesperson: string | null = 'st-1', co = CO, book: string | null = null): Row => ({
  company_id: co, doc_no: doc, so_date: '2026-09-15', status, debtor_name: `Customer ${doc}`, salesperson_id: salesperson, agent: salesperson ? null : 'WALK-IN',
  linked_ac_docno: book,
});

function harness(perms: readonly string[] = [PERM]) {
  seq = 0;
  const sb = fakeSb({
    so_product_changes: [
      ev('SO-1', '2026-10-03', 'SELLING', [300_000, 350_000, 120_000, 150_000]),
      ev('SO-2', '2026-10-20', 'COST_ONLY', [200_000, 200_000, 100_000, 108_000], { route: 'AMENDMENT', amendment_nos: ['SO-2/A1', 'SO-2/A2'], approved_by: ['Kris'] }),
      ev('SO-3', '2026-10-21', null, [100_000, 90_000, 40_000, 40_000]),
      ev('SO-4', '2026-10-22', 'SELLING', [100_000, 80_000, 40_000, 40_000]),
      ev('SO-1', '2026-11-02', 'SELLING', [350_000, 330_000, 150_000, 150_000]),
      ev('HC-SO-000123', '2026-10-25', 'COST_ONLY', [90_000, 90_000, 30_000, 36_000]),
      ev('SO-9', '2026-10-05', 'SELLING', [1, 2, 3, 4], {}, 1),
    ],
    mfg_sales_orders: [
      // SO-1 was pushed to AutoCount and came back under its own number: the ERP made it.
      so('SO-1', 'CONFIRMED', 'st-1', CO, 'SO-1'), so('SO-2', 'CONFIRMED', null), so('SO-3'), so('SO-4', 'CANCELLED'), so('SO-9', 'CONFIRMED', 'st-1', 1),
      // Brought over at the cutover: "HC-" + the book's number.
      so('HC-SO-000123', 'CONFIRMED', 'st-1', CO, 'SO-000123'),
    ],
    staff: [{ id: 'st-1', name: 'Mei Ling' }],
  });
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, CO as never);
    c.set('houzsUser' as never, { name: 'Chew', permissions_set: perms } as never);
    c.set('allowedCompanyIds' as never, [1, 2] as never);
    await next();
  });
  app.get('/accounting/product-changes', productChangesHandler as never);
  return app;
}
const read = async (app: Hono, qs: string) => {
  const res = await app.request(`/accounting/product-changes?${qs}`);
  return { status: res.status, body: await res.json() as any };
};

describe('GET /accounting/product-changes', () => {
  test('the financial statements key answers at this end', async () => {
    expect((await read(harness([]), 'from=2026-10&to=2026-10')).status).toBe(403);
  });

  test('a bad month is refused by name', async () => {
    const r = await read(harness(), 'from=2026-13');
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('bad_month');
  });

  test("the month's events of the active company, with who sold the order and whether the selling covered the cost", async () => {
    const r = await read(harness(), 'from=2026-10&to=2026-10');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ month: '2026-10', from: '2026-10-01', to: '2026-10-31' });
    expect(r.body.rows.map((x: any) => [x.docNo, x.changeDay, x.bucket, x.sellingDeltaSen, x.costDeltaSen, x.marginDeltaSen, x.covered, x.shortfallSen, x.salesperson, x.imported])).toEqual([
      ['SO-1', '2026-10-03', 'SELLING', 50_000, 30_000, 20_000, true, 0, 'Mei Ling', false],
      ['SO-2', '2026-10-20', 'COST_ONLY', 0, 8_000, -8_000, false, 8_000, 'WALK-IN', false],
      ['HC-SO-000123', '2026-10-25', 'COST_ONLY', 0, 6_000, -6_000, false, 6_000, 'Mei Ling', true],
    ]);
    expect(r.body.rows[1]).toMatchObject({ route: 'AMENDMENT', amendmentNos: ['SO-2/A1', 'SO-2/A2'], approvedBy: ['Kris'], customer: 'Customer SO-2' });
  });

  test('a range adds the months up', async () => {
    const r = await read(harness(), 'from=2026-10&to=2026-11');
    expect(r.body.rows.map((x: any) => x.changeDay)).toEqual(['2026-10-03', '2026-10-20', '2026-10-25', '2026-11-02']);
  });
});
