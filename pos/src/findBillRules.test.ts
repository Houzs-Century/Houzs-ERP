import { describe, expect, test } from "vitest";
import { findBillDays, otherDeviceBills } from "./findBillRules";
import type { SaleRecord } from "./sale";

const bill = (uuid: string, receipt_no: string): SaleRecord => ({ uuid, receipt_no } as SaleRecord);

describe("findBillRules", () => {
  test("a bill this device holds itself is not listed again from the ERP", () => {
    const local = [bill("a", "T01-000005")];
    const erp = [bill("a", "T01-000005"), bill("b", "T03-000001")];
    expect(otherDeviceBills(local, erp).map((s) => s.receipt_no)).toEqual(["T03-000001"]);
    expect(otherDeviceBills([], erp)).toHaveLength(2);
  });
  test("today only asks for today; otherwise from the start of the event", () => {
    expect(findBillDays(true, "2026-11-06", "2026-11-19")).toEqual({ from: "2026-11-19", to: "2026-11-19" });
    expect(findBillDays(false, "2026-11-06", "2026-11-19")).toEqual({ from: "2026-11-06", to: "2026-11-19" });
  });
  test("an event with no start date, or one that starts later, goes 30 days back", () => {
    expect(findBillDays(false, null, "2026-11-19")).toEqual({ from: "2026-10-20", to: "2026-11-19" });
    expect(findBillDays(false, "2026-12-01", "2026-11-19")).toEqual({ from: "2026-10-20", to: "2026-11-19" });
  });
});
