// The SO list's money per row, desktop and mobile. From the view
// scm.mfg_sales_orders_with_payment_totals: paid = the order's payments ledger,
// balance = total - paid. The stored header columns
// paid_sen / balance_sen are never money: paid_sen is not written by the ERP
// and recomputeTotals writes the gross total into balance_sen, so a fallback to
// them showed every order as unpaid / owing in full.

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
