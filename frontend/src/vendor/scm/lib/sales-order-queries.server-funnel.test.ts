import { describe, it, expect } from "vitest";
import { soListSearchParams } from "./sales-order-queries";

describe("soListSearchParams — server-filterable funnels", () => {
  it("serializes Customer (debtor) names and currencies as JSON arrays", () => {
    const usp = soListSearchParams({
      status: "confirmed",
      debtorNames: ["ALICE, INC", "BOB"],
      currencies: ["MYR", "USD"],
    });
    // JSON, not comma-join — a customer name may itself contain a comma.
    expect(usp.get("debtorNames")).toBe(JSON.stringify(["ALICE, INC", "BOB"]));
    expect(usp.get("currencies")).toBe(JSON.stringify(["MYR", "USD"]));
  });

  it("omits the server-filterable params when empty or absent", () => {
    const usp = soListSearchParams({ status: "all", debtorNames: [], currencies: [] });
    expect(usp.has("debtorNames")).toBe(false);
    expect(usp.has("currencies")).toBe(false);
  });

  it("serializes the Branding funnel so the server pages over the filtered set", () => {
    const usp = soListSearchParams({ status: "all", brandings: ["ZANOTTI", "2990s Sofa"] });
    expect(usp.get("brandings")).toBe(JSON.stringify(["ZANOTTI", "2990s Sofa"]));
    expect(soListSearchParams({ status: "all", brandings: [] }).has("brandings")).toBe(false);
  });

  it("serializes every other column funnel as one cols object", () => {
    const cols = { city: ["KL", "—"], so_date: ["2026-09-01"] };
    expect(soListSearchParams({ status: "all", cols }).get("cols")).toBe(JSON.stringify(cols));
    expect(soListSearchParams({ status: "all", cols: {} }).has("cols")).toBe(false);
  });
});
