## Service SO picker cannot find a migrated order by its AutoCount number [medium]

**Symptom.** Owner, 2026-08-28: creating a Service Case for `SO-001934`
(salesperson Stanley), he typed `001934` / `1934` into the SO picker and got
"No matching sales orders" — for an order the ERP holds. The order is only
findable by its ERP number (`HC-SO-…`), which nobody quotes: the customer and
the paperwork carry the AutoCount number.

**Root cause (traced).** `GET /api/assr/search-so` (`backend/src/routes/assr.ts`,
SCM arm at the `const scmRows` query, ~line 1292) substring-matches only
`so.doc_no` / `so.ref` / `so.debtor_name` on `scm.mfg_sales_orders`. Migrated
and write-back orders store their ORIGIN AutoCount number in
`linked_ac_docno` (mig `0271_scm_mfg_so_linked_ac_docno.sql`: doc_no =
`HC-<n>` ERP number, raw AutoCount number kept aside for write-back), so an
AutoCount-number needle matches none of the three searched columns. The mirror
arm (1) cannot cover it either — `public.sales_orders` is the HOUZS AutoCount
mirror, not the HC book. Traced by reading the arm's SQL against mig 0271's
header; the missing-column mechanism is the whole story.

**Fix.** Add `OR LOWER(COALESCE(so.linked_ac_docno, '')) LIKE ?` as a fourth
term inside the SCM arm's existing OR group, plus the matching bind. Company
scope and the DRAFT/CANCELLED status filter are untouched. Pinned by
`backend/tests/assrSearchSoLinkedAcDocno.test.ts` (source-shape scan, light
project — the D1 mirror carries no scm schema to execute against): proved RED
on the unfixed tree (2 failed: column absent, 3 binds not 4), GREEN with the
fix. UNTESTED against the production order itself — no prod query from this
session; the code-level mechanism is what is proven.

**Ref.** fix/assr-search-so-linked-ac-docno, 2026-08-28.
