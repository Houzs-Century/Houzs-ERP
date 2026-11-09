/* Four lists filter a TIMESTAMPTZ column by a from-to date the user picks:
   stock movements and COGS (/inventory/movements, /inventory/cogs), stock
   adjustments (/inventory/adjustments) and rack movements (/warehouse/movements).
   They used to compare against `from` and `${to}T23:59:59Z` — the UTC day, which
   runs 08:00 to 07:59 in Malaysia. A row made at 01:30 on 10 Nov MYT was listed
   under the 9th and missing from the 10th. The window is now the MALAYSIAN day
   (owner 2026-11-09): >= 00:00+08 on `from`, < 00:00+08 the day after `to`. */
import { Hono } from 'hono';
import { describe, expect, test, vi } from 'vitest';

vi.mock('../src/scm/middleware/auth', () => ({ supabaseAuth: async (_c: unknown, next: () => Promise<void>) => next() }));

import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { inventory } from '../src/scm/routes/inventory';
import { inventoryAdjustments } from '../src/scm/routes/inventory-adjustments';
import { warehouse } from '../src/scm/routes/warehouse';

const CO = 1;
/* 23:59 on the 9th, 00:30 / 01:30 on the 10th, 23:59 on the 10th and 00:00 on the 11th, all MYT. */
const STAMPS = ['2026-11-09T15:59:00Z', '2026-11-09T16:30:00Z', '2026-11-09T17:30:00Z', '2026-11-10T15:59:00Z', '2026-11-10T16:00:00Z'];
const rows = (col: string, extra: Row = {}): Row[] =>
  STAMPS.map((t, i) => ({ id: `r${i}`, company_id: CO, [col]: t, ...extra }));

function app() {
  const sb = fakeSb({
    inventory_movements: rows('created_at'),
    v_cogs_entries: rows('consumed_at'),
    stock_adjustments: rows('created_at'),
    stock_adjustment_lines: [],
    warehouse_rack_movements: rows('created_at'),
    warehouses: [],
  });
  const a = new Hono();
  a.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, CO as never);
    c.set('allowedCompanyIds' as never, [CO] as never);
    c.set('houzsUser' as never, { name: 'T', permissions_set: new Set(['projects.finance.view']) } as never);
    await next();
  });
  a.route('/inventory', inventory);
  a.route('/inventory-adjustments', inventoryAdjustments);
  a.route('/warehouse', warehouse);
  return a;
}

const LISTS: Array<[string, string, string, string]> = [
  ['stock movements', '/inventory/movements', 'dateFrom', 'dateTo'],
  ['COGS', '/inventory/cogs', 'from', 'to'],
  ['stock adjustments', '/inventory-adjustments', 'dateFrom', 'dateTo'],
  ['rack movements', '/warehouse/movements', 'from', 'to'],
];

async function ids(path: string, query: string): Promise<string[]> {
  const res = await app().request(`${path}?${query}`);
  expect(res.status, await res.clone().text()).toBe(200);
  const body = (await res.json()) as Record<string, unknown>;
  const list = (Object.values(body).find(Array.isArray) ?? []) as Row[];
  return list.map((r) => String(r.id)).sort();
}

describe('date-filtered lists use the Malaysian day', () => {
  for (const [name, path, fromKey, toKey] of LISTS) {
    test(`${name}: 10 Nov is 00:00 to 23:59 Malaysia time`, async () => {
      expect(await ids(path, `${fromKey}=2026-11-10&${toKey}=2026-11-10`)).toEqual(['r1', 'r2', 'r3']);
    });

    test(`${name}: a date that is not YYYY-MM-DD is refused, not ignored`, async () => {
      const res = await app().request(`${path}?${toKey}=10/11/2026`);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_date');
    });
  }
});
