
type SoListMoneyRow = {
  local_total_sen?: number | null;
  paid_total_sen?: number | null;
  balance_sen_live?: number | null;
};

/** Paid on the order, from the view; 0 when the view's column is absent. */
export const soListPaidSen = (r: SoListMoneyRow | null | undefined): number => r?.paid_total_sen ?? 0;

/** Signed balance (negative = over-collected), from the view; total - paid when the live column is absent. */
export const soListBalanceSen = (r: SoListMoneyRow): number =>
  r.balance_sen_live ?? (r.local_total_sen ?? 0) - soListPaidSen(r);
