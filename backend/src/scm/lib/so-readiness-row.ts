// ----------------------------------------------------------------------------
// so-readiness-row — the FOUR stock fields a board row carries, in one place.
//
// They exist because they answer four different questions, and the bug this
// module was extracted for is what happens when a caller answers one of them
// with a string it made up locally.
//
//   stock_status   a STATUS: 'READY' | 'PENDING'. TWO values. There is no third.
//   stock_remark   the LABEL: '' | 'READY' | 'PARTIAL' | 'BEDFRAME/ACC' — what
//                  IS ready. summariseReadiness owns the vocabulary; never
//                  build a string here.
//   is_main_ready  every MAIN line allocated. VACUOUSLY TRUE when the SO has no
//                  main line at all, so it is NOT a shipping gate. Kept because
//                  published consumers read it.
//   is_ship_ready  THE shipping gate. Use this one.
//
// WHY THIS IS A MODULE AND NOT FOUR LINES IN THE ROUTE. On 2026-08-16 the owner
// ruled that "READY (PARTIAL)" is a lie on an accessory-only order — it claimed
// a readiness the order did not have — and it was removed from the readiness
// rollup. routes/delivery-planning.ts did not take its label FROM that rollup;
// it built a second vocabulary inline, kept emitting the retired string as
// stock_status, and DeliveryPlanningBoard groups on exactly that field. So the
// board printed a "READY (PARTIAL)" group header over rows whose own cell read
// the corrected label — the retired string and its replacement, one screen,
// same moment. One rule expressed twice is the repeat offender here; this is
// the one expression. It is why the vocabulary could move AGAIN the same day
// (the label is the READY side once more, "PARTIAL" without the "READY ")
// without any board re-growing a copy of it.
//
// A row with no stock to be ready for (ASSR jobs, delivery-planning jobs,
// project setup/dismantle) spreads NO_STOCK_ROW so it cannot answer these
// questions by accident, and so the row shape stays uniform for the caller.
// ----------------------------------------------------------------------------

/** Just enough of summariseReadiness's result to fill a row — deliberately not
 *  the whole summary, so this module cannot grow into a second rollup. */
export type ReadinessRowInput = {
  isFullyReady: boolean;
  isShipReady: boolean;
  isMainReady: boolean;
  stockRemark: string;
};

export type ReadinessRowFields = {
  stock_status: string | null;
  stock_remark: string | null;
  is_main_ready: boolean | null;
  is_ship_ready: boolean | null;
};

/** The four fields for a stock-bearing row. `| null` in the return type so a
 *  caller can hold these and NO_STOCK_ROW in one array without widening. */
export function readinessRowFields(r: ReadinessRowInput): ReadinessRowFields {
  return {
    stock_status: r.isFullyReady ? 'READY' : 'PENDING',
    stock_remark: r.stockRemark,
    is_main_ready: r.isMainReady,
    is_ship_ready: r.isShipReady,
  };
}

/** A row that carries no stock at all. Not "nothing is ready" — the question
 *  does not apply, which is why every field is null rather than false/''. */
export const NO_STOCK_ROW: ReadinessRowFields = {
  stock_status: null,
  stock_remark: null,
  is_main_ready: null,
  is_ship_ready: null,
};
