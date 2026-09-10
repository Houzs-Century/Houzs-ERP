## A refused purchase order was filed under a UUID, and the probe could not look it up [medium]

**Symptom.** The owner opened the AutoCount Sync page on 2026-09-10, saw a
held-back row whose DOCUMENT column read
`b534845b-601f-435a-91bf-0eac2743b601` instead of a purchase order number, and
asked 「然后为什么会有这样的document」. The check written to answer exactly that
question — `check-autocount-held-back.mjs`, whose header says it exists so that
"no such document" is a MEASUREMENT and not a shrug — replied:

```
== 3. STATE OF b534845b-601f-435a-91bf-0eac2743b601 ==
   NOT FOUND. scm.mfg_sales_orders has no row with doc_no = '...'.
```

The document exists. The check was looking in the wrong table.

**Root cause (traced), and there are TWO — the second is why the row looked like
that in the first place.**

**1. The refusal path threw the number away.** `enqueueEdit` composes the state
inside a `try`, and `composed.docNo` is the PO NUMBER — its own comment says so:
*"A PO route knows its id, not its number; the outbox row is keyed by the human
document number so it lines up with the create row."* The CATCH then wrote
`docNo: String(opts.docNo ?? opts.docId ?? '')`, and a purchase-order route
passes only `docId`. So every REFUSED purchase-order edit was filed under a
UUID — while its own error message read `PO HC-PO-2609-055: 2 of 2 line(s) carry
no AutoCount DtlKey`. The composer had the number all along.

The number is now kept in `resolvedDocNo` where the catch can reach it. Pinned by
`backend/src/scm/lib/autocount-outbox.test.ts`, **proved RED** on the unfixed
tree (`Tests 1 failed | 126 passed`).

**2. And the check could not look it up.** A sales order is named by `doc_no`; a purchase order is
named by `po_number` and identified by `id`. `composePoState` writes the outbox
row's document name as `docNo: header.po_number || poId`
(`backend/src/scm/lib/autocount-outbox.ts`), so a purchase order whose
`po_number` is empty appears in the queue — and on the page — as its raw id.

Section 3 of the probe only ever read `scm.mfg_sales_orders`, so for any purchase
order it answered `NOT FOUND` with full confidence. Section 2 did not cover it
either: it searches every table carrying a **`doc_no`** column, and
`scm.purchase_orders` does not have one.

**Fix.** When the sales-order lookup finds nothing, `purchaseOrderState` reads
`scm.purchase_orders` — by `po_number` first, then by `id::text`, because both
are what the queue can be showing. It prints the same shape as the sales-order
report and, crucially, **prints `po_number` itself**: that is the whole question a
UUID-shaped row raises — is the number missing, or is the queue only showing the
id?

The id lookup is cast to `text` and guarded on its own: `uuid = text` fails as an
absent OPERATOR rather than as a no-match, and "no purchase order" is the one
wrong answer this check must never give.

Public-log discipline is unchanged — numbers, dates, statuses, counts and line
POSITIONS only. No supplier, no item, no money.

**Ref.** `fix/held-back-probe-reads-a-purchase-order`, 2026-09-10.
