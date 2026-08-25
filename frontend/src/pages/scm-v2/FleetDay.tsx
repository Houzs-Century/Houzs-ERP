// ----------------------------------------------------------------------------
// Last Mile Delivery — stage 4 (EXECUTION) of the delivery pipeline (Planning
// -> Date -> Time -> Last Mile). Owner's FINAL division (2026-08-08): this
// page owns the INTELLIGENT driver + lorry assignment — "我只需要帮它标上去是
// 什么罗里、什么 Driver、什么 Helper". The Time page sequences (排单); Last
// Mile labels the crew onto the SAME numbered trips.
//
// Time-arranged orders flow in automatically: the board rows are simply the SO
// rows whose live trip sits on the picked date (the server stamps trip_id /
// trip_no / trip_date on every row; lib/last-mile.ts folds the split — see its
// header). Same page skeleton as the rest of the family: PageHeader -> split
// chips (All / Time arranged / Delivered, counts for the day) -> region chips
// -> the shared DeliveryPlanningBoard (inline Driver / Lorry cells stay as the
// manual path).
//
// "Propose crew" — the day's crew intelligence, on the day's EXISTING trips:
// ONE sequence-assign call over the day's time-arranged orders (leave-aware
// crewing, fleet-status exclusions, 3PL overflow — the A2/A3 engine, zero
// backend change) whose per-run crew picks are re-attached to the real trips
// by stop overlap (lib/last-mile.ts matchCrewSuggestions — crew is only ever
// suggested for a run that exists). Each trip card carries editable Lorry +
// Driver 1/2 + Helper 1/2 (owner: "Helper 可以是两个也可以是一个;我也可以选择
// 两个 Driver 出去"); Apply writes through TWO long-standing endpoints — PATCH
// /trips/:id (the trip row: map crew line, run-sheet, row scope) and PUT
// /delivery-orders-mfg/:id/crew per DO (the delivery_order_crew snapshot the
// board displays, and the ONLY store with a driver-2 seat, which is why no
// migration accompanies the two-driver rule — see useAssignDoCrew's header).
//
// The day MAP is the RIGHT PANEL of the Option B split (owner 2026-08-08):
// board left, sticky map right — every trip that day as a coloured polyline
// with numbered stops + crew labels (plate/driver), one pin per order, the
// depot, and the trip/crew cards UNDER the map (the old lorry side panel
// merged into them — colour dot, plate, crew line, drops/revenue, per-trip
// run-sheet link). Closing the map returns the board to full width with the
// crew cards below it. Trip focus: clicking a trip card or its polyline dims
// the others, zooms to it, and filters the board to its stops. The map data
// rides the shared /delivery-planning/geo read + the server-stamped trip
// columns (lib/delivery-map-model.ts); GET /trips/day still feeds the trip
// cards + run-sheet.
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Printer, Truck, Users, Wand2, CalendarCheck, Map as MapIcon } from 'lucide-react';
import { PageHeader } from '../../components/Layout';
import { Button } from '../../components/Button';
import { Badge } from '../../components/Badge';
import { cn } from '../../lib/utils';
import { fmtSen, todayMY } from '../../vendor/shared/format';
import { useFleetDay, type FleetDayTrip } from '../../vendor/scm/lib/fleet-day-queries';
import { assignRouteColors, routeColorFor } from '../../vendor/scm/lib/fleet-colors';
import { DeliveryMapPanel, useMapPanelOpen, useMapCompactColumns } from '../../components/scm-v2/DeliveryMapPanel';
import { useDeliveryGeo } from '../../vendor/scm/lib/delivery-geo-queries';
import {
  pinsFromGeoPoints,
  geoTotals,
  zoneSummary,
  stagedRoutesFromRows,
  focusFilterRows,
  MAP_ESSENTIAL_COLUMNS_LAST_MILE,
  type MapFocus,
  type MapLatLng,
} from '../../vendor/scm/lib/delivery-map-model';
import {
  useDeliveryPlanning,
  useScheduleDelivery,
  useAssignDoCrew,
  type PlanningOrder,
} from '../../vendor/scm/lib/delivery-planning-queries';
import {
  lastMileSideOf,
  proposeCrewDocNos,
  matchCrewSuggestions,
  LAST_MILE_SIDE_LABEL,
  type LastMileSide,
  type CrewSuggestion,
} from '../../vendor/scm/lib/last-mile';
import {
  useSequenceAssign,
  type SequenceAssignResponse,
  type OverflowGroup,
} from '../../vendor/scm/lib/delivery-zones-queries';
import { pinAssignToDate, depotForDocNos } from '../../vendor/scm/lib/propose-time';
import {
  DeliveryPlanningBoard,
  regionTabsFrom,
} from '../../vendor/scm/components/DeliveryPlanningBoard';
import { arrangementQueueCompare } from '../../vendor/scm/lib/arrangement-sort';
import { useDrivers } from '../../vendor/scm/lib/drivers-queries';
import { useHelpers } from '../../vendor/scm/lib/helpers-queries';
import { useLorries } from '../../vendor/scm/lib/lorries-queries';
import { useUpdateTrip } from '../../vendor/scm/lib/trips-queries';
import { useDriverLeave } from '../../vendor/scm/lib/delivery-zones-queries';
import { findCrewLeave, crewLeaveLabel } from '../../vendor/shared/crew-leave';
import { AssignSelect, OverflowSection } from './delivery-propose-ui';
import { PackingListsSection } from '../../vendor/scm/components/PackingListsSection';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { DateField } from "../../vendor/scm/components/DateField";

