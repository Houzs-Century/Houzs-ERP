import { describe, it, expect } from "vitest";
import { monthBounds, monthOptions } from "./DoDateFilter";
import { doListSearchParams } from "../../vendor/scm/lib/delivery-order-queries";

describe("DO list date window (HC-0151)", () => {
  it("a month runs from its 1st to its last day", () => {
    expect(monthBounds("2026-10")).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    expect(monthBounds("2028-02")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
    expect(monthBounds("2026-12")).toEqual({ from: "2026-12-01", to: "2026-12-31" });
  });

  it("offers the last 24 months newest first, across a year end", () => {
    const opts = monthOptions("2026-01", "");
    expect(opts.slice(0, 3)).toEqual(["2026-01", "2025-12", "2025-11"]);
    expect(opts).toHaveLength(24);
    expect(monthOptions("2026-10", "2023-05").at(-1)).toBe("2023-05");
  });

  it("sends from / to / dateBy to the server, and no dateBy without a window", () => {
    const usp = doListSearchParams({ from: "2026-10-01", to: "2026-10-31", dateBy: "delivery" });
    expect(usp.get("from")).toBe("2026-10-01");
    expect(usp.get("to")).toBe("2026-10-31");
    expect(usp.get("dateBy")).toBe("delivery");
    expect(doListSearchParams({ dateBy: "do" }).has("dateBy")).toBe(false);
  });
});
