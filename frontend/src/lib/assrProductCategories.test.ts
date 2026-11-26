import { describe, expect, it } from "vitest";
import {
  ASSR_PRODUCT_CATEGORIES_ENDPOINT,
  categoryChipList,
  splitCategories,
  toggleCategory,
} from "./assrProductCategories";

describe("assr product categories — the shared rule both surfaces read", () => {
  it("names one endpoint", () => {
    expect(ASSR_PRODUCT_CATEGORIES_ENDPOINT).toBe("/api/assr/lookups/product-categories");
  });

  it("splits the flat display string the API sends on the case row", () => {
    expect(splitCategories("Bedframe, Mattress")).toEqual(["Bedframe", "Mattress"]);
    expect(splitCategories(" Sofa ")).toEqual(["Sofa"]);
    expect(splitCategories(null)).toEqual([]);
    expect(splitCategories("")).toEqual([]);
    expect(splitCategories("Sofa,")).toEqual(["Sofa"]);
  });

  it("keeps a value the lookup no longer offers, rather than dropping it", () => {
    expect(categoryChipList(["Mattress", "Bedframe"], ["Bedframe", "Divan Only"])).toEqual([
      "Mattress",
      "Bedframe",
      "Divan Only",
    ]);
  });

  it("does not duplicate a value that IS in the lookup", () => {
    expect(categoryChipList(["Mattress", "Bedframe"], ["Bedframe"])).toEqual([
      "Mattress",
      "Bedframe",
    ]);
  });

  it("toggles without mutating", () => {
    const value = ["Bedframe"];
    expect(toggleCategory(value, "Mattress")).toEqual(["Bedframe", "Mattress"]);
    expect(toggleCategory(value, "Bedframe")).toEqual([]);
    expect(value).toEqual(["Bedframe"]);
  });
});
