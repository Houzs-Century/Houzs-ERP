## The money-rename migration missed a materialized view and failed the deploy [medium]

**Symptom.** The deploy of `0305_money_centi_to_sen.sql` (the one-shot `_centi` ->
`_sen` money rename) failed: `cannot drop view scm.v_pi_outstanding because other
objects depend on it`. The backend job went `failure`, so `main` was green but the
backend did not ship until the fix landed.

**Root cause (traced, not guessed).** The census that generated 0305 enumerated
views from `information_schema.views`, which does **not** list MATERIALIZED views.
`scm.mv_ar_aging` is a materialized view that reads five of the outstanding views
(`v_pi_/v_po_/v_pr_/v_si_/v_so_outstanding`), so those views could not be dropped
while it existed. Proven by `pg_depend`: `mv_ar_aging (relkind 'm')` depended on
all five. Production was never half-renamed — 0305 runs inside `BEGIN/COMMIT` and
rolled back atomically, so the schema stayed `_centi` until the corrected file ran.

**Fix.** 0305 now `DROP MATERIALIZED VIEW scm.mv_ar_aging` before the plain views
and recreates it (with its unique index `mv_ar_aging_company_module_uidx`) after,
its body carrying the same `_centi`->`_sen` rename; it also recreates the two
functions whose bodies referenced the columns (`settle_pi_paid_centi` ->
`settle_pi_paid_sen`, `rebuild_mfg_so_delivery_lines`). Verified against prod after
deploy: `_centi` columns = 0, `mv_ar_aging` + index rebuilt, `settle_pi_paid_sen`
present. **Lesson:** a column-rename census that touches views must enumerate
dependents via `pg_depend` across BOTH relkind `'v'` AND `'m'`, plus `pg_proc`
bodies and CHECK constraints — `information_schema.views` alone is a blind spot.

**Ref.** PR #2441 (fix), #2438 (the rename), 2026-08-18/19.
