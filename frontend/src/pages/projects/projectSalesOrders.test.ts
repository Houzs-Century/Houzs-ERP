/* The one arithmetic the project page does on its sales orders: the lump-sum
 * Total Sales against what was actually opened in the SO module. Pinned so
 * desktop and mobile keep reading the same gap. */
import { describe, expect, test } from "vitest";

import { soStatusLabel, summarizeProjectSalesOrders } from "./projectSalesOrders";

const totals = (over: Partial<Parameters<typeof summarizeProjectSalesOrders>[0]> = {}) => ({
  count: 3,
  draft_count: 1,
  amount_sen: 8_000_000,
  paid_sen: 3_000_050,
  balance_sen: 4_999_950,
  ...over,
});

describe("summarizeProjectSalesOrders", () => {
  test("converts sen to RM and reports the gap against the final total", () => {
    const s = summarizeProjectSalesOrders(totals(), 113_990);
    expect(s.count).toBe(3);
    expect(s.draftCount).toBe(1);
    expect(s.openedRm).toBe(80_000);
    expect(s.paidRm).toBe(30_000.5);
    expect(s.balanceRm).toBe(49_999.5);
    expect(s.finalTotalRm).toBe(113_990);
    expect(s.notOpenedRm).toBe(33_990);
    expect(s.notOpenedPct).toBe(29.8);
  });

  test("without a final total there is no gap to report", () => {
    const s = summarizeProjectSalesOrders(totals(), null);
    expect(s.finalTotalRm).toBeNull();
    expect(s.notOpenedRm).toBeNull();
    expect(s.notOpenedPct).toBeNull();
    expect(s.openedRm).toBe(80_000);
  });

  test("the gap is signed: orders above the typed total read negative, never clamped", () => {
    const s = summarizeProjectSalesOrders(totals({ amount_sen: 12_000_000 }), 113_990);
    expect(s.notOpenedRm).toBe(-6_010);
    expect(s.notOpenedPct).toBe(-5.3);
  });

  test("a zero final total yields a gap but no percentage", () => {
    const s = summarizeProjectSalesOrders(totals(), 0);
    expect(s.notOpenedRm).toBe(-80_000);
    expect(s.notOpenedPct).toBeNull();
  });

  test("an empty fair is all zeros and the whole final total is still not opened", () => {
    const s = summarizeProjectSalesOrders(totals({ count: 0, draft_count: 0, amount_sen: 0, paid_sen: 0, balance_sen: 0 }), 5_000);
    expect(s.openedRm).toBe(0);
    expect(s.notOpenedRm).toBe(5_000);
    expect(s.notOpenedPct).toBe(100);
  });
});

describe("soStatusLabel", () => {
  test("spells the known statuses the way the SO list does", () => {
    expect(soStatusLabel("CONFIRMED")).toBe("Confirmed");
    expect(soStatusLabel("in_production")).toBe("In production");
    expect(soStatusLabel("SHIPPED")).toBe("Delivered");
  });
  test("opens up an unknown key rather than showing it raw, and dashes a blank", () => {
    expect(soStatusLabel("SOME_NEW_STATE")).toBe("Some new state");
    expect(soStatusLabel(null)).toBe("—");
    expect(soStatusLabel("  ")).toBe("—");
  });
});
