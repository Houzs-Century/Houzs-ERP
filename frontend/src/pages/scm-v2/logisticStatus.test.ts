import { describe, it, expect } from "vitest";
import { deliveryProgressBreakdown, messageStatusBreakdown, ordersOfSlice, topWithOther, NO_MESSAGE_STATUS } from "./logisticStatus";
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

describe("topWithOther", () => {
  const slice = (label: string, count: number, pct: number) => ({ key: label, label, count, sen: count * 10, pct });

  it("returns the list unchanged when it already fits", () => {
    const s = [slice("A", 5, 50), slice("B", 5, 50)];
    expect(topWithOther(s, 7)).toBe(s);
  });

  it("folds the tail into one 'Other (k)' row with a recomputed share", () => {
    const s = [slice("A", 50, 50), slice("B", 30, 30), slice("C", 12, 12), slice("D", 5, 5), slice("E", 3, 3)];
    const r = topWithOther(s, 2);
    expect(r).toHaveLength(3);
    expect(r[2]).toMatchObject({ key: "__other__", label: "Other (3)", count: 20, sen: 200, pct: 20 });
  });
});

describe("the orders behind a message-status row", () => {
  const o = (so: string, msg: string | null) => ({ so_doc_no: so, delivery_message_status: msg, delivery_state: "PENDING_DELIVERY", local_total_sen: 100 }) as unknown as PlanningOrder;
  const rows = [o("A", "Done Scheduling"), o("B", null), o("C", "Rare one"), o("D", "Done Scheduling")];
  const shown = topWithOther(messageStatusBreakdown(rows), 2);
  it("a named row lists its own orders, a blank status reads as no status yet", () => {
    expect(ordersOfSlice(rows, "Done Scheduling", shown).map((x) => x.so_doc_no)).toEqual(["A", "D"]);
    expect(ordersOfSlice(rows, NO_MESSAGE_STATUS, shown).map((x) => x.so_doc_no)).toEqual(["B"]);
  });
  it("Other lists every order whose status has no row of its own", () => {
    expect(ordersOfSlice(rows, "__other__", shown).map((x) => x.so_doc_no)).toEqual(["C"]);
  });
});
