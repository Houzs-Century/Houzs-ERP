## The PO importer dropped a sofa line without counting it, so seven mixed purchase orders came in holding only their pillows [high]

**Symptom.** `PO-010085, PO-010086, PO-010146, PO-010150, PO-010151, PO-010160,
PO-010161` sit in the ERP as SUBMITTED holding only their pillow lines. Each one
has exactly one sofa line in AutoCount. A sofa is hard-bound — READY only through
its own dedicated purchase-order line — so the customer leg of seven orders has
no purchasing line behind it, and nothing in any run log ever said a line had
been left out.

**Root cause (traced).** `backend/scripts/import-ac-outstanding-po.mjs`, the line
that groups the export into documents:

```js
for (const r of rows) { if (doneDocs.has(r.DocNo)) continue; if (!SOFA && isSofa(r.ItemCode)) continue; ... }
```

The gate is per LINE, not per document. On a document that is ALL sofa the effect
is a clean exclusion — nothing is left, so the document simply does not arrive.
On a MIXED document the remaining lines still build a purchase order, and the ERP
ends up holding a document that looks whole and is short its sofa. The `continue`
counts nothing and names nothing, so the only way to learn it happened is to go
back to the book.

It is also unrecoverable by re-running: both PO importers are idempotent at
DOCUMENT level (`built.filter((o) => !existing.has(o.poNo))`), so a later run
with `SOFA=1` sees the document already present and skips it whole. Lane 2
(`import-ac-so-linked-pos.mjs`) has no SOFA gate at all and would have carried
these — it never got the chance, because lane 1 had already created the document.

Measured 2026-09-08 against a cut taken the same morning: all seven appear in
BOTH export lanes, each with one sofa line and one to four pillow lines
(`ac-outstanding-po.json.gz` 18 rows / 7 documents; `ac-so-linked-pos.json.gz`
the same 18). The sofa item codes are `HOK-5536 SOFA`, `HOK-5540 SOFA`,
`HOK-5535 SOFA`, `AMN-SF9058 SOFA`, `DSL-8030 SOFA` — every one matches
`isSofa`'s `/SOFA/i`.

The SO importer does not have this shape: it groups first and excludes a MIXED
order WHOLE (`skipMixed`), and it counts what it excluded. Only the PO lane
builds a partial document, and only the PO lane was silent about it.

**Fix.** The drop is counted and the documents are NAMED, split into the two
classes that mean different things: the ones that fall out whole (a clean
exclusion) and the MIXED ones that will be imported incomplete — those are listed
by document number with the item codes being left behind, and the log says out
loud that re-running with `SOFA=1` will not repair them and `topup-ac-po-lines.mjs`
is what will. This is a REPORTING fix; the gate itself is unchanged, because
`SOFA=1` is a deliberate switch and the defect was that its cost was invisible.

The seven documents themselves are repaired by `topup-ac-po-lines.mjs`, which
exists for exactly this failure (it was written for the 25 mixed documents the
2026-08 rounds left behind) and reads both lanes.

**Ref.** chore/cutover-recut-0908, 2026-09-08.
