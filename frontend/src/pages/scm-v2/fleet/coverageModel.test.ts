import { describe, expect, it } from "vitest";
import { areasByRegionCode, hit, placeAddress, windowLabel } from "./coverageModel";
import { BLANK_SERVICE, serviceBody, serviceProblem } from "./LorryService";

describe("residence rule window", () => {
  it("reads a blank side as no limit", () => {
    expect(windowLabel(null, null)).toBe("Any time");
    expect(windowLabel("10:00", "18:00")).toBe("10:00 to 18:00");
    expect(windowLabel("10:00", null)).toBe("From 10:00");
    expect(windowLabel(null, "17:00")).toBe("Until 17:00");
  });
});

describe("region areas", () => {
  it("collapses spelling variants and sorts per region", () => {
    const areas = areasByRegionCode([
      { stateKey: "W.P. Kuala Lumpur", country: "Malaysia", regionCodes: ["KL"] },
      { stateKey: "Selangor", country: "Malaysia", regionCodes: ["KL"] },
      { stateKey: "Kuala Lumpur", country: "Malaysia", regionCodes: ["KL"] },
      { stateKey: "Pulau Pinang", country: "Malaysia", regionCodes: ["N", "KL"] },
    ]);
    expect(areas.KL).toEqual(["Kuala Lumpur", "Penang", "Selangor"]);
    expect(areas.N).toEqual(["Penang"]);
  });
});

describe("saved location address and search", () => {
  it("joins the parts that are there", () => {
    expect(placeAddress({ address1: "Lot 1", address2: null, city: "Klang", postcode: "41000", state: "Selangor" })).toBe("Lot 1, 41000 Klang, Selangor");
    expect(placeAddress({ address1: null, address2: null, city: null, postcode: null, state: null })).toBe("");
  });
  it("searches case-blind over the words given", () => {
    expect(hit("klang", "Lot 1", "KLANG")).toBe(true);
    expect(hit("ipoh", "Lot 1", null)).toBe(false);
    expect(hit(" ", "x")).toBe(true);
  });
});

describe("service record form", () => {
  it("sends blanks as null, RM as sen, and the next-service fields", () => {
    expect(serviceBody({ ...BLANK_SERVICE, date: "2026-11-01", what: " Oil ", cost: "120.5", km: "", nextDate: "2027-02-01", nextKm: "45000", notes: " " }))
      .toEqual({ serviceDate: "2026-11-01", description: "Oil", workshop: null, costSen: 12050, odometerKm: null, nextServiceDate: "2027-02-01", nextServiceKm: 45000, notes: null });
  });
  it("needs a date and a description, and numbers of 0 or more", () => {
    expect(serviceProblem(BLANK_SERVICE)).not.toBeNull();
    expect(serviceProblem({ ...BLANK_SERVICE, date: "2026-11-01", what: "Oil" })).toBeNull();
    expect(serviceProblem({ ...BLANK_SERVICE, date: "2026-11-01", what: "Oil", nextKm: "-3" })).not.toBeNull();
  });
});
