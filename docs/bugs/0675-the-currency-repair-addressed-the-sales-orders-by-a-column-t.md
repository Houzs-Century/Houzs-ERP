## The currency repair addressed the sales orders by a column that table does not have [medium]

<!-- area: AutoCount sync + write-back -->

**Symptom.** The first production run of `repair-migrated-currency.mjs`
(run 34140077540, 2026-09-07 23:47+08, `MODE=plan`) got the purchase orders
exactly right and then died:

```
scm.currency_code labels: CNY, MYR, RMB, SGD, USD
purchase orders: 574 migrated; 573 already agree with the book; 0 have no row in the header cut; 1 to change
PostgresError: column "id" does not exist
```

Nothing was written — it was a plan run — but the job exited 1, which reads as
"the check broke" rather than "the sales-order half never ran".

**Root cause (traced, not guessed).** The script walked both document types
through one `ARMS` table and addressed every row by `id`:

```js
`SELECT id::text AS id, ${arm.docCol} AS doc, ... FROM ${arm.table}`
```

`scm.purchase_orders` is keyed by a uuid `id`. **`scm.mfg_sales_orders` has no
`id` column at all** — its key is `doc_no`, and every writer in the tree already
says so: `import-ac-outstanding-so.mjs` ends `ON CONFLICT (doc_no) DO NOTHING`,
and `mfg_sales_order_items` joins `h.doc_no = i.doc_no`. One assumption applied
to two tables that never shared it.

**The failure shape is the expensive part.** The run had already done real work
and printed a real, correct number — 573 of 574 agreeing — before the wrong
assumption was reached. That reads like a working script that hit a blip, not
like a script that believed something false.

**Fix.**

- `backend/scripts/lib/migrated-currency-arms.mjs` — the arm table moved out of
  the script and each arm now carries its own `pk` (`id` for purchase orders,
  `doc_no` for sales orders). Every SELECT, UPDATE and verification re-read uses
  `${arm.pk}::text`, so a uuid arm and a doc-no arm need no separate cast.
- **The script now checks every column it is about to name, against
  `information_schema`, before it builds a statement**, and REFUSES by name:
  `REFUSING: scm.mfg_sales_orders has no column(s) doc_no — this script would
  have named them.` A wrong belief about a column should be a named refusal, not
  a Postgres error halfway through a run.

**Proved.** `backend/tests/migratedCurrencyArms.test.mjs` — 10 assertions, no
database. Planted RED by restoring the original defect (`pk: "id"` on the
sales-order arm): 3 failed — *"the sales-order arm is keyed by doc_no, never by
id"*, *"the two arms do not share a key"*, *"an empty column set names every
column the run would have used"*. Green with it restored. It also refuses the
literal statement that failed (`WHERE id =`) coming back by any route.

**Ref.** fix/currency-repair-so-key, 2026-09-07. Follows
`docs/bugs/0674-a-migrated-purchase-order-was-labelled-ringgit-because-the-i.md`,
which shipped the script.
