// ----------------------------------------------------------------------------
// ReportBarChart — the reports' month chart (the owner's Claude Design, batch 6
// §4.1), drawn by the in-house DashboardChart (hand-drawn SVG; the ERP carries
// no chart library and its bundle gate would refuse one): a bar per figure per
// month over twelve months (up to twenty-four for a longer range), the chosen
// period shaded with its labels petrol, the bottom line in figures under each
// month (a loss red). Pointing at a month opens a card beside its column —
// the month, In the period / To <today>, a line per bar with its colour and
// amount, the bottom line bold, "Click to open this month" — and a click opens
// that month (the range becomes it).
// ----------------------------------------------------------------------------

import { useMemo, useRef } from 'react';
import { fmtDate, fmtSenPlain } from '../../../vendor/shared/format';
import { useFinanceDashboard, type DashboardPeriod } from '../../../vendor/scm/lib/dashboard-queries';
import { monthEnd, monthStart } from '../../../lib/dateRangePresets';
import { DashboardChart } from '../DashboardChart';
import { nextChartWindow, windowMonths, type ChartWindow } from './chartWindow';
import { useReportRange } from './useReportRange';
import s from './ReportChart.module.css';

/** The report charts' one palette (owner 2026-11-02: petrol, gold, warm grey). */
export const REPORT_CHART_COLORS = { petrol: '#16695f', gold: '#d8a85a', grey: '#a3a99b' } as const;

export type ChartBarSeries = { key: string; label: string; color: string };
/** One month as the chart draws it: its bars, and the bottom line under them and in its card. */
export type ChartMonth = {
  month: string;
  values: Record<string, number | null>;
  /** The bold line of the card, and what follows it (a margin). */
  bottom: Array<{ label: string; value: string; loss?: boolean }>;
  /** The figure under the bars, RM thousand; null when the month has no figures. */
  under: { text: string; loss: boolean } | null;
};

/** RM thousand, a loss in brackets: 41, (12), 0.4. */
export const thousands = (sen: number): string => {
  const k = Math.abs(sen) / 100_000;
  const text = k >= 10 ? Math.round(k).toLocaleString('en-MY') : k.toFixed(1);
  return sen < 0 ? `(${text})` : text;
};

const monthLong = (m: string): string =>
  new Date(`${m}T00:00:00Z`).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const monthAxis = (m: string): string =>
  new Date(`${m}T00:00:00Z`).toLocaleString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' });

/** The months a chart shows for the range in use — kept while the range sits inside them. */
export function useChartMonths(from: string, to: string, usable: boolean): ChartWindow | null {
  const last = useRef<ChartWindow | null>(null);
  return useMemo(() => {
    if (!usable) return last.current;
    last.current = nextChartWindow(last.current, from, to);
    return last.current;
  }, [from, to, usable]);
}

/** The dashboard's months for a window — one read, the statements' own builders. */
export function useChartPeriods(win: ChartWindow | null) {
  const q = useFinanceDashboard({ granularity: 'month', from: win ? win.from.slice(0, 7) : null, to: win ? win.to.slice(0, 7) : null });
  const byMonth = useMemo(() => new Map((q.data?.periods ?? []).map((p): [string, DashboardPeriod] => [`${p.key}-01`, p])), [q.data]);
  return { byMonth, isLoading: q.isLoading, isError: q.isError, today: q.data?.today };
}

export function ReportBarChart({ title, series, months, win, loading, failed, note, onOpen, unit = 'sen', fmtValue = fmtSenPlain }: {
  title: string;
  series: ChartBarSeries[];
  /** The window's months with their figures, oldest first. */
  months: ChartMonth[];
  win: ChartWindow | null;
  loading: boolean;
  failed: boolean;
  note: string;
  /** Called after a month is opened (the Performance P&L also switches to Single). */
  onOpen?: (month: string) => void;
  /** What the bars count — RM by default; a % (Merchant charges' fee %). */
  unit?: 'sen' | 'pct';
  /** A bar's figure in the card beside a month. */
  fmtValue?: (v: number) => string;
}) {
  const r = useReportRange();
  const inPeriod = (m: string) => r.usable && m >= monthStart(r.from) && m <= monthStart(r.to);
  const running = (m: string) => m === monthStart(r.today);
  const open = (m: string) => {
    r.setRange(m, running(m) ? r.today : monthEnd(m));
    onOpen?.(m);
  };
  const span = win ? `${monthAxis(win.from)} – ${monthAxis(win.to)}` : '';
  const empty = !loading && !failed && months.every((m) => series.every((x) => m.values[x.key] == null));

  return (
    <section className={s.card} aria-label={`${title} · ${span}`}>
      <div className={s.head}>
        <span className={s.title}>{title}{span ? ` · ${span}` : ''}</span>
        {series.map((x) => (
          <span key={x.key} className={s.legend}><span className={s.swatch} style={{ background: x.color }} aria-hidden />{x.label}</span>
        ))}
      </div>
      {loading && <div className={`skeleton ${s.skeleton}`} aria-busy="true" aria-label="Loading the chart" />}
      {!loading && failed && <p className={s.message}>The chart did not load — the statement below is unaffected.</p>}
      {!loading && !failed && empty && <p className={s.message}>No figures for these months.</p>}
      {!loading && !failed && !empty && (
        <DashboardChart
          labels={months.map((m) => monthAxis(m.month))}
          bars={series.map((x) => ({ key: x.key, label: x.label, color: x.color, values: months.map((m) => m.values[x.key] ?? null) }))}
          height={230}
          unit={unit}
          legend={false}
          ariaLabel={`${title}, month by month`}
          shaded={months.map((m) => inPeriod(m.month))}
          notes={months.map((m) => m.under)}
          onPick={(i) => open(months[i]!.month)}
          pickLabel={(i) => `Open ${monthLong(months[i]!.month)}`}
          hoverCard={(i) => {
            const m = months[i]!;
            const tag = inPeriod(m.month) ? 'In the period' : running(m.month) ? `To ${fmtDate(r.today)}` : null;
            return (
              <div className={s.tip}>
                <div className={s.tipHead}><b>{monthLong(m.month)}</b>{tag && <span className={s.tipTag}>{tag}</span>}</div>
                {series.map((x) => (
                  <div key={x.key} className={s.tipRow}>
                    <span className={s.swatch} style={{ background: x.color }} aria-hidden />
                    <span className={s.tipLabel}>{x.label}</span>
                    <span className={s.tipValue}>{m.values[x.key] == null ? '—' : fmtValue(m.values[x.key]!)}</span>
                  </div>
                ))}
                {m.bottom.map((b, k) => (
                  <div key={b.label} className={`${s.tipRow} ${k === 0 ? s.tipBottom : ''}`}>
                    <span className={s.tipLabel}>{b.label}</span>
                    <span className={`${s.tipValue} ${b.loss ? s.loss : ''}`}>{b.value}</span>
                  </div>
                ))}
                <div className={s.tipHint}>Click to open this month</div>
              </div>
            );
          }}
        />
      )}
      <p className={s.note}>{note}</p>
    </section>
  );
}

/** The window's months, oldest first, each read through `pick` (null where the dashboard has none). */
export function chartMonths(win: ChartWindow | null, byMonth: Map<string, DashboardPeriod>, pick: (p: DashboardPeriod) => Omit<ChartMonth, 'month'> | null): ChartMonth[] {
  if (!win) return [];
  return windowMonths(win).map((month) => {
    const p = byMonth.get(month);
    const got = p ? pick(p) : null;
    return got ? { month, ...got } : { month, values: {}, bottom: [], under: null };
  });
}
