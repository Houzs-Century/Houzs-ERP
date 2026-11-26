import { afterEach, describe, expect, test, vi } from 'vitest';
import type { QueryClient } from '@tanstack/react-query';

import { scheduleBoardRefresh, BOARD_REFRESH_MS } from './delivery-planning-queries';

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
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

describe('scheduleBoardRefresh — coalesced board refresh', () => {
  test('fires nothing until the quiet window elapses, then once', () => {
    vi.useFakeTimers();
    const { qc, calls } = fakeQc();

    scheduleBoardRefresh(qc, [['delivery-planning']]);
    vi.advanceTimersByTime(BOARD_REFRESH_MS - 1);
    expect(calls).toHaveLength(0);

    vi.advanceTimersByTime(1);
    expect(calls).toEqual([['delivery-planning']]);
  });

  test('a burst of commits coalesces into ONE invalidation of the UNIONED keys', () => {
    vi.useFakeTimers();
    const { qc, calls } = fakeQc();

    scheduleBoardRefresh(qc, [['delivery-planning'], ['fleet-day']]);
    vi.advanceTimersByTime(BOARD_REFRESH_MS - 50);
    scheduleBoardRefresh(qc, [['delivery-planning'], ['scm-trips']]);
    vi.advanceTimersByTime(BOARD_REFRESH_MS - 50);
    scheduleBoardRefresh(qc, [['delivery-planning'], ['mfg-delivery-orders']]);

    vi.advanceTimersByTime(BOARD_REFRESH_MS - 1);
    expect(calls).toHaveLength(0);

    vi.advanceTimersByTime(1);
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
    expect(calls).toEqual([['delivery-planning']]);
  });
});
