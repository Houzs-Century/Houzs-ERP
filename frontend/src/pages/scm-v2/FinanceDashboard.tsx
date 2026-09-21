// ----------------------------------------------------------------------------
// FinanceDashboard — /scm/finance-dashboard (owner 2026-09-21: the Hookka
// Dashboard, trading edition — P&L, performance P&L, Cost structure by
// product group, cash flow; 两个都可以，做). Read-only cards: the statements'
// ACTUALS (gold bars) beside the Forecast P&L's TARGETS (red dashed line),
// a figures table under every chart. Every figure comes from ONE read,
// GET /accounting/dashboard, whose actuals are the report routes' own
// builders — the P&L, the Cash Flow, the Performance P&L and the balance
// sheet — so a card can never disagree with its report. The page writes
// nothing.
//
// The rules the Porting Guide learned the hard way: a forecast % divides by
// FORECAST revenue and an actual % by ACTUAL revenue, the vs Forecast row
// compares percentage POINTS; a period not finished wears " *" and the
// legend says why a small figure is not a fall; a period without a
// forecast draws no line (null, never 0); a tooltip carries the RM and the
// % share; the closing stock of the open month is provisional and says so.
// ----------------------------------------------------------------------------
import { Fragment, useMemo, useState } from 'react';
import { Button } from '@2990s/design-system';
import { PageHeader } from '../../components/Layout';
import { fmtSenPlain } from '../../vendor/shared/format';
import type { LaidNode } from '../../vendor/scm/lib/report-layout';
import {
  useFinanceDashboard,
  type CompareGroup, type CompareTotals, type CostStructureGroup, type DashboardFigures, type DashboardPeriod, type Granularity,
} from '../../vendor/scm/lib/dashboard-queries';
import { DashboardChart, type ChartLine, type ChartSeries } from './DashboardChart';

