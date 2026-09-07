## The ERP's paid figure was never observed, so a corrected total unbalanced it [high]

<!-- area: Cutover + migrated data -->

**Symptom.** `repair-so-price-from-autocount` applied the book's unit price to 13
migrated sales-order lines (run **34137116270**, 2026-09-07 23:13 local) and
re-summed the 12 headers it touched. Its own read-back then reported three of
them as no longer balancing:

```
HC-SO-002309  total RM 6049.00   paid RM 1770.00 + balance RM 4579.00 = RM 6349.00  <-- does not equal the total
HC-SO-010916  total RM 8905.00   paid RM 1859.00 + balance RM 4229.00 = RM 6088.00  <-- does not equal the total
HC-SO-013336  total RM 1386.00   paid RM    0.00 + balance RM 1071.00 = RM 1071.00  <-- does not equal the total
HC-SO-004188  total RM 7988.00   paid RM 7988.00 + balance RM    0.00 = total
```

Read at face value that says a price repair broke three customers' payment
records. It did not write either column.

**Root cause (traced).** `mfg_sales_orders.paid_sen` **was never observed.** The
cutover computed it, at `backend/scripts/import-ac-outstanding-so.mjs:328`:

```js
const bal = centi(h.UDF_BALANCE); const paid = Math.max(0, total - bal);
```

So exactly one of the two columns is a copied fact. `balance_sen` is
AutoCount's own `UDF_BALANCE` — what the book says is still owed — and
`paid_sen` is `total - balance`, evaluated against **the ERP's line total at
import time**. The single row the importer writes into
`scm.mfg_sales_order_payments` (`:470`) carries that same derived amount, so the
payments table inherits the derivation rather than correcting it.

That makes `paid + balance = total` an IDENTITY the importer creates, not a
reconciliation anything checks. It holds for as long as the line total does not
move, and the moment a line price is repaired the identity breaks — while
saying nothing whatever about the customer. `paid_sen` did not become wrong on
2026-09-07; it was already a function of a total that had since moved. **The
repair exposed the derivation, it did not cause it.**

Measured per order against the two committed snapshots (`ac-doc-headers.json.gz`
cut 2026-09-07 17:36 local carries `UDF_BALANCE`; `ac-reconcile-truth.json.gz`
cut 22:12 local carries the line prices and the currency — all four documents
are MYR):

| ERP order | book worth | book `UDF_BALANCE` | book implies paid | ERP paid | ERP balance | what actually moved |
|---|---|---|---|---|---|---|
| `HC-SO-002309` | 6,049.00 | 0 | 6,049.00 | 1,770.00 | 4,579.00 | STORAGE x3 was 150.00, book says 50.00 (-300.00). Separately the book was edited to fully paid on 2026-09-04, after the import |
| `HC-SO-010916` | 6,088.00 | 4,229.00 | 1,859.00 | 1,859.00 | 4,229.00 | line 1 3,380.00 -> 6,088.00 (+2,708.00); line 2 still holds an orphan 2,817.00 the book does not state |
| `HC-SO-013336` | 1,386.00 | 1,386.00 | 0.00 | 0.00 | 1,071.00 | line 1 683.00 -> 998.00 (+315.00). The book's balance was edited to 1,386.00 after the import; the ERP still holds 1,071.00 |
| `HC-SO-004188` | 7,988.00 | 0 | 7,988.00 | 7,988.00 | 0.00 | line 1 was 2 x 3,344.00, now 1 x 7,988.00 — restored by this same run |

Two of the three are the price correction landing on a stale derived figure. The
third, `HC-SO-002309`, is a bigger and separate fact: **the book says that order
is paid in full and the ERP still shows RM 4,279.00 outstanding**, because the
customer settled it in AutoCount on 2026-09-04, after the 2026-08-28 import, and
no payment ever flowed back into the ERP.

**`HC-SO-004188` is not a fourth case — it is the same case at two times.**
`docs/bugs/0672` records it over-collected by RM 4,644.00 after the quantity
repair (run 34134351163, 22:41 local) left it at 1 x RM 3,344.00. Run
34137116270 at 23:13 local wrote `287817` from RM 3,344.00 to the book's
RM 7,988.00 and its fresh-connection read-back reported the order balancing. The
two reports do not contradict; the first was true for 32 minutes. **The
unresolved question of that entry is now answered from the book itself:
`SODTL` DtlKey 287817 is `Qty 1.0000, UnitPrice 7988.0000, SubTotal 7988.00` —
the book says quantity ONE.**

**Fix.** Two tools, and deliberately no automatic correction of either column.

- `backend/scripts/probe-so-payment-reconcile.mjs` +
  `.github/workflows/probe-so-payment-reconcile.yml` — READ-ONLY. Per order it
  prints the book's worth, the book's `UDF_BALANCE`, the paid that implies, the
  ERP's stored pair, every row in `scm.mfg_sales_order_payments` with its date,
  the list view's live balance, the direction of the difference, and a
  line-by-line comparison against the book by DtlKey. It states both snapshot
  vintages and the gap between them before any finding (`docs/bugs/0672`), and
  refuses to subtract amounts on a non-MYR document (`docs/bugs/0665`, `0666`).
- `backend/scripts/clear-orphan-price-so-010916.mjs` +
  `.github/workflows/clear-orphan-price-so-010916.yml` — the owner's ruling on
  ONE line, 2026-09-07: 「跟账本，清成空白」. `HC-SO-010916` line 2, DtlKey
  758652, RM 2,817.00 the book does not state. Four guards, each of which
  refuses rather than adapts: the book must state 0.00 for that key; the
  document must be MYR; the key must map to exactly one ERP row
  (`linked_ac_dtlkey` is not unique — `docs/bugs/0673`); and the row must still
  hold exactly RM 2,817.00. Plan by default, `CONFIRM` phrase to write,
  fresh-connection shape re-read afterwards.

**Nothing writes `paid_sen` or the header's `balance_sen`.** What a customer
paid is not an arithmetic consequence of a corrected total, and the four rows
above need four different decisions — a book edit the ERP never saw, a stale
derivation, a stale balance, and one already correct. The clearing script
asserts after its write that neither column moved.

**The exception is one line, and the rule stands.** A blank never overwriting a
value is the owner's standing default; he overrode it for `HC-SO-010916` line 2
only. The clearing script's scope is three constants in its own source and no
input widens it; the probe's census LISTS every other line of that shape rather
than offering it as a candidate.

**Lesson.** A derived column that is written once and then never re-derived
looks exactly like an observed one, and the identity it satisfies at write time
reads as a reconciliation. **Where a migration computes a figure instead of
copying one, the fact that it was computed has to travel with it** — otherwise
the first correction downstream is read as the thing that broke it. The
migration's own rule (`docs/bugs` and the memory note *migration copies, never
computes*) says a migration reads AutoCount's own value and never infers one;
`paid_sen` is where that rule was not followed, and the cost was not a wrong
number but three hours of reading a corrected total as a payment defect.

**Ref.** fix/money-so-010916-payment-recon, PR pending, 2026-09-07.
