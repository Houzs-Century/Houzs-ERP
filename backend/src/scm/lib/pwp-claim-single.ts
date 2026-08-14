// ---------------------------------------------------------------------------
// pwp-claim-single.ts — Single-code PWP claim helper for the add-line path.
//
// Mirrors the create-path PWP loop in mfg-sales-orders.ts (~lines 1891-2023)
// for ONE code + ONE reward line being added to a placed SO.
//
// Rules faithfully reproduced from the create loop:
//   1. qty must be 1 (pwp_reward_qty_locked).
//   2. Prefetch single pwp_codes row by code.
//   3. Redeemable statuses: AVAILABLE or RESERVED (same owner_staff_id) or
//      orphaned-USED self-heal (USED but redeemed_doc_no → non-existent SO).
//   4. customer_id binding: AVAILABLE code with a customer_id must match the
//      order's customer_id (same rule as create §8.8).
//   5. reward_category match (case-insensitive).
//   6. SOFA rewards: matched via reward_combo_ids + module subset; returns
//      pwpSofaComboIds.
//   7. Non-SOFA rewards: model in eligible_reward_model_ids + pwp_price_sen > 0
//      (unless type='promo' → 0 = free); returns pwpBaseSen.
//   8. NEW (add-line only): reject if the same code is already redeemed on
//      another item row of this order (SELECT from mfg_sales_order_items).
//   9. Atomic claim: UPDATE … WHERE code=? AND status=? (RESERVED|AVAILABLE or
//      the exact orphan USED row).
//  10. Returns { pwpBaseSen | pwpSofaComboIds, claimed, rejection:null } on
//      success, or { rejection:{code,reason}, ...nulls } on any failure.
//
// rollbackSinglePwpClaim — mirrors rollbackPwpClaims in mfg-sales-orders.ts:
//   restores status=prevStatus, nulls redeemed_doc_no + redeemed_item_code;
//   if restoring to RESERVED also nulls source_doc_no (we stamped it on claim).
// ---------------------------------------------------------------------------

import { matchComboSubset } from '../shared';
import type { SofaComboRow } from '../shared/sofa-build';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SinglePwpClaimResult {
  /** Non-sofa PWP base in sen (0 = promo-free, >0 = pwp price). null on sofa path or rejection. */
  pwpBaseSen: number | null;
  /** Sofa reward combo ids. null on non-sofa path or rejection. */
  pwpSofaComboIds: string[] | null;
  /** For rollback on a subsequent failure. null if not claimed (rejection). */
  /* companyId travels WITH the claim so the rollback undoes the row the claim
     took. Since 0188 re-keyed pwp_codes (company_id, code), a receipt carrying
     only the code does not identify a row. */
  claimed: { code: string; companyId: number; prevStatus: string } | null;
  /** Set when the code cannot be granted. null on success. */
  rejection: { code: string; reason: string } | null;
}

