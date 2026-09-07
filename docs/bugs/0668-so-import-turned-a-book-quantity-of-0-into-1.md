## SO import turned a book quantity of 0 into 1 [medium]

<!-- area: AutoCount sync + write-back -->

**Symptom.** The 2026-09-07 reconcile (run `34127889821`) reported 22 migrated
sales-order lines whose quantity disagrees with AutoCount. Seven of them share
one shape:

```
SO-000390 DtlKey  34785: AutoCount qty 0 vs ERP qty 1
SO-000814 DtlKey  58981: AutoCount qty 0 vs ERP qty 1
SO-008442 DtlKey 585359: AutoCount qty 0 vs ERP qty 1
SO-008447 DtlKey 585389: AutoCount qty 0 vs ERP qty 1
SO-008562 DtlKey 597311: AutoCount qty 0 vs ERP qty 1
SO-013103 DtlKey 889479: AutoCount qty 0 vs ERP qty 1
SO-013499 DtlKey 926852: AutoCount qty 0 vs ERP qty 1
```

The owner's reading of the same finding is the one that matters:
*不是跟着 AutoCount 吗?* — the migration copies the book, so an ERP quantity the
book does not state is a defect, not a business decision.

**Root cause (traced, not guessed).** One line —
`backend/scripts/import-ac-outstanding-so.mjs:249`:

```js
const qty = Math.round(num(l.Qty)) || 1;
```

`0 || 1` is `1` in JavaScript. The `|| 1` was presumably meant to guard an
unparseable quantity, but `num()` (same file, `:46`) already returns `0` rather
than `NaN` for anything it cannot parse, so the fallback could only ever fire on
a genuine, deliberate zero. Every AutoCount line recorded at `Qty 0` was imported
as ONE unit of goods.

Read directly against the live book over the ZeroTier tunnel on 2026-09-07
(`sqlcmd` against `AED_HOUZS`, SELECT only), all seven are zero-priced
annotations rather than products:

| DtlKey | ItemCode | Description | Qty | UnitPrice |
|---|---|---|---|---|
| 34785 | `NB-KHJ35 (Q)` | *(blank)* | 0 | 0.00 |
| 58981 | *(blank)* | *(blank)*, Desc2 `LEG: FOLLOW DISPLAY` | 0 | 0.00 |
| 585359 | `DISPOSE` | DISPOSE REQUEST | 0 | 0.00 |
| 585389 | `DISPOSE` | DISPOSE REQUEST | 0 | 0.00 |
| 597311 | `DISPOSE` | DISPOSE REQUEST | 0 | 0.00 |
| 889479 | `TRANSPORTATION CHARGES` | TRANSPORTATION CHARGES | 0 | 0.00 |
| 926852 | `DISPOSE` | DISPOSE REQUEST | 0 | 0.00 |

So the ERP was claiming a unit of goods on lines the book raises purely as
instructions to the warehouse. The unit price is 0.00 on every one of them, so
no money moved — which is exactly why this survived every money audit.

**Fix.** Two parts, because the bad rows are already in production:

1. `import-ac-outstanding-so.mjs:249` drops the `|| 1`, so a re-import cannot
   put it back.
2. `backend/scripts/repair-so-qty-from-autocount.mjs` +
   `.github/workflows/repair-so-qty-from-autocount.yml` copy the book's quantity
   onto every migrated line whose DtlKey says it differs — not only these seven —
   re-derive `total_sen` / `balance_sen` as `unit_price_sen * qty`, and re-sum
   the header's `local_total_sen` and its five bucket columns from the lines.

**What the repair refuses to do silently.** A line that has already been
DELIVERED cannot be quietly reduced: the stock came out against the old number.
The repair reads each line's delivered quantity (live delivery orders only,
`status NOT IN ('CANCELLED','DRAFT')`) and its `allocated_batch_no` in the same
statement it plans from. Where the book's quantity is >= what has already moved
the book wins; where it is LESS, the line is NAMED in the log with its delivered
quantity and left for the owner, never folded into a refusal count.

**What it deliberately does NOT touch.** The header's `paid_sen` and
`balance_sen`. What a customer paid is a fact about the business, not an
arithmetic consequence of a corrected total; where the corrected total leaves
them no longer adding up, the run prints the order and the owner rules on it.

**Ref.** fix/ac-lines-match-2026-09-07, 2026-09-07.
