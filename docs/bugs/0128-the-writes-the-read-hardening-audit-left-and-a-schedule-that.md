## The writes the read-hardening audit left, and a schedule that reported success for a stop it never wrote [high]

**Symptom** — four of the five findings have no operator-visible symptom, which
is the point. A caller switched to one company could POST another company's
payment voucher (writing a journal entry against it), PATCH another company's GRN
header, and render another company's service case as a printable letterheaded
document holding nothing but `service_cases.read`. The fifth is visible:
scheduling a Sales Order straight from the Delivery Planning board returns
`WIRED` while writing no `trip_stops` row at all — the dispatcher sees success,
the driver's sheet stays empty, and lorry capacity counts nothing.

**Root cause (traced, not guessed)** — the 2026-08-10 audit scoped the READS. The
SCM supabase client is the SERVICE ROLE, so RLS is bypassed and an app-level
predicate is the only isolation there is; a scoped read does not gate an unscoped
write two PostgREST round trips later. `getAssrDetail`'s SQL is `WHERE c.id = ?`
with no company predicate at all, and `assr_print`'s GET had only
`requirePermission("service_cases.read")` — **a permission says what you may do,
never whose** — while the JSON detail route beside it already applied the guard.
Two further faults in the same pass:

1. **A dropped error where the absence authorises the write.**
   `postPaymentVoucherHandler`'s idempotency check destructured
   `const { data: existingRows }` and discarded the error. A failed read leaves
   `existingRows` undefined, `?? []` turns that into "no journal entry exists",
   and the handler posts a SECOND entry against the same voucher.
2. **A guard that can never fire.** In `scheduleOntoTrip` the stop insert is
   `if (!already && (doId || soId))`. On the SO-direct path `doId` is null (there
   is no DO) and `soId` is set to `null` six lines above, because
   `scm.mfg_sales_orders` has a TEXT `doc_no` primary key and no uuid while
   `trip_stops.so_id` is a uuid. Both operands are always null; the insert is
   unreachable; the function returned `WIRED` regardless.

**Fix** — `requireActiveCompanyId` + `scopeToCompanyId` on the payment-voucher
POST's voucher read, its `journal_entries` idempotency lookup and its POSTED
status flip; on the GRN PATCH's before-read **and** its UPDATE, with
`maybeSingle()` rather than `single()` so a zero-row match is the honest 404
instead of a 500; `allowedCompanyIds` on `assr_print` GET `/:id`, keeping the JSON
route's semantics deliberately (an UNRESOLVED scope skips the check, an EMPTY
scope 404s every company-stamped case — those two used to share `[]` and the
merged state failed open). The idempotency read's error now returns 500 with its
reason rather than reading as an absence.

**On the fifth finding, less landed than the framing suggests.** `stopCreated`
and `stopSkippedReason` were added to `TripWiring`'s WIRED arm — and **nothing
reads them**. `git grep stopCreated` at origin/main `de99056d5` returns six hits,
all inside `backend/src/scm/routes/delivery-planning.ts`: the type, the comment,
the assignment and the two response keys. No frontend, no test. The dispatcher
still sees a plain success. The orphan-TRIP half is untouched: a trip is still
found-or-created with no stop for it, and `/lorry-capacity` still counts it. That
defect was already on the record twice before this PR — in this file under the
stale-stop sweep entry (*"Deliberately NOT done — and this one is a second,
separate defect, now named"*) and in `docs/modules/delivery-tms.md` as *"Known
gap, inherited and documented (BUG-HISTORY 2026-07-22)"*. What this PR changed is
that the API stops asserting something false; the operator is still not told.

**The class, and the check that should have caught it** — the company-scoped
WRITE class, written up in this file as *"Every company-scoped WRITE in the system
was missing its company predicate"*. That entry's own Symptom paragraph names
these three by hand — *"Five instances were found and fixed by hand on 2026-08-13
(payment-vouchers POST, grns PATCH, assr_print GET)"* — so this defect is
referenced in the ledger without ever having been entered in it; this is the entry
it was pointing at. The existing check that should have caught the voucher is
`backend/tests/companyScopeHardening.test.ts`, cited as the precedent in
`docs/modules/payment-voucher.md`: it covers the CANCEL path (*"the cancel cannot
reverse another company's GL entry"*) and not the POST path 350 lines above it —
one of a pair was tested and the pair was called done, which is the same shape as
the reads/writes mistake one level up. The swallowed idempotency error belongs to
a different class and is in neither sweep: **a failed read must never read as an
absence when the absence is what authorises the write.**

**Ref** — 2026-08-13, PR #2086 (`fix/company-scope-writes-and-swallowed-errors`).
Entry written 2026-08-14 from the merged diff and from origin/main. Module guides
updated in the same commit as this entry: `docs/modules/payment-voucher.md`,
`docs/modules/grn.md`, `docs/modules/service-case.md`,
`docs/modules/delivery-tms.md`.

---
