// ProjectOverviewTable — Project Overview's project list as the Finance table
// (owner 2026-11-05: "这个我要做成 finance table"). The shared DataTable gives it
// what every Finance table has: drag a header edge for its width, drag a header
// to move it, right-click a header to sort, freeze, auto-fit or hide, the column
// chooser, Excel export, and a Total row at the foot. Project, Event type, Venue,
// State and Dates are columns of their own so a name never wraps; the money reads
// 1,234.56 / (1,234.56) with a dash for nothing.
//
// Every column carries `getValue` (owner 2026-11-12: 「这些其他不可以filter?」):
// DataTable gives a header its sort and its funnel only then — `sortValue` and
// `numberValue` alone left Dates and the figures with neither. The dates filter
// by a range, the figures by a minimum and maximum.

import { DataTable, type Column } from "../../components/DataTable";
import { fmtDateOrDash, fmtDayMonthRange } from "../../vendor/shared/format";
import { fmtSenPlain } from "../../vendor/shared/format";
import { figuresOf, pctOf, type OvProject } from "./projectOverviewModel";
import { projectLines } from "./projectOverviewView";

export type OverviewRow = { p: OvProject; f: ReturnType<typeof figuresOf> };

const money = (rm: number): string => (!Number.isFinite(rm) || Math.abs(rm) < 0.005 ? "-" : fmtSenPlain(Math.round(rm * 100)));
const pct = (x: number | null): string => (x == null ? "-" : x < 0 ? `(${Math.abs(x).toFixed(1)}%)` : `${x.toFixed(1)}%`);
const sum = (rows: OverviewRow[], pick: (r: OverviewRow) => number) => rows.reduce((s, r) => s + pick(r), 0);

/** One money column: right-aligned, totalled, exported as a number. */
const amountCol = (key: string, label: string, pick: (r: OverviewRow) => number, group: string, opts: { strong?: boolean } = {}): Column<OverviewRow> => ({
  key, label, align: "right", group,
  render: (r) => {
    const v = pick(r);
    return <span className={opts.strong ? (v < 0 ? "font-semibold text-err" : "font-semibold") : v < 0 ? "text-err" : Math.abs(v) < 0.005 ? "text-ink-muted" : ""}>{money(v)}</span>;
  },
  /* To the sen, so two rows that read the same share one line in the funnel. */
  getValue: (r) => Math.round(pick(r) * 100) / 100, filterLabel: (v) => money(Number(v)),
  filterType: "number", sortValue: pick, numberValue: pick, exportValue: (r) => pick(r),
  total: (rows) => <span className={opts.strong && sum(rows, pick) < 0 ? "text-err" : ""}>{money(sum(rows, pick))}</span>,
});

/** A % column worked out row by row, and on the Total row from the added-up figures. */
const pctCol = (key: string, label: string, top: (r: OverviewRow) => number, base: (r: OverviewRow) => number, group: string): Column<OverviewRow> => ({
  key, label, align: "right", group,
  render: (r) => { const x = pctOf(top(r), base(r)); return <span className={x != null && x < 0 ? "text-err" : "text-ink-secondary"}>{pct(x)}</span>; },
  /* To the one decimal the cell shows. */
  getValue: (r) => { const x = pctOf(top(r), base(r)); return x == null ? null : Math.round(x * 10) / 10; },
  filterLabel: (v) => pct(Number(v)),
  filterType: "number", sortValue: (r) => pctOf(top(r), base(r)) ?? -1e9, numberValue: (r) => pctOf(top(r), base(r)),
  exportValue: (r) => pctOf(top(r), base(r)),
  total: (rows) => pct(pctOf(sum(rows, top), sum(rows, base))),
});

function Daily({ r }: { r: OvProject["chatReport"] }) {
  if (!r || r.bills === 0) return <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[10.5px] text-ink-muted">No chat report</span>;
  if (r.opened === r.bills) return <span className="rounded-full bg-synced/10 px-2 py-0.5 text-[10.5px] text-synced">Daily · {r.opened} / {r.bills} bills</span>;
  return <span className="rounded-full bg-err/10 px-2 py-0.5 text-[10.5px] text-err">Not daily · {r.opened} / {r.bills} bills{r.otherEvent ? ` · ${r.otherEvent} elsewhere` : ""}</span>;
}

