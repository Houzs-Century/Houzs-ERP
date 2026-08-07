// ----------------------------------------------------------------------------
// Auto-Schedule — Fleet Module A1. The dispatcher's daily "fit the pending
// orders into days" job, automated: pick a DEPOT + a START DATE, and the packer
// derives each pending order's ZONE (from its postcode) + SET count (from its SO
// lines) and PACKS them into lorry-days under each lorry's capacity ceiling
// (first-ceiling-wins; Klang Valley mixes, far zones run dedicated + accumulate).
//
// The result is a REVERSIBLE, DISPLAY-ONLY proposal grouped day -> group ->
// lorry. Nothing is written until the owner clicks "Apply proposed dates", which
// writes each order's amended_delivery_date through the ESTABLISHED schedule
// path (PATCH /delivery-planning/so/:id/schedule) — never customer_delivery_date,
// and no lorry assignment (that is A2). A day can be LOCKED (frozen) once the
// owner is happy, and unlocked again.
//
// Source of pending orders: the same board the dispatcher already uses
// (useDeliveryPlanning state=PENDING_SCHEDULE) — no parallel queue.
// ----------------------------------------------------------------------------

import { useMemo, useState, type ReactNode, type CSSProperties } from 'react';
import { Button } from '@2990s/design-system';
import { Lock, Unlock, Wand2, CalendarCheck, Route, Users } from 'lucide-react';
import { PageHeader } from '../../components/Layout';
import { useDeliveryPlanning } from '../../vendor/scm/lib/delivery-planning-queries';
import { useScheduleDelivery } from '../../vendor/scm/lib/delivery-planning-queries';
import {
  useProposeDelivery,
  useSequenceAssign,
  useDayLocks,
  useLockDay,
  useUnlockDay,
  type ProposeResponse,
  type PackedDay,
  type SequenceAssignResponse,
  type AssignedTrip,
  type OverflowGroup,
  type ThreePlCarrier,
} from '../../vendor/scm/lib/delivery-zones-queries';
import { useDrivers } from '../../vendor/scm/lib/drivers-queries';
import { useHelpers } from '../../vendor/scm/lib/helpers-queries';
import { useDriverLeave } from '../../vendor/scm/lib/delivery-zones-queries';
import { findCrewLeave, crewLeaveLabel, type CrewLeaveRow } from '../../vendor/shared/crew-leave';
import { useLorries } from '../../vendor/scm/lib/lorries-queries';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';

const ICON = { size: 16, strokeWidth: 1.75 } as const;
const ALL_DEPOTS = '__ALL__';

