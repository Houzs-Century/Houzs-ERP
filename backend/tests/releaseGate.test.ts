import { describe, expect, test } from "vitest";
import { computeReleaseGate, DEFAULT_RELEASE_POLICY } from "../src/services/agents/release-gate";

/* The AR-005 delivery-release gate (docs/agents/operating-spec.md §7). It computes
   whether an order may be dispatched given its payment, and — crucially for Houzs,
   which collects the balance ON delivery — states what POD must collect. It never
   moves money. These tests pin the three decisions and the two things that must
   never happen: a silent hold on a fully-paid order, and a RELEASE on figures the
   system cannot defend (§10.2 RED = stop and escalate). */

const sen = (rm: number) => Math.round(rm * 100);

describe("computeReleaseGate — the normal Houzs B2C flow (default policy)", () => {
  test("fully paid → RELEASE, nothing to collect", () => {
    const g = computeReleaseGate({ totalCenti: sen(1000), paidCenti: sen(1000) });
    expect(g.decision).toBe("RELEASE");
    expect(g.remainingCenti).toBe(0);
    expect(g.collectOnDeliveryCenti).toBe(0);
  });

  test("deposit only → RELEASE_WITH_COLLECTION, POD collects the exact balance", () => {
    // The everyday case: 30% deposit taken on the order, balance due at delivery.
    const g = computeReleaseGate({ totalCenti: sen(1000), paidCenti: sen(300) });
    expect(g.decision).toBe("RELEASE_WITH_COLLECTION");
    expect(g.remainingCenti).toBe(sen(700));
    expect(g.collectOnDeliveryCenti).toBe(sen(700));
    expect(g.reason).toContain("700.00");
  });

  test("an outstanding balance is NOT a hold by default — delivery is not blocked", () => {
    // The DO path today explicitly does not gate on deposit; the gate must not
    // silently invent a stricter rule than the business runs on.
    const g = computeReleaseGate({ totalCenti: sen(5000), paidCenti: 0 });
    expect(g.decision).toBe("RELEASE_WITH_COLLECTION");
    expect(g.needsEscalation).toBe(false);
  });

  test("a free order (total 0) is fully paid, RELEASE", () => {
    const g = computeReleaseGate({ totalCenti: 0, paidCenti: 0 });
    expect(g.decision).toBe("RELEASE");
    expect(g.paidFraction).toBe(1);
  });
});

describe("computeReleaseGate — a hard hold is opt-in", () => {
  test("with a 50% floor, a 30% deposit HOLDs for a human", () => {
    const g = computeReleaseGate({
      totalCenti: sen(1000), paidCenti: sen(300),
      policy: { minPaidFractionToRelease: 0.5 },
    });
    expect(g.decision).toBe("HOLD");
    expect(g.collectOnDeliveryCenti).toBe(0);
    expect(g.reason).toMatch(/30% is below the 50%/);
  });

  test("with a 50% floor, exactly 50% paid RELEASEs (boundary is inclusive)", () => {
    const g = computeReleaseGate({
      totalCenti: sen(1000), paidCenti: sen(500),
      policy: { minPaidFractionToRelease: 0.5 },
    });
    expect(g.decision).toBe("RELEASE_WITH_COLLECTION");
    expect(g.collectOnDeliveryCenti).toBe(sen(500));
  });

  test("the default policy has a zero floor — it never blocks on balance alone", () => {
    expect(DEFAULT_RELEASE_POLICY.minPaidFractionToRelease).toBe(0);
  });
});

describe("computeReleaseGate — RED figures never dispatch (§10.2)", () => {
  test("unreconciled data HOLDs and escalates, even if it looks fully paid", () => {
    const g = computeReleaseGate({ totalCenti: sen(1000), paidCenti: sen(1000), dataQuality: "RED" });
    expect(g.decision).toBe("HOLD");
    expect(g.needsEscalation).toBe(true);
    expect(g.reason).toMatch(/RED/);
  });

  test("RED overrides an otherwise-clear release", () => {
    const g = computeReleaseGate({ totalCenti: sen(1000), paidCenti: sen(400), dataQuality: "RED" });
    expect(g.decision).toBe("HOLD");
    expect(g.collectOnDeliveryCenti).toBe(0);
  });
});

describe("computeReleaseGate — arithmetic never lies", () => {
  test("overpayment does not produce a negative balance or a hold", () => {
    const g = computeReleaseGate({ totalCenti: sen(1000), paidCenti: sen(1200) });
    expect(g.remainingCenti).toBe(0);
    expect(g.decision).toBe("RELEASE");
    expect(g.paidFraction).toBe(1); // clamped, not 1.2
  });

  test("negative / NaN inputs are floored to 0, never trusted", () => {
    const g = computeReleaseGate({ totalCenti: Number.NaN, paidCenti: -50 });
    expect(g.totalCenti).toBe(0);
    expect(g.paidCenti).toBe(0);
    expect(g.decision).toBe("RELEASE");
  });

  test("cents are rounded, not truncated to a wrong balance", () => {
    const g = computeReleaseGate({ totalCenti: 1000.6, paidCenti: 300.4 });
    expect(g.totalCenti).toBe(1001);
    expect(g.paidCenti).toBe(300);
    expect(g.remainingCenti).toBe(701);
  });
});
