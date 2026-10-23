/* The payslip paper (HC-0125 phase 4): what it DRAWS, captured off doc.text
   and the autotable cells, the way debtor-bill-pdf.test.ts does. Pinned: the
   title and month, the employee and payment block, the earnings with the
   absence and late / short lines, the deductions including the penalty
   (Hookka's slip left it off, so net did not reconcile), net pay, an unknown
   PCB printed as "--" never RM 0.00, and a draft's ESTIMATE watermark. */
import { afterEach, describe, expect, test, vi } from "vitest";
import { DEFAULT_BRANDING, clearBrandingLogoCache, setBrandingCache } from "../../lib/branding";
import type { Payslip } from "./hrApi";

type JsPdf = import("jspdf").jsPDF;
afterEach(() => {
  setBrandingCache({ ...DEFAULT_BRANDING }, "HOUZS");
  clearBrandingLogoCache();
  vi.restoreAllMocks();
});

const SLIP: Payslip = {
  id: 7, employeeId: 1, period: "2026-09", status: "APPROVED", empNo: "EMP-001", employeeName: "AHMAD BIN ALI", departmentName: "Logistics", payMode: "MONTHLY",
  fullSalarySen: 220000, dayRateSen: 8462, hourRateSen: 846, daysWorked: 23, absentDays: 2, absenceDeductionSen: 16923, shortHours: 1.5, shortHourDeductionSen: 1269,
  basicEarnedSen: 201808, otWeekdayHours: 2, otSundayHours: 0, otHolidayHours: 0, otWeekdayPaySen: 2538, otSundayPaySen: 0, otHolidayPaySen: 0, otPaySen: 2538,
  allowancesSen: 0, commissionSen: 0, tripAllowanceSen: 0, backpaySen: 0, grossSen: 204346, epfEmployeeSen: 24200, epfEmployerSen: 28600, socsoEmployeeSen: 745, socsoEmployerSen: 2615, eisEmployeeSen: 390, eisEmployerSen: 390,
  pcbSen: 0, pcbStatus: "UNKNOWN", statutoryEmployeeSen: 25335, advanceSen: 30000, penaltySen: 5000, netSen: 144011, paymentMethod: "TRANSFER", bankName: "Maybank", bankAccount: "114011223344",
  detail: { absentDates: ["2026-09-08", "2026-09-09"], otDays: [{ date: "2026-09-10", hours: 2, kind: "WEEKDAY" }], advanceDates: ["2026-09-12"], pcbNote: "PCB not computed: tax residency missing." },
  approvedAt: null, paidAt: null,
};

async function render(over: Partial<Payslip> = {}): Promise<string[]> {
  setBrandingCache({ ...DEFAULT_BRANDING, logoR2Key: "" }, "HOUZS");
  const [{ jsPDF }, autoTableModule, { renderPayslipInto }] = await Promise.all([import("jspdf"), import("jspdf-autotable"), import("./payslipPdf")]);
  const doc = new jsPDF({ unit: "mm", format: "a4", orientation: "portrait" });
  const texts: string[] = [];
  const original = doc.text.bind(doc);
  vi.spyOn(doc, "text").mockImplementation(((...args: Parameters<typeof doc.text>) => {
    const v = args[0];
    for (const t of Array.isArray(v) ? v : [v]) texts.push(String(t).trim());
    return original(...args);
  }) as typeof doc.text);
  await renderPayslipInto(doc, autoTableModule.default as unknown as (d: JsPdf, o: Record<string, unknown>) => void, { ...SLIP, ...over });
  return texts;
}

describe("payslip PDF", () => {
  test("title, month, employee and payment", async () => {
    const t = (await render()).join("\n");
    expect(t).toContain("PAYSLIP");
    expect(t).toContain("September 2026");
    expect(t).toContain("AHMAD BIN ALI");
    expect(t).toContain("Maybank");
  });

  test("earnings and deductions reconcile to net, penalty included", async () => {
    const t = (await render()).join("\n");
    expect(t).toMatch(/Less absence: 2 day\(s\)/);
    expect(t).toMatch(/Less late \/ short hours: 1\.5 h/);
    expect(t).toContain("Penalty");
    expect(t).toMatch(/Salary advance/);
    expect(t).toContain("NET PAY");
    expect(t).toContain("RM 1,440.11");
  });

  test("an unknown PCB prints -- and its reason, never RM 0.00", async () => {
    const lines = await render();
    const pcbIndex = lines.findIndex((l) => l === "PCB (income tax)");
    expect(pcbIndex).toBeGreaterThan(-1);
    expect(lines[pcbIndex + 1]).toBe("--");
    expect(lines.join("\n")).toContain("PCB not computed: tax residency missing.");
  });

  test("trip pay prints commission as base x rate and each allowance with its count; backpay is a deduction", async () => {
    const t = (
      await render({
        commissionSen: 66010,
        tripAllowanceSen: 70000,
        allowancesSen: 20000,
        backpaySen: 15000,
        detail: {
          ...SLIP.detail,
          paidLeaveDates: ["2026-09-15"],
          allowances: [
            { kind: "LEADERSHIP", label: "Leadership allowance", amountSen: 20000, note: null },
            { kind: "BACKPAY", label: "Backpay (company advance)", amountSen: 15000, note: null },
          ],
          trip: {
            commission: { lines: [{ crew: 3, baseSen: 16502600, rateBps: 30, amountSen: 49508 }], baseSen: 16502600, missedDays: 2, cutBps: 10, amountSen: 49508 },
            lines: [
              { key: "FAIR", label: "Fair", count: 4, unitSen: 10000, amountSen: 40000, dates: [] },
              { key: "OUT_JP", label: "Outstation (Johor, Penang)", count: 2, unitSen: 8000, amountSen: 16000, dates: [] },
            ],
          },
        },
      })
    ).join("\n");
    expect(t).toContain("Commission: RM 165,026.00 x 0.30%");
    expect(t).toContain("Fair x 4");
    expect(t).toContain("Outstation (Johor, Penang) x 2");
    expect(t).toContain("Leadership allowance");
    expect(t).toContain("Backpay (company advance)");
    expect(t).toMatch(/Trip pay counts the jobs from 2026\/08\/23 to 2026\/09\/22\. Commission rate cut 0\.10% for 2 day\(s\)/);
    expect(t).toContain("Paid leave: 2026/09/15.");
  });

  test("a draft carries the ESTIMATE watermark; an approved slip does not", async () => {
    expect(await render({ status: "DRAFT" })).toContain("ESTIMATE");
    expect(await render()).not.toContain("ESTIMATE");
  });
});
