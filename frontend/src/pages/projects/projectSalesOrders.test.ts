/* The one arithmetic the project page does on its sales orders: the lump-sum
 * Total Sales against what was actually opened in the SO module. Pinned so
 * desktop and mobile keep reading the same gap — and so a read that is not
 * the expected shape degrades to an empty one instead of crashing the page. */
import { describe, expect, test } from "vitest";

import { normalizeProjectSalesOrders, soStatusLabel, summarizeProjectSalesOrders } from "./projectSalesOrders";

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

describe("normalizeProjectSalesOrders", () => {
  test("passes a well-formed read through", () => {
    const row = { doc_no: "HC-SO-1", status: "CONFIRMED", amount_sen: 100, paid_sen: 0, balance_sen: 100 };
    const r = normalizeProjectSalesOrders({ data: [row], totals: totals(), scoped: true });
    expect(r.data).toEqual([row]);
    expect(r.totals).toEqual(totals());
    expect(r.scoped).toBe(true);
  });

  test("a read of another shape — a stub's { data: [] }, null, a string — becomes an empty, unscoped read", () => {
    for (const raw of [{ data: [] }, null, undefined, "nope", 42, { totals: { count: "3" } }]) {
      const r = normalizeProjectSalesOrders(raw);
      expect(r.data).toEqual([]);
      expect(r.totals).toEqual({ count: 0, draft_count: 0, amount_sen: 0, paid_sen: 0, balance_sen: 0 });
      expect(r.scoped).toBe(false);
    }
  });
});

describe("soStatusLabel", () => {
  test("spells the statuses the way the SO list does — the confirm rung reads Submitted", () => {
    expect(soStatusLabel("CONFIRMED")).toBe("Submitted");
    expect(soStatusLabel("in_production")).toBe("In Production");
    expect(soStatusLabel("DRAFT")).toBe("Draft");
  });
  test("opens up an unknown key rather than showing it raw, and dashes a blank", () => {
    expect(soStatusLabel("SOME_NEW_STATE")).toBe("Some New State");
    expect(soStatusLabel(null)).toBe("—");
    expect(soStatusLabel("  ")).toBe("—");
  });
});
