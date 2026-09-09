## A corrected sofa build never reached the ROW COUNT of the receipt, the delivery note or the invoice [high]

**Symptom.** The account book's `SO-000814` sofa is one line whose Desc2 reads
`[ (1 ELT / T + NA +2ER) (28") / COL: J9883-1-1 PAMA]`. The owner has ruled that
build three times now — `L(LHF) + 1NA + 2A(RHF)` — and the ERP holds it on the
order and on the purchase order raised from it. **Every document downstream of
those two still says the factory received, the driver delivered and the customer
was billed for a chaise on its own.**

Measured on production, probe
[run 34316985562](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34316985562):

| document | ERP rows for the book line | what it says |
|---|---|---|
| `HC-SO-000814` (dtl 58980) | 3 | `L(LHF)` + `1NA` + `2A(RHF)` |
| `HC-PO-000254` (dtl 59343) | 3 | `L(LHF)` + `2A(RHF)` + `1NA` |
| `HC-GR-000287` (dtl 84952) | **1** | `L(LHF)` |
| `HC-DO-000542` (dtl 71412) | **1** | `L(LHF)` |
| `HC-I-000745` (dtl 81589) | **1** | `L(LHF)` |

Nothing fails. Every row is priced, every link is filled, no constraint fires and
`probe-doc-link-matrix` reports the chain clean. It is `docs/bugs/0672`'s class
again — a link that is right about WHICH row and wrong about WHAT it is.

**Root cause, traced.** `apply-sofa-compartment-corrections.mjs` carries a
corrected build downstream, and the carry is four `UPDATE`s:

```
UPDATE scm.grn_items            SET item_code, variants WHERE purchase_order_item_id = <parent row>
UPDATE scm.delivery_order_items SET item_code, variants WHERE so_item_id            = <parent row>
UPDATE scm.purchase_invoice_items … WHERE grn_item_id = …
UPDATE scm.sales_invoice_items  … WHERE do_item_id  = …
```

An `UPDATE` can only move a row that exists. The correction's whole effect is to
turn ONE placeholder row into N compartment rows — the parent gains N-1 rows that
no downstream document has ever had — so the carry re-codes the lead and the
other pieces reach nothing. `docs/bugs/0687` fixed the same carry *stopping at the
invoice* and is the neighbouring half of this defect; it added the two invoice
`UPDATE`s and inherited their blindness to row count.

**Why it was invisible for a month.** The three documents are internally
consistent, the money is correct to the sen, and the reconcile compares the
compartment multiset per account-book line — so the only symptom is a cell reading
`sofa build not verifiable`, which the report also prints for the fifty documents
whose book text genuinely states no build. One number covering two populations,
which is this repo's own named defect class.

**Fix.** A corrections entry may now NAME the downstream documents beside the
order, and `applyDownstreamDoc` brings each of them to the build's own shape in
the same run — the pieces they have no row for are INSERTED, cloned from the row
that document already holds, zero in every money column. `scripts/lib/sofa-downstream-parity.mjs`
is the decision and is pure; the applier is the writer. Six guards, all refusals:

1. the document must be `migrated_no_stock` — a typed receipt is somebody's own
   statement about goods that moved;
2. no `inventory_movements` row may name it;
3. `pg_trigger` is re-read **on every run** and an unrecognised trigger STOPS the
   run. 「库存先不看」 is answered by measurement, not by the header flag. Read on
   prod in the same probe: `scm.grn_items`, `scm.sales_invoice_items` and
   `scm.purchase_invoice_items` carry **zero** non-internal triggers, and
   `scm.delivery_order_items` carries exactly one — `trg_do_line_integrity_lock`,
   `AFTER DELETE OR UPDATE OF delivery_order_id`, which an INSERT does not fire;
4. more rows than the build has pieces is REFUSED, never trimmed — nothing here
   deletes a receipt, delivery or invoice line;
5. every added piece is 0 in **every** `*_sen` column the table has, read from
   `information_schema` rather than a hand-written list, and the sums are asserted
   unchanged before and after;
6. the parent link is resolved to exactly one candidate or left NULL and said out
   loud — never guessed, which is `reshape-migrated-grns.mjs`'s ruling 「跟 autocount
   一样」.

The row is CLONED (column list read from `information_schema`), for the reason
`split-collapsed-sofa-lines.mjs` states: enumerating columns silently drops
whatever the script has not heard of, and these tables carry columns no migration
in this repository declares.

**Proved RED first.** `scripts/lib/sofa-downstream-parity.test.mjs` — 9 tests;
removing the over-count guard fails 2 of them, including the one that keeps two
identical sofas from being paired into one.
`tests/sofaDownstreamParityGuards.test.mjs` — 11 tests pinning the guards at the
write site; stubbing out the trigger re-read and the money-column zeroing fails 2.
Both restored and green.

**Ref.** `fix/sofa-elt-chain-downstream`, 2026-09-09.
