// ----------------------------------------------------------------------------
// Product SELLING-price effective-dating resolver (Pricing "Option B", Phase 1).
//
// Owner 2026-07-24 ("我要B"): a product's selling price is scheduled by date and
// a sales order takes the price effective ON ITS OWN DATE. This resolves the
// as-of price from scm.mfg_product_price_history (migration 0187), or returns
// null so the caller falls back to the flat scm.mfg_products.sell_price_sen.
//
// Copied from the maintenance-config resolver that already works here
// (loadConfigForScope, po-pricing.ts:31-47): newest effective_from <= asOf,
// tie-broken by created_at, limit 1. See docs/pricing-effective-dating-design.md.
//
// BACKWARD-COMPATIBLE: with the history table empty every lookup returns null, so
// pricing is byte-identical to today until a price is scheduled. Company-scoped —
// the same product_code can exist under both companies.
//
// supabase-js only (matches po-pricing.ts's `sb: any`); the raw-SQL callers add
// the predicate by hand.
import { todayMyt } from './my-time';

/** The as-of SELLING price (sen) for a product on a given date, or null when no
 *  scheduled price applies — caller then uses the flat mfg_products value. */
export async function resolveSellPriceSenAsOf(
  sb: any,
  companyId: number,
  productCode: string,
  asOf: string = todayMyt(),
): Promise<number | null> {
  const code = (productCode ?? '').trim();
  if (!code || !Number.isInteger(companyId) || companyId <= 0) return null;
  const { data } = await sb
    .from('mfg_product_price_history')
    .select('sell_price_sen')
    .eq('company_id', companyId)
    .eq('product_code', code)
    .lte('effective_from', asOf)
    .order('effective_from', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const v = (data as { sell_price_sen?: number | null } | null)?.sell_price_sen;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** The NEXT scheduled price strictly AFTER asOf (for a "next: RM X from <date>"
 *  badge), or null when none is pending. Mirror query of the resolver above. */
export async function resolvePendingSellPriceAfter(
  sb: any,
  companyId: number,
  productCode: string,
  asOf: string = todayMyt(),
): Promise<{ sellPriceSen: number; effectiveFrom: string } | null> {
  const code = (productCode ?? '').trim();
  if (!code || !Number.isInteger(companyId) || companyId <= 0) return null;
  const { data } = await sb
    .from('mfg_product_price_history')
    .select('sell_price_sen, effective_from')
    .eq('company_id', companyId)
    .eq('product_code', code)
    .gt('effective_from', asOf)
    .order('effective_from', { ascending: true })
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  const row = data as { sell_price_sen?: number | null; effective_from?: string } | null;
  if (!row || typeof row.sell_price_sen !== 'number' || !row.effective_from) return null;
  return { sellPriceSen: row.sell_price_sen, effectiveFrom: row.effective_from };
}
