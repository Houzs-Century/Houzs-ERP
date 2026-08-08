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
// The A4 day MAP stays as the page's visual: every trip that day, each lorry's
// route in its own colour, the side panel of lorries + crew ("Trip N" ordinal
// per date = trip_no order, the same numbering the Time page staged), the
// focused stop list, and the printable run-sheet link. The map read
// (GET /trips/day) is unchanged.
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { MapPin, Printer, Truck, Users, Wand2, CalendarCheck } from 'lucide-react';
import { PageHeader } from '../../components/Layout';
import { Button } from '../../components/Button';
import { Badge } from '../../components/Badge';
import { cn } from '../../lib/utils';
import { fmtCenti, todayMY } from '../../vendor/shared/format';
import { useFleetDay, type FleetDayTrip } from '../../vendor/scm/lib/fleet-day-queries';
import { assignRouteColors, routeColorFor } from '../../vendor/scm/lib/fleet-colors';
import { buildMapRoutes, etaLabel, windowLabel, kmLabel } from '../../vendor/scm/lib/fleet-day-model';
import { FleetDayMap } from '../../vendor/scm/components/FleetDayMap';
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
import { useNotify } from '../../vendor/scm/components/NotifyDialog';

const MAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined;

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
  const mapRoutes = useMemo(() => buildMapRoutes(trips, colors), [trips, colors]);

  const focused = focusedId ? trips.find((t) => t.id === focusedId) ?? null : null;
  const totalDrops = trips.reduce((n, t) => n + t.total_drops, 0);
  const totalRevenue = trips.reduce((n, t) => n + t.total_revenue_centi, 0);
  const geocodedStops = trips.reduce((n, t) => n + t.stops.filter((s) => s.geocoded).length, 0);
  const ungeocodedStops = trips.reduce((n, t) => n + t.stops.filter((s) => !s.geocoded).length, 0);

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
    const costCenti = Number.isFinite(costRm) && costRm > 0 ? Math.round(costRm * 100) : null;
    setAssigning3pl(o.key);
    let ok = 0; let failed = 0;
    for (let i = 0; i < o.orders.length; i += 1) {
      try {
        await sched.mutateAsync({
          type: 'so', id: o.orders[i],
          scheduleDate: o.date, tripDate: o.date,
          lorryId: pick.carrierId,
          stopNo: i + 1,
          threePlCostCenti: i === 0 ? costCenti : undefined,
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

  const goPrint = () => {
    const p = new URLSearchParams();
    p.set('date', date);
    if (warehouseId) p.set('warehouseId', warehouseId);
    if (focusedId) p.set('trip', focusedId);
    navigate(`/scm/fleet-run-sheet?${p.toString()}`);
  };

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Delivery"
        title="Last Mile Delivery"
        description="The day's time-arranged orders and their trips — manage crew on the board, watch every lorry's route on one map, and print the driver run-sheet."
        primaryAction={
          <Button variant="secondary" icon={<Printer size={14} />} onClick={goPrint} disabled={trips.length === 0}>
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
          <input
            type="date"
            value={date}
            onChange={(e) => { setParam('date', e.target.value || null); setSel(new Set()); }}
            className="rounded-md border border-border bg-surface px-2 py-1 text-[12.5px] text-ink"
          />
        </label>
        <span className="flex-1" />
        <span className="text-[11.5px] text-ink-muted">
          {trips.length} {trips.length === 1 ? 'trip' : 'trips'} · {totalDrops} drops · {fmtCenti(totalRevenue)}
        </span>
      </div>

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
      </div>

      <DeliveryPlanningBoard
        orders={dayRows}
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
        defaultSort={arrangementQueueCompare}
        emptyMessage="No time-arranged orders for this day — arrange times in Delivery Time Arrangement."
        onRowDoubleClick={(o) => { if (o.row_type === 'so') navigate('/scm/sales-orders/' + o.so_doc_no); }}
        contextMenu={(row) => (row.row_type === 'so'
          ? [{ label: 'Open Sales Order', onClick: () => navigate('/scm/sales-orders/' + row.so_doc_no) }]
          : [])}
      />

      {/* ── Crew assignment — the 智能 driver + lorry intelligence, on the day's
          EXISTING trips (the SAME numbered trips the Time page staged). */}
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
            const driverOpts = drivers.map((d) => ({
              id: d.id, label: d.name, note: crewLeaveLabel(findCrewLeave(crewLeave.data, 'driver', d.id, date)),
            }));
            const helperOpts = helpers.map((h) => ({
              id: h.id, label: h.name, note: crewLeaveLabel(findCrewLeave(crewLeave.data, 'helper', h.id, date)),
            }));
            return (
              <div key={t.id} style={{ borderRadius: 10, border: '1px solid var(--border, rgba(0,0,0,0.12))', overflow: 'hidden' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '10px 14px', background: 'var(--bg-subtle, rgba(0,0,0,0.03))' }}>
                  <strong style={{ fontSize: 'var(--fs-13)' }}>Trip {i + 1}</strong>
                  <span className="font-mono text-[12px] text-ink-secondary">{t.trip_no ?? '—'}</span>
                  <Badge tone="neutral" caseless>{String(t.status).replace('_', ' ').toLowerCase()}</Badge>
                  {t.is_outsourced && <Badge tone="warning" caseless>outsourced</Badge>}
                  <span style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
                    {t.total_drops} drops · {fmtCenti(t.total_revenue_centi)}
                  </span>
                  {suggestions && !suggestions.has(t.id) && crewAssign && (
                    <span style={{ fontSize: 'var(--fs-11)', color: 'var(--fg-muted)' }}>no engine suggestion — assign by hand</span>
                  )}
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

      {trips.length > 0 && (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,340px)_1fr]">
          {/* ── side panel: the day's lorries ── */}
          <div className="space-y-3">
            <div className="rounded-md border border-border bg-surface">
              <div className="border-b border-border px-4 py-2.5 text-[12px] font-semibold uppercase tracking-wider text-ink-secondary">
                Lorries today
              </div>
              <ul className="divide-y divide-border">
                {trips.map((t, i) => {
                  const color = routeColorFor(colors, t.id);
                  const active = focusedId === t.id;
                  return (
                    <li key={t.id}>
                      <button
                        type="button"
                        onClick={() => setParam('trip', active ? null : t.id)}
                        className={cn(
                          'flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-surface-raised',
                          active && 'bg-surface-raised',
                        )}
                      >
                        <span className="mt-0.5 h-3.5 w-3.5 flex-none rounded-full" style={{ backgroundColor: color }} />
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-2">
                            {/* "Trip N" per date = trip_no order — the SAME
                                numbering the Time page staged. */}
                            <span className="text-[12px] font-semibold text-ink-secondary">Trip {i + 1}</span>
                            <span className="font-mono text-[12.5px] font-semibold text-ink">
                              {t.lorry?.plate ?? t.trip_no ?? '—'}
                            </span>
                            <Badge tone="neutral" caseless>{String(t.status).replace('_', ' ').toLowerCase()}</Badge>
                            {t.is_outsourced && <Badge tone="warning" caseless>outsourced</Badge>}
                          </span>
                          <span className="mt-0.5 flex items-center gap-1.5 text-[11.5px] text-ink-secondary">
                            <Users size={12} strokeWidth={1.75} /> {driverLine(t)}
                          </span>
                          <span className="mt-0.5 block text-[11.5px] text-ink-muted">
                            {t.warehouse?.name ? `${t.warehouse.name} · ` : ''}{t.total_drops} drops · {fmtCenti(t.total_revenue_centi)}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>

            {ungeocodedStops > 0 && (
              <p className="rounded-md border border-border bg-surface-dim px-3 py-2 text-[11.5px] text-ink-muted">
                {geocodedStops} of {geocodedStops + ungeocodedStops} stops located on the map.
                {' '}{ungeocodedStops} could not be geocoded and have no pin.
              </p>
            )}
          </div>

          {/* ── map + focused stop list ── */}
          <div className="space-y-4">
            {MAPS_KEY && data?.configured ? (
              <FleetDayMap apiKey={MAPS_KEY} routes={mapRoutes} focusedId={focusedId} />
            ) : (
              <div className="flex h-[300px] items-center justify-center rounded-lg border border-dashed border-border bg-surface-dim px-6 text-center text-[12.5px] text-ink-muted">
                {MAPS_KEY
                  ? 'The maps key is not configured on the server, so stops were not geocoded. The lorry list and stop details below still work.'
                  : 'Set VITE_GOOGLE_MAPS_API_KEY to draw the day map. The lorry list and stop details still work without it.'}
              </div>
            )}

            <div className="rounded-md border border-border bg-surface">
              <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
                <MapPin size={14} strokeWidth={1.75} className="text-ink-secondary" />
                <span className="text-[12.5px] font-semibold text-ink">
                  {focused ? `${focused.lorry?.plate ?? focused.trip_no ?? 'Trip'} — stops` : 'Select a lorry to see its stops'}
                </span>
                {focused && (
                  <>
                    <span className="flex-1" />
                    <Button variant="ghost" icon={<Printer size={13} />} onClick={goPrint}>
                      Print this run-sheet
                    </Button>
                  </>
                )}
              </div>

              {!focused ? (
                <p className="p-5 text-[12.5px] text-ink-muted">
                  Pick a lorry from the list to focus its route and read its ordered stops.
                </p>
              ) : focused.stops.length === 0 ? (
                <p className="p-5 text-[12.5px] text-ink-muted">This trip has no stops.</p>
              ) : (
                <ul className="divide-y divide-border">
                  {focused.stops.map((s) => {
                    const win = windowLabel(s.earliest_time, s.latest_time);
                    return (
                      <li key={s.id} className="flex items-start gap-3 px-4 py-3">
                        <span
                          className="mt-0.5 flex h-6 w-6 flex-none items-center justify-center rounded-full text-[11px] font-bold text-white"
                          style={{ backgroundColor: routeColorFor(colors, focused.id) }}
                        >
                          {s.stop_no}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-2">
                            <span className="text-[13px] font-semibold text-ink">{s.customer_name ?? '—'}</span>
                            {s.house_type && <Badge tone="neutral" caseless>{s.house_type}</Badge>}
                            {s.stop_type !== 'DELIVERY' && (
                              <Badge tone="accent" caseless>{s.stop_type.replace('_', ' ').toLowerCase()}</Badge>
                            )}
                            {!s.geocoded && <Badge tone="warning" caseless>not located</Badge>}
                          </span>
                          <span className="block text-[11.5px] text-ink-muted">{s.address ?? 'No address'}</span>
                          <span className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11.5px] text-ink-secondary">
                            {s.phone && <span>{s.phone}</span>}
                            {win && <span>Window {win}</span>}
                            {s.access_note && <span>{s.access_note}</span>}
                          </span>
                        </span>
                        <span className="flex-none text-right text-[11.5px] text-ink-secondary">
                          <span className="block font-semibold text-ink">{etaLabel(s.eta_offset_s)}</span>
                          <span className="block">{kmLabel(s.leg_distance_m)}</span>
                          <span className="block">{fmtCenti(s.revenue_centi)}</span>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}

      <p className="flex items-center gap-1.5 text-[11px] text-ink-muted">
        <Truck size={12} strokeWidth={1.75} />
        The map is a read-only view over scheduled trips. Crew edits on the board above write through the same schedule path as everywhere else.
      </p>
    </div>
  );
}
