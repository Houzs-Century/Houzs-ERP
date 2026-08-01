// ----------------------------------------------------------------------------
// validate-item-codes — single catalog-membership guard for SO / DO / SI / DR
// line writes (Commander 2026-05-30, Edge #4).
//
// Frontend dropdowns already restrict the operator to catalog SKUs, but the
// API is the contract — a direct POST with a typo'd code (or a stale code
// removed from the catalog) was landing as a "phantom" line with no inventory
// linkage. This helper enforces existence in mfg_products.code at every line
// write across SO / DO / SI / DR (POST header-with-items, POST add-line,
// PATCH change-line-code).
//
// Skip-as-no-op: empty/whitespace codes are dropped before the lookup; if
// every input is blank we return ok without touching the DB.
// ----------------------------------------------------------------------------

export type ValidateResult =
  | { ok: true }
  | { ok: false; unknown: string[] };

/**
 * Resolve which of the given itemCodes exist in mfg_products.code, WITHIN one
 * company. Returns { ok: true } when all are catalog members (or none
 * provided), or { ok: false, unknown: [...] } listing every code that doesn't
 * exist.
 *
 * The company predicate has to move in LOCK-STEP with the pricing loaders
 * (loadProductByCode / loadProductsByCodes, mfg-pricing-recompute.ts). Both
 * companies keep their own SKU master, so unscoped this gate admits a code that
 * exists ONLY in the other company — and the now-scoped pricing read then finds
 * nothing for it, prices the line at 0 and rejects the order as pricing_drift.
 * A clean "that item code isn't in this company's catalogue" beats a drift
 * number nobody can act on. null/undefined degrades to no predicate.
 */
export async function validateItemCodes(
  sb: any,
  codes: Array<string | null | undefined>,
  companyId?: number | null,
): Promise<ValidateResult> {
  const unique = [...new Set(codes.map((c) => (c ?? '').trim()).filter(Boolean))];
  if (unique.length === 0) return { ok: true };
  let q = sb.from('mfg_products').select('code').in('code', unique);
  if (companyId != null) q = q.eq('company_id', companyId);
  const { data } = await q;
  const found = new Set(((data ?? []) as Array<{ code: string }>).map((r) => r.code));
  const unknown = unique.filter((c) => !found.has(c));
  return unknown.length === 0 ? { ok: true } : { ok: false, unknown };
}

/** Canonical 409 response body for unknown-code rejections. Callers should
 *  return c.json(unknownItemCodeResponse(check.unknown), 409). */
export const unknownItemCodeResponse = (unknown: string[]) => ({
  error: 'unknown_item_code',
  message:
    `Item ${unknown.length === 1 ? 'code is' : 'codes are'} not in the product catalog: ${unknown.join(', ')}. ` +
    `Pick from the dropdown — manual codes are not allowed.`,
  unknown,
});
