// ----------------------------------------------------------------------------
// Delivery Time Arrangement — stage 3 of the delivery pipeline (Planning ->
// Date -> Time -> Last Mile). Owner spec 2026-08-07/08: dates first, lorries
// later — the lorry / sequence / 3PL tools live HERE now.
//
// The page IS the queue board — the EXACT shared DeliveryPlanningBoard locked
// to PENDING_SCHEDULE, split Pending Time Arrangement (the inbox: date
// confirmed, no trip yet — every order Delivery Date Arrangement confirms flows
// in automatically) vs Time arranged (on a live trip), over the server-stamped
// arrangement_stage. Two actions on the multiselect:
//
//   "Propose time (N)"  — the A2/A3 sequence-assign flow, RELOCATED from the
//     Delivery Date Arrangement page, under the CONFIRMED-DATE discipline
//     (lib/propose-time.ts): the selection is grouped by each order's
//     confirmed delivery date, the endpoint is called once per date-group with
//     that date as its start, and the response is PINNED to that one day —
//     what the packer walked past the date spills to the 3PL overflow bucket
//     FOR the date (own fleet provably full) instead of being re-dated. The
//     Date page owns dates; this page never re-derives them. Each call crews
//     the groups with an available lorry + driver + helper (leave-aware),
//     sequences the stops (geocode + one Distance Matrix call per trip) and
//     returns editable per-trip cards + the 3PL overflow section. Apply
//     persists through the ESTABLISHED schedule path (PATCH
//     /delivery-planning/so/:id/schedule). Depot / capacity / max-trips ride
//     the server defaults silently; the depart-time input applies per day.
//   "Schedule (N)"      — the existing manual ScheduleTripDrawer, unchanged.
//
// Trip detail belongs under the "Time arranged" side: when that tab is active,
// the trip list + stop sheet (+ route optimiser + Phase-4 live map) render
// below the board. The old page-top trip-state chip bar and its two panels are
// gone — CANCELLED trips are dropped and the rest order IN_PROGRESS -> PLANNED
// -> COMPLETED (dispatchers watch running trips first).
// ----------------------------------------------------------------------------

