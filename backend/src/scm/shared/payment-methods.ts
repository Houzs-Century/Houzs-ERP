/* ----------------------------------------------------------------------------
   Payment methods — the single source of truth for the L1 method vocabulary.

   Loo 2026-06-06: "i want all same together and decide from so maintenance
   page". The POS handover cards, the Backend New-SO / SO-Detail Payments
   cascade, and the SO Maintenance editor all share ONE list: the
   so_dropdown_options 'payment_method' category. This module is the bridge
   between that list and the code that branches on a method:

   - Each LOCKED maintenance row's VALUE is an immutable key ('Merchant' /
     'Online' / 'Cash') — the API blocks value edits, adds, deletes and
     deactivation for these core rows (see routes/so-dropdown-options.ts).
     2026-06-24: the L1 method set is THREE (Merchant / Online / Cash).
     'Installment' is NO LONGER a top-level method — it is the *plan under
     Merchant* (a bank EPP is Merchant + an installment_months tenure). The
     'installment' ledger code below is RETAINED for back-compat with already
     stored payment rows (mfg_sales_order_payments.method) and the manual
     Finance route, but 'Installment' is NOT a protected L1 row — so the
     migration that deactivates the L1 'Installment' so_dropdown_options row is
     not blocked / re-locked by isCorePaymentMethodRow.
   - Each VALUE maps here to an internal CODE ('merchant' / 'transfer' /
     'installment' / 'cash') — what the ledger stores
     (mfg_sales_order_payments.method) and what branch logic switches on.
   - The row's LABEL is free — renaming it in SO Maintenance re-labels the
     POS cards and the Backend selects everywhere, with zero code impact.

   Don't add a 5th code here without wiring its branch logic end-to-end
   (POS card behaviour, deposit ledger, payments route, list-grid summary).

   THE ROUTE SCHEMAS READ PAYMENT_METHOD_CODES, they do not re-type it. Until
   2026-08-13 seven `z.enum(['merchant','transfer','cash','installment'])`
   literals stood in mfg-sales-orders / consignment-orders / consignment-notes /
   delivery-orders-mfg / sales-invoices — in a different order from this list,
   with one of them carrying a "kept in sync with PAYMENT_METHOD_CODES in
   packages/shared/src/payment-methods.ts" comment naming a path this repo does
   not have. A 5th code added here would have been rejected by every payments
   endpoint, which is the failure the paragraph above was written to prevent.
   ---------------------------------------------------------------------------- */

/** Internal method code — persisted on payment rows, branched on in code. */
export type PaymentMethodCode = 'merchant' | 'transfer' | 'installment' | 'cash';

export const PAYMENT_METHOD_CODES = ['merchant', 'transfer', 'installment', 'cash'] as const;

/** LOCKED L1 method VALUE (immutable key) → internal code. THREE rows only
 *  (Merchant / Online / Cash) — these are the protected core payment methods
 *  (isCorePaymentMethodRow keys off this map). 'Installment' is deliberately
 *  ABSENT: it is no longer a top-level method (it is the plan under Merchant),
 *  so its L1 so_dropdown_options row is unprotected and can be deactivated.
 *  'Online' → 'transfer' is historical: the ledger enum predates the
 *  maintenance cascade (migration 0083) and renaming stored methods would
 *  orphan Finance data. */
export const PAYMENT_METHOD_VALUE_TO_CODE: Readonly<Record<string, PaymentMethodCode>> = {
  Merchant: 'merchant',
  Online:   'transfer',
  Cash:     'cash',
};

/** Internal code → maintenance row VALUE (the immutable key). */
export const PAYMENT_METHOD_CODE_TO_VALUE: Readonly<Record<PaymentMethodCode, string>> = {
  merchant:    'Merchant',
  transfer:    'Online',
  installment: 'Installment',
  cash:        'Cash',
};

/** Display-label fallbacks — used before the maintenance fetch lands or if a
 *  row is somehow missing. The LIVE labels come from the payment_method rows;
 *  these mirror the seeds in migration 0156. */
export const PAYMENT_METHOD_DEFAULT_LABELS: Readonly<Record<PaymentMethodCode, string>> = {
  merchant:    'Merchant',
  transfer:    'Bank transfer / DuitNow',
  installment: 'Installment',
  cash:        'Cash',
};

/** Resolve a maintenance VALUE to its internal code, or null when the value
 *  isn't one of the three core rows (a legacy 'Installment' L1 row, or bad
 *  data — renders must never crash). Legacy installment ledger rows persist
 *  the 'installment' code directly, so they are unaffected by this lookup. */
export const paymentMethodCodeForValue = (value: string): PaymentMethodCode | null =>
  PAYMENT_METHOD_VALUE_TO_CODE[value] ?? null;

/** True when this (category, value) pair is one of the three locked core
 *  payment-method rows (Merchant / Online / Cash) — the API refuses to
 *  delete/deactivate these and the maintenance UIs render them with the lock
 *  affordance. 'Installment' is NOT core, so it returns false. */
export const isCorePaymentMethodRow = (category: string, value: string): boolean =>
  category === 'payment_method' && value in PAYMENT_METHOD_VALUE_TO_CODE;
