## The reconcile checker compared the book's MYR total against the ERP's document-currency total [high]

<!-- area: AutoCount sync + write-back -->

**Symptom.** `check-ac-erp-reconcile.mjs` reports a **document total** difference
on every purchase order that is not denominated in ringgit, whether or not
anything about it is actually wrong. On the 2026-09-07 book that is
`HC-PO-009335`: AutoCount RM 21,266.35 against ERP RM 34,334.90, reported as a
money defect when the two figures are the same amount stated in two currencies.

Worse than a false positive on a report: the same comparison, made by
`repair-po-line-discount.mjs`, moved RM 13,068.55 on that live document
(`docs/bugs/0665-a-checker-could-not-tell-an-exchange-rate-from-a-discount-an.md`).
This entry is the other half — the read-only checker that was making the same
comparison and would have gone on reporting it as a difference forever.

**Root cause (traced).** The two sides mean different currencies:

| side | what it holds |
|---|---|
| the snapshot, `export-ac-reconcile-truth.mjs:196` | `ISNULL(h.LocalNetTotal, h.NetTotal)` — the **local (MYR)** figure |
| the ERP, `import-ac-outstanding-po.mjs:401` | the **document's own** amounts, with `'MYR'` hard-coded into `purchase_orders.currency` regardless of what the book says |

`check-ac-erp-reconcile.mjs` compared `h.totalSen` (MYR) against
`purchase_orders.total_sen` (CNY on this document) and pushed the difference into
`F.money`. On the 9,390 MYR purchase orders the two are the same number, which is
exactly why the defect was invisible: it can only show on the 22 documents where
`LocalNetTotal` and `NetTotal` differ, of which 1 is in the migrated scope. All
13,366 sales orders are MYR.

**Fix — compare like with like, and give the currency its own column.**

- The snapshot now carries `currency`, `rate` and `docTotal` per header and
  `docSubTotal` per line, APPENDED beside the local-currency `netTotal` /
  `subTotal` rather than replacing them, so a consumer states which of the two it
  means instead of being handed one and left to assume (shipped in 0665).
- The checker's book side is now `h.docTotalSen ?? h.totalSen` — the DOCUMENT's
  own total, which is what the ERP stores. On an older snapshot `docTotalSen` is
  null and the fallback is the previous behaviour, announced once as
  `currencyBlind` rather than passed off as a like-for-like read. A checker that
  cannot see the currency must say so, not report a clean money column.
- A non-MYR document is reported in its **own column** (`non-MYR` in the summary
  table) and its own section, never as a money difference, and it is **not
  counted in `gaps`**. What is genuinely wrong on it is a different thing and the
  report now says so plainly: the ERP's `currency` column reads `MYR` on a CNY
  document. Repairing that is an owner decision with GRN / PI / PV consequences,
  so it is listed and not scripted.

**Why the CHECKER converts and the REPAIR refuses, said plainly.** The two make
opposite choices from the same data and both are right, because the cost of being
wrong is not the same:

| | what it does with a non-MYR document | why |
|---|---|---|
| `check-ac-erp-reconcile.mjs` (read-only) | compares it in its own currency, flags it in a currency column | being wrong costs a reader's attention. Reporting every foreign document as broken trains people to ignore the money column, which is the failure mode a checker exists to prevent |
| `repair-po-line-discount.mjs` (writes money) | REFUSES it | being wrong costs RM 13,068.55, and it already did. The gap between two totals may be a discount, may be the rate, may be both; nothing in a total tells them apart. The ERP row is also self-inconsistent on such a document — its `currency` says MYR — so repairing one field would leave it more coherent-looking and no more correct |

`currencyVerdict` and `LOCAL_CURRENCY` therefore live in
`backend/scripts/lib/ac-scope.mjs`, the snapshot library both consumers already
import, and `po-discount-plan.mjs` re-exports them. Two statements of one
currency rule is how the first one came to be wrong.

**Proved.** `backend/tests/poDiscountPlan.test.mjs` covers `currencyVerdict`'s
three answers and the repair's refusals; each was planted and proved RED in 0665
(gate removed: 3 red; absent currency read as local: 2 red; headers made optional:
1 red). The checker itself reads production and is exercised by running it, not by
a unit test — its change is a two-line swap of which snapshot field is compared,
with the fallback preserving the old behaviour exactly.

**Ref.** fix/reconcile-currency-like-for-like, 2026-09-07. Second half of
`docs/bugs/0665-a-checker-could-not-tell-an-exchange-rate-from-a-discount-an.md`.
