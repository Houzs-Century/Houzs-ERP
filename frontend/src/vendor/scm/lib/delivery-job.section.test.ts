/* Last Mile stop drawer: a DP job showed its address, contact and date in the
   drawer, then again in the embedded job panel's Job section. */
import { describe, expect, it } from "vitest";
import { jobSectionRows } from "./delivery-job";

const ctx = { kind: "SUPPLIER_PICKUP", address: "12 Jalan A", state: "Selangor", contact_name: "Ali", contact_phone: "012", date: "2026-11-17", remark: "Fragile" };

describe("jobSectionRows", () => {
  it("the stand-alone job panel keeps every fact (a DP job's State is on its own row)", () => {
    expect(jobSectionRows(ctx, "dp", false).map(([k]) => k)).toEqual(["Address", "Contact", "Date", "Remark"]);
    expect(jobSectionRows(ctx, "project", false).map(([k]) => k)).toEqual(["Address", "State", "Contact", "Date", "Remark"]);
  });
  it("inside the stop drawer, only what the drawer does not show", () => {
    expect(jobSectionRows(ctx, "dp", true).map(([k]) => k)).toEqual(["Remark"]);
  });
});
