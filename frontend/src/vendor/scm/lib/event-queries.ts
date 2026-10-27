// ----------------------------------------------------------------------------
// event-queries — events on the money side (owner 2026-09-29/30: 我的 payment 可能
// 需要绑定 event; 5a, an event per voucher / AP invoice line, the header a
// default). Server: backend/src/scm/routes/acc-events.ts. An "event" is a
// Projects row — one per brand per fair.
// ----------------------------------------------------------------------------

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { writeFailedAs } from './mutation-error';
import { fmtDayMonthRange } from '../../shared/format';

export type EventOption = {
  id: number;
  code: string | null;
  name: string;
  startDate: string | null;
  endDate: string | null;
  status: string | null;
  archived: boolean;
  venue: string | null;
  brand: string | null;
  organizer: string | null;
  boothNo: string | null;
};

/** An event the server matched to what a scanned bill printed, with why
 *  (backend scm/lib/event-match.ts) — a suggestion only (6a). */
export type EventSuggestion = { id: number; score: number; reasons: string[]; event: EventOption };

/** "Pulau Pinang [AKEMI] MLE @ PENANG WATERFRONT CONVENTION CENTRE · 25/09 - 27/09 · booth F1". */
export function eventLabel(e: Pick<EventOption, 'name' | 'startDate' | 'endDate' | 'boothNo' | 'status'>): string {
  const parts = [e.name];
  if (e.startDate) parts.push(fmtDayMonthRange(e.startDate, e.endDate));
  if (e.boothNo) parts.push(`booth ${e.boothNo}`);
  if (String(e.status ?? '').toLowerCase() === 'cancelled') parts.push('CANCELLED');
  return parts.join(' · ');
}

/** Where the picker reads: Finance's /acc-events, or — for a requester, who
 *  holds no Finance area — the payment requests' own copy of the same list. */
export type EventOptionsPath = '/acc-events/options' | '/payment-requests/event-options';

/** The picker's list: the company's events around a document date (the
 *  server's window — a booth is often paid months ahead of its fair). */
export function useEventOptions(around: string | null | undefined, enabled = true, path: EventOptionsPath = '/acc-events/options') {
  const date = around && /^\d{4}-\d{2}-\d{2}/.test(around) ? around.slice(0, 10) : null;
  return useQuery({
    queryKey: ['acc-events', 'options', path, date ?? 'today'],
    queryFn: () => authedFetch<{ events: EventOption[] }>(`${path}${date ? `?around=${date}` : ''}`).then((r) => r.events),
    staleTime: 60_000,
    enabled,
  });
}

/** Labels for events already on lines — archived ones included, so a tag the
 *  office later withdrew still reads as what it is. */
export function useEventLabels(ids: ReadonlyArray<number | null | undefined>, path: EventOptionsPath = '/acc-events/options') {
  const clean = [...new Set(ids.filter((n): n is number => typeof n === 'number' && n > 0))].sort((a, b) => a - b);
  return useQuery({
    queryKey: ['acc-events', 'labels', path, clean.join(',')],
    queryFn: () => authedFetch<{ events: EventOption[] }>(`${path}?ids=${clean.join(',')}`)
      .then((r) => new Map(r.events.map((e) => [e.id, e]))),
    staleTime: 60_000,
    enabled: clean.length > 0,
  });
}

export type EventCostLine = {
  jeNo: string; entryDate: string | null; sourceType: string | null; sourceDocNo: string | null;
  accountCode: string; notes: string | null; amountSen: number;
};
export type EventCostAccount = { accountCode: string; accountName: string | null; accountType: string | null; amountSen: number };
export type EventCostRow = { event: EventOption; costSen: number; otherSen: number; accounts: EventCostAccount[]; lines: EventCostLine[] };
export type EventCosts = { from: string; to: string; events: EventCostRow[]; totals: { costSen: number; otherSen: number } };

/** The event cost report: events starting in [from, to], each with every
 *  posted journal leg tagged to it. */
export function useEventCosts(from: string, to: string) {
  return useQuery({
    queryKey: ['acc-events', 'costs', from, to],
    queryFn: () => authedFetch<EventCosts>(`/acc-events/costs?from=${from}&to=${to}`),
    staleTime: 30_000,
  });
}

/* Event Commission (owner 2026-10-20) — server: routes/acc-event-commission.ts,
   rules: backend/src/scm/lib/event-commission.ts. Money in sen except the event
   page's own Total Sales and Commission row, which are RM. */