const errText = (e: unknown): string => (e instanceof Error && e.message ? e.message : 'That was not accepted.');
const soft: React.CSSProperties = { fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' };
const card: React.CSSProperties = { background: 'var(--c-paper, #fff)', border: '1px solid var(--border-weak, #e3e1da)', borderRadius: 8, padding: 'var(--space-3)' };
const th: React.CSSProperties = { padding: '5px 10px', fontSize: 'var(--fs-11)', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--fg-muted)', borderBottom: '1px solid var(--border-weak, #e3e1da)', whiteSpace: 'nowrap', textAlign: 'right' };
const td: React.CSSProperties = { padding: '4px 10px', fontSize: 'var(--fs-13)', borderBottom: '1px dashed var(--border-weak, #f0eee8)', whiteSpace: 'nowrap' };
const num: React.CSSProperties = { textAlign: 'right', fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums' };
const shaded: React.CSSProperties = { background: 'var(--c-surface-2, #f6f5f0)', fontWeight: 600 };
const danger = 'var(--c-festive-b, #B8331F)';
const good = 'var(--c-secondary-a, #2F5D4F)';
const input: React.CSSProperties = { padding: '4px 8px', fontSize: 'var(--fs-13)', border: '1px solid var(--border-weak, #e3e1da)', borderRadius: 6 };
const tabBtn = (active: boolean): React.CSSProperties => ({
  padding: '3px 10px', fontSize: 'var(--fs-12)', borderRadius: 'var(--radius-sm, 4px)', cursor: 'pointer',
  border: '1px solid var(--c-line, rgba(34,31,32,0.2))', background: active ? 'var(--c-ink, #221f20)' : 'transparent', color: active ? 'var(--c-cream, #fff)' : 'inherit',
});
/** The chart's dress: actuals in gold, the forecast in red, money in and out, the product groups. */
const GOLD = '#C9A227';
const RED = '#B8331F';
const IN = '#2F5D4F';
const OUT = '#B4501E';
const GROUP_COLORS: Record<string, string> = {
  sofa: '#6B8FB5', bedding: '#C9A227', accessories: '#7FA58A', dining: '#B8776B', others: '#9A9A9A',
  mattress: '#C9A227', bedframe: '#E0C270', accessory: '#7FA58A', service: '#9A9A9A',
};
const colorOf = (key: string): string => GROUP_COLORS[key] ?? '#9A9A9A';

/** A %, one decimal, null with nothing to divide by. */
const pct1 = (part: number, whole: number): number | null => (whole !== 0 ? Math.round((part / whole) * 1000) / 10 : null);
const fmtPct = (p: number | null | undefined): string => (p == null ? '—' : `${p.toFixed(1)}%`);
const fmtRatio = (r: number | null | undefined): string => (r == null ? '—' : r.toFixed(2));
const fmtPp = (pp: number | null): string => (pp == null ? '—' : `${pp > 0 ? '+' : ''}${pp.toFixed(1)} pp`);
const fmtSigned = (sen: number | null): string => (sen == null ? '—' : sen === 0 ? '0.00' : `${sen > 0 ? '+' : ''}${fmtSenPlain(sen)}`);
const fmtOrDash = (sen: number | null | undefined): string => (sen == null ? '—' : fmtSenPlain(sen));
/** The period's label as the cards print it — " *" on one not finished. */
const labelOf = (p: DashboardPeriod): string => (p.partial ? `${p.label} *` : p.label);

/* ── The pieces every card shares ────────────────────────────────────────── */

const Tabs = ({ options, value, onChange }: { options: Array<{ key: string; label: string }>; value: string; onChange: (k: string) => void }) => (
  <div role="tablist" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
    {options.map((o) => (
      <button key={o.key} type="button" role="tab" aria-selected={o.key === value} style={tabBtn(o.key === value)} onClick={() => onChange(o.key)}>{o.label}</button>
    ))}
  </div>
);

type TableRow = { id: string; label: string; cells: string[]; tone?: Array<'good' | 'bad' | null>; strong?: boolean };
/** The figures under a chart: one column per period, a row per line the card names. */
const FiguresTable = ({ periods, rows, ariaLabel }: { periods: DashboardPeriod[]; rows: TableRow[]; ariaLabel: string }) => (
  <div style={{ overflowX: 'auto', marginTop: 'var(--space-2)' }}>
    <table aria-label={ariaLabel} style={{ borderCollapse: 'collapse', width: '100%' }}>
      <thead>
        <tr>
          <th style={{ ...th, textAlign: 'left' }} />
          {periods.map((p) => <th key={p.key} style={th}>{labelOf(p)}</th>)}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id} data-row={r.id} style={r.strong ? shaded : undefined}>
            <td style={{ ...td, fontWeight: r.strong ? 600 : undefined }}>{r.label}</td>
            {r.cells.map((c, i) => {
              const tone = r.tone?.[i] ?? null;
              return <td key={i} style={{ ...td, ...num, color: tone === 'good' ? good : tone === 'bad' ? danger : undefined }}>{c}</td>;
            })}
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

const CardShell = ({ title, controls, children }: { title: string; controls?: React.ReactNode; children: React.ReactNode }) => (
  <section style={card} aria-label={title}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', flexWrap: 'wrap', marginBottom: 'var(--space-2)' }}>
      <h2 style={{ fontSize: 'var(--fs-14)', fontWeight: 700, margin: 0 }}>{title}</h2>
      <span style={{ flex: 1 }} />
      {controls}
    </div>
    {children}
  </section>
);

/* ── 1 · Income Statement ────────────────────────────────────────────────── */

type Metric = { key: string; label: string; of: (f: DashboardFigures) => number; higherIsBetter: boolean };
const METRICS: Metric[] = [
  { key: 'revenue', label: 'Revenue', of: (f) => f.salesSen, higherIsBetter: true },
  { key: 'cogs', label: 'COGS', of: (f) => f.costOfSalesSen, higherIsBetter: false },
  { key: 'gp', label: 'Gross Profit', of: (f) => f.grossProfitSen, higherIsBetter: true },
  { key: 'staff', label: 'Staff Cost', of: (f) => f.staffCostSen, higherIsBetter: false },
  { key: 'other', label: 'Other Expenses', of: (f) => f.otherExpensesSen, higherIsBetter: false },
  { key: 'net', label: 'Net Profit', of: (f) => f.netProfitSen, higherIsBetter: true },
];

const IncomeStatementCard = ({ periods }: { periods: DashboardPeriod[] }) => {
  const [metricKey, setMetricKey] = useState('revenue');
  const metric = METRICS.find((m) => m.key === metricKey) ?? METRICS[0]!;
  const actual = periods.map((p) => (p.actual ? metric.of(p.actual) : null));
  const forecast = periods.map((p) => (p.forecast ? metric.of(p.forecast) : null));
  /* A forecast % is of FORECAST revenue, an actual % of ACTUAL revenue — never mixed. */
  const actualPct = periods.map((p) => (p.actual ? pct1(metric.of(p.actual), p.actual.salesSen) : null));
  const forecastPct = periods.map((p) => (p.forecast ? pct1(metric.of(p.forecast), p.forecast.salesSen) : null));
  const gap = periods.map((_, i) => (actual[i] != null && forecast[i] != null ? actual[i]! - forecast[i]! : null));
  const gapPp = periods.map((_, i) => (actualPct[i] != null && forecastPct[i] != null ? Math.round((actualPct[i]! - forecastPct[i]!) * 10) / 10 : null));
  const tone = (g: number | null): 'good' | 'bad' | null => (g == null || g === 0 ? null : (metric.higherIsBetter ? g > 0 : g < 0) ? 'good' : 'bad');
  const vsLast = periods.map((_, i) => {
    const cur = actual[i]; const prev = i > 0 ? actual[i - 1] : null;
    return cur != null && prev != null && prev !== 0 ? Math.round(((cur - prev) / Math.abs(prev)) * 1000) / 10 : null;
  });
  const bars: ChartSeries[] = [{ key: 'actual', label: `Actual ${metric.label}`, color: GOLD, values: actual, tips: periods.map((p, i) => (actual[i] == null ? null : `${labelOf(p)} · Actual ${metric.label}: RM ${fmtSenPlain(actual[i])} (${fmtPct(actualPct[i])} of revenue)`)) }];
  const lines: ChartLine[] = [{ key: 'forecast', label: `Forecast ${metric.label}`, color: RED, dashed: true, values: forecast, tips: periods.map((p, i) => (forecast[i] == null ? null : `${labelOf(p)} · Forecast ${metric.label}: RM ${fmtSenPlain(forecast[i])} (${fmtPct(forecastPct[i])} of forecast revenue)`)) }];
  const rows: TableRow[] = [
    { id: 'actual', label: 'Actual', cells: actual.map(fmtOrDash), strong: true },
    { id: 'actual-pct', label: '% of actual revenue', cells: actualPct.map(fmtPct) },
    { id: 'forecast', label: 'Forecast', cells: forecast.map(fmtOrDash) },
    { id: 'forecast-pct', label: '% of forecast revenue', cells: forecastPct.map(fmtPct) },
    { id: 'vs-forecast', label: 'vs Forecast (RM)', cells: gap.map(fmtSigned), tone: gap.map(tone) },
    { id: 'vs-forecast-pp', label: 'vs Forecast (pp)', cells: gapPp.map(fmtPp), tone: gapPp.map((g) => tone(g)) },
    { id: 'vs-last', label: periods.length > 0 && periods[0]!.months.length > 1 ? 'vs last quarter' : 'vs last month', cells: vsLast.map((v) => (v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`)) },
  ];
  return (
    <CardShell title="Income Statement" controls={<Tabs options={METRICS} value={metricKey} onChange={setMetricKey} />}>
      <DashboardChart labels={periods.map(labelOf)} bars={bars} lines={lines} ariaLabel={`${metric.label} — actual bars, forecast line`} />
      <FiguresTable periods={periods} rows={rows} ariaLabel={`${metric.label} figures`} />
    </CardShell>
  );
};

/* ── 2 · Performance vs forecast, per product group ─────────────────────── */

type CompareMetric = 'sales' | 'gp' | 'gpPct';
const COMPARE_METRICS: Array<{ key: CompareMetric; label: string }> = [{ key: 'sales', label: 'Sales' }, { key: 'gp', label: 'Gross profit' }, { key: 'gpPct', label: 'GP %' }];
/** The Performance P&L's blue beside the ledger's gold. */
const PERF = '#5B7FA8';
const fmtSignedPct = (p: number | null): string => (p == null ? '—' : `${p > 0 ? '+' : ''}${p.toFixed(1)}%`);
/** (a − b) ÷ |b| in %, one decimal; null without both sides or with nothing to divide by. */
const gapPct = (a: number | null, b: number | null): number | null => (a == null || b == null || b === 0 ? null : Math.round(((a - b) / Math.abs(b)) * 1000) / 10);
const gapSen = (a: number | null, b: number | null): number | null => (a == null || b == null ? null : a - b);
const toneUp = (g: number | null): 'good' | 'bad' | null => (g == null || g === 0 ? null : g > 0 ? 'good' : 'bad');

/** Owner 2026-09-22: actual (the ledger, gold) and performance (the orders,
    blue) as bars side by side, the forecast a red dashed line — per product
    group, or All. On All the performance bar stacks the groups so the mix
    stays visible. Sales has three readings; gross profit and GP % have two —
    the ledger's cost of sales is periodic, one figure, never per group, so no
    actual GP is invented here. */
const PerformanceCard = ({ periods, groups }: { periods: DashboardPeriod[]; groups: Array<{ key: string; label: string }> }) => {
  const [metric, setMetric] = useState<CompareMetric>('sales');
  const [groupKey, setGroupKey] = useState('all');
  const present = groups.filter((g) => periods.some((p) => p.compare?.groups.some((x) => x.key === g.key)));
  const groupOf = (p: DashboardPeriod, key: string): CompareGroup | undefined => p.compare?.groups.find((g) => g.key === key);
  const figures: Array<CompareTotals | null> = periods.map((p) => (p.compare ? (groupKey === 'all' ? p.compare.totals : groupOf(p, groupKey) ?? null) : null));
  const read = (f: (x: CompareTotals) => number | null): Array<number | null> => figures.map((x) => (x ? f(x) : null));
  const actualSales = read((x) => x.actualSalesSen);
  const perfSales = read((x) => x.performanceSalesSen);
  const perfCost = read((x) => x.performanceCostSen);
  const perfGp = read((x) => x.performanceGpSen);
  const perfGpPct = read((x) => x.performanceGpPct);
  const forecastSales = read((x) => x.forecastSalesSen);
  const forecastCost = read((x) => x.forecastCostSen);
  const forecastGp = read((x) => x.forecastGpSen);
  const forecastGpPct = read((x) => x.forecastGpPct);
  const metricLabel = COMPARE_METRICS.find((m) => m.key === metric)?.label ?? '';
  const groupLabel = groupKey === 'all' ? 'All groups' : present.find((g) => g.key === groupKey)?.label ?? groupKey;
  const perfOf = (g: CompareGroup): number | null => (metric === 'sales' ? g.performanceSalesSen : metric === 'gp' ? g.performanceGpSen : g.performanceGpPct);
  const fmtMetric = (v: number | null): string => (metric === 'gpPct' ? fmtPct(v) : fmtOrDash(v));

  /* The bars: the performance side stacks the groups on All (sales and gross profit — a % does not stack). */
  const perfBars: ChartSeries[] = groupKey === 'all' && metric !== 'gpPct'
    ? present.map((g) => ({
      key: g.key, label: g.label, color: colorOf(g.key), stack: 'performance',
      values: periods.map((p) => { const x = groupOf(p, g.key); return x ? perfOf(x) : null; }),
      tips: periods.map((p) => { const x = groupOf(p, g.key); return x && x.performanceSalesSen != null ? `${labelOf(p)} · Performance · ${g.label}: sales RM ${fmtSenPlain(x.performanceSalesSen)} · cost RM ${fmtSenPlain(x.performanceCostSen ?? 0)} · GP ${fmtPct(x.performanceGpPct)}` : null; }),
    }))
    : [{ key: 'performance', label: `Performance ${metricLabel}`, color: PERF, values: metric === 'sales' ? perfSales : metric === 'gp' ? perfGp : perfGpPct }];
  const bars: ChartSeries[] = metric === 'sales'
    ? [{ key: 'actual', label: 'Actual sales (P&L)', color: GOLD, values: actualSales, tips: periods.map((p, i) => (actualSales[i] == null ? null : `${labelOf(p)} · Actual sales (P&L) · ${groupLabel}: RM ${fmtSenPlain(actualSales[i])}`)) }, ...perfBars]
    : perfBars;
  const lines: ChartLine[] = [
    metric === 'sales'
      ? { key: 'forecast-sales', label: 'Forecast sales', color: RED, dashed: true, values: forecastSales }
      : metric === 'gp'
        ? { key: 'forecast-gp', label: 'Forecast gross profit', color: RED, dashed: true, values: forecastGp }
        : { key: 'forecast-gp-pct', label: 'Forecast GP %', color: RED, dashed: true, values: forecastGpPct },
  ];

  const rows: TableRow[] = metric === 'sales'
    ? [
      { id: 'actual-sales', label: 'Actual sales (P&L)', cells: actualSales.map(fmtOrDash), strong: true },
      { id: 'performance-sales', label: 'Performance sales (SO)', cells: perfSales.map(fmtOrDash), strong: true },
      { id: 'forecast-sales', label: 'Forecast sales', cells: forecastSales.map(fmtOrDash) },
      { id: 'actual-vs-forecast', label: 'Actual vs Forecast (RM)', cells: periods.map((_, i) => fmtSigned(gapSen(actualSales[i] ?? null, forecastSales[i] ?? null))), tone: periods.map((_, i) => toneUp(gapSen(actualSales[i] ?? null, forecastSales[i] ?? null))) },
      { id: 'actual-vs-forecast-pct', label: 'Actual vs Forecast (%)', cells: periods.map((_, i) => fmtSignedPct(gapPct(actualSales[i] ?? null, forecastSales[i] ?? null))), tone: periods.map((_, i) => toneUp(gapPct(actualSales[i] ?? null, forecastSales[i] ?? null))) },
      { id: 'performance-vs-forecast', label: 'Performance vs Forecast (RM)', cells: periods.map((_, i) => fmtSigned(gapSen(perfSales[i] ?? null, forecastSales[i] ?? null))), tone: periods.map((_, i) => toneUp(gapSen(perfSales[i] ?? null, forecastSales[i] ?? null))) },
      { id: 'performance-vs-forecast-pct', label: 'Performance vs Forecast (%)', cells: periods.map((_, i) => fmtSignedPct(gapPct(perfSales[i] ?? null, forecastSales[i] ?? null))), tone: periods.map((_, i) => toneUp(gapPct(perfSales[i] ?? null, forecastSales[i] ?? null))) },
      { id: 'actual-vs-performance', label: 'Actual vs Performance (RM)', cells: periods.map((_, i) => fmtSigned(gapSen(actualSales[i] ?? null, perfSales[i] ?? null))) },
    ]
    : metric === 'gp'
      ? [
        { id: 'performance-gp', label: 'Performance gross profit', cells: perfGp.map(fmtOrDash), strong: true },
        { id: 'forecast-gp', label: 'Forecast gross profit', cells: forecastGp.map(fmtOrDash) },
        { id: 'gp-vs-forecast', label: 'vs Forecast (RM)', cells: periods.map((_, i) => fmtSigned(gapSen(perfGp[i] ?? null, forecastGp[i] ?? null))), tone: periods.map((_, i) => toneUp(gapSen(perfGp[i] ?? null, forecastGp[i] ?? null))) },
        { id: 'gp-vs-forecast-pct', label: 'vs Forecast (%)', cells: periods.map((_, i) => fmtSignedPct(gapPct(perfGp[i] ?? null, forecastGp[i] ?? null))), tone: periods.map((_, i) => toneUp(gapPct(perfGp[i] ?? null, forecastGp[i] ?? null))) },
        { id: 'performance-cost', label: 'Performance cost', cells: perfCost.map(fmtOrDash) },
        { id: 'forecast-cost', label: 'Forecast cost', cells: forecastCost.map(fmtOrDash) },
      ]
      : [
        { id: 'performance-gp-pct', label: 'Performance GP %', cells: perfGpPct.map(fmtPct), strong: true },
        { id: 'forecast-gp-pct', label: 'Forecast GP %', cells: forecastGpPct.map(fmtPct) },
        { id: 'gp-pct-vs-forecast', label: 'vs Forecast (pp)', cells: periods.map((_, i) => fmtPp(perfGpPct[i] != null && forecastGpPct[i] != null ? Math.round((perfGpPct[i]! - forecastGpPct[i]!) * 10) / 10 : null)), tone: periods.map((_, i) => toneUp(perfGpPct[i] != null && forecastGpPct[i] != null ? perfGpPct[i]! - forecastGpPct[i]! : null)) },
      ];
  /* On All, one row per group for the metric's performance side. */
  const groupRows: TableRow[] = groupKey === 'all'
    ? present.map((g) => ({ id: `${g.key}-performance`, label: `${g.label} — performance ${metricLabel.toLowerCase()}`, cells: periods.map((p) => { const x = groupOf(p, g.key); return x ? fmtMetric(perfOf(x)) : '—'; }) }))
    : [];
  return (
    <CardShell title="Performance vs forecast by product group" controls={<Tabs options={COMPARE_METRICS} value={metric} onChange={(k) => setMetric(k as CompareMetric)} />}>
      <div style={{ marginBottom: 'var(--space-2)' }}>
        <Tabs options={[{ key: 'all', label: 'All' }, ...present]} value={groupKey} onChange={setGroupKey} />
      </div>
      <DashboardChart labels={periods.map(labelOf)} bars={bars} lines={lines} unit={metric === 'gpPct' ? 'pct' : 'sen'} ariaLabel={`${metricLabel} — ${groupLabel}: actual and performance bars, forecast line`} />
      <FiguresTable periods={periods} rows={[...rows, ...groupRows]} ariaLabel="Performance figures" />
      <div style={soft}>Actual = the ledger's trading income through each group's sales accounts (the P&L's own figure); Performance = the sales orders dated in the period (delivered or not), sales and cost per group; Forecast = the Forecast P&L through the same accounts. Bedding = mattress + bedframe; the ledger's cost of sales is one periodic figure, so gross profit compares the orders with the forecast only.</div>
    </CardShell>
  );
};

/* ── 3 · Cost structure by product group ────────────────────────────────── */

type Measure = 'spend' | 'purchase' | 'closingStock';
const MEASURES: Array<{ key: Measure; label: string }> = [{ key: 'spend', label: 'Spend' }, { key: 'purchase', label: 'Purchase' }, { key: 'closingStock', label: 'Closing stock' }];
const measureOf = (g: CostStructureGroup, m: Measure): number => (m === 'spend' ? g.spendSen : m === 'purchase' ? g.purchaseSen : g.closingStockSen);

const CostStructureCard = ({ periods, groups }: { periods: DashboardPeriod[]; groups: Array<{ key: string; label: string }> }) => {
  const [measure, setMeasure] = useState<Measure>('spend');
  const [ticked, setTicked] = useState<Set<string>>(() => new Set(groups.map((g) => g.key)));
  const groupOf = (p: DashboardPeriod, key: string) => p.costStructure?.groups.find((g) => g.key === key);
  const present = groups.filter((g) => g.key !== 'others' || periods.some((p) => groupOf(p, g.key) != null));
  const allTicked = present.every((g) => ticked.has(g.key));
  const bars: ChartSeries[] = present.filter((g) => ticked.has(g.key)).map((g) => ({
    key: g.key, label: g.label, color: colorOf(g.key),
    values: periods.map((p) => (p.costStructure ? measureOf(groupOf(p, g.key) ?? { key: g.key, label: g.label, spendSen: 0, purchaseSen: 0, closingStockSen: 0 }, measure) : null)),
  }));
  /* The forecast keys cost of sales per purchase account, not per group: its line sums the whole, so it draws only on Purchase with every group ticked. */
  const lines: ChartLine[] = measure === 'purchase' && allTicked
    ? [{ key: 'forecast', label: 'Forecast cost of sales', color: RED, dashed: true, values: periods.map((p) => p.forecast?.costOfSalesSen ?? null) }]
    : [];
  const rows: TableRow[] = [
    ...present.map((g) => ({ id: g.key, label: g.label, cells: periods.map((p) => (p.costStructure ? fmtSenPlain(measureOf(groupOf(p, g.key) ?? { key: g.key, label: g.label, spendSen: 0, purchaseSen: 0, closingStockSen: 0 }, measure)) : '—')) })),
    { id: 'total', label: 'TOTAL', strong: true, cells: periods.map((p) => (p.costStructure ? fmtSenPlain(p.costStructure.groups.reduce((s, g) => s + measureOf(g, measure), 0)) : '—')) },
  ];
  const toggle = (key: string) => setTicked((t) => { const n = new Set(t); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  return (
    <CardShell title="Cost structure by product group" controls={<Tabs options={MEASURES} value={measure} onChange={(k) => setMeasure(k as Measure)} />}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 'var(--space-2)', alignItems: 'center' }}>
        <span style={soft}>Show</span>
        {present.map((g) => (
          <label key={g.key} style={{ ...soft, display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
            <input type="checkbox" checked={ticked.has(g.key)} onChange={() => toggle(g.key)} aria-label={`Show ${g.label}`} />
            <span style={{ width: 10, height: 10, background: colorOf(g.key), borderRadius: 2, display: 'inline-block' }} />{g.label}
          </label>
        ))}
      </div>
      <DashboardChart labels={periods.map(labelOf)} bars={bars} stacked lines={lines} ariaLabel={`${MEASURES.find((m) => m.key === measure)?.label ?? ''} per product group`} />
      <FiguresTable periods={periods} rows={rows} ariaLabel="Cost structure figures" />
      <div style={soft}>Spend = the orders' cost per group; Purchase = the groups' purchase accounts in the period; Closing stock = the stock engine by product category on the period's last day. Bedding = mattress + bedframe.</div>
    </CardShell>
  );
};

/* ── 4 · Cash Flow ───────────────────────────────────────────────────────── */

const CASH_TABS = [{ key: 'in', label: 'In' }, { key: 'out', label: 'Out' }, { key: 'net', label: 'Net' }];
const topCategories = (tree: LaidNode[]): LaidNode[] => tree.filter((n) => n.kind === 'category' || n.kind === 'unassigned' || n.kind === 'subtotal');

const CashFlowCard = ({ periods }: { periods: DashboardPeriod[] }) => {
  const [tab, setTab] = useState('in');
  const [detail, setDetail] = useState(false);
  const pick = (p: DashboardPeriod): number | null => (p.cashFlow ? (tab === 'in' ? p.cashFlow.inSen : tab === 'out' ? p.cashFlow.outSen : p.cashFlow.netSen) : null);
  const color = tab === 'in' ? IN : tab === 'out' ? OUT : GOLD;
  const bars: ChartSeries[] = [{ key: tab, label: `Cash ${tab}`, color, values: periods.map(pick) }];
  /* Detail: the Cash Flow tree's top categories, one row each, in the order they first appear. */
  const labels: string[] = [];
  for (const p of periods) for (const n of topCategories(p.cashFlow?.tree ?? [])) if (!labels.includes(n.label)) labels.push(n.label);
  const rows: TableRow[] = [
    { id: 'in', label: 'Cash in', cells: periods.map((p) => fmtOrDash(p.cashFlow?.inSen)), strong: tab === 'in' },
    { id: 'out', label: 'Cash out', cells: periods.map((p) => fmtOrDash(p.cashFlow?.outSen)), strong: tab === 'out' },
    { id: 'net', label: 'Net', cells: periods.map((p) => fmtOrDash(p.cashFlow?.netSen)), strong: tab === 'net', tone: periods.map((p) => (p.cashFlow == null || p.cashFlow.netSen === 0 ? null : p.cashFlow.netSen > 0 ? 'good' : 'bad')) },
    { id: 'opening', label: 'Balance b/f', cells: periods.map((p) => fmtOrDash(p.cashFlow?.openingSen)) },
    { id: 'closing', label: 'Balance c/f', cells: periods.map((p) => fmtOrDash(p.cashFlow?.closingSen)) },
    ...(detail ? labels.map((label) => ({
      id: `cat:${label}`, label,
      cells: periods.map((p) => { const n = topCategories(p.cashFlow?.tree ?? []).find((x) => x.label === label); return n ? fmtSenPlain(n.amountSen) : '—'; }),
    })) : []),
  ];
  return (
    <CardShell title="Cash Flow" controls={<><Tabs options={CASH_TABS} value={tab} onChange={setTab} /><Button variant="ghost" size="sm" onClick={() => setDetail((d) => !d)}>{detail ? 'Summary' : 'Detail'}</Button></>}>
      <DashboardChart labels={periods.map(labelOf)} bars={bars} ariaLabel={`Cash ${tab} per period`} />
      <FiguresTable periods={periods} rows={rows} ariaLabel="Cash flow figures" />
    </CardShell>
  );
};

/* ── 5 · Balance Sheet ───────────────────────────────────────────────────── */

const BalanceSheetCard = ({ periods }: { periods: DashboardPeriod[] }) => {
  const bars: ChartSeries[] = [
    { key: 'assets', label: 'Assets', color: GOLD, values: periods.map((p) => p.balanceSheet?.assetsSen ?? null) },
    { key: 'liabilities', label: 'Liabilities', color: OUT, values: periods.map((p) => p.balanceSheet?.liabilitiesSen ?? null) },
  ];
  const lines: ChartLine[] = [{ key: 'debt-to-asset', label: 'Debt / assets %', color: RED, axis: 'right', values: periods.map((p) => p.balanceSheet?.debtToAssetPct ?? null) }];
  const rows: TableRow[] = [
    { id: 'assets', label: 'Total assets', cells: periods.map((p) => fmtOrDash(p.balanceSheet?.assetsSen)), strong: true },
    { id: 'liabilities', label: 'Total liabilities', cells: periods.map((p) => fmtOrDash(p.balanceSheet?.liabilitiesSen)), strong: true },
    { id: 'equity', label: 'Equity incl. current earnings', cells: periods.map((p) => (p.balanceSheet ? fmtSenPlain(p.balanceSheet.equitySen + p.balanceSheet.earningsSen) : '—')) },
    { id: 'current-assets', label: 'Current assets', cells: periods.map((p) => fmtOrDash(p.balanceSheet?.currentAssetsSen)) },
    { id: 'current-liabilities', label: 'Current liabilities', cells: periods.map((p) => fmtOrDash(p.balanceSheet?.currentLiabilitiesSen)) },
    { id: 'inventory', label: 'Stock (the engine as at the period end)', cells: periods.map((p) => fmtOrDash(p.balanceSheet?.inventorySen)) },
    { id: 'debt-to-asset', label: 'Debt / assets', cells: periods.map((p) => fmtPct(p.balanceSheet?.debtToAssetPct)) },
    { id: 'check', label: 'Self-check (must be 0.00)', cells: periods.map((p) => fmtOrDash(p.balanceSheet?.checkSen)), tone: periods.map((p) => (p.balanceSheet == null || p.balanceSheet.checkSen === 0 ? null : 'bad')) },
  ];
  return (
    <CardShell title="Balance Sheet">
      <DashboardChart labels={periods.map(labelOf)} bars={bars} lines={lines} ariaLabel="Assets and liabilities, debt-to-asset % on the right axis" />
      <FiguresTable periods={periods} rows={rows} ariaLabel="Balance sheet figures" />
    </CardShell>
  );
};

/* ── 6 · Financial Ratios ────────────────────────────────────────────────── */

type RatioDef = { key: string; label: string; unit: 'pct' | 'ratio'; of: (p: DashboardPeriod) => number | null };
const RATIOS: RatioDef[] = [
  { key: 'gross-margin', label: 'Gross Margin', unit: 'pct', of: (p) => p.ratios.grossMarginPct },
  { key: 'net-margin', label: 'Net Margin', unit: 'pct', of: (p) => p.ratios.netMarginPct },
  { key: 'current', label: 'Current Ratio', unit: 'ratio', of: (p) => p.ratios.currentRatio },
  { key: 'quick', label: 'Quick Ratio', unit: 'ratio', of: (p) => p.ratios.quickRatio },
  { key: 'roe', label: 'ROE', unit: 'pct', of: (p) => p.ratios.roePct },
  { key: 'roa', label: 'ROA', unit: 'pct', of: (p) => p.ratios.roaPct },
];

const RatiosCard = ({ periods }: { periods: DashboardPeriod[] }) => {
  const [key, setKey] = useState('gross-margin');
  const def = RATIOS.find((r) => r.key === key) ?? RATIOS[0]!;
  const values = periods.map(def.of);
  const lines: ChartLine[] = [{ key: def.key, label: def.label, color: GOLD, values }];
  const rows: TableRow[] = [{ id: def.key, label: def.label, cells: values.map((v) => (def.unit === 'pct' ? fmtPct(v) : fmtRatio(v))), strong: true }];
  return (
    <CardShell title="Financial Ratios" controls={<Tabs options={RATIOS} value={key} onChange={setKey} />}>
      <DashboardChart labels={periods.map(labelOf)} bars={[]} lines={lines} unit={def.unit} ariaLabel={`${def.label} per period`} />
      <FiguresTable periods={periods} rows={rows} ariaLabel="Ratio figures" />
      <div style={soft}>Margins off the period's P&L; current and quick ratios, ROE and ROA off the balance sheet at the period's end (ROE and ROA on the period's net profit, not annualised).</div>
    </CardShell>
  );
};

/* ── The page ────────────────────────────────────────────────────────────── */

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export const FinanceDashboard = () => {
  const [granularity, setGranularity] = useState<Granularity>('month');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const ranged = MONTH_RE.test(from) && MONTH_RE.test(to) && from <= to;
  const q = useFinanceDashboard({ granularity, from: ranged ? from : null, to: ranged ? to : null });
  const periods = useMemo(() => q.data?.periods ?? [], [q.data]);
  const provisional = periods.filter((p) => p.actual != null && p.stock.closingProvisional).map(labelOf);

  return (
    <div className="space-y-4">
      <PageHeader eyebrow="Finance · Forecasting" title="Dashboard"
        description="The statements' actuals (gold) beside the Forecast P&L's targets (red, dashed), per month or quarter. Every figure is the report's own — the P&L, the Cash Flow, the Performance P&L, the balance sheet — read once per period. Nothing here writes." />
      <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center', flexWrap: 'wrap' }}>
        <Tabs options={[{ key: 'month', label: 'Monthly' }, { key: 'quarter', label: 'Quarterly' }]} value={granularity} onChange={(k) => setGranularity(k as Granularity)} />
        <span style={soft}>Period</span>
        <input type="month" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From month" style={input} />
        <span style={soft}>→</span>
        <input type="month" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To month" style={input} />
        <Button variant="ghost" size="sm" onClick={() => { setFrom(''); setTo(''); }} disabled={!from && !to}>Reset</Button>
        <span style={{ flex: 1 }} />
        {q.isFetching && <span style={soft}>Loading…</span>}
      </div>
      <div style={soft}>* this period is not finished — a small figure is not a fall.{provisional.length > 0 && ` Closing stock for ${provisional.join(', ')} is what the shelves hold today — provisional until the month-end close books it.`}</div>
      {q.isError && <div role="alert" style={{ color: danger }}>{errText(q.error)}</div>}
      {!q.isError && q.data && periods.length === 0 && <div style={soft}>Nothing to show for this window.</div>}
      {q.data && periods.length > 0 && (
        <>
          <IncomeStatementCard periods={periods} />
          <PerformanceCard periods={periods} groups={q.data.groups.compare} />
          <CostStructureCard periods={periods} groups={q.data.groups.costStructure} />
          <CashFlowCard periods={periods} />
          <BalanceSheetCard periods={periods} />
          <RatiosCard periods={periods} />
        </>
      )}
    </div>
  );
};
