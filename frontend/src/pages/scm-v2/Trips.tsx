// ----------------------------------------------------------------------------
// Delivery Time Arrangement — stage 3 of the delivery pipeline (Planning ->
// Date -> Time -> Last Mile). Owner's FINAL division (2026-08-08): this page
// is 排单 — "在送货当天,决定那一个区要先送哪一张单" — for the delivery DAY,
// decide the ORDER of orders within each zone. SEQUENCING ONLY: no lorry and
// no driver is named here; the intelligent driver + lorry assignment lives on
// Last Mile Delivery ("Propose crew").
//
// The page IS the queue board — the EXACT shared DeliveryPlanningBoard locked
// to PENDING_SCHEDULE, split Pending Time Arrangement (the inbox: date
// confirmed, no run yet) vs Time arranged (on a live run). Two actions on the
// multiselect:
//
//   "Propose time (N)"  — the per-date, per-zone STOP-SEQUENCE proposal,
//     under the confirmed-date discipline (lib/propose-time.ts): the selection
//     groups by each order's confirmed delivery date, the sequence-assign
//     engine runs once per date-group started AT that date, and each response
//     is pinned to that one day. The engine inherently packs into LORRY-SIZED
//     runs — capacity is real and is why the engine stays (zero backend
//     change) — but the vehicle's NAME is not this page's business:
//     lib/anonymous-runs.ts folds the trips into anonymous "Run 1 / Run 2"
//     groups per date, stripping every crew/vehicle identity field. The one
//     survivor is the opaque vehicleSlotId, kept strictly as Apply plumbing (a
//     stop needs a trip; a trip keys on (lorry, date)) and never rendered —
//     Last Mile's "Propose crew" is where a name is put to the slot. Applying
//     a run writes the sequence + dates exactly as before (schedule PATCH with
//     stopNo / ETA / leg metrics), with NO driver or helper written.
//   "Schedule (N)"      — the existing manual ScheduleTripDrawer, unchanged.
//
// Run detail (the trip list + stop sheet + route optimiser + Phase-4 live map)
// renders under the "Time arranged" tab. CANCELLED trips are dropped and the
// rest order IN_PROGRESS -> PLANNED -> COMPLETED.
// ----------------------------------------------------------------------------

import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Route as RouteIcon, MapPin, CalendarClock, CalendarCheck, Wand2, Map as MapIcon } from 'lucide-react';
import { PageHeader } from '../../components/Layout';
import { DeliveryMapPanel, useMapPanelOpen, useMapCompactColumns } from '../../components/scm-v2/DeliveryMapPanel';
import { useDeliveryGeo } from '../../vendor/scm/lib/delivery-geo-queries';
import {
  pinsFromGeoPoints,
  geoTotals,
  zoneSummary,
  routesFromRuns,
  stagedRoutesFromRows,
  focusFilterRows,
  toggleFocus,
  MAP_ESSENTIAL_COLUMNS_TIME,
  type MapFocus,
  type MapLatLng,
} from '../../vendor/scm/lib/delivery-map-model';
import { todayMY } from '../../vendor/shared/format';
import { Button } from '../../components/Button';
import { Badge } from '../../components/Badge';
import { cn } from '../../lib/utils';
import {
  useTrips,
  useTrip,
  useOptimizeTripRoute,
  type OptimizeResult,
  type TripRow,
} from '../../vendor/scm/lib/trips-queries';
import {
  useDeliveryPlanning,
  useScheduleDelivery,
  timeArrangementOf,
  ARRANGEMENT_STAGE_LABEL,
  type TimeArrangement,
  type PlanningOrder,
} from '../../vendor/scm/lib/delivery-planning-queries';
import { useDrivers } from '../../vendor/scm/lib/drivers-queries';
import { useLorries } from '../../vendor/scm/lib/lorries-queries';
import {
  useSequenceAssign,
  type SequenceAssignResponse,
} from '../../vendor/scm/lib/delivery-zones-queries';
import {
  groupByConfirmedDate,
  pinAssignToDate,
  mergeAssignResults,
  depotForDocNos,
} from '../../vendor/scm/lib/propose-time';
import { foldToAnonymousRuns, estWindowOf, type AnonymousRun } from '../../vendor/scm/lib/anonymous-runs';
import { MiniBadge, Th, Td, selStyle, fmtRm } from './delivery-propose-ui';
import {
  DeliveryPlanningBoard,
  regionTabsFrom,
  soDocNosFromSelection,
} from '../../vendor/scm/components/DeliveryPlanningBoard';
import { arrangementQueueCompare } from '../../vendor/scm/lib/arrangement-sort';
import { ScheduleTripDrawer } from '../../vendor/scm/components/ScheduleTripDrawer';
import { LiveTripMap, type LiveMarker } from '../../vendor/scm/components/LiveTripMap';
import { useTripLatestLocations } from '../../vendor/scm/lib/trip-locations-queries';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { DateField } from "../../vendor/scm/components/DateField";

const ICON = { size: 14, strokeWidth: 1.75 } as const;

/* Run-detail ordering under the Time arranged tab (dispatchers watch running
   trips first). CANCELLED is dropped entirely — a cancelled trip arranges
   nothing (its orders are already back in the queue via the reverse
   reconcile). */
const TRIP_STATUS_ORDER: Record<string, number> = { IN_PROGRESS: 0, PLANNED: 1, COMPLETED: 2 };

