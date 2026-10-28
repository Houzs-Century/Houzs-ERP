// ----------------------------------------------------------------------------
// composeSoLineDescription — build the multi-line "Description" cell for one SO
// line in the backend Sales Order PDF. Pure + unit-tested.
//
// The cell stacks: the SKU description, ONE variant-summary line, any PWP notes,
// and (when not already shown) a "Remark:" line.
//
// Loo 2026-06-13 — the stored `description2` and the recomputed `specs`
// (variantLine) are BOTH buildVariantSummary outputs, so on a variant line they
// fully overlap. Printing both duplicated the "SEAT … / SPECIAL: …" segment
// (one sofa module line showed the special add-on twice). `description2` is
// always auto-generated from the same variants, and `specs` is the fresher,
// fabric-expanded superset — so we print `specs` as the single variant-summary
// line and fall back to `description2` only when there is no recomputed summary
// (e.g. service / no-variant lines). The variant info then prints exactly once.
// ----------------------------------------------------------------------------

export interface SoLineDescriptionParts {
  /** SKU description, e.g. "SOFA ANNSA 1A(LHF)". */
  description: string;
  /** Stored description2 (buildVariantSummary at create/patch time), trimmed. */
  description2: string;
  /** Recomputed variantLine at print (fabric-expanded buildVariantSummary). */
  specs: string;
  /** Per-line item remark (trimmed) or null. */
  remark: string | null;
  /** PWP / trigger note lines, already resolved to text. */
  notes?: string[];
}

export function composeSoLineDescription(p: SoLineDescriptionParts): string[] {
  // One variant-summary line — specs (fresh, fabric-expanded) supersedes the
  // stored description2; description2 is the fallback only when specs is empty.
  const variantSummary = (p.specs || p.description2 || '').trim();
  const remark = p.remark && p.remark.trim() !== '' ? p.remark.trim() : null;
  // Suppress the separate "Remark:" line when the variant summary already shows
  // the same text verbatim (legacy pre-split rows folded the remark into it).
  const remarkShownAbove = remark !== null && variantSummary.includes(remark);
  return [
    p.description,
    variantSummary || (remarkShownAbove ? null : remark),
    ...(p.notes ?? []),
    variantSummary && remark && !remarkShownAbove ? `Remark: ${remark}` : null,
  ].filter((x): x is string => Boolean(x));
}
