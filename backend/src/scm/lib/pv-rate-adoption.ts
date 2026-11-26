// ----------------------------------------------------------------------------
// pv-rate-adoption — "the payment defines the FX rate".
//
// THE BUSINESS RULE (owner, 2026-07-30). Houzs buys from China and PAYS FIRST:
// money leaves the bank, then the goods arrive (GRN), then the supplier's invoice
// is entered (PI). The exchange rate is therefore NOT a figure anybody should be
// maintaining by hand — it is a FACT about the payment that already happened.
// Owner's words: "我把给钱的 knock off 掉这个 PI 就会计算到 costing" — when the
// payment knocks off the invoice, costing should be computed from it.
//
// So when a SUPPLIER_PAYMENT voucher settles a purchase invoice (pv_allocations →
// paid_sen, migration 0202), the voucher's own exchange_rate becomes the
// invoice's rate, and the GRN behind that invoice is re-costed at it
// (recostFromGrn cascades lot → consumption → DO line → SI line).
//
// WHY THIS IS THE FIX FOR AUDIT FINDING R2. safeRate degrades a missing /
// non-positive rate to 1 and a currency master that nobody has filled in also
// reads 1 (fx.ts:35-84), so a foreign GRN/PI posted before the rate was entered
// capitalises its raw RMB figure into the FIFO lot as if it were ringgit —
// toMyrSen(x, 1) === x. recostFromGrn re-reads the PI's OWN stored rate, so the
// error is STICKY and never self-heals (docs/inventory-costing-integrity-audit.md,
// R2). The payment is the one piece of evidence that can heal it, because it is
// the only place the true MYR-per-foreign-unit figure is known for certain.
//
// WHY THIS IS DELIBERATELY NARROW — it only ever fills a HOLE, never overwrites a
// judgement. If the invoice already carries a rate somebody entered on purpose,
// this does NOT replace it: it reports the disagreement and leaves the invoice
// alone. Two reasons. (1) A partial payment at a different rate is legitimate and
// common — paying half an invoice in January and half in March genuinely happens
// at two rates, and neither one is "the" rate for the whole invoice. (2) Silently
// overwriting a rate a human typed is a POLICY decision (which of the two wins?)
// that the owner has not made, and this module must not make it for him.
//
// PURE ON PURPOSE. The decision below touches no database, mirroring how
// oversell-retrocost.ts keeps its plan separate from its writes, so the whole
// decision table is exercised by unit tests without a Postgres.
// ----------------------------------------------------------------------------

import { normalizeCurrency, safeRate } from './fx';

const MYR = 'MYR';

/** numeric(14,6) — the stored precision of every exchange_rate column. A rate is
 *  compared and written at exactly that precision so a round-trip through the
 *  database can never look like a "change". */
export function roundRate6(raw: unknown): number {
  return Math.round(safeRate(raw) * 1e6) / 1e6;
}

/** The purchase-invoice facts the decision needs. */
export type PiRateFacts = {
  piId: string;
  docNo: string | null;
  currency: string | null;
  exchangeRate: string | number | null;
  grnId: string | null;
};

export type RateAdoptionSkipReason =
  | 'nothing_applied'
  | 'myr_invoice'
  | 'voucher_rate_unusable'
  | 'currency_mismatch'
  | 'already_at_this_rate';

export type RateAdoptionPlan =
  | { action: 'adopt'; rate: number; oldRate: number; grnId: string | null }
  | { action: 'report_mismatch'; piRate: number; pvRate: number }
  | { action: 'skip'; reason: RateAdoptionSkipReason };

/**
 * THE DECISION TABLE, in evaluation order.
 *
 *   1. applied ≤ 0                     → skip  nothing_applied
 *   2. PI currency is MYR              → skip  myr_invoice           (rate 1 by definition)
 *   3. PV currency is MYR, or the PV
 *      rate is not finite > 0          → skip  voucher_rate_unusable (no evidence to adopt)
 *   4. PV currency ≠ PI currency       → skip  currency_mismatch
 *   5. PI rate is 1 (never rated —
 *      the R2 defect)                  → ADOPT the PV's rate, then re-cost the GRN
 *   6. PI rate === PV rate             → skip  already_at_this_rate
 *   7. PI rate is something else       → report_mismatch, invoice UNCHANGED
 *
 * Row 5 keys on the stored rate being 1 rather than on "is it wrong?", because 1
 * is the only value that is indistinguishable from never having been set: it is
 * what safeRate returns for null / 0 / negative / NaN and what an unfilled
 * currency master returns. A foreign invoice at 1 is not a plausible rate, it is
 * a hole. Every other value is somebody's answer, and row 7 respects it.
 */
export function planPvRateAdoption(input: {
  appliedSen: number;
  pvCurrency: string | null;
  pvExchangeRate: string | number | null;
  pi: PiRateFacts;
}): RateAdoptionPlan {
  if (!(Number(input.appliedSen) > 0)) return { action: 'skip', reason: 'nothing_applied' };

  const piCurrency = normalizeCurrency(input.pi.currency);
  if (piCurrency === MYR) return { action: 'skip', reason: 'myr_invoice' };

  const pvCurrency = normalizeCurrency(input.pvCurrency);
  const pvRateRaw = Number(input.pvExchangeRate);
  const pvRate = roundRate6(pvRateRaw);
  if (pvCurrency === MYR || !Number.isFinite(pvRateRaw) || pvRateRaw <= 0 || pvRate === 1) {
    return { action: 'skip', reason: 'voucher_rate_unusable' };
  }
  if (pvCurrency !== piCurrency) return { action: 'skip', reason: 'currency_mismatch' };

  const piRate = roundRate6(input.pi.exchangeRate);

  if (piRate === 1) return { action: 'adopt', rate: pvRate, oldRate: piRate, grnId: input.pi.grnId };
  if (piRate === pvRate) return { action: 'skip', reason: 'already_at_this_rate' };
  return { action: 'report_mismatch', piRate, pvRate };
}

/**
 * CANCEL-PATH decision — is this invoice currently carrying the rate this voucher
 * established?
 *
 * THE CHOICE THE OWNER MUST KNOW ABOUT (see the PR body and
 * docs/modules/payment-voucher.md): cancelling a voucher unwinds its AP
 * settlement but DELIBERATELY LEAVES THE ADOPTED RATE AND THE RE-COSTED
 * INVENTORY IN PLACE. Reverting is not the conservative option, it is the
 * destructive one: the only value there was to revert TO is 1 — the R2 defect —
 * so "putting it back" would knowingly restore a 1:1 mis-cost and cascade that
 * wrong basis back through every lot, DO and SI the recost had corrected.
 * A cancelled voucher also does not un-happen the bank transfer it recorded; the
 * observed rate remains the best evidence anyone has.
 *
 * So this predicate does not drive a write. It exists so the cancel can NAME the
 * invoices whose rate it is leaving alone, in the History panel, instead of
 * saying nothing and leaving the reader to discover it.
 */
export function isRateRetainedFromPv(input: {
  pvCurrency: string | null;
  pvExchangeRate: string | number | null;
  piCurrency: string | null;
  piExchangeRate: string | number | null;
}): boolean {
  const pvCurrency = normalizeCurrency(input.pvCurrency);
  if (pvCurrency === MYR) return false;
  if (normalizeCurrency(input.piCurrency) !== pvCurrency) return false;
  const pvRate = roundRate6(input.pvExchangeRate);
  if (pvRate === 1) return false;
  return roundRate6(input.piExchangeRate) === pvRate;
}
