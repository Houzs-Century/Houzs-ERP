// ----------------------------------------------------------------------------
// fx-guard.ts — POST-boundary guard for the R2 foreign-rate mis-cost.
//
// See docs/inventory-costing-integrity-audit.md, R2. safeRate and
// masterRateForCurrency degrade a missing / non-positive / non-finite FX rate to
// 1 (fx.ts:47-84), and a brand-new currency's currencies.rate_to_myr defaults to
// 1 until the owner sets a real rate. So a GRN / PI in a foreign currency posted
// BEFORE that rate is entered folds the raw foreign figure into the FIFO lot / AP
// GL as if it were ringgit — toMyrSen(x, 1) === x. recostFromGrn re-reads the
// GRN's OWN stored rate, so the error is sticky and never self-heals.
//
// This guard refuses that POST instead of silently capitalising at 1:1. It fires
// ONLY when the document currency is non-MYR AND no real rate is available: the
// operator did not enter a positive rate on the document AND the currency master
// has no positive rate_to_myr (the value safeRate would coerce to 1).
//
// It deliberately does NOT change safeRate / toMyrSen / masterRateForCurrency:
// those coerce-to-1 rules are correct for the READ path (a bad rate must never
// zero out money) and are relied on across the FIFO layer. The provenance of a
// stored "1" — an unset master vs. a rate the operator deliberately typed — is
// only knowable at the CREATE boundary, before the resolved rate is flattened
// into the stored exchange_rate. That is why the guard lives here, at the write
// boundary, and reads the RAW master rate rather than the coerced one.
// ----------------------------------------------------------------------------

import { normalizeCurrency } from './fx';

const MYR = 'MYR';

/**
 * A finite, strictly-positive numeric rate. undefined / null / '' / 0 / negative
 * / NaN / Infinity are all NOT a real rate — every one of them is what safeRate
 * would fold to 1.
 */
export function isPositiveFiniteRate(raw: unknown): boolean {
  if (raw === undefined || raw === null || raw === '') return false;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0;
}

/**
 * The R2 predicate — pure and DB-free, so it is exhaustively unit-testable.
 * Returns true when a foreign document would be POSTED at the safeRate fallback
 * of 1 (its raw foreign figure capitalised 1:1 as ringgit):
 *
 *   · MYR (or blank ⇒ MYR)                       → never blocked (rate 1 is a no-op)
 *   · operator entered a positive, finite rate   → allowed (the owner may legitimately
 *                                                   type a rate even when the master is unset)
 *   · otherwise the stored rate comes from the currency master; if THAT is missing
 *     / non-positive / non-finite it would coerce to 1 → block.
 *
 * The block keys on the CURRENCY-MASTER rate being unset, NOT on the effective
 * rate being 1: a deliberately-entered operator rate of 1 is honoured, an unset
 * master that merely defaults to 1 is refused — matching the audit's intent.
 */
export function isUnratedForeignPost(args: {
  currency: unknown;
  operatorRate: unknown; // the raw exchange_rate the operator sent on the doc, if any
  masterRate: unknown; // the raw currencies.rate_to_myr for that currency
}): boolean {
  if (normalizeCurrency(args.currency) === MYR) return false;
  if (isPositiveFiniteRate(args.operatorRate)) return false;
  return !isPositiveFiniteRate(args.masterRate);
}

export type ForeignRateBlock = {
  error: 'foreign_rate_unset';
  currency: string;
  doc: string;
  message: string;
};

/** The 422 body an offending POST receives — actionable, never a 500. */
export function foreignRateBlockBody(currency: unknown, docLabel: string): ForeignRateBlock {
  const cur = normalizeCurrency(currency);
  return {
    error: 'foreign_rate_unset',
    currency: cur,
    doc: docLabel,
    message: `Set the ${cur} exchange rate before posting this ${docLabel}.`,
  };
}

/**
 * Read the RAW currencies.rate_to_myr (NOT safeRate-coerced) for a currency.
 * Returns 1 for MYR, and null for a missing row / lookup failure — both read as
 * "no positive master rate" by the predicate.
 */
export async function readMasterRateRaw(
  sb: { from: (t: string) => any },
  currency: unknown,
): Promise<unknown> {
  const code = normalizeCurrency(currency);
  if (code === MYR) return 1;
  try {
    const { data } = await sb
      .from('currencies')
      .select('rate_to_myr')
      .eq('code', code)
      .maybeSingle();
    return (data as { rate_to_myr?: unknown } | null)?.rate_to_myr ?? null;
  } catch {
    return null;
  }
}

/**
 * DB-aware POST-boundary check. Resolves the raw master rate and applies the
 * predicate. Returns { ok: true } to let the POST proceed, or { ok: false, body }
 * (a 422 payload) to refuse it. `operatorRate` is the raw body.exchangeRate the
 * caller received (pass undefined for flows that have no operator-rate input).
 */
export async function assertForeignRatePostable(
  sb: { from: (t: string) => any },
  args: { currency: unknown; operatorRate: unknown; docLabel: string },
): Promise<{ ok: true } | { ok: false; body: ForeignRateBlock }> {
  const currency = normalizeCurrency(args.currency);
  if (currency === MYR) return { ok: true };
  if (isPositiveFiniteRate(args.operatorRate)) return { ok: true };
  const masterRate = await readMasterRateRaw(sb, currency);
  if (isUnratedForeignPost({ currency, operatorRate: args.operatorRate, masterRate })) {
    return { ok: false, body: foreignRateBlockBody(currency, args.docLabel) };
  }
  return { ok: true };
}
