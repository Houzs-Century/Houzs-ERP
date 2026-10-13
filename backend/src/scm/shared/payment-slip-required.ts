// ----------------------------------------------------------------------------
// payment-slip-required — a keyed-in Sales Order payment must carry its proof.
//
// Owner 2026-10-13, after Admin: "please make sure when collect payment is
// attached with slip" — Admin verifies every late payment with Finance before
// approving it, and a payment without its slip cannot be checked against a bank
// line at all. This REVERSES the 2026-08-13 ruling that made the slip optional
// on every SO path: 490 of the 856 payments keyed in the 30 days before this
// rule carried no slip.
//
// WHAT COUNTS AS THE PROOF. An uploaded slip session (the per-payment uploader),
// or a scanned card-terminal receipt (the Scan-Order flow — the receipt IS the
// slip). A CONVERTED row is money moved from another order, receipted when it
// was first collected, so it carries none; the system's mirror and refund rows
// are the same money and skip the rule with it.
//
// FIVE READERS, ONE RULE: the payments POST, the SO create, the backdate request
// and its approval, and the write core underneath them; the frontend vendors a
// BYTE-IDENTICAL twin at frontend/src/vendor/scm/lib/payment-slip-required.ts
// (backend/scripts/check-shared-mirrors.mjs --strict), which is why this file
// imports nothing.
// ----------------------------------------------------------------------------

/** The HTTP error code every refusal carries. */
export const SLIP_REQUIRED_CODE = 'slip_required';

/** The one sentence every surface shows for a payment keyed without its proof. */
export const SLIP_REQUIRED_REASON = 'Attach the payment slip or receipt photo. A payment cannot be saved without it.';

export type PaymentSlipVerdict =
  | { ok: true }
  | { ok: false; code: typeof SLIP_REQUIRED_CODE; reason: string };

/**
 * The verdict for one payment about to be written.
 *   `converted`  — the row is money moved from another order (or a system
 *                  mirror / refund of such money): no slip is ever asked.
 *   `hasSlip`    — an upload session, an R2 slip key or a scanned receipt key
 *                  is attached.
 */
export function checkPaymentSlip(input: { converted: boolean; hasSlip: boolean }): PaymentSlipVerdict {
  if (input.converted || input.hasSlip) return { ok: true };
  return { ok: false, code: SLIP_REQUIRED_CODE, reason: SLIP_REQUIRED_REASON };
}
