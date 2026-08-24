/* RM 0 carries two meanings on one wire, and the server can only tell them
 * apart if the client says which.
 *
 *   "this line is FREE"        — staff typed 0 into the price box
 *   "I could not price it"     — the SKU has no sell price, or it is a sofa the
 *                                server prices from its Model's module SKUs
 *
 * The backend's `erpLineTrust` believes a 0 only when the client claims it
 * (`zeroPriceIntended: true` -> 'operator-zero'); a bare 0 means "not provided"
 * and takes the catalogue figure. That is correct, and it is why the claim must
 * be made ONLY where the operator actually authored the amount — claiming on
 * every 0 would book an unpriced sofa build at RM 0, which is the far worse bug.
 *
 * The helper exists because that decision was inline in ONE file, so the SO
 * CREATE path and the whole mobile surface never made the claim at all: a line
 * marked free on a NEW order was silently re-priced to full retail on both
 * surfaces, and the customer was invoiced for it.
 */
import { describe, expect, it } from "vitest";
import { zeroPriceClaim } from "./zeroPriceClaim";

describe("zeroPriceClaim", () => {
  it("claims a typed zero", () => {
    expect(zeroPriceClaim(0, true)).toEqual({ zeroPriceIntended: true });
  });

  it("does NOT claim a zero the operator never authored", () => {
    // An unpriced catalogue SKU, or a sofa the server prices from its modules.
    // Spreading `{}` leaves the field absent, which is what "not provided" is.
    expect(zeroPriceClaim(0, false)).toEqual({});
  });

  it("claims nothing at a non-zero price, authored or not", () => {
    // A real amount needs no claim — the trust helper already persists it.
    expect(zeroPriceClaim(12345, true)).toEqual({});
    expect(zeroPriceClaim(12345, false)).toEqual({});
  });

  it("spreads into a body without inventing a key", () => {
    // The shape callers rely on: `...zeroPriceClaim(...)` must add the field or
    // add nothing. A literal `zeroPriceIntended: false` would be a THIRD state
    // for the server to interpret.
    expect(Object.keys({ unitPriceSen: 0, ...zeroPriceClaim(0, false) })).toEqual(["unitPriceSen"]);
    expect(Object.keys({ unitPriceSen: 0, ...zeroPriceClaim(0, true) }))
      .toEqual(["unitPriceSen", "zeroPriceIntended"]);
  });
});
