/* docs/bugs/0916 — which cleared AutoCount Sync documents have since reached
 * AutoCount and go back on the list, and which a clear must refuse. Shapes are
 * the production rows of 2026-09-15. */
import { describe, expect, test } from "vitest";
import { HELD, clearVerdict, planClearedArrivals } from "../scripts/lib/cleared-arrived-plan.mjs";

let n = 0;
const row = (over) => ({
  id: `r${(n += 1)}`, doc_type: "SO", doc_no: "HC-SO-000814", status: "sent", error_head: "",
  created_at: "2026-09-10T00:00:00.000Z", archived_at: null, archived_by: null, ...over,
});
const CLEARED = "2026-09-10 14:06:00+00";

describe("planClearedArrivals", () => {
  test("HC-SO-000814: a script cleared its refusal, a later live edit arrived — back on the list", () => {
    const refusal = row({ status: "failed", created_at: "2026-09-10T09:27:00.000Z", archived_at: CLEARED });
    const { restore, held } = planClearedArrivals([refusal, row({ created_at: "2026-09-14T15:23:00.000Z" })], new Map());
    expect(held).toEqual([]);
    expect(restore).toEqual([{ docType: "SO", docNo: "HC-SO-000814", rowIds: [refusal.id], refile: [] }]);
  });

  test("HC-DO-2609-028: a refusal filed under the delivery order's id is re-filed under its number and restored", () => {
    const uuid = "21924489-8e6d-4ff2-843b-bb33c92bc284";
    const refusal = row({ doc_type: "DO", doc_no: uuid, status: "skipped", created_at: "2026-09-10T04:40:00.000Z", archived_at: CLEARED });
    const arrival = row({ doc_type: "DO", doc_no: "HC-DO-2609-028", created_at: "2026-09-14T15:30:00.000Z" });
    const { restore } = planClearedArrivals([refusal, arrival], new Map([[`DO|${uuid}`, "HC-DO-2609-028"]]));
    expect(restore).toEqual([{ docType: "DO", docNo: "HC-DO-2609-028", rowIds: [refusal.id], refile: [{ id: refusal.id, from: uuid, to: "HC-DO-2609-028" }] }]);
  });

  test("HC-GRN-2609-008: refused three minutes after it last arrived — stays cleared", () => {
    const rows = [
      row({ doc_type: "GR", doc_no: "HC-GRN-2609-008", created_at: "2026-09-10T06:48:00.000Z", archived_at: CLEARED }),
      row({ doc_type: "GR", doc_no: "HC-GRN-2609-008", status: "skipped", created_at: "2026-09-10T06:51:00.000Z", archived_at: CLEARED }),
    ];
    const { restore, held } = planClearedArrivals(rows, new Map());
    expect(restore).toEqual([]);
    expect(held).toEqual([{ docType: "GR", docNo: "HC-GRN-2609-008", reason: HELD.refusedSince }]);
  });

  test("a document a person cleared on the page is left alone, even though it arrived", () => {
    const { restore, held } = planClearedArrivals([row({ doc_no: "HC-SO-013361", archived_at: "2026-09-08 07:33:00+00", archived_by: 7 })], new Map());
    expect(restore).toEqual([]);
    expect(held[0].reason).toBe(HELD.person);
  });

  test("a waiting send, a document that never arrived, and an id no document carries stay cleared", () => {
    const { restore, held } = planClearedArrivals([
      row({ doc_no: "HC-SO-A", status: "pending", archived_at: CLEARED }),
      row({ doc_no: "HC-SO-B", status: "skipped", archived_at: CLEARED }),
      row({ doc_type: "PO", doc_no: "044f73de-c197-4e0d-a3f3-27fa0ab77724", status: "skipped", archived_at: CLEARED }),
    ], new Map());
    expect(restore).toEqual([]);
    expect(held.map((h) => h.reason).sort()).toEqual([HELD.neverArrived, HELD.sending, HELD.unresolvedId].sort());
  });

  test("a re-queued refusal newer than the arrival is history, as on the page", () => {
    const rows = [
      row({ created_at: "2026-09-10T06:03:00.000Z", archived_at: CLEARED }),
      row({ status: "failed", error_head: "[re-queued 2026-09-10T14:32", created_at: "2026-09-10T09:29:00.000Z", archived_at: CLEARED }),
    ];
    expect(planClearedArrivals(rows, new Map()).restore).toHaveLength(1);
  });
});

describe("clearVerdict", () => {
  test("a finished document may be cleared; an open refusal or a waiting send may not", () => {
    expect(clearVerdict([row({ status: "failed", created_at: "2026-09-10T01:00:00.000Z" }), row({ created_at: "2026-09-10T02:00:00.000Z" })])).toBeNull();
    expect(clearVerdict([row({ created_at: "2026-09-10T01:00:00.000Z" }), row({ status: "skipped", created_at: "2026-09-10T02:00:00.000Z" })])).toMatch(/refusal/);
    expect(clearVerdict([row({ status: "pending" })])).toBe(HELD.sending);
    expect(clearVerdict([])).toBe("no rows");
  });
});
