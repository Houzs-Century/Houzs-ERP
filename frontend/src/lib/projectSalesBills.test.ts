/* The derivations every surface shares for a project's pasted sales report:
   the red number per attending rep, the words on a bill's row, and a read of
   another shape degrading to empty rather than crashing the page. */
import { describe, expect, test } from "vitest";
import { billStatusLabel, fmtRmSen, normalizeProjectSalesBills, notOpenedByRepId, type PersonSummary } from "./projectSalesBills";

const person = (over: Partial<PersonSummary>): PersonSummary => ({
  key: "rep:1", name: "Jason Lee", sales_rep_id: 1, rep_user_id: 101, count: 2, amount_sen: 1_000_00,
  opened_count: 1, opened_sen: 400_00, not_opened_count: 1, not_opened_sen: 600_00, other_event_count: 0, ...over,
});

describe("notOpenedByRepId", () => {
  test("one red number per attending rep; nothing for a rep with everything opened or a name the list does not carry", () => {
    const m = notOpenedByRepId([
      person({}),
      person({ key: "rep:2", sales_rep_id: 2, not_opened_sen: 0 }),
      person({ key: "name:adrian", name: "Adrian", sales_rep_id: null, not_opened_sen: 120_00 }),
    ]);
    expect([...m.entries()]).toEqual([[1, 600_00]]);
  });
});

describe("billStatusLabel", () => {
  const base = { so_doc_no: "HC-SO-1", so_status: "CONFIRMED", so_project_id: 344, so_salesperson_id: null, so_amount_sen: 100, other_event: false, unlinked: false };
  test("not opened is red; opened under another event or with no event is amber; opened is green", () => {
    expect(billStatusLabel({ ...base, status: "not_opened" })).toEqual({ text: "Not opened", tone: "red" });
    expect(billStatusLabel({ ...base, status: "opened", other_event: true })).toEqual({ text: "Opened under another event", tone: "amber" });
    expect(billStatusLabel({ ...base, status: "opened", unlinked: true, so_project_id: null })).toEqual({ text: "Opened, no event on the order", tone: "amber" });
    expect(billStatusLabel({ ...base, status: "opened" })).toEqual({ text: "Opened", tone: "green" });
  });
});

describe("normalizeProjectSalesBills", () => {
  test("passes a well-formed read through and empties any other shape", () => {
    const full = { bills: [], persons: [person({})], totals: { count: 1, amount_sen: 2, opened_count: 3, opened_sen: 4, not_opened_count: 5, not_opened_sen: 6, other_event_count: 7 }, saved_activity_ids: [9, "10"], can_save: true };
    const r = normalizeProjectSalesBills(full);
    expect(r.persons).toHaveLength(1);
    expect(r.totals.other_event_count).toBe(7);
    expect(r.saved_activity_ids).toEqual([9, 10]);
    expect(r.can_save).toBe(true);
    for (const raw of [{ data: [] }, null, "x", 1]) {
      const e = normalizeProjectSalesBills(raw);
      expect(e.bills).toEqual([]);
      expect(e.totals.count).toBe(0);
      expect(e.can_save).toBe(false);
    }
  });
});

describe("fmtRmSen", () => {
  test("sen to ringgit, dashes when unknown", () => {
    expect(fmtRmSen(1149900)).toBe("RM 11,499.00");
    expect(fmtRmSen(null)).toBe("—");
  });
});