export interface PwpClaimSingleArgs {
  code: string;
  /**
   * The active company. REQUIRED, and required for a reason worth reading.
   *
   * A PWP code used to be globally unique — `code text PRIMARY KEY` — so
   * addressing a row by code alone was safe by construction. Migration 0188
   * re-keyed the table `(company_id, code)` so each company could own its own
   * code space, and that removed the guarantee this file was silently relying
   * on. From then on `.eq('code', ...)` addresses "whichever company's row the
   * planner returns first", on a path that CLAIMS and BURNS a voucher.
   *
   * Made required rather than optional so every caller has to answer the
   * question — CLAUDE.md's first recorded trap is that a default is a decision
   * nobody reviews, and an optional company would have defaulted to the old,
   * wrong behaviour at exactly the call sites that forgot it.
   */
  companyId: number;
  docNo: string;
  /**
   * The resolved product catalog SKU (product.code from the catalog row).
   * Caller MUST pass product.code here — this value is written to
   * redeemed_item_code on the pwp_codes row (matching create's audit at
   * mfg-sales-orders.ts ~1988: `redeemed_item_code: product.code`).
   */
  itemCode: string;
  /** Resolved from the product catalog row (same shape passed to recomputeFromSnapshot). */
  product: {
    category: string;
    model_id: string | null;
    base_model: string | null;
    pwp_price_sen?: number | null;
  };
  customerId: string | null;
  ownerStaffId: string;
  qty: number;
  /** Sofa line variants blob — needed for reward combo module matching. */
  variants: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// Pure eligibility types (exported for unit tests)
// ---------------------------------------------------------------------------

/** The raw DB row from pwp_codes. */
export interface PwpCodeRow {
  code: string;
  status: string;
  owner_staff_id: string | null;
  reward_category: string;
  eligible_reward_model_ids: string[] | null;
  reward_combo_ids: string[] | null;
  customer_id: string | null;
  source_doc_no: string | null;
  redeemed_doc_no: string | null;
  type: string | null;
}

export interface PureEligibilityArgs {
  codeRow: PwpCodeRow | null;
  product: PwpClaimSingleArgs['product'];
  customerId: string | null;
  ownerStaffId: string;
  qty: number;
  /** True when the redeemed SO (if USED) does NOT exist — caller checks this. */
  isOrphanedUsed: boolean;
  /** True when this code is already redeemed on another item of the same order. */
  alreadyOnOrder: boolean;
  /** Active sofa combos for reward combo matching (only needed if category=SOFA). */
  sofaCombos: SofaComboRow[];
  /** The sofa build modules extracted from variants (empty [] if not a sofa). */
  sofaModules: string[];
}

export type PureEligibilityResult =
  | { ok: true; grantPwpPrice: number; grantSofaComboIds: null }  // non-sofa grant
  | { ok: true; grantPwpPrice: 0; grantSofaComboIds: string[] }   // sofa grant
  | { ok: false; reason: string };

/**
 * Pure (no DB) eligibility check.
 * Mirrors the inner create-loop body: status, customer binding, category,
 * model/combo eligibility.  isOrphanedUsed + alreadyOnOrder must be resolved
 * by the async wrapper before calling this.
 */
export function checkPwpEligibility(args: PureEligibilityArgs): PureEligibilityResult {
  const { codeRow: cRow, product, customerId, ownerStaffId, qty, isOrphanedUsed, alreadyOnOrder, sofaCombos, sofaModules } = args;

  // Rule 1: qty must be 1 (matches create ~line 1903).
  if (qty !== 1) return { ok: false, reason: 'a PWP reward line must be quantity 1' };

  // Rule 2: code row must exist.
  if (!cRow) return { ok: false, reason: 'code not found — it may have been replaced; re-apply PWP on this line' };

  // Rule 8 (add-line only): reject if already redeemed on this order.
  if (alreadyOnOrder) return { ok: false, reason: 'code is already applied to another line on this order' };

  // Rule 3: redeemable status check (mirrors create ~line 1909-1936).
  const redeemable =
    cRow.status === 'AVAILABLE' ||
    (cRow.status === 'RESERVED' && cRow.owner_staff_id === ownerStaffId);

  if (!redeemable && !isOrphanedUsed) {
    const reason =
      cRow.status === 'USED'
        ? `code already used${cRow.redeemed_doc_no ? ` on ${cRow.redeemed_doc_no}` : ''}`
        : cRow.status === 'RESERVED'
          ? 'code is reserved by another salesperson'
          : `code is not redeemable (${cRow.status})`;
    return { ok: false, reason };
  }

  // Rule 5: reward_category match (mirrors create ~line 1937-1940).
  const prodCat = String(product.category ?? '').toUpperCase();
  if (prodCat !== String(cRow.reward_category ?? '').toUpperCase()) {
    return { ok: false, reason: `code rewards ${String(cRow.reward_category)}, not this item` };
  }

  // Rule 4: customer_id binding for AVAILABLE codes (mirrors create ~line 1943-1946).
  // Create gates this check on `cRow.status === 'AVAILABLE'` ONLY — an orphaned-USED
  // self-heal skips the customer check entirely (the original redemption was already
  // accepted; we're just recovering a stuck code). Applying the check to orphaned-USED
  // codes would be STRICTER than create and would block legitimate recovery.
  if (cRow.status === 'AVAILABLE' && cRow.customer_id && customerId && cRow.customer_id !== customerId) {
    return { ok: false, reason: 'code belongs to a different customer' };
  }

  // Rule 6/7: eligibility split by category (mirrors create ~line 1951-1977).
  if (prodCat === 'SOFA') {
    const rewardComboIds = (cRow.reward_combo_ids ?? []) as string[];
    if (rewardComboIds.length === 0) return { ok: false, reason: 'voucher has no reward combos' };
    if (sofaModules.length === 0) return { ok: false, reason: 'sofa line carries no build modules' };
    const candidate = sofaCombos.filter(
      (c) => rewardComboIds.includes(c.id) && (!product.base_model || c.baseModel === product.base_model),
    );
    if (!candidate.some((c) => matchComboSubset(sofaModules, c.modules) != null)) {
      return { ok: false, reason: "sofa build doesn't match the voucher's reward combo" };
    }
    return { ok: true, grantPwpPrice: 0, grantSofaComboIds: rewardComboIds };
  } else {
    const pwpPrice = Math.round(Number(product.pwp_price_sen ?? 0));
    const isPromo = String(cRow.type ?? 'pwp') === 'promo';
    if (!isPromo && !(pwpPrice > 0)) return { ok: false, reason: 'this SKU has no PWP price set (SKU Master)' };
    const elig = (cRow.eligible_reward_model_ids ?? []) as string[];
    const modelOk = elig.length === 0 || (product.model_id != null && elig.includes(product.model_id));
    if (!modelOk) return { ok: false, reason: 'code is not valid for this model' };
    return { ok: true, grantPwpPrice: isPromo ? 0 : pwpPrice, grantSofaComboIds: null };
  }
}

/**
 * Pure helper — tests whether a given PWP code is already applied to any item
 * row on the order.  Expects the raw `variants` column values from
 * `mfg_sales_order_items.select('variants')`.
 *
 * The match reads `variants.pwpCode` (trimmed string), mirroring the create-path
 * per-item code extraction at mfg-sales-orders.ts ~1893:
 *   `String((it?.variants as { pwpCode?: string | null } | null)?.pwpCode ?? '').trim()`
 *
 * Exported for unit tests.
 */
export function codeAlreadyOnOrder(
  rows: Array<{ variants: unknown }> | null | undefined,
  code: string,
): boolean {
  if (!rows || rows.length === 0) return false;
  const trimmed = code.trim();
  return rows.some((row) => {
    const v = row.variants;
    if (!v || typeof v !== 'object') return false;
    const pwpCode = (v as Record<string, unknown>).pwpCode;
    if (typeof pwpCode !== 'string') return false;
    return pwpCode.trim() === trimmed;
  });
}

/** Extract sofa module ids from a variants blob (same logic as extractSofaComboLookupArgs in mfg-sales-orders.ts). */
function extractSofaModules(
  product: Pick<PwpClaimSingleArgs['product'], 'category'>,
  variants: Record<string, unknown> | null,
): string[] {
  if (String(product.category ?? '').toUpperCase() !== 'SOFA') return [];
  if (!variants || typeof variants !== 'object') return [];
  const cells = variants.cells as Array<{ moduleId?: string }> | undefined;
  if (!Array.isArray(cells) || cells.length === 0) return [];
  return cells.map((c) => String(c.moduleId ?? '')).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Async main export
// ---------------------------------------------------------------------------

/**
 * Claim a single PWP code for one item being added to a placed SO.
 * Mirrors the create-path loop for ONE code. Does NOT throw — returns a
 * rejection reason in `result.rejection` on any failure; caller converts to 409.
 */
export async function claimPwpForSingleLine(
  sb: any,
  args: PwpClaimSingleArgs,
): Promise<SinglePwpClaimResult> {
  const reject = (reason: string): SinglePwpClaimResult => ({
    pwpBaseSen: null,
    pwpSofaComboIds: null,
    claimed: null,
    rejection: { code: args.code, reason },
  });

  // ── Rule 1: qty (pure, fast-reject) ───────────────────────────────────────
  if (args.qty !== 1) return reject('a PWP reward line must be quantity 1');

  // ── Rule 2: prefetch pwp_codes row ────────────────────────────────────────
  const { data: codeRows, error: fetchErr } = await sb
    .from('pwp_codes')
    .select('code, status, owner_staff_id, reward_category, eligible_reward_model_ids, reward_combo_ids, customer_id, source_doc_no, redeemed_doc_no, type')
    .eq('code', args.code)
    .eq('company_id', args.companyId)
    .limit(1);
  if (fetchErr) return reject('could not verify the code — please try again');
  const cRow: PwpCodeRow | null = (codeRows as PwpCodeRow[] | null)?.[0] ?? null;
  if (!cRow) return reject('code not found — it may have been replaced; re-apply PWP on this line');

  // ── Rule 8 (add-line only): already on this order? ────────────────────────
  // NOTE: mfg_sales_order_items has NO `redeemed_item_code` column — that field
  // lives on pwp_codes and records the reward SKU, not the voucher code.
  // The per-item voucher code is stored in variants.pwpCode (JSON).
  // We select `variants` and delegate matching to codeAlreadyOnOrder(), mirroring
  // the create-path extraction at mfg-sales-orders.ts ~1893.
  // We MUST destructure `error` — dropping it would silently pass on DB failure
  // (the previous bug), turning a lookup error into a double-spend opportunity.
  const { data: existingItems, error: itemsErr } = await sb
    .from('mfg_sales_order_items')
    .select('variants')
    .eq('doc_no', args.docNo);
  if (itemsErr) {
    // Mirror create's pwpPrefetchFailed honesty (~1883-1888): a failed read is NOT
    // "code not found" — reject as retryable rather than silently passing.
    console.error('[pwp-claim-single] item variants lookup failed:', itemsErr.message ?? itemsErr);
    return reject('could not verify the code — please try again (code_lookup_failed)');
  }
  const alreadyOnOrder = codeAlreadyOnOrder(
    existingItems as Array<{ variants: unknown }> | null,
    args.code,
  );

  // ── Rule 3a: orphaned-USED check (mirrors create ~line 1921-1928) ─────────
  const redeemable =
    cRow.status === 'AVAILABLE' ||
    (cRow.status === 'RESERVED' && cRow.owner_staff_id === args.ownerStaffId);
  let orphanedUsed = false;
  if (!redeemable && cRow.status === 'USED' && cRow.redeemed_doc_no && cRow.redeemed_doc_no !== args.docNo) {
    const { data: deadSo } = await sb
      .from('mfg_sales_orders')
      .select('doc_no')
      .eq('doc_no', cRow.redeemed_doc_no)
      .maybeSingle();
    orphanedUsed = !deadSo;
  }

  // ── Load combos for SOFA path ──────────────────────────────────────────────
  let sofaCombos: SofaComboRow[] = [];
  const prodCat = String(args.product.category ?? '').toUpperCase();
  if (prodCat === 'SOFA') {
    const { data: comboRows } = await sb
      .from('sofa_combo_pricing')
      .select('id, base_model, modules, tier, customer_id, prices_by_height, selling_prices_by_height, pwp_prices_by_height, label, effective_from, deleted_at, default_free_gifts')
      .is('deleted_at', null)
      .is('customer_id', null)
      .is('supplier_id', null);
    // Mirror the SofaComboRow shape from loadActiveSofaCombos.
    // For PWP combo matching we only need id, baseModel, modules.
    sofaCombos = ((comboRows ?? []) as Array<{
      id: string; base_model: string; modules: string[][];
    }>).map((r) => ({
      id: r.id,
      baseModel: r.base_model,
      modules: r.modules ?? [],
      tier: null,
      customerId: null,
      pricesByHeight: {},
      pwpPricesByHeight: {},
      label: null,
      effectiveFrom: '',
      deletedAt: null,
      defaultFreeGifts: [],
    }));
  }

  const sofaModules = extractSofaModules(args.product, args.variants);

  // ── Pure eligibility (all DB side-effects resolved, now pure logic) ───────
  const elig = checkPwpEligibility({
    codeRow: cRow,
    product: args.product,
    customerId: args.customerId,
    ownerStaffId: args.ownerStaffId,
    qty: args.qty,
    isOrphanedUsed: orphanedUsed,
    alreadyOnOrder,
    sofaCombos,
    sofaModules,
  });
  if (!elig.ok) return reject(elig.reason);

  // ── Atomic claim (mirrors create ~lines 1982-2007) ─────────────────────────
  let claimQ = sb
    .from('pwp_codes')
    .update({
      status:             'USED',
      source_doc_no:      cRow.source_doc_no ?? args.docNo,
      redeemed_doc_no:    args.docNo,
      redeemed_item_code: args.itemCode,
      updated_at:         new Date().toISOString(),
    })
    .eq('code', args.code)
    // The claim is the WRITE that burns the voucher; since 0188 re-keyed
    // pwp_codes (company_id, code), code alone no longer addresses one row.
    .eq('company_id', args.companyId);
  // Orphaned-USED re-claim: match USED + exact dead doc_no to avoid hijacking
  // a parallel legitimate redemption.
  claimQ = orphanedUsed
    ? claimQ.eq('status', 'USED').eq('redeemed_doc_no', cRow.redeemed_doc_no)
    : claimQ.in('status', ['RESERVED', 'AVAILABLE']);
  const { data: claimedRow } = await claimQ.select('code').maybeSingle();
  if (!claimedRow) return reject('code was just claimed by another order — try again');

  // prevStatus drives rollback (mirrors create ~lines 2004-2006).
  const prevStatus = orphanedUsed
    ? (cRow.owner_staff_id ? 'RESERVED' : 'AVAILABLE')
    : cRow.status;

  return {
    pwpBaseSen: elig.grantSofaComboIds ? null : elig.grantPwpPrice,
    pwpSofaComboIds: elig.grantSofaComboIds ?? null,
    claimed: { code: args.code, companyId: args.companyId, prevStatus },
    rejection: null,
  };
}

// ---------------------------------------------------------------------------
// Rollback — mirrors rollbackPwpClaims in mfg-sales-orders.ts (~lines 2014-2023)
// ---------------------------------------------------------------------------

/**
 * Restore a code to its pre-claim state after a subsequent failure.
 * Safe to call even if the code was already restored (idempotent via WHERE status='USED').
 */
export async function rollbackSinglePwpClaim(
  sb: any,
  /* companyId rides the claim receipt rather than being passed separately: a
     rollback must undo the row the claim actually took, and the two travelling
     together is what makes that true by construction. */
  claimed: { code: string; companyId: number; prevStatus: string },
): Promise<void> {
  const patch: Record<string, unknown> = {
    status: claimed.prevStatus,
    redeemed_doc_no: null,
    redeemed_item_code: null,
    updated_at: new Date().toISOString(),
  };
  // If restoring to RESERVED, also null source_doc_no — we stamped it on claim
  // (mirrors create rollbackPwpClaims ~line 2020).
  if (claimed.prevStatus === 'RESERVED') patch.source_doc_no = null;
  await sb.from('pwp_codes').update(patch)
    .eq('code', claimed.code)
    .eq('company_id', claimed.companyId)
    .eq('status', 'USED');
}
