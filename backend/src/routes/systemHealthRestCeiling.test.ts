/* THE INSTRUMENT MUST BE ABLE TO REPORT BOTH ANSWERS.
 *
 * `/api/admin/health/rest-page-ceiling` exists because the PostgREST row cap
 * has been asserted for weeks and never observed: lib/paginate-all.ts's header
 * states a 1000-row cap as fact, 52 files page against its `PAGE`, and nothing
 * ever measured it. A diagnostic for that is only worth trusting if it can come
 * back with the UNWELCOME answer too — a probe that reports "sound" whatever
 * the edge does is the `mrp_load_truncated` guard again, which compared
 * 1000 >= 5000 and therefore could never fire.
 *
 * So the fake below is a PostgREST edge with a CONFIGURABLE cap, and the suite
 * drives the endpoint against three edges:
 *   · capped at 1000  -> ceiling 1000, paginateAll CORRECT
 *   · capped at   500 -> ceiling  500, paginateAll TRUNCATES_SILENTLY (the
 *                        second-order bug the probe script raised: PAGE=1000
 *                        would make page one look short and stop the loop)
 *   · uncapped        -> ceiling is the table, and nothing is claimed
 *
 * It also pins the two disciplines the endpoint is answerable for: the gate,
 * and "counts only, never a row".
 */
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

/* A PostgREST edge that caps like the real one: `limit`/`range` set an UPPER
   bound, the server independently refuses to serve more than `cap` rows, and
   the Content-Range total always reports the true match count regardless. That
   asymmetry — bounded rows, honest total — is the whole signal the endpoint
   reads. */
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

/* The caller the gate admits. `*` is the existing admin capability
   (services/permissions.ts:7 — "Special key `*` → grants every permission"),
   and it is what this file's other heavy admin routes already use. */
function appWith(perms: string[]) {
  const app = new Hono<{ Variables: { user: { id: number; permissions: string[] } } }>();
  /* Only the two fields the gate reads. AuthUser carries fourteen more that
     requirePermission never touches, so the cast keeps the fixture honest
     about what is actually under test. */
  app.use('*', async (c, next) => { c.set('user', { id: 1, permissions: perms }); await next(); });
  app.route('/', health);
  return app;
}

/* Production-shaped sizes: the demand table dwarfs the limit ladder, so every
   rung is conclusive. */
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
  const res = await appWith(['*']).request('/rest-page-ceiling');
  expect(res.status).toBe(200);
  return (await res.json()) as CeilingBody;
}

describe('/rest-page-ceiling — the ceiling is measured, not assumed', () => {
  it('reports a 1000-row cap as 1000, and clears paginateAll', async () => {
    const b = await measure(BIG, 1000);
    expect(b.ceiling).toBe(1000);
    // The decisive rung: 1001 asked, 1000 served, and the total proves rows existed.
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
    // paginateAll's own first window came back short, so its short-page stop
    // would end the loop on page one and drop 13,418 rows with no error.
    expect(b.paginateAllFirstWindow.returned).toBe(500);
    expect(b.paginateAllFirstWindow.short).toBe(true);
    expect(b.paginateAll.verdict).toBe('TRUNCATES_SILENTLY');
    expect(b.paginateAll.basis).toContain('measured directly');
  });

  it('does not invent a ceiling from a read that merely ran out of rows', async () => {
    // Uncapped edge: every rung returns min(limit, table). Nothing was capped,
    // so no probe may be counted as evidence of a ceiling.
    const b = await measure({ mfg_sales_order_items: 120, mfg_products: 90, mfg_sales_orders: 40, purchase_order_items: 5 }, null);
    expect(b.ceiling).toBeNull();
    expect(b.status).toBe('unknown');
    expect(b.paginateAll.verdict).toBe('UNKNOWN');
    expect(b.probes.every((p) => p.inconclusive === true)).toBe(true);
  });

  it('picks the largest countable table, so a small table cannot mask the cap', async () => {
    // The demand table is tiny here (staging's shape: 67 rows, run 32281490702)
    // while mfg_products is large. A hardcoded target would have answered
    // "inconclusive"; choosing by size keeps the probe informative.
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
    // The fake's rows are `id-0`, `id-1`, … — none may reach the payload.
    expect(body).not.toContain('id-0');
    expect(b.probes.every((p) => !('data' in p) && !('rows' in p))).toBe(true);
  });
});
