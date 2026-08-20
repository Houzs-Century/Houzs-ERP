## The "All salespeople" board silently self-scoped for directors, and two DRAFT fixes chased the wrong filter [medium]

**Symptom.** After #2357 shipped (drafts shown on the board, KPI counting them
again), the POS My-orders screen for company 2 still read **28 orders /
RM 73,975** on the KPI card over a board showing **1** — with the picker on
"All salespeople". The one row shown was the viewer's own single order.

**Root cause (traced, not guessed).** `GET /mfg-sales-orders/mine` honours
`?salesperson=all` only for a view-all caller — and it was the ONE gate in
`mfg-sales-orders.ts` still checking the bare flat key:

```
$ git grep -n "hasHouzsPerm(c, 'scm.so.view_all')" -- backend/src/scm/routes
backend/src/scm/routes/mfg-sales-orders.ts:2029:    if (hasHouzsPerm(c, 'scm.so.view_all')) {
```

while every other sales read in the same file grants the tier via
`canViewAllSales` — flat key OR director position (`:772`, `:1161`, `:1877`),
the alignment `houzs-perms.ts` documents. The caller is a Sales Director whose
position matrix lacks the flat key: full visibility on the SO list, silently
self-scoped on the board. Silent is the sting — the param is ignored, not
refused, so the board looks complete and merely short.

The board therefore showed the caller's own 1 order. The KPI card counts the
showroom by `scm.staff.showroom_id`, no view-all needed, hence 28. **DRAFT was
never the binding constraint for the all-salespeople view** — #2356 and #2357
each closed a real inconsistency (the endpoints genuinely disagreed on DRAFT),
but neither could have produced 28/28 for this caller.

**Fix.** `/mine` gates on `canViewAllSales(c)`, the same tier as the rest of the
file. Net-zero lines (the file is under the shrink-only size gate). A structural
test in the consignmentOrderSalesScope layer-3 idiom
(`tests/mineBoardViewAllTier.test.ts`) pins the gate and fails on any revert to
the bare key, since the inline handler cannot be driven directly without
exporting it.

**Residual risk, and what holds it.** The period columns still differ —
`/pos/sales-stats` windows on `so_date`, `/mine` on `created_at` — so a
back-dated order can land in one month's card and the other month's board. That
mismatch is at most a few rows, not 27, and is recorded in the #2357 entry
below. Nothing yet asserts the two endpoints agree; a shared predicate remains
the durable fix.
