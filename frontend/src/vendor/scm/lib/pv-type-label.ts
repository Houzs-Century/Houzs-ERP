/* The voucher's TYPE, in the owner's words (2026-09-07: 为什么我一直看到
   purpose - others? → 可以). `purpose` is the stored document-kind flag —
   SUPPLIER_PAYMENT for a voucher raised as an AP Payment, OTHER for a plain
   Payment Voucher (the old three-way purpose dropdown is gone; a legacy
   FREIGHT row reads as a plain voucher). It is not an expense category:
   what the money was for lives on each line's account. */
export type PvPurpose = 'SUPPLIER_PAYMENT' | 'FREIGHT' | 'OTHER';

export const pvTypeLabel = (purpose: string | null | undefined): 'AP Payment' | 'Payment Voucher' =>
  purpose === 'SUPPLIER_PAYMENT' ? 'AP Payment' : 'Payment Voucher';

/** The edit form's two choices — FREIGHT is read as a plain voucher. */
export const pvTypeOf = (purpose: string | null | undefined): 'SUPPLIER_PAYMENT' | 'OTHER' =>
  purpose === 'SUPPLIER_PAYMENT' ? 'SUPPLIER_PAYMENT' : 'OTHER';
