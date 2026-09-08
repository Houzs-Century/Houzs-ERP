## The owner ruled that a row the book describes nothing in is not a line, and that our extra line be deleted [high]

<!-- area: AutoCount sync + write-back -->
<!-- status: fixed -->

**This entry records a DECISION, not only a defect.** It is the one place a
future session will find out that a hard `DELETE` on a live sales-order line was
the owner's, that he was told the standing convention first, and exactly how far
the ruling reaches. Read it before widening anything here.

### The ruling, verbatim — 2026-09-08 (Malaysia, UTC+8)

He was shown the last three sales-order differences on the go-live reconcile, and
told that two of them needed HIS decision **because this repo's standing
convention is never delete, only cancel** (CLAUDE.md working agreement; the
sales-order module guide's *Deleting an SO* section; the refusal written into
`topup-ac-lines-from-truth.mjs`: *"an ERP row the book does NOT have is REPORTED
and never deleted"*). Knowing that, he answered:

> 「删掉啊 没写的也删掉
> 简单来说都要跟Autocount一样啊 你不懂吗？」
>
> "Delete it. The one that says nothing, delete that too. Put simply,
> everything has to be the same as AutoCount. Don't you understand?"

**That is an explicit, informed override of the convention** — for these rows and
the class they belong to. It is **not** a general licence: "deleting is fine now"
is not what he said and not what this entry authorises. It sits beside his other
standing ruling of the same day, 「一律跟账本。除了sofa compartment而已啊」
(follow the account book for everything; only a sofa compartment needs his
judgement).

The same ruling is recorded in `docs/modules/sales-order.md` under **"The owner's
delete ruling (2026-09-08)"**, because a future reader who finds the `DELETE`
will look at the module guide before the bug ledger.

### Symptom

Three sales orders were the whole of the sales-order column on the go-live
reconcile. Run [`34212888329`](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34212888329)
(2026-09-08 17:58 +08) — the last measurement before this work:

```
   line count (first 2 of 2):
      SO-011384: AutoCount 12 vs ERP 11 (ERP HC-SO-011384)
      SO-013160: AutoCount 3 vs ERP 4 (ERP HC-SO-013160)
   document total (first 2 of 2):
      SO-012571: AutoCount RM 3450.00 vs ERP RM 3538.00 (ERP HC-SO-012571)
      SO-013160: AutoCount RM 300.00 vs ERP RM 600.00 (ERP HC-SO-013160)
   orphan DtlKey (first 1 of 1):
      SO-013160: ERP line 222041a0-b27b-4f59-b668-155b2af1a780 claims DtlKey 892917, not a line of this document
```

The whole reconcile read **21**. The sales-order type contributed **4** of them
(line count 2, document total 2) — and those 4 are these three documents.

### Root cause (traced), one per document

**1. `SO-013160` — we hold a line the book does not.** The ERP has a 4th row,
`STORAGE` RM 300.00, claiming AutoCount DtlKey **892917**. That key is on **no
line of any document of any of the six types** in the committed snapshot
(`ac-reconcile-truth.json.gz`, cut 2026-09-08 00:03Z). Proved by building the set
of every `dtlKey` the snapshot holds across SO, PO, GR, DO, IV and PI —
**220,733 distinct keys, one per line row, with no collision between the six detail tables** — and asking whether 892917 is in it. It is not. The
book's own three lines (892914, 892915, 892916) total RM 300.00; ours total
RM 600.00. The line was deleted in AutoCount after we imported it.

**2. `SO-011384` — the BOOK holds a line that names nothing.** Its `dtlKey`
783795 reads, in the snapshot's own columns:

```
docNo SO-011384  dtlKey 783795  seq 192  itemKey ""  hasCode 0
qty 4.0000  unitPrice 0.0000  subTotal 0.00  docSubTotal 0.00  Desc2 (none)
```

`itemKey` is the exporter's ItemCode **or the Description when ItemCode is
blank** (`export-ac-reconcile-truth.mjs:239`), so an empty `itemKey` on a
code-less row proves the book states **neither a code nor a description**. No
Desc2 either, and no money in either currency column. The only thing on the row
is a quantity of 4.

`lib/ac-blank-book-row.mjs` already declared AutoCount's own empty rows as
agreement — *"AutoCount lets a salesperson leave a row empty; the ERP cannot hold
one, so the two sides AGREE about them"* — but excluded this one **by design**,
on the reasoning that "the book is ordering four of something it does not name;
that is a real gap and it stays a finding". The owner's 「没写的也删掉」 overrules
that reasoning: a row the book describes nothing in is nothing, whatever number
sits in the quantity column.

**3. `SO-012571` — the money must match the book.** The book states
`DSL-8050 SOFA` RM 3,300.00 on ONE line plus `DISPOSE` RM 150.00 = RM 3,450.00.
The ERP holds the sofa as one row per compartment, the money rides one of them at
RM 3,388.00, and the document reads RM 3,538.00 — RM 88.00 over.
`repair-so-price-from-autocount.mjs` **skips every decomposed sofa by design**
(dry run `34188098187`: `SKIPPED, one book line decomposed into several ERP
lines`), because which compartment carries the money is a decision, not a copy.
His 「都要跟Autocount一样」 settles the part that matters — the document total
must equal the book — and leaves the split alone, because the book states nothing
about it.

### Fix

**Half 1 — the checker, for `SO-011384`. This is a CHECKER change, not a data
change, and the distinction is the point.** Nothing is written to that document;
the reconcile stops calling a row that says nothing a missing line.

`backend/scripts/lib/ac-blank-book-row.mjs` grew a **second arm**, deliberately
narrow, and the module header states every clause and why it earns its place:

| | arm 1 (unchanged) | arm 2 (the ruling) |
|---|---|---|
| item code | none | none |
| description | anything | **none** (`itemKey` blank) |
| Desc2 | anything | **none** |
| quantity | **zero** | anything |
| money (unit price, line subtotal, document-currency subtotal) | **zero** | **zero** |

**MONEY IS THE BOUNDARY THE RULING DID NOT MOVE.** A row carrying money is money
the customer is charged and it stays a finding whatever else is blank —
`HC-SO-000102`'s `"DELIVERY FEE "` (RM 50.00) and `HC-DO-001604`'s
`"* DISPOSE 3S L SHAPE SOFA + CONSOLE TABLE"` (RM 150.00) are both code-less and
both stay.

Two mechanical guards came with it, because a declaration that swallows too much
reads as a clean run:

- the Desc2 argument is **required**, on both exported functions, and they throw
  without it. Arm 2 turns on the row saying nothing at all, so a caller that
  simply did not look up the build text must not be able to produce the same
  answer as one that looked and found none. `check-keyless-lines.mjs` — the other
  consumer, and the script that once answered 25 against the reconcile's 26 for
  the same population — now passes `B.desc2` for that reason.
- `check-ac-erp-reconcile.mjs`'s in-run self-test carries **three** real rows of
  the snapshot instead of two: `SO-001473`/98858 (arm 1, declared),
  `SO-011384`/783795 (arm 2, declared — the case is kept and FLIPPED rather than
  deleted, so the change is visible at the line that used to assert the opposite)
  and `SO-000102`/15971 (**must stay a finding** — the money boundary). If the
  exporter ever stops carrying one, the run refuses rather than reporting clean.

The reconcile now prints, per row, which arm declared it and how many rows arm 2
swept up, and the declaration sentence names the ruling. A declaration the reader
cannot enumerate is a suppression.

**WHAT ARM 2 SWEEPS UP, MEASURED over the whole 2026-09-08 00:03Z cut — every
header and every line of all six types, not just the reconcile's population:
EIGHT rows on eight documents.** The owner is entitled to know what his ruling
caught, so every one is named:

| type | document | DtlKey | seq | qty |
|---|---|---|---|---|
| SO | `SO-000260` | 31317 | 64 | 1 |
| SO | `SO-001299` | 88178 | 112 | 1 |
| SO | `SO-001606` | 111672 | 64 | 1 |
| SO | `SO-011384` | 783795 | 192 | **4** |
| DO | `DO-000806` | 104943 | 112 | 1 |
| DO | `DO-001168` | 147295 | 64 | 1 |
| IV | `I-000976` | 110528 | 112 | 1 |
| IV | `I-001363` | 179226 | 64 | 1 |

PO, GR and PI have none. Only `SO-011384` was on the reconcile's offender list;
the other seven sit on documents the reconcile either already agrees about or
does not pair, so absorbing them changes no count. That is the honest reading of
"the ruling swept up eight rows": one of them was work, seven were already quiet.

**Proved RED on the unfixed tree before the change.** Both arm-2 cases were run
against `origin/main`'s copy of the rule and answered `false` where the ruling
requires `true`:

```
RED   HC-SO-011384 key 783795 — no code, no description, no Desc2, no money, QUANTITY 4
        old rule answers false, the ruling requires true
RED   HC-DO-000806 key 104943 — the same shape on a delivery order, quantity 1
        old rule answers false, the ruling requires true

2 of 2 owner-ruling case(s) FAIL on origin/main's rule, as they must before the change.
```

`backend/tests/acBlankBookRow.test.mjs` — 19 cases, each a real row of the book:
both arms, the money boundary from both sides, a described row with a quantity, a
build-text row with a quantity, and the two throws.

**Half 2 — the data, for `SO-013160` and `SO-012571`.**
`backend/scripts/repair-so-book-parity-owner-ruling.mjs` +
`.github/workflows/repair-so-book-parity-owner-ruling.yml`. Plan by default;
apply armed by `CONFIRM="I HAVE REVIEWED THE OWNER DELETE RULING PLAN"`, passed
through by the workflow's own `confirm` input — the thing `docs/bugs/0700` was
written about — narrowable by `ONLY_DOCS`, and capped at 2 line writes.

There is no general rule in it on purpose: each target is a literal and every
fact it rests on is asserted against the book and the live ERP before anything is
written. **A delete cannot be undone by reverting a commit**, so the delete lane
also:

- proves the key is on no line of any type, from the snapshot, at run time;
- requires exactly ONE ERP row to carry it, and every OTHER row of the document
  to carry a key the book DOES have — so removing this one leaves the document
  equal to the book;
- sweeps **every foreign key that references `scm.mfg_sales_order_items`**, taken
  from `pg_constraint` at run time rather than from a list typed in the script,
  and refuses if a single row points at the line. This is the guard that matters:
  the three FKs the module guide names — `purchase_order_items.so_item_id`,
  `delivery_order_items.so_item_id`, `sales_invoice_items.so_item_id` — are all
  `ON DELETE SET NULL`, so a delete would **silently unlink a real purchase
  order, delivery note or invoice and leave no trace**;
- reads the row with `SELECT *` and prints **every column** into the run log as
  JSON before deleting it, and refuses if that read comes back empty.

**RECOVERY, if the ruling is ever reversed.** The captured row is in the plan
run's log, in the apply run's log, and copied into this entry once the apply has
run. Putting it back is one `INSERT` into `scm.mfg_sales_order_items` with those
column values (a fresh `id` is fine — that nothing referenced the old one is a
precondition of the delete), then the same header re-sum `applyHeader` performs.
Nothing else in the database has to change.

The sofa lane does **not** loosen `repair-so-price-from-autocount.mjs`'s
decomposed-sofa guard, which is right for the general case. It makes the smallest
decision available: the money already rides exactly one compartment, and it stays
on that same one at the book's number. Its siblings sit at RM 0.00 and are not
touched.

Neither lane touches `paid_sen` or the header `balance_sen`, and neither can
reach AutoCount: `scm.autocount_outbox` is written by application code only,
there is no trigger on `scm.mfg_sales_order_items`, and the run counts that
table's rows for both documents before and after rather than asserting it.
Owner, same day: 「写回autocount的你不需要理了」.

### Applied to production — 2026-09-08, and what it moved

| run | at (Malaysia) | what |
| --- | --- | --- |
| [`34216158876`](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34216158876) | 18:34 | **PLAN.** 1 line to delete, 1 sofa compartment to re-price, **0 refused**. Nothing written. |
| [`34216261677`](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34216261677) | 18:36 | reconcile BEFORE — **20** |
| [`34216413503`](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34216413503) | 18:37 | **APPLY.** `APPLIED — 1 line(s) deleted, 1 sofa compartment(s) repriced, 2 header(s) re-summed.` |
| [`34216507949`](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34216507949) | 18:40 | reconcile AFTER — **17** |

Verified on a fresh connection inside the apply run, zero `WRONG SHAPE`:

```
VERIFIED ON A FRESH CONNECTION — 2 of 2 target(s) read back with the SHAPE the ruling
requires: the deleted line is claimed by nothing and named by no downstream row; the
repriced compartment carries the book's unit price and the ERP's own line invariant with
its siblings still at RM 0.00; and each header equals both the sum of its lines and the book.
   HC-SO-013160  3 line(s), total RM 300.00 (book RM 300.00 = same)
   HC-SO-012571  3 line(s), total RM 3450.00 (book RM 3450.00 = same)
AutoCount outbox rows naming these documents, AFTER: 0 (before 0) — unchanged
```

**What moved on the reconcile.** The sales-order type's four data axes all went
to zero: `SO DATA … line-count differs: 0; item code: 0; quantity: 0; unit price:
0; document total: 0`, and `DtlKey on the wrong document` went 1 -> 0. The SO
per-document verdict went **2731 -> 2733 would OPEN, 151 -> 149 LOCKED**.

| axis | 18:36 | 18:40 |
| --- | --- | --- |
| SO line count | 1 (`SO-013160`) | **0** |
| SO document total | 2 (`SO-012571`, `SO-013160`) | **0** |
| SO orphan DtlKey (reported, never counted in the headline) | 1 | **0** |
| whole reconcile | **20** | **17** |

**CONTROL — PO, GR, DO, IV and PI did not move**, cell for cell across the two
runs: PO `0 / 0 / 0 / 0 / 0` with decided 1, no-price 241, non-MYR 1; GR money 9
with 100 ERP-RM0 and 2 same-goods; DO phantom 2; IV 4 absent, 4 same-goods, 9
same-money, 1 no-key-open; PI 1 line-count, 11 same-money, 6 no-key-open. SO's
own `phantom 1` is also identical — it is `HC-SO-2609-001`, a document the ERP
claims and the book does not have, and it is **not** this lane's.

**Stock did not move at all.**

| check | before ([`34216287587`](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34216287587)) | after ([`34216512525`](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34216512525)) |
| --- | --- | --- |
| `check-stock-vs-autocount` | `cells compared: 996 \| AGREE: 933 \| DISAGREE: 29 \| AutoCount-only: 0 \| ERP-only: 3` | identical |
| sofa cells | `41 \| AGREE: 19 \| DISAGREE: 22` | identical |
| whole sofas | `AutoCount 107 vs ERP 104 (net -3)` | identical |
| `check-migrated-cancel-exposure` ([`34216290534`](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34216290534) / [`34216515488`](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34216515488)) | `0 movement rows behind 646 migrated documents` | identical |

**Readiness moved by exactly one line, and it is the line that no longer
exists.** Go-live readiness
[`34216294639`](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34216294639)
against
[`34216518695`](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34216518695):

| | before | after |
| --- | --- | --- |
| live orders / with a processing date / header READY_TO_SHIP | 2782 / 572 / 208 | 2782 / 572 / 208 |
| lines on PROCESSED orders | `READY=1673, PENDING=1371, PARTIAL=10` | `READY=1673, PENDING=1370, PARTIAL=10` |
| PROCESSED lines whose PO is received but the line is not READY | 36 | 36 |

**−1 PENDING, and nothing else.** The deleted row carried `stock_status: PENDING`
(it is in the capture below), so removing it removes its own readiness row. No
line gained or lost a status, and `recompute-so-allocation.mjs` is NOT required:
no quantity moved, so sales-order demand is unchanged apart from the row that is
gone.

### THE DELETED ROW, EVERY COLUMN — the recovery path

Captured by the apply run itself, before the `DELETE`. To reverse the ruling,
`INSERT` one row into `scm.mfg_sales_order_items` with exactly these values (a
fresh `id` is fine — that nothing referenced the old one is a precondition of the
delete, and the run measured it: **0 downstream rows across all 5 referencing
foreign keys**), then re-sum the header the way `applyHeader` does. Nothing else
in the database has to change.

```json
{"id":"222041a0-b27b-4f59-b668-155b2af1a780","doc_no":"HC-SO-013160","line_date":"2026-08-28T00:00:00.000Z","debtor_code":null,"debtor_name":null,"agent":null,"item_group":"service","item_code":"STORAGE","description":"STORAGE CHARGES","description2":null,"uom":"UNIT","location":"KL","warehouse_id":"e309c399-697c-4174-967f-ae2c888ad999","qty":1,"unit_price_sen":30000,"discount_sen":0,"total_sen":30000,"tax_sen":0,"total_inc_sen":0,"balance_sen":30000,"payment_status":"Unchecked","venue":null,"branding":null,"remark":null,"cancelled":false,"variants":null,"unit_cost_sen":0,"line_cost_sen":0,"line_margin_sen":0,"gap_inches":null,"divan_height_inches":null,"divan_price_sen":0,"leg_height_inches":null,"leg_price_sen":0,"custom_specials":null,"line_suffix":null,"special_order_price_sen":0,"po_qty_picked":0,"line_delivery_date":"2026-09-10T00:00:00.000Z","line_delivery_date_overridden":false,"photo_urls":[],"stock_status":"PENDING","line_no":4,"created_at":"2026-08-28T08:11:26.205Z","stock_qty_ready":0,"allocated_batch_no":null,"company_id":"1","linked_ac_dtlkey":"892917"}
```

The five referencing foreign keys the run found in `pg_constraint`, which is two
more than the module guide's list — the reason the sweep is taken from the
catalogue at run time rather than typed into the script:

```
scm.delivery_order_items.so_item_id             ON DELETE SET NULL
scm.mfg_so_price_overrides.item_id              ON DELETE CASCADE
scm.purchase_order_item_allocations.so_item_id  ON DELETE SET NULL
scm.purchase_order_items.so_item_id             ON DELETE SET NULL
scm.sales_invoice_items.so_item_id              ON DELETE SET NULL
```

### TWO DOCUMENTS NOW OWE A DIFFERENT AMOUNT THAN THEY ARE RECORDED AS PAYING — the owner's call

`paid_sen` and the header `balance_sen` were NOT touched, so both documents' own
totals moved away from `paid + balance`. This is REPORTED, never re-derived:

| document | total now (= the book) | paid + balance | reads as |
| --- | --- | --- | --- |
| `HC-SO-013160` | RM 300.00 | RM 600.00 + RM 0.00 = RM 600.00 | **RM 300.00 overpaid** |
| `HC-SO-012571` | RM 3,450.00 | RM 990.00 + RM 2,548.00 = RM 3,538.00 | **RM 88.00 too much still shown as owing** |

It is the same open question already standing on `HC-SO-000021`
(`docs/cutover-so-do-remainder-2026-09-08.md`): whether a migrated document's
payment columns are re-derived from a corrected total is a business decision,
and a payment column is not an arithmetic consequence.

**Ref.** `fix/owner-delete-ruling` (#3249) + `fix/owner-delete-ruling-evidence`, 2026-09-08.
