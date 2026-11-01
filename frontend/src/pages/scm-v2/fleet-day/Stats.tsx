import { StatStrip } from '../../../components/DetailLayout';
import { fmtSen } from '../../../vendor/shared/format';
import type { DayStats } from '../../../vendor/scm/lib/fleet-day-cards';

/** The day KPI strip — Lorries / Drops / Delivered / On the way / Late / Total
 *  value / POD rate. Derived entirely from the day's runs (fleet-day-model). */
export function FleetDayStats({ stats }: { stats: DayStats }) {
  return (
    <StatStrip
      items={[
        { label: 'Lorries', value: stats.lorries },
        { label: 'Drops', value: stats.drops },
        { label: 'Delivered', value: stats.delivered, tone: 'ok' },
        { label: 'On the way', value: stats.onTheWay },
        { label: 'Late', value: stats.late, tone: stats.late > 0 ? 'err' : 'default' },
        { label: 'Total value', value: fmtSen(stats.totalSen) },
        { label: 'POD rate', value: stats.podRatePct == null ? '—' : `${stats.podRatePct}%`, tone: stats.podRatePct === 100 ? 'ok' : 'default' },
      ]}
    />
  );
}
