## Re-import dropped the SO header stock-status and notes fields the owner's listing shows (Remark2/3/4, UDF_Note, SalesExemptionExpiryDate) [medium]

**Symptom.** The owner sent his AutoCount SO listing (stocks status.xlsx,
2026-08-28) and asked whether the ERP carries its Remark 2 (his per-order stock
status: READY / MATTRESS/ACC / ...), its notes, and its delivery date. It does
not: every re-imported order had remark2/remark3/remark4/note/
sales_exemption_expiry blank.

**Root cause (traced).** export-ac-reimport.py's SO section selected only
UDF_PDate + UDF_VENUE from the header — none of the five fields — so the
importer had nothing to write, even though scm.mfg_sales_orders carries all
five columns natively and the SO screen reads them (mfg-sales-orders.ts:911).
Same class as docs/bugs/0556 (the importer not carrying a field the UI reads).
Two sub-findings measured on the live book against the exact imported predicate
set (2,756 docs): the listing's "Note" column is UDF_Note (plain text, 481
docs), NOT SO.Note — SO.Note is filled on exactly 2 docs and both hold an
RTF-embedded PICTURE (megabytes of hex; a naive copy would have written that
into the note column). And SalesExemptionExpiryDate is the delivery date staff
maintain on the header: of 539 filled, 533 equal the earliest line
DeliveryDate.

**Fix.** export-ac-reimport.py gains a `remarks` section (ac-so-remarks.json.gz,
runnable alone with START_AT=remarks); import-ac-outstanding-so.mjs writes the
five columns at INSERT; backfill-so-remarks.mjs (+ workflow, all four
release-discipline gates) fills the already-imported orders — per-column
IS NULL guard, audit-trail refusal, fresh-connection byte-for-byte sample
verify. SO.Note is deliberately not imported.

**Ref.** fix/so-remarks-import, 2026-08-28.
