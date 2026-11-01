// ----------------------------------------------------------------------------
// fleet-day/vm — the view-model assembly for the lorry-card board. PURE: it
// folds the two feeds (FleetDayTrip runs + PlanningOrder drops) and a stop-status
// map into the LorryRunVM / DocRowVM the UI renders, and applies the filter row
// + search. Kept out of the components so the grouping, filtering and search
// rules are testable without a browser (vm.test.ts).
// ----------------------------------------------------------------------------
import type { PlanningOrder } from '../../../vendor/scm/lib/delivery-planning-queries';
import type { FleetDayTrip } from '../../../vendor/scm/lib/fleet-day-queries';
import type { DriverRow } from '../../../vendor/scm/lib/drivers-queries';
import type { StopStatus } from '../../../vendor/scm/lib/delivery-stop-status';
import { windowEndMinutes } from '../../../vendor/scm/lib/delivery-stop-status';
import {
  slotKindOf, slotLabelOf, runStatusOf, rollupRun, isLate, lateReason,
  type RunStatus, type SlotKind, type RunRollup,
} from '../../../vendor/scm/lib/fleet-day-cards';

/* The clock + day the board is rendered against (Malaysian time). */
export type DayClock = { day: string; today: string; nowMinutes: number };

/** An ISO instant as a Malaysian-time clock "8:42 AM" (null-safe). Time only —
 *  the board is always one known day. */
export function clockMY(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const d = new Date(t + 8 * 3600_000);
  let h = d.getUTCHours();
  const m = d.getUTCMinutes();
  const ap = h >= 12 ? 'PM' : 'AM';
  h = ((h + 11) % 12) + 1;
  return `${h}:${String(m).padStart(2, '0')} ${ap}`;
}

/** "HH:MM" (Malaysian clock) for an ISO instant — for a <input type="time">.
 *  "" when absent/unparseable. */
