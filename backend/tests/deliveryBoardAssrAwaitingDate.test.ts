import { describe, expect, test } from "vitest";
import { assrBoardLegs, assrBoardUnionSql, assrCaseClosed, type AssrBoardCase } from "../src/scm/lib/assr-board-scope";

/* Owner 2026-10-26: a Service Case's own-team leg is a REQUEST until Logistics
   confirms it. Service keys Own team + a date -> Pending Schedule; Logistics sets
   the date on the board (sched_* column) -> Pending Delivery, shown back on the
   case. Supplier legs never reach the board, and a leg the case has moved past
   (already picked up) is done, not left in Pending Delivery. */
const blank: AssrBoardCase = {
  stage: null, pickup_by: null, pickup_pic: null, customer_pickup_at: null, actual_pickup_at: null, sched_pickup_date: null,
  inspection_by: null, inspection_visit_at: null, sched_inspection_date: null,
  delivery_by: null, do_date: null, sched_delivery_date: null,
};

describe("Service Case legs on Delivery Planning", () => {
  test("the union reads open cases at the pickup / delivery stages even with no date", () => {
    const sql = assrBoardUnionSql({ get: () => undefined } as never, "2026-07-28");
    expect(sql).toContain("assr_cases.stage IN ('pending_supplier_pickup', 'pending_delivery_service')");
    expect(sql).toContain("sched_delivery_date AS sched_delivery_date");
  });

  test("Own team + Service's date = Pending Schedule; Logistics' date = Pending Delivery", () => {
    const own = { ...blank, stage: "pending_delivery_service", delivery_by: "own", do_date: "2026-10-26" };
    expect(assrBoardLegs(own, false)).toEqual([{ jobKind: "delivery", requested: "2026-10-26", confirmed: null, state: "PENDING_SCHEDULE" }]);
    expect(assrBoardLegs({ ...own, sched_delivery_date: "2026-10-28" }, false)[0]).toMatchObject({ confirmed: "2026-10-28", state: "PENDING_DELIVERY" });
    expect(assrBoardLegs({ ...blank, stage: "pending_supplier_pickup", pickup_by: "customer" }, false))
      .toEqual([{ jobKind: "customer_pickup", requested: null, confirmed: null, state: "PENDING_SCHEDULE" }]);
  });

  test("a supplier leg, or no choice and no date, stays off the board", () => {
    expect(assrBoardLegs({ ...blank, stage: "pending_delivery_service", delivery_by: "supplier", do_date: "2026-10-26" }, false)).toEqual([]);
    expect(assrBoardLegs({ ...blank, stage: "pending_supplier_pickup", pickup_by: "supplier" }, false)).toEqual([]);
    expect(assrBoardLegs({ ...blank, stage: "pending_delivery_service" }, false)).toEqual([]);
  });

  test("a pickup the case has moved past is Delivered, not Pending Delivery", () => {
    const moved = { ...blank, stage: "pending_delivery_service", pickup_by: "customer", customer_pickup_at: "2026-10-13" };
    expect(assrBoardLegs(moved, false)).toEqual([{ jobKind: "customer_pickup", requested: "2026-10-13", confirmed: null, state: "DELIVERED" }]);
    expect(assrBoardLegs({ ...blank, stage: "pending_supplier_pickup", pickup_by: "customer", customer_pickup_at: "2026-10-20", actual_pickup_at: "2026-10-20" }, false)[0].state).toBe("DELIVERED");
  });

  test("a closed case's dated legs are Delivered", () => {
    expect(assrBoardLegs({ ...blank, stage: "completed", delivery_by: "own", do_date: "2026-10-01" }, true)[0].state).toBe("DELIVERED");
  });
});

/* 2026-10-26: 56 old cases with status "Closed" but no closed_at stamp showed as
   pending deliveries once the confirmed date was read. */
describe("assrCaseClosed", () => {
  const open = { closed_at: null, archived_at: null, stage: "pending_delivery_service", status: "Open" };
  test("a Closed status, a terminal stage or a stamp all close the case", () => {
    expect(assrCaseClosed(open)).toBe(false);
    expect(assrCaseClosed({ ...open, status: "Closed" })).toBe(true);
    expect(assrCaseClosed({ ...open, stage: "completed" })).toBe(true);
    expect(assrCaseClosed({ ...open, stage: "voided" })).toBe(true);
    expect(assrCaseClosed({ ...open, closed_at: "2026-03-01" })).toBe(true);
  });
});
