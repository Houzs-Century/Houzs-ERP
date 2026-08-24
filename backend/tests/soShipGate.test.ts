import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { summariseReadiness, type ReadinessLine } from "../src/scm/lib/so-readiness";
import { derivePlanningState } from "../src/scm/routes/delivery-planning";

/* THE SHIP GATE, AND THE EMPTY-SO HOLE IT CLOSES.
 *
 * summariseReadiness.isMainReady answers "is every MAIN product line (sofa /
 * bedframe / mattress) allocated?" and is deliberately TRUE when the SO has no
 * MAIN line at all — that is the correct reading for an accessory-only order,
 * which really is ship-able without any mattress on it.
 *
 * It is the wrong reading for an SO with NO stock-bearing lines whatsoever, and
 * that case is reachable in production. On 2026-08-13/14 the 2990 POS minted 16
 * test SOs (`testRM500voucher`, `was testin promo voucher`, ...); staff "undid"
 * them by deleting every line and its payment, since an SO cannot be removed.
 * The auto-allocation sweep read isMainReady on the resulting husks, found zero
 * unready main lines, and advanced all 16 to READY_TO_SHIP — audit note "every
 * main product line is READY (stock allocation)", vacuously true of nothing.
 * Empty documents then sat in the ship queue looking like real work.
 *
 * isShipReady is that gate done correctly, in ONE place: main-ready when there
 * IS a main line, else isFullyReady (which requires >= 1 live line). Delivery
 * Planning had already derived the rule inline; the auto-allocation sweep and
 * the manual stock toggle had not. The source assertions at the bottom pin that
 * neither of those two writers has drifted back to bare isMainReady — this is a
 * bug that got shipped by using the nearly-right flag, so the near-right flag is
 * what the test watches.
 *
 * NOT tested here: the sweep running against a database. This suite binds D1
 * (vitest.config.mts) and recomputeSoStockAllocation reads Postgres through
 * Supabase — the regress of the 16 live husks is a staging/prod check.
 */

const main = (stock_status: string): ReadinessLine => ({ item_group: "MATTRESS", stock_status });
const acc  = (stock_status: string): ReadinessLine => ({ item_group: "ACCESSORIES", stock_status });
const svc  = (): ReadinessLine => ({ item_group: "SERVICE", item_code: "SVC-DELIVERY", stock_status: "PENDING" });

describe("isShipReady refuses an SO with nothing to ship", () => {
  test("no lines at all is NOT ship-ready (the 2026-08-13 husks)", () => {
    const r = summariseReadiness([]);
    /* The trap itself: the old gate read this flag and said yes. */
    expect(r.isMainReady).toBe(true);
    expect(r.isShipReady).toBe(false);
  });

  test("every line cancelled is NOT ship-ready", () => {
    const r = summariseReadiness([{ ...main("READY"), cancelled: true }]);
    expect(r.isMainReady).toBe(true);
    expect(r.isShipReady).toBe(false);
  });

  test("a service-only SO is not confused with an empty one", () => {
    /* This assertion was INVERTED on 2026-08-16. It used to demand that a
       service-only SO be un-shippable, on the reasoning that summariseReadiness
       skipped every service line so the SO "is empty by the same reasoning as
       the husks even though it has a row". The owner overruled it:
       「如果它是 service 的单，也应该直接 ready」 — a delivery-only order has
       nothing to allocate, so it is ready the moment it exists. Service lines
       are now COUNTED (svcCount) instead of dropped, which is what makes the two
       cases distinguishable at all: the husk has zero lines, this one has one. */
    const r = summariseReadiness([svc()]);
    expect(r.mainCount + r.accCount).toBe(0);
    expect(r.svcCount).toBe(1);
    expect(r.isShipReady).toBe(true);
    /* The husk it must not be mistaken for. */
    expect(summariseReadiness([]).svcCount).toBe(0);
    expect(summariseReadiness([]).isShipReady).toBe(false);
  });
});

describe("isShipReady keeps every case that legitimately ships", () => {
  test("all mains READY → ship-ready, accessories pending do not block", () => {
    const r = summariseReadiness([main("READY"), acc("PENDING")]);
    expect(r.isShipReady).toBe(true);
    /* Ship-able and still short — so the LABEL is the bare word "PARTIAL", not
       the retired "READY (PARTIAL)": it may not read READY while an accessory
       is outstanding. The gate and the label answer two different questions;
       see soReadinessRemark.test.ts. */
    expect(r.stockRemark).toBe("PARTIAL");
    expect(r.stockRemark).not.toContain("READY");
  });

  test("a pending main blocks", () => {
    expect(summariseReadiness([main("PENDING"), main("READY")]).isShipReady).toBe(false);
  });

  test("PARTIAL allocation on a main blocks (not fully allocated)", () => {
    expect(summariseReadiness([main("PARTIAL")]).isShipReady).toBe(false);
  });

  test("accessory-only SO ships once its accessories are READY — the case isMainReady's convention exists for", () => {
    expect(summariseReadiness([acc("READY")]).isShipReady).toBe(true);
    expect(summariseReadiness([acc("PENDING")]).isShipReady).toBe(false);
  });

  test("a service line does not hold back an otherwise-ready order", () => {
    expect(summariseReadiness([main("READY"), svc()]).isShipReady).toBe(true);
  });
});

describe("Delivery Planning reads the same gate", () => {
  const base = { storedOverride: null, status: "CONFIRMED", delivered: 0, remaining: 0,
                 effectiveDD: "2026-09-01", today: "2026-08-14" };

  test("an empty SO is NOT queued for scheduling", () => {
    const state = derivePlanningState({ ...base, readiness: summariseReadiness([]) });
    expect(state).not.toBe("PENDING_SCHEDULE");
  });

  test("a ready SO still is", () => {
    const readiness = summariseReadiness([main("READY")]);
    const state = derivePlanningState({ ...base, remaining: 5, readiness });
    expect(state).toBe("PENDING_SCHEDULE");
  });
});

describe("the two auto-advance writers use the gate, not the bare flag", () => {
  /* Both of these advance an SO header to READY_TO_SHIP with no human in the
     loop. Both previously gated on isMainReady. A regression here is invisible
     at runtime until empty documents show up in the ship queue again. */
  const read = (rel: string) => readFileSync(join(__dirname, "..", "src", rel), "utf8");

  test("the auto-allocation sweep gates on isShipReady", () => {
    const src = read("scm/lib/so-stock-allocation.ts");
    expect(src).toContain("r.isShipReady && (cur === 'CONFIRMED'");
    expect(src).toContain("!r.isShipReady && cur === 'READY_TO_SHIP'");
    expect(src).not.toContain("r.isMainReady &&");
  });

  test("the manual stock-status toggle gates on isShipReady", () => {
    const src = read("scm/routes/mfg-sales-orders.ts");
    expect(src).toContain("const allReady = readiness.isShipReady;");
    expect(src).not.toContain("const allReady = readiness.isMainReady;");
  });
});
