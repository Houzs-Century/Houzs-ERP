/* Shared template for the HR sub-pages (redesign stage 7): a page header, four
 * stat cards, a toolbar (search + period chips + show-amounts eye), a table
 * with configurable columns, and a footer total bar with a "Sample data" tag.
 * Each sub-page (Payroll, Shifts, KPI, …) is just config over this. */
import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { HrPageHeader } from "./HrPageHeader";
import { avatarColor, initials } from "./hrSampleData";

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

export const mask = (v: string, show: boolean) => (show ? v : "RM ••••••");

export function Person({ name, sub }: { name: string; sub?: string }) {
  return (
    <span className="flex items-center gap-2.5">
      <span className={cx("inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-white", avatarColor(name))}>{initials(name)}</span>
      <span className="min-w-0">
        <span className="block truncate text-[12.5px] font-semibold text-ink">{name}</span>
        {sub && <span className="block font-mono text-[10.5px] text-accent">{sub}</span>}
      </span>
    </span>
  );
}
export function Tag({ tone, children }: { tone: "ok" | "warn" | "bad" | "info" | "muted"; children: ReactNode }) {
  const cls: Record<string, string> = {
    ok: "bg-synced-bg text-synced", warn: "bg-warning-bg text-warning-text", bad: "bg-err-bg text-err",
    info: "bg-learning-soft text-learning", muted: "bg-surface-2 text-ink-muted",
  };
  return <span className={cx("rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide", cls[tone])}>{children}</span>;
}
export function Bar({ pct, tone = "bg-primary", w = "w-20" }: { pct: number; tone?: string; w?: string }) {
  return <div className={cx("h-1.5 overflow-hidden rounded-full bg-surface-2", w)}><div className={cx("h-full rounded-full", tone)} style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} /></div>;
}

/** A span on the 06:00-22:00 day scale (shift hours, overtime window). */
export function TimeSpan({ startMin, endMin, tone = "bg-primary" }: { startMin: number; endMin: number; tone?: string }) {
  const S = 360, E = 1320, span = E - S;
  const left = ((startMin - S) / span) * 100;
  const width = ((endMin - startMin) / span) * 100;
  return <div className="relative h-2 w-full min-w-[90px] rounded-full bg-surface-2"><div className={cx("absolute top-0 h-2 rounded-full", tone)} style={{ left: `${left}%`, width: `${width}%` }} /></div>;
}

export type HrStat = { label: string; value: (show: boolean) => ReactNode; sub: ReactNode; bar: string };
export type HrCol<T> = { key: string; label: string; align?: "left" | "right" | "center"; render: (r: T, show: boolean) => ReactNode };

export function HrTablePage<T extends { id: number | string }>({
  title, subtitle, actions, stats, periods, rows, columns, searchOf, searchPlaceholder, footer, onRowClick,
}: {
  title: string;
  subtitle: string;
  actions?: ReactNode;
  stats: HrStat[];
  periods?: string[];
  rows: T[];
  columns: HrCol<T>[];
  searchOf: (r: T) => string;
  searchPlaceholder?: string;
  footer?: (show: boolean) => ReactNode;
  onRowClick?: (r: T) => void;
}) {
  const [show, setShow] = useState(false);
  const [query, setQuery] = useState("");
  const [period, setPeriod] = useState(periods?.[0] ?? "");
  const shown = useMemo(() => rows.filter((r) => query === "" || searchOf(r).toLowerCase().includes(query.toLowerCase())), [rows, query, searchOf]);
  const alignCls = (a?: string) => (a === "right" ? "text-right" : a === "center" ? "text-center" : "text-left");

  return (
    <>
      <HrPageHeader title={title} subtitle={subtitle} actions={actions} />
      <div className="flex min-h-0 flex-1 flex-col gap-3 px-6 py-4">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {stats.map((s, i) => (
            <div key={i} className="flex flex-col overflow-hidden rounded-xl border border-border bg-surface">
              <div className={cx("h-[3px] w-full", s.bar)} />
              <div className="px-3.5 py-3">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">{s.label}</div>
                <div className="mt-1 text-[22px] font-bold leading-none text-ink">{s.value(show)}</div>
                <div className="mt-1.5 text-[11px] text-ink-muted">{s.sub}</div>
              </div>
            </div>
          ))}
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-surface">
          <div className="flex flex-wrap items-center gap-2 border-b border-border-subtle px-3 py-2.5">
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={searchPlaceholder ?? "Search"} className="h-8 w-56 rounded-md border border-border bg-surface-2 px-3 text-[12px] text-ink placeholder:text-ink-muted focus:border-primary focus:outline-none" />
            {periods && periods.length > 0 && (
              <div className="flex items-center gap-0.5 rounded-lg bg-surface-2 p-0.5">
                {periods.map((p) => (
                  <button key={p} type="button" onClick={() => setPeriod(p)} className={cx("h-7 rounded px-2.5 text-[12px] font-semibold", period === p ? "bg-surface text-primary shadow-sm" : "text-ink-muted hover:text-ink")}>{p}</button>
                ))}
              </div>
            )}
            <span className="text-[12px] text-ink-muted">{shown.length} rows</span>
            <button type="button" onClick={() => setShow((v) => !v)} className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[11px] font-semibold text-ink-secondary hover:bg-surface-2">{show ? "Hide amounts" : "Show amounts"}</button>
          </div>

          <div className="thin-scroll min-h-0 flex-1 overflow-auto">
            <table className="w-full border-separate border-spacing-0 text-[12px]">
              <thead>
                <tr className="text-[10px] font-bold uppercase tracking-wide text-ink-muted">
                  {columns.map((c) => (
                    <th key={c.key} className={cx("sticky top-0 z-10 border-b border-border-subtle bg-surface-2 px-3 py-2", alignCls(c.align))}>{c.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.id} className={cx("hover:bg-row-hover", onRowClick && "cursor-pointer")} onClick={onRowClick ? () => onRowClick(r) : undefined}>
                    {columns.map((c) => (
                      <td key={c.key} className={cx("border-b border-border-subtle px-3 py-2", alignCls(c.align))}>{c.render(r, show)}</td>
                    ))}
                  </tr>
                ))}
                {shown.length === 0 && <tr><td colSpan={columns.length} className="px-4 py-10 text-center text-[12px] text-ink-muted">Nothing here.</td></tr>}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between border-t border-border-subtle px-4 py-2 text-[11px]">
            <span className="text-ink-muted">{footer ? footer(show) : null}</span>
            <span className="text-ink-soft">Sample data</span>
          </div>
        </div>
      </div>
    </>
  );
}
