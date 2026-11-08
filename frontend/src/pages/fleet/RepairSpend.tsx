// What this lorry has cost to keep running (owner, 2026-10-15: "整个历史的维修
// amount"). Every repair and every recorded service is a work order, so the sum
// of the work orders' totals is the lorry's whole repair spend.
import { fmtSen } from "../../vendor/shared/format";
import { Tile } from "./FleetUi";

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
  return (
    <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
      <Tile label="All time" value={fmtSen(s.lifetimeSen)} hint={`${s.count} work order${s.count === 1 ? "" : "s"}`} />
      <Tile label={`This year (${today.slice(0, 4)})`} value={fmtSen(s.yearSen)} />
      <Tile label="This month" value={fmtSen(s.monthSen)} />
    </div>
  );
}