export const PROJECT_COLUMNS: Column<OverviewRow>[] = [
  {
    key: "project", label: "Project", alwaysVisible: true, group: "Project",
    render: (r) => <span className="whitespace-nowrap font-semibold text-primary" title={r.p.name}>{projectLines(r.p).title}</span>,
    getValue: (r) => projectLines(r.p).title, sortValue: (r) => projectLines(r.p).title, searchValue: (r) => r.p.name,
    total: (rows) => <span className="whitespace-nowrap">Total · {rows.length} project{rows.length === 1 ? "" : "s"}</span>,
  },
  { key: "eventType", label: "Event type", group: "Project", render: (r) => <span className="whitespace-nowrap text-ink-secondary">{r.p.eventType ?? "-"}</span>, getValue: (r) => r.p.eventType ?? "" },
  { key: "venue", label: "Venue", group: "Project", render: (r) => <span className="whitespace-nowrap">{r.p.venue ?? "-"}</span>, getValue: (r) => r.p.venue ?? "" },
  { key: "state", label: "State", group: "Project", render: (r) => <span className="whitespace-nowrap">{r.p.state ?? "-"}</span>, getValue: (r) => r.p.state ?? "" },
  {
    key: "dates", label: "Dates", group: "Project", newestFirst: true,
    render: (r) => <span className="whitespace-nowrap tabular-nums">{r.p.startDate ? fmtDayMonthRange(r.p.startDate, r.p.endDate) : "-"}</span>,
    /* By the day it starts: the funnel's presets and From / To range read it, and its list shows each start day. */
    getValue: (r) => r.p.startDate ?? "", filterLabel: (v) => fmtDateOrDash(v),
    filterType: "date", sortValue: (r) => r.p.startDate ?? "", dateValue: (r) => r.p.startDate, exportValue: (r) => r.p.startDate ?? "",
  },
  amountCol("sales", "Sales", (r) => r.f.sales, "Sales"),
  amountCol("service", "Service", (r) => r.f.serviceRevenue, "Sales"),
  amountCol("cogs", "COGS", (r) => r.f.cogs, "Gross profit"),
  amountCol("gp", "GP", (r) => r.f.gp, "Gross profit"),
  pctCol("gpPct", "GP %", (r) => r.f.gp, (r) => r.f.sales, "Gross profit"),
  amountCol("rental", "Rental", (r) => r.f.rental, "Event costs"),
  amountCol("setup", "Setup", (r) => r.f.setup, "Event costs"),
  amountCol("transport", "Transport", (r) => r.f.transport, "Event costs"),
  amountCol("commission", "Commission", (r) => r.f.commission, "Event costs"),
  amountCol("merchandise", "Merchandise", (r) => r.f.merchandise, "Event costs"),
  amountCol("others", "Others", (r) => r.f.other, "Event costs"),
  amountCol("np", "Net profit", (r) => r.f.np, "Result", { strong: true }),
  pctCol("npPct", "NP %", (r) => r.f.np, (r) => r.f.sales, "Result"),
  amountCol("collected", "Collected", (r) => r.p.collection.paidSen / 100, "Collected"),
  pctCol("collectedPct", "Collected %", (r) => r.p.collection.paidSen, (r) => r.p.collection.totalSen, "Collected"),
  { key: "daily", label: "Sales Orders daily?", group: "Collected", disableSort: true, render: (r) => <span className="whitespace-nowrap"><Daily r={r.p.chatReport} /></span>, getValue: (r) => (r.p.chatReport ? `${r.p.chatReport.opened}/${r.p.chatReport.bills}` : "") },
];

export function ProjectOverviewTable({ rows, loading, onOpen }: { rows: OverviewRow[]; loading: boolean; onOpen: (id: number) => void }) {
  return (
    <DataTable<OverviewRow>
      tableId="project-overview-projects"
      exportName="project-overview"
      exportXlsx
      columns={PROJECT_COLUMNS}
      rows={rows}
      loading={loading}
      error={null}
      emptyLabel="No projects in this period."
      getRowKey={(r) => r.p.id}
      onRowClick={(r) => onOpen(r.p.id)}
      defaultSort={(a, b) => (b.p.startDate ?? "").localeCompare(a.p.startDate ?? "")}
      /* More page sits below it (Venue rent, the stuck and gaps lists), which shrank the box to 240px:
         it fills the screen instead (owner 2026-11-05, the Event Commission rule). */
      freezeHeight="screen"
    />
  );
}
