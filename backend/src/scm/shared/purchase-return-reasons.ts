// Purchase-return reason codes — single source of truth for the dropdown
// (frontend) AND the backend validation gate, so the same list is enforced on
// both sides. Owner 2026-09-28: 「when raise purchase return need input reason
// and put in remark」 — the reason is now REQUIRED and picked from this list,
// with the free-text remark beside it in `notes`.
//
// Stored in scm.purchase_returns.reason. Rows raised before 2026-09-28 hold
// free text; purchaseReturnReasonLabel shows any unrecognised value verbatim
// rather than hiding it, so the history stays readable without a rewrite.
//
// REPAIR is the one code that changes what the document DOES: a repair return
// expects the goods BACK, so it is raised as kind = 'REPAIR', chases no credit
// note, and moves the stock into the repair warehouse instead of off the books.
// Keep that pairing — a REPAIR reason on a CREDIT return would promise a credit
// note for goods that are coming back.

export const PURCHASE_RETURN_REASONS = [
  { code: 'DAMAGED', label: 'Damaged' },
  { code: 'WRONG_COLOUR', label: 'Wrong colour' },
  { code: 'WRONG_ITEM', label: 'Wrong item' },
  { code: 'OVER_SUPPLY', label: 'Over-supply' },
  { code: 'QUALITY', label: 'Quality not acceptable' },
  { code: 'REPAIR', label: 'Send for repair' },
  { code: 'OTHER', label: 'Other' },
] as const;

export type PurchaseReturnReasonCode = (typeof PURCHASE_RETURN_REASONS)[number]['code'];

export const PURCHASE_RETURN_REASON_CODES: readonly string[] = PURCHASE_RETURN_REASONS.map((r) => r.code);

export const isPurchaseReturnReasonCode = (v: unknown): v is PurchaseReturnReasonCode =>
  typeof v === 'string' && PURCHASE_RETURN_REASON_CODES.includes(v);

export const purchaseReturnReasonLabel = (code: string | null | undefined): string => {
  if (!code) return '—';
  const found = PURCHASE_RETURN_REASONS.find((r) => r.code === code);
  return found ? found.label : code;
};

/** What a return is FOR. CREDIT: goods go back for good, the supplier owes a
 *  credit note. REPAIR: goods go to be fixed and are expected back. */
export const PURCHASE_RETURN_KINDS = ['CREDIT', 'REPAIR'] as const;
export type PurchaseReturnKind = (typeof PURCHASE_RETURN_KINDS)[number];

export const isPurchaseReturnKind = (v: unknown): v is PurchaseReturnKind =>
  typeof v === 'string' && (PURCHASE_RETURN_KINDS as readonly string[]).includes(v);

/** The reason a REPAIR return carries. The two are one decision on the form. */
export const REPAIR_REASON_CODE: PurchaseReturnReasonCode = 'REPAIR';

/** Does this pair make sense? A REPAIR return must say REPAIR, and a CREDIT one
 *  must not — otherwise a document promises a credit note for goods that are
 *  coming back, or chases nothing for goods that are not. */
export const kindMatchesReason = (kind: string, reasonCode: string): boolean =>
  kind === 'REPAIR' ? reasonCode === REPAIR_REASON_CODE : reasonCode !== REPAIR_REASON_CODE;
