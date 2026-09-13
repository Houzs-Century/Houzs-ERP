## 2990's Maybank statement config carried HOUZS's account number [medium]

<!-- area: Accounting + GL -->

**Symptom.** The first Maybank file the owner uploaded for 2990 was refused:
"This file does not mention account 564418610346, which is the MBB account
you chose." The file was `ACCOUNTACTIVITYREPORT_564418759397.csv` — 2990's
own account. Owner 2026-09-13: 564418610346 是 houzs 的，2990 的是 564418759397.

**Root cause (traced).** The config seeded the day before (docs/bugs/0840,
migration 20260912T1600) took its account number off the only Maybank export
that had ever been analysed, `ACCOUNTACTIVITYREPORT_564418610346.csv` — which
belongs to HOUZS (company 1), not to 2990. The upload's account check does
exactly what it should — refuse a file for another account by name — so with
the wrong number every 2990 file was refused.

**Fix.** Migration
`backend/src/db/migrations-pg/20260913T0900_acc_bank_statement_mbb_2990_account_no.sql`
sets 310-0010's `account_no` to 564418759397, guarded on the seeded value so a
row already corrected on the Setup screen is left alone; verified on staging.
The 0840 entry and the guide paragraph now name the right account, and note
which company 564418610346 belongs to, so the next config for HOUZS's Maybank
account starts from the right number. Nothing else on the row changes — the
file's shape (pipe, integer sen, AMOUNT IND) is the same for both accounts.

**Ref.** acc/bank-statement-mbb-2990-account, 2026-09-13.
