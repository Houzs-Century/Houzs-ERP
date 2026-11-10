/* The run-sheet's open delivery-order stop, kept current while it is open.

   The run-sheet reads the whole board once and does not poll it (it is the
   heaviest read the phone makes), so when the helper tapped "On the way" or
   "Arrived", the driver's open stop kept showing the old step until someone
   went back and pulled to refresh. The crew share one stop (owner, 2026-11-10),
   so the open stop asks the light POD read for just that DO every
   CREW_STOP_POLL_MS and lays its status and times over the board row. The same
   query key as MobilePOD's crew read, so the two screens share one answer. */
import { useQuery } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { CREW_STOP_POLL_MS } from './crew-stop-photos';

export type LiveDoStop = {
  id: string;
  do_number: string | null;
  status: string | null;
  arrival_at: string | null;
  departure_at: string | null;
};

const FINISHED = new Set(['DELIVERED', 'INVOICED', 'SIGNED', 'CANCELLED']);

export function useLiveDoStop(doNumber: string | null) {
  return useQuery({
    queryKey: ['mfg-delivery-order-pod', doNumber ?? ''],
    queryFn: () => authedFetch<{ deliveryOrder: LiveDoStop }>(`/delivery-planning/do/${encodeURIComponent(doNumber!)}/pod`),
    enabled: !!doNumber,
    staleTime: 10_000,
    refetchInterval: (query) => (FINISHED.has(String(query.state.data?.deliveryOrder.status ?? '').toUpperCase()) ? false : CREW_STOP_POLL_MS),
  });
}

type RowWithDos = {
  delivery_orders?: Array<{ id?: string; do_number?: string | null; status?: string | null } | null> | null;
  arrival_at?: string | null;
  departure_at?: string | null;
};

/** The board row with the live DO's status and times laid over it. Only the
 *  same DO is overlaid; a stale answer for another DO leaves the row alone. A
 *  time the live read does not have keeps the row's. */
export function withLiveDo<T extends RowWithDos>(row: T, live: LiveDoStop | null | undefined): T {
  const dos = (row.delivery_orders ?? []).filter((d): d is NonNullable<typeof d> => !!d && !!d.id);
  const latest = dos.at(-1);
  if (!live || !latest || latest.id !== live.id) return row;
  return {
    ...row,
    delivery_orders: [...dos.slice(0, -1), { ...latest, status: live.status ?? latest.status }],
    arrival_at: live.arrival_at ?? row.arrival_at,
    departure_at: live.departure_at ?? row.departure_at,
  };
}
