import { beforeEach, describe, expect, test, vi } from 'vitest';

import {
  drainStockAllocationRecomputeWithClient,
  enqueueStockAllocationRecompute,
  deferralBackoffMs,
} from '../src/scm/lib/stock-allocation-job';
import allocationSource from '../src/scm/lib/so-stock-allocation.ts?raw';

const recompute = vi.fn();

type Row = {
  job_key: string;
  request_token: string;
  requested_at: string;
  attempts: number;
  last_error: string | null;
  locked_by: string | null;
  locked_until: string | null;
  reason?: string;
  deferrals?: number;
  state?: string | null;
  next_attempt_at?: string | null;
  dead_lettered_at?: string | null;
};

function queueClient(initial?: Row) {
  let row = initial ? { ...initial } : null;
  class Query implements PromiseLike<{ data: unknown; error: null }> {
    private op: 'select' | 'update' | 'delete' | 'upsert' = 'select';
    private patch: Record<string, unknown> = {};
    private filters: Array<[string, unknown]> = [];
    select() { return this; }
    upsert(value: Record<string, unknown>) { this.op = 'upsert'; this.patch = value; return this; }
    update(value: Record<string, unknown>) { this.op = 'update'; this.patch = value; return this; }
    delete() { this.op = 'delete'; return this; }
    eq(column: string, value: unknown) { this.filters.push([column, value]); return this; }
    or() { return this; }
    maybeSingle() { return this.execute(); }
    private matches() { return row != null && this.filters.every(([key, value]) => (row as unknown as Record<string, unknown>)[key] === value); }
    private async execute() {
      if (this.op === 'upsert') {
        row = { ...(row ?? {}), ...this.patch } as Row;
        return { data: row, error: null };
      }
      if (this.op === 'update') {
        if (!this.matches()) return { data: null, error: null };
        row = { ...row!, ...this.patch };
        return { data: row, error: null };
      }
      if (this.op === 'delete') {
        if (!this.matches()) return { data: null, error: null };
        const deleted = row;
        row = null;
        return { data: deleted, error: null };
      }
      return { data: this.matches() ? row : null, error: null };
    }
    then<TResult1 = { data: unknown; error: null }, TResult2 = never>(
      onfulfilled?: ((value: { data: unknown; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ) { return this.execute().then(onfulfilled, onrejected); }
  }
  return {
    client: { from: () => new Query() },
    get row() { return row; },
    replace(next: Row) { row = next; },
  };
}

const pending = (): Row => ({
  job_key: 'GLOBAL', request_token: '00000000-0000-4000-8000-000000000001',
  requested_at: '2026-07-21T00:00:00.000Z', attempts: 0,
  last_error: null, locked_by: null, locked_until: null,
});

describe('durable stock-allocation recompute queue', () => {
  beforeEach(() => recompute.mockReset());

  test('keeps and unlocks the job when recompute reports ok=false', async () => {
    const state = queueClient(pending());
    recompute.mockResolvedValue({ ok: false, reason: 'injected allocation failure' });
    const result = await drainStockAllocationRecomputeWithClient(state.client, recompute);
    expect(result).toMatchObject({ processed: true, completed: false, reason: 'injected allocation failure' });
    expect(state.row).toMatchObject({ attempts: 1, last_error: 'injected allocation failure', locked_by: null, locked_until: null });
  });

  test('the timestamp fence preserves work enqueued while recompute is running', async () => {
    const state = queueClient(pending());
    recompute.mockImplementation(async () => {
      state.replace({
        ...state.row!,
        request_token: '00000000-0000-4000-8000-000000000002',
        requested_at: '2026-07-21T00:01:00.000Z',
        reason: 'new mutation',
      });
      return { ok: true };
    });
    const result = await drainStockAllocationRecomputeWithClient(state.client, recompute);
    expect(result).toMatchObject({ processed: true, completed: false, deferred: true, reason: 'new_work_arrived' });
    expect(state.row).toMatchObject({
      request_token: '00000000-0000-4000-8000-000000000002',
      requested_at: '2026-07-21T00:01:00.000Z',
      locked_by: null,
      locked_until: null,
    });
  });

  test('successful recompute deletes only the claimed generation', async () => {
    const state = queueClient();
    await enqueueStockAllocationRecompute(state.client, 'tbc-swap:SO-1');
    recompute.mockResolvedValue({ ok: true });
    expect(await drainStockAllocationRecomputeWithClient(state.client, recompute)).toMatchObject({ processed: true, completed: true });
    expect(state.row).toBeNull();
  });
});

/* ── REGRESSION: livelock (defect 2, 2026-07-22) ──────────────────────────────
   The SO edit lease is five minutes and the retry cron is five minutes. The
   recompute used to THROW the moment any one order was under an edit lease, so
   the whole global projection failed, and the next sweep — one lease-length
   later — met the same still-leased order. Two equal timers: it could fail
   forever while looking like it was retrying, and every order queued after the
   leased one never had its header evaluated at all. */
describe('allocation recompute makes progress under an edit lease', () => {
  beforeEach(() => recompute.mockReset());

  test('a leased header is skipped, not thrown — the sweep still walks every other order', () => {
    // The two header-transition branches must record the deferral and continue.
    expect(allocationSource).not.toContain('allocation header advance deferred');
    expect(allocationSource).not.toContain('allocation header regression deferred');
    expect(allocationSource).toContain('deferredDocNos.push(');
    expect(allocationSource).toContain('SKIP AND CONTINUE');
  });

  test('a deferral is not a failure: attempts stay put and the job never dead-letters', async () => {
    const state = queueClient(pending());
    recompute.mockResolvedValue({ ok: true, deferredDocNos: ['SO-2607-0001:lease'] });
    // Force the backoff to its floor so the row is due again immediately.
    for (let sweep = 0; sweep < 40; sweep++) {
      state.replace({ ...state.row!, next_attempt_at: null });
      const result = await drainStockAllocationRecomputeWithClient(state.client, recompute, () => 0);
      expect(result).toMatchObject({ processed: true, completed: false, deferred: true });
      expect(result.deadLettered).toBeFalsy();
    }
    // 40 sweeps is four times the hard-failure dead-letter threshold.
    expect(state.row).toMatchObject({ attempts: 0, deferrals: 40 });
    expect(state.row!.state ?? 'PENDING').toBe('PENDING');
    expect(state.row!.last_error).toContain('headers_leased');
  });

  test('the deferral backoff is jittered and never lands on the five-minute beat', () => {
    for (const deferrals of [1, 2, 3, 4, 9]) {
      const low = deferralBackoffMs(deferrals, () => 0);
      const high = deferralBackoffMs(deferrals, () => 0.999);
      expect(low).toBeGreaterThan(0);
      expect(high).toBeGreaterThan(low);          // jitter actually widens the window
      expect(high).toBeLessThan(5 * 60_000);      // strictly inside the cron/lease period
    }
  });
});

/* ── REGRESSION: dead letter + attempt survival (defect 3, 2026-07-22) ─────────
   `attempts` used to be listed in the enqueue upsert payload, so every new
   mutation reset the failure counter to 0; combined with the absence of any
   terminal state a permanently broken recompute retried forever and never
   surfaced. */
describe('stock-allocation queue dead-lettering', () => {
  beforeEach(() => recompute.mockReset());

  test('re-enqueue does not reset the attempt count', async () => {
    const state = queueClient(pending());
    recompute.mockResolvedValue({ ok: false, reason: 'injected allocation failure' });
    await drainStockAllocationRecomputeWithClient(state.client, recompute);
    expect(state.row).toMatchObject({ attempts: 1 });

    await enqueueStockAllocationRecompute(state.client, 'tbc-update:SO-2');
    expect(state.row).toMatchObject({ attempts: 1, reason: 'tbc-update:SO-2' });

    await drainStockAllocationRecomputeWithClient(state.client, recompute);
    expect(state.row).toMatchObject({ attempts: 2 });
  });

  test('a permanently failing job reaches a terminal state and stops spinning', async () => {
    const state = queueClient(pending());
    recompute.mockResolvedValue({ ok: false, reason: 'relation scm.stock_balances does not exist' });

    let last = await drainStockAllocationRecomputeWithClient(state.client, recompute);
    for (let i = 1; i < 10; i++) {
      // A mutation between attempts must NOT rescue the counter.
      await enqueueStockAllocationRecompute(state.client, `tbc-update:SO-${i}`);
      last = await drainStockAllocationRecomputeWithClient(state.client, recompute);
    }
    expect(last).toMatchObject({ deadLettered: true, attempts: 10 });
    expect(state.row).toMatchObject({ state: 'DEAD', attempts: 10 });
    expect(state.row!.dead_lettered_at).toBeTruthy();
    expect(state.row!.last_error).toContain('relation scm.stock_balances does not exist');

    // Parked: no further recompute is attempted, and the reason is reported.
    recompute.mockClear();
    const parked = await drainStockAllocationRecomputeWithClient(state.client, recompute);
    expect(recompute).not.toHaveBeenCalled();
    expect(parked).toMatchObject({ processed: false, completed: false, deadLettered: true });
    expect(parked.reason).toContain('dead_letter');
  });
});
