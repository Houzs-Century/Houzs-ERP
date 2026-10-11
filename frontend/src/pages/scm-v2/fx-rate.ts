/**
 * The ONE rule for turning a keyed or stored foreign-exchange rate into the
 * number the money is actually converted at.
 *
 * WHY THIS FILE EXISTS — the screen and the write disagreed about zero.
 *
 * Every create/update handler in this folder already agreed that a blank,
 * zero, negative or unparseable foreign rate posts at 1, and each inlined its
 * own copy of that rule:
 *
 *     (Number(x) > 0 && Number.isFinite(Number(x))) ? Number(x) : 1
 *
 * The on-screen previews sitting a few lines away — including the two labelled
 * "posted to GL" — inlined a DIFFERENT rule:
 *
 *     Number(x) || 0
 *
 * which falls back to ZERO. So while the operator was still typing a rate, or
 * for any record whose stored rate was ever null or unparseable, the screen
 * read "= RM 0.00 posted to GL" for a voucher the backend would post at full
 * value. The preview was not merely imprecise, it contradicted the write it
 * was previewing, and it did so on the number the operator uses to decide
 * whether to press the button.
 *
 * Two disagreeing rules across six files is how they came to disagree in the
 * first place, so both halves now call this. The write paths keep their exact
 * previous behaviour (identical rule, identical result); only the previews
 * change, from a confident 0 to the rate that will really be used.
 *
 * A rate of 0 is treated as UNSET rather than as a real "converts to nothing"
 * rate, for the same reason a 0/0 3PL rate is not a free delivery: no currency
 * is ever worth nothing, so a 0 here always means nobody keyed it.
 */
export function resolveFxRate(raw: unknown): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/**
 * Turn "I paid RM 13,404.50 for a ¥21,625.00 invoice" into the exchange rate.
 *
 * WHY: nobody at Houzs thinks in rates. They pay a China supplier BEFORE the goods
 * and the invoice arrive, and what they know afterwards is the figure on the bank
 * transfer — the ringgit that left. `0.619838` is not a number anyone has; it is a
 * number they would have to work out, and working it out by hand is how a rate ends
 * up wrong by a factor of ten on a document that silently re-costs inventory.
 *
 * Both inputs are INTEGER SEN / CENTI in their own currency, which is how every
 * money field in this codebase travels. The rate is MYR per 1 unit of the foreign
 * currency, so the units cancel and the division is simply myr / foreign.
 *
 * Returns null — never 0, never NaN, never Infinity — for anything that is not a
 * derivable rate: a zero or missing foreign total (the divide-by-zero), a
 * zero/blank MYR figure (the operator has not typed it yet, which must not be read
 * as "the rate is 0"), or a negative. The caller leaves the existing rate alone on
 * null; a 0 folded into the rate field would be resolveFxRate'd back to 1 and post
 * the raw foreign figure as ringgit, which is exactly the mis-cost this whole
 * feature exists to stop.
 *
 * Rounded to 6 decimals to match the stored numeric(14,6) — so the rate the screen
 * shows is the rate the database will hold, not one that shifts on save.
 */
export function deriveRateFromMyrPaid(
  myrPaidSen: number | null | undefined,
  foreignFaceCenti: number | null | undefined,
): number | null {
  const myr = Number(myrPaidSen);
  const foreign = Number(foreignFaceCenti);
  if (!Number.isFinite(myr) || myr <= 0) return null;
  if (!Number.isFinite(foreign) || foreign <= 0) return null;
  const rate = Math.round((myr / foreign) * 1e6) / 1e6;
  return rate > 0 ? rate : null;
}
