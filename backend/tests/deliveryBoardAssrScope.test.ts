import { describe, expect, test } from "vitest";
import { assrBoardUnionSql, assrLegGuardSql, assrBoardLegs, assrLegOpen } from "../src/scm/lib/assr-board-scope";
import { assrCompanySql } from "../src/routes/assr";

/* THE DELIVERY PLANNING BOARD MUST NOT SHOW ANOTHER COMPANY'S SERVICE CASE.
   Owner ruling 2026-08-21 — 「这个也不可以啊」 — on being shown that the board's
   ASSR union listed cases from companies the caller holds no grant for while
   /api/assr hid those same cases.

   Why these tests exist in this shape. The predicate was missing for months
   because it lived inside a template literal in the middle of a 3,000-line
   request handler, where nothing could assert it and nobody re-read it. Pulling
   the two statements into their own module (scm/lib/assr-board-scope) makes the
   rule checkable without a database, a Worker, or a Hono request.

   What they pin, and what they deliberately do not:
     - The READ (the board union) and the WRITE guard (the schedule endpoint's
       open-case check) BOTH carry the company predicate. Scoping only the read
       would leave the half that consumes a lorry wide open.
     - The predicate is `assrCompanySql` ITSELF, compared by value against the
       helper — not a hand-written " AND company_id IN (...)" string. A literal
       here would be a THIRD copy of the rule, which is precisely the drift that
       made routes/search.ts and /api/assr answer the same rep differently.
     - The three-state sentinel survives: granted-nothing matches nothing,
       unresolved degrades to no predicate (a single-company install must not be
       blanked by a company context that never resolved).

   PROVEN against production 2026-08-21 (run 32467665635): every one of the 72
   board-eligible Service Cases resolves to a real company — `company_id` is
   `bigint NOT NULL` — so this predicate drops rows only from a caller who was
   never granted that company, never from everyone. */

const COMPANIES = [{ id: 1, code: "HOUZS" }, { id: 2, code: "2990" }];
// A fixed recent-closed cutoff (owner 2026-10-21): the board passes `today - 90d`;
// the exact value does not matter to the company-scope assertions below.
const SINCE = "2026-07-01";

/** Minimal context stand-in — the builders need only `.get`. */
function ctx(allowed: number[] | undefined, active?: number) {
  const store: Record<string, unknown> = {
    companies: COMPANIES,
    allowedCompanyIds: allowed,
    companyId: active,
  };
  return { get: (k: string) => store[k] } as never;
}

describe("Delivery Planning board — Service Case rows follow the caller's companies", () => {
  test("a HOUZS-only caller's board union asks only for HOUZS cases", () => {
    const sql = assrBoardUnionSql(ctx([1]), SINCE);
    expect(sql).toContain("FROM assr_cases");
    expect(sql).toContain(assrCompanySql(ctx([1])));
  });

  test("a 2990-only caller's board union asks only for 2990 cases", () => {
    expect(assrBoardUnionSql(ctx([2]), SINCE)).toContain(assrCompanySql(ctx([2])));
  });

  test("a both-company caller still gets the combined queue (widen, not isolate)", () => {
    const sql = assrBoardUnionSql(ctx([1, 2]), SINCE);
    expect(sql).toContain(assrCompanySql(ctx([1, 2])));
    // The whole point of a cross-company view module: a dispatcher granted both
    // sees both. A predicate that pinned the SWITCHER's active company would
    // pass the test above and break this one.
    expect(sql).toContain("1,2");
  });

  test("granted no company matches nothing; unresolved degrades to no predicate", () => {
    expect(assrBoardUnionSql(ctx([]), SINCE)).toContain(" AND 1=0");
    const unresolved = assrBoardUnionSql(ctx(undefined), SINCE);
    expect(unresolved).not.toContain("company_id IN");
    expect(unresolved).not.toContain("1=0");
  });

  test("the union keeps the OPEN-dated arm and ADDS a recent-closed arm", () => {
    // The company predicate must be ADDITIVE — and so must the done-work widening
    // (owner 2026-10-21: the Delivered tab shows every job type). Open dated cases
    // still show; a closed case shows only when a leg is on/after the cutoff, so
    // the whole closed history never floods the board.
    const sql = assrBoardUnionSql(ctx([1]), SINCE);
    expect(sql).toContain("closed_at IS NULL");
    expect(sql).toContain("archived_at IS NULL");
    expect(sql).toContain("customer_pickup_at IS NOT NULL");
    expect(sql).toContain(`>= '${SINCE}'`);
    // closed_at / archived_at are now selected so the row builder can tell a done
    // leg from a pending one.
    expect(sql).toContain("AS closed_at");
    expect(sql).toContain("AS archived_at");
  });
});

