## A merged conversion never reached AutoCount — the ERP kept refusing a shape the service had already learned [high]

**Symptom.** A delivery order shipping two sales orders, a GRN receiving four
purchase orders, an invoice covering several DOs — every one of them landed in
`scm.autocount_outbox` as `skipped`, reason *"AutoCount transfers from ONE source
document, so this DO has no AutoCount counterpart"*, and the document existed in
the ERP and nowhere else.

> **HOW COMMON, MEASURED 2026-08-18 — and the first version of this entry got it
> wrong.** It said *"merging is the daily shape on the delivery board and the GRN
> picker, so this was not an edge: it was a standing stream"*. Nobody had counted.
> `ac-fidelity-do-lines.json.gz` (47,329 rows, `AED_HOUZS` live read 2026-08-11)
> grouped by `DocNo` -> distinct `FromDocNo`: **1 merged delivery order out of
> 11,134** — `DO-005907` from `SO-006615` + `SO-007830`. 0.0%.
>
> The honest caveat, which does not rescue the original claim: that is how the
> business shipped WHILE IT RAN ON AUTOCOUNT, where merging was awkward, and the
> ERP added `/from-sos` deliberately. The right denominator is `scm.delivery_orders`
> and it was not read either. **Neither denominator was measured when the claim was
> written**, which is the defect worth recording here.
>
> The fix stands on its own merits — it deletes a refusal that was never true of
> AutoCount's target, and it uncovered the `conversionIsPartial` defect below,
> which is real regardless of how many merges exist. It is not the emergency the
> first version implied.

**Root cause (read on both sides, not inferred).** The sentence was true of ONE
SDK method and was applied to the whole integration. `AddPartialTransferDetail`
refuses a key array drawn from two source documents —
`InvalidTransferItemException`, measured on the live book 2026-08-16 — but the
TARGET never had that limit. `PlanTransfer` in `AcSyncService.cs` reads
`FromDocNos`, the documented `FullTransfer` takes an ARRAY of document numbers,
and the by-line shape groups the keys by the document they belong to and invokes
the primitive once per group. The service side shipped on 2026-08-16 (#2259) and
the ERP side was left as an owner decision, recorded in
`docs/autocount-sync-reasons.md` §5.1. Six call sites kept writing the refusal:
`delivery-orders-mfg.ts`, `grns.ts` ×2, `sales-invoices.ts`,
`purchase-invoices.ts` and `scm/lib/si-autocount-source.ts` — each one a
`docNos.length === 1` beside a `recordConvertSkipped`.

**The second defect, which the first was hiding.** `conversionIsPartial` decides
whether an un-nameable subset may safely degrade to "transfer everything
outstanding". It read the parent of `takenSourceIds[0]` and compared THAT
document's line count against the total taken from ALL of them. Correct while
only single-source conversions could enqueue; with a merge, two sales orders of
two lines each and three shipped gives `2 > 3 === false` — "whole document", no
`DtlKeys` sent, and AutoCount moves every outstanding line on both orders
including the one still in the warehouse. That is D14, one level up, and it
would have shipped WITH the merge rather than being found after it.

**Fix.** `enqueueConvert` takes `AcDocRef | AcDocRef[]`. One source still writes
`payload.fromDoc`, so a payload composed today is byte-identical to one composed
last week and the contract test over `AcSyncService.cs` still finds `FromDocNo`
where it expects it; several write `payload.fromDocs`, and `dispatchOne`
resolves each through its `linked_ac_docno` into `FromDocNos`. **A merge whose
sources are not all in the book yet WAITS** and does not burn an attempt —
sending the subset would put a delivery order in a licensed account book
carrying one sales order's lines out of two, marked `sent`, which nothing would
ever look at again. `conversionIsPartial` counts leftovers per parent.

`scm.autocount_outbox` is append-only and `last_error` is never rewritten, so the
`no-autocount-shape` needle STAYS — every row recorded before this carries those
words and a removed needle reclassifies them as `unrecognised` with no remedy at
all. What changed is the remedy and the page copy: the class is history, nothing
new lands in it, and those documents were never composed so **Send again cannot
help them**. They are a one-off backlog to raise by hand.

**Tests.** `autocount-outbox.test.ts` gains three: a merge carries `FromDocNos`
one entry per source and no `FromDocNo`; a merge whose second source has no
counterpart returns `waiting`, sends nothing and burns no attempt; and an
un-nameable subset across two parents is REFUSED. Each was proven red first —
the drain pair against `if (false && payload.fromDocs?.length)`, the third
against the old `count > takenSourceIds.length` comparison, where it queued a
blind `pending` row exactly as described above. The first version of that third
test passed against the mutation, because with every line keyed it never reached
`conversionIsPartial` at all; it was rewritten until the mutation killed it.
`autocountWritebackWiring` and `salesInvoiceAutoCountSource` pinned the old
refusal and now pin the new contract.

**Ref.** 2026-08-18, `fix/ac-sync-close-gaps`. Owner's instruction: *"不能 sync
的所有，你就解决掉、统一掉"*. Service half: #2259.
