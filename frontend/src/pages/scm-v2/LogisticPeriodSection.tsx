// Logistic Overview · the selected period (owner, 2026-10-17):
//   what went out (DO amount and orders), what is still to deliver up to the
//   period's end (the month's end for "this month" — an estimate from Delivery
//   Planning), what is owed after it (next month, later, no date yet), the
//   average per order and per lorry run, and the jobs of the period by type.
// Every figure can be read by amount or by orders.
import { useState } from "react";
import { fmtSen } from "../../vendor/shared/format";
import { ASSR_JOB_KIND_LABEL, type AssrJobKind, type PlanningOrder } from "../../vendor/scm/lib/delivery-planning-queries";
import { Th, Td, Panel, Toggle } from "../../components/scm-v2/OverviewKit";
import { Donut, SplitBar, Tile, TONE, PALETTE } from "../../components/scm-v2/Charts";
import type { Period } from "../../components/scm-v2/DashboardPeriod";

import type { DayRow, RegionRow, RunRow } from "./LogisticDailySection";

export type PeriodTotals = {
  from: string; to: string; doCount: number; doAmountSen: number; podClosed: number; runs: number; lorries: number; runAmountSen: number;
  days: DayRow[]; byRegion: RegionRow[]; runList: RunRow[];
  byCategory: Array<{ category: string; orders: number; amountSen: number; avgSen: number | null }>;
};

