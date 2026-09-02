## Partial delivery was invisible: arrival and shipping shared one column [medium]

<!-- area: Sales orders + pricing -->

**Symptom.** An order with 5 units arrived and 2 shipped read plain **READY**.
Nothing anywhere said the customer was still owed 3. Shipping was visible only
at its two ENDS — a line turned `DELIVERED` once everything had left, and showed
nothing before that — so the whole middle of a partial delivery was off-screen.

The owner, 2026-09-02: 「partialy delivery 该怎么办呢」 · 「看一下那个 column 进入
适合」.

**Root cause (traced).** Not a defect in a rule — a missing column. "Stock
Status" (`stock_remark`) answers **arrival**: `'' | READY | PARTIAL |
BEDFRAME/ACC`, the warehouse's Remark-2 vocabulary for what can be PULLED now
(`scm/lib/so-readiness-row.ts`). Its `PARTIAL` means *some goods have come in*,
never *some goods have gone out*. Nothing rendered the second fact.

The figures were not missing — they were already summed on BOTH surfaces, from
the same deliverable engine the delivery picker uses
(`deliveredTotal` / `remainingTotal` on the list, `totalDelivered` /
`totalRemaining` on the detail). Only the `none|partial|full` verdict was ever
emitted, and a verdict cannot answer "how many are still owed".

**Fix.** The two questions get two columns. The owner picked this over adding a
fifth value to the arrival column, because the two are read by different people
for different reasons.

* `shipped_qty` and `deliverable_qty` are emitted on the list AND the detail —
  no new read, the maps already existed.
* `deliverable_qty` is `shipped + still owed`, **never** a sum of ordered line
  quantities, which would count cancelled lines and overstate the debt.
* `frontend/src/vendor/scm/lib/shipped-progress.ts` owns the rule;
  `frontend/src/components/ShippedProgressPill.tsx` renders it on both the list
  row and the drill-down line — one module, so the two surfaces cannot grow two
  vocabularies for one fact (the way `READY (PARTIAL)` once appeared on a board
  header and its own rows in the same moment).

**A missing figure is `unknown`, never zero.** An older payload carries neither
field, and reading that as "nothing has shipped" is a claim about an order that
may be fully out. Two more shapes are refused rather than guessed: an order with
nothing TO ship reads `none`, never `full` (a DELIVERED badge on an order nobody
shipped), and an over-delivery keeps both numbers (`6 / 5`) rather than clamping
the oddity away.

**NOT named `delivery_*`, deliberately.** That prefix is already two different
things — the stored scheduling override `mfg_sales_orders.delivery_state`
(`PENDING_SCHEDULE`, `scm/lib/tripReconcile.ts`) and the computed shipping
verdict that shadows it on the detail response — and two exported types are both
called `DeliveryState`. A third meaning under that prefix is how the next reader
picks the wrong one.

**Verified.** `shipped-progress.test.ts` — 8 tests, five of them refusals.
`backend/tests/soListShippedQty.test.ts` — 5 wiring assertions, including that
exactly TWO surfaces set the fields and that `deliverable` is never built from a
raw quantity; **PROVED RED on the unfixed tree, 3 of 5 fail**. The frontend
module is new, so its own tests cannot be proved red against a tree without it —
the backend pin is the one that regressed. Backend + frontend typecheck exit 0;
full frontend suite 293 files / 3,250 tests pass.

**Ref.** feat/split-stock-and-delivery-columns, 2026-09-02.
