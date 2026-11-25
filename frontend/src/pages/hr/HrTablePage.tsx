/* Shared new-design scaffold for the HR sub-pages: a page header, four stat
 * cards, and — for the table itself — the SYSTEM DataTable, so every HR list
 * reads and behaves like the rest of the ERP (search, per-column sort + funnel,
 * the Columns chooser, column freeze, export). Each page is config over this on
 * REAL data; loading / error / empty states and the money eye live here, and
 * each page renders its own add/edit modal as a sibling.
 *
 * A column sorts, filters and exports only when it carries `getValue` (the raw
 * value); a render-only column still shows and is searched by its cell text. */
import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { DataTable, type Column } from "../../components/DataTable";
import { HrPageHeader } from "./HrPageHeader";
import { avatarColor, initials } from "./hrAvatar";

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
  const left = Math.max(0, Math.min(100, ((startMin - S) / span) * 100));
  const width = Math.max(0, Math.min(100, ((endMin - startMin) / span) * 100));
  return <div className="relative h-2 w-full min-w-[90px] rounded-full bg-surface-2"><div className={cx("absolute top-0 h-2 rounded-full", tone)} style={{ left: `${left}%`, width: `${width}%` }} /></div>;
}

export type HrStat = { label: string; value: (show: boolean) => ReactNode; sub: ReactNode; bar: string };
/** A column over the HR DataTable. `render` draws the cell (given the money eye);
 *  `getValue` is the raw value that makes the column sort / filter / export. */
export type HrCol<T> = {
  key: string;
  label: string;
  align?: "left" | "right" | "center";
  width?: string;
  render: (r: T, show: boolean) => ReactNode;
  getValue?: (r: T, show: boolean) => string | number | boolean | null | undefined;
  /** Footer total over the rows on screen. */
  total?: (rows: T[], show: boolean) => ReactNode;
  filterType?: "date" | "number";
  disableSort?: boolean;
};

const slug = (s: string) => "hr-" + s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export function HrTablePage<T extends { id: number | string }>({
  title, subtitle, actions, topSection, stats, periods, period, onPeriod, rows, columns, searchPlaceholder, footer, footerRight, onRowClick,
  loading, error, emptyLabel, moneyToggle, toolbarExtra, tableId,
}: {
  title: string;
  subtitle: ReactNode;
  actions?: ReactNode;
  /** A block rendered between the header and the stat cards (e.g. the punch
   *  rules card), for a page that carries its own controls above the table. */
  topSection?: ReactNode;
  stats: HrStat[];
  /** Period chips: uncontrolled label-only, or controlled via period + onPeriod. */
  periods?: string[];
  period?: string;
  onPeriod?: (p: string) => void;
  rows: T[];
  columns: HrCol<T>[];
  /** Kept for callers; the DataTable's own search covers it (it matches each
   *  column's getValue, else the cell text). */
  searchOf?: (r: T) => string;
  searchPlaceholder?: string;
  footer?: (show: boolean) => ReactNode;
  footerRight?: ReactNode;
  onRowClick?: (r: T) => void;
  loading?: boolean;
  error?: string | null;
  emptyLabel?: string;
  /** Show the Show/Hide amounts eye (pages with money). */
  moneyToggle?: boolean;
  /** Extra controls in the toolbar (filters), before the money toggle. */
  toolbarExtra?: ReactNode;
  /** Stable id for persisting columns / sort / density. Defaults from the title. */
  tableId?: string;
}) {
  const [show, setShow] = useState(false);
  const [localPeriod, setLocalPeriod] = useState(periods?.[0] ?? "");
  const activePeriod = period ?? localPeriod;
  const setPeriod = (p: string) => (onPeriod ? onPeriod(p) : setLocalPeriod(p));

  const dtColumns = useMemo<Column<T>[]>(
    () =>
      columns.map((c) => ({
        key: c.key,
        label: c.label,
        align: c.align,
        width: c.width,
        render: (r: T) => c.render(r, show),
        getValue: c.getValue ? (r: T) => c.getValue!(r, show) : undefined,
        total: c.total ? (rs: T[]) => c.total!(rs, show) : undefined,
        filterType: c.filterType,
        dateValue: c.filterType === "date" && c.getValue ? (r: T) => String(c.getValue!(r, show) ?? "") : undefined,
        numberValue: c.filterType === "number" && c.getValue ? (r: T) => Number(c.getValue!(r, show) ?? 0) : undefined,
        disableSort: c.disableSort,
      })),
    [columns, show],
  );

  const toolbar = (
    <span className="flex items-center gap-2">
      {periods && periods.length > 0 && (
        <span className="flex items-center gap-0.5 rounded-lg bg-surface-2 p-0.5">
          {periods.map((p) => (
            <button key={p} type="button" onClick={() => setPeriod(p)} className={cx("h-7 rounded px-2.5 text-[12px] font-semibold", activePeriod === p ? "bg-surface text-primary shadow-sm" : "text-ink-muted hover:text-ink")}>{p}</button>
          ))}
        </span>
      )}
      {toolbarExtra}
      {moneyToggle && (
        <button type="button" onClick={() => setShow((v) => !v)} className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[11px] font-semibold text-ink-secondary hover:bg-surface-2">{show ? "Hide amounts" : "Show amounts"}</button>
      )}
    </span>
  );

  return (
    <>
      <HrPageHeader title={title} subtitle={subtitle} actions={actions} />
      <div className="flex min-h-0 flex-1 flex-col gap-3 px-6 py-4">
        {topSection}
        {stats.length > 0 && (
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
        )}

        <div className="flex min-h-0 flex-1 flex-col">
          <DataTable<T>
            tableId={tableId ?? slug(title)}
            documentLabel={title}
            columns={dtColumns}
            rows={rows}
            loading={loading}
            error={error}
            emptyLabel={emptyLabel ?? "Nothing here."}
            getRowKey={(r) => r.id}
            onRowClick={onRowClick}
            clientSearch={{ placeholder: searchPlaceholder ?? "Search" }}
            exportName={slug(title).replace(/^hr-/, "")}
            exportXlsx
            toolbarExtra={toolbar}
          />
        </div>

        {(footer || footerRight) && (
          <div className="flex items-center justify-between px-1 text-[11px]">
            <span className="text-ink-muted">{footer ? footer(show) : null}</span>
            {footerRight && <span className="text-ink-soft">{footerRight}</span>}
          </div>
        )}
      </div>
    </>
  );
}
