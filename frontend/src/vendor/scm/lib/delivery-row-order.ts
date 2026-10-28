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
