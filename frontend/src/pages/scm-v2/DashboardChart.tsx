// ----------------------------------------------------------------------------
// DashboardChart — the one chart the Financial Dashboard's cards draw with:
// bars per period (one series, or several stacked or side by side) and up to
// two lines over them, drawn by hand as inline SVG. The trading ERP carries
// no chart library and its bundle-size gate would refuse one; the ~200 lines
// here do the job and read the theme's tokens for light and dark.
//
// The rules the Porting Guide learned the hard way, kept here: a period with
// no value is NULL, never 0 — a bar is not drawn and a line BREAKS there
// (the forecast's dashed line stops where no month carries a row); every
// bar and point carries a tooltip with the figure AND its share; a partial
// period's label already wears its " *" when the card hands it in.
// ----------------------------------------------------------------------------
import { Fragment, useEffect, useRef, useState } from 'react';

export type ChartSeries = {
  key: string;
  label: string;
  color: string;
  /** One value per period, in sen (or a % when the chart's unit is 'pct'); null = nothing to draw. */
  values: Array<number | null>;
  /** The tooltip per period, when the figure alone is not enough (the % share rides here). */
  tips?: Array<string | null>;
  /** Series naming the same stack pile up in one column; one without a stack stands in its own (the Performance card: an actual bar beside the groups' stack). */
  stack?: string;
};
export type ChartLine = ChartSeries & {
  dashed?: boolean;
  /** 'right' draws the line on a second, % axis. */
  axis?: 'left' | 'right';
};
export type DashboardChartProps = {
  labels: string[];
  bars: ChartSeries[];
  /** Every bar series stacks in one column (the cost structure); otherwise each series stands in its own column unless it names a `stack`. */
  stacked?: boolean;
  lines?: ChartLine[];
  /** What the left axis counts: sen (RM), a % or a plain ratio. */
  unit?: 'sen' | 'pct' | 'ratio';
  height?: number;
  ariaLabel: string;
};

/** An axis tick as short as it can be: 1.2m, 120k, 1,234; a % as 40%. */
export const fmtAxis = (v: number, unit: 'sen' | 'pct' | 'ratio'): string => {
  if (unit === 'pct') return `${Number.isInteger(v) ? v : v.toFixed(1)}%`;
  if (unit === 'ratio') return v.toFixed(2);
  const rm = v / 100;
  const abs = Math.abs(rm);
  const sign = rm < 0 ? '-' : '';
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}m`;
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(abs >= 100_000 ? 0 : 1)}k`;
  return `${sign}${abs.toLocaleString('en-MY', { maximumFractionDigits: 0 })}`;
};

/** A "nice" step for about five ticks between lo and hi. */
const niceStep = (span: number): number => {
  if (span <= 0) return 1;
  const raw = span / 5;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  return step * mag;
};
type Scale = { lo: number; hi: number; ticks: number[] };
/** The axis range: from the smallest value (or 0) to the largest (or 0), on nice ticks. */
export const scaleOf = (values: Array<number | null>): Scale => {
  const present = values.filter((v): v is number => v != null && Number.isFinite(v));
  const min = Math.min(0, ...present);
  const max = Math.max(0, ...present);
  if (min === 0 && max === 0) return { lo: 0, hi: 1, ticks: [0, 1] };
  const step = niceStep(max - min);
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let t = lo; t <= hi + step / 2; t += step) ticks.push(Math.round(t * 1e6) / 1e6);
  return { lo, hi: hi === lo ? lo + step : hi, ticks };
};

/** Before the card is measured (and under jsdom, which has no ResizeObserver). */
const DEFAULT_W = 760;
/** The narrowest canvas: under it the figure scrolls sideways rather than shrinking its text (the finance pages are desktop pages). */
const MIN_W = 700;
const PAD = { top: 14, right: 16, bottom: 34, left: 60 };

