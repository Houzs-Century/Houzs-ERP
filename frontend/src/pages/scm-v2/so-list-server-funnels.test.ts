import { describe, expect, it } from "vitest";
import { clampSoPage, soPageOnlyFunnelKeys, soServerFunnels, withSoFunnelSeeds } from "./so-list-server-funnels";

/* Owner 2026-10-17: BRANDING = ZANOTTI on the Sales Orders list filtered only the
   loaded 50 rows (9 left) while the footer kept "1-50 of 3,465 · 70 pages"; then
   every column funnel was to run over all orders. */
describe("Sales Order list column funnels", () => {
  it("pushes Branding, Customer Name and Currency on their own params and every header column through cols", () => {
    expect(soServerFunnels({ branding: ["ZANOTTI"], debtor_name: ["ALICE"], currency: ["MYR"], status: ["DRAFT"], city: ["KL", "—"] }))
      .toEqual({ debtorNames: ["ALICE"], currencies: ["MYR"], brandings: ["ZANOTTI"], cols: { status: ["DRAFT"], city: ["KL", "—"] } });
  });

  it("reads an empty or cleared funnel as no server filter", () => {
    expect(soServerFunnels({ branding: [], status: [] })).toEqual({ debtorNames: undefined, currencies: undefined, brandings: undefined, cols: undefined });
  });

  it("keeps a date-range condition on the page and sends only plain values", () => {
    const cond = "dateRange:2026-01-01..2026-01-31";
    expect(soServerFunnels({ so_date: [cond] }).cols).toBeUndefined();
    expect(soServerFunnels({ so_date: [cond, "2026-02-01"] }).cols).toEqual({ so_date: ["2026-02-01"] });
    expect(soPageOnlyFunnelKeys({ so_date: [cond] })).toEqual(["so_date"]);
  });

  it("names only the set funnels the server cannot answer as page-only", () => {
    expect(soPageOnlyFunnelKeys({ branding: ["ZANOTTI"], status: ["DRAFT"], stock_status: ["READY"], salesperson: [] })).toEqual(["stock_status"]);
    expect(soPageOnlyFunnelKeys({ branding: ["ZANOTTI"], city: ["KL"] })).toEqual([]);
  });

  it("seeds each server column with the server's values, leaving a column's own seed alone", () => {
    const cols = [{ key: "city" }, { key: "branding", filterSeedValues: ["ZANOTTI"] }, { key: "stock_status" }];
    expect(withSoFunnelSeeds({ city: ["JB", "KL"], branding: ["X"] }, cols))
      .toEqual([{ key: "city", filterSeedValues: ["JB", "KL"] }, { key: "branding", filterSeedValues: ["ZANOTTI"] }, { key: "stock_status" }]);
    expect(withSoFunnelSeeds(undefined, cols)).toBe(cols);
  });

  it("brings a page past the filtered set back to its last page", () => {
    expect(clampSoPage(69, 120, 50)).toBe(2); // page 70 of 3,465 -> 3 pages after the filter
    expect(clampSoPage(1, 120, 50)).toBe(1);
    expect(clampSoPage(5, 0, 50)).toBe(0);
  });
});
