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
  /** 'price_wiped' (from 2026-11-13): the order's price wiped to 0, not put back yet. */
  notCounted: 'opening_day' | 'first_price' | 'system_fix' | 'price_wiped' | null;
  /** An upsale / drop Finance left out (「这次改价不算」): listed, moving no commission. Absent before 2026-11-12. */
  uncounted?: boolean;
  source: string;
  changedBy: string | null;
  /** Back-filled from the SO's modification history (1–19 October 2026); absent from older servers. */
  fromHistory?: boolean;
};
/* Finance's buttons (owner 2026-11-12: 「1个这张单不要算，1个是这个算下个月」, then on
   the Upsales / Drop sales table 「只是改价不算」 — 'exclude_change'). */
export type CommissionMarkKind = 'exclude' | 'defer' | 'exclude_change';
export type CommissionMarkInfo = {
  id: string;
  kind: CommissionMarkKind;
  /** defer: the month (YYYY-MM) its commission leaves; exclude_change: the month
      whose upsales / drop sales are left out; exclude: null. */
  month: string | null;
  reason: string | null;
  markedBy: string | null;
  markedAt: string;
};
export type CommissionSoRow = {
  docNo: string;
  soDate: string | null;
  /** The venue typed on an order with no fair (its fair row is "No fair", id below 0). */
  venue?: string | null;
  /** Ref No. (the booklet number), status and when it was keyed — absent before 2026-11-12. */
  ref?: string | null;
  status?: string;
  createdAt?: string;
  /** Finance's mark; the commission is then 0 here. */
  mark?: CommissionMarkInfo;
  salesperson: string | null;
  customer: string | null;
  goodsSen: number;
  totalSen: number;
  paidSen: number;
  paidPct: number;
  reachedOn: string | null;
  commissionSen: number;
  /** What 「这次改价不算」 left out of the commission here; absent when nothing. */
  uncountedSen?: number;
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
  /** The event page's typed Total Sales and its Commission row (RM). */
  totalSalesRm: number | null;
  estimateRm: number | null;
  /** Its orders' goods and those × the rate (owner 2026-11-12: 「total sales 应该是 by
      total goods」) — absent before then. */
  goodsSen?: number;
  estimateSen?: number;
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
  /** An upsale / drop Finance left out, and what that left out of the line. */
  uncounted?: boolean;
  uncountedSen?: number;
};
/** Where an order sits: its fair and that fair's place (owner 2026-10-26). */
export type CommissionOrderPlace = {
  docNo: string; fairId: number; fairName: string;
  brand: string | null; organizer: string | null; venue: string | null; state: string | null;
  salesperson: string | null; customer: string | null; ratePct: number | null;
  /** Ref No., SO date and status — absent before 2026-11-12. */
  ref?: string | null; soDate?: string | null; status?: string;
};
/** An earlier order once, its final result in the range (「我看final结果」). */
export type CommissionEarlierOrder = CommissionOrderPlace & {
  mark?: CommissionMarkInfo;
  events: Array<{ date: string; kind: CommissionAdjustment['kind']; beforeReach: boolean; uncounted?: boolean }>;
  lastDate: string;
  originalSen: number; latestSen: number; amendedSen: number;
  commissionSen: number;
  fromHistory: boolean;
};
/** An order the range's upsales / drop sales changed, once, final. */
export type CommissionChangedOrder = CommissionOrderPlace & {
  mark?: CommissionMarkInfo;
  /** The 「这次改价不算」 mark behind the changes left out — for the row's Undo. */
  changeMark?: CommissionMarkInfo;
  part: 'range' | 'earlier';
  lastChange: string;
  originalSen: number; latestSen: number; amendedSen: number;
  /** The goods of the changes left out: in Amended, not in the effect. */
  uncountedGoodsSen?: number;
  reachedOn: string | null;
  effectSen: number;
  fromHistory: boolean;
  /** An old order with no fair (opened before October 2026): only its upsales and
      drop sales count, paid or not (owner 2026-11-13). */
  oldOrder?: true;
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
  /** Ref No., SO date and status — absent on rows made before 2026-11-12. */
  ref?: string | null; soDate?: string | null; status?: string;
  /** What that month paid for the order: as closed, plus adjustments paid since. */
  wasSen: number;
  /** That month recalculated today. */
  nowSen: number;
  adjustmentSen: number;
  /** The goods Now is worked on and the rate (owner 2026-11-13: 「我看不到goods amount和rate」) —
      absent when the month pays the order on nothing, and on rows made before. */
  goodsSen?: number;
  ratePct?: number | null;
};
/** An order Finance marked, with the commission the mark took out of this report. */
export type CommissionMarkedOrder = CommissionOrderPlace & { mark: CommissionMarkInfo; commissionSen: number };
/** An order whose commission the month before moved here (「这个算下个月」). */
export type CommissionDeferredIn = CommissionOrderPlace & {
  fromMonth: string;
  mark: CommissionMarkInfo;
  commissionSen: number;
  /** Marked again here — moved on or not counted; 0 is paid here then. */
  markedAgain?: CommissionMarkInfo;
};
/** One of Finance's own lines (owner 2026-11-13): goods typed on an order for a
 *  month — plus adds commission, minus takes it back — at the order's own rate. */
export type CommissionManualLine = CommissionOrderPlace & {
  line: { id: string; month: string; reason: string | null; addedBy: string | null; addedAt: string };
  goodsSen: number;
  commissionSen: number;
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
  /** 补开单: orders keyed in the range for a fair that had ended before it — absent before 2026-11-12. */
  lateBills?: string[];
  /** The orders Finance marked on this report, and what the month before moved here. */
  marked?: CommissionMarkedOrder[];
  deferredIn?: CommissionDeferredIn[];
  /** Finance's own lines for the months the range begins — absent when there are none. */
  manualLines?: CommissionManualLine[];
  totals: { payableSen: number; adjustmentsSen: number; monthAdjustmentsSen?: number; deferredInSen?: number; manualSen?: number; totalSen: number };
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

/** Mark an order (Finance): 「这张单不要算」 — not counted, any month; 「这个算下个月」 —
 *  what it earns in `month` (an open month) is paid the month after; 「这次改价不算」
 *  — its upsales / drop sales of `month` move no commission, the order still counted. */
export function useMarkCommissionOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { docNo: string; kind: CommissionMarkKind; month?: string; reason?: string | null }) =>
      authedFetch<{ ok: true; mark: CommissionMarkInfo }>('/acc-events/commission/marks', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ['acc-events', 'commission'] }); },
    onError: writeFailedAs('Order not marked'),
  });
}

/** Type a line on an order for an open month (Finance): goods, plus or minus, with the reason. */
export function useAddCommissionLine() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { docNo: string; month: string; goodsSen: number; reason: string }) =>
      authedFetch<{ ok: true }>('/acc-events/commission/lines', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ['acc-events', 'commission'] }); },
    onError: writeFailedAs('Line not added'),
  });
}
/** Take one of Finance's lines away, while its month is open. */
export function useRemoveCommissionLine() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => authedFetch<{ ok: true }>('/acc-events/commission/lines/remove', { method: 'POST', body: JSON.stringify({ id }) }),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ['acc-events', 'commission'] }); },
    onError: writeFailedAs('Line not taken away'),
  });
}

/** Take a mark away: the order counts again where it belongs. */
export function useUnmarkCommissionOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => authedFetch<{ ok: true }>('/acc-events/commission/marks/undo', { method: 'POST', body: JSON.stringify({ id }) }),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ['acc-events', 'commission'] }); },
    onError: writeFailedAs('Mark not taken away'),
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
