## AutoCount's Description 2 was invisible on the sales-order line and was destroyed by the first edit [high]

**Symptom.** The owner, cutover day 2026-09-08: 「记得把autocount的这个
description2 remain着搬进去我们的remark」 — keep AutoCount's Description 2 and
carry it into our remark. The book's Description 2 is the salesperson's own
words on the order slip (`COL: PC151-01/ DIVAN: 8" + 2" LEG/ GAP: 12"`,
`Dipose 1 old mattress and 1 old bed frame`, `PICKUP AT SHOWROOM`). Staff
could not see it anywhere on a migrated sales order.

**Root cause (traced).** Two separate faults, and the second is the serious one.
The go-live importer DOES store the text: `backend/scripts/import-ac-outstanding-so.mjs`
lists `description2` in `ICOLS` and writes `V(it.d2 || null)`. So the words were
in the database the whole time. But:

1. **Nothing renders it.** Every SO surface renders
   `buildVariantSummary(item_group, variants) || description2` — the decoded
   variant summary WINS and `description2` is only a fallback for rows with no
   variants blob. A migrated line always has a variants blob, so the stored book
   text never reached a screen: `frontend/src/pages/scm-v2/SalesOrderDetailV2.tsx:817-824`,
   `SalesOrderDetail.tsx:2399-2409`, `frontend/src/mobile/MobileSODetail.tsx:1064-1070`,
   `frontend/src/components/DocumentLinesExpansion.tsx:600-610`.
2. **The first edit overwrites it.** The SO item PATCH regenerates the column
   unconditionally — `updates['description2'] = buildVariantSummary(String(effGroup ?? ''), effVariants ?? null) || null;`
   at `backend/src/scm/routes/mfg-sales-orders.ts:8575`, under the comment
   *"Description 2 is ALWAYS the server-generated variant summary; never trust a
   client-sent value."* That rule is correct for `description2` and fatal for the
   book text parked in it: the moment anyone touched a migrated line, AutoCount's
   own words were replaced by our derivation, or set to NULL when the summary
   came out empty. The decoded build is a DERIVATION; the slip's text is the
   source, and the source was being deleted by the derivation.

Measured on the committed book snapshot `backend/scripts/data/ac-reconcile-truth.json.gz`:
**16,532** AutoCount SO detail lines carry a non-blank Description 2.

**Why the remark is the right home.** `remark` is rendered verbatim on every SO
surface, it is a searchable / filterable / CSV-exported column on the desktop
detail (`SalesOrderDetailV2.tsx:918-930`), nothing regenerates it, and it is NOT
in `SO_ITEM_COLS` (`backend/src/scm/lib/autocount-outbox.ts:382`) so it cannot
reach the AutoCount write-back. This is the sales-side twin of what the PO
migration already did with `purchase_order_items.notes`.

**Fix.** `backend/scripts/lib/desc2-remark.mjs` composes the new remark and
`backend/scripts/backfill-so-desc2-into-remark.mjs` plans and applies it. The
book text is APPENDED on its own final line behind the marker `AC原文: `, never
substituted, so the importer's own notes ("sofa: …", "SOFA UNPARSED — 按图/原文
补件: …", "name-matched from free-text") survive and a script can split the two
apart again with `splitRemark()`. Rows are paired on `linked_ac_dtlkey`, never
on position (docs/bugs/0690). Blank stays blank: a line with no book Description 2
gets nothing — not an empty string, not a placeholder.

Idempotent by construction: `composeRemark` returns null when the remark already
carries the marked block, and also when it already quotes the book text verbatim
(the PO side measured 891 of 923 lines byte-identical, so doubling was a real
risk). A second run plans zero rows.

**Proved RED first.** `backend/tests/desc2IntoRemark.test.mjs` (20 assertions)
was written before the module existed and failed to import. Then five mutants
were introduced into the finished module and each was caught: dropping the
idempotence guard (4 failed), dropping the already-quoted guard (1), writing a
placeholder for a blank Description 2 (1), substituting instead of appending (3),
and pairing on position instead of the AutoCount line key (2). The restored
module is 20/20 green.

**Ref.** feat/desc2-into-remark, 2026-09-08.
