## An AGGREGATED GrQty was read as a per-line received quantity, inflating received_qty on migrated PO lines [high]

**Symptom** — 65 migrated `scm.purchase_order_items` rows in production carry
`received_qty > qty`: a line ordered 1 and received 2. That is a permanent
NEGATIVE outstanding, and no report surfaces it — the over-receipt detectors all
work off GRN lines, and these rows have no GRN behind them at all.

**Root cause (traced, not guessed)** — the two AutoCount PO exports do not carry
the same thing, and the code treated them as synonyms.
`ac-outstanding-po.json.gz` carries `PODTL.TransferedQty`, which is per PO LINE
(`data/autocount-refetch-po.sql` selects it straight off the detail row).
`ac-so-linked-pos.json.gz` carries `GrQty`, which is **aggregated on
(DocNo + ItemCode)** — on a document holding two lines of one ItemCode, every one
of those lines reports the DOCUMENT's total. `import-ac-so-linked-pos.mjs:167`
read it per line:

```js
const recv = Math.round(Number(l.GrQty ?? 0));
```

and `lib/po-line-topup-core.mjs:86` inherited the same assumption as
`acNum(r.TransferedQty ?? r.GrQty)`.

The export proves it against itself, with no database access needed: all 38
`(DocNo,ItemCode)` groups holding 2+ lines carry an IDENTICAL `GrQty` on every
line (an aggregate cannot vary inside its own group); 59 lines carry
`GrQty > Qty`, impossible for one line, and **all 59** sit on such a group, ZERO
on a single-line group; PO-008944 holds two `DSL-8050 SOFA` lines of Qty 2 and
Qty 1 and reports `GrQty 3` on both — their sum. Confirmed against live AutoCount
in review (read-only ODBC, the 738 merged DtlKeys joined to PODTL): 60 of 738
disagree with `PODTL.TransferedQty`, **always inflated**, and 0 disagree wherever
`TransferedQty` supplied the value. `GRDTL.FromDocDtlKey` is NULL in this book,
so recovering a per-line figure by joining GR details is impossible;
`PODTL.TransferedQty` is the only correct source.

**Fix** — one shared rule in `lib/po-line-topup-core.mjs` (`resolveReceivedQty`),
called by both the importer and the top-up so they cannot drift: `TransferedQty`
is taken; a `GrQty` of exactly zero is taken (a sum of non-negative receipts at
zero forces every member to zero — arithmetic, not trust); a `GrQty` above zero
yields NO quantity and the line is reported. `received_qty` is
`NOT NULL DEFAULT 0` (migration 0090), so there is no blank column to write —
the top-up WITHHOLDS the whole family and the importer REFUSES the whole
document, both loudly. Whole, not the determinate half: a half-written family is
what every later run reports as "partial" and never completes, so a partial write
here is permanent. `data/autocount-refetch-so-linked-po.sql` is the read-only
re-export that fixes the data properly.

The tempting rule — "the group holds one line, so the aggregate IS that line" —
is deliberately NOT implemented, though it would cover 333 more lines. It rests
on the export holding every line of that ItemCode on that document, and nothing
available here can establish that: the two exports never overlap on a received
line (0 of the 179 shared DtlKeys have `GrQty > 0`), so the repo cannot check it
even once. Group size is reported as diagnosis, never consulted as permission.

**The class, for next time** — a column name is not a contract. `GrQty` and
`TransferedQty` both read as "how many arrived", and the comment that used to sit
above them said "They mean the same thing." Before reading any quantity per line,
check whether it VARIES within the group it would have been aggregated on; a
column that is constant across a group of differing quantities is an aggregate.
The cheapest tell is the impossible value: `received > ordered` on a single line
is arithmetic that cannot happen, and 59 of them were sitting in the file.

**Not repaired here** — the 65 existing production rows are a SEPARATE repair
owned by another lane. This change stops the source of them; it rewrites nothing.

**Ref** — PR #1906, 2026-08-11.
