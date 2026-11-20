import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { reopenedLegSets } from "../src/scm/shared/assr-leg-reopen";

/* HC-0246 follow-up: a cancelled leg came back only when re-dated from Delivery
   Planning. Changing the date on the case itself (or the delivery sheet writing a
   scheduled date) left the cancel stamp, so the job stayed hidden on the board. */
describe("a new date on a cancelled Service Case leg books it again, from any writer", () => {
  test("a new requested or confirmed date clears that leg's stamp only", () => {
    expect(reopenedLegSets({ customer_pickup_at: "2026-11-10" }, { customer_pickup_at: "2026-11-20" })).toEqual(["pickup_cancelled_at = NULL"]);
    expect(reopenedLegSets(null, { do_date: "2026-11-20" })).toEqual(["delivery_cancelled_at = NULL"]);
    expect(reopenedLegSets({ sched_inspection_date: null }, { sched_inspection_date: "2026-11-20" })).toEqual(["inspection_cancelled_at = NULL"]);
  });

  test("emptying a date, re-saving the same date, or editing another field leaves the stamp", () => {
    expect(reopenedLegSets({ customer_pickup_at: "2026-11-10" }, { customer_pickup_at: null })).toEqual([]);
    expect(reopenedLegSets({ customer_pickup_at: "2026-11-10" }, { customer_pickup_at: "" })).toEqual([]);
    expect(reopenedLegSets({ do_date: "2026-11-10" }, { do_date: "2026-11-10T00:00:00Z" })).toEqual([]);
    expect(reopenedLegSets({ do_date: "2026-11-10" }, { action_remark: "called customer" })).toEqual([]);
  });

  test("two dates of one leg in one write clear it once", () => {
    expect(reopenedLegSets({}, { customer_pickup_at: "2026-11-20", sched_pickup_date: "2026-11-21" })).toEqual(["pickup_cancelled_at = NULL"]);
  });

  test("the case edit and the delivery-sheet write-back both apply the rule", () => {
    expect(readFileSync(new URL("../src/services/assr.ts", import.meta.url), "utf8")).toContain("sets.push(...reopenedLegSets(beforeSnapshot, body))");
    expect(readFileSync(new URL("../src/routes/assrFormIntake.ts", import.meta.url), "utf8")).toContain("reopenedLegSets({ [col]: row.cur }, { [col]: date })");
  });
});
