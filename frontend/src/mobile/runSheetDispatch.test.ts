import { describe, it, expect } from "vitest";
import { isDispatched } from "./runSheetDispatch";

/* Owner 2026-10-25 (tightened from 2026-10-22): a DELIVERY (SO) stop is on the
   run-sheet only when it has a cut DO, a driver, AND the DO's date matches the
   order's Delivery Date (amended ?? customer, never the sales-exemption-expiry).
   No driver → it stays on the desktop Delivery Planning board. Setup / Dismantle
   / DP legs carry no DO, so a named driver is their only gate. */
describe("isDispatched — run-sheet dispatched filter", () => {
  it("keeps a delivery with a cut DO, a driver, and a DO date that matches the Delivery Date", () => {
    expect(isDispatched({
      row_type: "so", delivery_orders: [{ id: "do1" }], crew: { driver: "Teik Hua" },
      do_date: "2026-10-25", customer_delivery_date: "2026-10-25",
    })).toBe(true);
  });

  it("drops a delivery that has a DO but NO driver (stays in Delivery Planning)", () => {
    expect(isDispatched({
      row_type: "so", delivery_orders: [{ id: "do1" }], crew: { driver: null },
      do_date: "2026-10-25", customer_delivery_date: "2026-10-25",
    })).toBe(false);
  });

  it("drops a delivery whose DO date disagrees with the order's Delivery Date", () => {
    // GOH EE SEONG: DO dated 10-24, order Delivery Date 10-25 — a stale DO.
    expect(isDispatched({
      row_type: "so", delivery_orders: [{ id: "do1" }], crew: { driver: "Teik Hua" },
      do_date: "2026-10-24", customer_delivery_date: "2026-10-25",
    })).toBe(false);
  });

  it("matches on the amended Delivery Date when one is set, not the original customer date", () => {
    expect(isDispatched({
      row_type: "so", delivery_orders: [{ id: "do1" }], crew: { driver: "Teik Hua" },
      do_date: "2026-10-26", amended_delivery_date: "2026-10-26", customer_delivery_date: "2026-10-25",
    })).toBe(true);
  });

  it("drops a delivery that carries no Delivery Date at all, even with a DO and driver", () => {
    expect(isDispatched({
      row_type: "so", delivery_orders: [{ id: "do1" }], crew: { driver: "Teik Hua" },
      do_date: "2026-10-25",
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
    expect(isDispatched({ row_type: "so", delivery_orders: [{ id: "do1" }], crew: { driver: "   " }, do_date: "2026-10-25", customer_delivery_date: "2026-10-25" })).toBe(false);
    expect(isDispatched({ row_type: "so", delivery_orders: [{ id: null }], crew: { driver: "Teik Hua" }, do_date: "2026-10-25", customer_delivery_date: "2026-10-25" })).toBe(false);
  });
});
