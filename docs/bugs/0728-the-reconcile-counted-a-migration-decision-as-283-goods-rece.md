## The reconcile counted a migration decision as 283 goods-receipt differences [medium]

**Symptom.** Run 34255416449 answered `GOODS RECEIPTS NOT TALLIED — 289 of 400
document(s) still differ`, and 283 of those 289 differed on one axis only:
单据转换链 `transfer to`, "how much of this receipt has been invoiced". Every one
of them read the same way — the account book states the line as fully invoiced
and the ERP records 0. Read as a backlog, that is 283 documents somebody owes on
go-live night. It was not a backlog and nobody owed any of it.

**Root cause (traced).** Measured on the committed book snapshot
`backend/scripts/data/ac-convert-edges.json.gz` (exported 2026-09-07, opened
directly rather than quoted from a summary): the book holds 21,746 goods-receipt
lines, **21,450 of them fully transferred onward**, and 21,480 purchase-invoice
lines naming a goods receipt as their source. The ERP holds **55** purchase
invoices against the book's **5,283**, because the purchase-invoice HISTORY was
deliberately never migrated. So `scm.grn_items.invoiced_qty` is 0 for those
lines and always will be: not a wrong number, an ABSENT one, and a decision
rather than a defect.

`lib/ac-transfer-chain-run.mjs` recorded every `erp_low` verdict through
`recorder.record()`, which LOCKS the document — the same channel a wrong quantity
goes down. Nothing in the chain lane knew about the migration decision, so a
choice the owner made read as work.

**Fix.** `splitUnmigratedOnwardTransfer` in `scripts/lib/ac-not-a-difference.mjs`
(section 6), with the declaration table `UNMIGRATED_ONWARD` naming the decision
per child type — GR's onward type is PI, PO's is GR. A row leaves the difference
column only when four things hold, and the last two are MEASURED in the same run,
never assumed:

- the type declares the decision;
- the shape is exactly "the book moved some and we record NONE" — a partial
  figure is a number we computed, and a computed number that disagrees is a
  difference;
- the book names at least one onward document raised off this one;
- the ERP holds **none** of them (`ONWARD_COVERAGE` reads
  `scm.purchase_invoices` / `scm.grns` for the AutoCount numbers we carry).

Anything else is returned as an `impostor`, stays counted, and is printed
LOUDER than the differences around it — a goods receipt whose purchase invoice we
DO hold is the real defect this bucket must never swallow, which is
`0668-the-reconcile-printed-real-gaps-as-owner-decisions-for-do-iv` in the
permissive direction.

It is recorded as the note class `chain-onward-not-migrated`, so it prints under
"WHAT THIS VERDICT EXCLUDED, AND UNDER WHOSE RULING" with the decision and its
owner, instead of vanishing.

Nine tests in `backend/tests/acNotADifference.test.ts`, **proved RED on the
unfixed tree** (`splitUnmigratedOnwardTransfer is not a function`, 9 failed / 35
passed) and green after. They pin the count-preservation invariant on all four
paths, both refusal paths, and every impostor shape.

A second guard came out of the same work: `backend/tests/transferChainAxis.test.mjs`
now asserts every declared NOTE class carries a `DECLARED_LABEL` sentence. It
failed first run and named a real gap — `unanswerable-cause` had none — which is
not a defect (it prints under its own heading) but was hand-known in one place
and hand-exempted in another. `NOT_DECLARED_CLASSES` in
`scripts/lib/so-tally-verdict.mjs` now names the exemption once, and the divert
reads from it.

**Nothing is repaired by this change**, deliberately. A transfer-quantity
correction moves an on-hand figure and stock is DEFERRED (「库存先不看」).
Reclassifying says what the number MEANS; it writes nothing.

**Ref.** fix/po-gr-transfer-chain-2026-09-09, 2026-09-09.
