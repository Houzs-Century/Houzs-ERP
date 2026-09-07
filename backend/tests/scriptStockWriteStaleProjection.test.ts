/* ══════════════════════════════════════════════════════════════════════════════
   A SCRIPT THAT WRITES STOCK LEAVES THE READINESS PROJECTION STALE — SILENTLY,
   FOREVER. (defect traced 2026-09-08, go-live night.)

   THE MECHANISM, in one paragraph. `mfg_sales_order_items.stock_status` is a
   PROJECTION: nothing computes it on read, `so-stock-allocation.ts` writes it.
   Every trigger for that recompute hangs off the WORKER REQUEST PATH — GRN post,
   DO ship/cancel, returns, stock takes, transfers, adjustments, consignment —
   and the five-minute cron in `src/index.ts` is not an independent sweeper: it
   DRAINS `scm.stock_allocation_recompute_queue`, and only a Worker ever put a
   row there. `backend/scripts/*` open `postgres(DATABASE_URL)` and write
   straight to the database. They enter neither. So the stock moves, the
   projection does not, the cron finds an empty queue, and no report anywhere
   says the two disagree.

   THE FIRST TEST IS THE DEFECT and it passes on both sides of this PR — it is
   the WHY, pinned, so nobody has to re-derive it. Three cron sweeps in a row
   change nothing, because there is nothing to change.

   THE SECOND TEST IS THE REMEDY and it FAILED before this PR: the module it
   imports did not exist. Observed red on 2026-09-08 (see the PR body).

   WHAT IS PROVEN WHERE. The queue row's SQL — the upsert, the singleton
   collapse, and the fact that `attempts` / `state` are NOT reset — is proven
   against a REAL PostgreSQL in tests-pg/stockAllocationEnqueueFromScript.pg.test.ts.
   This file proves the other half: that a row of that shape is what makes the
   very next cron sweep repair the projection. The `sql` stand-in below is
   wiring, not evidence, and must never become the only place the enqueue is
   exercised.
   ══════════════════════════════════════════════════════════════════════════ */
import { describe, expect, test } from 'vitest';
import { drainStockAllocationRecomputeWithClient } from '../src/scm/lib/stock-allocation-job';
import { enqueueStockAllocationRecompute } from '../scripts/lib/stock-allocation-enqueue.mjs';

type Row = Record<string, any>;

/* A PostgREST stand-in over plain arrays. Same shape as the one in
   src/scm/lib/so-stock-allocation.c1-pool.test.ts, plus DELETE — the drain
   deletes the queue row when the sweep completes, and a fake that silently
   ignored that would report a permanently-requeued job as healthy. */
