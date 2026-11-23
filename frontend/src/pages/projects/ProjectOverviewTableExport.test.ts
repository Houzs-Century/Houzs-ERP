/* The period exports as two columns — Start date and End date, each ISO — not
   one date (owner 2026-11-23: export 的 date 要 start 和 end，excel 只剩一个). */
import { describe, expect, it } from "vitest";
import { PROJECT_COLUMNS, type OverviewRow } from "./ProjectOverviewTable";

const col = (key: string) => PROJECT_COLUMNS.find((c) => c.key === key)!;
const startExport = col("dates").exportValue!;
const endExport = col("endDate").exportValue!;
const row = (startDate: string | null, endDate: string | null): OverviewRow =>
  ({ p: { startDate, endDate } } as unknown as OverviewRow);

describe("Project Overview — date export", () => {
  it("exports start and end as two ISO columns", () => {
    const r = row("2026-11-06", "2026-11-09");
    expect(startExport(r)).toBe("2026-11-06");
    expect(endExport(r)).toBe("2026-11-09");
  });

  it("labels the two columns Start date and End date", () => {
    expect(col("dates").exportLabel).toBe("Start date");
    expect(col("endDate").exportLabel).toBe("End date");
  });

  it("exports empty cells when a date is missing", () => {
    const r = row(null, null);
    expect(startExport(r)).toBe("");
    expect(endExport(r)).toBe("");
  });
});
