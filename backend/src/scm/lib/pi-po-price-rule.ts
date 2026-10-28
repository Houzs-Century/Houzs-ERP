// ----------------------------------------------------------------------------
// pi-po-price-rule — the PURE half of the purchase-order-price-vs-invoice-price
// rule, as ONE byte-identical file in two trees:
//   backend/src/scm/lib/pi-po-price-rule.ts      (the API, the list marker)
//   frontend/src/vendor/scm/lib/pi-po-price-rule.ts  (editor, detail, phone)
// refereed by frontend/src/vendor/scm/lib/pi-po-price-rule.canonical.test.ts,
// so a screen and the server cannot disagree about when two prices "differ".
//
// Owner 2026-09-12: 「PI 应该要有两个价钱」; 2026-09-14: the PO price is a
// reference only — 「我 PI 要填多少钱都是我喜欢的」. Nothing here blocks or warns.
//
// A PO price of 0 is UNPRICED, never a difference: measured 2026-09-12 on 115
// live lines, 78 carried an order that named no price (docs/bugs/0845).
// No imports on purpose — the file must stay identical in both trees.
// ----------------------------------------------------------------------------

/** The one comparison, so the API, the UI and any report agree on the word. */
export type PiLinePriceComparison = {
  /** Ordered price, or null when this line has no purchase-order line behind it. */
  poUnitPriceSen: number | null;
  /** What the supplier billed — the PI line's own unit price. */
  supplierUnitPriceSen: number;
  /** supplier - PO, per unit. null when there is nothing to compare against. */
  diffSen: number | null;
  /** True only when the two are BOTH known and differ. */
  differs: boolean;
};

export const comparePiLinePrice = (
  supplierUnitPriceSen: number,
  poUnitPriceSen: number | null,
): PiLinePriceComparison => {
  const supplier = Number.isFinite(supplierUnitPriceSen) ? supplierUnitPriceSen : 0;
  /* `0` joins `null` here: an order that named no price cannot be over- or
     under-billed against. See the measurement in the header — 68% of live lines
     are this case, and calling them differences hides the 1.7% that are. */
  if (poUnitPriceSen == null || poUnitPriceSen === 0) {
    return { poUnitPriceSen, supplierUnitPriceSen: supplier, diffSen: null, differs: false };
  }
  const diff = supplier - poUnitPriceSen;
  return {
    poUnitPriceSen,
    supplierUnitPriceSen: supplier,
    diffSen: diff,
    differs: diff !== 0,
  };
};

/** The header line a person checking the bill reads first: how many lines
 *  differ, and by how much in total (qty x per-unit difference). */
export const piPriceDifferenceSummary = (
  lines: ReadonlyArray<{ qty?: number | null; supplierUnitPriceSen: number; poUnitPriceSen: number | null }>,
): { linesDiffering: number; totalDiffSen: number } => {
  let linesDiffering = 0;
  let totalDiffSen = 0;
  for (const l of lines) {
    if (l.poUnitPriceSen == null || l.poUnitPriceSen === 0) continue;
    const diff = l.supplierUnitPriceSen - l.poUnitPriceSen;
    if (diff === 0) continue;
    linesDiffering += 1;
    totalDiffSen += diff * (Number(l.qty ?? 0) || 0);
  }
  return { linesDiffering, totalDiffSen };
};

/** What a NEW invoice line's unit price starts at (owner 2026-09-14: 「create 的
 *  时候，系统肯定会把 PO 的价钱直接带过来」): the purchase order's price when the
 *  order named one, otherwise the receipt line's — which is where a price keyed
 *  at receiving lives when the order had none. Only a default; the operator
 *  types over it freely and nothing compares or blocks. */
export const defaultPiUnitPriceSen = (poUnitPriceSen: number | null | undefined, grnUnitPriceSen: number | null | undefined): number => {
  if (typeof poUnitPriceSen === 'number' && Number.isFinite(poUnitPriceSen) && poUnitPriceSen > 0) return poUnitPriceSen;
  return typeof grnUnitPriceSen === 'number' && Number.isFinite(grnUnitPriceSen) ? grnUnitPriceSen : 0;
};
