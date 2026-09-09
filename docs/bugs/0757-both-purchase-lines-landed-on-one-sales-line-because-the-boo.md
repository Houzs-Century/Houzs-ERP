## Both purchase lines landed on one sales line because the book's edge names a mattress [medium]
<!-- area: AutoCount sync + write-back -->
<!-- status: fixed -->

**Symptom.** `HC-SO-000870` shows on the sales-order tally under 单据转换链. Its
two `CODY-(K)` bedframes are covered by `HC-PO-000290`'s two RECEIVED lines, but
**both purchase lines point at the same sales row** — the one carrying book line
60702, whose quantity is 1. That row therefore reads `po_qty_picked = 2` against
a qty of 1, and the order's OTHER `CODY-(K)` row (book 60699, qty 1) reads 0 and
still offers itself for purchase. One bedframe already bought and received looks
entirely unbought, which is a duplicate-purchase invitation on a PROCEEDED order.

**Root cause (traced, and it is the account book's).** Read from live
`AED_HOUZS`:

```
PO-000290 DtlKey 61216  NB-KHJ57(K) "NB-CODY B/FRAME(K)"  FromSODtlKey 60700
PO-000290 DtlKey 61217  NB-KHJ57(K) "NB-CODY B/FRAME(K)"  FromSODtlKey 60702
```

On the book's own `SO-000870`, 60699 and 60702 are CODY bedframes and **60700 is
a MYLATEX LUMBARIA mattress**. So the book points a bedframe purchase at a
mattress line while an unclaimed bedframe line sits on the same order. The
migration could not copy that edge — it would put one product's purchase on
another product's line, which is what `docs/bugs/0671-the-delta-sync-dedicated-9-sales-order-lines-to-purchase-ord.md`
cost — so the line fell back onto the row it could match and doubled up.

`lib/so-po-counter-cause.mjs` already classifies this as
`book_source_is_another_product` and refuses to repair it. **That refusal is
correct and is not widened**; it is what surfaced the case.

**Fix.** The owner, shown both products side by side on 2026-09-09: **「乙 · 照产
品对」** — link it to 60699, the other CODY bedframe, not to the mattress the book
names. His standing 「一律跟账本」 governs the VALUES the book states about a line;
it does not extend to an edge that names the wrong line, and his first answer
(「这个跟autocount啊」) was given before he had seen the two products.

`backend/scripts/relink-so-000870-po-line.mjs` +
`.github/workflows/relink-so-000870-po-line.yml` move that one purchase line's
`so_item_id`, pinned to the row id, its current `so_item_id` AND its book line
key, so a row that has moved matches nothing. The other purchase line
(61217 -> 60702) is already correct and is left untouched. `po_qty_picked` is
deliberately left stale for `recompute-so-po-qty-picked.mjs`, which owns that
counter and is idempotent — two scripts writing one denormalised value is how it
stops being trustworthy.