function fakeSb(tables: Record<string, Row[]>) {
  const from = (table: string) => {
    const filters: Array<(r: Row) => boolean> = [];
    let pendingUpdate: Row | null = null;
    let pendingInsert: Row | Row[] | null = null;
    let deleting = false;
    const src = () => (tables[table] ??= []);
    const rows = () => src().filter((r) => filters.every((f) => f(r)));
    const settle = () => {
      if (pendingInsert) {
        const add = Array.isArray(pendingInsert) ? pendingInsert : [pendingInsert];
        src().push(...add);
        return { data: add, error: null };
      }
      if (pendingUpdate) {
        const hit = rows();
        for (const r of hit) Object.assign(r, pendingUpdate);
        return { data: hit, error: null };
      }
      if (deleting) {
        const hit = rows();
        tables[table] = src().filter((r) => !hit.includes(r));
        return { data: hit, error: null };
      }
      return { data: rows(), error: null };
    };
    const builder: any = {
      select: () => builder,
      insert: (p: Row | Row[]) => { pendingInsert = p; return builder; },
      upsert: (p: Row | Row[]) => { pendingInsert = p; return builder; },
      update: (p: Row) => { pendingUpdate = p; return builder; },
      delete: () => { deleting = true; return builder; },
      eq: (c: string, v: unknown) => { filters.push((r) => String(r[c]) === String(v)); return builder; },
      in: (c: string, vs: unknown[]) => { const s = new Set(vs.map(String)); filters.push((r) => s.has(String(r[c]))); return builder; },
      gt: (c: string, v: unknown) => {
        if (c.includes('.')) {
          const [head, tail] = c.split('.') as [string, string];
          filters.push((r) => Array.isArray(r[head]) && r[head].some((e: Row) => Number(e[tail] ?? 0) > Number(v)));
        } else filters.push((r) => Number(r[c] ?? 0) > Number(v));
        return builder;
      },
      not: (c: string, op: string, v: string | null) => {
        if (op === 'is' && v === null) { filters.push((r) => r[c] !== null && r[c] !== undefined); return builder; }
        if (op !== 'in') throw new Error(`fake: unsupported not(${op})`);
        const s = new Set(String(v).replace(/^\(|\)$/g, '').split(',').map((x) => x.trim().replace(/^"|"$/g, '')));
        const col = c.includes('.') ? c.split('.').pop()! : c;
        filters.push((r) => !s.has(String(r[col])));
        return builder;
      },
      or: () => builder,
      order: () => builder,
      range: () => builder,
      limit: () => builder,
      maybeSingle: async () => { const s = settle(); return { data: (s.data as Row[])?.[0] ?? null, error: null }; },
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(settle()).then(resolve),
    };
    return builder;
  };
  return { from, tables } as any;
}

/* The `postgres` tagged-template surface the scripts hold, narrowed to the ONE
   statement the enqueue issues, applied to the same fake store. Wiring only —
   the statement itself is proven against real PostgreSQL in tests-pg/. */
const fakeSql = (tables: Record<string, Row[]>) => {
  const tag = async (_strings: TemplateStringsArray, ...values: unknown[]) => {
    const [jobKey, reason] = values as [string, string];
    const q = (tables['stock_allocation_recompute_queue'] ??= []);
    const existing = q.find((r) => r.job_key === jobKey);
    if (existing) {
      // ON CONFLICT DO UPDATE names three columns and no others. attempts /
      // deferrals / state survive, which is what stops a script laundering a
      // dead-lettered job back into PENDING.
      existing.request_token = `tok-${q.length}-${Date.now()}`;
      existing.requested_at = new Date().toISOString();
      existing.reason = reason;
      return [{ state: existing.state }];
    }
    q.push({
      job_key: jobKey, request_token: 'tok-1', requested_at: new Date().toISOString(),
      reason, attempts: 0, deferrals: 0, state: 'PENDING', next_attempt_at: null,
      locked_by: null, locked_until: null,
    });
    return [{ state: 'PENDING' }];
  };
  return tag as any;
};

const WH = 'WH-BALAKONG';
const CODE = 'MATT-TEST-(Q)';

/* One ordinary POOLED mattress line, currently READY on one unit of stock — the
   exact shape of the three lines that regressed on 2026-09-08. `world()` then
   takes the unit away, which is what a re-seed script does when AutoCount's
   balance for that cell is lower than the ERP's. */
const world = (onHand: number) => fakeSb({
  stock_allocation_recompute_lock: [{ lock_key: 'GLOBAL', locked_by: null, locked_until: null }],
  stock_allocation_recompute_queue: [],
  mfg_sales_orders: [{
    doc_no: 'TEST-SO-0001', status: 'READY_TO_SHIP', created_at: '2026-08-01T00:00:00Z',
    customer_delivery_date: '2026-09-20', amended_delivery_date: null, company_id: 1,
    processing_date: '2026-08-15', proceeded_at: null,
    /* advanceSoGeneration CASes on version + status + an inactive edit lease.
       Without these three the header advance answers `conflict`, the drain
       reports `headers_leased:...` and defers — a healthy-looking soft defer
       that would hide whether the projection actually converged. */
    version: 1, edit_lease_token: null, edit_lease_expires_at: null,
  }],
  mfg_sales_order_items: [{
    id: 'line-1', doc_no: 'TEST-SO-0001', item_code: CODE, item_group: 'mattress',
    variants: null, qty: 1, warehouse_id: WH, stock_status: 'READY',
    stock_qty_ready: 1, cancelled: false, allocated_batch_no: null, po_items: [],
  }],
  mfg_products: [{ code: CODE, category: 'MATTRESS' }],
  inventory_balances: [{ warehouse_id: WH, item_code: CODE, variant_key: '', qty: onHand }],
  v_inventory_lots_open: [],
  delivery_orders: [], delivery_order_items: [], delivery_returns: [], delivery_return_items: [],
  purchase_order_items: [], mfg_so_audit_log: [], mfg_so_status_changes: [],
});

