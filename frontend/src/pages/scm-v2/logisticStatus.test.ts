import { describe, it, expect } from "vitest";
import { deliveryProgressBreakdown, messageStatusBreakdown, NO_MESSAGE_STATUS } from "./logisticStatus";
import type { PlanningOrder } from "../../vendor/scm/lib/delivery-planning-queries";

/** Only the three fields the breakdowns read; the rest is irrelevant here. */
const o = (
  delivery_state: PlanningOrder["delivery_state"],
  delivery_message_status: string | null,
  local_total_sen = 0,
): PlanningOrder => ({ delivery_state, delivery_message_status, local_total_sen } as unknown as PlanningOrder);

describe("deliveryProgressBreakdown", () => {
  it("counts by state in the board tab order, with share and amount", () => {
    const rows = [
      o("PENDING_DELIVERY", null, 100),
      o("PENDING_DELIVERY", null, 100),
      o("OVERDUE", null, 50),
      o("DELIVERED", null, 250),
    ];
    const r = deliveryProgressBreakdown(rows);
    // Pending Schedule has no rows, so it is dropped; order follows DELIVERY_STATES.
    expect(r.map((s) => s.key)).toEqual(["PENDING_DELIVERY", "OVERDUE", "DELIVERED"]);
    expect(r[0]).toMatchObject({ count: 2, sen: 200, pct: 50 });
    expect(r[1]).toMatchObject({ count: 1, pct: 25 });
    expect(r.reduce((a, s) => a + s.count, 0)).toBe(4);
  });

  it("is empty for no rows and never divides by zero", () => {
    expect(deliveryProgressBreakdown([])).toEqual([]);
  });
});

describe("messageStatusBreakdown", () => {
  it("buckets blank / null as 'No status yet' and sorts biggest first", () => {
    const rows = [
      o("PENDING_DELIVERY", null, 10),
      o("PENDING_DELIVERY", "", 10),
      o("PENDING_DELIVERY", "   ", 10),
      o("PENDING_DELIVERY", "Done Scheduling", 20),
      o("DELIVERED", "Done Scheduling", 20),
      o("OVERDUE", "Invalid Data", 5),
    ];
    const r = messageStatusBreakdown(rows);
    expect(r[0]).toMatchObject({ label: NO_MESSAGE_STATUS, count: 3, pct: 50 });
    expect(r[1]).toMatchObject({ label: "Done Scheduling", count: 2 });
    expect(r.find((s) => s.label === "Invalid Data")).toMatchObject({ count: 1 });
  });
});
