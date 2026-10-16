// What this lorry has cost to keep running (owner, 2026-10-15: "整个历史的维修
// amount"). Every repair and every recorded service is a work order, so the sum
// of the work orders' totals is the lorry's whole repair spend.
import { fmtSen } from "../../vendor/shared/format";

type Wo = { totalSen: number; reportedAt: string | null; actualComplete: string | null; status: string };

/** Lifetime / this-year / this-month totals. A work order counts in the period
 *  it was completed, or reported when it is not completed yet. */
export function repairSpendOf(workOrders: Wo[], today: string): { lifetimeSen: number; yearSen: number; monthSen: number; count: number } {
  let lifetimeSen = 0; let yearSen = 0; let monthSen = 0;
  for (const w of workOrders) {
    const t = Number(w.totalSen) || 0;
    lifetimeSen += t;
    const day = String(w.actualComplete ?? w.reportedAt ?? "").slice(0, 10);
    if (day.slice(0, 4) === today.slice(0, 4)) yearSen += t;
    if (day.slice(0, 7) === today.slice(0, 7)) monthSen += t;
  }
  return { lifetimeSen, yearSen, monthSen, count: workOrders.length };
}

export function RepairSpend({ workOrders, today }: { workOrders: Wo[]; today: string }) {
  const s = repairSpendOf(workOrders, today);
  const tile = (label: string, value: string, hint?: string) => (
    <div className="rounded-md border border-border bg-surface-2/40 px-3 py-2">
      <div className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">{label}</div>
      <div className="mt-0.5 text-[15px] font-semibold tabular-nums text-ink">{value}</div>
      {hint && <div className="text-[10.5px] text-ink-muted">{hint}</div>}
    </div>
  );
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
      {tile("All time", fmtSen(s.lifetimeSen), `${s.count} work order${s.count === 1 ? "" : "s"}`)}
      {tile(`This year (${today.slice(0, 4)})`, fmtSen(s.yearSen))}
      {tile("This month", fmtSen(s.monthSen))}
    </div>
  );
}
