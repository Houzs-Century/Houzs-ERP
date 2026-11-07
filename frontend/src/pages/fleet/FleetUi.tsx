// Fleet Health building blocks in the approved design (2026-11-07): white cards
// with a quiet edge, the black number plate, tone-coloured stat tiles and the
// grey segmented switch. Shared by the dashboard and the lorry record.
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";
import type { Tone } from "../FleetHealth";

export const CARD = "rounded-2xl border border-border bg-surface shadow-[0_1px_2px_rgba(29,38,36,.06)]";

export function FleetCard({ title, sub, actions, className, children }: {
  title: string;
  sub?: ReactNode;
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={cn(CARD, "flex min-w-0 flex-col gap-3.5 p-4 sm:px-5 sm:py-[18px]", className)}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="text-[15px] font-bold text-ink">{title}</h2>
          {sub && <span className="text-[12.5px] text-ink-muted">{sub}</span>}
        </div>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

const PLATE_SIZE = {
  sm: "h-6 px-2 text-[12px] tracking-[.06em] rounded",
  md: "h-[30px] px-2.5 text-[15px] tracking-[.08em] rounded-[5px]",
  lg: "h-10 px-3.5 text-[20px] tracking-[.1em] rounded-md",
} as const;

export function PlateBadge({ plate, size = "sm" }: { plate: string; size?: keyof typeof PLATE_SIZE }) {
  return <span className={cn("inline-flex flex-none items-center bg-[#1b1f1e] font-bold text-white", PLATE_SIZE[size])}>{plate}</span>;
}

const TONE_VALUE: Record<Tone, string> = { crit: "text-err", warn: "text-warning-text", ok: "text-ink", info: "text-ink", neutral: "text-ink" };
const TONE_EDGE: Record<Tone, string> = { crit: "border-err/30 bg-err-bg/60", warn: "border-warning-text/25 bg-warning-bg/60", ok: "border-border bg-surface", info: "border-border bg-surface", neutral: "border-border bg-surface" };

/** One summary tile. Clickable tiles are buttons that show when they are the
 *  active filter; a tile with nothing to open is plain text. */
export function KpiTile({ label, value, sub, tone = "neutral", active, onClick, compact }: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: Tone;
  active?: boolean;
  onClick?: () => void;
  compact?: boolean;
}) {
  const body = (
    <>
      <span className="text-[12.5px] text-ink-muted">{label}</span>
      <span className={cn("font-bold tabular-nums", compact ? "text-[18px]" : "text-[24px] leading-tight", TONE_VALUE[tone])}>{value}</span>
      {sub && <span className="text-[12px] text-ink-muted">{sub}</span>}
    </>
  );
  const cls = cn(
    "flex min-w-0 flex-col gap-1 rounded-2xl border p-4 text-left",
    compact && "rounded-xl bg-surface-2 border-transparent px-3.5 py-3",
    !compact && TONE_EDGE[tone],
    active && "ring-2 ring-primary",
  );
  return onClick
    ? <button type="button" onClick={onClick} aria-pressed={active ?? false} className={cn(cls, "transition-colors hover:border-primary/50")}>{body}</button>
    : <div className={cls}>{body}</div>;
}

export function Segmented<T extends string>({ label, value, options, onChange }: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (v: T) => void;
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex flex-wrap gap-0.5 rounded-[9px] bg-[#ebe7dd] p-[3px]">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "h-[34px] rounded-[7px] px-3 text-[13px]",
            value === o.value ? "bg-surface font-semibold text-primary-ink shadow-sm" : "font-medium text-ink-secondary hover:text-ink",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export const TONE_DOT: Record<Tone, string> = { crit: "bg-err", warn: "bg-warning-text", ok: "bg-primary", info: "bg-[#2c6aa0]", neutral: "bg-ink-muted" };
