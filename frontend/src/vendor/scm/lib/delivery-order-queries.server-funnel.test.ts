import { describe, it, expect } from "vitest";
import { doListSearchParams } from "./delivery-order-queries";

describe("doListSearchParams — server-filterable funnels", () => {
  it("serializes Customer (debtor) names and currencies as JSON arrays", () => {
    const usp = doListSearchParams({ status: "delivered", debtorNames: ["ALICE, INC", "BOB"], currencies: ["MYR"] });
    expect(usp.get("debtorNames")).toBe(JSON.stringify(["ALICE, INC", "BOB"]));
    expect(usp.get("currencies")).toBe(JSON.stringify(["MYR"]));
  });

  it("omits them when empty or absent", () => {
    const usp = doListSearchParams({ debtorNames: [], currencies: [] });
    expect(usp.has("debtorNames")).toBe(false);
    expect(usp.has("currencies")).toBe(false);
  });
});
