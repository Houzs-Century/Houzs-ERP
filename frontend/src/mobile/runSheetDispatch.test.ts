import { describe, it, expect } from "vitest";
import { isDispatched } from "./runSheetDispatch";

/* Owner 2026-10-22: the driver run-sheet lists only DISPATCHED stops — a cut DO
   OR a named driver. An order merely carrying today's customer date (no DO, no
   driver) is left off the sheet (it stays on the desktop board). */
describe("isDispatched — run-sheet dispatched filter", () => {
  it("keeps a delivery with a cut DO even before a driver is assigned", () => {
    expect(isDispatched({ delivery_orders: [{ id: "do1" }], crew: { driver: null } })).toBe(true);
  });

  it("keeps a SETUP / DISMANTLE leg that has a named driver but no DO", () => {
    // Project / DP legs never carry a DO — the driver-name arm is what keeps them.
    expect(isDispatched({ delivery_orders: [], crew: { driver: "FASLIE ANAK DENNIS" } })).toBe(true);
  });

  it("drops an order that only carries a customer date (no DO, no driver)", () => {
    expect(isDispatched({ delivery_orders: [], crew: { driver: null } })).toBe(false);
    expect(isDispatched({ delivery_orders: undefined, crew: null })).toBe(false);
    expect(isDispatched({})).toBe(false);
  });

  it("ignores a blank / whitespace driver name and a DO with no id", () => {
    expect(isDispatched({ delivery_orders: [], crew: { driver: "   " } })).toBe(false);
    expect(isDispatched({ delivery_orders: [{ id: null }], crew: { driver: null } })).toBe(false);
  });
});
