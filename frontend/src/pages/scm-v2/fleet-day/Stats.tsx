import { cn } from '../../../lib/utils';
import { fmtSen } from '../../../vendor/shared/format';
import type { DayStats } from '../../../vendor/scm/lib/fleet-day-cards';

type Tone = 'ok' | 'err' | 'default';

/** The day KPI strip — Lorries / Drops / Delivered / On the way / Late / Total
 *  value / POD rate. One white row of seven (design handoff v2, Layout A): the
 *  cells auto-fit so on a wide screen all seven sit in a single line with large
 *  tabular numbers, wrapping only when the viewport is narrow. */
export function FleetDayStats({ stats }: { stats: DayStats }) {
  const items: Array<{ label: string; value: string | number; tone?: Tone }> = [
    { label: 'Lorries', value: stats.lorries },
    { label: 'Drops', value: stats.drops },
    { label: 'Delivered', value: stats.delivered, tone: 'ok' },
    { label: 'On the way', value: stats.onTheWay },
    { label: 'Late', value: stats.late, tone: stats.late > 0 ? 'err' : 'default' },
    { label: 'Total value', value: fmtSen(stats.totalSen) },
    { label: 'POD rate', value: stats.podRatePct == null ? '—' : `${stats.podRatePct}%`, tone: stats.podRatePct === 100 ? 'ok' : 'default' },
  ];
  return (
    <div
      className="grid overflow-hidden rounded-lg border border-border bg-surface shadow-stone"
      style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))' }}
    >
      {items.map((s, i) => (
        <div key={i} className="flex flex-col gap-1 border-l border-border-subtle px-4 py-3 first:border-l-0">
          <span className="font-mono text-[11px] font-semibold uppercase tracking-brand text-ink-muted">{s.label}</span>
          <span
            className={cn(
              'text-[20px] font-bold leading-none tabular-nums',
              s.tone === 'ok' && 'text-synced',
              s.tone === 'err' && 'text-err',
              (!s.tone || s.tone === 'default') && 'text-ink',
            )}
          >
            {s.value}
          </span>
        </div>
      ))}
    </div>
  );
}
