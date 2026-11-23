/* Symptom: putting a Sales Order on hold, or taking it off, re-walked stock allocation twice in the background.
   Cause: the hold queued the GLOBAL retry row, then the deferred sweep ran and its catch-up drain found that
   same row and swept again (#5925 added the catch-up).
   Fix: the hold drains the row it queued (one sweep that also clears it) instead of sweep-then-catch-up.
   Drives the real hold route, the real queue code and the fake PostgREST queue table; only the sweep is a stub. */
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const recompute = vi.fn();
vi.mock('../src/scm/lib/so-stock-allocation', () => ({ recomputeSoStockAllocation: (sb: unknown) => recompute(sb) }));

import { fakeSb } from '../src/scm/lib/fake-postgrest';
const { mountHoldRoute } = await import('../src/scm/routes/document-hold-routes');

const DONE = { ok: true, linesFlipped: 0, ordersAdvanced: 0, ordersRegressed: 0 };

async function holdAndSettle(onHold: boolean, queue: Record<string, unknown>[] = []) {
  const sb = fakeSb({
    mfg_sales_orders: [{ doc_no: 'SO-1', status: 'CONFIRMED', company_id: 1, on_hold: !onHold }],
    stock_allocation_recompute_queue: queue,
  });
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, 1 as never);
    c.set('user' as never, { id: 'u-1' } as never);
    await next();
  });
  mountHoldRoute(app, 'so');
  const waited: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => { waited.push(p); }, passThroughOnException: () => {}, props: {} };
  const res = await app.request('/SO-1/hold', {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ onHold, reason: 'customer asked' }),
  }, {}, ctx as never);
  await Promise.all(waited);
  return { res, sb, waited };
}

describe('SO hold re-walks stock allocation once', () => {
  it.each([true, false])('onHold=%s: one sweep, and the queued row is cleared', async (onHold) => {
    recompute.mockReset();
    recompute.mockResolvedValue(DONE);
    const { res, sb, waited } = await holdAndSettle(onHold);
    expect(res.status).toBe(200);
    expect(waited).toHaveLength(1);
    expect(recompute).toHaveBeenCalledTimes(1);
    expect(sb.tables.stock_allocation_recompute_queue).toEqual([]);
  });

  it('a parked (dead-lettered) row still gets one sweep for the hold, and stays parked', async () => {
    recompute.mockReset();
    recompute.mockResolvedValue(DONE);
    const { sb } = await holdAndSettle(true, [{ job_key: 'GLOBAL', request_token: 'old', state: 'DEAD', attempts: 5, deferrals: 0 }]);
    expect(recompute).toHaveBeenCalledTimes(1);
    expect(sb.tables.stock_allocation_recompute_queue).toHaveLength(1);
  });
});
