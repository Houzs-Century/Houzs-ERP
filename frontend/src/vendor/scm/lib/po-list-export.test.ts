import { describe, it, expect } from "vitest";
import { poListParams } from "./po-list-export";

describe("poListParams — server-filterable funnels", () => {
  it("serializes creditor names/codes and currencies as JSON arrays", () => {
    const usp = poListParams({
      status: "outstanding",
      creditorNames: ["DIGLANT SDN BHD", "FOO, INC"],
      creditorCodes: ["400-D001"],
      currencies: ["MYR", "USD"],
    });
    expect(usp.get("status")).toBe("outstanding");
    // JSON, not comma-join — a creditor name may itself contain a comma.
    expect(usp.get("creditorNames")).toBe(JSON.stringify(["DIGLANT SDN BHD", "FOO, INC"]));
    expect(usp.get("creditorCodes")).toBe(JSON.stringify(["400-D001"]));
    expect(usp.get("currencies")).toBe(JSON.stringify(["MYR", "USD"]));
  });

  it("omits the server-filterable params when they are empty or absent", () => {
    const usp = poListParams({ status: "all", creditorNames: [], currencies: [] });
    expect(usp.has("creditorNames")).toBe(false);
    expect(usp.has("creditorCodes")).toBe(false);
    expect(usp.has("currencies")).toBe(false);
    expect(usp.has("docDates")).toBe(false);
  });

  it("sends the Doc Date funnel so the pager total counts the filtered set", () => {
    expect(poListParams({ docDates: ["2026-09-23"] }).get("docDates")).toBe(JSON.stringify(["2026-09-23"]));
  });
});
