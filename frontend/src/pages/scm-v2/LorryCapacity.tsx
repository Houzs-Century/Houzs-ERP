// ----------------------------------------------------------------------------
// Lorry Capacity — STAGE 5B (final) of the Delivery / TMS module.
//
// The fleet performance dashboard. For a date range (Last / This / Next month,
// or a Custom from–to) and a fleet filter (All / In-house / Outsourced) it shows
// a summary metric-card row + a per-lorry metric table replicating the owner's
// Houzs "Lorry Capacity" page: Work Days · Repair Days (editable) · Available
// Days · Utilisation · Total Trips · Delivery Days · Deliveries · Orders/Trip ·
// Setup/Dismantle · Pickups · Services · Delivery Revenue · Revenue/Order ·
// Revenue/Trip. The header reports the working-day count (Mon–Sat) in range.
//
// All metrics + the working-day count are computed server-side (GET
// /lorry-capacity); this page renders them and drives the two inline edits:
// the In-house checkbox (PATCH …/in-house) and the Repair Days number (PUT
// …/repair-days, which writes a single dashboard-managed maintenance window for
// the queried range). Range + fleet live in the URL (useSearchParams) so a
// link / refresh keeps the view.
//
// Style: app design system (2026-07-16 reskin) — shared <PageHeader>, <StatCard>
// KPI tiles and Tailwind "Ink & Petrol" tokens; only the dense metric table
// keeps a CSS module. Utilisation is tinted (low → red-ish, healthy → green-ish),
// like Houzs. Money is integer cents from the API → fmtSen for the RM display.
// Every number is rounded.
// ----------------------------------------------------------------------------

