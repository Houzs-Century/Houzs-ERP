import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

type EdgeResult = { data: { id: string }[]; count: number; error: null };
type EdgeBuilder = {
  select(cols: string, opts?: { count?: string; head?: boolean }): EdgeBuilder;
  limit(n: number): EdgeBuilder;
  range(from: number, to: number): EdgeBuilder;
  then(resolve: (v: EdgeResult) => void): void;
};

function fakeEdge(tables: Record<string, number>, cap: number | null) {
  return {
    from(table: string) {
      const total = tables[table] ?? 0;
      let want = total;
      let head = false;
      const builder: EdgeBuilder = {
        select(_cols: string, opts?: { count?: string; head?: boolean }) {
          head = !!opts?.head;
          return builder;
        },
        limit(n: number) { want = Math.min(want, n); return builder; },
        range(from: number, to: number) { want = Math.min(want, to - from + 1); return builder; },
        then(resolve: (v: EdgeResult) => void) {
          const served = cap == null ? want : Math.min(want, cap);
          const rows = head ? [] : Array.from({ length: served }, (_, i) => ({ id: `id-${i}` }));
          resolve({ data: rows, count: total, error: null });
        },
      };
      return builder;
    },
  };
}

let EDGE: ReturnType<typeof fakeEdge>;
vi.mock('../db/supabase', () => ({
  getSupabaseService: () => EDGE,
  isSupabaseConfigured: () => true,
}));

const health = (await import('./systemHealth')).default;

function appWith(perms: string[]) {
  const app = new Hono<{ Variables: { user: { id: number; permissions: string[] } } }>();
  app.use('*', async (c, next) => { c.set('user', { id: 1, permissions: perms }); await next(); });
  app.route('/', health);
  return app;
}

const BIG = { mfg_sales_order_items: 13918, mfg_products: 2293, mfg_sales_orders: 4100, purchase_order_items: 900 };

type ProbeRow = {
  requested: number; returned: number | null; contentRangeTotal: number | null;
  short: boolean | null; cappedByEdge: boolean | null; inconclusive: boolean | null;
};
type CeilingBody = {
  status: string; table: string; ceiling: number | null;
  probes: ProbeRow[]; paginateAllFirstWindow: ProbeRow;
  paginateAll: { page: number; verdict: string; basis: string };
};

async function measure(tables: Record<string, number>, cap: number | null) {
  EDGE = fakeEdge(tables, cap);
  const res = await appWith(['*', 'it.view']).request('/rest-page-ceiling');
  expect(res.status).toBe(200);
  return (await res.json()) as CeilingBody;
}

describe('/rest-page-ceiling — the ceiling is measured, not assumed', () => {
  it('reports a 1000-row cap as 1000, and clears paginateAll', async () => {
    const b = await measure(BIG, 1000);
    expect(b.ceiling).toBe(1000);
    const decisive = b.probes.find((p) => p.requested === 1001)!;
    expect(decisive.returned).toBe(1000);
    expect(decisive.contentRangeTotal).toBe(13918);
    expect(decisive.cappedByEdge).toBe(true);
    expect(decisive.inconclusive).toBe(false);
    expect(b.paginateAll.verdict).toBe('CORRECT');
  });

  it('CATCHES a ceiling BELOW paginateAll PAGE — the silent second truncation', async () => {
    const b = await measure(BIG, 500);
    expect(b.ceiling).toBe(500);
    expect(b.paginateAllFirstWindow.returned).toBe(500);
    expect(b.paginateAllFirstWindow.short).toBe(true);
    expect(b.paginateAll.verdict).toBe('TRUNCATES_SILENTLY');
    expect(b.paginateAll.basis).toContain('measured directly');
  });

  it('does not invent a ceiling from a read that merely ran out of rows', async () => {
    const b = await measure({ mfg_sales_order_items: 120, mfg_products: 90, mfg_sales_orders: 40, purchase_order_items: 5 }, null);
    expect(b.ceiling).toBeNull();
    expect(b.status).toBe('unknown');
    expect(b.paginateAll.verdict).toBe('UNKNOWN');
    expect(b.probes.every((p) => p.inconclusive === true)).toBe(true);
  });

  it('picks the largest countable table, so a small table cannot mask the cap', async () => {
    const b = await measure({ mfg_sales_order_items: 67, mfg_products: 1326, mfg_sales_orders: 40, purchase_order_items: 5 }, 1000);
    expect(b.table).toBe('mfg_products');
    expect(b.ceiling).toBe(1000);
    expect(b.paginateAll.verdict).toBe('CORRECT');
  });

  it('is gated on an admin capability, not on being logged in', async () => {
    EDGE = fakeEdge(BIG, 1000);
    const denied = await appWith(['scm.access']).request('/rest-page-ceiling');
    expect(denied.status).toBe(403);
  });

  it('returns counts only — never a row, an id, or a document number', async () => {
    const b = await measure(BIG, 1000);
    const body = JSON.stringify(b);
    expect(body).not.toContain('id-0');
    expect(b.probes.every((p) => !('data' in p) && !('rows' in p))).toBe(true);
  });
});
