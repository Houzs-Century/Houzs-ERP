## The convert-symmetry check measured the wrong invoice column and never asked whether the ERP holds the book's edges [high]

**Symptom.** The owner asked twice for the convert relationships to be checked
in both directions across the whole migrated set — 「Transfer From 跟 Transfer To
全部都 check 完了」. `check-ac-convert-symmetry.mjs` answered, and its answer was
wrong in one place and incomplete in three:

- section 4a reported `SI line -> SO line   0 linked | 182 carry no parent link
  at all`, which reads as an invoice chain with no links at all;
- section 4b had no answer of any kind for GR -> PI, one of the five edges the
  owner named;
- nothing in the file compared the ERP against the book. Sections 1-2 measure the
  book against itself and 4a-4c measure the ERP against itself, so both halves
  could be perfectly clean while the ERP had simply never imported an edge
  AutoCount records.

**Root cause (traced).**

1. **Wrong column.** 4a measured `sales_invoice_items.so_item_id`. The column the
   system actually converts and gates on is `do_item_id` —
   `autocount-convert-lines.ts:257` names it as the invoice's `sourceFk`, and
   `do-line-remaining.ts:238-265` sums invoiced quantity through it. Measured on
   production (run 34141734756): `SI line -> DO line  182 linked | 0 ORPHAN | 0
   carry no parent link at all`. The edge was complete the whole time; the check
   was looking at a different column and reporting its emptiness as the answer.
   This is CLAUDE.md's first trap — *the check that answers a different question*
   — and the successful result was also true of a column the invoice flow does
   not use.

2. **A missing question, not a missing number.** 4a counts a NULL link as
   `unlinked`, and a NULL is not evidence of a missing link: a purchase order
   raised on its own legitimately has no sales order. Only the book can say which
   NULLs should have been links, and the file never asked it. `369 carry no
   parent link at all` had therefore been sitting in the output for a day
   meaning nothing in particular.

3. **Both stored counters were compared against a rule the code does not
   apply.** `recomputeSoPicked` (`mfg-purchase-orders.ts:2843-2887`) drops PO
   lines with `from_mrp = true` and excludes DRAFT purchase orders as well as
   CANCELLED; the check counted both populations. `recomputePoReceived`
   (`grns.ts:840-891`) writes `SUM(max(0, qty_accepted - returned_qty))`
   excluding DRAFT and CANCELLED GRNs; the check measured raw `qty_received` and
   raw `qty_accepted`, excluded only CANCELLED, and *resolved the tie by taking
   whichever column disagreed less* — choosing the flattering number rather than
   the true one.

   **The hypothesis this correction was built on was REFUTED, and the numbers
   stand.** The prediction was that the excluded populations inflated the child
   sums and manufactured the drift. Measured on production (run 34142505986),
   the write-path rule reports **962 of 15050** sales-order lines and **241 of
   1333** purchase-order lines — *identical* to the naive rule on both. The
   drifts are real. What the correction bought is that the numbers are now
   trustworthy rather than coincidentally right, that the misleading "the other
   convention differs on 241" framing is gone, and that the DIRECTION is
   reported: 962 read LOW (the SO->PO ceiling is too generous) and 241 read HIGH
   (a migrated PO reads received for goods whose receipts were not imported).

**Fix.** Three changes to `backend/scripts/check-ac-convert-symmetry.mjs`.

- 4a reports `sales_invoice_items.do_item_id` and `so_item_id` as the separate
  edges they are. 4b gains `grn_items.invoiced_qty`, measured the way
  `recomputeGrnInvoiced` (`purchase-invoices.ts:96-170`) writes it — DRAFT
  excluded as well as CANCELLED, clamped to `qty_accepted`, because a plain
  child-sum would have reported the clamp as drift. Result: 0 of 591 disagree.
- Both counters now replicate their write path exactly, and print the naive
  figure beside the answer so the old reading cannot return silently.
- **Section 5, new:** the book's edge set and the ERP's edge set matched at
  DOCUMENT grain through both headers' `linked_ac_docno`, reported FORWARD
  (book -> ERP) and BACKWARD (ERP -> book), each with its own denominator.
  Document grain, not line grain: the ERP decomposes a sofa into one row per
  compartment while the book keeps one line, so a line-count comparison would
  report that decomposition as a missing link. Where the question cannot be
  asked it says so — the goods receipt has no AutoCount number of its own
  (`autocount-outbox.ts:1069-1099`), so GR <- PO and PI <- GR have no
  document-grain identity on the child side, and GR <- PO is instead asked the
  strongest question that IS answerable: the GRN header's PO number against the
  PO its own lines resolve to.

  First run (34141734756, 2026-09-08 00:07 local): **16 book edges the ERP does
  not hold**, all on SO <- PO; **0 ERP edges the book does not record** on every
  edge; DO <- SO 171/171 and IV <- DO 45/45 complete in both directions.

The new analyser is self-tested with the rest, and the three assertions were
**proved RED** against a deliberately broken `bookDocEdges` before being trusted
— pair built from the wrong key, two lines to one parent counted as two edges,
cancelled parent not flagged; all three failed the self-test and the run refused.

`backend/scripts/probe-po-so-link-recoverable.mjs` is added to answer what the
16 mean: of the unlinked purchase-order lines, how many the book provably
resolves, and — counted separately — each way a row fails to be provable. It
refuses to call a row recoverable on a key match alone, because a key match is
not an identity match (class `0672`).

**Ref.** fix/convert-symmetry-matrix, 2026-09-08. Runs 34141734756 and
34142505986.
