## The migrated-document writer inserted the same delivery line twice [high]

**Symptom** - `HC-SO-001920` ordered one `ELEPAHNE-(SK)` and showed four
delivery lines. Stock was never deducted once.

**Root cause (traced, not guessed)** - two independent mechanisms in
`create-migrated-documents.mjs`, both in the AutoCount-row-to-SO-line mapping:
`targets` took `cands[0]` for every row, so a second AutoCount row of one item
code produced a second delivery line pointing at the FIRST sales-order line; and
the sofa branch re-pushed every compartment of a build each time another row
named the same model. The document-level `done` guard hid neither, because the
duplication happens while ONE document is being built.

**Fix** - candidates are consumed in order (which also corrects the mis-link
underneath the duplicate: two rows of one code are two deliveries against two
different lines), a build is covered once per document, and an identical
`(so_item_id, item_code, qty)` on one document is refused outright so a future
mapping path cannot reintroduce the shape. A row with no unclaimed SO line left
is skipped and counted LOUDLY rather than reusing one - the same choice
`backfill-ac-line-keys.mjs` makes, for the same reason: a wrong link is worse
than none.

**The 18 rows already written are NOT removed.** `scm.delivery_order_items` has
no line-level cancel column and adding one is the deferred line-retirement work.
They cost no stock (0 movements) but they do inflate the order's arithmetic:
**11 sales-order lines read as over-delivered**. The exact rows, two options and
a recommendation are in `docs/migrated-do-duplicate-lines.md` for one owner
decision. Not to be confused with AutoCount's `DO-006224`, which genuinely
delivered a second unit - real data, a commercial question, not a defect.

**Ref** - 2026-08-11, PR #1964. Prod evidence: diagnostic run 31431814091,
Section D.
