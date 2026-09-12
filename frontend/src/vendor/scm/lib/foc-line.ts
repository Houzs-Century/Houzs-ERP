// ----------------------------------------------------------------------------
// foc-line — "is this line free of charge?", once, for every document.
//
// Owner 2026-09-12: 「然后你的免费品（FOC）应该全部都要有，全部 documentation」.
//
// THERE IS NO FOC COLUMN, on any of the eleven line tables. A free line is one
// that CHARGES NOTHING, and that is a computed fact, not a stored flag — which
// is exactly why four surfaces had grown four different answers to it by
// 2026-09-12:
//
//   Sales Order (desktop)   unit_price_sen === 0 && total_sen === 0
//   Sales Invoice (desktop) unit_price_sen === 0 && (line_total_sen ?? 0) === 0
//   Delivery Order          Number(unit_price_sen ?? 0) === 0      <- price ONLY
//   Sales Order (mobile)    (unit_price_sen ?? 0) === 0 && lineTotalSen(it) === 0
//
// So a line billed at 0 with a non-zero total read **FOC on the delivery order
// and "Sale" on the invoice for the same goods**, and a line whose price was
// null read FOC on two surfaces and not on the other two. Purchase Order, Goods
// Receipt and Purchase Invoice had no badge at all.
//
// THE RULE, and what each half of it is for:
//
//   * `unitPriceSen` is 0 or absent — nothing is charged per unit. Absent counts
//     as zero: "no price" and "priced at zero" are the same thing to a customer,
//     and treating them differently is what made two surfaces disagree.
//   * AND the line total is 0 — so a line priced at 0 that still carries a
//     charge (a fee rebuilt into the total, a rounding line) is NOT called free
//     while it takes money. This is the half the delivery order was missing.
//   * OR the line is a PWP / promotional gift, which the sales order marks as
//     `variants.freeGift`. Such a line can carry a granted base price for
//     costing while still being free to the customer, so it must not depend on
//     the numbers at all.
//
// DISCOUNTED TO ZERO IS NOT FOC, deliberately. unit 100, discount 100, total 0
// is a line that was SOLD and then given away, and the document should keep
// saying so — the discount is the story, not the badge. Both desktop surfaces
// already behaved this way; this keeps it.
// ----------------------------------------------------------------------------

/** The shape every surface can supply — snake_case straight off the API, or the
 *  camelCase draft the editors carry. Both are accepted so no caller has to map
 *  a row into a third shape just to ask one question. */
export type FocLineInput = {
  unit_price_sen?: number | null;
  unitPriceSen?: number | null;
  line_total_sen?: number | null;
  lineTotalSen?: number | null;
  /** The Sales Order's own total column is `total_sen`, not `line_total_sen`. */
  total_sen?: number | null;
  variants?: { freeGift?: unknown } | Record<string, unknown> | null;
};

const num = (...vals: Array<number | null | undefined>): number => {
  for (const v of vals) if (typeof v === 'number' && Number.isFinite(v)) return v;
  return 0;
};

/** Does this line carry the sales order's promotional-gift marker? */
export const isFreeGiftLine = (line: FocLineInput): boolean => {
  const v = line.variants as { freeGift?: unknown } | null | undefined;
  const fg = v?.freeGift;
  return fg != null && fg !== false && fg !== '';
};

/**
 * Free of charge — the ONE answer every document uses.
 *
 * A caller that needs the numbers for something else should still ask this
 * rather than re-deriving it: the four copies this replaced disagreed in two
 * different ways, and neither disagreement was visible on the screen that had
 * it right.
 */
export const isFocLine = (line: FocLineInput): boolean => {
  if (isFreeGiftLine(line)) return true;
  const unit = num(line.unit_price_sen, line.unitPriceSen);
  const total = num(line.line_total_sen, line.lineTotalSen, line.total_sen);
  return unit === 0 && total === 0;
};

/** How many lines of a document are free — for the "N FOC lines included"
 *  footnote the Sales Order already prints, so the count and the badges can
 *  never disagree. */
export const focLineCount = (lines: ReadonlyArray<FocLineInput>): number =>
  lines.reduce((n, l) => n + (isFocLine(l) ? 1 : 0), 0);