export type CommissionChange = {
  date: string;
  deltaGoodsSen: number;
  kind: 'upsale' | 'drop';
  notCounted: 'opening_day' | 'first_price' | 'system_fix' | null;
  source: string;
  changedBy: string | null;
  /** Back-filled from the SO's modification history (1–19 October 2026); absent from older servers. */
  fromHistory?: boolean;
};
export type CommissionSoRow = {
  docNo: string;
  soDate: string | null;
  salesperson: string | null;
  customer: string | null;
  goodsSen: number;
  totalSen: number;
  paidSen: number;
  paidPct: number;
  reachedOn: string | null;
  commissionSen: number;
  changes: CommissionChange[];
};
export type CommissionFairRow = {
  id: number;
  name: string;
  brand: string | null;
  /** The project's own place — absent from a server before 2026-10-26 (read
      through fairPlace, which falls back to the name). */
  organizer?: string | null;
  venue?: string | null;
  state?: string | null;
  startDate: string;
  endDate: string | null;
  ratePct: number | null;
  totalSalesRm: number | null;
  estimateRm: number | null;
  payableSen: number;
  sos: CommissionSoRow[];
};
export type CommissionAdjustment = {
  date: string;
  kind: 'reached' | 'upsale' | 'drop' | 'cancelled';
  docNo: string;
  fairId: number;
  fairName: string;
  salesperson: string | null;
  goodsSen: number;
  commissionSen: number;
  beforeReach: boolean;
};
/** Where an order sits: its fair and that fair's place (owner 2026-10-26). */
export type CommissionOrderPlace = {
  docNo: string; fairId: number; fairName: string;
  brand: string | null; organizer: string | null; venue: string | null; state: string | null;
  salesperson: string | null; customer: string | null; ratePct: number | null;
};
/** An earlier order once, its final result in the range (「我看final结果」). */
export type CommissionEarlierOrder = CommissionOrderPlace & {
  events: Array<{ date: string; kind: CommissionAdjustment['kind']; beforeReach: boolean }>;
  lastDate: string;
  originalSen: number; latestSen: number; amendedSen: number;
  commissionSen: number;
  fromHistory: boolean;
};
/** An order the range's upsales / drop sales changed, once, final. */
export type CommissionChangedOrder = CommissionOrderPlace & {
  part: 'range' | 'earlier';
  lastChange: string;
  originalSen: number; latestSen: number; amendedSen: number;
  reachedOn: string | null;
  effectSen: number;
  fromHistory: boolean;
};
/** A closed month's commission for one order, then and now — paid in the first
 *  open month as that month's adjustment (owner 2026-10-26, 关月). */
export type CommissionMonthAdjustment = {
  /** The closed month it belongs to, YYYY-MM. */
  month: string;
  docNo: string;
  fairId: number | null;
  fairName: string;
  brand: string | null;
  salesperson: string | null;
  customer: string | null;
  /** What that month paid for the order: as closed, plus adjustments paid since. */
  wasSen: number;
  /** That month recalculated today. */
  nowSen: number;
  adjustmentSen: number;
};
/** Which date puts an order in the range: its fair's start, or its own SO date. */
export type CommissionBasis = 'fair' | 'so_date';
export type EventCommission = {
  /** Absent from a server older than the toggle — read it through basisOf. */
  basis?: CommissionBasis;
  from: string;
  to: string;
  fairs: CommissionFairRow[];
  adjustments: CommissionAdjustment[];
  /** Absent from a server before 2026-10-26 — read as empty. */
  earlierOrders?: CommissionEarlierOrder[];
  changedOrders?: CommissionChangedOrder[];
  /** Closed months' commission that changed after they closed, paid here — absent before 2026-10-27. */
  monthAdjustments?: CommissionMonthAdjustment[];
  totals: { payableSen: number; adjustmentsSen: number; monthAdjustmentsSen?: number; totalSen: number };
  /** Set when the range is a closed month, served as it was closed. */
  closed?: { month: string; closedAt: string; closedBy: string | null };
  /** The company's closed months (YYYY-MM) and the first open one. */
  closes?: { months: string[]; openFrom: string | null };
};

/** Event Commission for [from, to]: by fair, the fairs starting in it (as at
 *  `to`) and what happened in it to the orders of earlier fairs; by SO date,
 *  the orders opened in it and what happened to orders opened earlier. */
export function useEventCommission(from: string, to: string, basis: CommissionBasis = 'fair') {
  return useQuery({
    queryKey: ['acc-events', 'commission', from, to, basis],
    queryFn: () => authedFetch<EventCommission>(`/acc-events/commission?from=${from}&to=${to}${basis === 'so_date' ? '&basis=so_date' : ''}`),
    staleTime: 30_000,
  });
}

/** Close a month of Event Commission (Finance): frozen as it stands, both ways
 *  of looking at it; what changes for its orders later is paid in the next one. */
export function useCloseCommissionMonth() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (month: string) => authedFetch<{ ok: true; month: string }>('/acc-events/commission/close', {
      method: 'POST', body: JSON.stringify({ month }),
    }),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ['acc-events', 'commission'] }); },
    onError: writeFailedAs('Month not closed'),
  });
}

/** Reopen the latest closed month: it is recalculated from today's data again. */
export function useReopenCommissionMonth() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (month: string) => authedFetch<{ ok: true; month: string }>('/acc-events/commission/reopen', {
      method: 'POST', body: JSON.stringify({ month }),
    }),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ['acc-events', 'commission'] }); },
    onError: writeFailedAs('Month not reopened'),
  });
}

/** Change the event on one voucher line — posted or not; the server moves the
 *  line and, once posted, its journal leg together. */
export function useRetagPvLine() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ lineId, projectId }: { lineId: string; projectId: number | null }) =>
      authedFetch<{ ok: true; projectId: number | null; posted: boolean }>(`/acc-events/pv-lines/${encodeURIComponent(lineId)}/event`, {
        method: 'POST',
        body: JSON.stringify({ projectId }),
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['payment-voucher-detail'] });
      await qc.invalidateQueries({ queryKey: ['acc-events', 'costs'] });
    },
    onError: writeFailedAs('Event not changed'),
  });
}
