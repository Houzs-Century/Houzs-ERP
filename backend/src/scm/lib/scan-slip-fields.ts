// The slip fields the OCR report (services/ocrStats.ts) and the correction capture
// (scan-sample-review.ts) both compare, kept in one place so they cannot drift apart.

export const HEADER_FIELDS: Array<[string, string]> = [
  ["customerName", "Customer name"],
  ["addressLine1", "Address"],
  ["address", "Address"],
  ["city", "City"],
  ["postcode", "Postcode"],
  ["addressStateMatch", "State"],
  ["phones", "Phone"],
  ["customerSoRef", "Customer ref"],
  ["customerTypeMatch", "Customer type"],
  ["buildingTypeMatch", "Building type"],
  ["paymentMethodMatch", "Payment method"],
  ["bankMatch", "Bank"],
  ["approvalCode", "Approval code"],
  ["depositRm", "Deposit"],
  ["deliveryDate", "Delivery date"],
];
export const LINE_FIELDS: Array<[string, string]> = [
  ["skuMatch", "Product code"],
  ["qtyGuess", "Qty"],
  ["fabricMatch", "Fabric code"],
  ["specialsMatch", "Special order"],
];
export const LINES_CHANGED = "Line added/removed";

export const j = (v: unknown): string => JSON.stringify(v ?? null);
export const asObj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/**
 * The draft builder (routes/scan-so.ts buildDraftSoBodyFromSlip) skips a slip
 * line that has neither a catalog SKU nor any raw text. The correction capture
 * uses the same test so its line counts match the draft's.
 */
export function isDroppedBlankLine(rawText: unknown, hasCatalogSku: boolean): boolean {
  return !hasCatalogSku && (typeof rawText === "string" ? rawText : "").trim() === "";
}

/**
 * Which fields the operator changed, read from a CONFIRMED sample.
 * buildCorrectedSlipFromSo (scm/lib/scan-sample-review.ts) overwrites only the
 * keys whose value moved, so a key-by-key compare is the diff.
 */
export function changedFields(extracted: unknown, corrected: unknown): string[] {
  const ai = asObj(extracted);
  const op = asObj(corrected);
  if (!ai || !op) return [];
  const out = new Set<string>();
  for (const [key, label] of HEADER_FIELDS) if (j(ai[key]) !== j(op[key])) out.add(label);
  const aiLines = Array.isArray(ai.lines) ? (ai.lines as Array<Record<string, unknown>>) : [];
  const opLines = Array.isArray(op.lines) ? (op.lines as Array<Record<string, unknown>>) : [];
  if (aiLines.length !== opLines.length) {
    // ponytail: with a line added or removed the per-line fields are not compared;
    // pairing lines would need alignSoLinesToSlip's matching, add it if this hides misses.
    out.add(LINES_CHANGED);
  } else {
    // Compared as sorted lists so the review's line re-ordering is not a change.
    const col = (lines: Array<Record<string, unknown>>, key: string) => lines.map((l) => j(asObj(l)?.[key])).sort().join("|");
    for (const [key, label] of LINE_FIELDS) if (col(aiLines, key) !== col(opLines, key)) out.add(label);
  }
  return [...out];
}
