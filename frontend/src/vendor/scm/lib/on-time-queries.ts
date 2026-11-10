// On-time delivery for a period (GET /api/scm/logistic-overview/on-time). Every figure
// is worked out on the server (backend/src/scm/lib/on-time-delivery.ts); the Logistic
// Overview and Lorry Capacity only read it.
import { useQuery } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';

export type OnTimeResult = 'ON_TIME' | 'EARLY' | 'LATE' | 'LATE_OPEN';

export interface OnTimeOrder {
  soDocNo: string; customer: string | null; promised: string; delivered: string | null;
  daysLate: number; result: OnTimeResult;
  region: string; lorryId: string | null; lorry: string | null; driver: string | null;
}

export interface OnTimeGroup {
  key: string; lorryId: string | null;
  delivered: number; onTime: number; early: number; late: number; lateOpen: number;
  ratePct: number | null;
}

export interface OnTimeData {
  today: string; from: string; to: string;
  delivered: number; onTime: number; early: number; late: number; lateOpen: number;
  ratePct: number | null;
  byLorry: OnTimeGroup[]; byDriver: OnTimeGroup[]; byRegion: OnTimeGroup[];
  excluded: { offPeninsula: number; noPromise: number; noDeliveryTime: number };
  orders: OnTimeOrder[];
  /** When the server computed these figures (its kept copy can be up to 2 h old). */
  cachedAt?: string;
}

export const ON_TIME_LABEL: Record<OnTimeResult, string> = { ON_TIME: 'On time', EARLY: 'Early', LATE: 'Late', LATE_OPEN: 'Late, not delivered' };

/* Exported so the page's Refresh can re-ask this exact question with ?fresh=1. */
export const onTimeKey = (from: string, to: string, warehouse: string | null) => ['logistic-on-time', from, to, warehouse ?? ''];
export const onTimeUrl = (from: string, to: string, warehouse: string | null) =>
  `/logistic-overview/on-time?from=${from}&to=${to}${warehouse ? `&warehouse=${warehouse}` : ''}`;

export function useOnTime(from: string, to: string, warehouse: string | null) {
  return useQuery({
    queryKey: onTimeKey(from, to, warehouse),
    queryFn: () => authedFetch<OnTimeData>(onTimeUrl(from, to, warehouse)),
    staleTime: 60_000,
  });
}

/** "92.5%" or a dash when nothing was delivered. */
export const ratePctText = (p: number | null): string => (p == null ? '—' : `${p}%`);
