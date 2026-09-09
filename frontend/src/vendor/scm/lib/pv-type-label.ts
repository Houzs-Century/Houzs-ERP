/* The voucher's TYPE, in the owner's words (2026-09-07: 为什么我一直看到
   purpose - others? → 可以). `purpose` is the stored document-kind flag —
   SUPPLIER_PAYMENT for a voucher raised as an AP Payment, OTHER for a plain
   Payment Voucher (the old three-way purpose dropdown is gone; a legacy
   FREIGHT row reads as a plain voucher). It is not an expense category:
   what the money was for lives on each line's account. */
export type PvPurpose = 'SUPPLIER_PAYMENT' | 'FREIGHT' | 'OTHER' | 'CUSTOMER_REFUND';

/* The third kind (owner 2026-09-07, payment-voucher.md §14): a refund to a
   customer rides the same paper with the customer where the supplier would
   be. Its type is fixed at birth — the edit form never offers it. */
export const isRefundPurpose = (purpose: string | null | undefined): boolean => purpose === 'CUSTOMER_REFUND';

export const pvTypeLabel = (purpose: string | null | undefined): 'AP Payment' | 'Payment Voucher' | 'Customer Refund' =>
  purpose === 'SUPPLIER_PAYMENT' ? 'AP Payment' : isRefundPurpose(purpose) ? 'Customer Refund' : 'Payment Voucher';

/** The edit form's two choices — FREIGHT is read as a plain voucher. */
export const pvTypeOf = (purpose: string | null | undefined): 'SUPPLIER_PAYMENT' | 'OTHER' =>
  purpose === 'SUPPLIER_PAYMENT' ? 'SUPPLIER_PAYMENT' : 'OTHER';
