import { describe, expect, test } from "vitest";
import { assrCompanySql, assrCreateCompanyId } from "../src/routes/assr";

/* ASSR (Service Cases) is a cross-company module that scopes to the caller's
   GRANTED companies — no ASSR-specific role pin. Decision trail: 2026-07-16
   ASSR shipped HOUZS-only → 2026-07-19 "Assr 是兩個公司的" (reads widened for
   office/directors) → 2026-07-20 "2990 加 service case": Service Cases now
   follow the caller's user_companies grants like the rest of the SCM portal,
   flipping the old #601/#851 HOUZS-pin that rank-and-file Sales carried. A rep
   granted one company sees ONLY that company; a manager/director granted both
   sees the combined HOUZS+2990 queue. These tests pin that the READ scope IS
   allowedCompanyIds and the CREATE stamp IS the switcher's active company, so a
   future "re-pin ASSR" change cannot silently narrow or widen it. */

const COMPANIES = [{ id: 1, code: "HOUZS" }, { id: 2, code: "2990" }];

/** Minimal Hono-context stand-in. assrCompanySql reads `.get(companies)` +
 *  `.get(allowedCompanyIds)`; assrCreateCompanyId additionally reads the
 *  switcher's `.get(companyId)` (the `active` arg). Role/user is irrelevant to
 *  both now — the whole point of the 2026-07-20 flip. */
function ctx(allowed: number[] | undefined, active?: number) {
  const store: Record<string, unknown> = {
    companies: COMPANIES,
    allowedCompanyIds: allowed,
    companyId: active,
  };
  return { get: (k: string) => store[k] } as never;
}

describe("ASSR read scope follows the caller's granted companies", () => {
  test("a rep granted only HOUZS sees HOUZS", () => {
    expect(assrCompanySql(ctx([1]))).toBe(" AND company_id IN (1)");
  });

  test("a rep granted only 2990 sees 2990 (a future 2990 sales rep)", () => {
    expect(assrCompanySql(ctx([2]))).toBe(" AND company_id IN (2)");
  });

  test("a manager granted both sees the combined HOUZS+2990 queue", () => {
    expect(assrCompanySql(ctx([1, 2]))).toBe(" AND company_id IN (1,2)");
  });

  test("the column argument is honoured for joined queries", () => {
    expect(assrCompanySql(ctx([1]), "c.company_id")).toBe(" AND c.company_id IN (1)");
    expect(assrCompanySql(ctx([1, 2]), "c.company_id")).toBe(" AND c.company_id IN (1,2)");
  });

  test("granted no company matches nothing; unresolved degrades to no predicate", () => {
    // `[]` = resolved but restricted to nothing → match nothing (never open).
    expect(assrCompanySql(ctx([]))).toBe(" AND 1=0");
    // `undefined` = unresolved (pre-migration / D1 / cold-start) → no predicate.
    expect(assrCompanySql(ctx(undefined))).toBe("");
  });
});

/* CREATE stamp — the case belongs to the switcher's active company, falling
   back to HOUZS when none resolves. An SO-attached case is further overridden
   by the SO's OWN company inside createAssrCase — not covered here, since that
   path needs the scm schema the D1 test mirror doesn't carry. */
describe("ASSR create stamp — the switcher's active company, HOUZS fallback", () => {
  test("on the 2990 switcher raises a 2990 case", () => {
    expect(assrCreateCompanyId(ctx([1, 2], 2))).toBe(2);
  });

  test("on the HOUZS switcher raises a HOUZS case", () => {
    expect(assrCreateCompanyId(ctx([1, 2], 1))).toBe(1);
  });

  test("no usable switcher value falls back to HOUZS", () => {
    expect(assrCreateCompanyId(ctx([1, 2]))).toBe(1);
  });
});
