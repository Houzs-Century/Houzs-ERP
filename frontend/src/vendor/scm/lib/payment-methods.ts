// Vendored VERBATIM from packages/shared/src/payment-methods.ts — pure
// constants + helpers, no imports. Aliased as @2990s/shared/payment-methods.

export type PaymentMethodCode = 'merchant' | 'transfer' | 'installment' | 'cash';

export const PAYMENT_METHOD_CODES = ['merchant', 'transfer', 'installment', 'cash'] as const;

/* MIRRORS backend/src/scm/shared/payment-methods.ts. 'Installment' is NOT in
   this map, matching the backend: paymentMethodCodeOf must not resolve it
   (legacy installment ledger rows persist the code directly). The LOCKED set is
   a separate constant below — this copy used to fold the two together, which is
   how the UI came to lock a row the API would have let you delete. */
export const PAYMENT_METHOD_VALUE_TO_CODE: Readonly<Record<string, PaymentMethodCode>> = {
  Merchant:    'merchant',
  Online:      'transfer',
  Cash:        'cash',
};

/** The four locked core rows — mirrors PAYMENT_METHOD_CORE_VALUES on the backend. */
export const PAYMENT_METHOD_CORE_VALUES: readonly string[] = [
  'Merchant', 'Online', 'Cash', 'Installment',
];

export const PAYMENT_METHOD_CODE_TO_VALUE: Readonly<Record<PaymentMethodCode, string>> = {
  merchant:    'Merchant',
  transfer:    'Online',
  installment: 'Installment',
  cash:        'Cash',
};

export const PAYMENT_METHOD_DEFAULT_LABELS: Readonly<Record<PaymentMethodCode, string>> = {
  merchant:    'Merchant',
  transfer:    'Bank transfer / DuitNow',
  installment: 'Installment',
  cash:        'Cash',
};

export const paymentMethodCodeForValue = (value: string): PaymentMethodCode | null =>
  PAYMENT_METHOD_VALUE_TO_CODE[value] ?? null;

export const isCorePaymentMethodRow = (category: string, value: string): boolean =>
  category === 'payment_method' && PAYMENT_METHOD_CORE_VALUES.includes(value);
