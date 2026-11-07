import { describe, expect, it } from "vitest";
import { workByDay, type LorryWorkRow } from "./LogisticLorryDrawer";

const row = (key: string, date: string, type: string): LorryWorkRow => ({ key, date, type, ref: key, customer: "A", region: "Northern", amountSen: 0, onOpen: null });

describe("what a lorry did", () => {
  it("runs newest day first", () => {
    expect(workByDay([row("a", "2026-11-02", "Delivery"), row("b", "2026-11-05", "Setup")]).map((d) => d.date)).toEqual(["2026-11-05", "2026-11-02"]);
  });
  it("puts deliveries first inside a day, then the other job types", () => {
    const [day] = workByDay([row("a", "2026-11-02", "Transfer"), row("b", "2026-11-02", "Delivery"), row("c", "2026-11-02", "Dismantle")]);
    expect(day.rows.map((r) => r.type)).toEqual(["Delivery", "Dismantle", "Transfer"]);
  });
});
