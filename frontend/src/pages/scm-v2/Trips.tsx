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
import { Route as RouteIcon, MapPin } from 'lucide-react';
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
  type PlanningOrder,
} from '../../vendor/scm/lib/delivery-planning-queries';
import { fmtDateOrDash } from '../../vendor/shared/format';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';

// Owner ordering: IN_PROGRESS reads before PLANNED (dispatchers watch running
// trips first). The default-selected tab stays PLANNED (see useState below) —
// the working queue a dispatcher plans from, not the trips already rolling.
const STATUSES = ['ALL', 'IN_PROGRESS', 'PLANNED', 'COMPLETED', 'CANCELLED'] as const;

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
  const [status, setStatus] = useState<string>('PLANNED');
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<OptimizeResult | null>(null);

  const list = useTrips({ status });
  const detail = useTrip(selected);
  const optimize = useOptimizeTripRoute();
  const notify = useNotify();
  const askConfirm = useConfirm();

  // "To schedule" queue: ready-to-ship orders not yet on a trip. Reuses the
  // delivery board's own endpoint (GET /delivery-planning?state=PENDING_SCHEDULE)
  // and its PENDING_SCHEDULE derivation — no new query, no new state logic.
  // READ-ONLY for now; multiselect + scheduling actions are the next slice.
  const pending = useDeliveryPlanning({ region: 'ALL', state: 'PENDING_SCHEDULE' });
  const pendingOrders = useMemo<PlanningOrder[]>(
    () => pending.data?.orders ?? [],
    [pending.data],
  );

  const trips = useMemo(() => list.data?.trips ?? [], [list.data]);
  const stops = detail.data?.stops ?? [];
  const trip = detail.data?.trip ?? null;

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
        title="Trips"
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

      {/* ── To schedule: ready-to-ship orders not yet on a trip ──────────────
          Pulled straight from the delivery board (PENDING_SCHEDULE), read-only.
          Making them visible in Trips is this slice; multiselect + Date/Time
          scheduling actions are the next phase. */}
      <div className="rounded-md border border-border bg-surface">
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-3">
          <span className="text-[13px] font-semibold text-ink">To schedule</span>
          <Badge tone="neutral" caseless>{pendingOrders.length} ready to ship</Badge>
          <span className="flex-1" />
          <span className="text-[11.5px] text-ink-muted">Read-only — scheduling actions coming next</span>
        </div>

        {pending.isLoading && (
          <p className="p-5 text-[13px] text-ink-muted">Loading pending orders…</p>
        )}
        {!pending.isLoading && pendingOrders.length === 0 && (
          <p className="p-5 text-[13px] text-ink-muted">No orders waiting to be scheduled.</p>
        )}
        {!pending.isLoading && pendingOrders.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[12.5px]">
              <thead>
                <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-ink-muted">
                  <th className="px-5 py-2 font-semibold">SO / Ref</th>
                  <th className="px-3 py-2 font-semibold">Customer</th>
                  <th className="px-3 py-2 font-semibold">Region</th>
                  <th className="px-3 py-2 font-semibold">Stock</th>
                  <th className="px-3 py-2 text-right font-semibold">Qty</th>
                  <th className="px-5 py-2 font-semibold">Delivery Date</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {pendingOrders.map((o) => (
                  <tr key={`${o.row_type}:${o.so_doc_no}`} className="hover:bg-surface-raised">
                    <td className="px-5 py-2.5 font-mono font-semibold text-ink">
                      {o.so_doc_no || o.ref || '—'}
                    </td>
                    <td className="px-3 py-2.5 text-ink-secondary">
                      {o.debtor_name ?? o.debtor_code ?? '—'}
                    </td>
                    <td className="px-3 py-2.5 text-ink-secondary">{o.region || '—'}</td>
                    <td className="px-3 py-2.5 text-ink-muted">
                      {o.stock_remark || o.stock_status || '—'}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-ink-secondary">
                      {o.remaining_qty == null ? '—' : Math.round(o.remaining_qty)}
                    </td>
                    <td className="px-5 py-2.5 tabular-nums text-ink-secondary">
                      {fmtDateOrDash(o.effective_delivery_date ?? o.customer_delivery_date)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
