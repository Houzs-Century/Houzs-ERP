// ----------------------------------------------------------------------------
// payment-slip-date — how far back a payment's TRANSACTION SLIP date may be
// dated when someone keys the payment in.
//
// Owner 2026-09-23: "sales order - collect payment / when key in payment -
// transaction slip date cannot [be] more than 2 week[s]". A receipt that
// surfaces weeks after the swipe lands in the wrong cash-up, and the further
// back it is dated the less anyone can still check it against a bank line.
//
// THE WINDOW IS `[today - 14 days, today]`, inclusive on both ends, in MALAYSIAN
// calendar days (the `today` the caller passes is already MYT — `todayMyt()` on
// either side of the wire). A future date is refused by the same rule: it is the
// typo half of the same field, and the two refusals read differently so the
// operator knows which way they slipped.
//
// FOUR READERS, ONE RULE. Desktop PaymentsTable, mobile RecordedPayments, the
// mobile New-SO payment row, and the backend write core (scm/lib/so-payment-row)
// all ask this module — nobody re-derives "14 days" from a Date. The frontend
// vendors a BYTE-IDENTICAL twin at frontend/src/vendor/scm/lib/payment-slip-date.ts;
// backend/scripts/check-shared-mirrors.mjs --strict is the referee, which is why
// this file imports nothing and knows no clock of its own.
//
// WHAT IT DOES NOT DECIDE: who may key an out-of-window date anyway. That is the
// `scm.payment.backdate` permission (services/permissions.ts) and its capability
// twin, read by the caller — a rule about dates has no business reading a user.
// ----------------------------------------------------------------------------

/** How many days before today a slip may still be dated. */
export const PAYMENT_SLIP_WINDOW_DAYS = 14;

export type PaymentSlipDateVerdict =
  | { ok: true }
  | { ok: false; code: 'unreadable' | 'too_old' | 'future'; reason: string };

/** `YYYY-MM-DD` → the same calendar date shifted by `days`. Returns '' when the
 *  input is not a real calendar date (so a caller can never shift garbage into
 *  a plausible-looking bound). */
export function shiftIsoDay(iso: string, days: number): string {
  if (!isIsoDate(iso)) return '';
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** The inclusive `{ min, max }` a slip date must fall in, given today's MY date.
 *  Feeds the native date picker's own bounds as well as the verdict below, so
 *  the calendar cannot offer a day the save would bounce. */
export function paymentSlipDateWindow(today: string): { min: string; max: string } {
  return { min: shiftIsoDay(today, -PAYMENT_SLIP_WINDOW_DAYS), max: today };
}

/** The verdict for one keyed-in slip date. `today` is the MY calendar date. */
export function checkPaymentSlipDate(
  paidAt: string | null | undefined,
  today: string,
): PaymentSlipDateVerdict {
  const iso = String(paidAt ?? '').slice(0, 10);
  if (!isIsoDate(iso)) return { ok: false, code: 'unreadable', reason: 'Enter the slip date as a real calendar date.' };
  const { min, max } = paymentSlipDateWindow(today);
  /* An unreadable `today` would make both bounds '' and every date "out of
     window" — refuse to judge instead of refusing the operator. */
  if (!min || !max) return { ok: true };
  if (iso > max) {
    return { ok: false, code: 'future', reason: `Slip date cannot be in the future. The latest you can key in is ${dmy(max)}.` };
  }
  if (iso < min) {
    return {
      ok: false,
      code: 'too_old',
      reason: `Slip date is more than ${PAYMENT_SLIP_WINDOW_DAYS} days old. The earliest you can key in is ${dmy(min)}.`,
    };
  }
  return { ok: true };
}

/** True for a `YYYY-MM-DD` that is a real calendar date (rejects 2026-02-31). */
function isIsoDate(iso: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** `2026-09-09` → `2026/09/09` — the year-first spelling every date field in this
 *  app shows (owner 2026-09-25), so the refusal names the bound the way the
 *  operator reads it. */
function dmy(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${y}/${m}/${d}`;
}
