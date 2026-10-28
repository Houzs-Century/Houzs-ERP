import { describe, expect, test } from "vitest";
import { assessFulfilment, type FulfilmentInput } from "../src/services/agents/order-fulfilment";

/* OF-001 readiness (docs/agents/operating-spec.md §3): one truthful order status
   from many scattered signals — the precise blocker, its owner, the next action.
   These tests pin the two things the spec cares about most: an order that is NOT
   ready must say exactly WHY and WHO fixes it, and an order that IS ready must not
   be held by something that never holds a ship (a pending accessory). */

const clean = (over: Partial<FulfilmentInput> = {}): FulfilmentInput => ({
  status: "CONFIRMED",
  isMainReady: true,
  isFullyReady: true,
  releaseDecision: "RELEASE",
  hasCustomerName: true,
  hasEmail: true,
  hasAddress: true,
  hasPostcode: true,
  hasDeliveryDate: true,
  supplyShortage: false,
  achievableReadyDate: "2026-07-25",
  ...over,
});

describe("assessFulfilment — a clean order is ready", () => {
  test("no blockers, score 100, ready, no next action", () => {
    const r = assessFulfilment(clean());
    expect(r.ready).toBe(true);
    expect(r.score).toBe(100);
    expect(r.blockers).toEqual([]);
    expect(r.nextAction).toBeNull();
    expect(r.achievableReadyDate).toBe("2026-07-25");
  });
});

describe("assessFulfilment — a status stop makes the rest moot", () => {
  test("a cancelled order reports ONLY the cancellation, even with other gaps", () => {
    const r = assessFulfilment(clean({ status: "CANCELLED", isMainReady: false, hasAddress: false }));
    expect(r.blockers.map((b) => b.code)).toEqual(["SO_CANCELLED"]);
    expect(r.ready).toBe(false);
    expect(r.score).toBe(0);
  });

  test("a draft is owned by Sales and says confirm-the-order", () => {
    const r = assessFulfilment(clean({ status: "DRAFT" }));
    expect(r.blockers[0].code).toBe("SO_DRAFT");
    expect(r.blockers[0].owner).toBe("SALES");
    expect(r.nextAction).toMatch(/confirm/i);
  });

  test("on-hold is owned by the Office", () => {
    const r = assessFulfilment(clean({ status: "ON_HOLD" }));
    expect(r.blockers[0].code).toBe("SO_ON_HOLD");
    expect(r.blockers[0].owner).toBe("OFFICE");
  });
});

describe("assessFulfilment — every blocker names its owner", () => {
  test("missing customer info → Sales", () => {
    const r = assessFulfilment(clean({ hasEmail: false }));
    const b = r.blockers.find((x) => x.code === "MISSING_CUSTOMER_INFO")!;
    expect(b.owner).toBe("SALES");
    expect(b.severity).toBe("BLOCK");
    expect(r.ready).toBe(false);
  });

  test("missing address vs missing date are DISTINCT blockers, not one lump", () => {
    const r = assessFulfilment(clean({ hasPostcode: false, hasDeliveryDate: false }));
    const codes = r.blockers.map((b) => b.code);
    expect(codes).toContain("MISSING_ADDRESS");
    expect(codes).toContain("MISSING_DELIVERY_DATE");
  });

  test("a payment HOLD → Finance", () => {
    const r = assessFulfilment(clean({ releaseDecision: "HOLD" }));
    const b = r.blockers.find((x) => x.code === "PAYMENT_HOLD")!;
    expect(b.owner).toBe("FINANCE");
  });

  test("RELEASE_WITH_COLLECTION is NOT a payment blocker — the balance is a POD collection", () => {
    const r = assessFulfilment(clean({ releaseDecision: "RELEASE_WITH_COLLECTION" }));
    expect(r.blockers.some((b) => b.code === "PAYMENT_HOLD")).toBe(false);
    expect(r.ready).toBe(true);
  });

  test("an uncovered supply shortage → Procurement", () => {
    const r = assessFulfilment(clean({ supplyShortage: true }));
    const b = r.blockers.find((x) => x.code === "SUPPLY_SHORTAGE")!;
    expect(b.owner).toBe("PROCUREMENT");
  });

  test("stock not allocated → Warehouse", () => {
    const r = assessFulfilment(clean({ isMainReady: false, isFullyReady: false }));
    const b = r.blockers.find((x) => x.code === "STOCK_NOT_READY")!;
    expect(b.owner).toBe("WAREHOUSE");
  });
});

describe("assessFulfilment — a pending accessory never holds a ship (B2C rule)", () => {
  test("main ready + accessory pending → WARN only, still ready", () => {
    const r = assessFulfilment(clean({ isMainReady: true, isFullyReady: false }));
    const b = r.blockers.find((x) => x.code === "ACCESSORIES_PENDING")!;
    expect(b.severity).toBe("WARN");
    expect(r.ready).toBe(true); // a WARN does not un-ready the order
    expect(r.score).toBeLessThan(100); // but it is still surfaced
  });

  test("a WARN does not set STOCK_NOT_READY (main IS ready)", () => {
    const r = assessFulfilment(clean({ isMainReady: true, isFullyReady: false }));
    expect(r.blockers.some((b) => b.code === "STOCK_NOT_READY")).toBe(false);
  });
});

describe("assessFulfilment — the score and next action reflect the worst first", () => {
  test("multiple BLOCKs drive the score down and nextAction is the first", () => {
    const r = assessFulfilment(clean({ hasEmail: false, isMainReady: false, releaseDecision: "HOLD" }));
    expect(r.ready).toBe(false);
    expect(r.score).toBeLessThan(50);
    // Missing customer info is listed before payment and stock — the resolution order.
    expect(r.blockers[0].code).toBe("MISSING_CUSTOMER_INFO");
    expect(r.nextAction).toBe(r.blockers[0].nextAction);
  });

  test("score never goes below 0 however many blockers pile up", () => {
    const r = assessFulfilment(clean({
      hasCustomerName: false, hasEmail: false, hasAddress: false,
      hasPostcode: false, hasDeliveryDate: false, releaseDecision: "HOLD",
      isMainReady: false, supplyShortage: true,
    }));
    expect(r.score).toBe(0);
    expect(r.score).toBeGreaterThanOrEqual(0);
  });

  test("supplyShortage omitted (cheap caller) does not invent a shortage blocker", () => {
    const input = clean();
    delete (input as { supplyShortage?: boolean }).supplyShortage;
    const r = assessFulfilment(input);
    expect(r.blockers.some((b) => b.code === "SUPPLY_SHORTAGE")).toBe(false);
    expect(r.ready).toBe(true);
  });
});
