
import { matchComboBuild } from '../shared';
import type { SofaComboRow } from '../shared/sofa-build';
import { loadLiveCombosByIds } from './pos-sofa-combos';


export interface SinglePwpClaimResult {
  pwpBaseSen: number | null;
  pwpSofaComboIds: string[] | null;
  claimed: { code: string; companyId: number; prevStatus: string } | null;
  rejection: { code: string; reason: string } | null;
}

export interface PwpClaimSingleArgs {
  code: string;
  companyId: number;
  docNo: string;
  itemCode: string;
  product: {
    category: string;
    model_id: string | null;
    base_model: string | null;
    pwp_price_sen?: number | null;
  };
  customerId: string | null;
  ownerStaffId: string;
  qty: number;
  variants: Record<string, unknown> | null;
}


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
  isOrphanedUsed: boolean;
  alreadyOnOrder: boolean;
  sofaCombos: SofaComboRow[];
  sofaModules: string[];
}

export type PureEligibilityResult =
  | { ok: true; grantPwpPrice: number; grantSofaComboIds: null }
  | { ok: true; grantPwpPrice: 0; grantSofaComboIds: string[] }
  | { ok: false; reason: string };

/**
 * Pure (no DB) eligibility check.
 * Mirrors the inner create-loop body: status, customer binding, category,
 * model/combo eligibility.  isOrphanedUsed + alreadyOnOrder must be resolved
 * by the async wrapper before calling this.
 */
export function checkPwpEligibility(args: PureEligibilityArgs): PureEligibilityResult {
  const { codeRow: cRow, product, customerId, ownerStaffId, qty, isOrphanedUsed, alreadyOnOrder, sofaCombos, sofaModules } = args;

  if (qty !== 1) return { ok: false, reason: 'a PWP reward line must be quantity 1' };

  if (!cRow) return { ok: false, reason: 'code not found — it may have been replaced; re-apply PWP on this line' };

  if (alreadyOnOrder) return { ok: false, reason: 'code is already applied to another line on this order' };

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

  const prodCat = String(product.category ?? '').toUpperCase();
  if (prodCat !== String(cRow.reward_category ?? '').toUpperCase()) {
    return { ok: false, reason: `code rewards ${String(cRow.reward_category)}, not this item` };
  }

  if (cRow.status === 'AVAILABLE' && cRow.customer_id && customerId && cRow.customer_id !== customerId) {
    return { ok: false, reason: 'code belongs to a different customer' };
  }

  if (prodCat === 'SOFA') {
    const rewardComboIds = (cRow.reward_combo_ids ?? []) as string[];
    if (rewardComboIds.length === 0) return { ok: false, reason: 'voucher has no reward combos' };
    if (sofaModules.length === 0) return { ok: false, reason: 'sofa line carries no build modules' };
    const candidate = sofaCombos.filter(
      (c) => rewardComboIds.includes(c.id) && (!product.base_model || c.baseModel === product.base_model),
    );
    if (!candidate.some((c) => matchComboBuild({ modules: sofaModules }, c) != null)) {
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

  if (args.qty !== 1) return reject('a PWP reward line must be quantity 1');

  const { data: codeRows, error: fetchErr } = await sb
    .from('pwp_codes')
    .select('code, status, owner_staff_id, reward_category, eligible_reward_model_ids, reward_combo_ids, customer_id, source_doc_no, redeemed_doc_no, type')
    .eq('code', args.code)
    .eq('company_id', args.companyId)
    .limit(1);
  if (fetchErr) return reject('could not verify the code — please try again');
  const cRow: PwpCodeRow | null = (codeRows as PwpCodeRow[] | null)?.[0] ?? null;
  if (!cRow) return reject('code not found — it may have been replaced; re-apply PWP on this line');

  const { data: existingItems, error: itemsErr } = await sb
    .from('mfg_sales_order_items')
    .select('variants')
    .eq('doc_no', args.docNo);
  if (itemsErr) {
    console.error('[pwp-claim-single] item variants lookup failed:', itemsErr.message ?? itemsErr);
    return reject('could not verify the code — please try again (code_lookup_failed)');
  }
  const alreadyOnOrder = codeAlreadyOnOrder(
    existingItems as Array<{ variants: unknown }> | null,
    args.code,
  );

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

  let sofaCombos: SofaComboRow[] = [];
  const prodCat = String(args.product.category ?? '').toUpperCase();
  if (prodCat === 'SOFA') {
    const combosById = await loadLiveCombosByIds(sb, null);
    sofaCombos = [...combosById.entries()].map(([id, r]) => ({
      id,
      baseModel: r.base_model,
      modules: r.modules,
      accessories: r.accessories,
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
    .eq('company_id', args.companyId);
  claimQ = orphanedUsed
    ? claimQ.eq('status', 'USED').eq('redeemed_doc_no', cRow.redeemed_doc_no)
    : claimQ.in('status', ['RESERVED', 'AVAILABLE']);
  const { data: claimedRow } = await claimQ.select('code').maybeSingle();
  if (!claimedRow) return reject('code was just claimed by another order — try again');

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


/**
 * Restore a code to its pre-claim state after a subsequent failure.
 * Safe to call even if the code was already restored (idempotent via WHERE status='USED').
 */
export async function rollbackSinglePwpClaim(
  sb: any,
  claimed: { code: string; companyId: number; prevStatus: string },
): Promise<void> {
  const patch: Record<string, unknown> = {
    status: claimed.prevStatus,
    redeemed_doc_no: null,
    redeemed_item_code: null,
    updated_at: new Date().toISOString(),
  };
  if (claimed.prevStatus === 'RESERVED') patch.source_doc_no = null;
  await sb.from('pwp_codes').update(patch)
    .eq('code', claimed.code)
    .eq('company_id', claimed.companyId)
    .eq('status', 'USED');
}
