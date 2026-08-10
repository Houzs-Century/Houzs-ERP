// Mirror of REQUIRED_VARIANT_AXES_BY_CATEGORY + the two exemptions from
// src/scm/shared/so-variant-rule.ts, for .mjs audit scripts that cannot import
// TypeScript. Same reason phone-normalise.mjs exists.
//
// tests/variantAxesMirror.test.ts asserts this file and the TS source agree,
// so the copy cannot drift the way the rule did before so-variant-rule.ts
// centralised it (it had been hand-copied into four places).
//
// Owner's rules encoded here: a DIVAN ONLY line has no mattress Gap to state;
// adjustable / pull-out / double-decker frames have no divan base at all, so
// Divan Height, Leg Height and Gap are all exempt; the sofa Leg Height always
// carries a "Default" option, so it is never treated as missing.
export const REQUIRED_VARIANT_AXES_BY_CATEGORY = {
  bedframe: [
    { key: "divanHeight", label: "Divan Height", aliases: ["divanHeight"] },
    { key: "legHeight", label: "Leg Height", aliases: ["legHeight"] },
    { key: "gap", label: "Gap", aliases: ["gap"] },
    { key: "fabricCode", label: "Fabrics", aliases: ["fabricCode", "colorCode", "colourCode", "fabricColor"] },
  ],
  sofa: [
    { key: "seatHeight", label: "Seat Height", aliases: ["seatHeight", "depth"] },
    { key: "legHeight", label: "Leg Height", aliases: ["legHeight", "sofaLegHeight"], required: false },
    { key: "fabricCode", label: "Fabrics", aliases: ["fabricCode", "colorCode", "colourCode", "fabricColor"] },
  ],
};

export const isDivanOnly = (itemCode) => /\bDIVAN\s*ONLY\b/i.test(itemCode ?? "");
export const isDivanlessFrame = (itemCode) => /ADJUSTABLE|\(S?S\+S\)|DOUBLE\s*D[AE]C?KER|\bDDB/i.test(itemCode ?? "");

const DIVANLESS_AXES = new Set(["divanHeight", "legHeight", "gap"]);
const isEmpty = (v) => v === undefined || v === null || String(v).trim() === "";

export function missingVariantAxes(itemGroup, variants, itemCode) {
  const axes = REQUIRED_VARIANT_AXES_BY_CATEGORY[(itemGroup ?? "").toLowerCase()];
  if (!axes) return [];
  const v = variants ?? {};
  const skipGap = isDivanOnly(itemCode);
  const skipBase = isDivanlessFrame(itemCode);
  return axes.filter(
    (axis) =>
      axis.required !== false &&
      !(skipGap && axis.key === "gap") &&
      !(skipBase && DIVANLESS_AXES.has(axis.key)) &&
      axis.aliases.every((k) => isEmpty(v[k])),
  );
}
