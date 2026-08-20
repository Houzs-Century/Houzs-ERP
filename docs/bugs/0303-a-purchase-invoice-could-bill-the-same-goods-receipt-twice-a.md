## A Purchase Invoice could bill the same goods receipt twice, and the supplier be paid twice [high]

<!-- area: Purchase orders + GRN + PI -->

**Symptom.** None reported — found by asking which conversion chains still lack
the unlinked-line guard, after the owner asked for duplicate-document prevention
across every chain. `grep -ci unlinked backend/src/scm/routes/purchase-invoices.ts`
returned **0**, against 5 in `grns.ts`, 5 in `purchase-returns.ts`, 5 in
`delivery-returns.ts` and 12 in `sales-invoices.ts`.

**Root cause (traced, not guessed).** `scm.purchase_invoices.grn_id` names a
Goods Receipt; `purchase_invoice_items.grn_item_id` is NULLABLE, and that
nullability is legitimate — it is how a PI-native line (freight, a service
charge) is represented. Every cap and every recount in `purchase-invoices.ts`
filters NULL links out FIRST, which is right for a service line and wrong for a
hand-added GOODS line: it bills the material, `grn_items.invoiced_qty` never
moves, `recomputeGrnInvoiced` recounts only linked children so the GRN line still
reads fully outstanding, and a SECOND Purchase Invoice bills the same receipt.
Both post to AP and both enqueue to AutoCount.

This is the same back door `docs/unlinked-line-duplicate-coe.md` was written for
on 2026-08-04, when one Sales Order shipped twice. Five chains were closed then.
That COE's own deferred table says *"All four links in the chain are now
guarded"* — true of the four it enumerated, and read ever since as "the chain is
closed". It was not: the owner's instruction that day was 「包括 GR 那边也是」,
the RECEIVING half was built (`grn-unlinked-po-lines.ts`) and the BILLING half
was never done. Four guards were mistaken for a closed chain; there were six.
The stock chains lose goods — this one loses money.

**Fix.** `findUnlinkedPiLines` + `unlinkedInvoiceResponse` in
`backend/src/scm/lib/return-unlinked-lines.ts`, reusing the identical narrow
predicate all five siblings share: header names no parent -> allowed; item not
on the named parent -> allowed; item IS on the named parent -> 409, link it.
Wired into BOTH paths that can create such a line — `POST /` (including the
`?grnId=` draft path) and `POST /:id/items`, which is the likelier one, since the
operator converts the GRN properly and then types the missing item in by hand.
The add-line path now selects the parent's `grn_id` alongside `id`; without it
there is no parent to check against. No schema change. A freight or service line,
and any item the receipt does not contain, passes untouched — asserted directly,
because a guard that breaks legitimate invoicing gets removed rather than fixed.
The COE's over-claiming sentence is corrected in place. **Ref** PR #PLACEHOLDER,
2026-08-17.
