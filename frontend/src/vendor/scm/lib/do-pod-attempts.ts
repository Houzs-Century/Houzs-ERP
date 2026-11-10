/* Earlier delivery attempts of a Delivery Order: the POD an "Undo delivered"
   took off the order (owner-approved 2026-11-10). One read for the desktop DO
   page and the phone's DO detail. Server: backend/src/scm/routes/delivery-order-pod-attempts.ts.
   Keyed under the DO detail so the revert hook's detail invalidation refreshes it. */
import { useQuery } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';

export type DoPodAttempt = {
  id: string;
  delivery_order_id: string;
  attempt_no: number;
  undone_at: string;
  undone_by: number | null;
  undone_by_name: string | null;
  reason: string;
  from_status: string | null;
  departure_at: string | null;
  arrival_at: string | null;
  signed_at: string | null;
  delivered_at: string | null;
  signature_data: string | null;
  pod_lat: number | null;
  pod_lng: number | null;
  pod_located_at: string | null;
  photo_count: number;
};

export const doPodAttemptsKey = (doId: string) => ['mfg-delivery-order-detail', doId, 'pod-attempts'] as const;

export function useDoPodAttempts(doId: string | null | undefined) {
  return useQuery({
    queryKey: doPodAttemptsKey(doId ?? ''),
    queryFn: () =>
      authedFetch<{ attempts?: DoPodAttempt[] }>(`/delivery-orders-mfg/${encodeURIComponent(doId!)}/pod-attempts`)
        .then((r) => r.attempts ?? []),
    enabled: !!doId,
    staleTime: 30_000,
  });
}

/** The photo URLs of one attempt, for PodPhotoAlbum (auth-fetched as blobs). */
export function doPodAttemptPhotoPaths(a: Pick<DoPodAttempt, 'id' | 'delivery_order_id' | 'photo_count'>): string[] {
  const base = `/api/scm/delivery-orders-mfg/${encodeURIComponent(a.delivery_order_id)}/pod-attempts/${encodeURIComponent(a.id)}/photo`;
  return Array.from({ length: a.photo_count }, (_, n) => `${base}/${n}`);
}
