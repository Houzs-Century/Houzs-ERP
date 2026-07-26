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

// ── Sequence & assign (Fleet A2) ─────────────────────────────────────────────

export type SequenceAssignBody = {
  soDocNos: string[];
  depotWarehouseId?: string | null;
  startDate?: string;
  departTime?: string;
  defaultMaxSets?: number;
  defaultMaxRevenueCenti?: number;
  /** A3: own-fleet trips per lorry per day before the rest spill to 3PL overflow. */
  maxTripsPerLorryPerDay?: number;
};

export type AssignedSequenceStop = {
  ref: string;
  order: number;
  travelMinutes: number;
  distanceMetres: number;
  arrivalTime: string | null;
  waitMinutes: number;
  startServiceTime: string | null;
  finishTime: string | null;
  serviceMinutes: number;
  earliestTime: string | null;
  latestTime: string | null;
  windowViolated: boolean;
  etaOffsetS: number;
  legDistanceM: number;
  legDurationS: number;
};

export type AssignedTripStop = {
  ref: string;
  debtorName: string | null;
  buildingType: string | null;
  address: string;
  serviceMinutes: number;
  earliestTime: string | null;
  latestTime: string | null;
};

export type AssignedTrip = {
  key: string;
  date: string;
  group: string;
  lorryId: string;
  plate: string;
  driverId: string | null;
  driverName: string | null;
  helperId: string | null;
  helperName: string | null;
  sets: number;
  revenueCenti: number;
  ceilingSets: number | null;
  ceilingRevenueCenti: number | null;
  overCeiling: boolean;
  departTime: string;
  stops: AssignedTripStop[];
  /** The computed nearest-neighbour route + windows, or null when Google is off. */
  sequence: {
    departTime: string | null;
    sequence: AssignedSequenceStop[];
    totalTravelMinutes: number;
    totalDistanceMetres: number;
    returnTime: string | null;
    windowViolations: number;
  } | null;
  routeReason: string | null;
  ungeocoded: string[];
};

/** A3: a group the own fleet could not cover that day — a 3PL-assign candidate. */
export type OverflowGroup = {
  key: string;
  date: string;
  group: string;
  orders: string[];
  sets: number;
  revenueCenti: number;
  reason: string;
};

/** A3: a 3PL carrier the dispatcher can assign overflow to (an OUTSOURCE lorry). */
export type ThreePlCarrier = { id: string; plate: string; warehouseId: string | null };

/** A3: a driver withheld from the auto-pick because they are on leave. */
export type ExcludedDriver = { id: string; name: string | null; from: string; to: string; reason: string | null };

export type SequenceAssignResponse = {
  startDate: string;
  departTime: string;
  configured: boolean;
  usingDefaultZoneMap: boolean;
  depotWarehouseId: string | null;
  depot: { warehouseId: string | null; address: string; lat: number; lng: number } | null;
  lorryCount: number;
  dispatchableCount: number;
  trips: AssignedTrip[];
  excludedLorries: { id: string; plate: string; status: string }[];
  /** A3 fields. */
  excludedDrivers: ExcludedDriver[];
  overflow: OverflowGroup[];
  carriers: ThreePlCarrier[];
  unassigned: { key: string | null; date: string | null; group: string | null; orders: string[]; reason: string }[];
};

/** Fire A2 sequence + assign for the picked orders. A mutation (it reads the
 *  fleet + Module-B status + geocodes + one Distance Matrix call per trip), so
 *  the dispatcher triggers it explicitly per locked day. */
export function useSequenceAssign() {
  return useMutation({
    mutationFn: (body: SequenceAssignBody) =>
      authedFetch<SequenceAssignResponse>('/delivery-zones/sequence-assign', { method: 'POST', body: JSON.stringify(body) }),
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

// ── Driver leave (Fleet A3) ────────────────────────────────────────────────────
// The date-ranged driver absences the A2 auto-assigner reads to skip on-leave
// drivers. Backed by scm.driver_leave (mig 0206) via /api/scm/driver-leave.

export type DriverLeaveRow = {
  id: string;
  driverId: string;
  startDate: string;
  endDate: string;
  reason: string | null;
  createdAt: string | null;
};

const DRIVER_LEAVE_KEY = ['driver-leave'] as const;

export function useDriverLeave() {
  return useQuery({
    queryKey: DRIVER_LEAVE_KEY,
    queryFn: () => authedFetch<{ leave: DriverLeaveRow[] }>('/driver-leave').then((r) => r.leave),
    staleTime: 30_000,
  });
}

export function useCreateDriverLeave() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { driverId: string; startDate: string; endDate: string; reason?: string | null }) =>
      authedFetch<{ leave: DriverLeaveRow }>('/driver-leave', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: DRIVER_LEAVE_KEY }),
  });
}

export function useDeleteDriverLeave() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => authedFetch<{ ok: true }>(`/driver-leave/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: DRIVER_LEAVE_KEY }),
  });
}
