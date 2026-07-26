// ---------------------------------------------------------------------------
// fleet-assign.ts — Fleet Module A2/A3: greedy assignment of a lorry + driver +
// helper to each of a locked day's zone-packed trip groups. PURE, unit-tested.
//
// A1's packer (capacity-pack.ts) already grouped a day's orders into lorry-trips
// under each lorry's capacity ceiling. A2 takes those groups and decides, from
// the depot's AVAILABLE fleet, WHO drives WHAT:
//
//   - EXCLUDE unavailable lorries. A lorry that Module B (fleet-status.ts)
//     derives to a non-dispatchable status — BREAKDOWN / COMPLIANCE_BLOCKED /
//     OUT_OF_SERVICE / (in a maintenance window) — is never assigned. The caller
//     passes each lorry's `dispatchable` flag (from canDispatch(deriveVehicleStatus)).
//   - EXCLUDE on-leave drivers (A3). A driver whose leave covers a group's date
//     is never AUTO-crewed onto it. The caller passes the leave ranges
//     (driver-availability.ts); the exclusion is per group DATE, so a driver on
//     leave Monday is still eligible for Tuesday's trips.
//   - CAPACITY FIT. A group whose sets/revenue exceed the chosen lorry's active
//     ceiling is still assigned (the load must ship) but flagged overCeiling, the
//     same "ships anyway, visibly" posture A1 takes.
//   - BALANCE THE DAY. Spread the day's groups across distinct dispatchable
//     lorries rather than stacking several onto one while others idle. Each group
//     goes to the least-loaded eligible lorry (preferring the lorry A1 packed it
//     onto when that lorry is still free and dispatchable).
//   - 3PL OVERFLOW (A3). Each own-fleet lorry runs at most `maxTripsPerLorryPerDay`
//     trips a day (default 1 — one full-day delivery run). When a group's date
//     has no own-fleet slot left (every eligible lorry at its cap, or no eligible
//     lorry at all), the group SPILLS to `overflow[]` instead of being stacked
//     onto an already-full lorry. The dispatcher assigns each overflow group to a
//     region 3PL carrier (an OUTSOURCE lorry) at a captured cost — that does NOT
//     consume an own-fleet slot.
//   - PAIR THE CREW. A lorry's regular driver (matched by plate) takes it when
//     free AND not on leave; otherwise the least-used available driver. A helper
//     is the least-used available helper. Drivers/helpers are assigned at most
//     once per day.
//
// This is a PROPOSAL. It writes NOTHING. Every assignment is overridable by the
// dispatcher on screen; the established schedule write-path persists the accepted
// lorry/driver/helper + sequence. It is NOT a scheduler and NOT a parallel path.
// ---------------------------------------------------------------------------

import type { CapacityLayer } from './capacity-pack';
import { isDriverOnLeave, isHelperOnLeave, type DriverLeaveRange, type HelperLeaveRange } from './driver-availability';

/** A locked-day trip group to be crewed — one packed lorry-trip from A1. */
export interface AssignGroup {
  /** Stable identity for this group (e.g. `${date}|${group}|${idx}`). */
  key: string;
  date: string;
  /** 'KLANG_VALLEY' for the mixed pool, else the zone code. */
  group: string;
  /** The order refs (SO doc numbers) on this trip, in packing order. */
  orders: string[];
  sets: number;
  revenueCenti: number;
  /** The lorry A1 packed this group onto — the preferred assignment. */
  preferredLorryId: string | null;
}

/** A depot lorry the assigner may choose from. */
export interface AssignLorry {
  id: string;
  plate: string;
  /** canDispatch(deriveVehicleStatus(...)) — Module B. false => never assigned. */
  dispatchable: boolean;
  /** The derived VehicleStatus, carried so an excluded lorry can say WHY. */
  status: string;
  /** Per-lorry ceilings; null => use the config default. */
  maxSets: number | null;
  maxRevenueCenti: number | null;
  layer: CapacityLayer;
  /** The lorry's regular driver, matched by plate (caller resolves). */
  driverId: string | null;
  driverName: string | null;
}

export interface AssignDriver {
  id: string;
  name: string;
  /** The lorry plate this driver is normally paired with (drivers.vehicle). */
  vehiclePlate: string | null;
}

export interface AssignHelper {
  id: string;
  name: string;
}

export interface AssignConfig {
  defaultMaxSets: number;
  defaultMaxRevenueCenti: number;
  /** A3: max trips one own-fleet lorry runs per day before the rest spill to 3PL
   *  overflow. Default 1 (one full-day delivery run). Overridable per request. */
  maxTripsPerLorryPerDay?: number;
}

