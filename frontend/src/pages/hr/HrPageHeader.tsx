import type { ReactNode } from "react";

export function HrPageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="sticky top-0 z-10 border-b border-border bg-surface px-6 pb-3.5 pt-[18px]">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="h-[18px] w-0.5 rounded-full bg-accent" />
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-accent">HR · Employees &amp; Attendance</span>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-baseline gap-2.5">
          <h1 className="text-[24px] font-bold tracking-[-0.015em] text-ink">{title}</h1>
          {subtitle && <span className="text-[13px] text-ink-muted">{subtitle}</span>}
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

export const hrSecondaryBtn = "inline-flex h-8 items-center rounded-md border border-border bg-surface px-3 text-[12px] font-semibold text-ink-secondary hover:border-accent/40 hover:bg-accent-soft/50";
export const hrPrimaryBtn = "inline-flex h-8 items-center gap-1 rounded-md bg-primary px-3 text-[12px] font-semibold text-white hover:bg-primary-ink";
