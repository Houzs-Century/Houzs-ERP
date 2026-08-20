## 11 sales orders read as over-delivered against delivery lines that never moved stock [med]

**Symptom** - staff looking at `HC-SO-001920` saw one `ELEPAHNE-(SK)` ordered
and four delivered. Ten other sales-order lines read the same way. Nothing was
missing from the warehouse.

**Root cause (traced, not guessed)** - not a stock fault at all, an arithmetic
one. `create-migrated-documents.mjs` inserted 18 surplus delivery lines across 8
migrated documents (the writer defect logged below, fixed in #1964). Every one
is an EXACT duplicate of its twin on `(so_item_id, item_code, qty)`, every one
sits on a `migrated_no_stock` document, and prod run **31450027318** measured
**0 inventory movements** against any of them. But `delivered` is the DO line's
own `qty` (`do-line-remaining.ts:199`) and every delivered sum is `SUM(qty)`
over non-cancelled lines, so a duplicate inflates "delivered" with nothing
behind it.

**Fix** - `backend/scripts/zero-duplicate-do-lines.mjs` +
`.github/workflows/zero-duplicate-do-lines.yml`, the owner's Option B
(`docs/migrated-do-duplicate-lines.md`, decided 2026-08-11): set `qty = 0` and
append an audit note naming the original quantity and the twin. **The row is
retained** - the owner's rule is that nothing is deleted, and
`scm.delivery_order_items` has no line-level cancel column, so a zero quantity
is how a line is retired until the deferred line-retirement work lands. No
migration, no new column, no reader taught a new flag.

The guards are the entry: it refuses a document that is not
`migrated_no_stock`, a document with any inventory movement, a surplus line
carrying money, and a surplus line an invoice or a return already points at
(remaining-to-invoice is `delivered − invoiced − returned`, so zeroing one of
those drives it negative). `qty <> 0` in the grouping query makes a re-run inert
and stops the five zeroed `HC-DO-007525` rows from re-grouping with each other
at quantity 0.

**What zeroing does NOT fix, deliberately** - the duplicate half of the
over-delivery, not all of it. Where the surviving quantity still exceeds the
ordered quantity, the cause is the *mis-link* half of the same writer defect (a
second AutoCount row of one code pointed at the FIRST sales-order line), plus
`HC-DO-006224`, which genuinely delivered a second unit two months after
`DO-005452` against a 1-unit order. That last one is a commercial question for
the owner about a real shipment, **not an ERP defect**, and the script leaves
one row per group standing precisely so it survives.

**Lesson** - a rowcount and a stock ledger answer different questions. Nothing
was wrong with inventory here, and an audit that only checked movements would
have called this clean while staff read it as a stock problem daily.

**Ref** - 2026-08-11, PR #1971 (fix/do-duplicates-and-fabric-merge). Prod
evidence: read-only diagnostic run 31450027318 (Section D), DRY-RUN 31451629651, APPLY
31451705673 - 18 rows zeroed, over-delivered 11 -> 7, every document total
identical. Full numbers in `docs/migrated-do-duplicate-lines.md`.
