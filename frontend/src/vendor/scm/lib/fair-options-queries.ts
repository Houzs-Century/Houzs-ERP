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
import { fmtDayMonthRange } from '../../shared/format';

/** One row in the picker: a place, an organizer and the event's PERIOD. */
export type FairOption = {
  key: string;
  venue: string;
  organizer: string;
  /** Set by the server for a solo roadshow: the label reads "SOLO" where an
   *  exhibition names its organizer. Optional so a response cached from before
   *  the field existed still renders. */
  solo?: boolean;
  /** The event's PERIOD. Half the row's identity, not decoration: it is sent
   *  back on save (`fairStart` / `fairEnd`) and is what lets the server match
   *  the exact occurrence the operator picked. */
  startDate: string;
  endDate: string | null;
  projectIds: number[];
};

export type VenueMasterRow = { id: string; name: string };

/** The event an order is linked to, as the order detail sends it
 *  (`salesOrder.fair`, owner 2026-09-24). Backend twin: `LinkedFair` in
 *  scm/lib/fair-options.ts. */
export type LinkedFair = Pick<FairOption, 'venue' | 'organizer' | 'solo' | 'startDate' | 'endDate'>;

export type FairOptionsResponse = {
  date: string;
  /** Fairs running on the order's date. Nothing pre-selects one: an order with
   *  only a place shows that place (FairPicker rule 5). */
  running: FairOption[];
  /** The rest of the lookback window: fairs that have already CLOSED, newest
   *  first. Never anything in the future — the window ends at the order date. */
  earlier: FairOption[];
  /** The company's venue master — the list behind "Others". */
  venues: VenueMasterRow[];
};

/** Label for one row: the VENUE, with the ORGANIZER beside it. ONE label, shared
 *  by the SO fair picker and the fair-pending screen so the two can never
 *  describe the same event differently.
 *
 *  THE ORGANIZER IS PART OF THE LABEL — do not drop it again. It was dropped on
 *  2026-09-15 (#3999, a second `fairVenueLabel` the picker used instead) and the
 *  owner reversed it the next morning: 「我是写 venue，然后旁边还有 organizer 的名
 *  字的，它不是单纯就是 venue only」. A venue does not identify a fair, which is
 *  the whole reason this control replaced a venue text box. Measured on
 *  production 2026-09-16: of Houzs Century's 163 venue-months in 2026, 15 hold
 *  two or more organizers at the SAME venue — 31 dropdown rows that read
 *  identically on the venue alone. October 2026 at MID VALLEY is three of them
 *  (BIGHOME 10-02, HOMELOVE 10-15, MLE 10-23).
 *
 *  SOLO ROADSHOWS READ "SOLO" (owner 2026-09-18: "for solo roadshow change to
 *  solo dont mention mall mgt. for exhibition remain same"). This is NOT the
 *  organizer being dropped again: an exhibition still names its organizer. A solo
 *  roadshow has none — MALL MGT / MALL MGMT is only who the floor was rented
 *  from.
 *
 *  EVERY ROW CARRIES ITS DATES (owner 2026-09-19), reversing his 2026-09-13
 *  "no dates" ruling — *"我一号看到是有那个 venue，有那个 organizer，然后它是一号到
 *  三号的，我就点那个"*. The list is no longer one month of mostly-live fairs; it
 *  is four weeks of CLOSED ones, where picking a row means saying WHICH
 *  occurrence. The old `showDates` exception is gone rather than widened —
 *  with every row dated there is nothing left for it to decide. Keep the full
 *  rationale in the backend twin, `scm/lib/fair-options.ts::fairOptionLabel`;
 *  the two must render the same string. */
export function fairLabel(o: Pick<FairOption, 'venue' | 'organizer' | 'solo' | 'startDate' | 'endDate'>): string {
  return `${o.venue} — ${o.solo ? 'SOLO' : o.organizer} (${fmtDayMonthRange(o.startDate, o.endDate)})`;
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