describe("Delivery Planning board — scheduling a Service Case is scoped too", () => {
  test("the open-case guard carries the same company predicate as the read", () => {
    for (const allowed of [[1], [2], [1, 2], []]) {
      expect(assrLegGuardSql(ctx(allowed))).toContain(assrCompanySql(ctx(allowed)));
    }
  });

  test("the guard keeps the exists and archived conditions, and no longer the whole-case closed one (HC-0193)", () => {
    const sql = assrLegGuardSql(ctx([1]));
    expect(sql).toContain("id = ?");
    expect(sql).not.toContain("closed_at IS NULL");
    expect(sql).toContain("archived_at IS NULL");
  });

  test("unresolved company context does not blank the guard", () => {
    // A single-company install (or a cold start) must still be able to schedule.
    expect(assrLegGuardSql(ctx(undefined))).not.toContain("1=0");
  });
});

/* A leg Logistics marks Delivered on the board (owner 2026-11-06) carries its own
   actual_* date, so the leg shows DELIVERED while the CASE stays open — closure
   is a separate ASSR-module action and never fires from a board mark. */
const legCase = (o: Partial<Parameters<typeof assrBoardLegs>[0]> = {}) => ({
  stage: null,
  pickup_by: null, pickup_pic: null, customer_pickup_at: null, actual_pickup_at: null, sched_pickup_date: null, pickup_cancelled_at: null,
  inspection_by: null, inspection_visit_at: null, sched_inspection_date: null, actual_inspection_at: null, inspection_cancelled_at: null,
  delivery_by: null, do_date: null, sched_delivery_date: null, actual_delivery_at: null, delivery_cancelled_at: null,
  ...o,
});

describe("Delivery Planning board — a board-marked Delivered leg is DELIVERED with the case still open", () => {
  test("delivery leg: actual_delivery_at makes it DELIVERED even though caseClosed is false", () => {
    const legs = assrBoardLegs(legCase({ delivery_by: "own", do_date: "2026-11-01", actual_delivery_at: "2026-11-06" }), false);
    expect(legs.find((l) => l.jobKind === "delivery")?.state).toBe("DELIVERED");
  });

  test("delivery leg without an actual date is not Delivered: confirmed => PENDING_DELIVERY, request-only => PENDING_SCHEDULE", () => {
    const confirmed = assrBoardLegs(legCase({ delivery_by: "own", sched_delivery_date: "2026-11-10" }), false);
    expect(confirmed.find((l) => l.jobKind === "delivery")?.state).toBe("PENDING_DELIVERY");
    const requested = assrBoardLegs(legCase({ delivery_by: "own", do_date: "2026-11-10" }), false);
    expect(requested.find((l) => l.jobKind === "delivery")?.state).toBe("PENDING_SCHEDULE");
  });

  test("own inspection leg: actual_inspection_at makes it DELIVERED", () => {
    const legs = assrBoardLegs(legCase({ inspection_by: "own", inspection_visit_at: "2026-11-01", actual_inspection_at: "2026-11-06" }), false);
    expect(legs.find((l) => l.jobKind === "inspection")?.state).toBe("DELIVERED");
  });

  test("a CANCELLED leg is dropped from the board entirely (owner 2026-11-06)", () => {
    // Delivery leg cancelled → no delivery row at all, even though it has a date.
    const cancelled = assrBoardLegs(legCase({ delivery_by: "own", do_date: "2026-11-10", delivery_cancelled_at: "2026-11-06" }), false);
    expect(cancelled.find((l) => l.jobKind === "delivery")).toBeUndefined();
    // The pickup leg of the SAME case is unaffected — cancel is leg-only.
    const mixed = assrBoardLegs(legCase({
      pickup_by: "customer", customer_pickup_at: "2026-11-08",
      delivery_by: "own", do_date: "2026-11-10", delivery_cancelled_at: "2026-11-06",
    }), false);
    expect(mixed.find((l) => l.jobKind === "customer_pickup")).toBeDefined();
    expect(mixed.find((l) => l.jobKind === "delivery")).toBeUndefined();
  });

  test("the union selects the per-leg actual + cancelled columns the row builder reads", () => {
    const sql = assrBoardUnionSql(ctx([1]), SINCE);
    expect(sql).toContain("actual_inspection_at");
    expect(sql).toContain("actual_delivery_at");
    expect(sql).toContain("pickup_cancelled_at");
    expect(sql).toContain("delivery_cancelled_at");
  });
});

