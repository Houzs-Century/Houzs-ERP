## The reconcile guesses which goods-receipt line is which and prints the guess as an item-code defect [high]

**Symptom.** The AutoCount vs ERP reconcile (run 34184553347, 2026-09-08 11:45
+08) reports **36 company-1 goods-receipt item-code differences**, and they sit
in the summary's `item` column, which the table's own header calls
*"DIFFERENCES (the work)"*. Every sample it prints is a **transposed pair inside
one document**:

```
GR-005334|PO-009887 DtlKey 917594: AutoCount "AK-IMMORTAL MATT (K)"  vs ERP "AKEMI ULTIMATE MATT (K)"
GR-005334|PO-009887 DtlKey 917604: AutoCount "AK-ULTIMATE MATT (K)"  vs ERP "AKEMI IMMORTAL MATT (K)"
```

The two answers are each other's. All ten pairs in the printed sample of 20 have
that shape, across mattresses (`AKEMI EQUINOX` / `IMMORTAL` / `GUARDIAN` /
`ULTIMATE`), bedframes (`CELENE (A)-(K)` / `-(SS)`, `JAGER-(Q)` / `-(S)`,
`TRION (A) (HB STR)`) and accessories (`LONG PILLOW` / `SQUARE PILLOW`).

**Root cause (traced).** `scm.grn_items` carries **no AutoCount line key**, so
the reconcile has nothing to pair a receipt line on and falls back to guessing.

Two lines of code, both read in this tree:

* `backend/src/db/migrations-pg/0280_scm_ac_line_keys_downstream.sql` adds
  `linked_ac_dtlkey` to `scm.grn_items` and states plainly that **nothing
  backfills it** — *"the keys are stamped forward, at the moment AcSyncService
  reports the lines it created for a conversion"*. No migrated receipt is ever
  stamped, and `reshape-migrated-grns.mjs`'s own `INSERT INTO scm.grn_items`
  (:921) does not list the column, although the plan it writes from holds the
  book's DtlKey on every item as `i.book.dtlKey`.
* `backend/scripts/check-ac-erp-reconcile.mjs:423` therefore hardcodes
  `NULL::bigint AS ac_dtlkey` for the GR lane, and `0 AS line_no` with it.

With no key on either side, the keyless fallback (:1170) pairs on
`(qty, unit price)`, then on `qty` alone, then on document order. A migrated
receipt's `unit_price_sen` is taken from the **purchase order** line by design,
not from `GRDTL.UnitPrice`, so the first pass misses; two mattresses of qty 1
then land in one `qty` bucket and whichever row postgres returns first takes the
first book line. The ERP row is fine; the CORRESPONDENCE is invented, and the
difference the checker prints is its own guess.

The reconcile is not silent about this — it also reports **44 GR documents that
"could NOT be line-matched (no line key on either side and the line counts
differ)"**, which is the same absence declaring itself on the documents where it
could not even pretend.

**Why this is high and not cosmetic.** The identical shape on the sales and
purchase side was NOT an artefact: 61 of 111 were genuinely the wrong product,
including a mattress that would have shipped in the wrong size to four customers.
A column that mixes invented findings with real ones destroys the real ones —
the reader stops believing the list. That is the same cost `docs/bugs/0689`
recorded when a naive CSV split invented 40 of 101 item-code defects.

**Fix.** Not yet applied — this entry ships with the OBSERVATION, deliberately.
`backend/scripts/probe-gr-pi-iv-residue.mjs` + its workflow ask the one question
no ordering can affect: is the document's book-side item-code **multiset** equal
to its ERP-side multiset? If it is, both sides name the same products in the same
quantities and only the correspondence is unknown; if it is not, a product is
genuinely wrong and the probe names it. Sofa documents are excluded outright —
one book line becomes one ERP row per compartment, so the two are not
commensurable — and no sofa model alias is folded, because `SOFA_MODEL_ALIAS`
maps `5537 -> 8030`, which the owner has not confirmed, and folding could make a
wrong product compare equal.

The repair follows the measurement, in a second PR, and its shape depends on the
answer. Stamping `linked_ac_dtlkey` from the reshape's own plan is the candidate
root fix — it is a COPY of a key the writer already holds, it makes the GR lane
measurable instead of guessed, and migration 0280 names a second thing it
unblocks: without it the AutoCount write-back refuses every edit of a migrated
receipt, because the key it addresses a detail row by does not exist.

**Ref.** fix/gr-pi-iv-reconcile, 2026-09-08.
