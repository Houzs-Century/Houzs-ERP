/* A stock or SO save answers before the whole-company allocation re-walk
   (port of Conts D16). The re-walk runs on the request's waitUntil; a burst of
   saves shares one catch-up sweep; scripts, cron and unit tests still run it
   inline; the manual "Re-allocate stock" endpoint still waits for its result. */
import { describe, expect, it, vi } from 'vitest';

const recompute = vi.fn();
vi.mock('../src/scm/lib/so-stock-allocation', () => ({ recomputeSoStockAllocation: (sb: unknown) => recompute(sb) }));

import { withAfterResponse } from '../src/lib/after-response';
import { drainCoalesced, recomputeAllocationAfterSave } from '../src/scm/lib/stock-allocation-job';

const DONE = { ok: true, linesFlipped: 0, ordersAdvanced: 0, ordersRegressed: 0 };

/* A queue table with nothing pending: the catch-up drain reads once and stops. */
function emptyQueueSb(reads: string[]) {
  const chain = (): Record<string, unknown> => {
    const b: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'or', 'update', 'delete', 'upsert']) b[m] = () => b;
    b.maybeSingle = async () => ({ data: null, error: null });
    return b;
  };
  return { from: (t: string) => { reads.push(t); return chain(); } };
}

describe('recomputeAllocationAfterSave', () => {
  it('inside a request: returns before the sweep finishes and hands it to waitUntil', async () => {
    recompute.mockReset();
    let finish!: () => void;
    recompute.mockImplementation(() => new Promise((ok) => { finish = () => ok(DONE); }));
    const waited: Promise<unknown>[] = [];
    const reads: string[] = [];
    await withAfterResponse((p) => { waited.push(p); }, () => recomputeAllocationAfterSave(emptyQueueSb(reads), 'test-save'));
    expect(waited).toHaveLength(1);
    expect(recompute).toHaveBeenCalledTimes(1);
    expect(reads).toEqual([]);
    finish();
    await waited[0];
    /* The sweep finished, so it looked once for saves that queued behind it. */
    expect(reads).toEqual(['stock_allocation_recompute_queue']);
  });

  it('outside a request (cron, scripts, tests): runs the sweep inline as before', async () => {
    recompute.mockReset();
    recompute.mockResolvedValue(DONE);
    await recomputeAllocationAfterSave(emptyQueueSb([]), 'script');
    expect(recompute).toHaveBeenCalledTimes(1);
  });

  it('a save whose sweep lost the lock leaves the catch-up to the running sweep', async () => {
    recompute.mockReset();
    recompute.mockResolvedValue({ ...DONE, reason: 'another_recompute_in_progress', queuedForRetry: true });
    const reads: string[] = [];
    await recomputeAllocationAfterSave(emptyQueueSb(reads), 'loser');
    expect(reads).toEqual([]);
  });

  it('a failing sweep is logged, never thrown into the save', async () => {
    recompute.mockReset();
    recompute.mockRejectedValue(new Error('boom'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(recomputeAllocationAfterSave(emptyQueueSb([]), 'boom')).resolves.toBeUndefined();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

describe('drainCoalesced', () => {
  it('runs again while saves keep arriving, then stops', async () => {
    const drain = vi.fn()
      .mockResolvedValueOnce({ processed: true, completed: false, deferred: true, reason: 'new_work_arrived' })
      .mockResolvedValueOnce({ processed: true, completed: true });
    const r = await drainCoalesced({}, drain);
    expect(drain).toHaveBeenCalledTimes(2);
    expect(r.completed).toBe(true);
  });

  it('is bounded: a constant stream leaves the row for the cron', async () => {
    const drain = vi.fn().mockResolvedValue({ processed: true, completed: false, deferred: true, reason: 'new_work_arrived' });
    await drainCoalesced({}, drain);
    expect(drain).toHaveBeenCalledTimes(4);
  });

  it('does not repeat when another sweep holds the job', async () => {
    const drain = vi.fn().mockResolvedValue({ processed: false, completed: false, deferred: true, reason: 'job_already_claimed' });
    await drainCoalesced({}, drain);
    expect(drain).toHaveBeenCalledTimes(1);
  });
});

describe('no save route waits for the whole-company sweep', () => {
  const sources = import.meta.glob(['../src/scm/**/*.ts', '!../src/scm/**/*.test.ts'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
  it('only the manual "Re-allocate stock" endpoint and the job itself call the sweep inline', () => {
    const inline = Object.entries(sources)
      .map(([f, src]) => ({ f, n: src.split('await recomputeSoStockAllocation(').length - 1 }))
      .filter((x) => x.n > 0)
      .map((x) => `${x.f.replace('../', '')}:${x.n}`)
      .sort();
    expect(inline).toEqual([
      'src/scm/lib/so-stock-allocation.ts:2', // its own comments
      'src/scm/lib/stock-allocation-job.ts:1',
      'src/scm/routes/mfg-sales-orders.ts:1',
    ]);
  });
});
