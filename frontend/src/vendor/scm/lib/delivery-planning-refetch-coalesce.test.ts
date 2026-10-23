/* PERF 2026-10-23: the Delivery Planning board used to refetch its whole payload
 * on EVERY inline cell commit (status / date / driver / lorry / HC field / crew),
 * which was the board's main typing/scroll stutter — worst when a large refetch
 * landed mid-edit. scheduleBoardRefresh replaced those eager, per-edit
 * invalidations with a COALESCED one: a burst of commits arms a single timer and
 * fires ONE invalidation once the operator stops. These tests lock that contract
 * so a future edit can't quietly reintroduce the per-edit refetch.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { QueryClient } from '@tanstack/react-query';

import { scheduleBoardRefresh, BOARD_REFRESH_MS } from './delivery-planning-queries';

/* A QueryClient stand-in that records the keys it was asked to invalidate — the
 * one effect these tests care about. */
function fakeQc() {
  const calls: unknown[][] = [];
  const qc = {
    invalidateQueries: ({ queryKey }: { queryKey: readonly unknown[] }) => {
      calls.push([...queryKey]);
      return Promise.resolve();
    },
  } as unknown as QueryClient;
  return { qc, calls };
}

afterEach(() => {
  // Flush any armed timer so module-level state never leaks between tests, then
  // return to real timers.
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

describe('scheduleBoardRefresh — coalesced board refresh', () => {
  test('fires nothing until the quiet window elapses, then once', () => {
    vi.useFakeTimers();
    const { qc, calls } = fakeQc();

    scheduleBoardRefresh(qc, [['delivery-planning']]);
    vi.advanceTimersByTime(BOARD_REFRESH_MS - 1);
    expect(calls).toHaveLength(0); // a refetch must NOT land mid-edit

    vi.advanceTimersByTime(1);
    expect(calls).toEqual([['delivery-planning']]);
  });

  test('a burst of commits coalesces into ONE invalidation of the UNIONED keys', () => {
    vi.useFakeTimers();
    const { qc, calls } = fakeQc();

    // Three rapid edits inside the window, each resetting the timer — the shape of
    // a bulk apply / fast sequential cell edits across the three inline-edit hooks.
    scheduleBoardRefresh(qc, [['delivery-planning'], ['fleet-day']]);
    vi.advanceTimersByTime(BOARD_REFRESH_MS - 50);
    scheduleBoardRefresh(qc, [['delivery-planning'], ['scm-trips']]);
    vi.advanceTimersByTime(BOARD_REFRESH_MS - 50);
    scheduleBoardRefresh(qc, [['delivery-planning'], ['mfg-delivery-orders']]);

    // Still nothing — each call pushed the deadline out.
    vi.advanceTimersByTime(BOARD_REFRESH_MS - 1);
    expect(calls).toHaveLength(0);

    vi.advanceTimersByTime(1);
    // delivery-planning asked for 3x, invalidated once; every distinct root once.
    expect(calls).toHaveLength(4);
    expect(calls).toContainEqual(['delivery-planning']);
    expect(calls).toContainEqual(['fleet-day']);
    expect(calls).toContainEqual(['scm-trips']);
    expect(calls).toContainEqual(['mfg-delivery-orders']);
  });

  test('re-arms for a later burst (keys do not leak from the previous one)', () => {
    vi.useFakeTimers();
    const { qc, calls } = fakeQc();

    scheduleBoardRefresh(qc, [['delivery-planning'], ['fleet-day']]);
    vi.advanceTimersByTime(BOARD_REFRESH_MS);
    expect(calls).toHaveLength(2);

    calls.length = 0;
    scheduleBoardRefresh(qc, [['delivery-planning']]);
    vi.advanceTimersByTime(BOARD_REFRESH_MS);
    expect(calls).toEqual([['delivery-planning']]); // not carrying fleet-day over
  });
});
