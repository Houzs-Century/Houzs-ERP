## The SO-linked PO import crashed whole on one missing supplier instead of skipping it [medium]

**Symptom.** The lane-2 apply (run 33169457109) died mid-loop:
`null value in column "supplier_id" of relation "purchase_orders" violates
not-null constraint`. One document of 293 — PO-009555 — killed the run; every
PO after it in the loop went unwritten.

**Root cause (traced).** `import-ac-so-linked-pos.mjs:186-187` resolved the
creditor and then only COUNTED a miss (`if (!supId) noSupplier++`) — the build
and the INSERT proceeded with `supId = null`. The sibling importer
(`import-ac-outstanding-po.mjs:170`) refuses the document on the same miss;
this one predates that guard. The dry-run did print `supplier 1` in its
unresolved tally — a count with no document name, read as noise. The missing
master itself: the book's creditor **400-R002 RENNES BEDDING SDN BHD** has no
`scm.suppliers` row — the ERP instead carries RENNESS BEDDING under
**400-R001**, the code the book assigns to a different creditor (RED SOFA
PLT), while all 23 RDS items' MainSupplier in the book is 400-R001. Whether
those are one company renamed or two companies mis-coded is an owner catalog
question, recorded in the round ledger — the import does not decide it.

**Fix.** The miss now skips ITS document with a named log line and the rest of
the batch still lands, mirroring lane 1; supplier 400-R002 is added to the
seed data as a faithful copy of the book's creditor row, which unblocks
PO-009555 without judging the 400-R001 identity split. Verified by re-running
the apply after the seed — the run URL and counts are in the round ledger.

**Ref.** fix/lane2-supplier-guard, 2026-08-28.
