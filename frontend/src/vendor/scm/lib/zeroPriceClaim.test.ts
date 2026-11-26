import { describe, expect, it } from "vitest";
import { priceBoxAuthored, unpricedExtraSen, zeroPriceClaim } from "./zeroPriceClaim";

describe("zeroPriceClaim", () => {
  it("claims a typed zero", () => {
    expect(zeroPriceClaim(0, true)).toEqual({ zeroPriceIntended: true });
  });

  it("does NOT claim a zero the operator never authored", () => {
    expect(zeroPriceClaim(0, false)).toEqual({});
  });

  it("claims nothing at a non-zero price, authored or not", () => {
    expect(zeroPriceClaim(12345, true)).toEqual({});
    expect(zeroPriceClaim(12345, false)).toEqual({});
  });

  it("spreads into a body without inventing a key", () => {
    expect(Object.keys({ unitPriceSen: 0, ...zeroPriceClaim(0, false) })).toEqual(["unitPriceSen"]);
    expect(Object.keys({ unitPriceSen: 0, ...zeroPriceClaim(0, true) }))
      .toEqual(["unitPriceSen", "zeroPriceIntended"]);
  });
});

/* HC-0095: emptying the price box read as a TYPED RM 0, so an amendment asked
 * for RM 0 with zeroPriceIntended and approval billed the line RM 0. */
describe("priceBoxAuthored", () => {
  it("a blank or non-numeric box is not an authored price", () => {
    for (const t of ["", "  ", "-", ".", "abc"]) expect(priceBoxAuthored(t)).toBe(false);
  });

  it("a typed 0 is still an authored price", () => {
    for (const t of ["0", "0.00", "0.", "250", "1,250.50"]) expect(priceBoxAuthored(t)).toBe(true);
  });
});

describe('unpricedExtraSen (HC-0198)', () => {
  it('adds the variant surcharges only to a blank, untyped, non-sofa price', () => {
    expect(unpricedExtraSen(0, false, 25000, false)).toBe(25000);
    expect(unpricedExtraSen(0, true, 25000, false)).toBe(0);
    expect(unpricedExtraSen(10000, false, 25000, false)).toBe(0);
    expect(unpricedExtraSen(0, false, 25000, true)).toBe(0);
  });
});
