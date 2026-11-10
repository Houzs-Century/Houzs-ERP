/* Owner 2026-10-27 option B: the board re-reads only the orders others changed.
   Owner 2026-11-10: every band re-read every 5 min, at once on the listed
   triggers, nothing while hidden, a counts_only safety net. */
import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlanningCounts } from './delivery-planning-queries';
import type { BoardChanges } from './board-change-poll';

const rowRefresh = vi.fn();
vi.mock('./board-row-refresh', () => ({ scheduleRowRefresh: (_qc: unknown, docs: string[]) => rowRefresh(docs) }));
vi.mock('./authed-fetch', () => ({ authedFetch: vi.fn() }));
const {
  refreshChangedRows, editingDocs, createBoardRefresher, countsDiffer,
  CHANGE_POLL_MS, BOARD_FULL_REREAD_MS, HIDDEN_REREAD_AFTER_MS, COUNTS_CHECK_MS,
} = await import('./board-change-poll');

const counts = (all: number): PlanningCounts =>
  ({ ALL: all, PENDING_DELIVERY: all, PENDING_SCHEDULE: 0, OVERDUE: 0, DELIVERED: 0 });

function rig(o: { feed?: boolean; poll?: boolean; server?: PlanningCounts; loaded?: PlanningCounts | null } = {}) {
  const rows = vi.fn();
  let visible = true;
  let today = '2026-11-10';
  const fullReread = vi.fn();
  const fetchChanges = vi.fn(async (after: number | null): Promise<BoardChanges> => ({ cursor: (after ?? 1000) + 1, docs: [], others: false, full: false }));
  const fetchCounts = vi.fn(async () => o.server ?? counts(5));
  const r = createBoardRefresher({
    now: () => Date.now(),
    today: () => today,
    visible: () => visible,
    fullReread,
    feed: o.feed === false ? null : { read: fetchChanges, rows },
    pollFeed: o.poll ?? true,
    counts: o.server ? { read: fetchCounts, loaded: () => (o.loaded === undefined ? counts(5) : o.loaded) } : null,
  });
  return {
    r, fullReread, fetchChanges, fetchCounts, rows,
    setDay: (d: string) => { today = d; },
    hide: () => { visible = false; r.onVisibility(); },
    show: () => { visible = true; r.onVisibility(); },
  };
}

afterEach(() => { vi.useRealTimers(); });

describe('refreshChangedRows', () => {
  it('re-reads the changed orders, except one with an edit still in flight here', async () => {
    rowRefresh.mockReset();
    const qc = new QueryClient();
    let release: () => void = () => undefined;
    const m = qc.getMutationCache().build(qc, { networkMode: 'always', mutationFn: () => new Promise<void>((r) => { release = r; }) });
    const running = m.execute({ type: 'so', id: 'SO-2' });
    await new Promise((r) => setTimeout(r, 0));   // the mutation starts asynchronously
    expect([...editingDocs(qc)]).toEqual(['SO-2']);
    refreshChangedRows(qc, { cursor: 5, docs: ['SO-1', 'SO-2'], others: false, full: false });
    expect(rowRefresh).toHaveBeenCalledWith(['SO-1']);
    release(); await running;
  });
});

