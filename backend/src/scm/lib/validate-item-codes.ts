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
// every input is blank we return ok without touching the DB. (On the SO paths
// a BLANK code is no longer a free pass — see findFreeTextSoLines below and
// the DRAFT-only placeholder rule in createSalesOrderCore.)
//
// requireActive (owner 2026-08-08, HC-SO-2607-013 "square pillow"): the picker
// only ever offers ACTIVE products, so a NEW pick (create / add-line / a PATCH
// that CHANGES the code / an amendment ADD) must also be ACTIVE — an INACTIVE
// code arriving on those paths did not come from the UI. Opt-in, so the
// DO / SI / DR / consignment callers and unchanged-code line edits keep their
// existence-only semantics (a legacy line whose product was discontinued must
// stay editable).
// ----------------------------------------------------------------------------

export type ValidateResult =
  | { ok: true }
  | { ok: false; unknown: string[]; inactive: string[] };

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
 * number nobody can act on.
 *
 * companyId is a REQUIRED positional argument even though `null` still
 * degrades to no predicate — the SAME reason scopeToCompanyId states in
 * lib/companyScope.ts: a caller must not be able to get "every company" by
 * saying nothing. This is a REFUSAL gate, so an omitted scope does not fail
 * loudly, it silently admits the other company's SKU. Pass activeCompanyId(c)
 * on a request path; pass an explicit `null` only where the caller genuinely
 * has no company (pre-migration / a test), which now reads as a decision.
 */
export async function validateItemCodes(
  sb: any,
  codes: Array<string | null | undefined>,
  companyId: number | null | undefined,
  opts?: { requireActive?: boolean },
): Promise<ValidateResult> {
  const unique = [...new Set(codes.map((c) => (c ?? '').trim()).filter(Boolean))];
  if (unique.length === 0) return { ok: true };
  let q = sb.from('mfg_products').select('code, status').in('code', unique);
  if (companyId != null) q = q.eq('company_id', companyId);
  const { data } = await q;
  const rows = ((data ?? []) as Array<{ code: string; status?: string | null }>);
  const found = new Set(rows.map((r) => r.code));
  const unknown = unique.filter((c) => !found.has(c));
  /* A code counts ACTIVE if ANY of its rows is (code is only unique per
     company; unscoped reads can see both companies' rows). */
  const inactive = opts?.requireActive
    ? unique.filter((c) =>
        found.has(c) && !rows.some((r) => r.code === c && (r.status ?? 'ACTIVE') === 'ACTIVE'))
    : [];
  return unknown.length === 0 && inactive.length === 0
    ? { ok: true }
    : { ok: false, unknown, inactive };
}

/** Canonical 409 response body for unknown-code rejections. Callers should
 *  return c.json(unknownItemCodeResponse(check.unknown, check.inactive), 409). */
export const unknownItemCodeResponse = (unknown: string[], inactive: string[] = []) => {
  const parts: string[] = [];
  if (unknown.length > 0) {
    parts.push(
      `Item ${unknown.length === 1 ? 'code is' : 'codes are'} not in the product catalog: ${unknown.join(', ')}.`,
    );
  }
  if (inactive.length > 0) {
    parts.push(
      `Item ${inactive.length === 1 ? 'code is' : 'codes are'} no longer active in the product catalog: ${inactive.join(', ')}.`,
    );
  }
  return {
    error: 'unknown_item_code',
    message: `${parts.join(' ')} Pick from the dropdown — manual codes are not allowed.`,
    unknown,
    ...(inactive.length > 0 ? { inactive } : {}),
  };
};

/* ── Free-text SO lines (owner 2026-08-08, verbatim outrage on
   HC-SO-2607-013: "为什么会有这样的 sku square pillow 你可以允许 freetext
   的吗!?") ─────────────────────────────────────────────────────────────────
   The observed shape: a line with a BLANK item_code and typed text riding in
   `description` ("Square pillow Col: BO315-22"). The blank code sailed through
   the skip-as-no-op above, so the text SAVED as a group-OTHERS line that names
   no catalog product. That row shape must never insert again, on ANY SO write
   path. A blank code with a blank description is different — it is the scan
   pipeline's deliberate "Pick a product…" placeholder, allowed on DRAFT
   creates only (the confirm gate then refuses to confirm it). */

export type SoLineForFreeTextCheck = {
  itemCode?: unknown;
  description?: unknown;
};

/** The free-text labels (descriptions) of lines carrying text but NO catalog
 *  code. [] = nothing free-text. */
export function findFreeTextSoLines(items: readonly SoLineForFreeTextCheck[]): string[] {
  const out: string[] = [];
  for (const it of items) {
    const code = String(it.itemCode ?? '').trim();
    const desc = String(it.description ?? '').trim();
    if (!code && desc) out.push(desc);
  }
  return out;
}

/** Canonical 409 response for free-text line rejections. */
export const freeTextSoLineResponse = (labels: string[]) => ({
  error: 'so_free_text_line',
  message:
    `${labels.length === 1 ? 'This line is' : 'These lines are'} not in the product catalog: ` +
    `${labels.map((l) => `"${l}"`).join(', ')}. ` +
    `Every Sales Order line must be a catalog SKU — pick the product from the dropdown; free-typed lines cannot be saved.`,
  lines: labels,
});
