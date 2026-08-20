import { describe, expect, it } from "vitest";
import { effectiveStatusFilter, isRangeNotSatisfiable } from "./so-list-filters";

/* Regression: 2026-08-18, prod. The Sales Orders list showed "No sales orders
   yet" for HOUZS, which has 2,726 orders (proven live: base=2726, view=2726 —
   the mfg_sales_orders_with_payment_totals view is faithful, service_role reads
   all 2,726 through it). The network layer carried a swallowed 500
   { error:'load_failed', reason:'Requested range not satisfiable' }.

   TWO independent causes, both pinned here:

   1. `?status=all` — the list handler applied the raw param as
      q.eq('status', status), so 'all' filtered to rows whose status is the
      literal string 'all'. No SO carries that status, so the query matched
      ZERO rows; with count:'exact' a page past offset 0 then exceeds the count.

   2. A page whose offset is at/beyond the count is answered by PostgREST with
      PGRST103 / 416 "Requested range not satisfiable" instead of an empty 200.
      The handler turned that into a 500, and the grid masked it as "No sales
      orders yet". It must be an empty page. */

describe("effectiveStatusFilter", () => {
  it("treats the All tab (all / ALL / '' / whitespace) as NO status filter", () => {
    // This is the bug: 'all' must NOT reach q.eq('status', 'all').
    for (const v of ["all", "ALL", "All", "aLl", "", "   "]) {
      expect(effectiveStatusFilter(v)).toBeUndefined();
    }
  });

  it("treats a missing param as no filter", () => {
    expect(effectiveStatusFilter(undefined)).toBeUndefined();
    expect(effectiveStatusFilter(null)).toBeUndefined();
  });

  it("passes a real status through unchanged (exact match preserved)", () => {
    for (const v of ["CONFIRMED", "READY_TO_SHIP", "DELIVERED", "CANCELLED", "DRAFT"]) {
      expect(effectiveStatusFilter(v)).toBe(v);
    }
  });

  it("passes the OTHER sentinel through so the Other pill still opens", () => {
    expect(effectiveStatusFilter("OTHER")).toBe("OTHER");
  });

  it("trims surrounding whitespace but keeps the real value", () => {
    expect(effectiveStatusFilter("  CONFIRMED  ")).toBe("CONFIRMED");
  });
});

describe("isRangeNotSatisfiable", () => {
  it("recognises the PGRST103 code", () => {
    expect(isRangeNotSatisfiable({ code: "PGRST103" })).toBe(true);
  });

  it("recognises the message, case-insensitively", () => {
    expect(isRangeNotSatisfiable({ message: "Requested range not satisfiable" })).toBe(true);
    expect(isRangeNotSatisfiable({ message: "requested RANGE NOT SATISFIABLE for..." })).toBe(true);
  });

  it("is false for an absent error (the happy path)", () => {
    expect(isRangeNotSatisfiable(null)).toBe(false);
    expect(isRangeNotSatisfiable(undefined)).toBe(false);
  });

  it("is false for any OTHER PostgREST error — those must still surface as 500", () => {
    expect(isRangeNotSatisfiable({ code: "PGRST116", message: "no rows" })).toBe(false);
    expect(isRangeNotSatisfiable({ code: "42501", message: "permission denied for schema scm" })).toBe(false);
    expect(isRangeNotSatisfiable({ message: "column mfg_sales_orders.foo does not exist" })).toBe(false);
  });
});
