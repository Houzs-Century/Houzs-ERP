/* How the Delivery Planning board (and the screens on its band loader) stays
   current (owner 2026-10-27 option B; schedule owner 2026-11-10).

   - Every 30 s, ask which orders changed since the board last looked
     (GET /delivery-planning/changes, a server-side change log paged by its own
     serial id) and re-read only those (?docs=). An order with an edit still in
     flight on this screen is left out: the edit's own row refresh lands its
     truth (Hookka ERP: a poll overwrote a value the user had just saved).
   - Every BOARD_FULL_REREAD_MS of visible time, re-read every loaded band. A
     service case / DP job / project change (`others`) waits for that re-read.
   - Re-read every band when: the MYT date changes (days_left and Overdue count
     from today); the change feed answers `full`; the tab comes back after more
     than HIDDEN_REREAD_AFTER_MS hidden; the user presses Refresh.
   - A re-read nobody on this tab asked for (the 5 min clock, the date change,
     `full`, a counts difference, another tab's write) waits a random 0 to
     FULL_REREAD_SPREAD_MS first. Those triggers reach every open tab within the
     same 30 s, and their reads used to land on the server together (production
     2026-11-10: ~20 board reads in 18 s, each then ~260 s). Refresh and coming
     back to the tab still re-read at once.
   - Every COUNTS_CHECK_MS, ?counts_only=1 is compared with the counts of the
     loaded rows; a difference re-reads every band.
   - Nothing polls while the tab is hidden; on becoming visible the change feed
     runs once at once. A failed poll is retried next tick and never shown.
   - Another tab's write that covers the board's rows (lib/cross-tab-sync) runs
     the change feed at once instead of re-reading every band; `others` then
     re-reads in full, since a write just happened. A screen without the 30 s
     feed reads its cursor on the first such write (and re-reads in full once). */
import { useEffect, useMemo, useRef } from 'react';
import { useQueryClient, type Query, type QueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { scheduleRowRefresh } from './board-row-refresh';
import { todayMY } from '../../shared/format';
import { claimCrossTabRefresh } from '../../../lib/cross-tab-sync';
import { loadedBoardCounts, runBoardRequest, COUNTS_PRIORITY } from './delivery-board-bands';
import type { PlanningCounts } from './delivery-planning-queries';

export const CHANGE_POLL_MS = 30_000;
/** The full re-read of every loaded band. One place to change it (3 or 2 minutes later). */
export const BOARD_FULL_REREAD_MS = 5 * 60_000;
/** Hidden longer than this, the board re-reads in full when shown again. */
export const HIDDEN_REREAD_AFTER_MS = 10 * 60_000;
/** The counts_only safety net. */
export const COUNTS_CHECK_MS = 15 * 60_000;
/** The most an unasked-for re-read waits, so open tabs do not re-read together. */
export const FULL_REREAD_SPREAD_MS = 45_000;
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
  /** How long an unasked-for re-read waits (ms); 0 = at once. */
  spreadMs: () => number;
  /** null = this screen has no change feed (another tab's write re-reads in full). */
  feed: { read: (after: number | null) => Promise<BoardChanges>; rows: (ch: BoardChanges) => void } | null;
  /** false = the feed runs only on another tab's write, never on the 30 s tick. */
  pollFeed: boolean;
  /** null = no counts check. `loaded` is null while bands are loading or refetching. */
  counts: { read: () => Promise<PlanningCounts | null>; loaded: () => PlanningCounts | null } | null;
};

