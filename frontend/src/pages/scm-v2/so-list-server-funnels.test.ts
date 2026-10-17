import { describe, expect, it } from "vitest";
import { clampSoPage, soPageOnlyFunnelKeys, soServerFunnels } from "./so-list-server-funnels";

/* Owner 2026-10-17: BRANDING = ZANOTTI on the Sales Orders list filtered only the
   loaded 50 rows (9 left) while the footer kept "1-50 of 3,465 · 70 pages". */
describe("Sales Order list column funnels", () => {
  it("pushes the Branding funnel to the server with Customer Name and Currency", () => {
    expect(soServerFunnels({ branding: ["ZANOTTI"], debtor_name: ["ALICE"], currency: ["MYR"], status: ["DRAFT"] }))
      .toEqual({ debtorNames: ["ALICE"], currencies: ["MYR"], brandings: ["ZANOTTI"] });
  });

  it("reads an empty or cleared funnel as no server filter", () => {
    expect(soServerFunnels({ branding: [] })).toEqual({ debtorNames: undefined, currencies: undefined, brandings: undefined });
  });

  it("names only the set funnels the server cannot answer as page-only", () => {
    expect(soPageOnlyFunnelKeys({ branding: ["ZANOTTI"], status: ["DRAFT"], salesperson: [], currency: ["USD"] })).toEqual(["status"]);
    expect(soPageOnlyFunnelKeys({ branding: ["ZANOTTI"] })).toEqual([]);
  });

  it("brings a page past the filtered set back to its last page", () => {
    expect(clampSoPage(69, 120, 50)).toBe(2); // page 70 of 3,465 -> 3 pages after the filter
    expect(clampSoPage(1, 120, 50)).toBe(1);
    expect(clampSoPage(5, 0, 50)).toBe(0);
  });
});
