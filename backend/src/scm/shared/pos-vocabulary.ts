/* Houzs POS — the vocabularies the booth app's sync and the ERP's POS Sales
 * surfaces share: the payment methods a bill can be paid by, the word a
 * receipt row carries (PAID / VOID / RETURN), and the empty totals record.
 *
 * ONE home. backend/src/scm/shared/pos-vocabulary.ts is the original and
 * frontend/src/vendor/shared/pos-vocabulary.ts its byte-identical copy
 * (check-shared-mirrors.mjs). Money is integer sen.
 */

/** The label is the ONE statement of the method list; the array is derived. */
export const POS_METHOD_LABEL = {
  QR: "QR / DuitNow",
  CREDIT: "Credit Card",
  DEBIT: "Debit Card",
  EWALLET: "E-wallet",
  CASH: "Cash",
} as const;
export type PosPaymentMethod = keyof typeof POS_METHOD_LABEL;
export const POS_PAYMENT_METHODS = Object.keys(POS_METHOD_LABEL) as PosPaymentMethod[];

export function isPosPaymentMethod(v: unknown): v is PosPaymentMethod {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(POS_METHOD_LABEL, v);
}

export const posMethodLabel = (m: string): string => (isPosPaymentMethod(m) ? POS_METHOD_LABEL[m] : m);

/** The pill on a receipt row: VOID beats RETURN beats PAID. */
export type PosReceiptStatus = "PAID" | "VOID" | "RETURN";
export function posReceiptStatusLabel(r: { status: string; type: string }): PosReceiptStatus {
  if (r.status === "VOID") return "VOID";
  return r.type === "RETURN" ? "RETURN" : "PAID";
}
export function isPosReceiptStatus(v: unknown): v is PosReceiptStatus {
  return v === "PAID" || v === "VOID" || v === "RETURN";
}

export type PosSalesTotals = {
  /** Receipts in the list (every type and status). */
  count: number;
  paid_count: number;
  void_count: number;
  return_count: number;
  /** PAID sales minus PAID returns — what the booth actually took. */
  net_sen: number;
  /** PAID sales only (gross of returns). */
  sales_sen: number;
  return_sen: number;
  void_sen: number;
  discount_sen: number;
  sst_sen: number;
  /** Net received per payment method, PAID bills only; refunds are negative. */
  by_method: Record<string, number>;
};

export function emptyPosSalesTotals(): PosSalesTotals {
  return {
    count: 0, paid_count: 0, void_count: 0, return_count: 0,
    net_sen: 0, sales_sen: 0, return_sen: 0, void_sen: 0, discount_sen: 0, sst_sen: 0,
    by_method: {},
  };
}
