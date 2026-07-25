// Fleet A1 hooks — the postcode -> zone map admin, the auto-propose delivery-date
// action, and reversible day locks (migration 0205 / route delivery-zones.ts).
//
// The API emits camelCase already (the route shapes rows out); everything goes
// through authedFetch -> /api/scm/delivery-zones.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';

// ── Zone map ─────────────────────────────────────────────────────────────────

export type ZoneRuleRow = {
  id: string;
  zone: string;
  prefixStart: number;
  prefixEnd: number;
  label: string | null;
  isActive: boolean;
  createdAt?: string | null;
  updatedAt?: string | null;
};

export type ZoneMapResponse = {
  zones: ZoneRuleRow[];
  usingDefault: boolean;
  defaultMap: { zone: string; prefixStart: number; prefixEnd: number }[];
  knownZones: string[];
};

export type NewZoneRule = {
  zone: string;
  prefixStart: number;
  prefixEnd: number;
  label?: string | null;
  isActive?: boolean;
};

export type ZoneRulePatch = Partial<NewZoneRule> & { id: string };

const ZONES_KEY = ['delivery-zones'] as const;

export function useZoneMap() {
  return useQuery({
    queryKey: ZONES_KEY,
    queryFn: () => authedFetch<ZoneMapResponse>('/delivery-zones'),
    staleTime: 60_000,
  });
}

export function useCreateZoneRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: NewZoneRule) =>
      authedFetch<{ zone: ZoneRuleRow }>('/delivery-zones', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ZONES_KEY }),
  });
}

export function useUpdateZoneRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: ZoneRulePatch) =>
      authedFetch<{ zone: ZoneRuleRow }>(`/delivery-zones/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ZONES_KEY }),
  });
}

export function useDeleteZoneRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => authedFetch<{ ok: true }>(`/delivery-zones/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ZONES_KEY }),
  });
}

// ── Auto-propose ─────────────────────────────────────────────────────────────

export type ProposeBody = {
  soDocNos: string[];
  depotWarehouseId?: string | null;
  startDate?: string;
  defaultMaxSets?: number;
  defaultMaxRevenueCenti?: number;
};

export type PackedLorry = {
  lorryId: string;
  plate: string;
  sets: number;
  revenueCenti: number;
  ceilingSets: number | null;
  ceilingRevenueCenti: number | null;
  layer: 'SETS' | 'REVENUE' | 'BOTH';
  partial: boolean;
  overCeiling: boolean;
  orders: string[];
};

export type PackedDay = {
  date: string;
  group: string;
  lorries: PackedLorry[];
};

export type PackProposal = {
  ref: string;
  zone: string;
  group: string;
  deliveryDate: string;
  lorryId: string;
  plate: string;
  sets: number;
  revenueCenti: number;
  debtorName: string | null;
};

export type ProposeResponse = {
  startDate: string;
  usingDefaultZoneMap: boolean;
  depotWarehouseId: string | null;
  lorryCount: number;
  capacityDefaults: { maxSets: number; maxRevenueCenti: number };
  proposals: PackProposal[];
  days: PackedDay[];
  unassigned: { ref: string; zone: string | null; reason: string }[];
};

/** Fire the auto-propose. Not a query — the dispatcher triggers it explicitly
 *  (it reads the fleet + zone map + SO lines), so it is a mutation. */
export function useProposeDelivery() {
  return useMutation({
    mutationFn: (body: ProposeBody) =>
      authedFetch<ProposeResponse>('/delivery-zones/propose', { method: 'POST', body: JSON.stringify(body) }),
  });
}

// ── Day locks ────────────────────────────────────────────────────────────────

export type DayLock = {
  id: string;
  warehouseId: string | null;
  deliveryDate: string;
  notes: string | null;
  lockedBy: string | null;
  lockedAt: string | null;
};

export function useDayLocks(opts: { warehouseId?: string | null; from?: string; to?: string }) {
  const { warehouseId, from, to } = opts;
  return useQuery({
    queryKey: ['delivery-day-locks', warehouseId ?? null, from ?? null, to ?? null],
    queryFn: () => {
      const p = new URLSearchParams();
      if (warehouseId) p.set('warehouseId', warehouseId);
      if (from) p.set('from', from);
      if (to) p.set('to', to);
      const qs = p.toString();
      return authedFetch<{ locks: DayLock[] }>(`/delivery-zones/locks${qs ? `?${qs}` : ''}`).then((r) => r.locks);
    },
    staleTime: 30_000,
  });
}

export function useLockDay() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { deliveryDate: string; warehouseId?: string | null; notes?: string | null }) =>
      authedFetch<{ lock: DayLock }>('/delivery-zones/locks', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['delivery-day-locks'] }),
  });
}

export function useUnlockDay() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => authedFetch<{ ok: true }>(`/delivery-zones/locks/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['delivery-day-locks'] }),
  });
}
