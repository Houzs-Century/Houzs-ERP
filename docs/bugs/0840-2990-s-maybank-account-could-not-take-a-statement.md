## 2990's Maybank account could not take a statement [medium]

<!-- area: Accounting + GL -->

**Symptom.** Bank statement reconciliation knew one account for 2990 — the
Hong Leong current account (310-0020, migration 20260908T2100). Maybank
(310-0010, CASH AT BANK - MAYBANK, account 564418759397 — where the MBB card
machine, AEON and the cash deposits land) had no statement config, so its
Account Activity Report could not be uploaded, and the merchant reports the
owner had just finished uploading had no bank side to reconcile against.
Owner 2026-09-12: maybank statement 要做，我要测试 maybank statement.

**Root cause.** Configuration, not code: the reader
(`backend/src/acc/bank-parse.ts`) already reads Maybank's export — pipe
delimited, amounts as integer sen zero-padded to 15 digits, the direction in
its own AMOUNT IND column, dates packed as YYYYMMDD; its fixture is copied
from the real file — but no `acc_bank_statement_config` row named the
account.

**Fix.** Migration
`backend/src/db/migrations-pg/20260912T1600_acc_bank_statement_mbb_2990.sql`:
one config row for company 2 / 310-0010 — bank MBB, account 564418759397 (seeded as 564418610346, which is HOUZS's account — corrected by docs/bugs/0856),
CSV, delimiter `|`, amount format `integer-sen`, credit indicator `CR`, and a
column map naming the export's captions (EFFECT DATE, TRX DESCRIPTION,
TRX REFERENCE, AMOUNT, AMOUNT IND; BATCH DATE as the date's second name).
Guarded by NOT EXISTS on the account and by the chart row's existence; HOUZS
untouched. The upload's account check reads digits, so the zero-padded
0000564418759397 in the file satisfies it. Verified on staging.

Pinned by the reader's own Maybank fixture in
`backend/src/acc/bank-parse.test.ts` (pipe, packed dates, integer sen, the
DR charge sharing a credit's reference) — the config's values are the
fixture's.

**Ref.** acc/bank-statement-mbb-2990, 2026-09-12.
