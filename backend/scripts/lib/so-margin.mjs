/* A sales order's margin fields, as the app's save writes them
   (recomputeTotals in backend/src/scm/routes/mfg-sales-orders.ts):

     line   line_margin_sen   = total_sen - line_cost_sen
     header total_revenue_sen = the sum of its live line totals, plus the
                                header delivery fee only when no SVC-DELIVERY
                                line carries it (a line-less legacy order)
            total_margin_sen  = total_revenue_sen - total_cost_sen
            margin_pct_basis  = margin / revenue in basis points, 0 with no revenue

   The nightly cost fill, the AutoCount import stamp and repair-so-margin-fields
   write through these, so a script never invents its own rounding. */

const DELIVERY_FEE_CODE = 'SVC-DELIVERY';

/** Margin over revenue in basis points (12.34% -> 1234), 0 with no revenue. */
export const marginPctBasis = (marginSen, revenueSen) =>
  revenueSen > 0 ? Math.round((marginSen / revenueSen) * 10000) : 0;

/** A line's margin: its total less its cost. */
export const lineMarginSen = (line) => (Number(line.total_sen) || 0) - (Number(line.line_cost_sen) || 0);

/** True when a header's margin or margin basis is not what its revenue and cost give. */
export function headerMarginOff(h) {
  const revenue = Number(h.total_revenue_sen) || 0;
  const margin = revenue - (Number(h.total_cost_sen) || 0);
  return Number(h.total_margin_sen) !== margin || Number(h.margin_pct_basis) !== marginPctBasis(margin, revenue);
}

const isDeliveryFeeCode = (code) => String(code ?? '').trim().toUpperCase().startsWith(DELIVERY_FEE_CODE);

/** The revenue a save gives an order with these live lines. */
export function savedRevenueSen(header, liveLines) {
  const lines = liveLines.reduce((s, l) => s + (Number(l.total_sen) || 0), 0);
  const feeOnLines = liveLines.some((l) => isDeliveryFeeCode(l.item_code));
  return lines + (feeOnLines ? 0 : Number(header.delivery_fee_sen) || 0);
}

/**
 * What one order needs so its margin fields read as a save would write them,
 * without moving any cost, selling price or order total.
 *
 * Revenue moves only on the AutoCount import's gap: a header revenue of 0 under
 * a positive order total takes that total, and only when the order's lines add
 * up to it (the revenue a save would give). Anything else that disagrees is
 * refused for a person to look at, never guessed.
 *
 * @param header { doc_no, status, local_total_sen, total_revenue_sen, total_cost_sen, total_margin_sen, margin_pct_basis, delivery_fee_sen }
 * @param lines  the order's lines: { id, item_code, total_sen, line_cost_sen, line_margin_sen, cancelled }
 * @returns { status: 'refused', why } | { status: 'ok', header: null | { total_revenue_sen, total_margin_sen, margin_pct_basis }, revenueFilled, lines: [{ id, from, to }] }
 */
export function planOrderMargins(header, lines) {
  const live = lines.filter((l) => !l.cancelled);
  const cost = Number(header.total_cost_sen) || 0;
  const lineCost = live.reduce((s, l) => s + (Number(l.line_cost_sen) || 0), 0);
  if (lineCost !== cost) return { status: 'refused', why: 'its header cost is not the sum of its lines; save the order in the app first' };

  const total = Number(header.local_total_sen) || 0;
  const stored = Number(header.total_revenue_sen) || 0;
  let revenue = stored;
  if (stored === 0 && total > 0) {
    if (savedRevenueSen(header, live) !== total) return { status: 'refused', why: 'its revenue is 0 and its lines do not add up to its order total' };
    revenue = total;
  } else if (stored !== total) {
    return { status: 'refused', why: 'its revenue is not its order total' };
  }

  const margin = revenue - cost;
  const pct = marginPctBasis(margin, revenue);
  const headerMoves = revenue !== stored || margin !== Number(header.total_margin_sen) || pct !== Number(header.margin_pct_basis);
  const lineMoves = live
    .filter((l) => Number(l.line_margin_sen) !== lineMarginSen(l))
    .map((l) => ({ id: l.id, from: Number(l.line_margin_sen), to: lineMarginSen(l) }));
  return {
    status: 'ok',
    header: headerMoves ? { total_revenue_sen: revenue, total_margin_sen: margin, margin_pct_basis: pct } : null,
    revenueFilled: revenue !== stored,
    lines: lineMoves,
  };
}
