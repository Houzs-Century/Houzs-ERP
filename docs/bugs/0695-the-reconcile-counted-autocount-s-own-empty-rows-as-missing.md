## The reconcile counted AutoCount's own EMPTY ROWS as missing lines [medium]

<!-- area: AutoCount sync + write-back -->

**Symptom.** Nine of the nineteen sales orders and two of the four delivery
orders on the go-live reconcile's line-count list (run `34185154444`,
2026-09-08 11:55 Malaysia) were reported short of a line that does not exist.
`HC-SO-001473` is the clearest: the reconcile says `AutoCount 6 vs ERP 5`, and
the two documents agree on money to the sen.

**Root cause (traced).** AutoCount lets a salesperson leave a row on a document
with nothing in it. Read off the committed snapshot beside production, run
`34186980493`:

```
### SO-001473 -> HC-SO-001473  book 6 line(s) / RM 3700.00   ERP 5 row(s) / header RM 3700.00 / lines sum RM 3700.00
  BOOK seq=80 key=98858 "" code=N qty=0 unit=RM 0.00 sub=RM 0.00
      -> NO ERP ROW CLAIMS THIS KEY  [EMPTY BOOK ROW]
```

No item code, no quantity, no unit price, no amount. **The ERP cannot hold such
a row** — `scm.mfg_sales_order_items.item_code` needs a product and
`import-ac-outstanding-so.mjs` has none to point at — so carrying nothing for it
is the two systems agreeing. `check-ac-erp-reconcile.mjs` compared
`acLines.length !== erpLines.length` over every book row, so it counted one.

Eleven such rows sit on six sales orders — `SO-002294` (2), `SO-002354` (2),
`SO-000249` (2), `SO-000282` (1), `SO-000430` (2), `SO-001932` (2) — and the
same shape, an annotation row carrying no code and no money, is the whole
line-count difference on `HC-SO-000102`, `HC-SO-000814`, `HC-DO-000097` and
`HC-DO-002544`.

**What is NOT in this class, and it is the half that matters.** Two rows on this
same list look identical and are not:

| document | the row | why it stays a finding |
| --- | --- | --- |
| `HC-SO-011384` key 783795 | no item code, **quantity 4** | the book orders four of something it does not name |
| `HC-DO-001604` key 199273 | no item code, **RM 150.00** | "* DISPOSE 3S L SHAPE SOFA + CONSOLE TABLE" is money the customer is charged, and the ERP is short exactly that |

A rule that read only "no item code" would have declared both away — which is
the failure mode this repo names as *a verdict computed over nothing must never
read as a pass*.

**Fix.** `backend/scripts/lib/ac-blank-book-row.mjs`: a row is blank only when
AutoCount says it has **no item code AND no quantity AND no unit price AND no
amount**. The reconcile splits those out before it counts lines and before it
pairs, and prints them in their own DECLARED column with every row named — the
same treatment the sofa decomposition and the book's missing purchase prices
already get. Nothing is dropped silently.

Two self-tests guard it in BOTH directions at startup, against the snapshot's
own rows: `SO-001473` key 98858 must be declared and `SO-011384` key 783795 must
not, and a snapshot missing either row REFUSES the run rather than reporting
clean over a rule it could not exercise.

Pinned by `backend/tests/acBlankBookRow.test.mjs`. **Proved RED on a loosened
rule** — with the quantity clause removed, `1 failed | 10 passed (11)`:
`expected true to be false` on *HC-SO-011384 key 783795 — no item code,
QUANTITY 4*. Restored: `11 passed (11)`.

**Ref.** fix/so-do-money-reconcile, 2026-09-08.
