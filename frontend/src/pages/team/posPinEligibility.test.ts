import { describe, it, expect } from "vitest";
import {
  POS_COMPANY_CODE,
  inPosCompany,
  isPosPinPosition,
  showsPosPinCard,
} from "./posPinEligibility";

/* Adrian's real shape (screenshot, 2026-08-24): both companies, Sales
 * Executive. He is exactly the member the card exists for, so he is the
 * fixture rather than an invented one. */
const COMPANIES = [
  { id: 1, code: "HOUZS" },
  { id: 2, code: "2990" },
];

describe("isPosPinPosition", () => {
  it("accepts the sales slugs the backend accepts", () => {
    expect(isPosPinPosition("sales_executive")).toBe(true);
    expect(isPosPinPosition("sales")).toBe(true);
  });

  it("refuses a non-sales title — /pin-login would answer not_pos_role", () => {
    expect(isPosPinPosition("driver")).toBe(false);
    expect(isPosPinPosition("outlet_manager")).toBe(false);
  });

  it("refuses no title at all", () => {
    expect(isPosPinPosition(null)).toBe(false);
    expect(isPosPinPosition("")).toBe(false);
  });
});

describe("inPosCompany", () => {
  it("matches on the company CODE, not on a hard-coded id", () => {
    // Same code, different id — a fresh test DB numbers companies its own way.
    expect(inPosCompany([7], [{ id: 7, code: POS_COMPANY_CODE }])).toBe(true);
  });

  it("is false when the member holds only the other company", () => {
    expect(inPosCompany([1], COMPANIES)).toBe(false);
  });

  it("is true when the member holds both", () => {
    expect(inPosCompany([1, 2], COMPANIES)).toBe(true);
  });

  it("is false for a member with no company at all", () => {
    expect(inPosCompany([], COMPANIES)).toBe(false);
  });
});

describe("showsPosPinCard", () => {
  it("shows for Adrian — 2990's Home plus Sales Executive", () => {
    expect(
      showsPosPinCard({
        companyIds: [1, 2],
        companies: COMPANIES,
        positionSlug: "sales_executive",
      }),
    ).toBe(true);
  });

  it("hides when the title is right but the company is not", () => {
    expect(
      showsPosPinCard({
        companyIds: [1],
        companies: COMPANIES,
        positionSlug: "sales_executive",
      }),
    ).toBe(false);
  });

  it("hides when the company is right but the title is not", () => {
    expect(
      showsPosPinCard({ companyIds: [2], companies: COMPANIES, positionSlug: "driver" }),
    ).toBe(false);
  });

  it("hides when the companies master carries no 2990 row", () => {
    expect(
      showsPosPinCard({
        companyIds: [1],
        companies: [{ id: 1, code: "HOUZS" }],
        positionSlug: "sales_executive",
      }),
    ).toBe(false);
  });
});
