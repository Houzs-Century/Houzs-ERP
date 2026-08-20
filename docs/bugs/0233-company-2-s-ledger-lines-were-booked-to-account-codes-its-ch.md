## Company 2's ledger lines were booked to account codes its chart does not contain [medium]

<!-- area: Accounting + GL -->

**Symptom.** All six of company 2's journal entries carried account_code
1200/2000 — codes that exist only in company 1's chart. Company 2's own chart
(2990-prefixed + the new AutoCount-style codes) never contained them, so its
GL lines referenced accounts that no chart could explain.

**Root cause (traced).** postSiRevenue / postPiAccounting hardcoded '1100',
'4000', '1200', '2000' regardless of the document's company, and nothing
validated account codes against the chart on write (scm.accounts is
per-company; the codes happened to exist for company 1 only).

**Fix.** Account ROLES per company (scm.acc_account_roles, migration 0296)
replace every hardcode; the posting engine now validates codes against the
company's chart (exists, active, not a parent header); the migration
backfills the four bare codes into company 2's chart so history, validation
and the seeds agree. Phase 1's renumbering re-points the roles properly.

**Ref.** feat/accounting phase 0, 2026-08-16.
