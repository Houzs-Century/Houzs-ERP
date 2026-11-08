// Lorry Capacity › each lorry-day, Google against what really happened, and On-site
// time per building type (owner 2026-11-08). The server works every figure out
// (scm/lib/lorry-day-stats.ts); this page only lays them out. Terms are fixed:
// Google km, Google time, GPS km, Drive time, On-site time (docs/modules/delivery-tms.md).
import { useMemo } from 'react';
import { DataTable, type Column } from '../../components/DataTable';
import { cn } from '../../lib/utils';
import { diffPct, fmtDrive, fmtKm, type OnSiteRow, type RoadDayStat } from '../../vendor/scm/lib/lorry-routes-queries';

const dash = '—';

function Diff({ v }: { v: string | null }) {
  if (!v) return <span className="text-ink-muted">{dash}</span>;
  const n = Number(v.replace('%', ''));
  return <span className={cn('font-semibold tabular-nums', Math.abs(n) <= 10 ? 'text-ink-secondary' : n > 0 ? 'text-err' : 'text-synced')}>{v}</span>;
}

type DayRow = RoadDayStat & { key: string; plate: string };
type SiteRow = { key: string; buildingType: string; plate: string; stops: number; onSiteS: number };

export function LorryRoadDaily({ days, onSite, plateOf, loading, error }: {
  days: readonly RoadDayStat[];
  onSite: readonly OnSiteRow[];
  plateOf: (lorryId: string) => string | null;
  loading: boolean;
  error: string | null;
}) {
  const dayRows = useMemo<DayRow[]>(() => days
    .map((d) => ({ ...d, key: `${d.date}|${d.lorryId}`, plate: plateOf(d.lorryId) ?? dash }))
    .sort((a, b) => b.date.localeCompare(a.date) || a.plate.localeCompare(b.plate)), [days, plateOf]);

  /* All lorries first per building type, then each lorry. */
  const siteRows = useMemo<SiteRow[]>(() => {
    const byType = new Map<string, { stops: number; onSiteS: number }>();
    for (const r of onSite) {
      const t = byType.get(r.buildingType) ?? { stops: 0, onSiteS: 0 };
      t.stops += r.stops; t.onSiteS += r.onSiteS;
      byType.set(r.buildingType, t);
    }
    const out: SiteRow[] = [];
    for (const [bt, t] of [...byType].sort((a, b) => a[0].localeCompare(b[0]))) {
      out.push({ key: `${bt}|all`, buildingType: bt, plate: 'All lorries', ...t });
      for (const r of onSite.filter((x) => x.buildingType === bt)) out.push({ key: `${bt}|${r.lorryId}`, buildingType: bt, plate: plateOf(r.lorryId) ?? dash, stops: r.stops, onSiteS: r.onSiteS });
    }
    return out;
  }, [onSite, plateOf]);

  const dayColumns: Column<DayRow>[] = [
    { key: 'date', label: 'Date', width: '104px', getValue: (d) => d.date, render: (d) => <span className="font-mono tabular-nums">{d.date}</span> },
    { key: 'plate', label: 'Lorry', getValue: (d) => d.plate, render: (d) => d.plate },
    { key: 'stops', label: 'Stops', align: 'right', getValue: (d) => d.stops, render: (d) => d.stops },
    { key: 'google_km', label: 'Google km', align: 'right', getValue: (d) => d.googleM / 1000, render: (d) => fmtKm(d.googleM) },
    { key: 'gps_km', label: 'GPS km', align: 'right', getValue: (d) => d.gpsKm, render: (d) => (d.gpsKm == null ? dash : fmtKm(d.gpsKm * 1000)) },
    { key: 'km_diff', label: 'km diff', align: 'right', getValue: (d) => d.gpsKm, render: (d) => <Diff v={diffPct(d.gpsKm == null ? null : d.gpsKm * 1000, d.googleM)} /> },
    { key: 'google_time', label: 'Google time', align: 'right', getValue: (d) => d.googleS, render: (d) => fmtDrive(d.googleS) },
    {
      key: 'drive_time', label: 'Drive time', align: 'right', getValue: (d) => d.driveS,
      render: (d) => (d.timedStops ? <span title={`${d.timedStops} of ${d.stops} stops timed by the crew`}>{fmtDrive(d.driveS)} <span className="text-ink-muted">({d.timedStops}/{d.stops})</span></span> : dash),
    },
    { key: 'time_diff', label: 'Time diff', align: 'right', getValue: (d) => d.driveS, render: (d) => <Diff v={d.timedStops ? diffPct(d.driveS, d.googleTimedS) : null} /> },
    { key: 'on_site', label: 'On-site time', align: 'right', getValue: (d) => d.onSiteS, render: (d) => (d.onSiteStops ? fmtDrive(d.onSiteS) : dash) },
  ];

  const siteColumns: Column<SiteRow>[] = [
    { key: 'bt', label: 'Building type', getValue: (r) => r.buildingType, render: (r) => (r.plate === 'All lorries' ? <span className="font-semibold">{r.buildingType}</span> : <span className="text-ink-muted">{r.buildingType}</span>) },
    { key: 'plate', label: 'Lorry', getValue: (r) => r.plate, render: (r) => (r.plate === 'All lorries' ? <span className="font-semibold">{r.plate}</span> : r.plate) },
    { key: 'stops', label: 'Orders', align: 'right', getValue: (r) => r.stops, render: (r) => r.stops },
    { key: 'avg', label: 'On-site time per order', align: 'right', getValue: (r) => r.onSiteS / r.stops, render: (r) => fmtDrive(r.onSiteS / r.stops) },
    { key: 'total', label: 'On-site time total', align: 'right', getValue: (r) => r.onSiteS, render: (r) => fmtDrive(r.onSiteS) },
  ];

  return (
    <div className="mt-6 space-y-6">
      <section>
        <h2 className="mb-1 text-[14px] font-semibold text-ink">Each day: Google against GPS and the crew</h2>
        <p className="mb-2 text-[12px] text-ink-secondary">
          Google km and Google time: from the warehouse, every stop in order, and back. GPS km: the lorry's own GPS, blank for a lorry without one.
          Drive time: the crew's "on the way" to "arrived", stop by stop; Time diff compares it with Google over the same stops (the drive home has no tap).
          Red: more than 10% over Google.
        </p>
        <DataTable<DayRow>
          tableId="lorry-road-daily"
          exportName="lorry-road-daily"
          columns={dayColumns}
          rows={dayRows}
          loading={loading}
          error={error}
          emptyLabel="No lorry runs worked out in this period."
          getRowKey={(d) => d.key}
        />
      </section>
      <section>
        <h2 className="mb-1 text-[14px] font-semibold text-ink">On-site time by building type</h2>
        <p className="mb-2 text-[12px] text-ink-secondary">From the crew's "arrived" to "completed" on each finished order: carrying in, going up and installing. Building type as written on the sales order.</p>
        <DataTable<SiteRow>
          tableId="lorry-onsite-building"
          exportName="lorry-onsite-building"
          columns={siteColumns}
          rows={siteRows}
          loading={loading}
          error={error}
          emptyLabel="No finished orders with crew times in this period."
          getRowKey={(r) => r.key}
        />
      </section>
    </div>
  );
}
