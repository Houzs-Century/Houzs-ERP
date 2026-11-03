// ----------------------------------------------------------------------------
// connect-payment-map — the PURE decisions behind the Houzs Connect payment push
// (routes/connect-payments.ts): the method token map, RM→sen, currency guard,
// and the Sales-Order match classifier. No Supabase, no env, no I/O — so every
// branch is unit-testable (tests/connectPayments.test.ts) without a live DB, the
// way the route handler itself cannot be (it needs the scm Postgres schema).
// ----------------------------------------------------------------------------

/** The ERP ledger method codes a Connect push can resolve to. Connect sends the
 *  owner's 3-method vocabulary (Card / Online / Cash); the ERP persists the
 *  internal codes (scm/shared/payment-methods). A card EPP is still 'merchant'
 *  with an installment term, never a 4th method. */
export type ConnectMethodCode = 'merchant' | 'transfer' | 'cash';

/** Map Connect's method token to the ERP ledger code, or null when it is none of
 *  the three. "Card" is the owner's "Merchant" (PAYMENT_METHOD_VALUE_TO_CODE maps
 *  Online→transfer); both spellings are accepted, case-insensitively, so Connect
 *  may send either its own label or the ERP's. */
export function mapConnectMethod(raw: string | null | undefined): ConnectMethodCode | null {
  switch (String(raw ?? '').trim().toLowerCase()) {
    case 'card':
    case 'merchant':
      return 'merchant';
    case 'online':
    case 'transfer':
      return 'transfer';
    case 'cash':
      return 'cash';
    default:
      return null;
  }
}

/** RM (a decimal number) → integer sen, or null when it is not a positive,
 *  finite amount. Rounds to the nearest sen (float cents never reach the DB). */
export function rmToSen(amount: number | null | undefined): number | null {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) return null;
  return Math.round(amount * 100);
}

/** The ERP books Malaysian ringgit only. Empty / 'MYR' / 'RM' pass (Connect may
 *  omit it); any other currency is refused — a foreign-currency slip is not
 *  something this endpoint may silently book as RM. */
export function isSupportedCurrency(currency: string | null | undefined): boolean {
  const c = String(currency ?? '').trim().toUpperCase();
  return c === '' || c === 'MYR' || c === 'RM';
}

/** A Sales-Order row as resolved for matching: our own doc_no and, when the
 *  order is AutoCount-linked, the number the customer / Connect was shown. */
export type SoMatchRow = { doc_no: string; linked_ac_docno: string | null };

export type SoMatchResult =
  | { ok: true; docNo: string }
  | { ok: false; reason: string };

/**
 * Resolve `order_ref` to exactly ONE Sales Order, or refuse. An exact doc_no hit
 * wins over a linked AutoCount-number hit (the same precedence chatCallback uses),
 * so a number that is somehow both is booked against the order that literally
 * carries it. Zero hits, or more than one at the same precedence, is NOT a
 * confident match — the caller must queue it for manual linking, never book blind.
 */
export function classifySoMatch(hits: SoMatchRow[], orderRef: string): SoMatchResult {
  const ref = String(orderRef ?? '').trim();
  if (ref === '') return { ok: false, reason: 'order_ref is blank' };
  const byDoc = hits.filter((h) => h.doc_no === ref);
  if (byDoc.length === 1) return { ok: true, docNo: byDoc[0].doc_no };
  if (byDoc.length > 1) {
    return { ok: false, reason: `order_ref ${ref} matched ${byDoc.length} sales orders by doc_no` };
  }
  const byLinked = hits.filter((h) => h.linked_ac_docno === ref);
  if (byLinked.length === 1) return { ok: true, docNo: byLinked[0].doc_no };
  if (byLinked.length > 1) {
    return { ok: false, reason: `order_ref ${ref} matched ${byLinked.length} sales orders by AutoCount number` };
  }
  return { ok: false, reason: `no sales order found for order_ref ${ref}` };
}
