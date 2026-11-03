// ----------------------------------------------------------------------------
// payment-vocab — the live, active payment dropdown vocabulary and the snap that
// enforces "never invent a value not in the live list".
//
// ONE HOME for the four payment-cascade categories (payment_method /
// payment_merchant / online_type / installment_plan) and the canonical-casing
// snap. Lifted out of scm/routes/scan-payment.ts so the Houzs Connect payment
// push (routes/connect-payments.ts) validates a pushed bank / online sub-type
// against the SAME active so_dropdown_options the OCR flow snaps to — rather
// than carrying a second, drifting copy of the loader and the match. scan-payment
// keeps its OCR-specific prompt + formatOptions; only the load + snap moved.
// ----------------------------------------------------------------------------
import type { SupabaseClient as SupabaseClientGeneric } from '@supabase/supabase-js';
import { paginateAll } from './paginate-all';

// scm-scoped, loosely-typed client (matches scm/env.ts Variables.supabase and
// the service-role client from db/supabase.getSupabaseService).
type SupabaseClient = SupabaseClientGeneric<any, any, any>;

export const PAYMENT_OPTION_CATEGORIES = [
  'payment_method',     // L1 — Merchant / Online / Cash (3-method model)
  'payment_merchant',   // L2 merchant banks (MBB / CIMB / Public / AEON / …)
  'online_type',        // L2 online sub-types (Bank Transfer / TNG / Cheque / DuitNow)
  'installment_plan',   // L2 Merchant plans (One Shot / 3 / 6 / 12 / 24 / 36 months)
] as const;
export type PaymentOptionCategory = (typeof PAYMENT_OPTION_CATEGORIES)[number];
export type CatalogOption = { value: string; label: string };
export type CatalogOptions = Record<PaymentOptionCategory, CatalogOption[]>;

export const emptyPaymentOptions = (): CatalogOptions => ({
  payment_method:   [],
  payment_merchant: [],
  online_type:      [],
  installment_plan: [],
});

/** Pull the live, ACTIVE payment vocabularies from so_dropdown_options, scoped
 *  to the caller's company (multi-company, mig 0089 — null/undefined stays
 *  global). Paged so PostgREST's 1000-row cap can't drop option rows. */
export async function loadPaymentOptions(
  sb: SupabaseClient,
  companyId?: number | null,
): Promise<CatalogOptions> {
  const options = emptyPaymentOptions();
  const { data } = await paginateAll((from, to) => {
    let q = sb
      .from('so_dropdown_options')
      .select('category, value, label')
      .eq('active', true)
      .in('category', PAYMENT_OPTION_CATEGORIES as unknown as string[])
      .order('category', { ascending: true })
      .order('sort_order', { ascending: true })
      .order('label', { ascending: true });
    if (companyId != null) q = q.eq('company_id', companyId);
    return q.range(from, to);
  });
  for (const row of (data as Array<{ category: string; value: string; label: string }> | null) ?? []) {
    if ((PAYMENT_OPTION_CATEGORIES as readonly string[]).includes(row.category)) {
      options[row.category as PaymentOptionCategory].push({ value: row.value, label: row.label });
    }
  }
  return options;
}

/** Snap a free-typed value to the canonical casing of an ACTIVE option in the
 *  given category's list, or null when it is not in the live list. Case- and
 *  whitespace-insensitive match; this is the "never invent" enforcement every
 *  reader shares (scan-payment's validateReceipt, the Connect payment push). */
export function snapPaymentOption(
  options: CatalogOption[],
  value: string | null | undefined,
): string | null {
  const v = String(value ?? '').trim();
  if (v === '') return null;
  const canon = new Map(options.map((o) => [o.value.toUpperCase(), o.value]));
  return canon.get(v.toUpperCase()) ?? null;
}
