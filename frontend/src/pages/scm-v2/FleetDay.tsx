// ----------------------------------------------------------------------------
// Last Mile Delivery — the office execution board, redesigned around LORRIES
// (owner handoff 2026-11-01). One card per lorry run of the day: plate, crew,
// departure, progress and its documents; plus To-arrange / All-orders / History
// tabs, a day stat strip, the filter row, the order drawer and the crew modal.
//
// PHASE 1 is frontend-only: everything derives from the two feeds we already
// have (GET /trips/day for the runs, the shared delivery-planning feed for the
// drops) folded by fleet-day/vm + fleet-day-model. Planned-departure, the
// remarks thread, change-lorry and the history feed are later phases (their UI
// here is a labelled placeholder). The page keeps the scm.transportation.last_mile
// gate (applied on the route) and the real Google-Maps panel.
// ----------------------------------------------------------------------------
import { fmtDrive, fmtKm, legLabelsByRef, useRoadDay } from '../../vendor/scm/lib/lorry-routes-queries';
import { useCallback, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Printer, Truck, Map as MapIcon, ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '../../components/Button';
import { TabStrip } from '../../components/TabStrip';
import { DateField } from '../../vendor/scm/components/DateField';
import { cn } from '../../lib/utils';
import { todayMY } from '../../vendor/shared/format';
import { useFleetDay } from '../../vendor/scm/lib/fleet-day-queries';
import { assignRouteColors, routeColorFor } from '../../vendor/scm/lib/fleet-colors';
import { DeliveryMapPanel, useMapPanelOpen } from '../../components/scm-v2/DeliveryMapPanel';
import { useDeliveryGeo } from '../../vendor/scm/lib/delivery-geo-queries';
import {
  pinsFromGeoPoints, geoTotals, zoneSummary, type MapFocus, type MapLatLng,
} from '../../vendor/scm/lib/delivery-map-model';
import { type PlanningOrder } from '../../vendor/scm/lib/delivery-planning-queries';
import { useBandedBoard, bandOfDay } from '../../vendor/scm/lib/delivery-board-bands';
import { BoardLoadStatus } from '../../vendor/scm/components/BoardLoadStatus';
import { lastMileSideOf, lastMileListSideOf, isAssignedNoTripRow, isLastMileJobRow, isEastMalaysiaOrSingaporeStop } from '../../vendor/scm/lib/last-mile';
import { regionTabsFrom } from '../../vendor/scm/components/DeliveryPlanningBoard';
import { useDrivers } from '../../vendor/scm/lib/drivers-queries';
import { useHelpers } from '../../vendor/scm/lib/helpers-queries';
import { useLorries } from '../../vendor/scm/lib/lorries-queries';
import { useDriverLeave } from '../../vendor/scm/lib/delivery-zones-queries';
import { useStaffLookup } from '../../hooks/useStaffLookup';
import { stopStatusByRef } from '../../vendor/scm/lib/delivery-stop-status';
import { mytClock } from '../../vendor/scm/lib/delivery-stop-status';
import { useJobProgressMap } from '../../vendor/scm/lib/job-progress-queries';
import { jobRefOf, jobKey } from '../../vendor/scm/lib/delivery-job';
import { useVehiclePositions } from '../../vendor/scm/lib/vehicle-positions';
import { PackingListsSection } from '../../vendor/scm/components/PackingListsSection';
import { dayStatsFrom } from '../../vendor/scm/lib/fleet-day-cards';
import {
  docRowVM, buildLorryCards, buildLorryRoutes, applyFilters, filtersActive, EMPTY_FILTERS, clockMY, platekey,
  type FleetFilters, type DocRowVM, type LorryRunVM,
} from './fleet-day/vm';
import { FleetDayStats } from './fleet-day/Stats';
import { FleetDayFilterRow } from './fleet-day/FilterRow';
import { LorryCard } from './fleet-day/LorryCard';
import { OrderDrawer } from './fleet-day/OrderDrawer';
import { CrewModal } from './fleet-day/CrewModal';
import { ToArrangeTab } from './fleet-day/ToArrange';
import { AllOrdersTab, type AllOrderRow } from './fleet-day/AllOrders';
import { HistoryTab } from './fleet-day/History';
import { useRemarkFlags } from '../../vendor/scm/lib/delivery-remarks-queries';

type Tab = 'lorries' | 'arrange' | 'all' | 'history';

/** date (YYYY-MM-DD) shifted by whole days, Malaysian calendar. */
function shiftDate(date: string, delta: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

export function FleetDay() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const date = params.get('date') || todayMY();
  const tab = (params.get('tab') as Tab | null) || 'lorries';
  const focusedPlate = params.get('lorry') || null;
  const warehouseId = params.get('warehouseId') || '';

  const setParam = (key: string, value: string | null) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value) next.set(key, value); else next.delete(key);
      return next;
    }, { replace: true });
  };

  const [filters, setFilters] = useState<FleetFilters>(EMPTY_FILTERS);
  const [selected, setSelected] = useState<DocRowVM | null>(null);
  const [crewRun, setCrewRun] = useState<LorryRunVM | null>(null);
  const [mapOpen, setMapOpen] = useMapPanelOpen('last-mile');

  // ── Feeds ────────────────────────────────────────────────────────────────
  const query = useFleetDay({ date, warehouseId: warehouseId || null });
  const trips = useMemo(() => query.data?.trips ?? [], [query.data]);
  // The board in date bands: the band holding this day first, the rest after (delivery-board-bands.ts).
  const board = useBandedBoard({ state: 'ALL', first: bandOfDay(date, todayMY()) });
  const boardOrders = useMemo<PlanningOrder[]>(
    () => board.orders.filter(
      (o) => !isEastMalaysiaOrSingaporeStop({ region: o.region, state: o.customer_state, country: o.customer_country }),
    ),
    [board.orders],
  );
  const { data: drivers = [] } = useDrivers();
  const { data: helpers = [] } = useHelpers();
  const { data: lorries = [] } = useLorries();
  const leave = useDriverLeave();
  const staff = useStaffLookup();
  const progressMap = useJobProgressMap(true);
  const remarkFlags = useRemarkFlags();
  const remarkKeys = useMemo(() => new Set((remarkFlags.data ?? []).map((f) => f.soDocNo)), [remarkFlags.data]);

  // ── Derivation ─────────────────────────────────────────────────────────
  const clock = useMemo(() => ({ day: date, ...mytClock(new Date()) }), [date]);
  const dayRows = useMemo(() => boardOrders.filter((o) => lastMileSideOf(o, date) != null), [boardOrders, date]);
  // Orders DUE this day that already have a lorry assigned (crew.lorry_plate) but
  // no live trip yet — the dispatcher assigned the lorry on the DP board before a
  // run was opened (owner 2026-11-01). They belong UNDER that lorry's card, not
  // in the To-arrange bucket, so the board shows the day's plan per lorry even
  // before trips/DOs exist. (lastMileSideOf stays trip-only for map focus + crew.)
  const assignedRows = useMemo(
    () => boardOrders.filter((o) => isAssignedNoTripRow(o, date)),
    [boardOrders, date],
  );
  // The lorry's NON-SO jobs of the day — ASSR service legs and the DP / PMS
  // setup / dismantle / supplier-pickup / transfer / service work the same run
  // carries (owner 2026-11-02). They ride the shared feed with the lorry already
  // on them; buildLorryCards groups them under their lorry just like an SO drop.
  const jobRows = useMemo(() => boardOrders.filter((o) => isLastMileJobRow(o, date)), [boardOrders, date]);
  const lorryRows = useMemo(() => [...dayRows, ...assignedRows, ...jobRows], [dayRows, assignedRows, jobRows]);
  const statusByRef = useMemo(() => stopStatusByRef(
    lorryRows,
    (o) => { const j = jobRefOf(o); return j ? progressMap.get(jobKey(j)) ?? null : null; },
    date, new Date(),
  ), [lorryRows, progressMap, date]);
  const dayDocs = useMemo(
    () => lorryRows.map((o) => { const j = jobRefOf(o); return docRowVM(o, statusByRef.get(o.so_doc_no) ?? 'scheduled', clock, j ? progressMap.get(jobKey(j)) ?? null : null); }),
    [lorryRows, statusByRef, clock, progressMap],
  );
  const driversById = useMemo(() => new Map(drivers.map((d) => [d.id, d])), [drivers]);
  const colors = useMemo(() => assignRouteColors(trips.map((t) => t.id)), [trips]);
  const runs = useMemo(
    () => buildLorryCards(trips, dayDocs, lorries, driversById, (id) => routeColorFor(colors, id)),
    [trips, dayDocs, lorries, driversById, colors],
  );
  const runByTripId = useMemo(() => {
    const m = new Map<string, LorryRunVM>();
    for (const r of runs) if (r.trip) m.set(r.trip.id, r);
    return m;
  }, [runs]);
  const runByPlate = useMemo(() => {
    const m = new Map<string, LorryRunVM>();
    for (const r of runs) m.set(platekey(r.plate), r);
    return m;
  }, [runs]);
  /** The card a drop belongs to — its trip's card, else its crew plate's card. */
  const runForDoc = useCallback((d: DocRowVM): LorryRunVM | null => {
    if (d.order.trip_id) { const r = runByTripId.get(d.order.trip_id); if (r) return r; }
    const p = d.order.crew?.lorry_plate;
    return p ? runByPlate.get(platekey(p)) ?? null : null;
  }, [runByTripId, runByPlate]);
  // To arrange = due this day, no trip AND no lorry assigned yet. Once a lorry is
  // assigned (even before a run), the order moves onto that lorry's card above.
  const toArrangeOrders = useMemo(
    () => boardOrders.filter((o) => lastMileListSideOf(o, date) === 'TO_ARRANGE' && !isAssignedNoTripRow(o, date)),
    [boardOrders, date],
  );

  // "Lorries" counts the lorries actually working today (>=1 drop); the pinned
  // empty in-house cards still render but are not counted as out.
  const stats = useMemo(() => dayStatsFrom(runs.filter((r) => r.rollup.drops > 0).map((r) => r.rollup)), [runs]);
  const lateCount = useMemo(() => dayDocs.filter((d) => d.late).length, [dayDocs]);
  const active = filtersActive(filters);

  const filteredDocs = useMemo(() => applyFilters(dayDocs, filters), [dayDocs, filters]);
  const filteredByCard = useMemo(() => {
    const m = new Map<string, DocRowVM[]>();
    for (const d of filteredDocs) {
      const r = runForDoc(d); if (!r) continue;
      const k = platekey(r.plate);
      (m.get(k) ?? m.set(k, []).get(k)!).push(d);
    }
    return m;
  }, [filteredDocs, runForDoc]);
  const visibleRuns = useMemo(
    () => (active ? runs.filter((r) => (filteredByCard.get(platekey(r.plate))?.length ?? 0) > 0) : runs),
    [runs, active, filteredByCard],
  );
  const allOrderRows = useMemo<AllOrderRow[]>(() => {
    const rows: AllOrderRow[] = [];
    for (const d of filteredDocs) {
      const r = runForDoc(d);
      if (r) rows.push({ doc: d, run: r });
    }
    rows.sort((a, b) => a.run.plate.localeCompare(b.run.plate) || (a.doc.stopNo ?? 1e9) - (b.doc.stopNo ?? 1e9));
    return rows;
  }, [filteredDocs, runForDoc]);

  const regionTabs = useMemo(
    () => regionTabsFrom(board.regions).filter((t) => t.key !== 'EM').map((t) => ({ key: t.key, label: t.label })),
    [board.regions],
  );
  const salespeople = useMemo(() => {
    const m = new Map<string, string>();
    for (const d of dayDocs) if (d.salespersonId) m.set(d.salespersonId, staff.nameOf(d.agent, d.salespersonId));
    return [...m].map(([id, label]) => ({ id, label })).sort((a, b) => a.label.localeCompare(b.label));
  }, [dayDocs, staff]);

  const selectedRun = selected ? runForDoc(selected) : null;

  // ── Map wiring (reuses the shared Google-Maps panel) ───────────────────────
  const geo = useDeliveryGeo({ date, region: filters.region, enabled: mapOpen });
  const geoPoints = useMemo(
    () => (geo.data?.points ?? []).filter((p) => !isEastMalaysiaOrSingaporeStop({ region: p.region, state: p.state, country: p.country })),
    [geo.data?.points],
  );
  const mapPins = useMemo(() => pinsFromGeoPoints(geoPoints), [geoPoints]);
  const mapTotals = useMemo(() => geoTotals(geoPoints), [geoPoints]);
  const mapZones = useMemo(() => zoneSummary(geoPoints, regionTabs, filters.region), [geoPoints, regionTabs, filters.region]);
  const pointByRef = useMemo(() => {
    const m = new Map<string, MapLatLng>();
    for (const p of geoPoints) m.set(p.ref, { lat: p.lat, lng: p.lng });
    return m;
  }, [geoPoints]);
  const depotLL = useMemo<MapLatLng | null>(
    () => (geo.data?.depot ? { lat: geo.data.depot.lat, lng: geo.data.depot.lng } : null),
    [geo.data?.depot],
  );
  // One stable colour per lorry: a trip-backed lorry keeps its card's trip colour
  // (card, map and legend agree); a lorry assigned drops but no trip yet gets its
  // own palette colour so its route still reads as distinct (its card shows grey).
  const lorryColors = useMemo(() => assignRouteColors(runs.map((r) => platekey(r.plate))), [runs]);
  const colorForPlate = useCallback((k: string): string => {
    const run = runByPlate.get(k);
    return run?.trip ? run.color : routeColorFor(lorryColors, k);
  }, [runByPlate, lorryColors]);
  // Per-LORRY numbered routes (owner 2026-11-04): the office board shows each
  // lorry's run as its own numbered, coloured route — not the per-trip dots — and
  // surfaces every drop it could not locate instead of silently dropping it.
  const lorryRoutes = useMemo(
    () => buildLorryRoutes(runs, pointByRef, depotLL, (k) => { const h = geo.data?.lorryDepots?.[k.replace(/[^A-Z0-9]/g, "")]; return h ? { lat: h.lat, lng: h.lng } : null; }, colorForPlate),
    [runs, pointByRef, depotLL, geo.data?.lorryDepots, colorForPlate],
  );
  /* Each lorry's run by road, from its home and back (owner 2026-11-08), worked out on
     the server for the whole day; the board's region filter does not change it. */
  const roadDay = useRoadDay(date);
  const roadLabelOf = (plate: string): string | null => {
    const id = runByPlate.get(platekey(plate))?.lorryId;
    const f = id ? roadDay.data?.get(id) : undefined;
    return f ? `${fmtKm(f.distanceM)} · ${fmtDrive(f.durationS)}` : null;
  };
  const roadTotal = (() => {
    const figs = [...(roadDay.data?.values() ?? [])];
    return figs.length ? `All lorries, Google: ${fmtKm(figs.reduce((a, f) => a + f.distanceM, 0))} · ${fmtDrive(figs.reduce((a, f) => a + f.durationS, 0))}` : null;
  })();
  const legByRef = useMemo(() => legLabelsByRef(roadDay.data?.values() ?? []), [roadDay.data]);
  const mapNoByRef = useMemo(() => new Map(lorryRoutes.routes.flatMap((r) => r.stops.map((st) => [st.ref, st.order] as const))), [lorryRoutes.routes]);
  const panelRoutes = lorryRoutes.routes.map((r) => ({ ...r, roadLabel: roadLabelOf(r.title) }));
  // The board's own drops that could not be placed (surfaced, never dropped),
  // then any server-ungeocoded order not already named.
  const mapUnlocated = useMemo(() => {
    const seen = new Set<string>();
    const out: Array<{ ref: string; label?: string; reason: string }> = [];
    for (const u of lorryRoutes.unlocated) {
      if (seen.has(u.ref)) continue;
      seen.add(u.ref);
      out.push({ ref: u.ref, label: u.label, reason: u.reason });
    }
    for (const u of geo.data?.ungeocoded ?? []) {
      if (seen.has(u.ref)) continue;
      seen.add(u.ref);
      out.push({ ref: u.ref, reason: u.reason });
    }
    return out;
  }, [lorryRoutes.unlocated, geo.data?.ungeocoded]);
  // A lorry focus (the owner's by-lorry filter): the map isolates that lorry's
  // route and the board highlights its card; click it again to clear.
  const mapFocus = useMemo<MapFocus | null>(() => {
    if (!focusedPlate) return null;
    const run = runByPlate.get(focusedPlate);
    if (!run) return null;
    return { routeId: focusedPlate, refs: run.docs.map((d) => d.soDocNo) };
  }, [focusedPlate, runByPlate]);
  const vehicles = useVehiclePositions(trips, mapOpen);
  const toggleFocus = (routeId: string) => setParam('lorry', focusedPlate === routeId ? null : routeId);

  const goPrint = (tripId?: string) => {
    const p = new URLSearchParams();
    p.set('date', date);
    if (warehouseId) p.set('warehouseId', warehouseId);
    const t = tripId ?? (focusedPlate ? runByPlate.get(focusedPlate)?.trip?.id ?? null : null);
    if (t) p.set('trip', t);
    navigate(`/scm/fleet-run-sheet?${p.toString()}`);
  };

  const refetchAll = () => { void board.refetch(); void query.refetch(); };
  // Malaysian wall-clock for the "Live · h:mm AM/PM" header, via the shared pure
  // formatter (no locale date API — keeps audit:date-format clean).
  const liveTime = clockMY(new Date().toISOString()) ?? '';

  // Own fleet (in-house, always pinned) above outsourced (shown only on a day it
  // carries drops — owner rule 2026-11-01).
  const inHouseRuns = visibleRuns.filter((r) => r.isInternal);
  const outsourcedRuns = visibleRuns.filter((r) => !r.isInternal);
  const renderCard = (r: LorryRunVM) => (
    <LorryCard
      key={r.trip?.id ?? `lorry:${platekey(r.plate)}`}
      run={r}
      visibleDocs={active ? (filteredByCard.get(platekey(r.plate)) ?? []) : r.docs}
      filtersActive={active}
      searchActive={filters.query.trim().length >= 2}
      actionable={!!r.trip}
      focused={focusedPlate === platekey(r.plate)}
      selectedKey={selected?.key ?? null}
      remarkKeys={remarkKeys}
      road={roadLabelOf(r.plate)}
      legByRef={legByRef}
      mapNoByRef={mapNoByRef}
      onFocus={() => toggleFocus(platekey(r.plate))}
      onOpenDoc={(d) => setSelected(d)}
      onCrew={() => setCrewRun(r)}
      onRunSheet={() => { if (r.trip) goPrint(r.trip.id); }}
      onQr={() => { if (r.trip) goPrint(r.trip.id); }}
    />
  );

  const lorriesView = (
    <div className="lg:flex lg:items-start lg:gap-4">
      <div className="min-w-0 space-y-4 lg:flex-1">
        <div className="flex items-center justify-between">
          <span className="text-[11.5px] text-ink-muted">{visibleRuns.filter((r) => r.rollup.drops > 0).length} lorries out today</span>
          {!mapOpen && <Button variant="ghost" icon={<MapIcon size={14} strokeWidth={1.75} />} onClick={() => setMapOpen(true)}>Show map</Button>}
        </div>
        {query.isLoading ? (
          <p className="p-4 text-[13px] text-ink-muted">Loading the day…</p>
        ) : (
          <div className="space-y-5">
            <section className="space-y-2.5">
              <h2 className="font-mono text-[11px] font-semibold uppercase tracking-brand text-ink-muted">Own fleet</h2>
              {inHouseRuns.length === 0 ? (
                <p className="rounded-md border border-border bg-surface p-4 text-[12.5px] text-ink-muted">No own-fleet lorry matches the current filters.</p>
              ) : (
                <div className="grid grid-cols-1 gap-3.5 2xl:grid-cols-2">{inHouseRuns.map(renderCard)}</div>
              )}
            </section>
            <section className="space-y-2.5">
              <h2 className="font-mono text-[11px] font-semibold uppercase tracking-brand text-ink-muted">Outsourced</h2>
              {outsourcedRuns.length === 0 ? (
                <p className="rounded-md border border-dashed border-border bg-surface p-4 text-center text-[12.5px] text-ink-muted">
                  {runs.some((r) => !r.isInternal) ? 'No outsourced lorry matches the current filters.' : 'No outsourced lorries today.'}
                </p>
              ) : (
                <div className="grid grid-cols-1 gap-3.5 2xl:grid-cols-2">{outsourcedRuns.map(renderCard)}</div>
              )}
            </section>
          </div>
        )}
        <PackingListsSection date={date} warehouseId={warehouseId || null} />
      </div>

      {mapOpen && (
        <div className="mt-4 lg:mt-0 lg:w-[40%] lg:flex-none">
        <DeliveryMapPanel
          className=""
          title="Day map"
          onClose={() => setMapOpen(false)}
          pins={mapPins}
          routes={panelRoutes}
          depot={geo.data?.depot ? { lat: geo.data.depot.lat, lng: geo.data.depot.lng, label: geo.data.depot.name } : null}
          depotReason={geo.data?.depotReason ?? null}
          focus={mapFocus}
          onRouteClick={toggleFocus}
          selectedRef={selected?.soDocNo ?? null}
          onPinClick={(ref) => { const d = dayDocs.find((x) => x.soDocNo === ref); if (d) setSelected(d); }}
          totals={mapTotals}
          regionKey={filters.region}
          viewKey={`${date}|${filters.region}`}
          zoneSummary={mapZones}
          ungeocoded={mapUnlocated}
          serverConfigured={geo.data?.configured ?? true}
          isLoading={geo.isLoading || query.isLoading}
          statusByRef={statusByRef}
          routeStopRings
          vehicles={vehicles}
          onVehicleClick={(v) => { if (v.lorryId) navigate(`/fleet-health/${v.lorryId}`); }}
        />
        {roadTotal && <p className="mt-2 text-right text-[12.5px] font-semibold text-ink-secondary">{roadTotal}</p>}
        </div>
      )}
    </div>
  );

  return (
    <div className="space-y-4">
      {/* Header — one row (design handoff v2, Layout A): title left; live clock,
          day stepper and Print on the right. */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2 font-mono text-[11px] font-semibold uppercase tracking-brand text-accent">
            <span className="h-px w-[22px] bg-accent" />Delivery
          </div>
          <h1 className="text-[26px] font-bold leading-tight tracking-tight text-ink">Last Mile Delivery</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="flex items-center gap-1.5 text-[12px] text-ink-secondary">
            <span className="h-[7px] w-[7px] rounded-full bg-synced" /> Live · {liveTime}
          </span>
          <div className="flex items-center overflow-hidden rounded-lg border border-border bg-surface">
            <button type="button" aria-label="Previous day" onClick={() => { setParam('date', shiftDate(date, -1)); }} className="px-2 py-1.5 text-ink-secondary hover:bg-surface-2"><ChevronLeft size={16} /></button>
            <DateField value={date} onChange={(iso) => setParam('date', iso || null)} className="border-0 bg-transparent px-1 py-1 text-center text-[12.5px] font-semibold text-ink" />
            <button type="button" aria-label="Next day" onClick={() => { setParam('date', shiftDate(date, 1)); }} className="px-2 py-1.5 text-ink-secondary hover:bg-surface-2"><ChevronRight size={16} /></button>
          </div>
          <Button variant="secondary" icon={<Printer size={14} />} onClick={() => goPrint()} disabled={trips.length === 0}>
            Print all run-sheets
          </Button>
        </div>
      </div>

      <FleetDayStats stats={stats} />

      <TabStrip<Tab>
        value={tab}
        onChange={(v) => setParam('tab', v === 'lorries' ? null : v)}
        options={[
          { value: 'lorries', label: 'Lorries', count: runs.length },
          { value: 'arrange', label: 'To arrange', count: toArrangeOrders.length },
          { value: 'all', label: 'All orders', count: dayDocs.length },
          { value: 'history', label: 'History' },
        ]}
      />

      {tab !== 'history' && (
        <FleetDayFilterRow
          filters={filters}
          onChange={setFilters}
          regionTabs={regionTabs}
          salespeople={salespeople}
          lateCount={lateCount}
        />
      )}

      <BoardLoadStatus updatedAt={board.updatedAt} bands={board} />
      {board.failed && board.parts.length === 0 && (
        <p className="rounded-md border border-err/40 bg-err-bg p-4 text-[13px] text-err">
          Could not load the day's orders. {board.failed.error instanceof Error ? board.failed.error.message : ''}
        </p>
      )}

      {tab === 'lorries' && lorriesView}
      {tab === 'arrange' && (
        <ToArrangeTab
          orders={toArrangeOrders}
          date={date}
          drivers={drivers}
          helpers={helpers}
          lorries={lorries}
          salespersonOf={(o) => staff.nameOf(o.agent, o.salesperson_id)}
          onAssigned={refetchAll}
        />
      )}
      {tab === 'all' && <AllOrdersTab rows={allOrderRows} onOpen={(d) => setSelected(d)} />}
      {tab === 'history' && <HistoryTab />}

      <p className="flex items-center gap-1.5 text-[11px] text-ink-muted">
        <Truck size={12} strokeWidth={1.75} />
        Crew and arrange actions write through the same schedule path as the rest of the delivery pipeline.
      </p>

      <OrderDrawer
        doc={selected}
        run={selectedRun}
        runs={runs}
        salespersonName={selected ? staff.nameOf(selected.agent, selected.salespersonId) : '—'}
        onClose={() => setSelected(null)}
      />
      <CrewModal
        run={crewRun}
        trips={trips}
        drivers={drivers}
        helpers={helpers}
        lorries={lorries}
        leave={leave.data}
        date={date}
        onClose={() => setCrewRun(null)}
        onApplied={refetchAll}
      />
    </div>
  );
}