export interface AssignedGroup {
  key: string;
  date: string;
  group: string;
  orders: string[];
  sets: number;
  revenueCenti: number;
  lorryId: string;
  plate: string;
  ceilingSets: number | null;
  ceilingRevenueCenti: number | null;
  /** The group exceeds the chosen lorry's active ceiling but still ships. */
  overCeiling: boolean;
  driverId: string | null;
  driverName: string | null;
  helperId: string | null;
  helperName: string | null;
}

export interface AssignExcludedLorry {
  id: string;
  plate: string;
  status: string;
}

/** A group the own fleet could not take that day — a 3PL-assignment candidate. */
export interface OverflowGroup {
  key: string;
  date: string;
  group: string;
  orders: string[];
  sets: number;
  revenueCenti: number;
  reason: string;
}

export interface AssignResult {
  assignments: AssignedGroup[];
  /** Groups that could not be crewed (kept for shape; A3 routes fleet shortfall to overflow). */
  unassigned: { key: string; date: string; group: string; orders: string[]; reason: string }[];
  /** A3: groups the own fleet is full for — the dispatcher assigns a 3PL carrier. */
  overflow: OverflowGroup[];
  /** Lorries Module B ruled out — surfaced so the dispatcher sees the fleet gap. */
  excludedLorries: AssignExcludedLorry[];
}

interface Ceilings {
  sets: number | null;
  revenueCenti: number | null;
}

function ceilingsFor(lorry: AssignLorry, cfg: AssignConfig): Ceilings {
  const sets = lorry.maxSets ?? cfg.defaultMaxSets;
  const rev = lorry.maxRevenueCenti ?? cfg.defaultMaxRevenueCenti;
  switch (lorry.layer) {
    case 'SETS':
      return { sets, revenueCenti: null };
    case 'REVENUE':
      return { sets: null, revenueCenti: rev };
    case 'BOTH':
    default:
      return { sets, revenueCenti: rev };
  }
}

/** Does the group blow past EITHER active ceiling on the chosen lorry? */
function exceeds(group: AssignGroup, ceil: Ceilings): boolean {
  if (ceil.sets != null && group.sets > ceil.sets) return true;
  if (ceil.revenueCenti != null && group.revenueCenti > ceil.revenueCenti) return true;
  return false;
}

function normPlate(p: string | null | undefined): string {
  return String(p ?? '').trim().toUpperCase().replace(/\s+/g, '');
}

/**
 * Greedily assign a lorry + driver + helper to each group. PURE — deterministic
 * for a given input (groups are processed in the order given; the caller sorts
 * them biggest-first if it wants a fuller-first spread). Mutates nothing outside.
 */