export function isoToMytTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const d = new Date(t + 8 * 3600_000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

/** Combine the board day (YYYY-MM-DD) + a "HH:MM" into an ISO instant at
 *  Malaysian time (UTC+8). "" time clears the stamp (null). */
export function mytTimeToIso(day: string, time: string): string | null {
  if (!time) return null;
  return `${day}T${time}:00+08:00`;
}

/** The earliest moment any drop on a run went "on the way" (the DO departure
 *  stamp) — the actual-departure fallback when the trip has no clock-in yet.
 *  null when nothing has departed. */
export function actualDepartOf(docs: ReadonlyArray<{ order: PlanningOrder }>): string | null {
  let best: number | null = null;
  for (const d of docs) {
    const iso = d.order.departure_at;
    if (!iso) continue;
    const t = Date.parse(iso);
    if (Number.isNaN(t)) continue;
    if (best == null || t < best) best = t;
  }
  return best == null ? null : new Date(best).toISOString();
}

export type DocRowVM = {
  /** The board-row key the grid/selection uses (so:<docNo>). */
  key: string;
  order: PlanningOrder;
  soDocNo: string;
  doNumber: string | null;
  ref: string | null;
  customer: string;
  phone: string | null;
  address: string | null;
  region: string;
  salespersonId: string | null;
  agent: string | null;
  branding: string | null;
  amountSen: number;
  units: number;
  slotKind: SlotKind | null;
  slotLabel: string;
  stopNo: number | null;
  status: StopStatus;
  late: boolean;
  lateReason: string | null;
  hasPod: boolean;
  deliveredAt: string | null;
  /** The latest non-draft/cancelled DO's id — the POD + crew target; null when none. */
  latestLiveDoId: string | null;
};

export type LorryRunVM = {
  trip: FleetDayTrip;
  plate: string;
  tripNo: string | null;
  color: string;
  driverName: string | null;
  driverIc: string | null;
  driverPhone: string | null;
  driver2Name: string | null;
  helpers: string[];
  status: RunStatus;
  rollup: RunRollup;
  docs: DocRowVM[];
};

const unitsOf = (o: PlanningOrder): number => o.delivered_qty + o.remaining_qty;

/** The latest live (non-draft/cancelled) DO id for an order — the POD/crew target. */
export function latestLiveDoId(o: Pick<PlanningOrder, 'delivery_orders'>): string | null {
  const live = o.delivery_orders.filter((d) => {
    const s = d.status.toUpperCase();
    return s !== 'DRAFT' && s !== 'CANCELLED';
  });
  return live.length > 0 ? live[live.length - 1]!.id : null;
}

/** One board row -> a doc row, given its already-computed stop status + the clock. */
export function docRowVM(o: PlanningOrder, status: StopStatus, clock: DayClock): DocRowVM {
  const slotEnd = windowEndMinutes(o.time_range);
  const live = o.delivery_orders.filter((d) => {
    const s = d.status.toUpperCase();
    return s !== 'DRAFT' && s !== 'CANCELLED';
  });
  return {
    key: `so:${o.so_doc_no}`,
    order: o,
    soDocNo: o.so_doc_no,
    doNumber: live.length > 0 ? live[live.length - 1]!.do_number : null,
    ref: o.so_ref ?? null,
    customer: o.debtor_name ?? '',
    phone: o.phone ?? null,
    address: o.address ?? null,
    region: o.region,
    salespersonId: o.salesperson_id ?? null,
    agent: o.agent ?? null,
    branding: o.branding ?? null,
    amountSen: o.local_total_sen,
    units: unitsOf(o),
    slotKind: slotKindOf(o.time_range),
    slotLabel: slotLabelOf(o.time_range),
    stopNo: o.trip_stop_no ?? null,
    status,
    late: isLate(status),
    lateReason: lateReason(status, { day: clock.day, today: clock.today, slotEnd }),
    hasPod: !!o.has_pod,
    deliveredAt: o.delivered_at ?? o.customer_delivered_date ?? null,
    latestLiveDoId: live.length > 0 ? live[live.length - 1]!.id : null,
  };
}

/** Build the day's lorry runs: one per trip, carrying the drops whose server-
 *  stamped trip_id points at it, sorted by stop no. Driver IC/phone join the
 *  drivers master by id; driver-2's NAME comes off the drops' crew snapshot
 *  (its only store). `colorOf` resolves each trip's route colour. */
export function buildRuns(
  trips: readonly FleetDayTrip[],
  dayDocs: readonly DocRowVM[],
  driversById: Map<string, DriverRow>,
  colorOf: (tripId: string) => string,
): LorryRunVM[] {
  const docsByTrip = new Map<string, DocRowVM[]>();
  for (const d of dayDocs) {
    const tid = d.order.trip_id;
    if (!tid) continue;
    const arr = docsByTrip.get(tid) ?? [];
    arr.push(d);
    docsByTrip.set(tid, arr);
  }
  return trips.map((t) => {
    const docs = (docsByTrip.get(t.id) ?? []).slice().sort(
      (a, b) => (a.stopNo ?? 1e9) - (b.stopNo ?? 1e9),
    );
    const master = t.driver?.id ? driversById.get(t.driver.id) : undefined;
    const driver2Name = docs.map((d) => d.order.crew?.driver_2_name).find((n) => n) ?? null;
    const statuses = docs.map((d) => d.status);
    const totalSen = docs.reduce((n, d) => n + d.amountSen, 0);
    const withPod = docs.filter((d) => d.status === 'done' && d.hasPod).length;
    return {
      trip: t,
      plate: t.lorry?.plate ?? '—',
      tripNo: t.trip_no,
      color: colorOf(t.id),
      driverName: t.driver?.name ?? null,
      driverIc: master?.ic_number ?? null,
      driverPhone: master?.phone ?? null,
      driver2Name,
      helpers: t.helpers.map((h) => h.name).filter(Boolean),
      status: runStatusOf(statuses),
      rollup: rollupRun(statuses, totalSen, withPod),
      docs,
    };
  });
}

/* ── Filter row + search ──────────────────────────────────────────────────*/
export type StatusFilter = 'ALL' | 'scheduled' | 'active' | 'done' | 'overdue';
export type SlotFilter = 'ALL' | 'AM' | 'PM';

export type FleetFilters = {
  region: string;          // 'ALL' or a region code
  status: StatusFilter;
  salespersonId: string;   // 'ALL' or a staff id
  slot: SlotFilter;
  lateOnly: boolean;
  query: string;
};

export const EMPTY_FILTERS: FleetFilters = {
  region: 'ALL', status: 'ALL', salespersonId: 'ALL', slot: 'ALL', lateOnly: false, query: '',
};

export function filtersActive(f: FleetFilters): boolean {
  return f.region !== 'ALL' || f.status !== 'ALL' || f.salespersonId !== 'ALL'
    || f.slot !== 'ALL' || f.lateOnly || f.query.trim() !== '';
}

/** Does a query hit this drop? name / SO / DO / Ref (substring, case-insensitive)
 *  or a run of >=3 phone digits. A query under 2 chars matches everything. */
export function searchMatch(d: DocRowVM, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return true;
  const digits = q.replace(/\D/g, '');
  const phoneDigits = (d.phone ?? '').replace(/\D/g, '');
  if (digits.length >= 3 && phoneDigits.includes(digits)) return true;
  return [d.customer, d.soDocNo, d.doNumber, d.ref].some(
    (v) => (v ?? '').toLowerCase().includes(q),
  );
}

/** Apply the filter row to a set of drops. `region` matches the order's primary
 *  or leg buckets. */
export function applyFilters(docs: readonly DocRowVM[], f: FleetFilters): DocRowVM[] {
  return docs.filter((d) => {
    if (f.region !== 'ALL' && !d.order.regions.includes(f.region)) return false;
    if (f.status !== 'ALL' && d.status !== f.status) return false;
    if (f.lateOnly && !d.late) return false;
    if (f.salespersonId !== 'ALL' && d.salespersonId !== f.salespersonId) return false;
    if (f.slot !== 'ALL' && d.slotKind !== f.slot) return false;
    if (!searchMatch(d, f.query)) return false;
    return true;
  });
}
