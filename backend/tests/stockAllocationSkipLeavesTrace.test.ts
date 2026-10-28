/* A recompute that did not happen must not report success and vanish.
 *
 * `recomputeSoStockAllocation` claims a durable singleton lease. When another
 * recompute already holds it, the claim UPDATE matches no row and the function
 * returned `{ ok: true, reason: 'another_recompute_in_progress' }`. All ~34
 * best-effort triggers write `await recomputeSoStockAllocation(sb)` and discard
 * the result, so that `true` meant "nothing happened, and nobody will retry" —
 * the five-minute cron only drains QUEUE rows, and a best-effort trigger writes
 * none. Two GRNs posted close together therefore left the second one's lines
 * stale deterministically, which is how 2990-SO-2608-002 came to print
 * `SHORT: MATTRESS` over a mattress that was in the warehouse.
 *
 * These pin that every non-finishing outcome now leaves a durable retry row.
 */
import { describe, it, expect } from 'vitest';
import { recomputeSoStockAllocation } from '../src/scm/lib/so-stock-allocation';

type Upsert = { table: string; row: Record<string, unknown> };

/** Minimal PostgREST-shaped fake: chainable, thenable, and it RECORDS the
 *  upserts so the assertion is about a durable row existing, not about a
 *  function having been called. */
function fakeSb(opts: {
  lockClaimed: boolean;
  enqueueFails?: boolean;
  orders?: Array<Record<string, unknown>>;
}) {
  const upserts: Upsert[] = [];
  const make = (table: string) => {
    const result = (): { data: unknown; error: { message: string } | null } => {
      if (table === 'stock_allocation_recompute_lock') {
        return { data: opts.lockClaimed ? { lock_key: 'GLOBAL' } : null, error: null };
      }
      if (table === 'mfg_sales_orders') return { data: opts.orders ?? [], error: null };
      return { data: [], error: null };
    };
    const builder: Record<string, unknown> = {
      upsert(row: Record<string, unknown>) {
        upserts.push({ table, row });
        return opts.enqueueFails
          ? { error: { message: 'queue table unavailable' } }
          : { error: null };
      },
      then(resolve: (v: unknown) => unknown) { return Promise.resolve(result()).then(resolve); },
      maybeSingle() { return Promise.resolve(result()); },
    };
    for (const m of ['select', 'update', 'eq', 'or', 'not', 'in', 'order', 'range', 'gt', 'insert', 'delete']) {
      builder[m] = () => builder;
    }
    return builder;
  };
  return { sb: { from: (table: string) => make(table) }, upserts };
}

const QUEUE = 'stock_allocation_recompute_queue';

describe('a skipped recompute leaves a durable trace', () => {
  it('losing the single-flight race enqueues a retry row and SAYS so', async () => {
    const { sb, upserts } = fakeSb({ lockClaimed: false });
    const res = await recomputeSoStockAllocation(sb);

    // The historic return shape is unchanged — the drain keys off it.
    expect(res.ok).toBe(true);
    expect(res.reason).toBe('another_recompute_in_progress');
    // ... but it no longer means "nothing to do".
    expect(res.queuedForRetry).toBe(true);
    const queued = upserts.filter((u) => u.table === QUEUE);
    expect(queued).toHaveLength(1);
    expect(String(queued[0]!.row.reason)).toContain('another_recompute_in_progress');
    expect(queued[0]!.row.job_key).toBe('GLOBAL');
    // A retry row with no token cannot be fenced against a newer request.
    expect(typeof queued[0]!.row.request_token).toBe('string');
  });

  it('a recompute that FINISHES writes no retry row', async () => {
    /* The negative half, and the one that stops this becoming a write on every
       GRN: lock claimed, zero live orders, nothing left outstanding. */
    const { sb, upserts } = fakeSb({ lockClaimed: true, orders: [] });
    const res = await recomputeSoStockAllocation(sb);
    expect(res.ok).toBe(true);
    expect(res.reason).toBeUndefined();
    expect(res.queuedForRetry).toBeUndefined();
    expect(upserts.filter((u) => u.table === QUEUE)).toHaveLength(0);
  });

  it('when the retry row itself cannot be written, it says FALSE rather than true', async () => {
    /* The projection is stale AND nothing will retry. That state has to be
       distinguishable from a healthy skip, or the next reader inherits the same
       "ok means done" error one level up. */
    const { sb, upserts } = fakeSb({ lockClaimed: false, enqueueFails: true });
    const res = await recomputeSoStockAllocation(sb);
    expect(res.queuedForRetry).toBe(false);
    expect(upserts.filter((u) => u.table === QUEUE)).toHaveLength(1); // attempted
  });

  it('a failed lock read also leaves a trace — ok:false was equally silent', async () => {
    const sb = {
      from: (table: string) => {
        const builder: Record<string, unknown> = {
          upsert: () => ({ error: null }),
          maybeSingle: () => Promise.resolve({ data: null, error: { message: 'lock table gone' } }),
          then: (r: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(r),
        };
        for (const m of ['select', 'update', 'eq', 'or', 'not', 'in', 'order', 'range', 'gt']) builder[m] = () => builder;
        void table;
        return builder;
      },
    };
    const res = await recomputeSoStockAllocation(sb);
    expect(res.ok).toBe(false);
    expect(res.queuedForRetry).toBe(true);
  });
});
