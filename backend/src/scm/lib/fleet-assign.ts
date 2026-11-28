
import type { CapacityLayer } from './capacity-pack';
import { isDriverOnLeave, isHelperOnLeave, type DriverLeaveRange, type HelperLeaveRange } from './driver-availability';

/** A locked-day trip group to be crewed — one packed lorry-trip from A1. */
export interface AssignGroup {
  key: string;
  date: string;
  group: string;
  orders: string[];
  sets: number;
  revenueSen: number;
  preferredLorryId: string | null;
}

/** A depot lorry the assigner may choose from. */
export interface AssignLorry {
  id: string;
  plate: string;
  dispatchable: boolean;
  status: string;
  maxSets: number | null;
  maxRevenueSen: number | null;
  layer: CapacityLayer;
  driverId: string | null;
  driverName: string | null;
}

export interface AssignDriver {
  id: string;
  name: string;
  vehiclePlate: string | null;
}

export interface AssignHelper {
  id: string;
  name: string;
}

export interface AssignConfig {
  defaultMaxSets: number;
  defaultMaxRevenueSen: number;
  maxTripsPerLorryPerDay?: number;
}

export interface AssignedGroup {
  key: string;
  date: string;
  group: string;
  orders: string[];
  sets: number;
  revenueSen: number;
  lorryId: string;
  plate: string;
  ceilingSets: number | null;
  ceilingRevenueSen: number | null;
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
  revenueSen: number;
  reason: string;
}

export interface AssignResult {
  assignments: AssignedGroup[];
  unassigned: { key: string; date: string; group: string; orders: string[]; reason: string }[];
  overflow: OverflowGroup[];
  excludedLorries: AssignExcludedLorry[];
}

interface Ceilings {
  sets: number | null;
  revenueSen: number | null;
}

function ceilingsFor(lorry: AssignLorry, cfg: AssignConfig): Ceilings {
  const sets = lorry.maxSets ?? cfg.defaultMaxSets;
  const rev = lorry.maxRevenueSen ?? cfg.defaultMaxRevenueSen;
  switch (lorry.layer) {
    case 'SETS':
      return { sets, revenueSen: null };
    case 'REVENUE':
      return { sets: null, revenueSen: rev };
    case 'BOTH':
    default:
      return { sets, revenueSen: rev };
  }
}

function exceeds(group: AssignGroup, ceil: Ceilings): boolean {
  if (ceil.sets != null && group.sets > ceil.sets) return true;
  if (ceil.revenueSen != null && group.revenueSen > ceil.revenueSen) return true;
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
  driverLeave?: readonly DriverLeaveRange[];
  helperLeave?: readonly HelperLeaveRange[];
}): AssignResult {
  const { groups, config } = input;
  const driverLeave = input.driverLeave ?? [];
  const helperLeave = input.helperLeave ?? [];
  const maxTrips = Math.max(1, Math.floor(config.maxTripsPerLorryPerDay ?? 1));

  const eligible = input.lorries.filter((l) => l.dispatchable);
  const excludedLorries: AssignExcludedLorry[] = input.lorries
    .filter((l) => !l.dispatchable)
    .map((l) => ({ id: l.id, plate: l.plate, status: l.status }));

  const assignments: AssignedGroup[] = [];
  const unassigned: AssignResult['unassigned'] = [];
  const overflow: OverflowGroup[] = [];

  if (eligible.length === 0) {
    for (const g of groups) {
      overflow.push({ key: g.key, date: g.date, group: g.group, orders: g.orders, sets: g.sets, revenueSen: g.revenueSen, reason: 'no dispatchable own-fleet lorry — assign a 3PL carrier' });
    }
    return { assignments, unassigned, overflow, excludedLorries };
  }

  const lorryById = new Map(eligible.map((l) => [l.id, l]));
  const load = new Map<string, { sets: number; revenueSen: number; groups: number }>();
  const loadKey = (date: string, lorryId: string) => `${date}::${lorryId}`;
  const loadOf = (date: string, lorryId: string) =>
    load.get(loadKey(date, lorryId)) ?? { sets: 0, revenueSen: 0, groups: 0 };

  const usedDrivers = new Map<string, Set<string>>();
  const usedHelpers = new Map<string, Set<string>>();
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
    const preferred = g.preferredLorryId ? lorryById.get(g.preferredLorryId) ?? null : null;
    const withSlot = eligible.filter((l) => loadOf(g.date, l.id).groups < maxTrips);

    if (withSlot.length === 0) {
      overflow.push({ key: g.key, date: g.date, group: g.group, orders: g.orders, sets: g.sets, revenueSen: g.revenueSen, reason: 'own fleet is full for this day — assign a 3PL carrier' });
      continue;
    }

    const ranked = [...withSlot].sort((a, b) => {
      if (preferred) {
        if (a.id === preferred.id && b.id !== preferred.id) return -1;
        if (b.id === preferred.id && a.id !== preferred.id) return 1;
      }
      const la = loadOf(g.date, a.id);
      const lb = loadOf(g.date, b.id);
      if (la.groups !== lb.groups) return la.groups - lb.groups;
      if (la.sets !== lb.sets) return la.sets - lb.sets;
      if (la.revenueSen !== lb.revenueSen) return la.revenueSen - lb.revenueSen;
      return a.plate.localeCompare(b.plate);
    });

    const chosen = ranked[0];
    const ceil = ceilingsFor(chosen, config);
    const overCeiling = exceeds(g, ceil);

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
    const freeHelper = input.helpers.find((h) => !helpersUsedToday.has(h.id) && !isHelperOnLeave(helperLeave, h.id, g.date));
    if (freeHelper) { helperId = freeHelper.id; helperName = freeHelper.name; helpersUsedToday.add(helperId); }

    assignments.push({
      key: g.key,
      date: g.date,
      group: g.group,
      orders: g.orders,
      sets: g.sets,
      revenueSen: g.revenueSen,
      lorryId: chosen.id,
      plate: chosen.plate,
      ceilingSets: ceil.sets,
      ceilingRevenueSen: ceil.revenueSen,
      overCeiling,
      driverId,
      driverName,
      helperId,
      helperName,
    });

    const cur = loadOf(g.date, chosen.id);
    load.set(loadKey(g.date, chosen.id), {
      sets: cur.sets + g.sets,
      revenueSen: cur.revenueSen + g.revenueSen,
      groups: cur.groups + 1,
    });
  }

  return { assignments, unassigned, overflow, excludedLorries };
}
