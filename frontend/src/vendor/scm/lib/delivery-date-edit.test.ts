import { describe, it, expect } from "vitest";
import { deliveryDateChange, invalidDeliveryDate } from "./delivery-date-edit";

describe("deliveryDateChange", () => {
  it("no write when the value is unchanged", () => {
    expect(deliveryDateChange("2026-03-31", "2026-03-31")).toEqual({ changed: false, value: null });
    expect(deliveryDateChange("", "")).toEqual({ changed: false, value: null });
  });

  it("a new date writes that date", () => {
    expect(deliveryDateChange("2026-03-31", "2026-04-02")).toEqual({ changed: true, value: "2026-04-02" });
    expect(deliveryDateChange("", "2026-04-02")).toEqual({ changed: true, value: "2026-04-02" });
  });

  it("clearing a date writes null, not an empty string (unschedule)", () => {
    expect(deliveryDateChange("2026-03-31", "")).toEqual({ changed: true, value: null });
  });
});

/* HC-0164 (Syu, 2026-10-28): a typo like 35/11/2026 put the old date back on
   screen; she wants the cell emptied, as the HC Delivery sheet does. */
describe("invalidDeliveryDate", () => {
  it("a typo over a saved date clears it and says which date went", () => {
    const r = invalidDeliveryDate("2026-10-30", "35/11/2026", "HC-SO-006432");
    expect(r.clear).toBe(true);
    expect(r.body).toContain('"35/11/2026" is not a date');
    expect(r.body).toContain("HC-SO-006432");
    expect(r.body).toContain("has been cleared");
  });

  it("a typo in an empty cell writes nothing", () => {
    const r = invalidDeliveryDate("", "35/11/2026", "HC-SO-010484");
    expect(r.clear).toBe(false);
    expect(r.body).toContain("stays empty");
  });
});
