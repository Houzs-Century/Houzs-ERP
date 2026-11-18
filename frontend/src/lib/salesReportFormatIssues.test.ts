import { describe, it, expect } from "vitest";
import { salesReportFormatIssues } from "./salesReportFormatIssues";
import { parseSalesReport } from "../vendor/shared/sales-report-parse";

describe("salesReportFormatIssues", () => {
  it("regular chat note → no issues", () => {
    expect(salesReportFormatIssues("@Ali remember the booth number")).toEqual([]);
  });

  it("empty / null → no issues", () => {
    expect(salesReportFormatIssues("")).toEqual([]);
    expect(salesReportFormatIssues(null)).toEqual([]);
    expect(salesReportFormatIssues("   ")).toEqual([]);
  });

  it("summary-only paste → summary_only hint", () => {
    const summary = [
      "Akemi @ Spice Arena",
      "6/11 - RM13,688",
      "7/11 - RM12,499",
      "Total RM26,187",
    ].join("\n");
    const issues = salesReportFormatIssues(summary);
    expect(issues.map((i) => i.code)).toContain("summary_only");
  });

  it("the summary_only hint's example is itself read as a bill (HC-0239: the old example was not)", () => {
    const hint = salesReportFormatIssues("13/11 - RM35,315\nTotal RM35,315").find((i) => i.code === "summary_only");
    const example = hint?.message.match(/`([^`]+)`/)?.[1] ?? "";
    const bills = parseSalesReport(`13/11\n${example}`).bills;
    expect(bills.map((b) => [b.ref_token, b.amount_sen, b.salesperson_name])).toEqual([["ZNT5839", 588800, "Anthony"]]);
  });

  it("bill lines missing names → bills_missing_name hint", () => {
    const report = [
      "Akemi 11/10",
      "1. HC8993 RM6500",
      "2. HC10785 RM4999 Melvin",
      "Total RM 11,499",
    ].join("\n");
    const issues = salesReportFormatIssues(report);
    const miss = issues.find((i) => i.code === "bills_missing_name");
    expect(miss).toBeTruthy();
    expect(miss?.message).toContain("1 bill is missing");
  });

  it("well-formed bill paste with names → no hints for name/summary", () => {
    const report = [
      "Akemi 11/10",
      "1. HC8993 RM6500 Jason",
      "2. HC10785 RM4999 Melvin",
      "Total RM 11,499",
    ].join("\n");
    const codes = salesReportFormatIssues(report).map((i) => i.code);
    expect(codes).not.toContain("summary_only");
    expect(codes).not.toContain("bills_missing_name");
  });

  it("total that does not add up → total_mismatch warn", () => {
    const report = [
      "Akemi 11/10",
      "1. HC8993 RM6500 Jason",
      "2. HC10785 RM4999 Melvin",
      "Total RM 20,000",
    ].join("\n");
    const issues = salesReportFormatIssues(report);
    const mm = issues.find((i) => i.code === "total_mismatch");
    expect(mm).toBeTruthy();
    expect(mm?.tone).toBe("warn");
  });
});