/** Resolve a driver uuid to its display name off the loaded master list. */
const driverNameFor = (drivers: Array<{ id: string; name: string }>, id: string | null): string | null =>
  id ? (drivers.find((d) => d.id === id)?.name ?? null) : null;

const mins = (s: number | null | undefined): string =>
  s == null ? '—' : `${Math.round(s / 60)} min`;
const km = (m: number | null | undefined): string =>
  m == null ? '—' : `${(m / 1000).toFixed(1)} km`;
/** ETA offset (seconds from departure) → a readable "+1h 20m from depart". */
const etaLabel = (s: number | null | undefined): string => {
  if (s == null) return '—';
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h > 0 ? `+${h}h ${m}m` : `+${m}m`;
};

export function Trips() {
  const navigate = useNavigate();
  const notify = useNotify();
  const askConfirm = useConfirm();

  /* ── The time-arrangement queue (the page body). Reuses the board's own
     endpoint (GET /delivery-planning?region=<r>&state=PENDING_SCHEDULE) and the
     server-derived arrangement stage — no new query, no new state logic. */
  const [pendingRegion, setPendingRegion] = useState<string>('ALL');
  const pending = useDeliveryPlanning({ region: pendingRegion, state: 'PENDING_SCHEDULE' });
  const pendingOrders = useMemo<PlanningOrder[]>(
    () => pending.data?.orders ?? [],
    [pending.data],
  );
  const pendingRegionTabs = useMemo(() => regionTabsFrom(pending.data?.regions), [pending.data?.regions]);

  const [timeSide, setTimeSide] = useState<'ALL' | TimeArrangement>('PENDING_TIME');
  const timeCounts = useMemo(() => {
    const c: Record<TimeArrangement, number> & { awaitingDate: number } = {
      PENDING_TIME: 0, TIME_ARRANGED: 0, awaitingDate: 0,
    };
    for (const o of pendingOrders) {
      const side = timeArrangementOf(o);
      if (side) c[side] += 1;
      else c.awaitingDate += 1;
    }
    return c;
  }, [pendingOrders]);
  const timeRows = useMemo(
    () => (timeSide === 'ALL'
      ? pendingOrders.filter((o) => timeArrangementOf(o) != null)
      : pendingOrders.filter((o) => timeArrangementOf(o) === timeSide)),
    [pendingOrders, timeSide],
  );

  /* Shared write path + option lists for the board's inline cells + bulk bar
     (the manual crew path stays on the board everywhere). */
  const sched = useScheduleDelivery();
  const { data: drivers = [] } = useDrivers();
  const { data: lorries = [] } = useLorries();

  /* Multiselect → Schedule (manual drawer) or Propose time (sequence flow). */
  const [pendingSel, setPendingSel] = useState<Set<string>>(new Set());
  const [scheduling, setScheduling] = useState(false);
  const selectedDocNos = soDocNosFromSelection(pendingSel);
  /* The SO order objects behind the selection — fed to the drawer as its stop
     list (SO-only, like every board bulk action). */
  const pendingSelectedOrders = useMemo<PlanningOrder[]>(() => {
    const docs = new Set(soDocNosFromSelection(pendingSel));
    return pendingOrders.filter((o) => o.row_type === 'so' && docs.has(o.so_doc_no));
  }, [pendingOrders, pendingSel]);

  /* ── Propose time — the per-date, per-zone stop-sequence proposal, under the
     confirmed-date discipline. Crew-free by construction: the response is
     folded to anonymous runs before anything renders. */
  const seqAssign = useSequenceAssign();
  const [departTime, setDepartTime] = useState<string>('09:00');
  const [proposing, setProposing] = useState(false);
  const [assign, setAssign] = useState<SequenceAssignResponse | null>(null);
  /* Same silent-success gap as the Date page: the proposal renders below the
     board, so success scrolls it into view. */
  const assignRef = useRef<HTMLDivElement | null>(null);
  const [applyingRun, setApplyingRun] = useState<string | null>(null);
  /* Per-date window failures — a proposal with no computed route means NO
     estimated delivery windows, and the owner wants that failure LOUD and
     actionable (which warehouse, where to fix it), never a quiet "—" column. */
  const [windowGaps, setWindowGaps] = useState<Array<{ date: string; label: string | null }>>([]);

  const runs = useMemo<AnonymousRun[]>(
    () => (assign ? foldToAnonymousRuns(assign.trips) : []),
    [assign],
  );

  /* ── Option B side map (owner 2026-08-08): board left, sticky map right.
     Everything the Date page's map shows PLUS the proposed/staged Trip 1/2/3
     routes as coloured polylines with numbered stops + per-stop window text.
     A proposal for the picked date draws its runs (est. delivery windows from
     the #1720 folds); otherwise the day's STAGED live trips draw off the
     server-stamped board rows (trip_id / trip_stop_no / trip_eta_offset_s). */
  const [mapOpen, setMapOpen] = useMapPanelOpen('time-arrangement');
  /* Compact columns: a per-page-persisted DEFAULT, never a lock — the pill on
     the panel header toggles it, and any explicit Columns-panel choice while
     the map is open switches it off (the user's picks win instantly). */
  const [mapCompact, setMapCompact] = useMapCompactColumns('time-arrangement');
  const [mapDate, setMapDate] = useState<string>(todayMY());
  const [mapRegion, setMapRegion] = useState<string>('ALL');
  const [mapFocus, setMapFocus] = useState<MapFocus | null>(null);
  const geo = useDeliveryGeo({ date: mapDate, region: mapRegion, enabled: mapOpen });
  const mapPins = useMemo(() => pinsFromGeoPoints(geo.data?.points ?? []), [geo.data?.points]);
  const mapTotals = useMemo(() => geoTotals(geo.data?.points ?? []), [geo.data?.points]);
  const mapZones = useMemo(
    () => zoneSummary(geo.data?.points ?? [], pendingRegionTabs, mapRegion),
    [geo.data?.points, pendingRegionTabs, mapRegion],
  );
  const pointByRef = useMemo(() => {
    const m = new Map<string, MapLatLng>();
    for (const p of geo.data?.points ?? []) m.set(p.ref, { lat: p.lat, lng: p.lng });
    return m;
  }, [geo.data?.points]);
  const mapDepot = geo.data?.depot ? { lat: geo.data.depot.lat, lng: geo.data.depot.lng } : null;
  const mapRoutes = useMemo(() => {
    const proposed = routesFromRuns(runs, mapDate, pointByRef, mapDepot);
    if (proposed.length > 0) return proposed;
    return stagedRoutesFromRows(pendingOrders, mapDate, pointByRef, mapDepot);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runs, mapDate, pointByRef, pendingOrders, geo.data?.depot]);
  /* Trip focus: card or polyline click → dim the rest, zoom, filter the board. */
  const focusRoute = (routeId: string) => {
    const route = mapRoutes.find((r) => r.id === routeId);
    if (!route) return;
    setMapFocus((cur) => toggleFocus(cur, { routeId, refs: route.allRefs }));
  };
  /* Two-way linkage (same shape as the Date page). */
  const [selectedPin, setSelectedPin] = useState<string | null>(null);
  const [scrollTo, setScrollTo] = useState<{ key: string; nonce: number } | null>(null);
  const onPinClick = (ref: string) => {
    setSelectedPin(ref);
    setScrollTo({ key: `so:${ref}`, nonce: Date.now() });
  };
  /* The board under focus: only the focused trip's stops (unpinned included). */
  const boardRows = useMemo(
    () => (mapOpen && mapFocus ? focusFilterRows(timeRows, mapFocus) : timeRows),
    [timeRows, mapOpen, mapFocus],
  );

  const runProposeTime = async () => {
    if (selectedDocNos.length === 0) {
      notify({ title: 'Nothing selected', body: 'Tick the orders to sequence first.', tone: 'error' });
      return;
    }
    /* Dates first, sequence second: group the selection by each order's
       CONFIRMED delivery date — the Date page owns dates, so the engine is
       started AT each confirmed date and pinned to that one day. An order with
       no confirmed date is reported and skipped, never dated here. The DEPOT is
       derived from the group's own rows (majority warehouse) because the engine
       computes routes — and therefore delivery windows — only when the request
       names a depot to geocode. Capacity ceilings and max-trips still ride the
       server defaults silently; the depart time applies to every day's runs. */
    const { groups, undated } = groupByConfirmedDate(pendingOrders, selectedDocNos);
    if (groups.length === 0) {
      notify({
        title: 'No confirmed dates',
        body: 'None of the selected orders has a confirmed delivery date — arrange dates in Delivery Date Arrangement first.',
        tone: 'error',
      });
      return;
    }
    setProposing(true);
    const results: SequenceAssignResponse[] = [];
    const failures: string[] = [];
    const gaps: Array<{ date: string; label: string | null }> = [];
    for (const g of groups) {
      const depot = depotForDocNos(pendingOrders, g.docNos);
      try {
        const r = await seqAssign.mutateAsync({
          soDocNos: g.docNos,
          startDate: g.date,
          departTime,
          depotWarehouseId: depot?.warehouseId ?? null,
        });
        results.push(pinAssignToDate(r, g.date));
        /* No depot on the orders, or the depot would not geocode → the engine
           returned no route and no windows for this date. Name it. */
        if (!depot) gaps.push({ date: g.date, label: null });
        else if (r.configured && !r.depot) gaps.push({ date: g.date, label: depot.label });
      } catch (e) {
        failures.push(`${g.date} (${e instanceof Error ? e.message : 'Something went wrong.'})`);
      }
    }
    setProposing(false);
    setWindowGaps(gaps);
    const merged = mergeAssignResults(results);
    if (merged) {
      setAssign(merged);
      notify({ title: 'Time proposal ready', body: 'Review the proposed runs below, then apply each.' });
      setTimeout(() => assignRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
    }
    if (undated.length > 0 || failures.length > 0) {
      notify({
        title: merged ? 'Proposed, with notes' : 'Propose time failed',
        body: [
          undated.length > 0 ? `${undated.length} order(s) skipped — no confirmed delivery date yet (arrange the date first): ${undated.join(', ')}.` : '',
          failures.length > 0 ? `Failed for ${failures.join('; ')}.` : '',
        ].filter(Boolean).join(' '),
        tone: merged && failures.length === 0 ? 'info' : 'error',
      });
    }
  };

  /* Apply ONE run: persist the stop sequence + dates exactly as before — one
     schedule call per stop with stopNo / ETA / leg metrics. The run's opaque
     vehicleSlotId rides along as PLUMBING only (a stop needs a trip; a trip
     keys on (lorry, date)); NO driver or helper is written — naming the crew
     is Last Mile Delivery's "Propose crew". */
  const applyRun = async (run: AnonymousRun) => {
    setApplyingRun(run.key);
    let ok = 0; let failed = 0;
    for (const s of run.stops) {
      try {
        await sched.mutateAsync({
          type: 'so', id: s.ref,
          scheduleDate: run.date, tripDate: run.date,
          lorryId: run.vehicleSlotId,
          stopNo: s.order,
          etaOffsetS: s.etaOffsetS ?? undefined,
          legDistanceM: s.legDistanceM ?? undefined,
          legDurationS: s.legDurationS ?? undefined,
        });
        ok += 1;
      } catch { failed += 1; }
    }
    setApplyingRun(null);
    notify({
      title: failed === 0 ? 'Trip sequenced' : 'Sequenced with some failures',
      body: `${run.date} Trip ${run.runNo}: ${ok} stop(s) staged${failed ? `, ${failed} failed` : ''}. Assign the crew in Last Mile Delivery.`,
      tone: failed === 0 ? 'info' : 'error',
    });
    pending.refetch();
    list.refetch();
  };

  /* ── Run detail — the "Time arranged" tab's content. ──────────────────────── */
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<OptimizeResult | null>(null);
  const list = useTrips({ status: 'ALL' });
  const detail = useTrip(selected);
  const optimize = useOptimizeTripRoute();

  const trips = useMemo<TripRow[]>(() => {
    const all = (list.data?.trips ?? []).filter((t) => String(t.status).toUpperCase() !== 'CANCELLED');
    return [...all].sort((a, b) =>
      (TRIP_STATUS_ORDER[String(a.status).toUpperCase()] ?? 9) - (TRIP_STATUS_ORDER[String(b.status).toUpperCase()] ?? 9)
      || String(b.trip_date ?? '').localeCompare(String(a.trip_date ?? '')));
  }, [list.data]);
  const stops = detail.data?.stops ?? [];
  const trip = detail.data?.trip ?? null;

  // ── Live driver tracking (Phase 4) ─────────────────────────────────────────
  // A trip only reports position while IN_PROGRESS. Poll the latest position per
  // driver ONLY for a live selected trip (a closed / planned trip bills nothing).
  const mapsKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined;
  const isLive = trip ? String(trip.status).toUpperCase() === 'IN_PROGRESS' : false;
  const liveLocs = useTripLatestLocations(selected, isLive);
  const STALE_MS = 90_000; // ~3 missed posts (25s cadence) = "last seen" goes amber
  const liveMarkers = useMemo<LiveMarker[]>(() => {
    const locs = liveLocs.data?.locations ?? [];
    return locs.map((loc) => ({
      location: loc,
      label: driverNameFor(drivers, loc.driverId) ?? (trip?.trip_no ?? 'Driver'),
      stale: loc.receivedAt ? Date.now() - Date.parse(loc.receivedAt) > STALE_MS : false,
    }));
  }, [liveLocs.data, drivers, trip]);

  const runOptimise = async (apply: boolean) => {
    if (!selected) return;
    if (apply) {
      const ok = await askConfirm({
        title: 'Apply this route order?',
        body: 'The stop order and each stop\'s ETA will be rewritten on the trip. Do this before the driver leaves, not after.',
        confirmLabel: 'Apply route',
      });
      if (!ok) return;
    }
    try {
      const r = await optimize.mutateAsync({ id: selected, apply });
      if (!r.configured) {
        notify({
          title: 'Route optimisation is off',
          body: 'GOOGLE_MAPS_API_KEY is not set, so nothing was sent to Google (and nothing was billed). Set it to enable routing.',
        });
        return;
      }
      if (!r.ok) {
        notify({ title: 'Could not optimise', body: r.reason ?? 'Google returned no usable route.', tone: 'error' });
        return;
      }
      setPreview(r);
      notify({
        title: apply ? 'Route applied' : 'Route preview',
        body: `${km(r.totalDistanceMetres)} · ${mins(r.totalDurationSeconds)} driving${apply ? ' — stop order and ETAs saved.' : ' — nothing saved yet.'}`,
      });
    } catch (e) {
      notify({ title: 'Optimise failed', body: e instanceof Error ? e.message : 'Something went wrong.', tone: 'error' });
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Delivery"
        title="Delivery Time Arrangement"
        description="For each delivery day, decide which zone goes first and the order of stops within it — crew and lorries are assigned next in Last Mile Delivery."
      />

      {/* ── Option B split: board (left) / sticky map (right). ─────────────── */}
      <div className="lg:flex lg:items-start lg:gap-4">
      <div className="min-w-0 space-y-4 lg:flex-1">

      {/* Split chips — the derived time side of the pipeline. */}
      <div className="flex flex-wrap items-center gap-1.5">
        {(['ALL', 'PENDING_TIME', 'TIME_ARRANGED'] as const).map((side) => (
          <button
            key={side}
            type="button"
            onClick={() => setTimeSide(side)}
            className={cn(
              'rounded-full border px-3 py-1 text-[12px]',
              timeSide === side ? 'border-accent bg-accent/10 font-semibold text-accent' : 'border-border text-ink-secondary',
            )}
          >
            {side === 'ALL'
              ? `All (${timeCounts.PENDING_TIME + timeCounts.TIME_ARRANGED})`
              : `${ARRANGEMENT_STAGE_LABEL[side]} (${timeCounts[side]})`}
          </button>
        ))}
        {timeCounts.awaitingDate > 0 && (
          <button
            type="button"
            className="ml-2 text-[11.5px] text-ink-muted underline decoration-dotted underline-offset-2"
            onClick={() => navigate('/scm/auto-schedule')}
            title="These orders have no confirmed delivery date yet — arrange the date first"
          >
            {timeCounts.awaitingDate} awaiting date arrangement
          </button>
        )}
        <span className="flex-1" />
        {mapOpen && mapFocus && (
          <button
            type="button"
            className="text-[11.5px] text-accent underline decoration-dotted underline-offset-2"
            onClick={() => setMapFocus(null)}
            title="Stop filtering the board to the focused trip"
          >
            Focused on one trip — clear
          </button>
        )}
        {!mapOpen && (
          <Button variant="ghost" icon={<MapIcon {...ICON} />} onClick={() => setMapOpen(true)} title="Show the day map beside the board">
            Show map
          </Button>
        )}
      </div>

      <DeliveryPlanningBoard
        orders={boardRows}
        counts={pending.data?.counts ?? {}}
        regionTabs={pendingRegionTabs}
        activeRegion={pendingRegion}
        onRegionChange={setPendingRegion}
        isLoading={pending.isLoading}
        error={pending.error}
        /* No stateTabs → the board is locked to the PENDING_SCHEDULE fetch. */
        selectedKeys={pendingSel}
        onToggle={(k) => setPendingSel((p) => {
          const n = new Set(p);
          if (n.has(k)) n.delete(k); else n.add(k);
          return n;
        })}
        onToggleAll={(keys, allSel) => setPendingSel((p) => {
          const n = new Set(p);
          if (allSel) { for (const k of keys) n.delete(k); }
          else { for (const k of keys) n.add(k); }
          return n;
        })}
        onClearSelection={() => setPendingSel(new Set())}
        sched={sched}
        drivers={drivers}
        lorries={lorries}
        storageKey="dg-trips-time-arrangement-v2"
        exportName="TripsTimeArrangement"
        /* Map-open narrowing (a DEFAULT — the compact pill / an explicit
           Columns-panel choice turns it off) + two-way linkage (Option B). */
        visibleColumnsOverride={mapOpen && mapCompact ? MAP_ESSENTIAL_COLUMNS_TIME : null}
        onUserAdjustColumns={() => { if (mapOpen && mapCompact) setMapCompact(false); }}
        onRowClick={(o) => { if (mapOpen && o.row_type === 'so') setSelectedPin(o.so_doc_no); }}
        scrollToRow={scrollTo}
        /* Default queue order on entry (owner 2026-08-07/08): arranged date
           OLDEST first, then state, then postcode, then run time. A clicked
           column header still overrides. */
        defaultSort={arrangementQueueCompare}
        emptyMessage={timeSide === 'PENDING_TIME'
          ? 'No date-confirmed orders waiting for a time — confirm dates in Delivery Date Arrangement.'
          : 'No orders on a trip yet.'}
        onRowDoubleClick={(o) => { if (o.row_type === 'so') navigate('/scm/sales-orders/' + o.so_doc_no); }}
        bulkExtras={
          <>
            {/* Depart time for the proposed sequences — the one genuine input. */}
            <input
              type="time"
              value={departTime}
              onChange={(e) => setDepartTime(e.target.value)}
              title="Depart time for the proposed runs"
              style={{ ...selStyle, width: 100 }}
            />
            <Button
              variant="primary"
              icon={<Wand2 {...ICON} />}
              disabled={proposing || selectedDocNos.length === 0}
              onClick={() => void runProposeTime()}
              title={selectedDocNos.length === 0 ? 'Select one or more sales orders first' : 'Propose the stop order per zone for each confirmed delivery date — no crew is named here'}
            >
              {proposing ? 'Proposing…' : `Propose time (${selectedDocNos.length})`}
            </Button>
            <Button
              variant="secondary"
              icon={<CalendarClock {...ICON} />}
              disabled={selectedDocNos.length === 0}
              onClick={() => setScheduling(true)}
              title={selectedDocNos.length === 0 ? 'Select one or more sales orders first' : 'Schedule the selected orders onto a trip'}
            >
              Schedule ({selectedDocNos.length})
            </Button>
          </>
        }
        contextMenu={(row) => (row.row_type === 'so'
          ? [{ label: 'Open Sales Order', onClick: () => navigate('/scm/sales-orders/' + row.so_doc_no) }]
          : [])}
      />

      {/* ── The propose-time result: anonymous per-date runs — the stop
          sequence intelligence, presented with NO lorry or crew identity. */}
      <div ref={assignRef} />
      {assign && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <strong style={{ fontSize: 'var(--fs-14)' }}>Proposed trip sequence</strong>
            <span style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
              {runs.length} trip(s)
              {!assign.configured ? ' · route off (no maps key) — zone grouping only' : ''}
              {' '}· crew is assigned in Last Mile Delivery
            </span>
          </div>

          {/* LOUD, actionable window failure (owner 2026-08-08): a proposal with
              no geocoded depot has no ETAs and no estimated delivery windows —
              name the warehouse and where to fix it, never a quiet dash. */}
          {windowGaps.length > 0 && (
            <div style={{ padding: '10px 14px', borderRadius: 10, border: '1px solid rgba(220,38,38,0.4)', background: 'rgba(220,38,38,0.06)', fontSize: 'var(--fs-12)' }}>
              <strong>No estimated delivery windows for {windowGaps.map((g) => g.date).join(', ')}.</strong>{' '}
              {windowGaps.some((g) => g.label != null)
                ? <>The depot warehouse {windowGaps.filter((g) => g.label).map((g) => `"${g.label}"`).join(', ')} could not be geocoded — fill in its address (location / city / postcode / state) in the Warehouses master, then re-propose.</>
                : <>The selected orders carry no warehouse, so there is no depot to route from — set the orders&apos; warehouse (or fix the SO lines), then re-propose.</>}
              {' '}The zone grouping and stop order below still stand; only the clock times are missing.
            </div>
          )}

          {runs.map((run) => (
            <RunCard
              key={run.key}
              run={run}
              onApply={() => void applyRun(run)}
              applyBusy={applyingRun === run.key}
              /* Trip focus (Option B): clicking the card focuses its trip on
                 the map (jumping the map to the run's date) and filters the
                 board to its stops; clicking again unfocuses. */
              focused={mapOpen && mapFocus?.routeId === run.key}
              onFocus={mapOpen ? () => {
                setMapDate(run.date);
                setMapFocus((cur) => toggleFocus(cur, { routeId: run.key, refs: run.stops.map((s) => s.ref) }));
              } : undefined}
            />
          ))}

          {(assign.overflow.length > 0 || assign.unassigned.length > 0) && (
            <div style={{ padding: '12px 16px', borderRadius: 10, border: '1px solid rgba(217,119,6,0.4)' }}>
              <h3 style={{ margin: '0 0 8px', fontSize: 'var(--fs-14)' }}>
                Beyond the day&apos;s own-fleet capacity ({assign.overflow.length + assign.unassigned.length})
              </h3>
              <p style={{ margin: '0 0 8px', fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
                These could not fit the day&apos;s runs — assign a 3PL carrier for them in Last Mile Delivery.
              </p>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
                {assign.overflow.map((o) => (
                  <li key={o.key}>
                    <strong>{o.date}</strong> · {o.group === 'KLANG_VALLEY' ? 'Klang Valley (mixed)' : o.group} · {o.orders.join(', ')} — {o.sets} sets · {fmtRm(o.revenueSen)}
                  </li>
                ))}
                {assign.unassigned.map((u, i) => (
                  <li key={u.key ?? `${i}`}><strong>{u.orders.join(', ')}</strong> — {u.reason}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* ── Run detail — only under the "Time arranged" side: the trip list is
          the run-level view of the same fact the board's TIME_ARRANGED rows
          state per order. */}
      {timeSide === 'TIME_ARRANGED' && (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,360px)_1fr]">
          {/* ── trip list ── */}
          <div className="rounded-md border border-border bg-surface">
            <div className="border-b border-border px-4 py-2.5 text-[12px] font-semibold uppercase tracking-wider text-ink-secondary">
              Trips
            </div>
            {list.isLoading && <p className="p-4 text-[13px] text-ink-muted">Loading trips…</p>}
            {!list.isLoading && trips.length === 0 && (
              <p className="p-4 text-[13px] text-ink-muted">No trips yet — sequence orders above to create them.</p>
            )}
            <ul className="divide-y divide-border">
              {trips.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setSelected(t.id);
                      setPreview(null);
                      /* Trip focus (Option B): with the map open, picking a
                         trip also focuses it — jump the map to its date, dim
                         the other routes, filter the board to its stops. */
                      if (mapOpen) {
                        const day = String(t.trip_date ?? '').slice(0, 10);
                        if (day) setMapDate(day);
                        const refs = pendingOrders
                          .filter((o) => o.row_type === 'so' && o.trip_id === t.id)
                          .map((o) => o.so_doc_no);
                        setMapFocus((cur) => toggleFocus(cur, { routeId: t.id, refs }));
                      }
                    }}
                    className={cn(
                      'flex w-full flex-col gap-1 px-4 py-3 text-left hover:bg-surface-raised',
                      selected === t.id && 'bg-surface-raised',
                    )}
                  >
                    <span className="flex items-center gap-2">
                      <span className="font-mono text-[12.5px] font-semibold text-ink">{t.trip_no}</span>
                      <Badge tone="neutral" caseless>{String(t.status).replace('_', ' ').toLowerCase()}</Badge>
                      {t.is_outsourced && <Badge tone="warning" caseless>outsourced</Badge>}
                    </span>
                    <span className="text-[12px] text-ink-secondary">
                      {t.trip_date ?? '—'}
                      {t.total_distance_km != null && ` · ${t.total_distance_km} km`}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>

          {/* ── stops + optimiser ── */}
          <div className="rounded-md border border-border bg-surface">
            {!selected && (
              <p className="p-5 text-[13px] text-ink-muted">Pick a trip to see its stops.</p>
            )}
            {selected && detail.isLoading && <p className="p-5 text-[13px] text-ink-muted">Loading stops…</p>}
            {selected && trip && (
              <>
                <div className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-3">
                  <span className="font-mono text-[13px] font-semibold">{trip.trip_no}</span>
                  <span className="text-[12px] text-ink-secondary">{trip.trip_date ?? '—'}</span>
                  <span className="flex-1" />
                  <Button
                    variant="secondary"
                    icon={<RouteIcon size={14} />}
                    onClick={() => void runOptimise(false)}
                    disabled={optimize.isPending || stops.length === 0}
                  >
                    {optimize.isPending ? 'Asking Google…' : 'Preview best route'}
                  </Button>
                  <Button
                    variant="primary"
                    icon={<MapPin size={14} />}
                    onClick={() => void runOptimise(true)}
                    disabled={optimize.isPending || stops.length === 0}
                  >
                    Apply route
                  </Button>
                </div>

                {preview && (
                  <div className="border-b border-border bg-accent/5 px-5 py-2.5 text-[12.5px] text-ink-secondary">
                    Proposed: {km(preview.totalDistanceMetres)} · {mins(preview.totalDurationSeconds)} driving
                    {!preview.applied && ' — not saved yet.'}
                  </div>
                )}

                {/* ── Live driver location (Phase 4) — only while the trip is
                    IN_PROGRESS. Polls the latest ping per driver; the marker goes
                    amber when the last fix is stale. */}
                {isLive && (
                  <div className="border-b border-border px-5 py-3">
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <span className="text-[12.5px] font-semibold text-ink">Live location</span>
                      {(() => {
                        const loc = liveLocs.data?.locations?.[0];
                        if (!loc) return <span className="text-[11.5px] text-ink-muted">No location yet — the driver&apos;s page starts tracking when they open it.</span>;
                        const secs = loc.receivedAt ? Math.round((Date.now() - Date.parse(loc.receivedAt)) / 1000) : null;
                        return (
                          <span className="text-[11.5px] text-ink-secondary">
                            Last seen {secs == null ? '—' : secs < 60 ? `${secs}s ago` : `${Math.round(secs / 60)} min ago`}
                            {secs != null && secs > 90 && ' · stale'}
                          </span>
                        );
                      })()}
                    </div>
                    {mapsKey ? (
                      <LiveTripMap apiKey={mapsKey} markers={liveMarkers} />
                    ) : (
                      <div className="flex h-[120px] items-center justify-center rounded-lg border border-dashed border-border bg-surface-dim px-4 text-center text-[12px] text-ink-muted">
                        Set VITE_GOOGLE_MAPS_API_KEY to show the live driver map. The last-seen time above still updates.
                      </div>
                    )}
                  </div>
                )}

                {stops.length === 0 ? (
                  <p className="p-5 text-[13px] text-ink-muted">This trip has no stops yet.</p>
                ) : (
                  <ul className="divide-y divide-border">
                    {stops.map((s) => (
                      <li key={s.id} className="flex items-start gap-3 px-5 py-3">
                        <span className="mt-0.5 flex h-6 w-6 flex-none items-center justify-center rounded-full bg-accent/10 text-[11px] font-bold text-accent">
                          {s.stop_no}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-2">
                            <span className="text-[13px] font-semibold text-ink">{s.customer_name ?? '—'}</span>
                            <Badge tone="neutral" caseless>{s.stop_type.replace('_', ' ').toLowerCase()}</Badge>
                          </span>
                          <span className="block text-[11.5px] text-ink-muted">{s.address ?? 'No address'}</span>
                        </span>
                        <span className="flex-none text-right text-[11.5px] text-ink-secondary">
                          {/* NULL = never optimised — shown as "—", not a fabricated zero. */}
                          <span className="block font-semibold text-ink">{etaLabel(s.eta_offset_s)}</span>
                          <span className="block">{km(s.leg_distance_m)}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
        </div>
      )}

      </div>{/* /board column */}

      {mapOpen && (
        <DeliveryMapPanel
          className="mt-4 lg:mt-0 lg:w-[40%] lg:flex-none"
          title="Delivery day map"
          onClose={() => { setMapOpen(false); setMapFocus(null); }}
          headerControls={
            <>
              {/* REQUIRED picked date — the map always shows exactly one day. */}
              <DateField
                required
                value={mapDate}
                onChange={(iso) => { if (iso) { setMapDate(iso); setMapFocus(null); } }}
                title="The day the map shows"
                style={{ ...selStyle, width: 140 }}
              />
              {pendingRegionTabs.map((r) => (
                <button
                  key={r.key}
                  type="button"
                  onClick={() => setMapRegion(r.key)}
                  className={cn(
                    'rounded-full border px-2.5 py-0.5 text-[11px]',
                    mapRegion === r.key ? 'border-accent bg-accent/10 font-semibold text-accent' : 'border-border text-ink-secondary',
                  )}
                >
                  {r.label}
                </button>
              ))}
            </>
          }
          pins={mapPins}
          routes={mapRoutes}
          depot={geo.data?.depot ? { lat: geo.data.depot.lat, lng: geo.data.depot.lng, label: geo.data.depot.name } : null}
          depotReason={geo.data?.depotReason ?? null}
          focus={mapFocus}
          onRouteClick={focusRoute}
          selectedRef={selectedPin}
          onPinClick={onPinClick}
          totals={mapTotals}
          regionKey={mapRegion}
          viewKey={`${mapDate}|${mapRegion}`}
          zoneSummary={mapZones}
          compactColumns={mapCompact}
          onCompactColumnsChange={setMapCompact}
          ungeocoded={geo.data?.ungeocoded ?? []}
          serverConfigured={geo.data?.configured ?? true}
          isLoading={geo.isLoading}
        />
      )}
      </div>{/* /split */}

      {scheduling && (
        <ScheduleTripDrawer
          orders={pendingSelectedOrders}
          onClose={() => setScheduling(false)}
          onOpenTrips={() => setScheduling(false)}
        />
      )}
    </div>
  );
}

/* One anonymous trip — the Time page's proposal unit: a date, a zone, a stop
   ORDER with estimated delivery windows. Numbered "Trip N" per date (owner
   2026-08-08) — applying stages exactly this trip identity, so Last Mile sees
   the SAME numbered trips and only labels crew onto them. Deliberately carries
   no crew or vehicle identity (owner: 排单 decides which zone and which order
   go first; who drives is Last Mile's). */
const RunCard = ({ run, onApply, applyBusy, onFocus, focused = false }: {
  run: AnonymousRun;
  onApply: () => void;
  applyBusy: boolean;
  /** Option B trip focus — clicking the card header focuses this trip on the
   *  side map + filters the board; clicking again unfocuses. Absent (map
   *  closed) the header is inert, exactly as before. */
  onFocus?: () => void;
  focused?: boolean;
}) => (
  <div style={{ borderRadius: 10, border: `1px solid ${focused ? 'rgba(37,99,235,0.55)' : 'var(--border, rgba(0,0,0,0.12))'}`, overflow: 'hidden' }}>
    <div
      onClick={onFocus}
      title={onFocus ? (focused ? 'Click to unfocus this trip on the map' : 'Click to focus this trip on the map') : undefined}
      style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '10px 14px', background: focused ? 'rgba(37,99,235,0.08)' : 'var(--bg-subtle, rgba(0,0,0,0.03))', cursor: onFocus ? 'pointer' : undefined }}>
      <strong style={{ fontSize: 'var(--fs-13)' }}>{run.date}</strong>
      <span style={{ fontSize: 'var(--fs-11)', padding: '2px 8px', borderRadius: 999, background: 'var(--bg, rgba(0,0,0,0.06))', fontWeight: 700 }}>
        Trip {run.runNo}
      </span>
      <span style={{ fontSize: 'var(--fs-11)', padding: '2px 8px', borderRadius: 999, background: 'var(--bg, rgba(0,0,0,0.06))' }}>
        {run.group === 'KLANG_VALLEY' ? 'Klang Valley (mixed)' : run.group}
      </span>
      <span style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
        {run.stops.length} stop(s) · {run.sets} sets · {fmtRm(run.revenueSen)}
      </span>
      {run.overCapacity && <MiniBadge tone="danger">Over capacity</MiniBadge>}
      {run.windowViolations > 0 && <MiniBadge tone="warn">{run.windowViolations} window issue(s)</MiniBadge>}
      <div style={{ flex: 1 }} />
      {run.returnTime != null && run.totalDistanceMetres != null && (
        <span style={{ fontSize: 'var(--fs-11)', color: 'var(--fg-muted)' }}>
          back {run.returnTime} · {Math.round(run.totalDistanceMetres / 100) / 10} km
        </span>
      )}
      {/* stopPropagation: Apply must never toggle the header's map focus. */}
      <Button variant="primary" icon={<CalendarCheck {...ICON} />} onClick={(e) => { e.stopPropagation(); onApply(); }} disabled={applyBusy}>
        {applyBusy ? 'Applying…' : 'Apply this run'}
      </Button>
    </div>

    {run.routeReason && (
      <div style={{ padding: '6px 14px', fontSize: 'var(--fs-11)', color: 'var(--fg-muted)', borderTop: '1px solid var(--border, rgba(0,0,0,0.06))' }}>
        {run.routeReason}
      </div>
    )}

    {/* Ordered stops with the ESTIMATED delivery window (Google leg ETA +
        installation time + unload buffer — owner: "就会知道下一单几点到几点")
        beside the ALLOWED residence window — the 排单 answer itself. */}
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--fs-12)' }}>
        <thead>
          <tr style={{ textAlign: 'left', color: 'var(--fg-muted)' }}>
            <Th>#</Th><Th>Order</Th><Th>Customer</Th><Th>House</Th><Th>Est. window</Th><Th>Allowed</Th>
          </tr>
        </thead>
        <tbody>
          {run.stops.map((r) => (
            <tr key={r.ref} style={{ borderTop: '1px solid var(--border, rgba(0,0,0,0.06))' }}>
              <Td>{r.order}</Td>
              <Td><strong>{r.ref}</strong></Td>
              <Td>{r.debtorName ?? '—'}</Td>
              <Td>{r.buildingType ?? '—'}</Td>
              <Td>
                <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
                  {estWindowOf(r) ?? '—'}
                </span>
              </Td>
              <Td>
                {r.earliestTime || r.latestTime ? `${r.earliestTime ?? ''}–${r.latestTime ?? ''}` : 'any'}
                {r.windowViolated && <span style={{ color: 'var(--c-warning, #b45309)' }}> !</span>}
              </Td>
            </tr>
          ))}
          {run.stops.length > 0 && run.ungeocoded.length > 0 && (
            <tr><Td>—</Td><Td colSpan={5}>Not geocoded: {run.ungeocoded.join(', ')}</Td></tr>
          )}
        </tbody>
      </table>
    </div>
  </div>
);
