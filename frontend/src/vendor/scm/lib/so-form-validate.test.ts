import { describe, expect, it } from "vitest";
import {
  soStockLocationError,
  LOCATION_REQUIRED_COMPANY_CODES,
} from "./so-form-validate";

/* Owner 2026-08-13, after both AutoCount write-back test orders were refused
   for carrying no stock location: "Company 1 (Houzs Century) 开单必须有 State。
   Company 2 (2990) 不需要。其他公司也不必填。"

   The backend is the authoritative gate (so-location-gate.ts); this guard only
   decides whether the salesperson is told BEFORE or AFTER losing their typing.
   These pin that the two lists and the two verdicts agree. */

const input = (o: Partial<Parameters<typeof soStockLocationError>[0]> = {}) => ({
  companyCode: "HOUZS",
  salesLocation: "",
  state: "",
  ...o,
});

describe("company scope", () => {
  it("covers company 1 (HOUZS) and nothing else — mirrors the backend list", () => {
    expect(LOCATION_REQUIRED_COMPANY_CODES).toEqual(["HOUZS"]);
  });

  it("company 2 (2990) saves with no State, exactly as before", () => {
    expect(soStockLocationError(input({ companyCode: "2990" }))).toBeNull();
  });

  it("any other company is untouched", () => {
    expect(soStockLocationError(input({ companyCode: "HOOKKA" }))).toBeNull();
  });

  it("an unresolved company code does not block (the server still gates)", () => {
    expect(soStockLocationError(input({ companyCode: null }))).toBeNull();
    expect(soStockLocationError(input({ companyCode: "" }))).toBeNull();
  });
});

describe("company 1", () => {
  it("blocks a create with no State picked", () => {
    const e = soStockLocationError(input());
    expect(e?.title).toContain("State");
    expect(e?.body).toContain("warehouse");
  });

  it("blocks a State that resolved NO warehouse, with its own sentence", () => {
    const e = soStockLocationError(input({ state: "Perlis" }));
    expect(e?.title).toContain("Perlis");
    expect(e?.body).toContain("administrator");
  });

  it("passes once the State resolved a Sales Location", () => {
    expect(soStockLocationError(input({ state: "Selangor", salesLocation: "KL" })))
      .toBeNull();
  });

  it("treats a whitespace-only Sales Location as none", () => {
    expect(soStockLocationError(input({ salesLocation: "  " }))?.title).toContain("State");
  });
});

describe("what the gate never blocks", () => {
  it("a draft — a draft is never written to AutoCount", () => {
    expect(soStockLocationError(input({ asDraft: true }))).toBeNull();
  });

  it("an edit — an AutoCount EDIT leaves the account book's own Location alone", () => {
    expect(soStockLocationError(input({ isEdit: true }))).toBeNull();
  });

  it("a save while the state->warehouse mappings are still loading", () => {
    /* Every State looks unmapped before that query answers; the server reads
       the mappings directly, so let it have the last word rather than refusing
       a legitimate order over a request in flight. */
    expect(soStockLocationError(input({ state: "Selangor", mappingsLoaded: false })))
      .toBeNull();
  });

  it("…but a surface that resolves no location at all is still gated", () => {
    expect(soStockLocationError(input())).not.toBeNull();
  });
});
