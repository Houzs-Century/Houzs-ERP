import { describe, it, expect } from "vitest";
import { resolveSoLocation } from "./soLocation";

describe("resolveSoLocation", () => {
  it("prefers the resolved warehouse over the free-text snapshot", () => {
    expect(
      resolveSoLocation({
        warehouse_name: "KL WAREHOUSE",
        sales_location: "Johor Bahru",
      })
    ).toEqual({ label: "KL WAREHOUSE", isWarehouse: true });
  });

  it("falls back to the free text and flags it as unverified", () => {
    expect(
      resolveSoLocation({ warehouse_name: null, sales_location: "Johor Bahru" })
    ).toEqual({ label: "Johor Bahru", isWarehouse: false });
  });

  it("flags the fallback even when the free text is a real warehouse code", () => {
    expect(
      resolveSoLocation({ warehouse_name: null, sales_location: "KL WAREHOUSE" })
    ).toEqual({ label: "KL WAREHOUSE", isWarehouse: false });
  });

  it("treats blank and whitespace-only values as absent", () => {
    expect(
      resolveSoLocation({ warehouse_name: "   ", sales_location: "Kuantan" })
    ).toEqual({ label: "Kuantan", isWarehouse: false });
    expect(
      resolveSoLocation({ warehouse_name: "", sales_location: "" })
    ).toEqual({ label: null, isWarehouse: false });
  });

  it("trims the label it returns", () => {
    expect(
      resolveSoLocation({ warehouse_name: "  KL WAREHOUSE  " })
    ).toEqual({ label: "KL WAREHOUSE", isWarehouse: true });
  });

  it("returns no label when the row carries neither", () => {
    expect(resolveSoLocation({})).toEqual({ label: null, isWarehouse: false });
    expect(resolveSoLocation(null)).toEqual({ label: null, isWarehouse: false });
    expect(resolveSoLocation(undefined)).toEqual({
      label: null,
      isWarehouse: false,
    });
  });
});
