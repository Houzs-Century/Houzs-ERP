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

/** One brand's booth inside a row (backend twin `FairBooth`). */
export type FairBooth = { projectId: number; brand: string | null };

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
  /** The booths with their brand — what Fair Links names each choice by (owner
   *  2026-10-20). Optional so a response cached from before the field existed
   *  still renders; its booths then read as "No brand". */
  booths?: FairBooth[];
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

/** Why no fair was filled in for the person keying the order. Sent back to
 *  POST /validate as `fairWhy`, which words the refusal from it. */
export type FairWhy =
  | { code: 'no_fair' }
  | { code: 'too_old'; venue: string; startDate: string; endDate: string | null };

/** GET /fair-default — the KEYER's fair a new order starts with (owner
 *  2026-10-19): running today, else the latest one within the dropdown's window.
 *  `event` is a row of /fair-options. With none, `whyMessage` is the sentence a
 *  save without a fair is refused with. Houzs only; other companies get nulls. */
export type FairDefaultResponse = {
  date: string;
  event: FairOption | null;
  how: 'ongoing' | 'latest' | null;
  why: FairWhy | null;
  whyMessage: string | null;
};

export function useFairDefault(enabled: boolean) {
  return useQuery({
    queryKey: ['fair-default'],
    queryFn: () => authedFetch<FairDefaultResponse>('/mfg-sales-orders/fair-default'),
    enabled,
    staleTime: 60_000,
  });
}

export type FairPendingRow = {
  doc_no: string;
  so_date: string | null;
  venue: string | null;
  branding: string | null;
  project_id: number | null;
  /** NULL = an order keyed before the picker, listed from 1 September 2026. */
  fair_match: 'PENDING' | 'AMBIGUOUS' | 'UNMATCHED' | 'NO_FAIR' | null;
  status: string | null;
  local_total_sen: number | null;
  salesperson_id: string | null;
  /** The Ref No. — the slip number the evening report lists. Shown with the
   *  SO page's rule (lib/customer-ref.ts). Absent from an older server. */
  ref?: string | null;
  customer_so_no?: string | null;
};

/** Orders with no fair link a person should see (backend scm/lib/fair-pending.ts).
 *  The reasons share this list and the screen keeps them apart — see the
 *  `fair_match` column. */
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

/** A LINKED order to look at (backend scm/lib/fair-checks.ts, owner 2026-10-19):
 *  VENUE_DIFFERS — 要查, the venue on the order is not where it was placed;
 *  NEEDS_ATTENDING — 等加人, a scan whose scanner is not on its booth's Sales
 *  Attending. `note` is the server's sentence, shown as it comes. */
export type FairCheckRow = Omit<FairPendingRow, 'fair_match'> & {
  fair_match: string | null;
  /** REPORT_ELSEWHERE (owner 2026-10-20): another fair's evening report lists the
   *  order, linked elsewhere or to nothing. */
  check: 'VENUE_DIFFERS' | 'NEEDS_ATTENDING' | 'REPORT_ELSEWHERE';
  note: string;
  /** REPORT_ELSEWHERE: the booth the report puts it at; null when two fairs'
   *  reports both list it. `title` / `detail` are its two lines (owner
   *  2026-10-21); an older server sends `label` only. */
  target?: ({ projectId: number; label: string; reportDate: string | null } & Partial<FairCheckBooth>) | null;
  /** REPORT_ELSEWHERE: the booth the order is under now; null with none. */
  current?: FairCheckBooth | null;
  /** REPORT_ELSEWHERE with no target: the booths whose reports both list it. */
  candidates?: FairCheckBooth[];
};

/** A booth on two lines: "[AKEMI] HOMELOVE" over "IOIGECC · 10/09 - 10/11". */
export type FairCheckBooth = { projectId: number; title: string; detail: string };

export type FairTransferResult =
  | { docNo: string; ok: true; projectId: number; venue: string; fairDate: string | null }
  | { docNo: string; ok: false; reason: string };

const NOT_MOVED: Record<string, string> = {
  not_found: 'not found',
  cancelled: 'cancelled',
  fair_not_open: 'that fair is closed or cancelled',
  already_there: 'already there',
  update_failed: 'could not be saved',
};

/** "3 moved." / "2 moved. Not moved: HC-SO-2610-166 (already there)." */
export function transferSummary(results: readonly FairTransferResult[]): string {
  const moved = results.filter((r) => r.ok).length;
  const not = results.flatMap((r) => (r.ok ? [] : [`${r.docNo} (${NOT_MOVED[r.reason] ?? r.reason})`]));
  return `${moved} moved.${not.length ? ` Not moved: ${not.join(', ')}.` : ''}`;
}

/** Move orders to the project they belong to — one, a ticked few, or all
 *  (owner 2026-10-20). The Fair, Venue and Fair Day move together; the server
 *  moves what it can and says why for the rest (scm/lib/fair-transfer.ts). */
export function useFairTransfer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (items: ReadonlyArray<{ docNo: string; projectId: number }>) =>
      authedFetch<{ results: FairTransferResult[]; moved: number }>('/mfg-sales-orders/fair-transfer', {
        method: 'POST',
        body: JSON.stringify({ items }),
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['fair-pending'] });
      await qc.invalidateQueries({ queryKey: ['mfg-sales-orders'] });
    },
    onError: writeFailedAs('Orders not transferred'),
  });
}

export function useFairChecks() {
  return useQuery({
    queryKey: ['fair-pending', 'checks'],
    queryFn: () => authedFetch<{ rows: FairCheckRow[] }>('/mfg-sales-orders/fair-checks').then((r) => r.rows),
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
