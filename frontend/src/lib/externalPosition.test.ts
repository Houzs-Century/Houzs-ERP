import { describe, expect, test } from "vitest";
import { isExternalPosition } from "./externalPosition";


describe("isExternalPosition", () => {
  test("matches an outsourced Title by name or slug", () => {
    expect(isExternalPosition({ name: "Outsource Transporter" })).toBe(true);
    expect(isExternalPosition({ name: "OUTSOURCED DRIVER" })).toBe(true);
    expect(isExternalPosition({ slug: "outsource_transporter" })).toBe(true);
    expect(isExternalPosition({ name: "", slug: "outsource_helper" })).toBe(true);
  });

  test("does not claim an internal Title", () => {
    for (const name of ["Transporter", "Driver", "Storekeeper", "Sales Executive", "Logistic Admin", "Helper"]) {
      expect(isExternalPosition({ name }), name).toBe(false);
    }
  });

  test("null / empty is not external", () => {
    expect(isExternalPosition(null)).toBe(false);
    expect(isExternalPosition(undefined)).toBe(false);
    expect(isExternalPosition({})).toBe(false);
    expect(isExternalPosition({ name: null, slug: null })).toBe(false);
  });
});
