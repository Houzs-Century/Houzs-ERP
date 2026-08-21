## The Fair Report counted collected money as still owing [high]

**Symptom.** The Sales Report (Fair Report, `GET /api/scm/reports/fair-report`)
printed a Balance for every order equal to the order's FULL value, however much
the customer had already paid — and printed a correct, ledger-true "Paid" figure
in the next column of the same row. The Balance KPI on the header card summed
those, so management read money already banked as money still outstanding.
Measured against production 2026-08-21: **85 of 103 live orders, RM 238,652.50
overstated**, of which **RM 132,869.50** sat on the 51 CONFIRMED orders that are
this report's row set. Worst-affected slice: CONFIRMED, 51 of 62 orders.

**Root cause (traced).** `scm/lib/fair-report.ts`'s `fairSoMoney` returned
`balance_sen: n(h.balance_sen)` — a pass-through of the header column
`scm.mfg_sales_orders.balance_sen`. That column is not a balance:
`recomputeTotals` (`scm/routes/mfg-sales-orders.ts`) writes
`balance_sen = local_total_sen = total_revenue_sen = grandTotal` on every edit,
so it never reflects a payment. The repo already knew this and had written it
down — `scm/shared/so-outstanding.ts` exists precisely because that column keeps
being read as the balance — but the Fair Report was not using it. The same
handler computed `paid_total_sen` by summing the live payment ledger, so one row
carried a ledger fact and a header fiction side by side. `below_deposit` was
computed off the same stale balance, which made its "still owing" clause
(`balanceSen > 0`) permanently true.

Observed, not inferred: `backend/scripts/check-report-money.mjs` section 6g,
dispatched read-only against production
(run <https://github.com/Houzs-Century/Houzs-ERP/actions/runs/32466500870>),
compared `balance_sen` with `local_total_sen − SUM(mfg_sales_order_payments.amount_sen)`
per company and status. The delta equalled the ledger sum exactly, on every
affected row — the column is the order total, not a balance.

**Fix.** `fairSoMoney` no longer owns or reads a balance; `balance_sen` is gone
from `FairSoInputs` and `FairSoMoney`, so the header column is not reachable
from the report's money math. A new pure `fairBalanceSen(amountSen, paidSen)`
subtracts what was paid from the SAME `amount_sen` the report prints, and the
paid half comes from the shared `soPaidSen` / `soPaidInputsOf`
(`scm/shared/so-outstanding.ts`), which owns the rule that the header's legacy
`deposit_sen` counts only when the ledger carries no `is_deposit` row — without
that, every modern order would double-count its deposit. Both the list
(`stage=so`) and the per-order drill-down use it, so the two cannot disagree.
`fetchPaymentsByDoc` now carries `is_deposit` instead of dropping it.

Not `soBalanceSen`: that function deliberately answers 0 when
`total_revenue_sen` is 0, to keep a negative out of AutoCount's `UDF_BALANCE`,
and a report printing a large Amount beside a 0 Balance would just be
inconsistent somewhere else. The reasoning is in `fairBalanceSen`'s docblock.

Pinned by five cases in `backend/tests/fairReport.route.test.ts`
("balance is ledger-derived, not the stale header column"), driving the real
handler over a fixture shaped exactly like production — header `balance_sen`
equal to the total, ledger holding a deposit row plus a transfer. **Proved RED
on the unfixed tree** (`git checkout origin/main -- backend/src/scm/routes/reports.ts backend/src/scm/lib/fair-report.ts`,
then vitest): 4 of 5 failed — `expected 100000 to be 60000`,
`expected 25000 to be 40000`, `expected 100000 to be +0`,
`expected 100000 to be 60000` — and all 21 pass on the fixed tree.

**Ref.** `audit/report-money-math`, 2026-08-21.
