## Nine sales-order lines were dedicated to a purchase-order line for a different bed [high]

**Symptom.** The sofa document-chain audit reported SO -> PO `MISMATCH code 0`
at 19:54 MYT (run 34119014176) and `MISMATCH code 9` at 22:02 MYT (run
34130736979) the same evening. Every one is a bedframe whose sales-order line
names a different bed from the purchase-order line now dedicated to it — a
customer's REGAL (A)-(K) bound to a TRION (A) (HB STR)-(K), a CODY-(Q) to a
JAGER-(Q), a JAGER-(Q) to a JAGER-(SS).

**Root cause (traced).** `backend/scripts/sync-ac-delta.mjs` lane `links`
resolves `PODTL.FromSODtlKey` to an ERP sales-order line and `PODTL.DtlKey` to
an ERP purchase-order line, both by `linked_ac_dtlkey`, and wrote `so_item_id`
on the strength of that key pair alone — it never compared the two rows'
`item_code`. Run 34123720786 (2026-09-07 20:46 MYT, `mode=apply`) reported
`SO->PO dedications written: 10 of 10 intended` and is the only run between the
two audits that wrote a dedication. The GUARD for that is PR #3076; this entry
is about the rows it already wrote, which no guard can reach.

**Why a wrong one is worse than none.** A bedframe or sofa line is hard-bound
(`isHardBoundLine`, `backend/src/scm/lib/so-stock-allocation.ts`): it reads
READY only through its OWN dedicated purchase order's `received_qty`, never
through the pooled balance. So the customer's REGAL goes READY when a TRION is
received, and the real REGAL can never light. A line with NO dedication simply
waits on the pool, which is the state that held before that run.

**AutoCount is not the wrong side, and this was measured without touching the
book.** Decoding the committed snapshots — `ac-reconcile-truth.json.gz` (cut
2026-09-07 17:35 MYT) and `ac-po-fromsodtlkey.json.gz` — **696 of the 697**
PODTL SO-edges carry a BYTE-IDENTICAL item code on both ends, and every edge
behind these nine is one of the 696. `autocount-erp-mapping-1561.csv` then maps
that single code to what our PURCHASE ORDER line says (`HOK-2008(A) (K)` ->
`TRION (A) (HB STR)-(K)`, `HOK-1013 (Q)` -> `JAGER-(Q)`, `HOK-2038 (A) (K)` ->
`CELENE (A)-(K)`). So the book agrees with itself and with our PO line; the
disagreement is between our own two rows, and it is the SALES-ORDER line that
does not match its AutoCount source.

**Fix.** `backend/scripts/revert-so-po-dedications.mjs` +
`.github/workflows/revert-so-po-dedications.yml`. It selects the population
STRUCTURALLY — every company-scoped purchase-order line whose `so_item_id`
points at a sales-order line with a different normalised `item_code` — so a
tenth such row would be found without editing the script, and the count is
printed whether or not it is the nine expected. `plan` (the default) writes
nothing to the database: it writes a restorable JSON dump carrying one UPDATE
per row that puts the exact `so_item_id` back, re-reads that dump off disk, and
prints it in full to the log; `apply` refuses unless the dump parsed and unless
`CONFIRM` matches `REVERT <n> DEDICATIONS` with the count THIS run measured, so
a phrase copied from an earlier run cannot fire. The mismatch is re-asserted
inside the UPDATE, and a fresh connection re-reads the SHAPE afterwards
(`so_item_id` now NULL, `item_code` unmoved) rather than a row count.

**What it deliberately does NOT do.** It writes no correction. Which side is
right — the customer changed the bed in AutoCount after we copied the order, or
the import mis-mapped the code — is the owner's decision, so the plan prints the
comparison per pair (our two codes, the book's two, and which of ours disagrees)
and stops there.

**One rule, one place.** The repair imports `normItemCode` from
`backend/scripts/lib/ac-po-line.mjs` — the same export `planSoPoDedications`
uses to REFUSE a mismatched dedication (PR #3076, merged 2026-09-07). The guard
that will not write one and the repair that removes one must never disagree
about what "the same item" means, or the repair would delete links the guard
would have allowed.

**Companion entry.** `0671-the-delta-sync-dedicated-9-sales-order-lines-to-purchase-ord.md`
covers the WRITE-side guard. This one covers the rows it cannot reach.

**Ref.** fix/so-po-dedication-revert, 2026-09-07.