function todayMY(): string {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
const rm = (centi: number): string => `RM ${(centi / 100).toLocaleString('en-MY', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

const groupLabel = (g: string): string => (g === 'KLANG_VALLEY' ? 'Klang Valley (mixed)' : g);

export const AutoSchedule = () => {
  const board = useDeliveryPlanning({ region: 'ALL', state: 'PENDING_SCHEDULE' });
  const propose = useProposeDelivery();
  const seqAssign = useSequenceAssign();
  const schedule = useScheduleDelivery();
  const drivers = useDrivers();
  const helpers = useHelpers();
  // A3 folded leave into the AUTO assigner only; the manual pickers below mark
  // an on-leave driver/helper per TRIP DATE so the override is informed.
  const crewLeave = useDriverLeave();
  const lorries = useLorries();
  const notify = useNotify();
  const askConfirm = useConfirm();

  const [depot, setDepot] = useState<string>(ALL_DEPOTS);
  const [startDate, setStartDate] = useState<string>(todayMY());
  const [departTime, setDepartTime] = useState<string>('09:00');
  const [maxSets, setMaxSets] = useState<string>('10');
  const [maxRevenueRm, setMaxRevenueRm] = useState<string>('30000');
  const [maxTripsPerLorry, setMaxTripsPerLorry] = useState<string>('1');
  const [result, setResult] = useState<ProposeResponse | null>(null);
  const [applying, setApplying] = useState(false);
  const [assign, setAssign] = useState<SequenceAssignResponse | null>(null);
  // Per-trip dispatcher overrides of the auto-assigned lorry / driver / helper.
  const [overrides, setOverrides] = useState<Record<string, { lorryId?: string | null; driverId?: string | null; helperId?: string | null }>>({});
  const [applyingAssign, setApplyingAssign] = useState(false);
  // A3: per-overflow-group 3PL choice — the carrier lorry + captured cost (RM).
  const [threePl, setThreePl] = useState<Record<string, { carrierId?: string | null; costRm?: string }>>({});
  const [assigning3pl, setAssigning3pl] = useState<string | null>(null);

  // SO pending-schedule orders, and the depot options derived from them.
  const soOrders = useMemo(
    () => (board.data?.orders ?? []).filter((o) => o.row_type === 'so' && o.so_doc_no),
    [board.data],
  );
  const depots = useMemo(() => {
    const m = new Map<string, string>();
    for (const o of soOrders) {
      if (o.warehouse_id) m.set(o.warehouse_id, o.warehouse_name || o.warehouse_code || o.warehouse_id);
    }
    return [...m.entries()].map(([id, name]) => ({ id, name }));
  }, [soOrders]);

  const depotDocNos = useMemo(
    () => soOrders
      .filter((o) => depot === ALL_DEPOTS || o.warehouse_id === depot)
      .map((o) => o.so_doc_no)
      .filter((v): v is string => !!v),
    [soOrders, depot],
  );

  const locks = useDayLocks({ warehouseId: depot === ALL_DEPOTS ? null : depot });
  const lockedDates = useMemo(() => new Set((locks.data ?? []).map((l) => l.deliveryDate)), [locks.data]);
  const lockByDate = useMemo(() => new Map((locks.data ?? []).map((l) => [l.deliveryDate, l])), [locks.data]);
  const lockDay = useLockDay();
  const unlockDay = useUnlockDay();

  const runPropose = () => {
    if (depotDocNos.length === 0) { notify({ title: 'Nothing to schedule', body: 'No pending-schedule orders for this depot.', tone: 'error' }); return; }
    const sets = Number(maxSets);
    const revRm = Number(maxRevenueRm);
    propose.mutate({
      soDocNos: depotDocNos,
      depotWarehouseId: depot === ALL_DEPOTS ? null : depot,
      startDate,
      defaultMaxSets: Number.isInteger(sets) && sets > 0 ? sets : undefined,
      defaultMaxRevenueCenti: Number.isFinite(revRm) && revRm > 0 ? Math.round(revRm * 100) : undefined,
    }, {
      onSuccess: (r) => setResult(r),
      onError: (err) => notify({ title: 'Propose failed', body: err instanceof Error ? err.message : 'Something went wrong.', tone: 'error' }),
    });
  };

  const applyAll = async () => {
    if (!result || result.proposals.length === 0) return;
    if (!(await askConfirm({
      title: `Apply ${result.proposals.length} proposed delivery dates?`,
      body: 'Writes each order’s amended delivery date (never the customer date). No lorry is assigned. You can re-run and re-apply anytime.',
      confirmLabel: 'Apply dates',
    }))) return;
    setApplying(true);
    let ok = 0; let failed = 0;
    // Cap concurrency at 4, like the schedule drawer's fan-out.
    const queue = [...result.proposals];
    const worker = async () => {
      while (queue.length > 0) {
        const p = queue.shift()!;
        try {
          await schedule.mutateAsync({ type: 'so', id: p.ref, scheduleDate: p.deliveryDate });
          ok += 1;
        } catch {
          failed += 1;
        }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    setApplying(false);
    notify({
      title: failed === 0 ? 'Dates applied' : 'Applied with some failures',
      body: `${ok} order(s) dated${failed ? `, ${failed} failed` : ''}.`,
      tone: failed === 0 ? 'info' : 'error',
    });
    board.refetch();
  };

  // A2 — sequence + assign the packed groups for the picked orders. Runs over the
  // same depot docNos; the backend re-packs (deterministic) so its trips line up
  // with the review screen above, then crews + sequences each one.
  const runSequenceAssign = () => {
    if (depotDocNos.length === 0) { notify({ title: 'Nothing to assign', body: 'No pending-schedule orders for this depot.', tone: 'error' }); return; }
    const sets = Number(maxSets);
    const revRm = Number(maxRevenueRm);
    const trips = Number(maxTripsPerLorry);
    seqAssign.mutate({
      soDocNos: depotDocNos,
      depotWarehouseId: depot === ALL_DEPOTS ? null : depot,
      startDate,
      departTime,
      defaultMaxSets: Number.isInteger(sets) && sets > 0 ? sets : undefined,
      defaultMaxRevenueCenti: Number.isFinite(revRm) && revRm > 0 ? Math.round(revRm * 100) : undefined,
      maxTripsPerLorryPerDay: Number.isInteger(trips) && trips > 0 ? trips : undefined,
    }, {
      onSuccess: (r) => { setAssign(r); setOverrides({}); setThreePl({}); },
      onError: (err) => notify({ title: 'Sequence & assign failed', body: err instanceof Error ? err.message : 'Something went wrong.', tone: 'error' }),
    });
  };

  // A3: assign an overflow group to a 3PL carrier. Reuses the SAME schedule
  // write-path as an own-fleet trip — the carrier is an OUTSOURCE lorry, so the
  // backend flags the trip is_outsourced and records the captured cost. A 3PL
  // trip does NOT consume an own-fleet slot.
  const assignThreePl = async (o: SequenceAssignResponse['overflow'][number]) => {
    const pick = threePl[o.key] ?? {};
    if (!pick.carrierId) { notify({ title: 'Pick a 3PL carrier', body: 'Choose a carrier for this overflow trip before assigning.', tone: 'error' }); return; }
    const costRm = Number(pick.costRm);
    const costCenti = Number.isFinite(costRm) && costRm > 0 ? Math.round(costRm * 100) : null;
    setAssigning3pl(o.key);
    let ok = 0; let failed = 0;
    for (let i = 0; i < o.orders.length; i += 1) {
      try {
        await schedule.mutateAsync({
          type: 'so', id: o.orders[i],
          scheduleDate: o.date, tripDate: o.date,
          lorryId: pick.carrierId,
          warehouseId: depot === ALL_DEPOTS ? null : depot,
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
    board.refetch();
  };
  const setThreePlPick = (key: string, patch: { carrierId?: string | null; costRm?: string }) =>
    setThreePl((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));

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

  // Apply ONE trip's assignment: fan out one schedule call per stop, in the
  // proposed order, reusing the established schedule write-path (date + lorry +
  // driver + helper + stop position + ETA). amended_delivery_date only.
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
        await schedule.mutateAsync({
          type: 'so', id: r.ref,
          scheduleDate: t.date, tripDate: t.date,
          lorryId: eff.lorryId, driverId: eff.driverId ?? null,
          helper1Id: eff.helperId ?? null,
          warehouseId: depot === ALL_DEPOTS ? null : depot,
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
    board.refetch();
  };

  const toggleLock = (date: string) => {
    const existing = lockByDate.get(date);
    if (existing) {
      unlockDay.mutate(existing.id, { onError: (e) => notify({ title: 'Unlock failed', body: e instanceof Error ? e.message : '', tone: 'error' }) });
    } else {
      lockDay.mutate({ deliveryDate: date, warehouseId: depot === ALL_DEPOTS ? null : depot }, {
        onError: (e) => notify({ title: 'Lock failed', body: e instanceof Error ? e.message : '', tone: 'error' }),
      });
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Delivery"
        title="Delivery Date Arrangement"
        description="Fit the pending-schedule orders into delivery days automatically. Pick a depot and a start date; each order is grouped by its postcode zone and packed into lorry-days under your per-lorry capacity ceilings. The proposal is reversible — review it, then apply the dates (amended delivery date only) and lock the days you are happy with."
      />

      {/* Controls */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-end', padding: '14px 16px', borderRadius: 10, background: 'var(--bg-subtle, rgba(0,0,0,0.03))' }}>
        <Ctl label="Depot (origin)">
          <select value={depot} onChange={(e) => { setDepot(e.target.value); setResult(null); }} style={selStyle}>
            <option value={ALL_DEPOTS}>All depots</option>
            {depots.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </Ctl>
        <Ctl label="Start date">
          <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} style={selStyle} />
        </Ctl>
        <Ctl label="Depart time">
          <input type="time" value={departTime} onChange={(e) => setDepartTime(e.target.value)} style={{ ...selStyle, width: 110 }} />
        </Ctl>
        <Ctl label="Default max sets / lorry">
          <input type="number" min="1" value={maxSets} onChange={(e) => setMaxSets(e.target.value)} style={{ ...selStyle, width: 90 }} />
        </Ctl>
        <Ctl label="Default max revenue / lorry (RM)">
          <input type="number" min="1" value={maxRevenueRm} onChange={(e) => setMaxRevenueRm(e.target.value)} style={{ ...selStyle, width: 120 }} />
        </Ctl>
        <Ctl label="Max trips / lorry / day">
          <input type="number" min="1" value={maxTripsPerLorry} onChange={(e) => setMaxTripsPerLorry(e.target.value)} style={{ ...selStyle, width: 90 }} />
        </Ctl>
        <div style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)', flex: '1 1 auto' }}>
          {board.isLoading ? 'Loading pending orders…' : `${depotDocNos.length} pending order(s) for this depot`}
        </div>
        <Button variant="primary" size="md" onClick={runPropose} disabled={propose.isPending || board.isLoading}>
          <Wand2 {...ICON} />
          <span>{propose.isPending ? 'Proposing…' : 'Propose schedule'}</span>
        </Button>
      </div>

      {result && (
        <>
          {result.usingDefaultZoneMap && (
            <div style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
              Using the built-in default postcode zone map (no custom rules set). Refine it in Delivery Zones.
            </div>
          )}
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 'var(--fs-13)' }}>
              {result.proposals.length} order(s) placed across {result.days.length} day-trip(s) · {result.lorryCount} lorry(ies) available
            </span>
            <Button variant="primary" size="md" onClick={applyAll} disabled={applying || result.proposals.length === 0}>
              <CalendarCheck {...ICON} />
              <span>{applying ? 'Applying…' : 'Apply proposed dates'}</span>
            </Button>
            <Button variant="secondary" size="md" onClick={runSequenceAssign} disabled={seqAssign.isPending || result.proposals.length === 0}>
              <Route {...ICON} />
              <span>{seqAssign.isPending ? 'Sequencing…' : 'Sequence & assign'}</span>
            </Button>
          </div>

          {result.days.length === 0 && (
            <p style={{ fontSize: 'var(--fs-13)', color: 'var(--fg-muted)' }}>
              Nothing could be packed — check that the depot has active in-house lorries and that orders carry a postcode.
            </p>
          )}

          {result.days.map((day, i) => (
            <DayCard
              key={`${day.date}-${day.group}-${i}`}
              day={day}
              locked={lockedDates.has(day.date)}
              onToggleLock={() => toggleLock(day.date)}
              lockBusy={lockDay.isPending || unlockDay.isPending}
            />
          ))}

          {result.unassigned.length > 0 && (
            <div style={{ padding: '12px 16px', borderRadius: 10, border: '1px solid var(--border, rgba(0,0,0,0.1))' }}>
              <h3 style={{ margin: '0 0 8px', fontSize: 'var(--fs-14)' }}>Needs attention ({result.unassigned.length})</h3>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
                {result.unassigned.map((u) => (
                  <li key={u.ref}><strong>{u.ref}</strong>{u.zone ? ` (${u.zone})` : ''} — {u.reason}</li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      {assign && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <Users {...ICON} />
            <strong style={{ fontSize: 'var(--fs-14)' }}>Sequence &amp; assign</strong>
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

          {assign.trips.map((t) => {
            const eff = effectiveTrip(t);
            const locked = lockedDates.has(t.date);
            return (
              <AssignTripCard
                key={t.key}
                trip={t}
                eff={eff}
                locked={locked}
                lorries={(lorries.data ?? []).map((l) => ({ id: l.id, plate: l.plate }))}
                drivers={(drivers.data ?? []).map((d) => ({ id: d.id, name: d.name }))}
                helpers={(helpers.data ?? []).map((h) => ({ id: h.id, name: h.name }))}
                leaveRows={crewLeave.data}
                onOverride={(patch) => setOverride(t.key, patch)}
                onApply={() => applyTrip(t)}
                applyBusy={applyingAssign}
              />
            );
          })}

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
    </div>
  );
};

type CrewOpt = { id: string; name: string };
type LorryOpt = { id: string; plate: string };

const fmtRm = (centi: number): string => `RM ${(centi / 100).toLocaleString('en-MY', { maximumFractionDigits: 0 })}`;

const AssignTripCard = ({ trip, eff, locked, lorries, drivers, helpers, leaveRows, onOverride, onApply, applyBusy }: {
  trip: AssignedTrip;
  eff: { lorryId: string | null; driverId: string | null; helperId: string | null };
  locked: boolean;
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
    <div style={{ borderRadius: 10, border: `1px solid ${locked ? 'rgba(37,99,235,0.4)' : 'var(--border, rgba(0,0,0,0.12))'}`, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '10px 14px', background: locked ? 'rgba(37,99,235,0.06)' : 'var(--bg-subtle, rgba(0,0,0,0.03))' }}>
        <strong style={{ fontSize: 'var(--fs-13)' }}>{trip.date}</strong>
        <span style={{ fontSize: 'var(--fs-11)', padding: '2px 8px', borderRadius: 999, background: 'var(--bg, rgba(0,0,0,0.06))' }}>
          {trip.group === 'KLANG_VALLEY' ? 'Klang Valley (mixed)' : trip.group}
        </span>
        <span style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
          {trip.stops.length} stop(s) · {trip.sets} sets · {fmtRm(trip.revenueCenti)}
        </span>
        {trip.overCeiling && <MiniBadge tone="danger">Over ceiling</MiniBadge>}
        {seq && seq.windowViolations > 0 && <MiniBadge tone="warn">{seq.windowViolations} window issue(s)</MiniBadge>}
        {!locked && <MiniBadge tone="warn">Day not locked</MiniBadge>}
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
          <Button variant="primary" size="sm" onClick={onApply} disabled={applyBusy || !eff.lorryId}>
            <CalendarCheck {...ICON} />
            <span>{applyBusy ? 'Applying…' : 'Apply this trip'}</span>
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
              <Button variant="primary" size="sm" onClick={() => onAssign(o)} disabled={busy || !p.carrierId || carriers.length === 0}>
                <CalendarCheck {...ICON} />
                <span>{busy ? 'Assigning…' : 'Assign 3PL'}</span>
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

const DayCard = ({ day, locked, onToggleLock, lockBusy }: {
  day: PackedDay; locked: boolean; onToggleLock: () => void; lockBusy: boolean;
}) => {
  const daySets = day.lorries.reduce((s, l) => s + l.sets, 0);
  const dayRevenue = day.lorries.reduce((s, l) => s + l.revenueCenti, 0);
  return (
    <div style={{ borderRadius: 10, border: '1px solid var(--border, rgba(0,0,0,0.12))', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', background: locked ? 'rgba(37,99,235,0.08)' : 'var(--bg-subtle, rgba(0,0,0,0.03))' }}>
        <strong style={{ fontSize: 'var(--fs-14)' }}>{day.date}</strong>
        <span style={{ fontSize: 'var(--fs-12)', padding: '2px 8px', borderRadius: 999, background: 'var(--bg, rgba(0,0,0,0.06))' }}>{groupLabel(day.group)}</span>
        <span style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>{day.lorries.length} lorry-trip(s) · {daySets} sets · {rm(dayRevenue)}</span>
        <div style={{ flex: 1 }} />
        <Button variant={locked ? 'primary' : 'ghost'} size="sm" onClick={onToggleLock} disabled={lockBusy}>
          {locked ? <Lock {...ICON} /> : <Unlock {...ICON} />}
          <span>{locked ? 'Locked' : 'Lock day'}</span>
        </Button>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {day.lorries.map((l) => {
          const setPct = l.ceilingSets ? Math.min(100, Math.round((l.sets / l.ceilingSets) * 100)) : null;
          const revPct = l.ceilingRevenueCenti ? Math.min(100, Math.round((l.revenueCenti / l.ceilingRevenueCenti) * 100)) : null;
          return (
            <div key={l.lorryId} style={{ padding: '10px 14px', borderTop: '1px solid var(--border, rgba(0,0,0,0.08))' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <strong style={{ fontSize: 'var(--fs-13)' }}>{l.plate}</strong>
                <span style={{ fontSize: 'var(--fs-11)', color: 'var(--fg-muted)' }}>
                  {l.sets}{l.ceilingSets != null ? `/${l.ceilingSets}` : ''} sets
                  {setPct != null ? ` (${setPct}%)` : ''}
                  {l.ceilingRevenueCenti != null ? ` · ${rm(l.revenueCenti)}/${rm(l.ceilingRevenueCenti)}${revPct != null ? ` (${revPct}%)` : ''}` : ` · ${rm(l.revenueCenti)}`}
                </span>
                {l.partial && <Badge tone="warn">Partial — not a full load</Badge>}
                {l.overCeiling && <Badge tone="danger">Over ceiling — ships alone</Badge>}
              </div>
              <div style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)', marginTop: 4 }}>
                {l.orders.join(', ')}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

const Badge = ({ tone, children }: { tone: 'warn' | 'danger'; children: ReactNode }) => (
  <span style={{
    fontSize: 'var(--fs-11)', padding: '1px 7px', borderRadius: 999,
    background: tone === 'danger' ? 'rgba(220,38,38,0.12)' : 'rgba(217,119,6,0.14)',
    color: tone === 'danger' ? 'var(--c-danger, #b91c1c)' : 'var(--c-warning, #b45309)',
  }}>{children}</span>
);

const Ctl = ({ label, children }: { label: string; children: ReactNode }) => (
  <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
    <span style={{ fontSize: 'var(--fs-11)', color: 'var(--fg-muted)' }}>{label}</span>
    {children}
  </label>
);

const selStyle: CSSProperties = {
  padding: '6px 10px', borderRadius: 8, border: '1px solid var(--border, rgba(0,0,0,0.2))',
  background: 'var(--bg, #fff)', color: 'var(--fg, inherit)', fontSize: 'var(--fs-13)',
};
