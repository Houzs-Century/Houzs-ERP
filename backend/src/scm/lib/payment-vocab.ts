import type { SupabaseClient as SupabaseClientGeneric } from '@supabase/supabase-js';
import { paginateAll } from './paginate-all';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose scm client; no generated schema types (same as scan-payment.ts / scm route Variables.supabase)
type SupabaseClient = SupabaseClientGeneric<any, any, any>;

export const PAYMENT_OPTION_CATEGORIES = [
  'payment_method',
  'payment_merchant',
  'online_type',
  'installment_plan',
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
 *  to the caller's company (multi-company, mig 0089 — `null` is the GLOBAL,
 *  no-company read, and is passed explicitly: the scope decides which rows come
 *  back, so it is a required argument, never an omittable default). Paged so
 *  PostgREST's 1000-row cap can't drop option rows.
 *
 *  Returns `{ options, error }`: a read failure rides back rather than
 *  collapsing to an empty vocabulary, because "no options" and "the read
 *  failed" must not look alike — an empty list would silently clear every match
 *  the caller tries to snap. On error `options` is empty; the caller decides
 *  whether that is fatal (the Connect push fails, retryable) or tolerable. */
export async function loadPaymentOptions(
  sb: SupabaseClient,
  companyId: number | null,
): Promise<{ options: CatalogOptions; error: { message: string } | null }> {
  const options = emptyPaymentOptions();
  const { data, error } = await paginateAll((from, to) => {
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
  if (error) return { options, error };
  for (const row of (data as Array<{ category: string; value: string; label: string }> | null) ?? []) {
    if ((PAYMENT_OPTION_CATEGORIES as readonly string[]).includes(row.category)) {
      options[row.category as PaymentOptionCategory].push({ value: row.value, label: row.label });
    }
  }
  return { options, error: null };
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
