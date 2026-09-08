## The not-linked column counted 765 lines with no cause attached, four fifths of them the book's own answer [medium]

**Symptom.** `check-ac-convert-symmetry`'s matrix has printed a `not linked`
column since #3049 — 398 + 10 + 183 + 0 + 87 + 87 = **765 ERP lines that point
at no source at all** (run 34182972797, 2026-09-08 11:17 MYT). Nobody had ever
said what those were. The owner asked directly whether they were being handled;
the honest answer was no. Read as a gap the number is alarming, and read as
noise it hides a real one: a bedframe / sofa / (SP) mattress line is HARD-BOUND
(`isHardBoundLine`), so a company-1 purchase-order line with no `so_item_id`
lights nothing up and the sales order behind it stays PENDING with the goods in
the warehouse.

**Root cause (traced).** Two separate things, and the second is the one that
made the first hard to answer.

1. The column was **four unrelated populations wearing one number** — the same
   shape the `item code` column was in before #3167 split it. Measured against
   the committed book snapshot in run 34184228024: 34 are ERP-native documents
   the cutover never imported; 512 are lines whose own book document names no
   source of that type; 17 name a parent outside the cutover; 177 are edges the
   book records by DOCUMENT number and nothing finer. **740 of 765 are the
   absence being CORRECT and identical to the account book.** Only 25 are a
   finding: 13 where `PODTL.FromSODtlKey` names a sales-order LINE the ERP holds
   exactly once and `so_item_id` is still NULL, and 12 the book cannot settle
   (no line key, or a key carried by several ERP rows).

2. **The first classifier manufactured a gap of its own**, and it is recorded
   here rather than quietly corrected. It resolved every edge through the child
   line's `linked_ac_dtlkey` and reported **360 of the 765 as "no AutoCount line
   key"** (run 34183990531). Migration 0280's own header refutes that reading: it
   ADDED that column to the four downstream tables and states *"nothing
   backfills it: the keys are stamped forward"*, so a migrated delivery note,
   receipt or invoice has none BY DESIGN. A route that needs a key answers
   UNKNOWN for the whole migrated population — a checker that cannot match,
   reporting a false gap instead of a false pass.

   The `IV <- SO` row is what that cost: 183 invoice lines with no sales-order
   link, against a `0 / 0` forward count. Read through the document, all 183 are
   `book_no_edge` — the book's invoices are converted from DELIVERY ORDERS, and
   every one of those 183 ERP rows already carries its `do_item_id`. There is no
   SO -> IV edge to hold.

**Fix.** `backend/scripts/lib/not-linked-class.mjs` — a pure classifier, six
named classes, four marked benign. `SO -> PO` is read through the line key (the
one edge AutoCount stamps with one); the other five through the child DOCUMENT,
which is the grain the book stores them at. `check-ac-convert-symmetry.mjs`
gains section 6b, which classifies the whole unlinked population and REFUSES if
its classes do not total the figure section 6 printed — the two are the same
population read twice, and a disagreement means one read is not measuring what
it says. The matrix column now prints as `same as book + FINDING`.

`backend/tests/notLinkedClass.test.mjs` pins that a real gap cannot be folded
into a benign bucket: a missing line key, an unreachable child document and a
key carried by several ERP rows are all findings, and `null` line-lists never
collapse into "the book records no source". **Proved RED on the unfixed tree**:
the classifier as it stood at `c60551b2e` was restored over the fixed one and
the suite run — `6 failed | 13 passed (19)`, the six being every document-grain
assertion.

`backend/scripts/repair-po-so-link-from-book.mjs` writes the 13 the book settles
at line grain, under the four release-discipline gates, guarded on
`so_item_id IS NULL` so it can never re-point an existing link and is safe
beside the other PO/SO lanes. It does NOT recompute the allocation
(docs/bugs/0675) and says so.

**Ref.** `fix/notlinked-column`, 2026-09-08. Runs: 34182972797 (the column as it
stood), 34183990531 (the DtlKey route, refuted), 34184228024 (the classification).
