import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildVariantSummary, foldRedundantSpecials } from "./variant-summary";


const SOFA = "SOFA";
const BEDFRAME = "BEDFRAME";

describe("foldRedundantSpecials", () => {
  test("hides the glued twin of a picker code (HC-SO-011733 / 9058-2A(LHF))", () => {
    expect(foldRedundantSpecials([
      "BACKCUSHIONCHANGE8030", "Change 8030 Backcushion", "Wooden Arm",
    ])).toEqual(["Change 8030 Backcushion", "Wooden Arm"]);
  });

  test("hides a fragment contained in a richer entry, keeping the picker code", () => {
    expect(foldRedundantSpecials(["nylon", "Nylon Fabric"])).toEqual(["Nylon Fabric"]);
    expect(foldRedundantSpecials(["Nylon Fabric", "nylon"])).toEqual(["Nylon Fabric"]);
    expect(foldRedundantSpecials(["8030", "Change 8030 Backcushion"])).toEqual(["Change 8030 Backcushion"]);
  });

  test("nilon and nylon are one identity, and the spaced picker code survives", () => {
    expect(foldRedundantSpecials(["NILON", "nylon", "Nylon Fabric"])).toEqual(["Nylon Fabric"]);
    expect(foldRedundantSpecials(["NILONFABRIC", "Nylon Fabric"])).toEqual(["Nylon Fabric"]);
    expect(foldRedundantSpecials(["Nylon Fabric", "NILONFABRIC"])).toEqual(["Nylon Fabric"]);
  });

  test("a multi-word operator request is NEVER hidden", () => {
    expect(foldRedundantSpecials(["Leg Change Altay Leg Grossy Black Leg", "Change 8030 Backcushion"]))
      .toEqual(["Leg Change Altay Leg Grossy Black Leg", "Change 8030 Backcushion"]);
    expect(foldRedundantSpecials(["6\" wooden leg", "Nylon Fabric"]))
      .toEqual(["6\" wooden leg", "Nylon Fabric"]);
    expect(foldRedundantSpecials(["Backcushion Firmer", "Seat and Backcushion Firmer"]))
      .toEqual(["Backcushion Firmer", "Seat and Backcushion Firmer"]);
  });

  test("semantic pairs are deliberately left alone (they need the owner's phrase ruling)", () => {
    expect(foldRedundantSpecials(["NOSTICHINGINSITTINGAREA", "No notch on Seat Cushion"]))
      .toEqual(["NOSTICHINGINSITTINGAREA", "No notch on Seat Cushion"]);
    expect(foldRedundantSpecials(["BACKRESTCHANGE8030", "Change 8030 Backcushion"]))
      .toEqual(["BACKRESTCHANGE8030", "Change 8030 Backcushion"]);
  });

  test("never empties the list, and leaves an already-clean list untouched", () => {
    expect(foldRedundantSpecials(["nylon", "NYLON", "Nylon"])).toHaveLength(1);
    expect(foldRedundantSpecials(["Wooden Arm", "Nylon Fabric", "Left Drawer"]))
      .toEqual(["Wooden Arm", "Nylon Fabric", "Left Drawer"]);
    expect(foldRedundantSpecials(["Wooden Arm"])).toEqual(["Wooden Arm"]);
    expect(foldRedundantSpecials([])).toEqual([]);
  });
});

describe("buildVariantSummary — SPECIAL segment", () => {
  test("the reported line renders each request once", () => {
    const summary = buildVariantSummary(SOFA, {
      fabricCode: "CH141-8-ARMY",
      seatHeight: "30",
      legHeight: "DEFAULT",
      specials: ["BACKCUSHIONCHANGE8030", "Change 8030 Backcushion", "Wooden Arm"],
    });
    expect(summary).toBe(
      "CH141-8-ARMY / SEAT 30 / LEG DEFAULT / SPECIAL: Change 8030 Backcushion + Wooden Arm",
    );
    expect(summary).not.toContain("BACKCUSHIONCHANGE8030");
  });

  test("a clean line is byte-for-byte unchanged by the fold", () => {
    expect(buildVariantSummary(SOFA, {
      fabricCode: "CH141-8-ARMY",
      seatHeight: "30",
      legHeight: "DEFAULT",
      specials: ["Change 8030 Backcushion", "Wooden Arm"],
    })).toBe("CH141-8-ARMY / SEAT 30 / LEG DEFAULT / SPECIAL: Change 8030 Backcushion + Wooden Arm");
  });

  test("the surviving entry keeps its specialChoices suffix", () => {
    expect(buildVariantSummary(SOFA, {
      specials: ["nylon", "Nylon Fabric", "Right Drawer"],
      specialChoices: { "Right Drawer": ["10\""] },
    })).toBe("SPECIAL: Nylon Fabric + Right Drawer (10\")");
  });
});

describe("buildVariantSummary - recorded-only specials (owner choice 甲, 2026-09-03)", () => {
  test("a recorded option prints in the same SPECIAL segment", () => {
    expect(buildVariantSummary(BEDFRAME, {
      specialsRecorded: ["HB Fully Cover"],
    })).toBe("SPECIAL: HB Fully Cover");
  });

  test("picked and recorded options print together, picked first", () => {
    expect(buildVariantSummary(BEDFRAME, {
      specials: ["HB Straight"],
      specialsRecorded: ["HB Fully Cover"],
    })).toBe("SPECIAL: HB Straight + HB Fully Cover");
  });

  test("a code the operator has since PICKED is never printed twice", () => {
    expect(buildVariantSummary(BEDFRAME, {
      specials: ["HB Fully Cover"],
      specialsRecorded: ["HB Fully Cover"],
    })).toBe("SPECIAL: HB Fully Cover");
  });

  test("no recorded codes leaves the rendering byte-for-byte unchanged", () => {
    expect(buildVariantSummary(BEDFRAME, { specials: ["HB Straight"], specialsRecorded: [] }))
      .toBe(buildVariantSummary(BEDFRAME, { specials: ["HB Straight"] }));
  });
});

describe("the two copies of variant-summary.ts are identical", () => {
  test("frontend/src/vendor/shared === backend/src/scm/shared, byte for byte", () => {
    const here = readFileSync(resolve(__dirname, "../../../../shared/src/vendor/shared/variant-summary.ts"), "utf8");
    const there = readFileSync(
      resolve(__dirname, "../../../../backend/src/scm/shared/variant-summary.ts"),
      "utf8",
    );
    expect(here).toBe(there);
  });
});