import { useMemo, useState, type ReactNode, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import { Route as RouteIcon, MapPin, CalendarClock, CalendarCheck, Wand2 } from 'lucide-react';
import { PageHeader } from '../../components/Layout';
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
import { useHelpers } from '../../vendor/scm/lib/helpers-queries';
import { useLorries } from '../../vendor/scm/lib/lorries-queries';
import {
  useSequenceAssign,
  useDriverLeave,
  type SequenceAssignResponse,
  type AssignedTrip,
  type OverflowGroup,
  type ThreePlCarrier,
} from '../../vendor/scm/lib/delivery-zones-queries';
import { findCrewLeave, crewLeaveLabel, type CrewLeaveRow } from '../../vendor/shared/crew-leave';
import {
  groupByConfirmedDate,
  pinAssignToDate,
  mergeAssignResults,
} from '../../vendor/scm/lib/propose-time';
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

const ICON = { size: 14, strokeWidth: 1.75 } as const;

/* Trip ordering under the Time arranged tab (owner: dispatchers watch running
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
     AND the relocated propose-time cards. */
  const sched = useScheduleDelivery();
  const { data: drivers = [] } = useDrivers();
  const { data: helpers = [] } = useHelpers();
  const { data: lorries = [] } = useLorries();
  /* Leave marks the manual pickers per TRIP DATE (mark, never hide — the
     dispatcher has the final say; only the AUTO assigner refuses). */
  const crewLeave = useDriverLeave();

  /* Multiselect → Schedule (manual drawer) or Propose time (auto flow). */
  const [pendingSel, setPendingSel] = useState<Set<string>>(new Set());
  const [scheduling, setScheduling] = useState(false);
  const selectedDocNos = soDocNosFromSelection(pendingSel);
  /* The SO order objects behind the selection — fed to the drawer as its stop
     list (SO-only, like every board bulk action). */
  const pendingSelectedOrders = useMemo<PlanningOrder[]>(() => {
    const docs = new Set(soDocNosFromSelection(pendingSel));
    return pendingOrders.filter((o) => o.row_type === 'so' && docs.has(o.so_doc_no));
  }, [pendingOrders, pendingSel]);

  /* ── Propose time — the RELOCATED A2/A3 sequence-assign flow, under the
     confirmed-date discipline (lib/propose-time.ts): one endpoint call per
     confirmed-date group, each response pinned to its one day. */
  const seqAssign = useSequenceAssign();
  const [departTime, setDepartTime] = useState<string>('09:00');
  const [proposing, setProposing] = useState(false);
  const [assign, setAssign] = useState<SequenceAssignResponse | null>(null);
  // Per-trip dispatcher overrides of the auto-assigned lorry / driver / helper.
  const [overrides, setOverrides] = useState<Record<string, { lorryId?: string | null; driverId?: string | null; helperId?: string | null }>>({});
  const [applyingAssign, setApplyingAssign] = useState(false);
  // A3: per-overflow-group 3PL choice — the carrier lorry + captured cost (RM).
  const [threePl, setThreePl] = useState<Record<string, { carrierId?: string | null; costRm?: string }>>({});
  const [assigning3pl, setAssigning3pl] = useState<string | null>(null);

  const runProposeTime = async () => {
    if (selectedDocNos.length === 0) {
      notify({ title: 'Nothing selected', body: 'Tick the orders to arrange first.', tone: 'error' });
      return;
    }
    /* Dates first, lorries second: group the selection by each order's
       CONFIRMED delivery date — the Date page owns dates, so the packer is
       started AT each confirmed date and pinned to that one day. An order with
       no confirmed date is reported and skipped, never dated here. Depot,
       capacity ceilings and max-trips still ride the server defaults silently;
       the depart time applies to every day's trips. */
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
    for (const g of groups) {
      try {
        const r = await seqAssign.mutateAsync({ soDocNos: g.docNos, startDate: g.date, departTime });
        results.push(pinAssignToDate(r, g.date));
      } catch (e) {
        failures.push(`${g.date} (${e instanceof Error ? e.message : 'Something went wrong.'})`);
      }
    }
    setProposing(false);
    const merged = mergeAssignResults(results);
    if (merged) { setAssign(merged); setOverrides({}); setThreePl({}); }
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

  // The effective (possibly overridden) crew/lorry for a trip.
  const effectiveTrip = (t: AssignedTrip) => {
    const o = overrides[t.key] ?? {};
    return {
      lorryId: o.lorryId !== undefined ? o.lorryId : t.lorryId,
      driverId: o.driverId !== undefined ? o.driverId : t.driverId,
      helperId: o.helperId !== undefined ? o.helperId : t.helperId,
    };
  };
  const setOverride = (key: string, patch: { lorryId?: string | null; driverId?: string | null; helperId?: string | null }) =>
    setOverrides((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));
  const setThreePlPick = (key: string, patch: { carrierId?: string | null; costRm?: string }) =>
    setThreePl((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));

  /* Apply ONE trip's assignment: fan out one schedule call per stop, in the
     proposed order, reusing the established schedule write-path (date + lorry +
     driver + helper + stop position + ETA). amended_delivery_date only. */
  const applyTrip = async (t: AssignedTrip) => {
    const eff = effectiveTrip(t);
    if (!eff.lorryId) { notify({ title: 'Pick a lorry', body: 'This trip has no lorry assigned — choose one before applying.', tone: 'error' }); return; }
    // Ordered refs: the sequenced order if we have a route, else the packed order.
    const orderedRefs = t.sequence
      ? t.sequence.sequence.map((s) => ({ ref: s.ref, stopNo: s.order, etaOffsetS: s.etaOffsetS, legDistanceM: s.legDistanceM, legDurationS: s.legDurationS }))
      : t.stops.map((s, i) => ({ ref: s.ref, stopNo: i + 1, etaOffsetS: null as number | null, legDistanceM: null as number | null, legDurationS: null as number | null }));
    setApplyingAssign(true);
    let ok = 0; let failed = 0;
    for (const r of orderedRefs) {
      try {
        await sched.mutateAsync({
          type: 'so', id: r.ref,
          scheduleDate: t.date, tripDate: t.date,
          lorryId: eff.lorryId, driverId: eff.driverId ?? null,
          helper1Id: eff.helperId ?? null,
          stopNo: r.stopNo,
          etaOffsetS: r.etaOffsetS ?? undefined,
          legDistanceM: r.legDistanceM ?? undefined,
          legDurationS: r.legDurationS ?? undefined,
        });
        ok += 1;
      } catch { failed += 1; }
    }
    setApplyingAssign(false);
    notify({
      title: failed === 0 ? 'Trip assigned' : 'Assigned with some failures',
      body: `${t.plate}: ${ok} stop(s) scheduled${failed ? `, ${failed} failed` : ''}.`,
      tone: failed === 0 ? 'info' : 'error',
    });
    pending.refetch();
    list.refetch();
  };

  /* A3: assign an overflow group to a 3PL carrier. Reuses the SAME schedule
     write-path as an own-fleet trip — the carrier is an OUTSOURCE lorry, so the
     backend flags the trip is_outsourced and records the captured cost. A 3PL
     trip does NOT consume an own-fleet slot. */
  const assignThreePl = async (o: OverflowGroup) => {
    const pick = threePl[o.key] ?? {};
    if (!pick.carrierId) { notify({ title: 'Pick a 3PL carrier', body: 'Choose a carrier for this overflow trip before assigning.', tone: 'error' }); return; }
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
          // Capture the cost once (on the trip CREATE — the first stop mints it).
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
    pending.refetch();
    list.refetch();
  };

  /* ── Trip detail — the "Time arranged" tab's content. ─────────────────────── */
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
        description="Date-confirmed orders flow in automatically — propose or schedule each onto a lorry-day trip with a crew, a stop sequence and depart times."
      />

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
      </div>

      <DeliveryPlanningBoard
        orders={timeRows}
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
        /* Default queue order on entry (owner 2026-08-07): delivery date
           OLDEST first, then state, then postcode — both sides. A clicked
           column header still overrides. */
        defaultSort={arrangementQueueCompare}
        emptyMessage={timeSide === 'PENDING_TIME'
          ? 'No date-confirmed orders waiting for a time — confirm dates in Delivery Date Arrangement.'
          : 'No orders on a trip yet.'}
        onRowDoubleClick={(o) => { if (o.row_type === 'so') navigate('/scm/sales-orders/' + o.so_doc_no); }}
        bulkExtras={
          <>
            {/* Depart time for the proposed routes — the one genuine input. */}
            <input
              type="time"
              value={departTime}
              onChange={(e) => setDepartTime(e.target.value)}
              title="Depart time for the proposed trips"
              style={{ ...selStyle, width: 100 }}
            />
            <Button
              variant="primary"
              icon={<Wand2 {...ICON} />}
              disabled={proposing || selectedDocNos.length === 0}
              onClick={() => void runProposeTime()}
              title={selectedDocNos.length === 0 ? 'Select one or more sales orders first' : 'Propose lorry, crew, stop sequence and times — each order on its confirmed delivery date'}
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

      {/* ── The propose-time result: editable per-trip cards + 3PL overflow
          (the machinery relocated from Delivery Date Arrangement). */}
      {assign && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <strong style={{ fontSize: 'var(--fs-14)' }}>Proposed trips</strong>
            <span style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
              {assign.trips.length} trip(s) · {assign.dispatchableCount}/{assign.lorryCount} lorry(ies) available
              {!assign.configured ? ' · route off (no maps key) — crew + grouping only' : assign.depot ? '' : ' · depot not geocoded'}
            </span>
          </div>

          {assign.excludedLorries.length > 0 && (
            <div style={{ fontSize: 'var(--fs-12)', color: 'var(--c-warning, #b45309)' }}>
              Excluded by fleet status: {assign.excludedLorries.map((l) => `${l.plate} (${l.status})`).join(', ')}
            </div>
          )}

          {assign.excludedDrivers.length > 0 && (
            <div style={{ fontSize: 'var(--fs-12)', color: 'var(--c-warning, #b45309)' }}>
              On leave (not auto-assigned): {assign.excludedDrivers.map((d) => `${d.name ?? d.id} (${d.from}–${d.to}${d.reason ? `, ${d.reason}` : ''})`).join(', ')}
            </div>
          )}

          {assign.overflow.length > 0 && (
            <OverflowSection
              overflow={assign.overflow}
              carriers={assign.carriers}
              pick={threePl}
              onPick={setThreePlPick}
              onAssign={assignThreePl}
              assigningKey={assigning3pl}
            />
          )}

          {assign.trips.map((t) => (
            <AssignTripCard
              key={t.key}
              trip={t}
              eff={effectiveTrip(t)}
              lorries={lorries.map((l) => ({ id: l.id, plate: l.plate }))}
              drivers={drivers.map((d) => ({ id: d.id, name: d.name }))}
              helpers={helpers.map((h) => ({ id: h.id, name: h.name }))}
              leaveRows={crewLeave.data}
              onOverride={(patch) => setOverride(t.key, patch)}
              onApply={() => applyTrip(t)}
              applyBusy={applyingAssign}
            />
          ))}

          {assign.unassigned.length > 0 && (
            <div style={{ padding: '12px 16px', borderRadius: 10, border: '1px solid var(--border, rgba(0,0,0,0.1))' }}>
              <h3 style={{ margin: '0 0 8px', fontSize: 'var(--fs-14)' }}>Could not crew ({assign.unassigned.length})</h3>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
                {assign.unassigned.map((u, i) => (
                  <li key={u.key ?? `${i}`}><strong>{u.orders.join(', ')}</strong> — {u.reason}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* ── Trip detail — only under the "Time arranged" side: the trip list is
          the trip-level view of the same fact the board's TIME_ARRANGED rows
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
              <p className="p-4 text-[13px] text-ink-muted">No trips yet — arrange times above to create them.</p>
            )}
            <ul className="divide-y divide-border">
              {trips.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() => { setSelected(t.id); setPreview(null); }}
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

/* ── Relocated propose-time components (from the old Auto-Schedule page) ────── */

type CrewOpt = { id: string; name: string };
type LorryOpt = { id: string; plate: string };

const fmtRm = (centi: number): string => `RM ${(centi / 100).toLocaleString('en-MY', { maximumFractionDigits: 0 })}`;

const AssignTripCard = ({ trip, eff, lorries, drivers, helpers, leaveRows, onOverride, onApply, applyBusy }: {
  trip: AssignedTrip;
  eff: { lorryId: string | null; driverId: string | null; helperId: string | null };
  lorries: LorryOpt[];
  drivers: CrewOpt[];
  helpers: CrewOpt[];
  leaveRows: CrewLeaveRow[] | undefined;
  onOverride: (patch: { lorryId?: string | null; driverId?: string | null; helperId?: string | null }) => void;
  onApply: () => void;
  applyBusy: boolean;
}) => {
  const seq = trip.sequence;

  // Leave is per-DATE, and this card owns one date — so the marking is computed
  // here, not at page level where the proposal spans many days.
  const driverOpts = drivers.map((d) => ({
    id: d.id, label: d.name, note: crewLeaveLabel(findCrewLeave(leaveRows, 'driver', d.id, trip.date)),
  }));
  const helperOpts = helpers.map((h) => ({
    id: h.id, label: h.name, note: crewLeaveLabel(findCrewLeave(leaveRows, 'helper', h.id, trip.date)),
  }));
  // The ordered rows to show: the sequenced route if present, else the plain stops.
  const rows = seq
    ? seq.sequence.map((s) => {
        const info = trip.stops.find((st) => st.ref === s.ref);
        return {
          ref: s.ref, order: s.order, debtorName: info?.debtorName ?? null, address: info?.address ?? '',
          buildingType: info?.buildingType ?? null,
          arrivalTime: s.arrivalTime, finishTime: s.finishTime,
          earliestTime: s.earliestTime, latestTime: s.latestTime, windowViolated: s.windowViolated,
        };
      })
    : trip.stops.map((s, i) => ({
        ref: s.ref, order: i + 1, debtorName: s.debtorName, address: s.address, buildingType: s.buildingType,
        arrivalTime: null as string | null, finishTime: null as string | null,
        earliestTime: s.earliestTime, latestTime: s.latestTime, windowViolated: false,
      }));

  return (
    <div style={{ borderRadius: 10, border: '1px solid var(--border, rgba(0,0,0,0.12))', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '10px 14px', background: 'var(--bg-subtle, rgba(0,0,0,0.03))' }}>
        <strong style={{ fontSize: 'var(--fs-13)' }}>{trip.date}</strong>
        <span style={{ fontSize: 'var(--fs-11)', padding: '2px 8px', borderRadius: 999, background: 'var(--bg, rgba(0,0,0,0.06))' }}>
          {trip.group === 'KLANG_VALLEY' ? 'Klang Valley (mixed)' : trip.group}
        </span>
        <span style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
          {trip.stops.length} stop(s) · {trip.sets} sets · {fmtRm(trip.revenueCenti)}
        </span>
        {trip.overCeiling && <MiniBadge tone="danger">Over ceiling</MiniBadge>}
        {seq && seq.windowViolations > 0 && <MiniBadge tone="warn">{seq.windowViolations} window issue(s)</MiniBadge>}
        <div style={{ flex: 1 }} />
        {seq && (
          <span style={{ fontSize: 'var(--fs-11)', color: 'var(--fg-muted)' }}>
            back {seq.returnTime ?? '—'} · {Math.round(seq.totalDistanceMetres / 100) / 10} km
          </span>
        )}
      </div>

      {/* Editable crew + lorry — the auto-assignment, all overridable. */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', padding: '10px 14px', borderTop: '1px solid var(--border, rgba(0,0,0,0.08))' }}>
        <AssignSelect label="Lorry" value={eff.lorryId} onChange={(v) => onOverride({ lorryId: v })}
          options={lorries.map((l) => ({ id: l.id, label: l.plate }))} placeholder="— pick a lorry —" />
        <AssignSelect label="Driver" value={eff.driverId} onChange={(v) => onOverride({ driverId: v })}
          options={driverOpts} placeholder="— none —" />
        <AssignSelect label="Helper" value={eff.helperId} onChange={(v) => onOverride({ helperId: v })}
          options={helperOpts} placeholder="— none —" />
        <div style={{ flex: 1 }} />
        <div style={{ display: 'flex', alignItems: 'flex-end' }}>
          <Button variant="primary" icon={<CalendarCheck {...ICON} />} onClick={onApply} disabled={applyBusy || !eff.lorryId}>
            {applyBusy ? 'Applying…' : 'Apply this trip'}
          </Button>
        </div>
      </div>

      {trip.routeReason && (
        <div style={{ padding: '6px 14px', fontSize: 'var(--fs-11)', color: 'var(--fg-muted)', borderTop: '1px solid var(--border, rgba(0,0,0,0.06))' }}>
          {trip.routeReason}
        </div>
      )}

      {/* Ordered stops with ETA + delivery window. */}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--fs-12)' }}>
          <thead>
            <tr style={{ textAlign: 'left', color: 'var(--fg-muted)' }}>
              <Th>#</Th><Th>Order</Th><Th>Customer</Th><Th>House</Th><Th>ETA</Th><Th>Done</Th><Th>Window</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.ref} style={{ borderTop: '1px solid var(--border, rgba(0,0,0,0.06))' }}>
                <Td>{r.order}</Td>
                <Td><strong>{r.ref}</strong></Td>
                <Td>{r.debtorName ?? '—'}</Td>
                <Td>{r.buildingType ?? '—'}</Td>
                <Td>{r.arrivalTime ?? '—'}</Td>
                <Td>{r.finishTime ?? '—'}</Td>
                <Td>
                  {r.earliestTime || r.latestTime ? `${r.earliestTime ?? ''}–${r.latestTime ?? ''}` : 'any'}
                  {r.windowViolated && <span style={{ color: 'var(--c-warning, #b45309)' }}> !</span>}
                </Td>
              </tr>
            ))}
            {rows.length > 0 && rows.filter((r) => trip.ungeocoded.includes(r.ref)).length === 0 && trip.ungeocoded.length > 0 && (
              <tr><Td>—</Td><Td colSpan={6}>Not geocoded: {trip.ungeocoded.join(', ')}</Td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

// A3 — the day's overflow: groups the own fleet could not cover. The dispatcher
// picks a region 3PL carrier (an OUTSOURCE lorry) and captures the trip cost (the
// seam Module C's rate-card will compute against), then assigns it via the same
// schedule write-path — a 3PL trip does not consume an own-fleet slot.
const OverflowSection = ({ overflow, carriers, pick, onPick, onAssign, assigningKey }: {
  overflow: OverflowGroup[];
  carriers: ThreePlCarrier[];
  pick: Record<string, { carrierId?: string | null; costRm?: string }>;
  onPick: (key: string, patch: { carrierId?: string | null; costRm?: string }) => void;
  onAssign: (o: OverflowGroup) => void;
  assigningKey: string | null;
}) => (
  <div style={{ borderRadius: 10, border: '1px solid rgba(217,119,6,0.4)', overflow: 'hidden' }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '10px 14px', background: 'rgba(217,119,6,0.08)' }}>
      <strong style={{ fontSize: 'var(--fs-13)' }}>3PL overflow ({overflow.length})</strong>
      <span style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
        Own fleet is full for these — assign a 3PL carrier and capture the cost.
      </span>
    </div>
    {carriers.length === 0 && (
      <div style={{ padding: '8px 14px', fontSize: 'var(--fs-12)', color: 'var(--c-warning, #b45309)' }}>
        No 3PL carrier on file for this region. Add an OUTSOURCE lorry (non-internal) in Fleet to assign overflow.
      </div>
    )}
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {overflow.map((o) => {
        const p = pick[o.key] ?? {};
        const busy = assigningKey === o.key;
        return (
          <div key={o.key} style={{ padding: '10px 14px', borderTop: '1px solid var(--border, rgba(0,0,0,0.08))' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <strong style={{ fontSize: 'var(--fs-13)' }}>{o.date}</strong>
              <span style={{ fontSize: 'var(--fs-11)', padding: '2px 8px', borderRadius: 999, background: 'var(--bg, rgba(0,0,0,0.06))' }}>
                {o.group === 'KLANG_VALLEY' ? 'Klang Valley (mixed)' : o.group}
              </span>
              <span style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
                {o.orders.length} order(s) · {o.sets} sets · {fmtRm(o.revenueCenti)}
              </span>
            </div>
            <div style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)', margin: '4px 0' }}>{o.orders.join(', ')}</div>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <AssignSelect label="3PL carrier" value={p.carrierId ?? null} onChange={(v) => onPick(o.key, { carrierId: v })}
                options={carriers.map((c) => ({ id: c.id, label: c.plate }))} placeholder="— pick a carrier —" />
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={{ fontSize: 'var(--fs-11)', color: 'var(--fg-muted)' }}>Captured cost (RM)</span>
                <input type="number" min="0" value={p.costRm ?? ''} onChange={(e) => onPick(o.key, { costRm: e.target.value })}
                  placeholder="0" style={{ ...selStyle, width: 120 }} />
              </label>
              <Button variant="primary" icon={<CalendarCheck {...ICON} />} onClick={() => onAssign(o)} disabled={busy || !p.carrierId || carriers.length === 0}>
                {busy ? 'Assigning…' : 'Assign 3PL'}
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  </div>
);

/* `note` marks an option without removing it — an on-leave driver stays
   selectable because the dispatcher has always had the final say. */
const AssignSelect = ({ label, value, onChange, options, placeholder }: {
  label: string; value: string | null; onChange: (v: string | null) => void;
  options: { id: string; label: string; note?: string }[]; placeholder: string;
}) => {
  const selectedNote = options.find((o) => o.id === value)?.note;
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 'var(--fs-11)', color: 'var(--fg-muted)' }}>{label}</span>
      <select value={value ?? ''} onChange={(e) => onChange(e.target.value || null)} style={{ ...selStyle, minWidth: 150 }}>
        <option value="">{placeholder}</option>
        {value && !options.some((o) => o.id === value) && <option value={value}>(current)</option>}
        {options.map((o) => (
          <option key={o.id} value={o.id}>{o.note ? `${o.label} · ${o.note}` : o.label}</option>
        ))}
      </select>
      {selectedNote && (
        <span style={{ fontSize: 'var(--fs-11)', color: 'var(--c-warning, #b45309)' }}>{selectedNote}</span>
      )}
    </label>
  );
};

const MiniBadge = ({ tone, children }: { tone: 'warn' | 'danger'; children: ReactNode }) => (
  <span style={{
    fontSize: 'var(--fs-11)', padding: '1px 7px', borderRadius: 999,
    background: tone === 'danger' ? 'rgba(220,38,38,0.12)' : 'rgba(217,119,6,0.14)',
    color: tone === 'danger' ? 'var(--c-danger, #b91c1c)' : 'var(--c-warning, #b45309)',
  }}>{children}</span>
);

const Th = ({ children }: { children: ReactNode }) => (
  <th style={{ padding: '6px 10px', fontWeight: 500 }}>{children}</th>
);
const Td = ({ children, colSpan }: { children: ReactNode; colSpan?: number }) => (
  <td colSpan={colSpan} style={{ padding: '6px 10px' }}>{children}</td>
);

const selStyle: CSSProperties = {
  padding: '6px 10px', borderRadius: 8, border: '1px solid var(--border, rgba(0,0,0,0.2))',
  background: 'var(--bg, #fff)', color: 'var(--fg, inherit)', fontSize: 'var(--fs-13)',
};
