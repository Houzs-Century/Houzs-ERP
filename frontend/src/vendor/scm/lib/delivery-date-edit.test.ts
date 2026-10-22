import { describe, it, expect } from "vitest";
import { deliveryDateChange } from "./delivery-date-edit";

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
