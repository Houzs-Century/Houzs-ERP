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

  it("names the categories we could order later, and the days", () => {
    const items = watchItems({
      ...none,
      procurement: {
        asOf: "2026-10-17",
        total: { open: { lines: 5, late: 0, lateSen: 0, buckets: { late5: { lines: 0, sen: 0 } } }, due: { sen: 0, openSen: 0 } },
        byCategory: [{ key: "MATTRESS", ordering: { canOrderLaterDays: 8 } }, { key: "SOFA", ordering: { canOrderLaterDays: 1 } }],
        deadStock: { deadSen: 0, deadSkus: 0, totalSen: 0 },
      },
    });
    expect(items.map((i) => i.figure)).toEqual(["MATTRESS 8 days later"]);
  });
});
