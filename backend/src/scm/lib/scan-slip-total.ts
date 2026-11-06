// A scanned slip often writes its money only in the AMOUNT / TOTAL boxes, not
// per-line unit prices. Every line then reads unpriced (0), and the background
// draft was created at RM 0 even though the slip's TOTAL was read (HC-0214).
// The slip total is a value the slip states, not a guess, so it is carried onto
// the first line as the package total, the same rule the OCR prompt applies to
// a set price (scan-so.ts, priceRmGuess).
// shortcut: the whole total (transport included) sits on line 1; the operator
// splits it on review against the slip photo.
export function applySlipTotalToUnpricedLines(
  items: Array<Record<string, unknown>>,
  slipTotalRm: number | null,
): void {
  const first = items[0];
  if (!first || !(typeof slipTotalRm === 'number' && slipTotalRm > 0)) return;
  if (items.some((it) => Number(it.unitPriceSen) > 0)) return;
  const qty = Number(first.qty) > 0 ? Number(first.qty) : 1;
  first.unitPriceSen = Math.round((slipTotalRm * 100) / qty);
}
