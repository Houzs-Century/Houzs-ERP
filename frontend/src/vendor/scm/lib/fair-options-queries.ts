// The SO fair picker's reads. One hook, used by BOTH the desktop and the mobile
// SO forms — the owner's standing rule is one shared logic layer with the two
// surfaces differing only in presentation, and a picker that decides which
// exhibition a sale is attributed to is exactly the kind of rule that must not
// exist twice.
//
// Backend: backend/src/scm/routes/mfg-so-fairs.ts. The RULE (which fairs appear,
// in which group, and when a row shows its dates) is entirely server-side in
// scm/lib/fair-options.ts — this file renders what it is given and never
// re-derives it.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { writeFailedAs } from './mutation-error';

/** One row in the picker: a place plus an organizer. Owner 2026-09-13 — no
 *  dates, *"只需要选 event 和 organizer 就好了"*. `showDates` is set by the
 *  server for the one case that needs them: the same venue and organizer twice
 *  inside one month (four occurrences in the seven months to Sep 2026). */
export type FairOption = {
  key: string;
  venue: string;
  organizer: string;
  startDate: string;
  endDate: string | null;
  showDates: boolean;
  projectIds: number[];
};

export type VenueMasterRow = { id: string; name: string };

export type FairOptionsResponse = {
  date: string;
  /** Fairs running on the order's date. Nothing pre-selects one: an order with
   *  only a place shows that place (FairPicker rule 5). */
  running: FairOption[];
  /** Every other fair in the same calendar month — the ones already over too. */
  month: FairOption[];
  /** The company's venue master — the list behind "Others". */
  venues: VenueMasterRow[];
};

function withDates(
  o: Pick<FairOption, 'startDate' | 'endDate' | 'showDates'>,
  base: string,
): string {
  if (!o.showDates) return base;
  const end = o.endDate && o.endDate !== o.startDate ? ` ~ ${o.endDate}` : '';
  return `${base} (${o.startDate}${end})`;
}

/** Label for one row, venue AND organizer. Used where the reader needs to tell
 *  two booths at one venue apart — the fair-pending assignment screen. */
export function fairLabel(o: Pick<FairOption, 'venue' | 'organizer' | 'startDate' | 'endDate' | 'showDates'>): string {
  return withDates(o, `${o.venue} — ${o.organizer}`);
}

/** The SO fair picker's label: VENUE ONLY (owner, 2026-09-16). The organizer is
 *  NOT shown to the salesperson, but it still rides on the picked value and is
 *  saved on the order — it feeds fair P&L / commission. Only the displayed text
 *  drops it. The date suffix the server flags for the one collision case (same
 *  venue + organizer twice in a month) is kept so those two rows stay distinct. */
export function fairVenueLabel(o: Pick<FairOption, 'venue' | 'startDate' | 'endDate' | 'showDates'>): string {
  return withDates(o, o.venue);
}

/**
 * @param soDate The ORDER's date, `YYYY-MM-DD`. Passed through so a backdated
 *   slip offers the fair that was running the day it was written. Omitted means
 *   "today in MYT", which the server decides — the browser's clock is not the
 *   Malaysian business date and must not be used for this.
 */
export function useFairOptions(soDate: string | null | undefined) {
  const date = soDate && /^\d{4}-\d{2}-\d{2}/.test(soDate) ? soDate.slice(0, 10) : null;
  return useQuery({
    queryKey: ['fair-options', date ?? 'today'],
    queryFn: () =>
      authedFetch<FairOptionsResponse>(
        `/mfg-sales-orders/fair-options${date ? `?date=${date}` : ''}`,
      ),
    staleTime: 60_000,
  });
}

export type FairPendingRow = {
  doc_no: string;
  so_date: string | null;
  venue: string | null;
  branding: string | null;
  project_id: number | null;
  fair_match: 'PENDING' | 'AMBIGUOUS' | 'UNMATCHED' | null;
  status: string | null;
  local_total_sen: number | null;
  salesperson_id: string | null;
};

/** Orders whose fair link still needs a person. Three different reasons share
 *  this list and the screen keeps them apart — see the `fair_match` column. */
export function useFairPending(limit = 200) {
  return useQuery({
    queryKey: ['fair-pending', limit],
    queryFn: () =>
      authedFetch<{ rows: FairPendingRow[] }>(
        `/mfg-sales-orders/fair-pending?limit=${limit}`,
      ).then((r) => r.rows),
    staleTime: 30_000,
  });
}

/** Settle one order. `projectId: null` is a legitimate answer — "I do not know
 *  either" — and leaves the order in the list rather than forcing a wrong pick. */
export function useAssignFair() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ docNo, projectId }: { docNo: string; projectId: number | null }) =>
      authedFetch<{ ok: true }>(`/mfg-sales-orders/${encodeURIComponent(docNo)}/fair`, {
        method: 'POST',
        body: JSON.stringify({ projectId }),
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['fair-pending'] });
      await qc.invalidateQueries({ queryKey: ['mfg-sales-orders'] });
    },
    /* A server refusal that reaches nobody is worse than a crash — the owner
       reported that class as "the button does nothing". */
    onError: writeFailedAs('Fair not assigned'),
  });
}
