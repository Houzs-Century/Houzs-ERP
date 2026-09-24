import { describe, expect, test } from "vitest";
import { facetedFilterValues, type RowRuleColumn } from "./dataTableRows";

/* The funnel value list must NARROW as other filters are applied (owner
   2026-09-23, "越筛越少"): pick Date = 23/9 and the Creditor funnel should list
   only creditors present on 23/9, not every creditor. Before this, options were
   counted over the whole dataset, so the list never shrank. */

type Po = { date: string; creditor: string; status: string };

const rows: Po[] = [
  { date: "23/9", creditor: "DIGLANT", status: "SUBMITTED" },
  { date: "23/9", creditor: "DIGLANT", status: "SUBMITTED" },
  { date: "23/9", creditor: "NICE FUTURE", status: "PARTIAL" },
  { date: "22/9", creditor: "ARMANI", status: "SUBMITTED" },
  { date: "22/9", creditor: "AEROFOAM", status: "CANCELLED" },
];

const columns: RowRuleColumn<Po>[] = [
  { key: "date", getValue: (r) => r.date },
  { key: "creditor", getValue: (r) => r.creditor },
  {
    key: "status",
    getValue: (r) => r.status,
    // A fixed vocabulary — every status stays offered even at 0 rows.
    filterSeedValues: ["SUBMITTED", "PARTIAL", "CANCELLED", "DRAFT"],
  },
];

const col = (key: string) => columns.find((c) => c.key === key)!;
const names = (list: Array<[string, number]>) => list.map(([v]) => v);

describe("facetedFilterValues", () => {
  test("with no other filter active, every value is listed with its full count", () => {
    const v = facetedFilterValues(rows, {}, col("creditor"), columns);
    expect(names(v)).toEqual(["AEROFOAM", "ARMANI", "DIGLANT", "NICE FUTURE"]);
    expect(new Map(v).get("DIGLANT")).toBe(2);
  });

  test("picking Date=23/9 narrows the Creditor list to only creditors on 23/9", () => {
    const v = facetedFilterValues(rows, { date: ["23/9"] }, col("creditor"), columns);
    expect(names(v)).toEqual(["DIGLANT", "NICE FUTURE"]);
    // ARMANI / AEROFOAM (22/9 only) are gone — the point of the fix.
    expect(names(v)).not.toContain("ARMANI");
    expect(names(v)).not.toContain("AEROFOAM");
  });

  test("counts are over the OTHER-filtered rows, not the whole dataset", () => {
    const v = facetedFilterValues(rows, { date: ["23/9"] }, col("creditor"), columns);
    expect(new Map(v).get("DIGLANT")).toBe(2);
    expect(new Map(v).get("NICE FUTURE")).toBe(1);
  });

  test("a column excludes its OWN filter, so its options don't vanish as you tick them", () => {
    // DIGLANT is ticked; the other creditors must still be offered.
    const v = facetedFilterValues(rows, { creditor: ["DIGLANT"] }, col("creditor"), columns);
    expect(names(v)).toEqual(["AEROFOAM", "ARMANI", "DIGLANT", "NICE FUTURE"]);
  });

  test("fixed vocabulary (filterSeedValues) stays listed even when no row matches", () => {
    const v = facetedFilterValues(rows, { date: ["23/9"] }, col("status"), columns);
    // On 23/9 only SUBMITTED + PARTIAL occur, but the seeded set stays offered.
    expect(names(v)).toEqual(["CANCELLED", "DRAFT", "PARTIAL", "SUBMITTED"]);
    expect(new Map(v).get("SUBMITTED")).toBe(2);
    expect(new Map(v).get("DRAFT")).toBe(0);
  });

  test("a currently-ticked value stays listed so it can be un-ticked, even at 0 rows", () => {
    // Creditor ARMANI ticked but Date=23/9 excludes it → keep it visible at 0.
    const v = facetedFilterValues(
      rows,
      { date: ["23/9"], creditor: ["ARMANI"] },
      col("creditor"),
      columns,
    );
    expect(names(v)).toContain("ARMANI");
    expect(new Map(v).get("ARMANI")).toBe(0);
    // and the reachable ones are still there
    expect(names(v)).toContain("DIGLANT");
  });

  test("blank values collapse into the em-dash bucket", () => {
    const withBlank: Po[] = [...rows, { date: "23/9", creditor: "", status: "SUBMITTED" }];
    const v = facetedFilterValues(withBlank, { date: ["23/9"] }, col("creditor"), columns);
    expect(names(v)).toContain("—");
    expect(new Map(v).get("—")).toBe(1);
  });
});

/* DEV-13: a server-filtered column's counts come from the server over every
   matching row, so the Doc Date option said 34 (the loaded page) before a click
   and 42 after. filterCounts replaces the page count; 0-count options drop. */
describe("facetedFilterValues — server counts (filterCounts)", () => {
  test("uses the server's counts, not the loaded page's", () => {
    const serverDate: RowRuleColumn<Po> = { key: "date", getValue: (r) => r.date, filterCounts: [["23/9", 42], ["22/9", 16]] };
    const v = facetedFilterValues(rows, {}, serverDate, columns);
    expect(new Map(v)).toEqual(new Map([["23/9", 42], ["22/9", 16]]));
  });

  test("drops a 0-count server option unless it is ticked", () => {
    const serverCreditor: RowRuleColumn<Po> = { key: "creditor", getValue: (r) => r.creditor, filterCounts: [["DIGLANT", 2], ["ARMANI", 0]] };
    expect(facetedFilterValues(rows, {}, serverCreditor, columns).map(([k]) => k)).toEqual(["DIGLANT"]);
    expect(facetedFilterValues(rows, { creditor: ["ARMANI"] }, serverCreditor, columns).map(([k]) => k)).toEqual(["ARMANI", "DIGLANT"]);
  });
});
