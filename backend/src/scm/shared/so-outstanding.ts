// ----------------------------------------------------------------------------
// so-outstanding — WHAT A SALES ORDER STILL OWES, computed in ONE place.
//
// WHY THIS FILE EXISTS. This repo's recurring write-back defect is a fact the
// ERP keeps in two columns where the reader picks the wrong one — it has cost
// three incidents (`supplier_sku`, the stock location, the salesperson; see
// docs/autocount-writeback-golive-coe.md section 2). The outstanding balance is
// the same shape with THREE candidates, and the obvious one is the wrong one:
//
//   scm.mfg_sales_orders.balance_sen   NOT the balance. `recomputeTotals`
//       writes `balance_sen = local_total_sen = total_revenue_sen =
//       grandTotal` on every edit (mfg-sales-orders.ts), so it never reflects a
//       payment. It LOOKS right because the cutover really did land AutoCount's
//       UDF_BALANCE in it (check-migration-fidelity.mjs:95), and the first edit
//       of any order overwrote that with the gross total.
//   the view's balance_sen_live      local_total − SUM(payments). Right for
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
  /** `scm.mfg_sales_orders.total_revenue_sen`. */
  totalRevenueSen: number;
  /** `scm.mfg_sales_orders.deposit_sen` — the LEGACY header deposit. */
  headerDepositSen: number;
  /** SUM of `scm.mfg_sales_order_payments.amount_sen` for this document. */
  ledgerPaidSen: number;
  /** Any of those payment rows carries `is_deposit`. */
  depositInLedger: boolean;
}

/**
 * What the SCREEN needs on top of the paid rule: the SECOND total column.
 *
 * A separate interface rather than a field on `SoPaidInputs`, because the two
 * audiences take different inputs. `soOutstandingSen` writes AutoCount's
 * `UDF_BALANCE` and must keep answering off `total_revenue_sen` alone; only the
 * screen is allowed to fall back. Extending here means the compiler enumerates
 * the `soBalanceSen` call sites and leaves the write-back's untouched.
 */
export interface SoBalanceInputs extends SoPaidInputs {
  /**
   * `scm.mfg_sales_orders.local_total_sen` — the order total the ERP prints,
   * and the ONLY total an AutoCount-imported order has (the cutover importer's
   * header column list carries `local_total_sen` and not `total_revenue_sen`;
   * `import-ac-outstanding-so.mjs`'s `HCOLS`).
   */
  localTotalSen: number;
}

/**
 * The order total a HUMAN is shown, in sen.
 *
 * `total_revenue_sen` when `recomputeTotals` has run, `local_total_sen`
 * otherwise. Both are 0 only when the order has no total at all, and THAT is
 * the case the balance below refuses to answer.
 */
export function soDisplayTotalSen(a: SoBalanceInputs): number {
  return a.totalRevenueSen > 0 ? a.totalRevenueSen : a.localTotalSen;
}

/**
 * Total minus paid, SIGNED — the one subtraction, shared with the Fair Report.
 *
 * `fairBalanceSen` (scm/lib/fair-report.ts) delegates here. Two names because
 * the two callers choose a different AMOUNT to subtract from — the report uses
 * the figure it prints in its own Amount column — but the arithmetic, and the
 * decision NOT to clamp it, is one rule in one place. A third hand-rolled
 * `total - paid` is what put a stale header column into the report's Balance
 * (docs/bugs/0496-*).
 */
