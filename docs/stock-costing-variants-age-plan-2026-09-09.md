# Stock: costing, variants and age — the plan, and what is already measured

Owner, 2026-09-09: 「Costing 一定要有，因为要不然的话，我开 SCM 就 capture 不到
COGS」, then 「你尽量把所有的东西都补齐吧，Costing、Variants 跟 age 尽量能百分百
补齐是最好的」, and the instruction that decides HOW: 「通过 AutoCount 的通道去查看
整个计算 … 通过那边去提取，得到准确的 costing」 and 「确保 Variant 是根据我们的写法，
在我们的系统写的」.

## What is measured (production, read-only DSN, 2026-09-09)

`scm.inventory_lots`, company 1, `qty_remaining > 0` — **1,560 lots, 10,336 units**.

| axis | filled | gap |
| --- | --- | --- |
| age (`received_at`) | 1,560 / 1,560 (100%) | see below — populated is not the same as accurate |
| COGS (`unit_cost_sen`) | 1,283 / 1,560 (82.2%) | **277 lots, 403 units, 132 item codes** |
| variants (`variant_key`) | 219 / 1,560 (14.0%) | not a gap by itself — see below |

**Every zero-cost lot arrived through `source_doc_type = 'AC_CUTOVER'`.** The
migration imported a quantity and no cost.

Variant coverage tracks PRODUCT TYPE and is mostly correct as it stands:

```
sofa compartments   233 lots, 219 with a variant (94.0%)
mattresses          505 lots,   0 (0.0%)   correct - no variant axis
pillows/accessories 189 lots,   0 (0.0%)   correct
other               633 lots,   0 (0.0%)   includes 218 BEDFRAME lots / 570 units - a real gap
```

## The channel — the owner's instruction, and it is proven to work

AutoCount is the source of truth for both cost and spec, reachable over ZeroTier:

- **Cost.** `StockDTL` is the book's stock ledger — 959 item codes, and stock-in
  is dominated by `DocType = 'GR'` (80,434 units). Its movement-weighted average
  is the real cost. Measured examples: `AMN-SF9058 SOFA` RM 2,278.00,
  `DSL-8030 SOFA` RM 1,877.68, `RDS-5152 SOFA` RM 7,915.68.
- **Spec.** `StockDTL.DtlKey` reaches the source line, and for `GR` that is
  `GRDTL`, which carries `Desc2`. Proven on `HOK-1007 (K)` DtlKey 927132:
  `Col:PC151-01/M'gap:14"Inch/Divan:10"Inch No Leg/Addon Drawer Left side`.

**Deriving cost from OUR purchase orders is WRONG and was tried first.** A sofa
PO carries the whole sofa's money on ONE compartment line and RM 0 on the rest
(`HC-PO-008783`: `9058-1NA=0 | 9058-1A(RHF)=0 | 9058-CNR=0 | 9058-1NA=0 |
9058-2A(LHF)=4215`). Averaging per compartment code reads a whole sofa as the
price of one piece. Worse, the first attempt summed money and weight across ALL
purchase orders including the unpriced ones and came out **6x too low**. The book
says a 9058 sofa costs RM 2,278; our POs suggested RM 4,215 — nearly double. The
owner's channel is the accurate one.

## The three repairs

### 1. Costing — MANDATORY

For each zero-cost lot, in this order:

1. **The book's own cost** for that item code (`StockDTL`, movement-weighted).
2. **Sofa compartments**: take the book's WHOLE-SOFA cost for the model's
   AutoCount item, then split it across compartments weighted by
   `scm.compartment_library.default_price` — the owner's own price list
   (2-seater 1990, 1-seater 1490, corner 1490, L 1490, 2NA 1490, 1NA 990,
   console 590, stool 490). Owner: 「乙 你根据我们目前的价格的比例大概去算就行」.
   **The denominator is the model's TYPICAL BUILD taken from our own sales
   orders**, not an invented standard configuration, so the pieces of one sofa
   sum back to the book's cost for that sofa.
3. Anything neither answers stays 0 and is REPORTED. Models with no book item at
   all: 1025, 2376, 2379, 2391, 5142, 5150, 7179, 7219, 7226, 7233. The
   `-1S` / `-2S` whole-sofa codes are not a compartment and have no weight.

Two models have exactly one priced sample; asked, the owner said 「照算」.

### 2. Variants — bedframes

218 lots / 570 units. The spec is NOT in our system and IS in the book, reached
by the channel above.

**Write it in OUR shape, never AutoCount's text.** Owner: 「确保 Variant 是根据我们
的写法，在我们的系统写的」. Our shape is
`{colourId, colourLabel, fabricId, fabricCode, fabricLabel, gap, divanHeight,
legHeight, totalHeight, specials[]}` with strings like `14"`, `No Leg`.

**The target is the Stock Breakdown screen's ATTRIBUTES column**, which the
owner pointed at directly. A correctly filled bedframe lot reads:

```
BF-01 (PC151-01) / GAP 14" / DIVAN 8" / LEG 2" / TOTAL H 24"
```

so the fields behind it are the fabric code + colour, `gap`, `divanHeight`,
`legHeight` and `totalHeight`, each an inch string. That screen already carries
UNIT COST, SOURCE, MOVEMENTS (every stock change) and COGS (the FIFO
consumptions) — **the screen is not the gap, the data is**: 277 lots have no
unit cost and 218 bedframe lots have no attributes.

**Reuse `backend/scripts/lib/parse-bedframe.mjs`. Do not write a second
parser.** That module's own header records why: two copies drifted twice, and a
refresh script that rebuilt the parser from source text with `new Function()`
broke in production on 2026-08-09. `parse-sofa.mjs`, `bedframe-special-map.mjs`,
`sofa-special-map.mjs`, `variant-axes.mjs` and `variant-merge.mjs` are the rest
of the set.

### 3. Age

`received_at` is populated on every lot, and it is largely REAL rather than
stamped at import: 2023 → 6 lots, 2024 → 89, 2025 → 400, 2026 → 1,065. But
**424 of 1,560 lots carry a date inside the migration window (2026-08-28 to
09-09)** and from the ERP alone a genuine recent receipt cannot be told from an
import stamp. Settle it by comparing each against its `StockDTL.DocDate` through
the same channel, and correct only where the book disagrees.

## Discipline for all three

Each ships as its own plan/apply script + `workflow_dispatch` workflow: MODE
defaults to plan, apply needs a confirm phrase, every UPDATE carries a predicate
that the field is still empty so nothing already filled is overwritten, and
verification re-reads on a FRESH connection asserting the SHAPE — not a row
count. Costing additionally asserts no negative cost and that the count of
already-costed lots is unchanged.
