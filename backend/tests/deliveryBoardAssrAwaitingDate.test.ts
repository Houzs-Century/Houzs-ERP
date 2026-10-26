import { describe, expect, test } from "vitest";
import { assrBoardLegs, assrBoardUnionSql } from "../src/scm/lib/assr-board-scope";

/* Owner 2026-10-26 (option A): a Service Case at Pickup / Return or Delivery with
   no date for that leg waits in Delivery Planning's Pending Schedule; before this
   it was not on the board at all (4 Delivery + 3 Pickup cases that day). */
const blank = { stage: null, customer_pickup_at: null, inspection_visit_at: null, inspection_by: null, do_date: null };

describe("Service Cases waiting for a fleet date", () => {
  test("the union reads them in even with no date", () => {
    const sql = assrBoardUnionSql({ get: () => undefined } as never, "2026-07-28");
    expect(sql).toContain("assr_cases.stage IN ('pending_supplier_pickup', 'pending_delivery_service')");
  });

  test("Delivery with no do_date -> one undated delivery leg; Pickup / Return -> customer pickup", () => {
    expect(assrBoardLegs({ ...blank, stage: "pending_delivery_service" }, false)).toEqual([{ jobKind: "delivery", date: null }]);
    expect(assrBoardLegs({ ...blank, stage: "pending_supplier_pickup" }, false)).toEqual([{ jobKind: "customer_pickup", date: null }]);
  });

  test("a dated leg is not doubled, other stages and closed cases add nothing", () => {
    expect(assrBoardLegs({ ...blank, stage: "pending_delivery_service", do_date: "2026-10-30" }, false)).toEqual([{ jobKind: "delivery", date: "2026-10-30" }]);
    expect(assrBoardLegs({ ...blank, stage: "pending_item_ready" }, false)).toEqual([]);
    expect(assrBoardLegs({ ...blank, stage: "pending_delivery_service" }, true)).toEqual([]);
  });
});
