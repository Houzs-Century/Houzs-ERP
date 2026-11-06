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
import { jobRefOf, LEG_LABEL } from '../../../vendor/scm/lib/delivery-job';
import type { MapRoute, MapRouteStop, MapLatLng } from '../../../vendor/scm/lib/delivery-map-model';
import {
  slotKindOf, slotLabelOf, slotSortKey, condenseWindow, runStatusOf, rollupRun, isLate, lateReason,
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
  /** The feed row type — SO deliveries vs the non-SO jobs (assr / dp / project)
   *  the same lorry also runs. Drives the job tag + which identity line to show. */
  rowType: PlanningOrder['row_type'];
  /** The job-type tag for a NON-SO job ("Setup" / "Dismantle" / "Transfer item" /
   *  "Supplier pickup" / "Service"…); null for an SO delivery, which needs no tag. */
  jobLabel: string | null;
  /** The identity line the card shows: SO · DO · Ref for a delivery, the job's own
   *  document (DP / ASSR / project code) for a non-SO job. */
  codeLine: string;
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
  /** The scheduled trip backing this card, or null for a lorry that carries
   *  assigned drops (or is a pinned in-house lorry) with no run opened yet. */
  trip: FleetDayTrip | null;
  /** The lorry master id; null for a plate seen only as a drop's crew label. */
  lorryId: string | null;
  /** In-house (own fleet) vs outsourced/3PL — drives the board sectioning. */
  isInternal: boolean;
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

/** A lorry master row — the subset buildLorryCards needs to pin in-house
 *  lorries and classify in-house vs outsourced. */
export type LorryMaster = { id: string; plate: string; is_internal?: boolean | null; active: boolean };

/** Normalised plate key — spaces removed, upper-cased — so an order's crew
 *  label ("VQE 9058") and the lorry master ("VQE9058") collapse to one lorry. */
export function platekey(plate: string | null | undefined): string {
  return (plate ?? '').replace(/\s+/g, '').toUpperCase();
}

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
  const doNumber = live.length > 0 ? live[live.length - 1]!.do_number : null;
  // A non-SO job (assr / dp / project): its tag comes from the shared leg vocabulary
  // (LEG_LABEL — the same one the mobile run-sheet and job panel use) and its
  // identity line is the job's own document (dp_no for a DP job, else the row's ref
  // = the ASSR no. / project code). An SO delivery keeps its SO · DO · Ref line.
  const jr = jobRefOf(o);
  const jobLabel = jr ? (LEG_LABEL[jr.leg] ?? jr.leg) : null;
  const jobDoc = jr ? (jr.sourceType === 'dp' ? o.dp_no ?? null : o.ref ?? null) : null;
  const codeLine = jr
    ? (jobDoc ?? '')
    : [o.so_doc_no, doNumber, o.so_ref].filter(Boolean).join(' · ');
  // A completed NON-SO job (an ASSR service leg, a DP transfer / dismantle, a
  // project window) carries its done-ness on delivery_state — it has no DO status
  // or job-progress completion the stop-status reader keys on — so fold it into
  // the day's done list instead of showing a finished job as "Not started".
  const effStatus: StopStatus = o.row_type !== 'so' && o.delivery_state === 'DELIVERED' ? 'done' : status;
  return {
    key: `so:${o.so_doc_no}`,
    order: o,
    rowType: o.row_type,
    jobLabel,
    codeLine,
    soDocNo: o.so_doc_no,
    doNumber,
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
    status: effStatus,
    late: isLate(effStatus),
    lateReason: lateReason(effStatus, { day: clock.day, today: clock.today, slotEnd }),
    hasPod: !!o.has_pod,
    deliveredAt: o.delivered_at ?? o.customer_delivered_date ?? null,
    latestLiveDoId: live.length > 0 ? live[live.length - 1]!.id : null,
  };
}

/** Neutral plate/stop colour for a card with no trip (no map route to tint). */
const NO_TRIP_COLOR = '#b4b9ad';

/** Assemble one lorry card from its (optional) trip + the drops on it, sorted by
 *  stop no. With a trip, the crew + IC/phone come off the trip and the drivers
 *  master; without one (a lorry given drops on the DP board but no run opened),
 *  they fall back to the drops' own crew snapshot. driver-2's NAME always comes
 *  off the crew snapshot (its only store). */
