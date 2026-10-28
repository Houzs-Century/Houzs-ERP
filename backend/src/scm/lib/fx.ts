// ----------------------------------------------------------------------------
// fx.ts — multi-currency helpers for the procure-to-pay money path.
// Ported verbatim from 2990 apps/api/src/lib/fx.ts (migrations 0188/0190/0193).
//
// Three documents carry an exchange rate (MYR per 1 unit of the doc's currency):
//   · purchase_invoices.exchange_rate — converts the AP journal entry to MYR at
//     GL-post time.
//   · grns.exchange_rate — converts the inventory IN unit cost (the FIFO lot) to
//     MYR at receive time.
//   · payment_vouchers.exchange_rate — converts the PV's cash-out GL post to MYR.
//
// MYR is ALWAYS rate 1; a foreign rate must be a finite number > 0, else it falls
// back to 1 so a malformed rate can NEVER zero out the money. rate = 1 ⇒ toMyrSen
// is a byte-for-byte NO-OP (round(x*1) === x for an integer sen amount), so every
// existing all-MYR Houzs flow is unchanged.
// ----------------------------------------------------------------------------

/**
 * Normalise an incoming currency code to the canonical stored form: trimmed +
 * upper-cased, falling back to MYR when blank / non-string. The currencies
 * MASTER table + its rows are the real validity gate — we don't hardcode an
 * allow-list, so ANY currency the owner adds in the Maintenance page is accepted.
 * Blank → MYR (the base).
 */
export function normalizeCurrency(raw: unknown): string {
  const s = String(raw ?? '').trim().toUpperCase();
  return s || 'MYR';
}

/**
 * Normalise an incoming exchange rate against a currency, for WRITE paths
 * (GRN / PI / PV create + update). MYR forces 1; a foreign rate must be finite > 0
 * (else 1). Returns a JS number; PostgREST stores it into numeric(14,6).
 */
export function normalizeExchangeRate(raw: unknown, currency: string): number {
  if (String(currency).toUpperCase() === 'MYR') return 1;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/**
 * Guard a rate READ back from the DB (numeric → string|number|null). A missing /
 * non-positive / non-finite rate degrades to 1 — never zero out the money. MYR
 * rows always store 1 (enforced on write), so this only ever matters for a
 * malformed foreign rate.
 */
export function safeRate(raw: unknown): number {
  const n = Number(raw ?? 1);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/**
 * Convert a foreign-currency sen amount to MYR sen at the given rate.
 * round(foreignSen * rate). rate === 1 ⇒ returns foreignSen unchanged (the
 * MYR no-op): Math.round(intSen * 1) === intSen.
 */
export function toMyrSen(foreignSen: number, rate: unknown): number {
  return Math.round(Number(foreignSen ?? 0) * safeRate(rate));
}

/**
 * Resolve the auto-fill exchange rate for a document currency from the
 * currencies MASTER. MYR is always 1 (no lookup). For a foreign currency, read
 * currencies.rate_to_myr — a finite > 0 value, else 1 (the master defaults a new
 * currency to 1 until the owner sets a real rate). Used by GRN / PI / PV create
 * to DEFAULT the rate; an explicit rate on the request still wins (the caller
 * passes it through normalizeExchangeRate). `sb` is the request-scoped Supabase
 * client. The currency `code` is the master's PK (global), so no company scope.
 */
export async function masterRateForCurrency(
  sb: { from: (t: string) => any },
  currency: string,
): Promise<number> {
  if (normalizeCurrency(currency) === 'MYR') return 1;
  const code = normalizeCurrency(currency);
  try {
    const { data } = await sb.from('currencies')
      .select('rate_to_myr').eq('code', code).maybeSingle();
    const r = (data as { rate_to_myr?: string | number | null } | null)?.rate_to_myr;
    return safeRate(r);
  } catch {
    return 1;
  }
}
