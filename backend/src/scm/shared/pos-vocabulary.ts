
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
  count: number;
  paid_count: number;
  void_count: number;
  return_count: number;
  net_sen: number;
  sales_sen: number;
  return_sen: number;
  void_sen: number;
  discount_sen: number;
  sst_sen: number;
  by_method: Record<string, number>;
};

export function emptyPosSalesTotals(): PosSalesTotals {
  return {
    count: 0, paid_count: 0, void_count: 0, return_count: 0,
    net_sen: 0, sales_sen: 0, return_sen: 0, void_sen: 0, discount_sen: 0, sst_sen: 0,
    by_method: {},
  };
}
