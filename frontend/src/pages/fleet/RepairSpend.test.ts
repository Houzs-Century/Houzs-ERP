import { describe, expect, test } from "vitest";
import { repairSpendOf } from "./RepairSpend";

describe("repairSpendOf", () => {
  test("sums every work order, and splits by the period it was completed (or reported)", () => {
    const s = repairSpendOf([
      { totalSen: 35000, actualComplete: "2026-10-10T00:00:00+08:00", reportedAt: "2026-10-01T00:00:00Z", status: "COMPLETED" },
      { totalSen: 12000, actualComplete: null, reportedAt: "2026-03-02T00:00:00Z", status: "IN_REPAIR" },
      { totalSen: 50000, actualComplete: "2025-12-20T00:00:00Z", reportedAt: null, status: "VERIFIED" },
    ], "2026-10-15");
    expect(s).toEqual({ lifetimeSen: 97000, yearSen: 47000, monthSen: 35000, count: 3 });
  });
});
