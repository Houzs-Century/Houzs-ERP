## Six SO detail panels answered for the OTHER company — the reads were keyed on the doc number alone [high]

**Symptom.** Open a Sales Order detail URL carrying a `2990-` document number
while the active company is HOUZS (a pasted link, a bookmark, an emailed
reference) and the History, Status, Price-override and Payments panels populate
from 2990's books. `GET /:docNo/slip-url` goes further: it does not return a
field, it **streams the R2 object** — the other company's payment slip image
itself.

**Root cause (traced, not guessed).** Document numbers are unique per company by
**PREFIX convention** (`HC-`/bare = HOUZS, `2990-` = 2990), never by a
constraint. So `doc_no` does not carry the tenant, and six reads used it as the
whole key:

| route | table | key |
|---|---|---|
| `GET /:docNo/audit-log` | `mfg_so_audit_log` | `so_doc_no` |
| `GET /:docNo/status-changes` | `mfg_so_status_changes` | `doc_no` |
| `GET /:docNo/price-overrides` | `mfg_so_price_overrides` | `doc_no` |
| `GET /:docNo/payments` | `mfg_sales_order_payments` | `so_doc_no` |
| `GET /:docNo/slip-url` | `mfg_sales_orders` | `doc_no` |
| `GET /cross-category-eligibility` | `mfg_sales_orders` (×2, via `checkCrossCategorySource`) | `doc_no` |

The frontend fires these panels straight off the URL (`enabled: Boolean(docNo)`),
so no deliberate act is needed to trigger it. `checkCrossCategorySource` returns
`debtor_name`, so an unscoped probe answered **who the other company's customer
is** from a GET needing only a document number.

**It was an omission, not a decision.** `GET /:docNo/revisions` — registered
between two of the leaking routes, in the same file — already carries
`scopeToCompany`, with a comment explaining that `so_revisions` took
`company_id` in mig 0080. Every table above took `company_id` in mig 0083.

**Why no gate caught it.** `scripts/check-company-scope.mjs` has two passes and
this shape falls between them. The ROUTES pass tests `ID_PREDICATE`
(`/\.eq\(\s*['"`](id|[a-z_]+_id)['"`]/`), so a `doc_no` key is invisible to it.
The NATURAL-KEY pass does understand `.eq('doc_no', ...)` — but it iterates
`LIB_DIRS` only, and within those it screens on `LIB_WRITE`, so it sees neither
routes nor reads. Measured against the current tree, that blind spot spans
**278 natural-key reads in 86 route files, 200 of them carrying no company term
at all** (upper bound, not a confirmed leak count: some are validated upstream in
the same handler and some address genuinely global tables). Closing the class is
a separate change with its own triage; this entry fixes the six that were traced.

**Fix.** `scopeToCompany(...)` on all six statements. `checkCrossCategorySource`
gained a leading `c` parameter — it previously took only `sb`, so scoping was
not expressible — and both of its reads are scoped: the source lookup, and the
single-use count, because leaving the count unscoped would let the other
company's link burn ours.

**Not touched, deliberately.** `GET /:docNo/payments/:id/slip-url` looks like the
same shape but already calls `selfScopedSalesBlocked`, whose step 1 is a
`scopeToCompany` read of `mfg_sales_orders`. It was checked and left alone rather
than "fixed" twice.

**Test.** `backend/tests/soChildReadsCompanyScoped.test.ts`. Source-shape, because
these are Supabase builder chains the light suite cannot execute. Two assertions
per route — the handler slice must contain the query being judged AND the
predicate — because a slice taken from one registration to the next can otherwise
borrow the following handler's guard. Proved red: removing the predicate from
each of three routes in turn failed the suite, and the file was byte-restored
afterwards.

**Ref.** `fix/so-child-reads-company-scoped`, 2026-08-18. Found during the
