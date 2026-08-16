// ----------------------------------------------------------------------------
// so-balance-display — how a Sales-Order balance is READ off a list row and
// what colour it is drawn in.
//
// Its own module for two reasons. `MfgSalesOrdersListV2.tsx` sits exactly on its
// size ceiling and may only shrink, so new logic cannot live at the call site.
// And the answer is needed by more than one grid — the desktop SO list today,
// the mobile card and Delivery Planning if they ever show a signed figure —
// which is the shape that produced four hand-rolled copies of `total - paid`
// in the first place.
//
// The arithmetic itself is NOT here: it is `shared/so-balance.ts`, mirrored
// byte-for-byte from the backend. This module only picks the field and the ink.
// ----------------------------------------------------------------------------

/** The three balance-ish fields an SO list row can carry, newest first. */
export type SoBalanceRow = {
  /** SIGNED (may be negative) — stamped by GET /mfg-sales-orders since 2026-08-16. */
  balance_signed_centi?: number | null;
  /** local_total − Σ payments, FLOORED at 0 by the payment-totals view. */
  balance_centi_live?: number | null;
  /** Stored header column — the GROSS total, rewritten by recomputeTotals. Last resort. */
  balance_centi?: number | null;
};

/**
 * The number the Balance column shows.
 *
 * Ordered so the row degrades to its PREVIOUS behaviour, never to a wrong sign:
 * a payload from a backend that predates the signed stamp (mid-deploy, a cached
 * response) falls back to the floored view column and then to the stored header
 * value, which is what this column read before. Recomputing local_total − paid
 * here instead would be a fifth copy of a money rule.
 */
export function soRowBalanceCenti(r: SoBalanceRow): number {
  return r.balance_signed_centi ?? r.balance_centi_live ?? r.balance_centi ?? 0;
}

/**
 * The full className for a balance figure in a grid cell.
 *
 * RED once the balance is negative — the order has collected more than it is
 * worth, and the owner's ruling (2026-08-16) is that this is legal, visible and
 * red. Zero and positive keep the ink they have always had, so nothing that is
 * merely unpaid starts shouting.
 */
export function soBalanceCellClass(centi: number): string {
  return centi < 0
    ? 'font-money text-[13px] text-err font-semibold'
    : 'font-money text-[13px] text-ink';
}
