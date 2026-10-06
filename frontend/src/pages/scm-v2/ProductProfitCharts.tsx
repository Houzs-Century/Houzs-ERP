// ----------------------------------------------------------------------------
// ProductProfitCharts — the three charts the owner kept for the Product Profit
// tab (2026-10-05: 「第一个的可以，第4可以，有没有 pie chart?」): the gross-profit
// ranking, the share of gross profit (a donut), and the waterfall from sales to
// gross profit. Plain SVG in the app's own palette — no chart library — drawn
// at the card's own size, one SVG unit per CSS pixel, the way the Financial
// Dashboard draws (a fixed canvas scaled to a wide card blows the labels up).
// The ranking fills the height of its card, so the three sit as one block
// (owner 2026-10-05: 「dash board 可以整理一下吗？分到太散了」). The font is
// written on each chart, so "Charts PNG" draws them exactly as shown.
// ----------------------------------------------------------------------------

import { forwardRef, useEffect, useRef, useState } from 'react';
import { compact, type RankBar, type Slice, type Step } from './product-profit-view';

export { compact };

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

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** The box a chart draws in, measured; the defaults stand in before the first
    measure and under jsdom, which has no ResizeObserver. */
function useBox(defaults: { w: number; h: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState(defaults);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        const { width, height } = e.contentRect;
        if (width > 0) setBox({ w: Math.round(width), h: Math.round(height) });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, box] as const;
}

/** The ranking: one bar per product, measuring what the rows are ranked by,
    the figures at the end. It fills its card's height — the rows grow to meet the cards
    beside it — and never draws a row shorter than 24px. */
export const RankingChart = forwardRef<SVGSVGElement, { bars: RankBar[] }>(({ bars }, ref) => {
  const n = Math.max(1, bars.length);
  const minH = 12 + n * 26;
  const [holder, box] = useBox({ w: 760, h: 12 + n * 30 });
  const W = Math.max(320, box.w);
  const H = Math.max(minH, box.h);
  const rowH = clamp((H - 12) / n, 24, 44);
  const x0 = clamp(Math.round(W * 0.26), 120, 230);
  const x1 = W - 120;
  const lo = Math.min(0, ...bars.map((b) => b.value));
  const hi = Math.max(0, ...bars.map((b) => b.value));
  const span = hi - lo || 1;
  const xOf = (v: number) => x0 + ((v - lo) / span) * (x1 - x0);
  const zero = xOf(0);
  const barH = clamp(rowH * 0.62, 14, 24);
  return (
    <div ref={holder} style={{ position: 'relative', flex: 1, minHeight: minH }}>
      <svg ref={ref} viewBox={`0 0 ${W} ${H}`} width={W} height={H} style={{ position: 'absolute', left: 0, top: 0, display: 'block' }}
        fontFamily={FONT} role="img" aria-label="Products ranked, highest first">
        <rect x={0} y={0} width={W} height={H} fill="#ffffff" />
        <line x1={zero} x2={zero} y1={4} y2={H - 4} stroke={GRID} />
        {bars.map((b, i) => {
          const mid = 6 + i * rowH + rowH / 2;
          const xv = xOf(b.value);
          const neg = b.value < 0;
          return (
            <g key={`${b.label}-${i}`}>
              <text x={x0 - 10} y={mid + 4} fontSize={12} fill={INK} textAnchor="end">{clip(`${i + 1}. ${b.label}`, Math.max(12, Math.floor((x0 - 14) / 7)))}</text>
              <rect x={Math.min(zero, xv)} y={mid - barH / 2} width={Math.max(1, Math.abs(xv - zero))} height={barH} rx={3} fill={neg ? RED : PETROL} />
              <text x={Math.max(zero, xv) + 6} y={mid + 4} fontSize={11} fill={INK2}>{b.note}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
});
RankingChart.displayName = 'RankingChart';

/** The share of gross profit, as a donut with its legend beside it (under it when the card is narrow). */
export const ShareDonut = forwardRef<SVGSVGElement, { slices: Slice[]; footnote?: string }>(({ slices, footnote }, ref) => {
  const [holder, box] = useBox({ w: 380, h: 0 });
  const W = Math.max(260, box.w);
  const rows = Math.max(slices.length, 1);
  const side = W >= 340;
  const R = side ? 72 : 64;
  const r = Math.round(R * 0.62);
  const legendH = rows * 22;
  const foot = footnote ? 18 : 0;
  const H = (side ? Math.max(2 * R + 16, legendH + 16) : 2 * R + 24 + legendH) + foot;
  const cx = side ? R + 8 : W / 2;
  const cy = side ? (H - foot) / 2 : R + 8;
  const lx = side ? 2 * R + 36 : 8;
  const ly = side ? Math.max(14, cy - legendH / 2 + 12) : 2 * R + 30;
  /* The figures sit near their names, not at the far edge of a wide card. */
  const legendW = clamp(W - lx - 8, 160, 260);
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
    <div ref={holder} style={{ width: '100%' }}>
      <svg ref={ref} viewBox={`0 0 ${W} ${H}`} width={W} height={H} style={{ display: 'block' }} fontFamily={FONT} role="img" aria-label="Share of gross profit">
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
          <g key={`${s.label}-${i}`} transform={`translate(${lx} ${ly + i * 22})`}>
            <rect x={0} y={-9} width={10} height={10} rx={2} fill={colour(i, s)} />
            <text x={16} y={0} fontSize={12} fill={INK}>{clip(s.label, Math.max(10, Math.floor((legendW - 120) / 7)))}</text>
            <text x={legendW} y={0} fontSize={11} fill={INK2} textAnchor="end">{`${total > 0 ? ((s.valueSen / total) * 100).toFixed(1) : '0.0'}% · ${compact(s.valueSen)}`}</text>
          </g>
        ))}
        {footnote && <text x={8} y={H - 6} fontSize={11} fill={MUTED}>{footnote}</text>}
      </svg>
    </div>
  );
});
ShareDonut.displayName = 'ShareDonut';

/** The waterfall: sales, less own cost, less the gifts when they count, is gross profit. */
export const ProfitWaterfall = forwardRef<SVGSVGElement, { steps: Step[] }>(({ steps }, ref) => {
  const [holder, box] = useBox({ w: 380, h: 0 });
  const W = Math.max(260, box.w);
  const H = 220;
  const left = 52;
  const right = W - 12;
  const top = 22;
  const bottom = H - 30;
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
  const barW = Math.min(72, slot * 0.56);
  const ticks = [0, 1, 2, 3, 4].map((k) => lo + ((hi - lo) * k) / 4);
  const fill = (s: Step) => (s.key === 'sales' ? PETROL : s.key === 'gp' ? GREEN : s.key === 'gifts' ? BRASS : RED);
  return (
    <div ref={holder} style={{ width: '100%' }}>
      <svg ref={ref} viewBox={`0 0 ${W} ${H}`} width={W} height={H} style={{ display: 'block' }} fontFamily={FONT} role="img" aria-label="From sales to gross profit">
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
              <text x={cx} y={H - 10} fontSize={12} fill={INK} textAnchor="middle">{s.label}</text>
            </g>
          );
        })}
      </svg>
    </div>
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
