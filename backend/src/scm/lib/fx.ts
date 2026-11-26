
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
