## SO-readiness check crashed on a second empty-string-into-enum coercion (warehouse_type) [low]

**Symptom.** After PR #3616 fixed the `delivery_return_status` coercion, the
re-dispatched `SO readiness facts (read-only)` run (34557581816, 2026-09-11)
again printed `::notice::company = 1` and died: `check failed: invalid input
value for enum scm.warehouse_type: ""`, exit 1. Still no answer to the owner's
mattress/accessory readiness question.

**Root cause (traced).** The SELECT computed `non_selling` with
`lower(COALESCE(w.type, '')) = ANY(${NON_SELLING})`. `scm.warehouses.type` is
enum `warehouse_type` (`warehouse, showroom, display, service, others` — mig
0177), so COALESCE unified to the enum type and cast the `''` literal to
`warehouse_type` at plan time, which fails identically to the #3616 case. This
was the SAME BUG CLASS as [[0804]] on a different column; #3616 fixed one
instance and not the class, so the next run surfaced the second. Observed as the
run's `--log-failed` output.

**Fix.** `COALESCE(lower(w.type::text) = ANY(${NON_SELLING}), false)` — cast the
enum to text explicitly (no `''`), `lower()` still normalises case (labels are
already lowercase, so it also matches exactly), and the outer COALESCE makes a
NULL warehouse type a definite `false` rather than SQL NULL. Audited the whole
statement this time: every other `COALESCE` is on a numeric or text column, and
the `s.status`/`o.status` comparisons use real enum labels (they planned past in
both prior runs) — this was the last enum coercion. Acceptance is a green
re-run; UNTESTED at the time this entry was written (must merge first), result
recorded in the PR.

**Ref.** fix/so-readiness-warehouse-enum, 2026-09-11.
