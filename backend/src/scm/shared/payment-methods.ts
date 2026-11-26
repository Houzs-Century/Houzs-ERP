
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

export const PAYMENT_METHOD_CORE_VALUES: readonly string[] = [
  'Merchant', 'Online', 'Cash', 'Installment',
];

/** True when this (category, value) pair is one of the four locked core
 *  payment-method rows (Merchant / Online / Cash / Installment) — the API
 *  refuses to delete/deactivate these and the maintenance UIs render them with
 *  the lock affordance. */
export const isCorePaymentMethodRow = (category: string, value: string): boolean =>
  category === 'payment_method' && PAYMENT_METHOD_CORE_VALUES.includes(value);
