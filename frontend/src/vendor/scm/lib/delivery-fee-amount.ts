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
