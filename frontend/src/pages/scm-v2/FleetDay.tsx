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
import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Printer, Truck, Map as MapIcon, ChevronLeft, ChevronRight } from 'lucide-react';
import { PageHeader } from '../../components/Layout';
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
  pinsFromGeoPoints, geoTotals, zoneSummary, stagedRoutesFromRows, type MapFocus, type MapLatLng,
} from '../../vendor/scm/lib/delivery-map-model';
import { useDeliveryPlanning, type PlanningOrder } from '../../vendor/scm/lib/delivery-planning-queries';
import { lastMileSideOf, lastMileListSideOf, isEastMalaysiaOrSingaporeStop } from '../../vendor/scm/lib/last-mile';
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
  docRowVM, buildRuns, applyFilters, filtersActive, EMPTY_FILTERS, clockMY,
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
  const focusedId = params.get('trip') || null;
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
  const board = useDeliveryPlanning({ region: 'ALL', state: 'ALL' });
  const boardOrders = useMemo<PlanningOrder[]>(
    () => (board.data?.orders ?? []).filter(
      (o) => !isEastMalaysiaOrSingaporeStop({ region: o.region, state: o.customer_state, country: o.customer_country }),
    ),
    [board.data],
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
  const statusByRef = useMemo(() => stopStatusByRef(
    dayRows,
    (o) => { const j = jobRefOf(o); return j ? progressMap.get(jobKey(j)) ?? null : null; },
    date, new Date(),
  ), [dayRows, progressMap, date]);
  const dayDocs = useMemo(
    () => dayRows.map((o) => docRowVM(o, statusByRef.get(o.so_doc_no) ?? 'scheduled', clock)),
    [dayRows, statusByRef, clock],
  );
  const driversById = useMemo(() => new Map(drivers.map((d) => [d.id, d])), [drivers]);
  const colors = useMemo(() => assignRouteColors(trips.map((t) => t.id)), [trips]);
  const runs = useMemo(
    () => buildRuns(trips, dayDocs, driversById, (id) => routeColorFor(colors, id)),
    [trips, dayDocs, driversById, colors],
  );
  const runByTripId = useMemo(() => new Map(runs.map((r) => [r.trip.id, r])), [runs]);
  const toArrangeOrders = useMemo(
    () => boardOrders.filter((o) => lastMileListSideOf(o, date) === 'TO_ARRANGE'),
    [boardOrders, date],
  );

  const stats = useMemo(() => dayStatsFrom(runs.map((r) => r.rollup)), [runs]);
  const lateCount = useMemo(() => dayDocs.filter((d) => d.late).length, [dayDocs]);
  const active = filtersActive(filters);

  const filteredDocs = useMemo(() => applyFilters(dayDocs, filters), [dayDocs, filters]);
  const filteredByTrip = useMemo(() => {
    const m = new Map<string, DocRowVM[]>();
    for (const d of filteredDocs) { const t = d.order.trip_id; if (!t) continue; (m.get(t) ?? m.set(t, []).get(t)!).push(d); }
    return m;
  }, [filteredDocs]);
  const visibleRuns = useMemo(
    () => (active ? runs.filter((r) => (filteredByTrip.get(r.trip.id)?.length ?? 0) > 0) : runs),
    [runs, active, filteredByTrip],
  );
  const allOrderRows = useMemo<AllOrderRow[]>(() => {
    const rows: AllOrderRow[] = [];
    for (const d of filteredDocs) {
      const r = d.order.trip_id ? runByTripId.get(d.order.trip_id) : null;
      if (r) rows.push({ doc: d, run: r });
    }
    rows.sort((a, b) => a.run.plate.localeCompare(b.run.plate) || (a.doc.stopNo ?? 1e9) - (b.doc.stopNo ?? 1e9));
    return rows;
  }, [filteredDocs, runByTripId]);

  const regionTabs = useMemo(
    () => regionTabsFrom(board.data?.regions).filter((t) => t.key !== 'EM').map((t) => ({ key: t.key, label: t.label })),
    [board.data?.regions],
  );
  const salespeople = useMemo(() => {
    const m = new Map<string, string>();
    for (const d of dayDocs) if (d.salespersonId) m.set(d.salespersonId, staff.nameOf(d.agent, d.salespersonId));
    return [...m].map(([id, label]) => ({ id, label })).sort((a, b) => a.label.localeCompare(b.label));
  }, [dayDocs, staff]);

  const selectedRun = selected?.order.trip_id ? runByTripId.get(selected.order.trip_id) ?? null : null;

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
  const panelRoutes = useMemo(() => {
    const depotLL = geo.data?.depot ? { lat: geo.data.depot.lat, lng: geo.data.depot.lng } : null;
    const staged = stagedRoutesFromRows(boardOrders, date, pointByRef, depotLL);
    return staged.map((r) => {
      const run = runByTripId.get(r.id);
      const crew = run ? [run.plate, run.driverName].filter(Boolean).join(' · ') : null;
      return { ...r, color: routeColorFor(colors, r.id), crewLabel: crew || null };
    });
  }, [boardOrders, date, pointByRef, runByTripId, colors, geo.data?.depot]);
  const mapFocus = useMemo<MapFocus | null>(() => {
    if (!focusedId) return null;
    const refs = boardOrders
      .filter((o) => o.row_type === 'so' && o.trip_id === focusedId && lastMileSideOf(o, date) != null)
      .map((o) => o.so_doc_no);
    return { routeId: focusedId, refs };
  }, [focusedId, boardOrders, date]);
  const vehicles = useVehiclePositions(trips, mapOpen);
  const toggleFocus = (routeId: string) => setParam('trip', focusedId === routeId ? null : routeId);

  const goPrint = (tripId?: string) => {
    const p = new URLSearchParams();
    p.set('date', date);
    if (warehouseId) p.set('warehouseId', warehouseId);
    const t = tripId ?? focusedId;
    if (t) p.set('trip', t);
    navigate(`/scm/fleet-run-sheet?${p.toString()}`);
  };

  const refetchAll = () => { void board.refetch(); void query.refetch(); };
  // Malaysian wall-clock for the "Live · h:mm AM/PM" header, via the shared pure
  // formatter (no locale date API — keeps audit:date-format clean).
  const liveTime = clockMY(new Date().toISOString()) ?? '';

  const lorriesView = (
    <div className="lg:flex lg:items-start lg:gap-4">
      <div className="min-w-0 space-y-4 lg:flex-1">
        <div className="flex items-center justify-between">
          <span className="text-[11.5px] text-ink-muted">{visibleRuns.length} of {runs.length} lorries shown</span>
          {!mapOpen && <Button variant="ghost" icon={<MapIcon size={14} strokeWidth={1.75} />} onClick={() => setMapOpen(true)}>Show map</Button>}
        </div>
        {query.isLoading ? (
          <p className="p-4 text-[13px] text-ink-muted">Loading the day…</p>
        ) : visibleRuns.length === 0 ? (
          <p className="rounded-md border border-border bg-surface p-6 text-center text-[12.5px] text-ink-muted">
            {runs.length === 0 ? 'No lorry runs on this day yet — arrange orders onto a lorry in the To arrange tab.' : 'No lorries match the current filters.'}
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-3.5 2xl:grid-cols-2">
            {visibleRuns.map((r) => (
              <LorryCard
                key={r.trip.id}
                run={r}
                visibleDocs={active ? (filteredByTrip.get(r.trip.id) ?? []) : r.docs}
                filtersActive={active}
                searchActive={filters.query.trim().length >= 2}
                focused={focusedId === r.trip.id}
                selectedKey={selected?.key ?? null}
                remarkKeys={remarkKeys}
                onFocus={() => toggleFocus(r.trip.id)}
                onOpenDoc={(d) => setSelected(d)}
                onCrew={() => setCrewRun(r)}
                onRunSheet={() => goPrint(r.trip.id)}
                onQr={() => goPrint(r.trip.id)}
              />
            ))}
          </div>
        )}
        <PackingListsSection date={date} warehouseId={warehouseId || null} />
      </div>

      {mapOpen && (
        <DeliveryMapPanel
          className="mt-4 lg:mt-0 lg:w-[40%] lg:flex-none"
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
          ungeocoded={geo.data?.ungeocoded ?? []}
          serverConfigured={geo.data?.configured ?? true}
          isLoading={geo.isLoading || query.isLoading}
          statusByRef={statusByRef}
          vehicles={vehicles}
          onVehicleClick={(v) => { if (v.lorryId) navigate(`/fleet-health/${v.lorryId}`); }}
        />
      )}
    </div>
  );

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Delivery"
        title="Last Mile Delivery"
        description="Every lorry run of the day — crew, departure, progress and documents — with search, the order drawer and the day map."
        primaryAction={
          <Button variant="secondary" icon={<Printer size={14} />} onClick={() => goPrint()} disabled={trips.length === 0}>
            Print all run-sheets
          </Button>
        }
      />

      {/* date stepper + live */}
      <div className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-surface px-4 py-2.5">
        <div className="flex items-center gap-1">
          <button type="button" aria-label="Previous day" onClick={() => { setParam('date', shiftDate(date, -1)); }} className="rounded-md border border-border p-1.5 text-ink-secondary hover:bg-surface-2"><ChevronLeft size={16} /></button>
          <DateField value={date} onChange={(iso) => setParam('date', iso || null)} className="rounded-md border border-border bg-surface px-2 py-1 text-[12.5px] text-ink" />
          <button type="button" aria-label="Next day" onClick={() => { setParam('date', shiftDate(date, 1)); }} className="rounded-md border border-border p-1.5 text-ink-secondary hover:bg-surface-2"><ChevronRight size={16} /></button>
        </div>
        <span className="flex-1" />
        <span className="flex items-center gap-1.5 text-[12px] text-ink-secondary">
          <span className="h-1.5 w-1.5 rounded-full bg-synced" /> Live · {liveTime}
        </span>
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

      {board.error && (
        <p className="rounded-md border border-err/40 bg-err-bg p-4 text-[13px] text-err">
          Could not load the day's orders. {board.error instanceof Error ? board.error.message : ''}
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
