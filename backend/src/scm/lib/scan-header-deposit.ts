// The safe header deposit for a scanned Sales Order draft — a PURE decision the
// background scan job relies on, pinned by scanHeaderDeposit.test.ts because
// route-level coverage of runScanJob isn't possible in this harness (it rides
// Supabase Postgres + R2 + the Anthropic call).
//
// WHY THIS EXISTS
//
// Paid is the header aggregate `paid_sen_total`, computed by `soPaidSen`
// (backend/src/scm/shared/so-outstanding.ts:102):
//   (depositInLedger ? 0 : headerDepositSen) + ledgerPaidSen
// So a header `deposit_sen` is only safe when an `is_deposit` ledger row already
// represents it — otherwise it is added ON TOP of every ordinary payment the
// operator records later, and the deposit is double-counted (a customer who paid
// RM1,400 showed RM2,800; see docs/bugs/0785-*). soPaidSen's own docstring names
// the assumption this restores: "the SO create path writes the deposit as a
// ledger row ... adding the header column on top would DOUBLE COUNT".
//
// A scan books that backing `is_deposit` row ONLY in recordScanReceiptPayments,
// and ONLY for a NON-shell draft with a CLASSIFIED payment receipt (the shell
// paths return before the receipt pass; a receiptless slip books nothing). So the
// slip's handwritten deposit is safe to stamp ONLY in that same case. Everywhere
// else it is dropped, and the operator adds the payment on the draft — the owner
// rule the scan module already states ("never book money off an unclassified
// photo"). The receipt-backed case keeps the figure unchanged: its is_deposit row
// makes soPaidSen ignore the header anyway, so reports/PDF still read the deposit.

export interface ScanDepositContext {
  /** The draft is a SHELL (required fields unread) — it returns before the
   *  receipt-payment pass, so no is_deposit row will ever back a deposit. */
  isShell: boolean;
  /** The scan classified at least one uploaded image as a payment RECEIPT, so
   *  recordScanReceiptPayments will book an is_deposit ledger row for it. */
  hasClassifiedReceipt: boolean;
}

/**
 * The `deposit_sen` that is SAFE to stamp on a scan draft header: the slip's
 * figure only when a receipt will book the backing is_deposit row, else 0.
 *
 * @param slipDepositSen the deposit read off the slip, in sen (0 / non-finite /
 *        negative all collapse to 0 — a negative would deflate the paid rollup).
 */
export function safeScanDepositSen(
  slipDepositSen: number,
  ctx: ScanDepositContext,
): number {
  if (!Number.isFinite(slipDepositSen) || slipDepositSen <= 0) return 0;
  return !ctx.isShell && ctx.hasClassifiedReceipt ? Math.round(slipDepositSen) : 0;
}
