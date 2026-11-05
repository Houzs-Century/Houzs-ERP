import { describe, it, expect } from "vitest";
import { isDispatched } from "./runSheetDispatch";

/* Owner 2026-10-25 (tightened from 2026-10-22; delivery-date basis 2026-10-31): a
   DELIVERY (SO) stop is on the run-sheet when it has a cut DO, a driver, AND a
   Delivery Date (amended ?? customer). The DO's OWN document date is no longer
   compared — a reschedule moves the order's Delivery Date but not the DO's
   document date, which used to silently drop rescheduled bills. No driver → it
   stays on the desktop Delivery Planning board. Setup / Dismantle / DP legs carry
   no DO, so a named driver is their only gate. Which day a stop shows on is
   runDateOf's job (amended-aware), not this test's. */
describe("isDispatched — run-sheet dispatched filter", () => {
  it("keeps a delivery with a cut DO, a driver, and a Delivery Date", () => {
    expect(isDispatched({
      row_type: "so", delivery_orders: [{ id: "do1" }], crew: { driver: "Teik Hua" },
      customer_delivery_date: "2026-10-25",
    })).toBe(true);
  });

  it("keeps a rescheduled bill with a cut DO + driver (the amended date is what counts, not the DO's document date)", () => {
    // UMAR FARHAN: order rescheduled to a new day; the DO was cut earlier, so its
    // own document date is a different day. It used to drop off the driver's
    // phone; now it stays and runDateOf buckets it on the amended day.
    expect(isDispatched({
      row_type: "so", delivery_orders: [{ id: "do1" }], crew: { driver: "UMAR FARHAN" },
      amended_delivery_date: "2026-10-31", customer_delivery_date: "2026-10-25",
    })).toBe(true);
  });

  it("drops a delivery that has a DO but NO driver (stays in Delivery Planning)", () => {
    expect(isDispatched({
      row_type: "so", delivery_orders: [{ id: "do1" }], crew: { driver: null },
      customer_delivery_date: "2026-10-25",
    })).toBe(false);
  });

  it("drops a delivery that has a driver but NO cut DO", () => {
    expect(isDispatched({
      row_type: "so", delivery_orders: [], crew: { driver: "Teik Hua" },
      customer_delivery_date: "2026-10-25",
    })).toBe(false);
  });

  it("drops a delivery that carries no Delivery Date at all, even with a DO and driver", () => {
    expect(isDispatched({
      row_type: "so", delivery_orders: [{ id: "do1" }], crew: { driver: "Teik Hua" },
    })).toBe(false);
  });

  it("keeps a SETUP / DISMANTLE (project / DP) leg with a named driver and no DO", () => {
    // Project / DP legs never carry a DO — the driver-name arm is what keeps them.
    expect(isDispatched({ row_type: "project", delivery_orders: [], crew: { driver: "FASLIE ANAK DENNIS" } })).toBe(true);
    expect(isDispatched({ row_type: "dp", delivery_orders: [], crew: { driver: "FASLIE ANAK DENNIS" } })).toBe(true);
  });

  it("drops a non-delivery leg that has no driver", () => {
    expect(isDispatched({ row_type: "project", delivery_orders: [], crew: { driver: null } })).toBe(false);
  });

  it("drops an order that only carries a customer date (no DO, no driver)", () => {
    expect(isDispatched({ row_type: "so", delivery_orders: [], crew: { driver: null }, customer_delivery_date: "2026-10-25" })).toBe(false);
    expect(isDispatched({ delivery_orders: undefined, crew: null })).toBe(false);
    expect(isDispatched({})).toBe(false);
  });

  it("ignores a blank / whitespace driver name and a DO with no id", () => {
    expect(isDispatched({ row_type: "so", delivery_orders: [{ id: "do1" }], crew: { driver: "   " }, customer_delivery_date: "2026-10-25" })).toBe(false);
    expect(isDispatched({ row_type: "so", delivery_orders: [{ id: null }], crew: { driver: "Teik Hua" }, customer_delivery_date: "2026-10-25" })).toBe(false);
  });
});
