import { describe, expect, test } from "vitest";
import { EXTERNAL_POSITION_MESSAGE, isExternalPosition } from "./externalPosition";

describe("EXTERNAL_POSITION_MESSAGE", () => {
  test("describes the Team-invite flow instead of sending the admin away from it", () => {
    for (const fact of [
      "stays out of the Team Member list",
      "appears in Fleet as a driver automatically",
      "do not add them in Fleet by hand",
      "Set a password and give the Driver role",
      "Dispatch ticked for this position",
    ]) {
      expect(EXTERNAL_POSITION_MESSAGE).toContain(fact);
    }
    expect(EXTERNAL_POSITION_MESSAGE).not.toMatch(/not Members|belongs in Fleet/i);
  });
});

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
