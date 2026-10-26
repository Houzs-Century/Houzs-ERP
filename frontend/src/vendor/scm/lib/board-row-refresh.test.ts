/* Owner 2026-10-27 option A: an edit re-reads only the edited orders. */
import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlanningOrder, PlanningResponse } from './delivery-planning-queries';

const fetchMock = vi.fn();
vi.mock('./authed-fetch', () => ({ authedFetch: (url: string) => fetchMock(url) }));
const { mergeRowsIntoBoard, scheduleRowRefresh } = await import('./board-row-refresh');

const row = (doc: string, state: string, date: string | null = null, regions = ['KL']): PlanningOrder =>
  ({ row_type: 'so', so_doc_no: doc, delivery_state: state, amended_delivery_date: date, regions } as unknown as PlanningOrder);
const board = (orders: PlanningOrder[]): PlanningResponse => ({ orders, counts: {} as PlanningResponse['counts'], regions: [] });

afterEach(() => { fetchMock.mockReset(); vi.useRealTimers(); });

describe('mergeRowsIntoBoard', () => {
  it('replaces the edited row in place and leaves every other row alone', () => {
    const prev = board([row('A', 'PENDING_SCHEDULE', '2026-10-20'), row('B', 'PENDING_DELIVERY')]);
    const out = mergeRowsIntoBoard(prev, ['delivery-planning', 'ALL', 'OPEN'], ['A'], [row('A', 'PENDING_SCHEDULE', '2026-10-28')]);
    expect(out.orders.map((o) => [o.so_doc_no, o.amended_delivery_date])).toEqual([['A', '2026-10-28'], ['B', null]]);
    expect(out.orders[1]).toBe(prev.orders[1]);
  });
  it('takes a row out of a slice it no longer fits, and out when it no longer exists', () => {
    const prev = board([row('A', 'PENDING_SCHEDULE'), row('B', 'PENDING_SCHEDULE')]);
    const out = mergeRowsIntoBoard(prev, ['delivery-planning', 'ALL', 'OPEN'], ['A', 'B'], [row('A', 'DELIVERED')]);
    expect(out.orders).toEqual([]);
  });
  it('adds a row that newly fits the slice', () => {
    const out = mergeRowsIntoBoard(board([]), ['delivery-planning', 'ALL', 'PENDING_SCHEDULE'], ['A'], [row('A', 'PENDING_SCHEDULE')]);
    expect(out.orders.map((o) => o.so_doc_no)).toEqual(['A']);
  });
});

describe('scheduleRowRefresh', () => {
  it('coalesces a burst into one request and writes the fresh row into the cached board', async () => {
    vi.useFakeTimers();
    const qc = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
    qc.setQueryData(['delivery-planning', 'ALL', 'OPEN'], board([row('A', 'PENDING_SCHEDULE', '2026-10-20'), row('B', 'PENDING_DELIVERY')]));
    fetchMock.mockResolvedValue(board([row('A', 'PENDING_SCHEDULE', '2026-10-28'), row('B', 'PENDING_DELIVERY', '2026-11-01')]));
    scheduleRowRefresh(qc, ['A']);
    scheduleRowRefresh(qc, ['B']);
    await vi.runAllTimersAsync();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toContain('docs=A%2CB');
    const cached = qc.getQueryData<PlanningResponse>(['delivery-planning', 'ALL', 'OPEN'])!;
    expect(cached.orders.map((o) => o.amended_delivery_date)).toEqual(['2026-10-28', '2026-11-01']);
  });
  it('a failed row read is never merged: the board is re-read instead', async () => {
    vi.useFakeTimers();
    const qc = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
    qc.setQueryData(['delivery-planning', 'ALL', 'OPEN'], board([row('A', 'PENDING_SCHEDULE', '2026-10-20')]));
    const spy = vi.spyOn(qc, 'invalidateQueries');
    fetchMock.mockRejectedValue(new Error('network'));
    scheduleRowRefresh(qc, ['A']);
    await vi.runAllTimersAsync();
    expect(spy).toHaveBeenCalledWith({ queryKey: ['delivery-planning'] });
    expect(qc.getQueryData<PlanningResponse>(['delivery-planning', 'ALL', 'OPEN'])!.orders[0]!.amended_delivery_date).toBe('2026-10-20');
  });
  it('an older response never overwrites a newer one for the same order', async () => {
    vi.useFakeTimers();
    const qc = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
    qc.setQueryData(['delivery-planning', 'ALL', 'OPEN'], board([row('A', 'PENDING_SCHEDULE', '2026-10-20')]));
    let releaseFirst: (v: PlanningResponse) => void = () => undefined;
    fetchMock
      .mockImplementationOnce(() => new Promise<PlanningResponse>((r) => { releaseFirst = r; }))
      .mockResolvedValueOnce(board([row('A', 'PENDING_SCHEDULE', '2026-10-30')]));
    scheduleRowRefresh(qc, ['A']);
    await vi.advanceTimersByTimeAsync(600);   // first request in flight
    scheduleRowRefresh(qc, ['A']);
    await vi.advanceTimersByTimeAsync(600);   // second request answers 30
    releaseFirst(board([row('A', 'PENDING_SCHEDULE', '2026-10-28')]));   // the older answer lands late
    await vi.runAllTimersAsync();
    expect(qc.getQueryData<PlanningResponse>(['delivery-planning', 'ALL', 'OPEN'])!.orders[0]!.amended_delivery_date).toBe('2026-10-30');
  });
});