function makeRunVM(args: {
  plate: string;
  lorryId: string | null;
  isInternal: boolean;
  trip: FleetDayTrip | null;
  docs: readonly DocRowVM[];
  color: string;
  driversById: Map<string, DriverRow>;
}): LorryRunVM {
  const { plate, lorryId, isInternal, trip, color, driversById } = args;
  // Drops ordered by DELIVERY TIME, earliest first (owner 2026-11-02, every lorry):
  // the slot-start minutes, then the run sequence (trip_stop_no), then the SO no.
  // so the order is stable when two drops share a window.
  const BIG = Number.MAX_SAFE_INTEGER;
  const docs = args.docs.slice().sort((a, b) => {
    const ak = slotSortKey(a.order.time_range);
    const bk = slotSortKey(b.order.time_range);
    if (ak !== bk) return ak - bk;
    const as = a.stopNo ?? BIG;
    const bs = b.stopNo ?? BIG;
    if (as !== bs) return as - bs;
    return a.soDocNo.localeCompare(b.soDocNo);
  });
  const master = trip?.driver?.id ? driversById.get(trip.driver.id) : undefined;
  const crew = docs.map((d) => d.order.crew).find((c) => c) ?? null;
  const driver2Name = docs.map((d) => d.order.crew?.driver_2_name).find((n) => n) ?? null;
  const helpers = trip
    ? trip.helpers.map((h) => h.name).filter(Boolean)
    : [...new Set(
      docs.flatMap((d) => [d.order.crew?.helper_1_name, d.order.crew?.helper_2_name])
        .filter((n): n is string => !!n),
    )];
  const statuses = docs.map((d) => d.status);
  const totalSen = docs.reduce((n, d) => n + d.amountSen, 0);
  const withPod = docs.filter((d) => d.status === 'done' && d.hasPod).length;
  return {
    trip,
    lorryId,
    isInternal,
    plate,
    tripNo: trip?.trip_no ?? null,
    color,
    driverName: trip?.driver?.name ?? crew?.driver_1_name ?? crew?.driver ?? null,
    driverIc: master?.ic_number ?? crew?.driver_1_ic ?? null,
    driverPhone: master?.phone ?? crew?.driver_1_contact ?? null,
    driver2Name,
    helpers,
    status: runStatusOf(statuses),
    rollup: rollupRun(statuses, totalSen, withPod),
    docs,
  };
}

/** Build the day's lorry runs: one per trip, carrying the drops whose server-
 *  stamped trip_id points at it. `colorOf` resolves each trip's route colour. */
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
    (docsByTrip.get(tid) ?? docsByTrip.set(tid, []).get(tid)!).push(d);
  }
  return trips.map((t) => makeRunVM({
    plate: t.lorry?.plate ?? '—',
    lorryId: t.lorry?.id ?? null,
    isInternal: false,
    trip: t,
    docs: docsByTrip.get(t.id) ?? [],
    color: colorOf(t.id),
    driversById,
  }));
}

/** The board's lorry cards (owner rule 2026-11-01): every in-house lorry is
 *  PINNED — shown even with no work — and an outsourced lorry appears only on a
 *  day it carries drops. A card is backed by its trip when one exists; otherwise
 *  it is a read-only view of the drops assigned to that plate on the DP board
 *  (no trip was opened). Sorted in-house first, then outsourced, each A->Z by
 *  plate. No lorry has more than one trip a day, so one card per lorry holds. */
