import { describe, expect, it } from "vitest";
import { watchItems, type WatchInputs } from "./ManagementWatch";

const none: WatchInputs = { logistic: null, procurement: null, service: null, projectGaps: null };

describe("management watchlist", () => {
  it("lists nothing for a viewer who can read no module", () => {
    expect(watchItems(none)).toEqual([]);
  });

  it("puts urgent items first and skips a check that found nothing", () => {
    const items = watchItems({
      ...none,
      logistic: { doNotClosed: { count: 3, amountSen: 100_00, over30: 0 }, doNoCost: { count: 0, amountSen: 0 }, deliveredOwingOver30: { count: 2, balanceSen: 500_00, oldestDays: 40 } },
      service: { active_count: 10, breach_count: 0 },
    });
    expect(items.map((i) => [i.level, i.title])).toEqual([
      ["bad", "Delivered, still owing after 30 days"],
      ["warn", "Delivery orders loaded but never closed"],
    ]);
  });

  it("names the lead-time categories that are off and their suggested days", () => {
    const [item] = watchItems({
      ...none,
      procurement: { open: { late5Lines: 0, late5Suppliers: 0, worstDaysLate: 0 }, leadByCategory: [{ key: "MATTRESS", current: 40, suggested: 22, verdict: "can_shorten" }, { key: "SOFA", current: 40, suggested: 38, verdict: "ok" }] },
    });
    expect(item?.figure).toBe("MATTRESS 40 → 22 days");
  });
});
