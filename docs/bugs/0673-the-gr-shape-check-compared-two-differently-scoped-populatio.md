## The GR shape check compared two differently-scoped populations [medium]

<!-- area: Cutover + migrated data -->

**Symptom.** `check-gr-shape.mjs`'s first production run
([34135520445](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34135520445),
2026-09-07 22:55 local) printed what read as a 70-document hole in the migrated
goods receipts:

```
SHAPE A — 314 documents where the ERP holds 320 today (+-6), over the 247 purchase orders both sides agree on
  book purchase orders with a receipt that the ERP does NOT hold a GRN for: 71
  ERP migrated GRNs whose purchase order the book shows NO receipt for:     73
```

Nothing is wrong with the data. The check was measuring two populations that
were never the same population.

**Root cause (traced).** `ac-gr-refs.json.gz` is exported
`WHERE po.DocNo IN ('{pokeys}')` where `po_docs` is the union of
`ac-outstanding-po` and `ac-so-linked-pos` — `export-ac-reimport.py`, section
10. **That set is recomputed on every export.** A purchase order that has since
been fully delivered is no longer outstanding and drops out, so the snapshot
stops carrying rows about it. The ERP's migrated set was frozen at import and
does not shrink.

Measured on the committed snapshot:

```
ac-gr-refs export scope (outstanding PO + SO-linked PO): 484 POs
...of which have a GR document: 318
sanity: every PO in ac-gr-refs is inside that scope? true
```

484 purchase orders in the snapshot's reach, against the 574 the ERP holds. So
an ERP receipt on a purchase order outside that 484 is one the snapshot has **no
rows about** — it is not evidence the book lacks a receipt, and it was being
counted as though it were.

The malformed `+-6` on the first line was the tell, and it was ignored on the
first read: `314` is the pair count restricted to the 247 shared purchase
orders, `320` is every ERP migrated GRN. Subtracting them is not a comparison.
A sign printed where a sign should not appear is a shape error, not a cosmetic
one.

**Fix.** The GAP section now compares like with like over the shared purchase
orders, and splits the ERP side into two named outcomes: **outside the export
scope** (a scope artefact the snapshot cannot speak to) and **in scope but the
book shows no receipt** (a real disagreement, listed by document number so it
can be chased). It also states why a book purchase order may legitimately carry
no ERP GRN — `create-migrated-documents.mjs` builds only from
`received_qty > 0`.

No test: the check reads a production database and a committed snapshot, and
neither is available to the suite. The proof is the re-run, pasted in the PR.

**Lesson.** Two extracts of "the same" documents cut by different WHERE clauses
are not comparable, and the difference is invisible in the output — both sides
are real document numbers. Before subtracting two counts, establish that both
sides could have contained the same rows. Any snapshot in
`backend/scripts/data/` whose exporter carries a `WHERE ... IN (<computed
set>)` has this property.

**Ref.** #3094, 2026-09-07.
