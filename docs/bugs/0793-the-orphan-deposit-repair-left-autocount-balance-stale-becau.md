## The orphan-deposit repair left AutoCount balance stale because a raw-SQL SO edit does not trigger the write-back [low]

**Symptom.** After the orphan scan-deposit repair (docs/bugs/0785) corrected the
ERP's Paid/Balance on 9 SOs, AutoCount's own `UDF_BALANCE` for two of them stayed
at the pre-repair (doubled) figure: HC-SO-2609-011 showed RM288 in the account
book vs the correct RM2,488, and HC-SO-2609-049 showed RM1,500 vs RM2,900 — i.e.
the licensed account book under-stated what the customer still owed.

**Root cause (traced).** The write-back to AutoCount is enqueued by the app's SO
edit / payment paths (`enqueueEdit` -> `soEditHeader`, which sends the live
outstanding as `UDF_BALANCE`). The repair (`repair-orphan-scan-deposits.mjs`) is a
RAW SQL `UPDATE scm.mfg_sales_orders SET deposit_sen = 0` — it never goes through
the app, so no write-back is enqueued. AutoCount therefore keeps whatever balance
the last app-path edit sent (here, the doubled create-time figure). Verified on the
live DB: `scm.autocount_writeback = '1'` (ON — the module guide's "off" is stale),
and `scm.autocount_outbox` held only pre-repair `create_so`/`edit` rows for the two
SOs (balance at `body.UDF.BALANCE` for create, `body.Header.UDF.BALANCE` for edit).
A repo-wide sweep of the 49 SOs ever pushed found exactly these two off — every
other pushed order's latest balance matched (046 self-corrected via a later edit;
HC-SO-001139's ERP total is 0/0, a migrated-order unknown, not a real drift).

**Fix.** A tool, not a schema change: `enqueue-so-writeback.mts` +
`enqueue-so-writeback.yml` re-run the app's REAL `enqueueEdit` for the named SOs
via `lib/pgrest-shim.mjs` (DATABASE_URL only, no PostgREST creds — the access path
requeue-autocount-skipped uses), so the corrected outstanding is pushed with the
app's own composer (no hand-crafted accounting payload). DRY-RUN previews the
balance; `MODE=apply` enqueues and the 5-min cron sends it. No unit test — the
mechanism is the app's own enqueue, exercised by the workflow's own dry-run.

**Lesson.** Any prod SO money repair done as raw SQL must ALSO re-enqueue the
write-back (or be done through the app), or the licensed account book silently
diverges. See [[autocount-writeback-live-and-raw-sql-gotcha]] in the agent memory.

**Ref.** fix/enqueue-so-writeback, 2026-09-10.
