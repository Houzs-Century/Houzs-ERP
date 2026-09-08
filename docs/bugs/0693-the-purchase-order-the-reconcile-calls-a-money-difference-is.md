## The purchase order the reconcile calls a money difference is a dropped line discount the repair has not been re-run over [medium]

<!-- area: AutoCount sync + write-back -->

**Symptom.** The 2026-09-08 11:55 (Malaysia, UTC+8) go-live reconcile, run
`34185154444`, printed exactly one purchase-order money difference:

```
PO-009770: AutoCount RM 13893.75 vs ERP RM 18525.00 (ERP HC-PO-009770)
```

**Root cause (traced).** It is `docs/bugs/0662` again, on a document the repair
never covered. All 15 lines of `PO-009770` carry AutoCount's line discount, at a
uniform 75%, and the ERP holds the undiscounted extended price. Measured over
the committed book snapshot `backend/scripts/data/ac-reconcile-truth.json.gz`
(exported 2026-09-08T00:03:44Z = 08:03 Malaysia), not inferred:

```
PO-009770  lines 15  header netTotal 1389375
  SUM(unitPrice x qty) = 1852500  = RM 18525.00   <- what the ERP holds
  SUM(subTotal)        = 1389375  = RM 13893.75   <- what the book holds
  ratio sub/ext = 0.750000
  lines whose subTotal != unit x qty: 15 of 15
```

So the ERP's figure is not a wrong number typed anywhere: it is
`qty x UnitPrice` summed, which is precisely what
`import-ac-outstanding-po.mjs:230` computes, and AutoCount keeps the discount in
the gap between `PODTL.UnitPrice` and `PODTL.SubTotal`.

**Why the existing repair did not catch it.** `repair-po-line-discount.mjs`
already exists and is correct. Its last APPLY, run `34116301278` on
2026-09-07 19:22 Malaysia, reported `IN THE MIGRATED SCOPE: 89 line(s) across 10
purchase order(s), RM 42,662.80` and wrote all 89 — and `PO-009770` is not one
of the ten. The migrated PO population and the book snapshot have both been
re-cut since (the 2026-09-08 08:00–08:07 re-cut), so a one-shot repair that was
complete when it ran is no longer complete now.

That is the generalisable part, and it is not about discounts: **a repair
dispatched once against a population that is still being re-cut has an expiry
date, and nothing in this repo says when it expired.** The reconcile is what
noticed, sixteen hours later.

**Fix.** No code change. `repair-po-line-discount.yml` re-dispatched over the
current snapshot — PLAN first, then APPLY — which is the tool that owns this
correction. Runs recorded in the PR body.

**Ref.** fix/so-do-money-reconcile, 2026-09-08.
