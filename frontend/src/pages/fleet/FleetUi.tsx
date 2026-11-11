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
    <div role="group" aria-label={label} className="inline-flex flex-wrap gap-0.5 rounded-[9px] bg-[color:var(--hz-dk-warning-bg,#ebe7dd)] p-[3px]">
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

/* The lorry record's controls and inner cards, from the same design: small
   34px buttons, 42px inputs with a plain label above, a warm inset card for one
   record inside a section, and a fact (label over a readable value). */
export const BTN_PRI = "inline-flex h-[34px] items-center gap-1.5 whitespace-nowrap rounded-lg bg-primary px-3 text-[13px] font-semibold text-white hover:bg-primary/90 disabled:opacity-50";
export const BTN_SEC = "inline-flex h-[34px] items-center gap-1.5 whitespace-nowrap rounded-lg border border-[#d9d3c6] bg-surface px-3 text-[13px] font-semibold text-ink hover:border-primary/50 disabled:opacity-50";
export const BTN_GHOST = "inline-flex h-[34px] items-center gap-1 whitespace-nowrap rounded-[7px] px-2.5 text-[13px] font-semibold text-primary hover:bg-primary-soft disabled:opacity-50";
export const INPUT = "h-[42px] w-full rounded-lg border border-[#d9d3c6] bg-surface px-3 text-[14px] text-ink focus:border-primary focus:outline-none disabled:bg-surface-2";
export const LABEL = "mb-1 block text-[12.5px] font-semibold text-ink-secondary";
export const INSET = "rounded-[14px] bg-[color:var(--hz-dk-surface-2,#faf9f6)] p-4";
export const TILE = "flex min-w-0 flex-col gap-0.5 rounded-xl bg-[color:var(--hz-dk-surface-2,#f6f4ee)] px-3.5 py-3";
export const EMPTY = "py-2 text-[13.5px] text-ink-muted";

const NOT_SET = "Not set";
/** A value that is missing reads "Not set", never a dash or a blank. */
export const orNotSet = (v: ReactNode): ReactNode => (v == null || v === "" || v === "—" ? NOT_SET : v);

export function Fact({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  const shown = orNotSet(value);
  return (
    <div className="flex min-w-0 flex-col gap-0.5 border-b border-[#f0ece4] py-2">
      <dt className="text-[12px] text-ink-muted">{label}</dt>
      <dd className={cn("break-words text-[14px] font-semibold", shown === NOT_SET ? "font-medium text-ink-muted" : "text-ink")}>{shown}</dd>
      {hint && <dd className="text-[12px] text-ink-muted">{hint}</dd>}
    </div>
  );
}

export function FactGrid({ children, min = 200 }: { children: ReactNode; min?: number }) {
  return <dl className="grid gap-x-6" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, ${min}px), 1fr))` }}>{children}</dl>;
}

export function Tile({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className={TILE}>
      <span className="text-[12px] text-ink-muted">{label}</span>
      <span className="break-words text-[17px] font-bold leading-snug tabular-nums text-ink">{orNotSet(value)}</span>
      {hint && <span className="text-[12px] text-ink-muted">{hint}</span>}
    </div>
  );
}
