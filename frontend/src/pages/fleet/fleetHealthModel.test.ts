import { describe, expect, it } from "vitest";
import { attentionScore, lorryBox, offRoadRows, uploadEach } from "./fleetHealthModel";

describe("lorryBox", () => {
  it("draws the container only when all three sides are entered", () => {
    expect(lorryBox({ lengthFt: 17, widthFt: 7, heightFt: 7.5 })).toEqual({ length: 17, width: 7, height: 7.5 });
    expect(lorryBox({ lengthFt: 17, widthFt: 7, heightFt: null })).toBeNull();
    expect(lorryBox({ lengthFt: 0, widthFt: 7, heightFt: 7 })).toBeNull();
    expect(lorryBox({})).toBeNull();
  });
});

describe("offRoadRows", () => {
  const today = "2026-11-07";
  it("marks each window as now, planned or ended, newest first, with its days", () => {
    const rows = offRoadRows([
      { from: "2026-10-01", to: "2026-10-03", reason: "Gearbox" },
      { from: "2026-11-06", to: "2026-11-08T00:00:00Z", reason: "Service" },
      { from: "2026-11-20", to: "2026-11-20", reason: null },
    ], today);
    expect(rows.map((r) => [r.from, r.state, r.days])).toEqual([
      ["2026-11-20", "planned", 1],
      ["2026-11-06", "now", 3],
      ["2026-10-01", "ended", 3],
    ]);
  });
  it("a window with no dates is not given a length", () => {
    expect(offRoadRows([{ from: null, to: null, reason: "x" }], today)[0]).toMatchObject({ state: "now", days: null });
  });
  it("a window with no expected return is off now, with no end and no length", () => {
    expect(offRoadRows([{ from: "2026-11-05", to: "9999-12-31", reason: "Accident" }], today)[0]).toMatchObject({ to: null, state: "now", days: null });
  });
});

describe("attentionScore", () => {
  it("adds hours down, a day per overdue service and half a day per open work order", () => {
    expect(attentionScore({ downtimeHours: 5, plansOverdue: 1, openWorkOrders: 2 })).toBe(5 + 24 + 24);
    expect(attentionScore({ plansOverdue: 0 })).toBe(0);
  });
});

describe("uploadEach", () => {
  it("stops at the first failure and hands back that file and the rest", async () => {
    const sent: string[] = [];
    const r = await uploadEach(["a", "b", "c"], async (f) => { if (f === "b") throw new Error("too big"); sent.push(f); });
    expect(sent).toEqual(["a"]);
    expect(r.left).toEqual(["b", "c"]);
    expect((r.error as Error).message).toBe("too big");
  });
  it("returns nothing left when every file went up", async () => {
    expect(await uploadEach([1, 2], async () => undefined)).toEqual({ left: [], error: null });
  });
});
