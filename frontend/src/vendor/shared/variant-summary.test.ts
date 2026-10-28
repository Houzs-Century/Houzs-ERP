import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildVariantSummary, foldRedundantSpecials } from "./variant-summary";

/* Two things are pinned here.
 *
 * 1. The SPECIAL segment prints one request ONCE. The migrated-corpus backfill
 *    (backend/scripts/backfill-specials-into-variants.mjs) is merge-only by
 *    owner rule — it machine-asserts that it never removes a pre-existing
 *    entry — so a line legitimately stores both the parser's glued phrase and
 *    the picker code derived from it. The stored data is correct; the doubled
 *    rendering was the defect, and it is resolved here and nowhere else.
 *
 * 2. This file and backend/src/scm/shared/variant-summary.ts are byte-
 *    identical. They were already two hand-maintained copies of one module
 *    with NOTHING guarding them, and this change had to land in both: the
 *    Worker stamps description2 from the backend copy while the SO detail page
 *    (pages/scm-v2/SalesOrderDetailV2.tsx) recomputes the same summary in the
 *    browser from this one and PREFERS its result. A fix applied to one copy
 *    would look correct on whichever surface the author happened to open.
 */

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
    // Same identity, different dress: the owner's spaced code beats the glued one.
    expect(foldRedundantSpecials(["NILONFABRIC", "Nylon Fabric"])).toEqual(["Nylon Fabric"]);
    expect(foldRedundantSpecials(["Nylon Fabric", "NILONFABRIC"])).toEqual(["Nylon Fabric"]);
  });

  test("a multi-word operator request is NEVER hidden", () => {
    // Real production pairs that share a topic but are distinct requests.
    expect(foldRedundantSpecials(["Leg Change Altay Leg Grossy Black Leg", "Change 8030 Backcushion"]))
      .toEqual(["Leg Change Altay Leg Grossy Black Leg", "Change 8030 Backcushion"]);
    expect(foldRedundantSpecials(["6\" wooden leg", "Nylon Fabric"]))
      .toEqual(["6\" wooden leg", "Nylon Fabric"]);
    // Narrower live picker code beside a wider one: both are multi-word, both stay.
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
  /* An AutoCount-imported line's slip asked for a PRICED option. Recording it
     must let the factory see what to build without re-charging a closed
     document, so it lives in variants.specialsRecorded - a key NO pricing path
     reads (that is the whole safety property; see
     backend/scripts/record-priced-specials-on-migrated-lines.mjs). Description 2
     is the surface that carries it to the factory, so it renders HERE. */
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
    const here = readFileSync(resolve(__dirname, "variant-summary.ts"), "utf8");
    const there = readFileSync(
      resolve(__dirname, "../../../../backend/src/scm/shared/variant-summary.ts"),
      "utf8",
    );
    expect(here).toBe(there);
  });
});
