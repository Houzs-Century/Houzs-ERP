// ----------------------------------------------------------------------------
// Last Mile Delivery — stage 4 (EXECUTION) of the delivery pipeline (Planning
// -> Date -> Time -> Last Mile). Owner spec 2026-08-07/08.
//
// Time-arranged orders flow in automatically: the board rows are simply the SO
// rows whose live trip sits on the picked date (the server stamps trip_id /
// trip_no / trip_date on every row; lib/last-mile.ts folds the split — see its
// header). Same page skeleton as the rest of the family: PageHeader -> split
// chips (All / Time arranged / Delivered, counts for the day) -> region chips
// -> the shared DeliveryPlanningBoard. The crew columns (Driver / Lorry inline
// cells + the bulk bar) write through the ONE existing schedule path, making
// this the central place to view and manage drivers, lorries and helpers on
// the day.
//
// The A4 day MAP stays as the page's visual: every trip that day, each lorry's
// route in its own colour, the side panel of lorries + crew, the focused stop
// list, and the printable driver run-sheet link. The map reads GET /trips/day
// (READ-only) exactly as before.
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { MapPin, Printer, Truck, Users } from 'lucide-react';
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
  type PlanningOrder,
} from '../../vendor/scm/lib/delivery-planning-queries';
import {
  lastMileSideOf,
  LAST_MILE_SIDE_LABEL,
  type LastMileSide,
} from '../../vendor/scm/lib/last-mile';
import {
  DeliveryPlanningBoard,
  regionTabsFrom,
} from '../../vendor/scm/components/DeliveryPlanningBoard';
import { arrangementQueueCompare } from '../../vendor/scm/lib/arrangement-sort';
import { useDrivers } from '../../vendor/scm/lib/drivers-queries';
import { useLorries } from '../../vendor/scm/lib/lorries-queries';

const MAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined;

function driverLine(t: FleetDayTrip): string {
  const parts = [t.driver?.name, ...(t.helpers.map((h) => h.name))].filter(Boolean);
  return parts.length ? parts.join(', ') : 'No crew assigned';
}

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

  /* Crew management rides the existing shared write path — the board's inline
     Driver / Lorry cells and the bulk bar, nothing new. */
  const sched = useScheduleDelivery();
  const { data: drivers = [] } = useDrivers();
  const { data: lorries = [] } = useLorries();
  const [sel, setSel] = useState<Set<string>>(new Set());

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
                {trips.map((t) => {
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
