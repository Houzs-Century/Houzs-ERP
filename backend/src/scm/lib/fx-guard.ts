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

/**
 * The 422 body an offending POST receives — actionable, never a 500.
 *
 * The message names BOTH remedies because there are genuinely two, and which one
 * applies depends on where the operator is in the cycle. Houzs pays its China
 * suppliers BEFORE the goods and the invoice arrive, so most of the time the real
 * rate is already knowable from a bank transfer — recording that payment voucher is
 * the better answer than typing a rate, because the voucher's rate then flows onto
 * the invoice and re-costs the GRN on its own (lib/pv-rate-adoption.ts). Telling the
 * operator only to "set the rate" points them at the harder, guessier of the two.
 */
export function foreignRateBlockBody(currency: unknown, docLabel: string): ForeignRateBlock {
  const cur = normalizeCurrency(currency);
  return {
    error: 'foreign_rate_unset',
    currency: cur,
    doc: docLabel,
    message: `No ${cur} exchange rate is set, so this ${docLabel} would be costed as if ${cur} were ringgit. Set the ${cur} rate in the currency master, enter the rate on this ${docLabel}, or record the supplier payment first — a payment voucher's rate is adopted by the invoice it settles.`,
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

/* ────────────────────────────────────────────────────────────────────────────
   THE EDIT-PATH HOLE (2026-07-30) — the POST guard above closed the create
   boundary, and the very next door was left open.

   `PATCH /grns/:id` and `PATCH /purchase-invoices/:id` both accept `currency`. Both
   derive exchange_rate from it with the SAME three-branch rule: a rate explicitly
   sent is normalised; a flip TO MYR resets the rate to 1; and *neither* leaves the
   stored rate UNTOUCHED (grns.ts, purchase-invoices.ts). So switching an MYR
   document to RMB without sending a rate leaves exchange_rate sitting at 1 — the
   value it held because the document used to be ringgit — and nothing looks at the
   currency master at all. That is bit-for-bit the R2 mis-cost, reached by editing
   instead of creating, and the POST guard never sees it.
   ──────────────────────────────────────────────────────────────────────────── */

/**
 * The EDIT predicate — pure and DB-free, like its POST sibling.
 *
 * Fires ONLY on a genuine currency FLIP to a foreign code with no rate anywhere:
 *
 *   · currency not being changed by this patch  → never blocked. The document's rate
 *     was already gated at create; re-litigating it would refuse edits to unrelated
 *     fields (notes, warehouse, supplier) on every foreign document in the system.
 *   · flipping TO MYR                           → never blocked (the routes pin rate 1).
 *   · flipping FROM MYR to MYR, or no-op flip    → never blocked.
 *   · operator sent a positive finite rate      → allowed, same courtesy as POST.
 *   · otherwise the stored rate is about to describe the WRONG currency, so the
 *     currency master is the only source left; if that is unset → block.
 *
 * Deliberately narrow. An all-MYR document can never trip it (the only MYR path
 * through here returns false immediately), which matters because all-MYR is the
 * overwhelming majority of documents in this system.
 */
export function isUnratedForeignCurrencyFlip(args: {
  /** The currency stored on the row BEFORE this patch. */
  fromCurrency: unknown;
  /** The currency the patch sets, or undefined when the patch does not touch it. */
  toCurrency: unknown;
  operatorRate: unknown;
  masterRate: unknown;
}): boolean {
  if (args.toCurrency === undefined || args.toCurrency === null) return false; // not a flip
  const to = normalizeCurrency(args.toCurrency);
  if (to === MYR) return false;
  if (normalizeCurrency(args.fromCurrency) === to) return false; // same currency, not a flip
  if (isPositiveFiniteRate(args.operatorRate)) return false;
  return !isPositiveFiniteRate(args.masterRate);
}

/**
 * DB-aware PATCH-boundary check. Mirrors assertForeignRatePostable and returns the
 * same 422 body, so the two boundaries speak with one voice. `toCurrency` must be
 * undefined when the patch does not carry a currency.
 */
export async function assertForeignRatePatchable(
  sb: { from: (t: string) => any },
  args: { fromCurrency: unknown; toCurrency: unknown; operatorRate: unknown; docLabel: string },
): Promise<{ ok: true } | { ok: false; body: ForeignRateBlock }> {
  if (args.toCurrency === undefined || args.toCurrency === null) return { ok: true };
  const to = normalizeCurrency(args.toCurrency);
  if (to === MYR) return { ok: true };
  if (normalizeCurrency(args.fromCurrency) === to) return { ok: true };
  if (isPositiveFiniteRate(args.operatorRate)) return { ok: true };
  const masterRate = await readMasterRateRaw(sb, to);
  if (isUnratedForeignCurrencyFlip({ ...args, toCurrency: to, masterRate })) {
    return { ok: false, body: foreignRateBlockBody(to, args.docLabel) };
  }
  return { ok: true };
}
