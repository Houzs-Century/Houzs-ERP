/* Owner 2026-11-01: which supplier delays most, as one score with the three ways of judging it alongside. */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SupplierScorecard, scoreSupplier, supplierKey, type ScoreGroup } from "./SupplierScorecard";

const g = (key: string, onTimePct: number | null, avgDaysLate: number | null, receipts: number, sen: number, lateSen: number): ScoreGroup =>
  ({ key, open: { sen, late: lateSen ? 1 : 0, lateSen }, supplierLead: { receipts, onTimePct, avgDaysLate } });

describe("scoreSupplier", () => {
  it("weighs on time 40, how late 20, overdue share 30, quality 10", () => {
    // 80% on time, 5 days late (50), 25% overdue (75), 2 cases per 100 (90)
    const s = scoreSupplier(g("A", 80, 5, 20, 100_00, 25_00), [], 2);
    expect(s.score).toBe(Math.round((40 * 80 + 20 * 50 + 30 * 75 + 10 * 90) / 100));
  });
  it("a part with no data is left out, not counted as zero", () => {
    const s = scoreSupplier(g("A", 100, null, 20, 0, 0), [], null);
    expect(s.score).toBe(100);
  });
  it("RM x days adds each late line's amount times its days late, this supplier only", () => {
    const s = scoreSupplier(g("A", 100, null, 20, 300_00, 300_00), [
      { supplier: "A", openQty: 1, openSen: 100_00, daysLate: 3 },
      { supplier: "A", openQty: 1, openSen: 200_00, daysLate: 0 },
      { supplier: "B", openQty: 1, openSen: 900_00, daysLate: 9 },
    ], null);
    expect(s.senDays).toBe(300_00);
  });
  it("names match across reports whatever the punctuation", () => {
    expect(supplierKey("HOOKKA INDUSTRIES SDN. BHD.")).toBe(supplierKey("Hookka Industries Sdn Bhd"));
  });
});

describe("SupplierScorecard", () => {
  it("lists worst first and a click picks the supplier", () => {
    const onPick = vi.fn();
    render(<SupplierScorecard groups={[g("GOOD", 100, null, 20, 100, 0), g("BAD", 20, 9, 20, 100, 90)]} lines={[]} quality={null} onPick={onPick} />);
    const first = document.querySelector("tbody tr td") as HTMLElement;
    expect(first.textContent).toBe("BAD");
    fireEvent.click(screen.getByText("BAD"));
    expect(onPick).toHaveBeenCalledWith("BAD");
  });
});
