## The PO refetch reference SQL named a column the book does not have [low]

**Symptom.** Running the PO→SO link predicate from
`backend/scripts/data/autocount-refetch-po.sql` against the live `AED_HOUZS`
book fails immediately: `Invalid column name 'FromDtlKey'` (SQL Server error
207). Observed 2026-08-28 while counting the re-import candidate set — the
first time anyone actually executed that file's predicate.

**Root cause (traced).** The file (and its sibling
`autocount-refetch-so-linked-po.sql`) selects `pod.FromDtlKey AS FromSODtlKey`.
`dbo.PODTL` has no such column. Its `From*` columns, read from `sys.columns`
on the live book on 2026-08-28, are: `FromAODtlKey`, `FromDocDtlKey`,
`FromDocNo`, `FromDocType`, `FromSODocList`, **`FromSODtlKey`** — the real
link column is named `FromSODtlKey` directly, no alias needed. Both files were
written 2026-08-10 as hand-off instructions ("run this in SSMS") and were never
once executed — the actual export that day travelled a different path — so the
guess sat unfalsified. This is the repo's own "a workflow_dispatch workflow is
not shipped until dispatched once" rule, wearing a `.sql` extension.

**Fix.** `backend/scripts/export-ac-reimport.py` (the round-2 exporter in this
PR) uses the real column names and, for the DO side, discovers the SO-line
pointer column from `sys.columns` at run time instead of assuming one. The two
reference `.sql` files are superseded by that script for the re-import; their
predicate logic (which is correct apart from the name) is preserved in it.
Proved by execution: the same predicate with `FromSODtlKey` returned 442
documents / 685 lines on 2026-08-28.

**Ref.** feat/ac-reexport-v3, 2026-08-28.