const lineOf = (sb: any) => sb.tables['mfg_sales_order_items'][0];
const headOf = (sb: any) => sb.tables['mfg_sales_orders'][0];
const queueOf = (sb: any) => sb.tables['stock_allocation_recompute_queue'];

describe('a script-shaped stock write and the readiness projection', () => {
  test('THE DEFECT: no queue row, so three cron sweeps in a row repair nothing', async () => {
    /* The script has already committed: the unit is gone from the balance. It
       wrote no queue row because it never went through a Worker. */
    const sb = world(0);
    expect(queueOf(sb)).toHaveLength(0);

    for (let sweep = 0; sweep < 3; sweep++) {
      const r = await drainStockAllocationRecomputeWithClient(sb);
      // "Nothing queued" is reported as COMPLETED, which is the honest answer to
      // the question the drain asks and the wrong answer to the question the
      // business asks. It is why this failure is silent.
      expect(r).toEqual({ processed: false, completed: true });
    }

    expect(lineOf(sb).stock_status).toBe('READY');
    expect(lineOf(sb).stock_qty_ready).toBe(1);
    // And the header still tells the floor the order can be shipped.
    expect(headOf(sb).status).toBe('READY_TO_SHIP');
  });

  test('THE REMEDY: the scripts-side enqueue makes the very NEXT sweep repair it', async () => {
    const sb = world(0);
    const sql = fakeSql(sb.tables);

    const queued = await enqueueStockAllocationRecompute(sql, 'reseed-stock-from-ac-snapshot');
    expect(queued).toEqual({ queued: true, reason: 'reseed-stock-from-ac-snapshot', state: 'PENDING' });
    expect(queueOf(sb)).toHaveLength(1);

    const r = await drainStockAllocationRecomputeWithClient(sb);
    expect(r.processed).toBe(true);
    expect(r.completed).toBe(true);

    expect(lineOf(sb).stock_status).toBe('PENDING');
    expect(lineOf(sb).stock_qty_ready).toBe(0);
    // The header follows the line back: READY_TO_SHIP -> CONFIRMED. That is
    // exactly what the three orders on 2026-09-08 did, one sweep too late.
    expect(headOf(sb).status).toBe('CONFIRMED');
    // The drain deletes the row it completed, so the next cron tick is a no-op
    // rather than a global sweep every five minutes forever.
    expect(queueOf(sb)).toHaveLength(0);
  });

  test('the enqueue is a REPAIR REQUEST, not a status flip: it never touches the line itself', async () => {
    /* Guard against the obvious wrong fix — a script that "fixes" stock_status
       directly. The projection has one author, and a queue row must not become
       a second one. */
    const sb = world(0);
    await enqueueStockAllocationRecompute(fakeSql(sb.tables), 'guard');
    expect(lineOf(sb).stock_status).toBe('READY');
  });

  test('an unattributed request is refused — a queue row nobody can trace is worse than none', async () => {
    const sb = world(0);
    await expect(enqueueStockAllocationRecompute(fakeSql(sb.tables), '')).rejects.toThrow(/reason is required/);
    expect(queueOf(sb)).toHaveLength(0);
  });
});
