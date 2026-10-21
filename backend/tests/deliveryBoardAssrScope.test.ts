import { describe, expect, test } from "vitest";
import { assrBoardUnionSql, assrOpenCaseGuardSql } from "../src/scm/lib/assr-board-scope";
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
      expect(assrOpenCaseGuardSql(ctx(allowed))).toContain(assrCompanySql(ctx(allowed)));
    }
  });

  test("the guard keeps its original open/exists conditions", () => {
    const sql = assrOpenCaseGuardSql(ctx([1]));
    expect(sql).toContain("id = ?");
    expect(sql).toContain("closed_at IS NULL");
    expect(sql).toContain("archived_at IS NULL");
  });

  test("unresolved company context does not blank the guard", () => {
    // A single-company install (or a cold start) must still be able to schedule.
    expect(assrOpenCaseGuardSql(ctx(undefined))).not.toContain("1=0");
  });
});
