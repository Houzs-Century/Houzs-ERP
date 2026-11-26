
export type CapacityLayer = 'SETS' | 'REVENUE' | 'BOTH';

export interface PackOrder {
  ref: string;
  zone: string;
  sets: number;
  revenueSen: number;
  hasFurniture: boolean;
}

export interface PackLorry {
  id: string;
  plate: string;
  maxSets: number | null;
  maxRevenueSen: number | null;
  layer: CapacityLayer;
}

export interface PackConfig {
  startDate: string;
  klangValleyZones: readonly string[];
  defaultMaxSets: number;
  defaultMaxRevenueSen: number;
  maxDays?: number;
}

export interface PackedLorry {
  lorryId: string;
  plate: string;
  sets: number;
  revenueSen: number;
  ceilingSets: number | null;
  ceilingRevenueSen: number | null;
  layer: CapacityLayer;
  partial: boolean;
  overCeiling: boolean;
  orders: string[];
}

export interface PackedDay {
  date: string;
  group: string;
  lorries: PackedLorry[];
}

export interface PackProposal {
  ref: string;
  zone: string;
  group: string;
  deliveryDate: string;
  lorryId: string;
  plate: string;
  sets: number;
  revenueSen: number;
}

export interface PackResult {
  proposals: PackProposal[];
  days: PackedDay[];
  unassigned: { ref: string; zone: string; reason: string }[];
}

const KV_GROUP = 'KLANG_VALLEY';
const DEFAULT_MAX_DAYS = 60;

/** YYYY-MM-DD + n days (UTC-stable). PURE. */
export function addDays(iso: string, n: number): string {
  const base = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`).getTime();
  return new Date(base + n * 86_400_000).toISOString().slice(0, 10);
}

interface Ceilings {
  sets: number | null;
  revenueSen: number | null;
}

function ceilingsFor(lorry: PackLorry, cfg: PackConfig): Ceilings {
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

function fits(
  runningSets: number,
  runningRev: number,
  order: PackOrder,
  ceil: Ceilings,
): boolean {
  if (ceil.sets != null && runningSets + order.sets > ceil.sets) return false;
  if (ceil.revenueSen != null && runningRev + order.revenueSen > ceil.revenueSen) return false;
  return true;
}

function packGroup(
  group: string,
  orders: PackOrder[],
  lorries: PackLorry[],
  cfg: PackConfig,
  isFar: boolean,
): { days: PackedDay[]; proposals: PackProposal[] } {
  const days: PackedDay[] = [];
  const proposals: PackProposal[] = [];
  const maxDays = cfg.maxDays ?? DEFAULT_MAX_DAYS;
  const queue = [...orders];

  let dayIndex = 0;
  while (queue.length > 0 && dayIndex < maxDays) {
    const date = addDays(cfg.startDate, dayIndex);
    const dayLorries: PackedLorry[] = [];

    for (const lorry of lorries) {
      if (queue.length === 0) break;
      const ceil = ceilingsFor(lorry, cfg);
      const packed: PackedLorry = {
        lorryId: lorry.id,
        plate: lorry.plate,
        sets: 0,
        revenueSen: 0,
        ceilingSets: ceil.sets,
        ceilingRevenueSen: ceil.revenueSen,
        layer: lorry.layer,
        partial: false,
        overCeiling: false,
        orders: [],
      };

      while (queue.length > 0) {
        const next = queue[0];
        if (packed.orders.length === 0 && !fits(0, 0, next, ceil)) {
          packed.overCeiling = true;
          packed.orders.push(next.ref);
          packed.sets += next.sets;
          packed.revenueSen += next.revenueSen;
          proposals.push(proposalFor(next, group, date, lorry));
          queue.shift();
          break;
        }
        if (!fits(packed.sets, packed.revenueSen, next, ceil)) break;
        packed.orders.push(next.ref);
        packed.sets += next.sets;
        packed.revenueSen += next.revenueSen;
        proposals.push(proposalFor(next, group, date, lorry));
        queue.shift();
      }

      if (packed.orders.length === 0) continue;

      if (isFar && !packed.overCeiling) {
        const setFull = ceil.sets != null && packed.sets >= ceil.sets;
        const revFull = ceil.revenueSen != null && packed.revenueSen >= ceil.revenueSen;
        packed.partial = !(setFull || revFull);
      }
      dayLorries.push(packed);
    }

    if (dayLorries.length > 0) days.push({ date, group, lorries: dayLorries });
    if (dayLorries.length === 0) break;
    dayIndex += 1;
  }

  return { days, proposals };
}

function proposalFor(order: PackOrder, group: string, date: string, lorry: PackLorry): PackProposal {
  return {
    ref: order.ref,
    zone: order.zone,
    group,
    deliveryDate: date,
    lorryId: lorry.id,
    plate: lorry.plate,
    sets: order.sets,
    revenueSen: order.revenueSen,
  };
}

/**
 * Pack every provided order into proposed lorry-days. PURE. Deterministic:
 * orders are packed in the order given (the caller sorts them — e.g. by revenue
 * or set size — before calling, if it wants a particular fill strategy).
 */
export function packProposals(input: {
  orders: readonly PackOrder[];
  lorries: readonly PackLorry[];
  config: PackConfig;
}): PackResult {
  const { orders, lorries, config } = input;
  const kvSet = new Set(config.klangValleyZones);

  const unassigned: PackResult['unassigned'] = [];
  if (lorries.length === 0) {
    return {
      proposals: [],
      days: [],
      unassigned: orders.map((o) => ({ ref: o.ref, zone: o.zone, reason: 'no lorries available for this depot' })),
    };
  }

  const kvOrders: PackOrder[] = [];
  const farByZone = new Map<string, PackOrder[]>();
  for (const o of orders) {
    if (kvSet.has(o.zone)) {
      kvOrders.push(o);
    } else {
      const arr = farByZone.get(o.zone) ?? [];
      arr.push(o);
      farByZone.set(o.zone, arr);
    }
  }

  const days: PackedDay[] = [];
  const proposals: PackProposal[] = [];

  if (kvOrders.length > 0) {
    const r = packGroup(KV_GROUP, kvOrders, [...lorries], config, false);
    days.push(...r.days);
    proposals.push(...r.proposals);
    if (r.days.length === 0) {
      for (const o of kvOrders) unassigned.push({ ref: o.ref, zone: o.zone, reason: 'could not pack (no lorry capacity)' });
    }
  }

  for (const zone of [...farByZone.keys()].sort()) {
    const zoneOrders = farByZone.get(zone)!;
    const r = packGroup(zone, zoneOrders, [...lorries], config, true);
    days.push(...r.days);
    proposals.push(...r.proposals);
    if (r.days.length === 0) {
      for (const o of zoneOrders) unassigned.push({ ref: o.ref, zone: o.zone, reason: 'could not pack (no lorry capacity)' });
    }
  }

  return { proposals, days, unassigned };
}
