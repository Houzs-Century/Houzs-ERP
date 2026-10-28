// GET /inventory/valuation — the as-of photograph (GL redesign item 5).
// Pinned: the date is validated; rows come back per item joined to the product
// master (a code the master lost still shows — hiding it would break the
// subtotals against the total); zero-net rows drop as noise; totals are the
// sums of what is returned.

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { inventoryValuationHandler } from '../src/scm/routes/inventory-valuation';

const CO = 2;

const mv = (over: Row): Row => ({
  company_id: CO, movement_type: 'IN', qty: 1, total_cost_sen: 100_000,
  movement_date: '2026-08-10', created_at: '2026-08-10T02:00:00Z', item_code: 'SOFA-1', ...over,
});

function harness(tables: Record<string, Row[]> = {}) {
  const sb = fakeSb({
    inventory_movements: [],
    mfg_products: [
      { code: 'SOFA-1', name: 'Chesterfield 3-seater', category: 'SOFA' },
      { code: 'MAT-1', name: 'Latex Queen', category: 'MATTRESS' },
    ],
    ...tables,
  });
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, CO as never);
    c.set('allowedCompanyIds' as never, [1, 2] as never);
    await next();
  });
  app.get('/inventory/valuation', inventoryValuationHandler as never);
  return { app, sb };
}

describe('GET /inventory/valuation', () => {
  test('a bad or missing date is a 400 sentence', async () => {
    const { app } = harness();
    expect((await app.request('/inventory/valuation')).status).toBe(400);
    expect((await app.request('/inventory/valuation?asOf=nope')).status).toBe(400);
  });

  test('replays per item on the business date, joins the master, keeps a master-less code, drops zero-net noise', async () => {
    const { app } = harness({
      inventory_movements: [
        mv({}),
        mv({ movement_type: 'OUT', total_cost_sen: 30_000, movement_date: '2026-08-20' }),
        mv({ item_code: 'MAT-1', total_cost_sen: 20_000 }),
        // A code the product master no longer carries — must still show.
        mv({ item_code: 'GONE-9', total_cost_sen: 5_000 }),
        // Came and went entirely before the date: nets to zero, drops.
        mv({ item_code: 'NOISE-1', total_cost_sen: 1_000 }),
        mv({ item_code: 'NOISE-1', movement_type: 'OUT', total_cost_sen: 1_000, movement_date: '2026-08-11' }),
        // September — outside the photograph.
        mv({ item_code: 'MAT-1', movement_date: '2026-09-02', total_cost_sen: 999_999 }),
      ],
    });
    const res = await app.request('/inventory/valuation?asOf=2026-08-31');
    expect(res.status).toBe(200);
    const body = await res.json() as { totalQty: number; totalValueSen: number; rows: Array<Record<string, unknown>> };
    expect(body.rows.map((r) => [r.item_code, r.qty, r.value_sen, r.category])).toEqual([
      ['GONE-9', 1, 5_000, null],
      ['MAT-1', 1, 20_000, 'MATTRESS'],
      ['SOFA-1', 0, 70_000, 'SOFA'],
    ]);
    expect(body.totalValueSen).toBe(95_000);
    expect(body.totalQty).toBe(2);
  });
});
