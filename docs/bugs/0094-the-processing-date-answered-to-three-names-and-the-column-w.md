## The Processing Date answered to three names, and the column was the last one still disagreeing [medium]

**Symptom** - not a crash; a recurring class. Owner, 2026-08-13, after saying it
more than three times: *"你确保你的 process（就是整套系统）里，把 internal expected
date、processing date 和 process date 都直接整合变成一个，不要再搞多个了。因为每一
次讨论到 processing date 的时候，你就有各种各样的 bug，原因就是因为你有太多个了。
这三个 date 其实都是指向同一个东西。"* Every prior incident on this concept -
the blank Processing date on the SO read views (`#1179`), the legacy column drop
that blocked every deploy (`0189`/`#1191`), the two grant-loss outages behind it
(`0190`, `0191`), the amendment path that could set the date with no gate - has
the same shape: someone reached for the wrong one of several names.

**Root cause** - the DATA had already been unified on 2026-08-13 (519 company-1
orders moved out of `proceeded_at`; both companies report zero split). What was
left was vocabulary. One field was called `internal_expected_dd` in the database,
`internalExpectedDd` in the API payload, `so_internal_expected_dd` on SI/DO list
rows, and "Processing Date" by the UI label, the API's own `processingDate`
reads and every human in the building. 344 occurrences across 73 files, and the
next reader picks whichever one their file happens to use.

**Fix** - `migrations-pg/0284` renames
`scm.mfg_sales_orders.internal_expected_dd` to `processing_date` and does the
consignment twin identically, and the same commit renames every code reference,
the payload key (`internalExpectedDd` → `processingDate`), the row-stamp key
(`so_internal_expected_dd` → `so_processing_date`) and every doc that states a
present-tense fact about the column.

Three things had to be handled that a naive `ALTER TABLE` would have got wrong,
all of them verified against a PGlite replica rather than reasoned about:

1. **The view.** `scm.mfg_sales_orders_with_payment_totals` projects the column.
   The `ALTER TABLE` **succeeds** - Postgres re-points the stored rewrite rule by
   attribute number - but the view's own output column keeps the OLD name, so the
   base table has `processing_date` while the view still only answers to
   `internal_expected_dd`, and the first route that selects the new name off the
   view 500s. Closed with `ALTER VIEW … RENAME COLUMN`, a catalog rename: grants
   (service_role AND the Hyperdrive prod role that 0191 had to go hunt for) and
   owner were re-checked after and are unchanged. **A rename must never reach for
   DROP VIEW → CREATE VIEW** - that is the path that cost prod twice in July.
2. **The consignment collision.** `scm.consignment_sales_orders` carried BOTH the
   live `internal_expected_dd` and a dead legacy `processing_date` (mig 0153;
   0189 dropped the mfg twin and left this one). The rename fails outright until
   the dead one is dropped. The first draft of the migration dropped it with a
   plausible-looking `DROP COLUMN IF EXISTS` - which on a SECOND run would have
   dropped the freshly-renamed LIVE column and destroyed every consignment
   Processing Date. The replica's idempotency pass caught it; the guard now
   requires BOTH names to be present, i.e. a genuine collision to clear.
3. **The name is also stored inside data.** `scm.so_amendments.header_changes`
   is a jsonb blob keyed by the camelCase PAYLOAD name, and `applySoAmendment`
   skips any key not in `AMENDABLE_HEADER_FIELDS`. A Processing-Date amendment
   submitted before the deploy and approved after it would have been **silently
   dropped** - approve succeeds, the date never moves, the audit line does not
   even mention it. 0284 renames the key inside `header_changes`,
   `old_header_snapshot`, and `mfg_so_audit_log.field_changes` (where an
   un-migrated row would print the raw token `internalExpectedDd` instead of
   "Processing date").

`scm.apply_so_header_cas` (mig 0173) needed no change, and that was CONFIRMED
rather than assumed: it builds its `SET` list from `pg_attribute`. Worth knowing
for the next reader, because it fails quietly - it feeds the patch through
`jsonb_populate_record`, which IGNORES a key that is not a column, so a caller
left on the old key would not error, the date would just stop saving.

**Lesson** - **a concept with more than one name is a bug that has not fired
yet.** Unifying the DATA is only half; while the column, the payload key and the
label disagree, every new reader gets a coin flip, and this codebase paid for
that flip at least four separate times. Renaming is cheap, and the expensive part
is not the `ALTER TABLE` - it is finding the places the name is stored as a
VALUE (jsonb keys, audit rows) and the places a rename leaves *stale but not
broken* (the view's output column). Those are exactly the two that fail silently.

---
