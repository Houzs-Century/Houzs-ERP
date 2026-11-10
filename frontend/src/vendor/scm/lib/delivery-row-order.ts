// ----------------------------------------------------------------------------
// delivery-row-order — the Delivery Planning board's manual drag order (owner
// 2026-09-26: 拖动行手动排). One shared array of row ids; it only decides the
// board DEFAULT sort, so a column sort overrides it and clearing the sort brings
// it back. DataTable computes the new order on a drag (reorderKeys) and the board
// persists it; the board sorts by it (orderComparator) when no column sort runs.
// ----------------------------------------------------------------------------

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { writeFailed } from './mutation-error';

/** A comparator over row keys: keys the manual order lists come first in that
 *  order, everything else keeps its natural (input) order after them. */
export function orderComparator(orderedKeys: readonly string[]): (a: string, b: string) => number {
  const idx = new Map(orderedKeys.map((k, i) => [k, i] as const));
  return (a, b) => {
    const ia = idx.get(a) ?? Infinity;
    const ib = idx.get(b) ?? Infinity;
    return ia === ib ? 0 : ia - ib; // equal (incl. both unlisted) → keep input order
  };
}

/** The shared order after a drag in a filtered view: the shown rows take their
 *  new order in the slots they already held, so rows hidden by a tab, region or
 *  funnel keep their places (a plain replace wiped them). Saved keys no longer
 *  loaded (`liveKeys`) are dropped so the array cannot grow without bound. */
export function mergeShownOrder(saved: readonly string[], shownNew: readonly string[], liveKeys: ReadonlySet<string>): string[] {
  const shown = new Set(shownNew);
  const kept = [...new Set(saved)].filter((k) => liveKeys.has(k));
  const keptSet = new Set(kept);
  const base = [...kept, ...shownNew.filter((k) => !keptSet.has(k))];
  let i = 0;
  return base.map((k) => (shown.has(k) ? shownNew[i++] : k));
}

type OrderResponse = { orderedKeys: string[] };

/** The shared manual order (array of row ids). Its own query key, so the board's
 *  frequent `['delivery-planning']` invalidations don't refetch it. */
export function useDeliveryRowOrder() {
  return useQuery({
    queryKey: ['delivery-row-order'],
    queryFn: () => authedFetch<OrderResponse>('/delivery-planning-row-order').then((r) => r.orderedKeys),
    staleTime: 30_000,
  });
}

export function useSetRowOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (orderedKeys: string[]) =>
      authedFetch<{ ok: true }>('/delivery-planning-row-order', { method: 'PUT', body: JSON.stringify({ orderedKeys }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['delivery-row-order'] }),
    onError: writeFailed,
  });
}
