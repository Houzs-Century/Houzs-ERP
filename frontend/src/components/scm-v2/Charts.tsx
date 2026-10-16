// Small SVG charts for the module Overview pages (owner, 2026-10-17: mix pie,
// bar and report formats so problems stand out). No chart library: each chart
// is a few shapes, sized by its container, with the exact figure on hover.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "../../lib/utils";

export const PALETTE = ["#16695f", "#a16a2e", "#4f7cac", "#c2603d", "#7a8f3c", "#8a5a9e", "#3d9c94", "#b8913f", "#6b7a8f", "#a34d6d"];
export const TONE = { good: "#2f8a5b", warn: "#c08a1e", bad: "#b23a3a", muted: "#c9cdc4", main: "#16695f", brass: "#a16a2e" } as const;

type Fmt = (n: number) => string;
const pctOf = (v: number, total: number) => (total > 0 ? `${((v / total) * 100).toFixed(total > 0 && v / total < 0.1 ? 1 : 0)}%` : "—");

export interface Slice { label: string; value: number; color: string | null }

/** A donut with its legend: each slice's figure and share. */
export function Donut({ data, format, center, size }: { data: Slice[]; format: Fmt; center: { value: string; label: string } | null; size: number }) {
  const rows = data.filter((d) => d.value > 0);
  const total = rows.reduce((a, d) => a + d.value, 0);
  const r = 40; const c = 2 * Math.PI * r;
  let offset = 0;
  return (
    <div className="flex flex-wrap items-center gap-4">
      <svg viewBox="0 0 100 100" width={size} height={size} className="shrink-0 -rotate-90" role="img" aria-label="Share chart">
        <circle cx="50" cy="50" r={r} fill="none" stroke="#eceee8" strokeWidth="14" />
        {total > 0 && rows.map((d, i) => {
          const len = (d.value / total) * c;
          const el = (
            <circle key={d.label} cx="50" cy="50" r={r} fill="none" stroke={d.color ?? PALETTE[i % PALETTE.length]} strokeWidth="14"
              strokeDasharray={`${len} ${c - len}`} strokeDashoffset={-offset}>
              <title>{`${d.label}: ${format(d.value)} (${pctOf(d.value, total)})`}</title>
            </circle>
          );
          offset += len;
          return el;
        })}
        {center && (
          <g className="rotate-90" style={{ transformOrigin: "50px 50px" }}>
            <text x="50" y="49" textAnchor="middle" className="fill-ink" style={{ fontSize: 13, fontWeight: 700 }}>{center.value}</text>
            <text x="50" y="62" textAnchor="middle" className="fill-ink-muted" style={{ fontSize: 7.5 }}>{center.label}</text>
          </g>
        )}
      </svg>
      <ul className="min-w-[150px] flex-1 space-y-1 text-[12px]">
        {rows.length === 0 && <li className="text-ink-muted">No data in this period.</li>}
        {rows.map((d, i) => (
          <li key={d.label} className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: d.color ?? PALETTE[i % PALETTE.length] }} />
            <span className="min-w-0 flex-1 truncate text-ink-secondary" title={d.label}>{d.label}</span>
            <span className="tabular-nums text-ink">{format(d.value)}</span>
            <span className="w-11 text-right tabular-nums text-ink-muted">{pctOf(d.value, total)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export interface Series { name: string; color: string }

/** The container's width in px, so a chart draws at real size and its text stays readable. */
function useWidth(fallback: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => { for (const e of entries) setW(Math.max(200, Math.round(e.contentRect.width))); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

/** Vertical columns per period, side by side or stacked, with an optional line on top. */
export function Columns({ labels, series, values, format, stacked, line, highlight, height }: {
  labels: string[]; series: Series[]; values: number[][]; format: Fmt; stacked: boolean;
  line: { name: string; color: string; values: Array<number | null>; format: Fmt } | null; highlight: number | null; height: number;
}) {
  const [ref, W] = useWidth(420);
  const H = height; const padL = 8; const padB = 22; const padT = 10;
  const n = labels.length;
  const totals = labels.map((_, i) => (stacked ? values.reduce((a, s) => a + Math.max(0, s[i] ?? 0), 0) : Math.max(0, ...values.map((s) => s[i] ?? 0))));
  const max = Math.max(1, ...totals);
  const slot = (W - padL) / Math.max(1, n);
  const groupW = slot * 0.68;
  const barW = stacked ? groupW : groupW / Math.max(1, series.length);
  const y = (v: number) => padT + (H - padB - padT) * (1 - v / max);
  const lineVals = line?.values ?? [];
  const lmax = Math.max(1, ...lineVals.map((v) => v ?? 0));
  const lmin = Math.min(0, ...lineVals.map((v) => v ?? 0));
  const ly = (v: number) => padT + (H - padB - padT) * (1 - (v - lmin) / (lmax - lmin));
  const step = Math.max(1, Math.ceil((n * 44) / W));
  return (
    <div ref={ref}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="block" role="img" aria-label="Column chart">
        {[0.25, 0.5, 0.75, 1].map((f) => <line key={f} x1={padL} x2={W} y1={y(max * f)} y2={y(max * f)} stroke="#eceee8" strokeWidth="1" />)}
        {labels.map((lab, i) => {
          const x0 = padL + i * slot + (slot - groupW) / 2;
          let acc = 0;
          return (
            <g key={lab + i}>
              {highlight === i && <rect x={padL + i * slot} y={padT - 6} width={slot} height={H - padB - padT + 6} fill="#16695f" opacity="0.06" rx="3" />}
              {series.map((s, si) => {
                const v = Math.max(0, values[si]?.[i] ?? 0);
                const top = stacked ? y(acc + v) : y(v);
                const h = stacked ? y(acc) - y(acc + v) : H - padB - y(v);
                const x = stacked ? x0 : x0 + si * barW;
                acc += v;
                return v > 0 ? (
                  <rect key={s.name} x={x} y={top} width={Math.max(1, barW - (stacked ? 0 : 1.5))} height={Math.max(0.5, h)} fill={s.color} rx={stacked ? 0 : 1.5}>
                    <title>{`${lab} · ${s.name}: ${format(v)}`}</title>
                  </rect>
                ) : null;
              })}
              {i % step === 0 && <text x={padL + i * slot + slot / 2} y={H - 6} textAnchor="middle" className="fill-ink-muted" style={{ fontSize: 10.5 }}>{lab}</text>}
            </g>
          );
        })}
        {line && (
          <>
            <polyline fill="none" stroke={line.color} strokeWidth="2" strokeLinejoin="round"
              points={lineVals.map((v, i) => (v == null ? null : `${padL + i * slot + slot / 2},${ly(v)}`)).filter(Boolean).join(" ")} />
            {lineVals.map((v, i) => v == null ? null : (
              <circle key={i} cx={padL + i * slot + slot / 2} cy={ly(v)} r="3" fill="#fff" stroke={line.color} strokeWidth="1.5">
                <title>{`${labels[i]} · ${line.name}: ${line.format(v)}`}</title>
              </circle>
            ))}
          </>
        )}
      </svg>
      <Legend items={[...series.map((s) => ({ label: s.name, color: s.color, dot: false })), ...(line ? [{ label: line.name, color: line.color, dot: true }] : [])]} />
    </div>
  );
}

export function Legend({ items }: { items: Array<{ label: string; color: string; dot: boolean }> }) {
  return (
    <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-ink-muted">
      {items.map((it) => (
        <span key={it.label} className="inline-flex items-center gap-1.5">
          <span className={cn("inline-block", it.dot ? "h-2 w-2 rounded-full border-2 bg-white" : "h-2.5 w-2.5 rounded-sm")} style={it.dot ? { borderColor: it.color } : { background: it.color }} />
          {it.label}
        </span>
      ))}
    </div>
  );
}

export interface HBarRow { key: string; label: ReactNode; value: number; color: string | null; right: ReactNode; onClick: (() => void) | null }

/** Ranked horizontal bars: label, bar to scale, figure. */
export function HBars({ rows, format, empty }: { rows: HBarRow[]; format: Fmt; empty: string }) {
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.value)));
  if (rows.length === 0) return <div className="py-4 text-center text-[12px] text-ink-muted">{empty}</div>;
  return (
    <ul className="space-y-1.5">
      {rows.map((r, i) => {
        const inner = (
          <>
            <div className="flex items-baseline justify-between gap-2 text-[12px]">
              <span className="min-w-0 truncate text-ink-secondary">{r.label}</span>
              <span className="shrink-0 tabular-nums text-ink">{r.right ?? format(r.value)}</span>
            </div>
            <div className="mt-0.5 h-2 overflow-hidden rounded-full bg-surface-2">
              <div className="h-full rounded-full" style={{ width: `${(Math.abs(r.value) / max) * 100}%`, background: r.color ?? (r.value < 0 ? TONE.bad : PALETTE[i % PALETTE.length]) }} />
            </div>
          </>
        );
        return (
          <li key={r.key}>
            {r.onClick ? <button type="button" onClick={r.onClick} className="block w-full text-left hover:opacity-80">{inner}</button> : inner}
          </li>
        );
      })}
    </ul>
  );
}

/** One 100% bar split into parts, with the legend underneath. */
export function SplitBar({ parts, format }: { parts: Slice[]; format: Fmt }) {
  const total = parts.reduce((a, p) => a + Math.max(0, p.value), 0);
  return (
    <div>
      <div className="flex h-3.5 overflow-hidden rounded-full bg-surface-2">
        {total > 0 && parts.map((p, i) => p.value > 0 && (
          <div key={p.label} style={{ width: `${(p.value / total) * 100}%`, background: p.color ?? PALETTE[i % PALETTE.length] }} title={`${p.label}: ${format(p.value)} (${pctOf(p.value, total)})`} />
        ))}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[11.5px]">
        {parts.map((p, i) => (
          <span key={p.label} className="inline-flex items-center gap-1.5 text-ink-secondary">
            <span className="h-2.5 w-2.5 rounded-sm" style={{ background: p.color ?? PALETTE[i % PALETTE.length] }} />
            {p.label} <b className="font-semibold tabular-nums text-ink">{format(p.value)}</b>
            <span className="tabular-nums text-ink-muted">{pctOf(p.value, total)}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

/** Actual against target on a bar: green when on the right side of it. */
export function Bullet({ label, actual, target, max, format, higherIsBetter }: { label: string; actual: number | null; target: number; max: number; format: Fmt; higherIsBetter: boolean }) {
  const ok = actual == null ? null : higherIsBetter ? actual >= target : actual <= target;
  const w = (v: number) => `${Math.min(100, Math.max(0, (v / Math.max(max, 1e-9)) * 100))}%`;
  return (
    <div>
      <div className="flex items-baseline justify-between text-[12px]">
        <span className="text-ink-secondary">{label}</span>
        <span className={cn("font-semibold tabular-nums", ok == null ? "text-ink-muted" : ok ? "text-synced" : "text-err")}>{actual == null ? "—" : format(actual)}</span>
      </div>
      <div className="relative mt-1 h-2.5 rounded-full bg-surface-2">
        {actual != null && <div className="h-full rounded-full" style={{ width: w(actual), background: ok ? TONE.good : TONE.bad }} />}
        <div className="absolute -top-1 h-[18px] w-0.5 bg-ink" style={{ left: w(target) }} title={`Target ${format(target)}`} />
      </div>
      <div className="mt-0.5 text-[10.5px] text-ink-muted">Target {higherIsBetter ? "≥" : "≤"} {format(target)}</div>
    </div>
  );
}

/** A tiny trend line for a stat tile. */
export function Sparkline({ values, color }: { values: number[]; color: string }) {
  if (values.length < 2) return null;
  const max = Math.max(...values); const min = Math.min(...values); const span = max - min || 1;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * 100},${28 - ((v - min) / span) * 24}`).join(" ");
  return (
    <svg viewBox="0 0 100 30" preserveAspectRatio="none" className="h-7 w-full" aria-hidden>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** A headline tile: figure, note, an optional trend and a tone stripe. */
export function Tile({ label, value, note, tone, trend, onClick }: { label: string; value: string; note: ReactNode; tone: keyof typeof TONE; trend: number[] | null; onClick: (() => void) | null }) {
  const body = (
    <>
      <span className="absolute inset-y-0 left-0 w-1" style={{ background: TONE[tone] }} />
      <div className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-muted">{label}</div>
      <div className="mt-1 text-[22px] font-bold leading-tight tabular-nums text-ink">{value}</div>
      <div className="mt-0.5 text-[11.5px] text-ink-muted">{note}</div>
      {trend && <div className="mt-1"><Sparkline values={trend} color={TONE[tone]} /></div>}
    </>
  );
  const cls = "relative block w-full overflow-hidden rounded-lg border border-border bg-surface py-3 pl-4 pr-3 text-left";
  return onClick ? <button type="button" onClick={onClick} className={cn(cls, "hover:border-primary/40")}>{body}</button> : <div className={cls}>{body}</div>;
}
