/* How the Delivery Planning board (and the screens on its band loader) stays
   current (owner 2026-10-27 option B; schedule owner 2026-11-10).

   - Every 30 s, ask which orders changed since the board last looked
     (GET /delivery-planning/changes, a server-side change log paged by its own
     serial id) and re-read only those (?docs=). An order with an edit still in
     flight on this screen is left out: the edit's own row refresh lands its
     truth (Hookka ERP: a poll overwrote a value the user had just saved).
   - Every BOARD_FULL_REREAD_MS of visible time, re-read every loaded band. A
     service case / DP job / project change (`others`) waits for that re-read.
   - At once, re-read every band when: the MYT date changes (days_left and
     Overdue count from today); the change feed answers `full`; the tab comes
     back after more than HIDDEN_REREAD_AFTER_MS hidden; the user presses Refresh.
   - Every COUNTS_CHECK_MS, ?counts_only=1 is compared with the counts of the
     loaded rows; a difference re-reads every band.
   - Nothing polls while the tab is hidden; on becoming visible the change feed
     runs once at once. A failed poll is retried next tick and never shown. */
import { useEffect, useMemo, useRef } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { scheduleRowRefresh } from './board-row-refresh';
import { todayMY } from '../../shared/format';
import { loadedBoardCounts } from './delivery-board-bands';
import type { PlanningCounts } from './delivery-planning-queries';

export const CHANGE_POLL_MS = 30_000;
/** The full re-read of every loaded band. One place to change it (3 or 2 minutes later). */
export const BOARD_FULL_REREAD_MS = 5 * 60_000;
/** Hidden longer than this, the board re-reads in full when shown again. */
export const HIDDEN_REREAD_AFTER_MS = 10 * 60_000;
/** The counts_only safety net. */
export const COUNTS_CHECK_MS = 15 * 60_000;
const FIRST_CURSOR_OVERLAP = 200;

export type BoardChanges = { cursor: number; docs: string[]; others: boolean; full: boolean };

/** An SO edit on this screen that has not settled yet. */
export function editingDocs(qc: QueryClient): Set<string> {
  const out = new Set<string>();
  for (const m of qc.getMutationCache().getAll()) {
    const v = m.state.variables as { type?: unknown; id?: unknown } | undefined;
    if (m.state.status === 'pending' && v?.type === 'so' && typeof v.id === 'string') out.add(v.id);
  }
  return out;
}

/** Re-read the changed orders of one poll answer, except those being edited here. */
export function refreshChangedRows(qc: QueryClient, ch: BoardChanges): void {
  const busy = editingDocs(qc);
  const docs = ch.docs.filter((d) => !busy.has(d));
  if (docs.length > 0) scheduleRowRefresh(qc, docs);
}

/** True when the server's counts and the loaded rows' counts disagree on any tab. */
export function countsDiffer(server: PlanningCounts, loaded: PlanningCounts): boolean {
  return (Object.keys(server) as Array<keyof PlanningCounts>).some((k) => server[k] !== loaded[k]);
}

export type BoardRefreshDeps = {
  now: () => number;
  today: () => string;
  visible: () => boolean;
  fullReread: () => void;
  /** null = this screen does not run the change feed. */
  feed: { read: (after: number | null) => Promise<BoardChanges>; rows: (ch: BoardChanges) => void } | null;
  /** null = no counts check. `loaded` is null while bands are loading or refetching. */
  counts: { read: () => Promise<PlanningCounts | null>; loaded: () => PlanningCounts | null } | null;
};

/** The schedule itself, free of React, so the rules can be tested with fake timers. */
export function createBoardRefresher(d: BoardRefreshDeps) {
  let cursor: number | null = null;
  let feedBusy = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastFullAt = d.now();
  let lastCountsAt = d.now();
  let day = d.today();
  let hiddenAt: number | null = null;

  const full = () => { lastFullAt = d.now(); day = d.today(); d.fullReread(); };

  const runFeed = async () => {
    if (!d.feed || feedBusy) return;
    feedBusy = true;
    try {
      const ch = await d.feed.read(cursor);
      if (cursor == null) cursor = Math.max(0, ch.cursor - FIRST_CURSOR_OVERLAP);
      else {
        cursor = ch.cursor;
        if (ch.full) full(); else d.feed.rows(ch);
      }
    } catch {
      /* retried next tick */
    } finally {
      feedBusy = false;
    }
  };

  const runCounts = async () => {
    if (!d.counts) return;
    lastCountsAt = d.now();
    try {
      const server = await d.counts.read();
      const loaded = d.counts.loaded();
      if (server && loaded && countsDiffer(server, loaded)) full();
    } catch {
      /* tried again next check */
    }
  };

  const tick = () => {
    if (!d.visible()) return;
    const now = d.now();
    if (d.today() !== day || now - lastFullAt >= BOARD_FULL_REREAD_MS) full();
    else if (d.counts && now - lastCountsAt >= COUNTS_CHECK_MS) void runCounts();
    void runFeed();
  };

  const startTimer = () => { if (!timer) timer = setInterval(tick, CHANGE_POLL_MS); };
  const stopTimer = () => { if (timer) { clearInterval(timer); timer = null; } };

  const onVisibility = () => {
    if (!d.visible()) { hiddenAt = d.now(); stopTimer(); return; }
    const away = hiddenAt == null ? 0 : d.now() - hiddenAt;
    hiddenAt = null;
    if (away > HIDDEN_REREAD_AFTER_MS || d.today() !== day) full();
    else { lastFullAt += away; lastCountsAt += away; } // the schedule counts visible time only
    void runFeed();
    startTimer();
  };

  return {
    start() {
      if (d.visible()) { void runFeed(); startTimer(); } else hiddenAt = d.now();
    },
    stop: stopTimer,
    onVisibility,
    refreshNow: full,
  };
}

const isVisible = () => typeof document === 'undefined' || document.visibilityState === 'visible';

/** Keeps the band caches current; call once per screen. Returns the Refresh-button action. */
export function useBoardRefresh(opts: { changeFeed: boolean; countsState: 'ALL' | 'OPEN' | null }): { refreshNow: () => void } {
  const qc = useQueryClient();
  const countsState = useRef(opts.countsState);
  countsState.current = opts.countsState;
  const api = useRef<{ refreshNow: () => void } | null>(null);
  const withCounts = opts.countsState !== null;
  useEffect(() => {
    const r = createBoardRefresher({
      now: () => Date.now(),
      today: todayMY,
      visible: isVisible,
      fullReread: () => { void qc.invalidateQueries({ queryKey: ['delivery-planning'] }); },
      feed: opts.changeFeed
        ? {
            read: (after) => authedFetch<BoardChanges>(`/delivery-planning/changes${after == null ? '' : `?after=${after}`}`),
            rows: (ch) => refreshChangedRows(qc, ch),
          }
        : null,
      counts: withCounts
        ? {
            read: async () => {
              const res = await authedFetch<{ counts_by_region: Partial<Record<string, PlanningCounts>> }>('/delivery-planning?counts_only=1');
              qc.setQueryData(['delivery-planning', 'counts'], res);
              return res.counts_by_region.ALL ?? null;
            },
            loaded: () => (countsState.current ? loadedBoardCounts(qc, countsState.current) : null),
          }
        : null,
    });
    api.current = r;
    r.start();
    document.addEventListener('visibilitychange', r.onVisibility);
    return () => { r.stop(); document.removeEventListener('visibilitychange', r.onVisibility); api.current = null; };
  }, [qc, opts.changeFeed, withCounts]);
  return useMemo(() => ({ refreshNow: () => api.current?.refreshNow() }), []);
}