/* Regression (owner 2026-11-10): a case can reach Pending Delivery/Service (e.g. a
   delivery was booked for items taken back) while a NEW inspection is scheduled for
   the future. The board used to call that inspection done purely from the stage, so
   it showed Delivered AND the leg could not be given a driver (the write 404'd).
   An inspection scheduled today-or-later with no actual visit must stay a live,
   writable PENDING leg. A past-dated / already-visited inspection stays done. */
describe("Delivery Planning board — an upcoming inspection past the inspection stage is not Delivered/locked", () => {
  const TODAY = "2026-11-10";
  const pds = { stage: "pending_delivery_service", inspection_by: "own" as const };

  test("future inspection date at pending_delivery_service stays a PENDING leg", () => {
    const legs = assrBoardLegs(legCase({ ...pds, sched_inspection_date: "2026-11-11" }), false, TODAY);
    expect(legs.find((l) => l.jobKind === "inspection")?.state).toBe("PENDING_DELIVERY");
  });

  test("a PAST inspection date at the same stage is still DELIVERED (no regression)", () => {
    const legs = assrBoardLegs(legCase({ ...pds, sched_inspection_date: "2026-11-01" }), false, TODAY);
    expect(legs.find((l) => l.jobKind === "inspection")?.state).toBe("DELIVERED");
  });

  test("without a board date the legacy stage-only behaviour holds (still DELIVERED)", () => {
    const legs = assrBoardLegs(legCase({ ...pds, sched_inspection_date: "2026-11-11" }), false);
    expect(legs.find((l) => l.jobKind === "inspection")?.state).toBe("DELIVERED");
  });

  test("assrLegOpen: an upcoming inspection is writable; a past / done / dateless one is locked", () => {
    const base = { stage: "pending_delivery_service", actual_pickup_at: null, closed_at: null, status: "In Progress" };
    // Scheduled for tomorrow, no actual visit → writable (the fix).
    expect(assrLegOpen({ ...base, sched_inspection_date: "2026-11-11", actual_inspection_at: null }, "inspection", TODAY)).toBe(true);
    // Scheduled in the past, no actual stamp → done by stage, locked.
    expect(assrLegOpen({ ...base, sched_inspection_date: "2026-11-01", actual_inspection_at: null }, "inspection", TODAY)).toBe(false);
    // Already visited → locked even if a stale future date lingers.
    expect(assrLegOpen({ ...base, sched_inspection_date: "2026-11-11", actual_inspection_at: "2026-11-09" }, "inspection", TODAY)).toBe(false);
    // No board date (legacy caller) → stage-only lock.
    expect(assrLegOpen({ ...base, sched_inspection_date: "2026-11-11", actual_inspection_at: null }, "inspection")).toBe(false);
  });
});
