// ----------------------------------------------------------------------------
// ProductProfitCharts — the three charts the owner kept for the Product Profit
// tab (2026-10-05: 「第一个的可以，第4可以，有没有 pie chart?」): the gross-profit
// ranking, the share of gross profit (a donut), and the waterfall from sales to
// gross profit. Plain SVG in the app's own palette — no chart library — with
// the font written on each chart, so "Charts PNG" draws them exactly as shown.
// ----------------------------------------------------------------------------

import { forwardRef } from 'react';
import type { Slice, Step } from './product-profit-view';

const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";
const INK = '#11140f';
const INK2 = '#414539';
const MUTED = '#767b6e';
const GRID = '#e3e6e0';
const PETROL = '#16695f';
const RED = '#b23a3a';
const BRASS = '#a16a2e';
const GREEN = '#2f8a5b';
export const SLICE_COLOURS = ['#16695f', '#a16a2e', '#1f3a8a', '#2f8a5b', '#7a3e6e', '#4a6670'];
const REST_COLOUR = '#c2c6bd';
const CATEGORY_COLOURS = { mattress: '#16695f', sofa: '#a16a2e', bedframe: '#1f3a8a', other: '#767b6e' } as const;

/** A figure the way a chart can carry it: 1.50m, 341k, 950. */
export const compact = (sen: number): string => {
  const rm = Math.abs(sen) / 100;
  const s = rm >= 1_000_000 ? `${(rm / 1_000_000).toFixed(2)}m` : rm >= 10_000 ? `${Math.round(rm / 1000).toLocaleString('en-US')}k` : rm >= 1000 ? `${(rm / 1000).toFixed(1)}k` : String(Math.round(rm));
  return (sen < 0 ? '-' : '') + s;
};
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export type RankBar = { label: string; valueSen: number; note: string };

/** ① The gross-profit ranking: one bar per product, the figure and its margin at the end. */
export const RankingChart = forwardRef<SVGSVGElement, { bars: RankBar[] }>(({ bars }, ref) => {
  const W = 760;
  const rowH = 30;
  const H = 16 + Math.max(1, bars.length) * rowH;
  const x0 = 210;
  const x1 = W - 150;
  const lo = Math.min(0, ...bars.map((b) => b.valueSen));
  const hi = Math.max(0, ...bars.map((b) => b.valueSen));
  const span = hi - lo || 1;
  const xOf = (v: number) => x0 + ((v - lo) / span) * (x1 - x0);
  const zero = xOf(0);
  return (
    <svg ref={ref} viewBox={`0 0 ${W} ${H}`} width="100%" style={{ maxWidth: W, display: 'block' }} fontFamily={FONT} role="img" aria-label="Gross profit by product, highest first">
      <rect x={0} y={0} width={W} height={H} fill="#ffffff" />
      <line x1={zero} x2={zero} y1={4} y2={H - 4} stroke={GRID} />
      {bars.map((b, i) => {
        const y = 8 + i * rowH;
        const xv = xOf(b.valueSen);
        const neg = b.valueSen < 0;
        return (
          <g key={`${b.label}-${i}`}>
            <text x={x0 - 10} y={y + 15} fontSize={12} fill={INK} textAnchor="end">{clip(`${i + 1}. ${b.label}`, 30)}</text>
            <rect x={Math.min(zero, xv)} y={y + 3} width={Math.max(1, Math.abs(xv - zero))} height={18} rx={3} fill={neg ? RED : PETROL} />
            <text x={Math.max(zero, xv) + 6} y={y + 16} fontSize={11} fill={INK2}>{b.note}</text>
          </g>
        );
      })}
    </svg>
  );
});
RankingChart.displayName = 'RankingChart';

/** The share of gross profit, as a donut with its legend beside it. */
export const ShareDonut = forwardRef<SVGSVGElement, { slices: Slice[]; footnote?: string }>(({ slices, footnote }, ref) => {
  const W = 380;
  const legendH = 22 * Math.max(slices.length, 1);
  const H = Math.max(200, legendH + 30) + (footnote ? 18 : 0);
  const cx = 95;
  const cy = 100;
  const R = 80;
  const r = 50;
  const total = slices.reduce((a, s) => a + s.valueSen, 0);
  const colour = (i: number, s: Slice) => (s.category ? CATEGORY_COLOURS[s.category] : s.rest ? REST_COLOUR : SLICE_COLOURS[i % SLICE_COLOURS.length]);
  let angle = -Math.PI / 2;
  const arcs = slices.map((s, i) => {
    const sweep = total > 0 ? (s.valueSen / total) * Math.PI * 2 : 0;
    const a0 = angle;
    const a1 = angle + sweep;
    angle = a1;
    const large = sweep > Math.PI ? 1 : 0;
    const p = (rad: number, rr: number) => `${(cx + rr * Math.cos(rad)).toFixed(2)} ${(cy + rr * Math.sin(rad)).toFixed(2)}`;
    const d = `M ${p(a0, R)} A ${R} ${R} 0 ${large} 1 ${p(a1, R)} L ${p(a1, r)} A ${r} ${r} 0 ${large} 0 ${p(a0, r)} Z`;
    return { d, fill: colour(i, s), whole: sweep >= Math.PI * 2 - 1e-9 };
  });
  return (
    <svg ref={ref} viewBox={`0 0 ${W} ${H}`} width="100%" style={{ maxWidth: W, display: 'block' }} fontFamily={FONT} role="img" aria-label="Share of gross profit">
      <rect x={0} y={0} width={W} height={H} fill="#ffffff" />
      {total <= 0 && <text x={cx} y={cy} fontSize={12} fill={MUTED} textAnchor="middle">No product made money</text>}
      {total > 0 && arcs.map((a, i) => (a.whole
        ? <circle key={i} cx={cx} cy={cy} r={(R + r) / 2} fill="none" stroke={a.fill} strokeWidth={R - r} />
        : <path key={i} d={a.d} fill={a.fill} stroke="#ffffff" strokeWidth={1.5} />))}
      {total > 0 && (
        <>
          <text x={cx} y={cy - 4} fontSize={11} fill={MUTED} textAnchor="middle">Gross profit</text>
          <text x={cx} y={cy + 13} fontSize={14} fontWeight={600} fill={INK} textAnchor="middle">{compact(total)}</text>
        </>
      )}
      {slices.map((s, i) => (
        <g key={`${s.label}-${i}`} transform={`translate(200 ${18 + i * 22})`}>
          <rect x={0} y={-9} width={10} height={10} rx={2} fill={colour(i, s)} />
          <text x={16} y={0} fontSize={12} fill={INK}>{clip(s.label, 16)}</text>
          <text x={178} y={0} fontSize={11} fill={INK2} textAnchor="end">{`${total > 0 ? ((s.valueSen / total) * 100).toFixed(1) : '0.0'}% · ${compact(s.valueSen)}`}</text>
        </g>
      ))}
      {footnote && <text x={8} y={H - 6} fontSize={11} fill={MUTED}>{footnote}</text>}
    </svg>
  );
});
ShareDonut.displayName = 'ShareDonut';

