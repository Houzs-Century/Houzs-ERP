## Receipt rows the book never had were picked up by no tool once the rest of the receipt was keyed [medium]

<!-- area: AutoCount sync + write-back -->

**Symptom.** The outbox health check's identity section, after 0905, still
listed eight goods receipts with 1-2 keyless rows each: HC-GRN-2609-060, -061,
-062, -063, -064, -066, -067 and -068. The drain's note on each reads *"AutoCount
reported N line(s) and the ERP sent N+2"*.

Read-only on 2026-09-14, every one of those rows is a pillow received beside the
purchase lines, with no purchase line behind it (`purchase_order_item_id` null):

- AK-HAPPY SLEEP EASY on all eight;
- AK-SLEEP ESSENTIAL 7 HOLES on -064, -066 and -067;
- AK-SLEEP ESS LUX MICD. PLUS PI on -068.

That is 60 units that never reached the book's receipts. Every other row of the
eight receipts carries its key.

**Root cause (traced).** This is the shape 0817 names: a `po_to_gr` transfer
moves the purchase order's lines, so a row added on the receipt is a line the
book does not have. It can only arrive as `IsNewLine`. Two tools make that
declaration, and neither reached these receipts:

- the relink sweep declares it only on a run that itself stamped a key, and
  the DocTransfer stamp had already keyed the other rows;
- `requeue-keyed-conversion-edits.mjs` (0900) plans only documents holding a
  keyless-line refusal, and nobody had saved these receipts since, so none was
  refused.

**Fix.** `requeue-keyed-conversion-edits.mjs` takes `DOC_NOS`, exposed as a
workflow input. The named DO / GR documents are planned by the tool's existing
rule, refusal or not. A document goes out when it is fully keyed, or when its
only keyless rows have no source line and the book snapshot shows every book
line claimed; those rows then travel as `IsNewLine`. Plan, confirm and verify
are unchanged. HC-GRN-2609-057 is not in this class: its keyless row does point
at a purchase line, whose book line sits on HC-GRN-2609-012, and it is left for
a person.

**Ref.** feat/ac-requeue-named-receipts, 2026-09-14.
