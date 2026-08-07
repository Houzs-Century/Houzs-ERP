// ----------------------------------------------------------------------------
// FleetDay — Fleet Module A4, the DAY MAP. Pick a date + depot and see every
// trip that day: each lorry's route drawn on ONE Google map in its own colour
// (numbered stops 1->2->3, the depot as origin), a side panel of the day's
// lorries, and a link to the printable driver run-sheet.
//
// A READ / RENDER layer over already-scheduled trips (GET /trips/day) — it does
// NOT create or reschedule anything. Reuses the geocode/route infra (the backend
// geocodes cache-first) and the @vis.gl map pattern (FleetDayMap, the multi-route
// sibling of the Phase-3 ScheduleRouteMap). Scheduling stays on the Trips page.
// ----------------------------------------------------------------------------

import { useMemo } from 'react';
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
        description="Every trip on one day, each lorry's route on one map. A view over scheduled trips — plan and assign on the Trips page."
        primaryAction={
          <Button variant="secondary" icon={<Printer size={14} />} onClick={goPrint} disabled={trips.length === 0}>
            Print run-sheet
          </Button>
        }
      />

      {/* controls: date + depot filter */}
      <div className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-surface px-4 py-3">
        <label className="flex items-center gap-2 text-[12.5px] text-ink-secondary">
          <span className="font-semibold text-ink">Date</span>
          <input
            type="date"
            value={date}
            onChange={(e) => setParam('date', e.target.value || null)}
            className="rounded-md border border-border bg-surface px-2 py-1 text-[12.5px] text-ink"
          />
        </label>
        <span className="h-5 w-px bg-border" />
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => setParam('warehouseId', null)}
            className={cn(
              'rounded-full border px-3 py-1 text-[12px]',
              warehouseId === '' ? 'border-accent bg-accent/10 font-semibold text-accent' : 'border-border text-ink-secondary',
            )}
          >
            All depots
          </button>
          {warehouses.map((w) => (
            <button
              key={w.id}
              type="button"
              onClick={() => setParam('warehouseId', w.id)}
              className={cn(
                'rounded-full border px-3 py-1 text-[12px]',
                warehouseId === w.id ? 'border-accent bg-accent/10 font-semibold text-accent' : 'border-border text-ink-secondary',
              )}
            >
              {w.code || w.name}
            </button>
          ))}
        </div>
        <span className="flex-1" />
        <span className="text-[11.5px] text-ink-muted">
          {trips.length} {trips.length === 1 ? 'trip' : 'trips'} · {totalDrops} drops · {fmtCenti(totalRevenue)}
        </span>
      </div>

      {query.isLoading && <p className="p-4 text-[13px] text-ink-muted">Loading the day…</p>}
      {query.error && (
        <p className="rounded-md border border-err/40 bg-err/5 p-4 text-[13px] text-err">
          Could not load this day. {query.error instanceof Error ? query.error.message : ''}
        </p>
      )}

      {!query.isLoading && !query.error && trips.length === 0 && (
        <p className="rounded-md border border-border bg-surface p-6 text-center text-[13px] text-ink-muted">
          No trips scheduled for this day. Schedule deliveries onto a lorry-day from the Trips page.
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
        Read-only day view. Trips are created and assigned on the Trips page; nothing here changes a schedule.
      </p>
    </div>
  );
}
