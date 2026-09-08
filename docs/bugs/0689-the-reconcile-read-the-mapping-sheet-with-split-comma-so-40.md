## The reconcile read the mapping sheet with split(","), so 40 correct sales-order lines were reported as wrong products [high]

<!-- area: AutoCount sync + write-back -->

**Symptom.** On go-live morning, 2026-09-08 10:00 (UTC+8), run 34178538830 of
*AutoCount vs ERP reconcile* put `item code: 101` on sales orders and
`item code: 10` on purchase orders in front of the owner, and that 111 was the
largest unexplained number on the table. It was waved away for a night as
"derived, so a difference measures our translation, not a defect". That sentence
was never measured, and it was wrong in both directions: 46 of the 101 were
indeed harmless, and 61 of the 111 name a product the book does not.

**Root cause (traced).** `backend/scripts/check-ac-erp-reconcile.mjs` read
`data/autocount-erp-mapping-1561.csv` like this:

```js
const [ac, erp] = line.split(",");
```

The sheet is RFC4180. Three of its 1,577 rows quote the ERP code, because a
mattress name carries the inch mark:

```
DL-GENERASI (S),"DUNLOPILLO GENERASI 5"" MATT (S)",NEW,MATTRESS,400-D001
```

`split(",")` cuts that row into `"DUNLOPILLO GENERASI 5""` and ` MATT (S)"`, so
the ERP code the checker compared against was a fragment that **no production row
can ever equal**. Every sales-order line carrying `DL-GENERASI (S)` or
`DL-GENERASI (SS)` was therefore reported as an item-code defect: 40 of the 101,
across 26 sales orders, every one of them correct in the database.

Two things kept it invisible.

1. **The self-test measured the row COUNT.** `codeMap.size < 100` passes at 1,577
   whether or not three of those rows are garbage, so the reader looked healthy
   while it invented findings. A count cannot see a parse error.
2. **There were TWO parsers for one file.**
   `correct-so-item-code-from-autocount.mjs` — the script that corrected the ten
   bedframes the same morning — had always parsed the sheet properly. The two
   readers of one file disagreed about 40 rows and nothing compared them.

**What the 111 actually were, measured** (company 1, same snapshot, cut
2026-09-08 08:03 UTC+8):

| | sales orders | purchase orders |
| --- | --- | --- |
| translation — the same product written another way | 46 | 0 |
| decomposition — one book line, several compartment rows | 3 | 1 |
| **genuinely a different product** | **52** | **9** |

The 4 decompositions are the second half of the same class of blindness:
`isSofaCode` is a `/SOFA/i` substring test, and AutoCount writes some sofas
without the word (`THL-7179`, `THL-2379`, `THL-7223`), so a legitimate
compartment row took the plain-code branch and read as a defect.

**Fix.**

- `backend/scripts/lib/ac-mapping-csv.mjs` — ONE RFC4180 reader for the sheet.
  Both callers use it; the second parser is deleted, not corrected.
- `backend/scripts/lib/item-code-class.mjs` — the three populations, stated once:
  `translation`, `decomposition`, `different`. The reconcile counts the first two
  as declared and reports only `different` as a finding, and prints the raw total
  alongside so the drop from 101 to 61 is never mistaken for work someone did.
- The checker's self-test now asserts the three QUOTED rows resolve to what
  production stores, rather than counting rows. A parser cannot pass it by
  loading the right number of wrong values.
- `backend/tests/itemCodeClass.test.mjs` — pins the parser, the alias fold
  (including that `5535` is its own model and must never be folded), and one
  case per population.

**Ref.** fix/so-po-item-code-audit, 2026-09-08.
