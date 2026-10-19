// Shared building blocks of the module Overview pages (Procurement, Logistic,
// Project): a titled panel, compact table cells and a segmented toggle. The
// period picker is DashboardPeriod.tsx.
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

export const Th = ({ children, left }: { children: ReactNode; left?: boolean }) => (
  <th className={cn("whitespace-nowrap border-b border-border px-2.5 py-2 text-[10.5px] font-semibold uppercase tracking-wider text-ink-muted", left ? "text-left" : "text-right")}>{children}</th>
);
export const Td = ({ children, left, className }: { children: ReactNode; left?: boolean; className?: string }) => (
  <td className={cn("whitespace-nowrap border-b border-border px-2.5 py-1.5 text-[12.5px] tabular-nums", left ? "text-left" : "text-right", className)}>{children}</td>
);
export const Panel = ({ title, hint, right, children }: { title: string; hint?: ReactNode; right?: ReactNode; children: ReactNode }) => (
  <section className="rounded-lg border border-border bg-surface">
    <header className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
      <h2 className="text-[13.5px] font-semibold text-ink">{title}</h2>
      {hint && <span className="text-[11px] text-ink-muted">{hint}</span>}
      <span className="flex-1" />{right}
    </header>
    <div className="overflow-x-auto p-3">{children}</div>
  </section>
);
export function Toggle<T extends string>({ value, options, onChange }: { value: T; options: Array<[T, string]>; onChange: (v: T) => void }) {
  return (
    <span className="inline-flex overflow-hidden rounded-md border border-border text-[12px]">
      {options.map(([v, l]) => (
        <button key={v} type="button" onClick={() => onChange(v)} aria-pressed={value === v}
          className={cn("px-2.5 py-1", value === v ? "bg-primary text-white" : "bg-surface text-ink-secondary hover:bg-surface-2")}>{l}</button>
      ))}
    </span>
  );
}
/** Pill tabs with a count, and a small red count of how many are already late
 *  (owner 2026-10-19: "show how many have started to go overdue"). */
export function StepTabs({ tabs, value, onChange }: { tabs: Array<[string, string, number, number]>; value: string; onChange: (k: string) => void }) {
  return (
    <div className="mb-2 flex flex-wrap gap-1.5">
      {tabs.map(([k, label, n, late]) => (
        <button key={k} type="button" onClick={() => onChange(k)}
          className={cn("relative rounded-full border px-3 py-1 text-[12px]", value === k ? "border-primary bg-primary text-white" : "border-border text-ink-secondary hover:bg-surface-2")}>
          {label} <span className="ml-1 tabular-nums opacity-80">{n}</span>
          {late > 0 && <span className="absolute -right-1.5 -top-1.5 min-w-[18px] rounded-full bg-err px-1 text-[10px] font-bold leading-[18px] text-white" title={`${late} late`}>{late}</span>}
        </button>
      ))}
    </div>
  );
}
export const SELECT_CLS = "rounded-md border border-border bg-surface px-2 py-1 text-[12px] text-ink";
