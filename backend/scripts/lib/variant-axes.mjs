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
    { key: "seatHeight", label: "Seat Size", aliases: ["seatHeight", "depth", "seatSize"] },
    { key: "legHeight", label: "Leg Height", aliases: ["legHeight", "sofaLegHeight"], required: false },
    { key: "fabricCode", label: "Fabrics", aliases: ["fabricCode", "colorCode", "colourCode", "fabricColor"] },
  ],
};

export const isDivanOnly = (itemCode) => /\bDIVAN\s*ONLY\b/i.test(itemCode ?? "");
export const isDivanlessFrame = (itemCode) => /ADJUSTABLE|\(S?S\+S\)|DOUBLE\s*D[AE]C?KER|\bDDB/i.test(itemCode ?? "");

const DIVANLESS_AXES = new Set(["divanHeight", "legHeight", "gap"]);

/* A console is the table between two seats. It has no seat, so it can have no
   seat height, and asking for one reports a defect that cannot be fixed from
   any source. The owner stated the class directly (2026-08-11: "有些 sku 是没有
   的"), and the AutoCount sketches show it: on PO-009553 both seat boxes carry
   a figure and the console box is deliberately blank.

   Deliberately narrow. STOOL is NOT here - a stool is something you sit on, and
   no line currently reports it missing, so exempting it would be a guess with
   no case behind it. Add a piece here only with evidence that it has no seat. */
const SEATLESS_PIECE = /^(CONSOLE|CT)\b/i;
const compartmentOfCode = (itemCode) => {
  const c = String(itemCode ?? "").toUpperCase();
  const i = c.indexOf("-");
  return i < 0 ? "" : c.slice(i + 1);
};
export const isSeatlessPiece = (itemCode) => SEATLESS_PIECE.test(compartmentOfCode(itemCode));
const isEmpty = (v) => v === undefined || v === null || String(v).trim() === "";

export function missingVariantAxes(itemGroup, variants, itemCode) {
  const axes = REQUIRED_VARIANT_AXES_BY_CATEGORY[(itemGroup ?? "").toLowerCase()];
  if (!axes) return [];
  const v = variants ?? {};
  const skipGap = isDivanOnly(itemCode);
  const skipBase = isDivanlessFrame(itemCode);
  const skipSeat = isSeatlessPiece(itemCode);
  return axes.filter(
    (axis) =>
      axis.required !== false &&
      !(skipGap && axis.key === "gap") &&
      !(skipBase && DIVANLESS_AXES.has(axis.key)) &&
      !(skipSeat && axis.key === "seatHeight") &&
      axis.aliases.every((k) => isEmpty(v[k])),
  );
}

/* isColourKiv, mirrored from src/scm/shared/variant-summary.ts. A line that
   committed to a fabric SERIES (fabricId / fabricLabel) with the COLOUR still to
   come is KIV — a legitimate confirmed-order state that satisfies the fabric
   axis at confirm time and blocks the Processing Date instead. */
const kivStr = (v) => (v == null ? "" : String(v).trim());
export const isColourKiv = (variants) => {
  if (!variants || typeof variants !== "object") return false;
  if (!(kivStr(variants.fabricId) || kivStr(variants.fabricLabel))) return false;
  return !(
    kivStr(variants.fabricCode) || kivStr(variants.colorCode) ||
    kivStr(variants.colourCode) || kivStr(variants.colourLabel) ||
    kivStr(variants.fabricColor)
  );
};

/* missingConfirmVariantAxes, mirrored from so-variant-rule.ts.
   `itemCode` is REQUIRED here for the same reason it is required there: it is
   what decides the DIVAN ONLY / divanless / seatless exemptions, and an
   argument a caller may omit is an exemption that applies only where somebody
   remembered it. Pass null when a script genuinely has no code — nothing is
   exempted then. See BUG CLASS optional-param-noop in BUG-HISTORY.md.

   It exists so an audit script stops hand-porting the rule. Before this,
   check-so-noncatalog-lines.mjs carried a FIFTH copy of the axes table with no
   itemCode parameter at all, so every DIVAN ONLY / ADJUSTABLE / (S+S) /
   DOUBLE DECKER / DDB / CONSOLE line it looked at was reported as defective. */
export function missingConfirmVariantAxes(itemGroup, variants, itemCode) {
  const missing = missingVariantAxes(itemGroup, variants, itemCode);
  if (missing.length === 0) return missing;
  return isColourKiv(variants ?? null)
    ? missing.filter((axis) => axis.key !== "fabricCode")
    : missing;
}
