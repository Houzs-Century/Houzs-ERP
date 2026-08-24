## The party-code census counted documents the ERP never sent [medium]

<!-- area: AutoCount sync + write-back -->

**Symptom.** The first prod run of `census-autocount-party-codes` (run
32049402765, 2026-08-17) reported `PURCHASE ORDERS IN AUTOCOUNT: 450` and
`SALES ORDERS IN AUTOCOUNT: 2726` for company 1. Read as an answer to the
question the census exists to answer — how many documents could be booked to the
wrong party — those numbers are wrong by two orders of magnitude.

**Root cause, traced.** The census defined "reached AutoCount" as
`linked_ac_docno IS NOT NULL` OR a `sent` outbox row, and then used that one
predicate for everything. The OR arm is right for "is there a pair", and the
comment in the script argued for it correctly: dropping the column would miss
purchase orders that predate `scm.autocount_outbox`. What the comment did not
notice is that the pairs it recovers point the OTHER WAY. `import-ac-outstanding-po.mjs`
set `linked_ac_docno` on documents that ORIGINATED in AutoCount — the AC numbers
in the run are `PO-009xxx` against ERP `HC-PO-009xxx`, the import's one-to-one
shape. For those the book was the source and the ERP never chose a creditor, so
they cannot carry an ERP mapping error. Only a document the ERP PUSHED can.

This is the trap CLAUDE.md names as *the check that answers a different
question*: the predicate was true, the count was correct, and it measured
something other than what the reader would take it for.

**Fix.** LINKED and PUSHED are now separate columns and separate totals,
everywhere either appears; the document list sorts PUSHED first and marks it;
and section 4 marks the code collisions where the rows name DIFFERENT companies
(normalising case and punctuation, so `TODERN HOME SDN. BHD.` and `TODERN HOME
SDN BHD` are not flagged as a clash). With no outbox table, PUSHED is FALSE
rather than unknown — an unevidenced push must not read as one.

**Ref.** 2026-08-17, this PR, correcting the census shipped in #2377 the same
day. Lesson, which the file already carried and this still walked into: **ask
what a true predicate would ALSO be true of.**