/** The schedule itself, free of React, so the rules can be tested with fake timers. */
export function createBoardRefresher(d: BoardRefreshDeps) {
  let cursor: number | null = null;
  let feedBusy = false;
  let nudgeAgain = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastFullAt = d.now();
  let lastCountsAt = d.now();
  let day = d.today();
  let hiddenAt: number | null = null;
  let spreadTimer: ReturnType<typeof setTimeout> | null = null;

  const full = () => {
    if (spreadTimer) { clearTimeout(spreadTimer); spreadTimer = null; }
    lastFullAt = d.now(); day = d.today(); d.fullReread();
  };
  /* An unasked-for re-read: after a random wait, once. The 5 min clock restarts now so
     the next ticks do not queue it again. */
  const spreadFull = () => {
    if (spreadTimer) return;
    const wait = d.spreadMs();
    if (wait <= 0) { full(); return; }
    lastFullAt = d.now(); day = d.today();
    spreadTimer = setTimeout(() => {
      spreadTimer = null;
      // Hidden by now: nothing reads while hidden; due again at the first tick once shown.
      if (!d.visible()) { lastFullAt = Number.NEGATIVE_INFINITY; return; }
      full();
    }, wait);
  };

  const runFeed = async () => {
    if (!d.feed || !d.pollFeed || feedBusy) return;
    feedBusy = true;
    try {
      const ch = await d.feed.read(cursor);
      if (cursor == null) cursor = Math.max(0, ch.cursor - FIRST_CURSOR_OVERLAP);
      else {
        cursor = ch.cursor;
        if (ch.full) spreadFull(); else d.feed.rows(ch);
      }
    } catch {
      /* retried next tick */
    } finally {
      feedBusy = false;
      if (nudgeAgain) { nudgeAgain = false; void nudge(); }
    }
  };

  /* Another tab wrote something the board shows. */
  const nudge = async (): Promise<void> => {
    if (!d.feed) { spreadFull(); return; }
    if (feedBusy) { nudgeAgain = true; return; }
    feedBusy = true;
    try {
      const first = cursor == null;
      const ch = await d.feed.read(cursor);
      cursor = ch.cursor;
      if (first || ch.full || ch.others) spreadFull(); else d.feed.rows(ch);
    } catch {
      spreadFull();
    } finally {
      feedBusy = false;
      if (nudgeAgain) { nudgeAgain = false; void nudge(); }
    }
  };

  const runCounts = async () => {
    if (!d.counts) return;
    lastCountsAt = d.now();
    try {
      const server = await d.counts.read();
      const loaded = d.counts.loaded();
      if (server && loaded && countsDiffer(server, loaded)) spreadFull();
    } catch {
      /* tried again next check */
    }
  };

  const tick = () => {
    if (!d.visible()) return;
    const now = d.now();
    if (d.today() !== day || now - lastFullAt >= BOARD_FULL_REREAD_MS) spreadFull();
    else if (d.counts && now - lastCountsAt >= COUNTS_CHECK_MS) void runCounts();
    void runFeed();
  };

  const startTimer = () => { if (!timer) timer = setInterval(tick, CHANGE_POLL_MS); };
  const stopTimer = () => { if (timer) { clearInterval(timer); timer = null; } };
  const stopAll = () => { stopTimer(); if (spreadTimer) { clearTimeout(spreadTimer); spreadTimer = null; } };

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
    stop: stopAll,
    onVisibility,
    refreshNow: full,
    nudge: () => { void nudge(); },
  };
}

/** A cached board slice or band: the queries the row refresh merges into. */
export function isBoardRows(q: Query): boolean {
  return q.queryKey[0] === 'delivery-planning' && Array.isArray((q.state.data as { orders?: unknown } | undefined)?.orders);
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
      spreadMs: () => Math.floor(Math.random() * FULL_REREAD_SPREAD_MS),
      feed: {
        read: (after) => authedFetch<BoardChanges>(`/delivery-planning/changes${after == null ? '' : `?after=${after}`}`),
        rows: (ch) => refreshChangedRows(qc, ch),
      },
      pollFeed: opts.changeFeed,
      counts: withCounts
        ? {
            read: async () => {
              const res = await runBoardRequest(COUNTS_PRIORITY, () => authedFetch<{ counts_by_region: Partial<Record<string, PlanningCounts>> }>('/delivery-planning?counts_only=1'));
              qc.setQueryData(['delivery-planning', 'counts'], res);
              return res.counts_by_region.ALL ?? null;
            },
            loaded: () => (countsState.current ? loadedBoardCounts(qc, countsState.current) : null),
          }
        : null,
    });
    api.current = r;
    r.start();
    const release = claimCrossTabRefresh({ owns: isBoardRows, refresh: r.nudge });
    document.addEventListener('visibilitychange', r.onVisibility);
    return () => { r.stop(); release(); document.removeEventListener('visibilitychange', r.onVisibility); api.current = null; };
  }, [qc, opts.changeFeed, withCounts]);
  return useMemo(() => ({ refreshNow: () => api.current?.refreshNow() }), []);
}