import { dailyTotalsByLorry, diffPct, fmtDrive, fmtKm, roadTotalsByLorry, useRoadDaily, useRoadFigures } from '../../vendor/scm/lib/lorry-routes-queries';
import { LorryRoadDaily } from './LorryRoadDaily';
import { ratePctText, useOnTime } from '../../vendor/scm/lib/on-time-queries';
import { todayMyt } from '../../vendor/scm/lib/dates';
import { useMemo, useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { fmtSen, fmtDate } from '@2990s/shared';
import { PageHeader } from '../../components/Layout';
import { StatCard } from '../../components/StatCard';
import { DataTable, type Column } from '../../components/DataTable';
import { cn } from '../../lib/utils';
import {
  useLorryCapacity,
  useToggleLorryInHouse,
  useSetRepairDays,
  type FleetFilter,
  type LorryCapacityRow,
} from '../../vendor/scm/lib/lorry-capacity-queries';
import { capacityFromOverview, capacityTotals, tripsText } from './logisticCapacity';
import type { LorryRow } from './LogisticDailySection';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import styles from './LorryCapacity.module.css';
import { DateField } from "../../vendor/scm/components/DateField";

/* Custom-range date field — the design-system input slab. */
const DATE_INPUT =
  'h-[30px] rounded-md border border-border bg-surface px-2 text-[12px] text-ink outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-primary/20';

/* Segmented control — the FilterPills / ViewToggle slab from the reference
   list pages (PurchaseOrdersListV2). Replaces the bespoke `.segment` pill. */
function SegmentedControl<T extends string>({
  options, value, onChange, label,
}: {
  options: ReadonlyArray<{ key: T; label: string }>;
  value: T;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div
      className="inline-flex items-center gap-0.5 rounded-md border border-border bg-surface p-1 shadow-stone"
      role="group"
      aria-label={label}
    >
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          aria-pressed={value === o.key}
          className={cn(
            'whitespace-nowrap rounded px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider transition-colors',
            value === o.key
              ? 'bg-primary text-white shadow-sm'
              : 'text-ink-secondary hover:bg-primary-soft hover:text-primary',
          )}
          onClick={() => onChange(o.key)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ── Range presets ──────────────────────────────────────────────────────────
   Compute a {from,to} ISO range (YYYY-MM-DD, UTC-anchored so it matches the
   server's calendar-day math) for a named preset. 'custom' is driven by the URL
   from/to params directly. */
type RangePreset = 'last' | 'this' | 'next' | 'custom';

function isoUTC(y: number, mZeroBased: number, d: number): string {
  return new Date(Date.UTC(y, mZeroBased, d)).toISOString().slice(0, 10);
}
/* Counted from the Malaysian day: the UTC month still showed last month for the
   first eight hours of every 1st (owner 2026-11-09). */
function monthRange(offset: number): { from: string; to: string } {
  const today = todayMyt();
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7)) - 1 + offset;
  return { from: isoUTC(y, m, 1), to: isoUTC(y, m + 1, 0) };  // day 0 of next month = last day of this
}
function rangeForPreset(preset: RangePreset, custom: { from: string; to: string }): { from: string; to: string } {
  if (preset === 'last') return monthRange(-1);
  if (preset === 'this') return monthRange(0);
  if (preset === 'next') return monthRange(1);
  return custom;
}

const RANGE_TABS: Array<{ key: RangePreset; label: string }> = [
  { key: 'last', label: 'Last Month' },
  { key: 'this', label: 'This Month' },
  { key: 'next', label: 'Next Month' },
  { key: 'custom', label: 'Custom' },
];

const FLEET_TABS: Array<{ key: FleetFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'internal', label: 'In-house' },
  { key: 'outsourced', label: 'Outsourced' },
];

/* Display helpers — all null-safe ("—"). */
const dash = '—';
function numOrDash(n: number | null | undefined, dp = 0): string {
  if (n == null || !Number.isFinite(n)) return dash;
  return n.toLocaleString('en-MY', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}
function pctOrDash(frac: number | null | undefined): string {
  if (frac == null || !Number.isFinite(frac)) return dash;
  return `${Math.round(frac * 100)}%`;
}
function centiOrDash(centi: number | null | undefined): string {
  if (centi == null) return dash;
  return fmtSen(centi);
}

/* Utilisation tint class — low (<60%) red, mid (<90%) burnt, else green. */
function utilClass(frac: number | null): string {
  if (frac == null) return styles.utilMid!;
  if (frac < 0.6) return styles.utilLow!;
  if (frac < 0.9) return styles.utilMid!;
  return styles.utilHigh!;
}

/** Lorry Capacity as the Logistic Overview's second view (owner 2026-11-07): the period
 *  is the overview's, and the figures come from the overview's lorry rows so the two
 *  pages agree; this read adds the lorry list, in-house flag and running cost; Google km / GPS km /
 *  Google time / Drive time come from the lorry-day figures (lorry-routes). */
export const LorryCapacity = ({ period, overviewLorries }: { period: { from: string; to: string }; overviewLorries: LorryRow[] }) => {
  const [params, setParams] = useSearchParams();
  const notify = useNotify();
  /* Own lorries by default (owner 2026-11-08); All and Outsourced stay one click away. */
  const fleetParam = (params.get('fleet') as FleetFilter) ?? 'internal';
  const fleet: FleetFilter = FLEET_TABS.some((f) => f.key === fleetParam) ? fleetParam : 'internal';
  const { from, to } = period;
  const setFleet = (f: FleetFilter) => {
    const next = new URLSearchParams(params);
    if (f === 'internal') next.delete('fleet'); else next.set('fleet', f);
    setParams(next, { replace: true });
  };

  const { data, isLoading, error } = useLorryCapacity({ from, to, fleet });
  const toggleInHouse = useToggleLorryInHouse();
  const setRepair = useSetRepairDays();

  const rows = useMemo<LorryCapacityRow[]>(() => capacityFromOverview(data?.lorries ?? [], overviewLorries), [data, overviewLorries]);
  /* Road distance and driving time, home and back, from the Last Mile runs (owner 2026-11-08). */
  const road = useRoadFigures(from, to, null);
  const roadBy = useMemo(() => roadTotalsByLorry(road.data ?? []), [road.data]);
  /* GPS km, Drive time and On-site time per lorry-day, worked out on the server. */
  const daily = useRoadDaily(from, to);
  const dailyBy = useMemo(() => dailyTotalsByLorry(daily.data?.days ?? []), [daily.data]);
  /* On-time rate per lorry, worked out on the server (the Deliveries view's on-time KPI). */
  const onTime = useOnTime(from, to, null);
  const onTimeBy = useMemo(() => new Map((onTime.data?.byLorry ?? []).filter((g) => g.lorryId).map((g) => [g.lorryId as string, g])), [onTime.data]);
  const plateById = useMemo(() => new Map((data?.lorries ?? []).map((l) => [l.lorry_id, l.plate])), [data]);
  const totals = useMemo(() => capacityTotals(rows), [rows]);

  /* Sample-parity search (owner 2026-07-25: every table = the SO table):
     client-side over the loaded fleet — plate or type. */
  const [search, setSearch] = useState('');
  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (l) => l.plate.toLowerCase().includes(q) || (l.type ?? '').toLowerCase().includes(q),
    );
  }, [rows, search]);

  /* The 16 metric columns, DataTable-shaped: getValue powers sort / funnel
     filter / CSV export on every column (#1200 contract); the two INTERACTIVE
     cells (In-house toggle, Repair Days editor) keep their exact mutation
     semantics inside render. The old hand-rolled <tfoot> "Fleet total" row is
     gone on purpose — every one of its values already sits in the StatCard
     strip above, and DataTable has no footer concept. */
  const columns = useMemo<Column<LorryCapacityRow>[]>(() => [
    {
      key: 'plate', label: 'Lorry', width: '140px',
      getValue: (l) => l.plate,
      render: (l) => (
        <span className="inline-flex items-center gap-1.5">
          <span className={styles.plate}>{l.plate}</span>
          {l.type && l.type !== 'OTHER' && (
            <span className={styles.lorryType}>
              {l.type.replace(/^LORRY_/, '').replace(/FT$/, 'ft')}
            </span>
          )}
        </span>
      ),
    },
    {
      key: 'is_internal', label: 'In-house', width: '90px', align: 'center',
      getValue: (l) => l.is_internal,
      render: (l) => (
        <label className={styles.checkCell} onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={l.is_internal}
            onChange={(e) => toggleInHouse.mutate({ id: l.lorry_id, isInternal: e.target.checked })}
          />
        </label>
      ),
    },
    { key: 'work_days', label: 'Work Days', align: 'right', getValue: (l) => l.work_days, render: (l) => numOrDash(l.work_days) },
    {
      key: 'repair_days', label: 'Repair Days', width: '104px', align: 'right',
      getValue: (l) => l.repair_days,
      render: (l) => (
        <RepairDaysCell
          lorry={l}
          onSetRepair={(days) =>
            setRepair.mutate(
              { id: l.lorry_id, from, to, days },
              { onError: (e) => notify({ title: "Couldn't save repair days.", body: e instanceof Error ? e.message : 'Something went wrong.', tone: 'error' }) },
            )}
        />
      ),
    },
    { key: 'available_days', label: 'Available Days', align: 'right', getValue: (l) => l.available_days, render: (l) => numOrDash(l.available_days) },
    {
      key: 'utilisation', label: 'Utilisation', align: 'right',
      getValue: (l) => l.utilisation ?? null,
      render: (l) => (
        <span className={`${styles.utilPill} ${utilClass(l.utilisation)}`}>
          {pctOrDash(l.utilisation)}
        </span>
      ),
    },
    { key: 'total_trips', label: 'Total Trips', align: 'right', getValue: (l) => l.total_trips, render: (l) => tripsText(l.total_trips) },
    { key: 'delivery_days', label: 'Delivery Trips', align: 'right', getValue: (l) => l.delivery_days, render: (l) => tripsText(l.delivery_days) },
    { key: 'deliveries', label: 'Deliveries', align: 'right', getValue: (l) => l.deliveries, render: (l) => numOrDash(l.deliveries) },
    { key: 'orders_per_trip', label: 'Orders/Trip', align: 'right', getValue: (l) => l.orders_per_trip ?? null, render: (l) => numOrDash(l.orders_per_trip, 2) },
    { key: 'setup_dismantle', label: 'Setup/Dismantle', align: 'right', getValue: (l) => l.setup_dismantle, render: (l) => numOrDash(l.setup_dismantle) },
    { key: 'pickups', label: 'Pickups & Transfers', align: 'right', getValue: (l) => l.pickups, render: (l) => numOrDash(l.pickups) },
    { key: 'services', label: 'Services', align: 'right', getValue: (l) => l.services, render: (l) => numOrDash(l.services) },
    { key: 'delivery_revenue', label: 'Delivery Revenue', align: 'right', getValue: (l) => l.delivery_revenue_sen ?? null, render: (l) => <span className={styles.money}>{centiOrDash(l.delivery_revenue_sen)}</span> },
    { key: 'revenue_per_order', label: 'Revenue/Order', align: 'right', getValue: (l) => l.revenue_per_order_sen ?? null, render: (l) => <span className={styles.money}>{centiOrDash(l.revenue_per_order_sen)}</span> },
    { key: 'revenue_per_trip', label: 'Revenue/Trip', align: 'right', getValue: (l) => l.revenue_per_trip_sen ?? null, render: (l) => <span className={styles.money}>{centiOrDash(l.revenue_per_trip_sen)}</span> },
    { key: 'road_km', label: 'Google km', align: 'right', getValue: (l) => (roadBy.get(l.lorry_id)?.distanceM ?? 0) / 1000, render: (l) => { const r = roadBy.get(l.lorry_id); return r ? fmtKm(r.distanceM) : dash; } },
    { key: 'km', label: 'GPS km', align: 'right', getValue: (l) => dailyBy.get(l.lorry_id)?.gpsKm ?? null, render: (l) => { const g = dailyBy.get(l.lorry_id)?.gpsKm; return g == null ? dash : fmtKm(g * 1000); } },
    { key: 'road_time', label: 'Google time', align: 'right', getValue: (l) => roadBy.get(l.lorry_id)?.durationS ?? 0, render: (l) => { const r = roadBy.get(l.lorry_id); return r ? fmtDrive(r.durationS) : dash; } },
    {
      key: 'drive_time', label: 'Drive time', align: 'right', getValue: (l) => dailyBy.get(l.lorry_id)?.driveS ?? null,
      render: (l) => { const t = dailyBy.get(l.lorry_id); return t?.timedStops ? fmtDrive(t.driveS) : dash; },
    },
    {
      key: 'time_diff', label: 'Time diff', align: 'right', getValue: (l) => dailyBy.get(l.lorry_id)?.driveS ?? null,
      render: (l) => { const t = dailyBy.get(l.lorry_id); return (t?.timedStops ? diffPct(t.driveS, t.googleTimedS) : null) ?? dash; },
    },
    {
      key: 'on_time_rate', label: 'On-time rate', align: 'right', getValue: (l) => onTimeBy.get(l.lorry_id)?.ratePct ?? null,
      render: (l) => { const g = onTimeBy.get(l.lorry_id); return g?.delivered ? <span title={`${g.onTime + g.early} of ${g.delivered} delivered on or before the promised date`}>{ratePctText(g.ratePct)}</span> : dash; },
    },
    { key: 'running_cost', label: 'Running Cost', align: 'right', getValue: (l) => l.running_cost_sen ?? null, render: (l) => <span className={styles.money}>{centiOrDash(l.running_cost_sen)}</span> },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [toggleInHouse, setRepair, from, to, notify, roadBy, dailyBy, onTimeBy]);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-[12.5px] text-ink-secondary">
          {fmtDate(from)} – {fmtDate(to)} · KL, Southern and Northern · a run of under 3 orders is half a trip, as on Deliveries
        </p>
        <SegmentedControl label="Fleet" options={FLEET_TABS} value={fleet} onChange={setFleet} />
      </div>


      {/* Summary metric tiles */}
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Lorries" value={numOrDash(totals.lorries)} />
        <StatCard label="Total Trips" value={tripsText(totals.total_trips)} />
        <StatCard label="Available Days" value={numOrDash(totals.available_days)} />
        <StatCard label="Utilisation" value={pctOrDash(totals.utilisation)} />
        <StatCard label="Orders/Delivery Trip" value={numOrDash(totals.orders_per_delivery_trip, 2)} />
        <StatCard label="Delivery Revenue" value={centiOrDash(totals.delivery_revenue_sen)} />
        <StatCard label="Revenue/Order" value={centiOrDash(totals.revenue_per_order_sen)} />
        <StatCard label="Revenue/Trip" value={centiOrDash(totals.revenue_per_trip_sen)} />
      </div>

      {/* Running cost is never shown as a number that is too small: the server says why it is missing. */}
      {data?.km_incomplete && (
        <p role="status" className="mb-3 text-sm text-amber-700 dark:text-amber-300">Running cost not shown: {data.km_incomplete}</p>
      )}

      {/* Per-lorry metric table — the shared DataTable (owner 2026-07-25:
          every table = the SO sample). Sort / funnel filters / Columns drawer /
          CSV export / frozen header all come from the component. */}
      <DataTable<LorryCapacityRow>
        tableId="lorry-capacity"
        exportName="lorry-capacity"
        columns={columns}
        rows={filteredRows}
        loading={isLoading}
        error={error instanceof Error ? error.message : error ? String(error) : null}
        emptyLabel="No lorries in this fleet view."
        getRowKey={(l) => l.lorry_id}
        search={{
          value: search,
          onChange: setSearch,
          placeholder: 'Search plate or type…',
          totalRecords: filteredRows.length,
        }}
      />

      <LorryRoadDaily
        days={daily.data?.days ?? []}
        onSite={daily.data?.onSite ?? []}
        plateOf={(id) => plateById.get(id) ?? null}
        loading={daily.isLoading}
        error={daily.error instanceof Error ? daily.error.message : daily.error ? String(daily.error) : null}
      />
    </div>
  );
};

/* Repair Days cell — locally controlled so typing doesn't thrash the query;
   commits on blur / Enter only when the value changed (same contract as the
   old hand-rolled row). */
const RepairDaysCell = ({
  lorry, onSetRepair,
}: {
  lorry: LorryCapacityRow;
  onSetRepair: (days: number) => void;
}) => {
  const [repair, setRepair] = useState(String(lorry.repair_days));
  // Keep the local field in sync if the server value changes (range / fleet flip).
  useEffect(() => { setRepair(String(lorry.repair_days)); }, [lorry.repair_days]);

  const commitRepair = () => {
    const n = Math.max(0, Math.round(Number(repair)) || 0);
    if (n !== lorry.repair_days) onSetRepair(n);
    setRepair(String(n));
  };

  return (
    <input
      className={styles.repairInput}
      type="number" min={0} step={1}
      value={repair}
      onChange={(e) => setRepair(e.target.value)}
      onBlur={commitRepair}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      onClick={(e) => e.stopPropagation()}
    />
  );
};