export const DashboardChart = ({ labels, bars, stacked = false, lines = [], unit = 'sen', height = 260, ariaLabel }: DashboardChartProps) => {
  const n = labels.length;
  /* Drawn at the card's own width, one SVG unit per CSS pixel. The canvas used
     to be a fixed 760 scaled to the card, so a wide screen blew the chart up
     and its 11px labels with it while the table beneath stayed 13px (owner
     2026-09-22: 图很大，字很小). */
  const holder = useRef<HTMLElement>(null);
  const [W, setW] = useState(DEFAULT_W);
  useEffect(() => {
    const el = holder.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      if (width > 0) setW(Math.max(MIN_W, Math.round(width)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const rightLines = lines.filter((l) => l.axis === 'right');
  const leftLines = lines.filter((l) => l.axis !== 'right');
  const padRight = rightLines.length > 0 ? 48 : PAD.right;
  const plotW = W - PAD.left - padRight;
  const plotH = height - PAD.top - PAD.bottom;
  /* The columns a period draws: one pile of every series, or a pile per named stack and a column per loose series, in first appearance. */
  const columns: ChartSeries[][] = stacked ? [bars] : (() => {
    const piles = new Map<string, ChartSeries[]>();
    for (const s of bars) { const k = s.stack ?? `solo:${s.key}`; piles.set(k, [...(piles.get(k) ?? []), s]); }
    return [...piles.values()];
  })();
  /* The left axis spans every column's piled totals and every left line. */
  const stackTops = labels.flatMap((_, i) => columns.flatMap((col) => {
    let up = 0; let down = 0;
    for (const s of col) { const v = s.values[i]; if (v == null) continue; if (v >= 0) up += v; else down += v; }
    return [up, down];
  }));
  const left = scaleOf([...stackTops, ...leftLines.flatMap((l) => l.values)]);
  const right = scaleOf(rightLines.flatMap((l) => l.values));
  const yOf = (v: number, s: Scale): number => PAD.top + plotH - ((v - s.lo) / (s.hi - s.lo)) * plotH;
  const slot = n > 0 ? plotW / n : plotW;
  const xCenter = (i: number): number => PAD.left + slot * i + slot / 2;

  const barRects: Array<{ key: string; x: number; y: number; w: number; h: number; color: string; tip: string; group: string; period: number }> = [];
  const groupW = Math.min(slot * 0.72, 64);
  const each = columns.length > 0 ? groupW / columns.length : groupW;
  const colW = columns.length > 1 ? Math.max(each - 2, 2) : groupW;
  labels.forEach((label, i) => {
    columns.forEach((col, j) => {
      let up = 0; let down = 0;
      for (const s of col) {
        const v = s.values[i];
        if (v == null || v === 0) continue;
        const from = v >= 0 ? up : down;
        const to = from + v;
        if (v >= 0) up = to; else down = to;
        const y1 = yOf(from, left); const y2 = yOf(to, left);
        barRects.push({ key: `${s.key}:${i}`, x: xCenter(i) - groupW / 2 + each * j, y: Math.min(y1, y2), w: colW, h: Math.abs(y2 - y1), color: s.color, tip: s.tips?.[i] ?? `${label} · ${s.label}: ${fmtAxis(v, unit)}`, group: s.key, period: i });
      }
    });
  });

  /** A line's segments: consecutive present points join; a null breaks the line. */
  const segmentsOf = (l: ChartLine): string[] => {
    const s = l.axis === 'right' ? right : left;
    const out: string[] = [];
    let cur: string[] = [];
    l.values.forEach((v, i) => {
      if (v == null) { if (cur.length > 1) out.push(cur.join(' ')); cur = []; return; }
      cur.push(`${cur.length === 0 ? 'M' : 'L'}${xCenter(i).toFixed(1)} ${yOf(v, s).toFixed(1)}`);
    });
    if (cur.length > 1) out.push(cur.join(' '));
    return out;
  };

  const axisColor = 'var(--c-line, rgba(34,31,32,0.25))';
  const textStyle = { fontSize: 12, fill: 'currentColor', opacity: 0.75 } as const;
  return (
    <figure ref={holder} style={{ margin: 0, overflowX: 'auto' }}>
      <svg viewBox={`0 0 ${W} ${height}`} width={W} height={height} role="img" aria-label={ariaLabel} style={{ display: 'block', color: 'inherit', maxWidth: 'none' }}>
        {/* The left axis' ticks and grid. */}
        {left.ticks.map((t) => (
          <Fragment key={`l${t}`}>
            <line x1={PAD.left} x2={W - padRight} y1={yOf(t, left)} y2={yOf(t, left)} stroke={axisColor} strokeWidth={t === 0 ? 1.2 : 0.6} strokeDasharray={t === 0 ? undefined : '2 3'} />
            <text x={PAD.left - 6} y={yOf(t, left) + 4} textAnchor="end" style={textStyle}>{fmtAxis(t, unit)}</text>
          </Fragment>
        ))}
        {rightLines.length > 0 && right.ticks.map((t) => (
          <text key={`r${t}`} x={W - padRight + 6} y={yOf(t, right) + 4} textAnchor="start" style={textStyle}>{fmtAxis(t, 'pct')}</text>
        ))}
        {/* The periods. */}
        {labels.map((label, i) => (
          <text key={`x${i}`} x={xCenter(i)} y={height - PAD.bottom + 16} textAnchor="middle" style={textStyle}>{label}</text>
        ))}
        {/* The bars. */}
        {barRects.map((r) => (
          <rect key={r.key} x={r.x} y={r.y} width={r.w} height={Math.max(r.h, r.h === 0 ? 0 : 1)} fill={r.color} rx={1.5} data-group={r.group} data-period={r.period}>
            <title>{r.tip}</title>
          </rect>
        ))}
        {/* The lines: a null breaks them. */}
        {lines.map((l) => (
          <g key={l.key} data-line={l.key}>
            {segmentsOf(l).map((d, k) => (
              <path key={k} d={d} fill="none" stroke={l.color} strokeWidth={2} strokeDasharray={l.dashed ? '6 4' : undefined} data-segment={l.key} />
            ))}
            {l.values.map((v, i) => v == null ? null : (
              <circle key={i} cx={xCenter(i)} cy={yOf(v, l.axis === 'right' ? right : left)} r={3} fill={l.color} data-point={l.key} data-period={i}>
                <title>{l.tips?.[i] ?? `${labels[i]} · ${l.label}: ${fmtAxis(v, l.axis === 'right' ? 'pct' : unit)}`}</title>
              </circle>
            ))}
          </g>
        ))}
      </svg>
      <figcaption style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 'var(--fs-11)', color: 'var(--fg-muted)', padding: '4px 2px 0' }}>
        {bars.map((s) => (
          <span key={s.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><span style={{ width: 10, height: 10, background: s.color, borderRadius: 2, display: 'inline-block' }} />{s.label}</span>
        ))}
        {lines.map((l) => (
          <span key={l.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><span style={{ width: 16, height: 0, borderTop: `2px ${l.dashed ? 'dashed' : 'solid'} ${l.color}`, display: 'inline-block' }} />{l.label}</span>
        ))}
      </figcaption>
    </figure>
  );
};
