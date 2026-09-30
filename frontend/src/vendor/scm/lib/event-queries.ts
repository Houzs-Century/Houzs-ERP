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
