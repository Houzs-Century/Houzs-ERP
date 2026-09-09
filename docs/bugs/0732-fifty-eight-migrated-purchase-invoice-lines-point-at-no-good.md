## Fifty-eight migrated purchase-invoice lines point at no goods-receipt line [medium]

**Symptom.** Runs [34268495385](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34268495385)
and [34263816266](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34263816266)
on `main`: `PURCHASE INVOICES 53 differ` — the largest number left before
go-live.

**Measured, not inherited.** `docs/bugs/0730` closes by attributing 47 of those
invoices to two columns, from one run's printout. Dispatched run
[34272715185](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34272715185)
(`scripts/diag-pi-gr-links.mjs`, read-only) re-measured it against the live
database, classifying every line with the report's own `fromVerdictFor` rather
than a restatement of it:

```
  59  doc_differs        <- scm.grns.linked_ac_gr_docno IS NULL
  58  erp_link_missing   <- scm.purchase_invoice_items.grn_item_id IS NULL
 117  differing lines across 47 invoices
```

**Root cause of the 58 (traced).** `scm.purchase_invoice_items.grn_item_id` is
NULL. The chain axis reads that column as `has_link` (the PI arm of `chainEdges`,
`scripts/lib/ac-transfer-chain-run.mjs`) and `fromVerdictFor` returns
`erp_link_missing` before it looks at anything else
(`scripts/lib/transfer-chain-verdict.mjs`) — the book names a source document
and we hold no parent link at all.

The column could not be filled by copying the book's own value. **`FromDocDtlKey`
is NULL on all ~220,000 rows of all six AutoCount detail tables** — re-measured
every run by `ac-transfer-chain-run.mjs`, and asserted by the repair script
itself, which refuses to run if the book ever starts stating a source line.
AutoCount records which *document* a line came from and never which *line*.

**The repair is fully reachable, and that is measured too.** The same run:

```
  the book names exactly ONE source document: 58 · several: 0 · none: 0
  of the single-source lines, we HOLD that receipt: 58 · we do not: 0
```

So none of the 58 is blocked by the migration's outstanding-only scope. They sit
across 29 invoices.

**The trap on the way.** Reading the line by position is wrong, and this edge's
own rows prove it — not just the sibling edge's:

| invoice line | build text | receipt candidates | the one it bills |
|---|---|---|---|
| `PI-000654` dtl 41251 | `DIVAN: 8"+4" LEG / COL: SF-AT-8 / MATT GAP: 12"` | GR-000032 dtl 41242 (SF-AT-1), 41244 (SF-AT-8) | **41244**, the second |
| `PI-000632` dtl 41421 | `HC0202 DIVAN: 8"+4" LEG / COL:PC151-03 / MATT GAP: 12 INCHES` | GR-000017 dtl 41323, 41325, 41327, 52781 | **41325** — and 41327 is the same model and gap with only the colour different |

A position pairing bills one colour's receipt against another: the class of
[0690](0690-674-line-photos-sit-where-the-owning-line-is-chosen-by-posit.md),
and the same failure [0730](0730-twenty-two-migrated-goods-receipts-point-at-no-purchase-orde.md)
recorded on the goods-receipt edge.

**Fix.** `scripts/lib/ac-pi-gr-line-match.mjs` reads the line inside the one
goods receipt the book names, by two rules only: the sole line of that item
code, or the one line of several whose build text (`<DTL>.Desc2`, compared on
content — whitespace collapsed, case folded) is the same. Everything else is
REFUSED and named, including a line the book raised straight off a PURCHASE
ORDER, which `grn_item_id` structurally cannot point at, and a receipt the
migration never carried. Both of those are the cutover's shape, not doubt.

`scripts/repair-pi-gr-links.mjs` writes the one column, only where it IS NULL,
under a committed plan whose digest is re-checked at apply. It reads
`pg_trigger` on the live database first: nothing may fire on
`scm.purchase_invoice_items` **or** on `scm.grn_items` — the second because
`grn_items.invoiced_qty` is the counter this edge reads, and a pointer write
reaching it through a trigger would be a quantity move in disguise
(「库存先不看」). The read-back is on a fresh connection and asserts the shape:
same item code, a receipt of the same company.

