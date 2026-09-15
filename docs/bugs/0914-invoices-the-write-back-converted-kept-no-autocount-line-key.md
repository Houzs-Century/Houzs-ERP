## Invoices the write-back converted kept no AutoCount line keys, so their edits could never be sent [medium]

<!-- area: AutoCount sync + write-back -->

**Symptom.** HC-SI-2609-001 stayed under NOT ACCEPTED on the AutoCount Sync page
(owner's screenshot, 2026-09-15). Its edit of 2026-09-10 15:39Z was skipped:
*"edited before its AutoCount counterpart existed: the IV conversion is still
queued ... Re-save the document once the conversion has drained"*. The conversion
itself was sent the same minute.

**Root cause (traced).** Read on 2026-09-15, the book's invoice HC-SI-2609-001
already matches the ERP line for line:

- the same eight items, quantities and prices, total 7,000.00;
- every book line's `DocTransfer` source is the key of the ERP delivery-order
  line it was invoiced from.

But all eight ERP invoice lines are keyless. The drain cannot key a converted
document's lines, which is the same mechanism as 0897. Nothing else could reach
the invoice either:

- the stamp and re-queue tools had lanes for DO, GR and PO only;
- `resend-ac-document-edits.mjs` took no invoices.

So the dropped edit could not be sent again, and any later edit of the invoice
would be refused for its keyless lines.

In company 1 on 2026-09-15, the write-back had converted exactly one invoice (one
sent `do_to_iv`, no `gr_to_pi`). The other seven sales invoices and three purchase
invoices with keyless lines are migrated documents under AutoCount's own numbers,
and they are outside these lanes.

**Fix.**

- **Exporter.** `export-ac-conversion-line-keys.py` has an IV lane (`HC-SI-`,
  sourced from a DO) and a PI lane (`HC-PI-`, sourced from a GR), both read from
  `DocTransfer` like the DO lane.
- **Stamp tool.** `stamp-conversion-line-keys.mjs` pairs
  `sales_invoice_items.do_item_id` and `purchase_invoice_items.grn_item_id` by the
  existing rule. It writes through the lane's table and column names from its own
  constant. The schema-qualified identifier form was run read-only against
  production on 2026-09-15.
- **Triggers.** Neither table carries a user trigger (`pg_trigger`, 2026-09-15).
- **Resend tool.** `resend-ac-document-edits.mjs` looks up sales and purchase
  invoices by number.

Stamping and re-sending HC-SI-2609-001 are UNTESTED until dispatched after merge.

**Ref.** fix/ac-not-accepted-0915, 2026-09-15.
