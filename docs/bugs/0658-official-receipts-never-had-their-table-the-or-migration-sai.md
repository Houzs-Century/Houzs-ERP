## Official Receipts never had their table — the OR migration said CREATE TABLE IF NOT EXISTS on a name the general-receipt migration had already taken, so every receipt birth failed and the OR page could not load [high]

<!-- area: Accounting + GL -->

**Symptom.** Found while checking the Customer Refund design for the owner
(2026-09-07): prod `scm.acc_receipts` carries the general receipt's columns
(receipt_number, payer_name…) and none of the OR module's; `GET
/accounting/receipts` selects `or_number`, so /scm/official-receipts cannot
load, and every receipt birth since 2026-09-05 (three 2990 payments) failed
in the best-effort hook with nothing on screen. Zero official receipts exist.

**Root cause (traced).** `20260905T1800_official_receipts.sql` line 35:
`CREATE TABLE IF NOT EXISTS scm.acc_receipts (…)`. `0351_acc_general_receipts.sql`
(applied 2026-09-03) had already created `scm.acc_receipts` for the general
money-in receipt, so the statement was a no-op; the tracker
(`public._pg_migrations`) recorded the file as applied 2026-09-04 23:24 UTC
and the index it also created landed on the general table. `acc/receipts.ts`
and `accounting-receipts.ts` then read `or_number` off a table that never
had it. Tests were green because the fake client's tables are named by the
fixture, not by any migration.

**Fix.** Migration `20260907T1600_acc_official_receipts.sql` creates
`scm.acc_official_receipts` (20260905T1800's columns verbatim; that file is
left untouched — an applied migration's body is never edited); the module's
every read and mint names the new table; the fixture world follows.
`tests/officialReceiptsTable.test.ts` pins three things — no two pg
migrations create the same scm table name beyond the one collision it names,
a migration creates acc_official_receipts with the OR columns, and the OR
module reads only its own table while the general route keeps its own — RED
on the unfixed tree (no acc_official_receipts; both module files on
acc_receipts), green after. Verified on staging by applying the migration
(information_schema shows the 16 columns) before the PR.

**Ref.** fix/official-receipts-own-table, 2026-09-07.