**Proved RED on the unfixed idea.** `tests/acPiGrLineMatch.test.mjs` carries a
`POSITION_MATCHER` — the naive implementation — and asserts it gets both of the
book's transpositions WRONG (41242 instead of 41244; 41323 instead of 41325)
while the real matcher gets them right. The proof that position pairing fails
lives in the suite rather than in a commit message somebody has to trust.
12 tests, all passing.

**A defect in the diagnostic itself, found by running it.** Section 3 keyed its
receipt lookup on `erp_no`, which on this edge is the INVOICE number
(`h.invoice_number`) — so it asked `scm.grns` for `HC-PI-007927`, matched
nothing, and printed `NO-ROW` for all 20 cause-B lines. It reported `?` rather
than a clean answer, which is the one thing it got right. It now walks the line
to its receipt through `grn_item_id`, and counts separately the lines whose book
side names SEVERAL receipts, because one stamp cannot answer those.

**Not fixed here.** The 59 `doc_differs` lines. `linked_ac_gr_docno IS NOT NULL`
is the filter deciding which receipts are IN the goods-receipt comparison
(`lib/ac-reconcile-erp-sql.mjs`) and in `ONWARD_COVERAGE.GR`, so stamping it
ADDS documents to a population — and it is only safe where the receipt IS the
book's receipt rather than one raised in the ERP while the shop traded through
cutover. The fixed section 3 settles that per document before anything is
written.

**MEASURED OUTCOME — applied to production and verified.**

Applied to production. `MODE=plan` [34274440126](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34274440126),
`MODE=apply` [34275605452](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34275605452),
one link taken back in [34277058873](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34277058873)
(see `docs/bugs/0733-*`), verified by
[34277483785](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34277483785).

**The headline, from the same report the defect was raised against**
(`po-gr-tally-verdict.yml`, before = run 34268495385):

| document type | before | after |
| --- | --- | --- |
| Sales orders | 16 differ · 30 cannot compare | 16 · 30 |
| Purchase orders | 13 · 13 | 13 · 13 |
| Goods receipts | 11 · 6 | 11 · 6 |
| Delivery orders | 13 · 5 | 13 · 5 |
| Sales invoices | 16 · 2 | 16 · 2 |
| **Purchase invoices** | **53** · 1 | **48** · 1 |

**Five purchase invoices fully tallied. Every other type is unchanged to the
document** — the control this repair was required to hold.

**On the axis itself** (`ac-erp-reconcile.yml` run 34277179894, the PI arm of
单据转换链):

| verdict | before | after |
| --- | --- | --- |
| `agree_doc_line_unstated` | 0 | **25** |
| `erp_link_missing` | 58 | **33** |
| `doc_differs` | 59 | 59 |
| differing lines | 117 | **92** |
| differing invoices | 47 | **32** |

**Why the axis moved 15 invoices and the headline only 5.** The tally counts a
document as differing if it differs on ANY axis. Fifteen invoices stopped
differing on the transfer chain; ten of them still differ on something else, so
five is what reached the headline. Both numbers are true and they are not the
same number.

**The prediction, and how close it came.** Recorded on the pull request before
the apply: 117 -> 91 lines and 47 -> 31 invoices. Measured: 92 and 32. The
difference is exactly the one link that was written and then taken back — the
prediction assumed all 26 would stand, and 25 did. An earlier prediction on the
same work, made from the matcher's yield alone, said the axis would fall to 59
lines; that was wrong by a wide margin because it ignored the ERP's sofa
decomposition, and the plan run refuted it within minutes.

**What is left on this axis, and it is not this defect.** 33 lines still carry
no link — every one of them a book receipt line the ERP splits into several
compartment rows, where which compartment an invoice billed cannot be read from
either document. 59 lines are the other cause entirely
(`scm.grns.linked_ac_gr_docno` IS NULL), untouched here by design.

**Ref.** fix/pi-grn-links, 2026-09-09; outcome measured 2026-09-09.
