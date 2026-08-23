// ----------------------------------------------------------------------------
// si-outstanding — what a SALES INVOICE still owes, in ONE place.
//
// WHY THIS FILE EXISTS. On 2026-08-23 the invoice DETAIL page learned that a
// deposit taken on the source Sales Order settles part of the invoice, and no
// other screen did. Measured on production the same day: `HC-SI-2608-004`
// showed 2,400 on the detail page and 4,400 on the LIST, the list's Outstanding
// KPI, the cards, the mobile list, the PDF the customer receives and the
// Outstanding ledger. The list is the screen the office scans to decide who to
// chase, so the half that was wrong was the half that mattered.
//
// Six surfaces had six copies of `Math.max(0, total - paid)`. A seventh copy
// that also subtracted the deposit would have been a seventh thing to remember,
// so there is now one function and the copies call it.
//
// THE FIGURE IS SERVED, NOT COMPUTED HERE. The split of one order's deposit
// across its invoices depends on the invoice's SIBLINGS, which no screen can
// see — the backend stamps `so_deposit_applied_sen` on every invoice row and
// header (backend/src/scm/lib/si-order-deposit.ts). This module only reads it.
//
// `paid_sen` still means what it always meant: receipts banked against THIS
// invoice. The two are kept apart on purpose so a screen can say which document
// took the money.
// ----------------------------------------------------------------------------

/** Any shape carrying the server-stamped slice. */
export type WithOrderDeposit = { so_deposit_applied_sen?: number | null };

/**
 * The slice of the ORDER's deposit applied to this invoice, in sen.
 *
 * `null` / absent is the server saying it could NOT resolve the order, and it
 * reads as 0 — which renders the LARGER outstanding. That is deliberate and it
 * is the only direction this may be wrong in: a screen that over-states what is
 * owed sends someone to check, while one that under-states loses the money.
 */
export const siDepositAppliedSen = (r: WithOrderDeposit | null | undefined): number => {
  const v = Number(r?.so_deposit_applied_sen ?? 0);
  return Number.isFinite(v) && v > 0 ? v : 0;
};

/** Everything settling this invoice: its own receipts PLUS the order's deposit. */
export const siSettledSen = (paidSen: number, depositSen: number): number =>
  (Number.isFinite(paidSen) ? paidSen : 0) + (Number.isFinite(depositSen) ? depositSen : 0);

/**
 * What the invoice still owes. Floored at 0 — an over-payment is a customer
 * credit, and every screen this replaces already floored it.
 *
 * `depositSen` is REQUIRED, not optional. Its absence changes the answer, so an
 * optional parameter would leave every caller that forgot it silently rendering
 * the old, wrong figure with no compile error — the bug class CLAUDE.md calls
 * `optional-param-noop`.
 */
export const siOutstandingSen = (totalSen: number, paidSen: number, depositSen: number): number =>
  Math.max(0, (Number.isFinite(totalSen) ? totalSen : 0) - siSettledSen(paidSen, depositSen));