function driverLine(t: FleetDayTrip): string {
  const parts = [t.driver?.name, ...(t.helpers.map((h) => h.name))].filter(Boolean);
  return parts.length ? parts.join(', ') : 'No crew assigned';
}

/* The dispatcher's per-trip crew choice — pick > engine suggestion > the trip's
   current crew. All five seats (owner: 1 OR 2 drivers, 1 OR 2 helpers). */
type CrewPick = {
  lorryId?: string | null;
  driver1Id?: string | null;
  driver2Id?: string | null;
  helper1Id?: string | null;
  helper2Id?: string | null;
};

export function FleetDay() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();

  // URL is state (repo rule): date + depot warehouse + focused trip live in the URL.
  const date = params.get('date') || todayMY();
  const warehouseId = params.get('warehouseId') || '';
  const focusedId = params.get('trip') || null;

  const setParam = (key: string, value: string | null) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value) next.set(key, value); else next.delete(key);
      return next;
    }, { replace: true });
  };

  const query = useFleetDay({ date, warehouseId: warehouseId || null });
  const data = query.data;
  const trips = useMemo(() => data?.trips ?? [], [data]);
  const warehouses = data?.warehouses ?? [];

  const colors = useMemo(() => assignRouteColors(trips.map((t) => t.id)), [trips]);
  const totalDrops = trips.reduce((n, t) => n + t.total_drops, 0);
  const totalRevenue = trips.reduce((n, t) => n + t.total_revenue_sen, 0);

  /* ── The day's board — the shared DeliveryPlanningBoard over the SO rows on
     a live trip THIS day (server-stamped trip_date; lib/last-mile.ts). state=ALL
     because a delivered order leaves Pending Schedule but not the day. */
  const [boardRegion, setBoardRegion] = useState<string>('ALL');
  const board = useDeliveryPlanning({ region: boardRegion, state: 'ALL' });
  const boardOrders = useMemo<PlanningOrder[]>(() => board.data?.orders ?? [], [board.data]);
  const boardRegionTabs = useMemo(() => regionTabsFrom(board.data?.regions), [board.data?.regions]);

  const [side, setSide] = useState<'ALL' | LastMileSide>('ALL');
  const sideCounts = useMemo(() => {
    const c: Record<LastMileSide, number> = { TIME_ARRANGED: 0, DELIVERED: 0 };
    for (const o of boardOrders) {
      const s = lastMileSideOf(o, date);
      if (s) c[s] += 1;
    }
    return c;
  }, [boardOrders, date]);
  const dayRows = useMemo(
    () => boardOrders.filter((o) => (side === 'ALL' ? lastMileSideOf(o, date) != null : lastMileSideOf(o, date) === side)),
    [boardOrders, date, side],
  );

  /* Manual crew edits ride the existing shared write path — the board's inline
     Driver / Lorry cells and the bulk bar. */
  const sched = useScheduleDelivery();
  const { data: drivers = [] } = useDrivers();
  const { data: helpers = [] } = useHelpers();
  const { data: lorries = [] } = useLorries();
  const crewLeave = useDriverLeave();
  const [sel, setSel] = useState<Set<string>>(new Set());
  const notify = useNotify();

  /* ── Propose crew — the day's crew intelligence over its EXISTING trips. */
  const seqAssign = useSequenceAssign();
  const updateTrip = useUpdateTrip();
  const doCrew = useAssignDoCrew();
  const [proposingCrew, setProposingCrew] = useState(false);
  const [crewAssign, setCrewAssign] = useState<SequenceAssignResponse | null>(null);
  const [suggestions, setSuggestions] = useState<Map<string, CrewSuggestion> | null>(null);
  const [crewPicks, setCrewPicks] = useState<Record<string, CrewPick>>({});
  const [applyingCrew, setApplyingCrew] = useState<string | null>(null);
  const [threePl, setThreePl] = useState<Record<string, { carrierId?: string | null; costRm?: string }>>({});
  const [assigning3pl, setAssigning3pl] = useState<string | null>(null);

  /* The day's already-sequenced runs: TIME_ARRANGED board rows grouped by their
     live trip. Crew is proposed ONLY for these (lib/last-mile.ts). */
  const dayArrangedRows = useMemo(
    () => boardOrders.filter((o) => lastMileSideOf(o, date) === 'TIME_ARRANGED'),
    [boardOrders, date],
  );
  const tripIdByDocNo = useMemo(() => {
    const m = new Map<string, string>();
    for (const o of dayArrangedRows) if (o.trip_id) m.set(o.so_doc_no, o.trip_id);
    return m;
  }, [dayArrangedRows]);
  const rowsByTripId = useMemo(() => {
    const m = new Map<string, PlanningOrder[]>();
    for (const o of dayArrangedRows) {
      if (!o.trip_id) continue;
      const arr = m.get(o.trip_id) ?? [];
      arr.push(o);
      m.set(o.trip_id, arr);
    }
    return m;
  }, [dayArrangedRows]);

  /* ── Option B side map (owner 2026-08-08): the page's existing day map is
     now the RIGHT PANEL of the board/map split. Pins + depot ride the shared
     /delivery-planning/geo read; the day's routes come off the server-stamped
     trip columns on the board rows (stagedRoutesFromRows — the same fold the
     Time page draws staged trips with), with crew labels + the day-map colour
     per trip from GET /trips/day. */
  const [mapOpen, setMapOpen] = useMapPanelOpen('last-mile');
  /* Compact columns: a per-page-persisted DEFAULT, never a lock — the pill on
     the panel header toggles it, and any explicit Columns-panel choice while
     the map is open switches it off (the user's picks win instantly). */
  const [mapCompact, setMapCompact] = useMapCompactColumns('last-mile');
  const [mapRegion, setMapRegion] = useState<string>('ALL');
  const geo = useDeliveryGeo({ date, region: mapRegion, enabled: mapOpen });
  const mapPins = useMemo(() => pinsFromGeoPoints(geo.data?.points ?? []), [geo.data?.points]);
  const mapTotals = useMemo(() => geoTotals(geo.data?.points ?? []), [geo.data?.points]);
  const mapZones = useMemo(
    () => zoneSummary(geo.data?.points ?? [], boardRegionTabs, mapRegion),
    [geo.data?.points, boardRegionTabs, mapRegion],
  );
  const pointByRef = useMemo(() => {
    const m = new Map<string, MapLatLng>();
    for (const p of geo.data?.points ?? []) m.set(p.ref, { lat: p.lat, lng: p.lng });
    return m;
  }, [geo.data?.points]);
  const panelRoutes = useMemo(() => {
    const depotLL = geo.data?.depot ? { lat: geo.data.depot.lat, lng: geo.data.depot.lng } : null;
    const staged = stagedRoutesFromRows(boardOrders, date, pointByRef, depotLL);
    const tripById = new Map(trips.map((t) => [t.id, t]));
    return staged.map((r) => {
      const t = tripById.get(r.id);
      const crew = t ? [t.lorry?.plate, driverLine(t)].filter(Boolean).join(' · ') : null;
      /* Same colour as the trip cards' dot (assignRouteColors keys trip_no
         order on both sides, but go through the one map to be exact). */
      return { ...r, color: routeColorFor(colors, r.id), crewLabel: crew || null };
    });
  }, [boardOrders, date, pointByRef, trips, colors, geo.data?.depot]);
  /* Trip focus rides the existing ?trip= URL param (the run-sheet deep link):
     clicking a trip card / polyline toggles it; the board filters to its stops. */
  const mapFocus = useMemo<MapFocus | null>(() => {
    if (!focusedId) return null;
    const refs = boardOrders
      .filter((o) => o.row_type === 'so' && o.trip_id === focusedId && lastMileSideOf(o, date) != null)
      .map((o) => o.so_doc_no);
    return { routeId: focusedId, refs };
  }, [focusedId, boardOrders, date]);
  const toggleTripFocus = (routeId: string) => setParam('trip', focusedId === routeId ? null : routeId);
  /* Two-way linkage (same shape as the sibling pages). */
  const [selectedPin, setSelectedPin] = useState<string | null>(null);
  const [scrollTo, setScrollTo] = useState<{ key: string; nonce: number } | null>(null);
  const onPinClick = (ref: string) => {
    setSelectedPin(ref);
    setScrollTo({ key: `so:${ref}`, nonce: Date.now() });
  };
  const boardRowsShown = useMemo(
    () => (mapOpen && mapFocus ? focusFilterRows(dayRows, mapFocus) : dayRows),
    [dayRows, mapOpen, mapFocus],
  );

  const runProposeCrew = async () => {
    const docNos = proposeCrewDocNos(boardOrders, date);
    if (docNos.length === 0) {
      notify({ title: 'Nothing to crew', body: 'No time-arranged orders on this day — sequence the day in Delivery Time Arrangement first.', tone: 'error' });
      return;
    }
    const depot = depotForDocNos(boardOrders, docNos);
    setProposingCrew(true);
    try {
      /* ONE call for the whole day so the engine balances crew ACROSS the day's
         runs (each person used once); its per-run picks re-attach to the real
         trips by stop overlap. Depart time is the Time page's business — the
         server default rides. */
      const r = await seqAssign.mutateAsync({
        soDocNos: docNos,
        startDate: date,
        depotWarehouseId: depot?.warehouseId ?? null,
      });
      const pinned = pinAssignToDate(r, date);
      setCrewAssign(pinned);
      setSuggestions(matchCrewSuggestions(pinned.trips, tripIdByDocNo));
      setCrewPicks({});
      setThreePl({});
    } catch (e) {
      notify({ title: 'Propose crew failed', body: e instanceof Error ? e.message : 'Something went wrong.', tone: 'error' });
    }
    setProposingCrew(false);
  };

  /* pick > suggestion > the trip's current crew (helpers array order = seat). */
  const effCrewFor = (t: FleetDayTrip): Required<CrewPick> => {
    const pick = crewPicks[t.id] ?? {};
    const sug = suggestions?.get(t.id);
    return {
      lorryId:   pick.lorryId   !== undefined ? pick.lorryId   : (sug?.lorryId  ?? t.lorry?.id ?? null),
      driver1Id: pick.driver1Id !== undefined ? pick.driver1Id : (sug?.driverId ?? t.driver?.id ?? null),
      driver2Id: pick.driver2Id !== undefined ? pick.driver2Id : null,
      helper1Id: pick.helper1Id !== undefined ? pick.helper1Id : (sug?.helperId ?? t.helpers[0]?.id ?? null),
      helper2Id: pick.helper2Id !== undefined ? pick.helper2Id : (t.helpers[1]?.id ?? null),
    };
  };
  const setCrewPick = (tripId: string, patch: CrewPick) =>
    setCrewPicks((prev) => ({ ...prev, [tripId]: { ...prev[tripId], ...patch } }));

  /* Label the crew onto ONE trip: the trip row (PATCH /trips/:id — map crew
     line, run-sheet, per-assignee scope) + the delivery_order_crew snapshot per
     live DO (PUT /delivery-orders-mfg/:id/crew — the board's crew columns, DO
     header quick-fields, audit; the driver-2 seat lives here). An order with no
     DO gets the trip-row half only, and is counted out loud (the known no-DO
     gap — cut the DO and re-apply). */
  const applyCrew = async (t: FleetDayTrip, ordinal: number) => {
    const eff = effCrewFor(t);
    const rows = rowsByTripId.get(t.id) ?? [];
    setApplyingCrew(t.id);
    let doOk = 0; let doFailed = 0; let noDo = 0; let tripFailed: string | null = null;
    try {
      await updateTrip.mutateAsync({
        id: t.id,
        lorryId: eff.lorryId,
        driverId: eff.driver1Id,
        helper1Id: eff.helper1Id,
        helper2Id: eff.helper2Id,
      });
    } catch (e) {
      tripFailed = e instanceof Error ? e.message : 'trip update failed';
    }
    for (const row of rows) {
      const live = row.delivery_orders.filter((d) => {
        const s = (d.status ?? '').toUpperCase();
        return s !== 'DRAFT' && s !== 'CANCELLED';
      });
      const doId = live.length > 0 ? live[live.length - 1]!.id : null;
      if (!doId) { noDo += 1; continue; }
      try {
        await doCrew.mutateAsync({
          doId,
          driver1Id: eff.driver1Id,
          driver2Id: eff.driver2Id,
          helper1Id: eff.helper1Id,
          helper2Id: eff.helper2Id,
          lorryId: eff.lorryId,
        });
        doOk += 1;
      } catch { doFailed += 1; }
    }
    setApplyingCrew(null);
    const parts = [
      tripFailed ? `Trip row failed: ${tripFailed}.` : `Trip ${ordinal} crew saved.`,
      `${doOk} order(s) labelled${doFailed ? `, ${doFailed} failed` : ''}.`,
      noDo > 0 ? `${noDo} order(s) have no DO yet — crew recorded on the trip only (cut the DO and re-apply).` : '',
    ].filter(Boolean);
    notify({
      title: tripFailed || doFailed ? 'Crew applied with problems' : 'Crew applied',
      body: parts.join(' '),
      tone: tripFailed || doFailed ? 'error' : 'info',
    });
    board.refetch();
    query.refetch();
  };

  /* 3PL overflow (moved here with the crew intelligence): the day's spill goes
     to a carrier at a captured cost via the SAME schedule write-path. */
  const assignThreePl = async (o: OverflowGroup) => {
    const pick = threePl[o.key] ?? {};
    if (!pick.carrierId) { notify({ title: 'Pick a 3PL carrier', body: 'Choose a carrier for this overflow before assigning.', tone: 'error' }); return; }
    const costRm = Number(pick.costRm);
    const costSen = Number.isFinite(costRm) && costRm > 0 ? Math.round(costRm * 100) : null;
    setAssigning3pl(o.key);
    let ok = 0; let failed = 0;
    for (let i = 0; i < o.orders.length; i += 1) {
      try {
        await sched.mutateAsync({
          type: 'so', id: o.orders[i],
          scheduleDate: o.date, tripDate: o.date,
          lorryId: pick.carrierId,
          stopNo: i + 1,
          threePlCostSen: i === 0 ? costSen : undefined,
        });
        ok += 1;
      } catch { failed += 1; }
    }
    setAssigning3pl(null);
    notify({
      title: failed === 0 ? '3PL assigned' : 'Assigned with some failures',
      body: `${ok} order(s) routed to the 3PL carrier${failed ? `, ${failed} failed` : ''}.`,
      tone: failed === 0 ? 'info' : 'error',
    });
    board.refetch();
    query.refetch();
  };
  const setThreePlPick = (key: string, patch: { carrierId?: string | null; costRm?: string }) =>
    setThreePl((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));

  const goPrint = (tripId?: string) => {
    const p = new URLSearchParams();
    p.set('date', date);
    if (warehouseId) p.set('warehouseId', warehouseId);
    const t = tripId ?? focusedId;
    if (t) p.set('trip', t);
    navigate(`/scm/fleet-run-sheet?${p.toString()}`);
  };

  /* ── Crew assignment + trip cards — rendered UNDER the map while the panel
     is open, below the board when it is closed. The old "Lorries today" side
     panel merged into these cards (colour dot, plate, crew line, warehouse,
     drops/revenue, per-trip run-sheet link, focus click). */
  const crewSection = (
    <div className="space-y-3 rounded-md border border-border bg-surface p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-semibold text-ink">Crew assignment</span>
        <span className="text-[11.5px] text-ink-muted">
          Suggests a lorry, drivers and helpers per trip (leave-aware, fleet-status checked) — every seat stays yours to override
        </span>
        <span className="flex-1" />
        <Button
          variant="primary"
          icon={<Wand2 size={14} strokeWidth={1.75} />}
          disabled={proposingCrew || trips.length === 0}
          onClick={() => void runProposeCrew()}
          title={trips.length === 0 ? 'No trips on this day yet — sequence the day in Delivery Time Arrangement first' : 'Propose driver + lorry for every trip of the day'}
        >
          {proposingCrew ? 'Proposing…' : 'Propose crew'}
        </Button>
      </div>

      {crewAssign && crewAssign.excludedLorries.length > 0 && (
        <div style={{ fontSize: 'var(--fs-12)', color: 'var(--c-warning, #b45309)' }}>
          Excluded by fleet status: {crewAssign.excludedLorries.map((l) => `${l.plate} (${l.status})`).join(', ')}
        </div>
      )}
      {crewAssign && crewAssign.excludedDrivers.length > 0 && (
        <div style={{ fontSize: 'var(--fs-12)', color: 'var(--c-warning, #b45309)' }}>
          On leave (not auto-assigned): {crewAssign.excludedDrivers.map((d) => `${d.name ?? d.id} (${d.from}–${d.to}${d.reason ? `, ${d.reason}` : ''})`).join(', ')}
        </div>
      )}

      {crewAssign && crewAssign.overflow.length > 0 && (
        <OverflowSection
          overflow={crewAssign.overflow}
          carriers={crewAssign.carriers}
          pick={threePl}
          onPick={setThreePlPick}
          onAssign={assignThreePl}
          assigningKey={assigning3pl}
        />
      )}

      {trips.length === 0 ? (
        <p className="text-[12.5px] text-ink-muted">
          No trips on this day yet. Sequence the day in Delivery Time Arrangement — its numbered trips appear here for crew.
        </p>
      ) : (
        trips.map((t, i) => {
          const eff = effCrewFor(t);
          const rows = rowsByTripId.get(t.id) ?? [];
          const cardFocused = focusedId === t.id;
          const driverOpts = drivers.map((d) => ({
            id: d.id, label: d.name, note: crewLeaveLabel(findCrewLeave(crewLeave.data, 'driver', d.id, date)),
          }));
          const helperOpts = helpers.map((h) => ({
            id: h.id, label: h.name, note: crewLeaveLabel(findCrewLeave(crewLeave.data, 'helper', h.id, date)),
          }));
          return (
            <div key={t.id} style={{ borderRadius: 10, border: `1px solid ${cardFocused ? 'rgba(37,99,235,0.55)' : 'var(--border, rgba(0,0,0,0.12))'}`, overflow: 'hidden' }}>
              {/* Header = the merged lorry-panel line. Clicking it FOCUSES the
                  trip (map dims the rest, board filters to its stops); the
                  run-sheet link stays per trip. */}
              <div
                onClick={() => toggleTripFocus(t.id)}
                title={cardFocused ? 'Click to unfocus this trip' : 'Click to focus this trip on the map and board'}
                style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '10px 14px', background: cardFocused ? 'rgba(37,99,235,0.08)' : 'var(--bg-subtle, rgba(0,0,0,0.03))', cursor: 'pointer' }}
              >
                <span style={{ width: 12, height: 12, borderRadius: 999, background: routeColorFor(colors, t.id), flex: 'none' }} />
                <strong style={{ fontSize: 'var(--fs-13)' }}>Trip {i + 1}</strong>
                <span className="font-mono text-[12px] text-ink-secondary">{t.trip_no ?? '—'}</span>
                <span className="font-mono text-[12.5px] font-semibold text-ink">{t.lorry?.plate ?? ''}</span>
                <Badge tone="neutral" caseless>{String(t.status).replace('_', ' ').toLowerCase()}</Badge>
                {t.is_outsourced && <Badge tone="warning" caseless>outsourced</Badge>}
                <span className="flex items-center gap-1.5 text-[11.5px] text-ink-secondary">
                  <Users size={12} strokeWidth={1.75} /> {driverLine(t)}
                </span>
                <span style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
                  {t.warehouse?.name ? `${t.warehouse.name} · ` : ''}{t.total_drops} drops · {fmtSen(t.total_revenue_sen)}
                </span>
                {suggestions && !suggestions.has(t.id) && crewAssign && (
                  <span style={{ fontSize: 'var(--fs-11)', color: 'var(--fg-muted)' }}>no engine suggestion — assign by hand</span>
                )}
                <span style={{ flex: 1 }} />
                <Button variant="ghost" icon={<Printer size={13} />} onClick={(e) => { e.stopPropagation(); goPrint(t.id); }}>
                  Run-sheet
                </Button>
              </div>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', padding: '10px 14px', borderTop: '1px solid var(--border, rgba(0,0,0,0.08))' }}>
                <AssignSelect label="Lorry" value={eff.lorryId} onChange={(v) => setCrewPick(t.id, { lorryId: v })}
                  options={lorries.map((l) => ({ id: l.id, label: l.plate }))} placeholder="— pick a lorry —" />
                <AssignSelect label="Driver 1" value={eff.driver1Id} onChange={(v) => setCrewPick(t.id, { driver1Id: v })}
                  options={driverOpts} placeholder="— none —" />
                <AssignSelect label="Driver 2" value={eff.driver2Id} onChange={(v) => setCrewPick(t.id, { driver2Id: v })}
                  options={driverOpts} placeholder="— none —" />
                <AssignSelect label="Helper 1" value={eff.helper1Id} onChange={(v) => setCrewPick(t.id, { helper1Id: v })}
                  options={helperOpts} placeholder="— none —" />
                <AssignSelect label="Helper 2" value={eff.helper2Id} onChange={(v) => setCrewPick(t.id, { helper2Id: v })}
                  options={helperOpts} placeholder="— none —" />
                <div style={{ flex: 1 }} />
                <div style={{ display: 'flex', alignItems: 'flex-end' }}>
                  <Button
                    variant="primary"
                    icon={<CalendarCheck size={14} strokeWidth={1.75} />}
                    onClick={() => void applyCrew(t, i + 1)}
                    disabled={applyingCrew === t.id || !eff.lorryId}
                  >
                    {applyingCrew === t.id ? 'Applying…' : 'Apply crew'}
                  </Button>
                </div>
              </div>
              {rows.length === 0 && (
                <div style={{ padding: '6px 14px', fontSize: 'var(--fs-11)', color: 'var(--fg-muted)', borderTop: '1px solid var(--border, rgba(0,0,0,0.06))' }}>
                  No time-arranged board rows resolve to this trip — the crew saves to the trip row only.
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Delivery"
        title="Last Mile Delivery"
        description="The day's time-arranged orders and their trips — manage crew on the trip cards, watch every lorry's route on the side map, and print the driver run-sheet."
        primaryAction={
          <Button variant="secondary" icon={<Printer size={14} />} onClick={() => goPrint()} disabled={trips.length === 0}>
            Print run-sheet
          </Button>
        }
      />

      {/* controls: date only (owner 2026-08-08: the depot chip strip is gone —
          the day map shows every depot's trips; the board's region chips carry
          the narrowing like the rest of the family). warehouseId stays in the
          URL for deep links but no chip UI sets it. */}
      <div className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-surface px-4 py-3">
        <label className="flex items-center gap-2 text-[12.5px] text-ink-secondary">
          <span className="font-semibold text-ink">Date</span>
          <DateField
            fullWidth
            value={date}
            onChange={(iso) => { setParam('date', iso || null); setSel(new Set()); }}
            className="rounded-md border border-border bg-surface px-2 py-1 text-[12.5px] text-ink"
          />
        </label>
        <span className="flex-1" />
        <span className="text-[11.5px] text-ink-muted">
          {trips.length} {trips.length === 1 ? 'trip' : 'trips'} · {totalDrops} drops · {fmtSen(totalRevenue)}
        </span>
      </div>

      {/* ── Option B split: board (left) / sticky map + trip cards (right). ── */}
      <div className="lg:flex lg:items-start lg:gap-4">
      <div className="min-w-0 space-y-4 lg:flex-1">

      {/* Split chips — the execution split for the picked day. */}
      <div className="flex flex-wrap gap-1.5">
        {(['ALL', 'TIME_ARRANGED', 'DELIVERED'] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => { setSide(s); setSel(new Set()); }}
            className={cn(
              'rounded-full border px-3 py-1 text-[12px]',
              side === s ? 'border-accent bg-accent/10 font-semibold text-accent' : 'border-border text-ink-secondary',
            )}
          >
            {s === 'ALL'
              ? `All (${sideCounts.TIME_ARRANGED + sideCounts.DELIVERED})`
              : `${LAST_MILE_SIDE_LABEL[s]} (${sideCounts[s]})`}
          </button>
        ))}
        <span className="ml-2 self-center text-[11.5px] text-ink-muted">
          Time-arranged orders flow in from Delivery Time Arrangement automatically
        </span>
        <span className="flex-1" />
        {mapOpen && mapFocus && (
          <button
            type="button"
            className="self-center text-[11.5px] text-accent underline decoration-dotted underline-offset-2"
            onClick={() => setParam('trip', null)}
            title="Stop filtering the board to the focused trip"
          >
            Focused on one trip — clear
          </button>
        )}
        {!mapOpen && (
          <Button variant="ghost" icon={<MapIcon size={14} strokeWidth={1.75} />} onClick={() => setMapOpen(true)} title="Show the day map beside the board">
            Show map
          </Button>
        )}
      </div>

      <DeliveryPlanningBoard
        orders={boardRowsShown}
        counts={board.data?.counts ?? {}}
        regionTabs={boardRegionTabs}
        activeRegion={boardRegion}
        onRegionChange={setBoardRegion}
        isLoading={board.isLoading}
        error={board.error}
        /* No stateTabs — the page owns one DAY; the split chips above are its rail. */
        selectedKeys={sel}
        onToggle={(k) => setSel((p) => {
          const n = new Set(p);
          if (n.has(k)) n.delete(k); else n.add(k);
          return n;
        })}
        onToggleAll={(keys, allSel) => setSel((p) => {
          const n = new Set(p);
          if (allSel) { for (const k of keys) n.delete(k); }
          else { for (const k of keys) n.add(k); }
          return n;
        })}
        onClearSelection={() => setSel(new Set())}
        sched={sched}
        drivers={drivers}
        lorries={lorries}
        storageKey="dg-last-mile"
        exportName="LastMileDelivery"
        /* Map-open narrowing (a DEFAULT — the compact pill / an explicit
           Columns-panel choice turns it off) + two-way linkage (Option B). */
        visibleColumnsOverride={mapOpen && mapCompact ? MAP_ESSENTIAL_COLUMNS_LAST_MILE : null}
        onUserAdjustColumns={() => { if (mapOpen && mapCompact) setMapCompact(false); }}
        onRowClick={(o) => { if (mapOpen && o.row_type === 'so') setSelectedPin(o.so_doc_no); }}
        scrollToRow={scrollTo}
        defaultSort={arrangementQueueCompare}
        emptyMessage="No time-arranged orders for this day — arrange times in Delivery Time Arrangement."
        onRowDoubleClick={(o) => { if (o.row_type === 'so') navigate('/scm/sales-orders/' + o.so_doc_no); }}
        contextMenu={(row) => (row.row_type === 'so'
          ? [{ label: 'Open Sales Order', onClick: () => navigate('/scm/sales-orders/' + row.so_doc_no) }]
          : [])}
      />

      {/* Map closed → the crew/trip cards render below the board, full
          width. Map open → they live UNDER the map in the right panel. */}
      {!mapOpen && crewSection}

      {query.isLoading && <p className="p-4 text-[13px] text-ink-muted">Loading the day…</p>}
      {query.error && (
        <p className="rounded-md border border-err/40 bg-err/5 p-4 text-[13px] text-err">
          Could not load this day. {query.error instanceof Error ? query.error.message : ''}
        </p>
      )}

      {!query.isLoading && !query.error && trips.length === 0 && (
        <p className="rounded-md border border-border bg-surface p-6 text-center text-[13px] text-ink-muted">
          No trips scheduled for this day. Arrange times in Delivery Time Arrangement to create them.
        </p>
      )}

      </div>{/* /board column */}

      {mapOpen && (
        <DeliveryMapPanel
          className="mt-4 lg:mt-0 lg:w-[40%] lg:flex-none"
          title="Day map"
          onClose={() => setMapOpen(false)}
          headerControls={
            <>
              {/* The picked day (the page URL param) — required. */}
              <DateField
                fullWidth
                required
                value={date}
                onChange={(iso) => { if (iso) { setParam('date', iso); setSel(new Set()); } }}
                title="The day the map shows"
                className="rounded-md border border-border bg-surface px-2 py-1 text-[12px] text-ink"
              />
              {boardRegionTabs.map((r) => (
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
          routes={panelRoutes}
          depot={geo.data?.depot ? { lat: geo.data.depot.lat, lng: geo.data.depot.lng, label: geo.data.depot.name } : null}
          depotReason={geo.data?.depotReason ?? null}
          focus={mapFocus}
          onRouteClick={toggleTripFocus}
          selectedRef={selectedPin}
          onPinClick={onPinClick}
          totals={mapTotals}
          regionKey={mapRegion}
          viewKey={`${date}|${mapRegion}`}
          zoneSummary={mapZones}
          compactColumns={mapCompact}
          onCompactColumnsChange={setMapCompact}
          ungeocoded={geo.data?.ungeocoded ?? []}
          serverConfigured={geo.data?.configured ?? true}
          isLoading={geo.isLoading || query.isLoading}
        >
          {crewSection}
        </DeliveryMapPanel>
      )}
      </div>{/* /split */}

      {/* PACKING LISTS — owner 2026-08-25: the packing list hangs off Last Mile
          Delivery, not off a delivery order, because one run can carry both
          companies' DOs. One row per trip of this day; the printed sheet is the
          run in LOADING order. Full width, under the split, because it is about
          the whole day rather than about the board or the map. */}
      <PackingListsSection date={date} warehouseId={warehouseId || null} />

      <p className="flex items-center gap-1.5 text-[11px] text-ink-muted">
        <Truck size={12} strokeWidth={1.75} />
        The map is a read-only view over scheduled trips. Crew edits on the board above write through the same schedule path as everywhere else.
      </p>
    </div>
  );
}