/** ④ The waterfall: sales, less own cost, less the gifts when they count, is gross profit. */
export const ProfitWaterfall = forwardRef<SVGSVGElement, { steps: Step[] }>(({ steps }, ref) => {
  const W = 380;
  const H = 250;
  const left = 52;
  const right = W - 12;
  const top = 22;
  const bottom = H - 34;
  const spans: Array<[number, number]> = [];
  let run = 0;
  for (const s of steps) {
    if (s.kind === 'start') { spans.push([0, s.valueSen]); run = s.valueSen; } else if (s.kind === 'end') spans.push([0, s.valueSen]);
    else { spans.push([run + s.valueSen, run]); run += s.valueSen; }
  }
  const lo = Math.min(0, ...spans.flat());
  const hi = Math.max(1, ...spans.flat());
  const yOf = (v: number) => bottom - ((v - lo) / (hi - lo)) * (bottom - top);
  const slot = (right - left) / Math.max(steps.length, 1);
  const barW = Math.min(64, slot * 0.58);
  const ticks = [0, 1, 2, 3, 4].map((k) => lo + ((hi - lo) * k) / 4);
  const fill = (s: Step) => (s.key === 'sales' ? PETROL : s.key === 'gp' ? GREEN : s.key === 'gifts' ? BRASS : RED);
  return (
    <svg ref={ref} viewBox={`0 0 ${W} ${H}`} width="100%" style={{ maxWidth: W, display: 'block' }} fontFamily={FONT} role="img" aria-label="From sales to gross profit">
      <rect x={0} y={0} width={W} height={H} fill="#ffffff" />
      {ticks.map((t, i) => (
        <g key={i}>
          <line x1={left} x2={right} y1={yOf(t)} y2={yOf(t)} stroke={GRID} />
          <text x={left - 6} y={yOf(t) + 4} fontSize={10.5} fill={MUTED} textAnchor="end">{compact(t)}</text>
        </g>
      ))}
      {steps.map((s, i) => {
        const [a, b] = spans[i];
        const yTop = yOf(Math.max(a, b));
        const yBot = yOf(Math.min(a, b));
        const cx = left + slot * i + slot / 2;
        return (
          <g key={s.key}>
            <rect x={cx - barW / 2} y={yTop} width={barW} height={Math.max(1, yBot - yTop)} rx={3} fill={fill(s)} />
            <text x={cx} y={yTop - 6} fontSize={11} fill={INK2} textAnchor="middle">{compact(s.valueSen)}</text>
            <text x={cx} y={H - 14} fontSize={12} fill={INK} textAnchor="middle">{s.label}</text>
          </g>
        );
      })}
    </svg>
  );
});
ProfitWaterfall.displayName = 'ProfitWaterfall';

/** The charts as one PNG, stacked under a title line, drawn from the same SVGs the screen shows. */
export async function chartsPng(svgs: Array<SVGSVGElement | null>, title: string, fileName: string): Promise<void> {
  const shown = svgs.filter((s): s is SVGSVGElement => s != null);
  const scale = 2;
  const sizes = shown.map((s) => ({ w: s.viewBox.baseVal.width, h: s.viewBox.baseVal.height }));
  const width = Math.max(...sizes.map((s) => s.w), 400);
  const gap = 16;
  const head = 36;
  const height = head + sizes.reduce((a, s) => a + s.h + gap, 0);
  const canvas = document.createElement('canvas');
  canvas.width = width * scale;
  canvas.height = height * scale;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.scale(scale, scale);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = INK;
  ctx.font = `600 14px ${FONT}`;
  ctx.fillText(title, 8, 22);
  let y = head;
  for (let i = 0; i < shown.length; i += 1) {
    const clone = shown[i].cloneNode(true) as SVGSVGElement;
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('width', String(sizes[i].w));
    clone.setAttribute('height', String(sizes[i].h));
    clone.removeAttribute('style');
    const xml = new XMLSerializer().serializeToString(clone);
    const url = URL.createObjectURL(new Blob([xml], { type: 'image/svg+xml;charset=utf-8' }));
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const im = new Image();
        im.onload = () => resolve(im);
        im.onerror = () => reject(new Error('The chart could not be drawn.'));
        im.src = url;
      });
      ctx.drawImage(img, 0, y, sizes[i].w, sizes[i].h);
    } finally {
      URL.revokeObjectURL(url);
    }
    y += sizes[i].h + gap;
  }
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
