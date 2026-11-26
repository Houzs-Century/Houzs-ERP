import { scopeToCompany } from './companyScope';
import { normalizePhone } from '../shared/phone';

export type CrossCatEligibility = {
  eligible: boolean;
  reason?: 'not_found' | 'cancelled' | 'different_customer' | 'already_used' | 'lookup_failed';
  debtorName?: string | null;
};

export async function checkCrossCategorySource(
  c: any,
  sb: any,
  docNo: string,
  newPhoneRaw: string | null,
  newCustomerId: string | null = null,
): Promise<CrossCatEligibility> {
  const { data: srcRow, error: srcErr } = await scopeToCompany(sb
    .from('mfg_sales_orders')
    .select('doc_no, status, phone, debtor_name, customer_id')
    .eq('doc_no', docNo), c)
    .maybeSingle();
  if (srcErr) {
    console.error('[mfg-so] cross-category source lookup failed:', srcErr.message ?? srcErr);
    return { eligible: false, reason: 'lookup_failed' };
  }
  const src = srcRow as { doc_no: string; status: string; phone: string | null; debtor_name: string | null; customer_id: string | null } | null;
  if (!src) return { eligible: false, reason: 'not_found' };
  if (src.status === 'CANCELLED') return { eligible: false, reason: 'cancelled' };
  if (src.customer_id && newCustomerId) {
    if (src.customer_id !== newCustomerId) return { eligible: false, reason: 'different_customer' };
  } else {
    const newPhone = newPhoneRaw ? (normalizePhone(newPhoneRaw) ?? newPhoneRaw) : null;
    const srcPhone = src.phone ? (normalizePhone(src.phone) ?? src.phone) : null;
    if (newPhone && srcPhone && newPhone !== srcPhone) return { eligible: false, reason: 'different_customer' };
  }
  const { count, error: countErr } = await scopeToCompany(sb
    .from('mfg_sales_orders')
    .select('doc_no', { count: 'exact', head: true })
    .eq('cross_category_source_doc_no', docNo), c);
  if (countErr) {
    console.error('[mfg-so] cross-category already-used count failed:', countErr.message ?? countErr);
    return { eligible: false, reason: 'lookup_failed' };
  }
  if ((count ?? 0) > 0) return { eligible: false, reason: 'already_used' };
  return { eligible: true, debtorName: src.debtor_name ?? null };
}

export const crossCatReasonText = (docNo: string, reason?: string): string =>
  reason === 'not_found'         ? `Order ${docNo} was not found.`
  : reason === 'cancelled'         ? `Order ${docNo} is cancelled.`
  : reason === 'different_customer'? `Order ${docNo} belongs to a different customer.`
  : reason === 'already_used'      ? `Order ${docNo} was already used for a cross-category discount.`
  : reason === 'lookup_failed'     ? `Could not verify order ${docNo} — please try again.`
  :                                  `Order ${docNo} is not a valid linked order.`;
