import { describe, expect, it } from "vitest";
import { drillGroups } from "./DrillDrawer";

describe("drill rows under a heading", () => {
  it("puts rows under their day, days in order", () => {
    const rows = [{ d: "2026-11-09", n: 1 }, { d: "2026-11-08", n: 2 }, { d: "2026-11-09", n: 3 }];
    expect(drillGroups(rows, (r) => r.d).map((g) => [g.key, g.rows.map((r) => r.n)])).toEqual([["2026-11-08", [2]], ["2026-11-09", [1, 3]]]);
  });
  it("keeps one plain list without a heading rule", () => {
    expect(drillGroups([1, 2], null)).toEqual([{ key: null, rows: [1, 2] }]);
  });
});
