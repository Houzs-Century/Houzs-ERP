## Twenty-two migrated goods receipts point at no purchase-order line [medium]

**Symptom.** Run [34263816266](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34263816266)
on `main`: `GOODS RECEIPTS 26 differ (22 PROCEEDED)`. All 22 proceeded documents
differ on **单据转换链** and on nothing else. The reconcile prints the cause per
line — `erp_link_missing`, 28 lines across 22 (receipt × order) pairs: *"the book
raised it from PO PO-009081 — the ERP points at nothing."*

**Root cause (traced).** `scm.grn_items.purchase_order_item_id` is NULL on those
28 rows. The chain axis reads that column as `has_link`
(`scripts/lib/ac-transfer-chain-run.mjs`, the GR arm of `chainEdges`), and
`fromVerdictFor` returns `erp_link_missing` before it looks at anything else
(`scripts/lib/transfer-chain-verdict.mjs`) — the book names a source document and
we hold no parent link at all.

The column could not be filled by copying the book's own value, and that is the
part worth recording. **`FromDocDtlKey` is NULL on all ~220,000 rows of all six
AutoCount detail tables** — re-measured on the 2026-09-07 chain cut while this
was written, and asserted by the repair script itself, which refuses to run if
the book ever starts stating a source line. AutoCount records which *document* a
receipt line came from and never which *line*. So the order line has to be read
out of the two documents.

**The trap on the way.** Reading it by position is wrong, and the book proves it.
`PO-009081` orders the same bed frame twice — same item code, same quantity,
same price — and two receipts each take one:

| order line | build text | receipt line | build text |
|---|---|---|---|
| POdtl 833538 | `Color: PC151-10 / Divan: 10"no leg / Gap:12"` | GRdtl 853738 (GR-004939) | `Color: PC151-12/ …` |
| POdtl 833540 | `Color: PC151-12/ Divan: 10"no leg / Gap:12"` | GRdtl 860498 (GR-004989) | `Color: PC151-10 / …` |

In document order the FIRST receipt line belongs to the SECOND order line. A
position pairing transposes them and credits one colour's delivery against the
other — the class of [0690](0690-674-line-photos-sit-where-the-owning-line-is-chosen-by-posit.md).

**Fix.** `scripts/lib/ac-gr-po-line-match.mjs` reads the line inside the one
purchase order the book names, by two rules only: the sole line of that item
code, or the one line of several whose build text (`<DTL>.Desc2`, compared on
content — whitespace collapsed, case folded) is the same. Everything else is
REFUSED and named, including the case where our own side splits one book order
line into several rows, because which sofa compartment was filled is a stock
question and stock is deferred (「库存先不看」).

`scripts/repair-gr-po-line-links.mjs` writes the one column, only where it IS
NULL, under a committed plan whose digest is re-checked at apply, and reads
`pg_trigger` on the live database first: nothing may fire on `scm.grn_items`, so
a pointer write cannot become a quantity move. The read-back is on a fresh
connection and asserts the shape — same item, same purchase order.

**Proved RED on the unfixed tree.** `tests/acGrPoLineMatch.test.mjs` was run
against a position-pairing implementation before the matcher existed:
`6 failed | 2 passed (8)`, the `PO-009081` transposition among the failures.
Against the matcher: `8 passed (8)`.

**Not the same bug, and it does not fix them.** The 47 purchase invoices that
differ on the same axis have two other causes on two other columns —
`scm.grns.linked_ac_gr_docno` being NULL (which surfaces the purchase order where
the book names a receipt, `doc_differs`, 59 lines) and
`scm.purchase_invoice_items.grn_item_id` being NULL (`erp_link_missing`, 58
lines). Neither reads `purchase_order_item_id`. Measured before and after in the
runs cited on the pull request.

**Ref.** fix/gr-po-links-2026-09-09, 2026-09-08.
