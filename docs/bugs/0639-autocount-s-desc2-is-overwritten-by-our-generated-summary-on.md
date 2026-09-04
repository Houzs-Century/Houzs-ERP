## AutoCount's Desc2 is overwritten by our generated summary on the first save of a migrated line [high]

**Symptom.** The owner, 2026-09-02: 「那个 description 2 也要记录进我们的 remarks
里面」. AutoCount's `SODTL.Desc2` is the customer's own spec text on the line, in
the salesperson's words — `1+1NA+L(26/28'Inch)/Col:KIV/Bottom upgrade to
umbrella fabric`, `COLOUR :KIV/DIVAN : 8 INCHES , NO LEG/MATTRESS GAP : KIV`. It
is a different column from `FurtherDescription`, which is where the photographs
live (`docs/bugs/0220-*`). The ERP carries it on migrated lines in
`scm.mfg_sales_order_items.description2` and has exactly one copy of it.

**Root cause (traced).** `description2` is SERVER-GENERATED on every write, with
no exemption for a migrated line:

- `backend/src/scm/routes/mfg-sales-orders.ts:4315` — create assigns
  `description2: buildVariantSummary(category, variants) || null`
- `backend/src/scm/routes/mfg-sales-orders.ts:8581` — patch assigns
  `updates['description2'] = buildVariantSummary(effGroup, effVariants) || null`

So the first save of a migrated line replaces the book's wording with our
computed summary (`PC151-01 / DIVAN 8" + LEG 1" / GAP 14" / T.Heights 23"`).

The loss is TWO-SIDED. `scm.app_config 'scm.autocount_writeback'` reads `"1"`
(measured on production 2026-09-04), and `composeDescription2()` —
`backend/src/services/autocount-writeback.ts:973-976` — returns
`line.description2` verbatim when it is non-empty. So the same save then sends
our generated text back to AutoCount as the line's `Desc2` and overwrites the
book's copy as well. There is no third copy.

**How much has already been lost: ZERO, measured, and that is the finding.**
`buildVariantSummary` was re-run per line against production on 2026-09-04, from
each line's own `item_group` + `variants`, and compared to the stored
`description2`. Across all 14,450 migrated SO lines of company 1, **not one**
line's `description2` equals what the generator would produce for it. 3,362 of
them are byte-identical to the book's own snapshot; 125 differ from the
2026-08-11 snapshot but are still human book-style text from the later
2026-08-28 re-import; 5 lines the book has `Desc2` for hold nothing. So the
exposure is real and completely unmitigated in code, and the damage so far is
none. This is a PREVENTIVE fix, not a recovery.

**Fix.** `backend/scripts/preserve-autocount-desc2-in-remark.mjs` +
`.github/workflows/preserve-autocount-desc2-in-remark.yml` park a labelled copy
of the book's wording in `scm.mfg_sales_order_items.remark`, which the write-back
cannot see: the payload is `ItemCode / Description / Desc2 / Qty / UnitPrice`
(+ optional `Location`, `DeliveryDate`, `Photos`) at
`autocount-writeback.ts:1036-1041`, and `SO_ITEM_COLS` — the column list the
outbox reads off the ERP line, `backend/src/scm/lib/autocount-outbox.ts:382-383`
— does not select `remark`. A case-insensitive grep for `remark` over
`autocount-writeback.ts` and `autocount-outbox.ts` returns nothing.

The script writes ONE column. It never writes `description2` (re-deriving it is
the bug), never a money column, never a header field. Plan by default, rolled
back in one transaction, verified on a fresh connection that asserts the value
shape and that `description2` did not move.

**The write shape is the owner's, not the script's.** 663 of these lines already
carry a remark, and every one of them is our own importer's machine note —
measured on production 2026-09-04 by grouping all 663 by value (129 distinct
strings): 548 `sofa:` substitution notes, 95 `UNPARSED` token lists, 13
`compartment corrected 2026-08-10`, 7 `name-matched from free-text`. Not one is
customer text and not one was typed by a person. Told exactly that, the owner
ruled 2026-09-04: 「如果是我们导入的就不需要」. So `SHAPE=overwrite` is the
default — the book's wording replaces the machine note under a `账本原文:`
label — and every replaced value is printed in full in the run log before the
write, in the plan run and the apply run alike. `SHAPE=append` (keep the machine
note, add the book text under it) and `SHAPE=fill-only` remain selectable.

**Root fix still open, and named so it is not mistaken for done:** the two
assignments above should not overwrite a line whose `description2` came from the
book. This entry's script preserves the text; it does not stop the overwrite.

**Ref.** `feat/preserve-ac-desc2-in-remarks`, 2026-09-04.
