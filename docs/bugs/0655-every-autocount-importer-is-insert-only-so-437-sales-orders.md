## Every AutoCount importer is INSERT-ONLY, so 437 sales orders edited in the book since the cut were silently ignored [high]

**Symptom.** Owner, on go-live day 2026-09-07: 「把旧的 SO 中有人更改过的、开了 PO
或开了 DO 等等：也就是这段期间我们没在 Houzs ERP 操作，而别人在 AutoCount 操作的
这些数据全部补回来。」 Staff kept working in AutoCount after the 2026-08-29 import
cut, and none of that work reached the ERP. Re-running the importers brought in
the new documents and left every edited one exactly as it was, with no output
saying so.

**Root cause (traced).** `backend/scripts/import-ac-outstanding-so.mjs:459`
writes the header as
`INSERT INTO scm.mfg_sales_orders ... ON CONFLICT (doc_no) DO NOTHING`, and its
own file header states the consequence: *"items and payments are written only for
a NEWLY inserted header, so a re-run is safe"*. Safe, and inert — a document
already carrying its `doc_no` is skipped whole, so a changed Desc2, a changed
Remark2, a new deposit or a re-decoded sofa in the book can never reach the row.
`import-ac-outstanding-po.mjs:376` (`ON CONFLICT (po_number) DO NOTHING`) and
`import-ac-so-linked-pos.mjs` have the same shape. Nothing in the repo carried an
AutoCount timestamp either, so "which documents moved?" could not be asked at
all.

Measured against the live `AED_HOUZS` book on 2026-09-07 with 2026-08-29 as the
boundary, header `CreatedTimeStamp` / `LastModified`, cancelled and `HC-`/`ZZ`
test documents excluded:

| type | created since | edited only |
| --- | --- | --- |
| SO | 117 | **437** |
| PO | 91 | 10 |
| DO | 107 | 2 |
| IV | 62 | 1 |
| GR | 50 | 0 |
| PI | 59 | 0 |

**Fix.** Two parts, both additive.

`backend/scripts/export-ac-reimport.py` gains a `stamps` section — the first
thing in this repo to export an AutoCount timestamp. Header columns only (never
a picture column, which is the read that made `SalesOrder.InternalSave()` time
out on the live book earlier the same day), keyset-paged on `DocKey` with an
explicit range predicate, a sleep between pages and a per-statement timeout, so
it cannot starve the book the ERP write-back runs against.

`backend/scripts/sync-ac-delta.mjs` is the delta planner. It prints the per-type
census, REFUSES and lists every document a person has edited in the ERP (audit
trail or header `version > 1`), reports sofa compartment sets that now disagree
rather than guessing at them, and writes only the three lanes no existing tool
owns: line `description2`, the migrated payment/balance row, and the SO->PO line
dedication from `PODTL.FromSODtlKey`. Every other lane is COUNTED and its
existing owner NAMED — `refresh-so-tail-from-book.mjs`,
`refresh-so-variants.mjs`, `backfill-sofa-variants-from-desc2.mjs`,
`import-so-line-photos.mjs` — because a second copy of an import rule is the
class of bug that costs most here.

**Ref.** `feat/ac-delta-sync-2026-09-07`, 2026-09-07.
