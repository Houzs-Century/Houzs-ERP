import { scopeToCompany } from './companyScope';
import { normalizePhone } from '../shared/phone';

/* Cross-category delivery link (migration 0141) — shared eligibility check used
   by BOTH the live handover preview (GET /cross-category-eligibility) and the
   order POST, so the fee shown equals the fee charged. A non-empty SO number is
   eligible only when it exists, isn't cancelled, belongs to the same customer
   (by normalized phone, when both have one), and hasn't already backed another
   follow-up (the unique index is the hard backstop). */
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
  /* Both reads below are keyed on a caller-supplied doc_no. Unscoped, the
     eligibility probe answered for the OTHER company's order and handed back
     its debtor_name — a customer identity, from a GET that needs only a doc
     number. `c` is threaded in for exactly this. */
  const { data: srcRow, error: srcErr } = await scopeToCompany(sb
    .from('mfg_sales_orders')
    .select('doc_no, status, phone, debtor_name, customer_id')
    .eq('doc_no', docNo), c)
    .maybeSingle();
  /* Loo 2026-06-06 (SO-2606-025 incident) — a FAILED query is not a missing
     order. This used to swallow the error and report "Order was not found"
     for a real SO when the CF Workers free-plan subrequest cap killed this
     exact fetch (#51 of 50). Surface it as retryable instead. */
  if (srcErr) {
    console.error('[mfg-so] cross-category source lookup failed:', srcErr.message ?? srcErr);
    return { eligible: false, reason: 'lookup_failed' };
  }
  const src = srcRow as { doc_no: string; status: string; phone: string | null; debtor_name: string | null; customer_id: string | null } | null;
  if (!src) return { eligible: false, reason: 'not_found' };
  if (src.status === 'CANCELLED') return { eligible: false, reason: 'cancelled' };
  /* "Same customer" — prefer the real customer_id link (exact) now that every
     new SO resolves one (migration 0144). Fall back to normalised phone only
     when the SOURCE is a legacy row with no customer_id; the NEW order always
     carries both a compulsory phone and a resolved customer_id. */
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
  // Same honesty rule as above — a failed count must not silently pass the
  // already-used gate (fail-open) nor masquerade as another reason.
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
