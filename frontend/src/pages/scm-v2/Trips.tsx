// ----------------------------------------------------------------------------
// Trips — the scheduling layer, finally visible.
//
// scm.trips / trip_stops have existed since mig 0053 and DP orders schedule onto
// them (#738), but there was no page: a trip could only be read through the API,
// and the Google route optimiser (#732 + #757) had no human trigger. This is the
// list + the stop sheet + that trigger.
//
// The optimiser is a DRY RUN by default — you see the proposed order and the
// drive time before anything is written. "Apply" is a second, explicit click,
// because reordering stops changes the run a driver is about to do.
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Route as RouteIcon, MapPin, CalendarClock } from 'lucide-react';
import { PageHeader } from '../../components/Layout';
import { Button } from '../../components/Button';
import { Badge } from '../../components/Badge';
import { cn } from '../../lib/utils';
import {
  useTrips,
  useTrip,
  useOptimizeTripRoute,
  type OptimizeResult,
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
  DeliveryPlanningBoard,
  regionTabsFrom,
  soDocNosFromSelection,
} from '../../vendor/scm/components/DeliveryPlanningBoard';
import { ScheduleTripDrawer } from '../../vendor/scm/components/ScheduleTripDrawer';
import { LiveTripMap, type LiveMarker } from '../../vendor/scm/components/LiveTripMap';
import { useTripLatestLocations } from '../../vendor/scm/lib/trip-locations-queries';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';

// Owner ordering: IN_PROGRESS reads before PLANNED (dispatchers watch running
// trips first). The default-selected tab stays PLANNED (see useState below) —
// the working queue a dispatcher plans from, not the trips already rolling.
const STATUSES = ['ALL', 'IN_PROGRESS', 'PLANNED', 'COMPLETED', 'CANCELLED'] as const;

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
  const [status, setStatus] = useState<string>('PLANNED');
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<OptimizeResult | null>(null);

  const list = useTrips({ status });
  const detail = useTrip(selected);
  const optimize = useOptimizeTripRoute();
  const notify = useNotify();
  const askConfirm = useConfirm();

  // The TIME-ARRANGEMENT queue (owner pipeline, 2026-08-07): the EXACT Delivery
  // Planning board (shared <DeliveryPlanningBoard>) LOCKED to
  // state=PENDING_SCHEDULE — same columns, region chips, expandable line-item
  // detail and multiselect — scoped to the region chip. Reuses the board's own
  // endpoint (GET /delivery-planning?region=<r>&state=PENDING_SCHEDULE) and its
  // PENDING_SCHEDULE derivation: no new query, no new state logic. Split by the
  // server-derived arrangement stage (never re-derived here):
  //   Pending Time Arrangement — date confirmed, not yet on a trip. The INBOX:
  //     every order Delivery Date Arrangement confirms flows in automatically.
  //   Time arranged — already assigned onto a live trip (the trip list above is
  //     the trip-level view of the same fact).
  // Orders still AWAITING a date belong to Delivery Date Arrangement and are
  // counted in a note here, not mixed into the inbox.
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

  // Shared write path + option lists for the board's inline cells + bulk bar.
  const sched = useScheduleDelivery();
  const { data: drivers = [] } = useDrivers();
  const { data: lorries = [] } = useLorries();

  // Multiselect on the "To schedule" board → the Phase-2 ScheduleTripDrawer.
  const [pendingSel, setPendingSel] = useState<Set<string>>(new Set());
  const [scheduling, setScheduling] = useState(false);
  const pendingSelDocNos = (): string[] => soDocNosFromSelection(pendingSel);
  // The SO order objects behind the selection — fed to the drawer as its stop
  // list (SO-only, like every board bulk action).
  const pendingSelectedOrders = useMemo<PlanningOrder[]>(() => {
    const docs = new Set(pendingSelDocNos());
    return pendingOrders.filter((o) => o.row_type === 'so' && docs.has(o.so_doc_no));
  }, [pendingOrders, pendingSel]); // eslint-disable-line react-hooks/exhaustive-deps

  const trips = useMemo(() => list.data?.trips ?? [], [list.data]);
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
        description="A lorry-day: one lorry, a crew, and an ordered list of stops. Optimise the order with Google before the driver leaves."
      />

      {/* status filter */}
      <div className="flex flex-wrap gap-1.5">
        {STATUSES.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => { setStatus(s); setSelected(null); setPreview(null); }}
            className={cn(
              'rounded-full border px-3 py-1 text-[12px]',
              status === s ? 'border-accent bg-accent/10 font-semibold text-accent' : 'border-border text-ink-secondary',
            )}
          >
            {s === 'ALL' ? 'All' : s.replace('_', ' ').toLowerCase()}
          </button>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,360px)_1fr]">
        {/* ── trip list ── */}
        <div className="rounded-md border border-border bg-surface">
          {list.isLoading && <p className="p-4 text-[13px] text-ink-muted">Loading trips…</p>}
          {!list.isLoading && trips.length === 0 && (
            <p className="p-4 text-[13px] text-ink-muted">No trips in this state.</p>
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

      {/* ── Time arrangement: date-confirmed orders flowing in from Delivery
          Date Arrangement ─────────────────────────────────────────────────────
          The EXACT Delivery Planning board, LOCKED to PENDING_SCHEDULE (no
          state-tab row), split by the derived time side: the "Pending Time
          Arrangement" INBOX (date confirmed, no trip yet — no manual re-entry,
          the schedule write is the hand-off) and "Time arranged" (already on a
          live trip). Same columns, region chips, expandable line-item detail
          and multiselect. Ticking orders and clicking "Schedule (N)" opens the
          Phase-2 ScheduleTripDrawer → Apply via the existing schedule mutation,
          so the whole select → schedule → apply flow runs from inside Trips. */}
      <div className="rounded-md border border-border bg-surface p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="text-[13px] font-semibold text-ink">Time arrangement</span>
          <Badge tone="neutral" caseless>{timeCounts.PENDING_TIME} to arrange</Badge>
          <span className="flex-1" />
          <span className="text-[11.5px] text-ink-muted">Tick orders, then Schedule to put them on a trip</span>
        </div>
        <div className="mb-3 flex flex-wrap items-center gap-1.5">
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
          storageKey="dg-trips-to-schedule"
          exportName="TripsTimeArrangement"
          emptyMessage={timeSide === 'PENDING_TIME'
            ? 'No date-confirmed orders waiting for a time — confirm dates in Delivery Date Arrangement.'
            : 'No orders on a trip yet.'}
          onRowDoubleClick={(o) => { if (o.row_type === 'so') navigate('/scm/sales-orders/' + o.so_doc_no); }}
          bulkExtras={
            <Button
              variant="secondary"
              disabled={pendingSelDocNos().length === 0}
              onClick={() => setScheduling(true)}
              title={pendingSelDocNos().length === 0 ? 'Select one or more sales orders first' : 'Schedule the selected orders onto a trip'}
            >
              <CalendarClock size={14} strokeWidth={1.75} />
              <span>Schedule ({pendingSelDocNos().length})</span>
            </Button>
          }
          contextMenu={(row) => (row.row_type === 'so'
            ? [{ label: 'Open Sales Order', onClick: () => navigate('/scm/sales-orders/' + row.so_doc_no) }]
            : [])}
        />
      </div>

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
