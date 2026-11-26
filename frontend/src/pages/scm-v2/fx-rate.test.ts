import { describe, it, expect } from "vitest";
import { resolveFxRate, deriveRateFromMyrPaid } from "./fx-rate";

describe("resolveFxRate", () => {
  it("passes a real keyed rate straight through", () => {
    expect(resolveFxRate("4.35")).toBe(4.35);
    expect(resolveFxRate(4.35)).toBe(4.35);
    expect(resolveFxRate("1")).toBe(1);
  });

  it("treats an UNSET rate as 1 — the value the write paths already post at", () => {
    expect(resolveFxRate("")).toBe(1);
    expect(resolveFxRate(null)).toBe(1);
    expect(resolveFxRate(undefined)).toBe(1);
    expect(resolveFxRate("abc")).toBe(1);
    expect(resolveFxRate(NaN)).toBe(1);
  });

  it("treats zero and negative as UNSET, not as a real rate", () => {
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

describe("deriveRateFromMyrPaid", () => {
  it("derives the rate from the ringgit that actually left the bank", () => {
    expect(deriveRateFromMyrPaid(619_838, 1_000_000)).toBe(0.619838);
    expect(deriveRateFromMyrPaid(1_340_401, 2_162_500)).toBe(0.619839);
  });

  it("rounds to the stored numeric(14,6) so the screen and the database agree", () => {
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
    const r = deriveRateFromMyrPaid(1_340_450, 2_162_500)!;
    expect(resolveFxRate(String(r))).toBe(r);
  });

  it("a MYR figure so small it rounds to zero at 6dp is refused, not stored as 0", () => {
    expect(deriveRateFromMyrPaid(1, 1_000_000_000)).toBeNull();
  });
});
