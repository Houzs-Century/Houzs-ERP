## The presence matrix skipped the invoice-straight-off-the-order edge, and the item disagreements did not say which side was wrong [medium]

**Symptom.** Two gaps in the answer given to the owner's 「Transfer From 跟
Transfer To 全部都 check 完了」, both of the same shape — a question that was not
asked reads exactly like a question that came back clean.

1. Section 5 of `check-ac-convert-symmetry.mjs` (added in 0676) compared the
   book's edges against the ERP's on `PO <- SO`, `DO <- SO` and `IV <- DO`, and
   stopped. The book records a **sixth** edge: an invoice raised STRAIGHT off a
   sales order, no delivery order in between — `IV <- SO`, **169 lines** in the
   snapshot. It was not measured. A five-edge summary drops it silently, and
   this is the edge most likely to be absent: the ERP's own invoice flow has one
   `sourceFk` and it is `do_item_id` (`autocount-convert-lines.ts:257`), so
   there is no ERP shape that creates it. `sales_invoice_items.so_item_id`
   exists and reads **0 linked of 182**, which is a fact nobody had a
   denominator for.

2. `probe-po-so-link-recoverable.mjs` (also 0676) refused **10** key-pairs
   because the two ERP rows named different products — correctly, since writing
   those is the class that put nine sales-order lines on a purchase-order line
   for a different bed (`0671`, class `0672`). But it stopped at "they
   disagree", which leaves the useful question open and unowned: is the LINK
   wrong, or is the ERP's item_code wrong? Those two answers belong to different
   people and imply opposite repairs.

**Root cause (traced).** Both are omissions in work landed hours earlier, not
regressions. The first: `erpEdgeQ` in section 5 was built from the owner's
five-edge framing rather than from `EDGES`, which has six entries and always
did — the checker's own edge table already listed `IV <- SO` and section 1 was
reporting on it (`169 children name a source | 0 parent DOC missing`) while
section 5 looked past it. The second: the identity gate was written to REFUSE,
and refusing was treated as the whole job.

**Fix.**

- `IV <- SO` added to section 5's ERP edge set, resolved through
  `sales_invoice_items.so_item_id` -> `mfg_sales_order_items` -> its header's
  `linked_ac_docno`, the same document grain as the other three. Whether it is
  ever populated is the finding, not a reason to skip it.
- The probe now asks the book which side is wrong. AutoCount carries its own
  item key on BOTH ends of the conversion it recorded, so:
  - **book's two ends AGREE, ERP's disagree** -> the link is right and an
    `item_code` was rewritten on import. An ERP-side defect.
  - **book's two ends DIFFER too** -> AutoCount itself converted from a
    different product. A real substitution; the ERP is faithful and the link is
    honest.

  Counted both ways and printed per pair. **Neither is written** — a repair must
  not turn a question into a fact, and this probe still writes nothing at all.

  The two sub-counts are deliberately kept OUT of the `c` object, because the
  probe asserts that `c`'s values PARTITION the population and refuses when they
  do not. A subdivision living in the same object would overshoot the total by
  exactly the number of mismatches and refuse a correct run — the guard working
  against itself.

**Ref.** fix/convert-matrix-iv-so-edge, 2026-09-08. Follows `0676`; the 962
`po_qty_picked` rows of `0677` were applied and verified by run 34144281104
(962 of 962 written, 0 still disagreeing on a fresh connection).
