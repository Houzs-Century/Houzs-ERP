/* Every 30 s, ask which orders changed since the board last looked and re-read
   only those (owner 2026-10-27, option B). GET /delivery-planning/changes pages a
   server-side change log by its serial id, so no client clock is ever compared.

   - An order with an edit still in flight on this screen is left out: the
     edit's own row refresh lands its truth (Hookka ERP: a poll overwrote a
     value the user had just saved).
   - The first cursor is set back a little, so a change made between the board's
     own read and that first look is re-read rather than missed.
   - A service case / DP job / project change, or a burst too big to list,
     re-reads the whole board, at most once every 2 minutes.
   - Polls only while the tab is visible; a failed poll is retried next tick and
     never shown (it changes nothing on screen). */
import { useEffect } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { scheduleRowRefresh } from './board-row-refresh';

export const CHANGE_POLL_MS = 30_000;
const FULL_REREAD_MIN_MS = 120_000;
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

/** What one poll answer does to the board; returns the next cursor. */
export function applyChanges(qc: QueryClient, ch: BoardChanges, lastFullAt: { at: number }, now: number): void {
  if (ch.full || ch.others) {
    if (now - lastFullAt.at >= FULL_REREAD_MIN_MS) {
      lastFullAt.at = now;
      void qc.invalidateQueries({ queryKey: ['delivery-planning'] });
      return;
    }
  }
  const busy = editingDocs(qc);
  const docs = ch.docs.filter((d) => !busy.has(d));
  if (docs.length > 0) scheduleRowRefresh(qc, docs);
}

export function useBoardChangePoll(): void {
  const qc = useQueryClient();
  useEffect(() => {
    let cursor: number | null = null;
    let inFlight = false;
    const lastFullAt = { at: Date.now() };
    const tick = async () => {
      if (inFlight || document.visibilityState !== 'visible') return;
      inFlight = true;
      try {
        const ch = await authedFetch<BoardChanges>(`/delivery-planning/changes${cursor == null ? '' : `?after=${cursor}`}`);
        if (cursor == null) cursor = Math.max(0, ch.cursor - FIRST_CURSOR_OVERLAP);
        else { applyChanges(qc, ch, lastFullAt, Date.now()); cursor = ch.cursor; }
      } catch {
        /* retried next tick */
      } finally {
        inFlight = false;
      }
    };
    void tick();
    const id = setInterval(() => { void tick(); }, CHANGE_POLL_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') void tick(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVisible); };
  }, [qc]);
}
