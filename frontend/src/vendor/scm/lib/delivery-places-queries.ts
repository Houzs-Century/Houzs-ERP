// Places under the delivery zones (mig 20261111T1100; route delivery-places.ts;
// owner 2026-11-11: the 3PL rate cards use the same areas as Delivery Zones).
// A place is a town a rate card prices and the zone its postcodes fall in; the
// rate card reads it only inside that zone. Everything goes through
// authedFetch -> /api/scm/delivery-places.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';

export type Place = {
  id: string;
  name: string;
  /** The zone its postcodes fall in; null = in no zone (abroad). */
  zone: string | null;
  /** The rate cards that price it. */
  cards: string[];
};

export type PlacesResponse = {
  places: Place[];
  /** Towns rate cards price that no zone holds yet. */
  unplaced: Array<{ name: string; cards: string[] }>;
};

export const PLACES_KEY = ['delivery-places'] as const;

export function usePlaces() {
  return useQuery({
    queryKey: PLACES_KEY,
    queryFn: () => authedFetch<PlacesResponse>('/delivery-places'),
    staleTime: 60_000,
  });
}

export function useAddPlaces() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { zone: string | null; names: string[] }) =>
      authedFetch<{ places: Array<Omit<Place, 'cards'>> }>('/delivery-places', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: PLACES_KEY }),
  });
}

export function useMovePlace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, zone }: { id: string; zone: string | null }) =>
      authedFetch<{ place: Omit<Place, 'cards'> }>(`/delivery-places/${id}`, { method: 'PATCH', body: JSON.stringify({ zone }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: PLACES_KEY }),
  });
}

export function useRemovePlace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => authedFetch<{ ok: true }>(`/delivery-places/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: PLACES_KEY }),
  });
}
