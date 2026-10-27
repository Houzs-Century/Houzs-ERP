import { describe, expect, test } from "vitest";
import { orderEvents } from "./PosEventsTab";

describe("Events tab order", () => {
  test("on-going fairs first, then coming ones soonest first, then done ones latest first", () => {
    const rows = orderEvents([
      { name: "done old", status: "DONE" as const, start_date: "2026-01-02" },
      { name: "coming far", status: "COMING" as const, start_date: "2026-12-01" },
      { name: "done recent", status: "DONE" as const, start_date: "2026-10-02" },
      { name: "on going", status: "ON GOING" as const, start_date: "2026-10-20" },
      { name: "coming soon", status: "COMING" as const, start_date: "2026-11-01" },
    ]);
    expect(rows.map((r) => r.name)).toEqual(["on going", "coming soon", "coming far", "done recent", "done old"]);
  });
});
