## The invoice showed its delivery order as a uuid fragment [medium]

**Symptom.** The owner's screenshot of production, 2026-08-23, on
`HC-SI-2608-004`: the header meta line read **`Transfer From (DO) 065c5051`**.
He read it as a document reference and asked why the chain did not run
SO → DO → SI. It is not a document number — it is the first eight characters of
the parent delivery order's uuid.

**Root cause (traced).** TWO faults, and the second is why the first was never
noticed.

1. `SalesInvoiceDetailV2.tsx:112` declared `do_doc_no` and `:208` read it.
   **`do_doc_no` is a real column on DELIVERY RETURNS and has never existed on a
   sales invoice.** It was always `undefined`.
2. `sales-invoices.ts` HAS the resolver — `stampDoNumber`, which reads
   `delivery_orders.do_number` by id and writes `r.do_number`. Its own comment
   said *"Called on BOTH list paths"*, which was true: lines 754 and 824. **The
   detail handler at `:848` was never one of them**, so the correct field was
   not served either.

Every invoice therefore fell through to the fallback, which was:

```
if (h.delivery_order_id) return h.delivery_order_id.slice(0, 8);
```

justified in its own comment as *"so the field never renders blank"*. **That is
the third fault and the one worth naming**: a blank says "we have nothing to
show"; an eight-character hex slug in a field labelled "Transfer From (DO)" says
something FALSE, in exactly the shape of the true answer. It cost the owner a
question about his own document chain.

The Sales Invoice LIST was correct the whole time — `SalesInvoicesListV2:171`
reads `r.do_number`, the name the server actually serves. So the list and the
detail page disagreed about the same invoice, and only the detail page lied.

**Fix.** The detail handler calls `stampDoNumber(sb, [h.data])` — same function,
same field name, one more caller. The detail page reads `do_number`, the name
the list already used. The uuid fallback is deleted; a dash is the honest
answer.

Pinned by `frontend/src/pages/scm-v2/sales-invoice-do-ref.test.ts` — "NEVER
prints a uuid fragment" is **RED on the unfixed tree**, returning `065c5051`.

**Ref.** fix/the-invoice-names-its-delivery-order, 2026-08-23.