describe('createBoardRefresher', () => {
  it('re-reads every band once per BOARD_FULL_REREAD_MS (5 min), the feed every 30 s', async () => {
    expect(BOARD_FULL_REREAD_MS).toBe(5 * 60_000);
    vi.useFakeTimers();
    const t = rig();
    t.r.start();
    await vi.advanceTimersByTimeAsync(BOARD_FULL_REREAD_MS - CHANGE_POLL_MS);
    expect(t.fullReread).not.toHaveBeenCalled();
    expect(t.fetchChanges).toHaveBeenCalledTimes(BOARD_FULL_REREAD_MS / CHANGE_POLL_MS); // start + 9 ticks
    await vi.advanceTimersByTimeAsync(CHANGE_POLL_MS);
    expect(t.fullReread).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(BOARD_FULL_REREAD_MS);
    expect(t.fullReread).toHaveBeenCalledTimes(2);
    t.r.stop();
  });

  it('a service / DP / project change waits for the scheduled re-read; `full` re-reads at once', async () => {
    vi.useFakeTimers();
    const t = rig();
    t.fetchChanges
      .mockResolvedValueOnce({ cursor: 10, docs: [], others: false, full: false })
      .mockResolvedValueOnce({ cursor: 11, docs: [], others: true, full: false })
      .mockResolvedValueOnce({ cursor: 12, docs: [], others: false, full: true });
    t.r.start();
    await vi.advanceTimersByTimeAsync(CHANGE_POLL_MS);
    expect(t.fullReread).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(CHANGE_POLL_MS);
    expect(t.fullReread).toHaveBeenCalledTimes(1);
    t.r.stop();
  });

  it('the MYT date changing re-reads every band at the next tick', async () => {
    vi.useFakeTimers();
    const t = rig();
    t.r.start();
    await vi.advanceTimersByTimeAsync(CHANGE_POLL_MS);
    expect(t.fullReread).not.toHaveBeenCalled();
    t.setDay('2026-11-11');
    await vi.advanceTimersByTimeAsync(CHANGE_POLL_MS);
    expect(t.fullReread).toHaveBeenCalledTimes(1);
    t.r.stop();
  });

  it('hidden: no change feed and no re-read, however long', async () => {
    vi.useFakeTimers();
    const t = rig();
    t.r.start();
    await vi.advanceTimersByTimeAsync(0);
    t.fetchChanges.mockClear();
    t.hide();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(t.fetchChanges).not.toHaveBeenCalled();
    expect(t.fullReread).not.toHaveBeenCalled();
    t.r.stop();
  });

  it('a hidden start polls nothing until shown', async () => {
    vi.useFakeTimers();
    const t = rig();
    t.hide();
    t.r.start();
    await vi.advanceTimersByTimeAsync(10 * CHANGE_POLL_MS);
    expect(t.fetchChanges).not.toHaveBeenCalled();
    t.r.stop();
  });

  it('shown after more than 10 min hidden: every band re-read, and the feed at once', async () => {
    vi.useFakeTimers();
    const t = rig();
    t.r.start();
    await vi.advanceTimersByTimeAsync(0);
    t.hide();
    await vi.advanceTimersByTimeAsync(HIDDEN_REREAD_AFTER_MS + 1);
    t.fetchChanges.mockClear();
    t.show();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.fullReread).toHaveBeenCalledTimes(1);
    expect(t.fetchChanges).toHaveBeenCalledTimes(1);
    t.r.stop();
  });

  it('shown after a short hide: only the feed; the 5 min clock counts visible time only', async () => {
    vi.useFakeTimers();
    const t = rig();
    t.r.start();
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    t.hide();
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    t.fetchChanges.mockClear();
    t.show();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.fullReread).not.toHaveBeenCalled();
    expect(t.fetchChanges).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(t.fullReread).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000); // 5 min of visible time
    expect(t.fullReread).toHaveBeenCalledTimes(1);
    t.r.stop();
  });

  it('Refresh re-reads every band at once and restarts the 5 min clock', async () => {
    vi.useFakeTimers();
    const t = rig({ feed: false });
    t.r.start();
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    t.r.refreshNow();
    expect(t.fullReread).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(t.fullReread).toHaveBeenCalledTimes(1);
    t.r.stop();
  });

  it('counts_only differing from the loaded counts re-reads every band', async () => {
    vi.useFakeTimers();
    const t = rig({ server: counts(6), loaded: counts(5) });
    t.r.start();
    await vi.advanceTimersByTimeAsync(BOARD_FULL_REREAD_MS * 2);
    expect(t.fullReread).toHaveBeenCalledTimes(2);   // the 5 and 10 min re-reads
    expect(t.fetchCounts).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(COUNTS_CHECK_MS - BOARD_FULL_REREAD_MS * 2 + CHANGE_POLL_MS);
    // at 15:00 the scheduled re-read runs, at 15:30 the counts check
    expect(t.fetchCounts).toHaveBeenCalledTimes(1);
    expect(t.fullReread).toHaveBeenCalledTimes(4);
    t.r.stop();
  });

  it('matching counts, or bands still loading, re-read nothing extra', async () => {
    vi.useFakeTimers();
    for (const loaded of [counts(5), null]) {
      const t = rig({ server: counts(5), loaded });
      t.r.start();
      await vi.advanceTimersByTimeAsync(COUNTS_CHECK_MS + CHANGE_POLL_MS);
      expect(t.fetchCounts).toHaveBeenCalledTimes(1);
      expect(t.fullReread).toHaveBeenCalledTimes(3); // only the 5, 10 and 15 min re-reads
      t.r.stop();
    }
  });
});

describe('countsDiffer', () => {
  it('compares every tab', () => {
    expect(countsDiffer(counts(5), counts(5))).toBe(false);
    expect(countsDiffer(counts(5), { ...counts(5), DELIVERED: 1 })).toBe(true);
  });
});

describe('another tab wrote something the board shows', () => {
  it('runs the change feed and re-reads only the changed orders, not every band', async () => {
    const t = rig();
    t.r.start();
    await vi.waitFor(() => expect(t.fetchChanges).toHaveBeenCalledTimes(1));
    t.fetchChanges.mockResolvedValueOnce({ cursor: 900, docs: ['SO-7'], others: false, full: false });
    t.r.nudge();
    await vi.waitFor(() => expect(t.rows).toHaveBeenCalledWith({ cursor: 900, docs: ['SO-7'], others: false, full: false }));
    expect(t.fullReread).not.toHaveBeenCalled();
    t.r.stop();
  });

  it('a service / DP / project change re-reads in full at once', async () => {
    const t = rig();
    t.r.start();
    await vi.waitFor(() => expect(t.fetchChanges).toHaveBeenCalledTimes(1));
    t.fetchChanges.mockResolvedValueOnce({ cursor: 900, docs: [], others: true, full: false });
    t.r.nudge();
    await vi.waitFor(() => expect(t.fullReread).toHaveBeenCalledTimes(1));
    t.r.stop();
  });

  it('a screen without the 30 s feed polls nothing, re-reads in full on the first write, by rows after', async () => {
    vi.useFakeTimers();
    const t = rig({ poll: false });
    t.r.start();
    await vi.advanceTimersByTimeAsync(CHANGE_POLL_MS * 3);
    expect(t.fetchChanges).not.toHaveBeenCalled();
    t.r.nudge();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.fullReread).toHaveBeenCalledTimes(1);
    t.fetchChanges.mockResolvedValueOnce({ cursor: 5000, docs: ['SO-9'], others: false, full: false });
    t.r.nudge();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.rows).toHaveBeenCalledTimes(1);
    expect(t.fullReread).toHaveBeenCalledTimes(1);
    t.r.stop();
  });
});