export function assignFleet(input: {
  groups: readonly AssignGroup[];
  lorries: readonly AssignLorry[];
  drivers: readonly AssignDriver[];
  helpers: readonly AssignHelper[];
  config: AssignConfig;
  /** A3: date-ranged driver leave; an on-leave driver is not auto-crewed that day. */
  driverLeave?: readonly DriverLeaveRange[];
  /** WS2: date-ranged helper leave; an on-leave helper is not auto-crewed that day. */
  helperLeave?: readonly HelperLeaveRange[];
}): AssignResult {
  const { groups, config } = input;
  const driverLeave = input.driverLeave ?? [];
  const helperLeave = input.helperLeave ?? [];
  // One own-fleet trip per lorry per day by default; a lorry beyond its cap is
  // "full" and the next group for that day spills to 3PL overflow.
  const maxTrips = Math.max(1, Math.floor(config.maxTripsPerLorryPerDay ?? 1));

  const eligible = input.lorries.filter((l) => l.dispatchable);
  const excludedLorries: AssignExcludedLorry[] = input.lorries
    .filter((l) => !l.dispatchable)
    .map((l) => ({ id: l.id, plate: l.plate, status: l.status }));

  const assignments: AssignedGroup[] = [];
  const unassigned: AssignResult['unassigned'] = [];
  const overflow: OverflowGroup[] = [];

  if (eligible.length === 0) {
    // No own fleet at all -> the whole day is 3PL overflow (A3), not a dead end.
    for (const g of groups) {
      overflow.push({ key: g.key, date: g.date, group: g.group, orders: g.orders, sets: g.sets, revenueCenti: g.revenueCenti, reason: 'no dispatchable own-fleet lorry — assign a 3PL carrier' });
    }
    return { assignments, unassigned, overflow, excludedLorries };
  }

  const lorryById = new Map(eligible.map((l) => [l.id, l]));
  // Running per-(date, lorry) load, so balancing is per-day: a lorry idle on one
  // day is fair game even if busy on another.
  const load = new Map<string, { sets: number; revenueCenti: number; groups: number }>();
  const loadKey = (date: string, lorryId: string) => `${date}::${lorryId}`;
  const loadOf = (date: string, lorryId: string) =>
    load.get(loadKey(date, lorryId)) ?? { sets: 0, revenueCenti: 0, groups: 0 };

  // Drivers/helpers are a per-day resource too (a person crews one lorry a day).
  const usedDrivers = new Map<string, Set<string>>(); // date -> driverIds used
  const usedHelpers = new Map<string, Set<string>>(); // date -> helperIds used
  const daySet = (m: Map<string, Set<string>>, date: string) => {
    let s = m.get(date);
    if (!s) { s = new Set(); m.set(date, s); }
    return s;
  };

  const driverByPlate = new Map<string, AssignDriver>();
  for (const d of input.drivers) {
    const key = normPlate(d.vehiclePlate);
    if (key && !driverByPlate.has(key)) driverByPlate.set(key, d);
  }

  for (const g of groups) {
    // Candidate lorries: only those with a free own-fleet SLOT for this date
    // (fewer than maxTrips trips already), the preferred one first (if eligible),
    // then the rest, each ranked by CURRENT day-load so the least-loaded wins
    // (balance), with a group of 0 on a fresh lorry beating a lorry carrying work.
    const preferred = g.preferredLorryId ? lorryById.get(g.preferredLorryId) ?? null : null;
    const withSlot = eligible.filter((l) => loadOf(g.date, l.id).groups < maxTrips);

    if (withSlot.length === 0) {
      // Own fleet is full for this date -> spill to 3PL overflow (A3).
      overflow.push({ key: g.key, date: g.date, group: g.group, orders: g.orders, sets: g.sets, revenueCenti: g.revenueCenti, reason: 'own fleet is full for this day — assign a 3PL carrier' });
      continue;
    }

    const ranked = [...withSlot].sort((a, b) => {
      // Preferred lorry gets first refusal.
      if (preferred) {
        if (a.id === preferred.id && b.id !== preferred.id) return -1;
        if (b.id === preferred.id && a.id !== preferred.id) return 1;
      }
      const la = loadOf(g.date, a.id);
      const lb = loadOf(g.date, b.id);
      if (la.groups !== lb.groups) return la.groups - lb.groups;   // fewer trips first
      if (la.sets !== lb.sets) return la.sets - lb.sets;           // then lighter
      if (la.revenueCenti !== lb.revenueCenti) return la.revenueCenti - lb.revenueCenti;
      return a.plate.localeCompare(b.plate);                        // stable
    });

    const chosen = ranked[0];
    const ceil = ceilingsFor(chosen, config);
    const overCeiling = exceeds(g, ceil);

    // Crew the lorry. Its regular driver (by plate) if free today AND not on
    // leave; else the least-used available driver who is not on leave. Helper =
    // least-used available helper. On-leave drivers (A3) are skipped per-date.
    const driversUsedToday = daySet(usedDrivers, g.date);
    const helpersUsedToday = daySet(usedHelpers, g.date);
    const driverFree = (id: string) => !driversUsedToday.has(id) && !isDriverOnLeave(driverLeave, id, g.date);

    let driverId: string | null = null;
    let driverName: string | null = null;
    const paired = driverByPlate.get(normPlate(chosen.plate)) ?? null;
    if (paired && driverFree(paired.id)) {
      driverId = paired.id; driverName = paired.name;
    } else if (chosen.driverId && driverFree(chosen.driverId)) {
      driverId = chosen.driverId; driverName = chosen.driverName;
    } else {
      const free = input.drivers.find((d) => driverFree(d.id));
      if (free) { driverId = free.id; driverName = free.name; }
    }
    if (driverId) driversUsedToday.add(driverId);

    let helperId: string | null = null;
    let helperName: string | null = null;
    // Least-used available helper who is not on leave this date (WS2).
    const freeHelper = input.helpers.find((h) => !helpersUsedToday.has(h.id) && !isHelperOnLeave(helperLeave, h.id, g.date));
    if (freeHelper) { helperId = freeHelper.id; helperName = freeHelper.name; helpersUsedToday.add(helperId); }

    assignments.push({
      key: g.key,
      date: g.date,
      group: g.group,
      orders: g.orders,
      sets: g.sets,
      revenueCenti: g.revenueCenti,
      lorryId: chosen.id,
      plate: chosen.plate,
      ceilingSets: ceil.sets,
      ceilingRevenueCenti: ceil.revenueCenti,
      overCeiling,
      driverId,
      driverName,
      helperId,
      helperName,
    });

    const cur = loadOf(g.date, chosen.id);
    load.set(loadKey(g.date, chosen.id), {
      sets: cur.sets + g.sets,
      revenueCenti: cur.revenueCenti + g.revenueCenti,
      groups: cur.groups + 1,
    });
  }

  return { assignments, unassigned, overflow, excludedLorries };
}
