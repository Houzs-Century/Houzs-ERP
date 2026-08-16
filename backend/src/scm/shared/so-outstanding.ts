// ----------------------------------------------------------------------------
// so-outstanding — WHAT A SALES ORDER STILL OWES, computed in ONE place.
//
// WHY THIS FILE EXISTS. This repo's recurring write-back defect is a fact the
// ERP keeps in two columns where the reader picks the wrong one — it has cost
// three incidents (`supplier_sku`, the stock location, the salesperson; see
// docs/autocount-writeback-golive-coe.md section 2). The outstanding balance is
// the same shape with THREE candidates, and the obvious one is the wrong one:
//
//   scm.mfg_sales_orders.balance_centi   NOT the balance. `recomputeTotals`
//       writes `balance_centi = local_total_centi = total_revenue_centi =
//       grandTotal` on every edit (mfg-sales-orders.ts), so it never reflects a
//       payment. It LOOKS right because the cutover really did land AutoCount's
//       UDF_BALANCE in it (check-migration-fidelity.mjs:95), and the first edit
//       of any order overwrote that with the gross total.
//   the view's balance_centi_live      local_total − SUM(payments). Right for
//       the SO list, the mobile list and delivery planning, and it MISSES the
//       legacy header deposit that never reached the ledger.
//   this function                      what the SO detail page and the
//       customer-facing print show, which is the number a human has actually
//       agreed with the customer.
//
// The rule itself is not new — it is `GET /mfg-sales-orders/:docNo`'s, lifted
// out so the write-back cannot compute a different one. A second
// implementation of a money rule is how the two worlds disagree quietly.
// ----------------------------------------------------------------------------

/** The three reads the rule needs, in sen. */
export interface SoPaidInputs {
  /** `scm.mfg_sales_orders.total_revenue_centi`. */
  totalRevenueCenti: number;
  /** `scm.mfg_sales_orders.deposit_centi` — the LEGACY header deposit. */
  headerDepositCenti: number;
  /** SUM of `scm.mfg_sales_order_payments.amount_centi` for this document. */
  ledgerPaidCenti: number;
  /** Any of those payment rows carries `is_deposit`. */
  depositInLedger: boolean;
}

/**
 * Everything received on this order, in sen.
 *
 * The header deposit is added ONLY when the ledger does not already carry it as
 * an `is_deposit` row. Since the SO create path writes the deposit as a ledger
 * row (and history was backfilled), adding the header column on top would
 * DOUBLE COUNT every modern order; leaving it out entirely would under-count
 * the legacy ones. The `is_deposit` marker is what tells the two worlds apart.
 *
 * `scm.mfg_sales_orders.paid_centi` is deliberately not an input: it is
 * deprecated, no writer maintains it, and it is 0 on any order paid through the
 * payment drawer.
 */
export function soPaidCenti(a: SoPaidInputs): number {
  return (a.depositInLedger ? 0 : a.headerDepositCenti) + a.ledgerPaidCenti;
}

/**
 * What the order still owes, in sen. Never negative — an overpayment is a
 * credit, and AutoCount's own UDF_BALANCE is not where a credit belongs.
 *
 * THIS IS THE WRITE-BACK'S RULE, not the screen's. Keep it clamped: it feeds
 * `readSoOutstandingCenti` → AutoCount `UDF_BALANCE`, a licensed ledger the ERP
 * must not push a negative into. The SCREEN wants the signed number and calls
 * `soBalanceCenti` below — that split is the whole point of having two names.
 */
export function soOutstandingCenti(a: SoPaidInputs): number {
  return Math.max(0, a.totalRevenueCenti - soPaidCenti(a));
}

/**
 * The SIGNED balance for a HUMAN — negative means over-collected, and the UI
 * paints that red (owner 2026-08-16: 「需要可以超收 negative 边红色」).
 *
 * WHY THIS IS NOT JUST `total − paid`. `total_revenue_centi` is 0 on 2,687 of
 * production's 2,824 live orders — every AutoCount-imported one, where the real
 * figure sits in `local_total_centi` and `recomputeTotals` has never run
 * (probe-so-overpay, run 31938735652). Those rows carry real payments, so a
 * bare subtraction would paint 2,121 legacy orders a large angry red for money
 * that was never over-collected — RM 9.26m of false alarm. A zero total is
 * "unknown", not "owes nothing", so it answers 0 exactly as it does today and
 * only a KNOWN total is allowed to go negative. Fixing that 0 is a separate
 * job (the detail page under-reports those orders' balance today, in the safe
 * direction); this function must not turn it into a scarier bug in passing.
 */
export function soBalanceCenti(a: SoPaidInputs): number {
  if (!(a.totalRevenueCenti > 0)) return 0;
  return a.totalRevenueCenti - soPaidCenti(a);
}

/**
 * The two header numbers this rule needs, off a raw `mfg_sales_orders` row.
 *
 * Here rather than at the call site so the COLUMN NAMES live beside the rule
 * that uses them — the whole failure mode is a reader picking `balance_centi`,
 * and that is a decision about which column, not about arithmetic. An absent or
 * non-numeric value reads as 0, which is what the SO detail page has always
 * done; the write-back's own reader refuses the document instead, because a
 * screen showing 0 and a ledger asserting 0 are different acts.
 */
export function soPaidInputsOf(
  header: Record<string, unknown> | null | undefined,
  ledgerPaidCenti: number,
  depositInLedger: boolean,
): SoPaidInputs {
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    totalRevenueCenti: num(header?.total_revenue_centi),
    headerDepositCenti: num(header?.deposit_centi),
    ledgerPaidCenti,
    depositInLedger,
  };
}
