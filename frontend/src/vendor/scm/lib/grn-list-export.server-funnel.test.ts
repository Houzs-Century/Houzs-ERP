import { describe, it, expect } from "vitest";
import { grnListParams } from "./grn-list-export";

describe("grnListParams — server-filterable funnels", () => {
  it("serializes creditor names/codes and currencies as JSON arrays", () => {
    const usp = grnListParams({ status: "posted", creditorNames: ["DIGLANT, INC", "FOO"], creditorCodes: ["400-D001"], currencies: ["MYR"] });
    expect(usp.get("creditorNames")).toBe(JSON.stringify(["DIGLANT, INC", "FOO"]));
    expect(usp.get("creditorCodes")).toBe(JSON.stringify(["400-D001"]));
    expect(usp.get("currencies")).toBe(JSON.stringify(["MYR"]));
  });

  it("omits them when empty or absent", () => {
    const usp = grnListParams({ creditorNames: [], currencies: [] });
    expect(usp.has("creditorNames")).toBe(false);
    expect(usp.has("currencies")).toBe(false);
  });
});