export function signedBalanceSen(
  totalSen: number | null | undefined,
  paidSen: number | null | undefined,
): number {
  const n = (v: number | null | undefined): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : 0;
  return n(totalSen) - n(paidSen);
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
 * `scm.mfg_sales_orders.paid_sen` is deliberately not an input: it is
 * deprecated, no writer maintains it, and it is 0 on any order paid through the
 * payment drawer.
 */
export function soPaidSen(a: SoPaidInputs): number {
  return (a.depositInLedger ? 0 : a.headerDepositSen) + a.ledgerPaidSen;
}

/**
 * What the order still owes, in sen. Never negative — an overpayment is a
 * credit, and AutoCount's own UDF_BALANCE is not where a credit belongs.
 *
 * THIS IS THE WRITE-BACK'S RULE, not the screen's. Keep it clamped: it feeds
 * `readSoOutstandingSen` → AutoCount `UDF_BALANCE`, a licensed ledger the ERP
 * must not push a negative into. The SCREEN wants the signed number and calls
 * `soBalanceSen` below — that split is the whole point of having two names.
 */
export function soOutstandingSen(a: SoPaidInputs): number {
  return Math.max(0, a.totalRevenueSen - soPaidSen(a));
}

/**
 * The SIGNED balance for a HUMAN — negative means over-collected, and the UI
 * paints that red (owner 2026-08-16: 「需要可以超收 negative 边红色」).
 *
 * IT SUBTRACTS FROM `soDisplayTotalSen`, NOT FROM `total_revenue_sen`, and that
 * is the whole of this function's history. `total_revenue_sen` is 0 on 2,687 of
 * production's 2,824 live orders — every AutoCount-imported one, where the real
 * figure sits in `local_total_sen` and `recomputeTotals` has never run
 * (probe-so-overpay, run 31938735652). Reading only that column, this answered
 * 0 for all of them, and `GET /:docNo` stamps its answer over the header's own
 * `balance_sen`, so a partly-paid migrated order showed the customer's whole
 * outstanding amount as SETTLED — Total 3,200, Paid 1,600, Balance 0.00 on the
 * owner's phone (docs/bugs/0723-*), while the SO LIST beside it read
 * `balance_sen_live` and said 1,600.
 *
 * THE FALLBACK IS NOT A GUESS: the cutover importer wrote the ledger row as
 * `paid = total − UDF_BALANCE` against the same `local_total_sen` it stored, so
 * `local_total_sen − paid` reproduces AutoCount's own outstanding figure by
 * construction (`import-ac-outstanding-so.mjs`, and the note on
 * `readSoOutstandingSen`). It cannot mass-produce the red screen the old guard
 * was protecting against either — that subtraction is `min(total, UDF_BALANCE)`,
 * which is negative only where AutoCount itself recorded an over-collection.
 *
 * THE GUARD THAT STAYS: an order with NO total in EITHER column answers 0. A
 * zero total is "unknown", not "owes nothing", and a bare subtraction there
 * would paint money that was never over-collected a large angry red.
 */
export function soBalanceSen(a: SoBalanceInputs): number {
  const total = soDisplayTotalSen(a);
  if (!(total > 0)) return 0;
  return signedBalanceSen(total, soPaidSen(a));
}

/**
 * The header numbers this rule needs, off a raw `mfg_sales_orders` row.
 *
 * Here rather than at the call site so the COLUMN NAMES live beside the rule
 * that uses them — the whole failure mode is a reader picking `balance_sen`,
 * and that is a decision about which column, not about arithmetic. An absent or
 * non-numeric value reads as 0, which is what the SO detail page has always
 * done; the write-back's own reader refuses the document instead, because a
 * screen showing 0 and a ledger asserting 0 are different acts.
 *
 * A CALLER FEEDING `soBalanceSen` MUST SELECT `local_total_sen`. Omitted from
 * the select it reads as 0 here, which puts a migrated order back on the only
 * total it does not have. `HEADER` in `routes/mfg-sales-orders.ts` carries it;
 * the callers that take only `soPaidSen` off this (reports.ts, si-order-deposit)
 * are unaffected either way.
 */
export function soPaidInputsOf(
  header: Record<string, unknown> | null | undefined,
  ledgerPaidSen: number,
  depositInLedger: boolean,
): SoBalanceInputs {
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    totalRevenueSen: num(header?.total_revenue_sen),
    localTotalSen: num(header?.local_total_sen),
    headerDepositSen: num(header?.deposit_sen),
    ledgerPaidSen,
    depositInLedger,
  };
}
