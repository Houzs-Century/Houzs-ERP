import { describe, it, expect } from "vitest";
import { resolveFxRate, deriveRateFromMyrPaid } from "./fx-rate";

/**
 * The regression these guard is NOT "resolveFxRate returns a number" — it is
 * that the preview and the write now answer the same question the same way.
 * Under the old code the write paths inlined `(n > 0 && isFinite(n)) ? n : 1`
 * and the previews inlined `Number(x) || 0`; every case below where the
 * expectation is 1 is a case where the screen used to print RM 0.00 for money
 * the backend would post in full.
 */
describe("resolveFxRate", () => {
  it("passes a real keyed rate straight through", () => {
    expect(resolveFxRate("4.35")).toBe(4.35);
    expect(resolveFxRate(4.35)).toBe(4.35);
    expect(resolveFxRate("1")).toBe(1);
  });

  it("treats an UNSET rate as 1 — the value the write paths already post at", () => {
    // Each of these produced 0 in the old preview rule and 1 in the old write
    // rule. That divergence is the bug; they must now agree.
    expect(resolveFxRate("")).toBe(1);
    expect(resolveFxRate(null)).toBe(1);
    expect(resolveFxRate(undefined)).toBe(1);
    expect(resolveFxRate("abc")).toBe(1);
    expect(resolveFxRate(NaN)).toBe(1);
  });

  it("treats zero and negative as UNSET, not as a real rate", () => {
    // A currency is never worth nothing, so a stored 0 always means nobody
    // keyed it. Multiplying money by it is how a real total renders RM 0.00.
    expect(resolveFxRate(0)).toBe(1);
    expect(resolveFxRate("0")).toBe(1);
    expect(resolveFxRate("0.00")).toBe(1);
    expect(resolveFxRate(-3)).toBe(1);
  });

  it("rejects the infinities rather than propagating them into a total", () => {
    expect(resolveFxRate(Infinity)).toBe(1);
    expect(resolveFxRate(-Infinity)).toBe(1);
  });

  it("is byte-identical to the rule the write paths used to inline", () => {
    // The write paths must be provably unchanged by this refactor, so assert
    // the new helper against the exact expression that was deleted from
    // PaymentVoucherNew / PaymentVoucherDetail / PurchaseInvoiceNew / GrnNew.
    const oldWriteRule = (x: unknown) =>
      Number(x) > 0 && Number.isFinite(Number(x)) ? Number(x) : 1;
    const cases: unknown[] = [
      "4.35", 4.35, "1", "", null, undefined, "abc", NaN, 0, "0", "0.00",
      -3, Infinity, -Infinity, "  2.5  ", true, false, [], {},
    ];
    for (const c of cases) {
      expect(resolveFxRate(c)).toBe(oldWriteRule(c));
    }
  });
});

/**
 * "I paid RM 13,404.50 for a ¥21,625.00 invoice" — the input the owner actually
 * has, turned into the rate the document stores. The guard here is that NOTHING
 * unusable ever reaches the rate field: a null tells the caller to leave the
 * existing rate alone, whereas a 0 or NaN would be resolveFxRate'd back to 1 and
 * post the raw foreign figure as ringgit — the exact mis-cost this feature exists
 * to prevent.
 */
describe("deriveRateFromMyrPaid", () => {
  it("derives the rate from the ringgit that actually left the bank", () => {
    // ¥10,000.00 = 1_000_000 centi; RM 6,198.38 = 619_838 sen -> 0.619838.
    expect(deriveRateFromMyrPaid(619_838, 1_000_000)).toBe(0.619838);
    // And the owner's real invoice: ¥21,625.00 paid with RM 13,404.01.
    expect(deriveRateFromMyrPaid(1_340_401, 2_162_500)).toBe(0.619839);
  });

  it("rounds to the stored numeric(14,6) so the screen and the database agree", () => {
    // 1/3 would otherwise carry 16 digits the column cannot hold.
    expect(deriveRateFromMyrPaid(1, 3)).toBe(0.333333);
    expect(deriveRateFromMyrPaid(2, 3)).toBe(0.666667);
  });

  it("handles a rate above 1 (a stronger currency, e.g. SGD/USD)", () => {
    expect(deriveRateFromMyrPaid(4_350_000, 1_000_000)).toBe(4.35);
  });

  it("returns null on a zero or missing FOREIGN total — the divide-by-zero", () => {
    expect(deriveRateFromMyrPaid(1_340_450, 0)).toBeNull();
    expect(deriveRateFromMyrPaid(1_340_450, null)).toBeNull();
    expect(deriveRateFromMyrPaid(1_340_450, undefined)).toBeNull();
    expect(deriveRateFromMyrPaid(1_340_450, -100)).toBeNull();
  });

  it("returns null while the MYR figure is still blank or zero, never a rate of 0", () => {
    // The operator has not typed it yet. Treating that as 0 would blank the rate.
    expect(deriveRateFromMyrPaid(0, 2_162_500)).toBeNull();
    expect(deriveRateFromMyrPaid(null, 2_162_500)).toBeNull();
    expect(deriveRateFromMyrPaid(undefined, 2_162_500)).toBeNull();
    expect(deriveRateFromMyrPaid(-1, 2_162_500)).toBeNull();
  });

  it("returns null rather than NaN / Infinity for junk", () => {
    expect(deriveRateFromMyrPaid(Number.NaN, 2_162_500)).toBeNull();
    expect(deriveRateFromMyrPaid(Number.POSITIVE_INFINITY, 2_162_500)).toBeNull();
    expect(deriveRateFromMyrPaid(1_340_450, Number.NaN)).toBeNull();
  });

  it("never returns something resolveFxRate would fold to 1 behind the user's back", () => {
    // Any non-null result must be a rate the write path will honour verbatim.
    const r = deriveRateFromMyrPaid(1_340_450, 2_162_500)!;
    expect(resolveFxRate(String(r))).toBe(r);
  });

  it("a MYR figure so small it rounds to zero at 6dp is refused, not stored as 0", () => {
    // 1 sen against a ¥10,000,000.00 invoice rounds to 0.000000 — not a rate.
    expect(deriveRateFromMyrPaid(1, 1_000_000_000)).toBeNull();
  });
});