export function buildLorryCards(
  trips: readonly FleetDayTrip[],
  dayDocs: readonly DocRowVM[],
  lorries: readonly LorryMaster[],
  driversById: Map<string, DriverRow>,
  colorOf: (tripId: string) => string,
): LorryRunVM[] {
  const masterByPlate = new Map(lorries.map((l) => [platekey(l.plate), l]));
  const tripByPlate = new Map<string, FleetDayTrip>();
  for (const t of trips) if (t.lorry?.plate) tripByPlate.set(platekey(t.lorry.plate), t);

  // Each drop -> its lorry key: its trip's plate, else its crew's plate label.
  const docsByKey = new Map<string, DocRowVM[]>();
  for (const d of dayDocs) {
    const viaTrip = d.order.trip_id ? trips.find((t) => t.id === d.order.trip_id) : undefined;
    const key = platekey(viaTrip?.lorry?.plate ?? d.order.crew?.lorry_plate);
    if (!key) continue;
    (docsByKey.get(key) ?? docsByKey.set(key, []).get(key)!).push(d);
  }

  // Keys to show: every trip's lorry, every active in-house lorry (pinned), and
  // every lorry a drop was assigned to today.
  const keys = new Set<string>();
  for (const t of trips) if (t.lorry?.plate) keys.add(platekey(t.lorry.plate));
  for (const l of lorries) if (l.is_internal === true && l.active) keys.add(platekey(l.plate));
  for (const k of docsByKey.keys()) keys.add(k);

  const cards = [...keys].map((key) => {
    const master = masterByPlate.get(key);
    const trip = tripByPlate.get(key) ?? null;
    const docs = docsByKey.get(key) ?? [];
    const plate = trip?.lorry?.plate ?? master?.plate
      ?? docs.find((d) => d.order.crew?.lorry_plate)?.order.crew?.lorry_plate ?? key;
    return makeRunVM({
      plate,
      lorryId: trip?.lorry?.id ?? master?.id ?? null,
      isInternal: master?.is_internal === true,
      trip,
      docs,
      color: trip ? colorOf(trip.id) : NO_TRIP_COLOR,
      driversById,
    });
  });
  cards.sort((a, b) => (a.isInternal === b.isInternal ? a.plate.localeCompare(b.plate) : a.isInternal ? -1 : 1));
  return cards;
}

/** A drop the board could not put on the map: its code line + why, so the panel
 *  shows "N of M stops couldn't be located" instead of silently dropping it. */
export type UnlocatedStop = { ref: string; label: string; reason: string };

/** The lorry cards -> per-lorry map routes (one coloured, numbered polyline per
 *  lorry), in the SAME delivery-time order the cards show (run.docs is already
 *  sorted). A drop with a geocoded address becomes a numbered stop; one without
 *  joins `unlocated` (surfaced, never dropped) — an SO with no pin because its
 *  address won't geocode, or a non-SO job the geo feed doesn't locate. A lorry
 *  with no drops has no route. `allRefs` keeps EVERY drop (located or not) so the
 *  by-lorry focus still filters the board to the whole run. PURE. */
export function buildLorryRoutes(
  runs: readonly LorryRunVM[],
  pointByRef: ReadonlyMap<string, MapLatLng>,
  depot: MapLatLng | null,
  colorForPlate: (plateKey: string) => string,
): { routes: MapRoute[]; unlocated: UnlocatedStop[] } {
  const routes: MapRoute[] = [];
  const unlocated: UnlocatedStop[] = [];
  for (const run of runs) {
    if (run.docs.length === 0) continue;
    const key = platekey(run.plate);
    const stops: MapRouteStop[] = [];
    for (const d of run.docs) {
      const pt = pointByRef.get(d.soDocNo);
      const label = d.customer || d.codeLine || d.soDocNo;
      if (!pt) {
        unlocated.push({
          ref: d.soDocNo,
          label: d.codeLine || d.soDocNo,
          reason: d.rowType === 'so' ? 'Address could not be located' : 'Non-delivery job — no location',
        });
        continue;
      }
      stops.push({
        ref: d.soDocNo,
        lat: pt.lat,
        lng: pt.lng,
        order: stops.length + 1,
        label,
        // Condensed for the day-map legend ("10:30AM to 12:30PM" -> "10:30–12:30");
        // the lorry card keeps the full slotLabel.
        windowLabel: condenseWindow(d.slotLabel) || null,
      });
    }
    routes.push({
      id: key,
      color: colorForPlate(key),
      title: run.plate,
      crewLabel: run.driverName,
      depot,
      stops,
      allRefs: run.docs.map((d) => d.soDocNo),
      delivered: run.rollup.delivered,
      total: run.rollup.drops,
    });
  }
  return { routes, unlocated };
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
  // codeLine carries a non-SO job's own document (DP / ASSR / project code), so a
  // transfer or service leg is searchable by its number too, not only an SO.
  return [d.customer, d.soDocNo, d.doNumber, d.ref, d.codeLine].some(
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
