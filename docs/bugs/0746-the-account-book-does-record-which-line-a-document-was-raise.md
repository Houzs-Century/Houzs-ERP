## The account book DOES record which line a document was raised from, in DocTransfer, and every checker was reading the wrong table [high]

<!-- status: open -->

<!-- area: Cutover + migrated data -->

**白话.** 我们一直以为「账本只写这张单是从哪一张单转过来的，从来不写是从哪一行」。
**这句话是错的。** 账本有一张自己的表 `DocTransfer`，里面 134,501 笔，每一笔都写得
清清楚楚：哪一行转到哪一行，一行不漏。我们一直去看单据明细表里的那一栏，那一栏确实
是空的 —— 所以量到的是真的，结论是错的。因为这个，56 张单的上下游一直接不回去，只
能靠猜（用货品编号、用行的先后顺序），而猜过一次是错的。现在照账本一行一行接回去，
不用猜了。

**Symptom.** 56 documents were locked on the `transfer from` / `transfer to`
axes and had been for days — run
[34310423039](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34310423039):
7 sales orders, 5 purchase orders, 7 goods receipts, 5 delivery orders and 32
purchase invoices. Every brief written for that class carried the same governing
sentence: *"AutoCount records which DOCUMENT a line came from and NEVER which
line"*, and therefore the same instruction — derive the line from item code, and
where two candidates match, from the build text, and otherwise refuse.

**Root cause (traced).** The measurement was right and the table was wrong.

`FromDocDtlKey` on the six detail tables IS null on all ~220,000 rows.
`export-ac-convert-edges.mjs`'s header records that as fact 3 and exports the
column *"precisely so the checker can PROVE that rather than assume it: the day
the write-back starts populating it, line-level resolution becomes possible"*.
`lib/transfer-chain-verdict.mjs` states the same thing as fact 1 and builds
`agree_doc_line_unstated` on it — the verdict that says *the book states no
source LINE for this edge*. The reconcile excludes roughly 1,550 findings under
that heading.

AutoCount never kept the line graph there. It keeps it in its own table,
`DocTransfer`, with `FromDocDtlKey` **and** `ToDocDtlKey` on every row. Measured
on the live book (`AED_HOUZS`, over ZeroTier, read-only, 2026-09-09):

```
FromDocType|ToDocType|rows_|from_dtl_null|to_dtl_null
SO         |DO       |48740|            0|          0
DO         |IV       |44589|            0|          0
GR         |PI       |21481|            0|          0
PO         |GR       |18944|            0|          0
SO         |IV       |  169|            0|          0
...                  134501             0           0
```

Two further properties were measured, not assumed, and `export-ac-doc-transfer.mjs`
re-asserts all three at every export and REFUSES rather than writing a snapshot:
**every child line has exactly one source** (`max(sources) = 1` on every edge),
and **`DtlKey` is unique across all six detail tables** (the union has zero
duplicate keys).

The memory of `DocTransfer` existed — `ac-cutover-go-live` recorded *"DocTransfer
table also has the graph"* on 2026-08-09 — and it never reached the checkers,
which is the failure this repo names in its own words: a fact that lives only in
a note is read after the damage.

**Why guessing would have been wrong, with the counter-example.** On
`GR-004940` the book says the receipt line was raised from purchase line
**829688**. The only line on that purchase order carrying the same item code is
**829690**. An item-code rule — the rule the brief prescribed — writes the wrong
link and reports it as derived. Position pairing is worse and already cost this
repo `PO-009081` (`docs/bugs/0690`). On `GR-005334` the book pairs `917586 ->
897725` and `917588 -> 897723`, i.e. crossed against sequence order, so a
positional rule inverts it.

**Fix.**

- `backend/scripts/export-ac-doc-transfer.mjs` — pulls `DocTransfer` into
  `backend/scripts/data/ac-doc-transfer.json.gz` (134,501 edges, 0.78 MB),
  windowed on `TransferKey`, read-only, with the three shape assertions above.
- `backend/scripts/lib/transfer-link-plan.mjs` — the pure resolver. It reads the
  book's line, never a heuristic. The one remaining choice is our OWN
  decomposition (a sofa is one book line and one row per compartment here), and
  it is settled by compartment code INSIDE the single book line the book already
  chose, refusing when that does not separate.
- `backend/scripts/repair-transfer-chain-links.mjs` + its workflow — plan by
  default, CONFIRM plus a PLAN DIGEST on apply, fresh-connection shape check.
- `backend/scripts/diag-transfer-chain-56.mjs` + its workflow — read-only, prints
  both sides at line grain with the candidate parents, so a pairing claim can be
  checked by a person rather than believed.

**Proved RED on the unfixed tree.** `runSelfTest()` in `lib/transfer-link-plan.mjs`
passes 10 planted cases. Mutated so it never refuses and takes the first parent
when the item code does not separate, it fails exactly the two refusal cases —
*"two compartments of the SAME code under one book line"* and *"several rows and
NONE carries this row's code"* — both with `wanted ambiguous, got link`. The
exporter's cross-table key assertion was proved the same way: the same query
shape answers **62,773** over `SODTL UNION ALL SODTL` and **0** over the real
six.

**Measured effect of the repair, plan run against the read-only production DSN:**
51 links resolve from the book, closing **23** of the 56 documents on the
transfer-from axis — all 7 goods receipts, 4 of 5 delivery orders and 12 of 32
purchase invoices. The remainder is named in the plan output and is NOT book
ambiguity; see below.

**What is still open, and it is not this bug.**

| documents | why the book cannot be copied yet |
| --- | --- |
| 5 purchase orders + their 5 sales orders (`HC-PO-009467` `009554` `009587` `009679` `009830`) | the purchase order holds ONE `-1S` sofa placeholder row where the sales order holds compartments, so there is no line on our side for the book's line to attach to. `docs/bugs/0739`, unchanged by this entry |
| 19 purchase invoices, 1 delivery order | the book names a receipt/order line we hold NO row carrying that AutoCount line key — `scm.grn_items.linked_ac_dtlkey` is null on 229 receipt lines. `DocTransfer` FORCES 166 of those 229, so this is now mechanical rather than a judgement; it is left to the lane that owns `backfill-ac-downstream-line-keys.mjs` |

**One thing found while measuring that must not be lost.** Deriving a receipt's
AutoCount number from its `grn_number` looks safe and is not:
`HC-GR-005284-PO-009736` carries lines the book split across **GR-005284,
GR-005285, GR-005286 and GR-005294**. One ERP receipt can be several book
receipts, and `scm.grns.linked_ac_gr_docno` is one column — so that shortcut
would stamp a wrong number on a receipt that is really four. It was written,
measured, and abandoned before anything was applied.

**Ref.** fix/transfer-chain-56, 2026-09-09.
