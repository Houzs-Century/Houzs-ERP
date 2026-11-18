// The nightly Trip Pay read: which days it touches (yesterday, plus older days
// whose source changed or whose stops differ) and what it writes (new stops in,
// changed stops updated, HR's edits and removals kept, gone stops flagged).
import { describe, expect, test } from "vitest";
import type { SourceRow } from "./hr-trip-store";
import { nightlyMonths, planSync, selectSyncDays, type StoredRow } from "./hr-trip-sync";

const src = (ref: string, date: string, o: Partial<SourceRow> = {}): SourceRow => ({
  source: "PLANNING",
  source_ref: ref,
  trip_date: date,
  doc_no: "SO-1",
  transfer_to: "",
  ref_no: "",
  kind: "DO",
  job_type: "DELIVERY_ORDER",
  event_type: null,
  local_total_sen: 100000,
  state: "Selangor",
  postcode: "",
  lorry_plate: "VPC 1",
  trip_ref: "t1",
  venue_key: "",
  driver_1_name: "AMIR",
  driver_2_name: "",
  helper_1_name: "",
  helper_2_name: "",
  driver_1_employee_id: 1,
  driver_2_employee_id: null,
  helper_1_employee_id: null,
  helper_2_employee_id: null,
  ...o,
});
let nextId = 1;
const stored = (s: SourceRow, o: Partial<StoredRow> = {}): StoredRow => ({
  ...s,
  id: nextId++,
  source: "PLANNING",
  hr_edited: false,
  created_at: "2026-11-01T00:00:00Z",
  updated_at: "2026-11-01T00:00:00Z",
  source_missing_at: null,
  removed_at: null,
  ...o,
});

describe("selectSyncDays", () => {
  const month = { first: "2026-10-23", last: "2026-11-22", yesterday: "2026-11-16" };

  test("only yesterday when nothing older changed and every stop is already a row", () => {
    const s = [src("a", "2026-11-10")];
    expect([...selectSyncDays({ ...month, changed: new Set(), stored: s, source: s })]).toEqual(["2026-11-16"]);
  });

  test("an older day whose source changed, or whose stops differ from the rows, is re-read; today and later never", () => {
    const days = selectSyncDays({
      ...month,
      changed: new Set(["2026-11-03", "2026-11-17"]),
      stored: [src("a", "2026-11-10")],
      source: [src("a", "2026-11-10"), src("b", "2026-11-12"), src("c", "2026-11-18")],
    });
    expect([...days].sort()).toEqual(["2026-11-03", "2026-11-12", "2026-11-16"]);
  });

  test("no watermark yet: every day up to yesterday", () => {
    expect(selectSyncDays({ ...month, changed: "all", stored: [], source: [] }).size).toBe(25);
  });

  test("a month already over: no yesterday, only what changed", () => {
    expect([...selectSyncDays({ first: "2026-09-23", last: "2026-10-22", yesterday: "2026-11-16", changed: new Set(["2026-10-01"]), stored: [], source: [] })]).toEqual(["2026-10-01"]);
  });

  test("the open months: yesterday's and the one before", () => {
    expect(nightlyMonths("2026-11-16")).toEqual(["2026-10", "2026-11"]);
    expect(nightlyMonths("2026-12-28")).toEqual(["2026-12", "2027-01"]);
  });
});

describe("planSync", () => {
  test("a new stop is added, a changed one updated, an unchanged one left", () => {
    const same = src("a", "2026-11-16");
    const was = src("b", "2026-11-16");
    const plan = planSync([stored(same), stored(was)], [same, { ...was, local_total_sen: 250000 }, src("c", "2026-11-16")], new Set(["2026-11-16"]));
    expect(plan.inserts.map((r) => r.source_ref)).toEqual(["c"]);
    expect(plan.updates.map((u) => u.row.local_total_sen)).toEqual([250000]);
    expect(plan.flag).toEqual([]);
  });

  test("a row HR edited or removed is never rewritten", () => {
    const s = src("a", "2026-11-16");
    const edited = stored(s, { hr_edited: true, driver_1_name: "ALI" });
    const removed = stored(src("b", "2026-11-16"), { removed_at: "2026-11-10T00:00:00Z", local_total_sen: 1 });
    const plan = planSync([edited, removed], [{ ...s, local_total_sen: 9 }, src("b", "2026-11-16")], null);
    expect(plan).toEqual({ inserts: [], updates: [], flag: [], unflag: [] });
  });

  test("a row whose stop was cancelled or deleted is flagged, not removed; it is unflagged when the stop is back", () => {
    const gone = stored(src("a", "2026-11-16"));
    expect(planSync([gone], [], null).flag).toEqual([gone.id]);
    const back = stored(src("b", "2026-11-16"), { source_missing_at: "2026-11-15T00:00:00Z" });
    expect(planSync([back], [src("b", "2026-11-16")], null).unflag).toEqual([back.id]);
  });

  test("days outside the selection are not touched, pasted and hand-added rows never", () => {
    const old = stored(src("a", "2026-11-01"));
    const manual = stored(src("m", "2026-11-16"), { source: "MANUAL" });
    const plan = planSync([old, manual], [{ ...src("a", "2026-11-01"), state: "Johor" }], new Set(["2026-11-16"]));
    expect(plan).toEqual({ inserts: [], updates: [], flag: [], unflag: [] });
  });
});

describe("syncTripMonth", () => {
  test("a month whose payroll is approved is never read or written", async () => {
    const touched: string[] = [];
    const chain = { from: () => chain, where: () => chain, limit: async () => [{ id: 1 }] };
    const db = {
      select: () => chain,
      insert: () => touched.push("insert"),
      update: () => touched.push("update"),
      delete: () => touched.push("delete"),
      execute: () => touched.push("execute"),
    };
    const { syncTripMonth } = await import("./hr-trip-sync");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a stub standing in for the Drizzle client
    const r = await syncTripMonth(db as any, 1, "2026-10", { mode: "nightly", yesterday: "2026-11-16", since: null, by: null });
    expect(r).toMatchObject({ skipped: "locked", added: 0, updated: 0, flagged: 0 });
    expect(touched).toEqual([]);
  });
});

describe("nightly change detection", () => {
  test("a day whose delivery order or its crew changed is re-read", async () => {
    const seen: string[] = [];
    const db = {
      execute: async (q: { queryChunks: unknown[] }) => {
        seen.push(q.queryChunks.map((c) => (c && typeof c === "object" && "value" in c ? String((c as { value: unknown }).value) : "")).join(" "));
        return [{ d: "2026-11-17" }];
      },
    };
    const { changedSourceDays } = await import("./hr-trip-store");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a stub standing in for the Drizzle client
    const days = await changedSourceDays(db as any, 1, "2026-10-23", "2026-11-22", "2026-11-17T16:05:00Z");
    expect([...days]).toEqual(["2026-11-17"]);
    expect(seen[0]).toMatch(/JOIN scm\.delivery_orders d ON d\.id = r\.id\s+LEFT JOIN scm\.delivery_order_crew cr ON cr\.do_id = d\.id/);
    expect(seen[0]).toMatch(/d\.updated_at > /);
    // Keyed on the run date's candidates (doRunDate picks one), not the DO date alone.
    expect(seen[0]).toMatch(/VALUES \(r\.so_due_date\), \(r\.delivered_day\), \(r\.do_date\)/);
  });
});
