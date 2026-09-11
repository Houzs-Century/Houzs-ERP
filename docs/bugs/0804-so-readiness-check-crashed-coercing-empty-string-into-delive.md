## SO-readiness check crashed coercing empty string into delivery_return_status enum [low]

**Symptom.** The read-only diagnostic `check-so-readiness-facts.mjs` (workflow
`SO readiness facts (read-only)`, run 34556592005, dispatched 2026-09-11 against
production) failed: it printed `::notice::company = 1` and then died with
`check failed: invalid input value for enum scm.delivery_return_status: ""`,
exit 1. Because a red job means "the check broke", it produced NO answer to the
owner's question (do stocked mattress/accessory SO lines turn READY?).

**Root cause (traced).** The `returned` CTE guarded cancelled returns with
`WHERE COALESCE(r.status, '') <> 'CANCELLED'`. `scm.delivery_returns.status` is
of enum type `delivery_return_status` (labels `PENDING, RECEIVED, INSPECTED,
REFUNDED, CREDIT_NOTED, REJECTED, CANCELLED`), and the column is `NOT NULL
DEFAULT 'PENDING'`, so the COALESCE was never needed. Worse, it is fatal:
COALESCE unifies its arguments to the type of the first typed one (the enum), so
the untyped literal `''` is cast to `delivery_return_status` at PLAN time — and
`''` is not a valid label — so the whole statement errors before touching a row.
Observed as the run's `--log-failed` output above; enum labels confirmed in
`backend/scripts/scm-schema/2990s-full-schema.sql:4`.

**Fix.** Replaced the guard with `WHERE r.status IS DISTINCT FROM 'CANCELLED'` —
no `''` coercion, compares against a real enum label, and keeps the original
intent (a NULL status, were it ever possible, counts as not-cancelled). This is
a standalone ops `.mjs` under `backend/scripts` (no unit test; that area's
no-test floor is off by design). Acceptance is a dispatched re-run against
production going green where run 34556592005 was red; UNTESTED at the time this
entry was written (the fix has to merge before the workflow can run it), result
recorded in the PR once observed.

**Ref.** fix/so-readiness-return-enum, 2026-09-11.
