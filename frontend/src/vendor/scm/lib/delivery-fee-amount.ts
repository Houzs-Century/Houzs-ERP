/**
 * The delivery fee's amount cell, expressed as a discount.
 *
 * The fee itself is DERIVED (owner 2026-08-07, "every ringgit is a LINE"), so a
 * typed unit price cannot survive: the next rebuild re-derives it and the
 * operator watches 250 -> 125 snap back. The sanctioned reduction is the line
 * DISCOUNT — the line PATCH has always accepted one bounded 0..qty x unit, and
 * #2490 taught the fee rebuild to carry it across a rebuild — so the SO Detail
 * amount cell reads the NET on a fee line and writes the difference here.
 *
 * Kept out of SoLineCard.tsx so it can be executed by a test rather than
 * pinned by reading the JSX.
 */

/**
 * Does the amount cell edit this line as a FEE (type the amount to charge), or
 * as a plain unit price? The verdict is LOCKED for the life of the mounted
 * line: `prev` is the last verdict (null = none yet), and once made it never
 * changes while the line stays a fee code.
 *
 * Two shipped regressions, one per unlocked half:
 *  · gross-decides, evaluated live (#2516): a hand-added fee line on a NEW SO
 *    starts at 0, so a typed 250 was read as "charge 250", booked a discount of
 *    max(0 - 250, 0) = 0, never wrote a price, and snapped back to RM 0. You
 *    cannot discount a fee that does not exist yet.
 *  · gross-decides, still evaluated live (#2527): the first KEYSTROKE fixed
 *    that and created the flip. Typing "250" writes RM 2 as a unit price, the
 *    gross is now positive, the very next render flips the cell to
 *    amount-to-charge, and "25…" reads as a target >= the RM 2 gross — no
 *    discount, and the sync-back pins the box at 2.00 forever.
 *
 * So the decision is made ONCE, from the gross the line had when it became a
 * fee line under this mount: a line that ARRIVES priced edits as a fee, a line
 * being AUTHORED from 0 stays a plain price until it is saved and re-mounted.
 * Leaving fee code (product pick over the line) resets the verdict.
 */
export function lockedFeeSemantics(
  prev: boolean | null,
  isFeeCode: boolean,
  grossSen: number,
): boolean | null {
  if (!isFeeCode) return null;
  return prev === null ? safe(grossSen) > 0 : prev;
}

/** What the amount cell SHOWS on a fee line: the line net, never below zero. */
export function feeAmountSen(grossSen: number, discountSen: number): number {
  return Math.max(0, safe(grossSen) - safe(discountSen));
}

/**
 * The discount that makes a fee line charge `typedSen`.
 *
 * Clamped at both ends, matching the server's own bound (0 <= discount <=
 * qty x unit):
 *  · a figure at or above the gross is not a reduction, so it yields NO
 *    discount rather than a negative one. Charging MORE is what the
 *    SVC-DELIVERY-ADD line is for, and silently inventing a negative discount
 *    would be a fee rise with no line naming it — the back door the owner
 *    ruled out;
 *  · a negative or nonsense figure cannot discount more than the line holds,
 *    or the line total would go negative and the PATCH would 422.
 */
export function feeDiscountForAmount(grossSen: number, typedSen: number): number {
  const gross = safe(grossSen);
  /* An unreadable figure means NO discount, never a full one. Rounding it to
     zero the way `safe` does elsewhere would read as "charge nothing" and
     waive the whole fee — so garbage fails towards charging the derived
     amount. A deliberate waiver is still available: it is typed as 0. */
  if (!Number.isFinite(typedSen)) return 0;
  return Math.min(Math.max(gross - Math.round(typedSen), 0), gross);
}

/** NaN/Infinity from a half-typed number input must not become money. */
function safe(n: number): number {
  return Number.isFinite(n) ? Math.round(n) : 0;
}
