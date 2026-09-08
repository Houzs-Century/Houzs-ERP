## A model change dealt the sofa compartments out by position, onto the wrong rows [high]

<!-- area: AutoCount sync + write-back -->

**Symptom.** Caught in a DRY-RUN before it wrote anything (prod run `34186295345`).
Correcting `HC-PO-009550` from model `9058` to the book's `8030` planned this:

```
change 2A(RHF) -> 1A(LHF)
change CNR    -> CNR
change 1A(LHF) -> 2A(RHF)
```

Two of the three compartments were about to land on a DIFFERENT row. The same
plan on `HC-PO-009712` moved all three.

**Root cause (traced).** `pairRowsToPieces` in `scripts/lib/sofa-build-plan.mjs`
paired a row to a target piece by its FULL code, then handed whatever was left
out in DOCUMENT ORDER:

```js
const i = pool.findIndex((r) => K(codeOf(r)) === K(w));
...
for (const p of pairs) if (!p.row && pool.length) p.row = pool.shift();
```

While a correction kept the model it found, pass one matched every row and the
fallback never ran on a full build — so the hole was invisible for the whole
cutover. A MODEL change makes pass one match nothing, and every row falls to the
positional fallback at once.

Position is not identity here. Read on prod by the read-only probe
`34187267757`, `HC-PO-009550` holds its compartments in the order `2A(RHF), CNR,
1A(LHF)` while the build is written `1A(LHF), CNR, 2A(RHF)` — and each of those
purchase-order rows carries a `so_item_id` dedication to the sales-order row
with the same code. That dedication is what bound-mode readiness reads
(`isHardBoundLine`, `src/scm/lib/so-stock-allocation.ts`), and the applier never
moves it. Re-labelling the rows without moving the dedications crosses them.

**What saved it, and why that is not a fix.** The sales-order half of the same
build runs second and its downstream carry re-writes each purchase-order row
through the dedication —
`UPDATE scm.purchase_order_items SET item_code = <new> WHERE so_item_id = <so row id>`
— so the final state would have been correct anyway. That depends on the
document list naming the purchase order BEFORE the sales order, and on every
purchase-order row being dedicated. Both hold for these three builds and nothing
asserts either.

**Fix.** A second pass, between the two that existed: same COMPARTMENT under
another model keeps its own row. A piece with no compartment is excluded, so two
codeless rows are never paired to each other on the strength of `""`. Genuinely
different pieces still fall through to the positional fallback, which is what a
`-1S` placeholder needs.

Pinned in `scripts/lib/sofa-build-plan.test.mjs` on prod row fixtures, and
proved RED with the pass removed — 2 of 19 fail, with the shuffle in the message:

```
actual:   [ 'po1', 'po2', 'po3' ]
expected: [ 'po3', 'po2', 'po1' ]
```

**Also in this change.** `HC-SO-012629` / `HC-PO-009712` reported "no line
matches" on both documents, so that correction could not reach its rows at all.
The ERP's own `description2` reads `BO315-03` where the book reads `BO315-3`, and
the file's `desc2Match` quoted the book's spelling past that point. Shortened to
the prefix both sides carry; all three rows on each document hold one identical
text, so it stays unambiguous.

**Ref.** fix/sofa-book-model-2026-09-08, 2026-09-08. See
`docs/bugs/0693-a-hand-typed-model-in-the-sofa-corrections-file-outranked-th.md`
for why a model was moving at all.
