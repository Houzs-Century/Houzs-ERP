import { describe, expect, it } from "vitest";
import { toQuarters, type PnlBucket } from "./PnlCalendar";

const month = (m: number, revenue: number, cost: number): PnlBucket => {
  const mm = String(m).padStart(2, "0");
  const next = m === 12 ? "2027-01-01" : `2026-${String(m + 1).padStart(2, "0")}-01`;
  return { key: `2026-${mm}`, label: mm, start: `2026-${mm}-01`, endExclusive: next, revenue, cost, gross: revenue - cost,
    by_source: { sales_revenue: revenue, project_cost: cost, service_cost: 0, po_cost: 0 } };
};

describe("P&L quarterly view", () => {
  it("adds three months into one quarter spanning their dates", () => {
    const q = toQuarters([month(1, 100, 40), month(2, 50, 10), month(3, 10, 5), month(4, 7, 1)]);
    expect(q.map((b) => [b.key, b.label, b.start, b.endExclusive, b.revenue, b.cost, b.gross])).toEqual([
      ["2026-Q1", "Q1", "2026-01-01", "2026-04-01", 160, 55, 105],
      ["2026-Q2", "Q2", "2026-04-01", "2026-05-01", 7, 1, 6],
    ]);
    expect(q[0]!.by_source.project_cost).toBe(55);
  });
});
