/* The small form pieces every POS Admin tab shares, in the app's own tokens. */
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

export const inputCls = "h-8 w-full rounded-md border border-border bg-surface px-2 text-[12px] text-ink focus:border-accent focus:outline-none disabled:opacity-60";
export const smallBtn = "inline-flex h-7 items-center gap-1 whitespace-nowrap rounded-md border px-2 text-[11px] font-semibold disabled:opacity-50";
export const primaryBtn = cn(smallBtn, "border-accent bg-accent text-white hover:bg-accent/90");
export const ghostBtn = cn(smallBtn, "border-border bg-surface text-ink hover:bg-bg");
export const dangerBtn = cn(smallBtn, "border-rose-500/40 bg-rose-50 text-rose-800 hover:bg-rose-100");

export function Field({ label, hint, children, className }: { label: string; hint?: string; children: ReactNode; className?: string }) {
  return (
    <label className={cn("block", className)}>
      <span className="mb-1 block text-[10.5px] font-semibold uppercase tracking-wide text-ink-secondary">{label}</span>
      {children}
      {hint && <span className="mt-0.5 block text-[10.5px] text-ink-muted">{hint}</span>}
    </label>
  );
}

export function Toggle({ checked, onChange, label, hint, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string; disabled?: boolean }) {
  return (
    <label className={cn("flex cursor-pointer items-start gap-2 py-1", disabled && "cursor-not-allowed opacity-60")}>
      <input type="checkbox" className="mt-0.5 h-4 w-4 accent-accent" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <span className="block text-[12px] text-ink">{label}</span>
        {hint && <span className="block text-[10.5px] text-ink-muted">{hint}</span>}
      </span>
    </label>
  );
}

export function Pill({ tone, children }: { tone: "ok" | "warn" | "bad" | "info" | "muted"; children: ReactNode }) {
  const cls = {
    ok: "bg-emerald-100 text-emerald-800",
    warn: "bg-amber-100 text-amber-800",
    bad: "bg-rose-100 text-rose-800",
    info: "bg-sky-100 text-sky-800",
    muted: "bg-bg text-ink-muted border border-border",
  }[tone];
  return <span className={cn("inline-flex rounded-full px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider", cls)}>{children}</span>;
}

export function Table({ head, children, minWidth = 760 }: { head: ReactNode; children: ReactNode; minWidth?: number }) {
  return (
    <div className="overflow-x-auto rounded-md border border-border bg-surface">
      <table className="w-full" style={{ minWidth }}>
        <thead className="bg-bg/60">
          <tr className="text-left font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">{head}</tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export const th = "px-2 py-1.5";
export const td = "px-2 py-1.5 text-[11.5px]";

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-md border border-dashed border-border px-3 py-3 text-[11px] text-ink-muted">{children}</div>;
}

export const errText = (e: unknown, fallback: string): string => {
  if (e instanceof Error && e.message) return e.message;
  return fallback;
};
