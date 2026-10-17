// Logistic Overview · the selected period (owner, 2026-10-17): what was
// delivered (DO amount and orders), the average order (delivery orders only),
// the average a lorry carried, what is overdue today, the average order per
// product category, and the jobs of the period by type.
import { useState } from "react";
import { fmtSen } from "../../vendor/shared/format";
import { ASSR_JOB_KIND_LABEL, type AssrJobKind, type PlanningOrder } from "../../vendor/scm/lib/delivery-planning-queries";
import { Th, Td, Panel, Toggle } from "../../components/scm-v2/OverviewKit";
import { Tile } from "../../components/scm-v2/Charts";
import type { Period } from "../../components/scm-v2/DashboardPeriod";

import type { DayRow, RegionRow } from "./LogisticDailySection";

export type PeriodTotals = {
  from: string; to: string; doCount: number; doAmountSen: number; podClosed: number;
  days: DayRow[]; byRegion: RegionRow[];
  lorry: { lorryDays: number; recordedOrders: number; perLorrySen: number | null };
  byCategory: Array<{ category: string; orders: number; amountSen: number; avgSen: number | null }>;
  chargesSen: number;
};

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

export function LogisticPeriodSection({ rows, period, today, totals, overdue, onOverdue }: {
  rows: PlanningOrder[]; period: Period; today: string; totals: PeriodTotals | null;
  overdue: { count: number; sen: number }; onOverdue: () => void;
}) {
  const [by, setBy] = useState<"amount" | "orders">("amount");
  const amt = by === "amount";
  const date = (o: PlanningOrder) => o.effective_delivery_date;
  const jobs = rows.filter((o) => !!date(o) && (date(o) as string) >= period.from && (date(o) as string) <= period.to);
  const byType = new Map<string, { type: string; jobs: number; done: number }>();
  for (const o of jobs) {
    const t = jobTypeOf(o);
    const g = byType.get(t) ?? { type: t, jobs: 0, done: 0 };
    g.jobs += 1; if (jobDone(o, today)) g.done += 1;
    byType.set(t, g);
  }
  const types = [...byType.values()].sort((a, b) => b.jobs - a.jobs);
  const avgOrder = totals && totals.doCount ? totals.doAmountSen / totals.doCount : null;

  return (
    <Panel title={`Delivered · ${period.label}`} hint={`delivery orders issued ${period.from} – ${period.to} (the day the goods leave on the lorry)`}
      right={<Toggle value={by} options={[["amount", "By amount"], ["orders", "By orders"]]} onChange={setBy} />}>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile label="Delivered" tone="good" trend={null} onClick={null}
          value={totals ? (amt ? fmtSen(totals.doAmountSen) : `${totals.doCount} orders`) : "…"}
          note={totals ? (amt ? `${totals.doCount} delivery orders` : fmtSen(totals.doAmountSen)) : ""} />
        <Tile label="Average per order" tone="brass" trend={null} onClick={null}
          value={avgOrder != null ? fmtSen(avgOrder) : "—"} note="delivery orders only · service cases not counted" />
        <Tile label="Average per lorry, per day" tone="brass" trend={null} onClick={null}
          value={totals?.lorry.perLorrySen != null ? fmtSen(totals.lorry.perLorrySen) : "—"}
          note={totals ? (totals.lorry.recordedOrders ? `${totals.lorry.lorryDays} lorry-days · lorry recorded on ${totals.lorry.recordedOrders} of ${totals.doCount} DO` : `lorry not recorded on the DOs yet (0 of ${totals.doCount})`) : ""} />
        <Tile label="Overdue now" tone={overdue.count ? "bad" : "good"} trend={null} onClick={overdue.count ? onOverdue : null}
          value={amt ? fmtSen(overdue.sen) : `${overdue.count} orders`} note={overdue.count ? `${amt ? `${overdue.count} orders` : fmtSen(overdue.sen)} past their delivery date · see the list` : "nothing past its date"} />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-[1.3fr_1fr]">
        <div>
          <div className="mb-1.5 text-[12px] font-semibold text-ink">Average per order, by category</div>
          {totals && totals.byCategory.length > 0 ? (
            <table className="w-full border-collapse">
              <thead><tr><Th left>Category</Th><Th>Orders</Th><Th>Amount</Th><Th>Average per order</Th></tr></thead>
              <tbody>{totals.byCategory.map((c) => (
                <tr key={c.category}><Td left>{c.category}</Td><Td>{c.orders}</Td><Td>{fmtSen(c.amountSen)}</Td><Td className="font-semibold">{c.avgSen != null ? fmtSen(c.avgSen) : "—"}</Td></tr>
              ))}</tbody>
            </table>
          ) : <p className="text-[12.5px] text-ink-muted">Nothing delivered in this period.</p>}
          <p className="mt-1 text-[11px] text-ink-muted">
            An order counts in each category it charges for, with only that category&apos;s amount. Free items (bundled bedframes, gift pillows) are left out, and so are fee lines (transport, disposal, storage{totals?.chargesSen ? `: ${fmtSen(totals.chargesSen)} this period` : ""}).
          </p>
        </div>
        <div>
          <div className="mb-1.5 text-[12px] font-semibold text-ink">Jobs dated in the period, by type</div>
          <table className="w-full border-collapse">
            <thead><tr><Th left>Job type</Th><Th>Jobs</Th><Th>Done</Th><Th>Not done</Th></tr></thead>
            <tbody>
              {types.map((t) => <tr key={t.type}><Td left>{t.type}</Td><Td>{t.jobs}</Td><Td className="text-synced">{t.done}</Td><Td className={t.jobs - t.done ? "text-warning-text" : ""}>{t.jobs - t.done}</Td></tr>)}
              {types.length > 0 && <tr className="font-semibold"><Td left>Total</Td><Td>{jobs.length}</Td><Td>{types.reduce((a, t) => a + t.done, 0)}</Td><Td>{types.reduce((a, t) => a + t.jobs - t.done, 0)}</Td></tr>}
              {types.length === 0 && <tr><Td left className="text-ink-muted">No jobs dated in this period.</Td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </Panel>
  );
}