const endOfMonth = (d: string) => {
  const y = Number(d.slice(0, 4)); const m = Number(d.slice(5, 7));
  return `${d.slice(0, 7)}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
};
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const titleCase = (s: string) => s.toLowerCase().replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

/** The job a board row is: a sales-order delivery, a service-case job, or a DP / event job. */
export function jobTypeOf(o: PlanningOrder): string {
  if (o.row_type === "assr") {
    const kind = ASSR_JOB_KIND_LABEL[(o.job_kind ?? "delivery") as AssrJobKind];
    return kind === "Service" ? "Service case" : `Service case · ${kind}`;
  }
  if (o.row_type === "dp" || o.row_type === "project") return titleCase(o.dp_job_type ?? "Other");
  return "Delivery";
}
/** Done: delivered on the board; an event set-up / dismantle has no delivered state, so it is done once its day has passed. */
export function jobDone(o: PlanningOrder, today: string): boolean {
  if (o.row_type === "project") return !!o.effective_delivery_date && o.effective_delivery_date < today;
  return o.delivery_state === "DELIVERED";
}

export function LogisticPeriodSection({ rows, period, today, totals }: { rows: PlanningOrder[]; period: Period; today: string; totals: PeriodTotals | null }) {
  const [by, setBy] = useState<"amount" | "orders">("amount");
  /* "This month" runs to today; the estimate of what is still to deliver runs
     to the month's end, which is what "this month" means for a delivery. */
  const estimateEnd = period.to === today ? endOfMonth(today) : period.to;
  /* A past period: the board only knows what is open now, so these two read
     "still open today", never "what was open then". */
  const past = period.to < today;
  const so = rows.filter((o) => o.row_type === "so");
  const open = so.filter((o) => o.delivery_state !== "DELIVERED");
  const date = (o: PlanningOrder) => o.effective_delivery_date;
  const toDeliver = open.filter((o) => !!date(o) && (date(o) as string) <= estimateEnd);
  const overdue = toDeliver.filter((o) => (date(o) as string) < today);
  const after = open.filter((o) => !date(o) || (date(o) as string) > estimateEnd);
  const nextEnd = endOfMonth(addDays(estimateEnd, 1));
  const nextMonth = after.filter((o) => !!date(o) && (date(o) as string) <= nextEnd);
  const later = after.filter((o) => !!date(o) && (date(o) as string) > nextEnd);
  const noDate = after.filter((o) => !date(o));
  const sum = (xs: PlanningOrder[]) => xs.reduce((a, o) => a + o.local_total_sen, 0);
  const fig = (xs: PlanningOrder[]) => (by === "amount" ? fmtSen(sum(xs)) : `${xs.length} orders`);
  const sub = (xs: PlanningOrder[]) => (by === "amount" ? `${xs.length} orders` : fmtSen(sum(xs)));

  const jobs = rows.filter((o) => !!date(o) && (date(o) as string) >= period.from && (date(o) as string) <= period.to);
  const byType = new Map<string, { type: string; jobs: number; done: number; amountSen: number }>();
  for (const o of jobs) {
    const t = jobTypeOf(o);
    const g = byType.get(t) ?? { type: t, jobs: 0, done: 0, amountSen: 0 };
    g.jobs += 1; if (jobDone(o, today)) g.done += 1; g.amountSen += o.local_total_sen;
    byType.set(t, g);
  }
  const types = [...byType.values()].sort((a, b) => b.jobs - a.jobs);
  const avgOrder = totals && totals.doCount ? totals.doAmountSen / totals.doCount : null;
  const avgRun = totals && totals.runs ? totals.runAmountSen / totals.runs : null;

  return (
    <Panel title={`This period · ${period.label}`} hint={`out on a DO between ${period.from} and ${period.to}; still to deliver up to ${estimateEnd}`}
      right={<Toggle value={by} options={[["amount", "By amount"], ["orders", "By orders"]]} onChange={setBy} />}>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Tile label="Delivered (DO issued)" tone="good" trend={null} onClick={null}
          value={totals ? (by === "amount" ? fmtSen(totals.doAmountSen) : `${totals.doCount} DO`) : "…"}
          note={totals ? `${by === "amount" ? `${totals.doCount} DO` : fmtSen(totals.doAmountSen)} · ${totals.podClosed} marked delivered` : ""} />
        <Tile label={past ? `Dated by ${estimateEnd.slice(5).replace("-", "/")}, still not delivered today` : `Outstanding delivery by ${estimateEnd.slice(5).replace("-", "/")}`} tone={overdue.length ? "bad" : "warn"} trend={null} onClick={null}
          value={fig(toDeliver)} note={`${sub(toDeliver)} · ${overdue.length} already overdue (${fmtSen(sum(overdue))})`} />
        <Tile label={past ? `Open today, dated after ${estimateEnd.slice(5).replace("-", "/")}` : "Owed after that"} tone="main" trend={null} onClick={null}
          value={fig(after)} note={`next month ${by === "amount" ? fmtSen(sum(nextMonth)) : nextMonth.length} · later ${by === "amount" ? fmtSen(sum(later)) : later.length} · no date ${by === "amount" ? fmtSen(sum(noDate)) : noDate.length}`} />
        <Tile label="Average per order" tone="brass" trend={null} onClick={null}
          value={avgOrder != null ? fmtSen(avgOrder) : "—"} note="DO amount ÷ DOs in the period · by category below" />
        <Tile label="Average per lorry run" tone="brass" trend={null} onClick={null}
          value={avgRun != null ? fmtSen(avgRun) : "—"}
          note={totals?.runs ? `${totals.runs} runs · ${totals.lorries} lorries · ${fmtSen(totals.runAmountSen)} carried` : "no lorry runs recorded in this period yet"} />
      </div>

      {totals && totals.byCategory.length > 0 && (
        <div className="mt-3">
          <div className="mb-1.5 text-[12px] font-semibold text-ink">Average per order, by category</div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
            {totals.byCategory.map((c) => (
              <div key={c.category} className="rounded-md border border-border px-3 py-2">
                <div className="text-[11px] uppercase tracking-wide text-ink-muted">{c.category}</div>
                <div className="text-[15px] font-semibold tabular-nums text-ink">{c.avgSen != null ? fmtSen(c.avgSen) : "—"}</div>
                <div className="text-[11px] text-ink-muted">{c.orders} DO · {fmtSen(c.amountSen)}</div>
              </div>
            ))}
          </div>
          <p className="mt-1 text-[11px] text-ink-muted">A DO counts in each category it charges for, with only that category&apos;s amount; free items (bundled bedframes, gift pillows) are not counted.</p>
        </div>
      )}

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <div>
          <div className="mb-1.5 text-[12px] font-semibold text-ink">Delivered, still to deliver, owed after</div>
          <SplitBar format={by === "amount" ? fmtSen : (x) => `${x}`} parts={[
            { label: "Delivered", value: totals ? (by === "amount" ? totals.doAmountSen : totals.doCount) : 0, color: TONE.good },
            { label: "Overdue", value: by === "amount" ? sum(overdue) : overdue.length, color: TONE.bad },
            { label: "Outstanding by period end", value: by === "amount" ? sum(toDeliver) - sum(overdue) : toDeliver.length - overdue.length, color: TONE.warn },
            { label: "Next month", value: by === "amount" ? sum(nextMonth) : nextMonth.length, color: PALETTE[2]! },
            { label: "Later / no date", value: by === "amount" ? sum(later) + sum(noDate) : later.length + noDate.length, color: "#c9cdc4" },
          ]} />
          <div className="mt-4 mb-1.5 text-[12px] font-semibold text-ink">Jobs dated in the period, by type</div>
          <Donut size={116} format={(x) => `${x}`} center={{ value: String(jobs.length), label: "jobs" }}
            data={types.map((t) => ({ label: t.type, value: t.jobs, color: null }))} />
        </div>
        <table className="w-full self-start border-collapse">
          <thead><tr><Th left>Job type</Th><Th>Jobs</Th><Th>Done</Th><Th>Not done</Th><Th>Order value</Th></tr></thead>
          <tbody>
            {types.map((t) => <tr key={t.type}><Td left>{t.type}</Td><Td>{t.jobs}</Td><Td className="text-synced">{t.done}</Td><Td className={t.jobs - t.done ? "text-warning-text" : ""}>{t.jobs - t.done}</Td><Td>{t.amountSen ? fmtSen(t.amountSen) : "—"}</Td></tr>)}
            {types.length === 0 && <tr><Td left className="text-ink-muted">No jobs dated in this period.</Td></tr>}
            {types.length > 0 && <tr className="font-semibold"><Td left>Total</Td><Td>{jobs.length}</Td><Td>{types.reduce((a, t) => a + t.done, 0)}</Td><Td>{types.reduce((a, t) => a + t.jobs - t.done, 0)}</Td><Td>{fmtSen(types.reduce((a, t) => a + t.amountSen, 0))}</Td></tr>}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
